import { digestOf, type EventType } from '../src/contracts/index.ts';

const d = digestOf('p');
const sha = 'a'.repeat(40);
const delivery = { sink: 'files', key: 'k1', revision: '1', attempts: 1 };

/** Валидная нагрузка каждого типа события: тест сначала проверяет её принятие. */
export const validPayloads: Record<EventType, Record<string, unknown>> = {
  'graph.registered': {
    digest: d,
    orders: 1,
    source: { connector: 'files', ref: 'g', revision: '1' },
  },
  'graph.reviewed': { kind: 'plan', subject: 'g', digest: d, round: 1, approved: true, open: 0 },
  'graph.approved': { digest: d, actor: 'agent' },
  'work.ready': { orderDigest: d },
  'work.held': { operation: 'op-1', reason: 'contract change', released: false },
  'attempt.claimed': {
    owner: 'c1',
    runtime: 'claude',
    reviewer: 'codex',
    policyDigest: d,
    engineVersion: '0.1.0',
  },
  'attempt.phase': { phase: 'verifying', sha },
  'attempt.gate': { phase: 'candidate', gate: 'unit', sha, passed: true, evidenceId: 'e1' },
  'attempt.review': {
    phase: 'integration',
    sha,
    passed: false,
    evidenceId: 'e2',
    reviewer: 'codex',
    sameVendor: false,
    blocking: 1,
  },
  'attempt.failed': { failureKind: 'gate', message: 'unit failed', blocked: false },
  'attempt.expired': { leaseUntil: 1 },
  'attempt.cancelled': { reason: 'operator' },
  'attempt.recovered': { integrationSha: sha, accepted: true },
  'work.accepted': { resultSha: sha, integrationSha: sha },
  'work.blocked': { code: 'BUDGET_EXHAUSTED', message: 'budget' },
  'control.paused': { reason: 'runtime', failures: ['provider-auth'] },
  'control.resumed': { reason: 'operator' },
  'controller.acquired': { owner: 'c1' },
  'controller.released': { owner: 'c1' },
  'budget.blocked': {
    scope: 'group',
    scopeId: 'b1',
    state: 'undetermined',
    reason: 'unknown cost',
  },
  'corpus.adopted': {
    suite: 'KS-api',
    pending: 'AD-1',
    version: 1,
    digest: d,
    status: 'completed',
    accepted: ['a'],
  },
  'work.recovery': { recoveryId: 'RC-1', property: 'p-optimal', status: 'awaiting-lead' },
  'joint.started': { verificationId: 'JV-1', workIds: ['a', 'b'], policyDigest: d },
  'joint.finished': { verificationId: 'JV-1', status: 'passed', manifestDigest: d },
  'policy.applied': { digest: d, generation: 2, by: 'runner-1', operation: 'op-1' },
  'policy.reconfigure': { operation: 'op-1', digest: d, status: 'requested' },
  'delivery.pending': delivery,
  'delivery.delivered': { ...delivery, receipt: 'ok' },
  'delivery.failed': { ...delivery, error: 'sink down' },
  'delivery.conflict': { ...delivery, currentRevision: '2' },
  'delivery.uncertain': { ...delivery, operation: 'op-1', reason: 'timeout' },
};
