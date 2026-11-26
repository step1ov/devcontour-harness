// Деревья тонкого режима (alpha.73). Одно дерево работы на все её сдачи
// (`worktrees/work-<id>`, ветка `harness/work-<id>`): создаётся первой сдачей
// и живёт до приёмки. Проверка — на отдельном дереве интеграции: чистый
// checkout текущей цели и слияние закоммиченного кандидата, поэтому
// неотслеживаемые и игнорируемые файлы исполнителя в проверку не попадают.

import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TaskFailure } from '../contracts/index.ts';
import { git } from '../environment/process.ts';

/** Ветка дерева работы. */
export const workBranch = (workId: string) => `harness/work-${workId}`;

/** Дерево работы: есть — как есть (с правками прошлых сдач), нет — от цели. */
export async function ensureWorkTree(repoPath: string, dir: string, workId: string, base: string) {
  if (existsSync(dir)) return { created: false };
  await mkdir(dirname(dir), { recursive: true });
  // `-B`: ветка прежней (принятой или отменённой) жизни работы начинается заново.
  await git(repoPath, 'worktree', 'add', '-B', workBranch(workId), dir, base);
  return { created: true };
}

const HARNESS_GIT = [
  '-c',
  'user.name=harness',
  '-c',
  'user.email=harness@localhost',
  '-c',
  'core.hooksPath=/dev/null',
];

/** Закоммитить дерево работы (если есть что); кандидат — HEAD дерева. */
export async function commitWork(dir: string, message: string): Promise<string> {
  await git(dir, 'add', '-A');
  if (await git(dir, 'status', '--porcelain', '--untracked-files=no'))
    await git(dir, ...HARNESS_GIT, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Общая с целью база кандидата: от неё считаются область и сводка сдачи. */
export const mergeBase = (dir: string, target: string, candidate: string) =>
  git(dir, 'merge-base', target, candidate);

/**
 * Дерево интеграции: чистый checkout цели и слияние кандидата (`--no-ff`).
 * Конфликт — ход ведущего (`merge-conflict`, не засчитан) со списком файлов.
 */
export async function integrationTree(
  repoPath: string,
  dir: string,
  target: string,
  candidate: string,
): Promise<string> {
  await removeTree(repoPath, dir);
  await mkdir(dirname(dir), { recursive: true });
  await git(repoPath, 'worktree', 'add', '--detach', dir, target);
  try {
    await git(dir, ...HARNESS_GIT, 'merge', '--no-ff', '--no-edit', '--no-gpg-sign', candidate);
  } catch (error) {
    const files = await git(dir, 'diff', '--name-only', '--diff-filter=U').catch(() => '');
    await git(dir, 'merge', '--abort').catch(() => undefined);
    throw new TaskFailure(
      'needs-lead',
      `Сдача не сливается с целью ${target.slice(0, 12)}: конфликт в ${files.split('\n').filter(Boolean).join(', ') || (error instanceof Error ? error.message.slice(0, 300) : 'файлах')}; ведущий решает — повтор (исполнитель сольёт цель в дерево работы) или другой порядок работ`,
      undefined,
      'merge-conflict',
    );
  }
  const sha = await git(dir, 'rev-parse', 'HEAD');
  if (sha === target)
    throw new TaskFailure('empty-result', 'Сдача уже входит в цель: слиянию нечего добавить');
  return sha;
}

/** Убрать дерево (зарегистрированное или нет); каталог создан controller. */
export async function removeTree(repoPath: string, dir: string) {
  if (!existsSync(dir)) return;
  await git(repoPath, 'worktree', 'remove', '--force', dir).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
  await git(repoPath, 'worktree', 'prune').catch(() => undefined);
}
