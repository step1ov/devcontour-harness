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

/**
 * Как gate называет свой пакет: именем, каталогом (пакет, в котором он
 * лежит) или каталогом-фильтром pnpm (`under`: все пакеты под ним).
 */
export type PackageSelector = { name: string } | { dir: string } | { under: string };

/**
 * Аргумент или script выходит за каталог пакета или берёт весь workspace
 * (alpha.71, ревью B): сегмент `..` (`cd ..`, `--root ..`, `-C ../..`),
 * `-w`/`-r`/`--workspace-root`/`--recursive`/`--workspaces`, вызов другого
 * пакета (`--filter`, `-F`, `workspace`). Тогда применимости по умолчанию нет.
 */
export const escapesPackage = (text: string) =>
  /(^|[\s/'"=:(])\.\.(?=$|[/\s'")&;|])/.test(text) ||
  /(^|\s)(?:-w|-r|-ws|--workspace-root|--recursive|--workspaces|--filter(?:-prod)?|-F|workspace)(?=$|[\s=])/.test(
    text,
  );

/** Программы, через которые область команды не видна: оболочка, make, turbo, nx. */
const opaque = new Set(['sh', 'bash', 'zsh', 'dash', 'make', 'turbo', 'nx', 'npx', 'dlx']);

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

/**
 * Фильтр pnpm одного пакета: имя (`@a/b`, `b`, `b...`) или каталог
 * (`./dir`, `{./dir}`) — все проекты под ним (`under`, ревью B L3).
 */
function pnpmFilter(raw: string, cwd: string | undefined): PackageSelector | undefined {
  let f = raw.endsWith('...') ? raw.slice(0, -3) : raw;
  if (f.startsWith('{') && f.endsWith('}')) f = f.slice(1, -1);
  if (!f || /[*?[\]!^{}]/.test(f) || f.includes('...')) return undefined;
  if (f === '.' || f.startsWith('./') || f.startsWith('../')) {
    const dir = repoDir(cwd, f);
    return dir === undefined || dir === '.' ? undefined : { under: dir };
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
 * - иначе у pnpm/npm/yarn `cwd` gate вне корня — его каталог (пакет, в
 *   котором он лежит).
 *
 * Ведущий `env` с присваиваниями пропускается. Не менеджер пакетов (в том
 * числе `sh -c`, `make`, `turbo`, `nx`, `node`), исполнение через них
 * (`pnpm exec turbo`) и аргумент, выходящий за пакет (`escapesPackage`), —
 * привязки нет (ревью B, H2/M1).
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
  if (tool !== 'pnpm' && tool !== 'npm' && tool !== 'yarn') return undefined;
  if (
    args.some((a) => opaque.has(pmName(a))) ||
    args.some((a) => /(^|[\s/'"=:(])\.\.(?=$|[/\s'")&;|])/.test(a))
  )
    return undefined;
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
  return undefined;
}

/** Пакет workspace: каталог от корня, имя и имена его зависимостей (все поля зависимостей). */
export interface WorkspacePackage {
  dir: string;
  name?: string;
  dependencies: string[];
  scripts: Record<string, string>;
  /**
   * Пути, которые пакет читает вне своего каталога (ревью B, H2): каталоги
   * зависимостей `file:`/`link:` и цели `extends`/`references`/`paths` его
   * `tsconfig*.json` — от корня репозитория.
   */
  reads?: string[];
  /** Пакеты workspace, названные `extends` tsconfig по имени (`@repo/tsconfig/base.json`). */
  readsPackages?: string[];
  /** Почему пакет нельзя замкнуть: путь за пределами репозитория, tsconfig не разобран. */
  problem?: string;
}

/** JSON с комментариями и висячими запятыми (tsconfig); не разобран — undefined. */
export function looseJson(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const end = /^"(?:[^"\\\n]|\\.)*"/.exec(text.slice(i));
      if (!end) return undefined;
      out += end[0];
      i += end[0].length - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return undefined;
      i = end + 1;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Что пакет читает вне себя по `tsconfig*.json` (ревью B, H2): цели
 * `extends` (относительные и по имени пакета), `references[].path`,
 * `compilerOptions.paths` (до первого `*`, от `baseUrl`). Цель за
 * пределами репозитория или неразобранный файл — `problem`.
 */
function tsconfigReads(
  file: string,
  text: string,
): { reads: string[]; packages: string[]; problem?: string } {
  const value = looseJson(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { reads: [], packages: [], problem: `${file} не разобран` };
  const config = value as {
    extends?: unknown;
    references?: unknown;
    compilerOptions?: { baseUrl?: unknown; paths?: unknown };
  };
  const base = posix.dirname(file);
  const reads: string[] = [];
  const packages: string[] = [];
  let problem: string | undefined;
  const local = (rel: string, from: string) => {
    const path = posix.normalize(posix.join(from, rel)).replace(/\/$/, '');
    if (posix.isAbsolute(rel) || path === '..' || path.startsWith('../'))
      problem ??= `${file}: ${rel} вне репозитория`;
    else reads.push(path === '' ? '.' : path);
  };
  const extendsList = Array.isArray(config.extends) ? config.extends : [config.extends];
  for (const e of extendsList) {
    if (typeof e !== 'string') continue;
    if (e.startsWith('.') || e.startsWith('/')) local(e, base);
    else packages.push(e);
  }
  if (Array.isArray(config.references))
    for (const r of config.references)
      if (r && typeof r === 'object' && typeof (r as { path?: unknown }).path === 'string')
        local((r as { path: string }).path, base);
  const options = config.compilerOptions;
  const baseUrl = typeof options?.baseUrl === 'string' ? posix.join(base, options.baseUrl) : base;
  if (options?.paths && typeof options.paths === 'object')
    for (const targets of Object.values(options.paths as Record<string, unknown>))
      for (const t of Array.isArray(targets) ? targets : [])
        if (typeof t === 'string') local(t.split('*')[0]! || '.', baseUrl);
  return { reads, packages, ...(problem ? { problem } : {}) };
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
    if (
      path === 'pnpm-workspace.yaml' ||
      path === 'package.json' ||
      path.endsWith('/package.json') ||
      /(^|\/)tsconfig[^/]*\.json$/.test(path)
    )
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
  // tsconfig*.json в корне каталога каждого пакета (ревью B, H2).
  const tsconfigs = new Map(
    dirs.map((d) => [
      d,
      [...blobs.keys()].filter(
        (p) => p.startsWith(d + '/') && /^tsconfig[^/]*\.json$/.test(p.slice(d.length + 1)),
      ),
    ]),
  );
  let texts: Map<string, string>;
  try {
    texts = await read([
      ...dirs.map((d) => d + '/package.json'),
      ...[...tsconfigs.values()].flat(),
    ]);
  } catch (error) {
    return 'package.json: ' + (error instanceof Error ? error.message : String(error));
  }
  const out: WorkspacePackage[] = [];
  for (const dir of dirs) {
    const pkg = json(texts.get(dir + '/package.json'));
    if (!pkg) return `${dir}/package.json не разобран`;
    const deps = new Set<string>();
    const reads: string[] = [];
    const readsPackages: string[] = [];
    let problem: string | undefined;
    for (const field of depFields) {
      const value = pkg[field];
      if (!value || typeof value !== 'object') continue;
      for (const [k, spec] of Object.entries(value as Record<string, unknown>)) {
        deps.add(k);
        // `file:`/`link:` — каталог вне workspace читается как путь (ревью B, H2).
        const local = typeof spec === 'string' ? /^(?:file|link):(.+)$/.exec(spec)?.[1] : undefined;
        if (!local) continue;
        const path = posix.normalize(posix.join(dir, local)).replace(/\/$/, '');
        if (posix.isAbsolute(local) || path === '..' || path.startsWith('../'))
          problem ??= `${dir}: зависимость ${k} (${String(spec)}) вне репозитория`;
        else reads.push(path);
      }
    }
    for (const file of tsconfigs.get(dir) ?? []) {
      const t = tsconfigReads(file, texts.get(file) ?? '');
      reads.push(...t.reads);
      readsPackages.push(...t.packages);
      problem ??= t.problem;
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
      ...(reads.length ? { reads: [...new Set(reads)].sort() } : {}),
      ...(readsPackages.length ? { readsPackages: [...new Set(readsPackages)].sort() } : {}),
      ...(problem ? { problem } : {}),
    });
  }
  return out;
}

/** Каталоги пакетов gate с их зависимостями в workspace, или причина, почему их нет. */
export type PackageClosure =
  { ok: true; packages: string[]; dirs: string[] } | { ok: false; reason: string };

/**
 * Замыкание пакетов gate по зависимостям workspace (все поля зависимостей
 * package.json, транзитивно) и путям, которые пакеты читают вне себя
 * (`reads`: `file:`/`link:`, цели tsconfig; `readsPackages` — каталоги
 * пакетов, названных `extends` по имени). Селектор, не нашедший пакета,
 * `problem` пакета замыкания (путь вне репозитория, неразобранный
 * tsconfig), script, выходящий за пакет или берущий весь workspace
 * (`escapesPackage`), и больше `limit` путей — причина, и gate исполняется.
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
        ? graph.filter((p) => p.name === s.name)
        : 'under' in s
          ? // Фильтр каталога pnpm — все проекты под ним.
            graph.filter((p) => p.dir === s.under || p.dir.startsWith(s.under + '/'))
          : // Каталог gate — пакет, в котором он лежит (самый глубокий).
            graph
              .filter((p) => s.dir === p.dir || s.dir.startsWith(p.dir + '/'))
              .sort((a, b) => b.dir.length - a.dir.length)
              .slice(0, 1);
    if (!found.length)
      return {
        ok: false,
        reason: `пакет ${'name' in s ? s.name : 'under' in s ? s.under : s.dir} не найден в workspace`,
      };
    start.push(...found);
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
  const broken = all.find((p) => p.problem);
  if (broken) return { ok: false, reason: broken.problem! };
  const escaping = all.find((p) => Object.values(p.scripts).some(escapesPackage));
  if (escaping)
    return {
      ok: false,
      reason: `script пакета ${escaping.name ?? escaping.dir} выходит за его каталог или берёт весь workspace`,
    };
  // `extends` по имени пакета: путь начинается с имени пакета workspace.
  const named = all.flatMap((p) =>
    (p.readsPackages ?? []).flatMap((spec) => {
      const owner = [...byName.keys()]
        .filter((n) => spec === n || spec.startsWith(n + '/'))
        .sort((a, b) => b.length - a.length)[0];
      return owner ? [byName.get(owner)!.dir] : [];
    }),
  );
  const dirs = [
    ...new Set([...all.map((p) => p.dir), ...all.flatMap((p) => p.reads ?? []), ...named]),
  ]
    .filter((d) => d !== '.')
    .sort();
  if (all.some((p) => (p.reads ?? []).includes('.')))
    return { ok: false, reason: 'пакет читает весь репозиторий (путь .)' };
  if (dirs.length > limit) return { ok: false, reason: `путей в замыкании больше ${limit}` };
  return {
    ok: true,
    packages: start.map((p) => p.name ?? p.dir),
    dirs,
  };
}
