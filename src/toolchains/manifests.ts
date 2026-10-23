import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Чтение манифестов целевого репозитория — только чтение файлов внутри его
 * корня, без symlink наружу и без исполнения чего-либо. Всё, что здесь
 * разбирается (package.json, pnpm-workspace.yaml, turbo.json, go.mod,
 * pyproject.toml, uv.lock), читается как данные.
 */
const FILE_LIMIT = 4 * 1024 * 1024;

/** Lockfile → менеджер пакетов, которому он принадлежит. */
export const lockfiles = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
} as const;
export type LockManager = (typeof lockfiles)[keyof typeof lockfiles];

export class Manifests {
  readonly root: string;
  private cache = new Map<string, string | undefined>();
  constructor(root: string) {
    this.root = realpathSync(root);
  }

  /** Путь `rel` относительно корня; `.` — корень. */
  abs(rel: string) {
    return rel === '.' ? this.root : join(this.root, rel);
  }
  /** Относительный путь каталога; вне корня — undefined. */
  rel(abs: string) {
    const r = relative(this.root, resolve(abs));
    if (r === '') return '.';
    if (r === '..' || r.startsWith('..' + sep) || r.startsWith(sep)) return undefined;
    return r.split(sep).join('/');
  }
  /** Каталог внутри корня без symlink на пути. */
  isDir(rel: string) {
    const stat = this.stat(rel);
    return stat?.isDirectory() ?? false;
  }
  isFile(rel: string) {
    const stat = this.stat(rel);
    return stat?.isFile() ?? false;
  }
  private stat(rel: string) {
    if (rel === '.') return lstatSync(this.root);
    let cursor = this.root;
    let stat;
    for (const part of rel.split('/')) {
      if (!part || part === '..') return undefined;
      if (part === '.') continue;
      cursor = join(cursor, part);
      try {
        stat = lstatSync(cursor);
      } catch {
        return undefined;
      }
      if (stat.isSymbolicLink()) return undefined;
    }
    return stat;
  }
  /** Текст файла внутри корня (до 4 MiB) или undefined. */
  text(rel: string): string | undefined {
    if (this.cache.has(rel)) return this.cache.get(rel);
    const stat = this.stat(rel);
    const value =
      stat?.isFile() && stat.size <= FILE_LIMIT ? readFileSync(this.abs(rel), 'utf8') : undefined;
    this.cache.set(rel, value);
    return value;
  }
  json(rel: string): Record<string, unknown> | undefined {
    const text = this.text(rel);
    if (text === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  /** Каталог и его предки до корня включительно, от ближнего. */
  ancestors(dir: string) {
    const out: string[] = [];
    let cursor = dir;
    for (;;) {
      out.push(cursor);
      if (cursor === '.') return out;
      const up = dirname(cursor);
      cursor = up === '' || up === '.' ? '.' : up;
    }
  }
  /** Ближайший к `dir` каталог (до корня), где есть файл `name`. */
  nearest(dir: string, name: string) {
    return this.ancestors(dir).find((d) => this.isFile(join2(d, name)));
  }
  lockfilesIn(dir: string) {
    return Object.keys(lockfiles).filter((f) => this.isFile(join2(dir, f)));
  }
  list(rel: string) {
    if (!this.isDir(rel)) return [];
    return readdirSync(this.abs(rel), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }
}

export const join2 = (dir: string, name: string) => (dir === '.' ? name : `${dir}/${name}`);

/** Скрипты package.json каталога. */
export function scriptsOf(m: Manifests, dir: string): Record<string, string> | undefined {
  const pkg = m.json(join2(dir, 'package.json'));
  if (!pkg) return undefined;
  const scripts = pkg.scripts;
  return scripts && typeof scripts === 'object' ? (scripts as Record<string, string>) : {};
}

/** `packageManager` из package.json: `pnpm@10.12.3+sha512…` → { name, version }. */
export function packageManagerField(m: Manifests, dir: string) {
  const value = m.json(join2(dir, 'package.json'))?.packageManager;
  if (typeof value !== 'string') return undefined;
  const match = /^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+[^+]*)/.exec(value);
  return match ? { name: match[1]!, version: match[2]!, raw: value } : { name: value, raw: value };
}

/** Пакеты workspace pnpm: `packages:` из pnpm-workspace.yaml (простые шаблоны `dir/*`). */
export function workspacePackages(m: Manifests, workspaceRoot: string) {
  const text = m.text(join2(workspaceRoot, 'pnpm-workspace.yaml'));
  const patterns: string[] = [];
  if (text) {
    let inPackages = false;
    for (const line of text.split('\n')) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const item = /^\s+-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line);
        if (item) patterns.push(item[1]!.trim());
        else if (/^\S/.test(line)) inPackages = false;
      }
    }
  } else {
    const workspaces = m.json(join2(workspaceRoot, 'package.json'))?.workspaces;
    if (Array.isArray(workspaces))
      patterns.push(...workspaces.filter((w): w is string => typeof w === 'string'));
  }
  const dirs = new Set<string>([workspaceRoot]);
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    const clean = pattern.replace(/\/$/, '');
    if (clean.endsWith('/*') || clean.endsWith('/**')) {
      const base = join2(workspaceRoot, clean.replace(/\/\*\*?$/, ''));
      for (const child of m.list(base)) dirs.add(join2(base, child));
    } else dirs.add(join2(workspaceRoot, clean));
  }
  return [...dirs]
    .filter((d) => m.isFile(join2(d, 'package.json')))
    .map((dir) => {
      const pkg = m.json(join2(dir, 'package.json')) ?? {};
      return {
        dir,
        name: typeof pkg.name === 'string' ? pkg.name : undefined,
        scripts: scriptsOf(m, dir) ?? {},
      };
    });
}

/** Задачи turbo.json (`tasks` v2 либо `pipeline` v1). */
export function turboTasks(m: Manifests, dir: string) {
  const turbo = m.json(join2(dir, 'turbo.json'));
  if (!turbo) return undefined;
  const tasks = (turbo.tasks ?? turbo.pipeline) as Record<string, unknown> | undefined;
  return tasks && typeof tasks === 'object' ? Object.keys(tasks) : [];
}

/** go.mod: директивы `go`, `toolchain` и наличие require. */
export function goModule(m: Manifests, dir: string) {
  const text = m.text(join2(dir, 'go.mod'));
  if (text === undefined) return undefined;
  return {
    go: /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(text)?.[1],
    toolchain: /^toolchain\s+go(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(text)?.[1],
    requires: /^require\b/m.test(text),
  };
}

/** Пакеты, закреплённые uv.lock (`name = "…"` записей `[[package]]`). */
export function uvLocked(m: Manifests, dir: string) {
  const text = m.text(join2(dir, 'uv.lock'));
  if (text === undefined) return undefined;
  const names = new Map<string, string>();
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name) names.set(name.toLowerCase(), version ?? '');
  }
  return names;
}

/**
 * Точная версия зависимости `name` корневого пакета каталога, закреплённая
 * lockfile: `importers['.']` pnpm-lock.yaml либо `packages['node_modules/<name>']`
 * package-lock.json. Нет закрепления — undefined.
 */
export function lockedVersion(m: Manifests, dir: string, name: string) {
  const pnpm = m.text(join2(dir, 'pnpm-lock.yaml'));
  if (pnpm !== undefined) {
    const importers = pnpm.split(/^importers:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
    const root = /^ {2}\.:\s*$([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/m.exec(importers)?.[1] ?? '';
    const quoted = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const entry = new RegExp(
      `^ {6}'?${quoted}'?:\\s*$\\n {8}specifier:[^\\n]*\\n {8}version: ([^\\s(]+)`,
      'm',
    ).exec(root);
    if (entry && /^\d+\.\d+\.\d+/.test(entry[1]!)) return entry[1];
  }
  const npm = m.json(join2(dir, 'package-lock.json'));
  const packages = npm?.packages as Record<string, { version?: string }> | undefined;
  const version = packages?.[`node_modules/${name}`]?.version;
  return version && /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
}
