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

/**
 * Причины инспекции репозитория (`inspectProject`). `blocker` не даёт начать
 * подготовку, `warning` требует решения или внимания, `info` — факт.
 */
export const projectDiagnosticCodes = [
  'path-missing',
  'not-directory',
  'not-git-repository',
  'inside-repository',
  'git-worktree',
  'no-commits',
  'dirty-checkout',
  'stack-ambiguous',
  'stack-unsupported',
  'profile-invalid',
  'package-json-missing',
  'package-json-invalid',
  'manager-mismatch',
  'no-check-scripts',
  'tool-missing',
  'tool-version-error',
  'tool-version-mismatch',
  'runtime-missing',
  'runtime-version-error',
  'devcontour-owned',
  'harness-project',
] as const;
export type ProjectDiagnosticCode = (typeof projectDiagnosticCodes)[number];

const toolStatus = z.enum(['ok', 'missing', 'version-error', 'mismatch']);

/**
 * Факты готовности репозитория к первому запуску: только чтение файлов, Git
 * без optional locks и пробы `--version` вне репозитория. Не создаёт
 * `.harness`, state и refs; не исполняет scripts манифестов и не вызывает
 * модели. Авторизация runtime неизвестна (`auth: 'unknown'`): наличие CLI её
 * не подтверждает. Правила размещения и владения применяет вызывающий.
 */
export const projectFactsSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('project-facts'),
  /** Абсолютный путь, который инспектировали. */
  path: z.string().min(1),
  git: z.strictObject({
    /** realpath верхнего уровня Git; null — не Git. */
    root: z.string().nullable(),
    /** `linked` — дополнительный worktree, а не основной checkout. */
    worktree: z.enum(['main', 'linked']).nullable(),
    baseSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .nullable(),
    branch: z.string().nullable(),
    /** Изменения рабочего дерева и индекса, без игнорируемых; null — неизвестно. */
    dirty: z.boolean().nullable(),
    /** Первые 50 изменённых путей (`git status`), без игнорируемых. */
    changes: z.array(z.string()).max(50),
    /** Сколько всего изменённых путей; больше 50 — список `changes` усечён. null — неизвестно. */
    changeCount: z.number().int().min(0).nullable(),
  }),
  /** Lockfiles корня по известным менеджерам. */
  lockfiles: z.array(z.string()),
  packageManager: z.strictObject({
    status: z.enum(['detected', 'ambiguous', 'none']),
    name: z.enum(['npm', 'pnpm']).optional(),
    lockfile: z.string().optional(),
    /** Поле `packageManager` package.json как есть. */
    declared: z.strictObject({ name: z.string(), version: z.string().optional() }).optional(),
  }),
  /** Встроенные профили стека, подходящие по lockfile, с digest. */
  profiles: z.array(profilePinSchema),
  /** Scripts корневого package.json — данные, не исполняются. */
  scripts: z.array(z.strictObject({ name: z.string(), command: z.string() })),
  /** Имена scripts, похожих на проверки (check, test, typecheck, lint, build…). */
  checks: z.array(z.string()),
  tools: z.array(
    z.strictObject({
      name: z.string(),
      status: toolStatus,
      version: z.string().optional(),
      required: z.strictObject({ version: z.string(), source: z.string() }).optional(),
    }),
  ),
  runtimes: z.array(
    z.strictObject({
      runtime: runtimeSchema,
      status: z.enum(['available', 'missing', 'version-error']),
      version: z.string().optional(),
      auth: z.literal('unknown'),
    }),
  ),
  markers: z.strictObject({
    /** Маркеры DevContour в корне: факт, не повод создавать controller. */
    devcontour: z.array(z.string()),
    harnessProject: z.boolean(),
  }),
  diagnostics: z.array(
    z.strictObject({
      code: z.enum(projectDiagnosticCodes),
      severity: z.enum(['blocker', 'warning', 'info']),
      message: z.string(),
      action: z.string(),
      path: z.string().optional(),
    }),
  ),
  /** Нет диагностик `blocker`. */
  ready: z.boolean(),
});
export type ProjectFacts = z.infer<typeof projectFactsSchema>;
