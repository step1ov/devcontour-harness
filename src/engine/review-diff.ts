import { TaskFailure } from '../contracts/index.ts';
import { GitOutputLimit, git, gitWithLimit } from '../environment/process.ts';

/**
 * Предел diff независимого ревью кода, символов. Reviewer получает diff
 * целиком или не получает вовсе: усечённый diff выглядел бы полным, и часть
 * кода ушла бы без ревью.
 */
export const REVIEW_DIFF_LIMIT = 1_000_000;

/** Сколько путей называет отказ по размеру diff. */
const NAMED_PATHS = 20;

/**
 * Diff кандидата для ревью кода: целиком, без внешних diff и textconv. Больше
 * `limit` — отказ `review` с размером, пределом и изменёнными путями (имена —
 * JSON: это недоверенный ввод), а не усечённый diff.
 */
export async function codeReviewDiff(
  cwd: string,
  base: string,
  sha: string,
  limit = REVIEW_DIFF_LIMIT,
): Promise<string> {
  try {
    return await gitWithLimit(cwd, limit, 'diff', '--no-ext-diff', '--no-textconv', base, sha);
  } catch (error) {
    if (!(error instanceof GitOutputLimit)) throw error;
  }
  const paths = (await git(cwd, 'diff', '--no-renames', '--name-only', '-z', base, sha))
    .split('\0')
    .filter(Boolean);
  const named = paths.slice(0, NAMED_PATHS);
  throw new TaskFailure(
    'review',
    `Diff ${base.slice(0, 12)}..${sha.slice(0, 12)} больше предела независимого ревью ` +
      `(${limit} символов): ревью не проведено, reviewer не получил ни части diff; разделите поручение. ` +
      `Изменённые пути (${paths.length}, имена как JSON): ${JSON.stringify(named)}` +
      (paths.length > named.length ? ` и ещё ${paths.length - named.length}` : ''),
  );
}
