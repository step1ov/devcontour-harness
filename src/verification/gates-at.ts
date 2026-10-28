import { randomUUID } from 'node:crypto';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HarnessError, type EvidenceRecord, type ExecutionPolicy } from '../contracts/index.ts';
import { TaskFailure } from '../engine/failure.ts';
import { git } from '../environment/process.ts';
import { executionEnvironment, runSteps, withEnvironment } from '../environment/lifecycle.ts';
import { defaultResourceDatabase, withResources } from '../environment/resources.ts';
import { removeSnapshots, snapshotDependencies, type DependencySnapshot } from './dependencies.ts';
import { runGate, type Boundary } from './gates.ts';
import { checkoutPath, chooseCheckoutRoot } from '../environment/checkout-root.ts';
import { credentialPaths } from '../environment/isolation.ts';
import { explicitPrerequisites, orderedScope, standaloneScope } from './gate-scope.ts';

type Repo = ExecutionPolicy['repositories'][number];

/** Что нужно проверке на SHA от controller (как у эксперимента выполнимости). */
export interface GatesAtContext {
  policy: ExecutionPolicy;
  /** Каталог состояния: здесь логи, а при прежнем размещении — и рабочее дерево со снимками. */
  stateDir: string;
  /**
   * Корень рабочего дерева и снимков зависимостей проверки
   * (`<checkoutRoot>/<repositoryId>/gates-at/<id>`). Без него —
   * `chooseCheckoutRoot` по каталогу состояния и репозиториям политики.
   */
  checkoutRoot?: string;
  repoPath(repo: Repo): string;
  /** Закрытое проверке и открытое внутри него — та же граница, что у gates попыток. */
  boundary(): Boundary;
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
  /** Первый непрошедший gate и причина (то же, что `failures[0]`). */
  failure?: { gate: string; message: string };
  /**
   * Все непрошедшие gates. Провал не останавливает проверку: исполняются все
   * названные gates, кроме тех, чья предпосылка не прошла (они названы здесь
   * с этой причиной и evidence не получают).
   */
  failures: { gate: string; message: string }[];
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
  for (const gid of input.gates)
    if (!repo.gates.some((g) => g.id === gid))
      throw new HarnessError('NOT_FOUND', `Gate ${gid} не объявлен в ${repo.id}`);
  // Та же область и тот же порядок, что исполнила бы попытка с областью из
  // этих gates и их предпосылок (`standaloneScope`, `orderedScope`).
  const gates = orderedScope(repo.gates, standaloneScope(repo.gates, input.gates));
  const id = input.id ?? 'GA-' + randomUUID();
  const path = ctx.repoPath(repo);
  await git(path, 'cat-file', '-e', `${input.sha}^{commit}`).catch(() => {
    throw new HarnessError('NOT_FOUND', `Commit ${input.sha} недоступен в ${repo.id}`);
  });
  const root = join(ctx.stateDir, 'gates-at', id);
  // Рабочее дерево и снимки — под корнем вне дерева, если каталог состояния
  // лежит внутри репозитория; логи остаются в каталоге состояния.
  const placement = chooseCheckoutRoot({
    stateDirs: [ctx.stateDir],
    repositories: ctx.policy.repositories.map((r) => ctx.repoPath(r)),
    hidden: [...ctx.boundary().hidden, ...credentialPaths()],
    ...(ctx.checkoutRoot ? { configured: ctx.checkoutRoot } : {}),
  });
  const trees = checkoutPath(placement, root, repo.id, 'gates-at', id);
  const cwd = join(trees, 'worktree');
  const artifacts = join(root, 'artifacts');
  const timeout = AbortSignal.timeout(ctx.policy.runTimeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const source = ctx.environment ?? process.env;
  const evidence: EvidenceRecord[] = [];
  const failures: GatesAtResult['failures'] = [];
  const failed = new Set<string>();
  let snapshots: DependencySnapshot[] = [];
  let added = false;
  await mkdir(root, { recursive: true });
  await mkdir(dirname(cwd), { recursive: true });
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
            dir: join(trees, 'dependencies'),
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
              // Пропускается только gate, чья явная предпосылка (`dependsOn`) не
              // прошла. Провал неявной (более ранний check gate в режиме
              // порядка массива) не скрывает исход тестов: исполняются и
              // названы оба.
              const blocked = explicitPrerequisites(repo.gates, gate.id).filter((g) =>
                failed.has(g),
              );
              if (blocked.length) {
                failed.add(gate.id);
                failures.push({
                  gate: gate.id,
                  message: 'не исполнен: не прошла предпосылка ' + blocked.join(', '),
                });
                continue;
              }
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
                    // Чужие деревья под корнем вне дерева закрыты поэлементно,
                    // и тогда, когда хост его в своей границе не назвал.
                    checkouts: [
                      ...new Set([
                        ...(boundary.checkouts ?? []),
                        ...(placement.root ? [placement.root] : []),
                      ]),
                    ],
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
                failed.add(gate.id);
                failures.push({ gate: gate.id, message: error.message });
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
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    // Пустой каталог проверки вне дерева не копится; непустой (снимок, который
    // не удалось убрать) остаётся как есть.
    if (trees !== root)
      for (const dir of [join(trees, 'dependencies'), trees])
        await rmdir(dir).catch(() => undefined);
  }
  return {
    id,
    sha: input.sha,
    gates: gates.map((g) => g.id),
    evidence,
    ...(failures.length ? { failure: failures[0] } : {}),
    failures,
  };
}
