/**
 * H1-03: диагноз `explainStop` по сохранённому состоянию (`stopInputsOf`)
 * совпадает с тем, что затем делает настоящий движок (`h.run`): общий бюджет
 * группы, открытый разбор свойства у соседа, ожидающая перенастройка,
 * разрешённый повтор после неудачной попытки. Модели не вызываются.
 */
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { executionPolicySchema, workGraphSchema } from '../src/contracts/index.ts';
import { policyDigest } from '../src/contracts/policy.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { ready } from './engine-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { knap, propertyHarness, propertySetup } from './property-fixture.ts';
import { measuredInvoke } from '../src/engine/measured.ts';
import { approve, bin, implement } from './runner-fixture.ts';
import { Harness } from '../src/control/harness.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';

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
        {
          workId: 'add-greeting',
          retryPlanned: false,
          actor: 'user',
          // Разбор ждёт снятия паузы человеком — шаг человека именно этот.
          action: mode === 'pause' ? 'resume-queue' : 'user-decision',
        },
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

test('H1-03 (H1-F007): explain = движок — известная остановка посередине группы останавливает и тех, кто за ней', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: Record<string, unknown>) => {
      p.repairBudget = 6;
    },
    graph: (raw: Record<string, unknown>) => {
      const orders = raw.orders as Record<string, unknown>[];
      for (const id of ['second', 'third'])
        orders.push({
          ...orders[0],
          id,
          source: { connector: 'files', ref: id, revision: '1' },
          title: 'Independent work ' + id,
          writeScope: ['lib/' + id],
          dependsOn: [],
        });
    },
  });
  const h = ctx.open();
  try {
    const key = started(ctx, h);
    for (const i of [0, 1, 2]) {
      const a = h.engine.claim('controller')!;
      h.engine.fail(a.id, a.token, 'fixture failure ' + i, {
        kind: i === 1 ? 'review-protocol' : 'timeout',
      });
    }
    h.engine.release('controller');
    assert.deepEqual(diagnose(ctx, h), [
      { workId: 'add-greeting', retryPlanned: true, actor: 'controller', action: 'retry' },
      { workId: 'second', retryPlanned: false, actor: 'user', action: 'user-decision' },
      { workId: 'third', retryPlanned: false, actor: 'user', action: 'fix-environment' },
    ]);
    const result = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.deepEqual(
      result.works.map((w) => [w.id, w.status]),
      [
        ['add-greeting', 'done'],
        ['second', 'failed'],
        ['third', 'failed'],
      ],
    );
    const job = h.workflows.get(key);
    assert.equal(job.repairs, 1);
    assert.match(job.error!, /second/);
    assert.equal(
      h.engine.read((v) => v.work('third')!.attempt),
      1,
      'third не повторялась',
    );
    assert.equal(ctx.calls('claude', 'writer'), 1);
  } finally {
    h.close();
  }
});

/** Код диагноза каждой работы (дополняет `diagnose`). */
const codes = (ctx: Ctx, h: H) =>
  stopInputsOf(h, { maxAttempts: ctx.policy.maxAttempts, repairBudget: ctx.policy.repairBudget })
    .filter((i) => i.kind === 'work')
    .map(explainStop)
    .map((d) => [d.workId, d.code]);

/** Эпизод разбора свойства p1 на работе, как его открывает afterFailure(). */
const openEpisode = (
  h: H,
  workId: string,
  runs: string[],
  status: 'awaiting-lead' | 'awaiting-user' | 'stopped',
  reason?: string,
) => {
  const at = new Date(h.engine.clock()).toISOString();
  h.store.transact('task.retry', (tx) => {
    const w = tx.work(workId)!;
    tx.putWork({
      ...w,
      recovery: {
        id: 'RC-probe',
        property: 'p1',
        basis: h.engine.episodeOf(w, tx),
        runs,
        openedAt: at,
        status,
        calls: status === 'awaiting-lead' ? 0 : 1,
        ...(reason === undefined ? {} : { reason }),
        history: [{ at, event: 'opened' }],
        version: 1,
      },
    });
  });
  return at;
};

/** Решение оператора по эпизоду: новый подход (эпизод переходит в retry). */
const decideNewApproach = (h: H, workId: string, at: string) =>
  h.engine.recoveryDecide(workId, 'RC-probe', {
    action: 'new-approach',
    reason: 'operator decided a new approach',
    evidence: [],
    hypothesis: 'h',
    plan: 'p',
    source: { kind: 'operator' },
    decidedAt: at,
  });

/** Второе поручение `dependent`; с `dep` — зависит от первого. */
const second = (dep: boolean) => (raw: Record<string, unknown>) => {
  const orders = raw.orders as Record<string, unknown>[];
  orders.push({
    ...orders[0],
    id: 'dependent',
    source: { connector: 'files', ref: 'dependent', revision: '1' },
    title: 'Dependent work',
    writeScope: ['lib/dep'],
    dependsOn: dep ? [orders[0]!.id] : [],
  });
};

test('H1-03: explain = движок — эпизод awaiting-lead на последней разрешённой попытке → сброс попыток (решение человека)', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      p.maxAttempts = 2;
      p.repairBudget = 3;
    },
  });
  const h = ctx.open();
  try {
    const key = started(ctx, h);
    const runs: string[] = [];
    for (const i of [1, 2]) {
      const a = h.engine.claim('controller')!;
      runs.push(a.id);
      h.engine.fail(a.id, a.token, 'review p1 #' + i, { kind: 'review' });
      if (i === 1) h.engine.retry('add-greeting');
    }
    h.engine.release('controller');
    openEpisode(h, 'add-greeting', runs, 'awaiting-lead');
    const w = h.engine.read((v) => v.work('add-greeting')!);
    assert.deepEqual([w.status, w.attempt], ['failed', ctx.policy.maxAttempts]);

    assert.deepEqual(diagnose(ctx, h), [
      { workId: 'add-greeting', retryPlanned: false, actor: 'user', action: 'reset-attempts' },
    ]);

    const result = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.deepEqual(
      result.works.map((x) => [x.id, x.status]),
      [['add-greeting', 'failed']],
    );
    const job = h.workflows.get(key);
    assert.equal(job.status, 'failed');
    assert.ok((job.error ?? '').includes('Попытки поручения исчерпаны'), job.error);
    assert.equal(ctx.calls('claude', 'writer'), 0);
  } finally {
    h.close();
  }
});

for (const mode of ['awaiting-user', 'stopped'] as const) {
  test(`H1-03: explain = движок — ready-работа с эпизодом ${mode} ждёт решения человека`, async () => {
    const ctx = hsetup({
      scenario: { writer: implement(), reviewer: approve() },
      policy: (p) => {
        p.maxAttempts = 5;
      },
    });
    const h = ctx.open();
    try {
      const key = started(ctx, h);
      const a = h.engine.claim('controller')!;
      h.engine.fail(a.id, a.token, 'review A1', { kind: 'review' });
      h.engine.release('controller');
      openEpisode(h, 'add-greeting', [a.id], mode, 'ждёт решения человека по свойству');
      h.engine.retry('add-greeting'); // как `harness retry --work`
      const w = h.engine.read((v) => v.work('add-greeting')!);
      assert.deepEqual([w.status, w.recovery?.status], ['ready', mode]);

      const expected = [
        { workId: 'add-greeting', retryPlanned: false, actor: 'user', action: 'user-decision' },
      ];
      assert.deepEqual(diagnose(ctx, h), expected);

      const result = await h.run({ graph: ctx.graph, author: 'claude' });
      assert.deepEqual(
        result.works.map((x) => [x.id, x.status]),
        [['add-greeting', 'ready']],
      );
      const job = h.workflows.get(key);
      assert.equal(job.status, 'failed');
      assert.ok((job.error ?? '').includes('ждёт решения человека по свойству'), job.error);
      assert.equal(ctx.calls('claude', 'writer'), 0);
      assert.deepEqual(diagnose(ctx, h), expected, 'диагноз после прогона тот же');
    } finally {
      h.close();
    }
  });
}

test('H1-03: explain = движок — зависимая работа за остановленной (unknown) предпосылкой', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    graph: second(true),
  });
  const h = ctx.open();
  try {
    const key = started(ctx, h);
    const a = h.engine.claim('controller')!;
    assert.equal(a.workId, 'add-greeting');
    assert.equal(h.engine.claim('controller'), undefined, 'зависимая не выдаётся');
    h.engine.fail(a.id, a.token, 'unclassified', { kind: 'unknown' });
    h.engine.release('controller');

    assert.deepEqual(diagnose(ctx, h), [
      { workId: 'add-greeting', retryPlanned: false, actor: 'user', action: 'user-decision' },
      { workId: 'dependent', retryPlanned: false, actor: 'lead', action: 'diagnose-failure' },
    ]);
    assert.deepEqual(codes(ctx, h)[1], ['dependent', 'NOT_READY']);

    const result = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.deepEqual(
      result.works.map((x) => [x.id, x.status]),
      [
        ['add-greeting', 'failed'],
        ['dependent', 'ready'],
      ],
    );
    assert.equal(h.workflows.get(key).status, 'failed');
    assert.equal(ctx.calls('claude', 'writer'), 0);
  } finally {
    h.close();
  }
});

test('H1-03: explain = движок — эпизод retry у одной работы и отказ unknown у соседа', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      p.maxAttempts = 5;
    },
    graph: second(false),
  });
  const h = ctx.open();
  try {
    started(ctx, h);
    const a = h.engine.claim('controller')!;
    const b = h.engine.claim('controller')!;
    assert.deepEqual([a.workId, b.workId], ['add-greeting', 'dependent']);
    h.engine.fail(a.id, a.token, 'review A1', { kind: 'review' });
    h.engine.fail(b.id, b.token, 'unclassified B', { kind: 'unknown' });
    h.engine.release('controller');
    decideNewApproach(h, 'add-greeting', openEpisode(h, 'add-greeting', [a.id], 'awaiting-lead'));
    assert.equal(
      h.engine.read((v) => v.work('add-greeting')!.recovery?.status),
      'retry',
    );

    assert.deepEqual(diagnose(ctx, h), [
      { workId: 'add-greeting', retryPlanned: true, actor: 'controller', action: 'retry' },
      { workId: 'dependent', retryPlanned: false, actor: 'user', action: 'user-decision' },
    ]);

    const result = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.deepEqual(
      result.works.map((x) => [x.id, x.status]),
      [
        ['add-greeting', 'done'],
        ['dependent', 'failed'],
      ],
    );
    assert.equal(ctx.calls('claude', 'writer'), 1);
  } finally {
    h.close();
  }
});

// Только диагноз: h.run в этих состояниях зацикливается внутри движка
// (известный отдельный дефект FI-002, вне рамок H1-03) — поэтому не вызывается.
test('H1-03: explain = движок — эпизод retrying, разрешённый повтор упал на gate → решение человека (только диагноз)', () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      p.maxAttempts = 5;
    },
  });
  const h = ctx.open();
  try {
    started(ctx, h);
    let a = h.engine.claim('controller')!;
    h.engine.fail(a.id, a.token, 'review A1', { kind: 'review' });
    decideNewApproach(h, 'add-greeting', openEpisode(h, 'add-greeting', [a.id], 'awaiting-lead'));
    h.engine.retry('add-greeting');
    a = h.engine.claim('controller')!;
    h.engine.fail(a.id, a.token, 'other gate failed', { kind: 'gate' });
    h.engine.release('controller');
    const w = h.engine.read((v) => v.work('add-greeting')!);
    assert.deepEqual(
      [w.status, w.failureKind, w.recovery?.status, w.recovery?.retryRun === a.id],
      ['failed', 'gate', 'retrying', true],
    );

    assert.deepEqual(diagnose(ctx, h), [
      { workId: 'add-greeting', retryPlanned: false, actor: 'user', action: 'user-decision' },
    ]);
  } finally {
    h.close();
  }
});

for (const mode of ['env', 'operator'] as const) {
  // Только диагноз: h.run здесь зацикливается внутри движка (FI-002, вне рамок H1-03).
  test(`H1-03: explain = движок — эпизод retry при паузе очереди (${mode}) → шаг человека (только диагноз)`, () => {
    const ctx = hsetup({
      scenario: { writer: implement(), reviewer: approve() },
      policy: (p) => {
        p.maxAttempts = 5;
      },
    });
    const h = ctx.open();
    try {
      started(ctx, h);
      let a = h.engine.claim('controller')!;
      h.engine.fail(a.id, a.token, 'review A1', { kind: 'review' });
      decideNewApproach(h, 'add-greeting', openEpisode(h, 'add-greeting', [a.id], 'awaiting-lead'));
      h.engine.retry('add-greeting');
      a = h.engine.claim('controller')!;
      h.engine.fail(a.id, a.token, 'getaddrinfo ENOTFOUND', {
        kind: mode === 'env' ? 'environment' : 'timeout',
      });
      h.engine.release('controller');
      if (mode === 'operator') h.engine.pause('operator');
      const w = h.engine.read((v) => v.work('add-greeting')!);
      assert.deepEqual(
        [w.status, w.recovery?.status, h.engine.read((v) => v.control().pauseReason)],
        ['failed', 'retry', mode === 'env' ? 'runtime' : 'operator'],
      );

      assert.deepEqual(diagnose(ctx, h), [
        {
          workId: 'add-greeting',
          retryPlanned: false,
          actor: 'user',
          action: mode === 'env' ? 'fix-environment' : 'resume-queue',
        },
      ]);
      assert.deepEqual(codes(ctx, h), [
        ['add-greeting', mode === 'env' ? 'RUNTIME_UNAVAILABLE' : 'PAUSED'],
      ]);
    } finally {
      h.close();
    }
  });
}

test('H1-03 (H1-F009): explain = движок — готовый повтор эпизода не выдаётся на паузе runtime; следующий эпизод не обещает продолжения (только диагноз)', () => {
  // h.run здесь не вызывается: движок зацикливается в этом состоянии (FI-002, отдельное задание).
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: Record<string, unknown>) => {
      p.maxAttempts = 5;
      p.repairBudget = 6;
    },
    graph: (raw: Record<string, unknown>) => {
      const orders = raw.orders as Record<string, unknown>[];
      orders.push({
        ...orders[0],
        id: 'second',
        source: { connector: 'files', ref: 'second', revision: '1' },
        title: 'Second independent work',
        dependsOn: [],
        writeScope: ['lib'],
      });
    },
  });
  const h = ctx.open();
  try {
    started(ctx, h);
    const runs = [0, 1].map((i) => {
      const a = h.engine.claim('controller')!;
      h.engine.fail(a.id, a.token, 'review property fixture ' + i, { kind: 'review' });
      return a;
    });
    const at = new Date(h.engine.clock()).toISOString();
    for (const a of runs)
      h.store.transact('task.retry', (tx) => {
        const w = tx.work(a.workId)!;
        tx.putWork({
          ...w,
          recovery: {
            id: 'RC-' + w.id,
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
    h.engine.recoveryDecide('add-greeting', 'RC-add-greeting', {
      action: 'new-approach',
      reason: 'operator decided a new approach',
      evidence: [],
      hypothesis: 'h',
      plan: 'p',
      source: { kind: 'operator' },
      decidedAt: at,
    });
    h.engine.retry('add-greeting');
    const retried = h.engine.claim('controller')!;
    h.engine.fail(retried.id, retried.token, 'getaddrinfo ENOTFOUND fixture', {
      kind: 'environment',
    });
    h.engine.retry('add-greeting');
    h.engine.release('controller');
    assert.equal(h.engine.read((v) => v.control()).pauseReason, 'runtime');
    const d = diagnose(ctx, h);
    assert.deepEqual(d, [
      { workId: 'add-greeting', retryPlanned: false, actor: 'user', action: 'fix-environment' },
      // Группа стоит на паузе runtime: шаг человека — устранить её причину.
      { workId: 'second', retryPlanned: false, actor: 'user', action: 'fix-environment' },
    ]);
  } finally {
    h.close();
  }
});

/** Второе независимое поручение `second` в той же группе (как в пробах приёмки). */
const secondWork = (raw: Record<string, unknown>) => {
  const orders = raw.orders as Record<string, unknown>[];
  orders.push({
    ...orders[0],
    id: 'second',
    source: { connector: 'files', ref: 'second', revision: '1' },
    title: 'Second independent work',
    dependsOn: [],
    writeScope: ['lib'],
  });
};

/** По две review-неудачи у каждой из двух работ и эпизоды awaiting-lead, как в afterFailure. */
const twoEpisodes = (h: H) => {
  const runs: { workId: string; ids: string[] }[] = [];
  for (let i = 0; i < 2; i++) {
    const a = h.engine.claim('controller')!;
    h.engine.fail(a.id, a.token, 'review property fixture first ' + i, { kind: 'review' });
    h.engine.retry(a.workId);
    const b = h.engine.claim('controller')!;
    assert.equal(b.workId, a.workId);
    h.engine.fail(b.id, b.token, 'review property fixture second ' + i, { kind: 'review' });
    runs.push({ workId: a.workId, ids: [a.id, b.id] });
  }
  assert.deepEqual(
    runs.map((r) => r.workId),
    ['add-greeting', 'second'],
  );
  const at = new Date(h.engine.clock()).toISOString();
  for (const r of runs)
    h.store.transact('task.retry', (tx) => {
      const w = tx.work(r.workId)!;
      tx.putWork({
        ...w,
        recovery: {
          id: 'RC-' + w.id,
          property: 'p1',
          basis: h.engine.episodeOf(w, tx),
          runs: r.ids,
          openedAt: at,
          status: 'awaiting-lead',
          calls: 0,
          history: [{ at, event: 'opened' }],
          version: 1,
        },
      });
    });
  return at;
};

/** Решение оператора new-approach по эпизоду `RC-<workId>`. */
const operatorNewApproach = (h: H, workId: string, at: string) =>
  h.engine.recoveryDecide(workId, 'RC-' + workId, {
    action: 'new-approach',
    reason: 'operator decided a new approach',
    evidence: [],
    hypothesis: 'h',
    plan: 'p',
    source: { kind: 'operator' },
    decidedAt: at,
  });

/** Диагноз одной работы, как `harness explain --work`. */
const diagnoseOne = (ctx: Ctx, h: H, workId: string) =>
  stopInputsOf(h, {
    maxAttempts: ctx.policy.maxAttempts,
    repairBudget: ctx.policy.repairBudget,
    workId,
  })
    .filter((i) => i.kind === 'work')
    .map(explainStop)
    .map((d) => ({
      workId: d.workId,
      retryPlanned: d.retryPlanned,
      actor: d.actor,
      action: d.action,
    }));

test('H1-03 (H1-F010): explain = движок — последний разрешённый повтор эпизода упал, попытки исчерпаны → следующий эпизод не обещает продолжения', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      p.maxAttempts = 3;
      p.repairBudget = 6;
    },
    graph: secondWork,
  });
  const h = ctx.open();
  try {
    const key = started(ctx, h);
    const at = twoEpisodes(h);
    operatorNewApproach(h, 'add-greeting', at);
    h.engine.retry('add-greeting');
    const retried = h.engine.claim('controller')!;
    assert.equal(retried.workId, 'add-greeting');
    h.engine.fail(retried.id, retried.token, 'timeout on last permitted recovery retry', {
      kind: 'timeout',
    });
    h.engine.release('controller');
    const w = h.engine.read((v) => v.work('add-greeting')!);
    assert.deepEqual(
      [w.status, w.recovery?.status, w.attempt],
      ['failed', 'retry', ctx.policy.maxAttempts],
    );
    assert.equal(
      h.engine.read((v) => v.work('second')!.recovery?.status),
      'awaiting-lead',
    );

    const second = {
      workId: 'second',
      retryPlanned: false,
      actor: 'user',
      action: 'user-decision',
    };
    assert.deepEqual(diagnose(ctx, h), [
      { workId: 'add-greeting', retryPlanned: false, actor: 'user', action: 'reset-attempts' },
      second,
    ]);
    assert.deepEqual(codes(ctx, h)[0], ['add-greeting', 'ATTEMPTS_EXHAUSTED']);
    assert.deepEqual(diagnoseOne(ctx, h, 'second'), [second], 'фильтр --work second');

    await h.run({ graph: ctx.graph, author: 'claude' });
    const job = h.workflows.get(key);
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /Исчерпан лимит попыток/);
    assert.equal(
      h.engine.read((v) => v.work('second')!.recovery?.status),
      'awaiting-lead',
    );
    assert.equal(ctx.calls('claude', 'writer'), 0);
    assert.equal(ctx.calls('codex', 'reviewer'), 0);
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F011): explain = движок — два эпизода awaiting-lead на одну единицу общего бюджета → второй ждёт решения человека', async () => {
  // Локальный lead fixture (как в пробе приёмки): разбор выбирает new-approach.
  const scenario = {
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
  const ctx = hsetup({
    scenario,
    policy: (p) => {
      p.maxAttempts = 3;
      p.repairBudget = 1;
    },
    graph: secondWork,
  });
  const h = ctx.open();
  try {
    const key = started(ctx, h);
    twoEpisodes(h);
    h.engine.release('controller');

    const second = {
      workId: 'second',
      retryPlanned: false,
      actor: 'user',
      action: 'user-decision',
    };
    assert.deepEqual(diagnose(ctx, h), [
      { workId: 'add-greeting', retryPlanned: false, actor: 'controller', action: 'wait' },
      second,
    ]);
    assert.deepEqual(diagnoseOne(ctx, h, 'second'), [second], 'фильтр --work second');

    await h.run({ graph: ctx.graph, author: 'claude' });
    const job = h.workflows.get(key);
    assert.equal(job.status, 'failed');
    assert.equal(job.repairs, 1);
    assert.match(job.error ?? '', /исчерпан бюджет восстановлений/);
    assert.equal(ctx.calls('claude', 'writer'), 1);
    const w = h.engine.read((v) => v.work('second')!);
    assert.deepEqual([w.recovery?.status, w.recovery?.calls], ['awaiting-lead', 0]);
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F012): explain = движок — после эпизода retry отменённая работа останавливает группу до обычного повтора', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      p.maxAttempts = 5;
      p.repairBudget = 6;
    },
    graph: (raw) => {
      const orders = raw.orders as Record<string, unknown>[];
      for (const id of ['cancelled', 'third'])
        orders.push({
          ...orders[0],
          id,
          source: { connector: 'files', ref: id, revision: '1' },
          title: 'independent ' + id,
          dependsOn: [],
          writeScope: ['lib/' + id],
        });
    },
  });
  const h = ctx.open();
  try {
    const key = started(ctx, h);
    const a = h.engine.claim('controller')!;
    assert.equal(a.workId, 'add-greeting');
    h.engine.fail(a.id, a.token, 'review failure first', { kind: 'review' });
    h.engine.retry(a.workId);
    const b = h.engine.claim('controller')!;
    h.engine.fail(b.id, b.token, 'review failure second', { kind: 'review' });
    const at = new Date(h.engine.clock()).toISOString();
    h.store.transact('task.retry', (tx) => {
      const w = tx.work(a.workId)!;
      tx.putWork({
        ...w,
        recovery: {
          id: 'RC-' + w.id,
          property: 'p1',
          basis: h.engine.episodeOf(w, tx),
          runs: [a.id, b.id],
          openedAt: at,
          status: 'awaiting-lead',
          calls: 0,
          history: [{ at, event: 'opened' }],
          version: 1,
        },
      });
    });
    operatorNewApproach(h, a.workId, at);
    h.engine.cancel('cancelled', 'operator cancelled task');
    const c = h.engine.claim('controller')!;
    assert.equal(c.workId, 'third');
    h.engine.fail(c.id, c.token, 'timeout third', { kind: 'timeout' });
    h.engine.release('controller');
    const thirdAttempt = h.engine.read((v) => v.work('third')!.attempt);

    const diags = diagnose(ctx, h);
    assert.deepEqual(
      diags.find((d) => d.workId === 'add-greeting'),
      { workId: 'add-greeting', retryPlanned: true, actor: 'controller', action: 'retry' },
    );
    const third = {
      workId: 'third',
      retryPlanned: false,
      actor: 'user',
      action: 'fix-environment',
    };
    assert.deepEqual(
      diags.find((d) => d.workId === 'third'),
      third,
    );
    assert.deepEqual(diagnoseOne(ctx, h, 'third'), [third], 'фильтр --work third');

    const result = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.deepEqual(
      result.works.map((w) => [w.id, w.status]),
      [
        ['add-greeting', 'done'],
        ['cancelled', 'cancelled'],
        ['third', 'failed'],
      ],
    );
    const job = h.workflows.get(key);
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /cancelled/);
    assert.equal(
      h.engine.read((v) => v.work('third')!.attempt),
      thirdAttempt,
    );
    assert.equal(ctx.calls('claude', 'writer'), 1);
  } finally {
    h.close();
  }
});

/** Диагноз по любому `Harness` (в том числе property fixture); `workId` — как `--work`. */
const diagnosisOf = (
  policy: { maxAttempts: number; repairBudget: number },
  h: H,
  workId?: string,
) =>
  stopInputsOf(h, {
    maxAttempts: policy.maxAttempts,
    repairBudget: policy.repairBudget,
    ...(workId === undefined ? {} : { workId }),
  })
    .filter((i) => i.kind === 'work')
    .map(explainStop)
    .map((d) => ({
      workId: d.workId,
      retryPlanned: d.retryPlanned,
      actor: d.actor,
      action: d.action,
    }));

/** Число вызовов fixture runtime по файлу-счётчику сценария. */
const countOf = (scenarioPath: string, runtime: string, role: string) => {
  const p = scenarioPath + '.' + runtime + '.' + role + '.count';
  return existsSync(p) ? Number(readFileSync(p, 'utf8')) : 0;
};

/** Ограничитель известной петли FI-002: девятая выдача задания прерывает прогон. */
const guardClaims = (h: H, limit = 8) => {
  let claims = 0;
  const claim = h.workflows.claim.bind(h.workflows);
  h.workflows.claim = (...args: Parameters<typeof claim>) => {
    if (++claims > limit) throw new Error('PROBE_LOOP_GUARD');
    return claim(...args);
  };
};

const runGuarded = async (h: H, run: () => Promise<unknown>) => {
  guardClaims(h);
  let error = '';
  try {
    await run();
  } catch (e) {
    error = (e as Error).message;
  }
  return error;
};

test('H1-03 (H1-F014): explain = движок — отменённая работа с эпизодом останавливает группу до обычного повтора', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      p.maxAttempts = 5;
      p.repairBudget = 6;
    },
    graph: (raw) => {
      const orders = raw.orders as Record<string, unknown>[];
      for (const id of ['cancelled', 'third'])
        orders.push({
          ...orders[0],
          id,
          source: { connector: 'files', ref: id, revision: '1' },
          title: 'independent ' + id,
          dependsOn: [],
          writeScope: ['lib/' + id],
        });
    },
  });
  const h = ctx.open();
  try {
    const key = started(ctx, h);
    const episode = (workId: string, runs: string[], at: string) =>
      h.store.transact('task.retry', (tx) => {
        const w = tx.work(workId)!;
        tx.putWork({
          ...w,
          recovery: {
            id: 'RC-' + w.id,
            property: 'p1',
            basis: h.engine.episodeOf(w, tx),
            runs,
            openedAt: at,
            status: 'awaiting-lead',
            calls: 0,
            history: [{ at, event: 'opened' }],
            version: 1,
          },
        });
      });
    const a = h.engine.claim('controller')!;
    assert.equal(a.workId, 'add-greeting');
    h.engine.fail(a.id, a.token, 'review failure first', { kind: 'review' });
    h.engine.retry(a.workId);
    const b = h.engine.claim('controller')!;
    h.engine.fail(b.id, b.token, 'review failure second', { kind: 'review' });
    const at = new Date(h.engine.clock()).toISOString();
    episode(a.workId, [a.id, b.id], at);
    operatorNewApproach(h, a.workId, at);
    const ca = h.engine.claim('controller')!;
    assert.equal(ca.workId, 'cancelled');
    h.engine.fail(ca.id, ca.token, 'review failure cancelled first', { kind: 'review' });
    h.engine.retry(ca.workId);
    const cb = h.engine.claim('controller')!;
    assert.equal(cb.workId, 'cancelled');
    h.engine.fail(cb.id, cb.token, 'review failure cancelled second', { kind: 'review' });
    episode('cancelled', [ca.id, cb.id], at);
    h.engine.cancel('cancelled', 'operator cancelled task');
    assert.equal(
      h.engine.read((v) => v.work('cancelled')!.recovery?.status),
      'awaiting-lead',
      'cancel сохраняет эпизод',
    );
    const c = h.engine.claim('controller')!;
    assert.equal(c.workId, 'third');
    h.engine.fail(c.id, c.token, 'timeout third', { kind: 'timeout' });
    h.engine.release('controller');
    const thirdAttempt = h.engine.read((v) => v.work('third')!.attempt);

    const diags = diagnose(ctx, h);
    assert.deepEqual(
      diags.find((d) => d.workId === 'add-greeting'),
      { workId: 'add-greeting', retryPlanned: true, actor: 'controller', action: 'retry' },
    );
    const third = {
      workId: 'third',
      retryPlanned: false,
      actor: 'user',
      action: 'fix-environment',
    };
    assert.deepEqual(
      diags.find((d) => d.workId === 'third'),
      third,
    );
    assert.deepEqual(diagnoseOne(ctx, h, 'third'), [third], 'фильтр --work third');

    const result = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.deepEqual(
      result.works.map((w) => [w.id, w.status]),
      [
        ['add-greeting', 'done'],
        ['cancelled', 'cancelled'],
        ['third', 'failed'],
      ],
    );
    const job = h.workflows.get(key);
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /cancelled/);
    assert.equal(
      h.engine.read((v) => v.work('third')!.attempt),
      thirdAttempt,
    );
    assert.equal(ctx.calls('claude', 'writer'), 1);
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F015): explain = движок — следующий эпизод awaiting-lead на паузе runtime не обещает продолжения', async () => {
  // Локальный lead fixture (как в пробе приёмки): разбор выбирает new-approach.
  const scenario = {
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
  const ctx = hsetup({
    scenario,
    policy: (p) => {
      p.maxAttempts = 3;
      p.repairBudget = 6;
    },
    graph: (raw) => {
      secondWork(raw);
      const orders = raw.orders as Record<string, unknown>[];
      const last = orders.at(-1)!;
      last.writeScope = ['lib/second'];
      orders.push({
        ...orders[0],
        id: 'network',
        source: { connector: 'files', ref: 'network', revision: '1' },
        title: 'Independent work network',
        dependsOn: [],
        writeScope: ['lib/network'],
      });
    },
  });
  const h = ctx.open();
  try {
    started(ctx, h);
    twoEpisodes(h);
    const n = h.engine.claim('controller')!;
    assert.equal(n.workId, 'network');
    h.engine.fail(n.id, n.token, 'getaddrinfo ENOTFOUND fixture', { kind: 'environment' });
    h.engine.release('controller');
    assert.equal(h.engine.read((v) => v.control()).pauseReason, 'runtime');

    const diags = diagnose(ctx, h);
    const second = {
      workId: 'second',
      retryPlanned: false,
      actor: 'user',
      action: 'fix-environment',
    };
    assert.deepEqual(
      diags.find((d) => d.workId === 'second'),
      second,
    );
    assert.deepEqual(diagnoseOne(ctx, h, 'second'), [second], 'фильтр --work second');

    // Разбор A действительно выполняется, но его повтор не выдаётся на паузе
    // runtime, и движок вращается (FI-002): ограничиваем прогон по claim.
    const error = await runGuarded(h, () => h.run({ graph: ctx.graph, author: 'claude' }));
    assert.equal(error, 'PROBE_LOOP_GUARD');
    const w = h.engine.read((v) => v.work('second')!);
    assert.deepEqual([w.recovery?.status, w.recovery?.calls], ['awaiting-lead', 0]);
    assert.equal(ctx.calls('claude', 'writer'), 0);
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F016): explain = движок — эпизод applying на исчерпанных попытках останавливает группу', async () => {
  const ctx = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    policy: (p) => {
      p.maxAttempts = 2;
      p.repairBudget = 6;
    },
  });
  ctx.graph.orders.push({
    ...ctx.graph.orders[0]!,
    id: 'second',
    source: { connector: 'files', ref: 'second', revision: '1' },
    title: 'Second independent work',
    dependsOn: [],
  });
  const h = propertyHarness(ctx);
  try {
    const graph = ready(h.engine, ctx.graph, 'controller');
    const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
    h.workflows.finish(h.workflows.claim(job.key)!);
    for (let i = 0; i < 2; i++) {
      const a = h.engine.claim('controller')!;
      assert.equal(a.workId, 'add-greeting');
      h.engine.phase(a.id, a.token, 'verifying', {
        candidateSha: ctx.repo.git('rev-parse', 'HEAD'),
      });
      h.engine.fail(a.id, a.token, 'property failure ' + i, {
        kind: 'review',
        properties: { bound: ['knapsack-optimal'], unbound: [] },
      });
      if (i === 0) h.engine.retry(a.workId);
    }
    const a = h.engine.read((v) => v.work('add-greeting')!);
    assert.deepEqual([a.recovery?.status, a.attempt], ['awaiting-lead', 2]);
    h.engine.recoveryDecide(a.id, a.recovery!.id, {
      action: 'add-cases',
      reason: 'Add a confirmed knapsack counterexample',
      evidence: [],
      cases: [
        {
          input: JSON.stringify({
            items: [
              { w: 1, v: 1 },
              { w: 1, v: 1 },
              { w: 1, v: 1 },
              { w: 1, v: 9 },
            ],
            cap: 4,
          }),
          expected: '12',
        },
      ],
      source: { kind: 'operator' },
      decidedAt: new Date(h.engine.clock()).toISOString(),
    });
    assert.equal(
      h.engine.read((v) => v.work(a.id)!.recovery?.status),
      'applying',
    );
    const b = h.engine.claim('controller')!;
    assert.equal(b.workId, 'second');
    h.engine.fail(b.id, b.token, 'timeout second', { kind: 'timeout' });
    h.engine.release('controller');

    const diags = diagnosisOf(ctx.policy, h);
    const second = {
      workId: 'second',
      retryPlanned: false,
      actor: 'user',
      action: 'fix-environment',
    };
    assert.deepEqual(diags, [
      { workId: 'add-greeting', retryPlanned: false, actor: 'user', action: 'reset-attempts' },
      second,
    ]);
    const code = stopInputsOf(h, {
      maxAttempts: ctx.policy.maxAttempts,
      repairBudget: ctx.policy.repairBudget,
    })
      .filter((i) => i.kind === 'work')
      .map(explainStop)[0]!.code;
    assert.equal(code, 'ATTEMPTS_EXHAUSTED');
    assert.deepEqual(diagnosisOf(ctx.policy, h, 'second'), [second], 'фильтр --work second');

    await h.run({ graph: ctx.graph, author: 'claude' });
    assert.equal(
      h.engine.read((v) => v.work('add-greeting')!.recovery?.status),
      'stopped',
    );
    const stopped = h.workflows.get(job.key);
    assert.equal(stopped.status, 'failed');
    assert.match(stopped.error ?? '', /add-greeting:.*попытки.*исчерпаны/);
    assert.equal(
      h.engine.read((v) => v.work('second')!.attempt),
      1,
    );
    assert.equal(countOf(ctx.scenarioPath, 'claude', 'writer'), 0);
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F017): explain = движок — готовая работа с эпизодом retrying без активного run ждёт решения человека', async () => {
  const ctx = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    policy: (p) => {
      p.maxAttempts = 5;
      p.repairBudget = 6;
    },
  });
  ctx.graph.orders.push({
    ...ctx.graph.orders[0]!,
    id: 'second',
    source: { connector: 'files', ref: 'second', revision: '1' },
    title: 'Second independent work',
    dependsOn: [],
  });
  const h = propertyHarness(ctx);
  try {
    const graph = ready(h.engine, ctx.graph, 'controller');
    const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
    h.workflows.finish(h.workflows.claim(job.key)!);
    for (let i = 0; i < 2; i++) {
      const a = h.engine.claim('controller')!;
      assert.equal(a.workId, 'add-greeting');
      h.engine.phase(a.id, a.token, 'verifying', {
        candidateSha: ctx.repo.git('rev-parse', 'HEAD'),
      });
      h.engine.fail(a.id, a.token, 'property failure ' + i, {
        kind: 'review',
        properties: { bound: ['knapsack-optimal'], unbound: [] },
      });
      if (i === 0) h.engine.retry(a.workId);
    }
    const a = h.engine.read((v) => v.work('add-greeting')!);
    assert.deepEqual([a.recovery?.status, a.attempt], ['awaiting-lead', 2]);
    h.engine.recoveryDecide(a.id, a.recovery!.id, {
      action: 'new-approach',
      reason: 'New implementation approach after the property failures',
      evidence: [],
      hypothesis: 'Use a different approach',
      plan: 'Verify the gate',
      source: { kind: 'operator' },
      decidedAt: new Date(h.engine.clock()).toISOString(),
    });
    h.engine.retry(a.id);
    const retry = h.engine.claim('controller')!;
    assert.equal(retry.workId, a.id);
    h.engine.fail(retry.id, retry.token, 'gate failed unrelated to property', { kind: 'gate' });
    h.engine.retry(a.id);
    const w = h.engine.read((v) => v.work(a.id)!);
    assert.deepEqual(
      [w.status, w.recovery?.status, w.activeRunId],
      ['ready', 'retrying', undefined],
    );
    const b = h.engine.claim('controller')!;
    assert.equal(b.workId, 'second');
    h.engine.fail(b.id, b.token, 'timeout second', { kind: 'timeout' });
    h.engine.release('controller');

    const second = {
      workId: 'second',
      retryPlanned: false,
      actor: 'user',
      action: 'fix-environment',
    };
    assert.deepEqual(diagnosisOf(ctx.policy, h), [
      { workId: 'add-greeting', retryPlanned: false, actor: 'user', action: 'user-decision' },
      second,
    ]);
    assert.deepEqual(diagnosisOf(ctx.policy, h, 'second'), [second], 'фильтр --work second');

    const error = await runGuarded(h, () => h.run({ graph: ctx.graph, author: 'claude' }));
    assert.equal(error, 'PROBE_LOOP_GUARD');
    assert.equal(
      h.engine.read((v) => v.work('second')!.attempt),
      1,
    );
    assert.equal(countOf(ctx.scenarioPath, 'claude', 'writer'), 0);
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F018): explain = движок — расход уже превышен до записи budgetBlock; следующая работа не обещает продолжения', async () => {
  const ctx = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    policy: (p) => {
      p.maxAttempts = 5;
      p.repairBudget = 6;
      p.concurrency = 2;
      p.budgets = { work: { usd: 3 }, onUnknown: 'continue' };
    },
  });
  ctx.graph.orders.push({
    ...structuredClone(ctx.graph.orders[0]!),
    id: 'later',
    source: { connector: 'files', ref: 'later', revision: '1' },
    title: 'Later independent work',
  });
  const h = propertyHarness(ctx);
  try {
    const graph = ready(h.engine, ctx.graph, 'controller');
    const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
    h.workflows.finish(h.workflows.claim(job.key)!);
    const a1 = h.engine.claim('controller')!;
    const b1 = h.engine.claim('controller')!;
    assert.equal(a1.workId, 'add-greeting');
    assert.equal(b1.workId, 'later');
    const failProperty = (a: typeof a1, n: number) => {
      h.engine.phase(a.id, a.token, 'reviewing', {
        candidateSha: ctx.repo.git('rev-parse', 'HEAD'),
      });
      h.engine.fail(a.id, a.token, 'natural property failure ' + n, {
        kind: 'review',
        properties: { bound: ['knapsack-optimal'], unbound: [] },
      });
    };
    failProperty(a1, 1);
    h.engine.fail(b1.id, b1.token, 'timeout of later work', { kind: 'timeout' });
    h.engine.retry('add-greeting');
    const a2 = h.engine.claim('controller')!;
    assert.equal(a2.workId, 'add-greeting');
    // Отвергающий candidate review превысил бюджет работы: расход записан
    // (детерминированный локальный адаптер, без провайдера), budgetBlock — ещё нет.
    h.engine.phase(a2.id, a2.token, 'reviewing', {
      candidateSha: ctx.repo.git('rev-parse', 'HEAD'),
    });
    await measuredInvoke(
      h.engine,
      {
        runtime: 'codex',
        capabilities: () =>
          Promise.resolve({
            runtime: 'codex',
            structuredOutput: true,
            sandbox: ['none'],
            cancellation: true,
            usage: true,
            fixture: true,
          }),
        invoke: () =>
          Promise.resolve({
            status: 'ok',
            model: 'fixture',
            runtimeVersion: 'fixture',
            text: '',
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reportedUsd: 5,
              complete: true,
              source: 'fixture',
            },
            diagnostics: { exitCode: 0 },
          }),
      },
      {
        callId: 'fixture-cost-a2',
        task: 'review-code',
        binding: { runtime: 'codex' },
        cwd: ctx.repo.dir,
        prompt: 'fixture',
        session: { kind: 'fresh' },
        sandbox: { mode: 'none', writable: [], denied: [], network: { domains: [] } },
        timeoutMs: 60000,
        env: {},
      },
      new AbortController().signal,
      { repositoryId: 'app', runId: a2.id, stage: 'candidate-review' },
    );
    failProperty(a2, 2);
    const a = h.engine.read((v) => v.work('add-greeting')!);
    assert.equal(a.recovery?.status, 'awaiting-lead', 'эпизод открыт естественно');
    h.engine.recoveryDecide('add-greeting', a.recovery.id, {
      action: 'new-approach',
      reason: 'Operator approves a new implementation approach',
      evidence: [],
      hypothesis: 'new approach',
      plan: 'verify properties',
      source: { kind: 'operator' },
      decidedAt: new Date().toISOString(),
    });
    h.engine.release('controller');
    assert.equal(
      h.engine.read((v) => v.work('add-greeting')!.budgetBlock),
      undefined,
      'у упавшей работы budgetBlock ещё не записан',
    );

    const later = {
      workId: 'later',
      retryPlanned: false,
      actor: 'user',
      action: 'fix-environment',
    };
    assert.deepEqual(
      diagnosisOf(ctx.policy, h).find((d) => d.workId === 'later'),
      later,
    );
    assert.deepEqual(diagnosisOf(ctx.policy, h, 'later'), [later], 'фильтр --work later');

    const error = await runGuarded(h, () => h.run({ graph: ctx.graph, author: 'claude' }));
    assert.equal(error, 'PROBE_LOOP_GUARD');
    assert.equal(
      h.engine.read((v) => v.work('later')!.attempt),
      1,
    );
    for (const runtime of ['claude', 'codex'])
      for (const role of ['writer', 'reviewer'])
        assert.equal(countOf(ctx.scenarioPath, runtime, role), 0, runtime + ':' + role);
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F021): explain = движок — эпизод ready/retry за отменённой предпосылкой останавливает следующий эпизод', async () => {
  const ctx = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    policy: (p) => {
      p.maxAttempts = 5;
      p.repairBudget = 6;
    },
  });
  const a = ctx.graph.orders[0]!;
  a.dependsOn = ['parent'];
  for (const id of ['parent', 'later'])
    ctx.graph.orders.push({
      ...structuredClone(a),
      id,
      source: { connector: 'files', ref: id, revision: '1' },
      title: id,
      dependsOn: [],
    });
  const h = propertyHarness(ctx);
  try {
    ready(h.engine, ctx.graph, 'controller');
    h.engine.hold(['add-greeting', 'later'], 'setup', 'isolate prerequisite');
    h.engine.release('controller');
    await h.run({ graph: ctx.graph, author: 'claude', once: true });
    assert.equal(
      h.engine.read((v) => v.work('parent')!.status),
      'done',
    );
    assert.ok(h.engine.lead('controller'));
    h.engine.releaseHold('setup');
    h.engine.hold(['later'], 'setup', 'natural episode of add-greeting');
    const episode = (workId: string) => {
      for (let i = 0; i < 2; i++) {
        const run = h.engine.claim('controller')!;
        assert.equal(run.workId, workId);
        h.engine.phase(run.id, run.token, 'reviewing', {
          candidateSha: ctx.repo.git('rev-parse', 'HEAD'),
        });
        h.engine.fail(run.id, run.token, `property review failure ${i}`, {
          kind: 'review',
          properties: { bound: ['knapsack-optimal'], unbound: [] },
        });
        if (i === 0) h.engine.retry(workId);
      }
      const w = h.engine.read((v) => v.work(workId)!);
      assert.equal(w.recovery?.status, 'awaiting-lead');
      h.engine.recoveryDecide(workId, w.recovery.id, {
        action: 'new-approach',
        reason: 'new approach',
        evidence: [],
        hypothesis: 'new approach',
        plan: 'check property',
        source: { kind: 'operator' },
        decidedAt: new Date(h.engine.clock()).toISOString(),
      });
    };
    episode('add-greeting');
    h.engine.releaseHold('setup');
    // Новая редакция меняет только предпосылку: эпизод A сохраняется, A — ready/retry.
    ctx.graph.source.revision = '2';
    const parent = ctx.graph.orders.find((w) => w.id === 'parent')!;
    parent.title = 'Parent revised requirement';
    parent.source.revision = '2';
    const graph = ready(h.engine, ctx.graph, 'controller');
    assert.equal(
      h.engine.read((v) => v.work('add-greeting')!.recovery?.status),
      'retry',
    );
    const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
    h.workflows.finish(h.workflows.claim(job.key)!);
    h.engine.cancel('parent', 'revised prerequisite cancelled');
    episode('later');
    h.engine.release('controller');
    assert.equal(
      h.engine.read((v) => v.work('later')!.recovery?.status),
      'retry',
    );

    const diags = diagnosisOf(ctx.policy, h);
    const later = diags.find((d) => d.workId === 'later')!;
    assert.equal(later.retryPlanned, false, JSON.stringify(later));
    assert.notEqual(later.actor, 'controller', JSON.stringify(later));
    assert.deepEqual(diagnosisOf(ctx.policy, h, 'later'), [later], 'фильтр --work later');
    console.log('F021 later', JSON.stringify(later));

    const writer = countOf(ctx.scenarioPath, 'claude', 'writer');
    const retries: string[] = [];
    const retry = h.engine.retry.bind(h.engine);
    h.engine.retry = (...args: Parameters<typeof retry>) => {
      retries.push(args[0]);
      return retry(...args);
    };
    await runGuarded(h, () => h.run({ graph: ctx.graph, author: 'claude' }));
    assert.equal(retries.includes('later'), false, 'движок повтор later не выдаёт');
    assert.equal(countOf(ctx.scenarioPath, 'claude', 'writer'), writer);
    assert.equal(
      h.engine.read((v) => v.work('later')!.attempt),
      2,
    );
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F020): explain = движок — записанный budgetBlock после повышения бюджета — лишь кэш; диагноз берёт текущий расчёт', async () => {
  for (const change of ['raised', 'disabled'] as const) {
    const ctx = hsetup({
      scenario: { writer: implement(), reviewer: approve() },
      policy: (p) => {
        p.maxAttempts = 5;
        p.budgets = { work: { usd: 3 }, onUnknown: 'continue' };
      },
    });
    let h = ctx.open();
    try {
      const graph = ready(h.engine, ctx.graph, 'controller');
      const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
      h.workflows.finish(h.workflows.claim(job.key)!);
      const a = h.engine.claim('controller')!;
      await measuredInvoke(
        h.engine,
        {
          runtime: 'codex',
          capabilities: () =>
            Promise.resolve({
              runtime: 'codex',
              structuredOutput: true,
              sandbox: ['none'],
              cancellation: true,
              usage: true,
              fixture: true,
            }),
          invoke: () =>
            Promise.resolve({
              status: 'ok',
              model: 'fixture',
              runtimeVersion: 'fixture',
              text: '',
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reportedUsd: 5,
                complete: true,
                source: 'fixture',
              },
              diagnostics: { exitCode: 0 },
            }),
        },
        {
          callId: 'fixture-cost',
          task: 'review-code',
          binding: { runtime: 'codex' },
          cwd: ctx.repo.dir,
          prompt: 'fixture',
          session: { kind: 'fresh' },
          sandbox: { mode: 'none', writable: [], denied: [], network: { domains: [] } },
          timeoutMs: 60000,
          env: {},
        },
        new AbortController().signal,
        { repositoryId: 'app', runId: a.id, stage: 'candidate-review' },
      );
      h.engine.fail(a.id, a.token, 'timeout', { kind: 'timeout' });
      h.engine.retry(a.workId);
      assert.equal(h.engine.claim('controller'), undefined);
      assert.ok(
        h.engine.read((v) => v.work(a.workId)!.budgetBlock),
        'кэш записан claim',
      );
      h.engine.release('controller');
      assert.equal(diagnosisOf(ctx.policy, h)[0]!.action, 'raise-budget', 'до смены политики');
    } finally {
      h.close();
    }
    const raw = structuredClone(ctx.policy);
    if (change === 'disabled') delete raw.budgets;
    else raw.budgets!.work = { usd: 100 };
    const policy = executionPolicySchema.parse(raw);
    h = ctx.open(policy);
    try {
      assert.ok(
        h.engine.read((v) => v.work('add-greeting')!.budgetBlock),
        'кэш ещё записан',
      );
      const diag = diagnosisOf(policy, h)[0]!;
      assert.notEqual(diag.action, 'raise-budget', change + ': ' + JSON.stringify(diag));
      assert.equal(diag.actor, 'controller', change + ': ' + JSON.stringify(diag));
      await h.run({ graph: ctx.graph, author: 'claude' });
      assert.equal(
        h.engine.read((v) => v.work('add-greeting')!.status),
        'done',
        change,
      );
    } finally {
      h.close();
    }
  }
});

/** Детерминированный локальный вызов с сообщённым расходом $5 (без провайдера). */
const spend5 = (h: H, ctx: Ctx, runId: string) =>
  measuredInvoke(
    h.engine,
    {
      runtime: 'codex',
      capabilities: () =>
        Promise.resolve({
          runtime: 'codex',
          structuredOutput: true,
          sandbox: ['none'],
          cancellation: true,
          usage: true,
          fixture: true,
        }),
      invoke: () =>
        Promise.resolve({
          status: 'ok',
          model: 'fixture',
          runtimeVersion: 'fixture',
          text: '',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reportedUsd: 5,
            complete: true,
            source: 'fixture',
          },
          diagnostics: { exitCode: 0 },
        }),
    },
    {
      callId: 'fixture-cost-' + runId,
      task: 'review-code',
      binding: { runtime: 'codex' },
      cwd: ctx.repo.dir,
      prompt: 'fixture',
      session: { kind: 'fresh' },
      sandbox: { mode: 'none', writable: [], denied: [], network: { domains: [] } },
      timeoutMs: 60000,
      env: {},
    },
    new AbortController().signal,
    { repositoryId: 'app', runId, stage: 'candidate-review' },
  );

test('H1-03 (H1-F020): explain = движок — сломанная без эпизода под превышенным бюджетом: сначала повтор движка, затем raise-budget', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      p.maxAttempts = 5;
      p.budgets = { work: { usd: 3 }, onUnknown: 'continue' };
    },
  });
  const h = ctx.open();
  try {
    const graph = ready(h.engine, ctx.graph, 'controller');
    const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
    h.workflows.finish(h.workflows.claim(job.key)!);
    const a = h.engine.claim('controller')!;
    await spend5(h, ctx, a.id);
    h.engine.fail(a.id, a.token, 'timeout', { kind: 'timeout' });
    h.engine.release('controller');
    const held = {
      workId: 'add-greeting',
      retryPlanned: false,
      actor: 'user',
      action: 'raise-budget',
    };
    // Следующий шаг — автоматический повтор repair; выдачу затем держит бюджет.
    assert.deepEqual(diagnosisOf(ctx.policy, h), [
      { workId: 'add-greeting', retryPlanned: true, actor: 'controller', action: 'retry' },
    ]);
    const writer = ctx.calls('claude', 'writer');
    await h.run({ graph: ctx.graph, author: 'claude' });
    const w = h.engine.read((v) => v.work('add-greeting')!);
    assert.equal(w.status, 'ready');
    assert.ok(w.budgetBlock, 'claim не выдал повтор: бюджет');
    assert.equal(ctx.calls('claude', 'writer'), writer);
    assert.deepEqual(diagnosisOf(ctx.policy, h), [held], 'после run — тот же шаг человека');
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F020): status().blockers берёт текущий бюджетный расчёт, а не записанный budgetBlock', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      p.maxAttempts = 5;
      p.budgets = { work: { usd: 3 }, onUnknown: 'continue' };
    },
  });
  let h = ctx.open();
  const codes = () => h.status().works[0]!.blockers.map((b) => b.code);
  try {
    ready(h.engine, ctx.graph, 'controller');
    const a = h.engine.claim('controller')!;
    await spend5(h, ctx, a.id);
    h.engine.fail(a.id, a.token, 'timeout', { kind: 'timeout' });
    h.engine.retry(a.workId);
    assert.equal(
      h.engine.read((v) => v.work(a.workId)!.budgetBlock),
      undefined,
    );
    assert.ok(codes().includes('BUDGET_EXHAUSTED'), 'расход превышен до записи поля');
    assert.equal(h.engine.claim('controller'), undefined);
    h.engine.release('controller');
  } finally {
    h.close();
  }
  const raw = structuredClone(ctx.policy);
  raw.budgets!.work = { usd: 100 };
  h = ctx.open(executionPolicySchema.parse(raw));
  try {
    assert.ok(
      h.engine.read((v) => v.work('add-greeting')!.budgetBlock),
      'кэш ещё записан',
    );
    assert.equal(codes().includes('BUDGET_EXHAUSTED'), false, 'после повышения бюджета');
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F021): внешняя предпосылка с id отменённой работы другого графа не держит повтор эпизода', async () => {
  const ctx = hsetup({
    scenario: {
      writer: [implement(), implement({ 'lib/farewell.js': 'exports.bye = () => "Bye";\n' })],
      reviewer: approve(),
    },
    policy: (p) => {
      p.maxAttempts = 5;
      p.repairBudget = 5;
    },
  });
  const h = ctx.open();
  try {
    ready(h.engine, ctx.graph, 'controller');
    h.engine.release('controller');
    await h.run({ graph: ctx.graph, author: 'claude' });
    const run = h.engine.read((v) =>
      v.attempts('add-greeting').find((a) => a.status === 'succeeded')!,
    );
    // Новая редакция первого графа отменяет add-greeting; второй граф опирается
    // на принятый результат как на внешнюю предпосылку с тем же id.
    const revised = structuredClone(ctx.graph);
    revised.source.revision = '2';
    revised.orders[0]!.title = 'Revised greeting';
    revised.orders[0]!.source.revision = '2';
    ready(h.engine, workGraphSchema.parse(revised), 'controller');
    h.engine.cancel('add-greeting', 'revision dropped');
    const g2raw = structuredClone(ctx.graph);
    g2raw.id = 'g2';
    g2raw.source = { ...g2raw.source, ref: 'g2', revision: '1' };
    g2raw.orders = [
      {
        ...g2raw.orders[0]!,
        id: 'w2',
        source: { connector: 'files', ref: 'w2', revision: '1' },
        title: 'farewell',
        writeScope: ['lib'],
        dependsOn: ['add-greeting'],
      },
    ];
    g2raw.prerequisites = [
      {
        id: 'add-greeting',
        repositoryId: 'app',
        resultSha: run.integrationSha!,
        receipt: { kind: 'engine', runId: run.id },
      },
    ];
    const g2 = workGraphSchema.parse(g2raw);
    const gs = ready(h.engine, g2, 'controller');
    const job = h.workflows.start({ kind: 'graph', id: gs.id, authorRuntime: 'claude' });
    h.workflows.finish(h.workflows.claim(job.key)!);
    const a = h.engine.claim('controller')!;
    assert.equal(a.workId, 'w2', 'claim считает внешнюю предпосылку выполненной');
    h.engine.fail(a.id, a.token, 'review fail', { kind: 'review' });
    // Эпизод в состоянии retry (форма после решения ведущего), записан напрямую.
    const at = new Date(h.engine.clock()).toISOString();
    h.store.transact('task.retry', (tx) => {
      const w = tx.work('w2')!;
      tx.putWork({
        ...w,
        recovery: {
          id: 'RC-probe',
          property: 'p1',
          basis: 'a'.repeat(64),
          runs: [a.id],
          openedAt: at,
          status: 'retry',
          calls: 1,
          history: [{ at, event: 'opened' }],
          version: 1,
        },
      });
    });
    h.engine.release('controller');
    assert.deepEqual(diagnosisOf(ctx.policy, h, 'w2'), [
      { workId: 'w2', retryPlanned: true, actor: 'controller', action: 'retry' },
    ]);
    await h.run({ graph: g2, author: 'claude' });
    assert.equal(
      h.engine.read((v) => v.work('w2')!.status),
      'done',
    );
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F022): explain = движок — первый эпизод ready/retry на исчерпанных попытках останавливает прогноз группы', async () => {
  const ctx = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    policy: (p) => {
      p.maxAttempts = 5;
      p.repairBudget = 6;
    },
  });
  ctx.graph.orders.push({
    ...structuredClone(ctx.graph.orders[0]!),
    id: 'later',
    source: { connector: 'files', ref: 'later', revision: '1' },
    title: 'later',
    dependsOn: [],
  });
  let h = propertyHarness(ctx);
  try {
    const graph = ready(h.engine, ctx.graph, 'controller');
    const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
    h.workflows.finish(h.workflows.claim(job.key)!);
    h.engine.hold(['later'], 'setup', 'isolate first natural episode');
    const episode = (workId: string) => {
      for (let i = 0; i < 2; i++) {
        const run = h.engine.claim('controller')!;
        assert.equal(run.workId, workId);
        h.engine.phase(run.id, run.token, 'reviewing', {
          candidateSha: ctx.repo.git('rev-parse', 'HEAD'),
        });
        h.engine.fail(run.id, run.token, 'property review failure ' + i, {
          kind: 'review',
          properties: { bound: ['knapsack-optimal'], unbound: [] },
        });
        if (i === 0) h.engine.retry(workId);
      }
      const w = h.engine.read((v) => v.work(workId)!);
      assert.equal(w.recovery?.status, 'awaiting-lead');
      h.engine.recoveryDecide(workId, w.recovery.id, {
        action: 'new-approach',
        reason: 'new approach',
        evidence: [],
        hypothesis: 'new approach',
        plan: 'check property',
        source: { kind: 'operator' },
        decidedAt: new Date(h.engine.clock()).toISOString(),
      });
    };
    episode('add-greeting');
    h.engine.retry('add-greeting');
    const third = h.engine.claim('controller')!;
    // Нейтральный отказ возвращает эпизод в retry; повтор — готовая, attempt 3.
    h.engine.fail(third.id, third.token, 'timeout in third attempt', { kind: 'timeout' });
    h.engine.retry('add-greeting');
    h.engine.releaseHold('setup');
    h.engine.hold(['add-greeting'], 'setup-later', 'isolate later natural episode');
    episode('later');
    h.engine.releaseHold('setup-later');
    h.engine.release('controller');
    h.close();
    // Тот же state под законной политикой maxAttempts=3: у A попытки исчерпаны.
    const policy = executionPolicySchema.parse({ ...ctx.policy, maxAttempts: 3 });
    h = Harness.open({
      stateDir: ctx.state,
      policy,
      baseDir: ctx.repo.dir,
      adapters: {
        claude: cliAdapter('claude', { executable: bin('fake-claude') }),
        codex: cliAdapter('codex', { executable: bin('fake-codex') }),
      },
    });
    ready(h.engine, ctx.graph, 'controller');
    const current = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
    h.workflows.finish(h.workflows.claim(current.key)!);
    h.engine.release('controller');
    assert.deepEqual(
      h.engine.read((v) =>
        [v.work('add-greeting')!, v.work('later')!].map((w) => [
          w.status,
          w.attempt,
          w.recovery?.status,
        ]),
      ),
      [
        ['ready', 3, 'retry'],
        ['failed', 2, 'retry'],
      ],
    );

    const diags = diagnosisOf(policy, h);
    assert.deepEqual(
      diags.find((d) => d.workId === 'add-greeting'),
      {
        workId: 'add-greeting',
        retryPlanned: false,
        actor: 'user',
        action: 'reset-attempts',
      },
    );
    const later = diags.find((d) => d.workId === 'later')!;
    assert.equal(later.retryPlanned, false, JSON.stringify(later));
    assert.notEqual(later.actor, 'controller', JSON.stringify(later));
    assert.deepEqual(diagnosisOf(policy, h, 'later'), [later], 'фильтр --work later');

    const retries: string[] = [];
    const retry = h.engine.retry.bind(h.engine);
    h.engine.retry = (...args: Parameters<typeof retry>) => {
      retries.push(args[0]);
      return retry(...args);
    };
    const writer = countOf(ctx.scenarioPath, 'claude', 'writer');
    await runGuarded(h, () => h.run({ graph: ctx.graph, author: 'claude' }));
    assert.deepEqual(retries, [], 'движок повтор later не выдаёт');
    assert.equal(countOf(ctx.scenarioPath, 'claude', 'writer'), writer);
    assert.equal(
      h.engine.read((v) => v.work('later')!.attempt),
      2,
    );
  } finally {
    h.close();
  }
});
