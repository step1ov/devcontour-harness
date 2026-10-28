import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  executionDigest,
  API_VERSION,
  HarnessError,
  STATE_VERSION,
  WORKSPACE_OWNER,
  contextDigest,
  contextIssues,
  digestOf,
  workGraphDigest,
  type Author,
  type ContextSnapshot,
  type ContractDocument,
  type PropertyRecovery,
  type DeliveryState,
  type ExecutionPolicy,
  type ResultEnvelope,
  type ResultSink,
  type WorkSource,
  type RuntimeAdapter,
  type RuntimeName,
  type WorkGraph,
  type WorkflowJob,
} from '../contracts/index.ts';
import { cliAdapter } from '../agents/cli-adapter.ts';
import { Engine } from '../engine/engine.ts';
import { budgetOverview } from '../engine/budget.ts';
import { runResult } from '../engine/result.ts';
import { repairDecision } from '../engine/repair.ts';
import { Runner, type RunnerHooks } from '../engine/runner.ts';
import { standaloneHost } from '../engine/standalone.ts';
import { HARNESS_VERSION } from '../package.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';
import { validateInputs } from '../validate.ts';
import { WorkflowQueue } from './workflow.ts';
import { technicalReview } from './review.ts';
import { policySourceChanged, type PolicySource } from './provenance.ts';
import { JointRunner } from '../engine/joint-runner.ts';
import { git, hostGitArgs } from '../environment/process.ts';
import { analyzeRecovery, applyCases } from './recovery.ts';
import { declarationProblems, referenceNote } from '../verification/checks.ts';
import { spikeOf, spikesOf } from '../verification/spike.ts';
import { staleArtifacts } from '../verification/confirm.ts';

export interface HarnessOptions {
  /** Каталог состояния исполнения: база, worktrees, артефакты. */
  stateDir: string;
  policy: ExecutionPolicy;
  /** Каталог, от которого разрешаются относительные пути репозиториев политики. */
  baseDir: string;
  /** Подключённые runtime; по умолчанию — CLI codex и claude из PATH. */
  adapters?: Partial<Record<RuntimeName, RuntimeAdapter>>;
  /** Читающие операции не создают каталог состояния. */
  readOnly?: boolean;
  /**
   * Открыть базу состояния только для чтения (status, events, result): процесс
   * не записывает даже метку писателя. Любая запись — отказ.
   */
  readOnlyState?: boolean;
  environment?: NodeJS.ProcessEnv;
  /**
   * Файл, из которого загружена политика. С ним процесс может записать свою
   * политику применённой, только пока файл не менялся; без него политика —
   * объект вызывающего, и право ограничено остальными условиями.
   */
  policySource?: PolicySource;
  /** База блокировок ресурсов; по умолчанию — общая для машины. */
  resourceDatabase?: string;
  /**
   * Дополнения хоста к попыткам (например, история работы внешнего
   * хранилища задач до исполнения). Приёмку не решают: отказ хука — отказ
   * попытки.
   */
  hooks?: RunnerHooks;
}

const stateFile = (dir: string) => join(dir, 'state.sqlite');

/**
 * Доменные операции harness — общие для библиотеки и CLI. Здесь нет
 * операции «передать PASS» или «принять без проверок»: приёмка возможна
 * только через движок после evidence обеих фаз.
 */
export class Harness {
  readonly engine: Engine;
  readonly runner: Runner;
  readonly store: SqliteExecutionStore;
  readonly policy: ExecutionPolicy;
  /** Техническая очередь: сохранённые стадии и ограниченное восстановление графа. */
  readonly workflows: WorkflowQueue;
  /** Совместная проверка комбинации репозиториев. */
  readonly joint: JointRunner;
  private readonly adapters: Partial<Record<RuntimeName, RuntimeAdapter>>;

  static open(options: HarnessOptions) {
    if (options.readOnly && !existsSync(stateFile(options.stateDir)))
      throw new HarnessError('NOT_FOUND', 'Каталог состояния не найден: ' + options.stateDir);
    return new Harness(options);
  }

  private constructor(readonly options: HarnessOptions) {
    this.policy = options.policy;
    if (!options.readOnly) mkdirSync(options.stateDir, { recursive: true });
    this.store = new SqliteExecutionStore(
      stateFile(options.stateDir),
      'devcontour-harness@' + HARNESS_VERSION,
      // Только чтение состояния: процесс не становится писателем (meta, PRAGMA и данные прежние).
      { readOnly: Boolean(options.readOnlyState) },
    );
    const source = options.policySource;
    this.engine = new Engine({
      host: standaloneHost(this.store, this.policy),
      policy: this.policy,
      ...(source ? { provenance: () => policySourceChanged(source) } : {}),
    });
    this.workflows = new WorkflowQueue(this.store, this.policy, () => this.engine.clock());
    this.adapters = options.adapters ?? {
      codex: cliAdapter('codex', { toolProfiles: this.policy.toolProfiles }),
      claude: cliAdapter('claude', { toolProfiles: this.policy.toolProfiles }),
    };
    this.runner = new Runner({
      engine: this.engine,
      stateDir: options.stateDir,
      baseDir: options.baseDir,
      adapters: this.adapters,
      context: (work) => this.contextOf(work.graphId),
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.resourceDatabase ? { resourceDatabase: options.resourceDatabase } : {}),
      ...(options.hooks ? { hooks: options.hooks } : {}),
    });
    this.joint = new JointRunner({
      engine: this.engine,
      stateDir: options.stateDir,
      baseDir: options.baseDir,
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.resourceDatabase ? { resourceDatabase: options.resourceDatabase } : {}),
    });
  }

  close() {
    this.store.close();
  }

  /* ---------------------------------------------------------------- */
  /* Совместная проверка и применение политики                         */
  /* ---------------------------------------------------------------- */

  /**
   * Совместная проверка набора принятых поручений на текущих target ref.
   * Возвращает итог (`passed` или `failed` с причиной); продуктовое принятие
   * комбинации решает хост.
   */
  verifyJoint(workIds: string[], options: { baseline?: string } = {}) {
    return this.joint.verify(workIds, options);
  }

  /**
   * Актуальность результата совместной проверки набора и свежесть его
   * manifest: SHA каждого репозитория сравнивается с текущим target ref.
   * Свежесть — наблюдение, а не запрет: решение о принятии — за хостом.
   */
  async jointResult(workIds: string[]) {
    const result = this.engine.jointResult(workIds);
    const manifest = result.verification?.manifest;
    if (!manifest) return result;
    const freshness = await Promise.all(
      this.policy.repositories.map(async (repo) => {
        const head = await git(this.repoPath(repo.path), 'rev-parse', repo.targetRef).catch(
          () => undefined,
        );
        return {
          repositoryId: repo.id,
          sha: manifest[repo.id]!.sha,
          ...(head ? { head } : {}),
          fresh: head === manifest[repo.id]!.sha,
        };
      }),
    );
    return { ...result, freshness };
  }

  /** Запросить применение политики с digest `policyDigest(next)`; держит новые выдачи. */
  requestReconfigure(operation: string, digest: string) {
    this.engine.operationPause(operation);
    return this.engine.requestReconfigure(operation, digest);
  }

  /** Применить запрос политикой этого процесса (после drain), см. `Engine.applyReconfigure`. */
  applyReconfigure(by = 'harness') {
    return this.engine.applyReconfigure(by);
  }

  policyState() {
    return this.engine.policyState();
  }

  /**
   * Довести незавершённую очистку закончившейся попытки: повторить teardown по
   * сохранённым receipt окружений и убрать её рабочие деревья и снимки.
   */
  cleanup(runId: string) {
    return this.runner.finishCleanup(runId);
  }

  private repoPath(path: string) {
    return isAbsolute(path) ? path : resolve(this.options.baseDir, path);
  }

  /* ---------------------------------------------------------------- */
  /* Ревью плана и контракта                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Снимок контекста для ревью плана: без нужного графу источника — отказ
   * `NOT_READY`, нарушения снимка (digest, размер) — `INVALID_INPUT`.
   * Поручения без контекста — снимок не нужен.
   */
  private planContext(graph: WorkGraph, context?: ContextSnapshot) {
    const needed = [...new Set(graph.orders.flatMap((o) => o.context))];
    if (!context) {
      if (needed.length)
        throw new HarnessError(
          'NOT_READY',
          'Поручения требуют контекст, снимок не передан: ' + needed.join(', '),
        );
      return undefined;
    }
    const issues = contextIssues(context);
    if (issues.length)
      throw new HarnessError('INVALID_INPUT', 'Снимок контекста: ' + issues.join('; '));
    const absent = needed.filter((id) => !context.sources.some((s) => s.id === id));
    if (absent.length)
      throw new HarnessError('NOT_READY', 'В снимке нет нужного контекста: ' + absent.join(', '));
    return context;
  }

  /**
   * Раунд технического ревью предмета (граф или контракт) с конкретным
   * digest. Тот же digest и автор, уже согласованные последним раундом, —
   * тот же раунд без вызова модели. Reviewer — по правилу вендора политики;
   * недопустимый автор — `REVIEWER_SAME_VENDOR` до вызова. Reviewer называет
   * состояние каждой прежней открытой находки; история не переписывается.
   */
  async review(
    input:
      | { kind: 'plan'; graph: WorkGraph; context?: ContextSnapshot; author: Author }
      | { kind: 'contract'; contract: ContractDocument; author: Author },
  ) {
    const subject = input.kind === 'plan' ? input.graph.id : input.contract.id;
    const digest = input.kind === 'plan' ? workGraphDigest(input.graph) : digestOf(input.contract);
    // Структурные пропуски договора проверки и незакреплённые файлы — отказ до
    // вызова модели: reviewer оценивает достаточность, а не наличие полей.
    if (input.kind === 'contract') await this.assertContract(input.contract);
    // Закреплённый контекст плана: проверенный снимок с каждым нужным
    // источником, иначе — отказ до вызова; его digest — часть основания раунда.
    const context =
      input.kind === 'plan' ? this.planContext(input.graph, input.context) : undefined;
    const repo = this.policy.repositories[0]!;
    // Номер следующего раунда — от последнего записанного, а не от числа записей:
    // раунды хоста до harness сдвигают нумерацию, и каталог по числу записей
    // совпал бы с каталогом прежнего раунда.
    const round = (this.engine.reviews(input.kind, subject).at(-1)?.round ?? 0) + 1;
    return technicalReview(this.engine, this.policy, this.adapters, {
      kind: input.kind,
      subject,
      digest,
      author: input.author,
      instructions: [
        input.kind === 'plan'
          ? 'You independently review a plan: a graph of executable work orders. Check that each order is complete, testable, scoped and that dependencies are right. Do not edit files.'
          : 'You independently review a contract document. Check that every obligation is feasible and measurable. Do not edit files.',
        JSON.stringify(input.kind === 'plan' ? input.graph : input.contract, null, 2),
        input.kind === 'contract' ? this.spikeNote(input.contract) : '',
        input.kind === 'contract' ? referenceNote(input.contract.checks) : '',
      ],
      ...(context ? { context } : {}),
      ...(input.kind === 'contract' ? { contract: input.contract } : {}),
      repositoryId: repo.id,
      cwd: this.repoPath(repo.path),
      artifactDir: join(this.options.stateDir, 'reviews', `${input.kind}-${subject}-${round}`),
      denied: [this.options.stateDir],
      // Вызов под учётом: о графе — расход группы и её поручений, о контракте — общий.
      meta: {
        subjectId: subject,
        subjectKind: input.kind === 'plan' ? 'group' : 'other',
        // Расход ревью плана закрепляется за графом и его поручениями из входа:
        // граф может быть ещё не зарегистрирован, а состав — измениться позже.
        ...(input.kind === 'plan'
          ? { group: { id: subject, workIds: input.graph.orders.map((o) => o.id) } }
          : {}),
      },
      maxRounds: this.policy.maxAttempts * 2,
      ...(this.options.environment ? { environment: this.options.environment } : {}),
    });
  }

  /**
   * Эксперименты, на которые ссылаются тяжёлые обязательства: reviewer читает
   * фактический результат, а не пересказ автора.
   */
  private spikeNote(contract: ContractDocument) {
    const ids = new Set(contract.checks?.obligations.flatMap((o) => o.feasibility?.spike ?? []));
    if (!ids.size) return '';
    const repositoryId = contract.repositoryId ?? this.policy.repositories[0]!.id;
    const spikes = this.engine.read((v) => spikesOf(v, repositoryId)).filter((x) => ids.has(x.id));
    return (
      'Feasibility spikes referenced by hard obligations (pinned by digest). For obligations marked hard, read the spike: a timeout is inconclusive for that method and budget — it neither proves hardness or impossibility nor allows weakening the obligation; success on a sample does not prove a bound for every input. Spikes: ' +
      JSON.stringify(spikes)
    );
  }

  private async assertContract(contract: ContractDocument) {
    const repo =
      this.policy.repositories.find((r) => r.id === (contract.repositoryId ?? '')) ??
      (contract.repositoryId ? undefined : this.policy.repositories[0]);
    if (!repo)
      throw new HarnessError('INVALID_INPUT', 'Репозиторий не объявлен: ' + contract.repositoryId);
    const problems = contract.checks
      ? declarationProblems(contract.checks, {
          gates: repo.gates,
          repositoryId: repo.id,
          artifacts: (contract.artifacts ?? []).map((a) => a.path),
          // Ссылка тяжёлого обязательства закрепляет digest эксперимента этого репозитория.
          spike: (id) => this.engine.read((v) => spikeOf(v, repo.id, id)),
        })
      : [];
    const stale = await staleArtifacts(
      this.repoPath(repo.path),
      repo.targetRef,
      contract.artifacts ?? [],
    );
    if (stale.length)
      problems.push(
        'закреплённые файлы не совпадают с целевой веткой ' +
          repo.targetRef +
          ': ' +
          stale.join(', '),
      );
    if (problems.length)
      throw new HarnessError('INVALID_INPUT', 'Договор проверки неполон: ' + problems.join('; '));
  }

  /* ---------------------------------------------------------------- */
  /* Корпус подтверждённых случаев                                     */
  /* ---------------------------------------------------------------- */

  /** Корпус: принятые версии, решения, отложенные принятия. */
  get corpus() {
    return this.runner.corpus;
  }
  /**
   * Ограниченный эксперимент выполнимости до реализации тяжёлого обязательства.
   * Таймаут — `inconclusive`: не доказательство невыполнимости и не основание
   * ослаблять обязательство.
   */
  spike(input: unknown) {
    return this.runner.spike(input);
  }
  /** Эксперименты выполнимости репозитория (по умолчанию — всех). */
  spikes(repositoryId?: string) {
    return this.engine.read((v) => spikesOf(v, repositoryId));
  }
  /** Подтвердить пример закреплённым эталоном; подтверждённый — новая версия корпуса. */
  submitCase(input: unknown) {
    return this.runner.submitCase(input);
  }
  /** Ручное техническое подтверждение принятия версии корпуса (operator mode). */
  approveAdoption(suiteId: string, pendingId: string) {
    return this.corpus.approveAdoption(suiteId, pendingId);
  }
  /** Решение эпизода по свойству человеком: CAS по версии записи. */
  decideRecovery(
    workId: string,
    recoveryId: string,
    decision: Omit<NonNullable<PropertyRecovery['decision']>, 'source' | 'decidedAt'>,
    version: number,
  ) {
    return this.engine.recoveryDecide(
      workId,
      recoveryId,
      { ...decision, source: { kind: 'operator' }, decidedAt: new Date().toISOString() },
      version,
    );
  }

  /** Согласование оператором (approvalMode: operator) графа, digest которого прошёл ревью. */
  approve(subject: string, digest: string) {
    const graph = this.engine.read((v) => v.graph(subject));
    if (!graph) throw new HarnessError('NOT_FOUND', 'Граф не найден: ' + subject);
    if (graph.digest !== digest)
      throw new HarnessError('APPROVAL_STALE', 'Digest не совпадает с зарегистрированным графом');
    const before = graph.approval?.digest === digest;
    this.engine.approve(subject, 'operator', { bindContext: true });
    const at = this.engine.read((v) => v.graph(subject)!.approval!.at);
    return { subject, digest, at, changed: !before };
  }

  /* ---------------------------------------------------------------- */
  /* Работа                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Действующий контекст графа — снимок, связанный с его согласованием, а не
   * последний переданный: отклонённый или ещё не согласованный снимок не
   * исполняется.
   */
  private contextOf(graphId: string): ContextSnapshot | undefined {
    const digest = this.engine.read((v) => v.graph(graphId)?.approval?.context?.digest);
    if (!digest) return undefined;
    return this.engine.read((v) => v.local('context-snapshots', WORKSPACE_OWNER, digest));
  }

  /**
   * Зарегистрировать граф (идемпотентно по редакции), в режиме `agent`
   * провести ревью плана, если его нет, согласовать и вести очередь до
   * простоя. Результаты доставляются получателю с идемпотентным ключом.
   */
  async run(input: {
    graph: WorkGraph;
    context?: ContextSnapshot;
    author: Author;
    sink?: ResultSink;
    once?: boolean;
    /**
     * Источник, из которого прочитан граф. Его решение `trusts` — единственное
     * основание принять внешнюю предпосылку с receipt `trusted`; доступность
     * result SHA в target ref проверяется в любом случае. Без источника
     * доверенных receipt нет.
     */
    source?: WorkSource;
  }) {
    // Обязательный контекст — одинаково для библиотеки и CLI: без снимка нужных источников граф не исполняется.
    const needed = [...new Set(input.graph.orders.flatMap((o) => o.context))];
    if (needed.length && !input.context)
      throw new HarnessError(
        'NOT_READY',
        'Поручения требуют контекст, снимок не передан: ' + needed.join(', '),
      );
    validateInputs({
      graph: input.graph,
      policy: this.policy,
      ...(input.context ? { context: input.context } : {}),
    });
    const repos = new Map(this.policy.repositories.map((r) => [r.id, r]));
    if (input.source && input.source.id !== input.graph.source.connector)
      throw new HarnessError(
        'INVALID_INPUT',
        `Граф из источника ${input.graph.source.connector}, передан источник ${input.source.id}`,
      );
    // Решения источника собираются до транзакции регистрации: порт асинхронный.
    const trusted = new Set<string>();
    for (const p of input.graph.prerequisites)
      if (p.receipt.kind === 'trusted' && input.source && (await input.source.trusts(p)))
        trusted.add(p.id);
    // Атрибуция прежних записей вызовов закрепляется до смены состава графа.
    this.engine.pinLegacyCalls();
    const registered = this.engine.register(input.graph, {
      trusted: (p) => trusted.has(p.id),
      reachable: (p) => {
        const repo = repos.get(p.repositoryId);
        if (!repo) return false;
        try {
          // Синхронная проверка: предпосылка доступна в целевой ветке.
          execFileSync(
            'git',
            hostGitArgs(this.repoPath(repo.path), [
              'merge-base',
              '--is-ancestor',
              p.resultSha,
              repo.targetRef,
            ]),
            {
              cwd: this.repoPath(repo.path),
              stdio: 'ignore',
            },
          );
          return true;
        } catch {
          return false;
        }
      },
    });
    const graph = registered.graph;
    if (input.context) {
      const issues = contextIssues(input.context);
      if (issues.length)
        throw new HarnessError('INVALID_INPUT', 'Снимок контекста: ' + issues.join('; '));
    }
    // Согласование связано с контекстом, который видел reviewer плана: снимок
    // хранится по digest, но действующим становится только вместе с
    // согласованием. Другой снимок при том же графе требует нового раунда.
    const contextKey = input.context ? contextDigest(input.context) : null;
    const contextChanged = (graph.approval?.context?.digest ?? null) !== contextKey;
    if (
      !graph.approval ||
      graph.approval.digest !== graph.digest ||
      graph.policyDigest !== executionDigest(this.policy) ||
      contextChanged
    ) {
      if (this.policy.approvalMode === 'agent') {
        const record = await this.review({
          kind: 'plan',
          graph: input.graph,
          author: input.author,
          ...(input.context ? { context: input.context } : {}),
        });
        if (!record.approved)
          throw new HarnessError(
            'REVIEW_REJECTED',
            'Ревью плана не одобрило граф: ' + record.summary,
          );
        this.engine.approve(graph.id, 'agent', { bindContext: true });
      } else if (!this.engine.read((v) => v.graph(graph.id)?.approval) || contextChanged)
        throw new HarnessError(
          'APPROVAL_REQUIRED',
          'approvalMode: operator — выполните review-plan и approve' +
            (contextChanged ? ' (контекст изменился после ревью плана)' : ''),
        );
    }
    await this.runner.init();
    // Разрешение начать работу снимает только паузу «очередь ещё не запускали»
    // (без причины) и штатную остановку: это не решения о работе. Пауза
    // человека, отказа runtime, применения политики и проверки базы остаётся
    // до явного продолжения.
    if (
      this.engine.read(
        (v) =>
          v.control().paused &&
          (!v.control().pauseReason || v.control().pauseReason === 'shutdown'),
      )
    )
      this.engine.resume();
    // В режиме agent работа над графом — задание технической очереди: его
    // стадия сохраняется, а упавшие поручения чинятся в пределах бюджета.
    // Оператор решает сам: автоматических повторов нет.
    const job =
      this.policy.approvalMode === 'agent' &&
      !input.once &&
      (input.author === 'codex' || input.author === 'claude')
        ? this.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: input.author })
        : undefined;
    try {
      if (input.once) await this.runner.step();
      else if (job) await this.advance(job.key, graph.id);
      else await this.runner.drain();
    } finally {
      this.runner.release();
    }
    if (input.sink) await this.deliverAll(graph.id, input.sink);
    return {
      graphId: graph.id,
      digest: graph.digest,
      resumed: registered.resumed,
      ...(job ? { workflow: this.workflows.view(job.key) } : {}),
      works: this.engine.read((v) =>
        v.works(graph.id).map((w) => ({
          id: w.id,
          status: w.status,
          ...(w.activeRunId ? { runId: w.activeRunId } : {}),
          ...(w.resultSha ? { resultSha: w.resultSha } : {}),
          blockers: this.engine.blockers(w, v),
        })),
      ),
    };
  }

  /**
   * Вести задание графа: стадия согласования уже пройдена синхронно; стадия
   * исполнения — очередь до простоя, затем решение о восстановлении по
   * записанному состоянию. Повтор назначается и списывается одной
   * транзакцией; остановка записывает причину в задание.
   */
  private async advance(key: string, graphId: string) {
    for (;;) {
      await this.runner.drain();
      const job = this.workflows.claim(key);
      if (!job) return;
      const timer = setInterval(
        () => {
          try {
            this.workflows.heartbeat(job);
          } catch {
            /* Утраченное владение заданием проверит следующая запись. */
          }
        },
        Math.max(1000, this.policy.leaseMs / 3),
      );
      try {
        if (job.stage === 0) {
          this.workflows.finish(job);
          continue;
        }
        if ((await this.recoverProperties(job, graphId)) || this.repair(job, graphId)) {
          this.workflows.finish(job, true);
          continue;
        }
        const done = this.engine.read((v) => v.works(graphId).every((w) => w.status === 'done'));
        this.workflows.finish(job, !done);
        return;
      } catch (error) {
        this.workflows.fail(job, error instanceof Error ? error.message : String(error));
        return;
      } finally {
        clearInterval(timer);
      }
    }
  }

  /**
   * Эпизоды повторяющихся отказов по свойству. Возвращает true, когда
   * разрешённое действие назначено и его результата нужно дождаться;
   * останавливается с причиной там, где автоматического действия нет.
   * Бюджет восстановлений и разбор эпизода учитываются одной транзакцией до
   * вызова модели: рестарт и повтор бесплатного вызова не получают.
   */
  private async recoverProperties(job: WorkflowJob, graphId: string) {
    const works = this.engine.read((v) =>
      v.works(graphId).filter((w) => w.recovery && w.status !== 'cancelled'),
    );
    for (const work of works) {
      const r = work.recovery!;
      switch (r.status) {
        case 'awaiting-lead': {
          // Пауза человека, наступившая после старта работы, — его решение:
          // разбор её не обходит.
          const control = this.engine.read((v) => v.control());
          if (control.paused && control.pauseReason === 'operator')
            throw new Error(
              `${work.id}: разбор свойства ${r.property} ждёт снятия паузы человеком`,
            );
          if ((job.repairs ?? 0) >= this.policy.repairBudget)
            throw new Error(
              `${work.id}: исчерпан бюджет восстановлений; разбор свойства ${r.property} — решение человека`,
            );
          const reserved = this.workflows.repair(job, `recovery:${r.property}`, () =>
            this.engine.recoveryReserve(work.id, r.id),
          );
          if (reserved.status !== 'analyzing') throw new Error(`${work.id}: ${reserved.reason}`);
          let decision;
          try {
            decision = await analyzeRecovery(
              {
                engine: this.engine,
                policy: this.policy,
                adapters: this.adapters,
                stateDir: this.options.stateDir,
                cwd: this.repoPath(
                  this.policy.repositories.find((x) => x.id === work.order.repositoryId)!.path,
                ),
                ...(this.options.environment ? { environment: this.options.environment } : {}),
              },
              this.engine.read((v) => v.work(work.id)!),
              job.authorRuntime,
              AbortSignal.timeout(this.policy.runTimeoutMs + 5000),
            );
          } catch (error) {
            this.engine.recoveryInterrupted(
              work.id,
              r.id,
              'Разбор ведущего не дал решения: ' +
                (error instanceof Error ? error.message : String(error)),
            );
            throw error;
          }
          this.workflows.guard(job);
          const decided = this.engine.recoveryDecide(work.id, r.id, decision);
          if (decided.status === 'applying') await this.applyRecovery(work.id);
          return this.afterDecision(work.id);
        }
        case 'analyzing':
          // Разбор оборвался без решения (рестарт): вызов уже учтён.
          this.engine.recoveryInterrupted(
            work.id,
            r.id,
            'Разбор ведущего прерван до решения; повторный автоматический вызов не выполняется.',
          );
          throw new Error(`${work.id}: разбор прерван до решения; нужен ведущий или человек`);
        case 'applying':
          // Добавление случаев идемпотентно по ключам эпизода.
          await this.applyRecovery(work.id);
          return this.afterDecision(work.id);
        case 'retry':
        case 'retrying':
          return this.afterDecision(work.id);
        default:
          throw new Error(
            `${work.id}: ${r.reason ?? 'разбор свойства ' + r.property + ' ждёт решения'}`,
          );
      }
    }
    return false;
  }
  private async applyRecovery(workId: string) {
    const work = this.engine.read((v) => v.work(workId)!);
    try {
      this.engine.recoveryApplied(workId, work.recovery!.id, await applyCases(this.runner, work));
    } catch (error) {
      this.engine.recoveryInterrupted(
        workId,
        work.recovery!.id,
        'Добавление случаев не завершилось: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      throw error;
    }
  }
  private afterDecision(workId: string) {
    const work = this.engine.read((v) => v.work(workId)!);
    const r = work.recovery;
    if (!r) return false;
    if (r.status === 'retry' && ['failed', 'cancelled'].includes(work.status)) {
      if (work.status === 'cancelled') throw new Error(`${workId}: поручение отменено человеком`);
      this.engine.retry(workId);
      return true;
    }
    if (r.status === 'retry' || r.status === 'retrying') return true;
    throw new Error(`${workId}: ${r.reason ?? r.status}`);
  }

  /**
   * Восстановление упавшего поручения группы. Решение и его исполнение — одна
   * транзакция: между чтением и записью никто не успеет отменить поручение.
   * Возвращает true, когда повтор назначен; остановка — исключение с причиной.
   */
  private repair(job: WorkflowJob, graphId: string) {
    const decision = this.store.transact('task.retry', (tx) => {
      const decided = repairDecision(tx, tx.works(graphId), {
        budgetLeft: this.policy.repairBudget - (job.repairs ?? 0),
        maxAttempts: this.policy.maxAttempts,
      });
      if (!decided || decided.action === 'stop') return decided;
      this.workflows.repair(job, `repair:${decided.kind}`, () => {
        this.engine.retry(decided.workId);
        // Повтор признал причину разовой: своя причина паузы снимается. Выдача
        // возвращается, только когда не осталось ни одной; пауза человека
        // не снимается вовсе.
        if (decided.blocksQueue) this.engine.clearFailure([decided.kind]);
      });
      return decided;
    });
    if (!decision) return false;
    if (decision.action === 'stop') throw new Error(decision.reason);
    return true;
  }

  status(graphId?: string) {
    return this.engine.read((v) => ({
      stateVersion: STATE_VERSION,
      control: v.control(),
      ...(v.controller() ? { controller: v.controller() } : {}),
      graphs: v
        .graphs()
        .filter((g) => !graphId || g.id === graphId)
        .map((g) => ({
          id: g.id,
          digest: g.digest,
          source: g.graph.source,
          approved: g.approval?.digest === g.digest,
        })),
      works: v.works(graphId).map((w) => ({
        id: w.id,
        graphId: w.graphId,
        status: w.status,
        attempt: w.attempt,
        ...(w.activeRunId ? { activeRunId: w.activeRunId } : {}),
        ...(w.resultSha ? { resultSha: w.resultSha } : {}),
        blockers: this.engine.blockers(w, v),
      })),
      ...((budgets) => (budgets ? { budgets } : {}))(
        budgetOverview(this.engine.budgetContext(), v),
      ),
    }));
  }

  events(after = 0, limit = 100) {
    const events = this.store.events(after, Math.min(Math.max(limit, 1), 500));
    return { events, next: events.at(-1)?.seq ?? after };
  }

  /** Результат завершённой попытки поручения (последней или `runId`) и состояние его доставки. */
  result(workId: string, runId?: string): ResultEnvelope {
    return this.engine.read((v) => {
      const work = v.work(workId);
      if (!work) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + workId);
      const attempt = v
        .attempts(workId)
        .filter((a) => a.status !== 'active' && (!runId || a.id === runId))
        .at(-1);
      if (!attempt)
        throw new HarnessError('NOT_FOUND', 'У поручения нет завершённой попытки: ' + workId);
      return {
        apiVersion: API_VERSION,
        result: runResult(attempt, HARNESS_VERSION),
        delivery: v
          .locals('delivery', WORKSPACE_OWNER)
          .map((d) => d.value)
          .filter((d) => d.key.endsWith(':' + attempt.id)),
      };
    });
  }

  /**
   * Доставка результата поручения получателю. Ключ — получатель, поручение и
   * попытка: повтор не создаёт второй записи и не вызывает моделей или
   * интеграции. Конфликт редакции записывается, результат её не закрывает.
   */
  async deliver(workId: string, sink: ResultSink) {
    const envelope = this.result(workId);
    const key = `${sink.id}:${workId}:${envelope.result.runId}`;
    const prior = this.engine.read((v) => v.local('delivery', WORKSPACE_OWNER, key));
    if (prior?.status === 'delivered') return this.result(workId);
    const base: DeliveryState = prior ?? {
      sink: sink.id,
      key,
      revision: envelope.result.source.revision,
      status: 'pending',
      attempts: 0,
      updatedAt: new Date().toISOString(),
    };
    const save = (
      state: DeliveryState,
      type:
        | 'delivery.pending'
        | 'delivery.delivered'
        | 'delivery.failed'
        | 'delivery.conflict'
        | 'delivery.uncertain',
    ) =>
      this.store.transact('delivery.recorded', (tx) => {
        // Подтверждённую доставку не перезаписывает поздний итог другого
        // процесса (например, отказ «владелец занят» при параллельной доставке).
        if (
          state.status !== 'delivered' &&
          tx.local('delivery', WORKSPACE_OWNER, key)?.status === 'delivered'
        )
          return;
        tx.putLocal('delivery', WORKSPACE_OWNER, key, state);
        const payload = {
          sink: state.sink,
          key,
          revision: state.revision,
          attempts: state.attempts,
        };
        if (type === 'delivery.delivered')
          tx.emit({
            type,
            workId,
            payload: { ...payload, ...(state.receipt ? { receipt: state.receipt } : {}) },
          });
        else if (type === 'delivery.failed')
          tx.emit({ type, workId, payload: { ...payload, error: state.lastError ?? 'ошибка' } });
        else if (type === 'delivery.uncertain')
          tx.emit({
            type,
            workId,
            payload: {
              ...payload,
              operation: state.operation ?? 'unknown',
              reason: state.lastError ?? 'исход не доказан',
            },
          });
        else if (type === 'delivery.conflict')
          tx.emit({
            type,
            workId,
            payload: { ...payload, currentRevision: state.currentRevision ?? '?' },
          });
        else tx.emit({ type, workId, payload });
      });
    if (!prior) save(base, 'delivery.pending');
    const attempt = { ...base, attempts: base.attempts + 1, updatedAt: new Date().toISOString() };
    try {
      const outcome = await sink.deliver({ key, result: envelope.result });
      if (outcome.status === 'delivered')
        save(
          {
            ...attempt,
            status: 'delivered',
            ...(outcome.receipt ? { receipt: outcome.receipt.slice(0, 1000) } : {}),
          },
          'delivery.delivered',
        );
      else if (outcome.status === 'uncertain')
        // Неизвестный исход — не успех и не отказ: повтор не посылает мутацию
        // до явного разбора получателем (reconcile).
        save(
          {
            ...attempt,
            status: 'uncertain',
            operation: outcome.operation.slice(0, 300),
            lastError: ('Исход не доказан: ' + outcome.reason).slice(0, 4000),
          },
          'delivery.uncertain',
        );
      else
        save(
          {
            ...attempt,
            status: 'conflict',
            currentRevision: outcome.currentRevision.slice(0, 200),
          },
          'delivery.conflict',
        );
    } catch (error) {
      save(
        {
          ...attempt,
          status: 'failed',
          lastError: String(error instanceof Error ? error.message : error).slice(0, 4000),
        },
        'delivery.failed',
      );
    }
    return this.result(workId);
  }

  private async deliverAll(graphId: string, sink: ResultSink) {
    const ids = this.engine.read((v) =>
      v
        .works(graphId)
        .filter((w) => v.attempts(w.id).some((a) => a.status !== 'active'))
        .map((w) => w.id),
    );
    for (const id of ids) await this.deliver(id, sink);
  }
}
