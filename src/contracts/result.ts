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
  /** Уровень находки как его назвал reviewer; блокирующие: `blocking`, `critical`, `high`. */
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
  /** Компонент-потребитель, в дереве которого выполнена проверка. */
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

export const outcomes = ['accepted', 'rejected', 'blocked', 'cancelled', 'stopped'] as const;

/**
 * Итог работы над одной редакцией поручения. `accepted` — result SHA уже в
 * target ref, evidence обеих фаз записано; остальные исходы называют причину
 * остановки кодом из договора ошибок.
 */
export const runResultSchema = z
  .strictObject({
    apiVersion: z.literal(API_VERSION),
    outcome: z.enum(outcomes),
    workOrderId: idSchema,
    graphId: idSchema,
    source: sourceRefSchema,
    runId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    repositoryId: idSchema,
    targetRef: targetRefSchema,
    shas: z.strictObject({
      base: gitShaSchema.optional(),
      candidate: gitShaSchema.optional(),
      integration: gitShaSchema.optional(),
      result: gitShaSchema.optional(),
    }),
    /** Версии и digests входов, под которыми получен результат. */
    inputs: z.strictObject({
      harnessVersion: z.string().min(1),
      stateVersion: z.literal(STATE_VERSION),
      workOrderDigest: digestSchema,
      graphDigest: digestSchema,
      policyDigest: digestSchema,
      contextDigest: digestSchema.optional(),
      checks: digestSchema.optional(),
    }),
    evidence: z.array(evidenceRefSchema),
    findings: z.array(findingSchema).default([]),
    /** Чего результат не доказывает: недоступный дополнительный контекст, необязательные проверки. */
    limitations: z.array(z.string().min(1).max(1000)).default([]),
    stopReason: z
      .strictObject({
        code: z.enum(Object.keys(errorCodes) as [ErrorCode, ...ErrorCode[]]),
        message: z.string().min(1).max(4000),
      })
      .optional(),
    finishedAt: isoTimeSchema,
  })
  .superRefine((r, ctx) => {
    if (r.outcome === 'accepted' && (!r.shas.result || !r.shas.integration))
      ctx.addIssue({ code: 'custom', message: 'accepted требует result и integration SHA' });
    if (r.outcome !== 'accepted' && !r.stopReason)
      ctx.addIssue({ code: 'custom', message: 'Неуспешный исход требует stopReason' });
  });
export type RunResult = z.infer<typeof runResultSchema>;

/**
 * Состояние доставки результата получателю — отдельно от исхода исполнения.
 * Недоступность получателя не откатывает принятый код; повтор доставки
 * идёт с тем же ключом и не вызывает моделей или интеграции.
 */
export const deliveryStateSchema = z.strictObject({
  sink: idSchema,
  key: z.string().min(1).max(300),
  status: z.enum(['pending', 'delivered', 'failed', 'conflict']),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().max(4000).optional(),
  /** Редакция источника, которую получатель считает текущей, при конфликте. */
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
