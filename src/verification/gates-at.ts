import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  HarnessError,
  stallSweepOf,
  type EnvironmentCause,
  type EvidenceRecord,
  type ExecutionPolicy,
  type RunEventPayload,
  strictSandbox,
  harnessModeOf,
} from '../contracts/index.ts';
import { livenessPayload, superviseStalls } from '../engine/stall-sweep.ts';
import { TaskFailure } from '../engine/failure.ts';
import { git } from '../environment/process.ts';
import {
  allocateAttemptPorts,
  attemptVariables,
  type AttemptPorts,
} from '../environment/attempt-ports.ts';
import {
  executionEnvironment,
  preparation,
  preparesTree,
  runSteps,
  withEnvironment,
  type StepOutcome,
} from '../environment/lifecycle.ts';
import { defaultResourceDatabase, withResources } from '../environment/resources.ts';
import { removeSnapshots, snapshotDependencies, type DependencySnapshot } from './dependencies.ts';
import { GATE_SILENT_FAILURE, reapedFailure, runGate, type Boundary } from './gates.ts';
import { checkoutPath, chooseCheckoutRoot } from '../environment/checkout-root.ts';
import {
  dependencyStoreRoot,
  materializeStore,
  seedSourcesText,
  type StoreContext,
} from './dependency-store.ts';
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
  /**
   * Явная команда оператора (`harness smoke`, `harness gates`): сборка seed,
   * недавно упавшая из-за сети реестра, повторяется сразу (alpha.64).
   */
  retryStoreNetworkFailure?: boolean;
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
  /**
   * Остановиться на первом непрошедшем gate: следующие gates не исполняются
   * и названы в `skipped`, а не в `failures`. Нет — исполняются все (провал
   * не скрывает исход остальных).
   */
  failFast?: boolean;
  /**
   * Переход живости проверки по обходу зависших (`stallSweep`), в обоих
   * режимах: при `report` — единственный путь узнать о зависании до конца
   * проверки. Нагрузка — как у события `attempt.liveness`.
   */
  onLiveness?(report: LivenessReport): void;
  /**
   * Только окружение (`harness smoke`): снимки зависимостей, рабочее дерево,
   * lifecycle `setup`/`ready`, хранилище зависимостей, `prepare` и
   * `teardown` — без gates. `gates` тогда может быть пустым: он лишь сужает
   * ресурсы, которые держит проверка (нет — ресурсы всех gates репозитория).
   */
  lifecycleOnly?: boolean;
  /**
   * Исход каждого шага окружения по мере исполнения: шаги lifecycle и
   * `prepare` (`StepOutcome` из `runSteps`), а также стадии `dependencies`,
   * `worktree` и `dependency-store` (без кода выхода).
   */
  onStep?(step: StepOutcome): void;
  /**
   * Только окружение: вызов после `prepare` в подготовленном дереве, пока
   * службы lifecycle подняты (`harness smoke --writer-probe`). Граница —
   * та же, что у gates этой проверки.
   */
  afterPrepare?(ctx: {
    cwd: string;
    boundary: { hidden: string[]; readable: string[]; checkouts: string[] };
    signal: AbortSignal;
  }): Promise<void>;
}

/** Переход живости проверки вне попытки (нагрузка `attempt.liveness`). */
export type LivenessReport = RunEventPayload<'attempt.liveness'>;

export interface GatesAtResult {
  id: string;
  sha: string;
  /** Gates проверки в порядке исполнения (с предпосылками; не исполненные при `failFast` — и в `skipped`). */
  gates: string[];
  evidence: EvidenceRecord[];
  /** Первый непрошедший gate и причина (то же, что `failures[0]`). */
  failure?: { gate: string; message: string };
  /**
   * Все непрошедшие gates. Провал не останавливает проверку: исполняются все
   * названные gates, кроме тех, чья предпосылка не прошла (они названы здесь
   * с этой причиной и evidence не получают).
   */
  failures: {
    gate: string;
    message: string;
    /** Причина отказа среды, названная gate (`TaskFailure.diagnosis`), например `sandbox-process-list`. */
    environment?: EnvironmentCause;
  }[];
  /**
   * Gates, не исполненные после первого провала (`failFast`): не провал,
   * исход неизвестен. Нет поля — исполнены все.
   */
  skipped?: string[];
  /**
   * Проверка прервана сигналом вызывающего или своим пределом времени
   * (`runTimeoutMs`): `gate` — исполнявшийся в тот момент, следующие gates не
   * исполнены и названы в `skipped`. Для совместимости `failures` по-прежнему
   * называет их все (прерванный — причиной прерывания, следующие — «не
   * исполнен: проверка прервана»): прерванная проверка никогда не выглядит
   * прошедшей. Поле различает отмену и провал. Остановка обходом зависших —
   * провал gate, без этого поля.
   */
  interrupted?: { gate?: string; reason: string };
  /** Переходы живости за проверку (`onLiveness`); нет — проверка не замолкала. */
  liveness?: LivenessReport[];
  /**
   * Предупреждения пробы портов ресурсов: порт на всех адресах держит чужой
   * процесс, loopback свободен (например, AirPlay Receiver на macOS).
   */
  warnings?: string[];
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
  // Свой обход зависших: команды вне попытки, записать живость некуда; при
  // `stop` зависание прерывает проверку, и отказ называет его.
  const stall = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, stall.signal]) : stall.signal;
  const policy = stallSweepOf(ctx.policy);
  const liveness: LivenessReport[] = [];
  try {
    const result = await superviseStalls(
      policy,
      (reason) => stall.abort(reason),
      () => gatesAt(ctx, { ...input, signal }),
      (change) => {
        const report = livenessPayload(change, policy.action);
        liveness.push(report);
        input.onLiveness?.(report);
      },
    );
    return liveness.length ? { ...result, liveness } : result;
  } catch (error) {
    if (stall.signal.aborted && !(error instanceof TaskFailure && error.kind === 'stalled'))
      throw new TaskFailure('stalled', (stall.signal.reason as Error).message);
    throw error;
  }
}

/** Причина остановки обходом зависших, если сигнал прерван им. */
const stalledBy = (signal?: AbortSignal) =>
  signal?.aborted && (signal.reason as Error | undefined)?.name === 'StalledError'
    ? (signal.reason as Error).message
    : undefined;

async function gatesAt(ctx: GatesAtContext, input: GatesAtInput): Promise<GatesAtResult> {
  const repo = ctx.policy.repositories.find((r) => r.id === input.repositoryId);
  if (!repo) throw new HarnessError('NOT_FOUND', 'Репозиторий не объявлен: ' + input.repositoryId);
  if (!input.gates.length && !input.lifecycleOnly)
    throw new HarnessError('INVALID_INPUT', 'Не названы gates проверки');
  for (const gid of input.gates)
    if (!repo.gates.some((g) => g.id === gid))
      throw new HarnessError('NOT_FOUND', `Gate ${gid} не объявлен в ${repo.id}`);
  // Та же область и тот же порядок, что исполнила бы попытка с областью из
  // этих gates и их предпосылок (`standaloneScope`, `orderedScope`).
  const scope = input.gates.length
    ? orderedScope(repo.gates, standaloneScope(repo.gates, input.gates))
    : repo.gates;
  // Только окружение: gates не исполняются, но их ресурсы проверка держит —
  // службы lifecycle поднимаются для них (порт, устройство).
  const gates = input.lifecycleOnly ? [] : scope;
  /** Замер стадии окружения без команды (снимки, дерево, хранилище). */
  const staged = async <T>(
    stage: string,
    action: () => Promise<T>,
    detail?: (result: T) => string | undefined,
    unused?: (result: T) => boolean,
  ) => {
    const started = Date.now();
    const outcome = (ok: boolean, note?: string, idle?: boolean) =>
      input.onStep?.({
        stage,
        id: stage,
        durationMs: Date.now() - started,
        ok,
        timedOut: false,
        aborted: signal.aborted,
        ...(note ? { detail: note } : {}),
        ...(idle ? { unused: true } : {}),
      });
    try {
      const result = await action();
      outcome(true, detail?.(result), unused?.(result));
      return result;
    } catch (error) {
      outcome(false);
      throw error;
    }
  };
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
  const warnings: string[] = [];
  const failed = new Set<string>();
  const skipped: string[] = [];
  let interrupted: GatesAtResult['interrupted'];
  /** Прерывание сигналом или пределом проверки, не обходом зависших. */
  const interruption = () => {
    if (!signal.aborted || stalledBy(input.signal)) return undefined;
    const reason = signal.reason as Error | undefined;
    return timeout.aborted
      ? `исчерпан предел проверки runTimeoutMs (${Math.round(ctx.policy.runTimeoutMs / 1000)} с)`
      : (reason?.message ?? 'проверка прервана');
  };
  let snapshots: DependencySnapshot[] = [];
  let added = false;
  let ports: AttemptPorts | undefined;
  const boundaryOf = ctx.boundary();
  const store: StoreContext = {
    policy: ctx.policy,
    root: (rid) => dependencyStoreRoot(placement, ctx.stateDir, rid),
    repoPath: (r) => ctx.repoPath(r),
    boundary: {
      hidden: boundaryOf.hidden,
      checkouts: [
        ...new Set([...(boundaryOf.checkouts ?? []), ...(placement.root ? [placement.root] : [])]),
      ],
    },
    resourceDatabase: ctx.resourceDatabase ?? defaultResourceDatabase(),
    deadline: Date.now() + ctx.policy.runTimeoutMs,
    phaseMs: ctx.policy.runTimeoutMs,
    ...(ctx.retryStoreNetworkFailure ? { retryNetworkFailure: true } : {}),
  };
  await mkdir(root, { recursive: true });
  await mkdir(dirname(cwd), { recursive: true });
  try {
    await withResources(
      {
        resources: ctx.policy.resources,
        leaseMs: ctx.policy.leaseMs,
        resourceDatabase: ctx.resourceDatabase ?? defaultResourceDatabase(),
      },
      [...new Set(scope.flatMap((g) => g.resources ?? []))],
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
          snapshots = await staged('dependencies', () =>
            snapshotDependencies({
              repos,
              repositoryId: repo.id,
              dir: join(trees, 'dependencies'),
              artifacts,
              runId: id,
              policy: ctx.policy,
              environment: source,
              signal,
              store,
              ...(input.onStep ? { onStep: (step: StepOutcome) => input.onStep!(step) } : {}),
            }),
          );
        await staged('worktree', () => git(path, 'worktree', 'add', '--detach', cwd, input.sha));
        added = true;
        // Облегчённый режим (alpha.69): свои порты, имя проекта compose и
        // шлюз — как у попытки, чтобы прогон не столкнулся с идущими.
        const light = harnessModeOf(ctx.policy) === 'light';
        if (light && ctx.policy.attemptEnv?.ports?.length)
          ports = await allocateAttemptPorts(
            ctx.policy.attemptEnv,
            ctx.resourceDatabase ?? defaultResourceDatabase(),
            `${ctx.stateDir}:${id}`,
            {
              exclude: ctx.policy.resources
                .filter((r) => r.kind === 'port')
                .map((r) => Number(r.value)),
            },
          );
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
            ...(light ? attemptVariables(id, ports?.ports ?? {}, repo.gateway, repo.id) : {}),
          },
          source,
          ctx.policy.toolchain,
        );
        if (input.onStep) execution.onStep = (step) => input.onStep!(step);
        const boundary = ctx.boundary();
        const prepared = preparation.guard(
          strictSandbox(ctx.policy),
          cwd,
          preparesTree(repo.lifecycle ?? ctx.policy.lifecycle, repo.prepare, repo.dependencyStore),
        );
        await withEnvironment(
          repo.lifecycle ?? ctx.policy.lifecycle,
          cwd,
          join(artifacts, 'environment'),
          execution,
          signal,
          async () => {
            if (repo.dependencyStore)
              // Промах хранилища — не отказ: установка идёт обычным путём
              // (`prepare`, gates); исход и причина видны в шаге.
              await staged(
                'dependency-store',
                () => materializeStore(store, { repo, cwd, execution, signal, dir: artifacts }),
                (r) => r && `${r.outcome}${seedSourcesText(r)}${r.reason ? ': ' + r.reason : ''}`,
                // Промах — хранилище не использовано: шаг не «пройден», как в замерах `run`.
                (r) => !r || r.outcome === 'miss',
              );
            else await materializeStore(store, { repo, cwd, execution, signal, dir: artifacts });
            await runSteps(repo.prepare, cwd, join(artifacts, 'prepare'), execution, signal);
            prepared(execution);
            if (input.lifecycleOnly && input.afterPrepare)
              await input.afterPrepare({
                cwd,
                boundary: {
                  hidden: boundary.hidden,
                  readable: [...boundary.readable, ...snapshots.map((d) => d.path)],
                  checkouts: [
                    ...new Set([
                      ...(boundary.checkouts ?? []),
                      ...(placement.root ? [placement.root] : []),
                    ]),
                  ],
                },
                signal,
              });
            let reapedBy: string | undefined;
            for (const gate of gates) {
              if (interrupted) {
                skipped.push(gate.id);
                failed.add(gate.id);
                failures.push({ gate: gate.id, message: 'не исполнен: проверка прервана' });
                continue;
              }
              if (input.failFast && failures.length) {
                skipped.push(gate.id);
                continue;
              }
              // Пропускается только gate, чья явная предпосылка (`dependsOn`) не
              // прошла. Провал неявной (более ранний check gate в режиме
              // порядка массива) не скрывает исход тестов: исполняются и
              // названы оба.
              // Потомки прежнего gate не остановлены: следующие gates в этом
              // дереве не исполняются — их evidence записывалось бы рядом с
              // живым писателем.
              if (reapedBy) {
                failed.add(gate.id);
                failures.push({
                  gate: gate.id,
                  message: `не исполнен: потомки проверки ${reapedBy} не остановлены, дерево не используется`,
                });
                continue;
              }
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
                    // Корень вне дерева закрыт (свои деревья открыты), и тогда,
                    // когда хост его в своей границе не назвал.
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
                const reason = interruption();
                if (reason) {
                  interrupted = { gate: gate.id, reason };
                  failed.add(gate.id);
                  failures.push({ gate: gate.id, message: 'прерван: ' + reason });
                  continue;
                }
                failed.add(gate.id);
                const stalled = stalledBy(input.signal);
                failures.push({
                  gate: gate.id,
                  message: stalled ?? error.message,
                  ...(!stalled && error.kind === 'environment' && error.diagnosis
                    ? { environment: error.diagnosis }
                    : {}),
                });
                if (reapedFailure(error)) reapedBy = gate.id;
              }
            }
          },
          undefined,
          (message) => warnings.push(message),
        );
        if (interrupted) return;
        // Только окружение: отмена или предел во время teardown (у него свой
        // срок) — не PASS.
        if (input.lifecycleOnly && signal.aborted) throw signal.reason;
        if (
          (await git(cwd, 'rev-parse', 'HEAD')) !== input.sha ||
          (await git(cwd, 'status', '--porcelain', '--untracked-files=no'))
        )
          throw new Error('Проверка изменила проверяемый код');
      },
    );
  } catch (error) {
    // Прерванная до gates или между ними проверка — отмена, а не отказ среды.
    // Прерванная во время gate — результат с `interrupted` (уборка окружения
    // после прерывания может отказать тем же сигналом).
    const reason = interruption();
    if (!reason) throw error;
    if (!interrupted) throw new HarnessError('CANCELLED', 'Проверка gates прервана: ' + reason);
  } finally {
    try {
      ports?.release();
    } catch {
      /* аренда умершего процесса снимется при следующем выделении */
    }
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
    ...(skipped.length ? { skipped } : {}),
    ...(interrupted ? { interrupted } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Молчал ли тот же gate на этом коммите в прогоне `harness gates --sha`
 * (alpha.69, ревью): берётся только самый поздний итог этого gate на этом
 * коммите, и только при том же определении gate (`definition`); его
 * провал с меткой молчаливого провала — основание удержания
 * `gate-definition`. Поздний успешный прогон снимает основание.
 */
export function silentGateOnSha(
  stateDir: string,
  repositoryId: string,
  sha: string,
  gateId: string,
  definition: string,
  /**
   * Какой провал ищется: по умолчанию молчаливый (по коду в итоге, как в
   * alpha.69); `git-write` — по структурной отметке `failureSummary.gitWrite`
   * (ревью 5), не по тексту.
   */
  kind: 'silent' | 'git-write' = 'silent',
): boolean {
  const root = join(stateDir, 'gates-at');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return false;
  }
  let newest:
    | {
        at: number;
        gate: {
          status?: string;
          summary?: string;
          message?: string;
          definition?: string;
          failureSummary?: { gitWrite?: boolean };
        };
      }
    | undefined;
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(root, name, 'result.json'), 'utf8')) as {
        at?: string;
        data?: {
          repositoryId?: string;
          sha?: string;
          gates?: {
            gate?: string;
            status?: string;
            summary?: string;
            message?: string;
            definition?: string;
            failureSummary?: { gitWrite?: boolean };
          }[];
        };
      };
      const d = raw.data;
      const at = Date.parse(raw.at ?? '');
      if (d?.repositoryId !== repositoryId || d.sha !== sha || Number.isNaN(at)) continue;
      const gate = d.gates?.find(
        (g) => g.gate === gateId && (g.status === 'passed' || g.status === 'failed'),
      );
      if (gate && (!newest || at > newest.at)) newest = { at, gate };
    } catch {
      /* чужой или неполный итог */
    }
  }
  const g = newest?.gate;
  return (
    !!g &&
    g.status === 'failed' &&
    g.definition === definition &&
    (kind === 'git-write'
      ? g.failureSummary?.gitWrite === true
      : [g.summary, g.message].some(
          (t) =>
            typeof t === 'string' &&
            (t.includes(GATE_SILENT_FAILURE) || t.includes('GATE_DEFINITION_NO_CAUSE')),
        ))
  );
}
