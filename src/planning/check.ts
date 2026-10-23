import type { z } from 'zod';
import {
  HarnessError,
  digestOf,
  idSchema,
  workGraphDigest,
  type CodedIssue,
  type ContextSnapshot,
  type ContractDocument,
  type ExecutionPolicy,
} from '../contracts/index.ts';
import {
  planDraftSchema,
  type CheckGap,
  type PlanningFacts,
  type StandalonePlanDraft,
  type planCheckDataSchema,
  type planRequestDataSchema,
} from '../contracts/planning.ts';
import { validationIssues } from '../validate.ts';
import { requirementSnapshot } from '../verification/requirements.ts';
import { planningFactsOf } from './facts.ts';
import { draftToGraph } from './graph.ts';
import { checkGaps, draftIssues } from './issues.ts';
import { planningBasis, planningRequest } from './request.ts';
import { standaloneInstructions, type RequirementFact } from './standalone.ts';

export type PlanRequestData = z.infer<typeof planRequestDataSchema>;
export type PlanCheckData = z.infer<typeof planCheckDataSchema>;
export interface PlanInputs {
  policy: ExecutionPolicy;
  baseDir: string;
  context?: ContextSnapshot;
  contracts?: ContractDocument[];
}

type Snapshot = ReturnType<typeof requirementSnapshot>;

const factsOf = (input: PlanInputs) =>
  planningFactsOf(input.policy, {
    baseDir: input.baseDir,
    ...(input.context ? { context: input.context } : {}),
    ...(input.contracts ? { contracts: input.contracts } : {}),
  });

/** Каталог репозитория из фактов (путь уже разрешён от каталога политики). */
const repositoryPath = (facts: PlanningFacts, repositoryId: string) =>
  facts.repositories.find((r) => r.id === repositoryId)?.path;

/** `harness plan-request`: prompt, basis и факты; ничего не пишет. */
export function planRequestOf(
  input: PlanInputs & {
    brief: string;
    requirementSources?: { repositoryId: string; source: string }[];
  },
): PlanRequestData {
  const facts = factsOf(input);
  const requirements: RequirementFact[] = (input.requirementSources ?? []).map(
    ({ repositoryId, source }, i) => {
      const path = repositoryPath(facts, repositoryId);
      if (path === undefined)
        throw new HarnessError(
          'INVALID_INPUT',
          `--requirements: репозиторий не объявлен в политике: ${repositoryId}`,
          [{ path: ['--requirements', i], message: repositoryId }],
        );
      // В факт — без sha: prompt зависит только от текста требований.
      const { requirements: found } = requirementSnapshot(path, source, 'HEAD');
      return { repositoryId, source, requirements: found };
    },
  );
  const request = planningRequest({
    brief: input.brief,
    facts,
    hostInstructions: standaloneInstructions({ requirements }),
  });
  return {
    prompt: request.prompt,
    readOnly: request.readOnly,
    recommendedTasks: request.recommendedTasks,
    maxTasks: request.maxTasks,
    basis: request.basis,
    facts,
    draftSchema: 'plan-draft',
  };
}

/** `harness plan-check`: issues и план подготовки проверок либо граф. */
export function planCheck(
  input: PlanInputs & { draft: unknown; graphId: string; brief?: string; basis?: string },
): PlanCheckData {
  // 1. Входы.
  if (!idSchema.safeParse(input.graphId).success)
    return refused([
      {
        code: 'INVALID_INPUT',
        path: ['--draft'],
        message: `ID графа из имени draft не проходит формат ID: ${input.graphId}`,
      },
    ]);
  if (input.basis !== undefined && input.brief === undefined)
    return refused([
      { code: 'INVALID_INPUT', path: ['--basis'], message: 'plan-check: --basis требует --brief' },
    ]);

  // 2. Факты и basis постановки.
  const facts = factsOf(input);
  const basis = input.brief === undefined ? undefined : planningBasis(input.brief, facts);
  if (input.basis !== undefined && input.basis !== basis)
    return refused(
      [
        {
          code: 'APPROVAL_STALE',
          path: ['--basis'],
          message:
            'Постановка или факты проекта изменились после plan-request: составьте draft заново',
        },
      ],
      [],
      basis,
    );

  // 3. Форма draft; лишние ключи (approved, status, …) z.object отбрасывает.
  const parsed = planDraftSchema.safeParse(input.draft);
  if (!parsed.success)
    return refused(
      parsed.error.issues.map((i) => ({
        code: 'INVALID_INPUT' as const,
        path: ['draft', ...i.path.map((p) => (typeof p === 'symbol' ? String(p) : p))],
        message: i.message,
      })),
      [],
      basis,
    );
  const draft = parsed.data;

  // 4. Структура и ссылки на факты; недостающие проверки — план их подготовки, draft не меняется.
  const checkPlan = checkGaps(draft, facts);
  const structural = draftIssues(draft, { facts }).map(inDraft);
  if (structural.length) return refused(structural, checkPlan, basis);

  // 5. Требования — из источника на HEAD, не выдумываются.
  const stale = requirementsAtHead(draft, facts);
  if (stale.length) return refused(stale, checkPlan, basis);

  // 6. Draft → WorkGraph.
  const built = draftToGraph(draft, {
    graphId: input.graphId,
    facts,
    source: {
      connector: 'files',
      ref: `work/${input.graphId}.json`,
      revision: basis ?? digestOf(draft),
    },
  });
  if (built.issues.length || !built.graph)
    return refused(
      built.issues.length
        ? built.issues.map(inDraft)
        : [{ code: 'INTERNAL', path: ['graph'], message: 'draftToGraph не вернул граф' }],
      checkPlan,
      basis,
    );
  const graph = built.graph;

  // 7. Те же проверки, что у validate и run.
  const invalid = validationIssues(graph, input.policy, input.context);
  if (invalid.length) return refused(invalid, checkPlan, basis);

  // 8. Граф без согласования: дальше review-plan/approve/run.
  return {
    issues: [],
    checkPlan: [],
    graph,
    graphDigest: workGraphDigest(graph),
    ...(basis === undefined ? {} : { basis }),
  };
}

/** Ответ с проблемами: графа нет; checkPlan — только рядом с issues. */
const refused = (issues: CodedIssue[], checkPlan: CheckGap[] = [], basis?: string) => ({
  issues,
  checkPlan,
  ...(basis === undefined ? {} : { basis }),
});

/** Пути draft-проблем — от входа plan-check: `['draft', 'tasks', i, …]`; `['graph', …]` как есть. */
const inDraft = (issue: CodedIssue): CodedIssue =>
  issue.path[0] === 'graph' || issue.path[0] === 'draft'
    ? issue
    : { ...issue, path: ['draft', ...issue.path] };

function requirementsAtHead(draft: StandalonePlanDraft, facts: PlanningFacts): CodedIssue[] {
  const issues: CodedIssue[] = [];
  const snapshots = new Map<string, Snapshot | HarnessError>();
  draft.tasks.forEach((task, i) =>
    (task.requirements ?? []).forEach((link, k) => {
      const at = ['draft', 'tasks', i, 'requirements', k];
      const key = JSON.stringify([task.repositoryId, link.source]);
      if (!snapshots.has(key))
        snapshots.set(key, snapshotOf(facts, task.repositoryId, link.source));
      const snapshot = snapshots.get(key)!;
      if (snapshot instanceof HarnessError) {
        issues.push({ code: snapshot.code, path: [...at, 'source'], message: snapshot.message });
        return;
      }
      const found = snapshot.requirements.find((r) => r.id === link.id);
      if (!found)
        issues.push({
          code: 'INVALID_INPUT',
          path: [...at, 'id'],
          message: `Требование ${link.id} не найдено в ${link.source} на HEAD: требования не выдумываются`,
        });
      else if (found.digest !== link.digest)
        issues.push({
          code: 'APPROVAL_STALE',
          path: [...at, 'digest'],
          message: `Требование ${link.id} изменилось в ${link.source}: постановка устарела`,
        });
    }),
  );
  return issues;
}

/** Снимок источника на HEAD; отказ снимка становится issue с его кодом. */
function snapshotOf(
  facts: PlanningFacts,
  repositoryId: string,
  source: string,
): Snapshot | HarnessError {
  const path = repositoryPath(facts, repositoryId);
  if (path === undefined)
    return new HarnessError('INVALID_INPUT', `Репозиторий не объявлен: ${repositoryId}`);
  try {
    return requirementSnapshot(path, source, 'HEAD');
  } catch (error) {
    if (error instanceof HarnessError) return error;
    return new HarnessError(
      'NOT_READY',
      `Источник требований не читается на HEAD: ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
