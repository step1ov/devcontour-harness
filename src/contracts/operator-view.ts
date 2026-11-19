import { z } from 'zod';
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
        alternates: z.array(bindingSchema).max(10),
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
  title: freeText(T.questionTitle).optional(),
  createdAt: isoTimeSchema,
});

const escalationSchema = z.strictObject({
  workId: id.optional(),
  subject: id.optional(),
  code: token(80),
  actor: viewActor,
  action: token(80),
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
    /** P2. */
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
    line: freeText(T.line).optional(),
    lastFailure: z
      .strictObject({
        attempt: z.number().int().positive(),
        bucket: token(40),
        plain: z.string().min(1).max(T.plain),
        at: isoTimeSchema.optional(),
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
      }),
    )
    .max(L.blockersPerWork),
  dependsOn: z.array(id).max(L.dependsOn).optional(),
  target: z
    .strictObject({
      repositoryId: id,
      ref: z.string().min(1).max(500),
      acceptedSha: sha.optional(),
      remote: z.strictObject({
        state: token(40),
        trackingRef: z.string().min(1).max(500).optional(),
        reason: freeText(T.reason).optional(),
      }),
    })
    .optional(),
  question: z
    .strictObject({ requestId: id, state: token(40), severity: z.number().int().min(1).max(10) })
    .optional(),
  spend: z.strictObject({ calls: count, usd: boundedSchema, durationMs: count }),
  resultSha: sha.optional(),
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
});

/** P2: кто что делал. */
const activitySchema = z.strictObject({
  at: isoTimeSchema,
  actor: viewActor,
  action: token(80),
  workId: id.optional(),
  subject: id.optional(),
  plain: z.string().min(1).max(200),
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
    }),
  }),
  history: viewHistorySchema,
  health: viewHealthSchema,
  activity: z.array(activitySchema).max(L.activity).optional(),
  decisions: z.array(decisionSchema).max(L.decisions).optional(),
  truncated: z
    .strictObject({
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
      activity: truncatedCount.optional(),
      decisions: truncatedCount.optional(),
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
    })
    .optional(),
});
export type WorkDetailViewDocument = z.infer<typeof workDetailViewSchema>;

/** Ответ `harness view`: обзор или, с `--work`, детали работы. */
export const viewDataSchema = z.union([operatorViewSchema, workDetailViewSchema]);
