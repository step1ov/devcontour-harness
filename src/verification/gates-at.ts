import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HarnessError,
  type EvidenceRecord,
  type ExecutionPolicy,
  type GatePolicy,
} from '../contracts/index.ts';
import { TaskFailure } from '../engine/failure.ts';
import { git } from '../environment/process.ts';
import { executionEnvironment, runSteps, withEnvironment } from '../environment/lifecycle.ts';
import { defaultResourceDatabase, withResources } from '../environment/resources.ts';
import { removeSnapshots, snapshotDependencies, type DependencySnapshot } from './dependencies.ts';
import { runGate } from './gates.ts';

type Repo = ExecutionPolicy['repositories'][number];

/** Что нужно проверке на SHA от controller (как у эксперимента выполнимости). */
export interface GatesAtContext {
  policy: ExecutionPolicy;
  /** Каталог состояния: здесь рабочее дерево, снимки зависимостей и логи. */
  stateDir: string;
  repoPath(repo: Repo): string;
  /** Закрытое проверке и открытое внутри него — та же граница, что у gates попыток. */
  boundary(): { hidden: string[]; readable: string[] };
  environment?: NodeJS.ProcessEnv;
  resourceDatabase?: string;
}

export interface GatesAtInput {
  /** Идентификатор проверки: `runId` её evidence и `DEVCONTOUR_RUN_ID` gates. */
  id?: string;
  repositoryId: string;
  /** Проверяемый коммит; evidence привязано к нему. */
  sha: string;
  /** Gates профиля; их предпосылки (`dependsOn`) добавляются и идут первыми. */
  gates: string[];
  /**
   * Запись evidence под fencing хоста. Бросок прерывает проверку: хост,
   * утративший право записи, результата не получает.
   */
  record(evidence: EvidenceRecord): void;
  signal?: AbortSignal;
}

export interface GatesAtResult {
  id: string;
  sha: string;
  /** Исполненные gates в порядке исполнения (с предпосылками). */
  gates: string[];
  evidence: EvidenceRecord[];
  /** Первый непрошедший gate и причина; после него проверка не продолжается. */
  failure?: { gate: string; message: string };
}

/** Gates с предпосылками в порядке профиля зависимостей (как у попытки). */
function closure(repo: Repo, ids: string[]): GatePolicy[] {
  const byId = new Map(repo.gates.map((g) => [g.id, g]));
  const out: GatePolicy[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    const gate = byId.get(id);
    if (!gate) throw new HarnessError('NOT_FOUND', `Gate ${id} не объявлен в ${repo.id}`);
    seen.add(id);
    for (const dep of gate.dependsOn ?? []) visit(dep);
    out.push(gate);
  };
  ids.forEach(visit);
  return out;
}

/**
 * Gates компонента на закреплённом SHA вне попытки — тем же исполнением, что
 * integration поручения: отдельное рабочее дерево на SHA, снимки зависимостей
 * компонента, ресурсы gates, lifecycle и prepare компонента, окружение фазы
 * `integration`, песочница проверок и `runGate`. Каждое evidence (вида `test`,
 * фазы `integration`, на этом SHA) записывается через `record` хоста до
 * следующего gate. После gates дерево обязано остаться на SHA без изменений.
 * Рабочее дерево и снимки убираются при любом исходе.
 *
 * Нужна приёмке набора поручений, когда часть gates профиля не исполнило ни
 * одно поручение: суженные области задач — законная декомпозиция, а полный
 * профиль проверяется один раз на итоговом SHA.
 */
export async function runGatesAt(ctx: GatesAtContext, input: GatesAtInput): Promise<GatesAtResult> {
  const repo = ctx.policy.repositories.find((r) => r.id === input.repositoryId);
  if (!repo) throw new HarnessError('NOT_FOUND', 'Репозиторий не объявлен: ' + input.repositoryId);
  if (!input.gates.length) throw new HarnessError('INVALID_INPUT', 'Не названы gates проверки');
  const gates = closure(repo, input.gates);
  const id = input.id ?? 'GA-' + randomUUID();
  const path = ctx.repoPath(repo);
  await git(path, 'cat-file', '-e', `${input.sha}^{commit}`).catch(() => {
    throw new HarnessError('NOT_FOUND', `Commit ${input.sha} недоступен в ${repo.id}`);
  });
  const root = join(ctx.stateDir, 'gates-at', id);
  const cwd = join(root, 'worktree');
  const artifacts = join(root, 'artifacts');
  const timeout = AbortSignal.timeout(ctx.policy.runTimeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const source = ctx.environment ?? process.env;
  const evidence: EvidenceRecord[] = [];
  let failure: GatesAtResult['failure'];
  let snapshots: DependencySnapshot[] = [];
  let added = false;
  await mkdir(root, { recursive: true });
  try {
    await withResources(
      {
        resources: ctx.policy.resources,
        leaseMs: ctx.policy.leaseMs,
        resourceDatabase: ctx.resourceDatabase ?? defaultResourceDatabase(),
      },
      [...new Set(gates.flatMap((g) => g.resources ?? []))],
      `${ctx.stateDir}:${id}`,
      signal,
      async (signal, resources) => {
        const repos = {
          repo: (rid: string) => {
            const found = ctx.policy.repositories.find((r) => r.id === rid);
            if (!found) throw new Error('Неизвестный репозиторий: ' + rid);
            return found;
          },
          path: (r: Repo) => ctx.repoPath(r),
        };
        if (repo.dependsOn.length)
          snapshots = await snapshotDependencies({
            repos,
            repositoryId: repo.id,
            dir: join(root, 'dependencies'),
            artifacts,
            runId: id,
            policy: ctx.policy,
            environment: source,
            signal,
          });
        await git(path, 'worktree', 'add', '--detach', cwd, input.sha);
        added = true;
        const execution = executionEnvironment(
          [ctx.policy.environment, repo.environment],
          {
            DEVCONTOUR_REPOSITORY_ID: repo.id,
            DEVCONTOUR_RUN_ID: id,
            DEVCONTOUR_PHASE: 'integration',
            DEVCONTOUR_RESOURCES_JSON: JSON.stringify(resources),
            DEVCONTOUR_DEPENDENCIES_JSON: JSON.stringify(snapshots),
            DEVCONTOUR_COMPONENTS_JSON: JSON.stringify({
              ...Object.fromEntries(snapshots.map((d) => [d.repositoryId, d.path])),
              [repo.id]: cwd,
            }),
          },
          source,
        );
        const boundary = ctx.boundary();
        await withEnvironment(
          repo.lifecycle ?? ctx.policy.lifecycle,
          cwd,
          join(artifacts, 'environment'),
          execution,
          signal,
          async () => {
            await runSteps(repo.prepare, cwd, join(artifacts, 'prepare'), execution, signal);
            for (const gate of gates) {
              try {
                await runGate({
                  policy: ctx.policy,
                  record: (e) => {
                    const full: EvidenceRecord = {
                      ...e,
                      id: randomUUID(),
                      runId: id,
                      createdAt: new Date().toISOString(),
                    };
                    input.record(full);
                    evidence.push(full);
                    return full;
                  },
                  cwd,
                  sha: input.sha,
                  phase: 'integration',
                  gate,
                  artifactDir: artifacts,
                  signal,
                  execution,
                  boundary: {
                    hidden: boundary.hidden,
                    readable: [...boundary.readable, ...snapshots.map((d) => d.path)],
                  },
                  // Генеративный gate получает seed от этой проверки; договора
                  // поручения у неё нет — прежний уровень отчёта свойств.
                  ...(gate.property
                    ? { property: { runId: id, contracts: {}, artifacts: [] } }
                    : {}),
                });
              } catch (error) {
                // Провал gate записан (`record`); прочие ошибки — отказ проверки.
                if (!(error instanceof TaskFailure) || evidence.at(-1)?.gate !== gate.id)
                  throw error;
                failure = { gate: gate.id, message: error.message };
                return;
              }
            }
          },
        );
        if (
          (await git(cwd, 'rev-parse', 'HEAD')) !== input.sha ||
          (await git(cwd, 'status', '--porcelain', '--untracked-files=no'))
        )
          throw new Error('Проверка изменила проверяемый код');
      },
    );
  } finally {
    if (added) await git(path, 'worktree', 'remove', '--force', cwd).catch(() => undefined);
    await removeSnapshots(
      {
        repo: (rid) => ctx.policy.repositories.find((r) => r.id === rid)!,
        path: (r) => ctx.repoPath(r),
      },
      snapshots,
    );
    await rm(join(root, 'worktree'), { recursive: true, force: true }).catch(() => undefined);
  }
  return {
    id,
    sha: input.sha,
    gates: gates.map((g) => g.id),
    evidence,
    ...(failure ? { failure } : {}),
  };
}
