/**
 * События вмешательств и причин отказа (отчёт, фаза 2): `work.retried`,
 * `work.cancelled`, `attempt.diagnosed`. Каждое пишется в той же
 * транзакции, что изменение состояния, и под тем же fencing: отказ операции
 * не оставляет события. `base.moved` — в holds.test.ts (нужен Git).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HarnessError,
  readRunEvent,
  type ErrorCode,
  type EventType,
  type RunEvent,
} from '../src/contracts/index.ts';
import { BlockedError, environmentCauseOf } from '../src/engine/classify.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { engineOf, graphOf, planReview, policyOf, ready, trustNone } from './engine-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, implement } from './runner-fixture.ts';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};
const ofType = <T extends EventType>(events: RunEvent[], type: T) =>
  events.flatMap((e) => (e.type === type ? [e as Extract<RunEvent, { type: T }>] : []));

test('work.retried: актёр, сброс, засчитанные до сброса и длина причины — без её текста', () => {
  const { engine, store } = engineOf(
    policyOf((p) => ((p as { maxAttempts: number }).maxAttempts = 1)),
  );
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  engine.fail(a.id, a.token, 'cannot lock ref', { kind: 'stale-base' });
  const before = store.events().length;
  assert.throws(() => engine.retry('a', undefined, 'operator'), refused('ATTEMPTS_EXHAUSTED'));
  assert.equal(store.events().length, before, 'отказ повтора — без события');
  const reason = 'секретная причина сброса';
  engine.retry('a', { reason: `  ${reason} ` }, 'operator');
  const [reset] = ofType(store.events(), 'work.retried');
  assert.deepEqual(reset!.payload, {
    by: 'operator',
    reset: true,
    spent: 1,
    reasonLength: reason.length,
  });
  assert.equal(reset!.workId, 'a');
  assert.equal(reset!.graphId, 'g');
  assert.ok(!JSON.stringify(store.events()).includes('секретная'), 'текста причины нет');
  // Уже в очереди — изменения нет, события тоже.
  assert.equal(engine.retry('a', undefined, 'operator').changed, false);
  assert.equal(ofType(store.events(), 'work.retried').length, 1);
  // Повтор без сброса; хост без актёра — `host`.
  const b = engine.claim('c1')!;
  engine.fail(b.id, b.token, 'cannot lock ref', { kind: 'stale-base' });
  engine.retry('a', { reason: 'x' });
  assert.deepEqual(ofType(store.events(), 'work.retried')[1]!.payload, {
    by: 'host',
    reset: true,
    spent: 1,
    reasonLength: 1,
  });
});

test('work.retried: повтор без сброса — reset false, без spent; восстановление — recovery', () => {
  const { engine, store } = engineOf(
    policyOf((p) => ((p as { maxAttempts: number }).maxAttempts = 3)),
  );
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  engine.fail(a.id, a.token, 'unit failed', { kind: 'gate' });
  engine.retry('a', undefined, 'recovery');
  assert.deepEqual(ofType(store.events(), 'work.retried')[0]!.payload, {
    by: 'recovery',
    reset: false,
  });
});

test('work.cancelled: без активной попытки — hadAttempt false и без attempt.cancelled; повтор отмены — без события', () => {
  const { engine, store } = engineOf();
  ready(engine, graphOf({ a: [], b: [] }));
  engine.cancel('a', 'не нужно', 'operator');
  const [c] = ofType(store.events(), 'work.cancelled');
  assert.deepEqual(c!.payload, { by: 'operator', hadAttempt: false });
  assert.equal(c!.runId, undefined);
  assert.equal(ofType(store.events(), 'attempt.cancelled').length, 0);
  assert.equal(engine.cancel('a', 'ещё раз', 'operator').changed, false);
  assert.equal(ofType(store.events(), 'work.cancelled').length, 1);
  // С активной попыткой: оба события подряд, у work.cancelled — та же попытка.
  const b = engine.claim('c1')!;
  engine.cancel(b.workId);
  const events = store.events();
  const last = events.slice(-2);
  assert.deepEqual(
    last.map((e) => e.type),
    ['attempt.cancelled', 'work.cancelled'],
  );
  const wc = last[1] as Extract<RunEvent, { type: 'work.cancelled' }>;
  assert.deepEqual(wc.payload, { by: 'host', hadAttempt: true });
  assert.equal(wc.runId, b.id);
  assert.equal(wc.attempt, b.attempt);
  // Отказ отмены — без события.
  assert.throws(() => engine.cancel('nope'), refused('NOT_FOUND'));
  assert.equal(store.events().length, events.length);
});

test('work.cancelled: новая редакция графа без поручения — by graph', () => {
  const { engine, store } = engineOf();
  ready(engine, graphOf({ a: [], b: [] }));
  const { graph } = engine.register(graphOf({ a: [] }, '2'), trustNone);
  engine.recordReview(planReview(engine, graph, engine.reviews('plan', graph.id).length + 1));
  const cancelled = ofType(store.events(), 'work.cancelled');
  assert.deepEqual(
    cancelled.map((e) => [e.workId, e.payload]),
    [['b', { by: 'graph', hadAttempt: false }]],
  );
  // Третья редакция: уже отменённое снова не отменяется.
  engine.register(graphOf({ a: [] }, '3'), trustNone);
  assert.equal(ofType(store.events(), 'work.cancelled').length, 1);
});

test('attempt.diagnosed: сразу за attempt.failed той же попытки; причина приводится к классу; counted', () => {
  const { engine, store } = engineOf(
    policyOf((p) => ((p as { maxAttempts: number }).maxAttempts = 9)),
  );
  ready(engine, graphOf({ a: [] }));
  const cases: [
    Parameters<typeof engine.fail>[3],
    { failureKind: string; cause: string; counted: boolean },
  ][] = [
    [{ kind: 'gate' }, { failureKind: 'gate', cause: 'none', counted: true }],
    // Причина окружения у отказа не окружения не записывается.
    [
      { kind: 'gate', cause: 'dependency-network' },
      { failureKind: 'gate', cause: 'none', counted: true },
    ],
    [
      { kind: 'environment', cause: 'dependency-network' },
      { failureKind: 'environment', cause: 'dependency-network', counted: false },
    ],
    [{ kind: 'environment' }, { failureKind: 'environment', cause: 'other', counted: false }],
    [
      { kind: 'provider-auth', cause: 'provider-limit', blocked: true },
      { failureKind: 'provider-auth', cause: 'provider-limit', counted: false },
    ],
    [
      { kind: 'provider-auth', cause: 'transport' },
      { failureKind: 'provider-auth', cause: 'provider-auth', counted: false },
    ],
    [{ kind: 'stalled' }, { failureKind: 'stalled', cause: 'stalled', counted: true }],
    [{ kind: 'unknown' }, { failureKind: 'unknown', cause: 'none', counted: true }],
    [
      { kind: 'environment', interrupted: true },
      { failureKind: 'environment', cause: 'shutdown', counted: false },
    ],
  ];
  for (const [options, expected] of cases) {
    engine.clearFailure(['environment', 'provider-auth', 'stalled']);
    const a = engine.claim('c1')!;
    engine.fail(a.id, a.token, 'отказ', options);
    const events = store.events();
    const [failed, diagnosed] = pairOf(events, a.id);
    assert.equal(failed?.type, 'attempt.failed', JSON.stringify(options));
    assert.equal(diagnosed?.type, 'attempt.diagnosed');
    assert.equal(diagnosed.seq, failed.seq + 1, 'в той же транзакции, сразу за отказом');
    assert.equal(diagnosed.runId, a.id);
    assert.equal(diagnosed.attempt, a.attempt);
    assert.deepEqual(diagnosed.payload, expected, JSON.stringify(options));
    if (engine.read((v) => v.work('a')!.status) === 'failed') engine.retry('a', { reason: 'r' });
  }
});

function pairOf(events: RunEvent[], runId: string) {
  const own = events.filter(
    (e) => e.runId === runId && (e.type === 'attempt.failed' || e.type === 'attempt.diagnosed'),
  );
  return own as [
    Extract<RunEvent, { type: 'attempt.failed' }>,
    Extract<RunEvent, { type: 'attempt.diagnosed' }>,
  ];
}

test('attempt.diagnosed: чужой токен — отказ без событий; истёкшее владение — lease-expired', () => {
  const { engine, store, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  const before = store.events().length;
  assert.throws(
    () => engine.fail(a.id, 'forged-token', 'x', { kind: 'environment', cause: 'transport' }),
    refused('LEASE_STALE'),
  );
  assert.equal(store.events().length, before, 'fencing: ни отказа, ни причины');
  clock.now += 10 * 60_000;
  engine.expire();
  const events = store.events();
  const expired = events.find((e) => e.type === 'attempt.expired')!;
  const diagnosed = ofType(events, 'attempt.diagnosed');
  assert.equal(diagnosed.length, 1);
  assert.equal(diagnosed[0]!.seq, expired.seq + 1);
  assert.deepEqual(diagnosed[0]!.payload, {
    failureKind: 'environment',
    cause: 'lease-expired',
    counted: false,
  });
  // Опоздавший владелец после истечения ничего не пишет.
  assert.throws(() => engine.fail(a.id, a.token, 'поздно', { kind: 'gate' }), HarnessError);
  assert.equal(ofType(store.events(), 'attempt.diagnosed').length, 1);
});

test('environmentCauseOf: причина в точке обнаружения, иначе по признакам класса', () => {
  const cases: [unknown, string, Parameters<typeof environmentCauseOf>[2], string][] = [
    [
      new TaskFailure('environment', 'x', undefined, 'sandbox-launch'),
      'x',
      'environment',
      'sandbox-launch',
    ],
    [undefined, 'claude: connect EPROTO 1.2.3.4:443', 'environment', 'transport'],
    [undefined, 'socket hang up', 'environment', 'transport'],
    [
      new BlockedError('Runtime codex не подключён'),
      'Runtime codex не подключён',
      'environment',
      'preflight',
    ],
    [undefined, 'что-то сломалось', 'environment', 'other'],
    [undefined, 'Not logged in · Please run /login', 'provider-auth', 'provider-auth'],
    [undefined, 'API Error: 429 Too Many Requests', 'provider-auth', 'provider-limit'],
    [undefined, 'Credit balance is too low', 'provider-auth', 'provider-limit'],
    [undefined, 'stalled', 'stalled', 'stalled'],
    // Отказ кода с сетевым текстом остаётся без причины окружения.
    [new TaskFailure('gate', 'test "rejects EPROTO"'), 'test "rejects EPROTO"', 'gate', 'none'],
    [undefined, 'review', 'review', 'none'],
  ];
  for (const [error, message, kind, cause] of cases)
    assert.equal(environmentCauseOf(error, message, kind), cause, message);
});

test('старый читатель: новые типы событий читаются как unknown, без нагрузки', () => {
  for (const [type, payload] of [
    ['work.retried', { by: 'operator', reset: true, spent: 3, reasonLength: 4 }],
    ['work.cancelled', { by: 'graph', hadAttempt: false }],
    ['base.moved', { by: 'controller' }],
    ['attempt.diagnosed', { failureKind: 'environment', cause: 'transport', counted: false }],
  ] as const) {
    const raw = {
      apiVersion: 'devcontour-harness/v1alpha1',
      seq: 1,
      at: '2026-11-04T00:00:00.000Z',
      type: type.replace('.', '.future-'),
      payload,
    };
    const read = readRunEvent(raw);
    assert.equal(read.type, 'unknown');
    assert.ok(!('payload' in read));
    // Эта версия их знает и проверяет строго.
    assert.equal(readRunEvent({ ...raw, type }).type, type);
    assert.throws(() => readRunEvent({ ...raw, type, payload: { ...payload, extra: 1 } }));
  }
});

test('CLI retry --reset и cancel — актёр operator', () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 1),
  });
  writeFileSync(
    join(ctx.state, 'binding.json'),
    JSON.stringify({ policy: ctx.policy, baseDir: ctx.repo.dir }),
  );
  const h = ctx.open();
  let workId: string;
  try {
    ready(h.engine, ctx.graph);
    const a = h.engine.claim('c1')!;
    workId = a.workId;
    h.engine.fail(a.id, a.token, 'unit failed', { kind: 'gate' });
    h.engine.release('c1');
  } finally {
    h.close();
  }
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cliPath, ...args], {
      cwd: ctx.repo.dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  const retried = cli(
    'retry',
    '--state',
    ctx.state,
    '--work',
    workId,
    '--reset',
    '--reason',
    'flaky',
  );
  assert.equal(retried.status, 0, retried.stderr + retried.stdout);
  const cancelled = cli('cancel', '--state', ctx.state, '--work', workId);
  assert.equal(cancelled.status, 0, cancelled.stderr + cancelled.stdout);
  const store = new SqliteExecutionStore(ctx.statePath, 'test');
  try {
    const events = store.events(0, 1000);
    assert.deepEqual(
      ofType(events, 'work.retried').map((e) => e.payload),
      [{ by: 'operator', reset: true, spent: 1, reasonLength: 5 }],
    );
    assert.deepEqual(
      ofType(events, 'work.cancelled').map((e) => e.payload),
      [{ by: 'operator', hadAttempt: false }],
    );
  } finally {
    store.close();
  }
});
