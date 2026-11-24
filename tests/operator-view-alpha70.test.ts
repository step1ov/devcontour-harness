/**
 * Представление оператора, ревизия 10 (0.1.0-alpha.70): расход по работам,
 * попыткам, ролям и моделям (`costs`), второй проход ревью попыток
 * (`attemptReviews[].secondPass`), предложения исполнителей (`proposals`),
 * шаг документации выпуска (`progress.release.docs`), справочник причин у
 * последнего отказа (`attempts.lastFailure.reference`).
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, operatorViewSchema, type CallRecord } from '../src/contracts/index.ts';
import { collectOperatorViewInput } from '../src/control/operator-view.ts';
import { costBreakdown, costRoleOf } from '../src/projections/costs.ts';
import { operatorView } from '../src/projections/operator-view.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';

const call = (over: Partial<CallRecord>): CallRecord =>
  ({
    id: Math.random().toString(16).slice(2),
    stage: 'implementation',
    runtime: 'claude',
    model: 'claude-x',
    runtimeVersion: null,
    startedAt: '2026-11-24T10:00:00.000Z',
    outcome: 'returned',
    promptBytes: 1,
    promptDigest: digestOf('p'),
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      complete: true,
      source: 'claude-result',
    },
    costUsd: 1,
    costSource: 'provider-reported',
    ...over,
  }) as CallRecord;

test('costBreakdown: по работам и попыткам, ролям, моделям; неизвестная цена — нижняя граница; выпуск — после release done', () => {
  assert.equal(costRoleOf('implementation'), 'writer');
  assert.equal(costRoleOf('candidate-review'), 'reviewer');
  assert.equal(costRoleOf('candidate-review-refute'), 'reviewer');
  assert.equal(costRoleOf('code-review'), 'reviewer');
  assert.equal(costRoleOf('plan-review'), 'planner');
  assert.equal(costRoleOf('property-recovery'), 'other');
  const c = costBreakdown(
    [
      call({ workId: 'a', runId: 'r1', costUsd: 2 }),
      call({
        workId: 'a',
        runId: 'r1',
        stage: 'candidate-review',
        runtime: 'codex',
        model: 'gpt-x',
        costUsd: 0.5,
      }),
      call({ workId: 'a', runId: 'r2', costUsd: null, startedAt: '2026-11-24T12:00:00.000Z' }),
      call({ workId: 'b', runId: 'r3', costUsd: 1, startedAt: '2026-11-24T12:00:00.000Z' }),
      call({
        subjectId: 'g',
        subjectKind: 'group',
        stage: 'plan-review',
        runtime: 'codex',
        model: 'gpt-x',
        costUsd: 0.25,
      }),
    ],
    { attemptOf: (r) => ({ r1: 1, r2: 2, r3: 1 })[r], releaseSince: '2026-11-24T11:00:00.000Z' },
  );
  assert.deepEqual(c.total, { usd: 3.75, bound: 'lower', calls: 5 });
  assert.deepEqual(c.release, {
    usd: 1,
    bound: 'lower',
    calls: 2,
    since: '2026-11-24T11:00:00.000Z',
  });
  assert.deepEqual(
    c.byRole.map((r) => [r.role, r.usd, r.calls]),
    [
      ['writer', 3, 3],
      ['reviewer', 0.5, 1],
      ['planner', 0.25, 1],
    ],
  );
  assert.deepEqual(
    c.byModel.map((m) => [m.vendor, m.model, m.usd]),
    [
      ['anthropic', 'claude-x', 3],
      ['openai', 'gpt-x', 0.75],
    ],
  );
  const a = c.byWork.find((w) => w.workId === 'a')!;
  assert.deepEqual([a.usd, a.bound, a.calls], [2.5, 'lower', 3]);
  assert.deepEqual(
    a.attempts.map((x) => [x.runId, x.attempt, x.usd, x.bound]),
    [
      ['r1', 1, 2.5, 'exact'],
      ['r2', 2, 0, 'lower'],
    ],
  );
});

test('view: второй проход и предложения у работы, шаг документации выпуска — по схеме ревизии 10', () => {
  const env = engineOf(policyOf((p) => delete p.harnessMode));
  const { engine, dir } = env;
  ready(engine, graphOf({ w1: [] }));
  engine.lead('c1');
  const run = engine.claim('c1')!;
  engine.phase(run.id, run.token, 'verifying', { candidateSha: sha('c') });
  engine.recordProposals(run.id, run.token, [
    {
      kind: 'follow-up',
      title: 'Локализация',
      goal: 'Строки в словарь локалей',
      acceptance: ['ru/en'],
      reason: 'вне критериев',
    },
  ]);
  for (const kind of ['test', 'review'] as const)
    engine.evidence(run.id, run.token, {
      kind,
      phase: 'candidate',
      sha: sha('c'),
      gate: kind === 'test' ? 'unit' : 'independent-review',
      passed: true,
      command: ['x'],
      exitCode: 0,
      log: '',
      digest: digestOf(kind),
      summary: 'ok',
      ...(kind === 'review'
        ? {
            findings: [],
            reviewPasses: {
              mode: 'on-reject' as const,
              source: 'default' as const,
              status: 'ran' as const,
              first: 1,
              confirmed: 0,
              refuted: [{ message: 'ложная', basis: 'обработано в строке 3' }],
              missed: 0,
              overturned: true,
            },
          }
        : {}),
    });
  const view = operatorViewSchema.parse(
    operatorView(
      collectOperatorViewInput(
        {
          engine,
          policy: engine.policy,
          workflows: { list: () => [], continues: () => false } as never,
          stateDir: dir,
          baseDir: dir,
        },
        { raw: engine.policy, warnings: [], baseDir: dir },
        { now: engine.clock(), lang: 'ru' },
      ),
    ),
  );
  assert.equal(view.viewRevision, 10);
  const w = view.works.find((x) => x.id === 'w1')!;
  assert.deepEqual(w.attemptReviews?.[0]?.secondPass, {
    mode: 'on-reject',
    status: 'ran',
    refuted: 1,
    missed: 0,
    overturned: true,
  });
  assert.equal(w.proposals?.length, 1);
  assert.equal(w.proposals?.[0]?.kind, 'follow-up');
  assert.equal(w.proposals?.[0]?.status, 'proposed');
  const docs = view.forecast?.progress.release?.docs;
  assert.equal(docs?.mode, 'advisory');
  assert.equal(docs?.status, 'missing');
  assert.match(docs?.line ?? '', /нет работы с меткой docs/);
});
