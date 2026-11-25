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
import { harnessDocsBase } from '../src/package.ts';
import { releaseDocsLine } from '../src/control/release-docs.ts';
import { operatorView } from '../src/projections/operator-view.ts';
import { baseInput } from './operator-view-input.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';

const call = (over: Partial<CallRecord>): CallRecord => ({
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
    reportedUsd: null,
    complete: true,
    source: 'claude-result',
  },
  costUsd: 1,
  costSource: 'provider-reported',
  ...over,
});

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
  assert.deepEqual(c.total, { usd: 3.75, bound: 'lower', calls: 5, unpricedCalls: 1 });
  assert.deepEqual(c.release, {
    usd: 1,
    bound: 'lower',
    calls: 2,
    unpricedCalls: 1,
    sinceRelease: true,
    since: '2026-11-24T11:00:00.000Z',
  });
  assert.equal(c.byModelTruncated, 0);
  assert.equal(c.byWorkTruncated, 0);
  // Выпуска ещё не было: явно sinceRelease: false, since нет.
  const noRelease = costBreakdown([call({ workId: 'a', runId: 'r1' })]);
  assert.deepEqual(noRelease.release, {
    usd: 1,
    bound: 'exact',
    calls: 1,
    unpricedCalls: 0,
    sinceRelease: false,
  });
  // Пределы списков: опущенное — счётчиками; у работы — последние попытки.
  const many = costBreakdown(
    [
      call({ workId: 'a', runId: 'r1', model: 'm1' }),
      call({ workId: 'a', runId: 'r2', model: 'm2' }),
      call({ workId: 'a', runId: 'r3', model: 'm3' }),
      call({ workId: 'b', runId: 'r4', model: 'm1' }),
    ],
    { limits: { models: 2, works: 1, attempts: 2 } },
  );
  assert.equal(many.byModel.length, 2);
  assert.equal(many.byModelTruncated, 1);
  assert.equal(many.byWork.length, 1);
  assert.equal(many.byWorkTruncated, 1);
  assert.deepEqual(
    many.byWork[0]!.attempts.map((x) => x.runId),
    ['r2', 'r3'],
  );
  assert.equal(many.byWork[0]!.attemptsTruncated, 1);
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
  assert.deepEqual([a.usd, a.bound, a.calls, a.unpricedCalls], [2.5, 'lower', 3, 1]);
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
  const [proposal] = engine.read((v) => v.work('w1')!.proposals ?? []);
  engine.decideProposal('w1', proposal!.id, {
    decision: 'accept',
    by: 'lead',
    reason: 'Вносим в следующий план',
  });
  engine.beginCall(call({ id: 'c-1', workId: 'w1', runId: run.id, costUsd: 0.5 }), {
    runId: run.id,
    stage: 'implementation',
  });
  engine.beginCall(call({ id: 'c-2', workId: 'w1', runId: run.id, costUsd: null }), {
    runId: run.id,
    stage: 'implementation',
  });
  const viewIn = (lang: 'ru' | 'en') =>
    operatorViewSchema.parse(
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
          { now: engine.clock(), lang },
        ),
      ),
    );
  const view = viewIn('ru');
  assert.equal(view.viewRevision, 10);
  const w = view.works.find((x) => x.id === 'w1')!;
  assert.deepEqual(w.attemptReviews?.[0]?.secondPass, {
    mode: 'on-reject',
    status: 'ran',
    refuted: 1,
    missed: 0,
    overturned: true,
    refutedFindings: [{ finding: 'ложная', basis: 'обработано в строке 3' }],
  });
  assert.equal(w.proposals?.length, 1);
  const p = w.proposals?.[0];
  assert.equal(p?.kind, 'follow-up');
  assert.equal(p?.status, 'accepted');
  assert.equal(p?.title, 'Локализация');
  assert.equal(p?.goal, 'Строки в словарь локалей');
  assert.equal(p?.reason, 'вне критериев');
  assert.equal(p?.decision?.by, 'lead');
  assert.equal(p?.decision?.reason, 'Вносим в следующий план');
  assert.deepEqual(
    {
      usd: w.cost?.usd,
      bound: w.cost?.bound,
      calls: w.cost?.calls,
      unpricedCalls: w.cost?.unpricedCalls,
      attempts: w.cost?.byAttempt.map((a) => [a.attempt, a.calls]),
      truncated: w.cost?.byAttemptTruncated,
    },
    { usd: 0.5, bound: 'lower', calls: 2, unpricedCalls: 1, attempts: [[1, 2]], truncated: 0 },
  );
  assert.equal(view.costs?.release.sinceRelease, false);
  assert.equal(view.costs?.byWorkTruncated, 0);
  const docs = view.forecast?.progress.release?.docs;
  assert.equal(docs?.mode, 'advisory');
  assert.equal(docs?.status, 'missing');
  assert.deepEqual(docs?.missingRoots, ['w1']);
  assert.match(docs?.line ?? '', /нет работы с меткой docs/);
  assert.match(
    viewIn('en').forecast?.progress.release?.docs?.line ?? '',
    /no work labelled docs after the root works \(w1\)/,
  );
});

test('lastFailure.referenceUrl — адрес документа на master; шаг документации принят — строка done', () => {
  assert.equal(harnessDocsBase('https://github.com/o/r'), 'https://github.com/o/r/blob/master/');
  assert.equal(harnessDocsBase(''), undefined);
  assert.match(
    harnessDocsBase() ?? '',
    /^https:\/\/github\.com\/[^/]+\/devcontour-harness\/blob\/master\/$/,
  );
  const env = engineOf(policyOf((p) => delete p.harnessMode));
  ready(env.engine, graphOf({ w1: [] }));
  env.engine.lead('c1');
  const run = env.engine.claim('c1')!;
  env.engine.fail(run.id, run.token, 'gate unit упал', { kind: 'gate' });
  const view = operatorViewSchema.parse(
    operatorView(
      collectOperatorViewInput(
        {
          engine: env.engine,
          policy: env.engine.policy,
          workflows: { list: () => [], continues: () => false } as never,
          stateDir: env.dir,
          baseDir: env.dir,
        },
        { raw: env.engine.policy, warnings: [], baseDir: env.dir },
        { now: env.engine.clock(), lang: 'ru' },
      ),
    ),
  );
  const last = view.works[0]!.attempts.lastFailure;
  assert.equal(last?.reference, 'docs/failure-causes.md#kind-gate');
  assert.equal(last?.referenceUrl, harnessDocsBase()! + 'docs/failure-causes.md#kind-gate');
  assert.equal(
    releaseDocsLine({ mode: 'advisory', status: 'done', roots: ['a'], works: ['docs'] }, 'en'),
    'Release documentation step: docs work docs accepted',
  );
});

test('ревью 1: попытки в расходе — по времени, «последние» — последние по времени; большой расход ужимается fitSize, итоги остаются', () => {
  const c = costBreakdown(
    [
      call({ id: 'z', workId: 'a', runId: 'run-z', startedAt: '2026-11-24T09:00:00.000Z' }),
      call({ id: 'a', workId: 'a', runId: 'run-a', startedAt: '2026-11-24T12:00:00.000Z' }),
      call({ id: 'm', workId: 'a', runId: 'run-m', startedAt: '2026-11-24T10:00:00.000Z' }),
    ],
    { limits: { attempts: 2 } },
  );
  assert.deepEqual(
    c.byWork[0]!.attempts.map((x) => x.runId),
    ['run-m', 'run-a'],
  );
  assert.equal(c.byWork[0]!.attemptsTruncated, 1);
  // Расход 200 работ по 20 попыток не делает представление недоступным.
  const records = Array.from({ length: 200 * 20 }, (_, i) =>
    call({
      id: `c${i}`,
      workId: `work-${Math.floor(i / 20)}`,
      runId: `run-${i}-${'x'.repeat(150)}`,
      startedAt: new Date(Date.parse('2026-11-24T00:00:00.000Z') + i * 1000).toISOString(),
    }),
  );
  const costs = costBreakdown(records);
  const view = operatorViewSchema.parse(
    operatorView(baseInput({ costs }), { maxBytes: 256 * 1024 }),
  );
  assert.equal(view.costs?.total.calls, 4000);
  assert.equal(view.costs?.byWork.length, 0);
  assert.equal(view.costs?.byWorkTruncated, 200);
});

test('ревью 2: после сброса номер попытки начинается заново — «последние» всё равно по времени', () => {
  // Как в production: attemptOf — номер попытки из состояния; новая попытка
  // после сброса — №1, но позже прежних №2 и №3.
  const numbers: Record<string, number> = { old2: 2, old3: 3, new1: 1 };
  const c = costBreakdown(
    [
      call({ id: 'a', workId: 'w', runId: 'old2', startedAt: '2026-11-24T09:00:00.000Z' }),
      call({ id: 'b', workId: 'w', runId: 'old3', startedAt: '2026-11-24T10:00:00.000Z' }),
      call({ id: 'c', workId: 'w', runId: 'new1', startedAt: '2026-11-24T12:00:00.000Z' }),
    ],
    { attemptOf: (r) => numbers[r], limits: { attempts: 2 } },
  );
  assert.deepEqual(
    c.byWork[0]!.attempts.map((x) => [x.runId, x.attempt]),
    [
      ['old3', 3],
      ['new1', 1],
    ],
  );
});
