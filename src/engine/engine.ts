import { randomUUID } from 'node:crypto';
import {
  HarnessError,
  WORKSPACE_OWNER,
  digestOf,
  expandGateRefs,
  graphIssues,
  selectReviewer,
  workGraphDigest,
  type AttemptState,
  type EvidenceRecord,
  type ExecutionHost,
  type ExecutionPolicy,
  type ExecutionTransaction,
  type ExecutionView,
  type FailureKind,
  type GraphState,
  type NotPromise,
  type Prerequisite,
  type ReviewRecord,
  type TechnicalApproval,
  type TransactionKind,
  type WorkGraph,
  type WorkState,
} from '../contracts/index.ts';
import { HARNESS_VERSION } from '../package.ts';
import { failureFingerprint, repairPolicy } from './failure.ts';

/** Префикс причины неудавшегося продления: первая причина не затирается следствиями. */
export const HEARTBEAT_FAILED = 'Продление владения не удалось';

export interface EngineOptions {
  host: ExecutionHost;
  policy: ExecutionPolicy;
  /** Версия движка в попытках; по умолчанию — версия пакета. */
  version?: string;
  now?: () => number;
  id?: () => string;
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

  constructor(options: EngineOptions) {
    this.host = options.host;
    this.policy = options.policy;
    this.version = options.version ?? HARNESS_VERSION;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
  }

  /** Часы движка: по ним считаются сроки владения. */
  clock() {
    return this.now();
  }

  private tx<T>(kind: TransactionKind, fn: (tx: ExecutionTransaction) => NotPromise<T>): T {
    return this.host.store.transact(kind, fn);
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
        policyDigest: digestOf(this.policy),
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
        tx.putWork({
          id: order.id,
          graphId: graph.id,
          order,
          status: 'draft',
          attempt: prior?.attempt ?? 0,
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
  recordReview(record: ReviewRecord) {
    return this.tx('graph.reviewed', (tx) => {
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
   * Согласование графа. Привязано к digest проверенного предложения: в
   * режиме `agent` нужен одобренный последний раунд ревью этого digest, в
   * режиме `operator` — проведённое ревью этого digest и решение оператора.
   * Другого способа сделать поручения готовыми к выдаче нет.
   */
  approve(graphId: string, actor: TechnicalApproval['actor']) {
    return this.tx('graph.approved', (tx) => {
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
      const policy = digestOf(this.policy);
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
        const ready: WorkState = {
          ...work,
          status: 'ready',
          approvedAt: at,
          approvedDigest: this.host.basis.orderDigest(work, tx),
          approvedScope: this.host.basis.scopeDigest(work, tx),
          approval,
        };
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
    if (result && acquired)
      this.tx('scheduler.started', (tx) =>
        tx.emit({ type: 'controller.acquired', payload: { owner } }),
      );
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

  /** Пауза оператора или штатной остановки: новые claims запрещены. */
  pause(reason: 'operator' | 'shutdown') {
    return this.tx('scheduler.paused', (tx) => {
      const control = tx.control();
      if (control.paused && control.pauseReason === reason) return { control, changed: false };
      // Пауза отказа runtime или операции сохраняет своё имя: снимать её вправе только они.
      const next =
        control.paused &&
        control.pauseReason &&
        !['operator', 'shutdown'].includes(control.pauseReason)
          ? control
          : { ...control, paused: true, pauseReason: reason, pausedAt: iso(this.now()) };
      if (next === control) return { control, changed: false };
      tx.setControl(next);
      tx.emit({ type: 'control.paused', payload: { reason } });
      return { control: next, changed: true };
    });
  }

  /**
   * Снять паузу оператора или штатной остановки. Пауза отказа runtime
   * (`pauseFailures`) и пауза операции не снимаются: `PAUSED`.
   */
  resume() {
    return this.tx('scheduler.started', (tx) => {
      const control = tx.control();
      if (!control.paused) return { control, changed: false };
      if (
        control.pauseFailures?.length ||
        (control.pauseReason && !['operator', 'shutdown'].includes(control.pauseReason))
      )
        throw new HarnessError(
          'PAUSED',
          `Выдачу держит ${control.pauseFailures?.length ? 'отказ: ' + control.pauseFailures.join(', ') : 'операция: ' + control.pauseReason}; её снимает устранение причины`,
        );
      const reason = control.pauseReason ?? 'operator';
      const next = { ...control, paused: false, pauseReason: undefined, pausedAt: undefined };
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

  /** Почему поручение сейчас не выдаётся; пусто — может быть выдано. */
  blockers(work: WorkState, view: ExecutionView) {
    const out: {
      code: 'NOT_READY' | 'PAUSED' | 'ATTEMPTS_EXHAUSTED' | 'APPROVAL_STALE' | 'APPROVAL_REQUIRED';
      message: string;
    }[] = [];
    if (view.control().paused)
      out.push({
        code: 'PAUSED',
        message: 'Очередь на паузе: ' + (view.control().pauseReason ?? 'operator'),
      });
    if (work.status === 'draft')
      out.push({ code: 'APPROVAL_REQUIRED', message: 'Граф не согласован' });
    const graph = view.graph(work.graphId);
    if (graph?.approval && graph.policyDigest !== digestOf(this.policy))
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
    if (work.status === 'ready' && work.approvedDigest !== this.host.basis.orderDigest(work, view))
      out.push({ code: 'APPROVAL_STALE', message: 'Постановка изменилась после согласования' });
    const refusal = this.host.guards.claimable(work, view);
    if (refusal) out.push(refusal);
    return out;
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
      const active = tx.attempts().filter((a) => a.status === 'active');
      if (active.length >= this.policy.concurrency) return undefined;
      const eligible = tx.works().filter((w) => {
        if (w.status !== 'ready' || w.hold || w.budgetBlock) return false;
        if (w.attempt >= this.policy.maxAttempts) return false;
        const graph = tx.graph(w.graphId);
        // Согласование привязано к graph digest и к политике, под которой оно дано.
        if (!graph?.approval || graph.approval.digest !== graph.digest) return false;
        if (graph.policyDigest !== digestOf(this.policy)) return false;
        const external = new Set(graph.graph.prerequisites.map((p) => p.id));
        if (!w.order.dependsOn.every((d) => external.has(d) || tx.work(d)?.status === 'done'))
          return false;
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
        requiredGates: expandGateRefs(repo, work.order.gates),
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
        callsRecorded: true,
        evidence: [],
      };
      tx.putAttempt(attempt);
      tx.putWork({
        ...work,
        status: 'running',
        attempt: attempt.attempt,
        activeRunId: attempt.id,
        failure: undefined,
      });
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
      if (a.phase !== 'integrating' || !a.candidateSha || a.integrationSha !== sha)
        throw new HarnessError('NOT_READY', 'Нет интеграционного коммита');
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
      const refusal = this.host.guards.beforeAccept(w, a, tx);
      if (refusal) throw new HarnessError(refusal.code, refusal.message);
      const at = iso(this.now());
      tx.putAttempt({ ...a, status: 'succeeded', finishedAt: at });
      tx.putWork({
        ...w,
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
    options: { kind?: FailureKind; blocked?: boolean; heartbeatCause?: string } = {},
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
      tx.putAttempt({
        ...a,
        status: 'failed',
        error: shown,
        ...(blocked ? { blocked: true } : {}),
        failureKind: kind,
        failureFingerprint: fingerprint,
        finishedAt: iso(this.now()),
      });
      tx.putWork({
        ...w,
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
      return { workId: w.id, runId: id, kind, blocked };
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
