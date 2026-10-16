import { z } from 'zod';
import { API_VERSION } from './version.ts';
import {
  digestSchema,
  gitShaSchema,
  idSchema,
  isoTimeSchema,
  runtimeNameSchema,
} from './primitives.ts';
import { sourceRefSchema } from './work.ts';
import { failureKindSchema, workStatusSchema } from './execution.ts';

const sha = gitShaSchema;
const text = z.string().max(4000);
const runtime = runtimeNameSchema;
const phase = z.enum(['candidate', 'integration']);
const delivery = {
  sink: idSchema,
  key: z.string().min(1).max(300),
  revision: z.string().min(1).max(200),
  attempts: z.number().int().min(0),
};

/**
 * Нагрузка каждого типа события — закрытая схема: лишних полей нет, и
 * поэтому в событие нельзя положить fencing-токен, секрет или произвольный
 * объект попытки. Событие читают внешние получатели и CLI.
 */
export const eventPayloads = {
  'graph.registered': z.strictObject({
    digest: digestSchema,
    orders: z.number().int().positive(),
    source: sourceRefSchema,
  }),
  'graph.reviewed': z.strictObject({
    kind: z.enum(['plan', 'contract']),
    subject: idSchema,
    digest: digestSchema,
    round: z.number().int().positive(),
    approved: z.boolean(),
    open: z.number().int().min(0),
  }),
  'graph.approved': z.strictObject({ digest: digestSchema, actor: z.enum(['operator', 'agent']) }),
  'work.ready': z.strictObject({ orderDigest: digestSchema }),
  'work.held': z.strictObject({
    operation: z.string().min(1).max(200),
    reason: text,
    released: z.boolean(),
  }),
  'attempt.claimed': z.strictObject({
    owner: z.string().min(1).max(300),
    runtime,
    reviewer: runtime,
    policyDigest: digestSchema,
    engineVersion: z.string().min(1),
  }),
  'attempt.phase': z.strictObject({ phase: workStatusSchema, sha: sha.optional() }),
  'attempt.gate': z.strictObject({
    phase,
    gate: idSchema,
    sha,
    passed: z.boolean(),
    evidenceId: z.string().min(1).max(200),
    consumer: idSchema.optional(),
  }),
  'attempt.review': z.strictObject({
    phase,
    sha,
    passed: z.boolean(),
    evidenceId: z.string().min(1).max(200),
    reviewer: runtime,
    sameVendor: z.boolean(),
    blocking: z.number().int().min(0),
  }),
  'attempt.failed': z.strictObject({
    failureKind: failureKindSchema,
    message: text,
    blocked: z.boolean(),
  }),
  'attempt.expired': z.strictObject({ leaseUntil: z.number().int().min(0) }),
  'attempt.cancelled': z.strictObject({ reason: text }),
  'attempt.recovered': z.strictObject({
    integrationSha: sha,
    accepted: z.boolean(),
    reason: text.optional(),
  }),
  'work.accepted': z.strictObject({ resultSha: sha, integrationSha: sha }),
  'work.blocked': z.strictObject({ code: z.string().min(1).max(60), message: text }),
  'control.paused': z.strictObject({
    reason: z.enum(['operator', 'shutdown', 'runtime', 'base-check', 'reconfigure']),
    failures: z.array(failureKindSchema).optional(),
  }),
  'control.resumed': z.strictObject({
    reason: z.enum(['operator', 'shutdown', 'runtime', 'base-check', 'reconfigure']),
  }),
  'controller.acquired': z.strictObject({ owner: z.string().min(1).max(300) }),
  'controller.released': z.strictObject({ owner: z.string().min(1).max(300) }),
  'budget.blocked': z.strictObject({
    scope: z.enum(['work', 'group', 'total']),
    scopeId: z.string().max(200).optional(),
    state: z.enum(['exceeded', 'undetermined']),
    reason: text,
  }),
  /** Задачи приняли версию корпуса; тела случаев в журнал не попадают. */
  'corpus.adopted': z.strictObject({
    suite: z.string().min(1).max(300),
    pending: z.string().min(1).max(200),
    version: z.number().int().min(0),
    digest: digestSchema,
    status: z.enum(['waiting', 'completed']),
    accepted: z.array(idSchema).max(500),
  }),
  /** Эпизод повторяющихся отказов по свойству сменил состояние. */
  'work.recovery': z.strictObject({
    recoveryId: z.string().min(1).max(200),
    property: z.string().min(1).max(200),
    status: z.enum([
      'awaiting-lead',
      'analyzing',
      'applying',
      'retry',
      'retrying',
      'awaiting-user',
      'stopped',
      'closed',
    ]),
    reason: text.optional(),
  }),
  /** Совместная проверка комбинации репозиториев началась (без manifest). */
  'joint.started': z.strictObject({
    verificationId: z.string().min(1).max(200),
    workIds: z.array(idSchema).max(500),
    policyDigest: digestSchema,
  }),
  /** Совместная проверка закончилась: `passed` — только с manifest. */
  'joint.finished': z.strictObject({
    verificationId: z.string().min(1).max(200),
    status: z.enum(['passed', 'failed']),
    manifestDigest: digestSchema.optional(),
    error: text.optional(),
  }),
  /** Политика стала применённой: запуском процесса или операцией reconfigure. */
  'policy.applied': z.strictObject({
    digest: digestSchema,
    generation: z.number().int().min(0),
    by: z.string().min(1).max(300),
    operation: z.string().min(1).max(200).optional(),
  }),
  /** Запрос операции применить политику с ожидаемым digest или его отказ. */
  'policy.reconfigure': z.strictObject({
    operation: z.string().min(1).max(200),
    digest: digestSchema,
    status: z.enum(['requested', 'failed', 'cleared']),
    error: text.optional(),
  }),
  'delivery.pending': z.strictObject(delivery),
  'delivery.delivered': z.strictObject({ ...delivery, receipt: z.string().max(1000).optional() }),
  'delivery.failed': z.strictObject({ ...delivery, error: text }),
  'delivery.conflict': z.strictObject({ ...delivery, currentRevision: z.string().min(1).max(200) }),
} as const;
export type EventType = keyof typeof eventPayloads;
export const eventTypes = Object.keys(eventPayloads) as EventType[];

const envelope = {
  apiVersion: z.literal(API_VERSION),
  /** Строго возрастающий номер в пределах ExecutionStore. */
  seq: z.number().int().positive(),
  at: isoTimeSchema,
  graphId: idSchema.optional(),
  workId: idSchema.optional(),
  runId: z.string().min(1).max(200).optional(),
  attempt: z.number().int().positive().optional(),
};
const envelopeSchema = z.strictObject(envelope);
type Envelope = z.infer<typeof envelopeSchema>;
const variants = (Object.keys(eventPayloads) as EventType[]).map((type) =>
  envelopeSchema.extend({ type: z.literal(type), payload: eventPayloads[type] }),
);
/** Событие: общий конверт и нагрузка своего типа (дискриминатор `type`). */
export const runEventSchema = z.discriminatedUnion(
  'type',
  variants as [(typeof variants)[number], ...(typeof variants)[number][]],
);
export type RunEvent = {
  [T in EventType]: Envelope & { type: T; payload: z.infer<(typeof eventPayloads)[T]> };
}[EventType];
export type RunEventDraft = {
  [T in EventType]: Omit<Envelope, 'apiVersion' | 'seq' | 'at'> & {
    type: T;
    payload: z.infer<(typeof eventPayloads)[T]>;
  };
}[EventType];

/**
 * Типы транзакций исполнения. Это сохранённые строки: DevContour пишет их
 * в журнал аудита как тип события и разбирает (`scheduler.error` — причина
 * остановки очереди), поэтому harness использует те же имена, а не новые.
 * `heartbeat` продлевает сроки и события не создаёт.
 */
export const transactionKinds = [
  'run.claimed',
  'heartbeat',
  'run.heartbeat-failed',
  'run.phase',
  'run.context',
  'run.dependencies',
  'run.dependency-freshness',
  'run.consumer-checked',
  'run.implementation-basis',
  'run.partial',
  'run.continuation',
  'run.model',
  'run.timing.started',
  'run.timing.finished',
  'evidence.recorded',
  'reproduction.recorded',
  'findings.recorded',
  'task.done',
  'run.failed',
  'run.recovered',
  'recovery.rejected',
  'runs.expired',
  'task.retry',
  'task.cancelled',
  'task.held',
  'task.released',
  'task.hold-transferred',
  'wait.started',
  'wait.cleared',
  'recovery.reserved',
  'recovery.decided',
  'recovery.applied',
  'recovery.interrupted',
  'scheduler.started',
  'scheduler.paused',
  'scheduler.released',
  'scheduler.error',
  'scheduler.blockers',
  'config.started',
  'config.reconfigured',
  'config.reconfigure-requested',
  'config.reconfigure-cleared',
  'graph.registered',
  'graph.reviewed',
  'graph.approved',
  'delivery.recorded',
  'workspace.verification.started',
  'workspace.manifest',
  'workspace.evidence',
  'workspace.verified',
  'workspace.failed',
  /**
   * Сдвиг ref базы операцией внутри транзакции проверки её владения: только
   * проверка и синхронный `git update-ref`, записей и событий нет.
   */
  'base.moved',
  /** Только локальные записи технической очереди (`workflow-jobs`); событий журнала нет. */
  'workflow.updated',
  /**
   * Только локальные записи учёта вызовов (`usage`): начало вызова вместе с
   * проверкой бюджета, ход и итог вызова, закрытие прерванных, закрепление
   * атрибуции прежних записей. Событий журнала нет.
   */
  'usage.recorded',
  /**
   * Только локальные записи корпуса (`check-suites`): начало, продление и
   * завершение операции подтверждения, запись решения и версии. Событий
   * журнала нет.
   */
  'checks.recorded',
  'checks.adopted',
  'checks.awaiting-operator',
  'checks.adoption-abandoned',
] as const;
export type TransactionKind = (typeof transactionKinds)[number];
