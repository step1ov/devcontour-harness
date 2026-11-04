import { z } from 'zod';
import { diagnosisActions, diagnosisActors, stopDiagnosisSchema } from './diagnosis.ts';
import { errorCodes, type ErrorCode } from './errors.ts';
import { failureKindSchema, pauseReasons, workStatusSchema } from './execution.ts';
import { idSchema, isoTimeSchema } from './primitives.ts';

/**
 * Пакет передачи контекста (`harness handoff`, `handoffPack`): состояние доски
 * для следующей сессии ведущего агента, собранное из хранилища, а не из
 * памяти агента. Факты — только из сохранённого состояния; свободный текст
 * агента — только `intentions`.
 *
 * Пакет ограничен по размеру, чтобы поместиться в контекст агента: списки
 * обрезаются по `HANDOFF_LIMITS` (число отброшенного — в `truncated`), строки
 * усекаются до `HANDOFF_LIMITS.text` знаков с «…».
 *
 * Литералы `nextSteps` повторяют `src/projections/next.ts` (модуль без zod);
 * тест сверяет оба перечня поэлементно.
 */
export const HANDOFF_VERSION = 1;

export const HANDOFF_LIMITS = {
  /** Открытые поручения (не принятые и не отменённые). */
  works: 50,
  /** Остановки и решения (`explain`). */
  stops: 30,
  /** Последние провалы попыток, новые первыми. */
  failures: 10,
  /** Незавершённые записи попыток. */
  unfinished: 20,
  /** Блокировки одного поручения. */
  blockers: 3,
  /** Намерения агента и знаков в каждом. */
  intentions: 20,
  intentionChars: 1000,
  /** Предел строки факта из хранилища. */
  text: 300,
} as const;

/** Строка, усечённая до `n` знаков с «…» (`clipText`). */
const clipped = (n: number) => z.string().max(n + 1);
const text = clipped(HANDOFF_LIMITS.text);
const errorCodeSchema = z.enum(Object.keys(errorCodes) as [ErrorCode, ...ErrorCode[]]);
const count = z.number().int().min(0);

export const handoffNextSteps = [
  'accepted',
  'cancelled',
  'recovery-awaiting-lead',
  'recovery-analyzing',
  'recovery-applying',
  'recovery-retry-allowed',
  'recovery-retrying',
  'recovery-awaiting-user',
  'recovery-stopped',
  'corpus-adoption',
  'held',
  'plan-review',
  'attempt-running',
  'retry-within-budget',
  'attempts-exhausted',
  'awaiting-claim',
] as const;

/** Следующий шаг: кто действует и что (`nextAction`, `explain`). */
const nextSchema = z.strictObject({
  actor: z.enum(diagnosisActors).nullable(),
  action: z.enum(diagnosisActions),
  step: z.enum(handoffNextSteps).optional(),
  property: z.string().max(200).optional(),
  detail: text.optional(),
});

export const handoffPackSchema = z.strictObject({
  handoffVersion: z.literal(HANDOFF_VERSION),
  /** Момент снимка (часы движка). */
  at: isoTimeSchema,
  /** Только этот граф (`--graph`); нет — вся доска. */
  graphId: idSchema.optional(),
  /** Пределы политики: попытки поручения и восстановления группы. */
  limits: z.strictObject({ maxAttempts: z.number().int().positive(), repairBudget: count }),
  summary: z.strictObject({
    works: count,
    open: count,
    done: count,
    cancelled: count,
    byStatus: z.array(z.strictObject({ status: workStatusSchema, count: count })),
  }),
  /** Выдача очереди: пауза, причина и кто её снимает (как `status --detail`). */
  queue: z.strictObject({
    paused: z.boolean(),
    reason: z.enum(pauseReasons).optional(),
    detail: text.optional(),
    since: isoTimeSchema.optional(),
    liftedByRun: z.literal(true).optional(),
    code: errorCodeSchema.optional(),
    actor: z.enum(diagnosisActors).nullable().optional(),
    action: z.enum(diagnosisActions).optional(),
  }),
  /** Роль controller: кто держит и до какого времени; `live` — срок не истёк. */
  controller: z
    .strictObject({ owner: z.string().max(300), until: isoTimeSchema, live: z.boolean() })
    .optional(),
  /** Идущие попытки: поручение, стадия, свежесть владения, gates (`attemptView`). */
  active: z.array(
    z.strictObject({
      workId: idSchema,
      title: text,
      runId: z.string().max(200),
      attempt: z.number().int().positive(),
      phase: workStatusSchema,
      runtime: z.string(),
      elapsedMs: count,
      stage: z.strictObject({ name: z.string().max(200), elapsedMs: count }).optional(),
      sinceHeartbeatMs: count.optional(),
      stale: z.boolean(),
      gates: z.strictObject({
        phase: z.enum(['candidate', 'integration']),
        required: count,
        passed: count,
        failed: count,
        remaining: count,
      }),
    }),
  ),
  /**
   * Незавершённые записи попыток: владение истекло (`stale`) или поручение
   * уже не ссылается на попытку (`current: false`); их разбирает cleanup или
   * истечение срока, а не новая сессия.
   */
  unfinished: z.array(
    z.strictObject({
      runId: z.string().max(200),
      workId: idSchema,
      attempt: z.number().int().positive(),
      phase: workStatusSchema,
      startedAt: isoTimeSchema,
      stale: z.boolean(),
      current: z.boolean(),
      interrupted: z.literal('shutdown').optional(),
    }),
  ),
  /** Открытые поручения: статус, причина провала, блокировки и следующий шаг. */
  works: z.array(
    z.strictObject({
      id: idSchema,
      graphId: idSchema,
      title: text,
      status: workStatusSchema,
      attempt: count,
      failureKind: failureKindSchema.optional(),
      failure: text.optional(),
      hold: z.strictObject({ operation: z.string().max(300), reason: text }).optional(),
      recovery: z
        .strictObject({
          status: z.string().max(40),
          property: z.string().max(200),
          reason: text.optional(),
          proposal: text.optional(),
        })
        .optional(),
      blockers: z.array(z.strictObject({ code: errorCodeSchema, message: text })),
      next: nextSchema,
    }),
  ),
  /**
   * Остановки и открытые решения (`explain` без проб runtime): код, причина,
   * фаза, кто действует и допустимый шаг; решения — `actor` lead или user.
   */
  stops: z.array(stopDiagnosisSchema),
  /** Последние провалы попыток, новые первыми: класс отказа, код и причина. */
  failures: z.array(
    z.strictObject({
      runId: z.string().max(200),
      workId: idSchema,
      attempt: z.number().int().positive(),
      status: z.enum(['failed', 'expired']),
      phase: workStatusSchema,
      finishedAt: isoTimeSchema.optional(),
      failureKind: failureKindSchema.optional(),
      code: errorCodeSchema,
      error: text.optional(),
    }),
  ),
  /**
   * Бюджеты по записям вызовов: расход против предела. `spentUsd` —
   * сообщённое плюс оценённое; `remaining*` — `null`, когда расход известен
   * не полностью. Нет поля — бюджеты не заданы.
   */
  budgets: z
    .strictObject({
      onUnknown: z.enum(['stop', 'continue']),
      entries: z.array(
        z.strictObject({
          scope: z.enum(['work', 'group', 'total']),
          id: z.string().max(200).optional(),
          state: z.enum(['within', 'exceeded', 'undetermined']),
          limitUsd: z.number().positive().optional(),
          limitMs: z.number().int().positive().optional(),
          spentUsd: z.number().min(0),
          durationMs: z.number().min(0),
          unknownCalls: count,
          remainingUsd: z.number().min(0).nullable(),
          remainingMs: z.number().min(0).nullable(),
          reason: text.optional(),
        }),
      ),
    })
    .optional(),
  /** Восстановления заданий графов: потрачено против бюджета. */
  repairs: z.array(
    z.strictObject({
      graphId: idSchema,
      status: z.string().max(40),
      used: count,
      budget: count,
    }),
  ),
  /** Следующий шаг доски: первое решение lead/user, иначе ожидание controller. */
  next: nextSchema.extend({ workId: idSchema.optional(), code: errorCodeSchema.optional() }),
  /** Намерения агента — единственный текст не из хранилища. */
  intentions: z.array(clipped(HANDOFF_LIMITS.intentionChars).min(1)).max(HANDOFF_LIMITS.intentions),
  /** Сколько записей каждого списка не вошло в пакет. */
  truncated: z.strictObject({
    works: count,
    stops: count,
    failures: count,
    unfinished: count,
  }),
});
export type HandoffPack = z.infer<typeof handoffPackSchema>;
