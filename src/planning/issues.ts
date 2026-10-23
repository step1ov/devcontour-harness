import { sha256 } from '../contracts/digest.ts';
import type { CodedIssue, ErrorCode } from '../contracts/errors.ts';
import type { z } from 'zod';
import type { CheckGap, PlanDraft, PlanningFacts, planDraft } from '../contracts/planning.ts';
import { expandGateRefs } from '../contracts/policy.ts';
import { withinPaths } from '../validate.ts';

/**
 * Задача draft без расширения хоста. `PlanDraft` выводится из `ReturnType`
 * обобщённой `planDraft` и сейчас теряет типы полей, поэтому задача берётся
 * из явного инстанцирования.
 */
type Task = z.output<ReturnType<typeof planDraft<Record<never, never>>>>['tasks'][number];
const tasksOf = (draft: PlanDraft) => (draft as { tasks: Task[] }).tasks;
type GateFacts = PlanningFacts['gates'][number];
type Path = (string | number)[];

/**
 * Gates репозитория из фактов в форме, которую раскрывает `expandGateRefs`:
 * ей нужны только ID gates, группы и ID репозитория. Репозиторий без записи
 * в `facts.gates` — без gates: любая ссылка на gate неизвестна.
 */
const gateRepo = (facts: PlanningFacts, repositoryId: string) => {
  const entry: GateFacts = facts.gates.find((g) => g.repositoryId === repositoryId) ?? {
    repositoryId,
    gates: [],
  };
  const repo = {
    id: repositoryId,
    gates: entry.gates,
    gateGroups: entry.groups,
  } as unknown as Parameters<typeof expandGateRefs>[0];
  return { entry, repo };
};

/**
 * Область gates задачи по каждой ссылке отдельно: ссылка, которая не
 * раскрывается, даёт свою ошибку и в область не входит, остальные — входят.
 * Без ссылок — все gates репозитория, как у поручения без поля `gates`.
 */
const gateScope = (facts: PlanningFacts, task: Task) => {
  const { entry, repo } = gateRepo(facts, task.repositoryId);
  const failures: { index: number; ref: string; code: ErrorCode; message: string }[] = [];
  if (!task.gates?.length) return { entry, scope: entry.gates.map((g) => g.id), failures };
  const scope: string[] = [];
  task.gates.forEach((ref, index) => {
    try {
      for (const id of expandGateRefs(repo, [ref])) if (!scope.includes(id)) scope.push(id);
    } catch (error) {
      failures.push({
        index,
        ref,
        code: (error as { code?: ErrorCode }).code ?? 'GATE_UNKNOWN',
        message: (error as Error).message,
      });
    }
  });
  return { entry, scope, failures };
};

const testGatesOf = (entry: GateFacts) =>
  entry.gates.filter((g) => g.kind === 'test').map((g) => g.id);

/** Проверки задачи против фактов проекта — в порядке полей. */
function factIssues(facts: PlanningFacts, task: Task, i: number): CodedIssue[] {
  const issues: CodedIssue[] = [];
  const at = (...p: Path) => ['tasks', i, ...p];
  const add = (code: ErrorCode, path: Path, message: string) =>
    issues.push({ code, path, message });
  const repositories = new Set(facts.repositories.map((r) => r.id));
  if (!repositories.has(task.repositoryId)) {
    add(
      'INVALID_INPUT',
      at('repositoryId'),
      'Репозиторий не объявлен в фактах проекта: ' + task.repositoryId,
    );
    return issues;
  }
  const role = facts.roles
    .find((r) => r.repositoryId === task.repositoryId)
    ?.roles.find((r) => r.role === task.role);
  if (!role)
    add(
      'INVALID_INPUT',
      at('role'),
      `Роль не объявлена для репозитория ${task.repositoryId}: ${task.role}`,
    );
  task.relatedRepositories?.forEach((r, k) => {
    if (!repositories.has(r))
      add(
        'INVALID_INPUT',
        at('relatedRepositories', k),
        'Репозиторий не объявлен в фактах проекта: ' + r,
      );
  });
  const packs = new Set(facts.contextPacks.map((p) => p.id));
  task.contextPacks?.forEach((p, k) => {
    if (!packs.has(p))
      add(
        'INVALID_INPUT',
        at('contextPacks', k),
        'Пакет контекста не объявлен в фактах проекта: ' + p,
      );
  });
  const resources = new Set(facts.resources.map((r) => r.id));
  task.resources?.forEach((r, k) => {
    if (!resources.has(r))
      add('INVALID_INPUT', at('resources', k), 'Ресурс не объявлен в фактах проекта: ' + r);
  });
  const contracts = new Set(facts.contracts.map((c) => c.id));
  task.contracts.forEach((c, k) => {
    if (!contracts.has(c))
      add(
        'INVALID_INPUT',
        at('contracts', k),
        `Контракт не объявлен в фактах проекта: ${c}; digest не выдумывается`,
      );
  });
  const { entry, scope, failures } = gateScope(facts, task);
  for (const f of failures) add(f.code, at('gates', f.index), f.message);
  const tests = testGatesOf(entry);
  task.requirements?.forEach((req, k) => {
    if (sha256(req.text) !== req.digest)
      add(
        'INVALID_INPUT',
        at('requirements', k, 'digest'),
        'Текст требования не соответствует digest',
      );
    if (!tests.includes(req.gate))
      add(
        'INVALID_INPUT',
        at('requirements', k, 'gate'),
        'Требование должно ссылаться на test gate: ' + req.gate,
      );
    else if (!scope.includes(req.gate))
      add(
        'INVALID_INPUT',
        at('requirements', k, 'gate'),
        'Требование ссылается на проверку вне области задачи: ' + req.gate,
      );
  });
  const own = role?.writePaths;
  if (own?.length && task.writePaths)
    if (!task.writePaths.some((p) => withinPaths(p, own) || own.some((r) => withinPaths(r, [p]))))
      add(
        'INVALID_INPUT',
        at('writePaths'),
        `writePaths задачи не пересекаются с областью роли ${task.role}: исполнитель не сможет изменить ни одного файла`,
      );
  if (role?.requiresContract && !task.contracts.length)
    add(
      'INVALID_INPUT',
      at('contracts'),
      `Роль ${task.role} работает по согласованному контракту: задача должна ссылаться на контракт`,
    );
  return issues;
}

/**
 * Структурные проблемы draft (OP-PLAN-03); с `facts` — и ссылки на факты проекта.
 * Порядок: повтор ключа; зависимости по задачам (на себя, неизвестная); циклы;
 * затем по задачам — факты. Без `facts` — только структура: хост проверяет
 * контекст задач сам. Ничего не бросает и draft не меняет.
 */
export function draftIssues(
  draft: PlanDraft,
  options?: { known?: readonly string[]; facts?: PlanningFacts },
): CodedIssue[] {
  const issues: CodedIssue[] = [];
  const keys = new Map<string, number>();
  const tasks = tasksOf(draft);
  tasks.forEach((task, i) => {
    if (keys.has(task.key))
      issues.push({
        code: 'GRAPH_DUPLICATE_ID',
        path: ['tasks', i, 'key'],
        message: 'Повтор ключа задачи плана: ' + task.key,
      });
    else keys.set(task.key, i);
  });
  const known = new Set(options?.known ?? []);
  tasks.forEach((task, i) =>
    task.dependsOn.forEach((dep, d) => {
      if (dep === task.key)
        issues.push({
          code: 'GRAPH_CYCLE',
          path: ['tasks', i, 'dependsOn', d],
          message: 'Задача плана зависит от себя: ' + dep,
        });
      else if (!keys.has(dep) && !known.has(dep))
        issues.push({
          code: 'GRAPH_UNKNOWN_DEPENDENCY',
          path: ['tasks', i, 'dependsOn', d],
          message: 'Неизвестная зависимость плана ' + dep,
        });
    }),
  );
  // Цикл внутри draft — обход в глубину с цветами, как в `graphIssues`.
  const byKey = new Map<string, Task>();
  for (const task of tasks) if (!byKey.has(task.key)) byKey.set(task.key, task);
  const color = new Map<string, 1 | 2>();
  const reported = new Set<string>();
  const visit = (key: string, path: string[]) => {
    color.set(key, 1);
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (dep === key || !byKey.has(dep)) continue;
      if (color.get(dep) === 1) {
        const cycle = [...path.slice(path.indexOf(dep)), dep];
        const id = [...cycle].sort().join(',');
        if (!reported.has(id)) {
          reported.add(id);
          issues.push({
            code: 'GRAPH_CYCLE',
            path: ['tasks', keys.get(dep)!, 'dependsOn'],
            message: 'Цикл зависимостей плана: ' + cycle.join(' → '),
          });
        }
      } else if (!color.has(dep)) visit(dep, [...path, dep]);
    }
    color.set(key, 2);
  };
  for (const key of byKey.keys()) if (!color.has(key)) visit(key, [key]);
  const facts = options?.facts;
  if (facts) tasks.forEach((task, i) => issues.push(...factIssues(facts, task, i)));
  return issues;
}

/**
 * Недостающие проверки: план их подготовки, а не удаление из draft.
 * Неизвестный gate или группа — объявить gate; область задачи из известных
 * ссылок без test gate — добавить test gate. Задачи репозитория, которого нет
 * в фактах, сюда не входят: это ошибка draft, а не недостающая проверка.
 */
export function checkGaps(draft: PlanDraft, facts: PlanningFacts): CheckGap[] {
  const gaps: CheckGap[] = [];
  const repositories = new Set(facts.repositories.map((r) => r.id));
  for (const task of tasksOf(draft)) {
    if (!repositories.has(task.repositoryId)) continue;
    const { entry, scope, failures } = gateScope(facts, task);
    const testGates = testGatesOf(entry);
    const base = { taskKey: task.key, repositoryId: task.repositoryId };
    for (const f of failures)
      if (f.code === 'GATE_UNKNOWN')
        gaps.push({
          kind: 'gate-undeclared',
          ...base,
          ref: f.ref,
          testGates: [...testGates],
          action: 'declare-gate',
        });
    if (!scope.some((id) => testGates.includes(id)))
      gaps.push({
        kind: 'test-gate-missing',
        ...base,
        testGates: [...testGates],
        action: 'add-test-gate',
      });
  }
  return gaps;
}
