import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operatorView, viewToken, workDetailView } from '../src/projections/index.ts';
import { NOW, at, attempt, baseInput, work } from './operator-view-input.ts';
import { collectOperatorViewInput, harnessView, latestTime } from '../src/control/operator-view.ts';
import type { WorkflowQueue } from '../src/control/workflow.ts';
import { engineOf, graphOf, trustNone } from './engine-fixture.ts';
import { operatorViewSchema } from '../src/contracts/index.ts';
import { viewState } from './view-fixture.ts';

test('view token: тот же вход — тот же токен; generatedAt в токен не входит', () => {
  const input = baseInput({ works: [work('a')], controller: { leaseUntil: NOW + 30_000 } });
  const a = operatorView(input);
  const b = operatorView(input);
  assert.equal(a.source.token, b.source.token);
  assert.equal(viewToken(a), a.source.token);
  assert.match(a.source.token, /^[a-f0-9]{64}$/);
  // Тот же документ с другим generatedAt — тот же токен.
  assert.equal(viewToken({ ...a, generatedAt: '2030-01-01T00:00:00.000Z' }), a.source.token);
  const detail = workDetailView(input, 'a');
  assert.equal(viewToken(detail), detail.source.token);
});

test('view token: аренда controller истекла без записи в хранилище — токен меняется', () => {
  const leaseUntil = NOW + 10_000;
  const live = operatorView(baseInput({ controller: { leaseUntil }, now: NOW }));
  // Тот же вход хранилища, часы после конца аренды: содержимое (присутствие
  // controller) меняется — токен тоже; сдвиг окна сам по себе токен не меняет.
  const later = NOW + 15 * 60_000;
  const expired = operatorView(baseInput({ controller: { leaseUntil }, now: later }));
  assert.equal(live.health.controller.present, true);
  assert.equal(expired.health.controller.present, false);
  assert.notEqual(live.source.token, expired.source.token);
  // Те же вход и часы — тот же токен (повтор, а не новое представление).
  const sameWindow = operatorView(baseInput({ controller: { leaseUntil }, now: NOW }));
  assert.equal(sameWindow.source.token, live.source.token);
});

test('view token: смена любого поля содержимого меняет токен', () => {
  const a = operatorView(baseInput({ works: [work('a')] }));
  const b = operatorView(baseInput({ works: [work('a', { status: 'running' })] }));
  assert.notEqual(a.source.token, b.source.token);
});

test('view token r1: неизменное состояние при других часах — тот же токен; границы окна в токен не входят', () => {
  const input = baseInput({ works: [work('a')] });
  const a = operatorView(input);
  // Через 5 минут и через 2 часа: окно сдвинулось, содержимое то же.
  for (const later of [NOW + 5 * 60_000, NOW + 2 * 3_600_000]) {
    const b = operatorView({ ...input, now: later });
    assert.notEqual(b.history.to, a.history.to);
    assert.notEqual(b.generatedAt, a.generatedAt);
    assert.equal(b.source.token, a.source.token);
  }
  // Изменение состояния — другой токен.
  const changed = operatorView(baseInput({ works: [work('a', { status: 'failed' })] }));
  assert.notEqual(changed.source.token, a.source.token);
  // Тот же документ с другими границами окна — тот же токен; с другим рядом — другой.
  assert.equal(
    viewToken({ ...a, history: { ...a.history, from: '2000-01-01T00:00:00.000Z' } }),
    a.source.token,
  );
  const load = [...a.history.load];
  load[0] = 1;
  assert.notEqual(viewToken({ ...a, history: { ...a.history, load } }), a.source.token);
});

test('view token r1: настоящее состояние — два запуска harness view дают один токен, запись в хранилище меняет его', () => {
  const s = viewState();
  const now = Date.parse('2026-10-08T12:00:00Z');
  const first = harnessView({ stateDir: s.state, policyPath: s.policyPath, now });
  const second = harnessView({ stateDir: s.state, policyPath: s.policyPath, now: now + 60_000 });
  assert.equal(second.source.token, first.source.token);
  const detail = (at: number) =>
    harnessView({ stateDir: s.state, policyPath: s.policyPath, now: at, workId: 'gate' });
  assert.equal(detail(now + 60_000).source.token, detail(now).source.token);
  // Другое состояние (одна работа отменена) — другой токен.
  const other = viewState(undefined, (input) => {
    (input.works as unknown[])[0] = { ...input.works[0]!, status: 'cancelled' };
  });
  const changed = harnessView({ stateDir: other.state, policyPath: other.policyPath, now });
  assert.notEqual(changed.source.token, first.source.token);
});

const collectAt = (env: ReturnType<typeof engineOf>, now: number) =>
  collectOperatorViewInput(
    {
      engine: env.engine,
      policy: env.engine.policy,
      workflows: { list: () => [], continues: () => false } as unknown as WorkflowQueue,
      stateDir: env.dir,
      baseDir: env.dir,
    },
    { warnings: [], baseDir: env.dir },
    { now },
  );

test('view token r1: остановка без начала этапа — since = регистрация графа, токен не зависит от часов', () => {
  const env = engineOf();
  // Граф зарегистрирован, план не согласован: работа стоит без начала этапа и без попыток.
  const { graph } = env.engine.register(graphOf({ w: [] }), trustNone);
  const t0 = env.clock.now + 60_000;
  const a = operatorView(collectAt(env, t0));
  const b = operatorView(collectAt(env, t0 + 10 * 60_000));
  const stop = a.escalations.find((e) => e.workId === 'w');
  assert.ok(stop, 'остановка работы есть');
  assert.equal(stop.since, graph.registeredAt);
  assert.equal(b.source.token, a.source.token);
  env.store.close();
});

test('view token r1: пауза с pausedAt — since из хранилища, токен не зависит от часов; без pausedAt — момент запроса', () => {
  const env = engineOf();
  env.engine.register(graphOf({ w: [] }), trustNone);
  const pausedAt = new Date(env.clock.now).toISOString();
  env.store.transact('run.phase', (tx) =>
    tx.setControl({ paused: true, pauseReason: 'operator', pausedAt }),
  );
  const t0 = env.clock.now + 60_000;
  const a = operatorView(collectAt(env, t0));
  const b = operatorView(collectAt(env, t0 + 10 * 60_000));
  const pause = (v: typeof a) =>
    v.escalations.find((e) => e.workId === undefined && e.subject === undefined);
  assert.equal(pause(a)?.since, pausedAt);
  assert.equal(b.source.token, a.source.token);
  // Запись паузы прежней версии без момента начала: since обязателен в версии 1 —
  // момент запроса (единственный случай, когда токен идёт за часами).
  env.store.transact('run.phase', (tx) => tx.setControl({ paused: true, pauseReason: 'operator' }));
  const legacy = operatorView(collectAt(env, t0));
  operatorViewSchema.parse(legacy);
  assert.equal(pause(legacy)?.since, new Date(t0).toISOString());
  env.store.close();
});

test('view token r1: история с записями — сдвиг часов внутри интервала не меняет токен, переход интервала — меняет', () => {
  const input = baseInput({
    works: [work('a')],
    // Внутри интервалов, не на их границах (15 мин от конца окна).
    attempts: [attempt('a', 1, { startedAt: at(112), finishedAt: at(108) })],
  });
  const a = operatorView(input);
  // Окно сдвинулось на 1 мс и на 1 мин: запись в том же интервале, ряды те же —
  // тот же токен.
  for (const d of [1, 60_000])
    assert.equal(operatorView({ ...input, now: NOW + d }).source.token, a.source.token);
  // Через полный интервал (15 мин) запись переезжает в предыдущий интервал ряда:
  // это изменение содержимого скользящей истории, токен меняется.
  const moved = operatorView({ ...input, now: NOW + 15 * 60_000 });
  assert.notDeepEqual(moved.history.attemptsStarted, a.history.attemptsStarted);
  assert.notEqual(moved.source.token, a.source.token);
  assert.deepEqual(moved.history.totals, a.history.totals);
});

test('view token r1: latestTime — самый поздний момент по времени, а не по строке', () => {
  // Со смещением зоны строка «позже», а момент — раньше (10:00Z против 11:00Z).
  assert.equal(
    latestTime(['2026-01-01T13:00:00.000+03:00', '2026-01-01T11:00:00.000Z', undefined]),
    '2026-01-01T11:00:00.000Z',
  );
  assert.equal(latestTime(['bad', undefined]), undefined);
  assert.equal(latestTime([]), undefined);
});
