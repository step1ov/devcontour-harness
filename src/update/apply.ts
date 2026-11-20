import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  HarnessError,
  type PackageFormats,
  type UpdateCheck,
  type UpdateData,
  type UpdatePair,
  type UpdatesConfig,
} from '../contracts/index.ts';
import type { RunEventPayload } from '../contracts/events.ts';
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
  type InstallPlace,
} from './install.ts';
import { npmReason, runTool, type NpmOptions } from './npm.ts';
import { findPanels, restartPanels } from './panel.ts';
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
 * Порядок применения: проверка реестра → решение (смена форматов — только
 * решением владельца) → нет прогона (иначе пауза очереди и ожидание с
 * `--wait`, или отказ) → пауза операции `harness-update` → копия состояния с
 * контрольной суммой → сохранение package.json и lockfile → установка точных
 * версий обоих пакетов → `doctor` новой версии и проверка пары панелью →
 * запись `harness.updated` → перезапуск панели → снятие своей паузы. Любой
 * сбой после начала установки — автоматический возврат прежних версий; если
 * состояние успели изменить — и копии состояния. Хранятся две последние
 * пары и одна (последняя) копия состояния.
 *
 * Этот процесс — прежняя версия harness: после установки он не загружает
 * новых модулей; проверки новой версии идут её собственным процессом.
 */

export const UPDATE_OPERATION = 'harness-update';

export interface UpdateHost {
  /** Что идёт сейчас: живой controller, попытки, совместные проверки, задания графа. */
  live(): string[];
  /** Пауза операции обновления; false — очередь уже на паузе не нами. */
  pause(): boolean;
  /** Снять паузу операции обновления (только свою). */
  resume(): boolean;
  /** Событие `harness.updated` в журнале состояния. */
  record(payload: RunEventPayload<'harness.updated'>): void;
}

export interface HistoryEntry {
  id: string;
  at: string;
  from: UpdatePair;
  to: UpdatePair;
  fromFormats?: PackageFormats;
  toFormats?: PackageFormats;
  prefix: string;
  manager: InstallPlace['manager'];
  manifests: Record<string, boolean>;
  stateCopy?: { path: string; digest: string };
}

export interface ApplyOptions {
  stateDir: string;
  prefix: string;
  config: UpdatesConfig;
  npm: NpmOptions;
  host: UpdateHost;
  by: 'operator' | 'schedule';
  scheduled?: boolean;
  confirmFormats?: boolean;
  /** Ждать окончания прогона до этого срока (мс); 0 — не ждать. */
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Повторно использовать уже выполненную проверку (только тесты и `--check --apply`). */
  check?: UpdateCheck;
}

type Result = { data: UpdateData; code: number };
const step = (name: string, ok: boolean, detail?: string) => ({
  step: name,
  ok,
  ...(detail ? { detail: detail.slice(0, 1000) } : {}),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
const pairText = (p: UpdatePair) => `harness ${p.harness}${p.ui ? ` и панель ${p.ui}` : ''}`;
const historyFile = (stateDir: string) => join(updatesDir(stateDir), 'history.json');

export function readHistory(stateDir: string): HistoryEntry[] {
  try {
    const raw = JSON.parse(readFileSync(historyFile(stateDir), 'utf8')) as {
      entries?: HistoryEntry[];
    };
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}
function writeHistory(stateDir: string, entries: HistoryEntry[]) {
  writeAtomic(historyFile(stateDir), JSON.stringify({ entries }, null, 2) + '\n');
}

/** Запись в `<state>-updates/journal.jsonl`: виден и без каталога состояния harness. */
function journal(stateDir: string, record: Record<string, unknown>) {
  const dir = updatesDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, 'journal.jsonl'), 'a');
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

/**
 * Замок каталога обновлений: одно обновление за раз. Замок умершего
 * процесса снимается; его пауза операции снимается вызывающим.
 */
export function acquireLock(stateDir: string): { release: () => void; recovered: boolean } {
  const dir = updatesDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'lock');
  let recovered = false;
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return {
        recovered,
        release: () => {
          try {
            const held = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number };
            if (held.pid === process.pid) rmSync(file);
          } catch {
            // уже снят
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number | undefined;
      try {
        pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid;
      } catch {
        pid = undefined;
      }
      if (pid !== undefined && alive(pid))
        throw new HarnessError(
          'CONTROLLER_BUSY',
          `Обновление уже идёт (процесс ${pid}); дождитесь его окончания`,
        );
      rmSync(file, { force: true });
      recovered = true;
    }
  }
  throw new HarnessError('CONTROLLER_BUSY', 'Замок обновления не взят');
}

/** Ждать, пока ничего не идёт; `waitMs` 0 — один взгляд. Возвращает оставшиеся причины. */
async function waitIdle(host: UpdateHost, waitMs: number, pollMs: number, now: () => number) {
  const deadline = now() + waitMs;
  let reasons = host.live();
  while (reasons.length && now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    reasons = host.live();
  }
  return reasons;
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

/** Новая версия отвечает: `doctor` и `status` её собственным процессом и проверка пары панелью. */
async function verifyInstalled(
  prefix: string,
  stateDir: string,
  want: UpdatePair,
): Promise<{ ok: boolean; steps: UpdateData['steps'] & object }> {
  const steps: NonNullable<UpdateData['steps']> = [];
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
  const bound = existsSync(join(stateDir, 'binding.json'));
  const doctor = await runTool(
    process.execPath,
    [h.bin, 'doctor', ...(bound ? ['--state', stateDir] : [])],
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
  if (bound && existsSync(join(stateDir, 'state.sqlite'))) {
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

/** Перезапуск панели этого каталога состояния новой версией (или как это сделать). */
async function restartPanel(prefix: string, stateDir: string): Promise<string> {
  const ui = installedPackage(prefix, UI_PACKAGE);
  if (!ui?.bin) return 'Панель в этом каталоге не установлена.';
  const panels = findPanels(prefix, stateDir);
  const how = `запустите заново: npx devcontour-harness-ui --state ${stateDir}`;
  if (!panels.length)
    return `Запущенной панели для этого каталога состояния не найдено; когда понадобится — ${how}`;
  const log = join(updatesDir(stateDir), 'panel.log');
  const r = await restartPanels(panels, ui.bin, log);
  const parts = [
    ...r.restarted.map(
      (p) =>
        `Панель перезапущена версией ${ui.version} (pid ${p.pid}${p.url ? `, ${p.url}` : ''}).`,
    ),
    ...r.failed.map((f) => `Панель не перезапущена: ${f}; ${how}`),
  ];
  return parts.join(' ');
}

/** Хранить две последние пары; копию состояния — только у последней. */
function prune(stateDir: string, entries: HistoryEntry[]): HistoryEntry[] {
  const root = updatesDir(stateDir);
  const kept = entries.slice(-2);
  for (const old of entries.slice(0, -2)) {
    const dir = join(root, 'history', old.id);
    if (existsSync(dir)) removeInside(root, dir);
    if (old.stateCopy && existsSync(old.stateCopy.path)) removeInside(root, old.stateCopy.path);
  }
  for (const e of kept.slice(0, -1))
    if (e.stateCopy) {
      if (existsSync(e.stateCopy.path)) removeInside(root, e.stateCopy.path);
      delete e.stateCopy;
    }
  // Каталоги «replaced» (перенесённые живые файлы при возврате копии) — два последних.
  const replaced = join(root, 'replaced');
  if (existsSync(replaced))
    for (const name of readdirSync(replaced).sort().slice(0, -2))
      removeInside(root, join(replaced, name));
  return kept;
}

/** Убрать копии состояния, на которые не ссылается ни последняя пара, ни `keep`. */
function cleanCopies(stateDir: string, entries: HistoryEntry[], keep: string[] = []) {
  const root = updatesDir(stateDir);
  const dir = join(root, 'copies');
  if (!existsSync(dir)) return;
  const wanted = new Set([
    ...keep.map((p) => resolve(p)),
    ...entries.flatMap((e) => (e.stateCopy ? [resolve(e.stateCopy.path)] : [])),
  ]);
  for (const name of readdirSync(dir))
    if (!wanted.has(resolve(join(dir, name)))) removeInside(root, join(dir, name));
}

/** Последняя запись журнала обновлений этого каталога состояния. */
function lastJournal(stateDir: string): { action?: string; from?: UpdatePair } | undefined {
  try {
    const lines = readFileSync(join(updatesDir(stateDir), 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n');
    return JSON.parse(lines.at(-1)!) as { action?: string; from?: UpdatePair };
  } catch {
    return undefined;
  }
}

/** Прервавшееся обновление оставило паузу операции: снять её, если замка нет. */
export function recoverInterrupted(stateDir: string, host: UpdateHost): boolean {
  const lock = acquireLock(stateDir);
  try {
    return host.resume();
  } finally {
    lock.release();
  }
}

export async function applyUpdate(o: ApplyOptions): Promise<Result> {
  const now = o.now ?? Date.now;
  const lock = acquireLock(o.stateDir);
  let paused = false;
  try {
    // Замок прежнего процесса был мёртв — и его пауза операции тоже.
    if (lock.recovered) o.host.resume();
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
    if (check.state === 'unavailable')
      return { data: { ...base, outcome: 'unavailable', line: check.line }, code: 4 };
    if (check.state === 'up-to-date' || !check.available)
      return { data: { ...base, outcome: 'up-to-date', line: check.line }, code: 0 };
    const target = check.available;
    if (check.state === 'needs-decision' && (o.scheduled || !o.confirmFormats))
      return {
        data: {
          ...base,
          to: target,
          outcome: 'needs-decision',
          line: `Нужно ваше решение: ${pairText(target)} меняет форматы (${(check.formatChanges ?? []).join(', ')}); автоматически не ставится. Последствия: прежняя версия не прочтёт новое состояние без отката копией. Поставить: ${check.command ?? 'harness update --apply --confirm-formats'}`,
        },
        code: 3,
      };
    if (o.scheduled) {
      // Та же пара уже не прошла проверку: по расписанию не повторяется, только вручную.
      const last = lastJournal(o.stateDir);
      if (
        last?.action === 'restored' &&
        last.from?.harness === target.harness &&
        last.from?.ui === target.ui
      )
        return {
          data: {
            ...base,
            to: target,
            outcome: 'skipped',
            line: `Прошлое обновление до ${pairText(target)} не прошло проверку и было возвращено; по расписанию не повторяется. Поставить вручную: harness update --apply --state ${o.stateDir}`,
          },
          code: 0,
        };
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
    // Никогда во время прогона: ждать (с паузой очереди) или отказать.
    const steps: NonNullable<UpdateData['steps']> = [];
    let reasons = o.host.live();
    if (reasons.length && !o.waitMs)
      return {
        data: {
          ...base,
          to: target,
          outcome: 'busy',
          steps: [step('idle', false, reasons.join('; '))],
          line: `Сейчас идёт работа (${reasons[0]}): обновление не ставится посреди прогона. Повторите после окончания или с --wait <минуты>.`,
        },
        code: 3,
      };
    paused = o.host.pause();
    steps.push(
      step(
        'pause',
        true,
        paused ? 'выдача новых попыток на паузе на время обновления' : 'очередь уже была на паузе',
      ),
    );
    reasons = await waitIdle(o.host, o.waitMs ?? 0, o.pollMs ?? 2000, now);
    if (reasons.length)
      return {
        data: {
          ...base,
          to: target,
          outcome: 'busy',
          steps: [...steps, step('idle', false, reasons.join('; '))],
          line: `Работа не закончилась за отведённое время (${reasons[0]}): обновление отложено, очередь снова идёт.`,
        },
        code: 3,
      };
    steps.push(step('idle', true, 'прогонов, попыток и совместных проверок нет'));

    const root = updatesDir(o.stateDir);
    const id = stamp(now());
    const place = installPlace(o.prefix);
    const copyPath = join(root, 'copies', id);
    const copy = copyState(o.stateDir, copyPath);
    verifyCopy(copy.path, copy.digest);
    const fingerprint = stateFingerprint(o.stateDir);
    steps.push(
      step('state-copy', true, `${copy.files} файлов, sha256 ${copy.digest.slice(0, 12)}`),
    );
    const manifestDir = join(root, 'history', id, 'manifests');
    const manifests = saveManifests(o.prefix, manifestDir);
    const fromFormats = installedPackage(o.prefix, HARNESS_PACKAGE)?.formats;
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

    const versions: Record<string, string> = {};
    if (target.harness !== check.current.harness) versions[HARNESS_PACKAGE] = target.harness;
    if (target.ui && target.ui !== check.current.ui) versions[UI_PACKAGE] = target.ui;
    // Пакеты пары ставятся вместе: у панели — точная версия даже без смены.
    if (target.ui && !versions[UI_PACKAGE] && versions[HARNESS_PACKAGE])
      versions[UI_PACKAGE] = target.ui;
    let failure: string | undefined;
    try {
      const installed = await installExact(place, versions, o.config.registry ?? o.npm.registry);
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
      // Любой сбой после начала установки — тот же возврат.
      failure = 'установка: ' + ((error as Error)?.message ?? String(error));
      steps.push(step('install', false, failure));
    }

    if (failure) {
      // Автоматический возврат: прежние package.json, lockfile и пакеты.
      restoreManifests(o.prefix, manifestDir, manifests);
      const back = await reinstall(place, o.config.registry ?? o.npm.registry);
      const restoredH = installedPackage(o.prefix, HARNESS_PACKAGE)?.version;
      const restoredUi = installedPackage(o.prefix, UI_PACKAGE)?.version;
      const restoredOk =
        back.code === 0 && restoredH === check.current.harness && restoredUi === check.current.ui;
      steps.push(
        step(
          'restore-packages',
          restoredOk,
          restoredOk
            ? `вернулись ${pairText(check.current)}`
            : `npm install: ${npmReason(back)}; установлены harness ${restoredH ?? 'нет'}, панель ${restoredUi ?? 'нет'}`,
        ),
      );
      let stateNote = 'состояние не менялось — копия не понадобилась';
      let restoredState = false;
      if (stateFingerprint(o.stateDir) !== fingerprint) {
        const aside = join(root, 'replaced', id);
        restoreState(o.stateDir, copy.path, aside, copy.digest);
        restoredState = true;
        stateNote = `состояние возвращено из копии; изменённые файлы — в ${aside}`;
      }
      steps.push(step('restore-state', true, stateNote));
      const record = {
        action: 'restored' as const,
        from: target,
        to: check.current,
        by: o.by,
        reason: failure.slice(0, 500),
      };
      try {
        o.host.record(record);
      } catch {
        // журнал состояния недоступен — запись остаётся в journal.jsonl
      }
      journal(o.stateDir, { at: new Date(now()).toISOString(), ...record });
      // История пар не меняется; копия этой попытки нужна, только если ею вернули состояние.
      // Возврат пакетов не удался — копия и сохранённые package.json остаются для ручного возврата.
      const kept = prune(o.stateDir, [...readHistory(o.stateDir)]);
      writeHistory(o.stateDir, kept);
      cleanCopies(o.stateDir, kept, restoredState || !restoredOk ? [copy.path] : []);
      if (restoredOk) removeInside(root, join(root, 'history', id));
      return {
        data: {
          ...base,
          to: target,
          outcome: restoredOk ? 'restored' : 'restore-failed',
          steps,
          ...(restoredState ? { stateCopy: { path: copy.path, digest: copy.digest } } : {}),
          line: restoredOk
            ? `Обновление до ${pairText(target)} не прошло проверку (${failure}); автоматически возвращены ${pairText(check.current)}, ${stateNote}.`
            : `ВНИМАНИЕ: обновление не прошло (${failure}), и прежние версии вернуть не удалось. Верните руками: восстановите package.json и lockfile из ${manifestDir} и выполните npm install в ${o.prefix}.`,
        },
        code: 4,
      };
    }

    const toFormats = installedPackage(o.prefix, HARNESS_PACKAGE)?.formats;
    if (toFormats) entry.toFormats = toFormats;
    const record = { action: 'applied' as const, from: check.current, to: target, by: o.by };
    try {
      o.host.record(record);
      steps.push(step('event', true, `обновлено с ${check.current.harness} до ${target.harness}`));
    } catch (error) {
      steps.push(step('event', false, (error as Error).message));
    }
    journal(o.stateDir, { at: new Date(now()).toISOString(), ...record });
    const kept = prune(o.stateDir, [...readHistory(o.stateDir), entry]);
    writeHistory(o.stateDir, kept);
    cleanCopies(o.stateDir, kept);
    saveLastCheck(o.stateDir, {
      checkedAt: new Date(now()).toISOString(),
      mode: check.mode,
      channel: check.channel,
      state: 'up-to-date',
      current: target,
      line: `Установлены ${pairText(target)}: обновлено ${new Date(now()).toISOString().slice(0, 16).replace('T', ' ')} с ${check.current.harness}.`,
    });
    const panel = await restartPanel(o.prefix, o.stateDir);
    return {
      data: {
        ...base,
        to: target,
        outcome: 'applied',
        steps,
        stateCopy: { path: copy.path, digest: copy.digest },
        panel,
        line: `Обновлено с ${pairText(check.current)} до ${pairText(target)}. ${panel}`,
      },
      code: 0,
    };
  } finally {
    if (paused) o.host.resume();
    lock.release();
  }
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
 * живое состояние (`status` её процессом) и форматы те же — состояние
 * остаётся как есть, работа после обновления не теряется. Иначе состояние
 * возвращается из последней копии, а живые файлы переносятся в `replaced`.
 * Сбой на любом шаге — возврат новой пары и её состояния.
 */
export async function rollbackUpdate(o: RollbackOptions): Promise<Result> {
  const now = o.now ?? Date.now;
  const lock = acquireLock(o.stateDir);
  let paused = false;
  try {
    if (lock.recovered) o.host.resume();
    const history = readHistory(o.stateDir);
    const entry = history.at(-1);
    if (!entry)
      return {
        data: {
          action: 'rollback',
          outcome: 'nothing-to-roll-back',
          line: 'Откатывать нечего: обновлений этой командой не было.',
        },
        code: 3,
      };
    const steps: NonNullable<UpdateData['steps']> = [];
    let reasons = o.host.live();
    if (reasons.length && !o.waitMs)
      return {
        data: {
          action: 'rollback',
          outcome: 'busy',
          from: entry.to,
          to: entry.from,
          steps: [step('idle', false, reasons.join('; '))],
          line: `Сейчас идёт работа (${reasons[0]}): откат не делается посреди прогона. Повторите после окончания или с --wait <минуты>.`,
        },
        code: 3,
      };
    paused = o.host.pause();
    reasons = await waitIdle(o.host, o.waitMs ?? 0, o.pollMs ?? 2000, now);
    if (reasons.length)
      return {
        data: {
          action: 'rollback',
          outcome: 'busy',
          from: entry.to,
          to: entry.from,
          steps: [step('idle', false, reasons.join('; '))],
          line: `Работа не закончилась за отведённое время (${reasons[0]}): откат отложен.`,
        },
        code: 3,
      };
    const root = updatesDir(o.stateDir);
    const formatsDiffer = formatChanges(entry.fromFormats, entry.toFormats).length > 0;
    // Копия сверяется при возврате (restoreState): нужна только если прежняя версия не читает состояние.
    const place = installPlace(entry.prefix);
    const registry = o.config.registry ?? o.npm.registry;
    // Текущие файлы установки и состояние — чтобы вернуть всё, если откат не встанет.
    const current = join(root, 'history', entry.id, 'before-rollback');
    if (existsSync(current)) removeInside(root, current);
    const currentManifests = saveManifests(entry.prefix, current);
    const currentState = copyState(
      o.stateDir,
      join(root, 'copies', `${stamp(now())}-before-rollback`),
    );
    let stateRestored = false;
    const undo = async (why: string) => {
      if (stateRestored)
        restoreState(
          o.stateDir,
          currentState.path,
          join(root, 'replaced', `${stamp(now())}-undo`),
          currentState.digest,
        );
      restoreManifests(entry.prefix, current, currentManifests);
      const again = await reinstall(place, registry);
      steps.push(
        step(
          'restore-packages',
          again.code === 0,
          again.code === 0 ? `оставлены ${pairText(entry.to)}` : npmReason(again),
        ),
      );
      return {
        data: {
          action: 'rollback' as const,
          outcome: 'restore-failed' as const,
          from: entry.to,
          to: entry.from,
          steps,
          line: `Откат до ${pairText(entry.from)} не прошёл (${why}); ${again.code === 0 ? `оставлены ${pairText(entry.to)} и их состояние` : `верните руками файлы из ${current} и выполните npm install; состояние новой версии — в ${currentState.path}`}.`,
        },
        code: 4,
      };
    };
    restoreManifests(entry.prefix, join(root, 'history', entry.id, 'manifests'), entry.manifests);
    const back = await reinstall(place, registry);
    if (back.code !== 0) {
      steps.push(step('install', false, npmReason(back)));
      return await undo('установка прежних версий');
    }
    steps.push(step('install', true, pairText(entry.from)));
    // Прежняя версия читает живое состояние? Строгие схемы отклоняют поля новой версии.
    const old = installedPackage(entry.prefix, HARNESS_PACKAGE);
    const bound =
      existsSync(join(o.stateDir, 'binding.json')) && existsSync(join(o.stateDir, 'state.sqlite'));
    const reads =
      bound && old?.bin ? await readsState(old.bin, o.stateDir, entry.prefix) : undefined;
    let stateNote =
      'состояние читается прежней версией — оставлено как есть, работа после обновления сохранена';
    if (formatsDiffer || (reads && !reads.ok)) {
      if (!entry.stateCopy) {
        if (reads) steps.push(reads);
        return await undo('прежняя версия не читает состояние, а копии нет');
      }
      try {
        verifyCopy(entry.stateCopy.path, entry.stateCopy.digest);
      } catch (error) {
        return await undo('копия состояния: ' + (error as Error).message);
      }
      const aside = join(root, 'replaced', stamp(now()));
      restoreState(o.stateDir, entry.stateCopy.path, aside, entry.stateCopy.digest);
      stateRestored = true;
      stateNote = `состояние возвращено из копии ${entry.at} (${formatsDiffer ? 'форматы различались' : 'прежняя версия не читала новое'}); состояние новой версии — в ${aside}`;
    }
    steps.push(step('restore-state', true, stateNote));
    const verified = await verifyInstalled(entry.prefix, o.stateDir, entry.from);
    steps.push(...verified.steps);
    if (!verified.ok) return await undo(verified.steps.find((x) => !x.ok)?.detail ?? 'проверка');
    // Состояние новой версии уже лежит в replaced (или осталось живым): своя копия не нужна.
    removeInside(root, currentState.path);
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
    writeHistory(o.stateDir, history.slice(0, -1));
    const panel = await restartPanel(entry.prefix, o.stateDir);
    return {
      data: {
        action: 'rollback',
        outcome: 'rolled-back',
        from: entry.to,
        to: entry.from,
        steps,
        panel,
        line: `Откат: вернулись ${pairText(entry.from)} (была ${pairText(entry.to)}); ${stateNote}. ${panel}`,
      },
      code: 0,
    };
  } finally {
    // Возвращённое из копии состояние снято после паузы обновления: снять её в любом случае.
    void paused;
    o.host.resume();
    lock.release();
  }
}
