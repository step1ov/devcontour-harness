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

/** Режим и объект пути в дереве `rev` (`git ls-tree`); нет пути — `undefined`. */
async function entry(cwd: string, rev: string, path: string) {
  const out = await git(cwd, 'ls-tree', '-z', rev, '--', path).catch(() => '');
  const line = out.split('\0').find(Boolean);
  if (!line) return undefined;
  const [meta, name] = line.split('\t');
  if (name !== path) return undefined;
  const [mode, , object] = meta!.split(' ');
  return { mode: mode!, object: object! };
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
      : (await git(cwd, 'ls-files', '-s', '-z', '--', path).catch(() => ''))
          .split('\0')
          .find(Boolean)
          ?.split(' ')[0];
    if (mode === LINK_MODE) links.add(path);
  }
  return { present, links };
}
