import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { command, git, hostGitArgs } from '../environment/process.ts';
import { assertTrustedCheckout, worktreeKey } from '../environment/git-trust.ts';
import type { AttemptState, WorkState } from '../contracts/index.ts';

/**
 * Рабочие деревья закончившихся попыток. Обычно попытка убирает их сама; после
 * падения процесса, отказа удаления или под прежними версиями они остаются и
 * занимают диск. Ветка попытки, её объекты и артефакты не трогаются: дерево
 * нужно только для неподтверждённых правок, и они сохраняются патчем.
 */
export type WorktreeRefusal =
  | 'active'
  | 'recoverable'
  | 'cleanup-pending'
  | 'unknown-attempt'
  | 'untrusted'
  | 'embedded-repository';

export interface WorktreeCleanupEntry {
  path: string;
  repositoryId: string;
  attemptId?: string;
  /** remove — будет удалено (dry run); removed — удалено; refused, failed — дерево на месте. */
  action: 'remove' | 'removed' | 'refused' | 'failed';
  reason?: WorktreeRefusal;
  error?: string;
  head?: string;
  sizeKb?: number;
  /** Файлов с неподтверждёнными правками. */
  uncommitted?: number;
  /** Патч этих правок (не для dry run): `git apply --index` поверх `head`. */
  patch?: string;
}

const terminalWork: readonly string[] = ['done', 'failed', 'cancelled'];

/** Почему попытку нельзя лишить дерева: идёт, или её работа ещё может продолжиться. */
export function attemptRefusal(
  attempt: AttemptState,
  work: WorkState | undefined,
  latest: boolean,
  running: boolean,
): WorktreeRefusal | undefined {
  if (attempt.status === 'active' || running) return 'active';
  if (latest && !(work && terminalWork.includes(work.status))) return 'recoverable';
  return undefined;
}

/** Незавершённая очистка: дерево — вход `cleanup --run`, его нельзя убирать мимо teardown. */
export async function cleanupUnfinished(artifacts: string, receipts: string[]) {
  const file = join(artifacts, 'cleanup-pending.json');
  if (existsSync(file)) {
    const { reason } = JSON.parse(await readFile(file, 'utf8')) as { reason?: string };
    if (reason !== 'remove-failed') return true;
  }
  for (const receipt of receipts) {
    const { status } = JSON.parse(await readFile(receipt, 'utf8')) as { status: string };
    if (status === 'active' || status === 'cleanup-failed') return true;
  }
  return false;
}

/** Зарегистрированные рабочие деревья репозитория: настоящий путь → HEAD. */
export async function registered(repoPath: string) {
  const out = await git(repoPath, 'worktree', 'list', '--porcelain');
  const found = new Map<string, string | undefined>();
  for (const block of out.split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (path) found.set(worktreeKey(path), /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1]);
  }
  return found;
}

const gitEnv = (index: string) => ({
  ...process.env,
  GIT_INDEX_FILE: index,
  GIT_TERMINAL_PROMPT: '0',
});

/** Изменённые и неотслеживаемые пути дерева без записи в его индекс. */
export async function uncommittedPaths(dir: string) {
  const out = await git(dir, '--no-optional-locks', 'status', '--porcelain', '-uall');
  return out.split('\n').filter(Boolean).length;
}

/**
 * Неподтверждённые правки дерева — патчем к его HEAD. Индекс попытки не
 * меняется: неотслеживаемые файлы добавляются во временный. Игнорируемые файлы
 * (зависимости, сборка) в патч не входят. Вложенный репозиторий патчем не
 * сохранить: дерево остаётся.
 */
export async function savePatch(dir: string, path: string) {
  const scratch = await mkdtemp(join(tmpdir(), 'harness-worktree-index-'));
  try {
    const env = gitEnv(join(scratch, 'index'));
    const run = async (...args: string[]) => {
      const result = await command(['git', ...hostGitArgs(dir, args)], dir, { env });
      if (result.code !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim()}`);
      return result.stdout;
    };
    await run('read-tree', 'HEAD');
    await run('add', '-A', '--', '.');
    if (/^:\d+ 160000 /m.test(await run('diff', '--cached', '--raw', 'HEAD'))) return false;
    await run(
      'diff',
      '--cached',
      '--binary',
      '--no-ext-diff',
      '--no-textconv',
      `--output=${path}`,
      'HEAD',
    );
    if (!(await stat(path)).size) throw new Error('пустой патч неподтверждённых правок');
    return true;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Дерево на диске — именно зарегистрированное дерево этого репозитория. */
export function trusted(dir: string, repoPath: string) {
  try {
    return assertTrustedCheckout(dir) === assertTrustedCheckout(repoPath);
  } catch {
    return false;
  }
}

export async function sizeKb(dir: string) {
  const result = await command(['du', '-sk', dir], tmpdir());
  return Number(/^\d+/.exec(result.stdout)?.[0] ?? 0);
}

/** Запись рядом с артефактами попытки: что убрано, с какой вершины и где патч. */
export async function recordRemoval(artifacts: string, entry: WorktreeCleanupEntry) {
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    join(artifacts, `worktree-cleanup-${basename(entry.path)}.json`),
    JSON.stringify({ ...entry, removedAt: new Date().toISOString() }, null, 2),
  );
}

export const isWithin = (path: string, root: string) => {
  const rest = relative(root, path);
  return !!rest && !rest.startsWith('..') && !rest.startsWith('/');
};
