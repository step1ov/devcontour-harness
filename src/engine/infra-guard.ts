// Граница доверия работы инфраструктуры (alpha.67, docs/infra-works.md) над
// настоящим деревом: какие из изменённых путей есть в доверенной базе, какие
// стали символическими ссылками и куда по ссылкам базы ведут файлы шагов на
// хосте. Чистое решение — `infraViolations` (contracts/infra.ts).

import { posix } from 'node:path';
import { git } from '../environment/process.ts';

/** Режим git-объекта символической ссылки. */
const LINK_MODE = '120000';
/** Предел переходов по ссылкам при разрешении одного пути. */
const MAX_HOPS = 20;

/**
 * Записи `-z` вывода git (`<метаданные>\t<путь>`): путь — после первой
 * табуляции, целиком (в имени файла может быть и табуляция).
 */
function records(out: string) {
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { meta: line.slice(0, tab).split(' '), name: line.slice(tab + 1) };
    });
}

/**
 * Режим и объект пути в дереве `rev` (`git ls-tree`); нет пути — `undefined`.
 * Путь — буквальный (`--literal-pathspecs`: `[A].mjs` не шаблон), запись —
 * с точно тем же именем.
 */
async function entry(cwd: string, rev: string, path: string) {
  const out = await git(cwd, '--literal-pathspecs', 'ls-tree', '-z', rev, '--', path).catch(
    () => '',
  );
  const found = records(out).find((r) => r.name === path);
  if (!found) return undefined;
  return { mode: found.meta[0]!, object: found.meta[2]! };
}

/** Имена в каталоге `dir` дерева `rev` (`''` — корень). */
async function names(cwd: string, rev: string, dir: string) {
  const out = await git(
    cwd,
    '--literal-pathspecs',
    'ls-tree',
    '-z',
    '--name-only',
    rev,
    '--',
    ...(dir ? [dir + '/'] : []),
  ).catch(() => '');
  return out
    .split('\0')
    .filter(Boolean)
    .map((p) => p.slice(dir ? dir.length + 1 : 0));
}

/**
 * Путь дерева `rev` с разрешёнными ссылками на себе и предках: настоящий
 * путь внутри репозитория. Ссылка за пределы дерева или цикл — `undefined`
 * (такой путь не принадлежит дереву, и проверять его нечем).
 */
export async function resolveInTree(
  cwd: string,
  rev: string,
  path: string,
): Promise<string | undefined> {
  const dir = path.endsWith('/');
  let rest = path.replace(/\/+$/, '').split('/').filter(Boolean);
  let done: string[] = [];
  let hops = 0;
  while (rest.length) {
    const next = [...done, rest[0]!].join('/');
    const e = await entry(cwd, rev, next);
    if (e?.mode !== LINK_MODE) {
      done.push(rest.shift()!);
      continue;
    }
    if (++hops > MAX_HOPS) return undefined;
    const target = (await git(cwd, 'cat-file', 'blob', e.object)).trim();
    if (!target || target.startsWith('/')) return undefined;
    const joined = posix.normalize(posix.join(done.join('/'), target));
    if (joined === '..' || joined.startsWith('../')) return undefined;
    done = [];
    rest = [...(joined === '.' ? [] : joined.split('/')), ...rest.slice(1)];
  }
  const out = done.join('/');
  return out ? out + (dir ? '/' : '') : undefined;
}

/** Файлы шагов на хосте и их цели по ссылкам доверенной базы. */
export async function resolvedHostFiles(cwd: string, base: string, files: readonly string[]) {
  const out = new Set(files);
  for (const f of files) {
    if (f === '.') continue;
    const r = await resolveInTree(cwd, base, f);
    if (r) out.add(r);
  }
  return [...out];
}

/**
 * Что из изменённых путей есть в доверенной базе и что в кандидате —
 * символическая ссылка. `head` — коммит кандидата; нет — индекс дерева.
 */
export async function changedFacts(
  cwd: string,
  base: string,
  head: string | undefined,
  changed: readonly string[],
) {
  const present = new Set<string>();
  const links = new Set<string>();
  for (const path of changed) {
    if (await entry(cwd, base, path)) present.add(path);
    const mode = head
      ? (await entry(cwd, head, path))?.mode
      : records(
          await git(cwd, '--literal-pathspecs', 'ls-files', '-s', '-z', '--', path).catch(() => ''),
        ).find((r) => r.name === path)?.meta[0];
    if (mode === LINK_MODE) links.add(path);
  }
  // Новый путь, чей первый новый сегмент совпадает основой имени с файлом
  // или каталогом базы рядом (`lib.js` рядом с `lib/`, `util.ts` рядом с
  // `util.mjs`): он меняет, что найдёт разрешение модулей.
  const shadows = new Set<string>();
  const listed = new Map<string, Promise<string[]>>();
  const list = (dir: string) => {
    let p = listed.get(dir);
    if (!p) listed.set(dir, (p = names(cwd, base, dir)));
    return p;
  };
  const stem = (name: string) => name.replace(/\.[^.]*$/, '');
  for (const path of changed) {
    if (present.has(path)) continue;
    const segments = path.split('/');
    for (let i = 0; i < segments.length; i++) {
      const prefix = segments.slice(0, i + 1).join('/');
      if (i < segments.length - 1 && (await entry(cwd, base, prefix))) continue;
      const dir = segments.slice(0, i).join('/');
      const own = segments[i]!;
      if ((await list(dir)).some((n) => n !== own && (stem(n) === stem(own) || n === stem(own))))
        shadows.add(path);
      break;
    }
  }
  return { present, links, shadows };
}
