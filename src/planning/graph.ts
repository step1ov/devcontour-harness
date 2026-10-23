import type { CodedIssue } from '../contracts/errors.ts';
import {
  API_VERSION,
  idSchema,
  workGraphSchema,
  type SourceRef,
  type WorkGraph,
  type WorkGraphInput,
  type WorkOrderInput,
} from '../contracts/index.ts';
import type { PlanningFacts, StandalonePlanDraft } from '../contracts/planning.ts';

/**
 * Draft → WorkGraph (OP-PLAN-04): digests контрактов из фактов, не выдумываются.
 * Вызывается после пустого `draftIssues`. Пределы исполняемого поручения
 * (ID ≤ 80, acceptance ≤ 30 по 3–1500, текст без пробелов по краям,
 * contracts ≤ 30) проверяет `workGraphSchema`; его нарушения — issues с
 * путями `['graph', 'orders', i, …]`, где `orders[i]` — это `tasks[i]`.
 * При любых issues графа нет.
 */
export function draftToGraph(
  draft: StandalonePlanDraft,
  options: {
    graphId: string;
    source: SourceRef;
    facts: PlanningFacts;
    idOf?: (key: string) => string;
  },
): { graph?: WorkGraph; issues: CodedIssue[] } {
  const { graphId, source, facts } = options;
  const idOf = options.idOf ?? ((key: string) => key);
  const issues: CodedIssue[] = [];
  /** Пути zod, которые уже названы issue задачи: второй раз их не сообщаем. */
  const named = new Set<string>();
  const ids = new Map<string, string>();
  const invalid = new Set<string>();
  draft.tasks.forEach((task, i) => {
    const id = idOf(task.key);
    if (!ids.has(task.key)) ids.set(task.key, id);
    if (!idSchema.safeParse(id).success) {
      invalid.add(id);
      named.add(JSON.stringify(['orders', i, 'id']));
      issues.push({
        code: 'INVALID_INPUT',
        path: ['tasks', i, 'key'],
        message: `Ключ задачи не годится в ID поручения (1–80 символов A-Z, a-z, 0-9, _ и -): ${task.key}`,
      });
    }
  });
  const contracts = new Map(facts.contracts.map((c) => [c.id, c.digest]));
  const orders = draft.tasks.map((task, i): WorkOrderInput => {
    const id = idOf(task.key);
    const dependsOn: string[] = [];
    task.dependsOn.forEach((dep, d) => {
      const target = ids.get(dep);
      if (target === undefined)
        issues.push({
          code: 'GRAPH_UNKNOWN_DEPENDENCY',
          path: ['tasks', i, 'dependsOn', d],
          message: 'Неизвестная зависимость плана ' + dep,
        });
      else {
        if (invalid.has(target))
          named.add(JSON.stringify(['orders', i, 'dependsOn', dependsOn.length]));
        dependsOn.push(target);
      }
    });
    const refs: { id: string; digest: string }[] = [];
    task.contracts.forEach((c, k) => {
      const digest = contracts.get(c);
      if (digest === undefined)
        issues.push({
          code: 'INVALID_INPUT',
          path: ['tasks', i, 'contracts', k],
          message: `Контракт не объявлен в фактах проекта: ${c}; digest не выдумывается`,
        });
      else refs.push({ id: c, digest });
    });
    if (task.scope === 'component' && task.relatedRepositories?.length)
      issues.push({
        code: 'INVALID_INPUT',
        path: ['tasks', i, 'relatedRepositories'],
        message:
          'Задача уровня component не называет связанных репозиториев: для нескольких компонентов — scope workspace',
      });
    return {
      apiVersion: API_VERSION,
      id,
      source: { connector: source.connector, ref: id, revision: source.revision },
      title: task.title,
      goal: task.description,
      acceptance: task.acceptance,
      role: task.role,
      repositoryId: task.repositoryId,
      relatedRepositories: task.scope === 'workspace' ? (task.relatedRepositories ?? []) : [],
      writeScope: task.writePaths ?? ['.'],
      dependsOn,
      ...(task.gates ? { gates: task.gates } : {}),
      ...(task.consumers ? { consumers: task.consumers } : {}),
      ...(task.properties ? { properties: task.properties } : {}),
      ...(task.resources ? { resources: task.resources } : {}),
      requirements: task.requirements ?? [],
      contracts: refs,
      context: task.contextPacks ?? [],
    };
  });
  const candidate: WorkGraphInput = {
    apiVersion: API_VERSION,
    id: graphId,
    source,
    orders,
    prerequisites: [],
  };
  const parsed = workGraphSchema.safeParse(candidate);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const path = issue.path as (string | number)[];
      if (named.has(JSON.stringify(path))) continue;
      issues.push({ code: 'INVALID_INPUT', path: ['graph', ...path], message: issue.message });
    }
  if (issues.length || !parsed.success) return { issues };
  return { graph: parsed.data, issues };
}
