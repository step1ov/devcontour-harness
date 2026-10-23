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
import { stopCodeOf } from '../projections/stop.ts';

const stopCode = (attempt: AttemptState): ErrorCode => stopCodeOf(attempt.failureKind);

/**
 * Причины ошибок протокола предыдущих вызовов того же логического ревью
 * (фаза, SHA, область), записанные до этой записи.
 */
const priorIssues = (e: EvidenceRecord, attempt: AttemptState) => {
  const r = e.reviewRound;
  if (!r || r.protocol !== 'valid' || r.call < 2) return [];
  const at = attempt.evidence.indexOf(e);
  return attempt.evidence
    .slice(0, at)
    .filter(
      (x) =>
        x.kind === 'review' &&
        x.phase === e.phase &&
        x.sha === e.sha &&
        x.reviewRound?.scope === r.scope &&
        x.reviewRound.protocol === 'invalid',
    )
    .flatMap((x) => x.reviewRound?.issues ?? [])
    .slice(-50);
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
  // Раунд ревью кода: ошибка протокола и применённые переходы видны отдельно
  // от вердикта. Прежние записи этих сведений не имеют — их нет и в ссылке.
  ...(e.kind === 'review' && e.reviewRound
    ? {
        review: {
          round: e.reviewRound.round,
          call: e.reviewRound.call,
          protocol: e.reviewRound.protocol,
          // У невалидной записи — её причины; у валидного вердикта повтора —
          // причины предыдущих вызовов того же логического ревью.
          ...((issues) => (issues.length ? { issues } : {}))(
            e.reviewRound.protocol === 'valid'
              ? priorIssues(e, attempt)
              : (e.reviewRound.issues ?? []),
          ),
          ...(e.reviewRound.transitions?.length
            ? {
                transitions: e.reviewRound.transitions.map(({ id, from, to }) => ({
                  id,
                  from,
                  to,
                })),
              }
            : {}),
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
      writer: { runtime: attempt.runtime, ...(attempt.model ? { model: attempt.model } : {}) },
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
      // Принятый результат несёт решающие записи: вызов reviewer с ошибкой
      // протокола виден причинами у валидного вердикта (`review.issues`), а
      // не отдельной записью, которую получатель не проверяет.
      .filter((e) => attempt.status !== 'succeeded' || e.reviewRound?.protocol !== 'invalid')
      .map((e) => ref(e, attempt)),
    findings: attempt.evidence
      .filter((e) => e.kind === 'review' && !e.passed)
      .flatMap((e) => e.findings ?? [])
      .map((f) => ({
        severity: f.severity,
        message: f.message.slice(0, 4000) || '—',
        ...(f.path !== undefined ? { path: f.path } : {}),
        ...(f.line !== undefined ? { line: f.line } : {}),
        ...(f.id !== undefined ? { id: f.id } : {}),
        ...(f.status !== undefined ? { status: f.status } : {}),
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
