import { z } from 'zod';
import { idSchema, targetRefSchema } from './primitives.ts';
import { profilePinSchema } from './profiles.ts';
import { API_VERSION } from './version.ts';

/**
 * Самостоятельный проект harness в репозитории пользователя. Каталог
 * `.harness/` хранит политику и рабочие файлы агента; manifest — локальные
 * решения подготовки (абсолютные пути), поэтому он не под Git. Состояние
 * исполнения живёт вне репозитория: worktrees попыток не вкладываются в checkout.
 */
export const HARNESS_PROJECT_DIR = '.harness';
export const PROJECT_MANIFEST_PATH = '.harness/project.json';
export const PROJECT_POLICY_PATH = '.harness/policy.json';
export const PROJECT_WORK_DIR = '.harness/work';
export const PROJECT_NOTES_DIR = '.harness/work/context/notes';

const runtimeSchema = z.enum(['claude', 'codex']);

export const projectManifestSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('harness-project'),
  manifestVersion: z.literal(1),
  projectId: z.string().regex(/^p-[0-9a-f]{16}$/),
  /** realpath корня при init. */
  root: z.string().min(1),
  repository: z.strictObject({ id: idSchema, targetRef: targetRefSchema }),
  profile: z.strictObject({ ref: z.string().min(1), pin: profilePinSchema }),
  runtimes: z.strictObject({ writer: runtimeSchema, reviewer: runtimeSchema }),
  paths: z.strictObject({
    policy: z.literal(PROJECT_POLICY_PATH),
    work: z.literal(PROJECT_WORK_DIR),
    notes: z.literal(PROJECT_NOTES_DIR),
    /** Абсолютный путь каталога состояния. */
    state: z.string().min(1),
  }),
});
export type ProjectManifest = z.infer<typeof projectManifestSchema>;

export const fileConflicts = [
  'symlink',
  'ancestor-not-directory',
  'not-regular-file',
  'content-differs',
  'outside-root',
] as const;
export const filePlanEntrySchema = z.strictObject({
  path: z.string(),
  action: z.enum(['create', 'preserve', 'conflict']),
  conflict: z.enum(fileConflicts).optional(),
  conflictPath: z.string().optional(),
});
