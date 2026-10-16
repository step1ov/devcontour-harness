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
  type Author,
  trimmedText,
} from './primitives.ts';
import { digestOf } from './digest.ts';
import type { ErrorIssue } from './errors.ts';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
/** Переменные `HARNESS_*` и исторические `DEVCONTOUR_*` задаёт сам harness, не политика. */
const envKey = z
  .string()
  .regex(
    /^(?!HARNESS_|DEVCONTOUR_)[A-Za-z_][A-Za-z0-9_]*$/,
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

const gateCommon = {
  id: idSchema,
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().positive().default(120000),
  /** Генеративная проверка: путь отчёта свойств выбирает harness вне worktree. */
  property: z.strictObject({ path: relativePathSchema.optional() }).optional(),
  dependsOn: z.array(idSchema).optional(),
  cwd: relativePathSchema.optional(),
  resources: z.array(idSchema).optional(),
};
/** Отчёт testcases внутри worktree. */
const junitReport = z.strictObject({ type: z.literal('junit'), path: relativePathSchema });
/**
 * Gate. У `test` JUnit-отчёт обязателен: exit 0 без свежего непустого
 * отчёта на точном SHA не принимается. `check` — проверка без testcases.
 */
export const gateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...gateCommon, kind: z.literal('test'), report: junitReport }),
  z.strictObject({ ...gateCommon, kind: z.literal('check'), report: junitReport.optional() }),
]);
export type GatePolicy = z.infer<typeof gateSchema>;

/** Группы gates: не больше 100 групп по 100 ссылок, члены — gates или группы (`@имя`). */
export const gateGroupsSchema = z
  .record(idSchema, z.array(gateRefSchema).min(1).max(100))
  .check(z.refine((g) => Object.keys(g).length <= 100, 'Не больше 100 групп gates'))
  .meta({ maxProperties: 100 });

/** Gate совместной проверки: выполняется в дереве `repositoryId`, сохраняет `artifacts`. */
export const workspaceGateSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...gateCommon,
    kind: z.literal('test'),
    report: junitReport,
    repositoryId: idSchema,
    artifacts: z.array(relativePathSchema).default([]),
  }),
  z.strictObject({
    ...gateCommon,
    kind: z.literal('check'),
    report: junitReport.optional(),
    repositoryId: idSchema,
    artifacts: z.array(relativePathSchema).default([]),
  }),
]);

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

/** Предел расходов (USD) и/или времени вызовов; хотя бы одно поле — выражено вариантами. */
const budgetLimitSchema = z.union([
  z.strictObject({ usd: z.number().positive(), timeMs: z.number().int().positive().optional() }),
  z.strictObject({ usd: z.number().positive().optional(), timeMs: z.number().int().positive() }),
]);

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
  /**
   * `live` — настоящие runtime; `fixture` — управляемые ответы для тестов и
   * демо. Runtime `fixture` допустим только в режиме `fixture`, и режим не
   * выбирается сам при отсутствии учётных данных.
   */
  mode: z.enum(['live', 'fixture']).default('live'),
  /** Gates совместной проверки закреплённой комбинации репозиториев. */
  workspaceGates: z.array(workspaceGateSchema).default([]),
  /** `affected` — только изменённые компоненты и их транзитивные потребители. */
  verificationMode: z.enum(['all', 'affected']).default('all'),
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
        value: trimmedText(1, 300),
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
      /** Поручение. */
      work: budgetLimitSchema.optional(),
      /** Группа хоста (доска DevContour со всеми ревизиями; standalone — граф). */
      group: budgetLimitSchema.optional(),
      /** Вся установка. */
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
  writer: { runtime: Author },
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

type Issue = ErrorIssue & { code: string };
type Repo = z.infer<typeof repositoryPolicySchema>;

/** Gates в порядке зависимостей; повтор, неизвестная зависимость и цикл — нарушения. */
export function gateOrderIssues(
  gates: { id: string; dependsOn?: string[] }[],
): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  const byId = new Map<string, { id: string; dependsOn?: string[] }>();
  for (const g of gates) {
    if (byId.has(g.id)) issues.push({ code: 'INVALID_INPUT', message: 'Повтор gate ' + g.id });
    byId.set(g.id, g);
  }
  const active = new Set<string>();
  const seen = new Set<string>();
  const visit = (id: string, from: string) => {
    if (active.has(id)) {
      issues.push({ code: 'GATE_GROUP_CYCLE', message: 'Цикл зависимостей gates: ' + id });
      return;
    }
    if (seen.has(id)) return;
    const gate = byId.get(id);
    if (!gate) {
      issues.push({ code: 'GATE_UNKNOWN', message: `Неизвестная зависимость gate ${from}: ${id}` });
      return;
    }
    active.add(id);
    for (const parent of gate.dependsOn ?? []) visit(parent, id);
    active.delete(id);
    seen.add(id);
  };
  for (const g of gates) visit(g.id, g.id);
  return issues;
}

/**
 * Согласованность политики, которую не выразить схемой, — проверки
 * DevContour `validateWorkflow` и загрузки конфигурации, перенесённые без
 * ослабления: компоненты без циклов, gates упорядочиваемы, у репозитория
 * есть test gate, зарезервированный gate не объявлен, шаги уникальны,
 * ресурсы известны и корректны, профили инструментов совместимы с runtime,
 * `effort` только для codex, `fixture` только в режиме `fixture`, пары
 * writer/reviewer допустимы правилом вендора.
 */
export function policyIssues(policy: ExecutionPolicy): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, path: (string | number)[], message: string) =>
    issues.push({ code, path, message });
  const repos = new Map<string, Repo>();
  // Тариф однозначен: у модели не бывает двух тарифов на один момент.
  const tariffs = new Set<string>();
  policy.prices.forEach((p, i) => {
    const key = JSON.stringify([p.runtime, p.model, Date.parse(p.effectiveAt)]);
    if (tariffs.has(key))
      add(
        'INVALID_INPUT',
        ['prices', i],
        `Повтор тарифа ${p.runtime}/${p.model} на ${p.effectiveAt}`,
      );
    tariffs.add(key);
  });
  const resourceIds = new Set<string>();
  policy.resources.forEach((r, i) => {
    if (resourceIds.has(r.id)) add('INVALID_INPUT', ['resources', i], 'Повтор ресурса ' + r.id);
    resourceIds.add(r.id);
    if (
      r.kind === 'port' &&
      (!/^\d+$/.test(r.value) || Number(r.value) < 1024 || Number(r.value) > 65535)
    )
      add(
        'INVALID_INPUT',
        ['resources', i, 'value'],
        'Ресурс port должен содержать порт 1024–65535',
      );
  });
  const gateChecks = (
    gates: { id: string; dependsOn?: string[]; resources?: string[] }[],
    path: (string | number)[],
  ) => {
    for (const issue of gateOrderIssues(gates)) add(issue.code, path, issue.message);
    gates.forEach((g, i) => {
      if (g.id === 'requirement-source')
        add('INVALID_INPUT', [...path, i, 'id'], 'requirement-source — зарезервированный gate');
      for (const r of g.resources ?? [])
        if (!resourceIds.has(r))
          add('INVALID_INPUT', [...path, i, 'resources'], 'Неизвестный ресурс: ' + r);
    });
  };
  policy.repositories.forEach((repo, r) => {
    if (repos.has(repo.id))
      add('INVALID_INPUT', ['repositories', r, 'id'], 'Повтор репозитория ' + repo.id);
    repos.set(repo.id, repo);
    gateChecks(repo.gates, ['repositories', r, 'gates']);
    if (!repo.gates.some((g) => g.kind === 'test'))
      add(
        'INVALID_INPUT',
        ['repositories', r, 'gates'],
        'Нужен хотя бы один test gate с JUnit report',
      );
    for (const group of Object.keys(repo.gateGroups ?? {}))
      try {
        expandGateRefs(repo, ['@' + group]);
      } catch (error) {
        add(
          (error as { code?: string }).code ?? 'GATE_UNKNOWN',
          ['repositories', r, 'gateGroups', group],
          (error as Error).message,
        );
      }
    const lifecycle = repo.lifecycle ?? { setup: [], ready: [], teardown: [] };
    for (const [name, steps] of Object.entries({
      prepare: repo.prepare,
      dependencyBuild: repo.dependencyBuild,
      preflight: repo.preflight,
      setup: lifecycle.setup,
      ready: lifecycle.ready,
      teardown: lifecycle.teardown,
    }))
      if (new Set(steps.map((s) => s.id)).size !== steps.length)
        add('INVALID_INPUT', ['repositories', r, name], 'Step ids должны быть уникальны');
  });
  policy.repositories.forEach((repo, r) =>
    repo.dependsOn.forEach((dep, d) => {
      if (!repos.has(dep))
        add('INVALID_INPUT', ['repositories', r, 'dependsOn', d], 'Неизвестный репозиторий ' + dep);
    }),
  );
  // Цикл компонентов.
  const active = new Set<string>();
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) {
      add('INVALID_INPUT', ['repositories'], 'Цикл зависимостей компонентов: ' + id);
      return;
    }
    if (seen.has(id) || !repos.has(id)) return;
    active.add(id);
    for (const dep of repos.get(id)!.dependsOn) visit(dep);
    active.delete(id);
    seen.add(id);
  };
  for (const id of repos.keys()) visit(id);
  gateChecks(policy.workspaceGates, ['workspaceGates']);
  policy.workspaceGates.forEach((g, i) => {
    if (!repos.has(g.repositoryId))
      add(
        'INVALID_INPUT',
        ['workspaceGates', i, 'repositoryId'],
        'Неизвестный репозиторий ' + g.repositoryId,
      );
  });
  const bindings: [string[], RuntimeBinding][] = [
    ...(['code', 'plan', 'contract'] as const).map((k): [string[], RuntimeBinding] => [
      ['review', k, 'reviewer'],
      policy.review[k].reviewer,
    ]),
    ...Object.entries(policy.roles).flatMap(([role, b]): [string[], RuntimeBinding][] => [
      [['roles', role, 'writer'], b.writer],
      ...(b.review
        ? [[['roles', role, 'review', 'reviewer'], b.review.reviewer] as [string[], RuntimeBinding]]
        : []),
    ]),
  ];
  for (const [path, b] of bindings) {
    if (b.effort && b.runtime !== 'codex')
      add('INVALID_INPUT', path, 'effort поддерживается только для codex');
    if (b.runtime === 'fixture' && policy.mode !== 'fixture')
      add('INVALID_INPUT', path, 'Runtime fixture допустим только в mode: fixture');
    if (b.toolProfile) {
      const profile = policy.toolProfiles[b.toolProfile];
      if (!profile || profile.runtime !== b.runtime)
        add('INVALID_INPUT', path, 'Неизвестный или несовместимый toolProfile: ' + b.toolProfile);
    }
  }
  for (const [role, binding] of Object.entries(policy.roles)) {
    const choice = selectReviewer(policy, 'code', binding.writer, role);
    if (!choice.ok) add(choice.code, ['roles', role], choice.message);
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
