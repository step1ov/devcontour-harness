/**
 * H1-03: диагноз `explainStop` по сохранённому состоянию (`stopInputsOf`)
 * совпадает с тем, что затем делает настоящий движок (`h.run`): общий бюджет
 * группы, открытый разбор свойства у соседа, ожидающая перенастройка,
 * разрешённый повтор после неудачной попытки. Модели не вызываются.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyDigest } from '../src/contracts/policy.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { ready } from './engine-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, implement } from './runner-fixture.ts';

type Ctx = ReturnType<typeof hsetup>;
type H = ReturnType<Ctx['open']>;

/** Второе независимое поручение в той же группе. */
const farewell = (raw: Record<string, unknown>) => {
  const orders = raw.orders as Record<string, unknown>[];
  orders.push({
    ...orders[0],
    id: 'add-farewell',
    source: { connector: 'files', ref: 'add-farewell', revision: '1' },
    title: 'Add a farewell function',
    writeScope: ['lib'],
    dependsOn: [],
  });
};

/** Диагноз каждой работы; заодно проверяет, что чтение ничего не меняет. */
const diagnose = (ctx: Ctx, h: H) => {
  const jobs = JSON.stringify(h.workflows.list());
  const control = JSON.stringify(h.engine.read((v) => v.control()));
  const diags = stopInputsOf(h, {
    maxAttempts: ctx.policy.maxAttempts,
    repairBudget: ctx.policy.repairBudget,
  })
    .filter((i) => i.kind === 'work')
    .map(explainStop)
    .map((d) => ({
      workId: d.workId,
      retryPlanned: d.retryPlanned,
      actor: d.actor,
      action: d.action,
    }));
  assert.equal(JSON.stringify(h.workflows.list()), jobs, 'диагноз не меняет задания');
  assert.equal(
    JSON.stringify(h.engine.read((v) => v.control())),
    control,
    'диагноз не меняет control',
  );
  return diags;
};

/** Готовый граф и завершённое первое задание контроллера. */
const started = (ctx: Ctx, h: H) => {
  const graph = ready(h.engine, ctx.graph, 'controller');
  const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
  h.workflows.finish(h.workflows.claim(job.key)!);
  return job.key;
};

test('H1-03: explain = движок — общий бюджет группы repairBudget=1 на два отказа timeout', async () => {
  const ctx = hsetup({
    scenario: {
      writer: [implement(), implement({ 'lib/farewell.js': 'exports.bye = () => "Bye";\n' })],
      reviewer: approve(),
    },
    policy: (p) => {
      p.repairBudget = 1;
    },
    graph: farewell,
  });
  const h = ctx.open();
  try {
    const key = started(ctx, h);
    const a = h.engine.claim('controller')!;
    const b = h.engine.claim('controller')!;
    assert.deepEqual([a.workId, b.workId], ['add-greeting', 'add-farewell']);
    h.engine.fail(a.id, a.token, 'timeout A', { kind: 'timeout' });
    h.engine.fail(b.id, b.token, 'timeout B', { kind: 'timeout' });
    h.engine.release('controller');

    assert.deepEqual(diagnose(ctx, h), [
      { workId: 'add-greeting', retryPlanned: true, actor: 'controller', action: 'retry' },
      { workId: 'add-farewell', retryPlanned: false, actor: 'user', action: 'fix-environment' },
    ]);

    const result = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.deepEqual(
      result.works.map((w) => [w.id, w.status]),
      [
        ['add-greeting', 'done'],
        ['add-farewell', 'failed'],
      ],
    );
    const job = h.workflows.get(key);
    assert.equal(job.repairs ?? 0, 1);
    assert.match(job.error ?? '', /исчерпан бюджет автоматических восстановлений группы/);
    assert.equal(ctx.calls('claude', 'writer'), 1);
  } finally {
    h.close();
  }
});

for (const mode of ['pause', 'awaiting-user'] as const) {
  test(`H1-03: explain = движок — открытый разбор свойства у соседа (${mode}) блокирует повтор`, async () => {
    const ctx = hsetup({
      scenario: {
        writer: [implement({ 'lib/farewell.js': 'exports.bye = () => "Bye";\n' })],
        reviewer: approve(),
      },
      policy: (p) => {
        p.maxAttempts = 5;
        p.repairBudget = 5;
      },
      graph: farewell,
    });
    const h = ctx.open();
    try {
      const key = started(ctx, h);
      const a = h.engine.claim('controller')!;
      const b = h.engine.claim('controller')!;
      assert.deepEqual([a.workId, b.workId], ['add-greeting', 'add-farewell']);
      h.engine.fail(a.id, a.token, 'review p1 A2', { kind: 'review' });
      h.engine.fail(b.id, b.token, 'timeout B', { kind: 'timeout' });
      h.engine.release('controller');
      // Эпизод, как его открывает afterFailure() (awaiting-lead) или оставляет recoveryDecide (awaiting-user).
      const at = new Date(h.engine.clock()).toISOString();
      h.store.transact('task.retry', (tx) => {
        const w = tx.work('add-greeting')!;
        tx.putWork({
          ...w,
          recovery: {
            id: 'RC-probe',
            property: 'p1',
            basis: 'a'.repeat(64),
            runs: [a.id],
            openedAt: at,
            status: mode === 'pause' ? 'awaiting-lead' : 'awaiting-user',
            calls: 0,
            ...(mode === 'pause' ? {} : { reason: 'ждёт решения человека' }),
            history: [{ at, event: 'opened' }],
            version: 1,
          },
        });
      });
      if (mode === 'pause') h.engine.pause('operator');

      assert.deepEqual(diagnose(ctx, h), [
        { workId: 'add-greeting', retryPlanned: false, actor: 'user', action: 'user-decision' },
        { workId: 'add-farewell', retryPlanned: false, actor: 'user', action: 'fix-environment' },
      ]);

      const result = await h.run({ graph: ctx.graph, author: 'claude' });
      assert.deepEqual(
        result.works.map((w) => [w.id, w.status]),
        [
          ['add-greeting', 'failed'],
          ['add-farewell', 'failed'],
        ],
      );
      const job = h.workflows.get(key);
      assert.equal(job.repairs ?? 0, 0);
      assert.ok(
        (job.error ?? '').includes(
          mode === 'pause' ? 'ждёт снятия паузы человеком' : 'ждёт решения человека',
        ),
        job.error,
      );
      assert.equal(ctx.calls('claude', 'writer'), 0);
    } finally {
      h.close();
    }
  });
}

test('H1-03: explain = движок — ожидающая перенастройка не даёт повторить отказ timeout', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  try {
    const key = started(ctx, h);
    const a = h.engine.claim('controller')!;
    h.engine.fail(a.id, a.token, 'timeout A', { kind: 'timeout' });
    h.engine.release('controller');
    const next = { ...ctx.policy, prices: [], budgets: { onUnknown: 'continue' as const } };
    assert.equal(h.requestReconfigure('op-1', policyDigest(next)).changed, true);
    const job0 = h.workflows.get(key);
    assert.equal(
      h.engine.read((v) => h.workflows.continues(job0, v)),
      false,
    );

    assert.deepEqual(diagnose(ctx, h), [
      { workId: 'add-greeting', retryPlanned: false, actor: 'user', action: 'fix-environment' },
    ]);

    const result = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.deepEqual(
      result.works.map((w) => [w.id, w.status]),
      [['add-greeting', 'failed']],
    );
    const job = h.workflows.get(key);
    assert.equal(job.repairs ?? 0, 0);
    assert.equal(job.status, 'queued');
    assert.equal(ctx.calls('claude', 'writer'), 0);
  } finally {
    h.close();
  }
});

test('H1-03: explain = движок — разбор в статусе retry после неудачной разрешённой попытки (timeout)', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      p.maxAttempts = 5;
    },
  });
  const h = ctx.open();
  try {
    const key = started(ctx, h);
    let a = h.engine.claim('controller')!;
    h.engine.fail(a.id, a.token, 'review A1', { kind: 'review' });
    const at = new Date(h.engine.clock()).toISOString();
    h.store.transact('task.retry', (tx) => {
      const w = tx.work('add-greeting')!;
      tx.putWork({
        ...w,
        recovery: {
          id: 'RC-probe',
          property: 'p1',
          basis: h.engine.episodeOf(w, tx),
          runs: [a.id],
          openedAt: at,
          status: 'awaiting-lead',
          calls: 0,
          history: [{ at, event: 'opened' }],
          version: 1,
        },
      });
    });
    h.engine.recoveryDecide('add-greeting', 'RC-probe', {
      action: 'new-approach',
      reason: 'operator decided a new approach',
      evidence: [],
      hypothesis: 'h',
      plan: 'p',
      source: { kind: 'operator' },
      decidedAt: at,
    });
    h.engine.retry('add-greeting');
    a = h.engine.claim('controller')!;
    h.engine.fail(a.id, a.token, 'network down', { kind: 'timeout' });
    h.engine.release('controller');
    const w = h.engine.read((v) => v.work('add-greeting')!);
    assert.deepEqual([w.status, w.failureKind, w.recovery?.status], ['failed', 'timeout', 'retry']);

    assert.deepEqual(diagnose(ctx, h), [
      { workId: 'add-greeting', retryPlanned: true, actor: 'controller', action: 'retry' },
    ]);

    const result = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.deepEqual(
      result.works.map((x) => [x.id, x.status]),
      [['add-greeting', 'done']],
    );
    assert.equal(h.workflows.get(key).repairs ?? 0, 0);
    assert.equal(ctx.calls('claude', 'writer'), 1);
  } finally {
    h.close();
  }
});
