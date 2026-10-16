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
} from './primitives.ts';
import { digestOf } from './digest.ts';
import type { ErrorIssue } from './errors.ts';

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

/** Ссылка на закреплённый контракт: исполнение идёт против этого digest. */
export const contractRefSchema = z.strictObject({ id: idSchema, digest: digestSchema });

/** Проверка потребителя: компонент и его gates против integration результата. */
export const consumerSchema = z.strictObject({
  repositoryId: idSchema,
  gates: z.array(gateRefSchema).min(1).max(20),
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
  /** Область записи: изменения вне неё отклоняют попытку. */
  writeScope: z.array(relativePathSchema).min(1).max(100),
  dependsOn: z.array(idSchema).max(100).default([]),
  /** Область доказательства: подмножество gates/групп политики. Нет поля — все gates репозитория. */
  gates: z.array(gateRefSchema).max(20).optional(),
  consumers: z.array(consumerSchema).max(10).optional(),
  /** Свойства договора проверки, которые поручение подтверждает сейчас. */
  properties: z.array(propertyIdSchema).max(30).optional(),
  resources: z.array(idSchema).max(20).optional(),
  requirements: z.array(requirementSchema).max(30).default([]),
  contracts: z.array(contractRefSchema).max(30).default([]),
  /** Обязательные источники контекста по ID ContextSnapshot. */
  context: z.array(idSchema).max(30).default([]),
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
 * Структурная проверка графа до любой записи: повтор ID, неизвестная
 * зависимость, цикл. Зависимость разрешается поручением этого графа либо
 * подтверждённой предпосылкой; другого способа считать её выполненной нет.
 */
export function graphIssues(graph: WorkGraph): (ErrorIssue & { code: string })[] {
  const issues: (ErrorIssue & { code: string })[] = [];
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
