import {
  API_VERSION,
  HarnessError,
  STATE_VERSION,
  runResultSchema,
  vendorOf,
  type AttemptState,
  type ErrorCode,
  type EvidenceRecord,
  type RunResult,
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

const ref = (e: EvidenceRecord, attempt: AttemptState) => ({
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
  ...(e.checks ? { checks: e.checks } : {}),
  // Список тестов собственной проверки интеграции — для доказательства
  // названного testcase у получателя.
  ...(e.kind === 'test' && !e.consumer && e.phase === 'integration' && e.tests
    ? { tests: e.tests, ...(e.testsTruncated ? { testsTruncated: true } : {}) }
    : {}),
  ...(e.property && (e.property.level || e.property.manifest)
    ? {
        property: {
          ...(e.property.level ? { level: e.property.level } : {}),
          ...(e.property.manifest ? { manifest: e.property.manifest } : {}),
        },
      }
    : {}),
  ...(e.kind === 'review'
    ? {
        reviewer: {
          runtime: attempt.reviewer,
          sameVendor: vendorOf(attempt.reviewer) === vendorOf(attempt.runtime),
        },
      }
    : {}),
});

/**
 * Машинный результат завершённой попытки. Строится только из записей самой
 * попытки и оснований, закреплённых за ней при выдаче (`pinned`): новая
 * редакция графа, изменение или удаление поручения не переписывают
 * завершённую историю. `accepted` — только успешная попытка: её integration
 * SHA — result SHA. Недостающие сведения не выдумываются.
 */
export function runResult(attempt: AttemptState, harnessVersion: string): RunResult {
  if (!attempt.pinned)
    throw new HarnessError(
      'NOT_FOUND',
      `Попытка ${attempt.id} выдана без закреплённых оснований; результат не строится`,
    );
  if (attempt.status === 'active')
    throw new HarnessError('NOT_READY', 'Попытка ещё идёт: ' + attempt.id);
  const pinned = attempt.pinned;
  const base = {
    apiVersion: API_VERSION,
    workOrderId: attempt.workId,
    graphId: pinned.graphId,
    source: pinned.source,
    runId: attempt.id,
    attempt: attempt.attempt,
    repositoryId: attempt.repositoryId,
    targetRef: pinned.targetRef,
    inputs: {
      harnessVersion: attempt.engineVersion ?? harnessVersion,
      ...(attempt.consumerVersion ? { consumerVersion: attempt.consumerVersion } : {}),
      stateVersion: STATE_VERSION,
      workOrderDigest: pinned.orderDigest,
      graphDigest: pinned.graphDigest,
      policyDigest: attempt.policyDigest,
      ...(attempt.contextSnapshot ? { contextDigest: attempt.contextSnapshot } : {}),
      ...(attempt.checks ? { checks: attempt.checks.effective } : {}),
      ...(attempt.checks?.corpus ? { corpus: attempt.checks.corpus } : {}),
      ...(attempt.requiredGates ? { requiredGates: attempt.requiredGates } : {}),
    },
    checked: {
      dependencies: (attempt.dependencies ?? []).map(({ repositoryId, sha, tree, artifacts }) => ({
        repositoryId,
        sha,
        tree,
        artifacts,
      })),
      freshness: attempt.dependencyFreshness ?? [],
      // Только записавшие, что проверено: недостающее не выдумывается.
      consumers: (attempt.consumers ?? []).flatMap((c) =>
        c.checked
          ? [
              {
                repositoryId: c.repositoryId,
                gates: c.gates,
                sha: c.checked.sha,
                tree: c.checked.tree,
                dependencies: c.checked.dependencies,
                freshness: c.checked.freshness ?? [],
              },
            ]
          : [],
      ),
    },
    evidence: attempt.evidence
      .filter((e) => e.sha === attempt.candidateSha || e.sha === attempt.integrationSha)
      .map((e) => ref(e, attempt)),
    findings: attempt.evidence
      .filter((e) => e.kind === 'review' && !e.passed)
      .flatMap((e) => e.findings ?? [])
      .map((f) => ({
        severity: f.severity,
        message: f.message.slice(0, 4000) || '—',
        ...(f.path !== undefined ? { path: f.path } : {}),
        ...(f.line !== undefined ? { line: f.line } : {}),
      })),
    limitations: [] as string[],
    finishedAt: attempt.finishedAt ?? attempt.startedAt,
  };
  const value =
    attempt.status === 'succeeded'
      ? {
          ...base,
          outcome: 'accepted' as const,
          shas: {
            base: attempt.baseSha!,
            candidate: attempt.candidateSha!,
            integration: attempt.integrationSha!,
            result: attempt.integrationSha!,
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
