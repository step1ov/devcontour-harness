import { z } from 'zod';
import { POLICY_VERSION } from './version.ts';
import {
  gateRefSchema,
  idSchema,
  relativePathSchema,
  roleIdSchema,
  runtimeNameSchema,
  targetRefSchema,
  vendorOf,
} from './primitives.ts';
import { digestOf } from './digest.ts';
import type { ErrorIssue } from './errors.ts';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
/** Переменные `HARNESS_*` и исторические `DEVCONTOUR_*` задаёт сам harness, не политика. */
const envKey = envName.refine(
  (s) => !s.startsWith('HARNESS_') && !s.startsWith('DEVCONTOUR_'),
  'HARNESS_* и DEVCONTOUR_* задаёт harness',
);
export const environmentSchema = z.strictObject({
  inherit: z.array(envKey).default([]),
  values: z.record(envKey, z.string()).default({}),
  /** Имя переменной процесса → имя секрета окружения controller; значения в политику не входят. */
  secrets: z.record(envKey, envName).default({}),
});
export const stepSchema = z.strictObject({
  id: idSchema,
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().max(3_600_000).default(120000),
});
export const lifecycleSchema = z.strictObject({
  setup: z.array(stepSchema).default([]),
  ready: z.array(stepSchema).default([]),
  teardown: z.array(stepSchema).min(1),
});

export const gateSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(['check', 'test']),
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().positive().default(120000),
  /** Отчёт testcases. Для `test` exit 0 без свежего непустого отчёта не принимается. */
  report: z.strictObject({ type: z.literal('junit'), path: z.string().min(1) }).optional(),
  /** Генеративная проверка: путь отчёта свойств выбирает harness вне worktree. */
  property: z.strictObject({ path: relativePathSchema.optional() }).optional(),
  dependsOn: z.array(idSchema).optional(),
  cwd: relativePathSchema.optional(),
  resources: z.array(idSchema).optional(),
});
export type GatePolicy = z.infer<typeof gateSchema>;

/** Группы gates: не больше 100 групп по 100 ссылок, члены — gates или группы (`@имя`). */
export const gateGroupsSchema = z
  .record(idSchema, z.array(gateRefSchema).min(1).max(100))
  .refine((g) => Object.keys(g).length <= 100, 'Не больше 100 групп gates');

export const repositoryPolicySchema = z.strictObject({
  id: idSchema,
  /** Путь к checkout репозитория; относительный — от каталога политики. */
  path: z.string().min(1),
  kind: z.enum(['product', 'library']).default('product'),
  targetRef: targetRefSchema,
  dependsOn: z.array(idSchema).default([]),
  gates: z.array(gateSchema).min(1),
  gateGroups: gateGroupsSchema.optional(),
  protectedPaths: z.array(z.string().min(1)).default(['.github/', '.githooks/']),
  generatedPaths: z.array(relativePathSchema).default([]),
  environment: environmentSchema.optional(),
  lifecycle: lifecycleSchema.optional(),
  prepare: z.array(stepSchema).default([]),
  dependencyBuild: z.array(stepSchema).default([]),
  dependencyArtifacts: z.array(relativePathSchema).default([]),
  preflight: z.array(stepSchema).default([]),
});

export const runtimeBindingSchema = z.strictObject({
  runtime: runtimeNameSchema,
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  toolProfile: idSchema.optional(),
});
export type RuntimeBinding = z.infer<typeof runtimeBindingSchema>;

/**
 * Правило выбора reviewer для одного вида ревью. Reviewer задан явно: у
 * harness нет неявного «противоположного runtime». `different-vendor`
 * (умолчание) отклоняет reviewer того же вендора, что и writer;
 * `same-vendor-allowed` разрешает его, сохраняя отдельную роль, свежую
 * сессию и прежние условия приёмки.
 */
export const reviewRuleSchema = z.strictObject({
  reviewer: runtimeBindingSchema,
  vendor: z.enum(['different-vendor', 'same-vendor-allowed']).default('different-vendor'),
});
export type ReviewRule = z.infer<typeof reviewRuleSchema>;

export const roleBindingSchema = z.strictObject({
  writer: runtimeBindingSchema,
  /** Область записи роли по умолчанию; поручение сужает её своим writeScope. */
  writePaths: z.array(relativePathSchema).min(1).optional(),
  /** Ревью кода роли; нет поля — `review.code` политики. */
  review: reviewRuleSchema.optional(),
  requiresContract: z.boolean().default(false),
});

const budgetLimitSchema = z
  .strictObject({
    usd: z.number().positive().optional(),
    timeMs: z.number().int().positive().optional(),
  })
  .refine((l) => l.usd !== undefined || l.timeMs !== undefined, 'Задайте usd или timeMs');

export const toolProfileSchema = z.strictObject({
  runtime: z.enum(['codex', 'claude']),
  environment: environmentSchema.optional(),
  claudeTools: z.array(z.enum(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'])).optional(),
  claudeAllowedTools: z.array(z.string().min(1)).default([]),
  codexShell: z.boolean().default(true),
  codexNetwork: z.boolean().default(false),
});

/** Тариф модели за миллион токенов, USD. Форма совпадает с сохранёнными тарифами DevContour. */
export const priceSchema = z.strictObject({
  runtime: z.enum(['codex', 'claude']),
  model: z.string().min(1),
  effectiveAt: z.iso.datetime(),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});

/**
 * Политика исполнения: кто пишет и проверяет, какими gates, в какой
 * изоляции, с какими пределами. Digest политики закрепляется за попыткой;
 * попытка, выданная под другой политикой, под новой не принимается.
 */
export const executionPolicySchema = z.strictObject({
  policyVersion: z.literal(POLICY_VERSION),
  repositories: z.array(repositoryPolicySchema).min(1).max(10),
  roles: z.record(roleIdSchema, roleBindingSchema),
  review: z.strictObject({
    code: reviewRuleSchema,
    plan: reviewRuleSchema,
    contract: reviewRuleSchema,
  }),
  /** Режим технического согласования плана/контракта: агент-ревьюер или оператор. */
  approvalMode: z.enum(['agent', 'operator']).default('agent'),
  isolation: z
    .strictObject({
      mode: z.enum(['os', 'none']).default('os'),
      domains: z.array(z.string().min(1).max(253)).max(100).default([]),
    })
    .default({ mode: 'os', domains: [] }),
  toolProfiles: z.record(idSchema, toolProfileSchema).default({}),
  environment: environmentSchema.optional(),
  lifecycle: lifecycleSchema.optional(),
  resources: z
    .array(
      z.strictObject({
        id: idSchema,
        kind: z.enum(['device', 'port', 'account', 'service']),
        value: z.string().trim().min(1).max(300),
      }),
    )
    .default([]),
  concurrency: z.number().int().min(1).max(4).default(2),
  leaseMs: z.number().int().min(5000).default(30000),
  runTimeoutMs: z.number().int().min(1000).default(900000),
  reviewProbes: z
    .strictObject({
      commandTimeoutMs: z.number().int().min(1000).default(120000),
      budgetMs: z.number().int().min(1000).default(600000),
      reserveMs: z.number().int().min(0).default(120000),
    })
    .default({ commandTimeoutMs: 120000, budgetMs: 600000, reserveMs: 120000 }),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  repairBudget: z.number().int().min(0).max(50).default(6),
  reuseImplementation: z.boolean().default(true),
  budgets: z
    .strictObject({
      work: budgetLimitSchema.optional(),
      graph: budgetLimitSchema.optional(),
      total: budgetLimitSchema.optional(),
      onUnknown: z.enum(['stop', 'continue']).default('stop'),
    })
    .optional(),
  prices: z.array(priceSchema).max(100).default([]),
});
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
export type ExecutionPolicyInput = z.input<typeof executionPolicySchema>;

export const policyDigest = (policy: ExecutionPolicy) => digestOf(policy);

export type ReviewKind = 'code' | 'plan' | 'contract';

/**
 * Единственная точка выбора reviewer. Возвращает назначение или отказ с
 * кодом; другого пути назначить reviewer у движка нет.
 */
export function selectReviewer(
  policy: ExecutionPolicy,
  kind: ReviewKind,
  writer: { runtime: RuntimeBinding['runtime'] },
  role?: string,
):
  | { ok: true; reviewer: RuntimeBinding; sameVendor: boolean }
  | { ok: false; code: 'REVIEWER_SAME_VENDOR' | 'REVIEWER_MISSING'; message: string } {
  const rule =
    kind === 'code' && role !== undefined
      ? (policy.roles[role]?.review ?? policy.review.code)
      : policy.review[kind];
  if (!rule) return { ok: false, code: 'REVIEWER_MISSING', message: 'Не задан reviewer: ' + kind };
  const sameVendor = vendorOf(rule.reviewer.runtime) === vendorOf(writer.runtime);
  if (sameVendor && rule.vendor !== 'same-vendor-allowed')
    return {
      ok: false,
      code: 'REVIEWER_SAME_VENDOR',
      message: `Ревью ${kind}: reviewer ${rule.reviewer.runtime} того же вендора, что writer ${writer.runtime}; разрешите vendor: same-vendor-allowed явно`,
    };
  return { ok: true, reviewer: rule.reviewer, sameVendor };
}

/**
 * Согласованность политики, которую не выразить схемой: роли ссылаются на
 * объявленные профили, группы gates раскрываются без циклов и неизвестных
 * членов, пары writer/reviewer допустимы правилом вендора.
 */
export function policyIssues(policy: ExecutionPolicy): (ErrorIssue & { code: string })[] {
  const issues: (ErrorIssue & { code: string })[] = [];
  const repoIds = new Set<string>();
  policy.repositories.forEach((repo, r) => {
    if (repoIds.has(repo.id))
      issues.push({
        code: 'INVALID_INPUT',
        path: ['repositories', r, 'id'],
        message: 'Повтор репозитория',
      });
    repoIds.add(repo.id);
    const gates = new Set<string>();
    repo.gates.forEach((g, i) => {
      if (gates.has(g.id))
        issues.push({
          code: 'INVALID_INPUT',
          path: ['repositories', r, 'gates', i],
          message: 'Повтор gate ' + g.id,
        });
      gates.add(g.id);
    });
    for (const group of Object.keys(repo.gateGroups ?? {}))
      try {
        expandGateRefs(repo, ['@' + group]);
      } catch (error) {
        issues.push({
          code: (error as { code?: string }).code ?? 'GATE_UNKNOWN',
          path: ['repositories', r, 'gateGroups', group],
          message: (error as Error).message,
        });
      }
  });
  policy.repositories.forEach((repo, r) =>
    repo.dependsOn.forEach((dep, d) => {
      if (!repoIds.has(dep))
        issues.push({
          code: 'INVALID_INPUT',
          path: ['repositories', r, 'dependsOn', d],
          message: 'Неизвестный репозиторий ' + dep,
        });
    }),
  );
  for (const [role, binding] of Object.entries(policy.roles)) {
    for (const b of [binding.writer, binding.review?.reviewer])
      if (b?.toolProfile && !policy.toolProfiles[b.toolProfile])
        issues.push({
          code: 'INVALID_INPUT',
          path: ['roles', role],
          message: 'Неизвестный toolProfile ' + b.toolProfile,
        });
    const choice = selectReviewer(policy, 'code', binding.writer, role);
    if (!choice.ok)
      issues.push({ code: choice.code, path: ['roles', role], message: choice.message });
  }
  return issues;
}

/**
 * Раскрыть область в явный список gates репозитория: ID gates и группы
 * (`@имя`), рекурсивно, без циклов, в порядке первого появления; каждый gate
 * один раз. Неизвестный член, неизвестная группа и цикл — отказ с кодом.
 * Без области — все gates репозитория. Раскрытая группа повторно не
 * обходится: общий подграф иначе стоил бы экспоненциально.
 */
export function expandGateRefs(
  repo: Pick<z.infer<typeof repositoryPolicySchema>, 'gates' | 'gateGroups' | 'id'>,
  refs?: string[],
): string[] {
  if (!refs?.length) return repo.gates.map((g) => g.id);
  const fail = (code: 'GATE_GROUP_CYCLE' | 'GATE_UNKNOWN', message: string) =>
    Object.assign(new Error(message), { code });
  const out: string[] = [];
  const done = new Set<string>();
  const visit = (ref: string, path: string[]) => {
    if (ref.startsWith('@')) {
      const name = ref.slice(1);
      if (done.has(name)) return;
      if (path.includes(name))
        throw fail('GATE_GROUP_CYCLE', 'Цикл в группах gates: ' + [...path, name].join(' → '));
      const members = repo.gateGroups?.[name];
      if (!members) throw fail('GATE_UNKNOWN', `Неизвестная группа gates ${repo.id}: ${name}`);
      for (const member of members) visit(member, [...path, name]);
      done.add(name);
      return;
    }
    if (!repo.gates.some((g) => g.id === ref))
      throw fail('GATE_UNKNOWN', `Проверка вне профиля ${repo.id}: ${ref}`);
    if (!out.includes(ref)) out.push(ref);
  };
  for (const ref of refs) visit(ref, []);
  return out;
}
