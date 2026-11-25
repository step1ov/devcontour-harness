import { posix } from 'node:path';
import type { GatePolicy } from '../contracts/index.ts';
import { gitBlobs, gitRawOutput } from '../environment/process.ts';

/**
 * Привязка gate к пакету workspace и граф пакетов (alpha.71) — основа
 * применимости по умолчанию: gate пакета не исполняется, если diff не задел
 * ни сам пакет, ни его зависимости в workspace, ни неявные входы
 * (`applicability.ts`). Всё, в чём нет уверенности, даёт «привязка
 * неизвестна», и gate исполняется, как прежде.
 */

/** Как gate называет свой пакет: именем пакета или каталогом от корня репозитория. */
export type PackageSelector = { name: string } | { dir: string };

const pmName = (raw: string) => posix.basename(raw).replace(/\.(c?js|cmd|exe)$/i, '');

/** Значения флага (`--filter x`, `--filter=x`, `-F x`) до `--`. */
function flagValues(args: readonly string[], names: readonly string[]) {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') break;
    const eq = names.find((n) => n.startsWith('--') && a.startsWith(n + '='));
    if (eq) out.push(a.slice(eq.length + 1));
    else if (names.includes(a) && args[i + 1] !== undefined) out.push(args[++i]!);
  }
  return out;
}
const hasFlag = (args: readonly string[], names: readonly string[]) => {
  const end = args.indexOf('--');
  return (end < 0 ? args : args.slice(0, end)).some((a) =>
    names.some((n) => a === n || a.startsWith(n + '=')),
  );
};

/** Каталог от корня репозитория: `cwd` gate + относительный путь; выход за корень — undefined. */
function repoDir(cwd: string | undefined, rel: string) {
  const path = posix.normalize(posix.join(cwd ?? '.', rel)).replace(/\/$/, '');
  return path === '..' || path.startsWith('../') || posix.isAbsolute(rel) ? undefined : path;
}

/** Фильтр pnpm одного пакета: имя (`@a/b`, `b`, `b...`) или каталог (`./dir`, `{./dir}`). */
function pnpmFilter(raw: string, cwd: string | undefined): PackageSelector | undefined {
  let f = raw.endsWith('...') ? raw.slice(0, -3) : raw;
  if (f.startsWith('{') && f.endsWith('}')) f = f.slice(1, -1);
  if (!f || /[*?[\]!^{}]/.test(f) || f.includes('...')) return undefined;
  if (f === '.' || f.startsWith('./') || f.startsWith('../')) {
    const dir = repoDir(cwd, f);
    return dir === undefined ? undefined : { dir };
  }
  return /^(@[^/\s]+\/)?[^/\s@]+$/.test(f) ? { name: f } : undefined;
}

/**
 * Пакеты, которые проверяет gate, по его определению, или undefined —
 * привязка неизвестна (gate исполняется, как прежде):
 *
 * - `pnpm --filter <пакет>` / `-F` (имя или `./каталог`; суффикс `...` —
 *   зависимости, они входят и так); фильтры зависимых (`...x`, `^`), шаблоны
 *   и `-r`/`-w` без фильтра — неизвестно; `pnpm -C <каталог>` — каталог;
 * - `npm --workspace <пакет>` / `-w`; `--workspaces` — неизвестно;
 *   `npm --prefix <каталог>` — каталог;
 * - `yarn workspace <пакет>`;
 * - иначе `cwd` gate вне корня — его каталог (пакет, в котором он лежит).
 *
 * Ведущий `env` с присваиваниями пропускается.
 */
export function packageBinding(
  gate: Pick<GatePolicy, 'command' | 'cwd'>,
): PackageSelector[] | undefined {
  let argv = [...gate.command];
  if (pmName(argv[0] ?? '') === 'env') {
    argv = argv.slice(1);
    while (argv[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv.shift();
  }
  const tool = pmName(argv[0] ?? '');
  const args = argv.slice(1);
  const cwdBinding = (): PackageSelector[] | undefined => {
    const dir = gate.cwd ? repoDir('.', gate.cwd) : undefined;
    return dir && dir !== '.' ? [{ dir }] : undefined;
  };
  if (tool === 'pnpm') {
    if (hasFlag(args, ['-r', '--recursive', '-w', '--workspace-root'])) return undefined;
    const filters = flagValues(args, ['--filter', '-F', '--filter-prod']);
    if (filters.length) {
      const out = filters.map((f) => pnpmFilter(f, gate.cwd));
      return out.every((s) => s !== undefined) ? out : undefined;
    }
    const dirs = flagValues(args, ['--dir', '-C']);
    if (dirs.length) {
      const dir = repoDir(gate.cwd, dirs.at(-1)!);
      return dir && dir !== '.' ? [{ dir }] : undefined;
    }
    return cwdBinding();
  }
  if (tool === 'npm') {
    if (hasFlag(args, ['--workspaces', '-ws', '--include-workspace-root'])) return undefined;
    const workspaces = flagValues(args, ['--workspace', '-w']);
    if (workspaces.length) {
      const out = workspaces.map((w): PackageSelector | undefined => {
        if (/[*?[\]{}]/.test(w)) return undefined;
        if (/^(@[^/\s]+\/)?[^/\s@]+$/.test(w)) return { name: w };
        const dir = repoDir(gate.cwd, w);
        return dir && dir !== '.' ? { dir } : undefined;
      });
      return out.every((s) => s !== undefined) ? out : undefined;
    }
    const prefix = flagValues(args, ['--prefix']);
    if (prefix.length) {
      const dir = repoDir(gate.cwd, prefix.at(-1)!);
      return dir && dir !== '.' ? [{ dir }] : undefined;
    }
    return cwdBinding();
  }
  if (tool === 'yarn') {
    if (args[0] === 'workspace' && args[1] && /^(@[^/\s]+\/)?[^/\s@]+$/.test(args[1]))
      return [{ name: args[1] }];
    if (args[0] === 'workspaces') return undefined;
    return cwdBinding();
  }
  return cwdBinding();
}

/** Пакет workspace: каталог от корня, имя и имена его зависимостей (все поля зависимостей). */
export interface WorkspacePackage {
  dir: string;
  name?: string;
  dependencies: string[];
  scripts: Record<string, string>;
}

/** Предел пакетов workspace, сверх которого граф не строится. */
export const WORKSPACE_PACKAGE_LIMIT = 500;

/** Шаблон `packages:` workspace → регулярное выражение каталога целиком. */
function workspacePattern(pattern: string) {
  const body = pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '*' && body[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Шаблоны `packages:` из pnpm-workspace.yaml (список или строка `[a, b]`), undefined — не разобрать. */
export function pnpmWorkspacePatterns(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^packages\s*:/.test(l));
  if (at < 0) return undefined;
  const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  const inline = /^packages\s*:\s*(.*?)\s*(?:#.*)?$/.exec(lines[at]!)![1]!;
  if (inline) {
    const flow = /^\[(.*)\]$/.exec(inline);
    if (!flow) return undefined;
    return flow[1]!.split(',').map(unquote).filter(Boolean);
  }
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const item = /^\s+-\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!item) return undefined;
    out.push(unquote(item[1]!));
  }
  return out;
}

const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Граф пакетов workspace на коммите `sha` — из объектов Git, не из рабочего
 * дерева: каталоги с package.json, выбранные `packages:` pnpm-workspace.yaml
 * или `workspaces` корневого package.json (`!` исключает; node_modules — никогда).
 * Отказ — строка с причиной (нет workspace, манифест не разобран, предел).
 */
export async function workspaceGraphAt(
  cwd: string,
  sha: string,
): Promise<WorkspacePackage[] | string> {
  let listing: string;
  try {
    listing = await gitRawOutput(cwd, 'ls-tree', '-r', '-z', '--full-tree', sha);
  } catch (error) {
    return 'git ls-tree: ' + (error instanceof Error ? error.message : String(error)).slice(0, 200);
  }
  const blobs = new Map<string, string>();
  for (const entry of listing.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [, type, oid] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (type !== 'blob') continue;
    if (path === 'pnpm-workspace.yaml' || path === 'package.json' || path.endsWith('/package.json'))
      if (!path.split('/').includes('node_modules')) blobs.set(path, oid!);
  }
  const read = async (paths: string[]) => {
    const ids = paths.map((p) => blobs.get(p)!);
    const data = await gitBlobs(cwd, ids);
    return new Map(paths.map((p) => [p, data.get(blobs.get(p)!)!.toString('utf8')]));
  };
  const json = (text: string | undefined): Record<string, unknown> | undefined => {
    try {
      const v: unknown = JSON.parse(text ?? '');
      return v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  let patterns: string[] | undefined;
  try {
    const roots = await read(['pnpm-workspace.yaml', 'package.json'].filter((p) => blobs.has(p)));
    const yaml = roots.get('pnpm-workspace.yaml');
    if (yaml !== undefined) patterns = pnpmWorkspacePatterns(yaml);
    else {
      const ws = json(roots.get('package.json'))?.workspaces;
      const list = Array.isArray(ws)
        ? ws
        : ws && typeof ws === 'object'
          ? (ws as { packages?: unknown }).packages
          : undefined;
      if (Array.isArray(list) && list.every((x) => typeof x === 'string')) patterns = list;
    }
  } catch (error) {
    return 'манифест корня: ' + (error instanceof Error ? error.message : String(error));
  }
  if (!patterns?.length) return 'в репозитории нет workspace (pnpm-workspace.yaml, workspaces)';
  const include = patterns.filter((p) => !p.startsWith('!')).map(workspacePattern);
  const exclude = patterns
    .filter((p) => p.startsWith('!'))
    .map((p) => workspacePattern(p.slice(1)));
  const dirs = [...blobs.keys()]
    .filter((p) => p.endsWith('/package.json'))
    .map((p) => p.slice(0, -'/package.json'.length))
    .filter((d) => include.some((re) => re.test(d)) && !exclude.some((re) => re.test(d)))
    .sort();
  if (dirs.length > WORKSPACE_PACKAGE_LIMIT)
    return `пакетов workspace больше ${WORKSPACE_PACKAGE_LIMIT}`;
  let texts: Map<string, string>;
  try {
    texts = await read(dirs.map((d) => d + '/package.json'));
  } catch (error) {
    return 'package.json: ' + (error instanceof Error ? error.message : String(error));
  }
  const out: WorkspacePackage[] = [];
  for (const dir of dirs) {
    const pkg = json(texts.get(dir + '/package.json'));
    if (!pkg) return `${dir}/package.json не разобран`;
    const deps = new Set<string>();
    for (const field of depFields) {
      const value = pkg[field];
      if (value && typeof value === 'object') for (const k of Object.keys(value)) deps.add(k);
    }
    const scripts =
      pkg.scripts && typeof pkg.scripts === 'object'
        ? Object.fromEntries(
            Object.entries(pkg.scripts as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          )
        : {};
    out.push({
      dir,
      ...(typeof pkg.name === 'string' ? { name: pkg.name } : {}),
      dependencies: [...deps].sort(),
      scripts,
    });
  }
  return out;
}

/** Каталоги пакетов gate с их зависимостями в workspace, или причина, почему их нет. */
export type PackageClosure =
  { ok: true; packages: string[]; dirs: string[] } | { ok: false; reason: string };

/** Ссылка на путь выше каталога пакета в script (`../`): пакет читает файлы вне себя. */
const escapes = /(^|[\s'"=:(])\.\.(\/|$)/;

/**
 * Замыкание пакетов gate по зависимостям workspace (все поля зависимостей
 * package.json, транзитивно). Селектор, не нашедший пакета, корневой пакет,
 * script пакета замыкания со ссылкой выше своего каталога (`../`) и больше
 * `limit` каталогов — причина, и gate исполняется.
 */
export function packageClosure(
  graph: readonly WorkspacePackage[],
  selectors: readonly PackageSelector[],
  limit: number,
): PackageClosure {
  const start: WorkspacePackage[] = [];
  for (const s of selectors) {
    const found =
      'name' in s
        ? graph.find((p) => p.name === s.name)
        : // Каталог gate — пакет, в котором он лежит (самый глубокий).
          graph
            .filter((p) => s.dir === p.dir || s.dir.startsWith(p.dir + '/'))
            .sort((a, b) => b.dir.length - a.dir.length)[0];
    if (!found)
      return {
        ok: false,
        reason: `пакет ${'name' in s ? s.name : s.dir} не найден в workspace`,
      };
    start.push(found);
  }
  const byName = new Map(graph.flatMap((p) => (p.name ? [[p.name, p] as const] : [])));
  const seen = new Map<string, WorkspacePackage>();
  const queue = [...start];
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p.dir)) continue;
    seen.set(p.dir, p);
    for (const d of p.dependencies) {
      const dep = byName.get(d);
      if (dep && !seen.has(dep.dir)) queue.push(dep);
    }
  }
  const all = [...seen.values()];
  if (all.some((p) => p.dir === '.' || p.dir === ''))
    return { ok: false, reason: 'корневой пакет в замыкании' };
  const escaping = all.find((p) => Object.values(p.scripts).some((v) => escapes.test(v)));
  if (escaping)
    return {
      ok: false,
      reason: `script пакета ${escaping.name ?? escaping.dir} ссылается выше его каталога (../)`,
    };
  if (all.length > limit) return { ok: false, reason: `пакетов в замыкании больше ${limit}` };
  return {
    ok: true,
    packages: start.map((p) => p.name ?? p.dir),
    dirs: all.map((p) => p.dir).sort(),
  };
}
