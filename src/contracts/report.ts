import { z } from 'zod';
import { baseMoveActors, cancelActors, environmentCauses, retryActors } from './events.ts';
import { failureKindSchema, pauseReasons } from './execution.ts';
import { isoTimeSchema } from './primitives.ts';

/**
 * Отчёт об эффекте harness (`harness report`, `valueReport`): что дали
 * исполнение, проверки и ревью на данных самого проекта. Строится только из
 * перечисленных полей состояния, записей учёта и ревью; prompt, вывод
 * runtime, тексты находок и ошибок, fencing-токены сюда не попадают.
 *
 * Правила (`docs/contracts.md`, раздел «Отчёт»):
 * - каждое число — наблюдение, а не вывод: «сэкономлено часов» нет;
 * - неизвестное — не ноль: `bound` говорит, точное ли значение, нижняя или
 *   верхняя граница, или оно неизвестно (`value: null`);
 * - малые выборки: процент — только при знаменателе от 20, медиана — от 5
 *   значений, меньше 3 принятых поручений — «недостаточно данных»;
 * - списки ограничены (`REPORT_LIMITS`), усечение отмечено флагом.
 *
 * Литералы перечней повторяют `src/report/*` (модуль без zod для браузера);
 * тест сверяет оба перечня поэлементно.
 */
export const REPORT_VERSION = 1;

export const REPORT_LIMITS = {
  /** Строки таблицы поручений. */
  works: 50,
  /** Ссылки на evidence отказов. */
  evidence: 50,
  /** Недели тренда; более ранние свёрнуты в одну строку. */
  weeks: 12,
  /** Строки gates, стадий, версий движка и прочих разбивок. */
  rows: 50,
  /** Предел сериализованного JSON отчёта, байт UTF-8. */
  jsonBytes: 512 * 1024,
  /** Предел HTML отчёта, байт UTF-8. */
  htmlBytes: 1024 * 1024,
} as const;

/** Корзины классов отказа попытки (`failureBucketOf`). */
export const failureBuckets = [
  'defect',
  'incomplete',
  'integration',
  'environment',
  'time-limit',
  'tool',
  'operator',
  'budget',
  'unknown',
  'unclassified',
] as const;
export type FailureBucket = (typeof failureBuckets)[number];

/** Точность значения: точное, нижняя или верхняя граница, неизвестно. */
export const reportBounds = ['exact', 'lower', 'upper', 'unknown'] as const;

export const headlineIds = ['accepted', 'sent-back', 'lead-time', 'spend', 'environment'] as const;

const count = z.number().int().min(0);
const ms = z.number().int().min(0);
const usd = z.number().min(0);
const week = z.string().regex(/^\d{4}-W\d{2}$/);
const label = z.string().min(1).max(200);
const sentence = z.string().max(600);
const rows = REPORT_LIMITS.rows;

/** Значение и его основание: `n` — знаменатель или размер выборки, `unknown` — неизмеренные входы. */
export const reportMeasureSchema = z.strictObject({
  value: z.number().nullable(),
  n: count,
  unknown: count,
  bound: z.enum(reportBounds),
});
export type ReportMeasure = z.infer<typeof reportMeasureSchema>;

/**
 * Распределение: медиана и p75 — только при `n >= 5`, иначе `null`, а
 * значения перечислены в `values` (по возрастанию).
 */
export const reportDistSchema = z.strictObject({
  n: count,
  unknown: count,
  median: z.number().min(0).nullable(),
  p75: z.number().min(0).nullable(),
  max: z.number().min(0).nullable(),
  values: z.array(z.number().min(0)).max(4),
});
export type ReportDist = z.infer<typeof reportDistSchema>;

const headlineSchema = z.strictObject({
  id: z.enum(headlineIds),
  /** Значение для крупного шрифта: «19», «≥ $5.73», «3.2 h». */
  value: z.string().min(1).max(60),
  /** Одно предложение простым языком. */
  text: sentence,
  /** Знаменатель, окно и оговорка. */
  basis: sentence,
  measure: reportMeasureSchema,
});

const evidenceRefSchema = z.strictObject({
  workId: label,
  runId: label,
  attempt: z.number().int().positive(),
  kind: z.enum(['test', 'review', 'scope']),
  phase: z.enum(['candidate', 'integration']).nullable(),
  gate: label.nullable(),
  at: isoTimeSchema,
  /** Первые 12 символов SHA кандидата. */
  sha: z.string().max(12).nullable(),
  /** Журнал относительно каталога состояния; путь вне его — `…/<имя>`. */
  log: z.string().max(300).nullable(),
  /** Блокирующие находки отклонившего ревью. */
  blocking: count.nullable(),
});

const countRow = <K extends z.ZodType>(key: K) => z.strictObject({ key, count });
/** Число по каждому актёру перечня. */
const actorCounts = <A extends readonly [string, ...string[]]>(actors: A) =>
  z.strictObject(
    Object.fromEntries(actors.map((a) => [a, count])) as { [K in A[number]]: typeof count },
  );

const weekRowSchema = z.strictObject({
  kind: z.literal('week'),
  week,
  attempts: count,
  accepted: count,
  firstPass: count,
  defects: count,
  environment: count,
  knownUsd: usd,
  unknownCalls: count,
  leadMedianMs: ms.nullable(),
  engines: z.array(label).max(5),
  /** Набор версий движка отличается от предыдущей активной недели. */
  engineChanged: z.boolean(),
  /** Версий движка в неделе больше 5: показаны первые. */
  enginesTruncated: z.boolean(),
});
const weekGapSchema = z.strictObject({ kind: z.literal('gap'), from: week, to: week });
const weekEarlierSchema = z.strictObject({
  kind: z.literal('earlier'),
  from: week,
  to: week,
  weeks: count,
  attempts: count,
  accepted: count,
  firstPass: count,
  defects: count,
  environment: count,
  knownUsd: usd,
  unknownCalls: count,
});

const workRowSchema = z.strictObject({
  id: label,
  /** Нет при `noTitles`. */
  title: z.string().max(180).optional(),
  outcome: z.enum(['accepted', 'failed', 'cancelled']),
  finishedAt: isoTimeSchema.nullable(),
  attempts: count,
  /** Засчитанные попытки: без отказов окружения и прерываний штатной остановкой. */
  counted: count,
  leadMs: ms.nullable(),
  knownUsd: usd,
  unknownCalls: count,
  costBound: z.enum(reportBounds),
  rejections: z.array(countRow(z.enum(failureBuckets))).max(failureBuckets.length),
});

export const valueReportSchema = z.strictObject({
  reportVersion: z.literal(REPORT_VERSION),
  harnessVersion: z.string().min(1).max(100),
  /** Метка проекта (имя каталога состояния); нет при `noTitles`. */
  label: z.string().max(200).nullable(),
  window: z.strictObject({
    since: isoTimeSchema.nullable(),
    until: isoTimeSchema.nullable(),
    /** Момент отчёта: по умолчанию — последняя метка времени в данных, а не часы. */
    asOf: isoTimeSchema,
  }),
  /** Принятых поручений в окне не меньше 3. */
  enoughData: z.boolean(),
  coverage: z.strictObject({
    works: count,
    attempts: count,
    failed: count,
    withFailureKind: count,
    withTimings: count,
    /** Попытки с полным учётом вызовов (`callsRecorded`). */
    withCalls: count,
    /**
     * Поручения `done` без успешной попытки: время приёмки неизвестно, в
     * принятые (в любом окне) не входят.
     */
    doneWithoutAttempt: count,
    withWait: count,
    withEngineVersion: count,
    engines: z.array(label).max(20),
    enginesTruncated: z.boolean(),
    calls: count,
    reviews: count,
    events: count,
    eventsFrom: isoTimeSchema.nullable(),
  }),
  summary: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('ok'),
      headlines: z.array(headlineSchema).max(5),
    }),
    z.strictObject({
      status: z.literal('not-enough-data'),
      text: sentence,
      accepted: count,
      attempts: count,
      failedAttempts: count,
      works: count,
    }),
  ]),
  defects: z.strictObject({
    rejected: count,
    byKind: z.strictObject({ gate: count, review: count, 'scope-violation': count }),
    byPhase: z.strictObject({ candidate: count, integration: count, unknown: count }),
    /**
     * Возвращено до приёмки: `value` — с отказом `defect`; `unknown` — только
     * с отказами без класса (`unknown`, `unclassified`) — `bound: lower`;
     * без них, но с возвратами только gate подготовки — `bound: upper`.
     */
    sentBack: reportMeasureSchema,
    /** Возвращённые только отказами gate подготовки (возможна сеть). */
    sentBackSetupOnly: count,
    /**
     * Диапазон возвращённых: `min` — с отказом `defect` не только в gates
     * подготовки; `max` — плюс только gates подготовки и только отказы без
     * класса. Оба сомнения сразу — `sentBack.bound: unknown`, показывается
     * диапазон.
     */
    sentBackRange: z.strictObject({ min: count, max: count }),
    byGate: z
      .array(
        z.strictObject({
          gate: label,
          phase: z.enum(['candidate', 'integration']),
          failed: count,
          /** Gate подготовки (установка зависимостей): его отказ часто вызван сетью. */
          setup: z.boolean(),
        }),
      )
      .max(rows),
    byGateTruncated: z.boolean(),
    reviews: z.strictObject({
      rejected: count,
      candidate: count,
      integration: count,
      blockingFindings: count,
      withoutFindings: count,
    }),
    afterGreenGates: reportMeasureSchema,
    integration: count,
    planContract: z.strictObject({
      rounds: count,
      rejected: count,
      plans: z.strictObject({ rounds: count, rejected: count }),
      contracts: z.strictObject({ rounds: count, rejected: count }),
      blockingClosed: count,
      blockingOpen: count,
      blockingWithdrawn: count,
    }),
    withdrawn: reportMeasureSchema,
    items: z.array(evidenceRefSchema).max(REPORT_LIMITS.evidence),
    itemsTotal: count,
    itemsTruncated: z.boolean(),
  }),
  autonomy: z.strictObject({
    withAction: reportMeasureSchema,
    withoutAction: reportMeasureSchema,
    /** `null` — действие этого вида не записывается. */
    actions: z.strictObject({
      /** Решения recovery с источником `operator`: единственное действие с записанным актёром. */
      operatorDecisions: count,
      /** Удержания и отмены попыток: актёр не записан, к действиям человека не относятся. */
      holds: count,
      cancelledAttempts: count,
      /** Повторы, сбросы и сдвиги базы в окне по событиям; `null` — событий вмешательств нет. */
      retries: count.nullable(),
      resets: count.nullable(),
      baseMoves: count.nullable(),
      /**
       * Актёры вмешательств из событий `work.retried`, `work.cancelled`,
       * `base.moved`; `null` — таких событий в журнале нет (записаны до
       * версии, которая их пишет). `from` — первое такое событие; `bound:
       * lower` — в окне есть активность раньше него.
       */
      recorded: z
        .strictObject({
          from: isoTimeSchema,
          bound: z.enum(['exact', 'lower']),
          retries: actorCounts(retryActors),
          resets: actorCounts(retryActors),
          cancellations: actorCounts(cancelActors),
          /** Отмены поручений без активной попытки (их `attempt.cancelled` нет). */
          cancelledWithoutAttempt: count,
          baseMoves: actorCounts(baseMoveActors),
        })
        .nullable(),
    }),
    approvals: z.strictObject({
      operator: count,
      agent: count,
      /**
       * `events` — события `graph.approved`; `state` — согласования графов в
       * состоянии (графы без событий); `mixed` — оба; `none` — записей нет
       * (число неизвестно, а не ноль).
       */
      source: z.enum(['events', 'state', 'mixed', 'none']),
    }),
    pauses: z
      .array(
        z.strictObject({
          reason: z.enum(pauseReasons),
          count,
          pausedMs: ms,
          /** Пауз без последующего resume: их время считано до `asOf`. */
          open: count,
          failures: z.array(failureKindSchema).max(20),
        }),
      )
      .max(pauseReasons.length),
    escalations: count,
  }),
  speed: z.strictObject({
    leadTime: reportDistSchema,
    /** Начало взято из `WorkState.approvedAt`: у первой попытки нет `wait.approvedAt`. */
    leadTimeFallback: count,
    dependencyWait: reportDistSchema,
    queueWait: reportDistSchema,
    stages: z
      .array(
        z.strictObject({
          family: label,
          spans: count,
          totalMs: ms,
          medianMs: ms.nullable(),
          acceptedMs: ms,
          rejectedMs: ms,
          incomplete: count,
        }),
      )
      .max(rows),
    stagesTruncated: z.boolean(),
    firstPass: reportMeasureSchema,
    firstPassRaw: reportMeasureSchema,
    finished: z.strictObject({ accepted: count, failed: count, cancelled: count }),
    attemptsPerAccepted: z.strictObject({
      n: count,
      buckets: z.strictObject({ '1': count, '2': count, '3': count, '4-6': count, '7+': count }),
      median: z.number().min(0).nullable(),
      mean: z.number().min(0).nullable(),
    }),
    attemptsOnOther: count,
    machineTime: reportDistSchema,
  }),
  cost: z.strictObject({
    calls: count,
    knownCalls: count,
    knownUsd: usd,
    reportedUsd: usd,
    estimatedUsd: usd,
    unknown: z.strictObject({
      total: count,
      noPrice: count,
      incomplete: count,
      active: count,
      abandoned: count,
      byRuntime: z.array(z.strictObject({ runtime: label, calls: count })).max(20),
    }),
    /** Попытки без единой записи вызова и без полного учёта: расход неизвестен. */
    attemptsWithoutCalls: count,
    /** Попытки с записями вызовов, но без полного учёта: расход — нижняя граница. */
    attemptsPartialCalls: count,
    perAccepted: reportMeasureSchema,
    perAttempt: reportDistSchema,
    rejected: z.strictObject({
      /** `lower` — у части попыток учёт неполон. */
      bound: z.enum(reportBounds),
      usd,
      totalUsd: usd,
      attempts: count,
      byBucket: z.array(z.strictObject({ bucket: z.enum(failureBuckets), usd })).max(10),
    }),
    byStage: z
      .array(z.strictObject({ stage: label, calls: count, knownUsd: usd, unknownCalls: count }))
      .max(rows),
    tokens: z.strictObject({
      input: count,
      output: count,
      cacheRead: count,
      cacheWrite: count,
      incompleteCalls: count,
    }),
  }),
  environment: z.strictObject({
    failed: count,
    classified: count,
    interrupted: count,
    buckets: z.array(z.strictObject({ bucket: z.enum(failureBuckets), count })).length(10),
    /** Отказы окружения среди классифицированных; `lower`, если есть отказы gate подготовки. */
    share: reportMeasureSchema,
    /** Отказы `defect` только в gates подготовки: возможно, тоже окружение (сеть, реестр). */
    setupCheckFailures: count,
    timeLimit: count,
    /**
     * Подпричины отказов окружения по `attempt.diagnosed`; `null` — таких
     * событий в журнале нет. `undiagnosed` — отказы окружения окна без
     * события (записаны раньше): тогда `bound: lower`.
     */
    causes: z
      .strictObject({
        rows: z
          .array(
            z.strictObject({
              cause: z.enum(environmentCauses),
              count,
              /** Из них засчитаны в предел попыток. */
              counted: count,
            }),
          )
          .max(environmentCauses.length),
        diagnosed: count,
        undiagnosed: count,
        bound: z.enum(['exact', 'lower']),
      })
      .nullable(),
    neutral: z.strictObject({
      costBound: z.enum(reportBounds),
      attempts: count,
      blocked: count,
      machineMs: ms,
      knownUsd: usd,
      runtimePauses: count,
    }),
    rechecks: z.strictObject({ flaky: count, confirmed: count }),
  }),
  weeks: z.strictObject({
    rows: z.array(z.union([weekRowSchema, weekGapSchema])).max(2 * REPORT_LIMITS.weeks),
    earlier: weekEarlierSchema.nullable(),
    active: count,
  }),
  works: z.strictObject({
    rows: z.array(workRowSchema).max(REPORT_LIMITS.works),
    total: count,
    truncated: z.boolean(),
  }),
  limitations: z
    .array(z.strictObject({ id: z.string().min(1).max(60), text: sentence }))
    .min(1)
    .max(30),
});
export type ValueReport = z.infer<typeof valueReportSchema>;

/** `harness report --out`: отчёт записан в файл, в ответе — куда и сколько. */
export const reportFileSchema = z.strictObject({
  out: z.string().min(1),
  format: z.enum(['json', 'md', 'html']),
  bytes: count,
  asOf: isoTimeSchema,
});

/** Данные `harness report`: отчёт или запись о файле (`--out`). */
export const reportDataSchema = z.union([valueReportSchema, reportFileSchema]);
