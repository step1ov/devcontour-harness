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
import type { CodedIssue, ErrorCode } from './errors.ts';
import { toolchainSchema } from './toolchain.ts';

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
  /**
   * Запасные reviewer по порядку: берётся первый из `[reviewer, ...alternates]`,
   * допустимый правилом вендора для этого автора. Явный упорядоченный список —
   * так хост выражает «reviewer другого вендора, чем автор» без неявного
   * противоположного runtime.
   */
  alternates: z.array(runtimeBindingSchema).optional(),
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

export const repositoryPolicySchema = z.strictObject({
  id: idSchema,
  /**
   * Роли, переопределённые репозиторием: привязка роли с этим ID для
   * поручений репозитория целиком заменяет привязку `roles` политики.
   */
  roles: z.record(roleIdSchema, roleBindingSchema).optional(),
  /** Ревью кода репозитория по умолчанию: важнее `review.code`, уступает правилу роли. */
  review: reviewRuleSchema.optional(),
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
  /** Проверенные версии инструментов и явный выбор менеджера пакетов; читает preflight. */
  toolchain: toolchainSchema.optional(),
});

/** Предел расходов (USD) и/или времени вызовов; хотя бы одно поле — выражено вариантами. */
const budgetLimitSchema = z.union([
  z.strictObject({ usd: z.number().positive(), timeMs: z.number().int().positive().optional() }),
  z.strictObject({ usd: z.number().positive().optional(), timeMs: z.number().int().positive() }),
]);

/**
 * MCP-сервер профиля инструментов: stdio-команда либо http-адрес. Учётные
 * данные — только именами переменных окружения (`env`, `bearerTokenEnv`):
 * значения в политику не входят и в URL не допускаются.
 */
export const mcpServerSchema = z
  .strictObject({
    transport: z.enum(['stdio', 'http']),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.array(envKey).default([]),
    url: z.url().optional(),
    bearerTokenEnv: envKey.optional(),
    tools: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).min(1),
  })
  .superRefine((s, ctx) => {
    if (s.transport === 'stdio' ? !s.command || s.url : !s.url || s.command)
      ctx.addIssue({ code: 'custom', message: 'MCP требует command для stdio либо url для http' });
    if (s.url && (new URL(s.url).username || new URL(s.url).password))
      ctx.addIssue({
        code: 'custom',
        message: 'Учётные данные MCP передаются через bearerTokenEnv',
      });
  });
export type McpServer = z.infer<typeof mcpServerSchema>;

export const toolProfileSchema = z.strictObject({
  runtime: z.enum(['codex', 'claude']),
  environment: environmentSchema.optional(),
  /** MCP-серверы вызова: только перечисленные инструменты, без глобальной конфигурации CLI. */
  mcp: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), mcpServerSchema).default({}),
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
  /** Окружение совместной проверки: setup/ready/teardown вокруг её gates. */
  workspaceLifecycle: lifecycleSchema.optional(),
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
  /**
   * Дополнительные вызовы reviewer кода на одно логическое ревью при ошибке
   * протокола его ответа (0–2; 0 — без повтора). Нет поля — один повтор
   * (`DEFAULT_REVIEW_PROTOCOL_RETRIES`). Умолчание не подставляется в политику:
   * digest и pins прежней политики не меняются. См. docs/review-protocol.md.
   */
  reviewProtocolRetries: z.number().int().min(0).max(2).optional(),
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

/**
 * Digest исполнительной части политики — основание согласования графа и
 * fencing попыток. Пределы бюджетов и тарифы в него не входят: это учёт, а не
 * условия исполнения, и поднятый предел действует сразу, без нового
 * согласования (как в DevContour). `policyDigest` — digest загруженной
 * политики целиком: им сверяются применение политики (`appliedPolicy`) и
 * запрос операции reconfigure.
 */
export const executionDigest = (policy: ExecutionPolicy) =>
  digestOf({ ...policy, budgets: undefined, prices: undefined });

export type ReviewKind = 'code' | 'plan' | 'contract';

type RoleBinding = z.infer<typeof roleBindingSchema>;
/**
 * Привязка роли для поручения репозитория: роль, переопределённая
 * репозиторием, целиком заменяет роль политики. Единственная точка поиска
 * роли: правила записи, writer и ревью не расходятся между собой.
 */
export function roleBinding(
  policy: Pick<ExecutionPolicy, 'roles' | 'repositories'>,
  role: string,
  repositoryId?: string,
): RoleBinding | undefined {
  const repo = repositoryId ? policy.repositories.find((r) => r.id === repositoryId) : undefined;
  return repo?.roles?.[role] ?? policy.roles[role];
}
/** Правило ревью кода роли: своё у роли, иначе репозитория, иначе политики. */
export function codeReview(
  policy: Pick<ExecutionPolicy, 'roles' | 'review' | 'repositories'>,
  role: string,
  repositoryId?: string,
): ReviewRule {
  const repo = repositoryId ? policy.repositories.find((r) => r.id === repositoryId) : undefined;
  return roleBinding(policy, role, repositoryId)?.review ?? repo?.review ?? policy.review.code;
}

/**
 * Единственная точка выбора reviewer. Возвращает назначение или отказ с
 * кодом; другого пути назначить reviewer у движка нет.
 */
export function selectReviewer(
  policy: Pick<ExecutionPolicy, 'roles' | 'review' | 'repositories'>,
  kind: ReviewKind,
  writer: { runtime: Author },
  role?: string,
  repositoryId?: string,
):
  | { ok: true; reviewer: RuntimeBinding; sameVendor: boolean }
  | { ok: false; code: 'REVIEWER_SAME_VENDOR' | 'REVIEWER_MISSING'; message: string } {
  const rule =
    kind === 'code' && role !== undefined
      ? codeReview(policy, role, repositoryId)
      : policy.review[kind];
  if (!rule) return { ok: false, code: 'REVIEWER_MISSING', message: 'Не задан reviewer: ' + kind };
  for (const reviewer of [rule.reviewer, ...(rule.alternates ?? [])]) {
    const sameVendor = vendorOf(reviewer.runtime) === vendorOf(writer.runtime);
    if (!sameVendor || rule.vendor === 'same-vendor-allowed')
      return { ok: true, reviewer, sameVendor };
  }
  return {
    ok: false,
    code: 'REVIEWER_SAME_VENDOR',
    message: `Ревью ${kind}: reviewer ${rule.reviewer.runtime} того же вендора, что writer ${writer.runtime}; разрешите vendor: same-vendor-allowed явно`,
  };
}

type Issue = CodedIssue;
type Repo = z.infer<typeof repositoryPolicySchema>;

/** Gates в порядке зависимостей; повтор, неизвестная зависимость и цикл — нарушения. */
export function gateOrderIssues(
  gates: { id: string; dependsOn?: string[] }[],
): Omit<CodedIssue, 'path'>[] {
  const issues: Omit<CodedIssue, 'path'>[] = [];
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
  const add = (code: ErrorCode, path: (string | number)[], message: string) =>
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
          (error as { code?: ErrorCode }).code ?? 'GATE_UNKNOWN',
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
    ...policy.repositories.flatMap((repo, i): [string[], RuntimeBinding][] => [
      ...(repo.review
        ? [
            [['repositories', String(i), 'review', 'reviewer'], repo.review.reviewer] as [
              string[],
              RuntimeBinding,
            ],
          ]
        : []),
      ...Object.entries(repo.roles ?? {}).flatMap(([role, b]): [string[], RuntimeBinding][] => [
        [['repositories', String(i), 'roles', role, 'writer'], b.writer],
        ...(b.review
          ? [
              [
                ['repositories', String(i), 'roles', role, 'review', 'reviewer'],
                b.review.reviewer,
              ] as [string[], RuntimeBinding],
            ]
          : []),
      ]),
    ]),
  ];
  // Запасные reviewer правил проверяются так же, как основной.
  const rules: [string[], ReviewRule][] = [
    ...(['code', 'plan', 'contract'] as const).map((k): [string[], ReviewRule] => [
      ['review', k],
      policy.review[k],
    ]),
    ...Object.entries(policy.roles).flatMap(([role, b]): [string[], ReviewRule][] =>
      b.review ? [[['roles', role, 'review'], b.review]] : [],
    ),
    ...policy.repositories.flatMap((repo, i): [string[], ReviewRule][] => [
      ...(repo.review
        ? [[['repositories', String(i), 'review'], repo.review] as [string[], ReviewRule]]
        : []),
      ...Object.entries(repo.roles ?? {}).flatMap(([role, b]): [string[], ReviewRule][] =>
        b.review ? [[['repositories', String(i), 'roles', role, 'review'], b.review]] : [],
      ),
    ]),
  ];
  for (const [path, rule] of rules)
    (rule.alternates ?? []).forEach((b, j) =>
      bindings.push([[...path, 'alternates', String(j)], b]),
    );
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
  policy.repositories.forEach((repo, i) => {
    for (const [role, binding] of Object.entries(repo.roles ?? {})) {
      const choice = selectReviewer(policy, 'code', binding.writer, role, repo.id);
      if (!choice.ok) add(choice.code, ['repositories', i, 'roles', role], choice.message);
    }
  });
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

/** Имена переменных, которые MCP-серверы профиля получают по имени от CLI. */
export const mcpEnvironment = (profile?: { mcp: Record<string, McpServer> }) => ({
  inherit: [
    ...new Set(
      Object.values(profile?.mcp ?? {}).flatMap((s) => [
        ...s.env,
        ...(s.bearerTokenEnv ? [s.bearerTokenEnv] : []),
      ]),
    ),
  ],
  values: {},
  secrets: {},
});
