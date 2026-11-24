import { z } from 'zod';
import { API_VERSION } from './version.ts';
import {
  digestSchema,
  gateRefSchema,
  gitShaSchema,
  idSchema,
  relativePathSchema,
  roleIdSchema,
  trimmedText,
  gateScopeSchema,
  workLabelSchema,
} from './primitives.ts';
import { digestOf } from './digest.ts';
import type { CodedIssue } from './errors.ts';
import { workKindSchema } from './infra.ts';

/**
 * Откуда пришло поручение: коннектор, ключ записи в нём и её редакция.
 * Результат всегда относится к этой редакции; более новая редакция в
 * источнике старым результатом не закрывается.
 */
export const sourceRefSchema = z.strictObject({
  connector: idSchema,
  ref: z.string().min(1).max(300),
  revision: z.string().min(1).max(200),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const propertyIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,200}$/, 'property ID без пробелов');

/** Требование, закреплённое за поручением: текст, digest источника и проверяющий gate. */
export const requirementSchema = z.strictObject({
  id: z.string().regex(/^REQ-[A-Za-z0-9_-]{1,64}$/),
  source: relativePathSchema,
  digest: digestSchema,
  text: z.string().min(3).max(12000),
  gate: idSchema,
  scenario: z.string().min(3).max(1500),
  /** testcase отчёта, который проверяет сценарий (`classname.name` в JUnit). */
  testId: z.string().min(1).max(300).optional(),
});

/**
 * Источник критерия приёмки (0.1.0-alpha.70, правило «ведущий не добавляет
 * требований без источника»): `brief` — постановка (задача источника, её
 * раздел), `owner-answer` — ответ владельца (ID запроса), `review-finding` —
 * находка ревью (ID находки), `context` — закреплённый документ. `ref` —
 * где именно; `criterion` — номер критерия в `acceptance` (с 0).
 */
export const criterionSourceKinds = ['brief', 'owner-answer', 'review-finding', 'context'] as const;
export const criterionSourceSchema = z.strictObject({
  criterion: z.number().int().min(0).max(29),
  kind: z.enum(criterionSourceKinds),
  ref: z.string().trim().min(1).max(300),
});
export type CriterionSource = z.infer<typeof criterionSourceSchema>;

/** Ссылка на закреплённый контракт: исполнение идёт против этого digest. */
export const contractRefSchema = z.strictObject({ id: idSchema, digest: digestSchema });

/** Проверка потребителя: компонент и его gates против integration результата. */
export const consumerSchema = z.strictObject({
  repositoryId: idSchema,
  gates: gateScopeSchema(gateRefSchema).min(1),
});

/**
 * Область записи: изменения вне неё отклоняют попытку. `["."]` — весь
 * репозиторий (защищённые и генерируемые пути и область роли по-прежнему
 * ограничивают запись); `.` допустим только как единственный элемент.
 */
export const writeScopeSchema = z
  .array(z.union([z.literal('.'), relativePathSchema]))
  .min(1)
  .max(100)
  .refine((paths) => !paths.includes('.') || paths.length === 1, {
    message: 'Весь репозиторий (".") — единственный элемент области записи',
  });

/**
 * Исполняемое поручение. Это снимок постановки, а не редактируемая задача:
 * изменение любого поля — новая редакция источника и новый digest, и прежнее
 * согласование к ней не относится.
 */
export const workOrderSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  id: idSchema,
  source: sourceRefSchema,
  title: trimmedText(3, 180),
  goal: trimmedText(10, 12000),
  acceptance: z.array(trimmedText(3, 1500)).min(1).max(30),
  role: roleIdSchema,
  repositoryId: idSchema,
  /** Связанные репозитории поручения уровня workspace; пусто — один репозиторий. */
  relatedRepositories: z.array(idSchema).max(10).default([]),
  writeScope: writeScopeSchema,
  dependsOn: z.array(idSchema).max(100).default([]),
  /** Область доказательства: подмножество gates/групп политики. Нет поля — все gates репозитория. */
  gates: gateScopeSchema(gateRefSchema).optional(),
  consumers: z.array(consumerSchema).max(10).optional(),
  /** Свойства договора проверки, которые поручение подтверждает сейчас. */
  properties: z.array(propertyIdSchema).max(30).optional(),
  resources: z.array(idSchema).max(20).optional(),
  requirements: z.array(requirementSchema).max(30).default([]),
  contracts: z.array(contractRefSchema).max(30).default([]),
  /** Обязательные источники контекста по ID ContextSnapshot. */
  context: z.array(idSchema).max(30).default([]),
  /**
   * Вид работы (alpha.67, docs/infra-works.md): `infra` — код инфраструктуры
   * harness в области `repositories[].infra.paths`. Нет поля — продуктовая:
   * необязательное поле без умолчания сохраняет digest прежних поручений.
   */
  kind: workKindSchema.optional(),
  /**
   * Только `infra`: файлы gates доверенной базы, которые работа меняет
   * (новое определение gate). Список входит в digest графа: изменение
   * определения gate согласует ревью плана, а не ревью кода.
   */
  gateChanges: z.array(relativePathSchema).min(1).max(50).optional(),
  /**
   * Метки работы (0.1.0-alpha.70): `security`, `payments`, `auth` включают
   * второй проход ревью на каждом раунде; `docs` — работа документации
   * выпуска. Необязательное поле без умолчания: digest прежних поручений тот же.
   */
  labels: z.array(workLabelSchema).min(1).max(10).optional(),
  /**
   * Источники критериев, которые написал ведущий (0.1.0-alpha.70,
   * `criterionSourceSchema`): по номеру критерия `acceptance` — постановка,
   * ответ владельца или находка ревью. Ревью плана помечает критерий без
   * источника. Нет поля — поручение прежней версии.
   */
  criteriaSources: z.array(criterionSourceSchema).max(30).optional(),
});
export type WorkOrder = z.infer<typeof workOrderSchema>;
export type WorkOrderInput = z.input<typeof workOrderSchema>;

/**
 * Выполненная внешняя предпосылка. Принимается, только если её подтвердил
 * сам движок (`engine`) либо доверенный получателем receipt; в обоих случаях
 * result SHA обязан быть доступен в целевой ветке. Отметка `done` без SHA
 * доказательством не является.
 */
export const prerequisiteSchema = z.strictObject({
  id: idSchema,
  repositoryId: idSchema,
  resultSha: gitShaSchema,
  receipt: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('engine'), runId: z.string().min(1).max(200) }),
    z.strictObject({
      kind: z.literal('trusted'),
      issuer: idSchema,
      digest: digestSchema,
    }),
  ]),
});
export type Prerequisite = z.infer<typeof prerequisiteSchema>;

/** Неизменяемый снимок состава и зависимостей поручений одного согласования. */
export const workGraphSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  id: idSchema,
  source: sourceRefSchema,
  orders: z.array(workOrderSchema).min(1).max(500),
  prerequisites: z.array(prerequisiteSchema).max(500).default([]),
});
export type WorkGraph = z.infer<typeof workGraphSchema>;
export type WorkGraphInput = z.input<typeof workGraphSchema>;

export const workOrderDigest = (order: WorkOrder) => digestOf(order);
/** Digest графа закрепляет согласование: смена состава или поручения — новый digest. */
export const workGraphDigest = (graph: WorkGraph) => digestOf(graph);
/**
 * Digest содержания плана (0.1.0-alpha.68): граф без ревизии источника
 * набора. Поручения, их ревизии источника (постановки задач), зависимости и
 * предпосылки входят; ревизия набора, которую меняют одни необязательные
 * документы, — нет. Тот же digest после одобренного раунда — тот же план:
 * его повторное ревью не тратит предел раундов (`ReviewRecord.counted`).
 */
export const planContentDigest = (graph: WorkGraph) =>
  digestOf({ ...graph, source: { connector: graph.source.connector, ref: graph.source.ref } });

/**
 * Содержание поручения, значимое для плана (0.1.0-alpha.69): всё, что
 * исполнитель делает и чем доказывает, — заголовок, цель, критерии приёмки,
 * роль, репозитории, область записи, зависимости, gates и потребители,
 * свойства, ресурсы, требования (без digest документа-источника), привязанные
 * контракты (по ID; содержание контракта проверяет своё ревью), обязательный
 * контекст (ID источников), вид работы и меняемые gates. Не входит: версия
 * API и источник постановки (`source`: коннектор, ключ, ревизия) — новая
 * ревизия источника без изменения этих полей планом не считается.
 */
export const planOrderDigest = (order: WorkOrder) =>
  digestOf({
    ...order,
    apiVersion: undefined,
    source: undefined,
    requirements: order.requirements.map((r) => ({ ...r, digest: undefined })),
    contracts: order.contracts.map((c) => c.id),
  });

/**
 * Состав плана для счёта раундов ревью (0.1.0-alpha.69): ID поручения →
 * `planOrderDigest`. Настоящее изменение плана — другой набор ID или другой
 * digest поручения против прежнего одобренного раунда; предпосылки графа
 * (доказательства выполненного) и ревизия набора сюда не входят.
 */
export const planOrderDigests = (graph: WorkGraph): Record<string, string> =>
  Object.fromEntries(graph.orders.map((o) => [o.id, planOrderDigest(o)]));

/**
 * Постановка поручения для доработки (alpha.69, ревью): цель и критерии
 * приёмки. Их изменение у принятой работы — настоящее изменение плана, а не
 * бесплатная доработка.
 */
export const planStatementDigest = (order: Pick<WorkOrder, 'goal' | 'acceptance'>) =>
  digestOf({ goal: order.goal, acceptance: order.acceptance });
export const planStatementDigests = (graph: WorkGraph): Record<string, string> =>
  Object.fromEntries(graph.orders.map((o) => [o.id, planStatementDigest(o)]));

/**
 * Какие поручения изменились против прежнего состава плана: добавленные,
 * убранные и с другим содержанием (`planOrderDigests`), по ID.
 */
export function planOrderChanges(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...ids].filter((id) => before[id] !== after[id]).sort();
}

/**
 * Структурная проверка графа до любой записи: повтор ID, неизвестная
 * зависимость, цикл. Зависимость разрешается поручением этого графа либо
 * подтверждённой предпосылкой; другого способа считать её выполненной нет.
 */
export function graphIssues(graph: WorkGraph): CodedIssue[] {
  const issues: CodedIssue[] = [];
  const ids = new Map<string, number>();
  graph.orders.forEach((order, index) => {
    if (ids.has(order.id))
      issues.push({
        code: 'GRAPH_DUPLICATE_ID',
        path: ['orders', index, 'id'],
        message: 'Повтор ID поручения: ' + order.id,
      });
    else ids.set(order.id, index);
  });
  const external = new Set<string>();
  graph.prerequisites.forEach((p, index) => {
    if (ids.has(p.id) || external.has(p.id))
      issues.push({
        code: 'GRAPH_DUPLICATE_ID',
        path: ['prerequisites', index, 'id'],
        message: 'Предпосылка повторяет ID: ' + p.id,
      });
    external.add(p.id);
  });
  graph.orders.forEach((order, index) =>
    order.dependsOn.forEach((dep, d) => {
      if (dep === order.id)
        issues.push({
          code: 'GRAPH_CYCLE',
          path: ['orders', index, 'dependsOn', d],
          message: 'Поручение зависит от себя: ' + dep,
        });
      else if (!ids.has(dep) && !external.has(dep))
        issues.push({
          code: 'GRAPH_UNKNOWN_DEPENDENCY',
          path: ['orders', index, 'dependsOn', d],
          message: `Неизвестная зависимость ${order.id} → ${dep}`,
        });
    }),
  );
  // Цикл ищется обходом в глубину с цветами; путь цикла называется в сообщении.
  const color = new Map<string, 1 | 2>();
  const byId = new Map(graph.orders.map((o) => [o.id, o]));
  const reported = new Set<string>();
  const visit = (id: string, path: string[]) => {
    color.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep === id || !byId.has(dep)) continue;
      if (color.get(dep) === 1) {
        const cycle = [...path.slice(path.indexOf(dep)), dep];
        const key = [...cycle].sort().join(',');
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({
            code: 'GRAPH_CYCLE',
            path: ['orders', ids.get(dep)!, 'dependsOn'],
            message: 'Цикл зависимостей: ' + cycle.join(' → '),
          });
        }
      } else if (!color.has(dep)) visit(dep, [...path, dep]);
    }
    color.set(id, 2);
  };
  for (const order of graph.orders) if (!color.has(order.id)) visit(order.id, [order.id]);
  return issues;
}
