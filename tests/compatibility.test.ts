import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_VERSION,
  attemptStateSchema,
  callRecordSchema,
  checkSuiteSchema,
  digestOf,
  jointVerificationSchema,
  jointVerificationStateSchema,
  localSchemas,
  reviewRecordSchema,
  workflowJobSchema,
} from '../src/contracts/index.ts';

/**
 * Записи в формах, которые сохраняет DevContour (baseline), после
 * переименований из docs/compatibility.md. Если строгая схема их отвергает,
 * обещание «читается без потери» ложно.
 */
const d = digestOf('x');
const sha = 'c'.repeat(40);
const at = '2026-10-01T10:00:00.000Z';

test('UsageRecord с RuntimeDiagnostics читается как CallRecord без потери диагностики', () => {
  const baseline = {
    id: 'call-1',
    repositoryId: 'main',
    runId: 'r1',
    stage: 'implementation',
    runtime: 'codex',
    model: 'gpt-x',
    runtimeVersion: 'codex 0.1',
    startedAt: at,
    finishedAt: at,
    outcome: 'error',
    process: { id: 'p1', pid: 123, startedAt: 1 },
    durationMs: 5,
    taskId: 'T-1',
    boardId: 'B-1',
    taskIds: ['T-1'],
    promptBytes: 10,
    promptDigest: d,
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reportedUsd: null,
      complete: false,
      source: 'unavailable',
    },
    costUsd: null,
    costSource: 'unknown',
    diagnostics: {
      startedAt: at,
      finishedAt: at,
      lastOutputAt: null,
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      aborted: false,
      stdoutTail: '',
      stderrTail: 'timeout',
      processTree: {
        available: true,
        processes: [{ pid: 1, parentPid: 0, groupPid: 1, name: 'codex' }],
      },
    },
  };
  const { taskId, boardId, taskIds, ...rest } = baseline;
  const record = callRecordSchema.parse({
    ...rest,
    workId: taskId,
    groupId: boardId,
    workIds: taskIds,
  });
  assert.deepEqual(record.diagnostics, baseline.diagnostics);
  assert.equal(localSchemas.usage.safeParse(record).success, true);
});

const common = {
  apiVersion: API_VERSION,
  id: 'V-1',
  startedAt: at,
  policyDigest: d,
  specDigest: d,
  workIds: ['T-1'],
  evidence: [],
};
const owned = { token: 'token-0123456789abcdef', leaseUntil: 1 };

test('Совместная проверка: active и failed до manifest представимы, passed без manifest — нет', () => {
  assert.equal(
    jointVerificationStateSchema.safeParse({ ...common, ...owned, status: 'active' }).success,
    true,
  );
  assert.equal(
    jointVerificationStateSchema.safeParse({
      ...common,
      ...owned,
      status: 'failed',
      finishedAt: at,
      error: 'setup failed',
    }).success,
    true,
  );
  assert.equal(
    jointVerificationSchema.safeParse({ ...common, status: 'passed', finishedAt: at }).success,
    false,
  );
  const manifest = { app: { sha, tree: sha } };
  assert.equal(
    jointVerificationSchema.safeParse({
      ...common,
      status: 'passed',
      finishedAt: at,
      manifest,
      manifestDigest: d,
    }).success,
    true,
  );
  // Владение не выходит наружу: у результата нет token.
  assert.equal(
    jointVerificationSchema.safeParse({ ...common, ...owned, status: 'active' }).success,
    false,
  );
});

test('CheckSuite и задание очереди ведущего baseline проходят схемы своих пространств', () => {
  const suite = {
    id: 'main:api:property',
    repositoryId: 'main',
    contractId: 'api',
    contractDigest: d,
    gate: 'property',
    basis: 'oracle-v1',
    cases: {
      c1: {
        id: 'c1',
        property: 'p1',
        input: '{"a":1}',
        expected: '2',
        source: { kind: 'oracle', decision: 'D-1', sha, runId: 'r1', taskId: 'T-1' },
        addedAt: at,
      },
    },
    versions: [
      {
        number: 1,
        digest: d,
        previous: null,
        cases: ['c1'],
        blob: sha,
        createdAt: at,
        reason: 'r',
        decisions: ['D-1'],
      },
    ],
    decisions: [
      {
        id: 'D-1',
        property: 'p1',
        input: '{"a":1}',
        inputHash: d,
        outcome: 'confirmed',
        reason: 'oracle',
        source: { sha },
        observed: { expected: '2', actual: '3', equal: false, repeats: 2, durationsMs: [1, 2] },
        origin: { kind: 'review', runtime: 'codex' },
        at,
      },
    ],
    adoptions: [
      {
        id: 'A-1',
        taskId: 'T-1',
        from: null,
        to: { number: 1, digest: d },
        actor: 'agent',
        reason: 'r',
        operation: 'op',
        at,
      },
    ],
    pending: [
      {
        id: 'P-1',
        version: 1,
        digest: d,
        tasks: ['T-1'],
        status: 'waiting',
        results: {},
        actor: 'agent',
        reason: 'r',
        requestedAt: at,
      },
    ],
    operations: { k: { key: 'k', status: 'running', token: 'tok', leaseUntil: 5, startedAt: at } },
    revision: 3,
  };
  assert.equal(checkSuiteSchema.safeParse(suite).success, true);
  assert.equal(localSchemas['check-suites'].safeParse(suite).success, true);
  assert.equal(checkSuiteSchema.safeParse({ ...suite, revision: -1 }).success, false);
  const job = {
    kind: 'board',
    id: 'B-1',
    authorRuntime: 'claude',
    maxAttempts: 3,
    key: d,
    inputDigest: d,
    stage: 1,
    attempts: 1,
    status: 'running',
    repairs: 0,
    token: 'tok',
    leaseUntil: 5,
    startedAt: at,
    history: [{ at, stage: 0, event: 'review' }],
  };
  assert.equal(workflowJobSchema.safeParse(job).success, true);
  assert.equal(localSchemas['workflow-jobs'].safeParse(job).success, true);
  assert.equal(workflowJobSchema.safeParse({ ...job, status: 'done' }).success, false);
});

test('Run baseline читается как AttemptState: context — краткие pins, runtime demo → fixture', () => {
  const run = {
    id: 'r1',
    taskId: 'T-1',
    repositoryId: 'main',
    attempt: 1,
    token: 'token-0123456789abcdef',
    owner: 'srv',
    runtime: 'demo',
    reviewer: 'demo',
    policyDigest: d,
    status: 'active',
    phase: 'running',
    startedAt: at,
    leaseUntil: 1,
    context: [{ id: 'rules', version: '1', repositoryId: 'main', revision: sha, digest: d }],
    evidence: [],
    callsRecorded: true,
  };
  const { taskId, runtime, reviewer, ...rest } = run;
  const map = (r: string) => (r === 'demo' ? 'fixture' : r);
  assert.equal(
    attemptStateSchema.safeParse({
      ...rest,
      workId: taskId,
      runtime: map(runtime),
      reviewer: map(reviewer),
    }).success,
    true,
  );
  // Без отображения прежнее значение отвергается явно, а не принимается молча.
  assert.equal(
    attemptStateSchema.safeParse({ ...rest, workId: taskId, runtime, reviewer }).success,
    false,
  );
});

test('Раунд ревью с автором вне harness представим', () => {
  const record = {
    id: 'RV-1',
    kind: 'plan',
    subject: 'g',
    digest: d,
    round: 1,
    at,
    approved: true,
    summary: 's',
    authorRuntime: 'external',
    reviewerRuntime: 'codex',
    sameVendor: false,
    findings: [],
    artifact: 'reviews/RV-1.json',
  };
  assert.equal(reviewRecordSchema.safeParse(record).success, true);
  assert.equal(reviewRecordSchema.safeParse({ ...record, authorRuntime: 'gpt' }).success, false);
});
