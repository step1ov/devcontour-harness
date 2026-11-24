import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  executionDigest,
  API_VERSION,
  HarnessError,
  WORKSPACE_OWNER,
  contextDigest,
  contextDigestMatches,
  canonicalContext,
  canonicalContextDigest,
  contextChanges,
  contextChangeText,
  contextIssues,
  digestOf,
  workGraphDigest,
  planContentDigest,
  type Author,
  type ContextSnapshot,
  type ContractDocument,
  type ReviewDisposition,
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
  type AttemptState,
  INPUT_SOURCE_KIND,
  latestAnswer,
  strictSandbox,
} from '../contracts/index.ts';
import { inputContextSource, withInput, type InputMessageRef } from '../engine/input-requests.ts';
import { cliAdapter } from '../agents/cli-adapter.ts';
import { Engine } from '../engine/engine.ts';
import { runResult } from '../engine/result.ts';
import { repairDecision } from '../engine/repair.ts';
import { Runner, type RunnerHooks } from '../engine/runner.ts';
import { standaloneHost } from '../engine/standalone.ts';
import { HARNESS_VERSION } from '../package.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';
import { validateInputs } from '../validate.ts';
import { cleanupSmoke, SMOKE_RUN_ID, smokeRoots } from './smoke-cleanup.ts';
import { WorkflowQueue } from './workflow.ts';
import { deadUpdateLock, updateInProgress } from '../update/busy.ts';
import { statusOf } from './status.ts';
import {
  verificationLines,
  verificationRowLimit,
  verificationRows,
} from '../report/verification.ts';
import { acceptedTargets } from './target.ts';
import { planRoundEpoch, reviewRoundCap, technicalReview } from './review.ts';
import { reviewCode, type CodeReviewInput } from './review-code.ts';
import { reviewRelease, type ReleaseReviewInput } from './review-release.ts';
import { releaseReviewState } from './release-review-state.ts';
import { lifecyclePreflight } from './preflight.ts';
import { policySourceChanged, type PolicySource } from './provenance.ts';
import { JointRunner } from '../engine/joint-runner.ts';
import { git, hostGitArgs } from '../environment/process.ts';
import { analyzeRecovery, applyCases } from './recovery.ts';
import { declarationProblems, referenceNote } from '../verification/checks.ts';
import { spikeOf, spikesOf } from '../verification/spike.ts';
import { staleArtifacts } from '../verification/confirm.ts';
import { processListBackend } from '../verification/gates.ts';
import { collectReportInput } from './report.ts';
import { valueReport, type ValueReportOptions } from '../report/compute.ts';

export interface HarnessOptions {
  /** Каталог состояния исполнения: база, worktrees, артефакты. */
  stateDir: string;
  /**
   * Каталог установки пакетов harness (`harness update --prefix`): его замок
   * обновления (общий для нескольких каталогов состояния) тоже держит записи
   * библиотеки. Без него — только замок и записи `<state>-updates`.
   */
  installPrefix?: string;
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
   * Корень рабочих деревьев попыток и совместных проверок; без него —
   * `chooseCheckoutRoot` (кэш пользователя, если каталог состояния внутри
   * репозитория, иначе каталог состояния).
   */
  checkoutRoot?: string;
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
      // Обновление пакетов этого каталога состояния (замок, запись «идёт»):
      // записи библиотеки отказывают так же, как команды CLI.
      updateBusy: () => updateInProgress(options.stateDir, options.installPrefix),
      updaterGone: () => deadUpdateLock(options.stateDir),
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
      context: (work, attempt) => this.contextOf(work.graphId, attempt),
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.resourceDatabase ? { resourceDatabase: options.resourceDatabase } : {}),
      ...(options.hooks ? { hooks: options.hooks } : {}),
      ...(options.checkoutRoot ? { checkoutRoot: options.checkoutRoot } : {}),
    });
    this.joint = new JointRunner({
      engine: this.engine,
      stateDir: options.stateDir,
      baseDir: options.baseDir,
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.resourceDatabase ? { resourceDatabase: options.resourceDatabase } : {}),
      ...(options.checkoutRoot ? { checkoutRoot: options.checkoutRoot } : {}),
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
  async cleanup(runId: string) {
    // Запись smoke (`LS-…`, alpha.67): повтор teardown или сверка оставшейся
    // записи окружения, у которой дерева и ресурсов Docker уже нет.
    if (SMOKE_RUN_ID.test(runId))
      return cleanupSmoke({
        stateDir: this.options.stateDir,
        policy: this.policy,
        id: runId,
        roots: await smokeRoots(this.options.stateDir, this.runner.checkoutRoot().root),
        record: (id, payload) => this.engine.recordEnvironmentReconciled(id, payload),
      });
    return this.runner.finishCleanup(runId);
  }

  /** Убрать рабочие деревья закончившихся попыток; ветки и артефакты остаются. */
  cleanupWorktrees(options: { dryRun?: boolean } = {}) {
    return this.runner.cleanupWorktrees(options);
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
    return this.knownContext(graph.id, context);
  }

  /**
   * Входящий снимок в форме, которую harness исполняет (0.1.0-alpha.68):
   * уже записанный снимок (тот же digest) — как есть; снимок с тем же
   * содержанием, что у действующего согласования графа или последнего раунда
   * ревью его плана (в любом порядке источников; в том числе записанный
   * прежней версией), — тот записанный снимок; иначе — каноническая форма
   * (источники по ID). Так порядок источников не порождает новый digest, а
   * согласования, закрепления попыток и раунды прежних версий остаются
   * теми же байтами.
   */
  private knownContext(graphId: string, snapshot: ContextSnapshot): ContextSnapshot;
  private knownContext(
    graphId: string,
    snapshot: ContextSnapshot | undefined,
  ): ContextSnapshot | undefined;
  private knownContext(graphId: string, snapshot: ContextSnapshot | undefined) {
    if (!snapshot) return snapshot;
    const stored = (digest: string | null | undefined) =>
      digest
        ? this.engine.read((v) => v.local('context-snapshots', WORKSPACE_OWNER, digest))
        : undefined;
    // Сначала — снимок последнего раунда ревью плана и действующего
    // согласования: с ними сверяются продолжение и выдача (ревью r2).
    const canonical = canonicalContextDigest(snapshot);
    const candidates = [
      this.engine.reviews('plan', graphId).at(-1)?.contextDigest,
      this.engine.read((v) => v.graph(graphId)?.approval?.context?.digest),
    ];
    for (const digest of candidates) {
      const known = stored(digest);
      if (known && canonicalContextDigest(known) === canonical) return known;
    }
    if (stored(contextDigest(snapshot))) return snapshot;
    return canonicalContext(snapshot);
  }

  /**
   * Раунд технического ревью предмета (граф или контракт) с конкретным
   * digest. Тот же digest и автор, уже согласованные последним раундом, —
   * тот же раунд без вызова модели. Reviewer — по правилу вендора политики;
   * недопустимый автор — `REVIEWER_SAME_VENDOR` до вызова. Reviewer называет
   * состояние каждой прежней открытой находки; история не переписывается.
   */
  async review(
    input: (
      | { kind: 'plan'; graph: WorkGraph; context?: ContextSnapshot; author: Author }
      | { kind: 'contract'; contract: ContractDocument; author: Author }
    ) & {
      /**
       * Решения ведущего или оператора по открытым находкам последнего
       * раунда; применяются этим раундом (docs/review-protocol.md, §8).
       */
      dispositions?: ReviewDisposition[];
    },
  ) {
    // Во время обновления пакетов — отказ до вызова модели.
    this.engine.assertNotUpdating();
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
        input.kind === 'plan' && input.graph.orders.some((o) => o.kind === 'infra')
          ? 'Orders with kind "infra" write harness-owned infrastructure (bridges, gate wrappers, acceptance tests). Product orders of the same repository must depend on them. An infra order that lists gateChanges replaces the definition of an existing gate: approve it only if the order states what the new check proves and that it is not weaker than the old one.'
          : '',
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
      maxRounds: reviewRoundCap(this.policy),
      // Тот же план после одобренного раунда и доработка принятой работы —
      // не новые траты предела раундов (0.1.0-alpha.68).
      ...(input.kind === 'plan'
        ? ((since) => ({
            planDigest: planContentDigest(input.graph),
            ...(since ? { roundEpoch: since } : {}),
          }))(this.engine.read((v) => planRoundEpoch(v, subject)))
        : {}),
      ...(input.dispositions?.length ? { dispositions: input.dispositions } : {}),
      ...(this.options.environment ? { environment: this.options.environment } : {}),
    });
  }

  /**
   * Технический обзор уже написанной ветки (`harness review-code`): reviewer
   * по правилу ревью кода роли, diff merge-base(base, head)..head, только
   * чтение. Запись в `code-reviews` — наблюдение, не приёмка.
   */
  reviewCode(input: CodeReviewInput) {
    // Во время обновления пакетов — отказ до вызова модели.
    this.engine.assertNotUpdating();
    return reviewCode(
      {
        engine: this.engine,
        policy: this.policy,
        adapters: this.adapters,
        stateDir: this.options.stateDir,
        repoPath: (path) => this.repoPath(path),
        ...(this.options.checkoutRoot ? { checkoutRoot: this.options.checkoutRoot } : {}),
        ...(this.options.environment ? { environment: this.options.environment } : {}),
      },
      input,
    );
  }

  /**
   * Ревью выпуска (`harness review-release`, alpha.69): принятая цель против
   * договора выпуска; запись `code-reviews` с `kind: release`.
   */
  reviewRelease(input: ReleaseReviewInput) {
    this.engine.assertNotUpdating();
    return reviewRelease(
      {
        engine: this.engine,
        policy: this.policy,
        adapters: this.adapters,
        stateDir: this.options.stateDir,
        repoPath: (path) => this.repoPath(path),
        ...(this.options.checkoutRoot ? { checkoutRoot: this.options.checkoutRoot } : {}),
        ...(this.options.environment ? { environment: this.options.environment } : {}),
      },
      input,
    );
  }

  /** SHA target ref каждого репозитория политики; недоступный — без записи. */
  async targetHeads(): Promise<Record<string, string>> {
    const heads: Record<string, string> = {};
    for (const repo of this.policy.repositories) {
      const head = await git(
        this.repoPath(repo.path),
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${repo.targetRef}^{commit}`,
      ).catch(() => undefined);
      if (head) heads[repo.id] = head;
    }
    return heads;
  }

  /** Состояние ревью выпуска против текущих target ref (для status и view). */
  async releaseReview() {
    const heads = await this.targetHeads();
    return this.engine.read((v) => releaseReviewState(v, this.policy, heads));
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
    const current = executionDigest(this.policy);
    const before = graph.approval?.digest === digest && graph.policyDigest === current;
    // Тот же граф, другая политика — повторное согласование с записью, кто и
    // почему; новый раунд под текущей политикой согласуется обычным approve.
    const fresh = this.engine.reviews('plan', subject).at(-1)?.policyDigest === current;
    if (graph.approval?.digest === digest && !before && !fresh)
      throw new HarnessError(
        'APPROVAL_REQUIRED',
        'Граф согласован под прежней политикой: harness reapprove --by --reason (с записью), а после правки изоляции, сети или профилей — новый review-plan',
      );
    this.engine.approve(subject, 'operator', { bindContext: true });
    const at = this.engine.read((v) => v.graph(subject)!.approval!.at);
    return { subject, digest, at, changed: !before };
  }

  /**
   * Повторное согласование графа после правки политики (`harness reapprove`):
   * тот же digest графа, последний раунд ревью плана — прежний, а согласование
   * привязывается к текущей политике с записью, кто и почему (`approval.reapproval`,
   * событие `graph.approved`). Правки изоляции, сети и профилей инструментов
   * прежний раунд не покрывает — отказ `APPROVAL_REQUIRED` с требованием нового
   * `review-plan`. Действует в режиме политики (`approvalMode`): в режиме
   * `agent` последний раунд должен быть одобрен.
   */
  reapprove(subject: string, digest: string, input: { by: string; reason: string }) {
    const audit = { by: input.by.trim(), reason: input.reason.trim() };
    if (!audit.by || audit.by.length > 200)
      throw new HarnessError('INVALID_INPUT', 'by: от 1 до 200 знаков');
    if (audit.reason.length < 3 || audit.reason.length > 2000)
      throw new HarnessError('INVALID_INPUT', 'reason: от 3 до 2000 знаков');
    const graph = this.engine.read((v) => v.graph(subject));
    if (!graph) throw new HarnessError('NOT_FOUND', 'Граф не найден: ' + subject);
    if (graph.digest !== digest)
      throw new HarnessError('APPROVAL_STALE', 'Digest не совпадает с зарегистрированным графом');
    if (!graph.approval)
      throw new HarnessError(
        'APPROVAL_REQUIRED',
        'Граф ещё не согласован: повторное согласование — только после review-plan (и approve в режиме operator)',
      );
    // Повторное согласование — только того же графа: новый digest согласует
    // review-plan (и approve оператора), а не reapprove.
    if (graph.approval.digest !== digest)
      throw new HarnessError(
        'APPROVAL_REQUIRED',
        'Согласован другой digest графа: новый граф согласует review-plan (и approve в режиме operator), а не reapprove',
      );
    const previous = graph.policyDigest;
    const current = executionDigest(this.policy);
    if (graph.approval.digest === digest && previous === current)
      return {
        subject,
        digest,
        at: graph.approval.at,
        changed: false,
        policyDigest: current,
        previousPolicyDigest: previous,
      };
    // Повторное согласование держится на одобренном раунде в любом режиме:
    // смена approvalMode не превращает отклонённый раунд в согласование.
    const last = this.engine.reviews('plan', subject).at(-1);
    if (!last?.approved)
      throw new HarnessError(
        'REVIEW_REJECTED',
        'Последний раунд ревью плана не одобрил граф: reapprove держится только на одобренном раунде',
      );
    this.engine.approve(subject, this.policy.approvalMode, {
      bindContext: true,
      reapproval: audit,
    });
    const after = this.engine.read((v) => v.graph(subject)!.approval!);
    return {
      subject,
      digest,
      at: after.at,
      changed: true,
      policyDigest: current,
      previousPolicyDigest: previous,
      ...(after.reapproval ? { round: after.reapproval.round } : {}),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Работа                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Действующий контекст графа — снимок, связанный с его согласованием, а не
   * последний переданный: отклонённый или ещё не согласованный снимок не
   * исполняется.
   */
  private contextOf(graphId: string, attempt?: AttemptState): ContextSnapshot | undefined {
    // Попытка загружает снимок, закреплённый при выдаче: согласование,
    // сменившееся после claim, не подменяет её контекст.
    const pinned = attempt?.pinned?.contextDigest;
    const digest =
      pinned !== undefined
        ? pinned
        : this.engine.read((v) => v.graph(graphId)?.approval?.context?.digest);
    if (!digest) return undefined;
    return this.engine.read((v) => v.local('context-snapshots', WORKSPACE_OWNER, digest));
  }

  /* ---------------------------------------------------------------- */
  /* Вопросы исполнителя                                               */
  /* ---------------------------------------------------------------- */

  /** Запросы исполнителя: все или поручения. */
  inputRequests(filter: { workId?: string } = {}) {
    return this.engine.inputRequests(filter);
  }

  /** Запрос исполнителя по ID. */
  inputRequest(id: string) {
    return this.engine.inputRequest(id);
  }

  /** Записать ответ (новая версия); работу он не возобновляет. */
  answerInput(id: string, answer: Parameters<Engine['answerInput']>[1], expectedVersion: number) {
    return this.engine.answerInput(id, answer, expectedVersion);
  }

  /**
   * Снимок контекста с последним ответом на запрос: действующий снимок графа
   * плюс источник ответа (`input-answer`). Снимок сохраняется по digest, но
   * не активируется: дальше — review-plan с ним, `proposeTarget` и
   * `applyInput`. `messages` — сообщения обсуждения хоста, включённые в
   * manifest (ID, версия, digest).
   */
  inputContext(id: string, options: { messages?: InputMessageRef[] } = {}) {
    const request = this.engine.inputRequest(id);
    const answer = latestAnswer(request);
    if (!answer) throw new HarnessError('INPUT_REQUIRED', `На вопрос ${id} ещё нет ответа`);
    // Снимок с ответом нужен для продолжения (вопрос с ответом) или для
    // переноса ответа в новую редакцию (заменённый вопрос); у
    // неблокирующего запроса и закрытого без замены его нельзя ни применить,
    // ни согласовать.
    if (
      request.kind !== 'question' ||
      !request.blocking ||
      !['answered', 'superseded'].includes(request.lifecycle)
    )
      throw new HarnessError(
        'NOT_READY',
        `Запрос ${id} (${request.kind}, ${request.lifecycle}): снимок с ответом строится для вопроса в answered или заменённого (superseded)`,
      );
    const base = this.contextOf(request.graphId);
    const snapshot = this.knownContext(
      request.graphId,
      withInput(base, inputContextSource(request, answer, options.messages)),
    );
    const issues = contextIssues(snapshot);
    if (issues.length)
      throw new HarnessError('INVALID_INPUT', 'Снимок контекста: ' + issues.join('; '));
    const digest = contextDigest(snapshot);
    this.store.transact('run.context', (tx) =>
      tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
    );
    return { requestId: id, answerDigest: answer.digest, digest, snapshot };
  }

  /** Основание продолжения для снимка с ответом (только чтение). */
  proposeTarget(id: string, contextDigest: string | null) {
    return this.engine.proposeTarget(id, contextDigest);
  }

  /** Применить ответ одной транзакцией (см. `Engine.applyInput`); модель не вызывается. */
  applyInput(id: string, options: Parameters<Engine['applyInput']>[1]) {
    return this.engine.applyInput(id, options);
  }

  /** Основание переноса ответа заменённого вопроса (только чтение, см. `Engine.proposeCarry`). */
  proposeCarry(id: string, contextDigest: string) {
    return this.engine.proposeCarry(id, contextDigest);
  }

  /** Перенести ответ заменённого вопроса в согласование новой редакции (см. `Engine.carryInput`). */
  carryInput(id: string, options: Parameters<Engine['carryInput']>[1]) {
    return this.engine.carryInput(id, options);
  }

  /**
   * Раунд ревью плана для снимка с ответом: последний раунд уже одобрил этот
   * снимок под текущей политикой — он и используется (`reused`); иначе — новый
   * раунд `review` (автор обязателен; тот же digest и автор при одобренном
   * последнем раунде модель не вызывают). Отказ ревью — `REVIEW_REJECTED`.
   */
  private async reviewSnapshot(
    graphId: string,
    snapshot: ContextSnapshot,
    digest: string,
    author: Author | undefined,
  ) {
    const covered = this.engine.planRoundCovers(graphId, digest, snapshot);
    if ('round' in covered) return { round: covered.round, reviewed: 'reused' as const };
    if (!author)
      throw new HarnessError(
        'APPROVAL_REQUIRED',
        `Снимок с ответом ещё не покрыт ревью плана (${covered.reason}): повторите с --author <runtime ведущего> — harness проведёт review-plan сам`,
      );
    const graph = this.engine.read((v) => v.graph(graphId)?.graph);
    if (!graph) throw new HarnessError('NOT_FOUND', 'Граф не найден: ' + graphId);
    const record = await this.review({ kind: 'plan', graph, context: snapshot, author });
    if (!record.approved)
      throw new HarnessError(
        'REVIEW_REJECTED',
        `Ревью плана со снимком ответа не одобрило граф (раунд ${record.round}): ${record.summary}`,
      );
    return { round: record.round, reviewed: 'new' as const };
  }

  /**
   * От ответа до применения одним вызовом (`harness input-resolve`): снимок с
   * последним ответом (`inputContext`, хранится по digest — без файлов),
   * ревью плана с ним (`reviewSnapshot`), основание (`proposeTarget`) и
   * `applyInput` с точными версией, digest ответа и основания. Работа ушла из
   * исходной остановки — отказ `NOT_READY` с выходом `input-carry`. Правила
   * применения те же, что у `applyInput`: идущие попытки, исчерпанные попытки и
   * бюджет — `applied: false` с причиной.
   */
  async resolveInput(id: string, options: { author?: Author; reset?: { reason: string } } = {}) {
    // Во время обновления пакетов — отказ до вызова модели (как у CLI).
    this.engine.assertNotUpdating();
    // Применённый ответ, основание которого уже разошлось, — не «готово»:
    // перепроверка сейчас возвращает его в answered, и он применяется заново.
    const request = this.engine.refreshApplied(id);
    if (request.lifecycle === 'applied')
      return {
        requestId: id,
        applied: true as const,
        changed: false,
        lifecycle: request.lifecycle,
        ...(request.target?.contextDigest ? { contextDigest: request.target.contextDigest } : {}),
      };
    if (request.lifecycle === 'pending')
      throw new HarnessError('INPUT_REQUIRED', `На вопрос ${id} ещё нет ответа: input-answer`);
    if (request.lifecycle === 'superseded')
      throw new HarnessError(
        'NOT_READY',
        `Запрос ${id} заменён: перенос ответа — harness input-carry --request ${id}`,
      );
    if (request.lifecycle !== 'answered')
      throw new HarnessError('NOT_READY', `Запрос ${id} ${request.lifecycle}: применять нечего`);
    if (!this.engine.read((v) => this.engine.originHolds(v, request)))
      throw new HarnessError(
        'NOT_READY',
        `Работа ${request.workId} уже не в остановке вопроса ${id} (была другая попытка или новая редакция постановки): перенесите ответ — harness input-carry --request ${id} --reason <почему>`,
      );
    const ctx = this.inputContext(id);
    const review = await this.reviewSnapshot(
      request.graphId,
      ctx.snapshot,
      ctx.digest,
      options.author,
    );
    const proposed = this.proposeTarget(id, ctx.digest);
    if (!proposed.target)
      throw new HarnessError(
        'NOT_READY',
        'Основание не построено: ' + proposed.problems.join('; '),
      );
    const result = this.applyInput(id, {
      answerDigest: ctx.answerDigest,
      expectedVersion: proposed.request.version,
      contextDigest: ctx.digest,
      targetDigest: proposed.target.digest,
      actor: this.policy.approvalMode,
      ...(options.reset ? { reset: options.reset } : {}),
    });
    return {
      requestId: id,
      contextDigest: ctx.digest,
      reviewRound: review.round,
      reviewed: review.reviewed,
      ...result,
      lifecycle: result.request.lifecycle,
    };
  }

  /**
   * Перенос ответа одним вызовом (`harness input-carry`): вопрос, исходная
   * остановка которого больше не держится (была другая попытка, новая
   * редакция постановки), сначала заменяется преемником — той же работой — с
   * причиной; затем снимок с ответом, ревью плана с ним, основание
   * (`proposeCarry`) и `carryInput`. Применённый ответ, основание которого
   * устарело, и исходная остановка держится, — `input-resolve`, а не перенос.
   */
  async carryInputOf(
    id: string,
    options: {
      reason: string;
      author?: Author;
      reset?: { reason: string };
      /** Кто заменяет вопрос (запись `closed.by`); по умолчанию — ведущий. */
      by?: 'operator' | 'lead';
    },
  ) {
    this.engine.assertNotUpdating();
    let request = this.engine.inputRequest(id);
    if (request.kind !== 'question' || !request.blocking)
      throw new HarnessError('INVALID_INPUT', `Запрос ${id} неблокирующий: переносить нечего`);
    let superseded = false;
    if (request.lifecycle === 'answered') {
      if (this.engine.read((v) => this.engine.originHolds(v, request)))
        throw new HarnessError(
          'NOT_READY',
          `Исходная остановка вопроса ${id} держится: продолжение — harness input-resolve --request ${id}`,
        );
      // Замена — запись: до неё проверяется, что перенос можно довести до
      // конца без нового входа. Снимок заменённого вопроса — новый, раунда
      // ревью у него ещё нет: без --author дальше идти нечем.
      if (!options.author)
        throw new HarnessError(
          'APPROVAL_REQUIRED',
          `Перенос ответа на вопрос ${id} требует ревью плана со снимком ответа: повторите с --author <runtime ведущего>; вопрос не изменён`,
        );
      request = this.engine.supersedeInput(
        id,
        { by: options.by ?? 'lead', reason: options.reason, successor: request.workId },
        request.version,
      ).request;
      superseded = true;
    } else if (request.lifecycle === 'pending')
      throw new HarnessError('INPUT_REQUIRED', `На вопрос ${id} ещё нет ответа: input-answer`);
    else if (request.lifecycle !== 'superseded')
      throw new HarnessError('NOT_READY', `Запрос ${id} ${request.lifecycle}: переносить нечего`);
    const ctx = this.inputContext(id);
    let review: { round: number; reviewed: 'reused' | 'new' };
    try {
      review = await this.reviewSnapshot(request.graphId, ctx.snapshot, ctx.digest, options.author);
    } catch (error) {
      // Вопрос уже заменён этим вызовом: состояние названо, повтор продолжит перенос.
      if (superseded && error instanceof HarnessError)
        throw new HarnessError(
          error.code,
          `${error.message}. Вопрос ${id} уже заменён (superseded) этим вызовом: повтор input-carry продолжит перенос`,
        );
      throw error;
    }
    const proposed = this.proposeCarry(id, ctx.digest);
    if (!proposed.target)
      throw new HarnessError(
        'NOT_READY',
        'Основание не построено: ' + proposed.problems.join('; '),
      );
    const result = this.carryInput(id, {
      contextDigest: ctx.digest,
      actor: this.policy.approvalMode,
      expectedVersion: proposed.request.version,
      targetDigest: proposed.target.digest,
      ...(options.reset ? { reset: options.reset } : {}),
    });
    return {
      requestId: id,
      superseded,
      contextDigest: ctx.digest,
      reviewRound: review.round,
      reviewed: review.reviewed,
      ...result,
      lifecycle: result.request.lifecycle,
    };
  }

  /** Отменить вопрос: работа больше его не ждёт. */
  cancelInput(id: string, input: Parameters<Engine['cancelInput']>[1], expectedVersion: number) {
    return this.engine.cancelInput(id, input, expectedVersion);
  }

  /** Заменить вопрос преемником (изменение требований — новая ревизия). */
  supersedeInput(
    id: string,
    input: Parameters<Engine['supersedeInput']>[1],
    expectedVersion: number,
  ) {
    return this.engine.supersedeInput(id, input, expectedVersion);
  }

  /**
   * Контекст запуска с применёнными ответами: переданный снимок (или
   * отсутствие снимка) вместе с источниками применённых ответов действующего
   * согласования — это тот же действующий снимок, а не изменение контекста.
   * Иначе — переданный снимок с перенесёнными в него применёнными ответами
   * (новый снимок: новое ревью плана видит их вместе с правкой).
   */
  private withAppliedInputs(graphId: string, context: ContextSnapshot | undefined) {
    const approved = this.contextOf(graphId);
    if (!approved) return context;
    const applied = this.engine.read((v) =>
      approved.sources.filter(
        (s) =>
          s.kind === INPUT_SOURCE_KIND &&
          !this.engine.unappliedInputs(v, { ...approved, sources: [s] }).length,
      ),
    );
    if (!applied.length) return context;
    const carried = applied.reduce<ContextSnapshot | undefined>(
      (snapshot, entry) => withInput(snapshot, entry),
      context,
    );
    // Другой снимок (ведущий поправил контекст) применённые ответы не теряет:
    // они переносятся в него, и новый снимок проходит обычное ревью плана
    // вместе с ними — иначе правка контекста молча вернула бы ответ в
    // «ждёт применения».
    return carried && canonicalContextDigest(carried) === canonicalContextDigest(approved)
      ? approved
      : carried;
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
    // Пауза обновления, умершего до изменений (нет ни процесса, ни
    // незавершённого возврата), выдачу больше не держит: run её снимает.
    this.engine.clearStaleUpdatePause();
    // Удержание gate отказом `ps` снимается, когда список процессов в
    // песочнице стал доступен: проба (одна на процесс) — до выдачи.
    if (
      strictSandbox(this.policy) &&
      this.engine.read((v) => this.engine.environmentGateHolds(v)).length
    )
      await processListBackend.probe().catch(() => undefined);
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
    // Снимок с неприменённым ответом на вопрос исполнителя запуск не
    // активирует — до платного ревью: продолжение после ответа — applyInput.
    const incoming = this.knownContext(graph.id, input.context);
    const unapplied = this.engine.read((v) => this.engine.unappliedInputs(v, incoming));
    if (unapplied.length)
      throw new HarnessError(
        'INPUT_REQUIRED',
        'Снимок контекста содержит неприменённый ответ на вопрос исполнителя (' +
          unapplied.map((u) => u.requestId ?? u.source).join(', ') +
          '): review-plan со снимком, затем input-apply',
      );
    // Применённые ответы действующего согласования остаются в нём: запуск с
    // тем же снимком без них — не смена контекста.
    const context = this.knownContext(graph.id, this.withAppliedInputs(graph.id, incoming));
    // Снимок с новым ответом не активируется под идущими попытками графа —
    // отказ до платного ревью.
    const busy = this.engine.read((v) => this.engine.inputActivationRefusal(v, graph.id, context));
    if (busy) throw new HarnessError('NOT_READY', busy);
    // Согласование связано с контекстом, который видел reviewer плана: снимок
    // хранится по digest, но действующим становится только вместе с
    // согласованием. Другой снимок при том же графе требует нового раунда.
    // Окружение проекта — до ревью плана и первой попытки: отказ lifecycle,
    // prepare или хранилища не тратит ни одного платного вызова.
    if (this.policy.lifecyclePreflight === 'cached') {
      // Целевые ветки создаются до проверки (первый запуск); очередь выдаёт
      // работу всех графов, поэтому проверяются репозитории всех незавершённых.
      await this.runner.init();
      const pending = this.engine.read((v) =>
        v
          .works()
          .filter((w) => w.status !== 'done' && w.status !== 'cancelled')
          .map((w) => w.order.repositoryId),
      );
      await lifecyclePreflight({
        policy: this.policy,
        baseDir: this.options.baseDir,
        stateDir: this.options.stateDir,
        repositoryIds: pending,
        ...(this.options.resourceDatabase
          ? { resourceDatabase: this.options.resourceDatabase }
          : {}),
        ...(this.options.checkoutRoot ? { checkoutRoot: this.options.checkoutRoot } : {}),
        ...(this.options.environment ? { environment: this.options.environment } : {}),
      });
    }
    // Снимок сверяется по канонической форме и по digest прежних версий:
    // тот же контекст в другом порядке — не смена контекста.
    const contextChanged = !contextDigestMatches(graph.approval?.context?.digest ?? null, context);
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
          ...(context ? { context } : {}),
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
            (contextChanged
              ? ` (контекст изменился после ревью плана — ${contextChangeText(contextChanges(this.contextOf(graph.id), context))})`
              : ''),
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
      // Повтор по решению оператора — действие человека; по решению ведущего — восстановление.
      this.engine.retry(
        workId,
        undefined,
        r.decision?.source.kind === 'operator' ? 'operator' : 'recovery',
      );
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
        leadHold: (w) => this.engine.leadHoldOf(w, tx),
      });
      if (!decided || decided.action === 'stop') return decided;
      this.workflows.repair(job, `repair:${decided.kind}`, () => {
        this.engine.retry(decided.workId, undefined, 'recovery');
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

  /**
   * Состояние очереди, графов и поручений. С `detail` — ещё снимок
   * наблюдателя: почему стоит выдача (`queueStop` и `queuePause`) и активные
   * попытки (`attemptView`); без него ответ прежний. Та же функция над
   * движком и политикой хоста — `statusOf`.
   */
  status(graphId?: string, options: { detail?: boolean } = {}) {
    const data = statusOf(this, graphId, options);
    // Принятые работы против текущего target ref: что после приёмки не проверено.
    const accepted = this.engine.read((v) =>
      data.works.flatMap((w) => {
        const work = w.status === 'done' && w.resultSha ? v.work(w.id) : undefined;
        return work
          ? [{ id: w.id, repositoryId: work.order.repositoryId, acceptedSha: w.resultSha! }]
          : [];
      }),
    );
    if (!accepted.length) return data;
    const targets = acceptedTargets(this.policy, (p) => this.repoPath(p), accepted);
    return {
      ...data,
      works: data.works.map((w) => {
        const target = targets.get(w.id);
        return target ? { ...w, target } : w;
      }),
    };
  }

  /**
   * Отчёт об эффекте (`valueReport`) по состоянию этого каталога: только
   * чтение; пути evidence — относительно каталога состояния.
   */
  report(options: Omit<ValueReportOptions, 'stateDir' | 'harnessVersion'> = {}) {
    return valueReport(collectReportInput(this.store), {
      ...options,
      stateDir: resolve(this.options.stateDir),
      harnessVersion: HARNESS_VERSION,
    });
  }

  events(after = 0, limit = 100) {
    const events = this.store.events(after, Math.min(Math.max(limit, 1), 500));
    return { events, next: events.at(-1)?.seq ?? after };
  }

  /** Результат завершённой попытки поручения (последней или `runId`) и состояние его доставки. */
  result(workId: string, runId?: string): ResultEnvelope {
    const envelope = this.resultEnvelope(workId, runId);
    const { result } = envelope;
    if (result.outcome !== 'accepted' || !result.shas.result) return envelope;
    const target = acceptedTargets(this.policy, (p) => this.repoPath(p), [
      { id: workId, repositoryId: result.repositoryId, acceptedSha: result.shas.result },
    ]).get(workId);
    return target ? { ...envelope, target } : envelope;
  }

  private resultEnvelope(workId: string, runId?: string): ResultEnvelope {
    return this.engine.read((v) => {
      const work = v.work(workId);
      if (!work) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + workId);
      const all = v.attempts(workId);
      const attempt = all.filter((a) => a.status !== 'active' && (!runId || a.id === runId)).at(-1);
      if (!attempt)
        throw new HarnessError('NOT_FOUND', 'У поручения нет завершённой попытки: ' + workId);
      // Что проверено и как у попытки результата: записи её evidence.
      const rows = verificationRows(attempt);
      return {
        apiVersion: API_VERSION,
        result: runResult(
          attempt,
          HARNESS_VERSION,
          work.codeReviewDecisions,
          all.slice(0, all.indexOf(attempt) + 1),
        ),
        verification: {
          runId: attempt.id,
          rows: rows.slice(0, verificationRowLimit),
          ...(rows.length > verificationRowLimit
            ? { rowsTruncated: rows.length - verificationRowLimit }
            : {}),
          ...verificationLines(rows),
        },
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
  async deliver(
    workId: string,
    sink: ResultSink,
    /**
     * `runId` — результат этой попытки (по умолчанию последней завершённой);
     * `variant` — отдельная доставка того же результата (например,
     * повторное доказательство критериев `reprove-<digest>`): свой ключ, своя
     * запись, прежняя подтверждённая доставка не меняется.
     */
    options: { runId?: string; variant?: string } = {},
  ) {
    const envelope = this.result(workId, options.runId);
    const key = `${sink.id}:${options.variant ? options.variant + ':' : ''}${workId}:${envelope.result.runId}`;
    const prior = this.engine.read((v) => v.local('delivery', WORKSPACE_OWNER, key));
    if (prior?.status === 'delivered') return this.result(workId, options.runId);
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
    return this.result(workId, options.runId);
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
