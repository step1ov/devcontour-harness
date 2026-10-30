import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  HarnessError,
  digestOf,
  gateRefSchema,
  idSchema,
  roleIdSchema,
  sha256,
  gateScopeSchema,
  writeScopeSchema,
} from '../../contracts/index.ts';
import type { ProviderId, TaskColumn } from './transport.ts';

/**
 * Конфигурация коннектора внешнего хранилища задач.
 *
 * Provider выбирается явно (`relay-v1-http` | `relay-v2-cli`) и никогда не
 * угадывается по имени binary. `projectId` — ожидаемая идентичность проекта:
 * несовпадение с тем, что сообщил backend, блокирует любые мутации. Настройки
 * provider (`relay`) проверяет адаптер; ядро требует только минимально нужные
 * поля, чтобы ошибка была видна до подключения.
 */
export const providerIds = ['relay-v1-http', 'relay-v2-cli'] as const satisfies ProviderId[];
export const taskColumns = [
  'inbox',
  'ready',
  'in-progress',
  'review',
  'done',
  'cancelled',
] as const satisfies TaskColumn[];

const columnSchema = z.enum(taskColumns);

/** Сопоставление критерия задачи с доказательством принятого результата. */
export const criterionMappingSchema = z
  .strictObject({
    /** ID критерия backend (предпочтительно) или точный заголовок. */
    id: z.string().min(1).max(200).optional(),
    title: z.string().min(1).max(500).optional(),
    /** Gate, evidence которого (фаза integration, passed) подтверждает критерий. */
    gate: idSchema,
    /** Testcase JUnit (`classname.name`), который обязан пройти в этом evidence. */
    testId: z.string().min(1).max(300).optional(),
    /**
     * `test` (по умолчанию) — нужен testcase `testId`; `gate` — достаточно
     * прошедшего gate. Явный выбор: общий зелёный exit code сам по себе
     * критерий не закрывает.
     */
    evidence: z.enum(['test', 'gate']).default('test'),
  })
  .refine((m) => m.id !== undefined || m.title !== undefined, {
    message: 'Критерий сопоставляется по id или title',
  })
  .refine((m) => m.evidence === 'gate' || m.testId !== undefined, {
    message: 'evidence: test требует testId',
  });
export type CriterionMapping = z.infer<typeof criterionMappingSchema>;

export const taskMappingSchema = z.strictObject({
  /** Ссылка на задачу backend: постоянный ID или ключ (ключ разрешается в ID при снимке). */
  ref: z.string().min(1).max(200),
  role: roleIdSchema.default('developer'),
  repositoryId: idSchema.optional(),
  writeScope: writeScopeSchema,
  gates: gateScopeSchema(gateRefSchema).optional(),
  criteria: z.array(criterionMappingSchema).max(100).default([]),
  /** Документы, без которых запуск блокируется (ID, ключ или имя). Остальные — дополнительные. */
  requiredDocuments: z.array(z.string().min(1).max(200)).max(30).default([]),
  /**
   * Локальные пакеты контекста поручения — каталоги `<contextDir>/<id>` (например,
   * оверлей controller-mode). Закрепляются в снимке вместе с контекстом задачи;
   * изменение набора или содержимого пакетов — новый снимок и новое
   * согласование; semantic digest задачи от них не зависит.
   */
  context: z.array(idSchema).min(1).max(10).optional(),
});
export type TaskMapping = z.infer<typeof taskMappingSchema>;

const relaySettings = z.record(z.string(), z.unknown());

const common = {
  version: z.literal(1),
  projectId: z.string().min(1).max(200),
  actor: z.string().min(1).max(100),
  /**
   * Каталог состояния коннектора (относительно файла конфигурации); без него —
   * `--state` harness. Гарантия одного владельца доставки действует только
   * для процессов, разделяющих этот каталог.
   */
  stateDir: z.string().min(1).max(1000).optional(),
  /** Каталог пакетов `tasks[].context` (относительно файла конфигурации); по умолчанию `work/context`. */
  contextDir: z.string().min(1).max(1000).optional(),
  repository: z.strictObject({
    id: idSchema,
    /** Путь репозитория для сверки с политикой (относительно файла конфигурации). */
    path: z.string().min(1).max(1000).optional(),
  }),
  tasks: z.array(taskMappingSchema).min(1).max(50),
  completion: z
    .strictObject({
      /** `complete` — закрыть задачу по правилам backend; `review-only` — оставить на проверку человеку. */
      mode: z.enum(['complete', 'review-only']).default('complete'),
      /** Колонка после доставки; по умолчанию done (complete) или review (review-only). */
      column: columnSchema.optional(),
      /** После конфликта постановки записать явно исторический комментарий (не закрывает задачу). */
      historicalComment: z.boolean().default(false),
    })
    .default({ mode: 'complete', historicalComment: false }),
  eligibility: z
    .strictObject({
      /** Колонки, в которых задача допускается к запуску. done/cancelled не допускаются никогда. */
      columns: z.array(columnSchema).min(1).default(['ready', 'in-progress']),
    })
    .default({ columns: ['ready', 'in-progress'] }),
  limits: z
    .strictObject({
      documents: z.number().int().min(0).max(30).default(20),
      documentBytes: z
        .number()
        .int()
        .min(1)
        .max(2 * 1024 * 1024)
        .default(256 * 1024),
      totalBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1024 * 1024)
        .default(4 * 1024 * 1024),
      /** Предел текста постановки (описание и критерии) — обязательное содержимое. */
      taskBytes: z
        .number()
        .int()
        .min(1)
        .max(2 * 1024 * 1024)
        .default(1024 * 1024),
      /** Повторные чтения при изменении между страницами. */
      rereads: z.number().int().min(1).max(20).default(3),
      /** Срок владения доставкой, мс; больше таймаута транспорта. */
      leaseMs: z.number().int().min(1000).max(3_600_000).default(120_000),
    })
    .default({
      documents: 20,
      documentBytes: 256 * 1024,
      totalBytes: 4 * 1024 * 1024,
      taskBytes: 1024 * 1024,
      rereads: 3,
      leaseMs: 120_000,
    }),
  history: z
    .strictObject({
      enabled: z.boolean().default(true),
      client: z.string().min(1).max(100).default('devcontour-harness'),
    })
    .default({ enabled: true, client: 'devcontour-harness' }),
};

export const connectorConfigSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    ...common,
    provider: z.literal('relay-v1-http'),
    relay: relaySettings.and(z.looseObject({ endpoint: z.string().min(1) })),
  }),
  z.strictObject({
    ...common,
    provider: z.literal('relay-v2-cli'),
    relay: relaySettings.and(
      z.looseObject({
        binary: z.string().min(1),
        config: z.string().min(1),
        project: z.string().min(1).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    ),
  }),
]);
export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;
export type ConnectorConfigInput = z.input<typeof connectorConfigSchema>;

/** Загруженная конфигурация и каталог, от которого разрешаются её относительные пути. */
export interface LoadedConfig {
  config: ConnectorConfig;
  baseDir: string;
  file?: string;
}

export function parseConfig(value: unknown, baseDir: string, file?: string): LoadedConfig {
  const parsed = connectorConfigSchema.safeParse(value);
  if (!parsed.success)
    throw new HarnessError(
      'INVALID_INPUT',
      'source: конфигурация коннектора не прошла проверку схемы',
      parsed.error.issues.map((i) => ({
        path: ['source', ...(i.path as (string | number)[])],
        message: i.message,
      })),
    );
  const refs = parsed.data.tasks.map((t) => t.ref);
  const dup = refs.find((r, i) => refs.indexOf(r) !== i);
  if (dup) throw new HarnessError('INVALID_INPUT', 'source: задача указана дважды: ' + dup);
  // ID контекста задачи — `c` + 20 hex (contextIdOf): локальный пакет не может его занять.
  const taken = parsed.data.tasks
    .flatMap((t) => t.context ?? [])
    .find((id) => /^c[0-9a-f]{20}$/.test(id));
  if (taken)
    throw new HarnessError(
      'INVALID_INPUT',
      `source: пакет контекста ${taken} совпадает по форме с ID контекста задачи; выберите другое имя`,
    );
  return { config: parsed.data, baseDir, ...(file ? { file } : {}) };
}

export function loadConfig(path: string): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new HarnessError('INVALID_INPUT', `source: файл недоступен: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new HarnessError('INVALID_INPUT', `source: невалидный JSON: ${(error as Error).message}`);
  }
  return parseConfig(value, dirname(resolve(path)), resolve(path));
}

export const resolveFrom = (baseDir: string, path: string) =>
  isAbsolute(path) ? path : resolve(baseDir, path);

/* ------------------------------------------------------------------ */
/* Идентичность                                                        */
/* ------------------------------------------------------------------ */

const short = (text: string, n = 20) => sha256(text).slice(0, n);

/** ID коннектора (WorkSource/ResultSink и доверенный издатель receipts): provider + проект. */
export const connectorIdOf = (provider: ProviderId, projectId: string) =>
  `${provider}-${short(projectId, 12)}`;

/** Стабильная идентичность задачи: backend, проект и постоянный ID задачи. */
export const taskIdentity = (provider: ProviderId, projectId: string, taskId: string) =>
  `${provider}:${projectId}:${taskId}`;

export function parseIdentity(identity: string) {
  const [provider, ...rest] = identity.split(':');
  const taskId = rest.pop();
  const projectId = rest.join(':');
  if (!provider || !taskId || !projectId) return undefined;
  return { provider: provider as ProviderId, projectId, taskId };
}

/** ID поручения по идентичности задачи: одинаковые номера разных проектов/backend не совпадают. */
export const orderIdOf = (provider: ProviderId, projectId: string, taskId: string) =>
  't' + short(taskIdentity(provider, projectId, taskId));

export const contextIdOf = (orderId: string) => 'c' + orderId.slice(1);

/** ID графа по набору задач конфигурации. */
export const graphIdOf = (provider: ProviderId, projectId: string, taskIds: string[]) =>
  'g' + short([provider, projectId, ...[...taskIds].sort()].join('\n'));

/** Digest сопоставления задачи: входит в semantic digest — смена mapping требует нового согласования. */
export const mappingDigest = (config: ConnectorConfig, mapping: TaskMapping) =>
  digestOf({
    // Пакеты контекста — не постановка задачи: их ID и digest входят в ревизию
    // набора (новое согласование), но доставку принятого результата не меняют.
    mapping: { ...mapping, ref: undefined, context: undefined },
    repository: config.repository.id,
    completion: config.completion,
  });

/** Колонка завершения по правилам конфигурации. */
export const completionColumn = (config: ConnectorConfig): TaskColumn =>
  config.completion.column ?? (config.completion.mode === 'complete' ? 'done' : 'review');

/** Файл хранилища коннектора внутри каталога состояния. */
export const storeFileOf = (stateDir: string, provider: ProviderId, projectId: string) =>
  resolve(stateDir, 'connectors', `${provider}-${short(projectId, 16)}.sqlite`);
