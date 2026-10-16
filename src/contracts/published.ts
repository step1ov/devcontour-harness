import type { z } from 'zod';
import { workGraphSchema, workOrderSchema } from './work.ts';
import { executionPolicySchema } from './policy.ts';
import { contextSnapshotSchema } from './context.ts';
import { jointVerificationSchema, resultEnvelopeSchema, runResultSchema } from './result.ts';
import { runEventSchema } from './events.ts';
import { reviewRecordSchema } from './review.ts';
import { executionDocumentSchema } from './execution.ts';
import { contractDocumentSchema } from './checks.ts';
import { stackProfileSchema } from './profiles.ts';

/**
 * Схемы, публикуемые как JSON Schema (`schemas/<имя>.schema.json`).
 *
 * JSON Schema выражает всё, что относится к одному значению: типы,
 * обязательность, закрытость объектов, пределы, регулярные выражения путей
 * и refs, варианты исходов. Связи *между* значениями — граф без циклов и
 * неизвестных зависимостей, согласованность политики, связь поручений с
 * политикой, совпадение содержимого контекста с digests — проверяют
 * `graphIssues`, `policyIssues`, `crossIssues`, `contextIssues` и CLI
 * `harness validate`; JSON Schema их не заменяет.
 */
export const publishedSchemas = {
  'work-order': workOrderSchema,
  'work-graph': workGraphSchema,
  'execution-policy': executionPolicySchema,
  'context-snapshot': contextSnapshotSchema,
  'contract-document': contractDocumentSchema,
  'run-result': runResultSchema,
  'result-envelope': resultEnvelopeSchema,
  'run-event': runEventSchema,
  'review-record': reviewRecordSchema,
  'joint-verification': jointVerificationSchema,
  'execution-document': executionDocumentSchema,
  'stack-profile': stackProfileSchema,
} as const satisfies Record<string, z.ZodType>;
