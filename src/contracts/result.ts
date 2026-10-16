import { z } from 'zod';
import { API_VERSION, STATE_VERSION } from './version.ts';
import {
  digestSchema,
  gitShaSchema,
  idSchema,
  isoTimeSchema,
  runtimeNameSchema,
  targetRefSchema,
} from './primitives.ts';
import { sourceRefSchema } from './work.ts';
import { errorCodes, type ErrorCode } from './errors.ts';

export const findingSchema = z.strictObject({
  /** Уровень находки как его назвал reviewer: `blocking` или `note`. */
  severity: z.string().min(1).max(40),
  message: z.string().min(1).max(4000),
  path: z.string().max(500).nullable().optional(),
  line: z.number().int().positive().nullable().optional(),
  rule: z.string().max(100).optional(),
});
export type Finding = z.infer<typeof findingSchema>;

/**
 * Ссылка на доказательство. Само evidence (логи, отчёты) хранит
 * ExecutionStore; результат несёт digest и SHA, по которым его сверяют.
 */
export const evidenceRefSchema = z.strictObject({
  id: z.string().min(1).max(200),
  kind: z.enum(['test', 'check', 'review', 'property', 'consumer']),
  phase: z.enum(['candidate', 'integration']),
  gate: z.string().min(1).max(200),
  sha: gitShaSchema,
  passed: z.boolean(),
  digest: digestSchema,
  summary: z.string().max(4000),
  consumer: idSchema.optional(),
  reviewer: z
    .strictObject({
      runtime: runtimeNameSchema,
      model: z.string().optional(),
      sameVendor: z.boolean(),
    })
    .optional(),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

const artifactPin = z.strictObject({ path: z.string().min(1), digest: digestSchema });
const freshness = z.strictObject({
  repositoryId: idSchema,
  snapshot: gitShaSchema,
  head: gitShaSchema,
  fresh: z.boolean(),
});

/**
 * Против чего проверена попытка: снимки зависимостей и их свежесть на момент
 * окончания, проверенная комбинация каждого потребителя. Свежесть
 * записывается, а не запрещает приёмку: устаревший снимок — сведение для
 * получателя, а не отказ (семантика DevContour сохраняется).
 */
export const checkedInputsSchema = z.strictObject({
  dependencies: z.array(
    z.strictObject({
      repositoryId: idSchema,
      sha: gitShaSchema,
      tree: gitShaSchema,
      artifacts: z.array(artifactPin),
    }),
  ),
  freshness: z.array(freshness),
  consumers: z.array(
    z.strictObject({
      repositoryId: idSchema,
      gates: z.array(idSchema),
      sha: gitShaSchema,
      tree: gitShaSchema,
      dependencies: z.array(
        z.strictObject({
          repositoryId: idSchema,
          sha: gitShaSchema,
          tree: gitShaSchema,
          artifacts: z.array(artifactPin),
        }),
      ),
      freshness: z.array(freshness),
    }),
  ),
});

export const outcomes = ['accepted', 'rejected', 'blocked', 'cancelled', 'stopped'] as const;
const stopCode = z.enum(Object.keys(errorCodes) as [ErrorCode, ...ErrorCode[]]);

const resultBase = {
  apiVersion: z.literal(API_VERSION),
  workOrderId: idSchema,
  graphId: idSchema,
  source: sourceRefSchema,
  runId: z.string().min(1).max(200),
  attempt: z.number().int().positive(),
  repositoryId: idSchema,
  targetRef: targetRefSchema,
  /** Версии и digests входов, под которыми получен результат. */
  inputs: z.strictObject({
    harnessVersion: z.string().min(1),
    consumerVersion: z.string().min(1).optional(),
    stateVersion: z.literal(STATE_VERSION),
    workOrderDigest: digestSchema,
    graphDigest: digestSchema,
    policyDigest: digestSchema,
    contextDigest: digestSchema.optional(),
    checks: digestSchema.optional(),
  }),
  checked: checkedInputsSchema,
  evidence: z.array(evidenceRefSchema),
  findings: z.array(findingSchema).default([]),
  /** Чего результат не доказывает: недоступный дополнительный контекст, необязательные проверки. */
  limitations: z.array(z.string().min(1).max(1000)).default([]),
  finishedAt: isoTimeSchema,
};

/**
 * Итог работы над одной редакцией поручения. `accepted` — result SHA уже в
 * target ref (result = integration), evidence обеих фаз записано; остальные
 * исходы называют причину остановки кодом из договора ошибок. Различие
 * выражено вариантами, а не проверкой после разбора, поэтому JSON Schema
 * задаёт то же правило.
 */
export const runResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...resultBase,
    outcome: z.literal('accepted'),
    shas: z.strictObject({
      base: gitShaSchema,
      candidate: gitShaSchema,
      integration: gitShaSchema,
      result: gitShaSchema,
    }),
  }),
  z.strictObject({
    ...resultBase,
    outcome: z.enum(['rejected', 'blocked', 'cancelled', 'stopped']),
    shas: z.strictObject({
      base: gitShaSchema.optional(),
      candidate: gitShaSchema.optional(),
      integration: gitShaSchema.optional(),
    }),
    stopReason: z.strictObject({ code: stopCode, message: z.string().min(1).max(4000) }),
  }),
]);
export type RunResult = z.infer<typeof runResultSchema>;

/**
 * Состояние доставки результата получателю — отдельно от исхода исполнения.
 * Недоступность получателя не откатывает принятый код; повтор доставки
 * идёт с тем же ключом и не вызывает моделей или интеграции.
 */
export const deliveryStateSchema = z.strictObject({
  sink: idSchema,
  key: z.string().min(1).max(300),
  /** Редакция источника, к которой относится результат. */
  revision: z.string().min(1).max(200),
  status: z.enum(['pending', 'delivered', 'failed', 'conflict']),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().max(4000).optional(),
  /** Редакция, которую получатель считает текущей, при конфликте. */
  currentRevision: z.string().max(200).optional(),
  receipt: z.string().max(1000).optional(),
  updatedAt: isoTimeSchema,
});
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

/** Выход `harness result`: результат и состояние его доставки. */
export const resultEnvelopeSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  result: runResultSchema,
  delivery: z.array(deliveryStateSchema),
});
export type ResultEnvelope = z.infer<typeof resultEnvelopeSchema>;

/* ------------------------------------------------------------------ */
/* Совместная проверка комбинации репозиториев                         */
/* ------------------------------------------------------------------ */

/**
 * Совместная проверка закреплённой комбинации SHA нескольких репозиториев
 * gates уровня workspace (`policy.workspaceGates`). Это техническая
 * проверка; решение о продуктовом принятии (ChangeSet, релиз) принимает
 * хост. Атомарность продвижения нескольких Git-репозиториев не заявляется:
 * результат привязан к manifest, и смена любого SHA делает его устаревшим.
 */
export const jointManifestSchema = z.record(
  idSchema,
  z.strictObject({ sha: gitShaSchema, tree: gitShaSchema }),
);

export const jointEvidenceSchema = z.strictObject({
  gate: idSchema,
  passed: z.boolean(),
  command: z.array(z.string()),
  exitCode: z.number().int(),
  log: z.string(),
  digest: digestSchema,
  summary: z.string(),
  artifacts: z.array(artifactPin),
  durationMs: z.number().min(0).optional(),
});

export const jointImpactSchema = z.strictObject({
  changed: z.array(idSchema),
  affected: z.array(idSchema),
  gateIds: z.array(idSchema),
  mode: z.enum(['all', 'affected']),
  reason: z.string(),
  baseline: z.string().optional(),
});

const jointCommon = {
  apiVersion: z.literal(API_VERSION),
  id: z.string().min(1).max(200),
  startedAt: isoTimeSchema,
  policyDigest: digestSchema,
  /** Digest постановок поручений, входящих в проверку (основание хоста). */
  specDigest: digestSchema,
  workIds: z.array(idSchema),
  impact: jointImpactSchema.optional(),
  evidence: z.array(jointEvidenceSchema),
};
/**
 * Состояния совместной проверки. `active` — начата, manifest ещё может
 * отсутствовать (снимок SHA делается после старта); `failed` — отказ, в том
 * числе до получения manifest; `passed` — только с manifest и его digest.
 * Выдумывать manifest для ранних состояний нельзя.
 */
export const jointActiveSchema = z.strictObject({
  ...jointCommon,
  status: z.literal('active'),
  manifest: jointManifestSchema.optional(),
  manifestDigest: digestSchema.optional(),
});
export const jointFailedSchema = z.strictObject({
  ...jointCommon,
  status: z.literal('failed'),
  finishedAt: isoTimeSchema,
  manifest: jointManifestSchema.optional(),
  manifestDigest: digestSchema.optional(),
  error: z.string().min(1),
});
export const jointPassedSchema = z.strictObject({
  ...jointCommon,
  status: z.literal('passed'),
  finishedAt: isoTimeSchema,
  manifest: jointManifestSchema,
  manifestDigest: digestSchema,
});
export const jointVerificationSchema = z.discriminatedUnion('status', [
  jointActiveSchema,
  jointFailedSchema,
  jointPassedSchema,
]);
export type JointVerification = z.infer<typeof jointVerificationSchema>;
