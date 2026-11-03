import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessError, type RunEvent } from '../src/contracts/index.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';
import { engineOf, graphOf, ready } from './engine-fixture.ts';

const stageEvents = (events: RunEvent[]) =>
  events.filter(
    (e): e is Extract<RunEvent, { type: 'attempt.stage' }> => e.type === 'attempt.stage',
  );
const refused = (code: string) => (e: unknown) => e instanceof HarnessError && e.code === code;

test('attempt.stage: на каждую стадию полного прогона одно started и одно finished по порядку; длительность — из замера', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  const timings = a.timings ?? [];
  assert.ok(timings.length >= 6, JSON.stringify(timings));
  const events = stageEvents(ctx.store.events(0, 500));
  // Ровно два события на замер: объём ограничен числом стадий.
  assert.equal(events.length, timings.length * 2);
  // Начала идут в порядке замеров.
  assert.deepEqual(
    events.filter((e) => e.payload.phase === 'started').map((e) => e.payload.timingId),
    timings.map((t) => t.id),
  );
  for (const t of timings) {
    const pair = events.filter((e) => e.payload.timingId === t.id);
    assert.deepEqual(
      pair.map((e) => e.payload.phase),
      ['started', 'finished'],
      t.stage,
    );
    const [started, finished] = pair as [(typeof pair)[number], (typeof pair)[number]];
    assert.ok(started.seq < finished.seq);
    for (const e of pair) {
      assert.equal(e.payload.stage, t.stage);
      assert.equal(e.graphId, work.graphId);
      assert.equal(e.workId, 'add-greeting');
      assert.equal(e.runId, a.id);
      assert.equal(e.attempt, a.attempt);
    }
    assert.equal(started.payload.at, t.startedAt);
    assert.equal(started.payload.durationMs, undefined);
    assert.equal(started.payload.outcome, undefined);
    assert.equal(finished.payload.at, t.finishedAt);
    assert.equal(finished.payload.outcome, t.outcome);
    assert.equal(
      finished.payload.durationMs,
      Date.parse(t.finishedAt!) - Date.parse(t.startedAt),
      t.stage,
    );
  }
  for (const stage of ['implementation', 'candidate-test:unit', 'integration-review'])
    assert.ok(
      events.some((e) => e.payload.stage === stage),
      stage,
    );
  assert.ok(!JSON.stringify(events).includes(a.token), 'токен не в событиях');
});

test('attempt.stage под fencing: чужой токен, истёкшее и отозванное владение не пишут ни замера, ни события', () => {
  const { engine, store, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  const stages = () => stageEvents(store.events(0, 500));
  const timingsOf = () => engine.read((v) => v.attempt(a.id)!.timings ?? []);

  assert.throws(() => engine.timingStarted(a.id, 'forged-token-0000', 'x'), refused('LEASE_STALE'));
  assert.deepEqual(stages(), [], 'чужой токен не пишет');

  const late = engine.timingStarted(a.id, a.token, 'candidate-review');
  clock.now += 31_000; // срок владения истёк
  const before = { events: stages().length, timings: JSON.stringify(timingsOf()) };
  assert.throws(() => engine.timingFinished(a.id, a.token, late, 'failed'), refused('LEASE_STALE'));
  assert.throws(() => engine.timingStarted(a.id, a.token, 'late'), refused('LEASE_STALE'));
  const adopted = engine.adopt(a.id, 'c2');
  // Прежний владелец после перехвата тоже не пишет.
  assert.throws(() => engine.timingFinished(a.id, a.token, late, 'failed'), refused('LEASE_STALE'));
  assert.equal(stages().length, before.events, 'событий устаревшего владельца нет');
  assert.equal(JSON.stringify(timingsOf()), before.timings, 'замеров устаревшего владельца нет');
  // Новый владелец пишет.
  engine.timingStarted(adopted.id, adopted.token, 'candidate-test:unit');
  assert.equal(stages().length, before.events + 1);
});

test('attempt.stage: повторное закрытие замера — без изменений и без второго finished', () => {
  const { engine, store, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  const id = engine.timingStarted(a.id, a.token, 'candidate-test:unit');
  clock.now += 1500;
  engine.timingFinished(a.id, a.token, id, 'passed');
  const closed = engine.read((v) => v.attempt(a.id)!.timings![0]!);
  clock.now += 2000;
  engine.timingFinished(a.id, a.token, id, 'failed');
  engine.timingFinished(a.id, a.token, 'no-such-timing', 'failed');
  assert.deepEqual(
    engine.read((v) => v.attempt(a.id)!.timings![0]!),
    closed,
    'finishedAt и исход не переписаны',
  );
  assert.deepEqual(
    stageEvents(store.events(0, 500)).map((e) => [
      e.payload.phase,
      e.payload.durationMs,
      e.payload.outcome,
    ]),
    [
      ['started', undefined, undefined],
      ['finished', 1500, 'passed'],
    ],
  );
});

test('attempt.stage: стадия попытки, утратившей владение, остаётся открытой; конец попытки — attempt.expired', () => {
  const { engine, store, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  const id = engine.timingStarted(a.id, a.token, 'implementation');
  clock.now += 31_000;
  // Поздний finish владельца, утратившего срок, отклоняется (runner его глотает).
  assert.throws(() => engine.timingFinished(a.id, a.token, id, 'passed'), refused('LEASE_STALE'));
  engine.expire();
  const events = store.events(0, 500);
  const pair = stageEvents(events).filter((e) => e.payload.timingId === id);
  assert.deepEqual(
    pair.map((e) => e.payload.phase),
    ['started'],
    'started без finished',
  );
  assert.equal(
    engine.read((v) => v.attempt(a.id)!.timings![0]!.finishedAt),
    undefined,
    'замер не закрыт',
  );
  const expired = events.find((e) => e.type === 'attempt.expired' && e.runId === a.id);
  assert.ok(expired && expired.seq > pair[0]!.seq, 'конец стадии — событие конца попытки');
});
