import { z } from 'zod';

/**
 * «Что задействовано» (`resources` представления оператора, P4-8): модели и
 * вендоры ролей, изоляция, закреплённые версии инструментов, хранилище
 * зависимостей, службы lifecycle и число проверок — простыми словами для
 * человека не из разработки. Документ только для чтения; объекты закрыты,
 * списки и строки ограничены.
 *
 * Те же числа держит чистая проекция (`src/projections/view-resources.ts`,
 * браузерный бандл без zod): тест сверяет их с `RESOURCES_LIMITS`.
 */
export const RESOURCES_LIMITS = {
  /** Роли: исполнители, проверяющие (с запасными) и ведущий. */
  roles: 100,
  /** Закреплённые инструменты (`policy.toolchain` и `toolchain` репозиториев). */
  tools: 50,
  /** Репозитории в хранилище зависимостей и счёте проверок (как `policy.repositories`). */
  repositories: 10,
  /** Службы lifecycle (репозиторий × служба). */
  services: 50,
  /** Примеры попыток с оставшимся окружением у службы. */
  leftoverRuns: 5,
  /** Строки сводки для домашнего экрана. */
  lines: 8,
  /** Длины строк (символов) после маскирования. */
  text: {
    line: 300,
    id: 80,
    model: 200,
    name: 120,
    version: 120,
  },
} as const;

const T = RESOURCES_LIMITS.text;
const L = RESOURCES_LIMITS;
const count = z.number().int().min(0);
const id = z.string().min(1).max(T.id);
const line = z.string().min(1).max(T.line);
/** Сеть простыми словами: закрыта, только локальные адреса, только разрешённые домены, открыта, по-разному. */
export const resourcesNetworkSchema = z.enum(['closed', 'loopback', 'domains', 'open', 'mixed']);

export const resourcesViewSchema = z.strictObject({
  roles: z
    .array(
      z.strictObject({
        /** Роль исполнителя; у проверяющего — вид ревью или роль, код которой он проверяет. */
        role: id,
        kind: z.enum(['writer', 'reviewer', 'lead']),
        /** Вид ревью проверяющего. */
        review: z.enum(['plan', 'contract', 'code']).optional(),
        /** Запасной проверяющий (`alternates`). */
        alternate: z.literal(true).optional(),
        runtime: id,
        /** Вендор для человека: OpenAI, Anthropic, fixture. */
        vendor: id,
        model: z.string().min(1).max(T.model).optional(),
        effort: id.optional(),
        repositoryId: id.optional(),
        /** Сеть исполнителя (только `writer`). */
        network: resourcesNetworkSchema.optional(),
        line,
      }),
    )
    .max(L.roles),
  isolation: z.strictObject({
    /** `os` — песочница системы (Seatbelt на macOS, bubblewrap на Linux); `none` — выключена. */
    sandbox: z.enum(['os', 'none']),
    writers: resourcesNetworkSchema,
    gates: resourcesNetworkSchema,
    /** Число разрешённых внешних адресов (`isolation.domains`). */
    domains: count,
    line,
  }),
  toolchain: z.strictObject({
    tools: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(T.name),
          version: z.string().min(1).max(T.version),
          /** Нет поля — закрепление политики для всех процессов прогона. */
          repositoryId: id.optional(),
        }),
      )
      .max(L.tools),
    line,
  }),
  dependencyStore: z.strictObject({
    state: z.enum(['on', 'off', 'partial']),
    repositories: z
      .array(
        z.strictObject({
          repositoryId: id,
          manager: id,
          /** Готовые наборы зависимостей на диске; нет поля — не прочитано. */
          seeds: count.optional(),
        }),
      )
      .max(L.repositories),
    line,
  }),
  services: z
    .array(
      z.strictObject({
        /** Репозиторий; `@workspace` — совместная проверка. */
        repositoryId: id,
        name: z.string().min(1).max(T.name),
        /** `docker` — контейнеры; нет поля — команды lifecycle. */
        engine: z.literal('docker').optional(),
        /** `attempt` — своё окружение у каждой попытки; `workspace` — у совместной проверки. */
        scope: z.enum(['attempt', 'workspace']),
        running: count,
        stopped: count,
        leftover: count,
        /** Начало самого раннего из работающих. */
        since: z.iso.datetime().optional(),
        /** Попытки (run id), после которых окружение осталось: для `harness cleanup --run`. */
        leftoverRuns: z.array(id).max(L.leftoverRuns).optional(),
        line,
      }),
    )
    .max(L.services),
  gates: z.strictObject({
    total: count,
    /** Gates совместной проверки (`workspaceGates`). */
    workspace: count,
    repositories: z.array(z.strictObject({ repositoryId: id, count })).max(L.repositories),
    line,
  }),
  /** Короткие строки сводки для домашнего экрана. */
  lines: z.array(line).max(L.lines),
  /** Сколько записей отброшено пределом списка. */
  truncated: z
    .strictObject({
      roles: count.optional(),
      tools: count.optional(),
      services: count.optional(),
      /** Записи окружений (`environment.json`), не прочитанные пределом обхода. */
      receipts: count.optional(),
    })
    .optional(),
});
export type ResourcesViewDocument = z.infer<typeof resourcesViewSchema>;
