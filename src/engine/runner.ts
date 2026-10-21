import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  roleBinding,
  selectReviewer,
  mcpEnvironment,
  HarnessError,
  digestOf,
  contextDigest,
  implementationResultSchema,
  reviewIssues,
  reviewResultSchema,
  type ImplementationResult,
  type ReviewResult,
  sha256,
  type AttemptState,
  type ContextSnapshot,
  type EvidenceRecord,
  type ExecutionPolicy,
  type GatePolicy,
  type RuntimeAdapter,
  type RuntimeName,
  type ProbeServer,
  type RuntimeResponse,
  type WorkState,
} from '../contracts/index.ts';
import { git } from '../environment/process.ts';
import { executionEnvironment, runSteps, withEnvironment } from '../environment/lifecycle.ts';
import { redactDeep, type Redactor } from '../environment/redaction.ts';
import { implementationOutputSchema, reviewOutputSchema } from '../agents/schemas.ts';
import { unobservedReview } from '../agents/inspect.ts';
import { reviewerRunsChecks } from '../agents/cli-adapter.ts';
import {
  observeReproductions,
  probeCommand,
  probeLimits,
  probeRecords,
  probeTool,
  type ProbeSpec,
} from '../agents/review-probe.ts';
import { runGate } from '../verification/gates.ts';
import {
  assertDependencies,
  dependencyFreshness,
  removeSnapshots,
  snapshotDependencies,
  type DependencySnapshot,
  type Repositories,
} from '../verification/dependencies.ts';
import { CleanupFailure, cleanupEnvironment } from '../environment/lifecycle.ts';
import { defaultResourceDatabase, withResources } from '../environment/resources.ts';
import { REQUIREMENT_GATE, assertRequirements } from '../verification/requirements.ts';
import { BlockedError, classifyFailure } from './classify.ts';
import { TaskFailure, type FailureKind } from './failure.ts';
import type { Engine } from './engine.ts';
import { prompt } from './prompt.ts';
import { contractDocuments, orderCheckManifest } from '../verification/checks.ts';
import { CorpusStore, localRoots } from '../verification/corpus.ts';
import { submitCase } from '../verification/confirm.ts';
import { runSpike } from '../verification/spike.ts';
import { propertySeed } from '../verification/property.ts';
import { selfCheckNote, writeSelfCheck, type SelfCheckPlan } from '../verification/self-check.ts';
import { measuredInvoke } from './measured.ts';
import { continuableDraft, implementationBasis } from './reuse.ts';

type Repo = ExecutionPolicy['repositories'][number];

export interface RunnerOptions {
  engine: Engine;
  /** Каталог состояния: worktrees, артефакты попыток. Закрыт исполнителю, reviewer и gates. */
  stateDir: string;
  /**
   * Каталог рабочих деревьев, артефактов и снимков попыток репозитория; без
   * него — `stateDir`. Хост, хранящий данные компонента рядом с ним, кладёт
   * туда и его попытки.
   */
  stateDirFor?: (repositoryId: string) => string;
  /** Каталог, от которого разрешаются относительные пути репозиториев политики. */
  baseDir: string;
  adapters: Partial<Record<RuntimeName, RuntimeAdapter>>;
  /** Закреплённый контекст поручения; без него — пустой снимок. Хост может собирать его асинхронно. */
  context?: (work: WorkState) => ContextSnapshot | undefined | Promise<ContextSnapshot | undefined>;
  /** Дополнения хоста: сведения в запросах и отчёт исполнителя. В приёмке не участвуют. */
  hooks?: RunnerHooks;
  owner?: string;
  /** Префикс веток попыток; DevContour передаёт свой прежний `devcontour/run-`. */
  branchPrefix?: string;
  /** Внешние значения окружения (секреты политики); по умолчанию — окружение процесса. */
  environment?: NodeJS.ProcessEnv;
  /** База блокировок ресурсов; по умолчанию общая для машины. */
  resourceDatabase?: string;
}

/**
 * Точки расширения хоста. Они добавляют данные и записи хоста, но не решают
 * приёмку: gates, ревью, fencing и CAS остаются за движком и runner. Отказ
 * хука — отказ попытки, а не пропуск проверки.
 */
export interface RunnerHooks {
  /**
   * База попытки известна, работа ещё не начата: хост проверяет свои условия
   * (например, что база содержит закреплённые им файлы) и закрепляет свои
   * сведения. Отказ — отказ попытки; `BlockedError` — отказ окружения.
   */
  prepared?(input: {
    work: WorkState;
    attempt: AttemptState;
    baseSha: string;
  }): void | Promise<void>;
  /** Дополнительные части запроса writer (`review: false`) или reviewer — данные хоста. */
  notes?(input: {
    work: WorkState;
    attempt: AttemptState;
    review: boolean;
  }): string[] | Promise<string[]>;
  /**
   * Отказ попытки записан движком (класс, пауза очереди при отказе, который
   * повторится на любой работе): хост отражает его в своём журнале.
   */
  failed?(input: {
    attempt: AttemptState;
    kind: FailureKind;
    message: string;
  }): void | Promise<void>;
  /** Ответ writer закоммичен кандидатом `sha`: хост записывает сведения из отчёта (попутные находки). */
  implemented?(input: {
    attempt: AttemptState;
    output: ImplementationResult;
    sha: string;
  }): void | Promise<void>;
}

const ordered = (gates: GatePolicy[], ids: string[]) => {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const out: GatePolicy[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    // Псевдо-gate (актуальность требований) проверяется отдельно, а не командой.
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (ids.includes(dep)) visit(dep);
    out.push(byId.get(id)!);
  };
  ids.forEach(visit);
  return out;
};

const within = (path: string, prefixes: string[]) =>
  prefixes.some((p) => p === '.' || path === p || path.startsWith(p.endsWith('/') ? p : p + '/'));

/**
 * Исполнитель очереди. Один действующий controller; попытка проходит
 * реализацию, проверку области, gates и независимое ревью кандидата, затем
 * интеграцию с текущей принятой веткой, gates и ревью integration SHA и
 * приёмку с CAS продвижения target ref внутри транзакции приёмки.
 */
export class Runner {
  /** Предел git update-ref приёмки внутри транзакции; конечный и короче lease. */
  static refTimeoutMs = 15000;
  readonly owner: string;
  private readonly engine: Engine;
  private readonly policy: ExecutionPolicy;
  private jobs = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private mergeTails = new Map<string, Promise<void>>();
  /** Входы незавершённой очистки проверок потребителей, по попыткам. */
  private retained = new Map<string, Retained>();
  /** Самопроверка исполнителя попытки: каталог (читаем writer) и план. */
  private selfChecks = new Map<string, { dir: string; plan: SelfCheckPlan }>();

  /** Корпус подтверждённых случаев: принятие версий и закреплённые snapshot. */
  readonly corpus: CorpusStore;

  constructor(readonly options: RunnerOptions) {
    this.engine = options.engine;
    this.policy = options.engine.policy;
    this.owner = options.owner ?? 'harness-' + randomUUID();
    this.corpus = new CorpusStore(
      this.engine,
      localRoots([
        options.stateDir,
        options.baseDir,
        ...this.policy.repositories.map((r) => this.dirOf(r.id)),
        ...this.policy.repositories.map((r) => this.repoPath(r)),
      ]),
    );
  }

  /** Каталог попыток репозитория. */
  private dirOf(repositoryId: string) {
    return this.options.stateDirFor?.(repositoryId) ?? this.options.stateDir;
  }

  repoPath(repo: Repo) {
    return isAbsolute(repo.path) ? repo.path : resolve(this.options.baseDir, repo.path);
  }
  private repo(id: string) {
    const repo = this.policy.repositories.find((r) => r.id === id);
    if (!repo) throw new Error('Репозиторий не объявлен: ' + id);
    return repo;
  }
  /**
   * Закрыто процессам попытки: состояние controller и исходные checkout;
   * открыты их `.git` и закреплённые снимки зависимостей — на чтение.
   */
  private boundary(dependencies: Pick<DependencySnapshot, 'path'>[] = []) {
    const repos = this.policy.repositories.map((r) => this.repoPath(r));
    return {
      hidden: [
        ...new Set([
          this.options.stateDir,
          ...this.policy.repositories.map((r) => this.dirOf(r.id)),
          ...repos,
        ]),
      ],
      readable: [...repos.map((r) => join(r, '.git')), ...dependencies.map((d) => d.path)],
    };
  }
  private repositories(): Repositories {
    return { repo: (id) => this.repo(id), path: (repo) => this.repoPath(repo) };
  }

  /** Подготовка репозиториев: целевая ветка существует и не открыта ни в одном worktree. */
  async init() {
    for (const repo of this.policy.repositories) {
      const path = this.repoPath(repo);
      try {
        await git(path, 'rev-parse', '--verify', repo.targetRef);
      } catch {
        await git(path, 'update-ref', repo.targetRef, 'HEAD');
      }
      await this.assertTargetDetached(repo);
    }
  }
  private async assertTargetDetached(repo: Repo) {
    const list = await git(this.repoPath(repo), 'worktree', 'list', '--porcelain');
    if (list.split('\n').includes(`branch ${repo.targetRef}`))
      throw new Error(`Целевая ветка ${repo.targetRef} открыта в worktree; переключите его`);
  }

  get active() {
    return this.jobs.size;
  }

  /** Дождаться завершения выданных попыток (без новых выдач): хост ведёт свой цикл поверх `tick`. */
  async settled() {
    try {
      await Promise.all([...this.jobs.values()].map((j) => j.promise));
    } finally {
      // Продление роли нужно, пока идёт работа; следующий `tick` его возобновит.
      this.stopLead();
    }
  }

  /**
   * Актуальность требований на фазе: источник на HEAD репозитория и на
   * проверенном SHA совпадает с закреплённым; evidence псевдо-gate
   * `requirement-source` записывается только при совпадении.
   */
  private requirements(
    attempt: AttemptState,
    work: WorkState,
    repoPath: string,
    cwd: string,
    sha: string,
    phase: 'candidate' | 'integration',
  ) {
    if (!work.order.requirements.length) return;
    assertRequirements(work.order, repoPath);
    assertRequirements(work.order, cwd, sha);
    this.engine.evidence(attempt.id, attempt.token, {
      kind: 'test',
      phase,
      sha,
      gate: REQUIREMENT_GATE,
      passed: true,
      command: ['harness', 'requirements-check'],
      exitCode: 0,
      log: '',
      digest: sha256(JSON.stringify(work.order.requirements)),
      summary: 'Закреплённые требования совпадают с источником на HEAD и на проверенном SHA',
    });
  }

  private leaseTimer?: ReturnType<typeof setInterval>;
  /**
   * Роль controller продлевается, пока у процесса есть работа; утрата роли
   * прерывает его попытки — новый controller не делит очередь с прежним.
   */
  private keepLead() {
    if (this.leaseTimer) return;
    this.leaseTimer = setInterval(
      () => {
        if (this.engine.lead(this.owner)) return;
        for (const job of this.jobs.values()) job.controller.abort();
      },
      Math.max(500, this.policy.leaseMs / 3),
    );
    this.leaseTimer.unref();
  }
  private stopLead() {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
  }

  /** Освободить роль controller: процесс больше не ведёт очередь. */
  release() {
    this.stopLead();
    this.engine.release(this.owner);
  }

  /** Один шаг очереди до конца: выдать свободные слоты и довести выданное, без новых выдач. */
  async step() {
    await this.tick();
    try {
      await Promise.all([...this.jobs.values()].map((j) => j.promise));
    } finally {
      this.stopLead();
    }
  }

  /** Один шаг: роль controller, recovery, выдача свободных слотов. */
  async tick() {
    if (!this.engine.lead(this.owner)) {
      for (const job of this.jobs.values()) job.controller.abort();
      // Без своих попыток вести нечего: занятость роли — явный отказ, а не пустой шаг.
      if (!this.jobs.size) {
        const lease = this.engine.read((v) => v.controller());
        const other = lease && lease.engineVersion !== this.engine.version;
        throw new HarnessError(
          'CONTROLLER_BUSY',
          `Очередь ведёт другой controller${lease ? ` (${lease.owner} до ${new Date(lease.leaseUntil).toISOString()})` : ''}` +
            (other
              ? `: версия движка ${lease.engineVersion ?? 'прежняя, без записи версии'}, у этого процесса ${this.engine.version}`
              : ''),
        );
      }
      return;
    }
    this.keepLead();
    await this.recover();
    // Запрос операции применить политику: процесс с ожидаемой политикой
    // применяет его, когда работ под прежней не осталось.
    this.engine.serveReconfigure(this.owner);
    // Отложенные принятия корпуса: поручение освободилось — принятие
    // завершается до следующей выдачи.
    this.corpus.resume();
    for (const [id, job] of this.jobs)
      if (this.engine.read((v) => v.attempt(id)?.status) !== 'active') job.controller.abort();
    while (this.jobs.size < this.policy.concurrency) {
      const attempt = this.engine.claim(this.owner);
      if (!attempt) break;
      const controller = new AbortController();
      const promise = this.execute(attempt, controller).finally(() => this.jobs.delete(attempt.id));
      this.jobs.set(attempt.id, { promise, controller });
    }
  }

  /** Вести очередь, пока есть работа, которую можно выдать или довести. */
  async drain() {
    try {
      while (true) {
        await this.tick();
        if (!this.jobs.size) break;
        await Promise.all([...this.jobs.values()].map((j) => j.promise));
      }
    } finally {
      this.stopLead();
    }
  }

  /** Штатная остановка: пауза `shutdown`, прерывание попыток, освобождение роли controller. */
  async stop() {
    this.engine.pause('shutdown');
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.values()].map((j) => j.promise));
    this.release();
  }

  /**
   * Recovery после падения: истёкшая попытка с сохранённым integration SHA,
   * который уже в target ref, принимается заново проверкой всех evidence;
   * иначе она истекает с отказом окружения. Повторный recovery ничего не
   * дублирует: принятая попытка уже не активна.
   */
  /** Когда recovery последний раз искал прерванные вызовы. */
  private abandonScanAt = 0;

  async recover() {
    // Поиск прерванных вызовов читает всю историю вызовов: при старте и затем
    // не чаще раза в минуту, а не на каждом такте.
    if (Date.now() - this.abandonScanAt >= 60_000) {
      this.abandonScanAt = Date.now();
      this.engine.abandonCalls();
      this.engine.pinLegacyCalls();
    }
    const now = this.engine.clock();
    const stale = this.engine.read((v) =>
      v.attempts().filter((a) => a.status === 'active' && a.leaseUntil <= now),
    );
    for (const a of stale) {
      if (!a.integrationSha) continue;
      const repo = this.repo(a.repositoryId);
      try {
        // Восстанавливается только попытка под текущей политикой и требованиями.
        const work = this.engine.read((v) => v.work(a.workId)!);
        const policy = this.engine.read((v) => this.engine.host.basis.policyDigest(work, v));
        if (a.policyDigest !== policy)
          throw new Error('Политика изменилась; попытка под прежней не принимается');
        if (work.order.requirements.length) assertRequirements(work.order, this.repoPath(repo));
        await git(
          this.repoPath(repo),
          'merge-base',
          '--is-ancestor',
          a.integrationSha,
          repo.targetRef,
        );
        const adopted = this.engine.adopt(a.id, this.owner);
        this.engine.finish(a.id, adopted.token, a.integrationSha);
      } catch (error) {
        this.engine.rejectRecovery(a.id, error instanceof Error ? error.message : String(error));
      }
    }
    this.engine.expire();
  }

  /**
   * Окружение фазы: политика, репозиторий и — для вызова runtime — профиль
   * инструментов его назначения. Недостающий секрет — отказ окружения до
   * вызова, а не запуск без него.
   */
  private environment(attempt: AttemptState, phase: string, cwd: string, profile?: string) {
    const repo = this.repo(attempt.repositoryId);
    const tools = profile ? this.policy.toolProfiles[profile] : undefined;
    if (profile && !tools) throw new BlockedError('Неизвестный профиль инструментов: ' + profile);
    try {
      return this.environmentOf(attempt, phase, cwd, [
        this.policy.environment,
        repo.environment,
        tools?.environment,
        // MCP-серверы профиля получают свои переменные по имени.
        ...(tools ? [mcpEnvironment(tools)] : []),
      ]);
    } catch (error) {
      throw new BlockedError(error instanceof Error ? error.message : String(error));
    }
  }
  private environmentOf(
    attempt: AttemptState,
    phase: string,
    cwd: string,
    profiles: Parameters<typeof executionEnvironment>[0],
    repositoryId = attempt.repositoryId,
    dependencies = attempt.dependencies ?? [],
  ) {
    const repo = this.repo(repositoryId);
    return executionEnvironment(
      profiles,
      {
        DEVCONTOUR_REPOSITORY_ID: repo.id,
        DEVCONTOUR_RUN_ID: attempt.id,
        DEVCONTOUR_TASK_ID: attempt.workId,
        DEVCONTOUR_PHASE: phase,
        DEVCONTOUR_RESOURCES_JSON: JSON.stringify(attempt.resources ?? []),
        DEVCONTOUR_DEPENDENCIES_JSON: JSON.stringify(dependencies),
        // Компоненты попытки: закреплённые зависимости и своё рабочее дерево.
        DEVCONTOUR_COMPONENTS_JSON: JSON.stringify({
          ...Object.fromEntries(dependencies.map((d) => [d.repositoryId, d.path])),
          [repo.id]: cwd,
        }),
      },
      this.options.environment ?? process.env,
    );
  }

  private async call(
    adapter: RuntimeAdapter,
    input: {
      task: 'implement' | 'review-code';
      attempt: AttemptState;
      cwd: string;
      prompt: string;
      dir: string;
      phase: string;
      /** Сервер проверок reviewer с пределами controller. */
      probe?: ProbeServer;
    },
    signal: AbortSignal,
  ): Promise<RuntimeResponse & { redact: Redactor }> {
    const review = input.task !== 'implement';
    const work = await this.workOf(input.attempt);
    const role = roleBinding(this.policy, work.order.role, work.order.repositoryId)!;
    // Профиль reviewer — того назначения, которое выбрано для этой попытки
    // (основной или запасной reviewer правила).
    const chosen = selectReviewer(
      this.policy,
      'code',
      { runtime: input.attempt.runtime },
      work.order.role,
      work.order.repositoryId,
    );
    const reviewerProfile = chosen.ok ? chosen.reviewer.toolProfile : undefined;
    const binding = review
      ? {
          runtime: input.attempt.reviewer,
          ...(input.attempt.reviewerModel ? { model: input.attempt.reviewerModel } : {}),
          ...(input.attempt.reviewerEffort
            ? { effort: input.attempt.reviewerEffort as 'high' }
            : {}),
          ...(reviewerProfile ? { toolProfile: reviewerProfile } : {}),
        }
      : role.writer;
    // Окружение вызова — с профилем инструментов его назначения.
    const execution = this.environment(input.attempt, input.phase, input.cwd, binding.toolProfile);
    const boundary = this.boundary(input.attempt.dependencies);
    // Вызов под учётом: бюджет проверяется до вызова, расход закрепляется за попыткой.
    const response = await measuredInvoke(
      this.engine,
      adapter,
      {
        callId: randomUUID(),
        task: input.task,
        subject: {
          workId: input.attempt.workId,
          attemptId: input.attempt.id,
          phase: input.phase,
        },
        binding,
        cwd: input.cwd,
        prompt: input.prompt,
        outputSchema: review ? reviewOutputSchema : implementationOutputSchema,
        session: { kind: 'fresh' },
        sandbox: {
          mode: this.policy.isolation.mode,
          writable: review ? [] : [input.cwd],
          denied: boundary.hidden,
          readable: [
            input.cwd,
            ...boundary.readable,
            // Самопроверка исполнителя: план и полный корпус вне worktree.
            ...(!review && this.selfChecks.has(input.attempt.id)
              ? [this.selfChecks.get(input.attempt.id)!.dir]
              : []),
          ],
          network: { domains: this.policy.isolation.domains },
        },
        timeoutMs: this.policy.runTimeoutMs,
        env: Object.fromEntries(
          Object.entries(execution.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        artifactDir: input.dir,
        secrets: [...(execution.redact.secrets ?? [])],
        ...(review && input.probe ? { probe: input.probe } : {}),
      },
      signal,
      {
        repositoryId: input.attempt.repositoryId,
        runId: input.attempt.id,
        stage: review ? input.phase + '-review' : 'implementation',
      },
    );
    if (response.model && !review && response.model !== input.attempt.model)
      this.engine.update(input.attempt.id, input.attempt.token, 'run.model', {
        model: response.model,
      });
    if (response.status === 'unavailable')
      throw new BlockedError(
        `${adapter.runtime}: runtime недоступен${response.diagnostics.reason ? ': ' + response.diagnostics.reason : ''}`,
      );
    if (response.status === 'timeout')
      throw new TaskFailure('timeout', `${adapter.runtime}: исчерпан лимит времени прогона`);
    if (response.status === 'cancelled') throw new Error(`${adapter.runtime}: прогон прерван`);
    if (response.status === 'failed') {
      const message = `${adapter.runtime}: runtime завершился отказом${response.diagnostics.reason ? ': ' + response.diagnostics.reason : ''}`;
      throw new TaskFailure(
        classifyFailure(undefined, message) === 'unknown'
          ? review
            ? 'review'
            : 'unknown'
          : classifyFailure(undefined, message),
        message,
      );
    }
    // Маска — полным окружением вызова, включая секреты его профиля.
    return { ...response, redact: execution.redact };
  }

  private workOf(attempt: AttemptState) {
    return Promise.resolve(this.engine.read((v) => v.work(attempt.workId)!));
  }
  private history(attempt: AttemptState) {
    return this.engine.read((v) => v.attempts(attempt.workId));
  }
  private adapter(runtime: RuntimeName) {
    const adapter = this.options.adapters[runtime];
    if (!adapter) throw new BlockedError(`Runtime ${runtime} не подключён`);
    return adapter;
  }

  /** Область записи кандидата: защищённые пути, пустой результат, выход за область поручения и роли. */
  private async assertScope(
    work: WorkState,
    repo: Repo,
    cwd: string,
    context?: ContextSnapshot,
    range?: [string, string],
  ) {
    const changed = (
      await (range
        ? git(cwd, 'diff', '--no-renames', '--name-only', '-z', ...range)
        : git(cwd, 'diff', '--cached', '--no-renames', '--name-only', '-z'))
    )
      .split('\0')
      .filter(Boolean);
    // Закреплённый контекст из этого репозитория — норма, а не результат работы:
    // исполнитель, правящий его, подгонял бы свои же правила.
    const pinnedContext = (context?.sources ?? [])
      .filter((source) => source.repositoryId === repo.id)
      .flatMap((source) => [...source.files, ...source.references].map((f) => f.path));
    // Закреплённые checker/oracle/generator контрактов поручения: попытка, которая
    // правит эталон, подгоняла бы проверку под себя.
    const checkers = this.engine
      .read((v) => contractDocuments(work.order, v))
      .filter((c) => (c.repositoryId ?? work.order.repositoryId) === repo.id)
      .flatMap((c) => (c.artifacts ?? []).map((a) => a.path));
    const protectedList = [
      ...repo.protectedPaths,
      ...repo.generatedPaths,
      ...pinnedContext,
      ...checkers,
    ];
    const forbidden = changed.filter((p) => within(p, protectedList));
    if (forbidden.length)
      throw new TaskFailure(
        'scope-violation',
        `Изменены защищённые файлы: ${forbidden.join(', ')}`,
      );
    if (!changed.length)
      throw new TaskFailure(
        'empty-result',
        'Изменений нет: поручение отчиталось о выполнении пустым коммитом',
      );
    const role = roleBinding(this.policy, work.order.role, work.order.repositoryId)?.writePaths;
    const outside = changed.filter(
      (p) => !within(p, work.order.writeScope) || (role && !within(p, role)),
    );
    if (outside.length)
      throw new TaskFailure(
        'scope-violation',
        'Изменены файлы вне области поручения/роли: ' + outside.join(', '),
      );
  }

  /** Стадия попытки с замером: начало, конец и исход записываются под fencing. */
  private async timed<T>(attempt: AttemptState, stage: string, fn: () => Promise<T>) {
    const id = this.engine.timingStarted(attempt.id, attempt.token, stage);
    try {
      const value = await fn();
      this.engine.timingFinished(attempt.id, attempt.token, id, 'passed');
      return value;
    } catch (error) {
      try {
        this.engine.timingFinished(attempt.id, attempt.token, id, 'failed');
      } catch {
        /* Утраченное владение не публикует поздний замер. */
      }
      throw error;
    }
  }

  /**
   * Кандидат предыдущей попытки вместо новой реализации. Движок уже сверил
   * основания; здесь проверяется сам коммит: ровно один поверх той же базы,
   * рабочее дерево чистое, область прежняя. Проверки и ревью затем идут
   * заново — переиспользуется только написанный код.
   */
  private async reuseCandidate(
    attempt: AttemptState,
    work: WorkState,
    repo: Repo,
    cwd: string,
    base: string,
    context?: ContextSnapshot,
  ) {
    const sha = await git(cwd, 'rev-parse', 'HEAD');
    const parents = (await git(cwd, 'rev-list', '--parents', '-n', '1', sha)).split(' ').slice(1);
    if (sha !== attempt.reusedFrom!.candidateSha || parents.length !== 1 || parents[0] !== base)
      throw new TaskFailure(
        'unknown',
        `Кандидат ${attempt.reusedFrom!.candidateSha} не является одним коммитом поверх ${base}`,
      );
    if (await git(cwd, 'status', '--porcelain'))
      throw new TaskFailure('unknown', 'Рабочее дерево взятого кандидата не чистое');
    await this.assertScope(work, repo, cwd, context, [base, sha]);
    return sha;
  }

  /**
   * Время реализации кончилось раньше работы, или она оборвалась. Изменения
   * в области поручения сохраняются патчем к базе: следующая попытка начнёт с
   * них, а не с пустого дерева. Не удалось сохранить — попытка просто
   * начнётся заново.
   */
  private async keepDraft(attempt: AttemptState, work: WorkState, artifacts: string) {
    if (attempt.candidateSha || !attempt.worktree || !attempt.baseSha || !work.approvedDigest)
      return;
    try {
      const dir = join(artifacts, 'implementation');
      await mkdir(dir, { recursive: true });
      const patch = join(dir, 'partial.patch');
      // Только в области записи поручения: в дереве бывают и посторонние
      // неотслеживаемые каталоги — кеш менеджера пакетов, отчёты.
      const scope = ['--', ...work.order.writeScope];
      await git(attempt.worktree, 'add', '-A', ...scope);
      await git(
        attempt.worktree,
        'diff',
        '--cached',
        '--binary',
        `--output=${patch}`,
        attempt.baseSha,
        ...scope,
      );
      const text = await readFile(patch, 'utf8');
      if (!text.trim() || text.length > 5_000_000) return;
      const files = (
        await git(attempt.worktree, 'diff', '--cached', '--name-only', attempt.baseSha, ...scope)
      )
        .split('\n')
        .filter(Boolean);
      this.engine.recordPartial(attempt.id, attempt.token, {
        patch,
        digest: sha256(text),
        files,
        spec: work.approvedDigest,
        contracts: Object.fromEntries(work.order.contracts.map((c) => [c.id, c.digest])),
      });
    } catch {
      /* Черновик — удобство, а не условие: без него попытка начнётся с нуля. */
    }
  }

  /** Накладывает черновик предыдущей попытки, если он есть и годится. */
  private async continueDraft(
    attempt: AttemptState,
    work: WorkState,
    repoPath: string,
    cwd: string,
  ): Promise<AttemptState> {
    const draft = this.engine.read((v) => continuableDraft(v, work, attempt.id));
    if (!draft) return attempt;
    const dir = join(this.dirOf(attempt.repositoryId), 'artifacts', attempt.id, 'implementation');
    await mkdir(dir, { recursive: true });
    const scope = ['--', ...work.order.writeScope];
    let applied = false;
    let files: string[] = [];
    try {
      let patch: string;
      if (draft.kind === 'unfinished') {
        patch = draft.patch;
        files = draft.files;
        // Черновик подменённый или повреждённый не накладывается.
        if (sha256(await readFile(patch, 'utf8')) !== draft.digest) throw new Error('digest');
      } else {
        // Кандидат лежит коммитом в репозитории; его изменения относительно
        // своей базы переносятся на текущую.
        patch = join(dir, 'rejected-candidate.patch');
        await git(
          repoPath,
          'diff',
          '--binary',
          `--output=${patch}`,
          draft.baseSha,
          draft.candidateSha,
          ...scope,
        );
        if (!(await readFile(patch, 'utf8')).trim()) throw new Error('empty');
        files = (
          await git(repoPath, 'diff', '--name-only', draft.baseSha, draft.candidateSha, ...scope)
        )
          .split('\n')
          .filter(Boolean);
      }
      await git(cwd, 'apply', '--3way', '--whitespace=nowarn', patch);
      // --3way кладёт изменения в индекс; исполнитель видит их как свою
      // незакоммиченную работу.
      await git(cwd, 'reset', '-q');
      applied = true;
    } catch {
      await git(cwd, 'reset', '-q', '--hard').catch(() => undefined);
      await git(cwd, 'clean', '-fdq').catch(() => undefined);
    }
    const continuedFrom = {
      runId: draft.runId,
      kind: draft.kind,
      reason: draft.reason,
      ...(draft.respecified ? { respecified: true } : {}),
      applied,
      files,
    };
    await writeFile(join(dir, 'continuation.json'), JSON.stringify(continuedFrom, null, 2));
    this.engine.continuation(attempt.id, attempt.token, continuedFrom);
    return { ...attempt, continuedFrom };
  }

  private async execute(claimed: AttemptState, controller: AbortController) {
    let attempt = claimed;
    const repo = this.repo(attempt.repositoryId);
    const repoPath = this.repoPath(repo);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const rearm = () => {
      clearTimeout(timeout);
      timeout = setTimeout(
        () => controller.abort(new DOMException('Исчерпан лимит времени прогона', 'TimeoutError')),
        this.policy.runTimeoutMs,
      );
    };
    rearm();
    let heartbeatCause: string | undefined;
    const heartbeat = setInterval(
      () => {
        try {
          this.engine.heartbeat(attempt.id, attempt.token);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          heartbeatCause ??= reason;
          try {
            this.engine.heartbeatFailed(attempt.id, attempt.token, reason);
          } catch {
            /* Хранилище недоступно: причина останется в отказе. */
          }
          controller.abort();
        }
      },
      Math.max(1000, this.policy.leaseMs / 3),
    );
    const cwd = join(this.dirOf(repo.id), 'worktrees', attempt.id);
    const integrationCwd = cwd + '-integration';
    const artifacts = join(this.dirOf(repo.id), 'artifacts', attempt.id);
    const worktrees: string[] = [];
    const snapshots: DependencySnapshot[] = [];
    let preserve = false;
    try {
      // Ресурсы поручения, gates его репозитория и выбранных проверок
      // потребителей — одним резервированием на всю попытку.
      const reserve = [
        ...(claimed.workId ? ((await this.workOf(attempt)).order.resources ?? []) : []),
        ...repo.gates.flatMap((g) => g.resources ?? []),
        ...(claimed.consumers ?? []).flatMap((c) =>
          this.repo(c.repositoryId)
            .gates.filter((g) => c.gates.includes(g.id))
            .flatMap((g) => g.resources ?? []),
        ),
      ];
      await withResources(
        {
          resources: this.policy.resources,
          leaseMs: this.policy.leaseMs,
          resourceDatabase: this.options.resourceDatabase ?? defaultResourceDatabase(),
        },
        [...new Set(reserve)],
        `${this.options.stateDir}:${attempt.id}`,
        controller.signal,
        async (signal, resources) => {
          if (resources.length)
            this.engine.update(attempt.id, attempt.token, 'run.context', { resources });
          attempt = { ...attempt, resources };
          const work = await this.workOf(attempt);
          const context = await this.options.context?.(work);
          if (context)
            // Попытка закрепляет снимок контекста: writer и оба reviewer видят одни и те же байты.
            this.engine.update(attempt.id, attempt.token, 'run.context', {
              contextSnapshot: contextDigest(context),
              context: context.sources.map((s) => ({
                id: s.id,
                version: s.version,
                repositoryId: s.repositoryId ?? work.order.repositoryId,
                revision: s.revision ?? s.digest,
                digest: s.hostDigest ?? s.digest,
              })),
            });
          // Обязательный контекст поручения должен быть закреплён до работы:
          // без него исполнение не начинается (отказ окружения).
          const missing = work.order.context.filter(
            (id) => !context?.sources.some((s) => s.id === id),
          );
          if (missing.length)
            throw new BlockedError('Обязательный контекст не закреплён: ' + missing.join(', '));
          // Постановка по устаревшему источнику требований не исполняется.
          if (work.order.requirements.length) assertRequirements(work.order, repoPath);
          // Снимок зависимостей репозитория — до реализации: writer, gates и
          // reviewer видят одни и те же закреплённые деревья и artifacts.
          if (repo.dependsOn.length) {
            const dependencies = await snapshotDependencies({
              repos: this.repositories(),
              repositoryId: repo.id,
              dir: join(this.dirOf(repo.id), 'dependencies', attempt.id),
              artifacts,
              runId: attempt.id,
              policy: this.policy,
              environment: this.options.environment ?? process.env,
              signal,
              predecessors: this.engine.read((v) =>
                work.order.dependsOn.flatMap((id) => {
                  const w = v.work(id);
                  return w?.resultSha
                    ? [{ repositoryId: w.order.repositoryId, resultSha: w.resultSha }]
                    : [];
                }),
              ),
            });
            snapshots.push(...dependencies);
            this.engine.dependencies(attempt.id, attempt.token, dependencies);
            attempt = { ...attempt, dependencies };
          }
          const base = await git(repoPath, 'rev-parse', repo.targetRef);
          await this.options.hooks?.prepared?.({ work, attempt, baseSha: base });
          // Основания записываются до реализации; в той же транзакции решается,
          // берётся ли кандидат предыдущей попытки вместо нового кода.
          const reuse = this.engine.implementationBasis(
            attempt.id,
            attempt.token,
            implementationBasis(work, attempt, base, this.engine.version),
          );
          attempt = { ...attempt, ...(reuse.reusedFrom ? { reusedFrom: reuse.reusedFrom } : {}) };
          await mkdir(join(this.dirOf(repo.id), 'worktrees'), { recursive: true });
          await git(
            repoPath,
            'worktree',
            'add',
            '-b',
            `${this.options.branchPrefix ?? 'harness/run-'}${attempt.id}`,
            cwd,
            reuse.reusedFrom?.candidateSha ?? base,
          );
          worktrees.push(cwd);
          this.engine.phase(attempt.id, attempt.token, 'running', { baseSha: base, worktree: cwd });
          attempt = { ...attempt, baseSha: base, worktree: cwd };
          const gates = ordered(repo.gates, attempt.requiredGates ?? repo.gates.map((g) => g.id));
          const execution = this.environment(attempt, 'candidate', cwd);
          const candidate = await withEnvironment(
            repo.lifecycle ?? this.policy.lifecycle,
            cwd,
            join(artifacts, 'candidate', 'environment'),
            execution,
            signal,
            async () => {
              await runSteps(
                repo.prepare,
                cwd,
                join(artifacts, 'candidate', 'prepare'),
                execution,
                signal,
              );
              const sha = attempt.reusedFrom
                ? await this.timed(attempt, 'implementation-reuse', () =>
                    this.reuseCandidate(attempt, work, repo, cwd, base, context),
                  )
                : await this.timed(attempt, 'implementation', async () => {
                    attempt = await this.continueDraft(attempt, work, repoPath, cwd);
                    const dir = join(artifacts, 'implementation');
                    await mkdir(dir, { recursive: true });
                    await writeFile(join(dir, 'work.json'), JSON.stringify(work.order, null, 2));
                    // Закреплённый снимок контекста — тем же байтам, что видят writer и reviewer.
                    if (context)
                      await writeFile(join(dir, 'context.json'), JSON.stringify(context, null, 2));
                    await this.prepareSelfCheck(attempt, repo, join(artifacts, 'self-check'));
                    const response = await this.call(
                      this.adapter(attempt.runtime),
                      {
                        task: 'implement',
                        attempt,
                        cwd,
                        dir,
                        phase: 'candidate',
                        prompt: prompt({
                          work,
                          attempt,
                          history: this.history(attempt),
                          context,
                          gates: gates.map((g) => ({ id: g.id, command: g.command })),
                          notes: [
                            ...this.notes(attempt, false),
                            ...(await this.hostNotes(work, attempt, false)),
                          ],
                        }),
                      },
                      signal,
                    );
                    const result = implementationResultSchema.safeParse(response.output);
                    if (!result.success)
                      throw new Error(
                        'Ответ исполнителя вне схемы: ' + result.error.issues[0]?.message,
                      );
                    if (!result.data.completed)
                      throw new Error('Исполнитель сообщил о незавершённой работе');
                    this.engine.heartbeat(attempt.id, attempt.token);
                    signal.throwIfAborted();
                    if ((await git(cwd, 'rev-parse', 'HEAD')) !== base)
                      throw new TaskFailure(
                        'scope-violation',
                        'Исполнитель изменил HEAD; интеграцией владеет harness',
                      );
                    await git(cwd, 'add', '-A');
                    await this.assertScope(work, repo, cwd, context);
                    await git(
                      cwd,
                      '-c',
                      'core.hooksPath=/dev/null',
                      'commit',
                      '--no-gpg-sign',
                      '-q',
                      '-m',
                      `${work.id}: ${work.order.title}`,
                    );
                    const committed = await git(cwd, 'rev-parse', 'HEAD');
                    await this.options.hooks?.implemented?.({
                      attempt,
                      output: result.data,
                      sha: committed,
                    });
                    return committed;
                  });
              rearm();
              this.engine.phase(attempt.id, attempt.token, 'verifying', { candidateSha: sha });
              for (const gate of gates)
                await this.gate(attempt, cwd, sha, 'candidate', gate, artifacts, signal, execution);
              this.requirements(attempt, work, repoPath, cwd, sha, 'candidate');
              rearm();
              this.engine.phase(attempt.id, attempt.token, 'reviewing');
              await this.review(
                attempt,
                work,
                cwd,
                base,
                sha,
                'candidate',
                artifacts,
                signal,
                context,
              );
              return sha;
            },
            (stage, action) => this.timed(attempt, 'candidate-environment:' + stage, action),
          );
          await assertDependencies(attempt.dependencies ?? []);
          attempt = { ...attempt, candidateSha: candidate };
          const previous = this.mergeTails.get(repo.id) ?? Promise.resolve();
          let unlock!: () => void;
          this.mergeTails.set(repo.id, new Promise<void>((r) => (unlock = r)));
          await this.timed(attempt, 'integration-wait', () => previous);
          try {
            rearm();
            await this.integrate(
              attempt,
              work,
              repo,
              integrationCwd,
              worktrees,
              artifacts,
              signal,
              context,
              rearm,
            );
          } finally {
            unlock();
          }
        },
      );
    } catch (error) {
      // Незавершённая очистка окружения: рабочие деревья и снимки — входы её
      // повторения (`environment.json` ссылается на них), их нельзя убирать.
      preserve = error instanceof CleanupFailure;
      // Прерывание по лимиту времени называется лимитом времени, что бы ни выбросила прерванная операция.
      const expired =
        controller.signal.aborted &&
        (controller.signal.reason as Error | undefined)?.name === 'TimeoutError';
      const message =
        expired && !(error instanceof TaskFailure)
          ? `Исчерпан лимит времени попытки (${Math.round(this.policy.runTimeoutMs / 1000)} с)`
          : error instanceof Error
            ? error.message
            : String(error);
      try {
        const kind =
          expired && !(error instanceof TaskFailure) ? 'timeout' : classifyFailure(error, message);
        // Незакоммиченная работа сохраняется при любом отказе до кандидата:
        // по времени, «не закончил», обрыв. Иначе повтор начинал с пустого
        // дерева и тратил попытку на сделанное.
        if (kind !== 'provider-auth')
          await this.keepDraft(attempt, await this.workOf(attempt), artifacts);
        // Пример reviewer — гипотеза; эталон решает, станет ли он обязательным:
        // подтверждение идёт до записи отказа, и принятие новой версии корпуса
        // ждёт окончания этой попытки. В operator mode подтверждение — ручное.
        if (kind === 'review' && this.policy.approvalMode === 'agent')
          await this.confirmReproductions(attempt).catch(() => undefined);
        this.engine.fail(attempt.id, attempt.token, message, {
          ...(error instanceof TaskFailure && error.properties
            ? { properties: error.properties }
            : {}),
          kind,
          blocked:
            (error instanceof BlockedError || kind === 'provider-auth') && !attempt.candidateSha,
          ...(heartbeatCause ? { heartbeatCause } : {}),
        });
        await this.options.hooks?.failed?.({ attempt, kind, message });
      } catch {
        // Отменённая или потерявшая владение попытка не публикует поздний отказ.
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.selfChecks.delete(attempt.id);
      // Рабочие деревья попытки убираются; ветка попытки и объекты остаются —
      // по ним recovery и следующая попытка видят кандидата. Снимки
      // зависимостей: SHA, tree и artifacts записаны в попытке. Что убрать не
      // удалось или нельзя (незавершённая очистка), записывается для
      // `finishCleanup` — ошибки удаления не теряются.
      const retained = this.retained.get(attempt.id) ?? { worktrees: [], snapshots: [] };
      this.retained.delete(attempt.id);
      const pending: Retained = {
        worktrees: [
          ...worktrees.map((dir) => ({ checkout: repoPath, dir })),
          ...retained.worktrees,
        ],
        snapshots: [...snapshots, ...retained.snapshots],
      };
      await this.removeTrees(artifacts, pending, preserve).catch(() => undefined);
    }
  }

  /**
   * Убрать рабочие деревья и снимки попытки. При незавершённой очистке
   * (`keep`) ничего не убирается; оставшееся записывается в
   * `cleanup-pending.json` артефактов попытки.
   */
  private async removeTrees(artifacts: string, pending: Retained, keep: boolean) {
    const left: Retained = keep ? pending : { worktrees: [], snapshots: [] };
    const errors: string[] = [];
    if (!keep) {
      for (const tree of pending.worktrees)
        await git(tree.checkout, 'worktree', 'remove', '--force', tree.dir).catch((e: unknown) => {
          if (!existsSync(tree.dir)) return;
          left.worktrees.push(tree);
          errors.push(`${tree.dir}: ${e instanceof Error ? e.message : String(e)}`);
        });
      errors.push(...(await removeSnapshots(this.repositories(), pending.snapshots)));
      left.snapshots.push(...pending.snapshots.filter((d) => existsSync(d.path)));
    }
    const file = join(artifacts, 'cleanup-pending.json');
    if (!left.worktrees.length && !left.snapshots.length) return;
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      file,
      JSON.stringify(
        { reason: keep ? 'cleanup-failed' : 'remove-failed', errors, ...left },
        null,
        2,
      ),
    );
  }

  /**
   * Довести очистку завершённой попытки: повторить незавершённый teardown по
   * каждому сохранённому `environment.json` (входы на месте), затем убрать
   * рабочие деревья и снимки. Идемпотентно: без записи — `nothing-pending`;
   * отказ повторной очистки оставляет запись и входы.
   */
  async finishCleanup(attemptId: string) {
    const attempt = this.engine.read((v) => v.attempt(attemptId));
    if (!attempt) throw new HarnessError('NOT_FOUND', 'Попытка не найдена: ' + attemptId);
    if (attempt.status === 'active' || this.jobs.has(attemptId))
      throw new HarnessError('NOT_READY', 'Попытка ещё идёт: ' + attemptId);
    const artifacts = join(this.dirOf(attempt.repositoryId), 'artifacts', attemptId);
    const file = join(artifacts, 'cleanup-pending.json');
    if (!existsSync(file)) return { status: 'nothing-pending' as const };
    const pending = JSON.parse(await readFile(file, 'utf8')) as Retained & { reason: string };
    const roots = [
      ...new Set([
        await realpath(this.options.stateDir),
        await realpath(this.dirOf(attempt.repositoryId)),
      ]),
    ];
    const cleaned: string[] = [];
    for (const receipt of await receipts(artifacts)) {
      const state = JSON.parse(await readFile(receipt, 'utf8')) as { status: string };
      if (state.status !== 'cleanup-failed') continue;
      // Владелец окружения — этот процесс, а попытка уже закончена.
      await cleanupEnvironment(receipt, this.policy, roots, { owner: process.pid });
      cleaned.push(receipt);
    }
    await rm(file);
    await this.removeTrees(artifacts, pending, false);
    if (existsSync(file))
      throw new HarnessError(
        'INTERNAL',
        'Не удалось убрать рабочие деревья попытки: ' +
          (JSON.parse(await readFile(file, 'utf8')) as { errors: string[] }).errors.join('; '),
      );
    return { status: 'cleaned' as const, receipts: cleaned };
  }

  private async gate(
    attempt: AttemptState,
    cwd: string,
    sha: string,
    phase: EvidenceRecord['phase'],
    gate: GatePolicy,
    artifacts: string,
    signal: AbortSignal,
    execution: ReturnType<typeof executionEnvironment>,
    consumer?: { repositoryId: string; dependencies: DependencySnapshot[] },
  ) {
    // Время проверок потребителя — отдельная стадия: в метриках области оно
    // не смешивается с собственными gates поручения.
    const stage = consumer
      ? `${phase}-consumer:${consumer.repositoryId}:${gate.id}`
      : `${phase}-test:${gate.id}`;
    await this.timed(attempt, stage, () =>
      this.runOneGate(attempt, cwd, sha, phase, gate, artifacts, signal, execution, consumer),
    );
  }

  private async runOneGate(
    attempt: AttemptState,
    cwd: string,
    sha: string,
    phase: EvidenceRecord['phase'],
    gate: GatePolicy,
    artifacts: string,
    signal: AbortSignal,
    execution: ReturnType<typeof executionEnvironment>,
    consumer?: { repositoryId: string; dependencies: DependencySnapshot[] },
  ) {
    await runGate({
      policy: this.policy,
      record: (e) => this.engine.evidence(attempt.id, attempt.token, e),
      cwd,
      sha,
      phase,
      gate,
      artifactDir: consumer
        ? join(artifacts, phase, 'consumer', consumer.repositoryId)
        : join(artifacts, phase),
      signal,
      execution,
      boundary: this.boundary(consumer?.dependencies ?? attempt.dependencies),
      ...(consumer ? { consumer: consumer.repositoryId } : {}),
      ...(gate.property ? { property: this.propertyRun(attempt, gate, consumer) } : {}),
    });
  }

  /**
   * Ожидаемая проверка генеративного gate. Проверка потребителя исполняет
   * свою объявленную область целиком: договор свойств поручения к
   * одноимённому gate другого компонента не относится и не сужает его.
   */
  private propertyRun(attempt: AttemptState, gate: GatePolicy, consumer?: unknown) {
    return this.engine.read((v) => {
      const work = v.work(attempt.workId)!;
      const contracts = contractDocuments(work.order, v);
      const corpus =
        !consumer && attempt.checks?.corpus
          ? this.corpus.snapshot(v, attempt.checks.corpus)
          : undefined;
      const expected = consumer
        ? undefined
        : orderCheckManifest(work.order, contracts, gate.id, corpus);
      return {
        runId: attempt.id,
        ...(expected ? { expected } : {}),
        ...(corpus ? { corpus: { digest: corpus.digest, content: corpus.content } } : {}),
        contracts: Object.fromEntries(work.order.contracts.map((c) => [c.id, c.digest])),
        artifacts: contracts.flatMap((c) =>
          (c.artifacts ?? []).map((a) => ({ path: a.path, blob: a.blob })),
        ),
      };
    });
  }

  /**
   * Проверки потребителей поручения — на integration, в рабочем дереве
   * каждого объявленного потребителя на голове его целевой ветки. Компонент
   * поручения подставлен рабочим деревом integration (его интегрированным
   * результатом), прочие зависимости потребителя — снимок их целевых веток,
   * собранный уже против подстановки. Договор окружения потребителя — как у
   * собственной integration: lifecycle, prepare, gates, cleanup. Что
   * проверено, записывается; рабочие деревья убираются и при отказе, а отказ
   * очистки не скрывается.
   */
  private async consumers(
    attempt: AttemptState,
    cwd: string,
    sha: string,
    artifacts: string,
    signal: AbortSignal,
  ) {
    const provider = attempt.repositoryId;
    for (const consumer of attempt.consumers ?? []) {
      signal.throwIfAborted();
      const repo = this.repo(consumer.repositoryId);
      const checkout = this.repoPath(repo);
      const id = `${attempt.id}-consumer-${repo.id}-${randomUUID().slice(0, 8)}`;
      const dir = join(this.dirOf(repo.id), 'consumers', id);
      const own = join(artifacts, 'integration', 'consumer', repo.id);
      await mkdir(join(this.dirOf(repo.id), 'consumers'), { recursive: true });
      await git(checkout, 'worktree', 'add', '--detach', dir, repo.targetRef);
      let dependencies: DependencySnapshot[] = [];
      let failure: Error | undefined;
      try {
        const consumerSha = await git(dir, 'rev-parse', 'HEAD');
        // Проверяется закреплённая голова потребителя: подготовка, lifecycle и
        // gates не подменяют её коммитом или правкой отслеживаемых файлов.
        const pinned = async (step: string) => {
          if ((await git(dir, 'rev-parse', 'HEAD')) !== consumerSha)
            throw new Error(`Потребитель ${repo.id}: ${step} изменила HEAD`);
          if (await git(dir, 'status', '--porcelain', '--untracked-files=no'))
            throw new Error(`Потребитель ${repo.id}: ${step} изменила отслеживаемые файлы`);
        };
        dependencies = await snapshotDependencies({
          repos: this.repositories(),
          repositoryId: repo.id,
          dir: join(this.dirOf(repo.id), 'dependencies', id),
          artifacts: own,
          runId: attempt.id,
          policy: this.policy,
          environment: this.options.environment ?? process.env,
          signal,
          overrides: new Map([[provider, { path: cwd, sha }]]),
        });
        const execution = this.environmentOf(
          attempt,
          'integration',
          dir,
          [this.policy.environment, repo.environment],
          repo.id,
          dependencies,
        );
        await withEnvironment(
          repo.lifecycle ?? this.policy.lifecycle,
          dir,
          join(own, 'environment'),
          execution,
          signal,
          async () => {
            await runSteps(repo.prepare, dir, join(own, 'prepare'), execution, signal);
            await pinned('подготовка');
            for (const gate of ordered(repo.gates, consumer.gates))
              await this.gate(
                attempt,
                dir,
                sha,
                'integration',
                gate,
                artifacts,
                signal,
                execution,
                {
                  repositoryId: repo.id,
                  dependencies,
                },
              );
          },
          (stage, action) =>
            this.timed(attempt, `integration-consumer-environment:${repo.id}:${stage}`, action),
        );
        await assertDependencies(dependencies);
        await pinned('проверка');
        // Свежесть фактических входов потребителя — прочих зависимостей и его
        // самого — на момент окончания проверки.
        const head = await git(checkout, 'rev-parse', repo.targetRef);
        const freshness = [
          ...(await dependencyFreshness(
            this.repositories(),
            dependencies.filter((d) => d.repositoryId !== provider),
          )),
          { repositoryId: repo.id, snapshot: consumerSha, head, fresh: head === consumerSha },
        ];
        this.engine.consumerChecked(attempt.id, attempt.token, repo.id, {
          freshness,
          observedAt: new Date().toISOString(),
          sha: consumerSha,
          tree: await git(dir, 'rev-parse', `${consumerSha}^{tree}`),
          dependencies: dependencies.map((d) => ({
            repositoryId: d.repositoryId,
            sha: d.sha,
            tree: d.tree,
            artifacts: d.artifacts,
          })),
        });
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
      // Незавершённая очистка окружения потребителя: его рабочие деревья —
      // контекст повторной очистки по environment.json, их нельзя убирать.
      if (failure instanceof CleanupFailure) {
        const retained = this.retained.get(attempt.id) ?? { worktrees: [], snapshots: [] };
        retained.worktrees.push({ checkout, dir });
        retained.snapshots.push(...dependencies.filter((d) => d.repositoryId !== provider));
        this.retained.set(attempt.id, retained);
        throw new CleanupFailure(
          `${failure.message}; рабочие деревья проверки потребителя ${repo.id} сохранены для повторной очистки (${join(own, 'environment', 'environment.json')})`,
        );
      }
      // Очистка — обязательная часть проверки: её отказ не скрывается и не
      // заслоняется отказом самой проверки.
      const leftovers = await removeSnapshots(
        this.repositories(),
        dependencies.filter((d) => d.repositoryId !== provider),
      );
      await git(checkout, 'worktree', 'remove', '--force', dir).catch((e: unknown) =>
        leftovers.push(`${repo.id}: ${e instanceof Error ? e.message : String(e)}`),
      );
      const cleanup = leftovers.length
        ? `не удалось убрать рабочие деревья проверки потребителя: ${leftovers.join('; ')}`
        : undefined;
      if (failure && cleanup)
        throw failure instanceof TaskFailure
          ? new TaskFailure(failure.kind, `${failure.message}; ${cleanup}`)
          : new Error(`${failure.message}; ${cleanup}`, { cause: failure });
      if (failure) throw failure;
      if (cleanup)
        throw new TaskFailure('environment', cleanup[0]!.toUpperCase() + cleanup.slice(1));
    }
  }

  /**
   * Независимое ревью точного SHA. Отказ — отсутствие одобрения, блокирующая
   * находка, ответ вне схемы, изменение дерева или HEAD reviewer-ом. Ответ
   * reviewer маскируется целиком перед записью.
   */
  /**
   * Инструмент проверок reviewer с пределами controller — только тому, кто и
   * так может запускать команды: права reviewer он не расширяет, а
   * ограничивает срок. Спецификация лежит в каталоге ревью; значения
   * переменных окружения CLI передаёт серверу по имени, на диск они не пишутся.
   */
  private async reviewProbe(
    attempt: AttemptState,
    work: WorkState,
    cwd: string,
    dir: string,
    phase: string,
  ) {
    const chosen = selectReviewer(
      this.policy,
      'code',
      { runtime: attempt.runtime },
      work.order.role,
      work.order.repositoryId,
    );
    const name = chosen.ok ? chosen.reviewer.toolProfile : undefined;
    const profile = name ? this.policy.toolProfiles[name] : undefined;
    // Fixture runtime команд не запускает: инструмента ему не нужно.
    if (attempt.reviewer === 'fixture' || !reviewerRunsChecks(attempt.reviewer, profile))
      return undefined;
    const limits = probeLimits(this.policy);
    const boundary = this.boundary(attempt.dependencies);
    const execution = this.environment(attempt, phase, cwd, name);
    const secrets = new Set(execution.redact.secrets ?? []);
    const spec: ProbeSpec = {
      cwd,
      controller: boundary.hidden,
      readable: [cwd, ...boundary.readable],
      isolation: this.policy.isolation,
      commandTimeoutMs: limits.commandTimeoutMs,
      budgetMs: limits.budgetMs,
      deadline: Date.now() + this.policy.runTimeoutMs - limits.reserveMs,
      env: Object.keys(execution.env).filter((k) => execution.env[k] !== undefined),
      secrets: Object.entries(execution.env)
        .filter(([, value]) => value !== undefined && secrets.has(value))
        .map(([key]) => key),
      settingsDir: join(dir, 'probe-settings'),
      log: join(dir, 'probes.jsonl'),
    };
    const specPath = join(dir, 'probe.json');
    await writeFile(specPath, JSON.stringify(spec, null, 2));
    const seconds = (ms: number) => Math.round(ms / 1000);
    return {
      log: spec.log,
      server: {
        ...probeCommand(specPath),
        env: spec.env,
        commandTimeoutMs: limits.commandTimeoutMs,
      } satisfies ProbeServer,
      prompt: `Run checks with the ${probeTool} tool (argv, no shell; sources are read-only, temporary files go to TMPDIR). The controller stops each command after ${seconds(limits.commandTimeoutMs)} s and all checks share ${seconds(limits.budgetMs)} s; ${seconds(limits.reserveMs)} s stay reserved for your verdict. A timeout is an observation about that command on that input, not proof of a defect: name the input and the limit if you report it, and give your verdict with what you have when the budget runs out. When a finding rests on a run, put its runId into reproduction.run.`,
    };
  }

  private async review(
    attempt: AttemptState,
    work: WorkState,
    cwd: string,
    base: string,
    sha: string,
    phase: EvidenceRecord['phase'],
    artifacts: string,
    signal: AbortSignal,
    context?: ContextSnapshot,
  ) {
    await this.timed(attempt, phase + '-review', () =>
      this.reviewOnce(attempt, work, cwd, base, sha, phase, artifacts, signal, context),
    );
  }

  private async reviewOnce(
    attempt: AttemptState,
    work: WorkState,
    cwd: string,
    base: string,
    sha: string,
    phase: EvidenceRecord['phase'],
    artifacts: string,
    signal: AbortSignal,
    context?: ContextSnapshot,
  ) {
    const dir = join(artifacts, phase, 'review');
    await mkdir(dir, { recursive: true });
    const diff = await git(cwd, 'diff', '--no-ext-diff', '--no-textconv', base, sha);
    if (diff.length > 1_000_000)
      throw new TaskFailure(
        'review',
        'Diff превышает лимит независимого ревью; разделите поручение',
      );
    const status = await git(cwd, 'status', '--porcelain', '--untracked-files=all');
    const repo = this.repo(attempt.repositoryId);
    const gates = ordered(repo.gates, attempt.requiredGates ?? repo.gates.map((g) => g.id));
    const probe = await this.reviewProbe(attempt, work, cwd, dir, phase);
    const response = await this.call(
      this.adapter(attempt.reviewer),
      {
        task: 'review-code',
        attempt,
        cwd,
        dir,
        phase,
        prompt:
          prompt({
            work,
            attempt: { ...attempt, baseSha: base },
            history: this.history(attempt),
            context,
            gates: gates.map((g) => ({ id: g.id, command: g.command })),
            review: { sha, phase, diff },
            notes: [
              ...this.notes(attempt, true, sha),
              ...(await this.hostNotes(work, attempt, true)),
            ],
          }) + (probe ? '\n\n' + probe.prompt : ''),
        ...(probe ? { probe: probe.server } : {}),
      },
      signal,
    );
    // Reviewer не меняет закреплённые зависимости, как и своё дерево.
    await assertDependencies(attempt.dependencies ?? []);
    const redact = response.redact;
    const parsed = reviewResultSchema.safeParse(response.output);
    const clean =
      (await git(cwd, 'status', '--porcelain', '--untracked-files=all')) === status &&
      !(await git(cwd, 'status', '--porcelain', '--untracked-files=no')) &&
      (await git(cwd, 'rev-parse', 'HEAD')) === sha;
    const issues = parsed.success
      ? reviewIssues(parsed.data, [])
      : ['Ответ ревью вне схемы: ' + (parsed.error.issues[0]?.message ?? '')];
    const passed = clean && parsed.success && parsed.data.approved && !issues.length;
    const inspection = response.inspection ?? unobservedReview();
    // Проверки reviewer — по журналу controller, а не по самоотчёту модели.
    const probes = probe ? await probeRecords(probe.log) : undefined;
    const record = redactDeep(
      {
        ...(parsed.success
          ? { ...parsed.data, findings: observeReproductions(parsed.data.findings, probes, redact) }
          : { approved: false, summary: 'ответ вне схемы', findings: [] }),
        inspection,
        issues,
        ...(probes ? { probes } : {}),
      },
      redact,
    );
    // Служебные значения записи — перечисления контура, а не текст reviewer:
    // короткий секрет, совпавший с их частью, их не маскирует.
    record.inspection = { ...record.inspection, mode: inspection.mode, source: inspection.source };
    if (parsed.success)
      record.findings = record.findings.map((f, i) => ({
        ...f,
        severity: parsed.data.findings[i]?.severity ?? f.severity,
      }));
    const log = join(dir, 'review.json');
    await writeFile(log, JSON.stringify(record, null, 2));
    // Находки с воспроизводимым входом — в реестр поручения, уже
    // замаскированными; наблюдение — только по журналу controller. Команда из
    // текста находки не исполняется.
    const reproductions = (record.findings ?? []).flatMap((f) => {
      // Наблюдение проставляет `observeReproductions` по журналу controller.
      const r: (typeof f.reproduction & { observed?: boolean }) | null | undefined = f.reproduction;
      if (!r) return [];
      return [
        {
          property: r.property,
          input: r.input,
          expected: r.expected,
          actual: r.actual,
          command: r.command,
          message: f.message.slice(0, 4000),
          claimed: r.executed,
          observed: r.observed === true,
          run: r.observed === true ? (r.run ?? null) : null,
        },
      ];
    });
    if (reproductions.length)
      this.engine.recordReproductions(attempt.id, attempt.token, sha, reproductions);
    const reason = !clean
      ? 'reviewer изменил дерево или HEAD'
      : issues.join('; ') || record.summary;
    this.engine.evidence(attempt.id, attempt.token, {
      kind: 'review',
      inspection: record.inspection,
      phase,
      sha,
      gate: 'independent-review',
      passed,
      command: [attempt.reviewer, 'review-code'],
      exitCode: passed ? 0 : 1,
      log,
      digest: sha256(JSON.stringify(record)),
      summary: redact(`[${inspection.mode}] ${passed ? record.summary : reason}`).slice(0, 4000),
      findings: (record.findings ?? []).map((f) => ({
        severity: f.severity,
        message: f.message,
        path: f.path ?? null,
        line: f.line ?? null,
      })),
    });
    if (!passed) {
      // Свойство находки — только объявленное поручением; свободная строка
      // reviewer сохраняется для разбора, но эпизод не открывает.
      const named = (parsed.success ? parsed.data.findings : [])
        .map((f) => f.reproduction?.property)
        .filter((p): p is string => !!p);
      const declared = new Set(work.order.properties ?? []);
      throw new TaskFailure(
        'review',
        'Независимое ревью отклонило результат: ' + redact(reason),
        named.length
          ? {
              bound: [...new Set(named.filter((p) => declared.has(p)))],
              unbound: [...new Set(named.filter((p) => !declared.has(p)))],
            }
          : undefined,
      );
    }
  }

  /**
   * Обязательный корпус попытки (первые 20 случаев) и — исполнителю —
   * решение разбора ведущего, под которым выдан повтор.
   */
  /**
   * Самопроверка исполнителя для поручения со свойствами: закреплённый checker,
   * полный корпус версии попытки и seed. Диагностика: gates от неё не зависят.
   */
  private async prepareSelfCheck(attempt: AttemptState, repo: Repo, dir: string) {
    const input = this.engine.read((v) => {
      const work = v.work(attempt.workId)!;
      const corpus = attempt.checks?.corpus
        ? this.corpus.snapshot(v, attempt.checks.corpus)
        : undefined;
      return {
        order: work.order,
        contracts: contractDocuments(work.order, v),
        ...(corpus ? { corpus: { content: corpus.content, cases: corpus.cases.length } } : {}),
      };
    });
    const plan = await writeSelfCheck({
      ...input,
      gates: repo.gates,
      dir,
      seed: propertySeed(attempt.id, 'self', attempt.workId),
    });
    if (plan) this.selfChecks.set(attempt.id, { dir, plan });
  }

  /** Сведения хоста в запросе: данные, а не правила приёмки. */
  private async hostNotes(work: WorkState, attempt: AttemptState, review: boolean) {
    return (await this.options.hooks?.notes?.({ work, attempt, review })) ?? [];
  }

  private notes(attempt: AttemptState, review: boolean, sha?: string) {
    const reproductions = this.engine.reproductions(attempt.workId);
    return this.engine.read((v) => {
      const out: string[] = [];
      // Воспроизведения прошлых ревью — входы, на которых поручение уже
      // ломалось. Диагностика: gate они не расширяют.
      if (reproductions.length)
        out.push(
          'Reproductions recorded by earlier reviews of this work order (diagnostic, not a gate; "observed" means the controller saw the reviewer run the command). Check the change against each input: ' +
            JSON.stringify(
              reproductions
                .slice(-20)
                .map(({ property, input, expected, actual, command, observed, runs }) => ({
                  property,
                  input,
                  expected,
                  actual,
                  command,
                  observed,
                  seen: runs.length,
                })),
            ),
        );
      // Согласованные контракты поручения — их текстом, по закреплённому digest.
      const contracts = contractDocuments(v.work(attempt.workId)!.order, v);
      if (contracts.length)
        out.push(
          'Approved contracts: ' +
            JSON.stringify(
              contracts.map((c) => ({ id: c.id, title: c.title, content: c.content })),
            ),
        );
      if (review)
        out.push(
          'When a finding fails on a concrete input, fill reproduction: property (the testId or acceptance criterion it violates), input (the exact input as JSON text), expected and actual, and command (argv) that shows it. If you ran it through the controller check tool, set run to the runId it returned and executed=true; the controller confirms the run from its own log and records the command that actually ran. Otherwise run=null and it is a hypothesis. Use null for findings without such an input.',
        );
      // Reviewer видит, что controller сам записал о проверяемом SHA: gates и
      // их итоги, а не пересказ исполнителя.
      if (review && sha) {
        const evidence = (v.attempt(attempt.id)?.evidence ?? []).filter(
          (e) => e.sha === sha && e.kind !== 'review',
        );
        out.push(
          'Evidence the controller recorded for the review commit (gate, phase, passed, summary): ' +
            JSON.stringify(
              evidence.map((e) => ({
                gate: e.gate,
                phase: e.phase,
                passed: e.passed,
                summary: e.summary,
                ...(e.consumer ? { consumer: e.consumer } : {}),
              })),
            ),
          'Where a requirement names a testId, open that test. Reject it when the test does not exercise the stated scenario, or when it would still pass if the behaviour it claims to prove were broken. A matching name is not proof.',
        );
      }
      const r = v.work(attempt.workId)?.recovery;
      if (!review && r?.decision && r.status === 'retrying' && r.retryRun === attempt.id) {
        const d = r.decision;
        const source = `${d.source.kind}${d.source.runtime ? ' (' + d.source.runtime + ')' : ''}, recovery ${r.id}`;
        out.push(
          d.action === 'new-approach'
            ? `Lead decision after two failures on property ${r.property} (source: ${source}): change the implementation approach. Hypothesis: ${d.hypothesis}. Verification plan: ${d.plan}. Reason: ${d.reason}`
            : `Lead decision after two failures on property ${r.property} (source: ${source}): confirmed cases were added to the mandatory corpus. Reason: ${d.reason}. Fix the class of defect, not only these inputs.`,
        );
      }
      const self = this.selfChecks.get(attempt.id);
      if (!review && self) out.push(selfCheckNote(self.plan));
      const binding = attempt.checks?.corpus;
      if (binding) {
        const suite = this.corpus.get(v, binding.suite);
        const version = suite.versions.find((x) => x.digest === binding.digest)!;
        out.push(
          `Mandatory corpus ${suite.id} version ${version.number} (sha256 ${version.digest}): ${version.cases.length} cases confirmed by the pinned oracle on defective commits. They are part of the gate and run before review on both phases.${version.cases.length > 20 ? ' First 20 shown.' : ''} Cases: ` +
            JSON.stringify(
              version.cases.slice(0, 20).map((id) => {
                const c = suite.cases[id]!;
                return { id, property: c.property, input: c.input, expected: c.expected };
              }),
            ),
        );
      }
      return out;
    });
  }

  /**
   * Ограниченный эксперимент выполнимости тяжёлого обязательства: команда на
   * закреплённом SHA под изоляцией gates, с пределом времени на размер.
   */
  spike(raw: unknown) {
    return runSpike(
      {
        engine: this.engine,
        policy: this.policy,
        stateDir: this.options.stateDir,
        repoPath: (repo) => this.repoPath(repo),
        boundary: () => this.boundary(),
        ...(this.options.environment ? { environment: this.options.environment } : {}),
      },
      raw,
    );
  }

  /**
   * Подтвердить пример закреплённым эталоном (быстрый маршрут корпуса). Ни
   * команда воспроизведения, ни данные входа не исполняются.
   */
  submitCase(raw: unknown) {
    return submitCase(
      {
        corpus: this.corpus,
        policy: this.policy,
        stateDir: this.options.stateDir,
        repoPath: (repo) => this.repoPath(repo),
        boundary: () => this.boundary(),
        ...(this.options.environment ? { environment: this.options.environment } : {}),
      },
      raw,
    );
  }

  /**
   * Воспроизведения из отклонившего ревью попытки по объявленным свойствам —
   * на подтверждение эталоном. Не больше пяти; отказ одного не мешает другим.
   */
  private async confirmReproductions(attempt: AttemptState) {
    const { work, reviews } = this.engine.read((v) => ({
      work: v.work(attempt.workId)!,
      reviews: v.attempt(attempt.id)!.evidence.filter((e) => e.kind === 'review' && !e.passed),
    }));
    const declared = new Set(work.order.properties ?? []);
    if (!declared.size) return;
    const items: {
      sha: string;
      reproduction: NonNullable<ReviewResult['findings'][number]['reproduction']>;
    }[] = [];
    for (const e of reviews) {
      const saved = reviewResultSchema.safeParse(
        JSON.parse(await readFile(e.log, 'utf8').catch(() => 'null')),
      );
      if (!saved.success) continue;
      for (const f of saved.data.findings)
        if (f.reproduction?.property && declared.has(f.reproduction.property))
          items.push({ sha: e.sha, reproduction: f.reproduction });
    }
    for (const item of items.slice(0, 5))
      try {
        await this.submitCase({
          workId: work.id,
          property: item.reproduction.property!,
          input: item.reproduction.input,
          expected: item.reproduction.expected,
          actual: item.reproduction.actual,
          sourceRunId: attempt.id,
          sourceSha: item.sha,
          // Ключ — по предмету примера: тот же пример из следующей попытки
          // возвращает прежнее решение, а не второе подтверждение.
          key: `rep-${digestOf([work.id, item.reproduction.property, item.reproduction.input]).slice(0, 40)}`,
          origin: 'review',
          runtime: attempt.reviewer,
        });
      } catch {
        // Пример остаётся в артефакте ревью; эталон решит при следующем отказе.
      }
  }

  private async integrate(
    attempt: AttemptState,
    work: WorkState,
    repo: Repo,
    cwd: string,
    worktrees: string[],
    artifacts: string,
    signal: AbortSignal,
    context?: ContextSnapshot,
    /** Новый предел фазы: ревью интеграции не получает остаток времени её проверок. */
    rearm: () => void = () => {},
  ) {
    this.engine.heartbeat(attempt.id, attempt.token);
    signal.throwIfAborted();
    const repoPath = this.repoPath(repo);
    await this.assertTargetDetached(repo);
    const base = await git(repoPath, 'rev-parse', repo.targetRef);
    await git(repoPath, 'worktree', 'add', '--detach', cwd, base);
    worktrees.push(cwd);
    try {
      await git(
        cwd,
        '-c',
        'core.hooksPath=/dev/null',
        'merge',
        '--no-ff',
        '--no-edit',
        '--no-gpg-sign',
        attempt.candidateSha!,
      );
    } catch (error) {
      throw new TaskFailure('merge', error instanceof Error ? error.message : String(error));
    }
    const sha = await git(cwd, 'rev-parse', 'HEAD');
    this.engine.phase(attempt.id, attempt.token, 'integrating', { integrationSha: sha });
    const gates = ordered(repo.gates, attempt.requiredGates ?? repo.gates.map((g) => g.id));
    const execution = this.environment(attempt, 'integration', cwd);
    await withEnvironment(
      repo.lifecycle ?? this.policy.lifecycle,
      cwd,
      join(artifacts, 'integration', 'environment'),
      execution,
      signal,
      async () => {
        await runSteps(
          repo.prepare,
          cwd,
          join(artifacts, 'integration', 'prepare'),
          execution,
          signal,
        );
        for (const gate of gates)
          await this.gate(attempt, cwd, sha, 'integration', gate, artifacts, signal, execution);
        await this.consumers(attempt, cwd, sha, artifacts, signal);
        this.requirements(attempt, work, repoPath, cwd, sha, 'integration');
        rearm();
        await this.review(
          attempt,
          work,
          cwd,
          attempt.baseSha!,
          sha,
          'integration',
          artifacts,
          signal,
          context,
        );
      },
      (stage, action) => this.timed(attempt, 'integration-environment:' + stage, action),
    );
    if (
      (await git(cwd, 'rev-parse', 'HEAD')) !== sha ||
      (await git(cwd, 'status', '--porcelain', '--untracked-files=no'))
    )
      throw new Error('Очистка окружения изменила проверенный код');
    await assertDependencies(attempt.dependencies ?? []);
    // Свежесть снимка зависимостей — фиксируется, не отклоняет: параллельная
    // работа законно двигает ветки зависимостей.
    if (attempt.dependencies?.length)
      this.engine.dependencyFreshness(
        attempt.id,
        attempt.token,
        await dependencyFreshness(this.repositories(), attempt.dependencies),
      );
    signal.throwIfAborted();
    await this.assertTargetDetached(repo);
    // Fencing, CAS продвижения и приёмка — одна транзакция. Если процесс упадёт
    // после update-ref, recovery сверит сохранённые evidence до приёмки.
    try {
      this.engine.finish(attempt.id, attempt.token, sha, () => {
        // Источник требований мог измениться, пока шли проверки и ревью:
        // актуальность — непосредственно перед продвижением target.
        if (work.order.requirements.length) assertRequirements(work.order, repoPath);
        // Внутри транзакции: без hooks репозитория (они исполнили бы чужой код
        // под блокировкой записи) и с конечным пределом, короче lease.
        execFileSync(
          'git',
          ['-c', 'core.hooksPath=/dev/null', 'update-ref', repo.targetRef, sha, base],
          { cwd: repoPath, stdio: 'pipe', timeout: Runner.refTimeoutMs },
        );
      });
    } catch (error) {
      const text =
        error instanceof Error
          ? error.message + String((error as { stderr?: Buffer | string }).stderr ?? '')
          : String(error);
      if (/cannot lock ref|is at .* but expected|reference already exists/i.test(text))
        throw new TaskFailure(
          'stale-base',
          `Целевая ветка ${repo.targetRef} продвинулась после интеграции; повтор начнётся от актуальной базы`,
        );
      throw error;
    }
  }
}

/** Рабочие деревья (с их checkout) и снимки зависимостей, которые ещё нужно убрать. */
interface Retained {
  worktrees: { checkout: string; dir: string }[];
  snapshots: DependencySnapshot[];
}

/** Сохранённые receipt окружений попытки (`environment.json`) в её артефактах. */
async function receipts(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await receipts(path)));
    else if (entry.name === 'environment.json') out.push(path);
  }
  return out;
}
