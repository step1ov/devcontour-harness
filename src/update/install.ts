import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, packageFormatsSchema, type PackageFormats } from '../contracts/index.ts';
import { npm, npmBin, npmReason, runTool, type NpmResult } from './npm.ts';

export const HARNESS_PACKAGE = 'devcontour-harness';
export const UI_PACKAGE = 'devcontour-harness-ui';

export interface InstalledPackage {
  name: string;
  version: string;
  dir: string;
  /** Путь исполняемого файла пакета (поле `bin`). */
  bin?: string;
  formats?: Formats;
}

/** Установленный в `prefix` пакет (`node_modules/<name>/package.json`); нет — undefined. */
export function installedPackage(prefix: string, name: string): InstalledPackage | undefined {
  const dir = join(prefix, 'node_modules', name);
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
      name?: string;
      version?: string;
      bin?: string | Record<string, string>;
      devcontourHarness?: { formats?: unknown };
    };
    if (pkg.name !== name || typeof pkg.version !== 'string') return undefined;
    const binPath =
      typeof pkg.bin === 'string'
        ? pkg.bin
        : pkg.bin
          ? (pkg.bin[name === HARNESS_PACKAGE ? 'harness' : name] ?? Object.values(pkg.bin)[0])
          : undefined;
    const formats = formatsFrom(pkg.devcontourHarness?.formats);
    return {
      name,
      version: pkg.version,
      dir,
      ...(binPath ? { bin: join(dir, binPath) } : {}),
      ...(formats ? { formats } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Форматы пакета: известные ключи (`packageFormatsSchema`) обязательны и по
 * схеме, прочие ключи-примитивы сохраняются — новый ключ будущей версии не
 * делает форматы «неизвестными», а называется как смена.
 */
export type Formats = PackageFormats & Record<string, string | number>;
export function formatsFrom(raw: unknown): Formats | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const known = Object.keys(packageFormatsSchema.shape);
  const parsed = packageFormatsSchema.safeParse(
    Object.fromEntries(Object.entries(raw).filter(([k]) => known.includes(k))),
  );
  if (!parsed.success) return undefined;
  const extra = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([k, v]) =>
        !known.includes(k) &&
        /^[a-zA-Z][\w-]{0,40}$/.test(k) &&
        (typeof v === 'string' || typeof v === 'number'),
    ) as [string, string | number][],
  );
  return { ...extra, ...parsed.data };
}

/** Форматы из package.json tarball (`devcontourHarness.formats`); нет или не по схеме — undefined. */
export function formatsOf(packageJson: string | undefined): Formats | undefined {
  if (!packageJson) return undefined;
  try {
    return formatsFrom(
      (JSON.parse(packageJson) as { devcontourHarness?: { formats?: unknown } }).devcontourHarness
        ?.formats,
    );
  } catch {
    return undefined;
  }
}

const formatNames: Record<string, string> = {
  api: 'apiVersion',
  state: 'stateVersion',
  policy: 'policyVersion',
  handoff: 'handoffVersion',
  report: 'reportVersion',
  view: 'viewVersion',
};

/** Смены форматов `имя: было → станет` по всем ключам обеих сторон; сведений нет — `unknown`. */
export function formatChanges(
  before: Record<string, string | number> | undefined,
  after: Record<string, string | number> | undefined,
): string[] {
  if (!before || !after) return ['unknown'];
  const keys = [
    ...new Set([...Object.keys(formatNames), ...Object.keys(before), ...Object.keys(after)]),
  ];
  return keys
    .filter((k) => before[k] !== after[k])
    .map(
      (k) => `${formatNames[k] ?? k}: ${String(before[k] ?? 'нет')} → ${String(after[k] ?? 'нет')}`,
    );
}

export type Manager = 'npm' | 'pnpm';
export type Section = 'dependencies' | 'devDependencies';

/** Где и чем ставятся пакеты: каталог, менеджер, раздел package.json каждого пакета. */
export interface InstallPlace {
  prefix: string;
  manager: Manager;
  sections: Partial<Record<string, Section>>;
  /**
   * Отдельный каталог инструментов (`.harness-tools` навыка harness-setup):
   * в package.json только пакеты harness и панели. Ставится, как его ставит
   * навык: `--omit=dev --ignore-scripts`, раздел `dependencies`.
   */
  dedicated: boolean;
}

const MANIFEST_FILES = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
];

export function installPlace(prefix: string): InstallPlace {
  if (existsSync(join(prefix, 'yarn.lock')) || existsSync(join(prefix, 'bun.lockb')))
    throw new HarnessError(
      'INVALID_INPUT',
      `${prefix}: yarn и bun пока не поддерживаются обновлением; поставьте версии руками`,
    );
  const manager: Manager = existsSync(join(prefix, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
  const sections: Partial<Record<string, Section>> = {};
  const file = join(prefix, 'package.json');
  let dedicated = true;
  if (existsSync(file)) {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as Partial<
      Record<Section | 'peerDependencies' | 'optionalDependencies', Record<string, string>>
    >;
    for (const name of [HARNESS_PACKAGE, UI_PACKAGE])
      if (pkg.devDependencies?.[name]) sections[name] = 'devDependencies';
      else if (pkg.dependencies?.[name]) sections[name] = 'dependencies';
    const ours = new Set([HARNESS_PACKAGE, UI_PACKAGE]);
    // Наши пакеты в devDependencies — проект, а не каталог инструментов: --omit=dev их бы убрал.
    dedicated =
      Object.keys(pkg.devDependencies ?? {}).length === 0 &&
      (['dependencies', 'optionalDependencies'] as const).every((k) =>
        Object.keys(pkg[k] ?? {}).every((n) => ours.has(n)),
      );
  }
  return { prefix, manager, sections, dedicated };
}

/** Сохранить package.json и lockfile каталога установки (что было и чего не было). */
export function saveManifests(prefix: string, dir: string): Record<string, boolean> {
  mkdirSync(dir, { recursive: true });
  const existed: Record<string, boolean> = {};
  for (const f of MANIFEST_FILES) {
    existed[f] = existsSync(join(prefix, f));
    if (existed[f]) copyFileSync(join(prefix, f), join(dir, f));
  }
  return existed;
}

/** Вернуть сохранённые package.json и lockfile; появившиеся после сохранения — убрать. */
export function restoreManifests(prefix: string, dir: string, existed: Record<string, boolean>) {
  for (const f of MANIFEST_FILES) {
    if (existed[f]) copyFileSync(join(dir, f), join(prefix, f));
    // Только файл из списка выше в каталоге установки, которого до обновления не было.
    else if (existed[f] === false && existsSync(join(prefix, f))) rmSync(join(prefix, f));
  }
}

const pnpmBin = () => process.env.HARNESS_PNPM_BIN || 'pnpm';

/** Поставить точные версии пакетов (`--save-exact`), каждый в его раздел package.json. */
export async function installExact(
  place: InstallPlace,
  versions: Record<string, string>,
  registry?: string,
  ignoreScripts = false,
): Promise<NpmResult> {
  const groups = new Map<Section, string[]>();
  for (const [name, version] of Object.entries(versions)) {
    const section = place.sections[name] ?? (place.dedicated ? 'dependencies' : 'devDependencies');
    groups.set(section, [...(groups.get(section) ?? []), `${name}@${version}`]);
  }
  let last: NpmResult = { code: 0, stdout: '', stderr: '' };
  for (const [section, specs] of groups) {
    const dev = section === 'devDependencies';
    last =
      place.manager === 'pnpm'
        ? await runTool(
            pnpmBin(),
            [
              'add',
              '--save-exact',
              ...(dev ? ['--save-dev'] : []),
              ...(ignoreScripts ? ['--ignore-scripts'] : []),
              ...specs,
              ...(registry ? ['--registry', registry] : []),
            ],
            place.prefix,
          )
        : await npm(
            [
              'install',
              '--save-exact',
              dev ? '--save-dev' : '--save-prod',
              '--no-audit',
              '--no-fund',
              ...(place.dedicated ? ['--omit=dev'] : []),
              ...(place.dedicated || ignoreScripts ? ['--ignore-scripts'] : []),
              ...specs,
            ],
            { cwd: place.prefix, timeoutMs: 10 * 60_000, ...(registry ? { registry } : {}) },
          );
    if (last.code !== 0) return last;
  }
  return last;
}

/** Переставить зависимости по возвращённым package.json и lockfile. */
export function reinstall(place: InstallPlace, registry?: string): Promise<NpmResult> {
  // Возврат — без скриптов жизненного цикла: пакеты проекта уже собраны.
  return place.manager === 'pnpm'
    ? runTool(
        pnpmBin(),
        ['install', '--ignore-scripts', ...(registry ? ['--registry', registry] : [])],
        place.prefix,
      )
    : npm(
        [
          'install',
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          ...(place.dedicated ? ['--omit=dev'] : []),
        ],
        {
          cwd: place.prefix,
          timeoutMs: 10 * 60_000,
          ...(registry ? { registry } : {}),
        },
      );
}

export { npmBin, npmReason };
