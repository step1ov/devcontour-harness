/**
 * Синтетический вход проекции представления оператора: политика примера
 * single-task, работы и записи по форме `OperatorViewInput`.
 */
import { executionPolicySchema, DEFAULT_STALL_SWEEP } from '../src/contracts/index.ts';
import type {
  OperatorAttemptInput,
  OperatorReviewInput,
  OperatorViewInput,
  OperatorWorkInput,
} from '../src/projections/operator-view.ts';
import { example } from './fixtures.ts';

export const NOW = Date.parse('2026-11-19T12:00:00.000Z');
export const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

export function policy(edit: (p: Record<string, unknown>) => void = () => {}) {
  const raw = example('policy');
  edit(raw);
  return executionPolicySchema.parse(raw);
}

export function work(id: string, over: Partial<OperatorWorkInput> = {}): OperatorWorkInput {
  return {
    id,
    graphId: 'g1',
    status: 'ready',
    title: `Task ${id}`,
    stage: {
      name: 'queued',
      next: ['writer', 'gates', 'review', 'integration'],
      needs: { actor: 'controller', action: 'wait' },
      spend: { calls: 0, knownUsd: 0, unknownCalls: 0, durationMs: 0 },
    },
    spendFacts: { uncoveredRuns: 0, incompleteCalls: 0 },
    attemptSummary: {
      failed: 0,
      interrupted: 0,
      attempts: { used: 0, max: 3, left: 3 },
      neutral: { used: 0, max: 3 },
      line: 'попыток 0',
      lineEn: 'attempts 0',
    },
    rechecks: 0,
    blockers: [],
    ...over,
  };
}

export function attempt(workId: string, n: number, over: Partial<OperatorAttemptInput> = {}) {
  return {
    workId,
    runId: `${workId}-run-${n}`,
    attempt: n,
    status: 'succeeded',
    startedAt: at(120),
    finishedAt: at(100),
    failureBucket: null,
    interrupted: false,
    callsRecorded: true,
    runtime: 'claude',
    ...over,
  } satisfies OperatorAttemptInput;
}

export function review(
  subject: string,
  over: Partial<OperatorReviewInput> = {},
): OperatorReviewInput {
  return {
    kind: 'plan',
    subject,
    at: at(200),
    approved: true,
    rounds: { used: 1, max: 6 },
    open: { blocking: 0, notes: 0 },
    accepted: 0,
    reviewer: { runtime: 'codex' },
    sameVendor: false,
    spend: { calls: 1, knownUsd: 0.5, unknownCalls: 0 },
    findings: [],
    line: `план ${subject}: одобрено`,
    lineEn: `plan ${subject}: approved`,
    ...over,
  };
}

export function baseInput(over: Partial<OperatorViewInput> = {}): OperatorViewInput {
  const p = policy();
  return {
    now: NOW,
    harnessVersion: '0.1.0-alpha.55',
    stateVersion: 1,
    policy: p,
    policyDigest: 'a'.repeat(64),
    effective: {
      inputPolicy: { threshold: 7, criticalPaths: [] },
      stall: { ...DEFAULT_STALL_SWEEP },
      reviewRoundCap: p.maxAttempts * 2,
    },
    defaulted: [],
    works: [],
    attempts: [],
    gateEvents: [],
    calls: [],
    questions: [],
    reviews: [],
    stops: [],
    queue: { paused: false },
    ...over,
  };
}
