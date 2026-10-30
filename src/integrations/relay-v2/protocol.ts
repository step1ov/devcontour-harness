import { z } from 'zod';
import type { TransportErrorKind } from '../connector/transport.ts';

/**
 * Договор вывода Relay-2 CLI (`--format json`), проверенный на сборке
 * a3ee804: успех — одна JSON-строка `{ok:true,data,meta?}` в stdout и exit 0;
 * отказ — `{ok:false,error:{code,message,details?}}` в stderr и ненулевой exit.
 * Схемы проверяют только поля, которые читает адаптер; лишние поля допустимы.
 */

export const successSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
  meta: z.unknown().optional(),
});

export const failureSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

const nullableText = z
  .string()
  .nullable()
  .optional()
  .transform((v) => v ?? '');

export const columnSchema = z.enum([
  'inbox',
  'ready',
  'in-progress',
  'review',
  'done',
  'cancelled',
]);

/** Предел массива в ответе Relay-2: размер всего ответа ограничен транспортом. */
const MAX_ITEMS = 10_000;

/** Общий envelope записи: `{id, kind, key, revision, …, data}`. */
const envelope = <T extends z.ZodTypeAny>(kind: string, data: T) =>
  z.object({
    id: z.string().min(1),
    kind: z.literal(kind),
    key: z.string().min(1),
    revision: z.number().int().positive(),
    createdAt: z.string().optional(),
    createdBy: z.string().optional(),
    data,
  });

export const criterionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  summary: nullableText,
  description: nullableText,
  completed: z.boolean(),
});

export const commentSchema = z.object({
  id: z.string().min(1),
  title: nullableText,
  body: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
});

export const taskSchema = envelope(
  'task',
  z.object({
    title: z.string(),
    description: nullableText,
    column: columnSchema,
    parentId: z.string().nullable(),
    dependencies: z.array(z.string()).max(MAX_ITEMS),
    acceptanceCriteria: z.array(criterionSchema).max(MAX_ITEMS),
    comments: z.array(commentSchema).max(MAX_ITEMS).optional(),
  }),
);

export const progressSchema = z.object({
  completed: z.boolean(),
  canComplete: z.boolean(),
  blockers: z.array(z.string()).max(MAX_ITEMS),
});

export const documentSchema = envelope(
  'document',
  z.object({ name: z.string(), body: z.string() }),
);

export const sessionSchema = envelope(
  'work-session',
  z.object({
    title: z.string(),
    description: nullableText,
    status: z.enum(['pending', 'open', 'paused', 'completed', 'cancelled']),
    currentRunId: z.string().nullable(),
    parentSessionId: z.string().nullable(),
    result: nullableText,
  }),
);

export const checkpointSchema = envelope(
  'work-checkpoint',
  z.object({
    kind: z.enum(['intent', 'progress', 'result', 'cancel']),
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    intentId: z.string().nullable(),
    title: z.string(),
    body: z.string(),
  }),
);

export const storageStatusSchema = z.object({
  projectId: z.string().min(1),
  databasePath: z.string().min(1),
  generation: z.number().int().nonnegative(),
});

export const projectSchema = envelope('project', z.object({ name: z.string() }));

export const doctorSchema = z.object({
  projectId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  valid: z.boolean(),
  issues: z.array(z.unknown()).max(MAX_ITEMS),
});

export const pageMetaSchema = z.object({
  page: z.object({
    nextCursor: z.string().min(1).nullable(),
    consistency: z.string().optional(),
  }),
});

export const itemsSchema = z.object({ items: z.array(z.unknown()).max(MAX_ITEMS) });

/** Стабильный код Relay-2 → класс отказа транспорта. Exit code — только грубый класс. */
export function classifyCode(
  code: string,
  exit: number | null,
  mutation: boolean,
): TransportErrorKind {
  switch (code) {
    case 'REVISION_CONFLICT':
    case 'SNAPSHOT_CONFLICT':
    case 'CONFLICT':
    case 'STORAGE_BUSY':
      return 'conflict';
    case 'TASK_INCOMPLETE':
    case 'TASK_DONE':
    case 'TASK_CYCLE':
    case 'ACTOR_REQUIRED':
    case 'CONFLICTING_OPTIONS':
    case 'PROJECT_REQUIRED':
    case 'WORKSPACE_REQUIRED':
    case 'INVALID_CONFIG':
      return 'refused';
    case 'NOT_FOUND':
    case 'PROJECT_NOT_FOUND':
    case 'CONFIG_NOT_FOUND':
      return 'not-found';
  }
  if (code.startsWith('INVALID_') || code === 'VALIDATION_ERROR') return 'refused';
  // Неизвестный код: класс по exit. 2 — вход, 3 — нет записи, 4 — состояние;
  // все три — проверенный отказ до записи. Иное (1, сигнал) — сбой backend:
  // для мутации исход неизвестен.
  if (exit === 2) return 'refused';
  if (exit === 3) return 'not-found';
  if (exit === 4) return 'conflict';
  return mutation ? 'uncertain' : 'unavailable';
}
