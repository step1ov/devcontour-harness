import { HarnessError } from '../contracts/errors.ts';
import { digestOf } from '../contracts/digest.ts';
import type { PlanningFacts } from '../contracts/planning.ts';

export interface PlanningInput {
  brief: string;
  facts: PlanningFacts;
  hostInstructions?: string[];
  /** По умолчанию 15. */
  recommendedTasks?: number;
}
export interface PlanningRequest {
  prompt: string;
  readOnly: true;
  recommendedTasks: number;
  maxTasks: 30;
  basis: string;
}

/**
 * Общие разделы prompt планирования (S1–S11): смысл подсказки DevContour без
 * продуктовых строк хоста. Host-инструкции идут отдельным блоком перед brief,
 * brief — последним.
 */
function sharedSections(facts: PlanningFacts, recommendedTasks: number): string[] {
  return [
    `Inspect the repository read-only. Propose a small first vertical slice, at most ${recommendedTasks} tasks. Do not edit files, run implementation agents, commit, or mark tasks done. Independent plan review follows; the coordinator handles approval according to project policy.`,
    "Declared roles, by repository. A task may only use a role declared for its own repository; no other role exists. Where a role has writePaths, the task's writePaths must lie inside them, or the executor can change nothing. A role marked requiresContract needs an approved contract bound to its task: " +
      JSON.stringify(facts.roles),
    'Configured checks, by repository. A task proves itself with gates: a subset of these that must include a test gate; a named group is referenced as "@name" instead of listing its members, and nothing is inherited implicitly. A task in a library proves its consumers only when it declares them: consumers lists dependent components and their gates or groups, run against the integrated result of the task. Requirements link to a test gate from that same subset: ' +
      JSON.stringify(facts.gates),
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
  const recommendedTasks = input.recommendedTasks ?? 15;
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
    ...sharedSections(facts, recommendedTasks),
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
