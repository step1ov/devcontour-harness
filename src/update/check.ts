import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  HANDOFF_VERSION,
  HarnessError,
  OPERATOR_VIEW_VERSION,
  REPORT_VERSION,
  API_VERSION,
  POLICY_VERSION,
  STATE_VERSION,
  updateCheckSchema,
  updatesConfigSchema,
  type PackageFormats,
  type UpdateCheck,
  type UpdatePair,
  type UpdatesConfig,
} from '../contracts/index.ts';
import { HARNESS_VERSION } from '../package.ts';
import {
  HARNESS_PACKAGE,
  UI_PACKAGE,
  formatChanges,
  formatsOf,
  installPrefix,
  installedPackage,
} from './install.ts';
import {
  RegistryUnavailable,
  fetchTarball,
  packageVersions,
  peerDependencies,
  type NpmOptions,
} from './npm.ts';
import { whatsNewOf } from './notes.ts';
import { compareVersions, satisfies } from './semver.ts';
import { readTarball } from './tarball.ts';

/** Форматы договоров этой сборки (те же числа, что в package.json `devcontourHarness.formats`). */
export const RUNNING_FORMATS: PackageFormats = {
  api: API_VERSION,
  state: STATE_VERSION,
  policy: POLICY_VERSION,
  handoff: HANDOFF_VERSION,
  report: REPORT_VERSION,
  view: OPERATOR_VIEW_VERSION,
};

/** Каталог обновлений рядом с каталогом состояния: `<state>-updates`. */
export const updatesDir = (stateDir: string) =>
  resolve(stateDir).replace(/[/\\]+$/, '') + '-updates';
export const lastCheckFile = (stateDir: string) => join(updatesDir(stateDir), 'last-check.json');
export const configFile = (harnessDir: string) => join(harnessDir, 'updates.json');

/** `.harness/updates.json`; файла нет — значения по умолчанию (notify, alpha). */
export function loadUpdatesConfig(
  harnessDir: string | undefined,
  /** Без предупреждения о полях не этой версии (status и view их молча пропускают). */
  options: { quiet?: boolean } = {},
): {
  config: UpdatesConfig;
  path?: string;
  exists: boolean;
} {
  const defaults = updatesConfigSchema.parse({});
  if (!harnessDir) return { config: defaults, exists: false };
  const path = configFile(harnessDir);
  if (!existsSync(path)) return { config: defaults, path, exists: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new HarnessError(
      'INVALID_INPUT',
      `${path}: невалидный JSON: ${(error as Error).message}`,
    );
  }
  // Поля новее этой версии (настройку записала более новая) пропускаются, а не
  // ломают update после отката; известные поля проверяются строго.
  const known = Object.keys(updatesConfigSchema.shape);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const extra = Object.keys(raw).filter((k) => !known.includes(k));
    if (extra.length) {
      if (!options.quiet)
        process.stderr.write(
          `harness update: ${path}: поля не этой версии пропущены: ${extra.join(', ')}\n`,
        );
      raw = Object.fromEntries(Object.entries(raw).filter(([k]) => known.includes(k)));
    }
  }
  const parsed = updatesConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new HarnessError(
      'INVALID_INPUT',
      `${path}: не проходит схему настройки обновлений`,
      parsed.error.issues.map((i) => ({
        path: ['updates.json', ...(i.path as (string | number)[])],
        message: i.message,
      })),
    );
  return { config: parsed.data, path, exists: true };
}

/** Записать настройку (навык harness-setup или `--mode`): только поля схемы. */
export function writeUpdatesConfig(harnessDir: string, config: UpdatesConfig) {
  const path = configFile(harnessDir);
  writeAtomic(path, JSON.stringify(updatesConfigSchema.parse(config), null, 2) + '\n');
  return path;
}

export function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Последняя сохранённая проверка; нет или не по схеме — undefined. */
export function readLastCheck(stateDir: string): UpdateCheck | undefined {
  try {
    const parsed = updateCheckSchema.safeParse(
      JSON.parse(readFileSync(lastCheckFile(stateDir), 'utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function saveLastCheck(stateDir: string, check: UpdateCheck) {
  writeAtomic(
    lastCheckFile(stateDir),
    JSON.stringify(updateCheckSchema.parse(check), null, 2) + '\n',
  );
}

export interface CheckContext {
  stateDir: string;
  /** Каталог установки пакетов (корень проекта или `--prefix`). */
  prefix?: string;
  config: UpdatesConfig;
  npm: NpmOptions;
  now?: () => number;
}

/** Пара одной строкой для решения владельца: `harness@<версия>[+ui@<версия>]`. */
export const pairToken = (p: UpdatePair) => `harness@${p.harness}${p.ui ? `+ui@${p.ui}` : ''}`;

const pairText = (p: UpdatePair) => `harness ${p.harness}${p.ui ? ` и панель ${p.ui}` : ''}`;

export function currentPair(prefix: string | undefined): {
  pair: UpdatePair;
  formats?: PackageFormats;
} {
  const h = prefix ? installedPackage(prefix, HARNESS_PACKAGE) : undefined;
  const ui = prefix ? installedPackage(prefix, UI_PACKAGE) : undefined;
  const version = h?.version ?? HARNESS_VERSION;
  const formats = h?.formats ?? (version === HARNESS_VERSION ? RUNNING_FORMATS : undefined);
  return {
    pair: { harness: version, ...(ui ? { ui: ui.version } : {}) },
    ...(formats ? { formats } : {}),
  };
}

/** Кандидаты: новее `from` (или равные ему при `includeCurrent`) и не новее тега канала. */
const candidates = (versions: string[], from: string, tag: string, includeCurrent: boolean) =>
  versions
    .filter(
      (v) =>
        compareVersions(v, tag) <= 0 &&
        (compareVersions(v, from) > 0 || (includeCurrent && compareVersions(v, from) === 0)),
    )
    .sort((a, b) => compareVersions(b, a))
    .slice(0, 10);

/**
 * `harness update --check`: спросить реестр (через npm) о версиях канала,
 * выбрать новейшую совместимую пару (peer-диапазон панели на
 * devcontour-harness), прочитать из tarball форматы договоров и заметки
 * выпуска. Реестр недоступен — исход `unavailable`, работа не затронута.
 */
export async function checkUpdates(ctx: CheckContext): Promise<UpdateCheck> {
  const now = ctx.now ?? Date.now;
  const { config } = ctx;
  const { pair: current, formats: currentFormats } = currentPair(ctx.prefix);
  const base = {
    checkedAt: new Date(now()).toISOString(),
    mode: config.mode,
    channel: config.channel,
    current,
  };
  const stateArg = `--state ${ctx.stateDir}`;
  try {
    const hMeta = await packageVersions(HARNESS_PACKAGE, config.channel, ctx.npm);
    const hTag = hMeta?.tags[config.channel];
    if (!hMeta || !hTag)
      throw new RegistryUnavailable(
        `в реестре нет ${HARNESS_PACKAGE} с каналом «${config.channel}»`,
      );
    const hCandidates = candidates(hMeta.versions, current.harness, hTag, true);
    if (!hCandidates.some((v) => compareVersions(v, current.harness) === 0))
      hCandidates.push(current.harness);
    let uiCandidates: string[] = [];
    let uiTag: string | undefined;
    if (current.ui) {
      const uiMeta = await packageVersions(UI_PACKAGE, config.channel, ctx.npm);
      uiTag = uiMeta?.tags[config.channel];
      uiCandidates = uiMeta && uiTag ? candidates(uiMeta.versions, current.ui, uiTag, true) : [];
      if (!uiCandidates.includes(current.ui)) uiCandidates.push(current.ui);
    }
    const peers = new Map<string, string | undefined>();
    const peerOf = async (ui: string) => {
      if (!peers.has(ui))
        peers.set(ui, (await peerDependencies(UI_PACKAGE, ui, ctx.npm))[HARNESS_PACKAGE]);
      return peers.get(ui);
    };
    let chosen: UpdatePair | undefined;
    for (const h of hCandidates) {
      if (!current.ui) {
        chosen = { harness: h };
        break;
      }
      for (const ui of uiCandidates) {
        const range = await peerOf(ui);
        if (range === undefined || satisfies(h, range)) {
          chosen = { harness: h, ui };
          break;
        }
      }
      if (chosen) break;
    }
    chosen ??= current;
    const harnessChanged = compareVersions(chosen.harness, current.harness) !== 0;
    const uiChanged = !!chosen.ui && chosen.ui !== current.ui;
    let note: string | undefined;
    if (current.ui && uiTag && chosen.ui && compareVersions(uiTag, chosen.ui) > 0)
      note = `Панель ${uiTag} не подходит к harness ${chosen.harness} по peer-диапазону; поставится панель ${chosen.ui}`;
    if (!harnessChanged && !uiChanged)
      return {
        ...base,
        state: 'up-to-date',
        ...(note ? { note } : {}),
        line: `Обновлений нет: установлены ${pairText(current)} (канал ${config.channel}).`,
      };
    const whatsNew: string[] = [];
    let changes: string[] = [];
    if (harnessChanged) {
      const files = readTarball(
        await fetchTarball(HARNESS_PACKAGE, chosen.harness, ctx.npm),
        (p) => p === 'package/package.json' || /^package\/docs\/release-notes\/[^/]+\.md$/.test(p),
      );
      changes = formatChanges(currentFormats, formatsOf(files.get('package/package.json')));
      whatsNew.push(...whatsNewOf(files, 'harness', current.harness, chosen.harness, 8));
    }
    if (uiChanged) {
      const files = readTarball(await fetchTarball(UI_PACKAGE, chosen.ui!, ctx.npm), (p) =>
        /^package\/docs\/release-notes\/[^/]+\.md$/.test(p),
      );
      whatsNew.push(...whatsNewOf(files, 'панель', current.ui, chosen.ui!, 4));
    }
    const decision = changes.length > 0;
    // Решение владельца привязано к паре, которую он видел: другая пара — отказ.
    const command = `harness update --apply ${stateArg}${decision ? ` --confirm-formats ${pairToken(chosen)}` : ''}`;
    const line = decision
      ? `Доступна ${pairText(chosen)} со сменой форматов (${changes.join(', ')}): автоматически не ставится — нужно ваше решение. Поставить: ${command}`
      : `Доступна ${pairText(chosen)} (сейчас ${pairText(current)}). Что нового — harness update --check; обновить — ${command}`;
    return {
      ...base,
      state: decision ? 'needs-decision' : 'available',
      available: chosen,
      ...(changes.length ? { formatChanges: changes } : {}),
      ...(whatsNew.length ? { whatsNew } : {}),
      ...(note ? { note } : {}),
      line: line.slice(0, 300),
      command,
    };
  } catch (error) {
    if (!(error instanceof RegistryUnavailable)) throw error;
    // Прежняя найденная пара остаётся видна: офлайн не прячет доступное обновление.
    const previous = readLastCheck(ctx.stateDir);
    const keep =
      previous?.available && compareVersions(previous.available.harness, current.harness) >= 0
        ? {
            available: previous.available,
            ...(previous.formatChanges ? { formatChanges: previous.formatChanges } : {}),
            ...(previous.whatsNew ? { whatsNew: previous.whatsNew } : {}),
            ...(previous.command ? { command: previous.command } : {}),
          }
        : {};
    return {
      ...base,
      state: 'unavailable',
      ...keep,
      error: error.message.slice(0, 500),
      line: `Не удалось проверить обновления: ${error.message}`.slice(0, 300),
    };
  }
}

/**
 * Версия harness, с которой сравнивает `update --check`: установленная в
 * каталоге установки проекта (то же правило, что у `update`), а не версия
 * запущенного файла — они расходятся, когда harness запущен не из каталога
 * установки (глобальный, из исходников) или процесс пережил обновление.
 */
export const installedHarness = (harnessDir: string | undefined) =>
  currentPair(installPrefix(harnessDir)).pair.harness;

/**
 * Строка об обновлениях по сохранённой проверке для `status --human`,
 * представления оператора и ведущего: проверка старше установленной версии
 * (пару уже поставили) — «обновлений нет». `installed` — та же «текущая»
 * версия, что у `update --check` (installedHarness каталога .harness).
 */
export function cachedUpdates(
  stateDir: string,
  config: UpdatesConfig,
  installed: string = HARNESS_VERSION,
):
  | {
      state: UpdateCheck['state'] | 'not-checked';
      line: string;
      check?: UpdateCheck;
    }
  | undefined {
  const check = readLastCheck(stateDir);
  if (!check)
    return config.mode === 'off'
      ? undefined
      : {
          state: 'not-checked',
          line: `Обновления ещё не проверялись: harness update --check --state ${stateDir}`,
        };
  if (
    check.available &&
    compareVersions(check.available.harness, installed) <= 0 &&
    compareVersions(check.current.harness, installed) < 0
  )
    return {
      state: 'up-to-date',
      line: `Установлена harness ${installed}; проверка ${check.checkedAt.slice(0, 16).replace('T', ' ')} — обновлений нет.`,
      check,
    };
  return { state: check.state, line: check.line, check };
}
