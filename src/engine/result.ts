import {
  API_VERSION,
  STATE_VERSION,
  digestOf,
  runResultSchema,
  workGraphDigest,
  type AttemptState,
  type ErrorCode,
  type EvidenceRecord,
  type GraphState,
  type RunResult,
  type WorkState,
} from '../contracts/index.ts';

const stopCode = (attempt: AttemptState): ErrorCode => {
  switch (attempt.failureKind) {
    case 'gate':
    case 'empty-result':
      return 'GATE_FAILED';
    case 'review':
      return 'REVIEW_REJECTED';
    case 'scope-violation':
      return 'SCOPE_VIOLATION';
    case 'budget':
      return 'BUDGET_EXHAUSTED';
    case 'cancelled':
      return 'CANCELLED';
    case 'provider-auth':
    case 'environment':
    case 'timeout':
      return 'RUNTIME_UNAVAILABLE';
    case 'stale-base':
    case 'merge':
      return 'GIT_FAILED';
    default:
      return 'INTERNAL';
  }
};

const ref = (e: EvidenceRecord, sameVendor: boolean, reviewer: AttemptState['reviewer']) => ({
  id: e.id,
  kind:
    e.kind === 'review'
      ? ('review' as const)
      : e.consumer
        ? ('consumer' as const)
        : ('test' as const),
  phase: e.phase,
  gate: e.gate,
  sha: e.sha,
  passed: e.passed,
  digest: e.digest,
  summary: e.summary.slice(0, 4000),
  ...(e.consumer ? { consumer: e.consumer } : {}),
  ...(e.kind === 'review' ? { reviewer: { runtime: reviewer, sameVendor } } : {}),
});

/** Общая часть результата: входы, проверенное, evidence, находки — из записанного состояния. */
function common(
  graph: GraphState,
  work: WorkState,
  attempt: AttemptState,
  targetRef: string,
  harnessVersion: string,
) {
  const sameVendor =
    (attempt.runtime === 'codex'
      ? 'openai'
      : attempt.runtime === 'claude'
        ? 'anthropic'
        : 'fixture') ===
    (attempt.reviewer === 'codex'
      ? 'openai'
      : attempt.reviewer === 'claude'
        ? 'anthropic'
        : 'fixture');
  const repo = graph.graph.orders.find((o) => o.id === work.id)!;
  const evidence = attempt.evidence
    .filter((e) => e.sha === attempt.candidateSha || e.sha === attempt.integrationSha)
    .map((e) => ref(e, sameVendor, attempt.reviewer));
  const findings = attempt.evidence
    .filter((e) => e.kind === 'review' && !e.passed)
    .flatMap((e) => e.findings ?? [])
    .map((f) => ({
      severity: f.severity,
      message: f.message.slice(0, 4000) || '—',
      ...(f.path !== undefined ? { path: f.path } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
    }));
  const value = {
    apiVersion: API_VERSION,
    workOrderId: work.id,
    graphId: graph.id,
    source: work.order.source,
    runId: attempt.id,
    attempt: attempt.attempt,
    repositoryId: repo.repositoryId,
    targetRef,
    inputs: {
      harnessVersion: attempt.engineVersion ?? harnessVersion,
      ...(attempt.consumerVersion ? { consumerVersion: attempt.consumerVersion } : {}),
      stateVersion: STATE_VERSION,
      workOrderDigest: digestOf(work.order),
      graphDigest: workGraphDigest(graph.graph),
      policyDigest: attempt.policyDigest,
      ...(attempt.contextSnapshot ? { contextDigest: attempt.contextSnapshot } : {}),
      ...(attempt.checks ? { checks: attempt.checks.effective } : {}),
    },
    checked: {
      dependencies: (attempt.dependencies ?? []).map(({ repositoryId, sha, tree, artifacts }) => ({
        repositoryId,
        sha,
        tree,
        artifacts,
      })),
      freshness: attempt.dependencyFreshness ?? [],
      consumers: [],
    },
    evidence,
    findings,
    limitations: [] as string[],
    finishedAt: attempt.finishedAt ?? new Date().toISOString(),
  };
  return value;
}

/**
 * Машинный результат завершённой попытки поручения. `accepted` — только если
 * попытка успешна и поручение `done` с её integration SHA. Поля берутся из
 * записанного состояния; недостающие не выдумываются.
 */
export function runResult(
  graph: GraphState,
  work: WorkState,
  attempt: AttemptState,
  targetRef: string,
  harnessVersion: string,
): RunResult {
  const base = common(graph, work, attempt, targetRef, harnessVersion);
  const accepted =
    attempt.status === 'succeeded' &&
    work.status === 'done' &&
    work.resultSha === attempt.integrationSha;
  const value = accepted
    ? {
        ...base,
        outcome: 'accepted' as const,
        shas: {
          base: attempt.baseSha!,
          candidate: attempt.candidateSha!,
          integration: attempt.integrationSha!,
          result: work.resultSha!,
        },
      }
    : {
        ...base,
        outcome:
          attempt.status === 'cancelled'
            ? ('cancelled' as const)
            : attempt.blocked
              ? ('blocked' as const)
              : attempt.status === 'expired'
                ? ('stopped' as const)
                : ('rejected' as const),
        shas: {
          ...(attempt.baseSha ? { base: attempt.baseSha } : {}),
          ...(attempt.candidateSha ? { candidate: attempt.candidateSha } : {}),
          ...(attempt.integrationSha ? { integration: attempt.integrationSha } : {}),
        },
        stopReason: {
          code: stopCode(attempt),
          message: (attempt.error ?? 'Попытка не завершена').slice(0, 4000),
        },
      };
  return runResultSchema.parse(value);
}
