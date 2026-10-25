import { z } from 'zod';
import { errorCodes, HarnessError, type ErrorCode } from './errors.ts';
import {
  digestSchema,
  gateRefSchema,
  idSchema,
  relativePathPattern,
  roleIdSchema,
} from './primitives.ts';
import { consumerSchema, propertyIdSchema, workGraphSchema } from './work.ts';

/**
 * Draft плана: то, что ведущий агент (или хост) предлагает до проверки и
 * согласования. Это не WorkGraph: ключи задач локальные, пути и пределы —
 * форма постановки, а пределы исполняемого поручения проверяет `draftToGraph`.
 * Объекты — `z.object`, а не strict: лишние ключи (например «approved»)
 * отбрасываются, прежние допустимые планы хоста остаются допустимыми.
 */

/**
 * Путь draft: то же правило, что `relativePathSchema`, но проверкой refine —
 * в JSON Schema остаются только длины, как у прежней схемы плана хоста.
 */
const relativePath = new RegExp(relativePathPattern);
export const draftPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => relativePath.test(p), 'Ожидается относительный путь без glob, . или ..');

export const draftRequirementSchema = z.strictObject({
  id: z.string().regex(/^REQ-[A-Za-z0-9_-]{1,64}$/),
  source: draftPathSchema,
  digest: digestSchema,
  text: z.string().min(3).max(12000),
  gate: idSchema,
  scenario: z.string().min(3).max(1500),
  testId: z.string().min(1).max(300).optional(),
});

/** Общие поля задачи draft. Порядок ключей нормативен: по нему строится JSON Schema. */
export const planDraftTaskShape = {
  requirements: z.array(draftRequirementSchema).max(30).optional(),
  scope: z.enum(['component', 'workspace']).default('component'),
  relatedRepositories: z.array(idSchema).optional(),
  contextPacks: z.array(idSchema).max(30).optional(),
  writePaths: z.array(draftPathSchema).min(1).max(100).optional(),
  gates: z.array(gateRefSchema).max(20).optional(),
  properties: z.array(propertyIdSchema).max(30).optional(),
  resources: z.array(idSchema).max(20).optional(),
  repositoryId: z.string().default('main'),
  key: z.string().regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().min(3).max(180),
  description: z.string().min(10).max(12000),
  role: roleIdSchema,
  dependsOn: z.array(z.string()),
  acceptance: z.array(z.string().min(3)).min(1),
  contracts: z.array(z.string()),
};
export type PlanDraftTaskShape = typeof planDraftTaskShape;

/**
 * Схема draft с полями хоста. `keyOrder` — полная перестановка ключей задачи:
 * хост сохраняет прежний порядок полей своей схемы (а с ним байты JSON Schema
 * и digest своего каталога). Без него — общие поля, затем поля расширения.
 */
export function planDraft<E extends z.ZodRawShape = Record<never, never>>(
  taskExtension?: E,
  options: { keyOrder?: readonly string[] } = {},
) {
  const extension = (taskExtension ?? {}) as E;
  for (const [key, value] of Object.entries(extension)) {
    if (Object.hasOwn(planDraftTaskShape, key))
      throw new HarnessError(
        'INVALID_INPUT',
        'Расширение задачи draft не переопределяет общее поле: ' + key,
      );
    if (!(value instanceof z.ZodType))
      throw new HarnessError('INVALID_INPUT', 'Расширение задачи draft: поле не схема Zod: ' + key);
  }
  const merged: Record<string, unknown> = { ...planDraftTaskShape, ...extension };
  let shape = merged;
  if (options.keyOrder !== undefined) {
    // Плотная копия: дыра разреженного массива становится undefined и не
    // проходит проверку (every пропускает дыры).
    const order: unknown[] = Array.isArray(options.keyOrder) ? Array.from(options.keyOrder) : [];
    const keys = Object.keys(merged);
    if (
      order.length !== keys.length ||
      new Set(order).size !== order.length ||
      !order.every((k) => typeof k === 'string' && Object.hasOwn(merged, k))
    )
      throw new HarnessError(
        'INVALID_INPUT',
        'keyOrder: ожидается перестановка всех ключей задачи draft',
      );
    shape = Object.fromEntries((order as string[]).map((k) => [k, merged[k]!]));
  }
  return z.object({
    title: z.string().min(3).max(180),
    description: z.string().max(5000),
    tasks: z
      .array(z.object(shape as unknown as PlanDraftTaskShape & E))
      .min(1)
      .max(30),
  });
}

/** Draft самостоятельного проекта: общие поля и проверка потребителей библиотеки. */
export const planDraftSchema = planDraft({
  consumers: z.array(consumerSchema).max(10).optional(),
});
export type PlanDraft = z.output<ReturnType<typeof planDraft<Record<never, never>>>>;
export type StandalonePlanDraft = z.output<typeof planDraftSchema>;

/** JSON Schema draft для `--output-schema` runtime и для агента. */
export function planDraftJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

/** Факты проекта, по которым составляется и проверяется план. */
export interface PlanningFacts {
  repositories: { id: string; name?: string; kind?: string; path: string }[];
  roles: {
    repositoryId: string;
    roles: { role: string; title?: string; writePaths?: string[]; requiresContract: boolean }[];
  }[];
  gates: {
    repositoryId: string;
    gates: { id: string; kind: string }[];
    groups?: Record<string, string[]>;
  }[];
  contextPacks: {
    id: string;
    version?: string;
    repositoryId?: string;
    roles?: string[];
    files?: string[];
  }[];
  resources: { id: string; kind: string }[];
  /** Записи контрактов целиком: prompt получает их как есть. */
  contracts: (Record<string, unknown> & { id: string; digest: string })[];
}

export const planningFactsSchema = z.strictObject({
  repositories: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string().optional(),
      kind: z.string().optional(),
      path: z.string(),
    }),
  ),
  roles: z.array(
    z.strictObject({
      repositoryId: z.string(),
      roles: z.array(
        z.strictObject({
          role: z.string(),
          title: z.string().optional(),
          writePaths: z.array(z.string()).optional(),
          requiresContract: z.boolean(),
        }),
      ),
    }),
  ),
  gates: z.array(
    z.strictObject({
      repositoryId: z.string(),
      gates: z.array(z.strictObject({ id: z.string(), kind: z.string() })),
      groups: z.record(z.string(), z.array(z.string())).optional(),
    }),
  ),
  contextPacks: z.array(
    z.strictObject({
      id: z.string(),
      version: z.string().optional(),
      repositoryId: z.string().optional(),
      roles: z.array(z.string()).optional(),
      files: z.array(z.string()).optional(),
    }),
  ),
  resources: z.array(z.strictObject({ id: z.string(), kind: z.string() })),
  contracts: z.array(z.looseObject({ id: z.string(), digest: z.string() })),
});

export const codedIssueSchema = z.strictObject({
  code: z.enum(Object.keys(errorCodes) as [ErrorCode, ...ErrorCode[]]),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

/** Чего не хватает для проверки плана: агент готовит проверку, а не убирает её. */
export const checkGapKinds = ['gate-undeclared', 'test-gate-missing'] as const;
export const checkGapSchema = z.strictObject({
  kind: z.enum(checkGapKinds),
  taskKey: z.string(),
  repositoryId: z.string(),
  /** gate или группа, как написана в draft. */
  ref: z.string().optional(),
  /** Объявленные test gates репозитория — из них агент выбирает. */
  testGates: z.array(z.string()),
  action: z.enum(['declare-gate', 'add-test-gate']),
});
export type CheckGap = z.infer<typeof checkGapSchema>;

/** `plan-request`: запрос планирования для ведущего агента; модель не вызывается. */
export const planRequestDataSchema = z.strictObject({
  prompt: z.string(),
  readOnly: z.literal(true),
  recommendedTasks: z.number().int().min(1).max(30),
  maxTasks: z.literal(30),
  /** digest постановки и фактов: draft по другому basis устарел. */
  basis: digestSchema,
  facts: planningFactsSchema,
  draftSchema: z.literal('plan-draft'),
});

/** `plan-check`: проблемы draft либо собранный граф; согласования не выдаёт. */
export const planCheckDataSchema = z.strictObject({
  issues: z.array(codedIssueSchema),
  checkPlan: z.array(checkGapSchema),
  graph: workGraphSchema.optional(),
  graphDigest: digestSchema.optional(),
  basis: digestSchema.optional(),
});
