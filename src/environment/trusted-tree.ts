// Шаги на хосте после исполнителя — по доверенной базе (alpha.67,
// docs/infra-works.md). Teardown попытки работы инфраструктуры исполняется вне
// песочницы, когда в дереве уже лежит код кандидата, не прошедший ревью (или
// отклонённый). Чтобы он исполнял только принятый код, перед teardown
// изменения области инфраструктуры относительно базы откладываются в каталог
// окружения фазы, а область получает содержимое базы; после успешного
// teardown изменения возвращаются (черновик следующей попытки их видит). При
// неудачном teardown дерево остаётся в состоянии базы: повтор очистки по
// записи окружения тоже исполнит только принятый код. Индекс git не меняется.

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { git, gitRawOutput } from './process.ts';

/** Доверенная база области: коммит и пути (`repositories[].infra.paths`). */
export interface TrustedTree {
  base: string;
  paths: string[];
}

/** Неотслеживаемые (и игнорируемые) файлы области до исполнителя: путь → размер и время. */
export type UntrackedState = Record<string, string>;

const list = (out: string) => out.split('\0').filter(Boolean);
const inside = (cwd: string, path: string) => {
  const full = resolve(cwd, path);
  if (!full.startsWith(resolve(cwd) + sep)) throw new Error('Путь вне дерева: ' + path);
  return full;
};
async function stamp(cwd: string, path: string) {
  try {
    const s = await lstat(inside(cwd, path));
    return `${s.size}:${s.mtimeMs}:${s.mode}`;
  } catch {
    return undefined;
  }
}

/** Снимок неотслеживаемых файлов области (после setup/ready, до исполнителя). */
export async function untrackedState(cwd: string, t: TrustedTree): Promise<UntrackedState> {
  const out: UntrackedState = {};
  for (const p of list(await gitRawOutput(cwd, 'ls-files', '-z', '--others', '--', ...t.paths))) {
    const s = await stamp(cwd, p);
    if (s) out[p] = s;
  }
  return out;
}

interface Moved {
  path: string;
  /** Файла в дереве не было (удалён кандидатом). */
  absent?: true;
  link?: string;
  mode?: number;
}

/**
 * Отложить изменения области относительно базы и вернуть области содержимое
 * базы. `before` — неотслеживаемые файлы до исполнителя: их (без изменений)
 * не трогают — их создал setup. Возвращает список отложенного.
 */
export async function setAside(
  cwd: string,
  t: TrustedTree,
  before: UntrackedState,
  asideDir: string,
): Promise<Moved[]> {
  const tracked = list(
    await gitRawOutput(cwd, 'diff', '--no-renames', '--name-only', '-z', t.base, '--', ...t.paths),
  );
  const untracked: string[] = [];
  for (const p of list(await gitRawOutput(cwd, 'ls-files', '-z', '--others', '--', ...t.paths)))
    if (before[p] === undefined || before[p] !== (await stamp(cwd, p))) untracked.push(p);
  const paths = [...new Set([...tracked, ...untracked])];
  if (!paths.length) return [];
  const moved: Moved[] = [];
  const files = join(asideDir, 'files');
  for (const path of paths) {
    const full = inside(cwd, path);
    let st;
    try {
      st = await lstat(full);
    } catch {
      moved.push({ path, absent: true });
      continue;
    }
    if (st.isDirectory()) continue;
    const copy = join(files, path);
    await mkdir(dirname(copy), { recursive: true });
    if (st.isSymbolicLink()) moved.push({ path, link: await readlink(full) });
    else {
      await copyFile(full, copy);
      moved.push({ path, mode: st.mode & 0o7777 });
    }
    await rm(full, { force: true });
  }
  await writeFile(join(asideDir, 'moved.json'), JSON.stringify(moved, null, 2));
  const inBase: string[] = [];
  for (const path of paths)
    if (
      await git(cwd, 'cat-file', '-e', `${t.base}:${path}`).then(
        () => true,
        () => false,
      )
    )
      inBase.push(path);
  for (let i = 0; i < inBase.length; i += 100)
    await git(
      cwd,
      'restore',
      `--source=${t.base}`,
      '--worktree',
      '--',
      ...inBase.slice(i, i + 100),
    );
  return moved;
}

/** Вернуть отложенные изменения поверх содержимого базы. */
export async function putBack(cwd: string, asideDir: string, moved: readonly Moved[]) {
  for (const m of moved) {
    const full = inside(cwd, m.path);
    await rm(full, { force: true });
    if (m.absent) continue;
    await mkdir(dirname(full), { recursive: true });
    if (m.link !== undefined) await symlink(m.link, full);
    else {
      await copyFile(join(asideDir, 'files', m.path), full);
      if (m.mode !== undefined) await chmod(full, m.mode);
    }
  }
}

/** Снимок `before`, записанный фазой рядом с записью окружения. */
export async function readUntrackedState(file: string): Promise<UntrackedState | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as UntrackedState;
  } catch {
    return undefined;
  }
}
