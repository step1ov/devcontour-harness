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
  type RuntimeName,
  trimmedText,
} from './primitives.ts';
import { digestOf } from './digest.ts';
import {
  DEFAULT_INPUT_POLICY,
  inputPolicySchema,
  LIGHT_LEAD_TECHNICAL_AREAS,
  type InputPolicy,
} from './input.ts';
import type { CodedIssue, ErrorCode } from './errors.ts';
import { toolchainPinSchema, toolchainSchema } from './toolchain.ts';
import { gateArtifactLimits } from './result.ts';
import { infraIssues, infraScopeSchema } from './infra.ts';
import {
  DEFAULT_HARNESS_MODE,
  attemptEnvSchema,
  gatewaySchema,
  harnessModeSchema,
  releasePolicySchema,
  uiGateSchema,
  writeGuardSchema,
  type HarnessMode,
} from './light.ts';
import { reviewPassesPolicySchema } from './review-passes.ts';

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

/** Предел превью одного репозитория (`previews[]`). */
export const PREVIEW_LIMIT = 10;
/** Путь проверки готовности превью: абсолютный путь URL на loopback-порту приложения. */
const previewHealthPath = z
  .string()
  .min(1)
  .max(500)
  .regex(/^\/\S*$/, 'health — путь URL от корня, например /health');
/**
 * Превью результата (`previews[]` репозитория и профиля, docs/previews.md):
 * как собрать и запустить приложение на принятом коммите, чтобы человек
 * посмотрел результат в браузере. Запускает только оператор или ведущий по
 * его просьбе (`harness preview-start`), никогда — `run`, попытка или gate.
 *
 * - `build` — шаги до запуска (установка, сборка) в рабочем дереве превью;
 * - `start` — команда долгоживущего процесса: порт приложения — в переменной
 *   `PORT` и подстановке `{port}` (в `start` и значениях `env`), адрес —
 *   `HOST=127.0.0.1` и `{host}`: приложение слушает только loopback;
 * - `env` — значения окружения превью поверх окружения репозитория;
 * - `services: true` — вокруг превью идут lifecycle `setup`/`ready`/`teardown`
 *   репозитория (БД и прочие службы); нет поля — без lifecycle;
 * - `health` — путь готовности (`/` по умолчанию): ответ меньше 400 на
 *   `http://127.0.0.1:{port}{health}` до `readyTimeoutMs`;
 * - `ttlMs`, `idleMs` — срок жизни и простой без запросов, после которых
 *   harness останавливает превью сам (`idleMs: 0` — без остановки по простою).
 *
 * Необязательное поле без умолчания: политика и профиль без него сохраняют digest.
 */
export const previewSchema = z.strictObject({
  id: idSchema,
  title: trimmedText(1, 80).optional(),
  build: z.array(stepSchema).max(20).optional(),
  start: z.array(z.string().min(1)).min(1),
  /** Каталог команд относительно корня дерева; нет — корень. */
  cwd: relativePathSchema.optional(),
  env: z.record(envKey, z.string()).optional(),
  services: z.boolean().optional(),
  health: previewHealthPath.optional(),
  readyTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
  ttlMs: z.number().int().min(1000).max(86_400_000).optional(),
  idleMs: z.number().int().min(0).max(86_400_000).optional(),
});
export type PreviewDefinition = z.infer<typeof previewSchema>;
/** Список превью: ID без повторов. */
export const previewsSchema = z
  .array(previewSchema)
  .min(1)
  .max(PREVIEW_LIMIT)
  .refine((list) => new Set(list.map((p) => p.id)).size === list.length, {
    message: 'Повтор ID превью',
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
/**
 * Файлы и каталоги gate задачи, сохраняемые как evidence при любом исходе
 * (например, снимки экрана визуального теста), относительно корня дерева.
 * Необязательное поле без умолчания: политика без него сохраняет digest.
 */
const gateArtifacts = z.array(relativePathSchema).min(1).max(gateArtifactLimits.paths).optional();

/**
 * Почему шаблон пути `when.paths` недопустим, или undefined. Шаблон —
 * относительный POSIX-glob от корня репозитория: `**`, `*`, `?` и `{a,b}` без
 * вложенности; без `..`, `.`, пустых сегментов, ведущего `/`, обратной
 * косой черты, отрицания и классов символов.
 */
export function gatePathPatternProblem(pattern: string): string | undefined {
  if (pattern.startsWith('/')) return 'шаблон пути не может быть абсолютным';
  if (/[\\\0\[\]]/.test(pattern)) return 'обратная косая черта, NUL и [] в шаблоне не допускаются';
  if (pattern.startsWith('!')) return 'отрицание в шаблоне не поддерживается';
  const body = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  if (body.split('/').some((s) => s === '' || s === '.' || s === '..'))
    return 'шаблон пути без пустых сегментов, . и ..';
  // И внутри вариантов `{}`: `{..,x}` — тот же выход за корень.
  if (body.split(/[/{},]/).some((s) => s === '.' || s === '..'))
    return 'шаблон пути без . и .. и внутри {}';
  let depth = 0;
  for (const c of pattern) {
    if (c === '{' && ++depth > 1) return 'вложенные {} в шаблоне не поддерживаются';
    if (c === '}' && --depth < 0) return 'непарная } в шаблоне';
  }
  if (depth) return 'непарная { в шаблоне';
  return undefined;
}
const gatePathPattern = z
  .string()
  .min(1)
  .max(200)
  .superRefine((value, ctx) => {
    const problem = gatePathPatternProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
/**
 * Условие применимости gate задачи: gate исполняется, только когда настоящий
 * diff фазы (из Git, не заявление исполнителя) задевает один из путей или
 * неявный вход gate; иначе пишется запись `not-applicable`, которая не PASS.
 * `{ always: true }` (alpha.71) — gate исполняется всегда: отказ от
 * применимости по умолчанию для gate пакета workspace (`packageBinding`).
 * Необязательное поле без умолчания: политика без него сохраняет digest.
 */
export const gateWhenSchema = z.union([
  z.strictObject({ paths: z.array(gatePathPattern).min(1).max(64) }),
  z.strictObject({ always: z.literal(true) }),
]);
/** Явные `when.paths` gate, или undefined (нет `when` или `when.always`). */
export const whenPaths = (gate: { when?: z.infer<typeof gateWhenSchema> | undefined }) =>
  gate.when && 'paths' in gate.when ? gate.when.paths : undefined;
const gateWhen = gateWhenSchema.optional();
export const gateSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...gateCommon,
    kind: z.literal('test'),
    report: junitReport,
    artifacts: gateArtifacts,
    when: gateWhen,
    /** UI gate (alpha.69, `light.ts`): браузер (Playwright) или мобильный (Maestro). */
    ui: uiGateSchema.optional(),
  }),
  z.strictObject({
    ...gateCommon,
    kind: z.literal('check'),
    report: junitReport.optional(),
    artifacts: gateArtifacts,
    when: gateWhen,
    /** UI gate (alpha.69, `light.ts`): браузер (Playwright) или мобильный (Maestro). */
    ui: uiGateSchema.optional(),
  }),
]);
export type GatePolicy = z.infer<typeof gateSchema>;
/**
 * Digest определения gate задачи (с `when`): под ним записывается решение о
 * применимости. Смена команды, путей или любого поля — другой digest.
 */
export const gateDigest = (gate: GatePolicy) => digestOf(gate);

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

/**
 * Хранилище зависимостей репозитория: harness сам держит seed менеджера пакетов
 * по lockfile целевой ветки и разворачивает его в каждый checkout (см.
 * `verification/dependency-store.ts`). Нет поля — поведение и digest прежние.
 */
export const dependencyStoreSchema = z.strictObject({
  manager: z.enum(['pnpm']),
  /** Lockfile относительно корня репозитория. */
  lockfile: relativePathSchema.default('pnpm-lock.yaml'),
  /** Предел логического размера seeds репозитория на диске. */
  maxBytes: z
    .number()
    .int()
    .min(1024 * 1024)
    .default(8 * 1024 * 1024 * 1024),
  /**
   * Верхний предел сборки seed вместе с ожиданием чужой сборки. Действует ещё и
   * доля остатка времени фазы: хранилище не расходует время попытки до отказа.
   */
  timeoutMs: z.number().int().positive().max(3_600_000).default(600000),
});
export type DependencyStorePolicy = z.infer<typeof dependencyStoreSchema>;

/**
 * Генератор репозитория: команда, которая строит закоммиченные выходы
 * (`outputs`) из входов (`inputs`) инструментом (`tool`). Controller
 * исполняет её после исполнителя, когда настоящий diff задевает входы,
 * инструмент или выходы, с изоляцией и окружением gate; выходы попадают в
 * кандидата, даже если лежат вне области записи роли и поручения. На
 * взятом кандидате и на integration генератор исполняется заново и обязан
 * не менять дерево. Пути — относительно корня репозитория, совпадение — путь
 * или префикс каталога, как у `writePaths`.
 */
export const generatorSchema = z.strictObject({
  /** Короче общего ID: имя стадии замера (`integration-generate:<id>`) не длиннее 100. */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/, 'Ожидается ID генератора [A-Za-z0-9_-]{1,60}'),
  command: z.array(z.string().min(1)).min(1),
  /** Каталог команды относительно корня дерева; нет — корень. */
  cwd: relativePathSchema.optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).default(120000),
  inputs: z.array(relativePathSchema).min(1).max(64),
  outputs: z.array(relativePathSchema).min(1).max(64),
  /** Файлы самого генератора: их правка тоже требует перегенерации. */
  tool: z.array(relativePathSchema).max(64).default([]),
});
export type GeneratorPolicy = z.infer<typeof generatorSchema>;
/** Предел генераторов одного репозитория. */
export const MAX_GENERATORS = 10;

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
  /** Необязательное поле без умолчания: политика без него сохраняет digest. */
  dependencyStore: dependencyStoreSchema.optional(),
  /**
   * Установка зависимостей в дереве исполнителя до его работы — gates
   * установки попытки под изоляцией gate, без evidence. Нет поля — включено;
   * `false` — выключено. Без умолчания: политика без поля сохраняет digest.
   */
  writerDependencies: z.boolean().optional(),
  dependencyBuild: z.array(stepSchema).default([]),
  dependencyArtifacts: z.array(relativePathSchema).default([]),
  preflight: z.array(stepSchema).default([]),
  /** Проверенные версии инструментов и явный выбор менеджера пакетов; читает preflight. */
  toolchain: toolchainSchema.optional(),
  /**
   * Генераторы закоммиченных выходов (`generatorSchema`, не больше 10).
   * Необязательное поле без умолчания: политика без него сохраняет digest.
   */
  generators: z.array(generatorSchema).max(MAX_GENERATORS).optional(),
  /**
   * Команды, которые правила проекта требуют от исполнителя (генератор,
   * локальный сервер, браузерный инструмент): `harness smoke --writer-probe`
   * прогоняет их в точной изоляции исполнителя без модели и называет, что
   * закрыто. На попытки не влияют. Необязательное поле без умолчания:
   * политика без него сохраняет digest.
   */
  writerProbe: z.array(stepSchema).max(20).optional(),
  /**
   * Превью результата (`previewSchema`, docs/previews.md): запускает только
   * оператор командой `harness preview-start`. Не условие исполнения кода —
   * в `executionDigest` не входит. Необязательное поле без умолчания:
   * политика без него сохраняет digest.
   */
  previews: previewsSchema.optional(),
  /**
   * Область инфраструктуры harness (alpha.67, `infraScopeSchema`,
   * docs/infra-works.md): пути, которые меняют только работы `kind: infra`.
   * Входит в `isolationDigest`: смена области — новое ревью плана.
   * Необязательное поле без умолчания: политика без него сохраняет digest.
   */
  infra: infraScopeSchema.optional(),
  /**
   * Шлюз gates (alpha.69, `gatewaySchema`, docs/light-mode.md): gates идут к
   * приложению через шлюз проекта, как в production. Необязательное поле.
   */
  gateway: gatewaySchema.optional(),
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

export const writerNetworkSchema = z.enum(['none', 'loopback', 'full']);
export type WriterNetwork = z.infer<typeof writerNetworkSchema>;

export const toolProfileSchema = z.strictObject({
  runtime: z.enum(['codex', 'claude']),
  environment: environmentSchema.optional(),
  /** MCP-серверы вызова: только перечисленные инструменты, без глобальной конфигурации CLI. */
  mcp: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), mcpServerSchema).default({}),
  claudeTools: z.array(z.enum(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'])).optional(),
  claudeAllowedTools: z.array(z.string().min(1)).default([]),
  codexShell: z.boolean().default(true),
  codexNetwork: z.boolean().default(false),
  /**
   * Сеть исполнителя профиля. `none` — закрыта целиком, и локальные порты
   * тоже; `loopback` — только локальный сервер: listen и connect на
   * 127.0.0.1 и ::1, без интернета и доменов `isolation.domains`; `full` —
   * вся сеть (только codex, то же, что `codexNetwork: true`). Нет поля —
   * прежнее поведение: codex — по `codexNetwork`, claude — домены
   * `isolation.domains` и локальные порты. Ревьюер сети профиля не получает.
   * `none` и `loopback` закрывают и веб-инструменты runtime (веб-поиск codex,
   * WebFetch/WebSearch claude); MCP-серверы профиля — вне этой границы.
   * Поле входит в `isolationDigest` (через `toolProfiles`): его смена требует
   * нового ревью плана.
   */
  network: writerNetworkSchema.optional(),
});
export type ToolProfile = z.infer<typeof toolProfileSchema>;

/**
 * Действующая сеть исполнителя профиля: поле `network`, иначе у codex —
 * `codexNetwork`. `undefined` — claude без поля: прежняя сеть (домены
 * `isolation.domains` и локальные порты).
 */
export function profileNetwork(
  runtime: RuntimeName,
  profile: ToolProfile | undefined,
): WriterNetwork | undefined {
  if (profile?.network) return profile.network;
  if (runtime === 'codex') return profile?.codexNetwork ? 'full' : 'none';
  return undefined;
}

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
    /**
     * Второй проход ревью (0.1.0-alpha.70, `reviewPassesPolicySchema`):
     * `off | on-reject | always` или по видам. Нет поля — `on-reject` для
     * ревью попыток, `always` для приёмки выпуска и работ с метками
     * security/payments/auth. Надзор ревью: в `executionDigest` не входит.
     */
    passes: reviewPassesPolicySchema.optional(),
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
  /**
   * Закреплённый toolchain (`toolchainPinSchema`): каталог Node.js первым в
   * PATH каждого процесса прогона. Нет поля — PATH процесса harness.
   */
  toolchain: toolchainPinSchema.optional(),
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
  /**
   * Нижняя граница предела времени каждого исполнения gate (мс, 1000–600000):
   * действующий предел — max(gate.timeoutMs, gateTimeoutFloorMs). Объявленный
   * предел gate не меняется; поле защищает короткие пределы от нагрузки хоста.
   * Нет поля — действует объявленный предел; умолчание не подставляется, и
   * digest прежних политик не меняется.
   */
  gateTimeoutFloorMs: z.number().int().min(1000).max(600_000).optional(),
  /**
   * Обход зависших попыток controller: каждые `intervalMs` он оценивает
   * движение исполняющегося (вывод, команды, стадии, процессор дерева):
   * `quiet` — нет движения дольше `quietMs`, `stalled` — дольше `stalledMs`.
   * На `stalled` — снимок процессов и хвоста вывода и действие `action`:
   * `report` только сообщает, `stop` останавливает попытку исходом
   * `stalled`. Нет поля — умолчания `DEFAULT_STALL_SWEEP`; они не
   * подставляются в политику, и digest прежних политик не меняется.
   */
  stallSweep: z
    .strictObject({
      intervalMs: z.number().int().min(1000).max(600_000).default(30_000),
      quietMs: z.number().int().positive().max(86_400_000).default(180_000),
      stalledMs: z.number().int().positive().max(86_400_000).default(600_000),
      action: z.enum(['stop', 'report']).default('report'),
    })
    .refine((s) => s.quietMs < s.stalledMs, {
      message: 'stallSweep.quietMs должен быть меньше stalledMs',
      path: ['quietMs'],
    })
    .refine((s) => s.intervalMs <= s.quietMs, {
      message: 'stallSweep.intervalMs не больше quietMs: иначе quiet не заметить вовремя',
      path: ['intervalMs'],
    })
    .optional(),
  /**
   * Перенос evidence кандидата на интеграцию. `identical-tree`: если дерево
   * integration-коммита равно дереву кандидата, а политика, версия движка и
   * снимок провайдеров не сдвинулись, gate, прошедший на кандидате, на
   * интеграции не исполняется — пишется запись PASS со ссылкой на запись
   * кандидата (`reusedEvidence`); с alpha.71 так же переносится PASS ревью
   * кандидата (второе ревью того же дерева не вызывается). Доказательства
   * (требования, свойства, договоры) и gates с `artifacts` исполняются
   * всегда. `off` — каждый gate и ревью исполняются на интеграции.
   *
   * Нет поля (alpha.71): в облегчённом режиме — `identical-tree`, если хост
   * объявил поддержку (`ExecutionHost.capabilities.integrationReuse`), иначе
   * и в строгом режиме — `off` (`integrationReuseOn`). Умолчание в политику
   * не подставляется: digest прежних политик не меняется. Поле входит в
   * `executionDigest`. Явное `identical-tree` под хостом без поддержки —
   * отказ создания движка (`integrationReuseProblem`).
   */
  integrationReuse: z.enum(['identical-tree', 'off']).optional(),
  /**
   * Применимость по умолчанию gates пакетов workspace (alpha.71,
   * `derivationAllowed`): `on` — gate пакета без `when` не исполняется, когда
   * diff не задел пакет, его зависимости и неявные входы; `off` — каждый
   * такой gate исполняется. Нет поля — `on` в облегчённом режиме, `off` в
   * строгом (`derivedApplicabilityOn`).
   */
  derivedApplicability: z.enum(['on', 'off']).optional(),
  /**
   * Получатель результата засчитывает записи применимости по умолчанию
   * (`notApplicable.derived`) на слово исполнителя, без сверки Git
   * (`derivedRecordChecks`). Нет поля — без сверки такая запись не PASS.
   */
  trustDerivedRecords: z.literal(true).optional(),
  /**
   * Проверка окружения перед `run` (opt-in). `cached`: до ревью плана и
   * первой попытки controller поднимает окружение каждого репозитория с
   * незавершёнными поручениями на его `targetRef` — как `harness smoke`
   * (lifecycle, `prepare`, хранилище зависимостей, без gates и моделей) — и
   * запоминает успех в каталоге состояния по ключу (деревья базы и её
   * зависимостей, digest исполнительной политики, `stallSweep`, digest
   * окружения процесса, версия harness). Тот же ключ — без повторной
   * проверки; отказ не запоминается. Отказ останавливает запуск
   * `LIFECYCLE_FAILED` до любой платной попытки. Нет поля — проверки нет;
   * умолчание не подставляется, digest прежних политик не меняется. В
   * `executionDigest` не входит: это надзор, а не условие исполнения кода.
   */
  lifecyclePreflight: z.literal('cached').optional(),
  /**
   * Когда исполнитель останавливается с вопросом, а когда решает сам и
   * записывает допущение (`inputPolicySchema`, docs/contracts.md «Вопрос
   * исполнителя»). Нет поля — `DEFAULT_INPUT_POLICY` (порог 7); умолчание не
   * подставляется в политику, digest прежних политик не меняется. В
   * `executionDigest` не входит: закрепляется в попытке при выдаче.
   */
  inputPolicy: inputPolicySchema.optional(),
  /**
   * Кто восстанавливает работу после повторных отказов (docs/principles.md
   * «Кто принимает решения»). `mode: lead` — после `diagnoseAfter`
   * засчитанных отказов работы следующая попытка не выдаётся без
   * диагностики ведущего (`harness diagnose`), а при исчерпанных попытках
   * ведущий сам даёт новый предел (`retry --reset --by lead --diagnosis`) по
   * свежей технической диагностике — не больше `leadResets` раз на предел
   * попыток работы (0 — сбрасывает только человек). `mode: user` — прежнее
   * поведение: шлюза диагностики нет, исчерпание — решение человека.
   * `diagnoseAfter` — от 1 до 10; полезные значения — от 1 до
   * `maxAttempts - 1`: при `diagnoseAfter ≥ maxAttempts` шлюза до исчерпания
   * нет, разбор ведущего — только при исчерпании (doctor говорит об этом).
   * Нет поля — `mode: lead`, если технические вопросы исполнителя решает
   * ведущий (`inputPolicy.leadAnswers.technical`), иначе `user`; явное поле
   * всегда главнее (`recoveryPolicyOf`). В `executionDigest` не входит: это
   * правило надзора (кто решает), а не условие исполнения кода, и его
   * включение не требует нового согласования графа.
   */
  recovery: z
    .strictObject({
      mode: z.enum(['lead', 'user']),
      diagnoseAfter: z.number().int().min(1).max(10).default(2),
      leadResets: z.number().int().min(0).max(5).default(2),
    })
    .optional(),
  /**
   * Режим harness (alpha.69, `light.ts`): нет поля — `light` (по умолчанию),
   * `strict` — прежняя изоляция, заморожена. Имя `harnessMode`, потому что
   * `mode` политики — режим runtime (`live`/`fixture`). Не входит ни в
   * `executionDigest`, ни в `isolationDigest`.
   */
  harnessMode: harnessModeSchema.optional(),
  /** Граница записи облегчённого режима (`writeGuardSchema`); не входит в digests. */
  writeGuard: writeGuardSchema.optional(),
  /** Окружение попытки облегчённого режима: выделенные порты (`attemptEnvSchema`). */
  attemptEnv: attemptEnvSchema.optional(),
  /** Приёмка выпуска (`releasePolicySchema`, P7-6); надзор, не входит в digests. */
  release: releasePolicySchema.optional(),
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

/** Обход зависших попыток по умолчанию: умеренные пороги, только сообщение. */
export const DEFAULT_STALL_SWEEP = {
  intervalMs: 30_000,
  quietMs: 180_000,
  stalledMs: 600_000,
  action: 'report',
} as const satisfies NonNullable<ExecutionPolicy['stallSweep']>;
export type StallSweepPolicy = {
  intervalMs: number;
  quietMs: number;
  stalledMs: number;
  action: 'stop' | 'report';
};
/** Действующий обход политики: заданный или умолчание. */
export const stallSweepOf = (policy: Pick<ExecutionPolicy, 'stallSweep'>): StallSweepPolicy =>
  policy.stallSweep ?? DEFAULT_STALL_SWEEP;
export type ExecutionPolicyInput = z.input<typeof executionPolicySchema>;

export const policyDigest = (policy: ExecutionPolicy) => digestOf(policy);

/**
 * Digest исполнительной части политики — основание согласования графа и
 * fencing попыток. Пределы бюджетов и тарифы в него не входят: это учёт, а не
 * условия исполнения, и поднятый предел действует сразу, без нового
 * согласования (как в DevContour). Обход зависших (`stallSweep`) — тоже
 * надзор, а не условие исполнения кода: его пороги меняются без новой
 * попытки и не трогают основания reuse. Политика вопросов исполнителя
 * (`inputPolicy`) закрепляется в попытке при выдаче и тоже не входит;
 * проверка окружения перед запуском (`lifecyclePreflight`) — тоже надзор;
 * закреплённый toolchain (`toolchain`) не входит: фактический toolchain
 * каждой проверки записан в её evidence, и закрепление на идущем выпуске не
 * требует нового согласования. Превью репозиториев (`previews`) — не
 * исполнение кода попытки, а просмотр принятого человеком: тоже не входят.
 * `policyDigest` — digest загруженной
 * политики целиком: им сверяются применение политики (`appliedPolicy`) и
 * запрос операции reconfigure.
 */
export const executionDigest = (policy: ExecutionPolicy) =>
  digestOf({
    ...policy,
    budgets: undefined,
    prices: undefined,
    stallSweep: undefined,
    inputPolicy: undefined,
    lifecyclePreflight: undefined,
    toolchain: undefined,
    // Превью не входят в digest исполнения — кроме репозитория с областью
    // инфраструктуры (alpha.67): там их команды — шаги на хосте, и их смена
    // делает согласование устаревшим (маршрут прежний — `reapprove`). Gates и
    // генераторы входят всегда. Без области digest прежний.
    repositories: policy.repositories.map((r) => ({
      ...r,
      previews: r.infra ? r.previews : undefined,
    })),
    recovery: undefined,
    // Режим, граница записи и приёмка выпуска (alpha.69) — надзор: смена
    // режима не делает согласования устаревшими (решение владельца).
    harnessMode: undefined,
    writeGuard: undefined,
    release: undefined,
    // Второй проход ревью (alpha.70) — надзор ревью, не условие исполнения.
    review: { ...policy.review, passes: undefined },
  });

/**
 * Переносит ли интеграция PASS кандидата при том же дереве (gates и ревью):
 * явное `identical-tree` — да, явное `off` — нет; без поля — да в облегчённом
 * режиме, если хост объявил поддержку; у получателя (`host` не передан) —
 * только при явном `harnessMode: light` его политики (alpha.71).
 */
export const integrationReuseOn = (
  policy: {
    integrationReuse?: 'identical-tree' | 'off' | undefined;
    harnessMode?: HarnessMode | undefined;
  },
  host?: { capabilities?: { integrationReuse?: boolean | undefined } | undefined },
): boolean =>
  // Тонкий режим (alpha.73): переноса кандидат→интеграция нет и явным полем.
  policy.harnessMode === 'thin'
    ? false
    : policy.integrationReuse !== undefined
      ? policy.integrationReuse === 'identical-tree'
      : host === undefined
        ? // Получатель, не знающий режим, перенос не включает (ревью B, L2).
          policy.harnessMode === 'light'
        : harnessModeOf(policy) === 'light' && host.capabilities?.integrationReuse === true;

/** Действует ли применимость по умолчанию (alpha.71): явное поле, иначе облегчённый режим. */
export const derivedApplicabilityOn = (policy: {
  derivedApplicability?: 'on' | 'off' | undefined;
  harnessMode?: HarnessMode | undefined;
}): boolean =>
  // Тонкий режим (alpha.73): применимость не выводится и явным полем.
  policy.harnessMode === 'thin'
    ? false
    : policy.derivedApplicability !== undefined
      ? policy.derivedApplicability === 'on'
      : harnessModeOf(policy) === 'light';

/** Действующий режим политики: нет поля — `light` (alpha.69). */
export const harnessModeOf = (policy: { harnessMode?: HarnessMode | undefined }): HarnessMode =>
  policy.harnessMode ?? DEFAULT_HARNESS_MODE;
/**
 * Фазы, записи которых решают приёмку: в тонком режиме (alpha.73) фазы
 * кандидата нет — gates и ревью идут один раз, на слиянии с целью.
 */
export const acceptancePhases = (policy: {
  harnessMode?: HarnessMode | undefined;
}): readonly ('candidate' | 'integration')[] =>
  policy.harnessMode === 'thin' ? ['integration'] : ['candidate', 'integration'];
/**
 * Окружение хоста как у разработчика (alpha.73): облегчённый и тонкий
 * режимы — граница записи, порты и файл окружения попытки, технические
 * ответы ведущего, раунды ревью без счёта. Выводы ускорения (B1, B2) — только
 * `light`.
 */
export const hostEnvironment = (policy: { harnessMode?: HarnessMode | undefined }): boolean => {
  const mode = harnessModeOf(policy);
  return mode === 'light' || mode === 'thin';
};
/**
 * Прежняя песочница ОС проверок и исполнителя действует: строгий режим с
 * `isolation.mode: os`. В облегчённом режиме её место занимает граница
 * записи (`writeGuardActive`).
 */
export const strictSandbox = (
  policy: Pick<ExecutionPolicy, 'isolation'> & { harnessMode?: HarnessMode | undefined },
) => harnessModeOf(policy) === 'strict' && policy.isolation.mode === 'os';
/**
 * Граница записи облегчённого режима действует: режим `light`,
 * `isolation.mode` не `none` и граница не снята (`writeGuard.off`).
 */
export const writeGuardActive = (
  policy: Pick<ExecutionPolicy, 'isolation'> & {
    harnessMode?: HarnessMode | undefined;
    writeGuard?: { off?: true | undefined } | undefined;
  },
) => hostEnvironment(policy) && policy.isolation.mode !== 'none' && !policy.writeGuard?.off;

/** Пути `toolProfile` и `runtime` назначений в ролях и правилах ревью: какой профиль у кого. */
function profileSelections(value: unknown, path: string, out: [string, unknown][]) {
  if (Array.isArray(value)) value.forEach((v, i) => profileSelections(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      if (k === 'toolProfile' || k === 'runtime') out.push([`${path}.${k}`, v]);
      else profileSelections(v, `${path}.${k}`, out);
  return out;
}

/**
 * Digest границы исполнения политики: изоляция (`isolation`, режим и домены
 * сети), профили инструментов (`toolProfiles`: сеть Codex, shell, инструменты
 * Claude, MCP, окружение профиля), выбор профиля и runtime в ролях и правилах
 * ревью (модель и effort не входят), окружение процессов (`environment`
 * политики и репозиториев целиком: значения, переменные хоста, секреты),
 * защищённые пути (`protectedPaths`), шаги на хосте вне песочницы исполнителя
 * (`lifecycle`, `prepare`, `dependencyBuild`, `preflight`), установка
 * зависимостей исполнителя (`writerDependencies`), режим (`mode`) и режим
 * согласования (`approvalMode`).
 * Раунд ревью плана записывает его; согласование под другим digest границы —
 * только после нового раунда, а не по прежнему одобрению (ни `approve`, ни
 * `reapprove`, ни библиотечный `Engine.approve`).
 */
export const isolationDigest = (policy: ExecutionPolicy) =>
  digestOf({
    isolation: policy.isolation,
    toolProfiles: policy.toolProfiles,
    selections: profileSelections({ roles: policy.roles, review: policy.review }, '', []),
    environment: policy.environment ?? null,
    lifecycle: policy.lifecycle ?? null,
    mode: policy.mode,
    approvalMode: policy.approvalMode,
    repositories: policy.repositories.map((r) => [
      r.id,
      profileSelections({ roles: r.roles ?? null, review: r.review ?? null }, '', []),
      r.environment ?? null,
      r.protectedPaths,
      r.lifecycle ?? null,
      r.prepare,
      r.dependencyBuild,
      r.preflight,
      r.writerDependencies ?? null,
      // Область инфраструктуры — граница записи защищённых путей; без поля
      // кортеж прежний, и digest прежних политик не меняется.
      ...(r.infra ? [{ infra: r.infra }] : []),
    ]),
  });

/**
 * Действующая политика вопросов: заданная или умолчание. Порог вопросов —
 * правило исполнителя, а не условие исполнения кода: как и `stallSweep`, он
 * не входит в `executionDigest`, а попытка закрепляет его при выдаче.
 */
export const inputPolicyOf = (
  policy: Pick<ExecutionPolicy, 'inputPolicy'> & { harnessMode?: HarnessMode | undefined },
): InputPolicy => {
  const input = policy.inputPolicy ?? DEFAULT_INPUT_POLICY;
  if (!hostEnvironment(policy)) return input;
  // Облегчённый режим (alpha.72, P9-1): без явного правила технические
  // вопросы исполнителя решает ведущий с причиной; явное правило главнее,
  // `technical: false` — отказ. Технический вопрос о внутреннем договоре или
  // программном интерфейсе остаётся у ведущего и с самооценкой 10.
  const lead = input.leadAnswers;
  if (lead === undefined)
    return {
      ...input,
      leadAnswers: { technical: true, technicalAreas: [...LIGHT_LEAD_TECHNICAL_AREAS] },
    };
  if (lead.technical === true && !('technicalAreas' in lead && lead.technicalAreas))
    return {
      ...input,
      leadAnswers: { ...lead, technical: true, technicalAreas: [...LIGHT_LEAD_TECHNICAL_AREAS] },
    };
  return input;
};

/**
 * Откуда правило ответов ведущего: `policy` — поле `inputPolicy.leadAnswers`;
 * `light-default` — умолчание облегчённого режима (alpha.72); `default` —
 * поля нет, строгий режим: блокирующие вопросы — человеку.
 */
export const leadAnswersSourceOf = (
  policy: Pick<ExecutionPolicy, 'inputPolicy'> & { harnessMode?: HarnessMode | undefined },
): 'policy' | 'light-default' | 'default' =>
  policy.inputPolicy?.leadAnswers !== undefined
    ? 'policy'
    : hostEnvironment(policy)
      ? 'light-default'
      : 'default';

export { DEFAULT_RECOVERY, recoveryPolicyOf, type RecoveryPolicy } from './decision-rules.ts';

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

type PolicyBindings = Pick<ExecutionPolicy, 'roles' | 'review' | 'repositories'>;

/** Роли политики: общие и свои роли репозиториев. */
const roleEntries = (policy: PolicyBindings) => [
  ...Object.entries(policy.roles).map(([role, binding]) => ({
    role,
    binding,
    repositoryId: undefined as string | undefined,
  })),
  ...policy.repositories.flatMap((r) =>
    Object.entries(r.roles ?? {}).map(([role, binding]) => ({
      role,
      binding,
      repositoryId: r.id,
    })),
  ),
];

/**
 * Что политика назначает каждому runtime: `writer <роль>` и `reviewer <вид>`
 * (основной reviewer и запасные). Runtime без назначений в карте нет.
 */
export function runtimeAssignments(policy: PolicyBindings): Map<RuntimeName, string[]> {
  const out = new Map<RuntimeName, string[]>();
  const add = (runtime: RuntimeName, what: string) => {
    const list = out.get(runtime) ?? [];
    if (!list.includes(what)) list.push(what);
    out.set(runtime, list);
  };
  const rule = (r: ReviewRule | undefined, what: string) => {
    if (!r) return;
    for (const b of [r.reviewer, ...(r.alternates ?? [])]) add(b.runtime, 'reviewer ' + what);
  };
  for (const { role, binding } of roleEntries(policy)) {
    add(binding.writer.runtime, 'writer ' + role);
    rule(binding.review, 'code ' + role);
  }
  for (const r of policy.repositories) rule(r.review, 'code ' + r.id);
  for (const k of ['plan', 'contract', 'code'] as const) rule(policy.review[k], k);
  return out;
}

/**
 * Ревью, которые политика отдаёт reviewer того же вендора, что автор:
 * план и контракт — для каждого из `planAuthors`, код — для writer каждой
 * роли. Только допустимые назначения (`same-vendor-allowed`); отказ
 * `selectReviewer` сюда не попадает.
 */
export function sameVendorReviews(
  policy: PolicyBindings,
  planAuthors: readonly Author[],
): { kind: ReviewKind; author: Author; reviewer: RuntimeName; role?: string }[] {
  const out: { kind: ReviewKind; author: Author; reviewer: RuntimeName; role?: string }[] = [];
  for (const kind of ['plan', 'contract'] as const)
    for (const author of new Set(planAuthors)) {
      const choice = selectReviewer(policy, kind, { runtime: author });
      if (choice.ok && choice.sameVendor)
        out.push({ kind, author, reviewer: choice.reviewer.runtime });
    }
  for (const { role, binding, repositoryId } of roleEntries(policy)) {
    const author = binding.writer.runtime;
    const choice = selectReviewer(policy, 'code', { runtime: author }, role, repositoryId);
    if (choice.ok && choice.sameVendor)
      out.push({ kind: 'code', author, reviewer: choice.reviewer.runtime, role });
  }
  return out;
}

/** Правило ревью кода роли, которое отдаёт reviewer запрещённого вендора. */
export type ReviewVendorConflict = {
  role: string;
  repositoryId?: string;
  writer: RuntimeName;
  reviewer: RuntimeName;
  /** Где записано правило: у роли, у репозитория или `review.code`. */
  source: string;
};

/**
 * Роли, чьё правило ревью кода отдаёт reviewer того же вендора, что writer
 * роли, а правило этого не разрешает (`vendor: different-vendor`, нет
 * запасного reviewer другого вендора). Решает тот же `selectReviewer`, что
 * движок и приёмка: поручение такой роли не выдаётся (блокер
 * `REVIEWER_SAME_VENDOR`), результат с таким ревью приёмка отклоняет.
 */
export function reviewVendorConflicts(policy: PolicyBindings): ReviewVendorConflict[] {
  const out: ReviewVendorConflict[] = [];
  const seen = new Set<string>();
  // Действующие пары роль × репозиторий: общие роли без репозитория и в каждом
  // репозитории (его правило review или своя роль их переопределяют), плюс
  // роли, объявленные только в репозитории.
  const contexts: { role: string; repositoryId?: string }[] = [
    ...Object.keys(policy.roles).map((role) => ({ role })),
    ...policy.repositories.flatMap((r) =>
      [...new Set([...Object.keys(policy.roles), ...Object.keys(r.roles ?? {})])].map((role) => ({
        role,
        repositoryId: r.id,
      })),
    ),
  ];
  for (const { role, repositoryId } of contexts) {
    const binding = roleBinding(policy, role, repositoryId);
    if (!binding) continue;
    const writer = binding.writer.runtime;
    const choice = selectReviewer(policy, 'code', { runtime: writer }, role, repositoryId);
    if (choice.ok || choice.code !== 'REVIEWER_SAME_VENDOR') continue;
    const index = policy.repositories.findIndex((r) => r.id === repositoryId);
    const repo = index >= 0 ? policy.repositories[index] : undefined;
    const own = !!repo?.roles?.[role];
    const source = binding.review
      ? own
        ? `repositories.${index}.roles.${role}.review`
        : `roles.${role}.review`
      : repo?.review
        ? `repositories.${index}.review`
        : 'review.code';
    // То же правило той же роли с тем же writer — одна находка.
    const scopedToRepo = own || source.startsWith('repositories.');
    const key = `${role}|${source}|${writer}|${scopedToRepo ? repositoryId : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      role,
      ...(repositoryId !== undefined && scopedToRepo ? { repositoryId } : {}),
      writer,
      reviewer: codeReview(policy, role, repositoryId).reviewer.runtime,
      source,
    });
  }
  return out;
}

/** Строка о противоречии правила ревью кода роли: что сломается и как исправить. */
export function reviewVendorConflictMessage(c: ReviewVendorConflict): string {
  return (
    `Правило ревью кода роли ${c.role}${c.repositoryId ? ` (репозиторий ${c.repositoryId})` : ''} (${c.source}): ` +
    `reviewer ${c.reviewer} того же поставщика, что writer ${c.writer}, а правило требует другого (vendor: different-vendor) — ` +
    'поручения роли не будут выданы, приёмка откажет. Исправьте: назначьте в этом правиле reviewer другого вендора, ' +
    'либо разрешите ревью тем же вендором явно (vendor: same-vendor-allowed)' +
    (c.source.includes('.roles.') || c.source.startsWith('roles.')
      ? ', либо уберите правило review из роли (и reviewer из роли профиля) — тогда действует общее правило'
      : '')
  );
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

/** Путь внутри префикса (путь или каталог), как `writePaths`. */
const insidePath = (path: string, prefix: string) =>
  path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
/**
 * Пути пересекаются: один совпадает с другим или лежит внутри него. Без учёта
 * регистра: на нечувствительной к регистру ФС (macOS, Windows) `Gen/` и `gen/`
 * — один каталог.
 */
export const pathsOverlap = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return insidePath(x, y) || insidePath(y, x);
};
/** Каталог состояния harness в дереве репозитория: генератор туда не пишет. */
const HARNESS_TREE_DIRS = ['.devcontour', '.harness', '.git'];

/**
 * Согласованность генераторов репозитория (`repositories[].generators`):
 * ID уникальны; выходы разных генераторов не пересекаются; выходы не
 * пересекаются ни со входами и инструментом любого генератора (цепочек нет:
 * порядок исполнения не влияет на результат), ни с `protectedPaths`, ни со
 * служебными каталогами (`.devcontour/`, `.harness/`, `.git`). Пути — от корня
 * репозитория. `path` — префикс пути нарушения (по умолчанию от генераторов).
 */
export function generatorIssues(
  repo: Pick<Repo, 'generators' | 'protectedPaths'>,
  path: (string | number)[] = ['generators'],
): Issue[] {
  const issues: Issue[] = [];
  const generators = repo.generators ?? [];
  const add = (where: (string | number)[], message: string) =>
    issues.push({ code: 'INVALID_INPUT', path: [...path, ...where], message });
  const ids = new Set<string>();
  generators.forEach((g, i) => {
    if (ids.has(g.id)) add([i, 'id'], 'Повтор генератора ' + g.id);
    ids.add(g.id);
  });
  generators.forEach((g, i) =>
    g.outputs.forEach((out, o) => {
      const at = [i, 'outputs', o];
      for (const dir of HARNESS_TREE_DIRS)
        if (pathsOverlap(out, dir))
          add(at, `Выход генератора ${g.id} (${out}) пересекает служебный каталог ${dir}`);
      for (const p of repo.protectedPaths)
        if (pathsOverlap(out, p))
          add(at, `Выход генератора ${g.id} (${out}) пересекает защищённый путь ${p}`);
      generators.forEach((other, j) => {
        for (const own of [...other.inputs, ...other.tool])
          if (pathsOverlap(out, own))
            add(
              at,
              `Выход генератора ${g.id} (${out}) пересекает ${other.inputs.includes(own) ? 'вход' : 'инструмент'} генератора ${other.id} (${own})`,
            );
        if (j > i)
          for (const theirs of other.outputs)
            if (pathsOverlap(out, theirs))
              add(at, `Выходы генераторов ${g.id} (${out}) и ${other.id} (${theirs}) пересекаются`);
      });
    }),
  );
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
  // Нижняя граница предела gate не длиннее предела вызова: иначе одна
  // проверка законно переживала бы весь срок вызова, который её запустил.
  if (policy.gateTimeoutFloorMs !== undefined && policy.gateTimeoutFloorMs > policy.runTimeoutMs)
    add(
      'INVALID_INPUT',
      ['gateTimeoutFloorMs'],
      `gateTimeoutFloorMs (${policy.gateTimeoutFloorMs} мс) больше runTimeoutMs (${policy.runTimeoutMs} мс)`,
    );
  // Облегчённый режим (alpha.69, ревью): сеть исполнителя не ограничивается
  // (сам CLI ходит к модели), поэтому явное `network: none|loopback` профиля
  // исполнителя не выполняется — отказ, а не молчаливое игнорирование.
  if (hostEnvironment(policy)) {
    const writerProfiles = new Set(
      [
        ...Object.values(policy.roles),
        ...policy.repositories.flatMap((r) => Object.values(r.roles ?? {})),
      ].flatMap((b) => (b.writer.toolProfile ? [b.writer.toolProfile] : [])),
    );
    for (const id of writerProfiles) {
      const net = policy.toolProfiles[id]?.network;
      if (net === 'none' || net === 'loopback')
        add(
          'INVALID_INPUT',
          ['toolProfiles', id, 'network'],
          `network: ${net} профиля исполнителя в облегчённом режиме не выполняется (исполнитель работает на хосте с сетью): уберите поле или выберите harnessMode: strict (решение владельца)`,
        );
    }
  }
  // Сеть профиля однозначна: `network` не спорит с `codexNetwork`, а вся сеть
  // claude задаётся доменами `isolation.domains`, не профилем.
  for (const [id, profile] of Object.entries(policy.toolProfiles)) {
    if (profile.network && profile.network !== 'full' && profile.codexNetwork)
      add(
        'INVALID_INPUT',
        ['toolProfiles', id, 'network'],
        `network: ${profile.network} противоречит codexNetwork: true — уберите codexNetwork`,
      );
    // Без интернета веб-инструменты claude закрыты: разрешение на них — спор с режимом.
    if (profile.network === 'none' || profile.network === 'loopback')
      for (const rule of profile.claudeAllowedTools)
        if (/^Web(?:Fetch|Search)(?:$|\()/.test(rule))
          add(
            'INVALID_INPUT',
            ['toolProfiles', id, 'claudeAllowedTools'],
            `${rule} ходит в сеть мимо песочницы: с network: ${profile.network} он закрыт — уберите правило или выберите другой режим`,
          );
    if (profile.network === 'full' && profile.runtime !== 'codex')
      add(
        'INVALID_INPUT',
        ['toolProfiles', id, 'network'],
        'network: full поддерживается только для codex; claude получает внешние адреса через isolation.domains',
      );
  }
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
    // Шлюз gates (alpha.69) ссылается только на объявленные порты попытки.
    if (repo.gateway)
      for (const [, name] of repo.gateway.url.matchAll(/\$\{([^}]*)\}/g))
        if (!policy.attemptEnv?.ports?.includes(name!))
          add(
            'INVALID_INPUT',
            ['repositories', r, 'gateway', 'url'],
            `Шлюз ссылается на \${${name}}, а такого порта нет в attemptEnv.ports`,
          );
    // UI gates (alpha.69) — только облегчённый режим: в песочнице ОС
    // проверок на macOS не стартует ни Chromium (нужен mach-register), ни
    // симулятор (CoreSimulator XPC, запись в ~/Library/Developer).
    repo.gates.forEach((g, i) => {
      if (g.ui && harnessModeOf(policy) === 'strict' && policy.isolation.mode === 'os')
        add(
          'INVALID_INPUT',
          ['repositories', r, 'gates', i, 'ui'],
          `UI gate ${g.id} (${g.ui.type}) в строгом режиме не исполняется: в песочнице ОС проверок браузер и симулятор не стартуют. Облегчённый режим (решение владельца) или браузер в контейнере обычным gate без блока ui`,
        );
    });
    // Пул устройств мобильного UI gate — ресурсы kind: device.
    repo.gates.forEach((g, i) => {
      if (g.ui?.type !== 'mobile') return;
      for (const id of g.ui.device.pool ?? [])
        if (!policy.resources.some((x) => x.id === id && x.kind === 'device'))
          add(
            'INVALID_INPUT',
            ['repositories', r, 'gates', i, 'ui', 'device', 'pool'],
            `Устройство ${id} пула не объявлено ресурсом kind: device`,
          );
    });
    if (!repo.gates.some((g) => g.kind === 'test'))
      add(
        'INVALID_INPUT',
        ['repositories', r, 'gates'],
        'Нужен хотя бы один test gate с JUnit report',
      );
    // Условие путей: хотя бы один test gate исполняется всегда, и генеративный
    // gate условным не бывает (его seed и отчёт свойств — доказательство).
    else if (!repo.gates.some((g) => g.kind === 'test' && !whenPaths(g)))
      add(
        'INVALID_INPUT',
        ['repositories', r, 'gates'],
        'Нужен хотя бы один test gate без when: все test gates не могут быть условными',
      );
    repo.gates.forEach((g, i) => {
      if (whenPaths(g) && g.property)
        add(
          'INVALID_INPUT',
          ['repositories', r, 'gates', i, 'when'],
          'Генеративный gate (property) не может быть условным (when)',
        );
    });
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
      writerProbe: repo.writerProbe ?? [],
    }))
      if (new Set(steps.map((s) => s.id)).size !== steps.length)
        add('INVALID_INPUT', ['repositories', r, name], 'Step ids должны быть уникальны');
    issues.push(...generatorIssues(repo, ['repositories', r, 'generators']));
    issues.push(
      ...infraIssues(repo, ['repositories', r, 'infra'], {
        ...(policy.lifecycle ? { lifecycle: policy.lifecycle } : {}),
        ...(policy.workspaceLifecycle ? { workspaceLifecycle: policy.workspaceLifecycle } : {}),
      }),
    );
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

/**
 * Действующий предел времени исполнения gate: объявленный `timeoutMs`, не
 * меньше `gateTimeoutFloorMs` политики, если он задан.
 */
export function gateTimeoutMs(
  gate: { timeoutMs: number },
  policy: { gateTimeoutFloorMs?: number | undefined },
): number {
  return Math.max(gate.timeoutMs, policy.gateTimeoutFloorMs ?? 0);
}

/**
 * Предел времени gate для текста отказа: действующий в секундах и, если его
 * поднял `gateTimeoutFloorMs`, объявленный.
 */
export function gateTimeoutText(
  gate: { timeoutMs: number },
  policy: { gateTimeoutFloorMs?: number | undefined },
): string {
  const seconds = (ms: number) => `${Math.round(ms / 100) / 10} с`;
  const effective = gateTimeoutMs(gate, policy);
  return effective > gate.timeoutMs
    ? `предел ${seconds(effective)} (объявлен ${seconds(gate.timeoutMs)}, поднят gateTimeoutFloorMs)`
    : `предел ${seconds(effective)}`;
}
