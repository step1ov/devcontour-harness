/**
 * 0.1.0-alpha.66, ревизия 6 представления оператора (сценарий отменённых доработок):
 * - P4-7: отмена открытой доработки принятой работы — возврат к принятой
 *   редакции, а не «задача отменена»; прогноз считает попытки всех работ
 *   выпуска, в том числе отменённых;
 * - P4-5: планируемая работа (несогласованные снимки, задачи вне снимков,
 *   зарегистрированные несогласованные работы), две цифры прогноза и
 *   критический путь нижней границы;
 * - P4-10: журнал ведущего, сессия с арендой, итоговый отчёт выпуска, доля
 *   ведущего в готовности и во времени.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_OWNER,
  cliCommands,
  cliDataSchemas,
  digestOf,
  operatorViewSchema,
  type WorkGraph,
} from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { collectOperatorViewInput, connectorSources } from '../src/control/operator-view.ts';
import { statusOf } from '../src/control/status.ts';
import { cleanLeadText, leadBegin, leadNote, releaseDone } from '../src/control/lead.ts';
import { harnessCapabilities } from '../src/catalog/harness.ts';
import { operatorView } from '../src/projections/index.ts';
import { at, attempt, baseInput, work } from './operator-view-input.ts';
import {
  engineOf,
  graphOf,
  planReview,
  policyOf,
  ready,
  sha,
  trustNone,
} from './engine-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (...args: string[]) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', cli, ...args],
    { encoding: 'utf8' },
  );
  return {
    status: r.status,
    stderr: r.stderr,
    json: JSON.parse(r.stdout) as { ok: boolean; data?: never; error?: { code: string } },
  };
};

/** Провести попытку через обе фазы с PASS gate и ревью и принять её. */
function accept(e: Engine, id: string, token: string, candidate: string, integration: string) {
  e.phase(id, token, 'verifying', { candidateSha: candidate });
  for (const [phase, at] of [
    ['candidate', candidate],
    ['integration', integration],
  ] as const) {
    if (phase === 'integration') e.phase(id, token, 'integrating', { integrationSha: integration });
    for (const kind of ['test', 'review'] as const)
      e.evidence(id, token, {
        kind,
        phase,
        sha: at,
        gate: kind === 'test' ? 'unit' : 'independent-review',
        passed: true,
        command: ['x'],
        exitCode: 0,
        log: '',
        digest: digestOf(kind + phase),
        summary: 'ok',
        ...(kind === 'review' ? { findings: [] } : {}),
      });
  }
  e.finish(id, token, integration);
}

/** Новая редакция графа: регистрация, раунд ревью плана и согласование. */
function replan(e: Engine, graph: WorkGraph) {
  const { graph: state } = e.register(graph, trustNone);
  e.recordReview(planReview(e, state, e.reviews('plan', state.id).length + 1));
  e.approve(state.id, 'agent');
  return state;
}

/** Редакция `revision` графа `deps`, у поручений `changed` — новая цель. */
function revised(deps: Record<string, string[]>, revision: string, changed: string[], id = 'g') {
  const g = graphOf(deps, revision, id);
  g.orders = g.orders.map((o) =>
    changed.includes(o.id) ? { ...o, goal: `${o.goal} Доработка ${revision}.` } : o,
  );
  return g;
}

/** Представление над состоянием `engineOf`. */
function viewOf(env: ReturnType<typeof engineOf>, lang: 'ru' | 'en' = 'ru') {
  const { engine, dir } = env;
  const source = {
    engine,
    policy: engine.policy,
    workflows: { list: () => [], continues: () => false } as never,
    stateDir: dir,
    baseDir: dir,
  };
  return operatorViewSchema.parse(
    operatorView(
      collectOperatorViewInput(
        source,
        { raw: engine.policy, warnings: [], baseDir: dir },
        { now: engine.clock(), lang },
      ),
      { lang },
    ),
  );
}

/** Принять все работы графа по очереди (зависимости — цепочкой). */
function acceptAll(env: ReturnType<typeof engineOf>, n: number, letter: string) {
  for (let k = 0; k < n; k++) {
    env.clock.now += 30_000;
    env.engine.lead('c1');
    const run = env.engine.claim('c1')!;
    assert.ok(run, `claim ${k}`);
    env.clock.now += 20_000;
    accept(env.engine, run.id, run.token, sha(letter), sha(String.fromCharCode(97 + k)));
  }
}

const chain = { w1: [], w2: ['w1'], w3: ['w2'], w4: ['w3'] };

/**
 * Сценарий: четыре принятые работы, ведущий перепланировал их ради доставки
 * (четыре доработки), затем отменил доработки прежней версией harness
 * (работы `cancelled`), а пятая задача (PRODUCT-1) — отдельным графом —
 * принята. Отменённые доработки записаны так, как их записывала alpha.65.
 */
function abandonedReworks() {
  const env = engineOf();
  ready(env.engine, graphOf(chain));
  acceptAll(env, 4, 'f');
  replan(env.engine, revised(chain, '2', ['w1', 'w2', 'w3', 'w4']));
  // Отмена доработок alpha.65: `cancelled`, результат принятой редакции потерян.
  env.store.transact('task.cancelled', (tx) => {
    for (const id of ['w1', 'w2', 'w3', 'w4']) {
      const w = tx.work(id)!;
      assert.ok(w.rework, id);
      const rework = { ...w.rework };
      delete rework.acceptedOrder;
      tx.putWork({ ...w, status: 'cancelled', failureKind: 'cancelled', rework });
    }
  });
  ready(env.engine, graphOf({ p: [] }, '1', 'g2'));
  acceptAll(env, 1, 'e');
  return env;
}

test('P4-7: сценарий отменённых доработок — отменённые прежней версией доработки остаются принятыми: 5 из 5, не «0 из 1»', () => {
  const env = abandonedReworks();
  const f = viewOf(env).forecast!;
  assert.equal(f.progress.total, 5);
  assert.equal(f.progress.done, 5);
  assert.equal(f.progress.left, 0);
  assert.doesNotMatch(f.progress.line, /0 из 1/);
  assert.equal(f.progress.release?.state, 'code-accepted');
  assert.match(f.progress.line, /код принят, ведущий ещё работает/);
  assert.ok(f.progress.percent < 100 && f.progress.percent >= 90, String(f.progress.percent));
  assert.equal(f.time.estimate, 'nothing');
  assert.doesNotMatch(f.time.line, /ни одна попытка не закончилась/);
});

test('P4-7: сценарий отменённых доработок — все 5 работ в представлении приняты; отменённые доработки помечены, состояние не переписано', () => {
  const env = abandonedReworks();
  const view = viewOf(env);
  assert.deepEqual(
    view.works.map((w) => [w.id, w.status, w.stage.name]),
    [
      ['w1', 'done', 'done'],
      ['w2', 'done', 'done'],
      ['w3', 'done', 'done'],
      ['w4', 'done', 'done'],
      ['p', 'done', 'done'],
    ],
  );
  for (const w of view.works.slice(0, 4)) {
    assert.equal(w.restoredFrom, 'cancelled-rework', w.id);
    const accepted = env.engine.read((v) => v.work(w.id)!.rework!.accepted.resultSha);
    assert.equal(w.resultSha, accepted);
    assert.equal(w.restoredLine, `принято на ${accepted.slice(0, 7)}; доработка отменена`);
  }
  assert.equal(view.works[4]!.restoredFrom, undefined);
  assert.equal(view.progress.done, 5);
  assert.equal(
    viewOf(env, 'en').works[0]!.restoredLine,
    `accepted at ${view.works[0]!.resultSha!.slice(0, 7)}; rework cancelled`,
  );
  // Состояние не переписано: работы по-прежнему `cancelled`, пока их не починит cancel.
  assert.equal(
    env.engine.read((v) => v.work('w1')!.status),
    'cancelled',
  );
  env.engine.cancel('w1');
  const repaired = viewOf(env).works[0]!;
  assert.deepEqual([repaired.status, repaired.restoredFrom], ['done', undefined]);
});

test('P4-7: cancel отменённой прежней версией доработки — возврат к принятой редакции', () => {
  const env = abandonedReworks();
  const before = env.engine.read((v) => v.work('w1')!);
  const r = env.engine.cancel('w1', 'вернуть принятое', 'operator');
  assert.equal(r.abandoned, true);
  assert.equal(r.changed, true);
  const w = env.engine.read((v) => v.work('w1')!);
  assert.equal(w.status, 'done');
  assert.equal(w.resultSha, before.rework!.accepted.resultSha);
  assert.equal(w.attempt, before.rework!.spent);
  assert.deepEqual(w.rework!.abandoned && { ...w.rework!.abandoned, at: 'x' }, {
    at: 'x',
    by: 'operator',
    orderDigest: w.rework!.abandoned!.orderDigest,
    // Постановки принятой редакции у прежней доработки нет — остаётся текущая.
    restored: false,
    // Попытки оставленной доработки — для её продолжения той же постановкой.
    attempt: before.attempt,
  });
  const events = env.store.events(0, 1000).filter((e) => e.type === 'work.rework-abandoned');
  assert.deepEqual(
    events.map((e) => [e.workId, e.payload]),
    [
      [
        'w1',
        {
          by: 'operator',
          revision: 1,
          acceptedSha: before.rework!.accepted.resultSha,
          restored: false,
          hadAttempt: false,
        },
      ],
    ],
  );
  // Та же неутверждённая постановка в новой редакции снова открывает доработку.
  const g = revised(chain, '2', ['w1', 'w2', 'w3', 'w4']);
  g.source = { ...g.source, revision: '3' };
  g.orders = g.orders.map((o) => ({ ...o, source: { ...o.source, revision: '3' } }));
  env.engine.register(g, trustNone);
  const again = env.engine.read((v) => v.work('w1')!);
  assert.notEqual(again.status, 'done');
  assert.equal(again.rework?.revision, 2);
  assert.equal(again.rework?.abandoned, undefined);
});

test('P4-7: cancel открытой доработки — done, прежняя приёмка, принятая постановка и идущая попытка отменена', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  acceptAll(env, 1, 'a');
  const accepted = env.engine.read((v) => v.work('w')!);
  replan(env.engine, revised({ w: [] }, '2', ['w']));
  env.engine.lead('c1');
  const run = env.engine.claim('c1')!;
  assert.equal(run.workId, 'w');
  const r = env.engine.cancel('w', 'доработка не нужна', 'operator');
  assert.equal(r.abandoned, true);
  const w = env.engine.read((v) => v.work('w')!);
  assert.equal(w.status, 'done');
  assert.equal(w.resultSha, accepted.resultSha);
  assert.deepEqual(w.order, accepted.order, 'принятая постановка вернулась');
  assert.equal(w.rework?.abandoned?.restored, true);
  assert.equal(w.activeRunId, undefined);
  assert.equal(
    env.engine.read((v) => v.attempt(run.id)!.status),
    'cancelled',
  );
  // Повтор — «принятый результат не отменяется».
  assert.throws(() => env.engine.cancel('w'), /Принятый результат не отменяется/);
  // status: снова принятая редакция, без «доработки».
  const policy = env.engine.policy;
  const sw = statusOf({ engine: env.engine, policy }).works[0]!;
  assert.equal(sw.status, 'done');
  assert.equal(sw.attemptSummary.rework, undefined);
  assert.doesNotMatch(sw.attemptSummary.line, /доработка/);
  // Принятая постановка в новой редакции — без доработки; изменённая — новая доработка.
  const same = graphOf({ w: [] }, '3');
  env.engine.register(same, trustNone);
  assert.equal(
    env.engine.read((v) => v.work('w')!.status),
    'done',
  );
  // Лента: доработка оставлена.
  const view = viewOf(env);
  const item = view.activity!.find((a) => a.action === 'work.rework-abandoned');
  assert.ok(item);
  assert.match(item.plain, /доработка 1 работы w оставлена: работа вернулась к принятой/);
  assert.equal(view.forecast!.progress.done, 1);
});

test('P4-7: новая редакция графа без поручения с открытой доработкой — возврат к принятому, не отмена', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [], x: [] }));
  acceptAll(env, 2, 'a');
  replan(env.engine, revised({ w: [], x: [] }, '2', ['w']));
  env.engine.register(graphOf({ x: [] }, '3'), trustNone);
  const w = env.engine.read((v) => v.work('w')!);
  assert.equal(w.status, 'done');
  assert.equal(w.rework?.abandoned?.by, 'graph');
  assert.ok(!env.store.events(0, 1000).some((e) => e.type === 'work.cancelled'));
});

test('P4-7: CLI cancel открытой доработки отвечает abandoned: true и пишет журнал ведущего', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  acceptAll(env, 1, 'a');
  replan(env.engine, revised({ w: [] }, '2', ['w']));
  writeFileSync(
    join(env.dir, 'binding.json'),
    JSON.stringify({ policy: env.engine.policy, baseDir: env.dir }),
  );
  env.store.close();
  // Команда без явного актёра — ведущего, пока его сессия активна (ревью L4).
  assert.equal(harness('lead', 'begin', '--state', env.dir, '--ttl', '30m').status, 0);
  const r = harness('cancel', '--state', env.dir, '--work', 'w');
  assert.equal(r.status, 0, r.stderr);
  const data = cliDataSchemas.cancel.parse(r.json.data);
  assert.deepEqual([data.status, data.abandoned], ['done', true]);
  const log = harness('view', '--state', env.dir);
  assert.equal(log.status, 0, log.stderr);
  const view = operatorViewSchema.parse(
    (log.json.data as unknown as { view?: unknown }).view ?? log.json.data,
  );
  assert.ok(
    view.activity!.some(
      (a) =>
        a.actor === 'lead' && a.action === 'lead.cancel' && /оставил доработку w/.test(a.plain),
    ),
    JSON.stringify(view.activity),
  );
});

test('P4-7: длительность попытки — по попыткам всех работ выпуска, в том числе отменённых', () => {
  // Сценарий до приёмки PRODUCT-1: четыре отменённые работы с 8 закончившимися попытками.
  const minutes: [string, number, number, string][] = [
    ['w1', 1, 9, 'failed'],
    ['w1', 2, 4, 'failed'],
    ['w1', 3, 6, 'succeeded'],
    ['w2', 1, 8, 'succeeded'],
    ['w3', 1, 2, 'failed'],
    ['w3', 2, 13, 'succeeded'],
    ['w4', 1, 18, 'succeeded'],
    ['w1', 4, 4, 'failed'],
  ];
  const cancelled = (id: string) =>
    work(id, { status: 'cancelled', stage: { ...work(id).stage, name: 'cancelled', next: [] } });
  const input = baseInput({
    works: [cancelled('w1'), cancelled('w2'), cancelled('w3'), cancelled('w4'), work('p')],
    attempts: minutes.map(([id, n, m, status], k) =>
      attempt(id, n, {
        runId: `${id}-${n}-${k}`,
        startedAt: at(200 - k * 20),
        finishedAt: at(200 - k * 20 - m),
        status,
      }),
    ),
  });
  const f = operatorView(input).forecast!;
  assert.equal(f.progress.total, 1, 'отменённые работы вне объёма');
  assert.equal(f.time.estimate, 'precise');
  assert.equal(f.time.remaining?.samples, 8);
  assert.doesNotMatch(f.time.line, /ни одна попытка не закончилась/);
});

/** База коннектора: снимки по графам (выборкам), наблюдение, доставки. */
function connectorDb(
  state: string,
  snapshots: {
    graph: string;
    at: string;
    tasks: { id: string; key: string; orderId: string }[];
    deps?: Record<string, string[]>;
  }[],
  observation: { at: string; tasks: { id: string; key: string; orderId: string }[] },
  delivered: { task: string; work: string }[] = [],
) {
  mkdirSync(join(state, 'connectors'), { recursive: true });
  const db = new DatabaseSync(join(state, 'connectors', 'relay-v1-http-0123456789abcdef.sqlite'));
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE snapshots (revision TEXT PRIMARY KEY, graph_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE operations (key TEXT PRIMARY KEY, work_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE observations (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  for (const [k, v] of <[string, string][]>[
    ['schema', '1'],
    ['provider', 'relay-v1-http'],
    ['projectId', 'P1'],
  ])
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(k, v);
  snapshots.forEach((s, n) =>
    db.prepare('INSERT INTO snapshots VALUES (?, ?, ?, ?)').run(
      `rev-${n}`,
      s.graph,
      JSON.stringify({
        graphId: s.graph,
        graph: {
          orders: s.tasks.map((t) => ({ id: t.orderId, dependsOn: s.deps?.[t.orderId] ?? [] })),
        },
        manifest: { connector: 'relay-v1-http-0123', readAt: s.at, tasks: s.tasks, problems: [] },
      }),
      s.at,
    ),
  );
  db.prepare('INSERT INTO observations VALUES (?, ?, ?)').run(
    'relay',
    JSON.stringify({
      at: observation.at,
      connector: 'relay-v1-http-0123',
      scope: { readAt: observation.at, tasks: observation.tasks, problems: [] },
    }),
    observation.at,
  );
  delivered.forEach((d, n) =>
    db
      .prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        `op-${n}`,
        d.work,
        `run-${n}`,
        d.task,
        'delivered',
        JSON.stringify({ outcome: 'accepted', steps: [] }),
        at(1),
      ),
  );
  db.close();
}

const t = (k: number, key: string) => ({ id: `T${k}`, key, orderId: `w${k}` });

test('P4-5: задача несогласованного снимка — планируемая: planned[], две цифры прогноза', () => {
  const env = engineOf();
  const state = env.dir;
  // Сценарий: полный план из пяти задач проверен (снимок графа gfull), но не
  // согласован; ведущий запустил выборку из четырёх (gnarrow) — последнее чтение без PRODUCT-1.
  const four = [t(1, 'API-1'), t(2, 'API-2'), t(3, 'WEB-1'), t(4, 'ADMIN-1')];
  connectorDb(
    state,
    [
      {
        graph: 'gfull',
        at: at(100),
        tasks: [...four, { id: 'T5', key: 'PRODUCT-1', orderId: 'w5' }],
        deps: { w5: ['w4'] },
      },
      { graph: 'gnarrow', at: at(90), tasks: four },
    ],
    { at: at(90), tasks: four },
  );
  const src = connectorSources(state, new Set(['w1', 'w2', 'w3', 'w4']))[0]!;
  const p5 = src.release!.find((x) => x.key === 'PRODUCT-1');
  assert.ok(p5, 'задача несогласованного снимка — в выпуске');
  assert.deepEqual([p5.snapshot, p5.graphId, p5.dependsOn], [true, 'gfull', ['w4']]);
  const done = (id: string) =>
    work(id, { status: 'done', stage: { ...work(id).stage, name: 'done', next: [] } });
  const input = baseInput({
    works: [done('w1'), done('w2'), done('w3'), done('w4')],
    attempts: ['w1', 'w2', 'w3', 'w4'].map((id, k) =>
      attempt(id, 1, { startedAt: at(80 - k * 10), finishedAt: at(72 - k * 10) }),
    ),
    sources: [src],
  });
  const view = operatorView(input);
  operatorViewSchema.parse(view);
  assert.deepEqual(view.planned, [
    {
      id: 'w5',
      connector: src.connector,
      taskId: 'T5',
      key: 'PRODUCT-1',
      status: 'planned',
      from: 'validated',
      graphId: 'gfull',
      dependsOn: ['w4'],
      line: 'PRODUCT-1: ещё не утверждена (в проверенном, но не согласованном плане)',
    },
  ]);
  const f = view.forecast!;
  assert.equal(f.progress.total, 5);
  assert.equal(f.progress.done, 4);
  assert.deepEqual(f.progress.planned?.keys, ['PRODUCT-1']);
  assert.equal(f.progress.approved?.done, 4);
  assert.equal(f.progress.approved?.left, 0);
  assert.ok(f.progress.approved.percent > f.progress.percent);
  assert.match(
    f.progress.planned.line,
    /^по утверждённому плану ~\d+ %; с планируемыми \(1 задача, не утверждены: PRODUCT-1\) ~\d+ %, осталось ~/,
  );
  // План не согласован — шаг ведущего «план» не сделан.
  assert.equal(f.progress.lead?.steps.find((s) => s.step === 'plan')?.done, false);
  const en = operatorView(input, { lang: 'en' }).planned![0]!;
  assert.equal(en.line, 'PRODUCT-1: not approved yet (in a checked plan that is not approved)');
});

test('P4-5: нижняя граница времени — не короче цепочки зависимостей', () => {
  // Три незаконченные работы цепочкой, параллельно 3: прежняя граница — одна
  // задача; цепочка — три.
  const pending = (id: string, deps: string[]) => work(id, { dependsOn: deps });
  const finished = Array.from({ length: 5 }, (_, k) =>
    attempt('w0', k + 1, {
      runId: `w0-${k}`,
      startedAt: at(200 - k * 20),
      finishedAt: at(190 - k * 20),
      status: k < 4 ? 'failed' : 'succeeded',
    }),
  );
  const input = baseInput({
    policy: { ...baseInput().policy, concurrency: 3 },
    works: [
      work('w0', { status: 'done', stage: { ...work('w0').stage, name: 'done', next: [] } }),
      pending('a', []),
      pending('b', ['a']),
      pending('c', ['b']),
    ],
    attempts: finished,
  });
  const f = operatorView(input).forecast!;
  assert.equal(f.time.chain, 3);
  // p50 = 10 мин, попыток на задачу 5: цепочка из трёх — 3 × 10 × 5 мин.
  assert.equal(f.time.remaining?.loMs, 3 * 10 * 60_000 * 5);
  const parallel = operatorView({
    ...input,
    works: input.works.map((w) => ({ ...w, dependsOn: [] })),
  }).forecast!;
  assert.equal(parallel.time.remaining?.loMs, 1 * 10 * 60_000 * 5);
});

test('P4-5: зарегистрированная несогласованная работа — works[].planned, «ещё не утверждена»', () => {
  const env = engineOf();
  env.engine.register(graphOf({ w: [] }), trustNone);
  const view = viewOf(env);
  assert.equal(view.works[0]!.planned, true);
  const f = view.forecast!;
  assert.equal(f.progress.planned?.count, 1);
  assert.equal(f.progress.works?.[0]?.line, 'w: ещё не утверждена');
  ready(env.engine, graphOf({ w: [] }, '2'));
  assert.equal(viewOf(env).works[0]!.planned, undefined);
});

test('P4-10: журнал ведущего — сессия, заметки, итог выпуска; «код принят, ведущий ещё работает»', () => {
  // Приёмка выпуска (alpha.69) здесь не предмет: совет вместо требования.
  const env = engineOf(policyOf((p) => (p.release = { review: 'advisory' })));
  ready(env.engine, graphOf({ w: [], x: ['w'] }));
  assert.throws(
    () => releaseDone(env.engine, { summary: 'рано' }),
    /Выпуск не готов: не приняты w, x/,
  );
  leadBegin(env.engine, { ttlMs: 30 * 60_000 });
  acceptAll(env, 2, 'a');
  env.clock.now += 60_000;
  leadNote(env.engine, { text: 'Закрываю задачи в Relay\u0007 и\n\nпроверяю сайт в браузере' });
  const view = viewOf(env);
  assert.equal(view.lead?.active, true);
  assert.equal(view.lead?.lastNote?.plain, 'Закрываю задачи в Relay и проверяю сайт в браузере');
  assert.match(view.lead.line, /^ведущий работает: Закрываю задачи/);
  const f = view.forecast!;
  assert.equal(f.progress.release?.state, 'code-accepted');
  assert.equal(
    f.progress.line,
    // alpha.68: сессия ведущего открыта — «если ведущий не добавит задач».
    'готово ~95 % — если ведущий не добавит задач · код принят, ведущий ещё работает: Закрываю задачи в Relay и проверяю сайт в браузере',
  );
  assert.ok(f.time.lead, JSON.stringify(f.time));
  // alpha.68: код принят — «осталось немного: ведущий завершает (идёт …)», а не
  // «осталось: ничего + работа ведущего».
  assert.match(f.time.line, /код принят · осталось немного: ведущий завершает \(идёт /);
  assert.ok(f.time.finishing?.since, JSON.stringify(f.time));
  // Записи ведущего — в ленте с актёром lead.
  assert.ok(view.activity!.some((a) => a.actor === 'lead' && a.action === 'lead.note'));
  // Аренда истекла — не «работает».
  env.clock.now += 31 * 60_000;
  assert.equal(viewOf(env).lead?.active, false);
  env.clock.now += 1000;
  const done = releaseDone(env.engine, { summary: 'Выпуск готов: форма заявок работает.' });
  assert.equal(done.release?.works, 2);
  const after = viewOf(env).forecast!;
  assert.equal(after.progress.percent, 100);
  assert.equal(after.progress.release?.state, 'done');
  assert.equal(after.progress.release?.summary, 'Выпуск готов: форма заявок работает.');
  assert.equal(after.time.lead, undefined);
  const stored = env.engine.read((v) => v.local('lead', WORKSPACE_OWNER, 'log'))!;
  assert.deepEqual(
    stored.entries.map((e) => e.action),
    ['lead.begin', 'lead.note', 'release.done'],
  );
});

test('P4-10: строка ведущего — без управляющих символов и секретов, с пределом длины', () => {
  assert.equal(cleanLeadText(' a\u001b[31mb\u0000 c ', 200, 'x'), 'a b c');
  assert.doesNotMatch(
    cleanLeadText('token sk-ant-api03-' + 'A1b2'.repeat(10), 200, 'x'),
    /A1b2A1b2/,
  );
  const long = cleanLeadText('я'.repeat(500), 200, 'x');
  assert.equal(long.length, 200);
  assert.throws(() => cleanLeadText(' \n ', 200, 'x'), /непустая строка/);
});

test('P4-10: CLI lead begin|note|end и release done — синонимы, договор, capabilities', () => {
  // Приёмка выпуска (alpha.69) здесь не предмет: совет вместо требования.
  const env = engineOf(policyOf((p) => (p.release = { review: 'advisory' })));
  ready(env.engine, graphOf({ w: [] }));
  acceptAll(env, 1, 'a');
  writeFileSync(
    join(env.dir, 'binding.json'),
    JSON.stringify({ policy: env.engine.policy, baseDir: env.dir }),
  );
  env.store.close();
  const begin = harness('lead', 'begin', '--state', env.dir, '--ttl', '45m');
  assert.equal(begin.status, 0, begin.stderr);
  assert.equal(cliDataSchemas['lead-begin'].parse(begin.json.data).lead.active, true);
  const note = harness('lead', 'note', 'Обновляю документ DOC-2 в Relay', '--state', env.dir);
  assert.equal(note.status, 0, note.stderr);
  assert.equal(
    cliDataSchemas['lead-note'].parse(note.json.data).lead.lastNote,
    'Обновляю документ DOC-2 в Relay',
  );
  const tooEarly = harness('release-done', '--state', env.dir);
  assert.equal(tooEarly.status, 2, 'нужен --summary');
  const done = harness('release', 'done', 'Всё принято и доставлено.', '--state', env.dir);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(cliDataSchemas['release-done'].parse(done.json.data).release?.works, 1);
  const end = harness('lead', 'end', '--state', env.dir);
  assert.equal(end.status, 0, end.stderr);
  assert.equal(cliDataSchemas['lead-end'].parse(end.json.data).lead.active, false);
  // `--actor operator` — решение оператора, не журнал ведущего.
  const r = harness('view', '--state', env.dir);
  const view = operatorViewSchema.parse(
    (r.json.data as unknown as { view?: unknown }).view ?? r.json.data,
  );
  assert.equal(view.forecast?.progress.release?.state, 'done');
  assert.deepEqual(
    view.lead!.notes.map((n) => n.action),
    ['lead.end', 'release.done', 'lead.note', 'lead.begin'],
  );
  for (const c of ['lead-begin', 'lead-note', 'lead-end', 'release-done'] as const) {
    assert.ok(c in cliCommands, c);
    assert.equal(cliCommands[c].writes, true);
  }
  assert.deepEqual(
    cliCommands['release-done'].args.map((a) => a.name),
    ['--state', '--summary'],
  );
  // capabilities: ответ view (общая операция) описывает поля ревизии 6.
  const viewTool = harnessCapabilities().tools.find((x) => x.name === 'view')!;
  const out = JSON.stringify(viewTool.outputSchema);
  for (const field of ['"planned"', '"lead"', '"resources"', '"release"', '"chain"'])
    assert.ok(out.includes(field), field);
  // Помощь — по договору; синоним `lead note` ведёт к lead-note.
  const help = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', cli, 'lead', 'note', '--help'],
    { encoding: 'utf8' },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^harness lead-note — /);
});

test('alpha.67 P5-5: заметка ведущего с числами сохраняет пробелы в строке прогноза (неразрывные — обычными)', () => {
  assert.equal(cleanLeadText('Приняты 3 из 4 работ', 200, 'x'), 'Приняты 3 из 4 работ');
  assert.equal(cleanLeadText('Приняты 3 из 4 работ', 200, 'x'), 'Приняты 3 из 4 работ');
  const env = engineOf();
  ready(env.engine, graphOf({ w: [], x: ['w'] }));
  leadBegin(env.engine, { ttlMs: 30 * 60_000 });
  acceptAll(env, 2, 'a');
  env.clock.now += 60_000;
  leadNote(env.engine, { text: 'Сайт принят. Приняты 3 из 4 работ, исполнитель на админке.' });
  const view = viewOf(env);
  assert.equal(
    view.forecast!.progress.line,
    'готово ~95 % — если ведущий не добавит задач · код принят, ведущий ещё работает: Сайт принят. Приняты 3 из 4 работ, исполнитель на админке.',
  );
  assert.match(view.lead!.line, /Приняты 3 из 4 работ/);
});
