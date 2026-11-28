import { HarnessError } from '../contracts/errors.ts';
import { digestOf } from '../contracts/digest.ts';
import type { PlanningFacts } from '../contracts/planning.ts';

export interface PlanningInput {
  brief: string;
  facts: PlanningFacts;
  hostInstructions?: string[];
  /** По умолчанию 15. */
  recommendedTasks?: number;
  /** Тонкий режим (alpha.73): 3–5 работ, `THIN_TASK_SIZE_SECTION` вместо обычного размера. */
  thin?: boolean;
}
export interface PlanningRequest {
  prompt: string;
  readOnly: true;
  recommendedTasks: number;
  maxTasks: 30;
  basis: string;
}

/**
 * Размер задачи (alpha.71, D1/D2): одна задача на связный сценарий через
 * слои; общая тестовая инфраструктура первой задачи — внутри неё. Совет, не
 * проверка.
 */
export const TASK_SIZE_SECTION =
  'Size tasks by user scenario: one task per coherent user scenario, through every layer it needs (API, UI, data, tests). Split a scenario only by repository, or when its parts are truly independent and can be accepted separately. In light mode, shared test infrastructure (an acceptance launcher, fixtures, a test harness) that only the first product task needs belongs inside that task, not in a separate one; in strict mode, acceptance code under protected infra paths stays a separate infra task that the product tasks depend on.';

/** Сколько работ на фичу советует тонкий режим (alpha.73). */
export const THIN_TASKS = { min: 3, max: 5 } as const;

/**
 * Размер работы тонкого режима (alpha.73): работа — одна длинная сессия
 * исполнителя со своими проверками, поэтому работ мало и они крупные.
 * Работы без пути в dependsOn идут параллельно (alpha.75, R2): связь — только
 * настоящий интерфейс сборки или исполнения, общая тестовая инфраструктура —
 * у ранней работы контракта, сквозная проверка двух поверхностей — у выпуска.
 * Свои проверки работы — `gates`, чужие сценарии цели — `regressionGates`
 * (alpha.76, R3: исполнитель гоняет только свои, harness чужие — после ревью).
 * Совет, не проверка; plan-check советует при числе вне 3–5, цепочке и
 * пересечении областей параллельных работ.
 */
export const THIN_TASK_SIZE_SECTION = `Thin mode: plan ${THIN_TASKS.min}–${THIN_TASKS.max} tasks for the feature. Each task is one long writer session that runs its own gates until they pass, so make each task one coherent user scenario through every layer it needs (API, UI, data, tests). Split only by repository or into parts that are truly independent and can be accepted separately. Each task lists in gates its exact own checks: the gates that prove its acceptance criteria, one gate per suite it owns, never a glob or group that bundles another task's tests. The writer runs exactly these commands, and the harness reruns them on a clean checkout before the review. The slow suites of other tasks that this task must not break go to regressionGates: the harness runs them after the review approves and before accepting; the writer does not run them. Tasks without a path between them in dependsOn run in parallel, so add dependsOn only for a real build or runtime interface: a UI task depends on the API or SDK contract it consumes, not on another UI task. Shared test infrastructure (browser test config, fixtures, test environment helpers) belongs to the earliest contract task or to one small task of its own that the others depend on; never let two tasks that may run in parallel own or extend the same files. Browser test setup that several UI tasks use (the Playwright config, its global setup, shared fixtures and auth state) must be listed in the writePaths of that earliest contract task or of that one small shared task: a shared file in no task's writePaths is invisible to the plan check, and two parallel UI tasks then fail the same browser gate on it. A check that spans two surfaces (data entered in one UI, seen in another) is the release's job; inside a task, seed the data it needs through the API or SDK instead of depending on another UI task.`;

/**
 * Область gates задачи (alpha.71): только gates, покрывающие её критерии и
 * затронутые пакеты, — совет, не проверка.
 */
export const GATE_SCOPE_SECTION =
  "Scope each task's gates to the checks that cover its acceptance criteria and the packages it changes: include the gates of the touched packages and of the requirements it proves, and leave out slow acceptance or end-to-end gates of apps it does not touch (a web-only task does not need the API acceptance gate). Every test gate a requirement links to stays in that task's gates.";

/**
 * Общие разделы prompt планирования (S1–S11): смысл подсказки DevContour без
 * продуктовых строк хоста. Host-инструкции идут отдельным блоком перед brief,
 * brief — последним.
 */
function sharedSections(facts: PlanningFacts, recommendedTasks: number, thin = false): string[] {
  return [
    `Inspect the repository read-only. Propose a small first vertical slice, at most ${recommendedTasks} tasks. Do not edit files, run implementation agents, commit, or mark tasks done. Independent plan review follows; the coordinator handles approval according to project policy.`,
    thin ? THIN_TASK_SIZE_SECTION : TASK_SIZE_SECTION,
    "Declared roles, by repository. A task may only use a role declared for its own repository; no other role exists. Where a role has writePaths, the task's writePaths must lie inside them, or the executor can change nothing. A role marked requiresContract needs an approved contract bound to its task: " +
      JSON.stringify(facts.roles),
    'Configured checks, by repository. A task proves itself with gates: a subset of these that must include a test gate; a named group is referenced as "@name" instead of listing its members, and nothing is inherited implicitly. A task in a library proves its consumers only when it declares them: consumers lists dependent components and their gates or groups, run against the integrated result of the task. Requirements link to a test gate from that same subset: ' +
      JSON.stringify(facts.gates),
    GATE_SCOPE_SECTION,
    'Use a DAG with stable local keys. Roles owning separate surfaces can work in parallel once their shared contracts are agreed; test scenarios can be prepared early. Each task must have observable acceptance criteria. Return only the requested JSON structure.',
    'Keep component tasks scoped to their repository. Use scope=workspace and relatedRepositories only for work spanning multiple components. Component rules and task histories are local; the coordinator owns shared contracts and dependency links.',
    'Available repositories: ' +
      JSON.stringify(
        facts.repositories.map(({ id, name, kind, path }) => ({ id, name, kind, path })),
      ) +
      '. Every task must set repositoryId to a registered ID. Dependencies may cross repositories. Inspect the required repositories read-only.',
    'Assign narrow writePaths from actual repository structure. Use contextPacks IDs for relevant custom libraries and mobile testing; never invent IDs. Declare resources needed by task-level MCP work. Other-layer changes become dependent tasks, not scope expansion.',
    'When the specification has REQ-* sections, preserve exact id/source/text/digest bindings from the requirement snapshot you were given. Link each requirement to a configured test gate and an observable scenario; never invent a digest. Where the gate reports individual testcases, also name the testId that proves the scenario, exactly as the report spells it; acceptance verifies that this testcase ran and passed on the accepted commit.',
    'Available context packs: ' + JSON.stringify(facts.contextPacks),
    'Available resource IDs: ' +
      JSON.stringify(facts.resources.map(({ id, kind }) => ({ id, kind }))),
    // Записи контрактов целиком (M-4): source и декларация проверки не теряются.
    'Approved contracts available (only reference these IDs, or use an empty contracts array): ' +
      JSON.stringify(facts.contracts),
  ];
}

/** Read-only запрос планирования (OP-PLAN-01): чистая функция, модель не вызывает. */
export function planningRequest(input: PlanningInput): PlanningRequest {
  const { brief, facts } = input;
  const recommendedTasks = input.recommendedTasks ?? (input.thin ? THIN_TASKS.max : 5);
  if (!facts.roles.some((r) => r.roles.length > 0))
    throw new HarnessError(
      'INVALID_INPUT',
      'В конфигурации не объявлено ни одной роли: планировать некому. Объявите роли в профиле или в workspace.',
    );
  if (brief.trim() === '')
    throw new HarnessError('INVALID_INPUT', 'Пустая постановка: планировать нечего');
  if (!Number.isInteger(recommendedTasks) || recommendedTasks < 1 || recommendedTasks > 30)
    throw new HarnessError('INVALID_INPUT', 'recommendedTasks: ожидается целое 1–30');
  const host = (input.hostInstructions ?? []).filter((line) => line.trim() !== '');
  const prompt = [
    ...sharedSections(facts, recommendedTasks, input.thin),
    ...(host.length ? ['Host instructions:\n' + host.join('\n\n')] : []),
    'User brief:\n' + brief,
  ].join('\n\n');
  return {
    prompt,
    readOnly: true,
    recommendedTasks,
    maxTasks: 30,
    basis: planningBasis(brief, facts),
  };
}

/** digest постановки и фактов: draft по другому basis устарел. */
export function planningBasis(brief: string, facts: PlanningFacts): string {
  return digestOf({ brief, facts });
}
