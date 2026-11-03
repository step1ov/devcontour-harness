/**
 * Синтетическое состояние для отчёта (`valueReport`): записи вручную по
 * схемам договора, без живых моделей и данных пилотов. Поручения:
 * - `first`: принято с первой попытки;
 * - `gate`: прерывание штатной остановкой, отказ gate, затем принято;
 * - `review`: отказ ревью при зелёных gates (2 блокирующие находки), затем принято;
 * - `env`: отказ окружения (не засчитан), затем принято;
 * - `legacy`: попытка без класса отказа, без wait, timings и учёта вызовов;
 * - `broken`: отказ области и отказ gate установки зависимостей — поручение отклонено;
 * - `cancel`: попытка отменена человеком;
 * - `never`: отменено до первой попытки (в отчёт не входит).
 * Вызовы: известная цена провайдера, оценка по тарифу, вызов без тарифа,
 * незавершённые счётчики. Секреты (`SECRET`, токены, домашний каталог) —
 * в полях, которые отчёт не должен читать.
 */
import {
  attemptStateSchema,
  callRecordSchema,
  graphStateSchema,
  readRunEventSchema,
  reviewRecordSchema,
  workStateSchema,
  type AttemptState,
  type CallRecord,
  type EvidenceRecord,
  type GraphState,
  type ReviewRecord,
  type RunEvent,
  type WorkState,
} from '../src/contracts/index.ts';
import type { ValueReportInput } from '../src/report/index.ts';

export const STATE_DIR = '/Users/alice/projects/demo/.harness-state';
export const HOME = '/Users/alice';
export const SECRET = 'SECRET-FINDING-TEXT';

const hex = (seed: string, length: number) => {
  let out = '';
  let x = 0;
  for (const ch of seed) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  while (out.length < length) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += ((x >>> 16) % 16).toString(16);
  }
  return out;
};
export const sha = (seed: string) => hex('sha' + seed, 40);
export const digest = (seed: string) => hex('dg' + seed, 64);
export const tokenOf = (id: string) => `fence-token-${id}-0123456789`;

/** Метка времени: день от понедельника 2026-10-05 (W41) и час UTC. */
export const t = (day: number, hour = 9, minute = 0) =>
  new Date(Date.UTC(2026, 9, 5 + day, hour, minute)).toISOString();

const order = (id: string, title: string) => ({
  apiVersion: 'devcontour-harness/v1alpha1' as const,
  id,
  source: { connector: 'files', ref: id, revision: '1' },
  title,
  goal: 'Do the thing well enough to pass review.',
  acceptance: ['tests pass'],
  role: 'developer',
  repositoryId: 'app',
  writeScope: ['src'],
  gates: ['unit', 'install'],
});

const work = (
  id: string,
  title: string,
  status: WorkState['status'],
  extra: Partial<WorkState> = {},
) =>
  workStateSchema.parse({
    id,
    graphId: 'demo',
    order: order(id, title),
    status,
    attempt: 0,
    approvedAt: t(0, 8),
    ...extra,
  });

const evidence = (
  runId: string,
  kind: 'test' | 'review',
  phase: 'candidate' | 'integration',
  gate: string,
  passed: boolean,
  createdAt: string,
  extra: Partial<EvidenceRecord> = {},
): EvidenceRecord => ({
  id: `${runId}-${phase}-${gate}-${createdAt}`,
  runId,
  kind,
  phase,
  sha: sha(runId),
  gate,
  passed,
  createdAt,
  command: ['npm', 'test'],
  exitCode: passed ? 0 : 1,
  log: `${STATE_DIR}/repos/app/artifacts/${runId}/${phase}/${gate}.log`,
  digest: digest(runId + gate + phase),
  summary: `${SECRET} summary of ${gate}`,
  ...extra,
});

/** Зелёные gates кандидата и интеграции, одобренное ревью. */
const greenPath = (runId: string, at: (minute: number) => string) => [
  evidence(runId, 'test', 'candidate', 'install', true, at(20)),
  evidence(runId, 'test', 'candidate', 'unit', true, at(22)),
  evidence(runId, 'review', 'candidate', 'independent-review', true, at(30)),
  evidence(runId, 'test', 'integration', 'install', true, at(40)),
  evidence(runId, 'test', 'integration', 'unit', true, at(42)),
];

const timings = (at: (minute: number) => string, open = false) => [
  {
    id: 'i',
    stage: 'implementation',
    startedAt: at(0),
    finishedAt: at(18),
    outcome: 'passed' as const,
  },
  {
    id: 'g1',
    stage: 'candidate-test:install',
    startedAt: at(18),
    finishedAt: at(20),
    outcome: 'passed' as const,
  },
  {
    id: 'g2',
    stage: 'candidate-test:unit',
    startedAt: at(20),
    finishedAt: at(22),
    outcome: 'passed' as const,
  },
  { id: 'r', stage: 'candidate-review', startedAt: at(22), finishedAt: at(30) },
  ...(open ? [{ id: 'x', stage: 'integration-test:unit', startedAt: at(40) }] : []),
];

const attempt = (
  id: string,
  workId: string,
  n: number,
  status: AttemptState['status'],
  startedAt: string,
  finishedAt: string | undefined,
  extra: Partial<AttemptState> = {},
): AttemptState =>
  attemptStateSchema.parse({
    id,
    workId,
    repositoryId: 'app',
    attempt: n,
    token: tokenOf(id),
    owner: 'controller-1',
    runtime: 'claude',
    reviewer: 'codex',
    policyDigest: digest('policy'),
    status,
    phase: status === 'succeeded' ? 'done' : status === 'failed' ? 'failed' : 'running',
    startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    leaseUntil: 0,
    worktree: `${HOME}/worktrees/${id}`,
    candidateSha: sha(id),
    requiredGates: ['install', 'unit'],
    engineVersion: '0.1.0-alpha.29',
    callsRecorded: true,
    evidence: [],
    ...extra,
  });

/** Попытка, начатая в `day`/`hour`: минуты от начала. */
const clock = (day: number, hour: number) => (minute: number) => t(day, hour, minute);

export function reportFixture(): ValueReportInput {
  const graphs: GraphState[] = [
    graphStateSchema.parse({
      id: 'demo',
      digest: digest('graph'),
      graph: {
        apiVersion: 'devcontour-harness/v1alpha1',
        id: 'demo',
        source: { connector: 'files', ref: 'graph.json', revision: '1' },
        orders: [order('first', 'First task')],
      },
      policyDigest: digest('policy'),
      approval: { actor: 'operator', digest: digest('graph'), at: t(0, 8) },
      registeredAt: t(0, 7),
    }),
  ];

  const works = [
    work('first', 'Add the greeting', 'done'),
    work('gate', 'Fix | the *parser*', 'done'),
    work('review', 'Harden <input> handling', 'done'),
    work('env', 'Wire the CLI', 'done'),
    work('legacy', 'Old task from before classification', 'done', { approvedAt: t(-14, 8) }),
    work('broken', 'Refactor storage', 'failed'),
    work('cancel', 'Abandoned idea', 'cancelled'),
    work('never', 'Never started', 'cancelled'),
  ];

  const a = clock;
  const attempts: AttemptState[] = [
    // first: W41, одна попытка.
    attempt('run-first-1', 'first', 1, 'succeeded', t(0, 10), t(0, 10, 50), {
      wait: { approvedAt: t(0, 8), readyAt: t(0, 9, 30) },
      timings: timings(a(0, 10)),
      evidence: greenPath('run-first-1', a(0, 10)),
    }),
    // gate: W41 прерывание, W42 отказ gate, W42 приёмка.
    attempt('run-gate-1', 'gate', 1, 'failed', t(1, 10), t(1, 10, 15), {
      interrupted: 'shutdown',
      wait: { approvedAt: t(0, 8), readyAt: t(1, 9) },
      timings: timings(a(1, 10), true),
    }),
    attempt('run-gate-2', 'gate', 2, 'failed', t(7, 10), t(7, 10, 25), {
      failureKind: 'gate',
      error: `unit failed at ${HOME}/projects/demo/src/x.ts ${SECRET}`,
      wait: { approvedAt: t(7, 9), readyAt: t(7, 9, 50) },
      timings: timings(a(7, 10)),
      evidence: [
        evidence('run-gate-2', 'test', 'candidate', 'install', true, t(7, 10, 20)),
        evidence('run-gate-2', 'test', 'candidate', 'unit', false, t(7, 10, 22)),
      ],
    }),
    attempt('run-gate-3', 'gate', 3, 'succeeded', t(8, 10), t(8, 11), {
      wait: { approvedAt: t(7, 9), readyAt: t(8, 9) },
      timings: timings(a(8, 10)),
      evidence: greenPath('run-gate-3', a(8, 10)),
    }),
    // review: W42 отказ ревью при зелёных gates, W44 приёмка.
    attempt('run-review-1', 'review', 1, 'failed', t(9, 10), t(9, 10, 35), {
      failureKind: 'review',
      wait: { approvedAt: t(9, 8), readyAt: t(9, 9) },
      timings: timings(a(9, 10)),
      evidence: [
        evidence('run-review-1', 'test', 'candidate', 'install', true, t(9, 10, 20)),
        evidence('run-review-1', 'test', 'candidate', 'unit', true, t(9, 10, 22)),
        evidence('run-review-1', 'review', 'candidate', 'independent-review', false, t(9, 10, 30), {
          sha: sha('run-review-1'),
          findings: [
            { severity: 'blocking', message: SECRET + ' one', id: digest('f-a'), status: 'open' },
            {
              severity: 'blocking',
              message: SECRET + ' two',
              id: digest('f-b'),
              status: 'withdrawn',
            },
            { severity: 'note', message: SECRET + ' note' },
          ],
        }),
      ],
    }),
    attempt('run-review-2', 'review', 2, 'succeeded', t(22, 10), t(22, 13), {
      wait: { approvedAt: t(9, 8), readyAt: t(22, 9) },
      timings: timings(a(22, 10)),
      evidence: greenPath('run-review-2', a(22, 10)),
    }),
    // env: W44 отказ окружения (не засчитан), затем приёмка.
    attempt('run-env-1', 'env', 1, 'failed', t(23, 10), t(23, 10, 2), {
      failureKind: 'environment',
      blocked: true,
      error: `sandbox denied ${HOME}/.npmrc`,
      wait: { approvedAt: t(23, 8), readyAt: t(23, 9) },
    }),
    attempt('run-env-2', 'env', 2, 'succeeded', t(23, 11), t(23, 12), {
      wait: { approvedAt: t(23, 8), readyAt: t(23, 10, 5) },
      timings: timings(a(23, 11)),
      evidence: greenPath('run-env-2', a(23, 11)),
      engineVersion: '0.1.0-alpha.30',
    }),
    // legacy: W39 без класса, W40 приёмка; ни wait, ни timings, ни учёта вызовов.
    attempt('run-legacy-1', 'legacy', 1, 'failed', t(-13, 10), t(-13, 11), {
      engineVersion: undefined,
      callsRecorded: undefined,
      evidence: [
        evidence('run-legacy-1', 'test', 'candidate', 'unit', false, t(-13, 10, 50), {
          log: `${HOME}/old-state/artifacts/unit.log`,
        }),
      ],
    }),
    attempt('run-legacy-2', 'legacy', 2, 'succeeded', t(-6, 10), t(-6, 12), {
      engineVersion: undefined,
      callsRecorded: undefined,
      evidence: greenPath('run-legacy-2', a(-6, 10)),
    }),
    // broken: W44 отказ области, W45 отказ gate установки (интеграция), поручение отклонено.
    attempt('run-broken-1', 'broken', 1, 'failed', t(24, 10), t(24, 10, 30), {
      failureKind: 'scope-violation',
      timings: timings(a(24, 10)),
    }),
    attempt('run-broken-2', 'broken', 2, 'failed', t(29, 10), t(29, 10, 45), {
      failureKind: 'gate',
      engineVersion: '0.1.0-alpha.30',
      timings: timings(a(29, 10)),
      evidence: [
        evidence('run-broken-2', 'test', 'candidate', 'install', true, t(29, 10, 20)),
        evidence('run-broken-2', 'test', 'candidate', 'unit', true, t(29, 10, 22)),
        evidence('run-broken-2', 'review', 'candidate', 'independent-review', true, t(29, 10, 30)),
        evidence('run-broken-2', 'test', 'integration', 'install', false, t(29, 10, 40), {
          log: `${HOME}/elsewhere/cache/install.log`,
        }),
      ],
    }),
    // cancel: W45 отменено человеком.
    attempt('run-cancel-1', 'cancel', 1, 'cancelled', t(29, 14), t(29, 14, 20), {
      failureKind: 'cancelled',
      engineVersion: '0.1.0-alpha.30',
    }),
  ];

  const call = (id: string, startedAt: string, extra: Partial<CallRecord>): CallRecord =>
    callRecordSchema.parse({
      id,
      stage: 'implementation',
      runtime: 'claude',
      model: 'claude-model',
      runtimeVersion: '1.0.0',
      startedAt,
      finishedAt: startedAt,
      outcome: 'returned',
      promptBytes: 1000,
      promptDigest: digest(id),
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 5000,
        cacheWriteTokens: 100,
        reportedUsd: null,
        complete: true,
        source: 'claude-result',
      },
      costUsd: 1,
      costSource: 'provider-reported',
      ...extra,
    });
  const calls: CallRecord[] = [
    call('c-first-impl', t(0, 10, 1), { runId: 'run-first-1', costUsd: 1.2 }),
    call('c-first-review', t(0, 10, 23), {
      runId: 'run-first-1',
      stage: 'candidate-review',
      runtime: 'codex',
      model: 'codex-model',
      costUsd: null,
      costSource: 'unknown',
      usage: {
        inputTokens: 900,
        outputTokens: 90,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedUsd: null,
        complete: true,
        source: 'codex-turn-events',
      },
    }),
    call('c-gate-2', t(7, 10, 1), { runId: 'run-gate-2', costUsd: 2.5 }),
    call('c-gate-3', t(8, 10, 1), { runId: 'run-gate-3', costUsd: 1.75 }),
    call('c-review-1', t(9, 10, 1), { runId: 'run-review-1', costUsd: 3 }),
    call('c-review-2', t(22, 10, 1), {
      runId: 'run-review-2',
      costUsd: 0.8,
      costSource: 'tariff-estimate',
    }),
    call('c-env-2', t(23, 11, 1), { runId: 'run-env-2', costUsd: 1.1 }),
    call('c-broken-1', t(24, 10, 1), { runId: 'run-broken-1', costUsd: 0.6 }),
    call('c-broken-2', t(29, 10, 1), {
      runId: 'run-broken-2',
      costUsd: 0.4,
      usage: {
        inputTokens: null,
        outputTokens: 10,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reportedUsd: 0.4,
        complete: false,
        source: 'claude-result',
      },
    }),
    call('c-plan-1', t(0, 7, 30), {
      stage: 'plan-review',
      runtime: 'codex',
      model: 'codex-model',
      subjectId: 'demo',
      subjectKind: 'group',
      costUsd: 0.5,
      costSource: 'tariff-estimate',
    }),
  ];

  const finding = (
    seed: string,
    severity: 'blocking' | 'note',
    status: 'open' | 'closed' | 'withdrawn',
    openedIn: number,
    changedIn: number,
  ) => ({ id: digest(seed), severity, message: SECRET + seed, status, openedIn, changedIn });
  const review = (
    id: string,
    kind: 'plan' | 'contract',
    subject: string,
    round: number,
    at: string,
    approved: boolean,
    findings: ReviewRecord['findings'],
  ) =>
    reviewRecordSchema.parse({
      id,
      kind,
      subject,
      digest: digest(id),
      round,
      at,
      approved,
      summary: SECRET + ' summary',
      authorRuntime: 'claude',
      reviewerRuntime: 'codex',
      sameVendor: false,
      findings,
      artifact: `${STATE_DIR}/reviews/${id}/review.json`,
    });
  const reviews: ReviewRecord[] = [
    review('plan-1', 'plan', 'demo', 1, t(0, 7), false, [
      finding('p1', 'blocking', 'open', 1, 1),
      finding('p2', 'note', 'open', 1, 1),
    ]),
    review('plan-2', 'plan', 'demo', 2, t(0, 7, 40), true, [
      finding('p1', 'blocking', 'closed', 1, 2),
      finding('p2', 'note', 'open', 1, 1),
    ]),
    review('contract-1', 'contract', 'api', 1, t(0, 7, 10), true, []),
  ];

  let seq = 0;
  const event = (at: string, rest: Record<string, unknown>): RunEvent =>
    readRunEventSchema.parse({
      apiVersion: 'devcontour-harness/v1alpha1',
      seq: ++seq,
      at,
      ...rest,
    }) as RunEvent;
  const events: RunEvent[] = [
    event(t(0, 7, 50), {
      type: 'graph.approved',
      graphId: 'demo',
      payload: { digest: digest('graph'), actor: 'operator' },
    }),
    event(t(10, 9), {
      type: 'work.held',
      graphId: 'demo',
      workId: 'review',
      payload: { operation: 'operator-hold', reason: SECRET, released: false },
    }),
    event(t(21, 9), {
      type: 'work.held',
      graphId: 'demo',
      workId: 'review',
      payload: { operation: 'operator-hold', reason: SECRET, released: true },
    }),
    event(t(23, 10, 3), {
      type: 'control.paused',
      payload: { reason: 'runtime', failures: ['environment'] },
    }),
    event(t(23, 10, 33), { type: 'control.resumed', payload: { reason: 'runtime' } }),
    event(t(29, 14, 20), {
      type: 'attempt.cancelled',
      workId: 'cancel',
      runId: 'run-cancel-1',
      attempt: 1,
      payload: { reason: SECRET },
    }),
    event(t(29, 15), { type: 'control.paused', payload: { reason: 'operator' } }),
    event(t(29, 16), { type: 'unknown', original: 'work.retried' }),
  ];

  return { graphs, works, attempts, calls, reviews, events };
}

/** Перестановка массивов входа (детерминизм не зависит от порядка). */
export function shuffled(input: ValueReportInput, seed: number): ValueReportInput {
  const mix = <T>(xs: readonly T[] | undefined) => {
    const out = [...(xs ?? [])];
    let x = seed;
    for (let i = out.length - 1; i > 0; i--) {
      x = (x * 1103515245 + 12345) >>> 0;
      const j = x % (i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return {
    works: mix(input.works),
    attempts: mix(input.attempts),
    calls: mix(input.calls),
    reviews: mix(input.reviews),
    events: mix(input.events),
    graphs: mix(input.graphs),
  };
}
