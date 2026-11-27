import type { z } from 'zod';
import {
  HarnessError,
  digestOf,
  harnessModeOf,
  idSchema,
  relativePathSchema,
  workGraphDigest,
  type CodedIssue,
  type ContextSnapshot,
  type ContractDocument,
  type ExecutionPolicy,
  type WorkOrder,
} from '../contracts/index.ts';
import { pathsOverlap } from '../contracts/policy.ts';
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
import { planningBasis, planningRequest, THIN_TASKS } from './request.ts';
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
      // Тот же разбор отказов, что у plan-check: путь — вход, Git — готовность.
      const snapshot = snapshotOf(facts, repositoryId, source);
      if (snapshot instanceof HarnessError)
        throw new HarnessError(snapshot.code, `--requirements: ${snapshot.message}`, [
          { path: ['--requirements', i], message: source },
        ]);
      // В факт — без sha: prompt зависит только от текста требований.
      return { repositoryId, source, requirements: snapshot.requirements };
    },
  );
  const request = planningRequest({
    brief: input.brief,
    facts,
    hostInstructions: standaloneInstructions({ requirements }),
    ...(harnessModeOf(input.policy) === 'thin' ? { thin: true } : {}),
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
  const advice = thinAdvice(input.policy, graph.orders);
  return {
    issues: [],
    checkPlan: [],
    graph,
    graphDigest: workGraphDigest(graph),
    ...(basis === undefined ? {} : { basis }),
    ...(advice.length ? { advice } : {}),
  };
}

/**
 * Советы тонкого режима (не отказ): работ на фичу 3–5 (`THIN_TASK_SIZE_SECTION`);
 * цепочка из 3+ работ, где у какой-то связи dependsOn нет ни общей области
 * записи, ни общего контракта (`THIN_CHAIN`: параллельно не идёт ничего —
 * вопрос, нужна ли эта связь); работы без пути между ними (идут
 * одновременно) пишут в пересекающиеся области (`THIN_SCOPE_OVERLAP`).
 */
export function thinAdvice(
  policy: ExecutionPolicy,
  orders: readonly (Pick<WorkOrder, 'id' | 'repositoryId' | 'writeScope' | 'dependsOn'> &
    Partial<Pick<WorkOrder, 'contracts'>>)[],
): string[] {
  if (harnessModeOf(policy) !== 'thin') return [];
  const out: string[] = [];
  const works = orders.length;
  if (works < THIN_TASKS.min)
    out.push(
      `THIN_PLAN_SIZE: работ ${works} — меньше ${THIN_TASKS.min}: крупная работа даёт большой diff для одного ревью; разделите по репозиториям или независимым сценариям`,
    );
  if (works > THIN_TASKS.max)
    out.push(
      `THIN_PLAN_SIZE: работ ${works} — больше ${THIN_TASKS.max}: в тонком режиме работа — сценарий целиком через слои; объедините работы одного сценария`,
    );
  // Достижимость по dependsOn (граф уже проверен: ацикличен, ссылки целы).
  const byId = new Map(orders.map((o) => [o.id, o]));
  const above = new Map<string, Set<string>>();
  const ancestors = (id: string): Set<string> => {
    const known = above.get(id);
    if (known) return known;
    const set = new Set<string>();
    above.set(id, set);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      set.add(dep);
      ancestors(dep).forEach((x) => set.add(x));
    }
    return set;
  };
  const related = (a: string, b: string) => ancestors(a).has(b) || ancestors(b).has(a);
  const overlap = (a: (typeof orders)[number], b: (typeof orders)[number]) =>
    a.repositoryId === b.repositoryId &&
    a.writeScope.some((x) =>
      b.writeScope.some((y) => x === '.' || y === '.' || pathsOverlap(x, y)),
    );
  const pairs = orders.flatMap((a, i) => orders.slice(i + 1).map((b) => [a, b] as const));
  // Общий контракт — объявленный интерфейс, который работа использует.
  const contract = (a: (typeof orders)[number], b: (typeof orders)[number]) =>
    (a.contracts ?? []).some((x) => (b.contracts ?? []).some((y) => x.id === y.id));
  // Цепочка: каждая пара работ связана путём — порядок единственный.
  if (works >= 3 && pairs.every(([a, b]) => related(a.id, b.id))) {
    // Связь dependsOn без общей области и без общего контракта: может быть
    // лишней. Что работа использует интерфейс сборки или исполнения другой,
    // из плана не видно — совет спрашивает, а не утверждает.
    const loose = orders
      .flatMap((w) => w.dependsOn.map((d) => [w, byId.get(d)] as const))
      .find(([w, p]) => p && !overlap(w, p) && !contract(w, p));
    if (loose?.[1]) {
      const chain = [...orders].sort((a, b) => ancestors(a.id).size - ancestors(b.id).size);
      out.push(
        `THIN_CHAIN: работы идут одной цепочкой (${chain.map((o) => o.id).join(' → ')}), параллельно не выполнится ничего. Проверьте, действительно ли ${loose[0].id} зависит от ${loose[1].id}: общей области записи и общего контракта у них нет. Если ${loose[0].id} не использует интерфейс сборки или исполнения ${loose[1].id} (UI — контракт API или SDK, а не другой UI), уберите эту связь dependsOn; общую тестовую инфраструктуру отдайте ранней работе контракта, сквозную проверку двух поверхностей — выпуску`,
      );
    }
  }
  for (const [a, b] of pairs)
    if (!related(a.id, b.id) && overlap(a, b))
      out.push(
        `THIN_SCOPE_OVERLAP: работы ${a.id} и ${b.id} могут идти одновременно (пути между ними в dependsOn нет), но их области записи пересекаются: ${a.writeScope.join(', ')} и ${b.writeScope.join(', ')}. Общие файлы отдайте одной работе (ранней работе контракта или отдельной маленькой работе, от которой зависят обе) либо свяжите работы, если одна правда использует другую`,
      );
  // Предел схемы ответа: 10 советов по 1000 символов.
  return out.slice(0, 10).map((t) => t.slice(0, 1000));
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
  if (!relativePathSchema.safeParse(source).success)
    return new HarnessError(
      'INVALID_INPUT',
      `Источник требований — относительный путь внутри репозитория: ${source}`,
    );
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
