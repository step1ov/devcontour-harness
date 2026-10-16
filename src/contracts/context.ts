import { z } from 'zod';
import { API_VERSION } from './version.ts';
import { digestSchema, gitShaSchema, idSchema, relativePathSchema } from './primitives.ts';
import { digestOf, sha256 } from './digest.ts';

/**
 * Закреплённый файл контекста вместе с содержимым. Содержимое передаётся
 * в снимке, а не восстанавливается по пути: источник может не быть Git
 * (память, внешний сервис), и движок обязан получить ровно те байты, на
 * которые выдан digest. `digest` — SHA-256 байтов содержимого; движок
 * сверяет его при приёме снимка и при каждом использовании.
 */
export const pinnedFileSchema = z.strictObject({
  path: relativePathSchema,
  digest: digestSchema,
  bytes: z.number().int().nonnegative(),
  content: z.discriminatedUnion('encoding', [
    z.strictObject({ encoding: z.literal('utf8'), data: z.string() }),
    z.strictObject({
      encoding: z.literal('base64'),
      data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
    }),
  ]),
});
export type PinnedFile = z.infer<typeof pinnedFileSchema>;

/**
 * Источник контекста попытки. `files` вкладываются в запрос исполнителю,
 * `references` только называются, но их содержимое тоже закреплено и входит
 * в digest: изменилась справка — закрепление недействительно.
 *
 * `required: true` — без источника попытка не начинается (отказ окружения,
 * попытка не засчитывается); `false` — дополнительный, его отсутствие
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
  /** Digest источника: `sourceDigest(entry)`. */
  digest: digestSchema,
  /**
   * Digest закрепления по формуле хоста (у DevContour — digest контекстного
   * пакета в `Run.context`), если он есть. Движок его не пересчитывает и
   * переносит в `ContextPin.digest` как есть.
   */
  hostDigest: digestSchema.optional(),
});
export type ContextSourceEntry = z.infer<typeof contextSourceEntrySchema>;

/** Пределы снимка: файл и сумма содержимого, байт. */
export const CONTEXT_LIMITS = { fileBytes: 2 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 } as const;

export const contextSnapshotSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  sources: z.array(contextSourceEntrySchema).max(30),
  /** Отсутствующие дополнительные источники: ID и причина. */
  missing: z
    .array(z.strictObject({ id: idSchema, reason: z.string().min(1).max(1000) }))
    .default([]),
});
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;

/**
 * Краткая ссылка попытки на закреплённый источник — форма `Run.context`
 * DevContour. Полный снимок хранится отдельно по digest.
 */
export const contextPinSchema = z.strictObject({
  id: idSchema,
  version: z.string().min(1).max(100),
  repositoryId: idSchema,
  revision: z.string().min(1).max(64),
  digest: digestSchema,
});
export type ContextPin = z.infer<typeof contextPinSchema>;

const bytesOf = (file: PinnedFile) =>
  file.content.encoding === 'utf8'
    ? Buffer.from(file.content.data, 'utf8')
    : Buffer.from(file.content.data, 'base64');

/** Digest источника: id, версия, ревизия и digests всех файлов и справок по порядку. */
export const sourceDigest = (entry: Omit<ContextSourceEntry, 'digest'>) =>
  digestOf({
    id: entry.id,
    kind: entry.kind,
    version: entry.version,
    revision: entry.revision ?? null,
    files: entry.files.map((f) => [f.path, f.digest]),
    references: (entry.references ?? []).map((f) => [f.path, f.digest]),
  });

export const contextDigest = (snapshot: ContextSnapshot) => digestOf(snapshot);

/**
 * Проверка снимка: digest каждого файла равен SHA-256 его байтов, `bytes`
 * совпадает, digest источника пересчитывается, пределы соблюдены, ID
 * источников и пути внутри источника не повторяются. Возвращает нарушения.
 */
export function contextIssues(snapshot: ContextSnapshot): string[] {
  const issues: string[] = [];
  let total = 0;
  const ids = new Set<string>();
  for (const source of snapshot.sources) {
    if (ids.has(source.id)) issues.push('Повтор источника ' + source.id);
    ids.add(source.id);
    const paths = new Set<string>();
    for (const file of [...source.files, ...source.references]) {
      const bytes = bytesOf(file);
      total += bytes.length;
      if (paths.has(file.path)) issues.push(`${source.id}: повтор файла ${file.path}`);
      paths.add(file.path);
      if (bytes.length !== file.bytes)
        issues.push(`${source.id}/${file.path}: размер не совпадает`);
      if (sha256(bytes) !== file.digest)
        issues.push(`${source.id}/${file.path}: digest не совпадает с содержимым`);
      if (bytes.length > CONTEXT_LIMITS.fileBytes)
        issues.push(`${source.id}/${file.path}: файл больше предела`);
    }
    if (sourceDigest(source) !== source.digest)
      issues.push(`${source.id}: digest источника не совпадает`);
  }
  if (total > CONTEXT_LIMITS.totalBytes) issues.push('Снимок больше предела');
  for (const m of snapshot.missing)
    if (ids.has(m.id)) issues.push(`${m.id}: источник и присутствует, и отсутствует`);
  return issues;
}

/** Байты закреплённого файла после проверки digest; несовпадение — исключение. */
export function pinnedBytes(file: PinnedFile): Buffer {
  const bytes = bytesOf(file);
  if (sha256(bytes) !== file.digest)
    throw new Error('Содержимое не совпадает с закреплённым digest: ' + file.path);
  return bytes;
}
