import { z } from 'zod';
import { decisionSettingsSchema } from './decisions.ts';
import { trackStepActors, trackStepKinds, trackStepStates } from './decision-rules.ts';
import { gitShaSchema, isoTimeSchema } from './primitives.ts';
import {
  OPERATOR_VIEW_LIMITS as L,
  OPERATOR_VIEW_TEXT as T,
  OPERATOR_VIEW_VERSION,
} from './operator-view-limits.ts';

import { resourcesViewSchema } from './view-resources.ts';
import { setupProgressSchema } from './setup-progress.ts';
import {
  OUTLINE_ACTORS,
  OUTLINE_LIMITS,
  OUTLINE_SIZES,
  OUTLINE_STAGE_KINDS,
} from './outline-weights.ts';

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
  /**
   * Раунды предмета: `used` — засчитанные в текущей эпохе (с 0.1.0-alpha.68),
   * `remaining` — до предела, `free` — повторные ревью неизменённого плана,
   * не тратившие предел (необязательные, ревизия 8).
   */
  rounds: z.strictObject({
    used: count,
    max: z.number().int().positive().nullable(),
    remaining: count.nullable().optional(),
    free: count.optional(),
  }),
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
  /** Ревизия 6: план работы ещё не согласован, попыток не было — «ещё не утверждена». */
  planned: z.literal(true).optional(),
  /**
   * Ревизия 6: доработка, отменённая прежней версией harness, показана
   * принятой работой (`done`, `resultSha` — прежняя приёмка); состояние не
   * переписано, его чинит `harness cancel`. `restoredLine` — «принято на
   * <sha>; доработка отменена».
   */
  restoredFrom: z.literal('cancelled-rework').optional(),
  restoredLine: z.string().min(1).max(T.line).optional(),
  /**
   * Ревизия 7 (alpha.67): работа инфраструктуры harness (`kind: infra`,
   * docs/infra-works.md) — мосты, обёртки gates, приёмочные тесты. Нет поля —
   * продуктовая работа.
   */
  kind: z.literal('infra').optional(),
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
            /**
             * Кто решает на шаге решения (`diagnosis`, `reset`,
             * `user-decision`) и на ожидании ведущего (удержанный gate):
             * сброс человеком — `user`, сброс ведущего — `lead`.
             */
            actor: z.enum(trackStepActors).optional(),
            /**
             * Ревизия 8: шаг разбора (`diagnosis`) обязателен — работу держит
             * правило восстановления (`DIAGNOSIS_REQUIRED`, исчерпание) —
             * или ведущий разбирает по желанию (`false`: повтор делает
             * harness сам). Только показ.
             */
            required: z.boolean().optional(),
          }),
        )
        .max(L.trackSteps),
      truncated: count.optional(),
    })
    .optional(),
  /**
   * Ревизия 8: работа переоткрыта новой редакцией плана после приёмки
   * (`work.reopened`), доработка ещё не принята и не оставлена. `by` — кто
   * согласовал редакцию, переоткрывшую работу (`agent` — ведущий,
   * `operator` — человек); не согласована — поля нет. `budget` — свой
   * предел попыток (`fresh`) или перенесённый (`carried`), `spent` —
   * засчитанные попытки принятой редакции, `reason` — фраза для карточки.
   */
  reopened: z
    .strictObject({
      at: isoTimeSchema,
      by: z.enum(['lead', 'operator']).optional(),
      revision: z.number().int().positive(),
      budget: z.enum(['fresh', 'carried']),
      acceptedSha: sha,
      spent: count,
      reason: z.string().min(1).max(T.line),
    })
    .optional(),
  /**
   * Ревизия 8: итог независимого ревью кандидата по попыткам (и ревью
   * интеграции, `phase`): последний применённый раунд попытки и фазы.
   * `invalid` — у попытки и фазы были только ответы не по протоколу или
   * небезопасные. `findings` — открытые blocking-находки раунда, `notes` —
   * прочие открытые. `earlier` — попытка прежней (принятой) редакции работы
   * до доработки. Сверх предела — самые ранние отброшены
   * (`truncated.attemptReviews`). Ревью кода ведущего (`reviews[kind=code]`)
   * сюда не входит.
   */
  attemptReviews: z
    .array(
      z.strictObject({
        attempt: z.number().int().positive(),
        phase: z.enum(['candidate', 'integration']),
        verdict: z.enum(['approved', 'rejected', 'invalid']),
        findings: count,
        notes: count,
        at: isoTimeSchema,
        earlier: z.literal(true).optional(),
      }),
    )
    .max(L.attemptReviews)
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

/**
 * Решения (ревизия 8 — harness выдаёт): кто, когда и что решил по записям
 * хранилища и журнала событий, новые сверху; виды и соответствие актёров —
 * docs/operator-view.md. Обязательные сочетания — design §3.9.
 */
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

/** alpha.68: заполнение части плана выпуска работами. */
const outlineFillSchema = z.enum(['registered', 'partial', 'unregistered']);

/**
 * alpha.68: план выпуска ведущего в прогнозе (`forecast.outline`) или
 * подсказка `RELEASE_OUTLINE_MISSING`, что его нет (`run` не блокируется).
 */
const forecastOutlineSchema = z.strictObject({
  state: z.enum(['recorded', 'missing']),
  code: z.literal('RELEASE_OUTLINE_MISSING').optional(),
  revision: z.number().int().positive().optional(),
  recordedAt: isoTimeSchema.optional(),
  units: count.optional(),
  registered: count.optional(),
  unregistered: count.optional(),
  beyond: z.number().int().positive().optional(),
  stages: z
    .array(
      z.strictObject({
        id,
        title: freeText(T.title).optional(),
        kind: z.enum(OUTLINE_STAGE_KINDS),
        state: outlineFillSchema,
        units: count,
        registered: count,
        percent: z.number().int().min(0).max(100),
        components: z
          .array(
            z.strictObject({
              id,
              title: freeText(T.title).optional(),
              size: z.enum(OUTLINE_SIZES).optional(),
              tasks: z.number().int().positive().optional(),
              actor: z.enum(OUTLINE_ACTORS),
              state: outlineFillSchema,
              units: count,
              registered: count,
              percent: z.number().int().min(0).max(100),
              works: z.array(id).max(OUTLINE_LIMITS.viewWorks).optional(),
            }),
          )
          .max(OUTLINE_LIMITS.componentsPerStage),
      }),
    )
    .max(OUTLINE_LIMITS.stages)
    .optional(),
  line: z.string().min(1).max(T.line),
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
          /**
           * alpha.68: этап идущей попытки к приёмке — доли попытки на начале
           * (`from`) и конце (`to`) этапа, начало этапа, типичная длительность.
           */
          stageProgress: z
            .strictObject({
              stage: z.enum(['code', 'checks', 'review', 'integration']),
              from: z.number().min(0).max(1),
              to: z.number().min(0).max(1),
              since: isoTimeSchema.optional(),
              typicalMs: count.optional(),
              samples: z.number().int().positive().optional(),
            })
            .optional(),
          line: z.string().min(1).max(T.line),
        }),
      )
      .max(L.forecastWorks)
      .optional(),
    /** alpha.68: последний рост плана — что добавлено, готовность без него и с ним. */
    growth: z
      .strictObject({
        at: isoTimeSchema,
        added: z.array(z.string().min(1).max(200)).max(10),
        before: z.number().int().min(0).max(100),
        after: z.number().int().min(0).max(100),
        by: z.enum(['works', 'outline']),
        reason: freeText(OUTLINE_LIMITS.reason).optional(),
        line: z.string().min(1).max(T.line),
      })
      .optional(),
    /** alpha.68: «если ведущий не добавит задач» — последний отрезок при открытой сессии ведущего. */
    conditional: z.literal(true).optional(),
    /** alpha.68: плана нет, все работы — инфраструктура: её доля выпуска (оценка). */
    infraShare: z
      .strictObject({
        share: z.number().min(0).max(1),
        line: z.string().min(1).max(T.line),
      })
      .optional(),
    /**
     * Ревизия 6: планируемые задачи (вес 0) — ещё не утверждённые; `line` —
     * «по утверждённому плану ~X %; с планируемыми (N задач, не утверждены: …) ~Y %».
     */
    planned: z
      .strictObject({
        count: z.number().int().positive(),
        keys: z.array(token(200)).max(L.forecastPlanned),
        line: z.string().min(1).max(T.line),
      })
      .optional(),
    /** Ревизия 6: только утверждённый план (есть вместе с `planned`). */
    approved: z
      .strictObject({
        percent: z.number().int().min(0).max(100),
        total: count,
        done: count,
        left: count,
        loMs: count.optional(),
        hiMs: count.optional(),
      })
      .optional(),
    /** Ревизия 6: шаги ведущего — 10 % выпуска поровну (`weight` — доля выпуска). */
    lead: z
      .strictObject({
        steps: z
          .array(
            z.strictObject({
              step: z.enum(['plan', 'questions', 'delivery', 'report']),
              weight: z.number().min(0).max(1),
              done: z.boolean(),
            }),
          )
          .max(4),
        weighted: z.number().min(0),
        total: z.number().min(0),
      })
      .optional(),
    /**
     * Ревизия 6: состояние выпуска — `in-work`, `code-accepted` (код принят,
     * итогового отчёта ведущего нет), `done` (`harness release done`).
     */
    release: z
      .strictObject({
        state: z.enum(['in-work', 'code-accepted', 'done']),
        doneAt: isoTimeSchema.optional(),
        summary: freeText(T.releaseSummary).optional(),
        line: z.string().min(1).max(T.line),
      })
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
    /** Ревизия 6: цепочка зависимостей незаконченных работ (доли задачи): нижняя граница не короче. */
    chain: z.number().min(0).optional(),
    /** Ревизия 6: работа ведущего — отдельной долей, по истории проекта. */
    lead: z
      .strictObject({
        ms: count,
        samples: z.number().int().positive(),
        line: z.string().min(1).max(T.line),
      })
      .optional(),
    humanWait: z.strictObject({ works: count, ms: count, since: isoTimeSchema.optional() }),
    /** alpha.68: незарегистрированные части плана выпуска — оценка по размеру. */
    outline: z
      .strictObject({
        units: count,
        ownerUnits: z.number().int().positive().optional(),
        loMs: count.optional(),
        hiMs: count.optional(),
        basis: z.enum(['attempts', 'default']),
        line: z.string().min(1).max(T.line),
      })
      .optional(),
    /** alpha.68: код принят, ведущий завершает — начало отрезка, сколько идёт, превышена ли его доля. */
    finishing: z
      .strictObject({
        since: isoTimeSchema.optional(),
        elapsedMs: count.optional(),
        exceeded: z.literal(true).optional(),
      })
      .optional(),
    line: z.string().min(1).max(T.line),
  }),
  /** alpha.68: план выпуска ведущего или подсказка, что его нет. */
  outline: forecastOutlineSchema.optional(),
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
      /**
       * Ревизия 7 (alpha.67): ход настройки на этапе `setup` — шаги с
       * состоянием и временем и мягкий бюджет (`setupProgressSchema`).
       */
      progress: setupProgressSchema.optional(),
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
  /**
   * Ревизия 6: планируемые задачи без работы harness — карточки «ещё не
   * утверждена» (ни попыток, ни действий). `from`: `validated` — в
   * проверенном несогласованном снимке связки, `read` — только в последнем
   * чтении источника.
   */
  planned: z
    .array(
      z.strictObject({
        id,
        connector: id,
        taskId: id,
        key: token(200).optional(),
        title: freeText(T.title).optional(),
        status: z.literal('planned'),
        from: z.enum(['validated', 'read']),
        graphId: id.optional(),
        dependsOn: z.array(id).max(L.dependsOn).optional(),
        line: z.string().min(1).max(T.line),
      }),
    )
    .max(L.planned)
    .optional(),
  /**
   * Ревизия 6: ведущий — сессия `harness lead begin|end` (аренда до
   * `until`), последняя заметка и журнал новыми сверху (заметки, команды
   * harness ведущего, итог выпуска).
   */
  lead: z
    .strictObject({
      active: z.boolean(),
      since: isoTimeSchema.optional(),
      until: isoTimeSchema.optional(),
      endedAt: isoTimeSchema.optional(),
      lastNote: z
        .strictObject({ at: isoTimeSchema, plain: z.string().min(1).max(T.activity) })
        .optional(),
      notes: z
        .array(
          z.strictObject({
            at: isoTimeSchema,
            kind: token(40),
            action: token(80),
            workId: id.optional(),
            plain: z.string().min(1).max(T.activity),
          }),
        )
        .max(L.leadNotes),
      line: z.string().min(1).max(T.line),
    })
    .optional(),
  /** Ревизия 6: что задействовано — модели и вендоры ролей, изоляция, toolchain, сервисы, проверки. */
  resources: resourcesViewSchema.optional(),
  /**
   * 0.1.0-alpha.66: живые превью результата (`harness preview-start`,
   * docs/previews.md) — адрес на loopback, что показано и срок. Панель
   * показывает «Посмотреть результат» и «остановить» (`harness preview-stop
   * --preview <id>`). Нет поля — ни одно превью не идёт.
   */
  previews: z
    .array(
      z.strictObject({
        id,
        repositoryId: id,
        title: freeText(T.title).optional(),
        url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}\/$/),
        ref: freeText(T.line),
        sha: gitShaSchema,
        workId: id.optional(),
        startedAt: isoTimeSchema,
        expiresAt: isoTimeSchema,
        state: z.enum(['running']),
      }),
    )
    .min(1)
    .max(L.previews)
    .optional(),
  truncated: z
    .strictObject({
      scope: truncatedCount.optional(),
      /** Ревизия 6: планируемые задачи сверх предела или опущенные по размеру. */
      planned: truncatedCount.optional(),
      /** Ревизия 6: записи журнала ведущего сверх `lead.notes`. */
      leadNotes: truncatedCount.optional(),
      /** Ревизия 6: раздел `resources` опущен по размеру (1). */
      resources: truncatedCount.optional(),
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
      /** Ревизия 8: записи `works[].attemptReviews` сверх предела, по всем работам. */
      attemptReviews: truncatedCount.optional(),
      /**
       * Работы, у которых документ сверх предела размера опустил поля
       * ревизии 4 (`attempts.lastFailure.kind`/`counted`, `blockers[].step`,
       * `question.line`; harness 0.1.0-alpha.61).
       */
      workFields: truncatedCount.optional(),
      /** Пункты `updates.whatsNew` сверх предела (harness 0.1.0-alpha.61). */
      whatsNew: truncatedCount.optional(),
      /** Живые превью сверх предела `previews` (harness 0.1.0-alpha.66). */
      previews: truncatedCount.optional(),
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
      /** Ревизия 8: записи `work.attemptReviews` сверх предела. */
      attemptReviews: truncatedCount.optional(),
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
    /** Ревизия 7 (alpha.67): ход настройки, как у обзора. */
    progress: setupProgressSchema.optional(),
  }),
  setup: z.strictObject({ waitingFor: z.enum(['project', 'policy']) }),
});
export type SetupViewDocument = z.infer<typeof setupViewSchema>;

/** Ответ `harness view`: обзор, с `--work` — детали работы, до настройки — документ настройки. */
export const viewDataSchema = z.union([operatorViewSchema, workDetailViewSchema, setupViewSchema]);
