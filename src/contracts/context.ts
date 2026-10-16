import { z } from 'zod';
import { API_VERSION } from './version.ts';
import { digestSchema, gitShaSchema, idSchema, relativePathSchema } from './primitives.ts';
import { digestOf } from './digest.ts';

const pinnedFileSchema = z.strictObject({
  path: relativePathSchema,
  digest: digestSchema,
  bytes: z.number().int().nonnegative(),
});

/**
 * Закреплённый контекст попытки. `files` вкладываются в запрос исполнителю,
 * `references` только называются; содержимое обоих входит в digest:
 * изменилась справка — закрепление недействительно.
 *
 * `required: true` — без этого источника попытка не начинается (отказ
 * окружения, не засчитывается); `false` — дополнительный, его отсутствие
 * записывается в ограничения результата.
 */
export const contextSourceEntrySchema = z.strictObject({
  id: idSchema,
  kind: idSchema,
  version: z.string().min(1).max(100),
  repositoryId: idSchema.optional(),
  /** Коммит, из которого прочитан источник, если он живёт в Git. */
  revision: gitShaSchema.optional(),
  required: z.boolean(),
  files: z.array(pinnedFileSchema).max(30),
  references: z.array(pinnedFileSchema).max(60).default([]),
  digest: digestSchema,
});
export type ContextSourceEntry = z.infer<typeof contextSourceEntrySchema>;

export const contextSnapshotSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  sources: z.array(contextSourceEntrySchema).max(30),
});
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;

export const contextDigest = (snapshot: ContextSnapshot) => digestOf(snapshot);
