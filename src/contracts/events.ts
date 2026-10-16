import { z } from 'zod';
import { API_VERSION } from './version.ts';
import { idSchema, isoTimeSchema } from './primitives.ts';

export const eventTypes = [
  'graph.registered',
  'graph.reviewed',
  'graph.approved',
  'work.ready',
  'work.held',
  'attempt.claimed',
  'attempt.phase',
  'attempt.gate',
  'attempt.review',
  'attempt.failed',
  'attempt.expired',
  'attempt.cancelled',
  'attempt.recovered',
  'work.accepted',
  'work.blocked',
  'control.paused',
  'control.resumed',
  'controller.acquired',
  'controller.released',
  'budget.blocked',
  'delivery.pending',
  'delivery.delivered',
  'delivery.failed',
  'delivery.conflict',
] as const;
export type EventType = (typeof eventTypes)[number];

/**
 * Ключи, которых не бывает в нагрузке события: токены владения, секреты и
 * учётные данные. Событие читают внешние получатели и CLI; fencing-токен в
 * нём позволил бы стороннему процессу завершить чужую попытку.
 */
const forbiddenKey = /token|secret|password|passwd|credential|api[-_]?key|authorization|cookie/i;
const safeScalar = z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]);
const safeValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([safeScalar, z.array(safeValue).max(200), safeRecord]),
);
const safeRecord: z.ZodType<Record<string, unknown>> = z
  .record(z.string().max(100), safeValue)
  .refine((r) => Object.keys(r).every((k) => !forbiddenKey.test(k)), 'Запрещённый ключ в событии');

export const runEventSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  /** Строго возрастающий номер в пределах ExecutionStore. */
  seq: z.number().int().positive(),
  at: isoTimeSchema,
  type: z.enum(eventTypes),
  graphId: idSchema.optional(),
  workId: idSchema.optional(),
  runId: z.string().min(1).max(200).optional(),
  attempt: z.number().int().positive().optional(),
  payload: safeRecord,
});
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventDraft = Omit<RunEvent, 'apiVersion' | 'seq' | 'at'>;
export const isForbiddenEventKey = (key: string) => forbiddenKey.test(key);

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
  'graph.approved',
  'delivery.recorded',
] as const;
export type TransactionKind = (typeof transactionKinds)[number];
