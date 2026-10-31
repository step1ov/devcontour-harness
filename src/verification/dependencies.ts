import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { ExecutionPolicy } from '../contracts/index.ts';
import type { AttemptState } from '../contracts/index.ts';
import { git } from '../environment/process.ts';
import { executionEnvironment, runSteps } from '../environment/lifecycle.ts';
import { materializeStore, type StoreContext } from './dependency-store.ts';

type Repo = ExecutionPolicy['repositories'][number];
export type DependencySnapshot = NonNullable<AttemptState['dependencies']>[number];
export type DependencyFreshness = NonNullable<AttemptState['dependencyFreshness']>[number];

/** Репозитории политики с разрешёнными путями checkout. */
export interface Repositories {
  repo(id: string): Repo;
  path(repo: Repo): string;
}

/** Зависимости компонентов в топологическом порядке, транзитивно. */
export function dependencyOrder(repos: Repositories, ids: string[]) {
  const ordered: string[] = [];
  const active = new Set<string>();
  const visit = (id: string) => {
    if (ordered.includes(id)) return;
    if (active.has(id)) throw new Error('Цикл зависимостей компонентов');
    active.add(id);
    for (const parent of repos.repo(id).dependsOn) visit(parent);
    active.delete(id);
    ordered.push(id);
  };
  ids.forEach(visit);
  return ordered;
}

export async function artifactDigest(root: string, path: string) {
  const full = await realpath(join(root, path));
  if (!full.startsWith((await realpath(root)) + sep))
    throw new Error('Artifact выходит из компонента');
  return createHash('sha256')
    .update(await readFile(full))
    .digest('hex');
}

/**
 * Снимок зависимостей компонента в топологическом порядке: рабочее дерево
 * целевой ветки каждой зависимости, её `dependencyBuild` и digests
 * `dependencyArtifacts`.
 *
 * `overrides` подставляет зависимость уже существующим деревом (проверка
 * потребителя: компонент поручения — его интегрированный результат).
 * Подстановка идёт до сборки: промежуточные зависимости собираются уже против
 * неё. `predecessors` — принятые результаты поручений, от которых зависит
 * работа: их SHA обязан быть в снимке. Каждое созданное здесь рабочее дерево
 * принадлежит снимку с момента создания: при отказе на любом шаге созданные
 * деревья убираются, и отказ очистки не скрывается.
 */
export async function snapshotDependencies(input: {
  repos: Repositories;
  repositoryId: string;
  dir: string;
  artifacts: string;
  runId: string;
  policy: ExecutionPolicy;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  predecessors?: { repositoryId: string; resultSha: string }[];
  overrides?: Map<string, { path: string; sha: string }>;
  /** Хранилище зависимостей для `dependencyBuild` снимков. */
  store?: StoreContext;
}) {
  const { repos, signal } = input;
  const ids = dependencyOrder(repos, repos.repo(input.repositoryId).dependsOn);
  const snapshots: DependencySnapshot[] = [];
  const created: DependencySnapshot[] = [];
  await mkdir(input.dir, { recursive: true });
  try {
    for (const id of ids) {
      signal.throwIfAborted();
      const repo = repos.repo(id);
      const override = input.overrides?.get(id);
      if (override) {
        snapshots.push({
          repositoryId: id,
          sha: override.sha,
          tree: await git(override.path, 'rev-parse', 'HEAD^{tree}'),
          path: override.path,
          artifacts: [],
        });
        continue;
      }
      const checkout = repos.path(repo);
      const sha = await git(checkout, 'rev-parse', repo.targetRef);
      for (const predecessor of (input.predecessors ?? []).filter((p) => p.repositoryId === id))
        await git(checkout, 'merge-base', '--is-ancestor', predecessor.resultSha, sha).catch(() => {
          throw new Error(
            `Принятый результат зависимости ${id} (${predecessor.resultSha}) отсутствует в ${repo.targetRef}`,
          );
        });
      const path = join(input.dir, id);
      await git(checkout, 'worktree', 'add', '--detach', path, sha);
      const snapshot = {
        repositoryId: id,
        sha,
        tree: await git(path, 'rev-parse', 'HEAD^{tree}'),
        path,
        artifacts: [] as DependencySnapshot['artifacts'],
      };
      created.push(snapshot);
      snapshots.push(snapshot);
    }
    const paths = Object.fromEntries(snapshots.map((s) => [s.repositoryId, s.path]));
    for (const snapshot of snapshots) {
      const repo = repos.repo(snapshot.repositoryId);
      const execution = executionEnvironment(
        [input.policy.environment, repo.environment],
        {
          DEVCONTOUR_RUN_ID: input.runId,
          DEVCONTOUR_COMPONENTS_JSON: JSON.stringify(paths),
        },
        input.environment,
      );
      // Подставленное дерево (`overrides`) снимку не принадлежит: его хранилище
      // уже развёрнуто на своей фазе.
      if (input.store && repo.dependencyBuild.length && created.includes(snapshot))
        await materializeStore(input.store, {
          repo,
          cwd: snapshot.path,
          execution,
          signal,
          dir: join(input.artifacts, 'dependency-build', repo.id),
        });
      await runSteps(
        repo.dependencyBuild,
        snapshot.path,
        join(input.artifacts, 'dependency-build', repo.id),
        execution,
        signal,
      );
      for (const path of repo.dependencyArtifacts)
        snapshot.artifacts.push({ path, digest: await artifactDigest(snapshot.path, path) });
    }
    await assertDependencies(snapshots);
    await writeFile(join(input.dir, 'manifest.json'), JSON.stringify(snapshots, null, 2));
    return snapshots;
  } catch (error) {
    const failures = await removeSnapshots(repos, created);
    if (failures.length)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; не удалось убрать снимки: ${failures.join('; ')}`,
        { cause: error },
      );
    throw error;
  }
}

/** Убирает рабочие деревья снимков; возвращает отказы, а не скрывает их. */
export async function removeSnapshots(repos: Repositories, snapshots: DependencySnapshot[]) {
  const failures: string[] = [];
  for (const snapshot of snapshots)
    await git(
      repos.path(repos.repo(snapshot.repositoryId)),
      'worktree',
      'remove',
      '--force',
      snapshot.path,
    ).catch((e: unknown) =>
      failures.push(`${snapshot.repositoryId}: ${e instanceof Error ? e.message : String(e)}`),
    );
  return failures;
}

/** Закреплённый снимок не изменён: HEAD, отслеживаемые файлы и artifacts. */
export async function assertDependencies(snapshots: DependencySnapshot[]) {
  for (const snapshot of snapshots) {
    if (
      (await git(snapshot.path, 'rev-parse', 'HEAD')) !== snapshot.sha ||
      (await git(snapshot.path, 'status', '--porcelain', '--untracked-files=no'))
    )
      throw new Error('Изменён закреплённый dependency snapshot: ' + snapshot.repositoryId);
    for (const artifact of snapshot.artifacts)
      if ((await artifactDigest(snapshot.path, artifact.path)) !== artifact.digest)
        throw new Error(
          'Изменён artifact зависимости: ' + snapshot.repositoryId + '/' + artifact.path,
        );
  }
}

/**
 * Свежесть снимка на момент окончания проверки: голова целевой ветки каждой
 * зависимости и совпадает ли она со снимком. Параллельная работа законно
 * двигает ветки зависимостей, поэтому сдвиг не отклоняет результат, а
 * фиксируется в попытке и результате; сочетание версий проверяет совместная
 * проверка по закреплённому манифесту.
 */
export async function dependencyFreshness(
  repos: Repositories,
  snapshots: Pick<DependencySnapshot, 'repositoryId' | 'sha'>[],
): Promise<DependencyFreshness[]> {
  const result: DependencyFreshness[] = [];
  for (const snapshot of snapshots) {
    const repo = repos.repo(snapshot.repositoryId);
    const head = await git(repos.path(repo), 'rev-parse', repo.targetRef);
    result.push({
      repositoryId: repo.id,
      snapshot: snapshot.sha,
      head,
      fresh: head === snapshot.sha,
    });
  }
  return result;
}
