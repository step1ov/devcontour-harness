import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessError, workGraphSchema, type ErrorCode } from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { planReview, trustNone } from './engine-fixture.ts';
import { implement } from './runner-fixture.ts';
import { knap, propertyHarness, propertySetup } from './property-fixture.ts';

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};
const P = 'knapsack-optimal';

/** Зарегистрировать и согласовать граф без запуска очереди. */
function approved() {
  const ctx = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    policy: (p) => (p.maxAttempts = 10),
  });
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(planReview(ctx.engine, graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  ctx.engine.lead('c1');
  return ctx;
}
/** Выдать попытку и записать её отказ с классом и свойствами. */
function failAs(
  e: Engine,
  kind: 'gate' | 'review' | 'environment' | 'provider-auth' | 'timeout',
  bound: string[] = [],
  unbound: string[] = [],
  message = 'отказ ' + Math.random(),
) {
  const a = e.claim('c1');
  assert.ok(a, 'попытка выдана');
  const r = e.fail(a.id, a.token, message, {
    kind,
    ...(bound.length || unbound.length ? { properties: { bound, unbound } } : {}),
  });
  return { attempt: a, result: r };
}
const work = (e: Engine) => e.read((v) => v.work('add-greeting')!);

test('T16/AC24: два содержательных отказа одного свойства с разными сообщениями запрещают третью выдачу; свойство не берётся из текста', () => {
  const { engine } = approved();
  failAs(engine, 'gate', [P], [], 'свойство нарушено на входе A');
  engine.retry('add-greeting');
  // Текст, называющий свойство, без привязки — не счёт.
  failAs(engine, 'gate', [], [], `свойство ${P} нарушено, хотя отчёт пуст`);
  engine.retry('add-greeting');
  assert.equal(work(engine).recovery, undefined);
  failAs(engine, 'review', [P], [], 'ревью нашло вход B');
  const w = work(engine);
  assert.equal(w.recovery?.status, 'awaiting-lead');
  assert.equal(w.recovery?.property, P);
  assert.equal(w.recovery?.runs.length, 2);
  engine.retry('add-greeting');
  assert.equal(work(engine).status, 'ready');
  assert.equal(engine.claim('c1'), undefined, 'третья обычная выдача запрещена');
  assert.ok(
    engine
      .read((v) => engine.blockers(v.work('add-greeting')!, v))
      .some((b) => /Разбор свойства/.test(b.message)),
  );
  const events = engine.host.store.events().filter((e) => e.type === 'work.recovery');
  assert.equal(
    events.at(-1)?.type === 'work.recovery' && events.at(-1)!.payload.status,
    'awaiting-lead',
  );
});

test('T16/AC25: инфраструктурный отказ между отказами не увеличивает и не обнуляет счёт; свойства не склеиваются; необъявленное не открывает эпизод', () => {
  const { engine } = approved();
  failAs(engine, 'gate', [P]);
  engine.retry('add-greeting');
  for (const kind of ['environment', 'provider-auth', 'timeout'] as const) {
    failAs(engine, kind, [P]);
    engine.clearFailure([kind]);
    engine.retry('add-greeting');
    assert.equal(work(engine).recovery, undefined, kind + ' не увеличивает счёт');
  }
  // Другое свойство — не тот же счёт.
  failAs(engine, 'gate', ['reach-complete']);
  engine.retry('add-greeting');
  assert.equal(work(engine).recovery, undefined, 'свойства не склеиваются');
  // Необъявленное поручением свойство — только для разбора.
  const { result } = failAs(engine, 'review', ['not-declared']);
  assert.equal(result.properties, undefined);
  const last = engine.read((v) => v.attempts('add-greeting').at(-1)!);
  assert.deepEqual(last.unboundProperties, ['not-declared']);
  engine.retry('add-greeting');
  assert.equal(work(engine).recovery, undefined);
  // Две находки одной попытки — один отказ; вместе с первым — эпизод.
  failAs(engine, 'review', [P, P]);
  assert.equal(
    work(engine).recovery?.status,
    'awaiting-lead',
    'нейтральные отказы не обнулили счёт',
  );
});

test('F06: инфраструктурный отказ с прошедшим отчётом как отрицательной диагностикой не обнуляет серию', () => {
  const { engine } = approved();
  failAs(engine, 'gate', [P]);
  engine.retry('add-greeting');
  const a = engine.claim('c1')!;
  engine.phase(a.id, a.token, 'verifying', { candidateSha: 'c'.repeat(40) });
  engine.evidence(a.id, a.token, {
    kind: 'test',
    phase: 'candidate',
    sha: 'c'.repeat(40),
    gate: 'properties',
    passed: false,
    command: ['node'],
    exitCode: -1,
    log: '',
    digest: 'd'.repeat(64),
    summary: 'оборвано',
    property: {
      seed: 1,
      reproduce: 'x',
      contracts: {},
      artifacts: [],
      level: 'manifest',
      report: { version: 1, properties: [{ testId: P, status: 'passed', cases: 100 }] },
    },
  });
  engine.fail(a.id, a.token, 'обрыв', { kind: 'environment' });
  engine.clearFailure(['environment']);
  engine.retry('add-greeting');
  failAs(engine, 'gate', [P]);
  assert.equal(work(engine).recovery?.status, 'awaiting-lead');
});

test('T16: один ограниченный разбор на эпизод; прерванный разбор не даёт бесплатного вызова; повтор после решения разрешён один раз', () => {
  const { engine } = approved();
  failAs(engine, 'gate', [P]);
  engine.retry('add-greeting');
  failAs(engine, 'gate', [P]);
  const r = work(engine).recovery!;
  assert.equal(engine.recoveryReserve('add-greeting', r.id).status, 'analyzing');
  assert.throws(() => engine.recoveryReserve('add-greeting', r.id), refused('NOT_READY'));
  engine.recoveryInterrupted('add-greeting', r.id, 'рестарт посреди разбора');
  assert.equal(work(engine).recovery?.status, 'awaiting-user');
  // Ручное решение человека с версией записи; устаревшая версия не применяется.
  const stale = work(engine).recovery!.version - 1;
  const decision = {
    action: 'new-approach' as const,
    reason: 'Нужен динамический подход по вместимости',
    evidence: ['вход A', 'вход B'],
    hypothesis: 'Учитывать все предметы',
    plan: 'Генератор с adversarial семейством',
    source: { kind: 'operator' as const },
    decidedAt: new Date().toISOString(),
  };
  assert.throws(
    () => engine.recoveryDecide('add-greeting', r.id, decision, stale),
    refused('APPROVAL_STALE'),
  );
  const decided = engine.recoveryDecide(
    'add-greeting',
    r.id,
    decision,
    work(engine).recovery!.version,
  );
  assert.equal(decided.status, 'retry');
  engine.retry('add-greeting');
  const retry = engine.claim('c1')!;
  assert.equal(work(engine).recovery?.status, 'retrying');
  assert.equal(work(engine).recovery?.retryRun, retry.id);
  engine.fail(retry.id, retry.token, 'снова', {
    kind: 'gate',
    properties: { bound: [P], unbound: [] },
  });
  assert.equal(
    work(engine).recovery?.status,
    'stopped',
    'повторный отказ после разрешённого повтора',
  );
  engine.retry('add-greeting');
  assert.equal(engine.claim('c1'), undefined, 'бесконечного повтора нет');
});

test('F07: согласованное изменение основания закрывает прежний эпизод и даёт выдачу; история эпизода сохраняется', () => {
  const ctx = approved();
  const { engine } = ctx;
  failAs(engine, 'gate', [P]);
  engine.retry('add-greeting');
  failAs(engine, 'gate', [P]);
  const opened = work(engine).recovery!;
  const raw = structuredClone(ctx.graph) as unknown as {
    source: { revision: string };
    orders: { goal: string; source: { revision: string } }[];
  };
  raw.source.revision = '2';
  raw.orders[0]!.source.revision = '2';
  raw.orders[0]!.goal = 'Добавить оптимальный рюкзак — уточнённая постановка.';
  const next = workGraphSchema.parse(raw);
  const { graph } = engine.register(next, trustNone);
  assert.equal(
    work(engine).recovery?.id,
    opened.id,
    'новая редакция источника эпизод не закрывает',
  );
  engine.recordReview(planReview(engine, graph, 2));
  engine.approve(graph.id, 'agent');
  const w = work(engine);
  assert.equal(w.recovery, undefined);
  assert.equal(w.recoveryHistory?.at(-1)?.id, opened.id);
  assert.match(w.recoveryHistory.at(-1)!.reason!, /новое основание/);
  assert.ok(engine.claim('c1'), 'выдача возвращена');
});

const counter = JSON.stringify({
  items: [
    { w: 1, v: 1 },
    { w: 1, v: 1 },
    { w: 1, v: 1 },
    { w: 1, v: 9 },
  ],
  cap: 4,
});
const lead = (patch: Record<string, unknown>) => ({
  result: {
    action: 'add-cases',
    reason: 'Реализация пропускает предметы после третьего',
    evidence: ['контрпример генератора'],
    hypothesis: null,
    plan: null,
    cases: null,
    proposal: null,
    conflict: null,
    ...patch,
  },
});

test('T16/AC26: в режиме agent узкий маршрут завершается без человека — добавленным подтверждённым случаем и одним повтором', async () => {
  const ctx = propertySetup({
    writer: [
      implement({ 'src/knap.mjs': knap.firstThree }),
      implement({ 'src/knap.mjs': knap.fitted({ items: [{ w: 9, v: 9 }], cap: 0 }, 0) }),
      implement({ 'src/knap.mjs': knap.correct }),
    ],
    lead: lead({ cases: [{ input: counter, expected: '12' }] }),
    policy: (p) => ((p.maxAttempts = 5), (p.repairBudget = 5)),
  });
  const h = propertyHarness(ctx);
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  const w = h.engine.read((v) => v.work('add-greeting')!);
  assert.equal(w.status, 'done', JSON.stringify(data.workflow));
  const history = w.recoveryHistory?.at(-1);
  assert.equal(history?.decision?.action, 'add-cases');
  assert.equal(history?.status, 'closed');
  assert.equal(history?.calls, 1, 'один разбор на эпизод');
  assert.equal(w.checkVersion?.number, 1, 'подтверждённый случай принят поручением');
  const attempts = h.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts.length, 3, 'два отказа и один разрешённый повтор');
  assert.equal(attempts[2]!.checks?.corpus?.number, 1, 'повтор исполняет корпус');
  assert.ok(data.workflow?.history.some((x) => x.event === 'recovery:' + P));
  h.close();
});

test('T16/AC26: новая гипотеза ведущего передаётся исполнителю повтора с источником', async () => {
  const ctx = propertySetup({
    writer: [
      implement({ 'src/knap.mjs': knap.firstThree }),
      implement({ 'src/knap.mjs': knap.zeroWeight }),
      { ...implement({ 'src/knap.mjs': knap.correct }), recordPrompt: true },
    ],
    lead: lead({
      action: 'new-approach',
      hypothesis: 'Полная таблица по вместимости для всех предметов',
      plan: 'Сверить на adversarial семействе',
    }),
    policy: (p) => ((p.maxAttempts = 5), (p.repairBudget = 5)),
  });
  const h = propertyHarness(ctx);
  await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(
    h.engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  const prompt = readFileSync(ctx.scenarioPath + '.writer.2.prompt', 'utf8');
  assert.match(prompt, /Hypothesis: Полная таблица по вместимости/);
  assert.match(prompt, /source: lead \(claude\)/);
  h.close();
});

test('T16/AC28: пауза человека и предложение для обычного ревью не обходятся автоматически', async () => {
  const ctx = propertySetup({
    writer: [implement({ 'src/knap.mjs': knap.firstThree })],
    lead: lead({
      action: 'strengthen-checker',
      proposal: 'Добавить семейство с длинными списками',
    }),
    policy: (p) => ((p.maxAttempts = 5), (p.repairBudget = 5)),
  });
  const h = propertyHarness(ctx);
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  const w = h.engine.read((v) => v.work('add-greeting')!);
  assert.equal(w.recovery?.status, 'stopped');
  assert.match(w.recovery?.reason ?? '', /обычное ревью/);
  assert.equal(data.workflow?.status, 'failed');
  assert.equal(
    h.engine.read((v) => v.attempts('add-greeting').length),
    2,
    'третьей выдачи нет',
  );
  h.close();
});
