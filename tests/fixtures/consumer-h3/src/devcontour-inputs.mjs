/**
 * Входы каталога DevContour для H3: дословные копии `agentInputs`,
 * `descriptions` и `readOnly` 21 операции снимка
 * `tests/fixtures/catalog/devcontour-capabilities.json` на чистом zod.
 * Источник — `devcontour-dedup`, коммит 6a597286a1d59b107fa0365c9a0f01765696af90:
 *
 * - `id`, `agentInputs` (signal_status … contract_change_revise, plan_import,
 *   board_create, task_retry, task_assign, board_correct, queue_set,
 *   preview_status, checks_adopt, recovery_decide) — src/application/agent.ts:31–125;
 * - `descriptions` — src/application/agent.ts:142–247; `readOnly` — 248–272;
 * - `scope`, `paging`, `observabilityInputs` (usage_report, decision_report,
 *   strategy_replay) — src/application/observability.ts:8–25;
 * - `planResult` — src/core/plan.ts:3–37; поля `taskInput` и их зависимости
 *   (`roleId`, `id`, `gateRef`, `relativePath`, `requirementLink`,
 *   `propertyIdSchema`) — src/core/model.ts:24–26, 41–43, 53–66, 112–133, 135–189;
 *   `featureId` — src/core/preparation-model.ts:6–7.
 *
 * Единственный импорт harness — `recoveryActions` (в DevContour он из
 * `devcontour-harness`, agent.ts:27), и только в этом файле. В репозитории это
 * относительный путь к `src/contracts/index.ts`; в установленном consumer-h3,
 * где исходников нет, — `devcontour-harness/contracts` того же пакета.
 */
import { z } from 'zod';

const { recoveryActions } = await import(
  new URL('../../../../src/contracts/index.ts', import.meta.url).href
).catch(() => import('devcontour-harness/contracts'));

/* src/core/preparation-model.ts:6–7 */
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/);
const featureId = slug;

/* src/core/model.ts:24–26 */
const roleId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/, 'Идентификатор роли: строчные латинские буквы, цифры и дефис');
/* src/core/model.ts:41–43 */
const modelId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
/** Ссылка на gate или на именованную группу gates компонента (`@имя`). */
const gateRef = z.string().regex(/^@?[A-Za-z0-9_-]{1,80}$/);
/* src/core/model.ts:53–66 */
const relativePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes(':') &&
      !/[*?\[\]]/.test(p) &&
      !p.split('/').some((part) => part === '..' || part === '.') &&
      !p.includes('\0'),
    'Ожидается относительный путь без glob, . или ..',
  );
/* src/core/model.ts:112–133 */
/** Стабильный id свойства: testcase в JUnit, testId в отчёте свойств. */
const propertyIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/, 'property ID без пробелов');
const requirementLink = z.strictObject({
  id: z.string().regex(/^REQ-[A-Za-z0-9_-]{1,64}$/),
  source: relativePath,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().min(3).max(12000),
  gate: modelId,
  scenario: z.string().min(3).max(1500),
  testId: z.string().min(1).max(300).optional(),
});
/* src/core/model.ts:135–189 — только поля, которые читает planResult */
const taskInputShape = {
  featureId: featureId.optional(),
  requirements: z.array(requirementLink).max(30).optional(),
  assignee: z
    .string()
    .regex(/^[A-Za-z0-9_.@-]{1,80}$/)
    .optional(),
  scope: z.enum(['component', 'workspace']).default('component'),
  relatedRepositories: z.array(modelId).optional(),
  role: roleId,
  contextPacks: z.array(modelId).max(30).optional(),
  writePaths: z.array(relativePath).min(1).max(100).optional(),
  gates: z.array(gateRef).max(20).optional(),
  properties: z.array(propertyIdSchema).max(30).optional(),
  resources: z.array(modelId).max(20).optional(),
};

/* src/core/plan.ts:3–37 */
const planResult = z.object({
  title: z.string().min(3).max(180),
  description: z.string().max(5000),
  tasks: z
    .array(
      z.object({
        featureId: taskInputShape.featureId,
        requirements: taskInputShape.requirements,
        assignee: taskInputShape.assignee,
        scope: taskInputShape.scope,
        relatedRepositories: taskInputShape.relatedRepositories,
        contextPacks: taskInputShape.contextPacks,
        writePaths: taskInputShape.writePaths,
        gates: taskInputShape.gates,
        properties: taskInputShape.properties,
        resources: taskInputShape.resources,
        repositoryId: z.string().default('main'),
        key: z.string().regex(/^[A-Za-z0-9_-]+$/),
        title: z.string().min(3).max(180),
        description: z.string().min(10).max(12000),
        role: taskInputShape.role,
        dependsOn: z.array(z.string()),
        acceptance: z.array(z.string().min(3)).min(1),
        contracts: z.array(z.string()),
      }),
    )
    .min(1)
    .max(30),
});

/* src/application/observability.ts:8–25 */
const scope = {
  repositoryId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .optional(),
};
const paging = {
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(50).default(20),
};
const observabilityInputs = {
  usage_report: z.strictObject({ ...scope, ...paging }),
  decision_report: z.strictObject({ ...scope, ...paging }),
  strategy_replay: z.strictObject({
    ...scope,
    policy: z.enum(['fifo-ready-v1', 'fewest-attempts-v1']),
  }),
};

/* src/application/agent.ts:31–125; порядок ключей — порядок снимка */
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const agentInputs = {
  ...observabilityInputs,
  signal_status: z.strictObject({ repositoryId: id }),
  workflow_status: z.strictObject({ repositoryId: id.optional() }),
  workflow_retry: z.strictObject({
    repositoryId: id.optional(),
    key: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  workflow_metrics: z.strictObject({ repositoryId: id.optional() }),
  requirements_snapshot: z.strictObject({ repositoryId: id, source: z.string().min(1).max(500) }),
  requirements_report: z.strictObject({ repositoryId: id }),
  requirements_correct: z.strictObject({ boardId: id, reason: z.string().min(10).max(5000) }),
  plan_import: z.object({ plan: planResult, boardId: id.optional() }).strict(),
  board_create: z
    .object({
      title: z.string().min(3).max(180),
      description: z.string().max(5000).default(''),
      repositoryId: id.optional(),
    })
    .strict(),
  task_retry: z.object({ taskId: id }).strict(),
  task_assign: z
    .object({ taskId: id, member: z.string().regex(/^[A-Za-z0-9_.@-]{1,80}$/) })
    .strict(),
  board_correct: z
    .object({
      boardId: id,
      roots: z.array(id).min(1).max(100),
      reason: z.string().min(10).max(5000),
    })
    .strict(),
  queue_set: z.object({ paused: z.boolean() }).strict(),
  preview_status: z.strictObject({}),
  checks_adopt: z.strictObject({
    suiteId: id,
    version: z.number().int().min(1).optional(),
    /** Однозначная ссылка на версию; номер после объединения клонов может совпасть. */
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    tasks: z.array(id).min(1).max(30),
    reason: z.string().trim().min(10).max(2000),
  }),
  recovery_decide: z.strictObject({
    taskId: id,
    recoveryId: id,
    expectedVersion: z.number().int().min(1),
    action: z.enum(recoveryActions),
    reason: z.string().trim().min(10).max(4000),
    evidence: z.array(z.string().max(2000)).max(20).default([]),
    hypothesis: z.string().max(4000).optional(),
    plan: z.string().max(4000).optional(),
    cases: z
      .array(
        z.strictObject({
          input: z
            .string()
            .min(1)
            .max(64 * 1024),
          expected: z
            .string()
            .max(64 * 1024)
            .nullable()
            .optional(),
        }),
      )
      .max(10)
      .optional(),
    proposal: z.string().max(8000).optional(),
    conflict: z.string().max(4000).optional(),
  }),
  contract_change_status: z.strictObject({ id: z.string().regex(/^CC-[A-Za-z0-9-]{1,80}$/) }),
  contract_change_revise: z.strictObject({
    id: z.string().regex(/^CC-[A-Za-z0-9-]{1,80}$/),
    expectedVersion: z.number().int().min(0),
    include: z.array(id).max(30).optional(),
  }),
};

/** Порядок операций снимка (подмножество `agentOperations`). */
export const agentOperations = [
  'usage_report',
  'decision_report',
  'strategy_replay',
  'signal_status',
  'workflow_status',
  'workflow_retry',
  'workflow_metrics',
  'requirements_snapshot',
  'requirements_report',
  'requirements_correct',
  'plan_import',
  'board_create',
  'task_retry',
  'task_assign',
  'board_correct',
  'queue_set',
  'preview_status',
  'checks_adopt',
  'recovery_decide',
  'contract_change_status',
  'contract_change_revise',
];

/* src/application/agent.ts:142–247 — записи этих 21 операции */
export const descriptions = {
  usage_report:
    'Read paginated owner-local invocation costs, versions and telemetry coverage; never evidence.',
  decision_report:
    'Read recorded dispatch inputs and observed outcomes. Other component tasks appear only as dependency IDs.',
  strategy_replay:
    'Audit a fixed strategy against prefix-only dispatch inputs. Unobserved alternatives stay unsupported; no policy is installed.',
  signal_status:
    'Read external signal receipts in one component. No remote requests or model calls.',
  workflow_status:
    'Read owner-local durable stage jobs. No model calls or execution leases are granted.',
  workflow_retry:
    'Retry a diagnosed failed stage within its original attempt budget. Never retries failed task implementations automatically.',
  workflow_metrics:
    'Read per-owner execution measurements, incomplete attempts and unknown cost. No model calls.',
  requirements_snapshot:
    'Read REQ sections from committed repository HEAD. Bind returned digest/text to a task and a configured test gate.',
  requirements_report:
    'Compare current requirement sections with task evidence. Historical done is unchanged; stale requirements are not current coverage.',
  requirements_correct:
    'Create draft replacements for changed requirements on an accepted board. Preserve history and require new plan review.',
  plan_import:
    "Import a draft task DAG. Without boardId it opens a new board; with boardId of an accepted board it opens the next stage as that board's next revision, so one release stays on one board. This does not approve the plan or execute agents. Do not blindly retry creation after an uncertain response.",
  board_create: 'Create a draft board in the selected repository or common workspace.',
  task_retry:
    'Explicitly retry a failed or cancelled task within the attempt budget. Diagnose the failure first.',
  task_assign: 'Assign a task to a team member. Assignment is not a distributed lease.',
  board_correct:
    'Create a correction after board acceptance, preserving history and recalculating transitive impact.',
  queue_set:
    'Pause or resume issuance of tasks. Resuming may invoke configured models in a running server; this does not launch a server or cancel active runs.',
  checks_adopt:
    'Adopt an existing corpus version by explicitly listed unfinished tasks of the same check contract. Waits for active runs and holds their issuance; accepted tasks are never changed.',
  recovery_decide:
    'Record the lead decision for a recovery episode (two failures on one property) with the expected record version: add confirmed cases under the pinned oracle, one retry with a new hypothesis, a proposal for normal review (strengthen checker, split task), a product conflict for the user, or an environment stop. Never resets attempts.',
  contract_change_status:
    'Read a contract-change operation: its step, holds, history, earlier redactions and the next step. Read-only.',
  contract_change_revise:
    'Revise a failed, stale or waiting contract change to the current committed redaction with the expected record version. Before side effects the same operation is re-reviewed with its history kept; after them a linked successor takes the holds over. Effects are never rolled back.',
  preview_status:
    'Read the local preview: which verified release serves the URL, its states (built, deployed, healthy, confirmed or unconfirmed), and past deployments with their errors. Deploying and rolling back are separate controlled actions through the CLI or panel.',
};

/* src/application/agent.ts:248–272 */
export const readOnly = (name) =>
  [
    'preview_status',
    'preparation_status',
    'intent_render',
    'intent_snapshot',
    'intent_report',
    'product_view',
    'usage_report',
    'decision_report',
    'strategy_replay',
    'memory_recall',
    'project_context',
    'project_overview',
    'task_briefing',
    'checkpoint_changes',
    'requirements_snapshot',
    'requirements_report',
    'workflow_metrics',
    'workflow_status',
    'signal_status',
    'feasibility_spikes',
    'checks_view',
    'contract_change_status',
  ].includes(name);

/** package.json DevContour на снимке. */
export const pkg = { name: 'devcontour', version: '0.4.0-alpha.7' };
