import { z } from 'zod';
import { STATE_VERSION } from './version.ts';
import {
  digestSchema,
  gitShaSchema,
  idSchema,
  isoTimeSchema,
  relativePathSchema,
  runtimeNameSchema,
  trimmedText,
} from './primitives.ts';
import { workGraphSchema, workOrderSchema } from './work.ts';
import { contextPinSchema, contextSnapshotSchema } from './context.ts';
import {
  deliveryStateSchema,
  jointActiveSchema,
  jointFailedSchema,
  jointPassedSchema,
} from './result.ts';
import { findingStatuses, reviewRecordSchema, reviewRoundSchema } from './review.ts';
import { contractDocumentSchema, spikeSchema } from './checks.ts';

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
  'stale-base',
  'empty-result',
  'scope-violation',
  'gate',
  'review',
  /** Ответ reviewer нарушил протокол ревью и разрешённые повторы reviewer исчерпаны. */
  'review-protocol',
  'merge',
  'cancelled',
  'budget',
  'unknown',
] as const;
export const failureKindSchema = z.enum(failureKinds);
export type FailureKind = (typeof failureKinds)[number];

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
});

export const evidenceRecordSchema = z.strictObject({
  id: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  kind: z.enum(['test', 'review']),
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
  inspection: reviewInspectionSchema.optional(),
  findings: z.array(evidenceFindingSchema).optional(),
  /** Раунд ревью кода: область истории, вызов, протокол, переходы (docs/review-protocol.md). */
  reviewRound: reviewRoundSchema.optional(),
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
  /** Действующая версия проверок, под которой получено evidence. */
  checks: digestSchema.optional(),
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
  failureKind: failureKindSchema.optional(),
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
  episodeBasis: digestSchema.optional(),
  implementationBasis: digestSchema.optional(),
  reusedFrom: z
    .strictObject({ runId: z.string().min(1).max(200), candidateSha: gitShaSchema })
    .optional(),
  partial: partialDraftSchema.optional(),
  continuedFrom: continuationSchema.optional(),
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
  timings: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        stage: z.string().min(1),
        startedAt: isoTimeSchema,
        finishedAt: isoTimeSchema.optional(),
        outcome: z.enum(['passed', 'failed']).optional(),
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
  attempts: z.number().int().min(0),
  status: z.enum(['queued', 'running', 'failed', 'stale', 'completed']),
  repairs: z.number().int().min(0).optional(),
  token: z.string().optional(),
  leaseUntil: z.number().int().min(0).optional(),
  startedAt: isoTimeSchema,
  finishedAt: isoTimeSchema.optional(),
  error: z.string().optional(),
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
  sequence: z.number().int().min(0),
});
export type ExecutionDocument = z.infer<typeof executionDocumentSchema>;

/** Текст, который хранит fencing-токен, — проверка утечки в тестах и адаптерах. */
export const containsToken = (value: unknown, token: string) =>
  token.length > 0 && JSON.stringify(value ?? null).includes(token);
