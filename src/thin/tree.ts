// Деревья тонкого режима (alpha.73). Одно дерево работы на все её сдачи
// (`worktrees/work-<id>`, ветка `harness/work-<id>`): создаётся первой сдачей
// и живёт до приёмки. Проверка — на отдельном дереве интеграции: чистый
// checkout текущей цели и слияние закоммиченного кандидата, поэтому
// неотслеживаемые и игнорируемые файлы исполнителя в проверку не попадают.

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TaskFailure } from '../contracts/index.ts';
import { git } from '../environment/process.ts';
import { dropGateOutputs } from '../verification/gate-outputs.ts';

/** Ветка дерева работы. */
export const workBranch = (workId: string) => `harness/work-${workId}`;

/** Зарегистрировано ли дерево у репозитория (а не просто каталог). */
async function registered(repoPath: string, dir: string) {
  const list = await git(repoPath, 'worktree', 'list', '--porcelain').catch(() => '');
  const real = existsSync(dir) ? realpathSync(dir) : dir;
  return list.split('\n').some((l) => l.startsWith('worktree ') && l.slice(9) === real);
}

/**
 * Дерево работы: зарегистрированное — как есть (с правками прошлых сдач);
 * ветка работы есть, а дерева нет (убрано) — дерево на её коммитах; нет и
 * ветки — от цели.
 */
export async function ensureWorkTree(repoPath: string, dir: string, workId: string, base: string) {
  if (existsSync(dir) && (await registered(repoPath, dir))) return { created: false };
  await removeTree(repoPath, dir);
  await mkdir(dirname(dir), { recursive: true });
  const branch = workBranch(workId);
  const exists = await git(repoPath, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    await git(repoPath, 'worktree', 'add', dir, branch);
    return { created: false };
  }
  await git(repoPath, 'worktree', 'add', '-b', branch, dir, base);
  return { created: true };
}

/** Дерево, ветка и сессии работы — после приёмки, отмены или сброса ведущего. */
export async function discardWork(repoPath: string, dir: string, workId: string, sessions: string) {
  await removeTree(repoPath, dir).catch(() => undefined);
  await git(repoPath, 'branch', '-D', workBranch(workId)).catch(() => undefined);
  await rm(sessions, { recursive: true, force: true }).catch(() => undefined);
}

const HARNESS_GIT = [
  '-c',
  'user.name=harness',
  '-c',
  'user.email=harness@localhost',
  '-c',
  'core.hooksPath=/dev/null',
];

/**
 * Закоммитить дерево работы (если есть что); кандидат — HEAD дерева. Новые
 * файлы под объявленными выходами gates (`outputs`, P11-5) в коммит не идут;
 * `dropped` получает их пути.
 */
export async function commitWork(
  dir: string,
  message: string,
  outputs: readonly string[] = [],
  dropped?: (paths: string[]) => void,
): Promise<string> {
  await git(dir, 'add', '-A');
  const left = await dropGateOutputs(dir, outputs);
  if (left.length) dropped?.(left);
  if (await git(dir, 'status', '--porcelain', '--untracked-files=no'))
    await git(dir, ...HARNESS_GIT, 'commit', '-q', '--no-gpg-sign', '--no-verify', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * Слить текущую цель в ветку работы, если она сдвинулась с общей базы. Чистое
 * слияние — коммит; конфликт остаётся в дереве (маркеры, MERGE_HEAD) для
 * исполнителя. Цель уже в ветке — `undefined`.
 */
export async function mergeTarget(
  dir: string,
  target: string,
): Promise<{ conflicts: string[] } | undefined> {
  if ((await git(dir, 'merge-base', target, 'HEAD')) === target) return undefined;
  try {
    await git(dir, ...HARNESS_GIT, 'merge', '--no-ff', '--no-edit', '--no-gpg-sign', target);
    return { conflicts: [] };
  } catch {
    const files = (await git(dir, 'diff', '--name-only', '--diff-filter=U').catch(() => ''))
      .split('\n')
      .filter(Boolean);
    // Слияние не началось (незакоммиченные правки прошлой сдачи мешают):
    // дерево как есть, цель сольётся на проверке.
    return files.length ? { conflicts: files } : undefined;
  }
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
