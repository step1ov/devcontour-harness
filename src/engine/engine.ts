import { randomUUID } from 'node:crypto';
import {
  executionDigest,
  HarnessError,
  WORKSPACE_OWNER,
  digestOf,
  expandGateRefs,
  policyDigest,
  graphIssues,
  selectReviewer,
  workGraphDigest,
  type AttemptState,
  type Author,
  type CallRecord,
  type ContractDocument,
  type EvidenceRecord,
  type ExecutionHost,
  type ExecutionPolicy,
  type ExecutionTransaction,
  type ExecutionView,
  type FailureKind,
  type GraphState,
  type JointVerification,
  type JointVerificationState,
  type NotPromise,
  type Prerequisite,
  type PropertyRecovery,
  type ReviewRecord,
  type TechnicalApproval,
  type TransactionKind,
  type WorkGraph,
  type WorkState,
} from '../contracts/index.ts';
import { HARNESS_VERSION } from '../package.ts';
import {
  assertBudget,
  blockingBudget,
  budgetOverview,
  callAttribution,
  callBudgets,
  workBudgets,
  type BudgetContext,
  type CallMeta,
} from './budget.ts';
import { callDurationMs, callOwner, callRecords, ownerGone } from './usage.ts';
import { failureFingerprint, repairPolicy } from './failure.ts';
import { reusableImplementation } from './reuse.ts';
import { unprovenReason } from '../verification/proof.ts';
import {
  contractDocuments,
  effectiveChecks,
  episodeBasis,
  orderPropertyProblems,
} from '../verification/checks.ts';
import {
  afterFailure,
  afterSuccess,
  blocksClaim,
  closeIfBasisChanged,
} from './property-recovery.ts';
import { REQUIREMENT_GATE } from '../verification/requirements.ts';
import {
  jointImpact,
  jointPolicyDigest,
  jointSpecDigest,
  publicJoint,
  sameWorks,
} from '../verification/joint.ts';

/** Префикс причины неудавшегося продления: первая причина не затирается следствиями. */
export const HEARTBEAT_FAILED = 'Продление владения не удалось';

export interface EngineOptions {
  host: ExecutionHost;
  policy: ExecutionPolicy;
  /** Версия движка в попытках; по умолчанию — версия пакета. */
  version?: string;
  now?: () => number;
  id?: () => string;
  /**
   * Источник политики не менялся с её загрузки: `undefined` — да, иначе
   * причина. Без источника (политика передана объектом) право записать свою
   * политику как применённую ограничено остальными условиями.
   */
  provenance?: () => string | undefined;
}

export type Phase = 'running' | 'verifying' | 'reviewing' | 'integrating';

const iso = (ms: number) => new Date(ms).toISOString();

/** Содержание поручения без номера редакции источника: одинаковое содержание — та же работа. */
const contentDigest = (order: WorkState['order']) =>
  digestOf({ ...order, source: { connector: order.source.connector, ref: order.source.ref } });

/**
 * Правила исполнения и технической приёмки. Все решения — внутри одной
 * транзакции хранилища: состояние, на котором решение принято, и запись
 * решения неразделимы. Хост может только добавить запрет (`HostGuards`) и
 * дать основания (`BasisProvider`); снять отказ движка он не может.
 */
export class Engine {
  readonly host: ExecutionHost;
  readonly policy: ExecutionPolicy;
  readonly version: string;
  private readonly now: () => number;
  private readonly id: () => string;
  /** Digest политики процесса на момент создания движка. */
  readonly loadedPolicy: string;
  /** Поколение применённой политики, которое процесс застал при запуске. */
  private readonly observedGeneration: number;
  private readonly provenance: () => string | undefined;
  /** Владелец роли controller, под которым этот процесс её получил. */
  private ownLeader?: string;

  constructor(options: EngineOptions) {
    this.host = options.host;
    this.policy = options.policy;
    this.version = options.version ?? HARNESS_VERSION;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.provenance = options.provenance ?? (() => undefined);
    this.loadedPolicy = policyDigest(this.policy);
    this.observedGeneration = this.host.store.read(
      (v) => v.control().appliedPolicy?.generation ?? 0,
    );
  }

  /** Часы движка: по ним считаются сроки владения. */
  clock() {
    return this.now();
  }

  private tx<T>(kind: TransactionKind, fn: (tx: ExecutionTransaction) => NotPromise<T>): T {
    return this.host.store.transact(kind, fn);
  }
  private repository(id: string) {
    const repo = this.policy.repositories.find((r) => r.id === id);
    if (!repo) throw new HarnessError('INVALID_INPUT', 'Репозиторий не объявлен: ' + id);
    return repo;
  }

  read<T>(fn: (view: ExecutionView) => NotPromise<T>): T {
    return this.host.store.read(fn);
  }

  /* ---------------------------------------------------------------- */
  /* Граф и согласование                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Регистрация графа. Повтор той же редакции источника с тем же digest —
   * продолжение прежней работы; другой digest той же редакции или того же
   * ID графа — `REVISION_CONFLICT`. Предпосылки должны быть подтверждены:
   * `engine` — успешной попыткой этого хранилища с тем же result SHA,
   * `trusted` — решением источника (`trusted`), переданным вызывающим вместе
   * с проверкой доступности SHA в target ref (`reachable`).
   */
  register(
    graph: WorkGraph,
    prerequisites: {
      trusted: (p: Prerequisite) => boolean;
      reachable: (p: Prerequisite) => boolean;
    },
  ): { graph: GraphState; resumed: boolean; replaced?: boolean } {
    const issues = graphIssues(graph);
    if (issues.length)
      throw new HarnessError(
        issues[0]!.code as 'GRAPH_CYCLE',
        `Граф отклонён: ${issues.length} нарушений`,
        issues.map(({ path, message }) => ({ path: ['graph', ...path], message })),
      );
    const digest = workGraphDigest(graph);
    const key = digestOf([graph.source.connector, graph.source.ref, graph.source.revision]);
    return this.tx('graph.registered', (tx) => {
      const known = tx.local('run-keys', WORKSPACE_OWNER, key);
      const existing = tx.graph(graph.id);
      if (known && known.digest !== digest)
        throw new HarnessError(
          'REVISION_CONFLICT',
          `Редакция ${graph.source.revision} источника ${graph.source.ref} уже зарегистрирована с другим содержанием`,
        );
      if (existing?.digest === digest) return { graph: existing, resumed: true };
      // Новая редакция графа заменяет прежнюю, только пока у него нет активных
      // попыток. Принятые поручения с неизменной постановкой остаются принятыми;
      // изменённые и новые — черновики до нового согласования; история попыток
      // не переписывается.
      if (existing && tx.works(graph.id).some((w) => w.activeRunId))
        throw new HarnessError(
          'REVISION_CONFLICT',
          `У графа ${graph.id} есть активные попытки; новая редакция подождёт их`,
        );
      for (const p of graph.prerequisites) {
        const ok =
          p.receipt.kind === 'engine'
            ? tx
                .attempts()
                .some(
                  (a) =>
                    a.id === (p.receipt as { runId: string }).runId &&
                    a.status === 'succeeded' &&
                    a.integrationSha === p.resultSha,
                )
            : prerequisites.trusted(p);
        if (!ok || !prerequisites.reachable(p))
          throw new HarnessError(
            'NOT_READY',
            `Предпосылка ${p.id} не подтверждена: нужен результат движка или доверенный receipt с доступным SHA`,
          );
      }
      const at = iso(this.now());
      const state: GraphState = {
        id: graph.id,
        digest,
        graph,
        policyDigest: executionDigest(this.policy),
        registeredAt: at,
      };
      tx.putGraph(state);
      for (const order of graph.orders) {
        const prior = tx.work(order.id);
        if (prior && prior.graphId !== graph.id)
          throw new HarnessError(
            'REVISION_CONFLICT',
            `Поручение ${order.id} уже принадлежит другому графу`,
          );
        if (prior?.status === 'done' && contentDigest(prior.order) === contentDigest(order))
          continue;
        // Принятая версия корпуса остаётся за поручением, пока оно ссылается на
        // её контракт; эпизод восстановления и его история — тоже: закрывает их
        // согласование нового основания, а не новая редакция источника.
        const corpus =
          prior?.checkVersion &&
          order.contracts.some((c) => 'KS-' + c.id === prior.checkVersion!.suite)
            ? prior.checkVersion
            : undefined;
        tx.putWork({
          id: order.id,
          graphId: graph.id,
          order,
          status: 'draft',
          attempt: prior?.attempt ?? 0,
          ...(corpus ? { checkVersion: corpus } : {}),
          ...(prior?.recovery ? { recovery: prior.recovery } : {}),
          ...(prior?.recoveryHistory ? { recoveryHistory: prior.recoveryHistory } : {}),
        });
      }
      for (const prior of existing ? tx.works(graph.id) : [])
        if (!graph.orders.some((o) => o.id === prior.id) && prior.status !== 'done')
          tx.putWork({ ...prior, status: 'cancelled', activeRunId: undefined });
      tx.putLocal('run-keys', WORKSPACE_OWNER, key, { graphId: graph.id, digest, at });
      tx.emit({
        type: 'graph.registered',
        graphId: graph.id,
        payload: { digest, orders: graph.orders.length, source: graph.source },
      });
      return { graph: state, resumed: false, replaced: Boolean(existing) };
    });
  }

  /** Раунд технического ревью плана или контракта сохраняется в истории предмета. */
  /**
   * `document` — документ контракта, который ревью рассматривало: он
   * сохраняется по своему digest, и из него движок берёт договор проверки.
   */
  recordReview(record: ReviewRecord, document?: ContractDocument) {
    if (document && (record.kind !== 'contract' || digestOf(document) !== record.digest))
      throw new HarnessError('INVALID_INPUT', 'Документ не соответствует ревью контракта');
    return this.tx('graph.reviewed', (tx) => {
      if (document) tx.putLocal('contract-documents', WORKSPACE_OWNER, record.digest, document);
      const previous = tx
        .locals('reviews', WORKSPACE_OWNER)
        .map((r) => r.value)
        .filter((r) => r.kind === record.kind && r.subject === record.subject);
      if (record.round !== previous.length + 1)
        throw new HarnessError(
          'INVALID_INPUT',
          `Раунд ${record.round} не следует за ${previous.length}`,
        );
      tx.putLocal('reviews', WORKSPACE_OWNER, record.id, record);
      tx.emit({
        type: 'graph.reviewed',
        graphId: record.kind === 'plan' ? record.subject : undefined,
        payload: {
          kind: record.kind,
          subject: record.subject,
          digest: record.digest,
          round: record.round,
          approved: record.approved,
          open: record.findings.filter((f) => f.status === 'open').length,
        },
      });
      return record;
    });
  }

  reviews(kind: 'plan' | 'contract', subject: string): ReviewRecord[] {
    return this.read((v) =>
      v
        .locals('reviews', WORKSPACE_OWNER)
        .map((r) => r.value)
        .filter((r) => r.kind === kind && r.subject === subject)
        .sort((a, b) => a.round - b.round),
    );
  }

  /**
   * Digest назначения reviewer вида `kind` для автора по текущей политике:
   * runtime, модель, effort, содержимое профиля и правило вендора. Раунд ревью
   * подтверждает предмет только при том же назначении.
   */
  reviewerBinding(kind: 'plan' | 'contract' | 'code', author: Author): string | undefined {
    const choice = selectReviewer(this.policy, kind, { runtime: author });
    if (!choice.ok) return undefined;
    // Содержимое профиля, а не только его имя: другой набор инструментов —
    // другое назначение.
    const profile = choice.reviewer.toolProfile;
    return digestOf({
      reviewer: choice.reviewer,
      vendor: this.policy.review[kind].vendor,
      ...(profile ? { tools: this.policy.toolProfiles[profile] ?? null } : {}),
    });
  }

  /**
   * Контракты поручения: последний раунд ревью каждого контракта — его digest,
   * одобрен, при текущем назначении reviewer. Иначе поручение не выдаётся и не
   * принимается.
   */
  contractBlocker(work: WorkState, view: ExecutionView): string | undefined {
    for (const ref of work.order.contracts) {
      const last = view
        .locals('reviews', WORKSPACE_OWNER)
        .map((r) => r.value)
        .filter((r) => r.kind === 'contract' && r.subject === ref.id)
        .sort((a, b) => a.round - b.round)
        .at(-1);
      if (!last) return `Контракт ${ref.id} не проходил технического ревью`;
      if (last.digest !== ref.digest)
        return `Контракт ${ref.id}: последнее ревью относится к другому digest`;
      if (!last.approved) return `Контракт ${ref.id}: последний раунд ревью не одобрил его`;
      if (last.reviewerBinding !== this.reviewerBinding('contract', last.authorRuntime))
        return `Контракт ${ref.id}: ревью проведено при другом назначении reviewer`;
    }
    return undefined;
  }

  /**
   * Согласование графа. Привязано к digest проверенного предложения: в
   * режиме `agent` нужен одобренный последний раунд ревью этого digest, в
   * режиме `operator` — проведённое ревью этого digest и решение оператора.
   * Другого способа сделать поручения готовыми к выдаче нет.
   */
  approve(graphId: string, actor: TechnicalApproval['actor']) {
    return this.tx('graph.approved', (tx) => {
      this.assertCurrentPolicy(tx);
      const graph = tx.graph(graphId);
      if (!graph) throw new HarnessError('NOT_FOUND', 'Граф не найден: ' + graphId);
      if (actor !== this.policy.approvalMode)
        throw new HarnessError(
          'APPROVAL_REQUIRED',
          `Политика требует согласования ${this.policy.approvalMode === 'operator' ? 'оператором' : 'агентом-ревьюером'}`,
        );
      const rounds = tx
        .locals('reviews', WORKSPACE_OWNER)
        .map((r) => r.value)
        .filter((r) => r.kind === 'plan' && r.subject === graphId)
        .sort((a, b) => a.round - b.round);
      const last = rounds.at(-1);
      if (!last || last.digest !== graph.digest)
        throw new HarnessError('APPROVAL_REQUIRED', 'Нет ревью плана для текущего digest графа');
      if (actor === 'agent' && !last.approved)
        throw new HarnessError('REVIEW_REJECTED', 'Последний раунд ревью плана не одобрил граф');
      if (last.reviewerBinding !== this.reviewerBinding('plan', last.authorRuntime))
        throw new HarnessError(
          'APPROVAL_REQUIRED',
          'Ревью плана проведено при другом назначении reviewer; нужен новый раунд',
        );
      // Свойства поручений существуют в их договорах проверки и исполняются
      // их генеративными gates: иначе ожидаемая проверка не определена.
      const problems = tx.works(graphId).flatMap((w) => {
        const repo = this.repository(w.order.repositoryId);
        return orderPropertyProblems(w.order, contractDocuments(w.order, tx), {
          configured: repo.gates,
          ...(w.order.gates ? { scope: expandGateRefs(repo, w.order.gates) } : {}),
        });
      });
      if (problems.length)
        throw new HarnessError(
          'INVALID_INPUT',
          'Договор проверки поручений не согласован: ' + problems.join('; '),
        );
      const policy = executionDigest(this.policy);
      if (graph.approval?.digest === graph.digest && graph.policyDigest === policy)
        return { graph, changed: false };
      const at = iso(this.now());
      const approval: TechnicalApproval = {
        actor,
        digest: graph.digest,
        authorRuntime: last.authorRuntime === 'external' ? undefined : last.authorRuntime,
        reviewerRuntime: last.reviewerRuntime,
        artifact: last.artifact,
      };
      tx.putGraph({ ...graph, policyDigest: policy, approval: { ...approval, at } });
      tx.emit({ type: 'graph.approved', graphId, payload: { digest: graph.digest, actor } });
      for (const work of tx.works(graphId)) {
        if (work.status !== 'draft') continue;
        const ready: WorkState = structuredClone({
          ...work,
          status: 'ready' as const,
          approvedAt: at,
          approvedDigest: this.host.basis.orderDigest(work, tx),
          approvedScope: this.host.basis.scopeDigest(work, tx),
          approval,
        });
        if (closeIfBasisChanged(ready, at))
          this.recoveryEvent(tx, ready, ready.recoveryHistory!.at(-1)!);
        tx.putWork(ready);
        tx.emit({
          type: 'work.ready',
          graphId,
          workId: work.id,
          payload: { orderDigest: ready.approvedDigest! },
        });
      }
      return { graph: tx.graph(graphId)!, changed: true };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Controller и очередь                                              */
  /* ---------------------------------------------------------------- */

  /** Захват или продление роли единственного controller. */
  lead(owner: string): boolean {
    let acquired = false;
    const result = this.tx('heartbeat', (tx) => {
      const lease = tx.controller();
      if (lease && lease.owner !== owner && lease.leaseUntil > this.now()) return false;
      acquired = !lease || lease.owner !== owner || lease.leaseUntil <= this.now();
      tx.setController({ owner, leaseUntil: this.now() + this.policy.leaseMs });
      return true;
    });
    if (result) this.ownLeader = owner;
    if (result && acquired) {
      this.tx('scheduler.started', (tx) =>
        tx.emit({ type: 'controller.acquired', payload: { owner } }),
      );
      this.recordPolicy(owner);
    }
    return result;
  }

  release(owner: string) {
    return this.tx('scheduler.released', (tx) => {
      if (tx.controller()?.owner !== owner) return false;
      tx.setController(undefined);
      tx.emit({ type: 'controller.released', payload: { owner } });
      return true;
    });
  }

  /**
   * Пауза оператора или штатной остановки: новые claims запрещены (семантика
   * DevContour `pause`). Штатная остановка поверх существующей паузы её не
   * подменяет, кроме паузы операции reconfigure. Пауза оператора — решение
   * человека: она заменяет любую паузу, и классы отказов прежней паузы с ней
   * не переживают.
   */
  pause(reason: 'operator' | 'shutdown') {
    return this.tx('scheduler.paused', (tx) => {
      const control = tx.control();
      if (control.paused && reason === 'shutdown' && control.pauseReason !== 'reconfigure')
        return { control, changed: false };
      if (control.paused && control.pauseReason === reason && !control.pauseFailures?.length)
        return { control, changed: false };
      const next = {
        ...control,
        paused: true,
        pauseReason: reason,
        pausedAt: iso(this.now()),
        pauseOperation: undefined,
        pauseFailures: undefined,
      };
      tx.setControl(next);
      tx.emit({ type: 'control.paused', payload: { reason } });
      return { control: next, changed: true };
    });
  }

  /**
   * Снять паузу — решение человека (семантика DevContour `pause(false)`):
   * снимает паузу оператора, штатной остановки и отказа runtime вместе с её
   * классами отказов. Паузу операции reconfigure снимает только сама
   * операция: `PAUSED`.
   */
  resume() {
    return this.tx('scheduler.started', (tx) => {
      const control = tx.control();
      if (!control.paused) return { control, changed: false };
      if (control.pauseReason === 'reconfigure')
        throw new HarnessError(
          'PAUSED',
          'Выдачу держит операция применения политики; её снимает сама операция',
        );
      const reason = control.pauseReason ?? 'operator';
      const next = {
        ...control,
        paused: false,
        pauseReason: undefined,
        pausedAt: undefined,
        pauseOperation: undefined,
        pauseFailures: undefined,
        waits: control.waits?.filter((w) => w.kind !== 'base-check'),
      };
      if (!next.waits?.length) delete next.waits;
      tx.setControl(next);
      tx.emit({ type: 'control.resumed', payload: { reason } });
      return { control: next, changed: true };
    });
  }

  /** Снять паузу отказа после устранения причины: только названные классы. */
  clearFailure(kinds: FailureKind[]) {
    return this.tx('scheduler.started', (tx) => {
      const control = tx.control();
      const left = (control.pauseFailures ?? []).filter((k) => !kinds.includes(k));
      if (left.length === (control.pauseFailures ?? []).length) return control;
      const unpause = !left.length && control.pauseReason === 'runtime';
      const next = {
        ...control,
        pauseFailures: left.length ? left : undefined,
        ...(unpause ? { paused: false, pauseReason: undefined, pausedAt: undefined } : {}),
      };
      tx.setControl(next);
      if (unpause) tx.emit({ type: 'control.resumed', payload: { reason: 'runtime' } });
      return next;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Бюджеты и учёт вызовов                                            */
  /* ---------------------------------------------------------------- */

  /** Правила и области бюджетов: политика движка и группы хоста. */
  budgetContext(): BudgetContext {
    return { policy: this.policy, scopes: this.host.budgets };
  }

  /**
   * Бюджетное удержание готовых поручений. Бюджеты считаются по сохранённым
   * записям вызовов: сброс попыток и перезапуск их не уменьшают. Удержанное
   * поручение несёт причину, пока бюджет не позволит снова; выключенные
   * бюджеты удержание снимают.
   */
  private budgetBlocks(tx: ExecutionTransaction) {
    const ready = tx.works().filter((w) => w.status === 'ready');
    if (!this.policy.budgets) {
      for (const w of ready) if (w.budgetBlock) tx.putWork({ ...w, budgetBlock: undefined });
      return;
    }
    const c = this.budgetContext();
    const records = callRecords(tx);
    for (const w of ready) {
      const blocking = blockingBudget(c, workBudgets(c, tx, w.id, records));
      if (!blocking) {
        if (w.budgetBlock) tx.putWork({ ...w, budgetBlock: undefined });
        continue;
      }
      if (w.budgetBlock?.reason === blocking.reason) continue;
      tx.putWork({ ...w, budgetBlock: { reason: blocking.reason!, at: iso(this.now()) } });
      tx.emit({
        type: 'budget.blocked',
        graphId: w.graphId,
        workId: w.id,
        payload: {
          scope: blocking.scope.kind,
          ...(blocking.scope.id ? { scopeId: blocking.scope.id } : {}),
          state: blocking.state as 'exceeded' | 'undetermined',
          reason: blocking.reason!.slice(0, 4000),
        },
      });
    }
  }

  /**
   * Начало вызова модели: атрибуция на момент вызова и проверка бюджетов — в
   * одной транзакции с регистрацией идущего вызова. Превышенный или
   * неопределённый бюджет — отказ `budget` до вызова, без записи; два процесса
   * не проходят проверку оба, не видя друг друга.
   */
  beginCall(record: CallRecord, meta: CallMeta): CallRecord {
    return this.tx('usage.recorded', (tx) => {
      const c = this.budgetContext();
      const started = { ...record, ...callAttribution(c, tx, meta) };
      if (this.policy.budgets) assertBudget(c, callBudgets(c, tx, meta, callRecords(tx)));
      tx.putLocal('usage', callOwner(started), started.id, started);
      return started;
    });
  }

  /** Ход или итог вызова: запись заменяется целиком. */
  saveCall(record: CallRecord) {
    this.tx('usage.recorded', (tx) => tx.putLocal('usage', callOwner(record), record.id, record));
  }

  /**
   * Закрывает записи вызовов, чей процесс умер, исходом `abandoned`. Запись
   * без процесса закрывается, когда её попытка уже не активна, а без попытки —
   * спустя два предела времени вызова. Под транзакцией запись перечитывается:
   * вызов мог завершиться между сканированием и закрытием, и его исход и
   * стоимость не затираются устаревшим снимком.
   */
  abandonCalls(at = Date.now()): string[] {
    const dead = (r: CallRecord, view: ExecutionView) =>
      r.outcome === 'active' &&
      (r.process
        ? ownerGone(r)
        : r.runId
          ? view.attempt(r.runId)?.status !== 'active'
          : at - Date.parse(r.startedAt) > 2 * this.policy.runTimeoutMs);
    const candidates = this.read((v) => callRecords(v).filter((r) => dead(r, v)));
    if (!candidates.length) return [];
    return this.tx('usage.recorded', (tx) => {
      const closedIds: string[] = [];
      for (const seen of candidates) {
        const r = tx.local('usage', callOwner(seen), seen.id);
        if (!r || !dead(r, tx)) continue;
        // Время прерванного вызова фиксируется монотонно (часы ОС, сохранённый
        // замер), пока запись ещё идущая; измерить нельзя — время неизвестно,
        // а не берётся по системным часам, которые могли откатиться.
        const elapsed = callDurationMs(r, at);
        tx.putLocal('usage', callOwner(r), r.id, {
          ...r,
          ...(elapsed !== null ? { durationMs: elapsed } : { durationUnknown: true as const }),
          outcome: 'abandoned',
          abandonedAt: iso(at),
        });
        closedIds.push(r.id);
      }
      return closedIds;
    });
  }

  /**
   * Закрепляет атрибуцию прежних записей вызовов (без закреплённых поручения и
   * группы) по текущему составу — до того, как новая редакция графа его
   * изменит: иначе перенос поручения снял бы или разделил учтённый расход
   * группы. Уже закреплённое не меняется; запись перечитывается под
   * транзакцией.
   */
  pinLegacyCalls(): number {
    const unpinned = (r: CallRecord) => !r.workIds && (!r.workId || !r.groupId);
    const legacy = this.read((v) => callRecords(v).filter(unpinned));
    if (!legacy.length) return 0;
    return this.tx('usage.recorded', (tx) => {
      let pinned = 0;
      for (const seen of legacy) {
        const r = tx.local('usage', callOwner(seen), seen.id);
        if (!r || !unpinned(r)) continue;
        const found = this.host.budgets.legacy(r, tx);
        if (!(r.groupId ?? found.groupId)) continue;
        const next: CallRecord = { ...r, groupId: r.groupId ?? found.groupId };
        const workId = r.workId ?? found.workId;
        if (workId) next.workId = workId;
        if (!next.workId && found.workIds) next.workIds = found.workIds;
        if (!next.workId && !next.workIds) continue;
        tx.putLocal('usage', callOwner(next), next.id, next);
        pinned++;
      }
      return pinned;
    });
  }

  /** Обзор бюджетов для статуса; `undefined` — бюджеты не заданы. */
  budgets() {
    return this.read((v) => budgetOverview(this.budgetContext(), v));
  }

  /** Почему поручение сейчас не выдаётся; пусто — может быть выдано. */
  blockers(work: WorkState, view: ExecutionView) {
    const out: {
      code:
        | 'NOT_READY'
        | 'PAUSED'
        | 'ATTEMPTS_EXHAUSTED'
        | 'APPROVAL_STALE'
        | 'APPROVAL_REQUIRED'
        | 'BUDGET_EXHAUSTED'
        | 'REVIEWER_SAME_VENDOR'
        | 'REVIEWER_MISSING'
        | 'INVALID_INPUT';
      message: string;
    }[] = [];
    if (view.control().paused)
      out.push({
        code: 'PAUSED',
        message: 'Очередь на паузе: ' + (view.control().pauseReason ?? 'operator'),
      });
    const reconfigure = this.reconfiguring(view);
    if (reconfigure)
      out.push({
        code: 'PAUSED',
        message: `Операция ${reconfigure.operation} применяет политику`,
      });
    const stale = this.staleReason(view);
    if (stale) out.push({ code: 'APPROVAL_STALE', message: stale });
    if (this.liveJoint(view))
      out.push({ code: 'NOT_READY', message: 'Идёт совместная проверка репозиториев' });
    if (work.status === 'draft')
      out.push({ code: 'APPROVAL_REQUIRED', message: 'Граф не согласован' });
    const graph = view.graph(work.graphId);
    if (graph?.approval && graph.policyDigest !== executionDigest(this.policy))
      out.push({
        code: 'APPROVAL_STALE',
        message: 'Политика изменилась после согласования; согласуйте заново',
      });
    else if (work.status !== 'ready')
      out.push({ code: 'NOT_READY', message: 'Статус ' + work.status });
    for (const dep of work.order.dependsOn) {
      const d = view.work(dep);
      const external = view.graph(work.graphId)?.graph.prerequisites.some((p) => p.id === dep);
      if (!external && d?.status !== 'done')
        out.push({ code: 'NOT_READY', message: 'Ждёт ' + dep });
    }
    if (work.attempt >= this.policy.maxAttempts)
      out.push({
        code: 'ATTEMPTS_EXHAUSTED',
        message: `Исчерпано ${work.attempt} из ${this.policy.maxAttempts} попыток`,
      });
    if (work.hold)
      out.push({ code: 'NOT_READY', message: 'Удержано операцией ' + work.hold.operation });
    if (work.budgetBlock) out.push({ code: 'BUDGET_EXHAUSTED', message: work.budgetBlock.reason });
    if (blocksClaim(work))
      out.push({
        code: 'NOT_READY',
        message: `Разбор свойства ${work.recovery!.property}: ${work.recovery!.reason ?? work.recovery!.status}`,
      });
    if (this.awaitsOperator(work, view))
      out.push({
        code: 'APPROVAL_REQUIRED',
        message: 'Принятие версии корпуса ждёт подтверждения оператора',
      });
    if (work.status === 'ready' && work.approvedDigest !== this.host.basis.orderDigest(work, view))
      out.push({ code: 'APPROVAL_STALE', message: 'Постановка изменилась после согласования' });
    const contract = this.contractBlocker(work, view);
    if (contract) out.push({ code: 'APPROVAL_REQUIRED', message: contract });
    const reviewer = this.reviewerBlocker(work);
    if (reviewer) out.push(reviewer);
    const refusal = this.host.guards.claimable(work, view);
    if (refusal) out.push(refusal);
    return out;
  }

  /**
   * Назначение ревью кода для роли поручения недопустимо политикой (reviewer
   * того же вендора без явного разрешения, нет reviewer или роли). Такое
   * поручение не выдаётся и видно блокером; остальная очередь идёт дальше.
   */
  private reviewerBlocker(work: WorkState) {
    const role = this.policy.roles[work.order.role];
    if (!role)
      return { code: 'INVALID_INPUT' as const, message: 'Роль не объявлена: ' + work.order.role };
    const reviewer = selectReviewer(this.policy, 'code', role.writer, work.order.role);
    return reviewer.ok ? undefined : { code: reviewer.code, message: reviewer.message };
  }

  /**
   * Выдать следующую готовую работу. Только действующий controller; не на
   * паузе; не сверх `concurrency`; первое готовое поручение в порядке
   * регистрации. Поручение с согласованием, не совпадающим с текущим
   * основанием, — отказ `APPROVAL_STALE`, а не выдача.
   */
  claim(owner: string): AttemptState | undefined {
    return this.tx('run.claimed', (tx) => {
      const lease = tx.controller();
      if (!lease || lease.owner !== owner || lease.leaseUntil <= this.now())
        throw new HarnessError(
          'CONTROLLER_BUSY',
          'Выдавать попытки может только действующий controller',
        );
      if (tx.control().paused || this.host.guards.claimBarrier(tx)) return undefined;
      // Пока операция применяет политику, попытки не выдаются, даже если
      // человек снял паузу: попытка под прежней политикой не нужна.
      if (this.reconfiguring(tx)) return undefined;
      // Процесс с не применённой политикой не выдаёт: условия попытки
      // разошлись бы с применёнными.
      if (this.policyStale(tx)) return undefined;
      // Идущая совместная проверка закрепила комбинацию SHA: новые попытки
      // сдвинули бы target ref под ней.
      if (this.liveJoint(tx)) return undefined;
      const active = tx.attempts().filter((a) => a.status === 'active');
      if (active.length >= this.policy.concurrency) return undefined;
      this.budgetBlocks(tx);
      for (const ready of tx.works().filter((w) => w.status === 'ready' && w.recovery)) {
        const next = structuredClone(ready);
        if (closeIfBasisChanged(next, iso(this.now()))) {
          tx.putWork(next);
          this.recoveryEvent(tx, next, next.recoveryHistory!.at(-1)!);
        }
      }
      const eligible = tx.works().filter((w) => {
        if (w.status !== 'ready' || w.hold || w.budgetBlock) return false;
        // Два содержательных отказа по одному свойству: третья выдача — только
        // после разбора. Принятие корпуса, ждущее оператора, удерживает выдачу.
        if (blocksClaim(w) || this.awaitsOperator(w, tx)) return false;
        if (w.attempt >= this.policy.maxAttempts) return false;
        const graph = tx.graph(w.graphId);
        // Согласование привязано к graph digest и к политике, под которой оно дано.
        if (!graph?.approval || graph.approval.digest !== graph.digest) return false;
        if (graph.policyDigest !== executionDigest(this.policy)) return false;
        const external = new Set(graph.graph.prerequisites.map((p) => p.id));
        if (!w.order.dependsOn.every((d) => external.has(d) || tx.work(d)?.status === 'done'))
          return false;
        // Контракты поручения согласованы ревью своего digest при текущем назначении reviewer.
        if (this.contractBlocker(w, tx)) return false;
        // Недопустимое назначение reviewer держит только это поручение.
        if (this.reviewerBlocker(w)) return false;
        return !this.host.guards.claimable(w, tx);
      });
      const work = eligible[0];
      if (!work) return undefined;
      if (work.approvedDigest !== this.host.basis.orderDigest(work, tx))
        throw new HarnessError(
          'APPROVAL_STALE',
          `Постановка ${work.id} изменилась после согласования`,
        );
      if (work.approvedScope && work.approvedScope !== this.host.basis.scopeDigest(work, tx))
        throw new HarnessError(
          'APPROVAL_STALE',
          `Область проверок ${work.id} изменилась после согласования`,
        );
      const current = this.host.guards.current(work, undefined, tx);
      if (current) throw new HarnessError(current.code, current.message);
      const role = this.policy.roles[work.order.role];
      if (!role) throw new HarnessError('INVALID_INPUT', 'Роль не объявлена: ' + work.order.role);
      const reviewer = selectReviewer(this.policy, 'code', role.writer, work.order.role);
      if (!reviewer.ok) throw new HarnessError(reviewer.code, reviewer.message);
      const repo = this.policy.repositories.find((r) => r.id === work.order.repositoryId);
      if (!repo)
        throw new HarnessError(
          'INVALID_INPUT',
          'Репозиторий не объявлен: ' + work.order.repositoryId,
        );
      const candidates = eligible.map((w) => ({
        taskId: w.id,
        repositoryId: w.order.repositoryId,
        attempt: w.attempt,
      }));
      const at = this.now();
      const attempt: AttemptState = {
        id: this.id(),
        workId: work.id,
        repositoryId: work.order.repositoryId,
        attempt: work.attempt + 1,
        token: this.id() + this.id(),
        owner,
        runtime: role.writer.runtime,
        reviewer: reviewer.reviewer.runtime,
        ...(role.writer.model ? { model: role.writer.model } : {}),
        ...(reviewer.reviewer.model ? { reviewerModel: reviewer.reviewer.model } : {}),
        ...(role.writer.effort ? { effort: role.writer.effort } : {}),
        ...(reviewer.reviewer.effort ? { reviewerEffort: reviewer.reviewer.effort } : {}),
        policyDigest: this.host.basis.policyDigest(work, tx),
        status: 'active',
        phase: 'running',
        startedAt: iso(at),
        leaseUntil: at + this.policy.leaseMs,
        requiredGates: [
          ...expandGateRefs(repo, work.order.gates),
          ...(work.order.requirements.length ? [REQUIREMENT_GATE] : []),
        ],
        // Проверки потребителей закрепляются раскрытыми: смена групп
        // потребителя после выдачи не меняет состав, который доказывает попытка.
        ...(work.order.consumers?.length
          ? {
              consumers: work.order.consumers.map((c) => ({
                repositoryId: c.repositoryId,
                gates: expandGateRefs(this.repository(c.repositoryId), c.gates),
              })),
            }
          : {}),
        pinned: {
          graphId: work.graphId,
          graphDigest: tx.graph(work.graphId)!.digest,
          orderDigest: digestOf(work.order),
          targetRef: repo.targetRef,
          source: work.order.source,
        },
        dispatch: {
          policy: 'fifo-ready-v1',
          at: iso(at),
          eligible: candidates,
          activeCount: active.length,
          concurrency: this.policy.concurrency,
          inputDigest: digestOf(candidates),
        },
        ...(work.approvedAt ? { wait: { approvedAt: work.approvedAt } } : {}),
        engineVersion: this.version,
        ...(this.host.consumerVersion ? { consumerVersion: this.host.consumerVersion } : {}),
        // Версия проверок закрепляется при выдаче: принятие нового корпуса
        // посередине попытки ждёт её окончания, и evidence этой попытки
        // относится к этой версии.
        checks: {
          effective: effectiveChecks(work, this.host.basis.policyDigest(work, tx)),
          ...(work.checkVersion ? { corpus: work.checkVersion } : {}),
        },
        episodeBasis: episodeBasis(work),
        callsRecorded: true,
        evidence: [],
      };
      tx.putAttempt(attempt);
      const recovery =
        work.recovery?.status === 'retry'
          ? {
              ...structuredClone(work.recovery),
              // Разрешённый разбором повтор выдан: второй раз он не выдаётся.
              status: 'retrying' as const,
              retryRun: attempt.id,
              version: work.recovery.version + 1,
              history: [
                ...work.recovery.history,
                { at: iso(at), event: 'retry-claimed', detail: attempt.id },
              ],
            }
          : work.recovery;
      tx.putWork({
        ...work,
        status: 'running',
        attempt: attempt.attempt,
        activeRunId: attempt.id,
        failure: undefined,
        ...(recovery ? { recovery } : {}),
      });
      if (recovery && recovery !== work.recovery) this.recoveryEvent(tx, work, recovery);
      tx.emit({
        type: 'attempt.claimed',
        graphId: work.graphId,
        workId: work.id,
        runId: attempt.id,
        attempt: attempt.attempt,
        payload: {
          owner,
          runtime: attempt.runtime,
          reviewer: attempt.reviewer,
          policyDigest: attempt.policyDigest,
          engineVersion: this.version,
        },
      });
      return attempt;
    });
  }

  /**
   * Единственная точка fencing: операция попытки выполняется, только если
   * попытка активна, токен её, срок владения не истёк, она — текущая попытка
   * поручения, политика не сменилась и хост не возражает.
   */
  withAttempt<T>(
    id: string,
    token: string,
    kind: TransactionKind,
    fn: (attempt: AttemptState, work: WorkState, tx: ExecutionTransaction) => NotPromise<T>,
  ): T {
    return this.tx(kind, (tx) => {
      const attempt = tx.attempt(id);
      if (!attempt) throw new HarnessError('NOT_FOUND', 'Попытка не найдена: ' + id);
      const work = tx.work(attempt.workId)!;
      if (
        attempt.status !== 'active' ||
        attempt.token !== token ||
        attempt.leaseUntil <= this.now() ||
        work.activeRunId !== attempt.id
      )
        throw new HarnessError('LEASE_STALE', 'Устаревшая попытка: владение утрачено');
      if (attempt.policyDigest !== this.host.basis.policyDigest(work, tx))
        throw new HarnessError('APPROVAL_STALE', 'Политика изменилась; нужна новая попытка');
      const refusal = this.host.guards.current(work, attempt, tx);
      if (refusal) throw new HarnessError(refusal.code, refusal.message);
      return fn(attempt, work, tx);
    });
  }

  heartbeat(id: string, token: string) {
    this.withAttempt(id, token, 'heartbeat', (a, _w, tx) => {
      tx.putAttempt({ ...a, leaseUntil: this.now() + this.policy.leaseMs });
    });
  }

  /** Причина неудавшегося продления: записывается первой и не затирается. Истёкший срок допустим, чужой токен — нет. */
  heartbeatFailed(id: string, token: string, reason: string) {
    return this.tx('run.heartbeat-failed', (tx) => {
      const a = tx.attempt(id);
      if (a?.status !== 'active' || a.token !== token || a.error?.startsWith(HEARTBEAT_FAILED))
        return false;
      tx.putAttempt({ ...a, error: `${HEARTBEAT_FAILED}: ${reason.slice(0, 500)}` });
      return true;
    });
  }

  phase(
    id: string,
    token: string,
    phase: Phase,
    data: Partial<
      Pick<AttemptState, 'baseSha' | 'candidateSha' | 'integrationSha' | 'worktree'>
    > = {},
  ) {
    this.withAttempt(id, token, 'run.phase', (a, w, tx) => {
      tx.putAttempt({ ...a, ...data, phase });
      tx.putWork({ ...w, status: phase });
      tx.emit({
        type: 'attempt.phase',
        workId: w.id,
        runId: id,
        attempt: a.attempt,
        payload: {
          phase,
          ...((data.integrationSha ?? data.candidateSha ?? data.baseSha)
            ? { sha: (data.integrationSha ?? data.candidateSha ?? data.baseSha)! }
            : {}),
        },
      });
    });
  }

  /** Дополнить попытку сведениями её хода (контекст, ресурсы, замеры) под тем же fencing. */
  update(
    id: string,
    token: string,
    kind: TransactionKind,
    patch: Partial<
      Pick<AttemptState, 'context' | 'contextSnapshot' | 'resources' | 'model' | 'timings'>
    >,
  ) {
    this.withAttempt(id, token, kind, (a, _w, tx) => tx.putAttempt({ ...a, ...patch }));
  }

  /** Снимок зависимостей, против которого идёт попытка; закрепляется до реализации. */
  dependencies(id: string, token: string, snapshots: NonNullable<AttemptState['dependencies']>) {
    this.withAttempt(id, token, 'run.dependencies', (a, _w, tx) =>
      tx.putAttempt({ ...a, dependencies: snapshots }),
    );
  }

  /** Свежесть снимка зависимостей на момент окончания: записывается, не отклоняет. */
  dependencyFreshness(
    id: string,
    token: string,
    freshness: NonNullable<AttemptState['dependencyFreshness']>,
  ) {
    this.withAttempt(id, token, 'run.dependency-freshness', (a, _w, tx) =>
      tx.putAttempt({ ...a, dependencyFreshness: freshness }),
    );
  }

  /** Что проверено у потребителя: его голова и снимок всех его зависимостей. */
  consumerChecked(
    id: string,
    token: string,
    repositoryId: string,
    checked: NonNullable<NonNullable<AttemptState['consumers']>[number]['checked']>,
  ) {
    this.withAttempt(id, token, 'run.consumer-checked', (a, _w, tx) => {
      if (!a.consumers?.some((c) => c.repositoryId === repositoryId))
        throw new HarnessError(
          'INVALID_INPUT',
          'Потребитель не объявлен попыткой: ' + repositoryId,
        );
      tx.putAttempt({
        ...a,
        consumers: a.consumers.map((c) =>
          c.repositoryId === repositoryId ? { ...c, checked } : c,
        ),
      });
    });
  }

  /**
   * Gates репозиториев, не пройденные на integration ни одним из принятых
   * поручений: покрытие — по фактическому собственному evidence на принятом
   * SHA, для любой области. Evidence потребителя — проверка другого
   * компонента и не в счёт; запись ревью не закрывает одноимённый test gate.
   * Решение о приёмке набора поручений — за хостом.
   */
  uncoveredGates(workIds: string[]) {
    return this.read((v) => {
      const works = workIds.map((id) => v.work(id)).filter((w): w is WorkState => !!w);
      const result: { repositoryId: string; gates: string[] }[] = [];
      for (const repositoryId of [...new Set(works.map((w) => w.order.repositoryId))]) {
        const covered = new Set(
          works
            .filter((w) => w.order.repositoryId === repositoryId)
            .flatMap((w) =>
              v
                .attempts(w.id)
                .flatMap((a) => a.evidence)
                .filter(
                  (e) =>
                    e.kind === 'test' &&
                    e.phase === 'integration' &&
                    e.passed &&
                    !e.consumer &&
                    w.resultSha !== undefined &&
                    e.sha === w.resultSha,
                )
                .map((e) => e.gate),
            ),
        );
        const missing = this.repository(repositoryId)
          .gates.map((g) => g.id)
          .filter((id) => !covered.has(id));
        if (missing.length) result.push({ repositoryId, gates: missing });
      }
      return result;
    });
  }

  /**
   * Основания реализации записываются до неё: по ним следующая попытка решит,
   * можно ли взять этого кандидата. В той же транзакции решается, берётся ли
   * кандидат предыдущей попытки вместо новой реализации.
   */
  implementationBasis(id: string, token: string, basis: string) {
    return this.withAttempt(id, token, 'run.implementation-basis', (a, w, tx) => {
      const decision = this.policy.reuseImplementation
        ? reusableImplementation(tx, w, id, basis)
        : ({ reuse: false, reason: 'переиспользование выключено политикой' } as const);
      const reusedFrom = decision.reuse
        ? { runId: decision.from.id, candidateSha: decision.candidateSha }
        : undefined;
      tx.putAttempt({ ...a, implementationBasis: basis, ...(reusedFrom ? { reusedFrom } : {}) });
      return reusedFrom ? { reusedFrom } : { reason: (decision as { reason: string }).reason };
    });
  }

  /** Черновик реализации, оборванной до кандидата (см. `AttemptState.partial`). */
  recordPartial(id: string, token: string, partial: NonNullable<AttemptState['partial']>) {
    this.withAttempt(id, token, 'run.partial', (a, _w, tx) => tx.putAttempt({ ...a, partial }));
  }

  /** Попытка начала с черновика предыдущей (см. `AttemptState.continuedFrom`). */
  continuation(id: string, token: string, from: NonNullable<AttemptState['continuedFrom']>) {
    this.withAttempt(id, token, 'run.continuation', (a, _w, tx) =>
      tx.putAttempt({ ...a, continuedFrom: from }),
    );
  }

  /** Начало стадии попытки; `timingFinished` закрывает её исходом. */
  timingStarted(id: string, token: string, stage: string) {
    const timing = { id: this.id(), stage, startedAt: iso(this.now()) };
    this.withAttempt(id, token, 'run.timing.started', (a, _w, tx) =>
      tx.putAttempt({ ...a, timings: [...(a.timings ?? []), timing] }),
    );
    return timing.id;
  }

  timingFinished(id: string, token: string, timingId: string, outcome: 'passed' | 'failed') {
    this.withAttempt(id, token, 'run.timing.finished', (a, _w, tx) =>
      tx.putAttempt({
        ...a,
        timings: (a.timings ?? []).map((t) =>
          t.id === timingId ? { ...t, finishedAt: iso(this.now()), outcome } : t,
        ),
      }),
    );
  }

  evidence(
    id: string,
    token: string,
    evidence: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>,
  ) {
    return this.withAttempt(id, token, 'evidence.recorded', (a, w, tx) => {
      if (evidence.checks !== undefined && evidence.checks !== a.checks?.effective)
        throw new HarnessError('APPROVAL_STALE', 'Evidence другой версии проверок, чем у попытки');
      const record: EvidenceRecord = {
        ...evidence,
        ...(a.checks ? { checks: a.checks.effective } : {}),
        id: this.id(),
        runId: id,
        createdAt: iso(this.now()),
      };
      tx.putAttempt({ ...a, evidence: [...a.evidence, record] });
      const common = { workId: w.id, runId: id, attempt: a.attempt };
      if (record.kind === 'review')
        tx.emit({
          type: 'attempt.review',
          ...common,
          payload: {
            phase: record.phase,
            sha: record.sha,
            passed: record.passed,
            evidenceId: record.id,
            reviewer: a.reviewer,
            sameVendor: a.reviewer === a.runtime,
            blocking: (record.findings ?? []).filter((f) => f.severity === 'blocking').length,
          },
        });
      else
        tx.emit({
          type: 'attempt.gate',
          ...common,
          payload: {
            phase: record.phase,
            gate: record.gate,
            sha: record.sha,
            passed: record.passed,
            evidenceId: record.id,
            ...(record.consumer ? { consumer: record.consumer } : {}),
          },
        });
      return record;
    });
  }

  /**
   * Техническая приёмка. Требует фазу интеграции и integration SHA, PASS
   * каждого обязательного gate в обеих фазах на точных SHA, PASS
   * независимого ревью в обеих фазах; затем условие хоста `beforeAccept`.
   * `publish` — CAS продвижения target ref — выполняется внутри той же
   * транзакции до фиксации: его отказ откатывает приёмку целиком.
   */
  finish(id: string, token: string, sha: string, publish?: () => void) {
    return this.withAttempt(id, token, 'task.done', (a, w, tx) => {
      // Процесс с не применённой политикой не принимает: сравнение двух его
      // же старых digest актуальности не доказывает.
      this.assertCurrentPolicy(tx);
      if (a.phase !== 'integrating' || !a.candidateSha || a.integrationSha !== sha)
        throw new HarnessError('NOT_READY', 'Нет интеграционного коммита');
      // Принять можно только под той версией проверок, под которой шла
      // попытка: новый корпус, принятый поручением, требует новой попытки.
      if (
        a.checks &&
        effectiveChecks(w, this.host.basis.policyDigest(w, tx)) !== a.checks.effective
      )
        throw new HarnessError(
          'APPROVAL_STALE',
          'Версия проверок поручения изменилась; нужна новая попытка',
        );
      const last = (
        kind: EvidenceRecord['kind'],
        phase: EvidenceRecord['phase'],
        at: string,
        gate: string,
      ) =>
        a.evidence.findLast(
          (e) =>
            e.kind === kind &&
            e.phase === phase &&
            e.sha === at &&
            e.gate === gate &&
            e.consumer === undefined &&
            (!a.checks || e.checks === a.checks.effective),
        )?.passed === true;
      for (const gate of a.requiredGates ?? [])
        for (const phase of ['candidate', 'integration'] as const)
          if (!last('test', phase, phase === 'candidate' ? a.candidateSha : sha, gate))
            throw new HarnessError('GATE_FAILED', `Нет PASS: ${phase}/${gate}`);
      for (const phase of ['candidate', 'integration'] as const)
        if (
          !last('review', phase, phase === 'candidate' ? a.candidateSha : sha, 'independent-review')
        )
          throw new HarnessError('REVIEW_REJECTED', `Нет независимого ревью: ${phase}`);
      // Проверки потребителей — на integration, против интегрированного
      // результата: evidence потребителя закрывает только его проверку.
      for (const consumer of a.consumers ?? []) {
        for (const gate of consumer.gates)
          if (
            a.evidence.findLast(
              (e) =>
                e.kind === 'test' &&
                e.phase === 'integration' &&
                e.sha === sha &&
                e.gate === gate &&
                e.consumer === consumer.repositoryId &&
                (!a.checks || e.checks === a.checks.effective),
            )?.passed !== true
          )
            throw new HarnessError(
              'GATE_FAILED',
              `Нет PASS проверки потребителя: ${consumer.repositoryId}/${gate}`,
            );
        // Что проверено, обязано быть записано: иначе проверку потребителя не с
        // чем сверить, и результат нельзя перенести.
        const provider = consumer.checked?.dependencies.find(
          (d) => d.repositoryId === a.repositoryId,
        );
        if (provider?.sha !== sha)
          throw new HarnessError(
            'GATE_FAILED',
            `Проверка потребителя ${consumer.repositoryId} не записала снимок с интегрированным результатом`,
          );
      }
      const unproven = unprovenReason(w.order.requirements, a.evidence, sha);
      if (unproven) throw new HarnessError('GATE_FAILED', unproven);
      const contract = this.contractBlocker(w, tx);
      if (contract) throw new HarnessError('APPROVAL_STALE', contract);
      const refusal = this.host.guards.beforeAccept(w, a, tx);
      if (refusal) throw new HarnessError(refusal.code, refusal.message);
      const at = iso(this.now());
      tx.putAttempt({ ...a, status: 'succeeded', finishedAt: at });
      const accepted = structuredClone(w);
      const open = accepted.recovery;
      afterSuccess(accepted, at);
      if (open) this.recoveryEvent(tx, w, accepted.recoveryHistory!.at(-1)!);
      tx.putWork({
        ...accepted,
        status: 'done',
        resultSha: sha,
        activeRunId: undefined,
        failure: undefined,
        failureKind: undefined,
        failureFingerprint: undefined,
      });
      tx.emit({
        type: 'work.accepted',
        graphId: w.graphId,
        workId: w.id,
        runId: id,
        attempt: a.attempt,
        payload: { resultSha: sha, integrationSha: sha },
      });
      publish?.();
      return { workId: w.id, runId: id, sha };
    });
  }

  /**
   * Отказ попытки. Класс и отпечаток записываются вместе с отказом. Отказ
   * окружения до кандидата (`blocked`) попытку не засчитывает. Отказ,
   * который повторится на любой работе (`repairPolicy.blocksQueue`), ставит
   * паузу `runtime` с классом отказа — снимает её устранение причины.
   */
  fail(
    id: string,
    token: string,
    error: string,
    options: {
      kind?: FailureKind;
      blocked?: boolean;
      heartbeatCause?: string;
      /** Свойства отказа: `bound` — объявленные поручением, `unbound` — прочие названные. */
      properties?: { bound: string[]; unbound: string[] };
    } = {},
  ) {
    const kind = options.kind ?? 'unknown';
    return this.withAttempt(id, token, 'run.failed', (a, w, tx) => {
      const fingerprint = failureFingerprint(kind, error);
      const prefix = a.error?.startsWith(HEARTBEAT_FAILED)
        ? a.error
        : options.heartbeatCause
          ? `${HEARTBEAT_FAILED}: ${options.heartbeatCause.slice(0, 500)}`
          : undefined;
      const shown = prefix ? `${prefix}. ${error}` : error;
      const blocked = Boolean(options.blocked);
      // Свойство отказа — только объявленное поручением: неизвестное
      // сохраняется для разбора, но счётчик эпизода не выбирает.
      const declared = new Set(w.order.properties ?? []);
      const bound = [...new Set((options.properties?.bound ?? []).filter((p) => declared.has(p)))];
      const unbound = [
        ...new Set([
          ...(options.properties?.unbound ?? []),
          ...(options.properties?.bound ?? []).filter((p) => !declared.has(p)),
        ]),
      ];
      const failed: AttemptState = {
        ...a,
        status: 'failed',
        error: shown,
        ...(blocked ? { blocked: true } : {}),
        failureKind: kind,
        failureFingerprint: fingerprint,
        finishedAt: iso(this.now()),
        ...(bound.length ? { properties: bound } : {}),
        ...(unbound.length ? { unboundProperties: unbound } : {}),
      };
      tx.putAttempt(failed);
      const next = structuredClone(w);
      const before = next.recovery?.status;
      const episode = afterFailure(
        next,
        tx.attempts(w.id).map((x) => (x.id === id ? failed : x)),
        failed,
        iso(this.now()),
      );
      if (episode && (episode.status !== before || !w.recovery || w.recovery.id !== episode.id))
        this.recoveryEvent(tx, w, episode);
      tx.putWork({
        ...next,
        status: 'failed',
        failure: shown,
        failureKind: kind,
        failureFingerprint: fingerprint,
        activeRunId: undefined,
        attempt: blocked && w.attempt > 0 ? w.attempt - 1 : w.attempt,
      });
      tx.emit({
        type: 'attempt.failed',
        graphId: w.graphId,
        workId: w.id,
        runId: id,
        attempt: a.attempt,
        payload: { failureKind: kind, message: shown.slice(0, 4000), blocked },
      });
      if (repairPolicy[kind].blocksQueue) {
        const control = tx.control();
        const failures = [...new Set([...(control.pauseFailures ?? []), kind])];
        tx.setControl({
          ...control,
          paused: true,
          pauseReason: control.paused ? control.pauseReason : 'runtime',
          pausedAt: control.pausedAt ?? iso(this.now()),
          pauseFailures: failures,
        });
        tx.emit({
          type: 'control.paused',
          payload: {
            reason: control.paused ? (control.pauseReason ?? 'runtime') : 'runtime',
            failures,
          },
        });
      }
      return {
        workId: w.id,
        runId: id,
        kind,
        blocked,
        ...(bound.length ? { properties: bound } : {}),
        ...(episode ? { recovery: { id: episode.id, status: episode.status } } : {}),
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Эпизоды восстановления по свойству                                 */
  /* ---------------------------------------------------------------- */

  private recoveryEvent(tx: ExecutionTransaction, work: WorkState, r: PropertyRecovery) {
    tx.emit({
      type: 'work.recovery',
      graphId: work.graphId,
      workId: work.id,
      payload: {
        recoveryId: r.id,
        property: r.property,
        status: r.status,
        ...(r.reason ? { reason: r.reason.slice(0, 4000) } : {}),
      },
    });
  }

  /** Принятие корпуса, ждущее оператора, удерживает выдачу поручения. */
  private awaitsOperator(work: WorkState, view: ExecutionView) {
    return view
      .locals('check-suites', work.order.repositoryId)
      .some((x) =>
        x.value.pending.some(
          (p) => p.status === 'waiting' && p.awaitingOperator && p.tasks.includes(work.id),
        ),
      );
  }

  private episode(
    kind: TransactionKind,
    workId: string,
    recoveryId: string,
    fn: (r: PropertyRecovery, w: WorkState) => string | undefined,
  ): PropertyRecovery {
    return this.tx(kind, (tx) => {
      const w = tx.work(workId);
      if (!w) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + workId);
      if (!w.recovery || w.recovery.id !== recoveryId)
        throw new HarnessError('NOT_FOUND', 'Эпизод восстановления не найден');
      const r = structuredClone(w.recovery);
      const event = fn(r, w);
      if (event === undefined) return r;
      r.version++;
      r.history.push({
        at: iso(this.now()),
        event,
        ...(r.reason ? { detail: r.reason.slice(0, 1000) } : {}),
      });
      tx.putWork({ ...w, recovery: r });
      this.recoveryEvent(tx, w, r);
      return r;
    });
  }

  /**
   * Учесть разбор ведущего до вызова модели. Один автоматический разбор на
   * эпизод: повторная регистрация, рестарт или дубликат бесплатного вызова
   * не получают. Исчерпанные попытки — решение человека.
   */
  recoveryReserve(workId: string, recoveryId: string) {
    return this.episode('recovery.reserved', workId, recoveryId, (r, w) => {
      if (r.status !== 'awaiting-lead')
        throw new HarnessError('NOT_READY', `Эпизод ${r.id} не ждёт разбора: ${r.status}`);
      if (r.calls >= 1) {
        r.status = 'awaiting-user';
        r.reason = 'Автоматический разбор эпизода уже использован; повторный вызов не выполняется.';
      } else if (w.attempt >= this.policy.maxAttempts) {
        r.status = 'awaiting-user';
        r.reason =
          'Попытки поручения исчерпаны: разрешённого повтора не осталось, сброс — решение человека.';
      } else {
        r.calls++;
        r.status = 'analyzing';
      }
      return r.status === 'analyzing' ? 'analysis-reserved' : 'refused';
    });
  }

  /**
   * Записать решение разбора — ведущего или ручное — и перевести эпизод в
   * состояние разрешённого действия. Ручное решение сверяет версию записи:
   * устаревшее не применяется.
   */
  recoveryDecide(
    workId: string,
    recoveryId: string,
    decision: NonNullable<PropertyRecovery['decision']>,
    expectedVersion?: number,
  ) {
    if (decision.reason.trim().length < 10)
      throw new HarnessError('INVALID_INPUT', 'Решение требует причины не короче 10 символов');
    return this.episode('recovery.decided', workId, recoveryId, (r, w) => {
      if (expectedVersion !== undefined && r.version !== expectedVersion)
        throw new HarnessError('APPROVAL_STALE', 'Эпизод изменился; прочитайте его заново');
      const manual = decision.source.kind === 'operator';
      if (!manual && r.status !== 'analyzing')
        throw new HarnessError('NOT_READY', `Эпизод ${r.id} не в разборе: ${r.status}`);
      if (manual && !['awaiting-lead', 'awaiting-user', 'stopped', 'analyzing'].includes(r.status))
        throw new HarnessError('NOT_READY', `Эпизод ${r.id} уже исполняет решение: ${r.status}`);
      if (w.status === 'cancelled') throw new HarnessError('NOT_READY', 'Поручение отменено');
      r.decision = decision;
      const retryable = w.attempt < this.policy.maxAttempts;
      switch (decision.action) {
        case 'add-cases':
          if (!decision.cases?.length)
            throw new HarnessError('INVALID_INPUT', 'add-cases без случаев');
          r.status = 'applying';
          break;
        case 'new-approach':
          if (!decision.hypothesis?.trim() || !decision.plan?.trim())
            throw new HarnessError(
              'INVALID_INPUT',
              'Новый подход требует гипотезы и плана проверки',
            );
          r.status = retryable ? 'retry' : 'awaiting-user';
          if (!retryable) r.reason = 'Попытки исчерпаны: повтор с новой гипотезой невозможен.';
          break;
        case 'strengthen-checker':
        case 'split-task':
          if (!decision.proposal?.trim())
            throw new HarnessError('INVALID_INPUT', 'Предложение для обычного ревью обязательно');
          r.status = 'stopped';
          r.reason = `Подготовлено предложение (${decision.action}); оно проходит обычное ревью или перепланирование и автоматически не применяется.`;
          break;
        case 'clarify-obligation':
          r.status = 'awaiting-user';
          r.reason = `Нужно решение человека: ${decision.conflict ?? decision.reason}`;
          break;
        case 'environment':
          r.status = 'stopped';
          r.reason = `Причина в среде или не установлена: ${decision.reason}`;
          break;
      }
      return 'decided';
    });
  }

  /** Итог добавления случаев: подтверждённый случай разрешает один повтор. */
  recoveryApplied(
    workId: string,
    recoveryId: string,
    outcomes: { outcome: string; reason: string }[],
  ) {
    return this.episode('recovery.applied', workId, recoveryId, (r, w) => {
      if (r.status !== 'applying')
        throw new HarnessError('NOT_READY', 'Эпизод не исполняет добавление случаев');
      const confirmed = outcomes.filter((o) => o.outcome === 'confirmed').length;
      if (confirmed && w.attempt < this.policy.maxAttempts) {
        r.status = 'retry';
        r.reason = `${confirmed} из ${outcomes.length} случаев подтверждено`;
      } else {
        r.status = 'stopped';
        r.reason = confirmed
          ? 'Случаи подтверждены, но попытки поручения исчерпаны.'
          : 'Ни один предложенный случай не подтверждён эталоном: ' +
            outcomes
              .map((o) => o.reason)
              .join('; ')
              .slice(0, 800);
      }
      return 'applied';
    });
  }

  /** Разбор прервался без решения: вызов учтён, повтор не бесплатен. */
  recoveryInterrupted(workId: string, recoveryId: string, reason: string) {
    return this.episode('recovery.interrupted', workId, recoveryId, (r) => {
      if (!['analyzing', 'applying'].includes(r.status)) return undefined;
      r.status = 'awaiting-user';
      r.reason = reason.slice(0, 1000);
      return 'interrupted';
    });
  }

  /* ---------------------------------------------------------------- */
  /* Применённая политика и операция reconfigure                       */
  /* ---------------------------------------------------------------- */

  /**
   * Применённая политика в хранилище — единственный источник правды; у
   * процесса нет своего «поколения», которое мог бы рассинхронизировать
   * откат транзакции. Процесс текущий, только если его политика совпадает с
   * применённой. Записать свою вместо применённой (перезапуск с другой
   * политикой) он может, только если нет живого чужого controller, политика
   * не менялась в памяти после создания движка, её источник не менялся с
   * загрузки и после запуска процесса никто не применил другую: поколение
   * считается по записям, а не по часам.
   */
  private mayAdopt(view: ExecutionView): string | undefined {
    const lease = view.controller();
    if (lease && lease.leaseUntil > this.now() && lease.owner !== this.ownLeader)
      return `работает controller ${lease.owner} с другой политикой`;
    if (policyDigest(this.policy) !== this.loadedPolicy)
      return 'политика изменена в памяти после загрузки';
    const applied = view.control().appliedPolicy;
    if (applied && (applied.generation ?? 0) !== this.observedGeneration)
      return `после запуска процесса применена политика поколения ${applied.generation ?? 0}`;
    return this.provenance();
  }

  private adoptPolicy(tx: ExecutionTransaction, by: string, operation?: string) {
    const control = tx.control();
    const generation = (control.appliedPolicy?.generation ?? 0) + 1;
    tx.setControl({
      ...control,
      appliedPolicy: { digest: this.loadedPolicy, generation, at: iso(this.now()), by },
    });
    tx.emit({
      type: 'policy.applied',
      payload: {
        digest: this.loadedPolicy,
        generation,
        by,
        ...(operation ? { operation } : {}),
      },
    });
  }

  /** Почему процесс не вправе действовать под своей политикой; `undefined` — вправе. */
  private staleReason(view: ExecutionView): string | undefined {
    const applied = view.control().appliedPolicy;
    if (!applied || applied.digest === this.loadedPolicy) return undefined;
    const refusal = this.mayAdopt(view);
    return refusal
      ? `Процесс работает не с применённой политикой (${refusal}); перезапустите его`
      : undefined;
  }
  private policyStale(tx: ExecutionTransaction) {
    try {
      this.assertCurrentPolicy(tx);
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Общий барьер: в транзакциях выдачи, согласования, приёмки и совместной
   * проверки процесс сверяет свою политику с применённой. Первый процесс,
   * действующий после законной смены политики без живого controller,
   * записывает свою как применённую в той же транзакции — откат отменит и её.
   */
  assertCurrentPolicy(tx: ExecutionTransaction) {
    const applied = tx.control().appliedPolicy;
    if (!applied || applied.digest === this.loadedPolicy) return;
    const stale = this.staleReason(tx);
    if (stale) throw new HarnessError('APPROVAL_STALE', stale);
    this.adoptPolicy(tx, 'process');
  }

  /**
   * Запуск controller записывает его политику применённой, если её ещё нет
   * или процесс вправе её сменить. Неприменённый запрос операции остаётся.
   */
  private recordPolicy(owner: string) {
    this.tx('config.started', (tx) => {
      const lease = tx.controller();
      if (lease?.owner !== owner || lease.leaseUntil <= this.now()) return;
      const applied = tx.control().appliedPolicy;
      if (applied?.digest === this.loadedPolicy) return;
      if (applied && this.mayAdopt(tx)) return;
      this.adoptPolicy(tx, owner);
    });
  }

  private reconfiguring(view: ExecutionView) {
    const request = view.control().reconfigure;
    return request && !request.appliedAt ? request : undefined;
  }

  /** Сведения о политике процесса и применённой. */
  policyState() {
    return this.read((v) => ({
      loaded: this.loadedPolicy,
      ...(v.control().appliedPolicy ? { applied: v.control().appliedPolicy } : {}),
      ...(v.control().reconfigure ? { reconfigure: v.control().reconfigure } : {}),
      ...(this.staleReason(v) ? { stale: this.staleReason(v) } : {}),
    }));
  }

  /**
   * Пауза операции: ставится, только если очередь не остановлена, и
   * помечается операцией. Пауза человека не перезаписывается.
   */
  operationPause(operation: string) {
    return this.tx('scheduler.paused', (tx) => {
      const control = tx.control();
      if (control.paused) return false;
      tx.setControl({
        ...control,
        paused: true,
        pauseReason: 'reconfigure',
        pauseOperation: operation,
        pausedAt: iso(this.now()),
      });
      tx.emit({ type: 'control.paused', payload: { reason: 'reconfigure' } });
      return true;
    });
  }

  /** Снять паузу операции — только свою; паузу человека она не трогает. */
  operationResume(operation: string) {
    return this.tx('scheduler.started', (tx) => {
      const control = tx.control();
      if (
        !control.paused ||
        control.pauseReason !== 'reconfigure' ||
        control.pauseOperation !== operation
      )
        return false;
      tx.setControl({
        ...control,
        paused: false,
        pauseReason: undefined,
        pauseOperation: undefined,
        pausedAt: undefined,
      });
      tx.emit({ type: 'control.resumed', payload: { reason: 'reconfigure' } });
      return true;
    });
  }

  /**
   * Запросить применение политики с ожидаемым digest (`policyDigest`
   * загруженной политики). Идемпотентно; повтор той же операцией сбрасывает
   * прежний отказ — политику могли исправить. Пока запрос не применён, новые
   * попытки не выдаются.
   */
  requestReconfigure(operation: string, digest: string) {
    return this.tx('config.reconfigure-requested', (tx) => {
      const control = tx.control();
      const current = control.reconfigure;
      if (current && current.operation === operation && current.digest === digest) {
        if (!current.error) return { operation, digest, changed: false };
        tx.setControl({ ...control, reconfigure: { ...current, error: undefined } });
        tx.emit({
          type: 'policy.reconfigure',
          payload: { operation, digest, status: 'requested' },
        });
        return { operation, digest, changed: true, retried: true };
      }
      if (current && current.operation !== operation && !current.appliedAt)
        throw new HarnessError(
          'NOT_READY',
          `Политику уже применяет операция ${current.operation}; дождитесь её`,
        );
      tx.setControl({
        ...control,
        reconfigure: { operation, digest, requestedAt: iso(this.now()) },
      });
      tx.emit({ type: 'policy.reconfigure', payload: { operation, digest, status: 'requested' } });
      return { operation, digest, changed: true };
    });
  }

  /**
   * Работы, идущие под действующей политикой. Запись с истёкшим сроком не
   * держит применение: её результат и так не будет принят (владение
   * проверяется при каждой записи), а держать применение из-за неё значило
   * бы ждать вечно.
   */
  busyWork(view: ExecutionView) {
    const now = this.now();
    return [
      ...view
        .attempts()
        .filter((a) => a.status === 'active' && a.leaseUntil > now)
        .map((a) => a.id),
      ...view
        .verifications()
        .filter((v) => v.status === 'active' && v.leaseUntil > now)
        .map((v) => v.id),
      ...view
        .locals('workflow-jobs')
        .filter((j) => j.value.status === 'running' && (j.value.leaseUntil ?? 0) > now)
        .map((j) => j.key),
      ...view.locals('check-suites').flatMap(({ value }) =>
        Object.values(value.operations)
          .filter((op) => op.status === 'running' && (op.leaseUntil ?? 0) > now)
          .map((op) => `${value.id}:${op.key}`),
      ),
    ];
  }

  /**
   * Применить запрос этим процессом: только если его политика — ровно
   * ожидаемая и работ под прежней не осталось. Политика другого digest —
   * отказ с обоими digest (повтор операции его сбросит). Применение и снятие
   * паузы операции — одна транзакция.
   */
  applyReconfigure(
    by: string,
  ):
    | { status: 'none' }
    | { status: 'busy'; busy: string[] }
    | { status: 'waiting'; expected: string }
    | { status: 'failed'; error: string }
    | { status: 'applied'; generation: number } {
    return this.tx('config.reconfigured', (tx) => {
      const control = tx.control();
      const request = control.reconfigure;
      if (!request || request.appliedAt || request.error) return { status: 'none' as const };
      const busy = this.busyWork(tx);
      if (busy.length) return { status: 'busy' as const, busy };
      if (request.digest !== this.loadedPolicy) {
        const error = `Политика не совпадает с ожидаемой операцией: ожидался digest ${request.digest.slice(0, 16)}, загружен ${this.loadedPolicy.slice(0, 16)}`;
        tx.setControl({ ...control, reconfigure: { ...request, error } });
        tx.emit({
          type: 'policy.reconfigure',
          payload: {
            operation: request.operation,
            digest: request.digest,
            status: 'failed',
            error,
          },
        });
        return { status: 'failed' as const, error };
      }
      const generation = (control.appliedPolicy?.generation ?? 0) + 1;
      const at = iso(this.now());
      const resume =
        control.paused &&
        control.pauseReason === 'reconfigure' &&
        control.pauseOperation === request.operation;
      tx.setControl({
        ...control,
        reconfigure: { ...request, appliedAt: at, appliedBy: by, error: undefined },
        appliedPolicy: { digest: request.digest, generation, at, by },
        ...(resume
          ? {
              paused: false,
              pauseReason: undefined,
              pauseOperation: undefined,
              pausedAt: undefined,
            }
          : {}),
      });
      tx.emit({
        type: 'policy.applied',
        payload: { digest: request.digest, generation, by, operation: request.operation },
      });
      if (resume) tx.emit({ type: 'control.resumed', payload: { reason: 'reconfigure' } });
      return { status: 'applied' as const, generation };
    });
  }

  /**
   * Процесс, работающий с прежней политикой, применить запрос не может: он
   * ждёт перезапуска с ожидаемой. Такой процесс применение не отклоняет.
   */
  serveReconfigure(by: string) {
    const request = this.read((v) => this.reconfiguring(v));
    if (!request || request.error || request.digest !== this.loadedPolicy)
      return { status: 'none' as const };
    return this.applyReconfigure(by);
  }

  /** Снять завершённый или отменённый запрос операции. */
  clearReconfigure(operation: string) {
    return this.tx('config.reconfigure-cleared', (tx) => {
      const control = tx.control();
      if (control.reconfigure?.operation !== operation) return false;
      tx.setControl({ ...control, reconfigure: undefined });
      tx.emit({
        type: 'policy.reconfigure',
        payload: { operation, digest: control.reconfigure.digest, status: 'cleared' },
      });
      return true;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Удержания операций                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Удержать поручения от выдачи на время операции. Поручение, удерживаемое
   * другой операцией, — конфликт: две операции не меняют одно поручение
   * одновременно. Повтор той же операции ничего не меняет. `fence` —
   * проверка владения операцией в той же транзакции: утративший владение
   * ничего не пишет.
   */
  hold(ids: string[], operation: string, reason: string, fence?: (view: ExecutionView) => void) {
    return this.tx('task.held', (tx) => {
      fence?.(tx);
      const works = ids.map((id) => {
        const w = tx.work(id);
        if (!w) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + id);
        return w;
      });
      const busy = works.filter((w) => w.hold && w.hold.operation !== operation);
      if (busy.length)
        throw new HarnessError(
          'NOT_READY',
          'Поручения удерживает другая операция: ' +
            busy.map((w) => `${w.id} (${w.hold!.operation})`).join(', '),
        );
      for (const w of works) {
        if (w.hold?.operation === operation && w.hold.reason === reason) continue;
        tx.putWork({ ...w, hold: { operation, reason } });
        tx.emit({
          type: 'work.held',
          graphId: w.graphId,
          workId: w.id,
          payload: { operation, reason, released: false },
        });
      }
      return works.map((w) => w.id);
    });
  }

  /** Снять удержание операции — со всех или с перечисленных поручений; чужие не трогаются. */
  releaseHold(operation: string, ids?: string[], fence?: (view: ExecutionView) => void) {
    return this.tx('task.released', (tx) => {
      fence?.(tx);
      const released = tx
        .works()
        .filter((w) => w.hold?.operation === operation && (!ids || ids.includes(w.id)));
      for (const w of released) {
        tx.putWork({ ...w, hold: undefined });
        tx.emit({
          type: 'work.held',
          graphId: w.graphId,
          workId: w.id,
          payload: { operation, reason: w.hold!.reason, released: true },
        });
      }
      return released.map((w) => w.id);
    });
  }

  /** Передать удержание от одной операции другой без окна выдачи. */
  transferHold(from: string, to: string, reason: string, fence?: (view: ExecutionView) => void) {
    return this.tx('task.hold-transferred', (tx) => {
      fence?.(tx);
      const moved = tx.works().filter((w) => w.hold?.operation === from);
      for (const w of moved) {
        tx.putWork({ ...w, hold: { operation: to, reason } });
        tx.emit({
          type: 'work.held',
          graphId: w.graphId,
          workId: w.id,
          payload: { operation: to, reason, released: false },
        });
      }
      return moved.map((w) => w.id);
    });
  }

  /** Попытки, ещё владеющие поручениями (живой срок): операция ждёт их окончания. */
  activeAttempts(workIds?: string[]) {
    return this.read((v) =>
      v
        .attempts()
        .filter(
          (a) =>
            a.status === 'active' &&
            a.leaseUntil > this.now() &&
            (!workIds || workIds.includes(a.workId)),
        )
        .map((a) => ({ id: a.id, workId: a.workId, leaseUntil: a.leaseUntil })),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Совместная проверка комбинации репозиториев                       */
  /* ---------------------------------------------------------------- */

  private liveJoint(view: ExecutionView) {
    return view.verifications().some((v) => v.status === 'active' && v.leaseUntil > this.now());
  }

  /**
   * Начать совместную проверку набора принятых поручений. Нужны gates уровня
   * workspace с JUnit, у каждого продуктового репозитория — свой; идущих
   * попыток и другой живой проверки быть не должно; истёкшая проверка
   * закрывается отказом. `baseline` — успешная проверка, которую хост принял
   * (для режима `affected`).
   */
  jointStart(input: { workIds: string[]; baseline?: string }): JointVerificationState {
    const gates = this.policy.workspaceGates;
    if (!gates.some((g) => g.kind === 'test' && g.report))
      throw new HarnessError(
        'INVALID_INPUT',
        'Настройте обязательные gates совместной проверки (workspaceGates) с JUnit',
      );
    for (const repo of this.policy.repositories.filter((r) => r.kind === 'product'))
      if (!gates.some((g) => g.repositoryId === repo.id && g.kind === 'test' && g.report))
        throw new HarnessError('INVALID_INPUT', `Нужна совместная проверка продукта ${repo.id}`);
    if (!input.workIds.length || new Set(input.workIds).size !== input.workIds.length)
      throw new HarnessError('INVALID_INPUT', 'Нужен непустой набор разных поручений');
    return this.tx('workspace.verification.started', (tx) => {
      this.assertCurrentPolicy(tx);
      const reconfigure = this.reconfiguring(tx);
      if (reconfigure)
        throw new HarnessError(
          'NOT_READY',
          `Операция ${reconfigure.operation} применяет политику; дождитесь её`,
        );
      if (tx.attempts().some((a) => a.status === 'active' && a.leaseUntil > this.now()))
        throw new HarnessError('NOT_READY', 'Дождитесь текущих попыток перед совместной проверкой');
      for (const v of tx.verifications()) {
        if (v.status !== 'active') continue;
        if (v.leaseUntil > this.now())
          throw new HarnessError('NOT_READY', 'Совместная проверка уже выполняется');
        const error = 'Истёк срок владения проверкой';
        tx.putVerification({ ...v, status: 'failed', error, finishedAt: iso(this.now()) });
        tx.emit({
          type: 'joint.finished',
          payload: { verificationId: v.id, status: 'failed', error },
        });
      }
      const previous = tx.verifications().filter((v) => sameWorks(v.workIds, input.workIds));
      if (previous.length >= this.policy.maxAttempts)
        throw new HarnessError(
          'ATTEMPTS_EXHAUSTED',
          'Исчерпан предел совместных проверок этого набора',
        );
      const works = input.workIds.map((id) => tx.work(id));
      if (works.some((w) => !w || w.status !== 'done' || !w.resultSha))
        throw new HarnessError('NOT_READY', 'Сначала завершите все поручения набора');
      if (input.baseline && tx.verification(input.baseline)?.status !== 'passed')
        throw new HarnessError('INVALID_INPUT', 'Базовая проверка не найдена или не успешна');
      const at = this.now();
      const v: JointVerificationState = {
        apiVersion: 'devcontour-harness/v1alpha1',
        id: this.id(),
        token: this.id() + this.id(),
        startedAt: iso(at),
        leaseUntil: at + this.policy.leaseMs,
        status: 'active',
        policyDigest: jointPolicyDigest(this.policy),
        specDigest: jointSpecDigest(tx, input.workIds),
        workIds: [...input.workIds],
        ...(input.baseline
          ? {
              impact: {
                changed: [],
                affected: [],
                gateIds: [],
                mode: 'all' as const,
                reason: 'manifest ещё не закреплён',
                baseline: input.baseline,
              },
            }
          : {}),
        evidence: [],
      };
      tx.putVerification(v);
      tx.emit({
        type: 'joint.started',
        payload: { verificationId: v.id, workIds: v.workIds, policyDigest: v.policyDigest },
      });
      return v;
    });
  }

  /**
   * Fencing совместной проверки: активна, токен её, срок не истёк, политика
   * и основание (поручения, их постановки и результаты) не изменились.
   */
  private jointUpdate<T>(
    id: string,
    token: string,
    kind: TransactionKind,
    fn: (v: JointVerificationState, tx: ExecutionTransaction) => NotPromise<T>,
  ): T {
    return this.tx(kind, (tx) => {
      if (kind !== 'heartbeat') this.assertCurrentPolicy(tx);
      const v = tx.verification(id);
      if (!v || v.status !== 'active' || v.token !== token || v.leaseUntil <= this.now())
        throw new HarnessError('LEASE_STALE', 'Устаревшая попытка совместной проверки');
      if (
        v.policyDigest !== jointPolicyDigest(this.policy) ||
        v.specDigest !== jointSpecDigest(tx, v.workIds)
      )
        throw new HarnessError(
          'APPROVAL_STALE',
          'Состав набора или политика изменились; нужна новая проверка',
        );
      return fn(v, tx);
    });
  }

  jointHeartbeat(id: string, token: string) {
    this.jointUpdate(id, token, 'heartbeat', (v, tx) =>
      tx.putVerification({ ...v, leaseUntil: this.now() + this.policy.leaseMs }),
    );
  }

  /**
   * Закрепить manifest: SHA и tree каждого репозитория политики. Закрепляется
   * один раз; по нему же выбирается область проверки.
   */
  jointManifest(id: string, token: string, manifest: NonNullable<JointVerification['manifest']>) {
    return this.jointUpdate(id, token, 'workspace.manifest', (v, tx) => {
      if (v.manifest) throw new HarnessError('INVALID_INPUT', 'Manifest уже закреплён');
      const ids = this.policy.repositories.map((r) => r.id).sort();
      const sha = /^[a-f0-9]{40,64}$/;
      if (
        JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(ids) ||
        Object.values(manifest).some((m) => !sha.test(m.sha) || !sha.test(m.tree))
      )
        throw new HarnessError(
          'INVALID_INPUT',
          'Manifest должен фиксировать SHA и tree каждого репозитория',
        );
      const baseline = v.impact?.baseline ? tx.verification(v.impact.baseline) : undefined;
      const impact = jointImpact(this.policy, manifest, v.policyDigest, baseline);
      const next = { ...v, manifest, manifestDigest: digestOf(manifest), impact };
      tx.putVerification(next);
      return next;
    });
  }

  jointEvidence(id: string, token: string, evidence: JointVerification['evidence'][number]) {
    this.jointUpdate(id, token, 'workspace.evidence', (v, tx) => {
      if (!v.manifest) throw new HarnessError('NOT_READY', 'Нет закреплённого manifest');
      tx.putVerification({ ...v, evidence: [...v.evidence, evidence] });
    });
  }

  private jointMissing(v: JointVerificationState) {
    if (!v.manifest || digestOf(v.manifest) !== v.manifestDigest)
      return 'Нет закреплённого manifest';
    for (const gate of this.policy.workspaceGates.filter(
      (g) => !v.impact || v.impact.gateIds.includes(g.id),
    ))
      if (!v.evidence.findLast((e) => e.gate === gate.id)?.passed) return `Нет PASS: ${gate.id}`;
    return undefined;
  }

  jointFinish(id: string, token: string) {
    return this.jointUpdate(id, token, 'workspace.verified', (v, tx) => {
      const missing = this.jointMissing(v);
      if (missing) throw new HarnessError('GATE_FAILED', missing);
      const next: JointVerificationState = {
        ...v,
        status: 'passed',
        manifest: v.manifest!,
        manifestDigest: v.manifestDigest!,
        finishedAt: iso(this.now()),
      };
      tx.putVerification(next);
      tx.emit({
        type: 'joint.finished',
        payload: { verificationId: id, status: 'passed', manifestDigest: v.manifestDigest! },
      });
      return publicJoint(next);
    });
  }

  /** Отказ проверки её владельцем; истёкший срок допустим, чужой токен — нет. */
  jointFail(id: string, token: string, error: string) {
    return this.tx('workspace.failed', (tx) => {
      const v = tx.verification(id);
      if (!v || v.status !== 'active' || v.token !== token) return false;
      const message = error.slice(0, 4000) || 'Совместная проверка не прошла';
      tx.putVerification({ ...v, status: 'failed', error: message, finishedAt: iso(this.now()) });
      tx.emit({
        type: 'joint.finished',
        payload: { verificationId: id, status: 'failed', error: message },
      });
      return true;
    });
  }

  /**
   * Актуальный результат совместной проверки набора: последняя проверка этого
   * набора, успешная, с целым manifest, под текущей политикой, на неизменном
   * основании, с PASS каждого gate своей области. Иначе — причина; прежний
   * результат как актуальный не выдаётся.
   */
  jointResult(workIds: string[]): {
    verification?: JointVerification;
    current: boolean;
    reason?: string;
  } {
    return this.read((v) => {
      const last = v
        .verifications()
        .filter((x) => sameWorks(x.workIds, workIds))
        .at(-1);
      if (!last) return { current: false, reason: 'Совместной проверки этого набора нет' };
      const verification = publicJoint(last);
      const reason =
        last.status !== 'passed'
          ? `Последняя проверка: ${last.status}${last.status === 'failed' ? ' — ' + last.error : ''}`
          : last.policyDigest !== jointPolicyDigest(this.policy)
            ? 'Политика совместной проверки изменилась'
            : last.specDigest !== jointSpecDigest(v, last.workIds)
              ? 'Поручения набора или их результаты изменились'
              : this.jointMissing(last);
      return reason ? { verification, current: false, reason } : { verification, current: true };
    });
  }

  /** Истёкшие попытки: отказ окружения, работа ждёт явного повтора. */
  expire() {
    return this.tx('runs.expired', (tx) => {
      const ids: string[] = [];
      for (const a of tx.attempts())
        if (a.status === 'active' && a.leaseUntil <= this.now()) {
          const error =
            (a.error?.startsWith(HEARTBEAT_FAILED) ? a.error + '. ' : '') +
            'Истёк срок владения. Повторите явно.';
          const fingerprint = failureFingerprint('environment', error);
          tx.putAttempt({
            ...a,
            status: 'expired',
            finishedAt: iso(this.now()),
            error,
            failureKind: 'environment',
            failureFingerprint: fingerprint,
          });
          const w = tx.work(a.workId)!;
          if (w.activeRunId === a.id)
            tx.putWork({
              ...w,
              status: 'failed',
              failure: error,
              failureKind: 'environment',
              failureFingerprint: fingerprint,
              activeRunId: undefined,
            });
          tx.emit({
            type: 'attempt.expired',
            workId: a.workId,
            runId: a.id,
            attempt: a.attempt,
            payload: { leaseUntil: a.leaseUntil },
          });
          ids.push(a.id);
        }
      return ids;
    });
  }

  /** Восстановление: новый владелец истёкшей активной попытки получает новый токен. Старый токен недействителен. */
  adopt(id: string, owner: string): AttemptState {
    return this.tx('run.recovered', (tx) => {
      const a = tx.attempt(id);
      if (!a) throw new HarnessError('NOT_FOUND', 'Попытка не найдена: ' + id);
      if (a.status !== 'active' || a.leaseUntil > this.now())
        throw new HarnessError('LEASE_STALE', 'Попытка ещё принадлежит владельцу');
      const adopted = {
        ...a,
        token: this.id() + this.id(),
        owner,
        leaseUntil: this.now() + this.policy.leaseMs,
      };
      tx.putAttempt(adopted);
      return adopted;
    });
  }

  /** Recovery отклонил продолжение: попытка истечёт на следующем `expire`. */
  rejectRecovery(id: string, reason: string) {
    return this.tx('recovery.rejected', (tx) => {
      const a = tx.attempt(id);
      if (a?.status !== 'active') return false;
      tx.putAttempt({ ...a, leaseUntil: 0 });
      if (a.integrationSha)
        tx.emit({
          type: 'attempt.recovered',
          workId: a.workId,
          runId: a.id,
          attempt: a.attempt,
          payload: {
            integrationSha: a.integrationSha,
            accepted: false,
            reason: reason.slice(0, 4000),
          },
        });
      return true;
    });
  }

  /** Отмена: активная попытка теряет владение, поручение — cancelled. Принятое не отменяется. */
  cancel(workId: string, reason = 'отменено оператором') {
    return this.tx('task.cancelled', (tx) => {
      const w = tx.work(workId);
      if (!w) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + workId);
      if (w.status === 'done')
        throw new HarnessError('NOT_READY', 'Принятый результат не отменяется');
      if (w.status === 'cancelled') return { work: w, changed: false };
      const a = w.activeRunId ? tx.attempt(w.activeRunId) : undefined;
      if (a) {
        tx.putAttempt({
          ...a,
          status: 'cancelled',
          finishedAt: iso(this.now()),
          failureKind: 'cancelled',
        });
        tx.emit({
          type: 'attempt.cancelled',
          workId,
          runId: a.id,
          attempt: a.attempt,
          payload: { reason: reason.slice(0, 4000) },
        });
      }
      const next: WorkState = {
        ...w,
        status: 'cancelled',
        activeRunId: undefined,
        failureKind: 'cancelled',
      };
      tx.putWork(next);
      return { work: next, changed: true };
    });
  }

  /**
   * Повтор неуспешного или отменённого поручения. Пока попытки не
   * исчерпаны — без сброса; исчерпаны — только явный сброс с причиной.
   * Класс и отпечаток прошлого отказа снимаются.
   */
  retry(workId: string, reset?: { reason: string }) {
    return this.tx('task.retry', (tx) => {
      const w = tx.work(workId);
      if (!w) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + workId);
      const exhausted = w.attempt >= this.policy.maxAttempts;
      if (w.status === 'ready' && !exhausted) return { work: w, changed: false };
      if (!['failed', 'cancelled'].includes(w.status) && !(exhausted && !w.activeRunId))
        throw new HarnessError('NOT_READY', 'Повтор доступен после отказа или отмены');
      if (exhausted && !reset?.reason.trim())
        throw new HarnessError(
          'ATTEMPTS_EXHAUSTED',
          'Исчерпан лимит попыток; повторите со сбросом и причиной',
        );
      const next: WorkState = {
        ...w,
        status: w.approvedDigest ? 'ready' : 'draft',
        attempt: exhausted ? 0 : w.attempt,
        failure: undefined,
        failureKind: undefined,
        failureFingerprint: undefined,
      };
      tx.putWork(next);
      return { work: next, changed: true };
    });
  }
}
