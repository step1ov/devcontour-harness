import { z } from 'zod';
import { reviewPassesRecordSchema } from './review-passes.ts';
import { PROPOSAL_LIMITS, workProposalSchema, workResearchSchema } from './proposals.ts';
import { STATE_VERSION } from './version.ts';
import {
  digestSchema,
  gitShaSchema,
  idSchema,
  isoTimeSchema,
  relativePathSchema,
  runtimeNameSchema,
  trimmedText,
  gateScopeSchema,
} from './primitives.ts';
import { workGraphSchema, workOrderSchema } from './work.ts';
import { leadLogSchema } from './lead.ts';
import { releaseOutlineSchema, workSeenSchema } from './outline.ts';
import { contextPinSchema, contextSnapshotSchema } from './context.ts';
import { toolchainFactsSchema } from './toolchain.ts';
import {
  deliveryStateSchema,
  gateApplicabilitySchema,
  gateArtifactFilesSchema,
  jointActiveSchema,
  jointFailedSchema,
  jointPassedSchema,
  reusedEvidenceSchema,
} from './result.ts';
import {
  codeReviewDecisionSchema,
  findingStatuses,
  lateFindingSchema,
  reviewRecordSchema,
  reviewRoundSchema,
} from './review.ts';
import { contractDocumentSchema, spikeSchema } from './checks.ts';
import { codeReviewRecordSchema } from './code-review.ts';
import {
  INPUT_LIMITS,
  inputPolicySchema,
  inputRequestSchema,
  recordedAssumptionSchema,
} from './input.ts';

/**
 * Нейтральная модель исполнения — то, что ExecutionStore обязан хранить
 * транзакционно. Формы совпадают с записями задач и попыток DevContour
 * (`Task`/`Run`/`Evidence`): адаптер DevContour отображает их без
 * переименования сохранённых данных (docs/compatibility.md), standalone
 * SQLite хранит ровно эту модель. Схемы нестрогие к *отсутствию*
 * необязательных полей (прежние записи их не содержат), но строгие к их
 * форме и к лишним полям.
 *
 * Продуктовых сущностей (доски, релизы, INTENT, продуктовые согласования)
 * здесь нет: движок их не читает.
 */
export const workStatuses = [
  'draft',
  'ready',
  'running',
  'verifying',
  'reviewing',
  'integrating',
  'done',
  'failed',
  'cancelled',
] as const;
export const workStatusSchema = z.enum(workStatuses);
export type WorkStatus = (typeof workStatuses)[number];

export const failureKinds = [
  'provider-auth',
  'environment',
  'timeout',
  /**
   * Процесс попытки жив, но дольше порога политики (`stallSweep.stalledMs`)
   * не выводил, не расходовал процессор и не закрывал стадий: обход
   * controller остановил его. Действие — повтор или правка среды, не кода.
   */
  'stalled',
  /**
   * Исполнителю не хватило окна контекста модели внутри попытки: runtime
   * сам сообщил, что запрос больше окна (claude: `terminal_reason`
   * `prompt_too_long` или `blocking_limit`). Успешное автоматическое сжатие
   * контекста отказом не является. Попытка засчитывается: задача не
   * помещается в попытку — её нужно разделить или сократить контекст.
   */
  'context-exhausted',
  'stale-base',
  'empty-result',
  /** Исполнитель сообщил `completed: false`: работа не доделана, черновик сохранён. */
  'unfinished',
  'scope-violation',
  'gate',
  'review',
  /** Ответ reviewer нарушил протокол ревью и разрешённые повторы reviewer исчерпаны. */
  'review-protocol',
  'merge',
  'cancelled',
  'budget',
  /**
   * Исполнитель не изменил ни файла, а основания считать работу уже
   * сделанной механически нет: решение — за ведущим, не повтор.
   */
  'needs-lead',
  /**
   * Исполнитель остановился с вопросом, серьёзность которого не ниже порога
   * закреплённой `inputPolicy`: запрос записан в `input-requests` той же
   * транзакцией, черновик сохранён. Попытка засчитана; автоматического
   * повтора нет — продолжение только после ответа и `applyInput`.
   */
  'needs-input',
  'unknown',
] as const;
export const failureKindSchema = z.enum(failureKinds);
export type FailureKind = (typeof failureKinds)[number];

/**
 * Какой предел окна контекста сообщил runtime у отказа `context-exhausted`:
 * `prompt-too-long` — запрос отклонён (claude `terminal_reason:
 * prompt_too_long`, уже одна реплика больше окна; повтор только удлинит
 * подсказку), `blocking-limit` — ход остановлен у предела окна (claude
 * `blocking_limit`).
 */
export const contextLimits = ['prompt-too-long', 'blocking-limit'] as const;
export const contextLimitSchema = z.enum(contextLimits);
export type ContextLimit = (typeof contextLimits)[number];

/**
 * Причины отказа окружения, при которых повтор даст тот же отказ
 * (0.1.0-alpha.66): `sandbox-process-list` — gate запускает `ps`, а
 * песочница ОС проверок его не даёт; `sandbox-signal` — gate шлёт сигнал
 * процессу вне песочницы (`kill EPERM`), `sandbox-browser` — gate запускает
 * браузер, который в песочнице не стартует (0.1.0-alpha.68); `gate-definition`
 * — gate упал, не назвав причины (ни упавших тестов, ни строки ошибки: обёртка
 * скрыла вывод), и это правка команды gate, а не кода задачи
 * (0.1.0-alpha.69). Попытка их не засчитывает, автоматического повтора нет:
 * ход ведущего — поменять gate или команду.
 */
export const noRetryEnvironmentCauses = [
  'sandbox-process-list',
  'sandbox-signal',
  'sandbox-browser',
  'gate-definition',
] as const;
export type NoRetryEnvironmentCause = (typeof noRetryEnvironmentCauses)[number];
/** Код отказа gate, с которого начинается сводка evidence отказа без повтора. */
export const NO_RETRY_GATE_CODES: Record<NoRetryEnvironmentCause, string> = {
  'sandbox-process-list': 'GATE_SANDBOX_PROCESS_LIST',
  'sandbox-signal': 'GATE_SANDBOX_SIGNAL',
  'sandbox-browser': 'GATE_SANDBOX_BROWSER',
  'gate-definition': 'GATE_DEFINITION_NO_CAUSE',
};

/**
 * Живость исполняющейся попытки по периодическому обходу controller
 * (`stallSweep` политики): `active` — движение было недавно, `quiet` — нет
 * движения дольше `quietMs`, `stalled` — дольше `stalledMs`. Движение —
 * вывод процесса, начало или конец его команды, граница стадии
 * (`attempt.stage`), заметный расход процессора деревом процессов.
 */
export const livenessStates = ['active', 'quiet', 'stalled'] as const;
export const livenessStateSchema = z.enum(livenessStates);
export type LivenessState = (typeof livenessStates)[number];
/** Что исполняется: вызов агента, gate, шаг среды или прочая команда попытки. */
export const activitySchema = z.strictObject({
  kind: z.enum(['agent', 'gate', 'step', 'command']),
  label: z.string().min(1).max(300),
});
export type Activity = z.infer<typeof activitySchema>;
/** Действие controller на `stalled`: остановить процесс или только сообщить. */
export const stallActionSchema = z.enum(['stop', 'report']);
/** Последнее состояние живости попытки; пишется только на переходах. */
export const attemptLivenessSchema = z.strictObject({
  state: livenessStateSchema,
  /** Время обхода, на котором состояние стало текущим. */
  at: isoTimeSchema,
  /** Последнее замеченное движение. */
  lastMovementAt: isoTimeSchema,
  /** Последняя начатая из исполняющихся команд; нет — команды не идут. */
  activity: activitySchema.optional(),
  /** Только у `stalled`: что controller сделал по политике. */
  action: stallActionSchema.optional(),
  /** Только у `stalled`: файл снимка процессов и хвоста вывода. */
  artifact: z.string().max(1000).optional(),
});
export type AttemptLiveness = z.infer<typeof attemptLivenessSchema>;

/** Значение из отчёта проверки или ответа reviewer: произвольный JSON, сохраняется как есть. */
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

/* ------------------------------------------------------------------ */
/* Согласование                                                        */
/* ------------------------------------------------------------------ */

/** Техническое согласование, привязанное к digest проверенного предложения. */
export const technicalApprovalSchema = z.strictObject({
  actor: z.enum(['operator', 'agent']),
  authorRuntime: runtimeNameSchema.optional(),
  reviewerRuntime: runtimeNameSchema.optional(),
  /** Ссылка на сохранённый ответ reviewer. */
  artifact: z.string().max(1000).optional(),
  digest: digestSchema.optional(),
  /**
   * Снимок контекста, который видел reviewer согласованного плана (`null` —
   * без контекста). Есть, когда хост связывает согласование с контекстом:
   * исполняется и принимается только этот снимок.
   */
  context: z.strictObject({ digest: digestSchema.nullable() }).optional(),
  /**
   * Повторное согласование после правки политики (`harness reapprove`): кто и
   * почему, раунд ревью, на котором оно держится, и прежний `policyDigest`.
   */
  reapproval: z
    .strictObject({
      by: z.string().min(1).max(200),
      reason: z.string().min(1).max(2000),
      round: z.number().int().positive(),
      previousPolicyDigest: digestSchema,
    })
    .optional(),
});
export type TechnicalApproval = z.infer<typeof technicalApprovalSchema>;

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

/** Отчёт генеративной проверки (`version: 1`), форма — как у DevContour. */
export const propertyReportSchema = z.object({
  version: z.literal(1),
  seed: z.number().int().min(0).optional(),
  properties: z
    .array(
      z.object({
        testId: z.string().min(1).max(200),
        status: z.enum(['passed', 'failed', 'running']),
        cases: z.number().int().min(0),
        families: z.record(z.string().min(1).max(80), z.number().int().min(0)).optional(),
        error: z.string().max(500).optional(),
        current: jsonValue.optional(),
        counterexample: z
          .object({
            original: jsonValue,
            reduced: jsonValue.optional(),
            expected: jsonValue.optional(),
            actual: jsonValue.optional(),
            reductionTimedOut: z.boolean().optional(),
            case: z.string().min(1).max(200).optional(),
          })
          .optional(),
      }),
    )
    .max(100),
  corpus: z
    .object({
      digest: digestSchema,
      executed: z.number().int().min(0),
      passed: z.number().int().min(0),
      witness: digestSchema,
      failed: z
        .array(
          z.object({
            id: z.string().min(1).max(200),
            property: z.string().min(1).max(200),
            expected: jsonValue.optional(),
            actual: jsonValue.optional(),
          }),
        )
        .max(20),
    })
    .optional(),
});
export type PropertyReport = z.infer<typeof propertyReportSchema>;

/** Доказательство генеративной проверки: seed, отчёт, версии договора и уровень. */
export const propertyEvidenceSchema = z.strictObject({
  seed: z.number().int().min(0),
  reproduce: z.string().max(4000),
  report: propertyReportSchema.optional(),
  problem: z.string().max(4000).optional(),
  contracts: z.record(idSchema, digestSchema),
  artifacts: z.array(z.strictObject({ path: relativePathSchema, blob: gitShaSchema })),
  level: z.enum(['manifest', 'legacy']).optional(),
  manifest: z
    .strictObject({
      digest: digestSchema,
      properties: z.array(z.string().min(1).max(200)),
      corpus: z.strictObject({ digest: digestSchema, cases: z.number().int().min(0) }).optional(),
    })
    .optional(),
  coverage: z.array(z.string().max(1000)).optional(),
});

/** Происхождение подтверждённой команды: событие runtime или запуск probe controller. */
export const inspectionOriginSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('runtime'),
    /** Имя runtime reviewer (`codex`, `claude`, …). */
    runtime: z.string().min(1).max(100),
    /** ID item в потоке событий runtime; `null` — runtime его не дал. */
    item: z.string().min(1).max(200).nullable(),
  }),
  z.strictObject({
    type: z.literal('controller'),
    /** runId запуска probe в журнале controller (не runId попытки). */
    runId: z.string().min(1).max(200),
  }),
]);

/**
 * Что reviewer действительно выполнил — по событиям runtime и журналу
 * проверок controller одного вызова reviewer, не по словам модели
 * (docs/review-probes.md). Поля после `reason` появились в alpha.7 и
 * необязательны: записи прежних версий читаются как есть.
 */
export const reviewInspectionSchema = z.strictObject({
  mode: z.enum(['commands', 'diff-only']),
  source: z.enum(['codex-events', 'unavailable', 'controller-probes', 'runtime-and-controller']),
  commands: z.array(
    z.strictObject({
      command: z.string(),
      /** `null` — код неизвестен: таймаут/отмена после старта, старая проекция без кода. */
      exitCode: z.number().int().nullable(),
      output: z.string(),
      origins: z.array(inspectionOriginSchema).min(1).max(8).optional(),
      /** Исход: `completed`/`failed` — runtime; остальные — статус probe controller. */
      status: z.enum(['completed', 'passed', 'failed', 'timeout', 'cancelled', 'error']).optional(),
      /** Неуспех не в проверяемом коде: среда или отчёт (как у probe). */
      failure: z.enum(['environment', 'report']).optional(),
      /** ID объявленного gate, запущенного через probe. */
      gate: z.string().min(1).max(200).optional(),
      note: z.string().max(2000).optional(),
    }),
  ),
  reason: z.string().nullable(),
  /** Вызов reviewer, которому принадлежит итог. */
  context: z
    .strictObject({
      /** ID попытки harness (runId evidence). */
      attempt: z.string().min(1).max(200),
      phase: z.enum(['candidate', 'integration']),
      sha: gitShaSchema,
      call: z.number().int().positive(),
    })
    .optional(),
  /** Число всех подтверждённых операций, в том числе не вошедших в `commands`. */
  total: z.number().int().min(0).optional(),
  /** Записи журнала, не засчитанные выполнением: почему (не более 100). */
  excluded: z
    .array(
      z.strictObject({
        runId: z.string().min(1).max(200),
        status: z.string().max(40).nullable(),
        reason: z.enum([
          'not-started',
          'legacy-unconfirmed',
          'foreign-scope',
          'unknown-status',
          'unfinished',
          'abandoned',
        ]),
      }),
    )
    .max(100)
    .optional(),
  excludedTotal: z.number().int().min(0).optional(),
  /** Строки журнала без формы исхода (битый JSON, `{}`): не запуски. */
  invalid: z.number().int().min(0).optional(),
});

export const evidenceFindingSchema = z.strictObject({
  severity: z.string().min(1).max(40),
  message: z.string().max(12000),
  path: z.string().max(500).nullable().optional(),
  line: z.number().int().positive().nullable().optional(),
  /** ID находки, выданный controller (раунды протокола `reviewRound`); нет у прежних записей. */
  id: digestSchema.optional(),
  /** Статус находки на момент раунда. */
  status: z.enum(findingStatuses).optional(),
  /** Новая blocking-находка на пути без изменений с прошлого раунда фазы (docs/review-protocol.md §10). */
  late: lateFindingSchema.optional(),
});

/**
 * Безопасная выжимка провала gate (0.1.0-alpha.68): имена упавших тестов
 * (отчёт JUnit gate, вывод spec/TAP или JUnit-файлы, которые команда пишет
 * сама), первая строка утверждения или ошибки и хвост вывода — всё с маской
 * секретов и в пределах. `withheld` — gate не назвал ни теста, ни ошибки
 * (вывод скрыт обёрткой): gate должен печатать выжимку сам.
 */
export const gateFailureSummarySchema = z.strictObject({
  tests: z.array(z.string().min(1).max(200)).max(20).optional(),
  testsTruncated: z.literal(true).optional(),
  assertion: z.string().min(1).max(300).optional(),
  tail: z.string().min(1).max(1200).optional(),
  /** Откуда имена тестов: отчёт gate, вывод команды или её собственный отчёт. */
  source: z.enum(['junit', 'output', 'command-report']).optional(),
  withheld: z.literal(true).optional(),
  /**
   * Провал объяснён только тем, что gate менял состояние git под границей
   * записи (`GATE_GIT_WRITE`, 0.1.0-alpha.70): других признаков провала
   * (упавших тестов, утверждения, сигнала) нет. По этой отметке, а не по
   * тексту, итог на базе удерживает gate.
   */
  gitWrite: z.literal(true).optional(),
});
export type GateFailureSummary = z.infer<typeof gateFailureSummarySchema>;

export const evidenceRecordSchema = z.strictObject({
  id: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  /**
   * `not-applicable` — gate с `when.paths` не исполнялся: diff фазы его не
   * задел (`notApplicable`). Такая запись всегда `passed: false` и не PASS.
   */
  kind: z.enum(['test', 'review', 'not-applicable']),
  phase: z.enum(['candidate', 'integration']),
  sha: gitShaSchema,
  /** ID gate; для ревью — `independent-review`. */
  gate: z.string().min(1).max(200),
  passed: z.boolean(),
  createdAt: isoTimeSchema,
  command: z.array(z.string()),
  exitCode: z.number().int(),
  log: z.string(),
  digest: digestSchema,
  summary: z.string(),
  /** Проверка потребителя: компонент, в дереве которого она выполнена. */
  consumer: idSchema.optional(),
  /**
   * Повтор провала gate на том же SHA — интеграции (провал при зелёном
   * кандидате) или кандидата (таймаут под высокой нагрузкой хоста), не больше
   * одного на фазу попытки: `of` — ID повторённой записи; `flaky` — повтор
   * прошёл (первый провал вызван средой), `confirmed` — провал подтвердился.
   * Исключение — интеграция: повтор, упавший только кодом выхода исполнителя
   * тестов (`crashedRecheck`), получает ещё один запуск с тем же `of`.
   */
  recheck: z
    .strictObject({
      of: z.string().min(1).max(200),
      outcome: z.enum(['flaky', 'confirmed']),
    })
    .optional(),
  inspection: reviewInspectionSchema.optional(),
  findings: z.array(evidenceFindingSchema).optional(),
  /** Раунд ревью кода: область истории, вызов, протокол, переходы (docs/review-protocol.md). */
  reviewRound: reviewRoundSchema.optional(),
  /** Второй проход ревью (0.1.0-alpha.70): режим, итог, снятые находки с основанием. */
  reviewPasses: reviewPassesRecordSchema.optional(),
  tests: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        status: z.enum(['passed', 'failed', 'skipped']),
        opaque: z.literal(true).optional(),
      }),
    )
    .optional(),
  testsTruncated: z.boolean().optional(),
  property: propertyEvidenceSchema.optional(),
  /** Копии `gate.artifacts` (нет у прежних записей и у gate без поля). */
  artifactFiles: gateArtifactFilesSchema.optional(),
  /** Действующая версия проверок, под которой получено evidence. */
  checks: digestSchema.optional(),
  /**
   * Основание исполнения gate с `when` (`gateBasis`: определение, ресурсы,
   * окружение, подготовка, изоляция, версия harness) у собственной записи
   * `test` попытки: по нему ищется последний зелёный SHA gate. Нет у gates
   * без `when` и у прежних записей.
   */
  gateBasis: digestSchema.optional(),
  /**
   * SHA-256 JUnit-отчёта (`<gate>.xml` рядом с логом), сохранённого этим
   * запуском gate: по нему следующая попытка берёт текст провала только из
   * отчёта той же записи. Нет у gate без отчёта и у прежних записей.
   */
  reportDigest: digestSchema.optional(),
  /**
   * Выжимка провала (0.1.0-alpha.68, `gateFailureSummarySchema`): только у
   * непройденной записи `test`, чей провал назвала команда (код выхода или
   * упавшие testcases). Нет у прежних записей.
   */
  failureSummary: gateFailureSummarySchema.optional(),
  /**
   * Фактический toolchain процесса проверки (первый `node` в PATH окружения
   * фазы, его версия; `pnpm` при наличии). Нет у прежних записей и у ревью.
   */
  toolchain: toolchainFactsSchema.optional(),
  /** Только у записи `not-applicable`: правило и diff, по которым gate не исполнялся. */
  notApplicable: gateApplicabilitySchema.optional(),
  /**
   * Запись `test` интеграции, взятая из записи кандидата той же попытки
   * (`integrationReuse: 'identical-tree'`): дерево integration SHA совпало с
   * деревом кандидата, gate на интеграции не исполнялся. Не путать с
   * `AttemptState.reusedFrom` (кандидат прежней попытки).
   */
  reusedEvidence: reusedEvidenceSchema.optional(),
  /**
   * Ревью попытки без изменений подтвердило, что приёмка уже выполнена на
   * базе: gates, на которые сослался reviewer, и его основание.
   */
  alreadySatisfied: z
    .strictObject({
      gates: gateScopeSchema(z.string().min(1).max(200)).min(1),
      evidence: z.string().min(1).max(4000),
      /** Механическое основание, найденное controller (`alreadySatisfiedVerdict`). */
      basis: z
        .discriminatedUnion('kind', [
          z.strictObject({
            kind: z.literal('contract'),
            gates: z.array(z.string().min(1).max(200)).min(1).max(30),
          }),
          z.strictObject({
            kind: z.literal('dependency'),
            workId: idSchema,
            /** Кандидат зависимости, изменивший область записи. */
            sha: gitShaSchema,
            paths: z.array(z.string().min(1).max(1000)).min(1).max(50),
          }),
        ])
        .optional(),
    })
    .optional(),
});
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

/* ------------------------------------------------------------------ */
/* Попытка                                                             */
/* ------------------------------------------------------------------ */

const artifactPinSchema = z.strictObject({ path: relativePathSchema, digest: digestSchema });

/** Снимок зависимости, против которого шла попытка. */
export const dependencySnapshotSchema = z.strictObject({
  repositoryId: idSchema,
  sha: gitShaSchema,
  tree: gitShaSchema,
  path: z.string().min(1),
  artifacts: z.array(artifactPinSchema),
});

/** Свежесть входа на момент окончания проверки: снимок против головы ветки. */
export const freshnessSchema = z.strictObject({
  repositoryId: idSchema,
  snapshot: gitShaSchema,
  head: gitShaSchema,
  fresh: z.boolean(),
});

/** Что проверено у потребителя: его голова и снимок всех его зависимостей. */
export const consumerCheckedSchema = z.strictObject({
  sha: gitShaSchema,
  tree: gitShaSchema,
  dependencies: z.array(
    z.strictObject({
      repositoryId: idSchema,
      sha: gitShaSchema,
      tree: gitShaSchema,
      artifacts: z.array(artifactPinSchema),
    }),
  ),
  freshness: z.array(freshnessSchema).optional(),
  observedAt: isoTimeSchema.optional(),
});

export const attemptConsumerSchema = z.strictObject({
  repositoryId: idSchema,
  gates: z.array(idSchema),
  checked: consumerCheckedSchema.optional(),
});

const checkVersionSchema = z.strictObject({
  suite: z.string().min(1).max(200),
  number: z.number().int().min(0),
  digest: digestSchema,
});

/** Незавершённая реализация, оборванная по времени: черновик, не кандидат. */
export const partialDraftSchema = z.strictObject({
  patch: z.string(),
  digest: digestSchema,
  files: z.array(z.string()),
  spec: digestSchema,
  contracts: z.record(idSchema, digestSchema),
});

export const continuationSchema = z.strictObject({
  runId: z.string().min(1).max(200),
  kind: z.enum(['unfinished', 'candidate']),
  reason: failureKindSchema.optional(),
  respecified: z.boolean().optional(),
  applied: z.boolean(),
  files: z.array(z.string()),
});

export const resourceSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(['device', 'port', 'account', 'service']),
  value: trimmedText(1, 300),
});

/**
 * Попытка. Поля и смысл — как у `Run` DevContour; `workId` соответствует
 * `taskId`. `token` — fencing-токен владения: он хранится только здесь и
 * никогда не попадает в события, результат и логи.
 */
export const attemptStateSchema = z.strictObject({
  id: z.string().min(1).max(200),
  workId: idSchema,
  repositoryId: idSchema,
  attempt: z.number().int().positive(),
  token: z.string().min(16).max(200),
  owner: z.string().min(1).max(300),
  runtime: runtimeNameSchema,
  reviewer: runtimeNameSchema,
  model: z.string().optional(),
  reviewerModel: z.string().optional(),
  effort: z.string().optional(),
  reviewerEffort: z.string().optional(),
  policyDigest: digestSchema,
  status: z.enum(['active', 'succeeded', 'failed', 'cancelled', 'expired']),
  phase: workStatusSchema,
  startedAt: isoTimeSchema,
  finishedAt: isoTimeSchema.optional(),
  /** Срок владения, epoch ms. */
  leaseUntil: z.number().int().min(0),
  worktree: z.string().optional(),
  baseSha: gitShaSchema.optional(),
  candidateSha: gitShaSchema.optional(),
  integrationSha: gitShaSchema.optional(),
  error: z.string().optional(),
  /** Отказ окружения: исполнителю не дали работать, попытка не засчитана. */
  blocked: z.boolean().optional(),
  /**
   * Исполнитель остановился, назвав причиной окружение (`needs-lead` с
   * причиной `writer-environment`): попытка не засчитана, тратится предел
   * незасчитанных отказов; повтора без ведущего нет.
   */
  writerBlocked: z.literal(true).optional(),
  /**
   * Исполнитель в начале попытки предложил разделить работу (0.1.0-alpha.70,
   * `needs-lead` с причиной `writer-split`): ID предложения. Попытка не
   * засчитана (тратится предел незасчитанных отказов); решает ведущий.
   */
  writerSplit: z
    .string()
    .regex(/^P-[0-9a-f]{12}$/)
    .optional(),
  /** Итог исполнителя незавершённой попытки своими словами (до 500 знаков). */
  writerSummary: z.string().max(500).optional(),
  failureKind: failureKindSchema.optional(),
  /** Предел окна контекста — только у отказа `context-exhausted`. */
  contextLimit: contextLimitSchema.optional(),
  /**
   * Причина отказа окружения без повтора (`noRetryEnvironmentCauses`,
   * 0.1.0-alpha.66) — только у отказа `environment` с такой причиной.
   */
  environmentCause: z.enum(noRetryEnvironmentCauses).optional(),
  failureFingerprint: z.string().optional(),
  /** Gates, которые попытка обязана пройти в обеих фазах (раскрытая область). */
  requiredGates: z.array(idSchema).optional(),
  consumers: z.array(attemptConsumerSchema).optional(),
  /** Версия проверок, закреплённая при claim. */
  checks: z
    .strictObject({ effective: digestSchema, corpus: checkVersionSchema.optional() })
    .optional(),
  /** Закреплённые источники контекста; содержимое — в снимке по `ContextSnapshot` digest. */
  context: z.array(contextPinSchema).optional(),
  /** Digest полного ContextSnapshot попытки; нет у попыток прежних версий. */
  contextSnapshot: digestSchema.optional(),
  resources: z.array(resourceSchema).optional(),
  dependencies: z.array(dependencySnapshotSchema).optional(),
  dependencyFreshness: z.array(freshnessSchema).optional(),
  properties: z.array(z.string()).optional(),
  unboundProperties: z.array(z.string()).optional(),
  /**
   * Попытку прервала штатная остановка controller: работа не исполнена до
   * конца, но и не отклонена — поручение вернулось в очередь, следующая
   * попытка продолжает с её кандидата или черновика.
   */
  interrupted: z.literal('shutdown').optional(),
  /** Классы входов, названные отклонившим ревью (`reproduction.inputClass`). */
  inputClasses: z.array(z.string().max(500)).max(20).optional(),
  /**
   * Пары «необъявленное свойство или критерий — класс входов» блокирующих
   * находок отклонившего ревью: по ним `acceptanceGap` узнаёт один и тот же
   * дефект в разных попытках.
   */
  classified: z
    .array(z.strictObject({ property: z.string().max(200), inputClass: z.string().max(500) }))
    .max(20)
    .optional(),
  episodeBasis: digestSchema.optional(),
  implementationBasis: digestSchema.optional(),
  reusedFrom: z
    .strictObject({ runId: z.string().min(1).max(200), candidateSha: gitShaSchema })
    .optional(),
  partial: partialDraftSchema.optional(),
  continuedFrom: continuationSchema.optional(),
  /**
   * Политика вопросов исполнителя, закреплённая при выдаче: смена порога
   * действует со следующей попытки. Нет у попыток прежних версий.
   */
  inputPolicy: inputPolicySchema.optional(),
  /** Развилки, решённые исполнителем, с оценкой controller (не больше 20). */
  assumptions: z.array(recordedAssumptionSchema).max(INPUT_LIMITS.assumptions).optional(),
  /**
   * Ответ на вопрос, с которым выдана попытка: запрос, точный ответ и
   * основание продолжения. Связывается при claim, только если применённое
   * основание совпало с основанием выдачи.
   */
  input: z
    .strictObject({
      requestId: z.string().min(1).max(200),
      answerDigest: digestSchema,
      targetDigest: digestSchema,
    })
    .optional(),
  callsRecorded: z.literal(true).optional(),
  dispatch: z
    .strictObject({
      policy: z.literal('fifo-ready-v1'),
      at: isoTimeSchema,
      eligible: z.array(
        z.strictObject({
          taskId: idSchema,
          repositoryId: idSchema.optional(),
          attempt: z.number().int().min(0),
        }),
      ),
      activeCount: z.number().int().min(0),
      concurrency: z.number().int().positive(),
      inputDigest: digestSchema,
    })
    .optional(),
  wait: z
    .strictObject({ approvedAt: isoTimeSchema.optional(), readyAt: isoTimeSchema.optional() })
    .optional(),
  /** Живость исполняющейся попытки (обход controller); нет — обход её не оценивал. */
  liveness: attemptLivenessSchema.optional(),
  timings: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        stage: z.string().min(1),
        startedAt: isoTimeSchema,
        finishedAt: isoTimeSchema.optional(),
        outcome: z.enum(['passed', 'failed']).optional(),
        /** Стадия прошла, но её средство не применялось: хранилище зависимостей без seed. */
        unused: z.literal(true).optional(),
      }),
    )
    .optional(),
  /**
   * Основания, под которыми выдана попытка: graph и поручение (digest),
   * target ref, редакция источника. Результат попытки строится из них, а не
   * из текущего графа: новая редакция не переписывает завершённую историю.
   */
  pinned: z
    .strictObject({
      graphId: idSchema,
      graphDigest: digestSchema,
      orderDigest: digestSchema,
      targetRef: z.string().min(1),
      source: z.strictObject({
        connector: idSchema,
        ref: z.string().min(1).max(300),
        revision: z.string().min(1).max(200),
      }),
      /**
       * Действующий снимок контекста на момент выдачи (`null` — без
       * контекста): runner загружает именно его. Нет — хост не связывает
       * согласование с контекстом (или попытка прежней версии).
       */
      contextDigest: digestSchema.nullable().optional(),
    })
    .optional(),
  /**
   * Версия движка, ведущего попытку: выдавшего её или принявшего владение при
   * recovery (`adopt`). Только он продолжает попытку. Входит в основание reuse
   * и recovery. Нет у прежних попыток.
   */
  engineVersion: z.string().min(1).optional(),
  /** Версия потребителя, через который выдана попытка; не заменяет engineVersion. */
  consumerVersion: z.string().min(1).optional(),
  evidence: z.array(evidenceRecordSchema),
});
export type AttemptState = z.infer<typeof attemptStateSchema>;

/* ------------------------------------------------------------------ */
/* Поручение в исполнении                                              */
/* ------------------------------------------------------------------ */

export const recoveryActions = [
  'add-cases',
  'new-approach',
  'strengthen-checker',
  'split-task',
  'clarify-obligation',
  'environment',
] as const;

export const recoveryDecisionSchema = z.strictObject({
  action: z.enum(recoveryActions),
  reason: z.string().max(4000),
  evidence: z.array(z.string().max(4000)),
  hypothesis: z.string().max(4000).optional(),
  plan: z.string().max(8000).optional(),
  cases: z
    .array(z.strictObject({ input: z.string(), expected: z.string().nullable().optional() }))
    .optional(),
  proposal: z.string().max(8000).optional(),
  conflict: z.string().max(4000).optional(),
  source: z.strictObject({
    kind: z.enum(['lead', 'operator']),
    runtime: z.string().optional(),
    model: z.string().optional(),
  }),
  decidedAt: isoTimeSchema,
});

/** Эпизод повторяющихся отказов по свойству (`version` — CAS ручного решения). */
export const propertyRecoverySchema = z.strictObject({
  id: z.string().min(1).max(200),
  property: z.string().min(1).max(200),
  basis: digestSchema,
  runs: z.array(z.string()),
  openedAt: isoTimeSchema,
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
  calls: z.number().int().min(0),
  decision: recoveryDecisionSchema.optional(),
  retryRun: z.string().optional(),
  reason: z.string().optional(),
  history: z.array(
    z.strictObject({ at: isoTimeSchema, event: z.string(), detail: z.string().optional() }),
  ),
  version: z.number().int().min(1),
});
export type PropertyRecovery = z.infer<typeof propertyRecoverySchema>;

/**
 * Причина повторных отказов по диагностике ведущего (`harness diagnose`):
 * слабое покрытие — добавить случаи или усилить проверку; неверный подход —
 * новая проверяемая гипотеза исполнителю; задача велика — разделить её с
 * ревью плана; противоречивое обещание — вопрос человеку; окружение;
 * другое. Технические (`coverage`, `approach`, `other` с гипотезой) ведущий
 * решает сам в пределах бюджета (docs/principles.md).
 */
export const leadDiagnosisCauses = [
  'coverage',
  'approach',
  'split',
  'contradiction',
  'environment',
  'other',
] as const;
export type LeadDiagnosisCause = (typeof leadDiagnosisCauses)[number];

/** Пределы диагностик и сбросов поручения (`WorkState.leadRecovery`). */
export const LEAD_RECOVERY_LIMIT = 20;

export const leadDiagnosisSchema = z.strictObject({
  /** `D<n>` — номер диагностики поручения (n растёт и после усечения списка). */
  id: z.string().regex(/^D[1-9][0-9]{0,5}$/),
  cause: z.enum(leadDiagnosisCauses),
  hypothesis: z.string().min(1).max(2000).optional(),
  evidence: z.array(z.string().min(1).max(1000)).max(10),
  /** Засчитанные отказы (ID попыток), которые она разбирает. */
  failures: z.array(z.string().min(1)).min(1).max(20),
  by: z.literal('lead'),
  at: isoTimeSchema,
  /** Согласованная постановка на момент диагностики: `split` ждёт другую. */
  approvedDigest: digestSchema.optional(),
  /** Предел попыток (`rework.budgets`), к которому она относится. */
  epoch: z.number().int().min(0),
  /** Человек решил по ней (сброс оператора): удержание снято. */
  resolved: z.strictObject({ by: z.literal('operator'), at: isoTimeSchema }).optional(),
  /**
   * Дополнения ведущего к этому разбору (`harness diagnose --addendum`,
   * 0.1.0-alpha.68): вторая причина или заметка к тому же засчитанному
   * отказу — следующая попытка получает их вместе с разбором. Причину,
   * гипотезу, счёт разборов и право на сброс дополнение не меняет.
   */
  addenda: z
    .array(
      z.strictObject({
        at: isoTimeSchema,
        text: z.string().min(1).max(2000),
        evidence: z.array(z.string().min(1).max(1000)).max(10),
      }),
    )
    .max(5)
    .optional(),
});
export type LeadDiagnosis = z.infer<typeof leadDiagnosisSchema>;

export const leadResetSchema = z.strictObject({
  by: z.enum(['lead', 'operator']),
  at: isoTimeSchema,
  /** Диагностика, по которой ведущий дал предел; у сброса оператора — нет. */
  diagnosis: z.string().optional(),
  epoch: z.number().int().min(0),
  /** Засчитанные попытки, потраченные до сброса. */
  spent: z.number().int().min(0),
  /** Сколько попыток дал сброс (`maxAttempts`). */
  granted: z.number().int().min(1),
  /** Номер сброса ведущего в пределе (`K из M`); у сброса оператора — нет. */
  index: z.number().int().min(1).optional(),
  cap: z.number().int().min(0).optional(),
  /** Отказы, которые сброс покрыл (решение человека или ведущего по ним). */
  failures: z.array(z.string().min(1)).max(20),
});
export type LeadReset = z.infer<typeof leadResetSchema>;

export const leadRecoverySchema = z.strictObject({
  diagnoses: z.array(leadDiagnosisSchema).max(LEAD_RECOVERY_LIMIT),
  resets: z.array(leadResetSchema).max(LEAD_RECOVERY_LIMIT),
  /** Номер последней диагностики (ID следующей — `D<seq+1>`). */
  seq: z.number().int().min(0),
});
export type LeadRecovery = z.infer<typeof leadRecoverySchema>;

export const workStateSchema = z.strictObject({
  id: idSchema,
  graphId: idSchema,
  /** Закреплённое поручение. */
  order: workOrderSchema,
  status: workStatusSchema,
  attempt: z.number().int().min(0),
  activeRunId: z.string().optional(),
  resultSha: gitShaSchema.optional(),
  failure: z.string().optional(),
  failureKind: failureKindSchema.optional(),
  failureFingerprint: z.string().optional(),
  /** Согласованный digest постановки и области проверок (основания от BasisProvider). */
  approvedAt: isoTimeSchema.optional(),
  approvedDigest: digestSchema.optional(),
  approvedScope: digestSchema.optional(),
  approval: technicalApprovalSchema.optional(),
  /** Выдача удержана операцией; снимает её только эта операция. */
  hold: z.strictObject({ operation: z.string().min(1), reason: z.string() }).optional(),
  budgetBlock: z.strictObject({ reason: z.string(), at: isoTimeSchema }).optional(),
  checkVersion: checkVersionSchema.optional(),
  recovery: propertyRecoverySchema.optional(),
  recoveryHistory: z.array(propertyRecoverySchema).optional(),
  /**
   * Отказы окружения, провайдера и истёкшего владения после начала работы:
   * попытку они не засчитывают, но ограничены своим пределом
   * (`MAX_NEUTRAL_FAILURES`); сброс — вместе со сбросом попыток.
   */
  neutralFailures: z.number().int().min(0).optional(),
  /**
   * Решения ведущего/оператора по находкам ревью кода поручения
   * (`review-accept`): применяются следующим раундом (docs/review-protocol.md §10).
   */
  codeReviewDecisions: z.array(codeReviewDecisionSchema).max(500).optional(),
  /**
   * Доработка после приёмки: новая редакция графа изменила постановку уже
   * принятого поручения. Это не повтор проваленного договора, а следующее
   * изменение: `fresh` — редакция начала свой предел попыток (`attempt` и
   * незасчитанные отказы с нуля; таких — не больше `MAX_REWORK_BUDGETS`,
   * счёт — `budgets`), иначе счётчик перенесён с прежней редакции.
   * `revision` — номер доработки (1 — первая), `accepted` — приёмка, после
   * которой она открыта, `spent` — засчитанные попытки принятой редакции.
   * Изменённая постановка непринятого поручения счётчик не трогает и это
   * поле не пишет: перепланированием предел не обойти. Нет поля — доработок
   * не было.
   */
  rework: z
    .strictObject({
      revision: z.number().int().positive(),
      budgets: z.number().int().min(0),
      fresh: z.boolean(),
      /**
       * Доработка продолжает оставленную (0.1.0-alpha.66): та же постановка
       * после отказа — попытки, незасчитанные отказы и предел (эпоха
       * сбросов ведущего) перенесены с неё, своего предела нет.
       */
      resumed: z.literal(true).optional(),
      accepted: z.strictObject({
        runId: z.string().min(1).optional(),
        resultSha: gitShaSchema,
        at: isoTimeSchema.optional(),
      }),
      reopenedAt: isoTimeSchema,
      /**
       * Начало эпохи раундов ревью плана этой доработки (0.1.0-alpha.68):
       * у доработки со своим пределом — время её открытия; продолжение
       * оставленной и доработка с перенесённым счётчиком сохраняют прежнее.
       */
      roundEpochAt: isoTimeSchema.optional(),
      spent: z.number().int().min(0),
      /**
       * Постановка принятой редакции (0.1.0-alpha.66): отказ от доработки
       * возвращает её поручению. Нет — доработка открыта прежней версией.
       */
      acceptedOrder: workOrderSchema.optional(),
      /**
       * Доработка оставлена (0.1.0-alpha.66, `cancel` открытой доработки или
       * новая редакция графа без поручения): работа вернулась к принятой
       * редакции — `done`, результат `accepted.resultSha`. `orderDigest` —
       * содержание оставленной (не принятой) постановки: та же постановка в
       * новой редакции графа снова открывает доработку. `restored` —
       * поручению возвращена принятая постановка (`acceptedOrder`).
       */
      abandoned: z
        .strictObject({
          at: isoTimeSchema,
          by: z.enum(['operator', 'host', 'graph']),
          orderDigest: digestSchema,
          restored: z.boolean(),
          /**
           * Засчитанные попытки и незасчитанные отказы оставленной доработки:
           * та же постановка в новой редакции графа продолжает их, а не
           * открывает свой предел заново. Нет — запись прежней сборки.
           */
          attempt: z.number().int().min(0).optional(),
          neutralFailures: z.number().int().min(0).optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * Восстановление ведущим (`policy.recovery`, docs/principles.md):
   * диагностики повторных отказов и сбросы попыток — кто, по какой
   * диагностике, какой по счёту. Пишется только `harness diagnose` и
   * сбросом; нет поля — диагностик и учтённых сбросов не было.
   */
  leadRecovery: leadRecoverySchema.optional(),
  /**
   * Предложения исполнителей ведущему (0.1.0-alpha.70, `workProposalSchema`):
   * задачи-продолжения на остаток и разделения из разбора в начале попытки.
   * Принимает или отклоняет только ведущий (или оператор).
   */
  proposals: z.array(workProposalSchema).max(PROPOSAL_LIMITS.perWork).optional(),
  /**
   * Исследование задачи (0.1.0-alpha.70, `workResearchSchema`): последнее
   * записанное исполнителем; следующие попытки и зависящие работы начинают с
   * него. Reviewer его не получает.
   */
  research: workResearchSchema.optional(),
  /**
   * Удержание gate по отказу окружения без повтора (0.1.0-alpha.66):
   * попытка этой работы упала `sandbox-process-list` на вызове `ps`, который
   * есть уже в базе (или `sandbox-signal`, `sandbox-browser` — 0.1.0-alpha.68;
   * `gate-definition` — gate упал, не назвав причины, 0.1.0-alpha.69). Пока определение gate (`gateDigest`) то же и ведущий не
   * повторил эту работу (`retry --by lead`), работы репозитория, которым
   * нужен этот gate, не выдаются (`ENVIRONMENT_GATE_HELD`): тот же gate в той
   * же песочнице откажет снова. Держит, пока работа не принята и не отменена.
   */
  environmentHold: z
    .strictObject({
      repositoryId: idSchema,
      gate: idSchema,
      digest: digestSchema,
      runId: z.string().min(1),
      at: isoTimeSchema,
      /**
       * Режим изоляции проверок при отказе (`os`): отказ — свойство
       * песочницы ОС; `isolation.mode: none` снимает удержание. Нет поля
       * (состояние до этого поля) — `os`. У `gate-definition` поля нет:
       * причина в определении gate, а не в песочнице.
       */
      isolation: z.enum(['os', 'none']).optional(),
      /**
       * Причина отказа без повтора, удержавшего gate (0.1.0-alpha.68):
       * `sandbox-process-list`, `sandbox-signal`, `sandbox-browser`;
       * `gate-definition` (0.1.0-alpha.69) — gate не назвал причину провала.
       * Нет поля (состояние до этого поля) — `sandbox-process-list`.
       */
      cause: z.enum(noRetryEnvironmentCauses).optional(),
      /**
       * `gate-definition` из-за отсутствующего инструмента или браузера
       * (`GATE_TOOL_MISSING`, alpha.71): чинится команда gate или окружение.
       */
      tool: z.literal(true).optional(),
    })
    .optional(),
});
export type WorkState = z.infer<typeof workStateSchema>;

export const graphStateSchema = z.strictObject({
  id: idSchema,
  digest: digestSchema,
  graph: workGraphSchema,
  policyDigest: digestSchema,
  approval: technicalApprovalSchema.extend({ at: isoTimeSchema }).optional(),
  registeredAt: isoTimeSchema,
});
export type GraphState = z.infer<typeof graphStateSchema>;

/* ------------------------------------------------------------------ */
/* Очередь и controller                                                */
/* ------------------------------------------------------------------ */

/**
 * Причины паузы. `operator` и `shutdown` — решения человека и штатной
 * остановки; `runtime` — отказ провайдера (`pauseFailures` называет классы);
 * `reconfigure` — операция применения политики, снимает её только она;
 * `base-check` — техническое ожидание проверки перенесённой базы.
 */
export const pauseReasons = [
  'operator',
  'shutdown',
  'runtime',
  'base-check',
  'reconfigure',
] as const;
export type PauseReason = (typeof pauseReasons)[number];

export const controlStateSchema = z.strictObject({
  paused: z.boolean(),
  pauseReason: z.enum(pauseReasons).optional(),
  pausedAt: isoTimeSchema.optional(),
  pauseOperation: z.string().optional(),
  pauseFailures: z.array(failureKindSchema).optional(),
  waits: z
    .array(
      z.strictObject({
        kind: z.enum(['base-check', 'context-lock']),
        detail: z.string(),
        at: isoTimeSchema,
        operation: z.string().optional(),
      }),
    )
    .optional(),
  appliedPolicy: z
    .strictObject({
      digest: digestSchema,
      generation: z.number().int().min(0).optional(),
      at: isoTimeSchema,
      by: z.string().min(1),
      /**
       * Пределы бюджета применённой политики (0.1.0-alpha.68): попытки,
       * раунды ревью, повторы, сбросы ведущего, расходы и время. Сравнение с
       * ними при следующем применении записывает `budget.raised`.
       */
      limits: z.record(z.string().max(60), z.number().nullable()).optional(),
    })
    .optional(),
  reconfigure: z
    .strictObject({
      operation: z.string().min(1),
      digest: digestSchema,
      requestedAt: isoTimeSchema,
      appliedAt: isoTimeSchema.optional(),
      appliedBy: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
});
export type ControlState = z.infer<typeof controlStateSchema>;

/** Единственный действующий controller очереди. */
export const controllerLeaseSchema = z.strictObject({
  owner: z.string().min(1).max(300),
  leaseUntil: z.number().int().min(0),
  /**
   * Версия движка, под которой процесс держит роль. Живую роль другой версии
   * (или роль без версии, записанную прежним движком) процесс не перенимает:
   * попытки прежней версии не продолжаются незаметно под новой.
   */
  engineVersion: z.string().min(1).max(100).optional(),
});
export type ControllerLease = z.infer<typeof controllerLeaseSchema>;

/* ------------------------------------------------------------------ */
/* Учёт вызовов моделей                                                */
/* ------------------------------------------------------------------ */

/**
 * Диагностика процесса runtime — форма `RuntimeDiagnostics` DevContour:
 * время, последний вывод, код и сигнал, таймаут/отмена, хвосты потоков
 * (уже замаскированные), дерево процессов.
 */
export const runtimeDiagnosticsSchema = z.strictObject({
  startedAt: isoTimeSchema,
  finishedAt: isoTimeSchema,
  lastOutputAt: isoTimeSchema.nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  aborted: z.boolean(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  processTree: z
    .strictObject({
      available: z.boolean(),
      reason: z.string().optional(),
      processes: z.array(
        z.strictObject({
          pid: z.number().int(),
          parentPid: z.number().int(),
          groupPid: z.number().int(),
          name: z.string(),
        }),
      ),
    })
    .optional(),
});
export type RuntimeDiagnostics = z.infer<typeof runtimeDiagnosticsSchema>;

const tokenCount = z.number().int().nonnegative().nullable();
export const usageSchema = z.strictObject({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheWriteTokens: tokenCount,
  reportedUsd: z.number().nonnegative().nullable(),
  complete: z.boolean(),
  source: z.enum(['codex-turn-events', 'claude-result', 'fixture', 'unavailable']),
});
export type Usage = z.infer<typeof usageSchema>;

/**
 * Запись вызова модели. Атрибуция закрепляется **при вызове**: поручение,
 * группа (у DevContour — доска со всеми ревизиями) и поручения группы на
 * момент вызова. Перенос поручения между группами расход не переносит;
 * записи без закреплённой атрибуции получают её от хоста
 * (`BudgetScopes.legacy`) один раз и больше не пересчитываются.
 */
export const callRecordSchema = z.strictObject({
  id: z.string().min(1).max(200),
  repositoryId: idSchema.optional(),
  runId: z.string().optional(),
  subjectId: z.string().optional(),
  /**
   * Чем является предмет вызова: поручение, группа или прочее (контракт).
   * Явный вид важнее совпадения строки с ID поручения; у прежних записей
   * его нет — тогда предмет ищется по ID.
   */
  subjectKind: z.enum(['work', 'group', 'other']).optional(),
  stage: z.string().min(1).max(100),
  runtime: z.string().min(1),
  /** Модель, о которой сообщил runtime; по ней выбирается тариф. */
  model: z.string().nullable(),
  runtimeVersion: z.string().nullable(),
  startedAt: isoTimeSchema,
  finishedAt: isoTimeSchema.optional(),
  outcome: z.enum(['active', 'returned', 'error', 'abandoned']),
  process: z
    .strictObject({
      id: z.string().min(1),
      pid: z.number().int().positive(),
      startedAt: z.number().optional(),
    })
    .optional(),
  abandonedAt: isoTimeSchema.optional(),
  durationMs: z.number().min(0).optional(),
  elapsedMs: z.number().min(0).optional(),
  startedHr: z.string().regex(/^\d+$/).optional(),
  durationUnknown: z.literal(true).optional(),
  bootId: z.string().optional(),
  workId: idSchema.optional(),
  groupId: z.string().min(1).max(200).optional(),
  workIds: z.array(idSchema).optional(),
  promptBytes: z.number().int().min(0),
  promptDigest: digestSchema,
  usage: usageSchema,
  costUsd: z.number().nonnegative().nullable(),
  costSource: z.enum(['provider-reported', 'tariff-estimate', 'unknown']),
  price: z
    .strictObject({
      runtime: z.enum(['codex', 'claude']),
      model: z.string().min(1),
      effectiveAt: z.iso.datetime(),
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative(),
    })
    .optional(),
  diagnostics: runtimeDiagnosticsSchema.optional(),
});
export type CallRecord = z.infer<typeof callRecordSchema>;

/* ------------------------------------------------------------------ */
/* Корпус подтверждённых случаев                                       */
/* ------------------------------------------------------------------ */

/**
 * Набор корпуса одного gate договора проверки — форма `CheckSuite`
 * DevContour. Случаи, версии, решения, принятия, отложенные принятия и
 * операции подтверждения под владением (token/lease); `revision` — CAS для
 * конкурентных добавок. История решений только дополняется.
 */
const corpusCaseSchema = z.strictObject({
  id: z.string().min(1).max(200),
  property: z.string().min(1).max(200),
  /** Канонический JSON входа. */
  input: z.string(),
  /** Ответ закреплённого эталона, а не слова reviewer. */
  expected: z.string(),
  source: z.strictObject({
    kind: z.literal('oracle'),
    decision: z.string().min(1),
    sha: gitShaSchema,
    runId: z.string().optional(),
    taskId: idSchema.optional(),
    reproduction: z.string().optional(),
  }),
  addedAt: isoTimeSchema,
});
const corpusVersionSchema = z.strictObject({
  number: z.number().int().min(0),
  digest: digestSchema,
  previous: digestSchema.nullable(),
  cases: z.array(z.string()),
  blob: gitShaSchema,
  createdAt: isoTimeSchema,
  reason: z.string(),
  decisions: z.array(z.string()),
});
const caseDecisionSchema = z.strictObject({
  id: z.string().min(1),
  key: z.string().optional(),
  property: z.string().min(1).max(200),
  input: z.string(),
  inputHash: digestSchema,
  outcome: z.enum(['confirmed', 'refuted', 'inconclusive', 'rejected']),
  reason: z.string(),
  claimed: z
    .strictObject({
      expected: z.string().nullable(),
      actual: z.string().nullable(),
      reproduction: z.string().optional(),
    })
    .optional(),
  source: z.strictObject({
    sha: gitShaSchema,
    runId: z.string().optional(),
    taskId: idSchema.optional(),
  }),
  observed: z
    .strictObject({
      expected: z.string().optional(),
      actual: z.string().optional(),
      equal: z.boolean().optional(),
      repeats: z.number().int().min(0),
      durationsMs: z.array(z.number().min(0)),
    })
    .optional(),
  method: z
    .strictObject({
      gate: idSchema,
      // Команда checker — локальная политика установки: в переносимую форму
      // корпуса она не входит, и решение, полученное из Git другого клона,
      // её не имеет.
      command: z.array(z.string()).optional(),
      artifacts: z.array(z.strictObject({ path: relativePathSchema, blob: gitShaSchema })),
      contract: z.string().min(1),
      basis: z.string().min(1),
    })
    .optional(),
  caseId: z.string().optional(),
  version: z.number().int().min(0).optional(),
  origin: z.strictObject({
    kind: z.enum(['review', 'lead', 'agent', 'operator']),
    runtime: z.string().optional(),
  }),
  at: isoTimeSchema,
});
const versionRefSchema = z.strictObject({ number: z.number().int().min(0), digest: digestSchema });
export const checkSuiteSchema = z.strictObject({
  id: z.string().min(1).max(300),
  repositoryId: idSchema,
  contractId: idSchema,
  contractDigest: digestSchema,
  gate: idSchema,
  basis: z.string().min(1),
  cases: z.record(z.string(), corpusCaseSchema),
  versions: z.array(corpusVersionSchema),
  decisions: z.array(caseDecisionSchema),
  adoptions: z.array(
    z.strictObject({
      id: z.string().min(1),
      taskId: idSchema,
      from: versionRefSchema.nullable(),
      to: versionRefSchema,
      actor: z.string().min(1),
      reason: z.string(),
      operation: z.string().min(1),
      at: isoTimeSchema,
    }),
  ),
  pending: z.array(
    z.strictObject({
      id: z.string().min(1),
      version: z.number().int().min(0),
      digest: digestSchema.optional(),
      awaitingOperator: z.boolean().optional(),
      tasks: z.array(idSchema),
      status: z.enum(['waiting', 'completed']),
      results: z.record(z.string(), z.string()),
      actor: z.string().min(1),
      reason: z.string(),
      requestedAt: isoTimeSchema,
      completedAt: isoTimeSchema.optional(),
    }),
  ),
  operations: z.record(
    z.string(),
    z.strictObject({
      key: z.string().min(1),
      status: z.enum(['running', 'completed']),
      token: z.string().optional(),
      leaseUntil: z.number().int().min(0).optional(),
      decision: z.string().optional(),
      startedAt: isoTimeSchema,
    }),
  ),
  revision: z.number().int().min(0),
});
export type CheckSuite = z.infer<typeof checkSuiteSchema>;

/* ------------------------------------------------------------------ */
/* Техническая очередь ведущего                                        */
/* ------------------------------------------------------------------ */

/**
 * Задание технической очереди — форма `WorkflowJob` DevContour: предмет
 * (вид и ID группы, у DevContour — доска или ChangeSet), закреплённый runtime
 * автора, digest входа (смена входа делает задание `stale`), этап, попытки,
 * число ремонтов, владение (token/lease) и история. Постановка идемпотентна
 * по ключу; повтор с другим автором отклоняется.
 */
export const workflowJobSchema = z.strictObject({
  kind: idSchema,
  id: idSchema,
  authorRuntime: z.enum(['codex', 'claude']),
  maxAttempts: z.number().int().min(1).max(5),
  key: digestSchema,
  owner: z.string().optional(),
  inputDigest: digestSchema,
  stage: z.number().int().min(0),
  /** Попытки текущей стадии; у завершённого задания — все израсходованные попытки стадий. */
  attempts: z.number().int().min(0),
  status: z.enum(['queued', 'running', 'failed', 'stale', 'completed']),
  repairs: z.number().int().min(0).optional(),
  token: z.string().optional(),
  leaseUntil: z.number().int().min(0).optional(),
  startedAt: isoTimeSchema,
  /**
   * Порядковый номер постановки в этом хранилище (1, 2, …): порядок заданий
   * не зависит от часов — равное или откатившееся `startedAt` не меняет,
   * какое задание новее. Ставится при постановке и не меняется. У заданий
   * прежних версий нет: они старше любого задания с номером, а между собой
   * упорядочены по `startedAt`, затем по ключу (`compareWorkflowJobs`).
   */
  seq: z.number().int().min(1).optional(),
  /**
   * Время окончания: `completed`, `failed`, `stale`. Повтор человека его
   * снимает. У заданий, остановленных прежними версиями, может отсутствовать.
   */
  finishedAt: isoTimeSchema.optional(),
  error: z.string().optional(),
  /** События стадий: захват (`running`), исход (`completed`, `failed`, `stale`, `queued`), восстановления. */
  history: z.array(
    z.strictObject({ at: isoTimeSchema, stage: z.number().int().min(0), event: z.string() }),
  ),
});
export type WorkflowJob = z.infer<typeof workflowJobSchema>;

/* ------------------------------------------------------------------ */
/* Локальные записи                                                    */
/* ------------------------------------------------------------------ */

/**
 * Пространства локальных записей и их схемы. Запись адресуется
 * `(namespace, owner, key)`: `owner` — репозиторий, за которым запись
 * закреплена, или `@workspace` для общих. У DevContour с хранением по
 * компонентам запись владельца-компонента живёт в его базе. Неизвестное
 * пространство движок не пишет и не читает.
 */
export const WORKSPACE_OWNER = '@workspace';
/**
 * Воспроизведение из находки ревью: вход, на котором поручение ломалось.
 * Один и тот же вход одного свойства — одна запись, повтор добавляет прогон.
 * `observed` — запуск подтверждён журналом controller (probe); иначе это
 * гипотеза reviewer. Диагностика: gate не расширяет, корпусом не становится
 * без подтверждения эталоном.
 */
export const reproductionRecordSchema = z.strictObject({
  key: digestSchema,
  property: z.string().max(200).nullable(),
  inputHash: digestSchema,
  input: z.string().min(1).max(8000),
  /** Класс входов, названный reviewer; у записей прежних версий нет. */
  inputClass: z.string().max(500).nullable().optional(),
  expected: z.string().max(2000).nullable(),
  actual: z.string().max(2000).nullable(),
  command: z.array(z.string()).max(64).nullable(),
  message: z.string().max(4000),
  /** Reviewer сообщил, что запускал команду. */
  claimed: z.boolean(),
  observed: z.boolean(),
  run: z.string().nullable(),
  runs: z
    .array(z.strictObject({ runId: z.string().min(1), sha: gitShaSchema, at: isoTimeSchema }))
    .max(200),
});
export type ReproductionRecord = z.infer<typeof reproductionRecordSchema>;

/** Реестр воспроизведений поручения; ограничен — старые записи вытесняются. */
export const reproductionRegistrySchema = z.strictObject({
  workId: idSchema,
  items: z.array(reproductionRecordSchema).max(500),
});
export const MAX_REPRODUCTIONS = 500;

/** Кто сбросил бюджет совместных проверок (`joint.budget-reset`). */
export const jointResetActors = ['operator', 'host'] as const;
export type JointResetActor = (typeof jointResetActors)[number];
/**
 * Явный сброс бюджета совместных проверок набора (`engine.jointBudgetReset`):
 * завершённые к этому моменту проверки набора больше не тратят его предел.
 * Граница — снимок ID этих проверок, а не время: откат часов её не сдвигает.
 */
export const jointBudgetResetSchema = z.strictObject({
  id: z.string().min(1).max(200),
  at: isoTimeSchema,
  workIds: z.array(idSchema).min(1).max(500),
  reason: z.string().trim().min(1).max(2000),
  actor: z.enum(jointResetActors),
  settledVerificationIds: z.array(z.string().min(1).max(200)).min(1).max(10_000),
});
export type JointBudgetReset = z.infer<typeof jointBudgetResetSchema>;

export const localSchemas = {
  /** Учёт вызовов моделей. */
  usage: callRecordSchema,
  /** Снимки контекста попыток по digest: повторное использование после рестарта. */
  'context-snapshots': contextSnapshotSchema,
  /** Ключи идемпотентности запуска: (connector, ref, revision, digest) → graphId. */
  'run-keys': z.strictObject({ graphId: idSchema, digest: digestSchema, at: isoTimeSchema }),
  /** Состояние доставки результата по ключу. */
  delivery: deliveryStateSchema,
  /** История технического ревью плана и контрактов. */
  reviews: reviewRecordSchema,
  /**
   * Технические обзоры уже написанных веток (`harness review-code`) по ID
   * записи, у `@workspace`. Наблюдение, а не приёмка: поручений и target ref
   * не меняют.
   */
  'code-reviews': codeReviewRecordSchema,
  /** Наборы корпуса подтверждённых случаев (у DevContour — `check-suites`). */
  'check-suites': checkSuiteSchema,
  /** Техническая очередь ведущего (у DevContour — `lead`). */
  'workflow-jobs': workflowJobSchema,
  /**
   * Документы контрактов, прошедшие ревью, по digest: из них движок берёт
   * договор проверки и закреплённые артефакты поручения (у DevContour —
   * `contracts` состояния).
   */
  'contract-documents': contractDocumentSchema,
  /**
   * Ограниченные эксперименты выполнимости по репозиториям: на них ссылаются
   * тяжёлые обязательства договора проверки (у DevContour — `spikes`).
   */
  spikes: spikeSchema,
  /**
   * Реестр воспроизведений из находок ревью по поручениям (у DevContour —
   * `reproductions` состояния): входы, на которых поручение ломалось,
   * передаются следующей попытке.
   */
  reproductions: reproductionRegistrySchema,
  /**
   * Вопросы исполнителей и ответы на них (`InputRequest`) по владельцу —
   * репозиторию поручения. Вопрос и основание неизменяемы, ответы только
   * дополняются, `version` — CAS записи: это правила движка (все записи —
   * через его операции); хранилище хранит запись целиком, как записана, и
   * отдаёт её в списке без владельца с `owner` и `key` (`executionStoreContract`).
   */
  'input-requests': inputRequestSchema,
  /**
   * Явные сбросы бюджета совместных проверок (`JointBudgetReset`) по ID сброса,
   * у `@workspace`. Пишет только `engine.jointBudgetReset`.
   */
  'joint-budget-resets': jointBudgetResetSchema,
  /**
   * Журнал ведущего (0.1.0-alpha.66): одна запись `log` у `@workspace` —
   * сессия, записи и итог выпуска (`leadLogSchema`). Пишут только операции
   * журнала (`lead.recorded`).
   */
  lead: leadLogSchema,
  /**
   * План выпуска ведущего (0.1.0-alpha.68): одна запись `outline` у
   * `@workspace` (`releaseOutlineSchema`). Пишет только `harness lead outline`.
   */
  'release-outline': releaseOutlineSchema,
  /**
   * Первое появление работы в выпуске (0.1.0-alpha.68): запись по ID работы у
   * `@workspace` (`workSeenSchema`). Пишет регистрация графа для новой работы.
   */
  'work-seen': workSeenSchema,
  /**
   * Эпохи раундов ревью плана графа (0.1.0-alpha.68): запись по ID графа у
   * `@workspace` — каждая доработка принятой работы со своим пределом
   * попыток, в порядке открытия. Записи не удаляются: открытая эпоха
   * остаётся израсходованной и после отказа от доработки. Пишет регистрация
   * графа.
   */
  /**
   * База выпуска (0.1.0-alpha.69): запись по ID репозитория у `@workspace` —
   * target ref репозитория при первой регистрации графа выпуска или при
   * `lead outline` (что раньше). Новый выпуск (после `release done`)
   * записывает новую базу. Читает приёмка выпуска (`review-release`).
   */
  'release-base': z.strictObject({
    sha: gitShaSchema,
    at: isoTimeSchema,
    /** `attempt` — выпуск, начатый до alpha.69: база самой ранней его попытки. */
    source: z.enum(['register', 'outline', 'attempt']),
  }),
  'round-epochs': z.strictObject({
    epochs: z.array(z.strictObject({ at: isoTimeSchema, workId: idSchema })).max(100),
  }),
} as const;
export type LocalNamespace = keyof typeof localSchemas;
export type LocalValue<N extends LocalNamespace> = z.infer<(typeof localSchemas)[N]>;

/* ------------------------------------------------------------------ */
/* Документ standalone                                                 */
/* ------------------------------------------------------------------ */

/**
 * Совместная проверка в состоянии: результат и владение ею. Токен и срок
 * владения наружу не выдаются (`JointVerification` их не содержит).
 */
const ownership = {
  token: z.string().min(16).max(200),
  leaseUntil: z.number().int().min(0),
  /** Версия движка, начавшего проверку: другая версия её не продолжает. */
  engineVersion: z.string().min(1).max(100).optional(),
};
export const jointVerificationStateSchema = z.discriminatedUnion('status', [
  jointActiveSchema.extend(ownership),
  jointFailedSchema.extend(ownership),
  jointPassedSchema.extend(ownership),
]);
export type JointVerificationState = z.infer<typeof jointVerificationStateSchema>;

/** Документ состояния standalone SQLite. DevContour хранит свой документ, а не этот. */
export const executionDocumentSchema = z.strictObject({
  stateVersion: z.literal(STATE_VERSION),
  graphs: z.array(graphStateSchema),
  works: z.array(workStateSchema),
  attempts: z.array(attemptStateSchema),
  verifications: z.array(jointVerificationStateSchema).default([]),
  control: controlStateSchema,
  controller: controllerLeaseSchema.optional(),
  /**
   * Метка D53: сроки аренды активных попыток держат строки таблицы
   * `leases`, а `leaseUntil` попытки в документе — не источник (для отладки).
   * Прежние версии не знают поля и отказывают до любой записи (строгая
   * схема). Ставится первой строкой аренды вместе с переносом сроков всех
   * активных попыток; снимается шагом вниз (`stepDownLeases`).
   */
  leaseRows: z.literal(true).optional(),
  sequence: z.number().int().min(0),
});
export type ExecutionDocument = z.infer<typeof executionDocumentSchema>;

/** Текст, который хранит fencing-токен, — проверка утечки в тестах и адаптерах. */
export const containsToken = (value: unknown, token: string) =>
  token.length > 0 && JSON.stringify(value ?? null).includes(token);
