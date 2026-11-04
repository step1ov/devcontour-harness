import { z } from 'zod';
import {
  diagnosisActions,
  diagnosisActors,
  diagnosisCauses,
  diagnosisPhases,
} from './diagnosis.ts';
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
 * обрезаются по `HANDOFF_LIMITS` (число отброшенного — в `truncated`), каждая
 * строка из хранилища очищается от escape-последовательностей и управляющих
 * символов и усекается до предела своего поля с «…» (без разрыва суррогатной
 * пары), а сериализованный пакет не больше `HANDOFF_MAX_BYTES` байт UTF-8:
 * сверх него записи отбрасываются (`truncated.bySize`).
 *
 * Литералы `nextSteps` повторяют `src/projections/next.ts` (модуль без zod);
 * тест сверяет оба перечня поэлементно.
 */
export const HANDOFF_VERSION = 1;

export const HANDOFF_LIMITS = {
  /** Открытые поручения (не принятые и не отменённые). */
  works: 50,
  /** Остановки и решения (`explain`), после свёртки одинаковых. */
  stops: 30,
  /** Ссылки evidence одной остановки. */
  evidence: 5,
  /** Поручения, перечисленные у свёрнутой остановки. */
  stopWorks: 20,
  /** Последние провалы попыток, новые первыми. */
  failures: 10,
  /** Незавершённые записи попыток. */
  unfinished: 20,
  /** Блокировки одного поручения. */
  blockers: 3,
  /** Строки бюджетов (общий и групп — первыми). */
  budgets: 20,
  /** Задания графов с восстановлениями. */
  repairs: 10,
  /** Намерения агента и знаков в каждом. */
  intentions: 20,
  intentionChars: 1000,
  /** Предел строки факта из хранилища. */
  text: 300,
  /** Предел идентификатора, имени стадии, владельца из хранилища. */
  name: 200,
} as const;

/** Предел сериализованного пакета (JSON, UTF-8). */
export const HANDOFF_MAX_BYTES = 256 * 1024;

/** Строка, усечённая до `n` знаков с «…». */
const clipped = (n: number) => z.string().max(n + 1);
const text = clipped(HANDOFF_LIMITS.text);
const name = clipped(HANDOFF_LIMITS.name);
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

/** Команда harness, которая выполняет следующий шаг, когда он — запуск команды. */
export const handoffCommands = ['harness run', 'harness resume'] as const;

/** Следующий шаг: кто действует и что (`nextAction`, `explain`). */
const nextSchema = z.strictObject({
  actor: z.enum(diagnosisActors).nullable(),
  action: z.enum(diagnosisActions),
  step: z.enum(handoffNextSteps).optional(),
  property: name.optional(),
  detail: text.optional(),
  command: z.enum(handoffCommands).optional(),
});

/**
 * Остановка (`StopDiagnosis` explain) в пределах пакета. Одинаковые
 * остановки на выдаче (общая пауза очереди и другие повторы одного диагноза)
 * свёрнуты в одну запись без `workId`: `works` — первые затронутые поручения,
 * `worksCount` — сколько их всего.
 */
const stopSchema = z.strictObject({
  code: errorCodeSchema,
  cause: z.enum(diagnosisCauses),
  phase: z.enum(diagnosisPhases),
  actor: z.enum(diagnosisActors).nullable(),
  action: z.enum(diagnosisActions),
  retryPlanned: z.boolean(),
  message: text,
  evidence: z
    .array(
      z.strictObject({
        kind: z.enum(['attempt', 'evidence', 'event', 'doctor']),
        id: name,
        sha: z.string().max(64).optional(),
      }),
    )
    .max(HANDOFF_LIMITS.evidence),
  workId: idSchema.optional(),
  runId: name.optional(),
  /** Остановка выдачи всей очереди (её же показывает `queue`). */
  queue: z.literal(true).optional(),
  works: z.array(idSchema).max(HANDOFF_LIMITS.stopWorks).optional(),
  worksCount: count.optional(),
});

export const handoffPackSchema = z.strictObject({
  handoffVersion: z.literal(HANDOFF_VERSION),
  /** Момент снимка (часы движка); весь пакет — одно чтение хранилища. */
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
    /** Операция, держащая паузу (reconfigure, base-check): её применяют или отменяют. */
    operation: name.optional(),
    /** Классы отказа, которые держат паузу runtime. */
    failures: z.array(failureKindSchema).optional(),
    liftedByRun: z.literal(true).optional(),
    code: errorCodeSchema.optional(),
    actor: z.enum(diagnosisActors).nullable().optional(),
    action: z.enum(diagnosisActions).optional(),
  }),
  /** Роль controller: кто держит и до какого времени; `live` — срок не истёк. */
  controller: z.strictObject({ owner: name, until: isoTimeSchema, live: z.boolean() }).optional(),
  /** Идущие попытки: поручение, стадия, свежесть владения, gates (`attemptView`). */
  active: z.array(
    z.strictObject({
      workId: idSchema,
      title: text,
      runId: name,
      attempt: z.number().int().positive(),
      phase: workStatusSchema,
      runtime: name,
      elapsedMs: count,
      stage: z.strictObject({ name: name, elapsedMs: count }).optional(),
      sinceHeartbeatMs: count.optional(),
      /** Срок владения попыткой. */
      leaseUntil: isoTimeSchema,
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
   * уже не ссылается на попытку (`current: false`); их закрывает истечение
   * срока при следующем `harness run` или cleanup, а не новая сессия.
   */
  unfinished: z.array(
    z.strictObject({
      runId: name,
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
      hold: z.strictObject({ operation: name, reason: text }).optional(),
      recovery: z
        .strictObject({
          status: z.string().max(40),
          property: name,
          reason: text.optional(),
          proposal: text.optional(),
        })
        .optional(),
      /** Без паузы очереди: она одна на всех и показана в `queue`. */
      blockers: z.array(z.strictObject({ code: errorCodeSchema, message: text })),
      blockersTruncated: count.optional(),
      next: nextSchema,
    }),
  ),
  /**
   * Остановки и открытые решения (`explain` без проб runtime): код, причина,
   * фаза, кто действует и допустимый шаг; решения (`actor` lead или user,
   * действие не `wait`) — первыми.
   */
  stops: z.array(stopSchema),
  /** Последние провалы попыток, новые первыми: класс отказа, код и причина. */
  failures: z.array(
    z.strictObject({
      runId: name,
      workId: idSchema,
      /** Текущий статус поручения (провал мог уже смениться повтором или приёмкой). */
      workStatus: workStatusSchema.optional(),
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
   * Бюджеты по записям вызовов: расход против предела. `reportedUsd` —
   * сообщённое runtime, `estimatedUsd` — оценка по тарифу; `complete: false`
   * — расход известен не полностью (вызовы без стоимости, незавершённые,
   * брошенные, попытки без учёта), сумма — нижняя граница, `remaining*` —
   * `null`. Бюджеты поручений в пределах и без расхода не перечисляются.
   * Нет поля — бюджеты не заданы.
   */
  budgets: z
    .strictObject({
      onUnknown: z.enum(['stop', 'continue']),
      entries: z.array(
        z.strictObject({
          scope: z.enum(['work', 'group', 'total']),
          id: name.optional(),
          state: z.enum(['within', 'exceeded', 'undetermined']),
          limitUsd: z.number().positive().optional(),
          limitMs: z.number().int().positive().optional(),
          reportedUsd: z.number().min(0),
          estimatedUsd: z.number().min(0),
          complete: z.boolean(),
          unknownCalls: count,
          unfinishedCalls: count,
          abandonedCalls: count,
          uncoveredRuns: count,
          durationMs: z.number().min(0),
          remainingUsd: z.number().min(0).nullable(),
          remainingMs: z.number().min(0).nullable(),
          reason: text.optional(),
        }),
      ),
    })
    .optional(),
  /** Восстановления заданий графов: потрачено против бюджета. */
  repairs: z
    .array(
      z.strictObject({
        graphId: idSchema,
        status: z.string().max(40),
        used: count,
        budget: count,
      }),
    )
    .max(HANDOFF_LIMITS.repairs),
  /** Следующий шаг доски: первое решение lead/user, иначе ход controller. */
  next: nextSchema.extend({ workId: idSchema.optional(), code: errorCodeSchema.optional() }),
  /** Намерения агента — единственный текст не из хранилища. */
  intentions: z.array(clipped(HANDOFF_LIMITS.intentionChars).min(1)).max(HANDOFF_LIMITS.intentions),
  /**
   * Сколько записей каждого списка не вошло в пакет (по пределу числа или
   * размера). `budgets` — строки бюджетов сверх предела, `budgetsWithin` —
   * бюджеты поручений в пределах и без расхода (не показаны намеренно);
   * `intentions` — сколько намерений усечено по `intentionChars`,
   * `intentionsDropped` — отброшено ради предела размера; `bySize` — пакет
   * урезан до `HANDOFF_MAX_BYTES`.
   */
  truncated: z.strictObject({
    works: count,
    stops: count,
    failures: count,
    unfinished: count,
    budgets: count,
    budgetsWithin: count,
    repairs: count,
    intentions: count,
    intentionsDropped: count,
    bySize: z.boolean(),
  }),
});
export type HandoffPack = z.infer<typeof handoffPackSchema>;
