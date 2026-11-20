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
  formats?: PackageFormats;
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
    const formats = packageFormatsSchema.safeParse(pkg.devcontourHarness?.formats);
    return {
      name,
      version: pkg.version,
      dir,
      ...(binPath ? { bin: join(dir, binPath) } : {}),
      ...(formats.success ? { formats: formats.data } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Форматы из package.json tarball (`devcontourHarness.formats`); нет или не по схеме — undefined. */
export function formatsOf(packageJson: string | undefined): PackageFormats | undefined {
  if (!packageJson) return undefined;
  try {
    const parsed = packageFormatsSchema.safeParse(
      (JSON.parse(packageJson) as { devcontourHarness?: { formats?: unknown } }).devcontourHarness
        ?.formats,
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Смены форматов `имя: было → станет`; сведений нет — `unknown`. */
export function formatChanges(
  before: PackageFormats | undefined,
  after: PackageFormats | undefined,
): string[] {
  if (!before || !after) return ['unknown'];
  const names: Record<keyof PackageFormats, string> = {
    api: 'apiVersion',
    state: 'stateVersion',
    policy: 'policyVersion',
    handoff: 'handoffVersion',
    report: 'reportVersion',
    view: 'viewVersion',
  };
  return (Object.keys(names) as (keyof PackageFormats)[])
    .filter((k) => before[k] !== after[k])
    .map((k) => `${names[k]}: ${String(before[k])} → ${String(after[k])}`);
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
              ...(place.dedicated ? ['--omit=dev', '--ignore-scripts'] : []),
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
  return place.manager === 'pnpm'
    ? runTool(pnpmBin(), ['install', ...(registry ? ['--registry', registry] : [])], place.prefix)
    : npm(
        [
          'install',
          '--no-audit',
          '--no-fund',
          ...(place.dedicated ? ['--omit=dev', '--ignore-scripts'] : []),
        ],
        {
          cwd: place.prefix,
          timeoutMs: 10 * 60_000,
          ...(registry ? { registry } : {}),
        },
      );
}

export { npmBin, npmReason };
