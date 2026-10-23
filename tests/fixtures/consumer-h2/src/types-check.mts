/**
 * H2: типы общих операций планирования из `.d.ts` установленного архива.
 * Проверяется внешним tsc; не исполняется. Импорты — корень, ./contracts и zod.
 */
import { z } from 'zod';
import {
  checkGaps,
  draftIssues,
  draftToGraph,
  planCheck,
  planDraft,
  planDraftJsonSchema,
  planDraftSchema,
  planningBasis,
  planningRequest,
  planRequestOf,
  type CheckGap,
  type CodedIssue,
  type ExecutionPolicy,
  type PlanCheckData,
  type PlanDraft,
  type PlanningFacts,
  type PlanningInput,
  type PlanningRequest,
  type PlanRequestData,
  type StandalonePlanDraft,
  type WorkGraph,
} from 'devcontour-harness';
import { planDraft as contractsPlanDraft } from 'devcontour-harness/contracts';

// Одна реализация: тип функции корня совпадает с ./contracts.
const same: typeof planDraft = contractsPlanDraft;
void same;

// Хост расширяет задачу своими полями и сохраняет порядок ключей.
const planResult = planDraft(
  {
    featureId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,48}$/)
      .optional(),
    assignee: z.string().optional(),
  },
  {
    keyOrder: [
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
    ],
  },
);
type HostPlan = z.output<typeof planResult>;
const hostPlan: HostPlan = planResult.parse({});
const featureId: string | undefined = hostPlan.tasks[0]?.featureId;
const key: string | undefined = hostPlan.tasks[0]?.key;
const repositoryId: string | undefined = hostPlan.tasks[0]?.repositoryId;
void featureId;
void key;
void repositoryId;
const schema: Record<string, unknown> = planDraftJsonSchema(planResult);
void schema;

const facts: PlanningFacts = {
  repositories: [{ id: 'main', path: '/srv/app' }],
  roles: [{ repositoryId: 'main', roles: [{ role: 'engine', requiresContract: false }] }],
  gates: [
    { repositoryId: 'main', gates: [{ id: 'unit', kind: 'test' }], groups: { all: ['unit'] } },
  ],
  contextPacks: [],
  resources: [],
  contracts: [{ id: 'api', digest: 'a'.repeat(64), source: { ref: 'x' } }],
};
const input: PlanningInput = {
  brief: 'b',
  facts,
  hostInstructions: ['You are a product planner.'],
};
const request: PlanningRequest = planningRequest(input);
const readOnly: true = request.readOnly;
const maxTasks: 30 = request.maxTasks;
const basis: string = planningBasis('b', facts);
void readOnly;
void maxTasks;
void basis;

const draft: PlanDraft = hostPlan;
const issues: CodedIssue[] = draftIssues(draft, { known: ['T1'] });
const code: CodedIssue['code'] | undefined = issues[0]?.code;
const gaps: CheckGap[] = checkGaps(draft, facts);
void code;
void gaps;

const standalone: StandalonePlanDraft = planDraftSchema.parse({});
const built: { graph?: WorkGraph; issues: CodedIssue[] } = draftToGraph(standalone, {
  graphId: 'g',
  source: { connector: 'files', ref: 'work/g.json', revision: basis },
  facts,
});
void built;

export function standaloneRoute(policy: ExecutionPolicy, baseDir: string): PlanCheckData {
  const req: PlanRequestData = planRequestOf({ policy, baseDir, brief: 'b' });
  const data: PlanCheckData = planCheck({
    policy,
    baseDir,
    draft: {},
    graphId: 'g',
    brief: 'b',
    basis: req.basis,
  });
  const graphDigest: string | undefined = data.graphDigest;
  void graphDigest;
  return data;
}
