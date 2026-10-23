import { z } from 'zod';
import { idSchema } from '../../contracts/index.ts';

/**
 * Нейтральный договор внешней памяти (Hindsight и подобные). Harness не
 * зависит от SDK, MCP или сетевого клиента: реальный адаптер реализует эти
 * два метода у себя и подключается явно, через opt-in entrypoint
 * `devcontour-harness/integrations/memory`. Ядро и `./contracts` этот модуль
 * не импортируют.
 */

/** Запрос recall: identity банка/проекта, текст и пределы, которые провайдер обязан соблюдать. */
export interface MemoryQuery {
  bank: string;
  project: string;
  text: string;
  maxItems: number;
  maxBytes: number;
  maxCostUnits?: number;
}

/**
 * Ответ recall — фактические байты тела ответа провайдера (`body`, JSON по
 * `memoryRecallBodySchema`). Байты закрепляются как есть: digest считается
 * от них, а не от пересобранного объекта.
 */
export interface MemoryRecallResponse {
  body: string;
}

export const memoryItemSchema = z.strictObject({
  id: z.string().min(1).max(200),
  text: z.string().max(1_000_000),
  score: z.number().optional(),
  /** Элемент, который нельзя отбросить по пределу: его обрезка — отказ, а не пометка. */
  mandatory: z.boolean().optional(),
});
export type MemoryItem = z.infer<typeof memoryItemSchema>;

export const memoryRecallBodySchema = z.strictObject({
  items: z.array(memoryItemSchema).max(10_000),
  /** Стоимость recall в единицах провайдера; учитывается отдельно от coding runtime. */
  costUnits: z.number().nonnegative().optional(),
  providerVersion: z.string().min(1).max(100).optional(),
});
export type MemoryRecallBody = z.infer<typeof memoryRecallBodySchema>;

/** Провайдер recall. Ошибка или ответ вне схемы — недоступность, а не пустой успех. */
export interface MemoryRecallProvider {
  readonly id: string;
  recall(query: MemoryQuery, signal: AbortSignal): Promise<MemoryRecallResponse>;
}

/**
 * Документ подтверждённого итога для retain. `documentId` — стабильная
 * identity одного результата (upsert документа); `operationId` — identity
 * одной операции доставки (идемпотентность асинхронного retain). Это разные
 * гарантии: upsert не предотвращает повторную асинхронную обработку.
 */
export interface MemoryDocument {
  bank: string;
  project: string;
  documentId: string;
  operationId: string;
  content: string;
  metadata: Record<string, string>;
}

export const memoryRetainAckSchema = z.strictObject({
  status: z.enum(['stored', 'accepted']),
  receipt: z.string().min(1).max(500).optional(),
  costUnits: z.number().nonnegative().optional(),
});
export type MemoryRetainAck = z.infer<typeof memoryRetainAckSchema>;

/** Провайдер retain. Исключение — сбой доставки памяти; harness записывает его отдельно. */
export interface MemoryRetainProvider {
  readonly id: string;
  retain(document: MemoryDocument, signal: AbortSignal): Promise<MemoryRetainAck>;
}

export type MemoryProvider = MemoryRecallProvider & MemoryRetainProvider;

/** ID провайдера входит в ID источника и получателя — та же форма, что у остальных ID. */
export const providerIdSchema = idSchema;
