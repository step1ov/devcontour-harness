import { z } from 'zod';
import { decisionSettingsSchema } from './decisions.ts';
import { trackStepKinds, trackStepStates } from './decision-rules.ts';
import { isoTimeSchema } from './primitives.ts';
import {
  OPERATOR_VIEW_LIMITS as L,
  OPERATOR_VIEW_TEXT as T,
  OPERATOR_VIEW_VERSION,
} from './operator-view-limits.ts';

export * from './operator-view-limits.ts';

/**
 * Представление оператора (`harness view`, панель оператора): документ
 * только для чтения, версия `viewVersion` (мажорная) и `viewRevision`
 * (добавления). Поля, помеченные P2, harness ещё не выдаёт; схема их
 * описывает, чтобы документ другого производителя (хост, фикстура панели)
 * проверялся той же схемой. Объекты закрыты: поле вне договора — дефект
 * производителя, а не незаметная утечка.
 */

const count = z.number().int().min(0);
const usd = z.number().min(0);
/** Открытое перечисление: известные значения в документации, читатель осторожен с прочими. */
const token = (max = 80) => z.string().min(1).max(max);
const id = token(200);
const freeText = (max: number) => z.string().max(max);

export const boundedSchema = z.strictObject({
  value: z.number().min(0),
  bound: z.enum(['exact', 'lower', 'unknown']),
});

const viewActor = token(40);
const bindingSchema = z.strictObject({
  runtime: token(40),
  model: z.string().min(1).max(T.model).optional(),
  effort: token(20).optional(),
});

export const viewSettingsSchema = z.strictObject({
  policyDigest: token(100),
  approvalMode: z.enum(['agent', 'operator']),
  mode: z.enum(['live', 'fixture']),
  concurrency: z.number().int().positive(),
  roles: z
    .array(z.strictObject({ role: id, writer: bindingSchema, repositoryId: id.optional() }))
    .max(L.roles),
  reviews: z
    .array(
      z.strictObject({
        kind: z.enum(['plan', 'contract', 'code']),
        scope: z.enum(['global', 'repository', 'role']),
        repositoryId: id.optional(),
        role: id.optional(),
        reviewer: bindingSchema,
        alternates: z.array(bindingSchema).max(L.alternates),
        vendor: z.enum(['different-vendor', 'same-vendor-allowed']),
      }),
    )
    .max(L.reviewRules),
  thresholds: z.strictObject({
    inputSeverity: z.number().int().min(1).max(11),
    leadAnswersMaxSeverity: z.number().int().min(1).max(10).optional(),
    leadAnswersTechnical: z.boolean().optional(),
    criticalPaths: count,
    maxAttempts: z.number().int().positive(),
    repairBudget: count,
    maxNeutralFailures: count,
    reviewRoundCap: count,
    reviewEscalationRounds: count,
  }),
  budgets: z
    .array(
      z.strictObject({
        scope: z.enum(['work', 'group', 'total']),
        usd: usd.optional(),
        timeMs: count.optional(),
      }),
    )
    .max(3),
  budgetOnUnknown: z.enum(['stop', 'continue']).optional(),
  timeouts: z.strictObject({
    runTimeoutMs: count,
    leaseMs: count,
    gateTimeoutFloorMs: count.optional(),
    stall: z.strictObject({
      intervalMs: count,
      quietMs: count,
      stalledMs: count,
      action: z.enum(['stop', 'report']),
    }),
  }),
  lean: z.strictObject({ state: z.enum(['on', 'off', 'unknown']) }),
  defaulted: z.array(token(100)).max(50),
  /**
   * Ревизия 6: настройки решений — кто решает после повторных отказов и на
   * технические вопросы — с объяснением и итогом одной фразой; те же тексты
   * у doctor и status (docs/principles.md «Кто принимает решения»).
   */
  decisions: decisionSettingsSchema.optional(),
});

const findingSchema = z.strictObject({
  id: token(100),
  severity: token(20),
  status: token(40),
  rounds: count.optional(),
  disposition: z
    .strictObject({
      decision: z.enum(['accepted-limitation', 'continue']),
      by: z.enum(['lead', 'operator']),
      round: z.number().int().positive(),
    })
    .optional(),
  title: freeText(T.title).optional(),
});

export const reviewSubjectViewSchema = z.strictObject({
  kind: z.enum(['plan', 'contract', 'code']),
  subject: id,
  workId: id.optional(),
  approved: z.boolean(),
  rounds: z.strictObject({ used: count, max: z.number().int().positive().nullable() }),
  open: z.strictObject({ blocking: count, notes: count }),
  accepted: count,
  reviewer: bindingSchema.optional(),
  sameVendor: z.boolean().optional(),
  spend: z.strictObject({ calls: count, usd: boundedSchema }),
  findings: z.array(findingSchema).max(L.findingsPerSubject),
  escalation: z
    .strictObject({
      requestId: id,
      findings: z.array(token(100)).max(L.findingsPerSubject),
      answered: z.boolean(),
    })
    .optional(),
  line: freeText(T.line).optional(),
});

export const operatorQuestionSchema = z.strictObject({
  requestId: id,
  workId: id,
  state: token(40),
  version: z.number().int().positive(),
  severity: z.number().int().min(1).max(10),
  answerableBy: z.enum(['operator', 'operator-or-lead']),
  /** Нет поля или значение вне перечня — `user-visible`: отвечает только оператор. */
  impact: token(40).optional(),
  plain: freeText(T.questionPlain).optional(),
  answeredBy: z.enum(['operator', 'lead', 'host']).optional(),
  /**
   * Основание последнего ответа (ревизия 1): кто ответил, по какому правилу
   * политики ответил ведущий (`technical`, `severity`), его причина и влияние
   * вопроса — панель показывает «ответил ведущий: <причина>» строкой `line`.
   */
  answerBasis: z
    .strictObject({
      by: z.enum(['operator', 'lead', 'host']),
      rule: z.enum(['technical', 'severity']).optional(),
      reason: freeText(T.reason).optional(),
      impact: token(40),
      at: isoTimeSchema,
      line: z.string().min(1).max(T.line),
    })
    .optional(),
  title: freeText(T.questionTitle).optional(),
  /**
   * Варианты ответа и рекомендуемый (ревизия 4): то же, что `harness
   * input-show`, после маскирования и обрезки; без `--no-titles`.
   */
  options: z
    .array(
      z.strictObject({
        id: token(40),
        label: freeText(T.option),
        recommended: z.literal(true).optional(),
      }),
    )
    .max(L.questionOptions)
    .optional(),
  /** Обоснование исполнителя (ревизия 4); без `--no-titles`. */
  rationale: freeText(T.rationale).optional(),
  createdAt: isoTimeSchema,
  /**
   * Где применённый ответ (ревизия 4): у идущей попытки («ждать нечего»;
   * состояние тогда `delivered`) или у закончившейся, не передавшей его
   * исполнителю («его получит следующая попытка»).
   */
  line: freeText(T.line).optional(),
});

/**
 * Вопрос владельцу из источника задач (ревизия 4): документ `Вопрос: …`
 * (тип `proposal`, состояние `draft`), который ведущий записал в Relay.
 * Только чтение: отвечают в источнике, ссылка — `url` или `ref`. Список —
 * последнее наблюдение связки (`readAt`) при `source-snapshot` или `run --source`.
 */
const sourceQuestionViewSchema = z.strictObject({
  connector: id,
  provider: token(40),
  id,
  ref: token(200),
  title: freeText(T.questionTitle).optional(),
  question: freeText(T.questionTitle).optional(),
  options: z.array(freeText(T.option)).max(L.questionOptions).optional(),
  recommendation: freeText(T.questionPlain).optional(),
  provisional: freeText(T.questionPlain).optional(),
  tasks: z.array(token(200)).max(20).optional(),
  url: z.string().min(1).max(T.url).optional(),
  readAt: isoTimeSchema,
});

/**
 * Весь срез прогона (ревизия 4, P10): все задачи последнего снимка связки,
 * в том числе ещё не готовые. `state`: `in-harness` — работа harness есть
 * (`workId`), `not-ready` — задача не допускается к запуску (`plain` — почему),
 * `not-handed-over` — снимок есть, работа ещё не создана. `progress`
 * по-прежнему считает только работы harness; весь срез считает `forecast`.
 */
const scopeSchema = z.strictObject({
  total: count.optional(),
  tasks: z
    .array(
      z.strictObject({
        id,
        connector: id,
        key: token(200).optional(),
        title: freeText(T.title).optional(),
        workId: id.optional(),
        state: z.enum(['in-harness', 'not-handed-over', 'not-ready']),
        plain: freeText(T.plain).optional(),
      }),
    )
    .max(L.scope),
});

const escalationSchema = z.strictObject({
  workId: id.optional(),
  subject: id.optional(),
  code: token(80),
  actor: viewActor,
  action: token(80),
  /**
   * С какого момента ждёт — время из хранилища. Поле обязательно в версии 1;
   * только у паузы записи прежней версии без `pausedAt` времени нет — тогда
   * это момент запроса (и токен такого состояния меняется от запуска к запуску).
   */
  since: isoTimeSchema,
});

const sha = token(64);
export const driftViewSchema = z.strictObject({
  workId: id,
  repositoryId: id,
  ref: z.string().min(1).max(500),
  acceptedSha: sha,
  head: sha.optional(),
  commitsSinceAccepted: count.optional(),
  filesSinceAccepted: count.optional(),
  diverged: z.literal(true).optional(),
  unavailable: freeText(T.unavailable).optional(),
});

export const workViewSchema = z.strictObject({
  id,
  graphId: id,
  title: freeText(T.title).optional(),
  status: token(40),
  stage: z.strictObject({
    name: token(40),
    step: freeText(T.step).optional(),
    since: isoTimeSchema.optional(),
    next: z.array(token(40)).max(10),
    needs: z.strictObject({ actor: viewActor.nullable(), action: token(80) }).optional(),
    /**
     * Наблюдаемая длительность этапа по закончившимся этапам попыток этого
     * состояния (ревизия 1): p50 и p90 по ближайшему рангу, `samples` — сколько
     * образцов; нет поля — образцов меньше `OPERATOR_VIEW_TYPICAL_MIN_SAMPLES`.
     * Это наблюдение, не обещание.
     */
    typical: z
      .strictObject({ p50Ms: count, p90Ms: count, samples: z.number().int().positive() })
      .optional(),
  }),
  attempts: z.strictObject({
    used: count,
    max: count,
    left: count,
    failed: count,
    interrupted: count,
    rechecks: count,
    neutral: z.strictObject({ used: count, max: count }),
    /**
     * Ревизия 5: запусков всего, в том числе незасчитанных (вопрос
     * исполнителя, отказ окружения, остановка controller). `used` — только
     * засчитанные в предел `max`; строка `line` называет оба числа. Нет
     * поля — запусков столько же, сколько засчитано.
     */
    runs: count.optional(),
    /**
     * Доработка после приёмки (ревизия 5): новая редакция
     * изменила постановку принятой работы. Числа попыток — только её;
     * `acceptedSha`/`acceptedAt` — прежняя приёмка, `fresh` — у доработки
     * свой предел попыток (иначе перенесён с прежней редакции). Нет поля —
     * доработок не было.
     */
    rework: z
      .strictObject({
        revision: z.number().int().positive(),
        fresh: z.boolean(),
        acceptedSha: sha,
        acceptedAt: isoTimeSchema.optional(),
      })
      .optional(),
    line: freeText(T.line).optional(),
    lastFailure: z
      .strictObject({
        attempt: z.number().int().positive(),
        bucket: token(40),
        plain: z.string().min(1).max(T.plain),
        at: isoTimeSchema.optional(),
        /**
         * Ревизия 4: класс отказа движка (`failureKind`: `environment`,
         * `needs-input`, `needs-lead`, `timeout`…) и засчитана ли попытка в
         * предел — панель не разбирает фразу `plain`. Нет поля — неизвестно.
         */
        kind: token(40).optional(),
        counted: z.boolean().optional(),
      })
      .optional(),
  }),
  liveness: z.enum(['active', 'quiet', 'stalled']).optional(),
  runtime: token(40).optional(),
  model: z.string().min(1).max(T.model).optional(),
  blockers: z
    .array(
      z.strictObject({
        code: token(80),
        plain: freeText(T.plain).optional(),
        actor: viewActor.nullable(),
        /**
         * Ревизия 4: порядок снятия, когда блокировки снимают разные
         * участники (1 — первой: согласование раньше сброса попыток).
         */
        step: z.number().int().positive().optional(),
      }),
    )
    .max(L.blockersPerWork),
  dependsOn: z.array(id).max(L.dependsOn).optional(),
  target: z
    .strictObject({
      repositoryId: id,
      ref: z.string().min(1).max(500),
      acceptedSha: sha.optional(),
      /**
       * Есть ли принятый коммит в удалённой ветке (ревизия 2): `state` —
       * `pushed`, `not-pushed` или `unknown`, только по локальной
       * remote-tracking ref, без fetch и сети. `trackingRef` — короткое имя
       * удалённой ветки (`origin/main`), `checkedAt` — когда git на этой
       * машине последний раз обновил её (reflog; нет — неизвестно), `line` —
       * та же сводка простыми словами. Неизвестное значение `state` читается
       * как `unknown`.
       */
      remote: z.strictObject({
        state: token(40),
        trackingRef: z.string().min(1).max(500).optional(),
        checkedAt: isoTimeSchema.optional(),
        reason: freeText(T.reason).optional(),
        line: z.string().min(1).max(T.line).optional(),
      }),
    })
    .optional(),
  question: z
    .strictObject({
      requestId: id,
      state: token(40),
      severity: z.number().int().min(1).max(10),
      /** Ревизия 4: где применённый ответ (как `questions[].line`). */
      line: freeText(T.line).optional(),
    })
    .optional(),
  spend: z.strictObject({ calls: count, usd: boundedSchema, durationMs: count }),
  resultSha: sha.optional(),
  /**
   * Ревизия 6: путь работы целиком — пройденные попытки по шагам (код →
   * проверки → ревью → интеграция), разборы и сбросы между ними, текущая
   * точка и плановый остаток: попытки, разбор ведущего по
   * `recovery.diagnoseAfter`, запасные раунды сбросов ведущего
   * (`recovery.leadResets`) и «принято». `rework` — шаг доработки после
   * приёмки. Сверх предела отброшены самые ранние (`truncated`).
   */
  track: z
    .strictObject({
      steps: z
        .array(
          z.strictObject({
            kind: z.enum(trackStepKinds),
            attempt: z.number().int().positive().optional(),
            state: z.enum(trackStepStates),
            label: z.string().min(1).max(80),
            at: isoTimeSchema.optional(),
            reason: z.string().min(1).max(200).optional(),
            rework: z.number().int().positive().optional(),
          }),
        )
        .max(L.trackSteps),
      truncated: count.optional(),
    })
    .optional(),
});

const series = z.array(count).max(L.buckets);
export const viewHistorySchema = z.strictObject({
  from: isoTimeSchema,
  to: isoTimeSchema,
  bucketMs: z.number().int().positive(),
  load: series,
  attemptsStarted: series,
  attemptsFailed: series,
  gatesPassed: series,
  gatesFailed: series,
  gatesReused: series,
  spendUsd: z.array(usd).max(L.buckets),
  spendBound: z.enum(['exact', 'lower', 'unknown']),
  spendOpeningUsd: boundedSchema,
  budgetUsd: usd.optional(),
  /**
   * Итоги окна (ревизия 1): те же правила, что ряды; `failuresByBucket` — те
   * же неудачные попытки, что `attemptsFailed`, по классам отказа (сумма
   * равна `attemptsFailed`).
   */
  totals: z
    .strictObject({
      attemptsStarted: count,
      attemptsFailed: count,
      failuresByBucket: z.record(token(40), count),
      gatesPassed: count,
      gatesFailed: count,
      gatesReused: count,
      reviewRounds: z.strictObject({
        plan: count,
        contract: count,
        code: count,
        attempt: count,
      }),
      spendUsd: boundedSchema,
      /** Время окна, когда шла хотя бы одна попытка. */
      wallMs: count,
      /** Сумма времени попыток в окне (параллельные складываются). */
      attemptMs: count,
      loadPeak: count,
    })
    .optional(),
});

export const viewHealthSchema = z.strictObject({
  controller: z.strictObject({ present: z.boolean(), leaseUntil: isoTimeSchema.optional() }),
  stalledAttempts: count,
  quietAttempts: count,
  environmentFailures: count,
  budgeting: z.enum(['on', 'off']),
  budgets: z
    .array(
      z.strictObject({
        scope: z.enum(['work', 'group', 'total']),
        id: id.optional(),
        state: z.enum(['within', 'exceeded', 'undetermined']),
        spentUsd: boundedSchema,
        limitUsd: usd.optional(),
        spentMs: count.optional(),
        limitMs: count.optional(),
      }),
    )
    .max(L.reviews),
  spentTotalUsd: boundedSchema,
  drift: z.strictObject({ checked: count, drifted: count, unavailable: count }),
  warnings: z
    .array(z.strictObject({ code: token(80), message: freeText(T.message) }))
    .max(L.warnings),
  /**
   * Связки с источниками задач (ревизия 4): совместимость Relay по последнему
   * наблюдению связки — `level` (`recommended`, `below-recommended`), есть ли
   * контекст задачи, версия договора и строка простыми словами.
   */
  sources: z
    .array(
      z.strictObject({
        connector: id,
        provider: token(40),
        level: token(40).optional(),
        taskContext: z.boolean().optional(),
        contractVersion: z.number().int().optional(),
        line: z.string().min(1).max(T.line).optional(),
        checkedAt: isoTimeSchema,
      }),
    )
    .max(L.sources)
    .optional(),
});

/**
 * Кто что делал (ревизия 2): события из записей хранилища за окно истории,
 * новые сверху. `actor` — `controller`, `writer`, `reviewer`, `lead`,
 * `operator`, `host`; `action` — код события (docs/operator-view.md), `plain`
 * — фраза обычными словами. Нет поля — производитель ленту не ведёт.
 */
const activitySchema = z.strictObject({
  at: isoTimeSchema,
  actor: viewActor,
  action: token(80),
  workId: id.optional(),
  subject: id.optional(),
  plain: z.string().min(1).max(T.activity),
});

/** P2: решения; обязательные сочетания — design §3.9. */
const decisionSchema = z
  .strictObject({
    id,
    kind: token(40),
    by: z.enum(['lead', 'operator']),
    at: isoTimeSchema,
    workId: id.optional(),
    subject: id.optional(),
    findingId: token(100).optional(),
    requestId: id.optional(),
    temporary: z.boolean(),
    revisit: freeText(200).optional(),
    title: freeText(200).optional(),
    reason: freeText(400).optional(),
  })
  .superRefine((d, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [path], message });
    };
    need(!d.temporary || d.revisit !== undefined, 'revisit', 'temporary требует revisit');
    if (d.kind === 'technical-answer') {
      need(d.requestId !== undefined, 'requestId', 'technical-answer требует requestId');
      need(d.reason !== undefined, 'reason', 'technical-answer требует reason');
    }
    if (d.kind === 'accepted-limitation')
      need(d.findingId !== undefined, 'findingId', 'accepted-limitation требует findingId');
  });

/**
 * Прогноз выпуска (ревизия 4, P11): готовность всего объёма и время; те же
 * строки, что в `status --human`. Неизвестное время — без поля `remaining`
 * (никогда не ноль). Формула и допущения — в `assumptions` и docs/contracts.md.
 */
const forecastSchema = z.strictObject({
  progress: z.strictObject({
    percent: z.number().int().min(0).max(100),
    weighted: z.number().min(0),
    total: z.number().int().positive(),
    done: count,
    inWork: count,
    left: count,
    basis: z.enum(['scope', 'works']),
    line: z.string().min(1).max(T.line),
    /**
     * Открытые доработки после приёмки: работы в `done` (вес 1 — прежняя
     * приёмка прогноз не роняет), чья новая редакция ещё не принята. Их
     * остаток входит в «осталось» времени. Нет поля — доработок нет.
     */
    rework: z.number().int().positive().optional(),
    /** Ревизия 5: задачи, добавленные в выпуск после его начала. */
    added: z
      .array(
        z.strictObject({
          key: token(200),
          workId: id.optional(),
          at: isoTimeSchema,
          before: count,
          after: count,
          line: z.string().min(1).max(T.line),
        }),
      )
      .max(L.forecastAdded)
      .optional(),
    /** Ревизия 5: готовность каждой работы (не падает на повторе) и её попытка из предела. */
    works: z
      .array(
        z.strictObject({
          workId: id,
          key: token(200).optional(),
          percent: z.number().int().min(0).max(100),
          attempt: z
            .strictObject({ n: z.number().int().positive(), max: z.number().int().positive() })
            .optional(),
          retry: z.enum(['repair', 'answer']).optional(),
          /** Доработка после приёмки: `percent` — готовность доработки, работа уже в `done`. */
          rework: z.literal(true).optional(),
          line: z.string().min(1).max(T.line),
        }),
      )
      .max(L.forecastWorks)
      .optional(),
  }),
  time: z.strictObject({
    startedAt: isoTimeSchema.optional(),
    elapsedMs: count.optional(),
    /** Ревизия 5: выпуск закончен — конец последней попытки (`elapsedMs` — до него). */
    finishedAt: isoTimeSchema.optional(),
    remaining: z
      .strictObject({
        loMs: count,
        hiMs: count,
        samples: z.number().int().positive(),
        attemptsPerTask: z.number().min(1),
      })
      .optional(),
    /** Ревизия 5: грубая оценка при 1–4 закончившихся попытках выпуска («грубо, по N попыткам»). */
    rough: z
      .strictObject({
        loMs: count,
        hiMs: count,
        samples: z.number().int().positive(),
        attemptsPerTask: z.number().min(1),
      })
      .optional(),
    /** Ревизия 5: чем названо «осталось». */
    estimate: z.enum(['precise', 'rough', 'unknown', 'nothing']).optional(),
    humanWait: z.strictObject({ works: count, ms: count, since: isoTimeSchema.optional() }),
    line: z.string().min(1).max(T.line),
  }),
  assumptions: z.array(z.string().min(1).max(400)).max(10),
});

const sourceSchema = z.strictObject({
  producer: token(100),
  producerVersion: token(100),
  stateVersion: z.number().int().positive(),
  /** SHA-256 канонических байтов без `generatedAt` и `source.token` (у harness — 64 hex). */
  token: token(100),
});

const truncatedCount = z.number().int().positive();

export const operatorViewSchema = z.strictObject({
  viewVersion: z.literal(OPERATOR_VIEW_VERSION),
  viewRevision: count,
  generatedAt: isoTimeSchema,
  source: sourceSchema,
  settings: viewSettingsSchema,
  works: z.array(workViewSchema).max(L.works),
  reviews: z.array(reviewSubjectViewSchema).max(L.reviews),
  questions: z.array(operatorQuestionSchema).max(L.questions),
  escalations: z.array(escalationSchema).max(L.escalations),
  drift: z.array(driftViewSchema).max(L.drift),
  progress: z.strictObject({
    total: count,
    byStage: z.record(token(40), count),
    running: count,
    done: count,
    waitingOperator: count,
    queue: z.strictObject({
      paused: z.boolean(),
      reason: token(80).optional(),
      detail: freeText(T.detail).optional(),
      actor: viewActor.optional(),
      action: token(80).optional(),
      /**
       * Ревизия 4: кто двигает очередь (`status.runner`): `running` — живой
       * controller, идущая попытка или ревью плана в живом run;
       * `not-running` — никто не запущен, открытые работы сдвинет только
       * новый запуск, его делает `restartBy` (`lead`: harness run). `line` —
       * то же фразой. `paused: false` при `not-running` — не «очередь идёт».
       */
      runner: z.enum(['running', 'not-running']).optional(),
      /**
       * 0.1.0-alpha.62: harness с этим каталогом ещё ничего не запускал (нет
       * состояния или в нём нет ни работ, ни попыток, ни controller); `line`
       * — фраза о первом запуске. Не «очередь идёт» и не «очередь стоит».
       */
      neverRun: z.literal(true).optional(),
      restartBy: viewActor.optional(),
      line: freeText(T.line).optional(),
    }),
  }),
  history: viewHistorySchema,
  health: viewHealthSchema,
  activity: z.array(activitySchema).max(L.activity).optional(),
  decisions: z.array(decisionSchema).max(L.decisions).optional(),
  scope: scopeSchema.optional(),
  /**
   * 0.1.0-alpha.62: почему `scope` нет — `no-snapshot`: ни одна связка ещё не
   * записала снимок задач трекера; `unreadable`: база коннектора есть, но эта
   * версия её не прочитала. Опущенный по размеру `scope` называет
   * `truncated.scope`.
   */
  scopeReason: z.enum(['no-snapshot', 'unreadable']).optional(),
  sourceQuestions: z.array(sourceQuestionViewSchema).max(L.sourceQuestions).optional(),
  /**
   * Ревизия 5: принятые работы, оставленные в источнике задач на проверку
   * человеку (`completion.mode: review-only` или колонка не done): по
   * последней доставке и последнему чтению связки. Каждая задача — и
   * эскалация `SOURCE_REVIEW` (actor `operator`).
   */
  sourceReviews: z
    .array(
      z.strictObject({
        connector: id,
        provider: token(80),
        tasks: z
          .array(
            z.strictObject({
              taskId: id,
              key: token(200).optional(),
              workId: id,
              column: token(40),
              since: isoTimeSchema,
            }),
          )
          .min(1)
          .max(L.sourceReviewTasks),
        line: z.string().min(1).max(T.line),
      }),
    )
    .max(L.sources)
    .optional(),
  /**
   * Ревизия 5: этап проекта. `setup` — harness ещё настраивается (нет
   * состояния, политики или ни одной работы): `lines` — простые фразы для
   * панели («Идёт настройка harness», «Задач пока нет»). `work` — работы есть.
   */
  stage: z
    .strictObject({
      name: z.enum(['setup', 'work']),
      lines: z.array(z.string().min(1).max(T.line)).max(L.stageLines),
    })
    .optional(),
  forecast: forecastSchema.optional(),
  /**
   * Обновления harness и панели по последней проверке `harness update
   * --check` (ревизия 4, harness 0.1.0-alpha.60): панель показывает
   * «Доступна … — что нового · как обновить».
   */
  updates: z
    .strictObject({
      state: z.enum(['up-to-date', 'available', 'needs-decision', 'unavailable', 'not-checked']),
      mode: z.enum(['auto', 'notify', 'off']),
      current: z.strictObject({ harness: token(100), ui: token(100).optional() }),
      available: z.strictObject({ harness: token(100), ui: token(100).optional() }).optional(),
      checkedAt: isoTimeSchema.optional(),
      line: freeText(T.updateLine),
      whatsNew: z.array(freeText(T.updateLine)).max(L.updatesWhatsNew).optional(),
      command: freeText(T.updateLine).optional(),
    })
    .optional(),
  truncated: z
    .strictObject({
      scope: truncatedCount.optional(),
      sourceQuestions: truncatedCount.optional(),
      /** Ревизия 5: задачи `sourceReviews[].tasks` сверх предела. */
      sourceReviews: truncatedCount.optional(),
      /** Ревизия 5: незаконченные работы сверх `forecast.progress.works`. */
      forecastWorks: truncatedCount.optional(),
      works: truncatedCount.optional(),
      reviews: truncatedCount.optional(),
      findings: truncatedCount.optional(),
      questions: truncatedCount.optional(),
      escalations: truncatedCount.optional(),
      drift: truncatedCount.optional(),
      roles: truncatedCount.optional(),
      reviewRules: truncatedCount.optional(),
      warnings: truncatedCount.optional(),
      budgets: truncatedCount.optional(),
      blockers: truncatedCount.optional(),
      dependsOn: truncatedCount.optional(),
      alternates: truncatedCount.optional(),
      activity: truncatedCount.optional(),
      decisions: truncatedCount.optional(),
      /**
       * Работы, у которых документ сверх предела размера опустил поля
       * ревизии 4 (`attempts.lastFailure.kind`/`counted`, `blockers[].step`,
       * `question.line`; harness 0.1.0-alpha.61).
       */
      workFields: truncatedCount.optional(),
      /** Пункты `updates.whatsNew` сверх предела (harness 0.1.0-alpha.61). */
      whatsNew: truncatedCount.optional(),
    })
    .optional(),
});
export type OperatorViewDocument = z.infer<typeof operatorViewSchema>;

const verificationRowSchema = z
  .strictObject({
    gate: id,
    kind: z.enum(['gate', 'review']),
    /** Фаза записи: кандидат или интеграция (harness 0.1.0-alpha.55). */
    phase: z.enum(['candidate', 'integration']).optional(),
    result: token(40),
    how: token(40),
    by: token(80).optional(),
    attempt: z.number().int().positive().optional(),
    at: isoTimeSchema.optional(),
  })
  .superRefine((r, ctx) => {
    if (r.how === 'executed' && (r.by === undefined || r.attempt === undefined))
      ctx.addIssue({ code: 'custom', path: ['how'], message: 'executed требует by и attempt' });
    if (r.how === 'reused' && r.attempt === undefined)
      ctx.addIssue({ code: 'custom', path: ['attempt'], message: 'reused требует attempt' });
    if (r.kind === 'review' && r.how === 'executed')
      ctx.addIssue({ code: 'custom', path: ['how'], message: 'ревью не бывает executed' });
  });

export const workDetailViewSchema = z.strictObject({
  viewVersion: z.literal(OPERATOR_VIEW_VERSION),
  viewRevision: count,
  generatedAt: isoTimeSchema,
  source: sourceSchema,
  work: workViewSchema,
  attempts: z
    .array(
      z.strictObject({
        attempt: z.number().int().positive(),
        status: token(40),
        failureBucket: token(40).optional(),
        interrupted: z.literal(true).optional(),
        runtime: token(40),
        model: z.string().min(1).max(T.model).optional(),
        startedAt: isoTimeSchema,
        finishedAt: isoTimeSchema.optional(),
        stages: z
          .array(
            z.strictObject({
              stage: z.string().min(1).max(T.step),
              durationMs: count.optional(),
              outcome: z.enum(['passed', 'failed']).optional(),
              /** Ревизия 3: стадия прошла, но средство не применялось («не используется»). */
              unused: z.literal(true).optional(),
            }),
          )
          .max(L.stagesPerAttempt),
      }),
    )
    .max(L.detailAttempts),
  verification: z.array(verificationRowSchema).max(L.verificationPerWork).optional(),
  reviews: z.array(reviewSubjectViewSchema).max(L.reviews),
  questions: z.array(operatorQuestionSchema).max(L.questions),
  drift: driftViewSchema.optional(),
  truncated: z
    .strictObject({
      attempts: truncatedCount.optional(),
      findings: truncatedCount.optional(),
      verification: truncatedCount.optional(),
      stages: truncatedCount.optional(),
      reviews: truncatedCount.optional(),
      questions: truncatedCount.optional(),
      blockers: truncatedCount.optional(),
      dependsOn: truncatedCount.optional(),
    })
    .optional(),
});
export type WorkDetailViewDocument = z.infer<typeof workDetailViewSchema>;

/**
 * Документ настройки (ревизия 5): harness в проекте ещё не настроен (нет
 * `.harness/project.json`, политики или привязанного состояния). Вместо отказа
 * `harness view` отдаёт этап `setup` с простыми строками; панель перечитывает
 * представление, пока не придёт обзор.
 */
export const setupViewSchema = z.strictObject({
  viewVersion: z.literal(OPERATOR_VIEW_VERSION),
  viewRevision: count,
  generatedAt: isoTimeSchema,
  source: sourceSchema,
  stage: z.strictObject({
    name: z.literal('setup'),
    lines: z.array(z.string().min(1).max(T.line)).min(1).max(L.stageLines),
  }),
  setup: z.strictObject({ waitingFor: z.enum(['project', 'policy']) }),
});
export type SetupViewDocument = z.infer<typeof setupViewSchema>;

/** Ответ `harness view`: обзор, с `--work` — детали работы, до настройки — документ настройки. */
export const viewDataSchema = z.union([operatorViewSchema, workDetailViewSchema, setupViewSchema]);
