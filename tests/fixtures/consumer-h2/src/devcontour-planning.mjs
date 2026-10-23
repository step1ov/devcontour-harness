/**
 * Хост, устроенный как DevContour: свой план (поля `featureId`, `assignee`),
 * свои продуктовые инструкции planner и свой импорт плана с прежними
 * статусами, а схема draft, общий prompt и структурные проблемы плана —
 * общие операции установленного пакета. Хост добавляет только свои поля,
 * тексты, ID задач и статусы отказов.
 */
import { z } from 'zod';
import { draftIssues, planDraft, planDraftJsonSchema, planningRequest } from 'devcontour-harness';

/** Прежний порядок полей задачи плана хоста: от него зависят байты JSON Schema и digest каталога. */
export const keyOrder = [
  'featureId',
  'requirements',
  'assignee',
  'scope',
  'relatedRepositories',
  'contextPacks',
  'writePaths',
  'gates',
  'properties',
  'resources',
  'repositoryId',
  'key',
  'title',
  'description',
  'role',
  'dependsOn',
  'acceptance',
  'contracts',
];

/** Поля хоста: привязка к фиче и исполнитель. */
export const hostTaskFields = {
  featureId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}$/)
    .optional(),
  assignee: z
    .string()
    .regex(/^[A-Za-z0-9_.@-]{1,80}$/)
    .optional(),
};

export const planResult = planDraft(hostTaskFields, { keyOrder });
/** `--output-schema` runtime планировщика. */
export const planSchema = planDraftJsonSchema(planResult);
/** Вход каталога операций хоста (`catalogDigest`). */
export const planInputSchema = z.toJSONSchema(planResult, { io: 'input' });

/** Продуктовые строки planner хоста: в общий prompt не входят, идут блоком host-инструкций. */
export const hostInstructions = [
  'You are a product planner.',
  'Include design references, prototype and semantic tokens when UI changes.',
  'Obtain REQ-* bindings with requirements_snapshot through the lead agent.',
  'Read the component intent when present (docs/implementation-intent.md for embedded workspace; INTENT.md otherwise). Use the source path returned by intent_snapshot. The lead prepares it from the specification, then uses intent_snapshot for exact story REQ bindings. Bind both the selected story and its detailed REQ sections to tasks. Cover only the requested release; preserve IDs, product purpose, constraints and non-goals. The release inventory must account for every declared source requirement, including work not yet decomposed. Do not weaken intent to fit implementation or mark a release complete from task counts.',
];

/** Конфигурация хоста → `PlanningFacts`: проекция 1:1, без вычислений. */
export function planningFacts(config, contracts) {
  return {
    repositories: config.repositories.map(({ id, name, kind, path }) => ({ id, name, kind, path })),
    roles: config.repositories.map((r) => ({
      repositoryId: r.id,
      roles: Object.entries(r.roles).map(([role, binding]) => ({
        role,
        ...(binding.title ? { title: binding.title } : {}),
        ...(binding.writePaths ? { writePaths: binding.writePaths } : {}),
        requiresContract: Boolean(binding.requiresContract),
      })),
    })),
    gates: config.repositories.map((r) => ({
      repositoryId: r.id,
      gates: r.gates.map(({ id, kind }) => ({ id, kind })),
      ...(r.groups ? { groups: r.groups } : {}),
    })),
    contextPacks: config.contextPacks,
    resources: config.resources,
    // M-4: записи контрактов целиком.
    contracts,
  };
}

/** Prompt planner хоста: общий запрос и продуктовые строки отдельным блоком. */
export function plannerPrompt(config, contracts, brief) {
  return planningRequest({ brief, facts: planningFacts(config, contracts), hostInstructions });
}

/** Ошибка домена хоста со статусом HTTP. */
export class DomainError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

/** Прежняя проверка ацикличности хоста по его ID задач. */
function assertDag(tasks) {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const visiting = new Set();
  const done = new Set();
  const visit = (id) => {
    if (visiting.has(id))
      throw new DomainError(`Цикл зависимостей: ${[...visiting, id].join(' → ')}`);
    if (done.has(id)) return;
    const task = map.get(id);
    if (!task) throw new DomainError(`Зависимость ${id} не существует`, 400);
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    done.add(id);
  };
  tasks.forEach((t) => visit(t.id));
}

/**
 * Импорт плана хоста: разбор своей схемой, свои per-task проверки, затем
 * `draftIssues` без `facts` (только структура) → прежние статусы: повтор
 * ключа — 400, неизвестная зависимость — 404, цикл — прежний отказ
 * `assertDag` (409). ID задач, исполнитель и транзакция — хоста.
 */
export function importPlan(store, input) {
  const plan = planResult.parse(input);
  for (const task of plan.tasks)
    if (!store.roles.includes(task.role))
      throw new DomainError('Роль не объявлена: ' + task.role, 400);
  const issues = draftIssues(plan, { known: store.tasks.map((t) => t.id) });
  const first = issues.find((i) => i.code !== 'GRAPH_CYCLE');
  if (first?.code === 'GRAPH_DUPLICATE_ID')
    throw new DomainError('Ключи задач должны быть уникальны', 400);
  if (first?.code === 'GRAPH_UNKNOWN_DEPENDENCY') {
    const [, i, , d] = first.path;
    throw new DomainError(`Неизвестная зависимость плана ${plan.tasks[i].dependsOn[d]}`, 404);
  }
  if (first) throw new DomainError(first.message, 400);
  const ids = new Map(plan.tasks.map((t, n) => [t.key, `T${store.tasks.length + n + 1}`]));
  const tasks = plan.tasks.map((t) => ({
    ...t,
    id: ids.get(t.key),
    dependsOn: t.dependsOn.map((key) => ids.get(key) ?? key),
    assignee: t.assignee ?? store.member,
    status: 'draft',
  }));
  const next = [...store.tasks, ...tasks];
  assertDag(next);
  store.tasks = next;
  return { tasks: tasks.length, issues };
}
