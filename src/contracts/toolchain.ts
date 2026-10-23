import { z } from 'zod';
import { relativePathSchema } from './primitives.ts';

/**
 * Требования toolchain репозитория — не «тип проекта». Установка зависимостей,
 * команды задач, каталоги и окружение уже выражены шагами `prepare`, gates и
 * `environment`; здесь только то, чего из команд не вывести: какие версии
 * внешних исполняемых файлов проверены и какой менеджер пакетов явно выбран
 * для каталога, где лежат lockfiles нескольких менеджеров. Поле необязательное:
 * политика и профиль без него сохраняют прежний digest.
 */
export const toolNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Имя исполняемого файла без пути');
/** `1.12.3` — совпадают названные компоненты версии; `>=1.24` — не ниже. */
export const toolVersionSchema = z
  .string()
  .regex(/^(>=)?\d+(\.\d+){0,2}$/, 'Версия: 1.12.3 (точно) либо >=1.24 (не ниже)');
/** Каталог репозитория: `.` — корень. */
export const toolchainDirSchema = z.union([z.literal('.'), relativePathSchema]);
export const packageManagerSchema = z.enum(['npm', 'pnpm']);
export type PackageManager = z.infer<typeof packageManagerSchema>;

export const toolchainSchema = z.strictObject({
  /** Проверенные версии внешних исполняемых файлов (из PATH окружения harness). */
  tools: z
    .record(toolNameSchema, toolVersionSchema)
    .check(z.refine((t) => Object.keys(t).length <= 50, 'Не больше 50 инструментов'))
    .default({}),
  /**
   * Явный выбор менеджера пакетов каталога. Снимает неоднозначность, когда в
   * каталоге лежат lockfiles нескольких менеджеров; команда другого менеджера
   * в этом каталоге — конфликт композиции.
   */
  packageManagers: z
    .record(toolchainDirSchema, packageManagerSchema)
    .check(z.refine((t) => Object.keys(t).length <= 50, 'Не больше 50 каталогов'))
    .default({}),
});
export type Toolchain = z.infer<typeof toolchainSchema>;

const fieldSchema = z.array(z.union([z.string(), z.number()]));
const problemSchema = z.strictObject({
  code: z.string(),
  field: fieldSchema,
  path: z.string().optional(),
  message: z.string(),
});
/** Диагностика toolchain репозитория в ответе `doctor` (см. `src/toolchains`). */
export const toolchainReportSchema = z.strictObject({
  repositoryId: z.string(),
  root: z.string(),
  configSource: z.string().optional(),
  plan: z.array(
    z.strictObject({
      phase: z.enum([
        'prepare',
        'dependencyBuild',
        'preflight',
        'setup',
        'ready',
        'teardown',
        'gate',
      ]),
      id: z.string(),
      kind: z.enum(['check', 'test']).optional(),
      cwd: z.string(),
      argv: z.array(z.string()),
      report: z.string().optional(),
      field: fieldSchema,
    }),
  ),
  tools: z.array(
    z.strictObject({
      name: z.string(),
      provider: z.enum(['path', 'project']),
      found: z.boolean(),
      version: z.string().optional(),
      required: z.array(z.strictObject({ version: z.string(), source: z.string() })),
      usedBy: z.array(z.string()),
    }),
  ),
  lockfiles: z.array(
    z.strictObject({
      dir: z.string(),
      files: z.array(z.string()),
      manager: z.string().optional(),
      selectedBy: z.string().optional(),
    }),
  ),
  reports: z.array(z.strictObject({ gate: z.string(), path: z.string(), cwd: z.string() })),
  ambiguities: z.array(
    z.strictObject({
      field: fieldSchema,
      path: z.string().optional(),
      message: z.string(),
      resolvedBy: z.string().optional(),
    }),
  ),
  problems: z.array(problemSchema),
  warnings: z.array(problemSchema),
});
