// Шаги на хосте после исполнителя — по доверенной базе (alpha.67,
// docs/infra-works.md). Teardown попытки работы инфраструктуры исполняется вне
// песочницы, когда в дереве кандидата уже лежит код, не прошедший ревью (или
// отклонённый). Поэтому он исполняется не в дереве кандидата, а в отдельном
// чистом checkout доверенной базы (`git worktree add --detach`), который
// убирается после шага. Дерево кандидата harness не меняет: черновик и
// `keepDraft` видят его целиком. Файлы, которые setup создал в дереве
// кандидата, в checkout базы не попадают: teardown, которому они нужны,
// откажет — запись окружения останется `cleanup-failed`, а очистку доведут
// `harness cleanup` и сверка по меткам (закрыто по умолчанию).

import { mkdtemp, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { git } from './process.ts';

/** Доверенная база попытки: коммит (target ref при выдаче) и область инфраструктуры. */
export interface TrustedTree {
  base: string;
  paths?: string[];
}

const PREFIX = 'trusted-base-';

/**
 * Исполнить `run` в отдельном чистом checkout базы: создать его рядом с
 * записью окружения (`dir`), передать путь, убрать после — и при отказе.
 * `repo` — любое дерево репозитория (дерево кандидата): через него git
 * находит общий каталог.
 */
export async function withBaseCheckout<T>(
  repo: string,
  base: string,
  dir: string,
  run: (cwd: string) => Promise<T>,
): Promise<T> {
  const path = await mkdtemp(join(dir, PREFIX));
  try {
    await git(repo, 'worktree', 'add', '--detach', path, base);
    return await run(path);
  } finally {
    await removeBaseCheckout(repo, dir, path);
  }
}

async function removeBaseCheckout(repo: string, dir: string, path: string) {
  try {
    await git(repo, 'worktree', 'remove', '--force', path);
  } catch {
    // Убирается только созданный здесь каталог.
    const full = resolve(path);
    if (full.startsWith(resolve(dir) + sep) && basename(full).startsWith(PREFIX))
      await rm(full, { recursive: true, force: true });
  }
  await git(repo, 'worktree', 'prune').catch(() => undefined);
}
