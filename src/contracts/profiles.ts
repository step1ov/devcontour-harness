import { z } from 'zod';
import { idSchema, relativePathSchema, roleIdSchema } from './primitives.ts';
import { environmentSchema, gateSchema, lifecycleSchema, stepSchema } from './policy.ts';

/**
 * Профиль стека — переносимый файл, из которого собирается описание
 * репозитория в политике: gates, подготовка, окружение, lifecycle,
 * защищённые пути, роли и инструкции стека. Профиль только описывает:
 * разрешение читает манифесты и не исполняет ни одной команды проекта.
 *
 * Форма файла совпадает с профилями, которые уже закреплены у потребителей
 * (их digest — sha256 байтов файла), поэтому встроенные профили переносятся
 * побайтно.
 */
export const PROFILE_FILE_LIMIT = 131072;
export const PROFILE_FILES_LIMIT = 32;
export const PROFILE_DEPTH_LIMIT = 16;

const profileVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
const profileRuntimeSchema = z.enum(['codex', 'claude']);

/** Привязка runtime в профиле: кто пишет или проверяет у роли. */
export const profileBindingSchema = z.strictObject({
  runtime: profileRuntimeSchema,
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  toolProfile: idSchema.optional(),
});

/** Роль, которую требует поверхность стека. `title` — подпись для людей, harness её не читает. */
export const profileRoleSchema = profileBindingSchema.extend({
  writePaths: z.array(relativePathSchema).min(1).optional(),
  reviewer: profileBindingSchema.optional(),
  title: z.string().trim().min(2).max(40).optional(),
  requiresContract: z.boolean().optional(),
});

/**
 * Инструкции стека: файлы, которые хост закрепляет как контекст ролей
 * (`files` — вкладываются в запрос, `references` — только называются).
 * Harness их не читает и не копирует: закреплять их — дело ContextSource.
 */
export const profileContextPackSchema = z.strictObject({
  id: idSchema,
  version: z.string().min(1).max(80),
  repositoryId: idSchema.optional(),
  roles: z.array(roleIdSchema).default([]),
  files: z.array(relativePathSchema).min(1).max(30),
  references: z.array(relativePathSchema).max(60).default([]),
});

/** Gate в профиле: та же форма, что в политике; отсутствие JUnit у test gate называется явно. */
export const profileGateSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(['check', 'test']),
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().positive().default(120000),
  report: z.strictObject({ type: z.literal('junit'), path: relativePathSchema }).optional(),
  property: z.strictObject({ path: relativePathSchema.optional() }).optional(),
  dependsOn: z.array(idSchema).optional(),
  cwd: relativePathSchema.optional(),
  resources: z.array(idSchema).optional(),
});

export const stackProfileSchema = z.strictObject({
  id: idSchema,
  version: profileVersionSchema,
  /** Встроенный ID или относительный `./file.json` внутри репозитория. */
  extends: z.array(z.string().min(1)).max(PROFILE_DEPTH_LIMIT).default([]),
  capabilities: z.array(z.string().min(1).max(100)).max(100).default([]),
  gates: z.array(profileGateSchema).max(100).default([]),
  prepare: z.array(stepSchema).max(100).default([]),
  environment: environmentSchema.optional(),
  lifecycle: lifecycleSchema.optional(),
  protectedPaths: z.array(relativePathSchema).max(100).default([]),
  generatedPaths: z.array(relativePathSchema).max(100).default([]),
  concurrency: z.number().int().min(1).max(4).optional(),
  /** Сколько времени стек отводит одной попытке; слои берут наибольший предел. */
  runTimeoutMs: z.number().int().min(60_000).max(7_200_000).optional(),
  roles: z.record(roleIdSchema, profileRoleSchema).default({}),
  contextPacks: z.array(profileContextPackSchema).max(50).default([]),
});
export type StackProfile = z.infer<typeof stackProfileSchema>;

export const profileSourceSchema = z.strictObject({
  repositoryId: idSchema,
  path: relativePathSchema,
});

/** Закрепление профиля: digest — по байтам листа (один файл) или по замыканию слоёв. */
export const profilePinSchema = z.strictObject({
  id: idSchema,
  version: profileVersionSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  source: profileSourceSchema.optional(),
});
export type ProfilePin = z.infer<typeof profilePinSchema>;

/** Разрешённый профиль: слои сложены, gates упорядочены и проверены. */
export const resolvedProfileSchema = z.strictObject({
  id: idSchema,
  version: profileVersionSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  capabilities: z.array(z.string()),
  gates: z.array(gateSchema),
  prepare: z.array(stepSchema),
  environment: environmentSchema.optional(),
  lifecycle: lifecycleSchema.optional(),
  protectedPaths: z.array(relativePathSchema),
  generatedPaths: z.array(relativePathSchema),
  concurrency: z.number().int().optional(),
  runTimeoutMs: z.number().int().optional(),
  roles: z.record(roleIdSchema, profileRoleSchema),
  contextPacks: z.array(profileContextPackSchema),
  source: profileSourceSchema.optional(),
  closure: z.array(z.strictObject({ ref: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) })),
});
export type ResolvedProfile = z.infer<typeof resolvedProfileSchema>;
