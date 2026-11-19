import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HarnessError,
  digestOf,
  executionDigest,
  type ExecutionPolicy,
} from '../contracts/index.ts';
import { git } from '../environment/process.ts';
import { HARNESS_VERSION } from '../package.ts';
import { repositoryPath } from './gates-check.ts';
import { smokeLifecycle, type LifecycleSmokeResult } from './lifecycle-smoke.ts';

type Repo = ExecutionPolicy['repositories'][number];

/** Есть ли у репозитория окружение, которое стоит поднимать до попыток. */
export const hasEnvironment = (policy: ExecutionPolicy, repo: Repo) => {
  const lifecycle = repo.lifecycle ?? policy.lifecycle;
  return Boolean(
    lifecycle?.setup.length ||
    lifecycle?.ready.length ||
    lifecycle?.teardown.length ||
    repo.prepare.length ||
    repo.dependencyStore ||
    repo.dependsOn.length,
  );
};

/** Исход preflight одного репозитория. */
export interface PreflightOutcome {
  repositoryId: string;
  sha: string;
  /** Ключ кэша: дерево базы, digest исполнительной политики, версия harness. */
  key: string;
  /** Успех взят из каталога состояния, окружение не поднималось. */
  cached: boolean;
  result: LifecycleSmokeResult;
}

/** Файл записи preflight в каталоге состояния. */
export const preflightFile = (stateDir: string, key: string) =>
  join(stateDir, 'preflight', key.replace(/^sha256:/, '') + '.json');

const readCached = (file: string): LifecycleSmokeResult | undefined => {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as { result?: LifecycleSmokeResult };
    return record.result?.passed === true ? record.result : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Preflight окружения перед `run` (`lifecyclePreflight: "cached"`): для
 * каждого названного репозитория с окружением (lifecycle, `prepare`,
 * хранилище, зависимости) — `smokeLifecycle` на `targetRef`, один раз на
 * ключ (дерево базы, `executionDigest` политики, версия harness). Успех
 * записывается в `<stateDir>/preflight/<ключ>.json` и при том же ключе не
 * повторяется. Отказ записывается для разбора, но не переиспользуется: порт,
 * сеть и службы — состояние машины, а не дерева. Первый отказ —
 * `LIFECYCLE_FAILED` с классом, шагом и советом; следующие репозитории не
 * проверяются.
 */
export async function lifecyclePreflight(input: {
  policy: ExecutionPolicy;
  baseDir: string;
  stateDir: string;
  repositoryIds: readonly string[];
  resourceDatabase?: string;
  checkoutRoot?: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<PreflightOutcome[]> {
  const { policy } = input;
  const pathOf = repositoryPath(input.baseDir);
  const outcomes: PreflightOutcome[] = [];
  for (const id of [...new Set(input.repositoryIds)]) {
    const repo = policy.repositories.find((r) => r.id === id);
    if (!repo || !hasEnvironment(policy, repo)) continue;
    let sha: string, tree: string;
    try {
      sha = await git(pathOf(repo), 'rev-parse', '--verify', `${repo.targetRef}^{commit}`);
      tree = await git(pathOf(repo), 'rev-parse', '--verify', `${sha}^{tree}`);
    } catch {
      throw new HarnessError(
        'NOT_FOUND',
        `Preflight окружения: target ref ${repo.targetRef} не найден в ${repo.id}`,
      );
    }
    const key = digestOf({
      repositoryId: repo.id,
      tree,
      policy: executionDigest(policy),
      harness: HARNESS_VERSION,
    });
    const file = preflightFile(input.stateDir, key);
    const cached = readCached(file);
    if (cached) {
      outcomes.push({ repositoryId: repo.id, sha, key, cached: true, result: cached });
      continue;
    }
    const result = await smokeLifecycle({
      policy,
      baseDir: input.baseDir,
      stateDir: input.stateDir,
      repositoryId: repo.id,
      rev: sha,
      ...(input.resourceDatabase ? { resourceDatabase: input.resourceDatabase } : {}),
      ...(input.checkoutRoot ? { checkoutRoot: input.checkoutRoot } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    mkdirSync(join(input.stateDir, 'preflight'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify(
        { key, repositoryId: repo.id, tree, checkedAt: new Date().toISOString(), result },
        null,
        2,
      ),
    );
    renameSync(tmp, file);
    outcomes.push({ repositoryId: repo.id, sha, key, cached: false, result });
    if (!result.passed) {
      const f = result.failure!;
      const where = f.step ? ` на шаге ${f.stage}/${f.step}` : '';
      throw new HarnessError(
        'LIFECYCLE_FAILED',
        `Preflight окружения ${repo.id} @ ${sha.slice(0, 12)} не прошёл (${f.class})${where}: ${f.message}. ` +
          `Что сделать: ${f.advice} Попытки не начаты, модели не вызывались. ` +
          `Повторить проверку без запуска: harness smoke --state <state> --sha ${repo.targetRef}` +
          (policy.repositories.length > 1 ? ` --repository ${repo.id}` : '') +
          `. Логи: ${result.logs}`,
        [
          { path: ['preflight', repo.id, 'class'], message: f.class },
          ...result.steps
            .filter((s) => s.status === 'failed')
            .map((s) => ({
              path: ['preflight', repo.id, s.stage, s.id],
              message: `failed${s.exitCode !== undefined ? ' exit ' + s.exitCode : ''}${s.timedOut ? ' timeout' : ''}${s.log ? ' log ' + s.log : ''}`,
            })),
        ],
      );
    }
  }
  return outcomes;
}
