/**
 * H1-03: диагноз `explainStop(stopInputsOf(...))` по сохранённому состоянию
 * против того, что затем делает настоящий движок (`h.run` с fixture runtimes):
 * ожидающая перенастройка с тем же digest, пауза shutdown, explain под
 * изменённой политикой, устаревшее согласование оператора, два графа в одной
 * очереди. Модели не вызываются.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionPolicySchema, policyDigest, workGraphSchema } from '../src/contracts/index.ts';
import type { ExecutionPolicy } from '../src/contracts/index.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { planReview, ready, trustNone } from './engine-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, implement } from './runner-fixture.ts';

type Ctx = ReturnType<typeof hsetup>;
type H = ReturnType<Ctx['open']>;
type RunInput = Parameters<H['run']>[0];

/** Диагноз каждого входа: workId, retryPlanned, actor, action. */
const explain = (h: H, policy: ExecutionPolicy, workId?: string) =>
  stopInputsOf(h, {
    maxAttempts: policy.maxAttempts,
    repairBudget: policy.repairBudget,
    ...(workId ? { workId } : {}),
  })
    .map(explainStop)
    .map((d) => ({
      workId: d.workId ?? '-',
      code: d.code,
      retryPlanned: d.retryPlanned,
      actor: d.actor,
      action: d.action,
    }));

/** Готовый граф и завершённое первое задание контроллера. */
const started = (ctx: Ctx, h: H) => {
  const graph = ready(h.engine, ctx.graph, 'controller');
  const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
  h.workflows.finish(h.workflows.claim(job.key)!);
  return job.key;
};

/** Отказ первой выдаваемой работы указанным классом. */
const failNext = (h: H, message: string, kind: 'timeout' | 'environment' | 'review') => {
  const a = h.engine.claim('controller')!;
  h.engine.fail(a.id, a.token, message, { kind });
  return a;
};

/** Наблюдает engine.retry и стадии задания во время h.run; обрывает прогон после max стадий. */
const observeRun = async (ctx: Ctx, h: H, input: RunInput, max = 60) => {
  const retries: string[] = [];
  const retry = h.engine.retry.bind(h.engine);
  h.engine.retry = (...args: Parameters<typeof retry>) => {
    retries.push(args[0]);
    return retry(...args);
  };
  const claim = h.workflows.claim.bind(h.workflows);
  let claims = 0;
  h.workflows.claim = (...args: Parameters<typeof claim>) => {
    if (++claims > max) throw new Error('engine-loop guard');
    return claim(...args);
  };
  const before = new Set(h.engine.read((v) => v.attempts().map((a) => a.id)));
  let error: string | undefined;
  try {
    await h.run(input);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    error,
    retries,
    claims,
    newAttempts: h.engine.read((v) =>
      v
        .attempts()
        .filter((a) => !before.has(a.id))
        .map((a) => [a.workId, a.status]),
    ),
    works: h.engine.read((v) => v.works().map((w) => [w.id, w.status])),
    jobs: h.workflows.list().map((j) => ({
      id: j.id,
      stage: j.stage,
      status: j.status,
      repairs: j.repairs ?? 0,
      error: j.error,
    })),
    writer: ctx.calls('claude', 'writer'),
    control: h.engine.read((v) => v.control()),
  };
};

const leadScenario = {
  writer: implement(),
  reviewer: approve(),
  lead: {
    result: {
      action: 'new-approach',
      reason: 'Use another implementation approach',
      evidence: ['saved attempts'],
      hypothesis: 'a new hypothesis',
      plan: 'verify configured gate',
      cases: null,
      proposal: null,
      conflict: null,
    },
  },
};

test('H1-03: explain = run — ожидающая перенастройка с digest текущей политики: повтор', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  try {
    const key = started(ctx, h);
    failNext(h, 'attempt timed out after 60000ms', 'timeout');
    h.engine.release('controller');
    h.requestReconfigure('op-1', policyDigest(ctx.policy));
    assert.equal(
      h.engine.read((v) => v.control().pauseReason),
      'reconfigure',
    );

    assert.deepEqual(explain(h, ctx.policy), [
      {
        workId: 'add-greeting',
        code: 'RUNTIME_UNAVAILABLE',
        retryPlanned: true,
        actor: 'controller',
        action: 'retry',
      },
    ]);

    const r = await observeRun(ctx, h, { graph: ctx.graph, author: 'claude' });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.retries, ['add-greeting']);
    assert.deepEqual(r.newAttempts, [['add-greeting', 'succeeded']]);
    assert.deepEqual(r.works, [['add-greeting', 'done']]);
    const job = h.workflows.get(key);
    assert.equal(job.status, 'completed');
    assert.equal(job.repairs ?? 0, 1);
    assert.equal(r.control.paused, false);
    assert.equal(r.control.reconfigure?.operation, 'op-1');
    assert.ok(r.control.reconfigure?.appliedAt, 'перенастройка применена');
    assert.equal(r.writer, 1);
  } finally {
    h.close();
  }
});

for (const mode of ['episode', 'lead', 'ready'] as const) {
  test(`H1-03: explain = run — пауза shutdown (${mode})`, async () => {
    const second = mode === 'lead';
    const ctx = hsetup({
      scenario: leadScenario,
      policy: (p) => {
        p.maxAttempts = 5;
      },
      graph: (g) => {
        if (!second) return;
        const orders = g.orders as Record<string, unknown>[];
        const o = structuredClone(orders[0]) as Record<string, unknown> & {
          source: { ref: string };
        };
        o.id = 'second';
        o.source.ref = 'second';
        orders.push(o);
      },
    });
    const h = ctx.open();
    try {
      const key = started(ctx, h);
      const episode = (status: 'retry' | 'awaiting-lead') => {
        const a = failNext(h, 'review A1', 'review');
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
        if (status === 'retry')
          h.engine.recoveryDecide('add-greeting', 'RC-probe', {
            action: 'new-approach',
            reason: 'operator decided a new approach',
            evidence: [],
            hypothesis: 'h',
            plan: 'p',
            source: { kind: 'operator' },
            decidedAt: at,
          });
      };
      if (mode === 'episode') episode('retry');
      if (mode === 'lead') {
        episode('awaiting-lead');
        const b = failNext(h, 'attempt timed out after 60000ms', 'timeout');
        assert.equal(b.workId, 'second');
      }
      h.engine.release('controller');
      h.engine.pause('shutdown');
      assert.equal(
        h.engine.read((v) => v.control().pauseReason),
        'shutdown',
      );

      const diagnosis = explain(h, ctx.policy);
      const r = () => observeRun(ctx, h, { graph: ctx.graph, author: 'claude' });
      if (mode === 'episode') {
        assert.deepEqual(diagnosis, [
          {
            workId: 'add-greeting',
            code: 'REVIEW_REJECTED',
            retryPlanned: true,
            actor: 'controller',
            action: 'retry',
          },
        ]);
        const run = await r();
        assert.equal(run.error, undefined);
        assert.deepEqual(run.retries, ['add-greeting']);
        assert.deepEqual(run.newAttempts, [['add-greeting', 'succeeded']]);
        assert.deepEqual(run.works, [['add-greeting', 'done']]);
        assert.equal(h.workflows.get(key).status, 'completed');
      }
      if (mode === 'lead') {
        assert.deepEqual(diagnosis, [
          {
            workId: 'add-greeting',
            code: 'REVIEW_REJECTED',
            retryPlanned: false,
            actor: 'controller',
            action: 'wait',
          },
          {
            workId: 'second',
            code: 'RUNTIME_UNAVAILABLE',
            retryPlanned: false,
            actor: 'controller',
            action: 'wait',
          },
        ]);
        const run = await r();
        assert.equal(run.error, undefined);
        // Движок сам повторяет обе работы (ожидание контроллера, не шаг человека).
        assert.ok(run.retries.includes('add-greeting'), JSON.stringify(run.retries));
        assert.ok(run.retries.includes('second'), JSON.stringify(run.retries));
        assert.deepEqual(
          run.newAttempts.filter(([w]) => w === 'add-greeting'),
          [['add-greeting', 'succeeded']],
        );
        assert.deepEqual(run.works[0], ['add-greeting', 'done']);
      }
      if (mode === 'ready') {
        assert.deepEqual(diagnosis, [
          {
            workId: 'add-greeting',
            code: 'NOT_READY',
            retryPlanned: false,
            actor: 'controller',
            action: 'wait',
          },
        ]);
        const run = await r();
        assert.equal(run.error, undefined);
        assert.deepEqual(run.retries, []);
        assert.deepEqual(run.newAttempts, [['add-greeting', 'succeeded']]);
        assert.deepEqual(run.works, [['add-greeting', 'done']]);
        assert.equal(h.workflows.get(key).status, 'completed');
      }
    } finally {
      h.close();
    }
  });
}

for (const mode of ['attempts', 'budget'] as const) {
  test(`H1-03: explain = run — explain и run под изменённой политикой (${mode})`, async () => {
    const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
    let h = ctx.open();
    try {
      started(ctx, h);
      failNext(h, 'attempt timed out after 60000ms', 'timeout');
      h.engine.release('controller');
      assert.deepEqual(explain(h, ctx.policy), [
        {
          workId: 'add-greeting',
          code: 'RUNTIME_UNAVAILABLE',
          retryPlanned: true,
          actor: 'controller',
          action: 'retry',
        },
      ]);
    } finally {
      h.close();
    }
    const raw = structuredClone(ctx.policy);
    if (mode === 'attempts') raw.maxAttempts = 5;
    if (mode === 'budget') raw.repairBudget = 0;
    const next = executionPolicySchema.parse(raw);
    h = ctx.open(next);
    try {
      const diagnosis = explain(h, next);
      const run = await observeRun(ctx, h, { graph: ctx.graph, author: 'claude' });
      assert.equal(run.error, undefined);
      if (mode === 'attempts') {
        assert.deepEqual(diagnosis, [
          {
            workId: 'add-greeting',
            code: 'RUNTIME_UNAVAILABLE',
            retryPlanned: true,
            actor: 'controller',
            action: 'retry',
          },
        ]);
        assert.deepEqual(run.retries, ['add-greeting']);
        assert.deepEqual(run.newAttempts, [['add-greeting', 'succeeded']]);
        assert.deepEqual(run.works, [['add-greeting', 'done']]);
        // Новая политика — новое задание графа; оно и завершается.
        assert.equal(run.jobs.length, 2);
        const created = run.jobs.find((j) => j.status === 'completed');
        assert.ok(created, JSON.stringify(run.jobs));
        assert.equal(created.repairs, 1);
      } else {
        assert.deepEqual(diagnosis, [
          {
            workId: 'add-greeting',
            code: 'RUNTIME_UNAVAILABLE',
            retryPlanned: false,
            actor: 'user',
            action: 'fix-environment',
          },
        ]);
        assert.deepEqual(run.retries, []);
        assert.deepEqual(run.newAttempts, []);
        assert.deepEqual(run.works, [['add-greeting', 'failed']]);
        assert.equal(run.writer, 0);
        const failed = run.jobs.find((j) => j.status === 'failed');
        assert.ok(failed, JSON.stringify(run.jobs));
        assert.match(failed.error ?? '', /исчерпан бюджет автоматических восстановлений группы/);
      }
    } finally {
      h.close();
    }
  });
}

test('H1-03: explain = run — режим operator, согласование устарело после смены политики', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      p.approvalMode = 'operator';
    },
  });
  let h = ctx.open();
  try {
    const e = h.engine;
    const { graph } = e.register(ctx.graph, trustNone);
    e.recordReview(planReview(e, graph, 1));
    e.approve(graph.id, 'operator', { bindContext: true });
    e.lead('controller');
    e.resume();
    e.release('controller');
    assert.deepEqual(explain(h, ctx.policy), [
      {
        workId: 'add-greeting',
        code: 'NOT_READY',
        retryPlanned: false,
        actor: 'controller',
        action: 'wait',
      },
    ]);
  } finally {
    h.close();
  }
  const raw = structuredClone(ctx.policy);
  raw.maxAttempts = 5;
  const next = executionPolicySchema.parse(raw);
  h = ctx.open(next);
  try {
    assert.deepEqual(explain(h, next), [
      {
        workId: 'add-greeting',
        code: 'APPROVAL_STALE',
        retryPlanned: false,
        actor: 'lead',
        action: 'review-plan',
      },
    ]);
    const run = await observeRun(ctx, h, { graph: ctx.graph, author: 'external' });
    assert.equal(run.error, undefined);
    assert.equal(run.claims, 0);
    assert.deepEqual(run.retries, []);
    assert.deepEqual(run.newAttempts, []);
    assert.deepEqual(run.works, [['add-greeting', 'ready']]);
    assert.deepEqual(run.jobs, []);
    assert.equal(run.writer, 0);
  } finally {
    h.close();
  }
});

test('H1-03: explain = run — два графа в одной очереди, отказ environment у первого', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  try {
    const rawB = structuredClone(ctx.graph);
    rawB.id = 'greeting-b';
    rawB.source = { ...rawB.source, ref: 'graph-b.json' };
    const first = rawB.orders[0]!;
    rawB.orders[0] = { ...first, id: 'b-work', source: { ...first.source, ref: 'b-work' } };
    const graphB = workGraphSchema.parse(rawB);
    const keyA = started(ctx, h);
    const gB = ready(h.engine, graphB, 'controller');
    const jobB = h.workflows.start({ kind: 'graph', id: gB.id, authorRuntime: 'claude' });
    h.workflows.finish(h.workflows.claim(jobB.key)!);
    const a = failNext(h, 'getaddrinfo ENOTFOUND api.example', 'environment');
    assert.equal(a.workId, 'add-greeting');
    h.engine.release('controller');
    assert.deepEqual(
      h.engine.read((v) => [v.control().paused, v.control().pauseReason]),
      [true, 'runtime'],
    );

    const waitB = {
      workId: 'b-work',
      code: 'NOT_READY',
      retryPlanned: false,
      actor: 'controller',
      action: 'wait',
    };
    assert.deepEqual(explain(h, ctx.policy), [
      {
        workId: 'add-greeting',
        code: 'RUNTIME_UNAVAILABLE',
        retryPlanned: true,
        actor: 'controller',
        action: 'retry',
      },
      waitB,
    ]);
    assert.deepEqual(explain(h, ctx.policy, 'b-work'), [waitB]);

    const run = await observeRun(ctx, h, { graph: ctx.graph, author: 'claude' });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.retries, ['add-greeting']);
    assert.deepEqual(run.newAttempts, [
      ['add-greeting', 'succeeded'],
      ['b-work', 'succeeded'],
    ]);
    assert.deepEqual(run.works, [
      ['add-greeting', 'done'],
      ['b-work', 'done'],
    ]);
    const jobA = h.workflows.get(keyA);
    assert.equal(jobA.status, 'completed');
    assert.equal(jobA.repairs ?? 0, 1);
  } finally {
    h.close();
  }
});
