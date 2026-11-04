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
import {
  activitySchema,
  failureKindSchema,
  livenessStateSchema,
  stallActionSchema,
  workStatusSchema,
} from './execution.ts';

const sha = gitShaSchema;
const text = z.string().max(4000);
const runtime = runtimeNameSchema;
const phase = z.enum(['candidate', 'integration']);
/**
 * Причина отказа окружения (`attempt.diagnosed`): ставится в точке
 * обнаружения (песочница gate, сеть установки зависимостей, провайдер,
 * транспорт), а не разбором текста потом. `none` — отказ не окружения
 * (код, ревью, область); `other` — отказ окружения без известной причины.
 */
export const environmentCauses = [
  'sandbox-launch',
  'sandbox-network',
  'sandbox-filesystem',
  'sandbox-policy',
  'dependency-network',
  'provider-auth',
  'provider-limit',
  'transport',
  'preflight',
  'lease-expired',
  'stalled',
  'shutdown',
  'other',
  'none',
] as const;
export const environmentCauseSchema = z.enum(environmentCauses);
export type EnvironmentCause = (typeof environmentCauses)[number];
/** Кто повторил поручение (`work.retried`): `host` — хост не назвал актёра. */
export const retryActors = ['operator', 'recovery', 'host'] as const;
export type RetryActor = (typeof retryActors)[number];
/** Кто отменил поручение (`work.cancelled`): `graph` — новая редакция графа его убрала. */
export const cancelActors = ['operator', 'host', 'graph'] as const;
export type CancelActor = (typeof cancelActors)[number];
/** Кто сдвинул ref базы (`base.moved`): `host` — хост не назвал актёра. */
export const baseMoveActors = ['operator', 'controller', 'host'] as const;
export type BaseMoveActor = (typeof baseMoveActors)[number];
/** Предел имени стадии в событии `attempt.stage`. */
export const STAGE_NAME_LIMIT = 300;
const delivery = {
  sink: idSchema,
  key: z.string().min(1).max(300),
  revision: z.string().min(1).max(200),
  attempts: z.number().int().min(0),
};

/** Переход живости по обходу зависших: общая часть событий попытки и совместной проверки. */
const liveness = {
  state: livenessStateSchema,
  previous: livenessStateSchema,
  lastMovementAt: isoTimeSchema,
  idleMs: z.number().int().min(0),
  activity: activitySchema.optional(),
  /** ps не дал данных о процессах: оценка только по выводу, не выше `quiet`. */
  cpuUnavailable: z.boolean().optional(),
  action: stallActionSchema.optional(),
  snapshot: z
    .strictObject({
      processes: z
        .array(
          z.strictObject({
            pid: z.number().int().positive(),
            parentPid: z.number().int().min(0),
            /** Процессорное время; нет — ps его не сообщил. */
            cpuMs: z.number().int().min(0).optional(),
            command: z.string().max(300),
          }),
        )
        .max(20),
      /** ps не дал списка процессов: снимок только из вывода. */
      processesUnavailable: z.boolean().optional(),
      tail: z.string().max(2000),
      artifact: z.string().max(1000).optional(),
    })
    .optional(),
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
    /** Повтор провала интеграции: повторённая запись и исход. */
    recheck: z
      .strictObject({
        of: z.string().min(1).max(200),
        outcome: z.enum(['flaky', 'confirmed']),
      })
      .optional(),
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
  /**
   * Граница стадии попытки (замер `AttemptState.timings`): одно `started` и
   * не больше одного `finished` на стадию, в той же транзакции под fencing,
   * что и замер. Стадия попытки, утратившей владение или упавшей, остаётся
   * открытой: её конец — событие конца попытки. `at` и `durationMs` — по
   * часам движка, те же, что в замере.
   */
  'attempt.stage': z.strictObject({
    timingId: z.string().min(1).max(200),
    stage: z.string().min(1).max(STAGE_NAME_LIMIT),
    phase: z.enum(['started', 'finished']),
    at: isoTimeSchema,
    /** Только у `finished`. */
    durationMs: z.number().int().min(0).optional(),
    /** Только у `finished`. */
    outcome: z.enum(['passed', 'failed']).optional(),
  }),
  /**
   * Обход controller сменил живость исполняющейся попытки (только переходы).
   * У `stalled` — снимок: процессы исполняющихся команд и хвост их вывода
   * (замаскированные), и что controller сделал (`action`).
   */
  'attempt.liveness': z.strictObject(liveness),
  'attempt.failed': z.strictObject({
    failureKind: failureKindSchema,
    message: text,
    blocked: z.boolean(),
  }),
  /**
   * Причина отказа попытки: пишется в той же транзакции, что `attempt.failed`
   * (и `attempt.expired`, причина `lease-expired`). `counted` — отказ
   * засчитан в предел попыток поручения. Текста отказа здесь нет.
   */
  'attempt.diagnosed': z.strictObject({
    failureKind: failureKindSchema,
    cause: environmentCauseSchema,
    counted: z.boolean(),
  }),
  'attempt.expired': z.strictObject({ leaseUntil: z.number().int().min(0) }),
  'attempt.cancelled': z.strictObject({ reason: text }),
  'attempt.recovered': z.strictObject({
    integrationSha: sha,
    accepted: z.boolean(),
    reason: text.optional(),
  }),
  'work.accepted': z.strictObject({ resultSha: sha, integrationSha: sha }),
  /**
   * Поручение возвращено в очередь повтором (`engine.retry`). `reset` —
   * сброс исчерпанного предела; `spent` — засчитанных попыток до сброса
   * (сброс обнуляет счётчик). Причины сброса нет: только её длина.
   */
  'work.retried': z.strictObject({
    by: z.enum(retryActors),
    reset: z.boolean(),
    spent: z.number().int().min(0).optional(),
    reasonLength: z.number().int().min(0).optional(),
  }),
  /**
   * Поручение отменено (`engine.cancel` или новая редакция графа).
   * `hadAttempt` — отменена и активная попытка (её `attempt.cancelled` — в
   * той же транзакции).
   */
  'work.cancelled': z.strictObject({ by: z.enum(cancelActors), hadAttempt: z.boolean() }),
  'work.blocked': z.strictObject({ code: z.string().min(1).max(60), message: text }),
  'control.paused': z.strictObject({
    reason: z.enum(['operator', 'shutdown', 'runtime', 'base-check', 'reconfigure']),
    failures: z.array(failureKindSchema).optional(),
  }),
  'control.resumed': z.strictObject({
    reason: z.enum(['operator', 'shutdown', 'runtime', 'base-check', 'reconfigure']),
  }),
  'controller.acquired': z.strictObject({ owner: z.string().min(1).max(300) }),
  /**
   * Ref базы сдвинут (`fencedRefMove`) — в той же транзакции, что проверка
   * владения и `git update-ref`. Одно событие на репозиторий.
   */
  'base.moved': z.strictObject({ by: z.enum(baseMoveActors) }),
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
  /**
   * Обход зависших совместной проверки сменил её живость (только переходы);
   * нагрузка — как у `attempt.liveness`. При `report` это единственный след
   * зависания: записи попытки у проверки нет.
   */
  'joint.liveness': z.strictObject({
    verificationId: z.string().min(1).max(200),
    ...liveness,
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
  /**
   * Исход мутации получателя не доказан (только получатели, сообщающие это
   * явно): повтор не отправляет мутацию до разбора (reconcile).
   */
  'delivery.uncertain': z.strictObject({
    ...delivery,
    operation: z.string().min(1).max(300),
    reason: text,
  }),
} as const;
export type EventType = keyof typeof eventPayloads;
/** Нагрузка события своего типа. */
export type RunEventPayload<T extends EventType> = z.infer<(typeof eventPayloads)[T]>;
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
/** Событие известного этой версии типа: так оно записывается. */
export type KnownRunEvent = {
  [T in EventType]: Envelope & { type: T; payload: z.infer<(typeof eventPayloads)[T]> };
}[EventType];

/**
 * Событие типа, которого эта версия не знает (его записала более новая
 * версия): при чтении журнала оно не обрывает список, а возвращается
 * непрозрачным — конверт, `type: 'unknown'` и исходный тип в `original`;
 * нагрузка не возвращается. Записать такое событие нельзя: писатель строгий
 * (`runEventSchema`). Известный тип с нарушенной нагрузкой — по-прежнему отказ.
 */
export const unknownRunEventSchema = envelopeSchema.extend({
  type: z.literal('unknown'),
  original: z.string().min(1).max(200),
});
export type UnknownRunEvent = z.infer<typeof unknownRunEventSchema>;
/** Событие журнала при чтении: известного типа или непрозрачное неизвестное. */
export type RunEvent = KnownRunEvent | UnknownRunEvent;
/** Схема прочитанного события (`events`): `runEventSchema` и `unknownRunEventSchema`. */
export const readRunEventSchema = z.discriminatedUnion('type', [
  ...(variants as [(typeof variants)[number], ...(typeof variants)[number][]]),
  unknownRunEventSchema,
]);

/**
 * Разобрать сохранённое событие терпимо к неизвестному типу: тип, которого
 * нет в `eventPayloads`, становится `UnknownRunEvent` (конверт проверяется
 * строго); известный тип разбирается строгой схемой, и её отказ — ошибка.
 */
export function readRunEvent(raw: unknown): RunEvent {
  const type = (raw as { type?: unknown } | null)?.type;
  if (typeof type === 'string' && !Object.hasOwn(eventPayloads, type)) {
    const env = z.object(envelope).parse(raw);
    return unknownRunEventSchema.parse({ ...env, type: 'unknown', original: type.slice(0, 200) });
  }
  return runEventSchema.parse(raw) as KnownRunEvent;
}
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
  'run.liveness',
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
  'workspace.liveness',
  /**
   * Сдвиг ref базы внутри транзакции проверки владения: проверка, синхронный
   * `git update-ref` и событие `base.moved`; записей нет.
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
  'checks.spike',
] as const;
export type TransactionKind = (typeof transactionKinds)[number];
