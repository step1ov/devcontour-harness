// Доверенные метаданные git дерева попытки (0.1.0-alpha.70, ревью 2).
//
// Под границей записи исполнителю и gates открыт каталог git их дерева
// (`<common>/worktrees/<имя>`): HEAD, index. Исполнитель мог бы
// переключить дерево на ветку владельца (`git checkout main`) или
// переписать `commondir`/`gitdir`/файл `.git` дерева — тогда обычный
// `git commit` controller через HEAD сдвинул бы чужую ветку или писал бы в
// другой репозиторий. Поэтому controller при создании дерева запоминает
// метаданные, перед записью кандидата сверяет их (расхождение —
// засчитанное нарушение области исполнителем) и записывает кандидата не
// через HEAD: свежий index от базы (`read-tree`), `write-tree`,
// `commit-tree -p <база>`, `update-ref refs/heads/<ветка попытки> <новый>
// <база>` — с явным `--git-dir`.

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../environment/process.ts';

export interface TrustedGitMeta {
  cwd: string;
  gitDir: string;
  common: string;
  /** Ветка дерева попытки: `refs/heads/<prefix><попытка>`. */
  branch: string;
  files: { dotGit: string; commondir: string; gitdir: string; configWorktree: string | null };
}

/** Файл, которого может не быть: `null` — нет; ссылка — особое значение. */
async function optional(path: string): Promise<string | null> {
  try {
    const st = await lstat(path);
    if (!st.isFile()) return '\0not-a-file';
    // Пустой файл — как отсутствующий: bubblewrap создаёт его заранее, чтобы
    // закрыть на запись (ревью 3).
    return (await readFile(path, 'utf8')) || null;
  } catch {
    return null;
  }
}

async function regular(path: string): Promise<string | undefined> {
  try {
    const st = await lstat(path);
    if (!st.isFile()) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Запомнить метаданные сразу после `git worktree add` (до любого процесса попытки). */
export async function captureGitMeta(cwd: string, branch: string): Promise<TrustedGitMeta> {
  const gitDir = await git(cwd, 'rev-parse', '--absolute-git-dir');
  const common = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const files = {
    dotGit: (await regular(join(cwd, '.git'))) ?? '',
    commondir: (await regular(join(gitDir, 'commondir'))) ?? '',
    gitdir: (await regular(join(gitDir, 'gitdir'))) ?? '',
    configWorktree: await optional(join(gitDir, 'config.worktree')),
  };
  return { cwd, gitDir, common, branch, files };
}

/**
 * Сверить метаданные дерева с запомненными: файлы `.git`, `commondir`,
 * `gitdir` — те же обычные файлы, HEAD — символьная ссылка на ветку
 * попытки. Возвращает описание расхождения или `undefined`.
 */
export async function gitMetaProblem(meta: TrustedGitMeta): Promise<string | undefined> {
  const now = {
    dotGit: await regular(join(meta.cwd, '.git')),
    commondir: await regular(join(meta.gitDir, 'commondir')),
    gitdir: await regular(join(meta.gitDir, 'gitdir')),
  };
  for (const k of ['dotGit', 'commondir', 'gitdir'] as const)
    if (now[k] !== meta.files[k])
      return `метаданные git дерева попытки изменены (${k === 'dotGit' ? '.git' : k})`;
  // `config.worktree` (фильтры, `core.worktree`) и `config` каталога дерева —
  // как при создании (ревью 3).
  if ((await optional(join(meta.gitDir, 'config.worktree'))) !== meta.files.configWorktree)
    return 'метаданные git дерева попытки изменены (config.worktree)';
  if ((await optional(join(meta.gitDir, 'config'))) !== null)
    return 'метаданные git дерева попытки изменены (config в каталоге дерева)';
  // Ссылка вместо файла в каталоге дерева — отказ, какой бы ни была цель.
  for (const name of ['HEAD', 'index', 'commondir', 'gitdir'])
    try {
      if ((await lstat(join(meta.gitDir, name))).isSymbolicLink())
        return `метаданные git дерева попытки изменены (${name} — символическая ссылка)`;
    } catch {
      /* нет файла: HEAD/commondir/gitdir проверены выше, index может отсутствовать */
    }
  const head = await regular(join(meta.gitDir, 'HEAD'));
  if (head?.trim() !== `ref: ${meta.branch}`)
    return `HEAD дерева попытки переключён (${(head ?? 'не файл').trim().slice(0, 100)}), а не на ${meta.branch}`;
  return undefined;
}

const explicit = (meta: TrustedGitMeta) => [`--git-dir=${meta.gitDir}`, `--work-tree=${meta.cwd}`];

/**
 * Index дерева — заново от базы перед записью кандидата: каталог git
 * дерева под границей закрыт (alpha.69-граница, ревью 4), index пишет
 * только controller; `read-tree` снимает и любые прежние флаги.
 */
export async function resetIndex(meta: TrustedGitMeta, base: string) {
  await git(meta.cwd, ...explicit(meta), 'read-tree', base);
}

/**
 * Записать кандидата не через HEAD: дерево из index (его собрал controller
 * после `resetIndex`), коммит с родителем-базой, продвижение ветки попытки
 * с ожидаемым прежним значением. Возвращает SHA кандидата.
 */
export async function commitCandidate(meta: TrustedGitMeta, base: string, message: string) {
  const tree = await git(meta.cwd, ...explicit(meta), 'write-tree');
  const sha = await git(
    meta.cwd,
    ...explicit(meta),
    'commit-tree',
    '--no-gpg-sign',
    tree,
    '-p',
    base,
    '-m',
    message,
  );
  await git(meta.cwd, `--git-dir=${meta.common}`, 'update-ref', meta.branch, sha, base);
  return sha;
}
