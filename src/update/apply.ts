import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  HarnessError,
  type UpdateCheck,
  type UpdateData,
  type UpdatePair,
  type UpdatesConfig,
} from '../contracts/index.ts';
import type { RunEventPayload } from '../contracts/events.ts';
import { processStartedAt } from '../environment/live-calls.ts';
import { checkUpdates, saveLastCheck, updatesDir, writeAtomic } from './check.ts';
import {
  HARNESS_PACKAGE,
  UI_PACKAGE,
  formatChanges,
  installExact,
  installPlace,
  installedPackage,
  reinstall,
  restoreManifests,
  saveManifests,
  type Formats,
  type InstallPlace,
} from './install.ts';
import { npmReason, runTool, type NpmOptions } from './npm.ts';
import { findPanels, startPanels, stopPanels, type PanelProcess } from './panel.ts';
import {
  copyState,
  removeInside,
  restoreState,
  stateFingerprint,
  verifyCopy,
} from './state-copy.ts';

/**
 * `harness update --apply` и `--rollback`.
 *
 * Применение: проверка реестра → решение (смена форматов — только решением
 * владельца) → нет прогона: пауза выдачи операцией `harness-update`,
 * ожидание (`--wait`) и роль controller на всё время обновления (новый
 * `harness run` не становится controller и не пишет состояние) → копия
 * состояния с контрольной суммой → запись «обновление идёт» → остановка
 * панели → установка точных версий → `doctor`, `status` новой версии и
 * проверка пары панелью → событие `harness.updated` → запуск панели. Любой
 * сбой — автоматический возврат прежних пакетов и, если состояние успели
 * изменить, копии. Процесс, убитый посреди, оставляет запись «обновление
 * идёт»: следующий `harness update` завершает возврат по ней. Хранятся две
 * последние пары и одна копия состояния (плюс копия незавершённого возврата).
 *
 * Этот процесс — прежняя версия harness: после установки он не загружает
 * новых модулей; проверки новой версии идут её собственным процессом.
 */

export const UPDATE_OPERATION = 'harness-update';

export interface UpdateHost {
  /** Что идёт сейчас (без роли controller самого обновления). */
  live(): string[];
  /** Пауза операции обновления; false — очередь уже на паузе не нами. */
  pause(): boolean;
  /** Снять паузу операции обновления (только свою). */
  resume(): boolean;
  /** Взять или продлить роль controller обновления; false — роль у другого. */
  hold(): boolean;
  /** Отпустить роль controller обновления. */
  release(): void;
  /** Период продления роли, мс. */
  heartbeatMs: number;
  /** Событие `harness.updated` в журнале состояния. */
  record(payload: RunEventPayload<'harness.updated'>): void;
}

export interface HistoryEntry {
  id: string;
  at: string;
  from: UpdatePair;
  to: UpdatePair;
  fromFormats?: Formats;
  toFormats?: Formats;
  prefix: string;
  manager: InstallPlace['manager'];
  manifests: Record<string, boolean>;
  stateCopy?: { path: string; digest: string };
}

/** Запись «обновление или откат идёт» (`in-progress.json`): по ней завершается прерванный возврат. */
interface InProgress {
  id: string;
  kind: 'apply' | 'rollback';
  at: string;
  prefix: string;
  /** Пара, к которой возвращаться при прерывании, и её package.json/lockfile. */
  restoreTo: UpdatePair;
  manifestDir: string;
  manifests: Record<string, boolean>;
  /** Копия состояния до шага и отпечаток живого состояния в тот момент. */
  copy?: { path: string; digest: string };
  fingerprint?: string;
  /** Возврат уже не удался: следующий update повторит его и до того ничего не ставит. */
  failed?: boolean;
}

export interface ApplyOptions {
  stateDir: string;
  prefix: string;
  config: UpdatesConfig;
  npm: NpmOptions;
  host: UpdateHost;
  by: 'operator' | 'schedule';
  scheduled?: boolean;
  /** Решение владельца о смене форматов: ровно пара из `--check` (`pairToken`). */
  confirmFormats?: string;
  /** Ждать окончания прогона до этого срока (мс); 0 — не ждать. */
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Повторно использовать уже выполненную проверку (тесты). */
  check?: UpdateCheck;
}

type Result = { data: UpdateData; code: number };
type Steps = NonNullable<UpdateData['steps']>;
const step = (name: string, ok: boolean, detail?: string) => ({
  step: name,
  ok,
  ...(detail ? { detail: detail.slice(0, 1000) } : {}),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Уникальный id шага: время до секунды и случайный хвост (два шага в одну секунду не сталкиваются). */
const newId = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z') +
  '-' +
  randomBytes(3).toString('hex');
/** Пара одной строкой для решения владельца: `harness@<версия>[+ui@<версия>]`. */
export const pairToken = (p: UpdatePair) => `harness@${p.harness}${p.ui ? `+ui@${p.ui}` : ''}`;
const pairText = (p: UpdatePair) => `harness ${p.harness}${p.ui ? ` и панель ${p.ui}` : ''}`;
const samePair = (a: UpdatePair | undefined, b: UpdatePair | undefined) =>
  !!a && !!b && a.harness === b.harness && a.ui === b.ui;
const file = (stateDir: string, name: string) => join(updatesDir(stateDir), name);
const message = (error: unknown) => (error as Error)?.message ?? String(error);

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function readHistory(stateDir: string): HistoryEntry[] {
  const raw = readJson<{ entries?: HistoryEntry[] }>(file(stateDir, 'history.json'));
  return Array.isArray(raw?.entries) ? raw.entries : [];
}
function writeHistory(stateDir: string, entries: HistoryEntry[]) {
  writeAtomic(file(stateDir, 'history.json'), JSON.stringify({ entries }, null, 2) + '\n');
}

const readInProgress = (stateDir: string) =>
  readJson<InProgress>(file(stateDir, 'in-progress.json'));
const writeInProgress = (stateDir: string, p: InProgress) =>
  writeAtomic(file(stateDir, 'in-progress.json'), JSON.stringify(p, null, 2) + '\n');
const clearInProgress = (stateDir: string) =>
  rmSync(file(stateDir, 'in-progress.json'), { force: true });

/**
 * Пары, которые не ставятся по расписанию (`skip.json`): не прошли проверку
 * и были возвращены или откачены человеком. Ручной `--apply` ставит их и
 * убирает из списка.
 */
interface Skip {
  harness: string;
  ui?: string;
  reason: string;
  at: string;
}
/** Пара задета пропуском: тот же новый harness или та же новая панель. */
const skippedBy = (skip: Skip, target: UpdatePair, current: UpdatePair) =>
  (target.harness !== current.harness && skip.harness === target.harness) ||
  (!!target.ui && target.ui !== current.ui && skip.ui === target.ui) ||
  samePair(skip, target);
const readSkips = (stateDir: string) =>
  readJson<{ pairs?: Skip[] }>(file(stateDir, 'skip.json'))?.pairs ?? [];
function writeSkips(stateDir: string, pairs: Skip[]) {
  writeAtomic(
    file(stateDir, 'skip.json'),
    JSON.stringify({ pairs: pairs.slice(-20) }, null, 2) + '\n',
  );
}
function addSkip(stateDir: string, pair: UpdatePair, reason: string, at: string) {
  writeSkips(stateDir, [
    ...readSkips(stateDir).filter((s) => !samePair(s, pair)),
    { harness: pair.harness, ...(pair.ui ? { ui: pair.ui } : {}), reason, at },
  ]);
}

/** Запись в `<state>-updates/journal.jsonl`: видна и без каталога состояния harness. */
function journal(stateDir: string, record: Record<string, unknown>) {
  mkdirSync(updatesDir(stateDir), { recursive: true });
  const fd = openSync(file(stateDir, 'journal.jsonl'), 'a');
  try {
    writeSync(fd, JSON.stringify(record) + '\n');
  } finally {
    closeSync(fd);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

interface LockBody {
  pid?: number;
  startedAt?: number;
  at?: string;
}
/** Держатель замка жив: тот же pid и тот же момент старта процесса. */
const holds = (held: LockBody | undefined) =>
  held?.pid !== undefined &&
  alive(held.pid) &&
  (held.startedAt === undefined || processStartedAt(held.pid) === held.startedAt);
const sameBody = (a: LockBody | undefined, b: LockBody | undefined) =>
  !!a && !!b && a.pid === b.pid && a.startedAt === b.startedAt && a.at === b.at;

/**
 * Замок `<dir>/<name>`: создаётся атомарно (полная запись во временный файл
 * и `link`); держатель — pid и момент старта процесса (pid, занятый после
 * перезагрузки другим процессом, — не держатель). Нечитаемый замок моложе
 * 30 с считается занятым. Замок умершего процесса снимается
 * переименованием; переименованный файл сверяется с тем, что признан
 * умершим, — если за это время замок взял другой процесс, он возвращается
 * на место (`link`), и ответ — занято.
 */
export function acquireLockAt(
  dir: string,
  name: string,
  busy: string,
): { release: () => void; recovered: boolean } {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, name);
  const me = {
    pid: process.pid,
    startedAt: processStartedAt(process.pid),
    at: new Date().toISOString() + '-' + randomBytes(3).toString('hex'),
  };
  let recovered = false;
  const refuse = (held?: LockBody) =>
    new HarnessError(
      'CONTROLLER_BUSY',
      `${busy}${held?.pid ? ` (процесс ${held.pid})` : ''}; дождитесь его окончания`,
    );
  for (let i = 0; i < 3; i++) {
    const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(3).toString('hex')}`);
    writeFileSync(tmp, JSON.stringify(me));
    try {
      linkSync(tmp, lock);
      rmSync(tmp, { force: true });
      return {
        recovered,
        release: () => {
          if (sameBody(readJson<LockBody>(lock), me)) rmSync(lock, { force: true });
        },
      };
    } catch (error) {
      rmSync(tmp, { force: true });
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const held = readJson<LockBody>(lock);
    let young = false;
    try {
      young = Date.now() - statSync(lock).mtimeMs < 30_000;
    } catch {
      continue;
    }
    if (holds(held) || (!held && young)) throw refuse(held);
    const stale = join(dir, `.${name}.stale.${randomBytes(3).toString('hex')}`);
    try {
      renameSync(lock, stale);
    } catch {
      continue; // замок уже снял другой процесс — пробуем взять снова
    }
    const taken = readJson<LockBody>(stale);
    if (held ? !sameBody(taken, held) : taken !== undefined) {
      // Переименовали не умерший замок, а только что взятый другим: вернуть.
      try {
        linkSync(stale, lock);
      } catch {
        // на месте уже третий замок — оставить его
      }
      rmSync(stale, { force: true });
      throw refuse(taken);
    }
    rmSync(stale, { force: true });
    recovered = true;
  }
  throw refuse();
}

/** Замки каталога состояния и каталога установки (второй — если он есть). */
function lockBoth(stateDir: string, prefix: string | undefined) {
  const state = acquireLock(stateDir);
  let pre: { release: () => void } | undefined;
  try {
    if (prefix && existsSync(join(prefix, 'node_modules'))) pre = acquirePrefixLock(prefix);
  } catch (error) {
    state.release();
    throw error;
  }
  return {
    recovered: state.recovered,
    release: () => {
      pre?.release();
      state.release();
    },
  };
}

/** Замок каталога обновлений этого каталога состояния. */
export const acquireLock = (stateDir: string) =>
  acquireLockAt(updatesDir(stateDir), 'lock', 'Обновление уже идёт');

/**
 * Замок каталога установки (`<prefix>/node_modules/.harness-update.lock`):
 * два каталога состояния с общим каталогом установки не ставят пакеты
 * одновременно.
 */
export const acquirePrefixLock = (prefix: string) =>
  acquireLockAt(
    join(prefix, 'node_modules'),
    '.harness-update.lock',
    'Пакеты этого каталога установки уже обновляет другой harness update',
  );

/**
 * Идёт или прервано обновление этого каталога состояния: живой держатель
 * замка или запись «идёт». Команды, которые пишут состояние или запускают
 * проверки без роли controller (`gates`, `smoke`, `review-code`, ревью плана),
 * в это время отказывают.
 */
export function updateInProgress(stateDir: string): string | undefined {
  const held = readJson<LockBody>(file(stateDir, 'lock'));
  if (holds(held)) return `идёт harness update (процесс ${held!.pid})`;
  if (readInProgress(stateDir))
    return 'прерванное обновление ждёт возврата: harness update --check';
  return undefined;
}

/**
 * Охрана обновления: пауза выдачи, ожидание окончания работы, роль
 * controller с продлением, сигналы прерывания отложены до конца шага.
 * Возвращает причины, если дождаться не удалось.
 */
async function guard(
  host: UpdateHost,
  waitMs: number,
  pollMs: number,
  now: () => number,
  steps: Steps,
): Promise<{ reasons: string[]; still: () => boolean; end: () => void }> {
  const paused = host.pause();
  steps.push(
    step(
      'pause',
      true,
      paused ? 'выдача новых попыток на паузе на время обновления' : 'очередь уже была на паузе',
    ),
  );
  const deadline = now() + waitMs;
  let reasons: string[] = [];
  let held = false;
  try {
    for (;;) {
      reasons = host.live();
      if (!reasons.length) {
        held = host.hold();
        if (held) {
          reasons = host.live();
          if (!reasons.length) break;
          host.release();
          held = false;
        } else reasons = ['роль controller у другого процесса'];
      }
      if (now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
    }
  } catch (error) {
    // Сбой посреди ожидания: роль и пауза не остаются.
    if (held)
      try {
        host.release();
      } catch {
        // истечёт сама
      }
    if (paused)
      try {
        host.resume();
      } catch {
        // снимет следующий update
      }
    throw error;
  }
  const state = { lost: false };
  const timer = held
    ? setInterval(() => {
        try {
          if (!host.hold()) state.lost = true;
        } catch {
          // продление — при следующем тике
        }
      }, host.heartbeatMs)
    : undefined;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const onSignal = () =>
    process.stderr.write(
      'harness update: обновление завершается — прерывание сейчас оставило бы пакеты наполовину; дождитесь окончания\n',
    );
  if (held) for (const s of signals) process.on(s, onSignal);
  return {
    reasons: held ? [] : reasons,
    /** Роль ещё у обновления и ничего не идёт: проверяется перед изменением пакетов. */
    still: () => !state.lost && host.hold() && host.live().length === 0,
    end: () => {
      if (timer) clearInterval(timer);
      for (const s of signals) process.off(s, onSignal);
      if (held)
        try {
          host.release();
        } catch {
          // роль истечёт сама
        }
      if (paused)
        try {
          host.resume();
        } catch {
          // пауза операции снимается следующим update или resume
        }
    },
  };
}

/**
 * Версия читает состояние целиком: `status` её собственным процессом (только
 * чтение). Строгие схемы прежних версий отклоняют поля, записанные новой,
 * даже при том же `stateVersion` — это видно только чтением.
 */
async function readsState(bin: string, stateDir: string, prefix: string) {
  const r = await runTool(process.execPath, [bin, 'status', '--state', stateDir], prefix, 120_000);
  let ok = false;
  try {
    ok = r.code === 0 && (JSON.parse(r.stdout) as { ok?: boolean }).ok === true;
  } catch {
    ok = false;
  }
  return step(
    'state-read',
    ok,
    ok
      ? 'состояние читается этой версией'
      : `status: exit ${r.code} ${(r.stderr.split('\n').find(Boolean) ?? '').slice(0, 300)}`,
  );
}

const bound = (stateDir: string) =>
  existsSync(join(stateDir, 'binding.json')) && existsSync(join(stateDir, 'state.sqlite'));

/** Установленная пара — та, что нужна, и отвечает: `doctor`, `status` и проверка пары панелью. */
async function verifyInstalled(
  prefix: string,
  stateDir: string,
  want: UpdatePair,
): Promise<{ ok: boolean; steps: Steps }> {
  const steps: Steps = [];
  const h = installedPackage(prefix, HARNESS_PACKAGE);
  if (!h || h.version !== want.harness || !h.bin) {
    steps.push(
      step(
        'installed',
        false,
        `ожидалась harness ${want.harness}, установлена ${h?.version ?? 'нет'}`,
      ),
    );
    return { ok: false, steps };
  }
  const ui = want.ui ? installedPackage(prefix, UI_PACKAGE) : undefined;
  if (want.ui && (!ui || ui.version !== want.ui || !ui.bin)) {
    steps.push(
      step('installed', false, `ожидалась панель ${want.ui}, установлена ${ui?.version ?? 'нет'}`),
    );
    return { ok: false, steps };
  }
  steps.push(step('installed', true, pairText(want)));
  const withState = existsSync(join(stateDir, 'binding.json'));
  const doctor = await runTool(
    process.execPath,
    [h.bin, 'doctor', ...(withState ? ['--state', stateDir] : [])],
    prefix,
    180_000,
  );
  let ok = false;
  let detail = '';
  try {
    const env = JSON.parse(doctor.stdout) as {
      ok?: boolean;
      data?: { harness?: string; state?: { compatible?: boolean } };
    };
    ok =
      doctor.code === 0 &&
      env.ok === true &&
      env.data?.harness === want.harness &&
      env.data?.state?.compatible !== false;
    detail = ok
      ? `doctor ${want.harness}: состояние совместимо`
      : `doctor: exit ${doctor.code}, harness ${env.data?.harness ?? '?'}, состояние ${env.data?.state?.compatible === false ? 'несовместимо' : 'не проверено'}`;
  } catch {
    detail = `doctor: exit ${doctor.code}, ответ не JSON: ${npmReason(doctor)}`;
  }
  steps.push(step('doctor', ok, detail));
  if (!ok) return { ok: false, steps };
  if (bound(stateDir)) {
    const read = await readsState(h.bin, stateDir, prefix);
    steps.push(read);
    if (!read.ok) return { ok: false, steps };
  }
  if (ui?.bin) {
    const check = await runTool(
      process.execPath,
      [ui.bin, '--check', '--harness', h.bin],
      prefix,
      120_000,
    );
    const good = check.code === 0;
    steps.push(
      step(
        'panel-check',
        good,
        good
          ? `панель ${ui.version} совместима`
          : `панель --check: exit ${check.code} ${check.stderr.split('\n')[0] ?? ''}`,
      ),
    );
    if (!good) return { ok: false, steps };
  }
  return { ok: true, steps };
}

const installedPair = (prefix: string): UpdatePair | undefined => {
  const h = installedPackage(prefix, HARNESS_PACKAGE)?.version;
  const ui = installedPackage(prefix, UI_PACKAGE)?.version;
  return h ? { harness: h, ...(ui ? { ui } : {}) } : undefined;
};

/**
 * Вернуть пакеты к паре `to`: сохранённые package.json и lockfile и
 * установка по ним (без скриптов); не встала нужная пара (нет lockfile,
 * диапазон в package.json) — точные версии и снова сохранённые файлы байт в
 * байт. Возвращает, совпала ли установленная пара.
 */
async function restorePackages(
  place: InstallPlace,
  manifestDir: string,
  manifests: Record<string, boolean>,
  to: UpdatePair,
  registry: string | undefined,
): Promise<{ ok: boolean; detail: string }> {
  try {
    restoreManifests(place.prefix, manifestDir, manifests);
    const back = await reinstall(place, registry);
    if (back.code === 0 && samePair(installedPair(place.prefix), to))
      return { ok: true, detail: `вернулись ${pairText(to)}` };
    const exact = await installExact(
      place,
      { [HARNESS_PACKAGE]: to.harness, ...(to.ui ? { [UI_PACKAGE]: to.ui } : {}) },
      registry,
      true,
    );
    restoreManifests(place.prefix, manifestDir, manifests);
    const got = installedPair(place.prefix);
    return samePair(got, to)
      ? { ok: true, detail: `вернулись ${pairText(to)} (точными версиями)` }
      : {
          ok: false,
          detail: `npm: ${npmReason(exact.code !== 0 ? exact : back)}; установлены ${got ? pairText(got) : 'нет harness'}`,
        };
  } catch (error) {
    return { ok: false, detail: message(error) };
  }
}

/** Поставить пару точными версиями (только наши записи package.json), без скриптов. */
async function exactPair(
  place: InstallPlace,
  to: UpdatePair,
  registry: string | undefined,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await installExact(
      place,
      { [HARNESS_PACKAGE]: to.harness, ...(to.ui ? { [UI_PACKAGE]: to.ui } : {}) },
      registry,
      true,
    );
    const got = installedPair(place.prefix);
    return samePair(got, to)
      ? { ok: true, detail: `поставлены ${pairText(to)}` }
      : {
          ok: false,
          detail: `npm: ${npmReason(r)}; установлены ${got ? pairText(got) : 'нет harness'}`,
        };
  } catch (error) {
    return { ok: false, detail: message(error) };
  }
}

/** Стоп панелей этого каталога состояния до установки; запуск — после (любой версией). */
async function stopPanel(prefix: string, stateDir: string) {
  const panels = findPanels(prefix, stateDir);
  return panels.length ? await stopPanels(panels) : { stopped: [] as PanelProcess[], failed: [] };
}
async function startPanel(
  prefix: string,
  stateDir: string,
  stopped: { stopped: PanelProcess[]; failed: string[] },
): Promise<string> {
  const ui = installedPackage(prefix, UI_PACKAGE);
  const how = `запустите заново: npx devcontour-harness-ui --state ${stateDir}`;
  if (!ui?.bin) return 'Панель в этом каталоге не установлена.';
  if (!stopped.stopped.length && !stopped.failed.length)
    return `Запущенной панели для этого каталога состояния не найдено; когда понадобится — ${how}`;
  const r = await startPanels(stopped.stopped, ui.bin, file(stateDir, 'panel.log'));
  return [
    ...r.restarted.map(
      (p) =>
        `Панель перезапущена версией ${ui.version} (pid ${p.pid}${p.url ? `, ${p.url}` : ''}).`,
    ),
    ...[...stopped.failed, ...r.failed].map((f) => `Панель не перезапущена: ${f}; ${how}`),
  ].join(' ');
}

/** Хранить две последние пары; копию состояния — только у последней. */
function prune(stateDir: string, entries: HistoryEntry[]): HistoryEntry[] {
  const root = updatesDir(stateDir);
  const kept = entries.slice(-2);
  for (const old of entries.slice(0, -2)) {
    const dir = join(root, 'history', old.id);
    if (existsSync(dir)) removeInside(root, dir);
  }
  for (const e of kept.slice(0, -1)) delete e.stateCopy;
  // Перенесённые живые файлы (`replaced/`) автоматически не удаляются никогда:
  // это настоящее состояние, его убирает человек.
  return kept;
}

/**
 * Убрать копии состояния и каталоги истории, на которые не ссылаются ни
 * пары истории, ни запись «идёт», ни `keep`.
 */
function cleanUp(stateDir: string, entries: HistoryEntry[], keep: string[] = []) {
  const root = updatesDir(stateDir);
  const progress = readInProgress(stateDir);
  const copies = new Set(
    [
      ...keep,
      ...entries.flatMap((e) => (e.stateCopy ? [e.stateCopy.path] : [])),
      ...(progress?.copy ? [progress.copy.path] : []),
    ].map((p) => resolve(p)),
  );
  const dir = join(root, 'copies');
  if (existsSync(dir))
    for (const name of readdirSync(dir))
      if (!copies.has(resolve(join(dir, name)))) removeInside(root, join(dir, name));
  // Временный каталог прерванного возврата копии (`<state>.restore-*`) — только свой шаблон.
  const state = resolve(stateDir);
  const parent = resolve(state, '..');
  for (const name of readdirSync(parent))
    if (name.startsWith(`${basename(state)}.restore-`) && /\.restore-[0-9a-f]{8}$/.test(name))
      rmSync(join(parent, name), { recursive: true, force: true });
  const ids = new Set([...entries.map((e) => e.id), ...(progress ? [progress.id] : [])]);
  const history = join(root, 'history');
  if (existsSync(history))
    for (const name of readdirSync(history))
      if (!ids.has(name)) removeInside(root, join(history, name));
}

/**
 * Завершить прерванное обновление или откат по записи «идёт»: вернуть
 * пакеты к прежней паре и, если состояние изменилось после копии, — копию.
 * Вызывается под замком и охраной (ничего не идёт, роль controller у нас).
 */
async function finishInterrupted(
  stateDir: string,
  progress: InProgress,
  o: { config: UpdatesConfig; npm: NpmOptions; host: UpdateHost; now: () => number },
  steps: Steps,
): Promise<{ ok: boolean; line: string }> {
  const root = updatesDir(stateDir);
  const place = installPlace(progress.prefix);
  const packages = await restorePackages(
    place,
    progress.manifestDir,
    progress.manifests,
    progress.restoreTo,
    o.config.registry ?? o.npm.registry,
  );
  steps.push(step('restore-packages', packages.ok, packages.detail));
  let stateNote = 'состояние не менялось';
  let stateOk = true;
  const changed =
    progress.copy && progress.fingerprint && stateFingerprint(stateDir) !== progress.fingerprint;
  // Возвращённая версия читает живое состояние — оно остаётся: работу после
  // прерванного обновления (например, после resume человека) не терять.
  const restoredBin = installedPackage(progress.prefix, HARNESS_PACKAGE)?.bin;
  const reads =
    changed && packages.ok && bound(stateDir) && restoredBin
      ? await readsState(restoredBin, stateDir, progress.prefix)
      : undefined;
  if (changed && reads?.ok)
    stateNote = 'состояние изменилось, но читается возвращённой версией — оставлено как есть';
  else if (changed && progress.copy) {
    const aside = join(root, 'replaced', `${newId(o.now())}-interrupted`);
    try {
      restoreState(stateDir, progress.copy.path, aside, progress.copy.digest);
      stateNote = `состояние возвращено из копии; изменённые файлы — в ${aside}`;
    } catch (error) {
      stateOk = false;
      stateNote = message(error);
    }
  }
  steps.push(step('restore-state', stateOk, stateNote));
  const ok = packages.ok && stateOk;
  if (!ok) {
    writeInProgress(stateDir, { ...progress, failed: true });
    return {
      ok,
      line: `ВНИМАНИЕ: прерванное обновление не удалось вернуть (${packages.ok ? stateNote : packages.detail}). Верните руками: package.json и lockfile — из ${progress.manifestDir} (затем npm install в ${progress.prefix})${progress.copy ? `, состояние — копия ${progress.copy.path}` : ''}. Пока это не сделано, update ничего не ставит.`,
    };
  }
  const record = {
    action: 'restored' as const,
    from: installedPair(progress.prefix) ?? progress.restoreTo,
    to: progress.restoreTo,
    by: 'operator' as const,
    reason: 'обновление было прервано; возвращена прежняя пара',
  };
  try {
    o.host.record(record);
  } catch {
    // запись остаётся в journal.jsonl
  }
  journal(stateDir, { at: new Date(o.now()).toISOString(), ...record });
  clearInProgress(stateDir);
  cleanUp(stateDir, readHistory(stateDir));
  // Пауза прерванного обновления (живая или из копии) — снять.
  o.host.resume();
  return {
    ok,
    line: `Прерванное обновление завершено возвратом: ${pairText(progress.restoreTo)}, ${stateNote}.`,
  };
}

/**
 * Прервавшееся обновление: замок умершего процесса, пауза операции, запись
 * «идёт». С `--check` (без ожидания) — снять паузу, если записи нет, и
 * завершить возврат, если ничего не идёт; иначе сказать, что нужно.
 */
export async function recoverInterrupted(
  stateDir: string,
  o: { config: UpdatesConfig; npm: NpmOptions; host: UpdateHost; now?: () => number },
): Promise<string | undefined> {
  const lock = lockBoth(stateDir, readInProgress(stateDir)?.prefix);
  try {
    const progress = readInProgress(stateDir);
    if (!progress) {
      o.host.resume();
      return undefined;
    }
    const steps: Steps = [];
    const g = await guard(o.host, 0, 1000, o.now ?? Date.now, steps);
    try {
      if (g.reasons.length)
        return `Прерванное обновление ждёт возврата, но сейчас идёт работа (${g.reasons[0]}); повторите harness update --check позже.`;
      return (await finishInterrupted(stateDir, progress, { ...o, now: o.now ?? Date.now }, steps))
        .line;
    } finally {
      g.end();
      // Пауза прерванного обновления — тоже снять (запись «идёт» закрыта или помечена).
      if (!readInProgress(stateDir)) o.host.resume();
    }
  } finally {
    lock.release();
  }
}

/** Прерванное или незавершённое прошлое: закрыть до нового шага; не вышло — отказ. */
async function settlePast(
  stateDir: string,
  o: { config: UpdatesConfig; npm: NpmOptions; host: UpdateHost; now: () => number },
  steps: Steps,
): Promise<string | undefined> {
  const progress = readInProgress(stateDir);
  if (!progress) return undefined;
  const r = await finishInterrupted(stateDir, progress, o, steps);
  return r.ok ? undefined : r.line;
}

export async function applyUpdate(o: ApplyOptions): Promise<Result> {
  const now = o.now ?? Date.now;
  const lock = lockBoth(o.stateDir, readInProgress(o.stateDir)?.prefix ?? o.prefix);
  try {
    // Под замком, без записи «идёт», пауза операции обновления — ничья: снять.
    if (!readInProgress(o.stateDir)) o.host.resume();
    if (o.scheduled && o.config.mode === 'off')
      return {
        data: {
          action: 'apply',
          outcome: 'skipped',
          line: 'Обновления выключены (mode: off): ничего не проверено.',
        },
        code: 0,
      };
    const check =
      o.check ??
      (await checkUpdates({
        stateDir: o.stateDir,
        prefix: o.prefix,
        config: o.config,
        npm: o.npm,
        now,
      }));
    saveLastCheck(o.stateDir, check);
    const base = { action: 'apply' as const, check, from: check.current };
    const pending = readInProgress(o.stateDir);
    if (check.state === 'unavailable' && !pending)
      return { data: { ...base, outcome: 'unavailable', line: check.line }, code: 4 };
    if ((check.state === 'up-to-date' || !check.available) && !pending)
      return { data: { ...base, outcome: 'up-to-date', line: check.line }, code: 0 };
    const target = check.available;
    if (
      target &&
      check.state === 'needs-decision' &&
      (o.scheduled || o.confirmFormats !== pairToken(target)) &&
      !pending
    )
      return {
        data: {
          ...base,
          to: target,
          outcome: 'needs-decision',
          line: `${o.confirmFormats && o.confirmFormats !== pairToken(target) ? `Решение было о ${o.confirmFormats}, а реестр сейчас предлагает ${pairToken(target)}: ничего не поставлено. ` : ''}Нужно ваше решение: ${pairText(target)} меняет форматы (${(check.formatChanges ?? []).join(', ')}); автоматически не ставится. Последствия: прежняя версия не прочтёт новое состояние без отката копией. Поставить: ${check.command ?? 'harness update --apply --confirm-formats'}`,
        },
        code: 3,
      };
    if (target && o.scheduled && !pending) {
      const skipped = readSkips(o.stateDir).find((s) => skippedBy(s, target, check.current));
      if (skipped) {
        const line = `${pairText(target)} по расписанию не ставится: ${skipped.reason}. Поставить вручную: harness update --apply --state ${o.stateDir}`;
        saveLastCheck(o.stateDir, { ...check, line: line.slice(0, 300) });
        return {
          data: {
            ...base,
            to: target,
            outcome: 'skipped',
            line,
          },
          code: 0,
        };
      }
      const harnessChanges = target.harness !== check.current.harness;
      if (o.config.mode !== 'auto' || (o.config.autoScope === 'ui-only' && harnessChanges))
        return {
          data: {
            ...base,
            to: target,
            outcome: 'skipped',
            line: `${check.line} (режим ${o.config.mode}${o.config.mode === 'auto' ? `, пределы ${o.config.autoScope}` : ''}: само не ставится)`,
          },
          code: 0,
        };
    }
    // Никогда во время прогона: ждать (с паузой и ролью controller) или отказать.
    const steps: Steps = [];
    const first = o.host.live();
    if (first.length && !o.waitMs)
      return {
        data: {
          ...base,
          ...(target ? { to: target } : {}),
          outcome: 'busy',
          steps: [step('idle', false, first.join('; '))],
          line: `Сейчас идёт работа (${first[0]}): обновление не ставится посреди прогона. Повторите после окончания или с --wait <минуты>.`,
        },
        code: 3,
      };
    const g = await guard(o.host, o.waitMs ?? 0, o.pollMs ?? 2000, now, steps);
    try {
      if (g.reasons.length)
        return {
          data: {
            ...base,
            ...(target ? { to: target } : {}),
            outcome: 'busy',
            steps: [...steps, step('idle', false, g.reasons.join('; '))],
            line: `Работа не закончилась за отведённое время (${g.reasons[0]}): обновление отложено, пакеты не тронуты, пауза обновления снята.`,
          },
          code: 3,
        };
      steps.push(
        step(
          'idle',
          true,
          'прогонов, попыток и совместных проверок нет; роль controller у обновления',
        ),
      );
      const unsettled = await settlePast(o.stateDir, { ...o, now }, steps);
      if (unsettled)
        return { data: { ...base, outcome: 'restore-failed', steps, line: unsettled }, code: 4 };
      if (pending)
        return {
          data: {
            ...base,
            outcome: 'restored',
            steps,
            line: 'Прерванное прошлое обновление завершено возвратом; запустите обновление ещё раз.',
          },
          code: 0,
        };
      if (!target) return { data: { ...base, outcome: 'up-to-date', line: check.line }, code: 0 };
      return await install(o, check, target, steps, now, g.still);
    } finally {
      g.end();
    }
  } finally {
    lock.release();
  }
}

async function install(
  o: ApplyOptions,
  check: UpdateCheck,
  target: UpdatePair,
  steps: Steps,
  now: () => number,
  still: () => boolean,
): Promise<Result> {
  const base = { action: 'apply' as const, check, from: check.current, to: target };
  const root = updatesDir(o.stateDir);
  const id = newId(now());
  const place = installPlace(o.prefix);
  const registry = o.config.registry ?? o.npm.registry;
  const copy = copyState(o.stateDir, join(root, 'copies', id));
  verifyCopy(copy.path, copy.digest);
  const fingerprint = stateFingerprint(o.stateDir);
  steps.push(step('state-copy', true, `${copy.files} файлов, sha256 ${copy.digest.slice(0, 12)}`));
  const manifestDir = join(root, 'history', id, 'manifests');
  const manifests = saveManifests(o.prefix, manifestDir);
  const fromFormats = installedPackage(o.prefix, HARNESS_PACKAGE)?.formats;
  // До первого изменения пакетов: по этой записи следующий update завершит возврат.
  writeInProgress(o.stateDir, {
    id,
    kind: 'apply',
    at: new Date(now()).toISOString(),
    prefix: resolve(o.prefix),
    restoreTo: check.current,
    manifestDir,
    manifests,
    copy: { path: copy.path, digest: copy.digest },
    fingerprint,
  });
  // Копия синхронна и могла занять дольше аренды: роль и тишина — ещё раз.
  if (!still()) {
    clearInProgress(o.stateDir);
    cleanUp(o.stateDir, readHistory(o.stateDir));
    return {
      data: {
        ...base,
        outcome: 'busy',
        steps: [
          ...steps,
          step('idle', false, 'за время копии началась работа или роль controller перешла'),
        ],
        line: 'За время подготовки началась работа: обновление отложено, пакеты не тронуты.',
      },
      code: 3,
    };
  }
  const panels = await stopPanel(o.prefix, o.stateDir);
  const versions: Record<string, string> = {};
  if (target.harness !== check.current.harness) versions[HARNESS_PACKAGE] = target.harness;
  // Пакеты пары ставятся вместе: у панели — точная версия даже без смены.
  if (target.ui && (target.ui !== check.current.ui || versions[HARNESS_PACKAGE]))
    versions[UI_PACKAGE] = target.ui;
  let failure: string | undefined;
  try {
    const installed = await installExact(place, versions, registry);
    if (installed.code !== 0) {
      failure = 'установка: ' + npmReason(installed);
      steps.push(step('install', false, failure));
    } else {
      steps.push(
        step(
          'install',
          true,
          Object.entries(versions)
            .map(([n, v]) => `${n}@${v}`)
            .join(' '),
        ),
      );
      const verified = await verifyInstalled(o.prefix, o.stateDir, target);
      steps.push(...verified.steps);
      if (!verified.ok)
        failure = verified.steps.find((s) => !s.ok)?.detail ?? 'проверка новой версии';
    }
  } catch (error) {
    failure = 'установка: ' + message(error);
    steps.push(step('install', false, failure));
  }

  if (failure) {
    // Автоматический возврат: прежние package.json, lockfile и пакеты; копия — если состояние менялось.
    const packages = await restorePackages(place, manifestDir, manifests, check.current, registry);
    steps.push(step('restore-packages', packages.ok, packages.detail));
    let stateNote = 'состояние не менялось — копия не понадобилась';
    let stateOk = true;
    let restoredState = false;
    try {
      if (stateFingerprint(o.stateDir) !== fingerprint) {
        const aside = join(root, 'replaced', newId(now()));
        restoreState(o.stateDir, copy.path, aside, copy.digest);
        restoredState = true;
        stateNote = `состояние возвращено из копии; изменённые файлы — в ${aside}`;
      }
    } catch (error) {
      stateOk = false;
      stateNote = message(error);
    }
    steps.push(step('restore-state', stateOk, stateNote));
    const ok = packages.ok && stateOk;
    const record = {
      action: 'restored' as const,
      from: target,
      to: check.current,
      by: o.by,
      reason: failure.slice(0, 500),
    };
    if (ok) {
      try {
        o.host.record(record);
      } catch {
        // журнал состояния недоступен — запись остаётся в journal.jsonl
      }
      clearInProgress(o.stateDir);
      addSkip(
        o.stateDir,
        target,
        'не прошла проверку и была возвращена',
        new Date(now()).toISOString(),
      );
    } else writeInProgress(o.stateDir, { ...readInProgress(o.stateDir)!, failed: true });
    journal(o.stateDir, { at: new Date(now()).toISOString(), ...record, ok });
    const kept = prune(o.stateDir, readHistory(o.stateDir));
    writeHistory(o.stateDir, kept);
    cleanUp(o.stateDir, kept, restoredState ? [copy.path] : []);
    const panel = await startPanel(o.prefix, o.stateDir, panels);
    return {
      data: {
        ...base,
        outcome: ok ? 'restored' : 'restore-failed',
        steps,
        ...(restoredState || !ok ? { stateCopy: { path: copy.path, digest: copy.digest } } : {}),
        panel,
        line: ok
          ? `Обновление до ${pairText(target)} не прошло проверку (${failure}); автоматически возвращены ${pairText(check.current)}, ${stateNote}.`
          : `ВНИМАНИЕ: обновление не прошло (${failure}), и вернуть всё автоматически не удалось (${packages.ok ? stateNote : packages.detail}). Верните руками: package.json и lockfile — из ${manifestDir} (затем npm install в ${o.prefix}), состояние — копия ${copy.path}. Пока это не сделано, update ничего не ставит.`,
      },
      code: 4,
    };
  }

  const entry: HistoryEntry = {
    id,
    at: new Date(now()).toISOString(),
    from: check.current,
    to: target,
    ...(fromFormats ? { fromFormats } : {}),
    prefix: resolve(o.prefix),
    manager: place.manager,
    manifests,
    stateCopy: { path: copy.path, digest: copy.digest },
  };
  const toFormats = installedPackage(o.prefix, HARNESS_PACKAGE)?.formats;
  if (toFormats) entry.toFormats = toFormats;
  // Сначала закрыть «идёт»: падение между записями не откатит готовое обновление.
  clearInProgress(o.stateDir);
  const kept = prune(o.stateDir, [...readHistory(o.stateDir), entry]);
  writeHistory(o.stateDir, kept);
  cleanUp(o.stateDir, kept);
  writeSkips(
    o.stateDir,
    readSkips(o.stateDir).filter((s) => !samePair(s, target)),
  );
  const record = { action: 'applied' as const, from: check.current, to: target, by: o.by };
  try {
    o.host.record(record);
    steps.push(step('event', true, `обновлено с ${check.current.harness} до ${target.harness}`));
  } catch (error) {
    steps.push(step('event', false, message(error)));
  }
  journal(o.stateDir, { at: new Date(now()).toISOString(), ...record });
  saveLastCheck(o.stateDir, {
    checkedAt: new Date(now()).toISOString(),
    mode: check.mode,
    channel: check.channel,
    state: 'up-to-date',
    current: target,
    line: `Установлены ${pairText(target)}: обновлено ${new Date(now()).toISOString().slice(0, 16).replace('T', ' ')} с ${check.current.harness}.`,
  });
  const panel = await startPanel(o.prefix, o.stateDir, panels);
  return {
    data: {
      ...base,
      outcome: 'applied',
      steps,
      stateCopy: { path: copy.path, digest: copy.digest },
      panel,
      line: `Обновлено с ${pairText(check.current)} до ${pairText(target)}. ${panel}`,
    },
    code: 0,
  };
}

export interface RollbackOptions {
  stateDir: string;
  config: UpdatesConfig;
  npm: NpmOptions;
  host: UpdateHost;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
}

/**
 * `harness update --rollback`: вернуть прошлую пару. Прежняя версия читает
 * живое состояние (`status` её процессом), а форматы не различаются —
 * состояние остаётся как есть, работа после обновления не теряется. Иначе
 * состояние возвращается из последней копии, а живые файлы переносятся в
 * `replaced`. Сбой на любом шаге — возврат новой пары и её состояния.
 */
export async function rollbackUpdate(o: RollbackOptions): Promise<Result> {
  const now = o.now ?? Date.now;
  const lock = lockBoth(
    o.stateDir,
    readInProgress(o.stateDir)?.prefix ?? readHistory(o.stateDir).at(-1)?.prefix,
  );
  try {
    if (!readInProgress(o.stateDir)) o.host.resume();
    const history = readHistory(o.stateDir);
    const entry = history.at(-1);
    const pending = readInProgress(o.stateDir);
    if (!entry && !pending)
      return {
        data: {
          action: 'rollback',
          outcome: 'nothing-to-roll-back',
          line: 'Откатывать нечего: обновлений этой командой не было.',
        },
        code: 3,
      };
    const ends = entry ? { from: entry.to, to: entry.from } : {};
    // Обе стороны известны и различаются — прежняя версия не прочтёт новое состояние.
    const formatsDiffer =
      !!entry?.fromFormats &&
      !!entry.toFormats &&
      formatChanges(entry.fromFormats, entry.toFormats).length > 0;
    if (entry && formatsDiffer && !pending) {
      try {
        if (!entry.stateCopy) throw new Error('копии нет');
        verifyCopy(entry.stateCopy.path, entry.stateCopy.digest);
      } catch (error) {
        return {
          data: {
            action: 'rollback',
            outcome: 'restore-failed',
            ...ends,
            line: `Откат невозможен: форматы версий различаются, а копия состояния недоступна (${message(error)}). Ничего не изменено.`,
          },
          code: 3,
        };
      }
    }
    const steps: Steps = [];
    const first = o.host.live();
    if (first.length && !o.waitMs)
      return {
        data: {
          action: 'rollback',
          outcome: 'busy',
          ...ends,
          steps: [step('idle', false, first.join('; '))],
          line: `Сейчас идёт работа (${first[0]}): откат не делается посреди прогона. Повторите после окончания или с --wait <минуты>.`,
        },
        code: 3,
      };
    const g = await guard(o.host, o.waitMs ?? 0, o.pollMs ?? 2000, now, steps);
    try {
      if (g.reasons.length)
        return {
          data: {
            action: 'rollback',
            outcome: 'busy',
            ...ends,
            steps: [...steps, step('idle', false, g.reasons.join('; '))],
            line: `Работа не закончилась за отведённое время (${g.reasons[0]}): откат отложен.`,
          },
          code: 3,
        };
      const unsettled = await settlePast(o.stateDir, { ...o, now }, steps);
      if (unsettled)
        return {
          data: { action: 'rollback', outcome: 'restore-failed', steps, line: unsettled },
          code: 4,
        };
      if (pending)
        return {
          data: {
            action: 'rollback',
            outcome: 'restored',
            steps,
            line: 'Прерванное обновление завершено возвратом прежней пары.',
          },
          code: 0,
        };
      return await rollBack(o, entry!, history, formatsDiffer, steps, now);
    } finally {
      g.end();
    }
  } finally {
    lock.release();
  }
}

async function rollBack(
  o: RollbackOptions,
  entry: HistoryEntry,
  history: HistoryEntry[],
  formatsDiffer: boolean,
  steps: Steps,
  now: () => number,
): Promise<Result> {
  const root = updatesDir(o.stateDir);
  const place = installPlace(entry.prefix);
  const registry = o.config.registry ?? o.npm.registry;
  const ends = { from: entry.to, to: entry.from };
  const id = newId(now());
  // Текущие файлы установки и состояние — чтобы вернуть всё, если откат не встанет.
  const current = join(root, 'history', id, 'manifests');
  const currentManifests = saveManifests(entry.prefix, current);
  const currentState = copyState(o.stateDir, join(root, 'copies', id));
  writeInProgress(o.stateDir, {
    id,
    kind: 'rollback',
    at: new Date(now()).toISOString(),
    prefix: entry.prefix,
    restoreTo: entry.to,
    manifestDir: current,
    manifests: currentManifests,
    copy: { path: currentState.path, digest: currentState.digest },
    fingerprint: stateFingerprint(o.stateDir),
  });
  const panels = await stopPanel(entry.prefix, o.stateDir);
  let stateRestored = false;
  const undo = async (why: string): Promise<Result> => {
    let stateOk = true;
    if (stateRestored)
      try {
        restoreState(
          o.stateDir,
          currentState.path,
          join(root, 'replaced', `${newId(now())}-undo`),
          currentState.digest,
        );
      } catch (error) {
        stateOk = false;
        steps.push(step('restore-state', false, message(error)));
      }
    const packages = place.dedicated
      ? await restorePackages(place, current, currentManifests, entry.to, registry)
      : await exactPair(place, entry.to, registry);
    steps.push(step('restore-packages', packages.ok, packages.detail));
    const ok = packages.ok && stateOk;
    if (ok) clearInProgress(o.stateDir);
    else writeInProgress(o.stateDir, { ...readInProgress(o.stateDir)!, failed: true });
    cleanUp(o.stateDir, history);
    const panel = await startPanel(entry.prefix, o.stateDir, panels);
    return {
      data: {
        action: 'rollback',
        outcome: 'restore-failed',
        ...ends,
        steps,
        panel,
        line: `Откат до ${pairText(entry.from)} не прошёл (${why}); ${ok ? `оставлены ${pairText(entry.to)} и их состояние` : `верните руками файлы из ${current} (затем npm install), состояние — копия ${currentState.path}`}.`,
      },
      code: 4,
    };
  };
  // Каталог инструментов — целиком прежние файлы; проект — только наши две
  // записи точными версиями: зависимости, добавленные после обновления, целы.
  const back = place.dedicated
    ? await restorePackages(
        place,
        join(root, 'history', entry.id, 'manifests'),
        entry.manifests,
        entry.from,
        registry,
      )
    : await exactPair(place, entry.from, registry);
  steps.push(step('install', back.ok, back.detail));
  if (!back.ok) return await undo('установка прежних версий');
  // Прежняя версия читает живое состояние? Строгие схемы отклоняют поля новой версии.
  const old = installedPackage(entry.prefix, HARNESS_PACKAGE);
  const reads =
    bound(o.stateDir) && old?.bin ? await readsState(old.bin, o.stateDir, entry.prefix) : undefined;
  let stateNote =
    'состояние читается прежней версией — оставлено как есть, работа после обновления сохранена';
  if (formatsDiffer || (reads && !reads.ok)) {
    if (!entry.stateCopy) {
      if (reads) steps.push(reads);
      return await undo('прежняя версия не читает состояние, а копии нет');
    }
    const aside = join(root, 'replaced', newId(now()));
    try {
      restoreState(o.stateDir, entry.stateCopy.path, aside, entry.stateCopy.digest);
      stateRestored = true;
    } catch (error) {
      return await undo('копия состояния: ' + message(error));
    }
    stateNote = `состояние возвращено из копии ${entry.at} (${formatsDiffer ? 'форматы различались' : 'прежняя версия не читала новое'}); состояние новой версии — в ${aside}`;
  }
  steps.push(step('restore-state', true, stateNote));
  const verified = await verifyInstalled(entry.prefix, o.stateDir, entry.from);
  steps.push(...verified.steps);
  if (!verified.ok) return await undo(verified.steps.find((x) => !x.ok)?.detail ?? 'проверка');
  // В возвращённой копии — пауза прошлого обновления: снять (своя пауза снимется в конце).
  if (stateRestored) o.host.resume();
  const record = {
    action: 'rolled-back' as const,
    from: entry.to,
    to: entry.from,
    by: 'operator' as const,
  };
  try {
    o.host.record(record);
  } catch {
    // журнал состояния недоступен — запись остаётся в journal.jsonl
  }
  journal(o.stateDir, { at: new Date(now()).toISOString(), ...record });
  addSkip(o.stateDir, entry.to, 'откачена вручную', new Date(now()).toISOString());
  const kept = history.slice(0, -1);
  clearInProgress(o.stateDir);
  writeHistory(o.stateDir, kept);
  // Копия перед откатом не нужна: состояние новой версии осталось живым или лежит в replaced.
  cleanUp(o.stateDir, kept);
  saveLastCheck(o.stateDir, {
    checkedAt: new Date(now()).toISOString(),
    mode: o.config.mode,
    channel: o.config.channel,
    state: 'available',
    current: entry.from,
    available: entry.to,
    line: `Возвращены ${pairText(entry.from)} (откат с ${entry.to.harness}); ${pairText(entry.to)} по расписанию больше не ставится, вручную — harness update --apply --state ${o.stateDir}.`.slice(
      0,
      300,
    ),
  });
  const panel = await startPanel(entry.prefix, o.stateDir, panels);
  return {
    data: {
      action: 'rollback',
      outcome: 'rolled-back',
      ...ends,
      steps,
      panel,
      line: `Откат: вернулись ${pairText(entry.from)} (была ${pairText(entry.to)}); ${stateNote}. ${panel}`,
    },
    code: 0,
  };
}
