import { hostname } from 'node:os';
import {
  HarnessError,
  digestOf,
  sha256,
  type DeliveryOutcome,
  type ResultSink,
  type RunResult,
} from '../../contracts/index.ts';
import { redactor, type Redactor } from '../../environment/redaction.ts';
import {
  completionColumn,
  orderIdOf,
  parseIdentity,
  type ConnectorConfig,
  type TaskMapping,
} from './config.ts';
import type { HistoryRecorder } from './history.ts';
import { maskError, redactingTransport } from './redact.ts';
import { matchCriterion, readFailure, semanticDigest, type SnapshotManifest } from './snapshot.ts';
import {
  StepConflict,
  StepRetry,
  StepUncertain,
  newStep,
  runStep,
  type ReadBack,
} from './steps.ts';
import type { ConnectorStore, OperationRecord, StepRecord } from './store.ts';
import { summaryText, type CriterionOutcome } from './summary.ts';
import type { RelayTransport, TaskColumn, TaskRead } from './transport.ts';

/**
 * Получатель результата во внешнем хранилище задач с сохраняемым протоколом.
 *
 * Ключ операции — `hash(provider, projectId, workId, runId, resultDigest)`.
 * Intent записывается в состояние коннектора **до** внешнего вызова; без него
 * мутация не отправляется. Каждый шаг (комментарий с маркером, отметки
 * критериев с CAS, перемещение с CAS, история) записывается до и после
 * вызова; неизвестный исход разбирается read-back по маркеру или сравнением
 * состояния, а не повтором. Неоднозначность — `uncertain` и явный
 * `source-reconcile`.
 *
 * Владелец доставки один: lease с токеном, сроком и fencing в той же SQLite.
 * Гарантия действует для процессов с общим каталогом состояния коннектора;
 * независимые установки с разными каталогами вне её. Distributed
 * exactly-once не заявляется: у получателя нет идемпотентности по requestId.
 */

export const operationKey = (
  provider: string,
  projectId: string,
  workId: string,
  runId: string,
  resultDigest: string,
) => sha256(JSON.stringify([provider, projectId, workId, runId, resultDigest]));

export type CriterionPlan = CriterionOutcome;

export interface SinkOptions {
  config: ConnectorConfig;
  transport: RelayTransport;
  store: ConnectorStore;
  connectorId: string;
  history?: HistoryRecorder;
  /** Владелец lease (для диагностики); по умолчанию host:pid. */
  owner?: string;
  redact?: Redactor;
}

/** Решение оператора при reconcile неоднозначного шага. */
export type ReconcileDecision =
  /** Доказано вне harness, что записи нет: отправить шаг снова (маркер тот же). */
  | { kind: 'resend' }
  /** Несколько записей с маркером: явно выбрать одну как подтверждение. */
  | { kind: 'adopt'; id: string }
  /** Конфликт CAS из-за несемантического изменения: перепроверить постановку и продолжить. */
  | { kind: 'recheck' };

const evidenceFor = (result: RunResult, m: TaskMapping['criteria'][number]) =>
  result.evidence.find(
    (e) =>
      e.gate === m.gate &&
      e.phase === 'integration' &&
      e.passed &&
      !e.consumer &&
      (m.evidence === 'gate' ||
        (e.tests ?? []).some((t) => t.id === m.testId && t.status === 'passed')),
  );

export class RelaySink implements ResultSink {
  readonly id: string;
  private readonly owner: string;
  private readonly redact: Redactor;
  private readonly t: RelayTransport;

  constructor(readonly options: SinkOptions) {
    this.id = options.connectorId;
    this.owner = options.owner ?? `${hostname()}:${process.pid}`;
    this.redact = options.redact ?? redactor([]);
    this.t = redactingTransport(options.transport, this.redact);
  }
  private get config() {
    return this.options.config;
  }

  /** Задача и её mapping по результату; чужой provider/проект — отказ до записи. */
  private taskOf(result: RunResult) {
    const identity = parseIdentity(result.source.ref);
    if (
      !identity ||
      identity.provider !== this.config.provider ||
      identity.projectId !== this.config.projectId ||
      result.source.connector !== this.id
    )
      throw new HarnessError(
        'INVALID_INPUT',
        `Результат относится к другому источнику (${result.source.connector}:${result.source.ref}); этот коннектор — ${this.id}`,
      );
    return identity.taskId;
  }

  private sameSnapshot(op: OperationRecord, read: TaskRead) {
    const mapping = this.mappingOf(read);
    return mapping !== undefined && semanticDigest(this.config, mapping, read) === op.revision;
  }

  private mappingOf(read: TaskRead): TaskMapping | undefined {
    return this.config.tasks.find((m) => m.ref === read.task.id || m.ref === read.task.key);
  }

  keyOf(result: RunResult) {
    return operationKey(
      this.config.provider,
      this.config.projectId,
      result.workOrderId,
      result.runId,
      digestOf(result),
    );
  }

  private outcomeOf(op: OperationRecord): DeliveryOutcome {
    if (op.status === 'delivered')
      return { status: 'delivered', receipt: `${this.id}:${op.taskId}:${op.key.slice(0, 16)}` };
    if (op.status === 'uncertain')
      return { status: 'uncertain', operation: op.key, reason: op.reason ?? 'исход не доказан' };
    return { status: 'conflict', currentRevision: op.currentRevision ?? 'unknown' };
  }

  async deliver(input: { key: string; result: RunResult }): Promise<DeliveryOutcome> {
    try {
      return await this.deliverOnce(input.result);
    } catch (error) {
      // Ошибка доставки сохраняется в lastError и выводится CLI: только в маскированном виде.
      throw maskError(error, this.redact);
    }
  }

  private async deliverOnce(result: RunResult): Promise<DeliveryOutcome> {
    const taskId = this.taskOf(result);
    const key = this.keyOf(result);
    const store = this.options.store;
    const settled = (op?: OperationRecord) =>
      op && (op.status === 'delivered' || op.status === 'uncertain' || op.status === 'conflict');
    const prior = store.operation(key);
    // Подтверждённая доставка, неизвестный исход и конфликт не повторяются автоматически.
    if (settled(prior)) return this.outcomeOf(prior!);
    const { lease, holder } = store.acquire(key, this.owner, this.config.limits.leaseMs);
    if (!lease)
      throw new HarnessError(
        'CONTROLLER_BUSY',
        `Доставку ${key.slice(0, 16)} ведёт другой владелец (${holder!.owner}, до ${new Date(holder!.expiresAt).toISOString()})`,
      );
    // Живой владелец продлевает lease и во время долгого вызова: перехват
    // возможен только после остановки процесса (crash) и истечения срока.
    // Продление — отдельная короткая транзакция, вне вызова транспорта.
    const heartbeat = setInterval(
      () => {
        try {
          store.renew(key, lease.token, this.config.limits.leaseMs);
        } catch {
          /* Утраченное владение проверит следующая fenced-запись. */
        }
      },
      Math.max(200, Math.floor(this.config.limits.leaseMs / 3)),
    );
    try {
      // Intent — до любого внешнего вызова; отказ записи — исключение без мутации.
      let op = store.putIntent(
        {
          key,
          provider: this.config.provider,
          projectId: this.config.projectId,
          workId: result.workOrderId,
          runId: result.runId,
          taskId,
          resultDigest: digestOf(result),
          revision: result.source.revision,
          outcome: result.outcome,
        },
        lease.token,
      );
      if (settled(op)) return this.outcomeOf(op);
      if (!op.planned) op = await this.plan(op, result, lease.token);
      op = await this.execute(op, result, lease.token);
      return this.outcomeOf(op);
    } finally {
      clearInterval(heartbeat);
      store.release(key, lease.token);
    }
  }

  /** Предварительная сверка постановки и eligibility, затем план шагов — до первой мутации. */
  private async plan(op: OperationRecord, result: RunResult, token: string) {
    const store = this.options.store;
    let read: TaskRead;
    try {
      read = await this.t.readTask(op.taskId);
    } catch (error) {
      const failure = readFailure(error, 'Задача ' + op.taskId);
      if (failure.code === 'NOT_READY')
        return store.updateOp(op.key, token, (o) => ({
          ...o,
          planned: true,
          status: 'conflict',
          currentRevision: 'removed',
          reason: failure.message,
        }));
      throw failure;
    }
    const mapping = this.mappingOf(read);
    const digest = mapping ? semanticDigest(this.config, mapping, read) : 'unmapped';
    const problem =
      digest !== op.revision
        ? `постановка изменилась после снимка (${op.revision.slice(0, 12)} → ${digest.slice(0, 12)}): результат относится к прежней редакции`
        : read.task.column === 'cancelled'
          ? 'задача отменена'
          : read.task.column === 'done'
            ? 'задача уже завершена другим участником'
            : undefined;
    const identity = `${this.config.provider}:${this.config.projectId}:${read.task.id}`;
    // Принятое без доказательства остаётся видно в итоге: только этой постановки.
    const pinned = store.latestSnapshot(result.graphId)?.manifest as SnapshotManifest | undefined;
    const accepted = pinned?.tasks
      .find((t) => t.id === read.task.id && t.semanticDigest === digest)
      ?.dependencies.filter((d) => d.proof === 'baseline')
      .map((d) => d.key);
    const base = {
      casRevision: read.task.revision,
      taskKey: read.task.key,
      identity,
      ...(accepted?.length && pinned?.baseline
        ? { baseline: { ...pinned.baseline, tasks: accepted } }
        : {}),
    };
    if (problem) {
      // Текущая задача не закрывается старым результатом; допустим только явно исторический комментарий.
      const steps =
        this.config.completion.historicalComment && result.outcome === 'accepted'
          ? [newStep(1, 'historical-comment', op.key, { ...base, historical: true })]
          : [];
      return store.updateOp(op.key, token, (o) => ({
        ...o,
        planned: true,
        steps,
        status: steps.length ? 'in-progress' : 'conflict',
        currentRevision: digest,
        reason: problem,
        receipt: { conflict: problem },
      }));
    }
    const criteria = this.criteriaPlan(result, read, mapping!);
    const steps: StepRecord[] = [newStep(1, 'comment', op.key, { ...base, criteria })];
    for (const c of criteria.filter((x) => x.outcome === 'closed'))
      steps.push(newStep(steps.length + 1, 'criterion', op.key, { criterionId: c.criterionId }));
    const move = this.movePlan(result, read, criteria);
    if (move.column) steps.push(newStep(steps.length + 1, 'move', op.key, { column: move.column }));
    if (this.options.history?.enabled) steps.push(newStep(steps.length + 1, 'history', op.key, {}));
    return store.updateOp(op.key, token, (o) => ({
      ...o,
      planned: true,
      steps,
      status: 'in-progress',
      receipt: { criteria, completion: move.reason, casRevision: read.task.revision },
    }));
  }

  /** Критерий закрывается только явным mapping на прошедший gate/testcase принятого результата. */
  private criteriaPlan(result: RunResult, read: TaskRead, mapping: TaskMapping): CriterionPlan[] {
    return read.task.criteria.map((c) => {
      const rule = mapping.criteria.find((m) => matchCriterion([c], m).length === 1);
      if (!rule)
        return {
          criterionId: c.id,
          title: c.title,
          outcome: c.completed ? 'already' : 'manual',
          ...(c.completed ? {} : { reason: 'нет mapping: ручной критерий' }),
        };
      const target = { gate: rule.gate, ...(rule.testId ? { testId: rule.testId } : {}) };
      if (result.outcome !== 'accepted')
        return {
          criterionId: c.id,
          title: c.title,
          ...target,
          outcome: c.completed ? 'already' : 'unproven',
          reason: 'результат не принят',
        };
      const evidence = evidenceFor(result, rule);
      if (!evidence)
        return {
          criterionId: c.id,
          title: c.title,
          ...target,
          outcome: c.completed ? 'already' : 'unproven',
          reason:
            rule.evidence === 'gate'
              ? 'gate не прошёл в integration'
              : `testcase ${rule.testId} не прошёл`,
        };
      return {
        criterionId: c.id,
        title: c.title,
        ...target,
        outcome: c.completed ? 'already' : 'closed',
      };
    });
  }

  private movePlan(
    result: RunResult,
    read: TaskRead,
    criteria: CriterionPlan[],
  ): { column?: TaskColumn; reason: string } {
    if (result.outcome !== 'accepted')
      return { reason: 'результат не принят: задача не перемещается' };
    const target = completionColumn(this.config);
    const blockers = [
      ...criteria
        .filter((c) => c.outcome === 'manual' || c.outcome === 'unproven')
        .map((c) => `критерий «${c.title}» (${c.outcome})`),
      ...read.children.filter((c) => !c.finished).map((c) => `подзадача ${c.key}`),
      ...read.dependencies.filter((d) => !d.finished).map((d) => `зависимость ${d.key}`),
    ];
    if (this.config.completion.mode === 'review-only') {
      if (target === 'done') return { reason: 'review-only: done не выставляется' };
      return read.task.column === target
        ? { reason: `review-only: задача уже в ${target}` }
        : { column: target, reason: `review-only: задача оставлена на проверку (${target})` };
    }
    if (target === 'done' && blockers.length)
      return { reason: 'задача не завершена: ' + blockers.join(', ') };
    if (read.task.column === target) return { reason: `задача уже в ${target}` };
    return { column: target, reason: `задача перемещена в ${target}` };
  }

  /** Выполнить оставшиеся шаги по протоколу; итог — новое состояние операции. */
  private async execute(op: OperationRecord, result: RunResult, token: string) {
    const store = this.options.store;
    const leaseMs = this.config.limits.leaseMs;
    try {
      for (const planned of op.steps) {
        store.renew(op.key, token, leaseMs);
        const n = planned.n;
        const io = {
          load: () => store.operation(op.key)!.steps.find((s) => s.n === n)!,
          save: (step: StepRecord) =>
            void store.updateOp(
              op.key,
              token,
              (o) => ({
                ...o,
                steps: o.steps.map((s) => (s.n === n ? step : s)),
              }),
              'step',
            ),
        };
        const current = io.load();
        if (current.status !== 'done' && current.status !== 'skipped')
          await this.verifyBefore(store.operation(op.key)!, current, token);
        await runStep(io, this.handlers(store.operation(op.key)!, planned, result));
      }
    } catch (error) {
      const status =
        error instanceof StepUncertain
          ? 'uncertain'
          : error instanceof StepConflict
            ? 'conflict'
            : error instanceof StepRetry
              ? 'failed'
              : undefined;
      if (!status) throw error;
      const after = store.updateOp(op.key, token, (o) => ({
        ...o,
        status,
        reason: (error as Error).message,
        ...(status === 'conflict'
          ? {
              currentRevision:
                (error as StepConflict).currentRevision ?? o.currentRevision ?? 'cas-conflict',
            }
          : {}),
      }));
      if (status === 'failed')
        throw new HarnessError('DELIVERY_FAILED', 'Доставка не завершена: ' + after.reason);
      return after;
    }
    const final = store.operation(op.key)!;
    if (final.receipt?.conflict)
      return store.updateOp(op.key, token, (o) => ({ ...o, status: 'conflict' }));
    const comment = final.steps.find((s) => s.kind === 'comment');
    const last = [...final.steps].reverse().find((s) => s.result?.revision !== undefined);
    const receipt = {
      ...final.receipt,
      operation: op.key,
      connector: this.id,
      taskId: op.taskId,
      commentId: comment?.result?.commentId,
      revision: last?.result?.revision ?? final.receipt?.casRevision,
      history: final.steps.find((s) => s.kind === 'history')?.result,
      deliveredAt: new Date().toISOString(),
    };
    if (result.outcome === 'accepted')
      store.putReceipt(
        {
          issuer: this.id,
          orderId: orderIdOf(this.config.provider, this.config.projectId, op.taskId),
          taskId: op.taskId,
          repositoryId: result.repositoryId,
          resultSha: result.shas.result,
          workId: result.workOrderId,
          runId: result.runId,
          operation: op.key,
        },
        token,
      );
    return store.updateOp(op.key, token, (o) => ({ ...o, status: 'delivered', receipt }));
  }

  /**
   * Сверка перед каждым неподтверждённым шагом (и при продолжении после
   * обрыва): постановка та же (semantic digest), задача не отменена и не
   * закрыта другим, а для нового CAS-шага текущая ревизия равна ревизии,
   * записанной после **нашего** предыдущего шага. Иначе — conflict: старый
   * результат не применяется к изменённой задаче.
   */
  private async verifyBefore(op: OperationRecord, step: StepRecord, token: string) {
    if (step.kind === 'historical-comment' || step.kind === 'history') return;
    const conflict = (reason: string, currentRevision?: string): never => {
      this.options.store.updateOp(op.key, token, (o) => ({
        ...o,
        steps: o.steps.map((s) =>
          s.n === step.n
            ? { ...s, status: 'conflict', reason, updatedAt: new Date().toISOString() }
            : s,
        ),
      }));
      throw new StepConflict(step.n, reason, currentRevision);
    };
    let read: TaskRead;
    try {
      read = await this.t.readTask(op.taskId);
    } catch (error) {
      const failure = readFailure(error, 'Задача ' + op.taskId);
      if (failure.code === 'NOT_READY') return conflict(failure.message, 'removed');
      throw new StepRetry(step.n, 'сверка перед шагом не выполнена: ' + failure.message);
    }
    if (!this.sameSnapshot(op, read)) {
      const mapping = this.mappingOf(read);
      const digest = mapping ? semanticDigest(this.config, mapping, read) : 'unmapped';
      return conflict(
        `постановка изменилась во время доставки (${op.revision.slice(0, 12)} → ${digest.slice(0, 12)}): результат относится к прежней редакции`,
        digest,
      );
    }
    if (read.task.column === 'cancelled') return conflict('задача отменена во время доставки');
    const ourMove = op.steps.some((s) => s.kind === 'move' && s.status === 'done');
    if (read.task.column === 'done' && !ourMove && step.kind !== 'move')
      return conflict('задача завершена другим участником во время доставки');
    if (step.status === 'planned' && (step.kind === 'criterion' || step.kind === 'move')) {
      const expected = this.revisionBefore(op, step.n);
      if (read.task.revision !== expected)
        return conflict(
          `ревизия задачи ${expected} → ${read.task.revision} без нашей записи (чужое изменение): старая команда по новой ревизии не применяется`,
          `cas:${read.task.revision}`,
        );
    }
  }

  /** Последняя подтверждённая CAS-ревизия задачи перед шагом `n`. */
  private revisionBefore(op: OperationRecord, n: number): number {
    // После явного recheck оператора отсчёт идёт от перечитанной ревизии.
    const from = (op.receipt?.rebasedFrom as number | undefined) ?? 0;
    const done = op.steps
      .filter(
        (s) =>
          s.n < n && s.n >= from && s.status === 'done' && typeof s.result?.revision === 'number',
      )
      .at(-1);
    return (
      (done?.result?.revision as number | undefined) ??
      (op.receipt?.casRevision as number) ??
      (op.steps[0]?.input.casRevision as number)
    );
  }

  private handlers(op: OperationRecord, step: StepRecord, result: RunResult) {
    const t = this.t;
    const taskId = op.taskId;
    switch (step.kind) {
      case 'comment':
      case 'historical-comment': {
        const text = summaryText({
          marker: step.marker,
          result,
          task: { key: step.input.taskKey as string, identity: step.input.identity as string },
          snapshot: { revision: op.revision, casRevision: step.input.casRevision as number },
          criteria: (step.input.criteria as CriterionOutcome[] | undefined) ?? [],
          completion: (op.receipt?.completion as string | undefined) ?? op.reason ?? '',
          historical: step.kind === 'historical-comment',
          ...(step.input.baseline
            ? { baseline: step.input.baseline as { tasks: string[]; sha: string; reason: string } }
            : {}),
          redact: this.redact,
        });
        return {
          appendOnly: true,
          send: async () => ({ commentId: (await t.addComment(taskId, text)).commentId }),
          readBack: async (): Promise<ReadBack> => {
            const found = (await t.listComments(taskId)).filter((c) =>
              c.body.includes(step.marker),
            );
            if (found.length === 1) return { state: 'found', result: { commentId: found[0]!.id } };
            return {
              state: 'ambiguous',
              reason: `комментарий с маркером найден ${found.length} раз (ожидался ровно один)`,
            };
          },
        };
      }
      case 'criterion': {
        const criterionId = step.input.criterionId as string;
        return {
          prepare: () => ({
            ifRevision: this.revisionBefore(this.options.store.operation(op.key)!, step.n),
          }),
          send: async (input: Record<string, unknown>) => ({
            revision: (
              await t.setCriterion(taskId, {
                criterionId,
                completed: true,
                ifRevision: input.ifRevision as number,
              })
            ).revision,
          }),
          readBack: async (input: Record<string, unknown>): Promise<ReadBack> => {
            const read = await t.readTask(taskId);
            const c = read.task.criteria.find((x) => x.id === criterionId);
            // Своя запись доказана, только если после неё ничего не менялось:
            // ровно +1 к нашей ревизии и та же постановка.
            if (
              c?.completed &&
              read.task.revision === (input.ifRevision as number) + 1 &&
              this.sameSnapshot(op, read)
            )
              return { state: 'found', result: { revision: read.task.revision } };
            if (c?.completed)
              return {
                state: 'foreign',
                reason: `критерий отмечен, но ревизия ${String(input.ifRevision)} → ${read.task.revision} или постановка изменились: чужое изменение после записи`,
              };
            if (read.task.revision === input.ifRevision)
              return {
                state: 'absent',
                reason: 'ревизия задачи не изменилась, критерий не отмечен',
              };
            return {
              state: 'foreign',
              reason: `ревизия задачи ${String(input.ifRevision)} → ${read.task.revision} без нашей отметки (чужое изменение)`,
            };
          },
        };
      }
      case 'move': {
        const column = step.input.column as TaskColumn;
        return {
          prepare: () => ({
            ifRevision: this.revisionBefore(this.options.store.operation(op.key)!, step.n),
          }),
          send: async (input: Record<string, unknown>) => ({
            revision: (await t.move(taskId, { column, ifRevision: input.ifRevision as number }))
              .revision,
          }),
          readBack: async (input: Record<string, unknown>): Promise<ReadBack> => {
            const read = await t.readTask(taskId);
            if (
              read.task.column === column &&
              read.task.revision === (input.ifRevision as number) + 1 &&
              this.sameSnapshot(op, read)
            )
              return { state: 'found', result: { revision: read.task.revision } };
            if (read.task.column === column)
              return {
                state: 'foreign',
                reason: `колонка ${column}, но ревизия ${String(input.ifRevision)} → ${read.task.revision} или постановка изменились: чужое изменение после записи`,
              };
            if (read.task.revision === input.ifRevision)
              return { state: 'absent', reason: 'ревизия задачи не изменилась, колонка прежняя' };
            return {
              state: 'foreign',
              reason: `ревизия задачи ${String(input.ifRevision)} → ${read.task.revision} без нашего перемещения (чужое изменение)`,
            };
          },
        };
      }
      case 'history': {
        const history = this.options.history!;
        return {
          // Шаги истории — собственные записи с маркерами; здесь только их итог.
          send: async () => history.closeResult(result, op.workId),
          readBack: async (): Promise<ReadBack> => ({
            state: 'found',
            result: await history.closeResult(result, op.workId),
          }),
        };
      }
      default:
        throw new Error('Неизвестный шаг доставки: ' + step.kind);
    }
  }

  /**
   * Разбор неизвестного исхода или конфликта операции. Сначала — факты
   * получателя (read-back); решение оператора требуется только там, где
   * факты неоднозначны. Сам reconcile мутаций не отправляет: продолжение —
   * обычной доставкой с тем же ключом.
   */
  async reconcile(key: string, decision?: ReconcileDecision) {
    const store = this.options.store;
    const before = store.operation(key);
    if (!before) throw new HarnessError('NOT_FOUND', 'Операция доставки не найдена: ' + key);
    if (before.status !== 'uncertain' && before.status !== 'conflict')
      return {
        operation: key,
        before: before.status,
        after: before.status,
        resolved: before.status === 'delivered',
        facts: [] as string[],
      };
    const { lease, holder } = store.acquire(key, this.owner, this.config.limits.leaseMs);
    if (!lease)
      throw new HarnessError(
        'CONTROLLER_BUSY',
        `Операцию ведёт другой владелец (${holder!.owner})`,
      );
    const facts: string[] = [];
    try {
      const op = store.operation(key)!;
      const step = op.steps.find((s) => s.status === 'uncertain' || s.status === 'conflict');
      const setStep = (patch: Partial<StepRecord>, status: OperationRecord['status']) =>
        store.updateOp(key, lease.token, (o) => ({
          ...o,
          status,
          steps: o.steps.map((s) =>
            s.n === step!.n ? { ...s, ...patch, updatedAt: new Date().toISOString() } : s,
          ),
        }));
      if (op.status === 'conflict') {
        if (decision?.kind !== 'recheck' || !step)
          return {
            operation: key,
            before: op.status,
            after: op.status,
            resolved: false,
            facts: [op.reason ?? 'конфликт постановки: результат относится к прежнему снимку'],
          };
        // Явная перепроверка: постановка та же и задача допускает доставку — шаг снова planned.
        const read = await this.t.readTask(op.taskId);
        const mapping = this.mappingOf(read);
        const digest = mapping ? semanticDigest(this.config, mapping, read) : 'unmapped';
        if (digest !== op.revision || read.task.column === 'cancelled') {
          facts.push('постановка изменилась или задача отменена: конфликт остаётся');
          return { operation: key, before: op.status, after: op.status, resolved: false, facts };
        }
        const next = setStep({ status: 'planned', reason: 'recheck оператора' }, 'in-progress');
        store.updateOp(key, lease.token, (o) => ({
          ...o,
          receipt: { ...o.receipt, casRevision: read.task.revision, rebasedFrom: step.n },
        }));
        facts.push(`постановка не изменилась; продолжение от ревизии ${read.task.revision}`);
        return { operation: key, before: op.status, after: next.status, resolved: true, facts };
      }
      if (!step)
        return { operation: key, before: op.status, after: op.status, resolved: false, facts };
      // Факты получателя.
      let markers: { id: string }[] = [];
      if (step.kind === 'comment' || step.kind === 'historical-comment') {
        markers = (await this.t.listComments(op.taskId)).filter((c) =>
          c.body.includes(step.marker),
        );
        facts.push(`комментариев с маркером: ${markers.length}`);
        if (markers.length === 1) {
          const next = setStep(
            { status: 'done', result: { commentId: markers[0]!.id } },
            'in-progress',
          );
          return { operation: key, before: op.status, after: next.status, resolved: true, facts };
        }
        if (decision?.kind === 'resend' && markers.length === 0) {
          const next = setStep(
            { status: 'planned', reason: 'resend оператора: записи нет' },
            'in-progress',
          );
          return { operation: key, before: op.status, after: next.status, resolved: true, facts };
        }
        if (decision?.kind === 'adopt' && markers.some((m) => m.id === decision.id)) {
          const next = setStep(
            { status: 'done', result: { commentId: decision.id }, reason: 'adopt оператора' },
            'in-progress',
          );
          return { operation: key, before: op.status, after: next.status, resolved: true, facts };
        }
        facts.push(
          markers.length === 0
            ? 'записи нет, но отправка могла состояться: нужен --decision resend после проверки получателя'
            : 'несколько записей: нужен --decision adopt:<id> (первая найденная не выбирается автоматически)',
        );
        return { operation: key, before: op.status, after: op.status, resolved: false, facts };
      }
      // CAS-шаги и история: состояние получателя; uncertain здесь — read-back был недоступен.
      if (step.kind === 'history') this.options.history?.resetUncertain(op.workId);
      const next = setStep(
        { status: 'sending', reason: 'reconcile: повторный read-back' },
        'in-progress',
      );
      facts.push('шаг будет разобран read-back при продолжении доставки');
      return { operation: key, before: op.status, after: next.status, resolved: true, facts };
    } finally {
      store.release(key, lease.token);
    }
  }
}
