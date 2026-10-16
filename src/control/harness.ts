import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  API_VERSION,
  HarnessError,
  STATE_VERSION,
  WORKSPACE_OWNER,
  contextDigest,
  contextIssues,
  digestOf,
  findingId,
  reviewIssues,
  reviewResultSchema,
  selectReviewer,
  workGraphDigest,
  type Author,
  type ContextSnapshot,
  type ContractDocument,
  type PropertyRecovery,
  type DeliveryState,
  type ExecutionPolicy,
  type ResultEnvelope,
  type ResultSink,
  type ReviewRecord,
  type RuntimeAdapter,
  type RuntimeName,
  type WorkGraph,
  type WorkflowJob,
} from '../contracts/index.ts';
import { cliAdapter } from '../agents/cli-adapter.ts';
import { reviewOutputSchema } from '../agents/schemas.ts';
import { executionEnvironment } from '../environment/lifecycle.ts';
import { redactDeep } from '../environment/redaction.ts';
import { Engine } from '../engine/engine.ts';
import { measuredInvoke } from '../engine/measured.ts';
import { budgetOverview } from '../engine/budget.ts';
import { TaskFailure } from '../engine/failure.ts';
import { runResult } from '../engine/result.ts';
import { repairDecision } from '../engine/repair.ts';
import { Runner } from '../engine/runner.ts';
import { standaloneHost } from '../engine/standalone.ts';
import { HARNESS_VERSION } from '../package.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';
import { validateInputs } from '../validate.ts';
import { WorkflowQueue } from './workflow.ts';
import { analyzeRecovery, applyCases } from './recovery.ts';
import { declarationProblems } from '../verification/checks.ts';
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
  environment?: NodeJS.ProcessEnv;
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
    );
    this.engine = new Engine({
      host: standaloneHost(this.store, this.policy),
      policy: this.policy,
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
    });
  }

  close() {
    this.store.close();
  }

  private repoPath(path: string) {
    return isAbsolute(path) ? path : resolve(this.options.baseDir, path);
  }

  /* ---------------------------------------------------------------- */
  /* Ревью плана и контракта                                           */
  /* ---------------------------------------------------------------- */

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
    const rounds = this.engine.reviews(input.kind, subject);
    const last = rounds.at(-1);
    // Назначение reviewer по текущей политике: прежний раунд подтверждает предмет
    // только при том же назначении; недопустимый автор — отказ до вызова.
    const choice = selectReviewer(this.policy, input.kind, { runtime: input.author });
    if (!choice.ok) throw new HarnessError(choice.code, choice.message);
    const binding = this.engine.reviewerBinding(input.kind, input.author)!;
    if (
      last &&
      last.digest === digest &&
      last.authorRuntime === input.author &&
      last.approved &&
      last.reviewerBinding === binding
    )
      return last;
    if (rounds.length >= this.policy.maxAttempts * 2)
      throw new HarnessError(
        'ATTEMPTS_EXHAUSTED',
        `Исчерпаны раунды ревью ${input.kind} ${subject}`,
      );
    const adapter = this.adapters[choice.reviewer.runtime];
    if (!adapter)
      throw new HarnessError(
        'RUNTIME_UNAVAILABLE',
        'Runtime не подключён: ' + choice.reviewer.runtime,
      );
    const open = (last?.findings ?? []).filter((f) => f.status === 'open');
    const round = rounds.length + 1;
    const dir = join(this.options.stateDir, 'reviews', `${input.kind}-${subject}-${round}`);
    await mkdir(dir, { recursive: true });
    const repo = this.policy.repositories[0]!;
    const cwd = this.repoPath(repo.path);
    // Окружение reviewer — с профилем инструментов его назначения; недостающий секрет — отказ до вызова.
    const tools = choice.reviewer.toolProfile
      ? this.policy.toolProfiles[choice.reviewer.toolProfile]
      : undefined;
    let execution: ReturnType<typeof executionEnvironment>;
    try {
      execution = executionEnvironment(
        [this.policy.environment, repo.environment, tools?.environment],
        {},
        this.options.environment ?? process.env,
      );
    } catch (error) {
      throw new HarnessError(
        'RUNTIME_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      );
    }
    const prompt = [
      input.kind === 'plan'
        ? 'You independently review a plan: a graph of executable work orders. Check that each order is complete, testable, scoped and that dependencies are right. Do not edit files.'
        : 'You independently review a contract document. Check that every obligation is feasible and measurable. Do not edit files.',
      `Subject: ${input.kind} ${subject}, digest ${digest}, round ${round}. Author: ${input.author}.`,
      JSON.stringify(input.kind === 'plan' ? input.graph : input.contract, null, 2),
      open.length
        ? 'Previous open findings. For each, report its state in `previous` (closed, open or withdrawn) with a concrete basis: ' +
          JSON.stringify(open.map((f) => ({ id: f.id, severity: f.severity, message: f.message })))
        : '',
      'Report execution.commands or an empty list with execution.noCommandsReason. Findings need a message; use null where a field does not apply.',
    ]
      .filter(Boolean)
      .join('\n\n');
    // Вызов под учётом: о графе — расход группы и её поручений, о контракте — общий.
    const response = await measuredInvoke(
      this.engine,
      adapter,
      {
        callId: randomUUID(),
        task: input.kind === 'plan' ? 'review-plan' : 'review-contract',
        binding: choice.reviewer,
        cwd,
        prompt,
        outputSchema: reviewOutputSchema,
        session: { kind: 'fresh' },
        sandbox: {
          mode: this.policy.isolation.mode,
          writable: [],
          denied: [this.options.stateDir],
          readable: [cwd],
          network: { domains: this.policy.isolation.domains },
        },
        timeoutMs: this.policy.runTimeoutMs,
        env: Object.fromEntries(
          Object.entries(execution.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        artifactDir: dir,
        secrets: [...(execution.redact.secrets ?? [])],
      },
      AbortSignal.timeout(this.policy.runTimeoutMs + 5000),
      { subjectId: subject, stage: input.kind + '-review' },
    ).catch((error: unknown) => {
      if (error instanceof TaskFailure && error.kind === 'budget')
        throw new HarnessError('BUDGET_EXHAUSTED', error.message);
      throw error;
    });
    if (response.status !== 'ok')
      throw new HarnessError(
        'RUNTIME_UNAVAILABLE',
        `Ревью ${input.kind}: ${response.status}${response.diagnostics.reason ? ': ' + response.diagnostics.reason : ''}`,
      );
    const parsed = reviewResultSchema.safeParse(response.output);
    const issues = parsed.success ? reviewIssues(parsed.data, open) : ['Ответ ревью вне схемы'];
    const at = new Date().toISOString();
    const transitions = new Map((parsed.success ? parsed.data.previous : []).map((t) => [t.id, t]));
    const findings: ReviewRecord['findings'] = [
      ...(last?.findings ?? []).map((f) => {
        const t = transitions.get(f.id);
        return f.status === 'open' && t
          ? { ...f, status: t.status, changedIn: round, basis: t.basis.slice(0, 4000) }
          : f;
      }),
      ...(parsed.success ? parsed.data.findings : [])
        .map((f) => ({ ...f, id: findingId(subject, f) }))
        .filter((f) => !(last?.findings ?? []).some((p) => p.id === f.id))
        .map((f) => ({
          id: f.id,
          severity: f.severity,
          message: execution.redact(f.message).slice(0, 12000),
          ...(f.rule ? { rule: f.rule.slice(0, 200) } : {}),
          path: f.path ?? null,
          line: f.line ?? null,
          status: 'open' as const,
          openedIn: round,
          changedIn: round,
        })),
    ];
    const record: ReviewRecord = {
      id: `RV-${input.kind}-${subject}-${round}`,
      kind: input.kind,
      subject,
      digest,
      round,
      at,
      approved: parsed.success && parsed.data.approved && !issues.length,
      summary:
        execution
          .redact(parsed.success ? parsed.data.summary : 'Ответ ревью вне схемы')
          .slice(0, 12000) + (issues.length ? ' / ' + issues.join('; ') : ''),
      authorRuntime: input.author,
      reviewerRuntime: choice.reviewer.runtime,
      ...(response.model ? { reviewerModel: response.model } : {}),
      sameVendor: choice.sameVendor,
      reviewerBinding: binding,
      findings,
      artifact: join(dir, 'review.json'),
    };
    // Сохраняемые представления маскируются полным окружением вызова: сырой
    // структурированный ответ адаптера может нести значение секрета профиля.
    await writeFile(
      record.artifact,
      JSON.stringify(
        redactDeep({ response: parsed.success ? parsed.data : null, issues }, execution.redact),
        null,
        2,
      ),
    );
    return this.engine.recordReview(
      redactDeep(record, execution.redact),
      input.kind === 'contract' ? input.contract : undefined,
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
    this.engine.approve(subject, 'operator');
    const at = this.engine.read((v) => v.graph(subject)!.approval!.at);
    return { subject, digest, at, changed: !before };
  }

  /* ---------------------------------------------------------------- */
  /* Работа                                                            */
  /* ---------------------------------------------------------------- */

  private contextOf(graphId: string): ContextSnapshot | undefined {
    const key = this.engine.read((v) => v.local('run-keys', WORKSPACE_OWNER, 'context:' + graphId));
    if (!key) return undefined;
    return this.engine.read((v) => v.local('context-snapshots', WORKSPACE_OWNER, key.digest));
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
    // Атрибуция прежних записей вызовов закрепляется до смены состава графа.
    this.engine.pinLegacyCalls();
    const registered = this.engine.register(input.graph, {
      trusted: () => false,
      reachable: (p) => {
        const repo = repos.get(p.repositoryId);
        if (!repo) return false;
        try {
          // Синхронная проверка: предпосылка доступна в целевой ветке.
          execFileSync('git', ['merge-base', '--is-ancestor', p.resultSha, repo.targetRef], {
            cwd: this.repoPath(repo.path),
            stdio: 'ignore',
          });
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
      const digest = contextDigest(input.context);
      this.store.transact('run.context', (tx) => {
        tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, input.context!);
        tx.putLocal('run-keys', WORKSPACE_OWNER, 'context:' + graph.id, {
          graphId: graph.id,
          digest,
          at: new Date().toISOString(),
        });
      });
    }
    if (
      !graph.approval ||
      graph.approval.digest !== graph.digest ||
      graph.policyDigest !== digestOf(this.policy)
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
        this.engine.approve(graph.id, 'agent');
      } else if (!this.engine.read((v) => v.graph(graph.id)?.approval))
        throw new HarnessError(
          'APPROVAL_REQUIRED',
          'approvalMode: operator — выполните review-plan и approve',
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
      type: 'delivery.pending' | 'delivery.delivered' | 'delivery.failed' | 'delivery.conflict',
    ) =>
      this.store.transact('delivery.recorded', (tx) => {
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
