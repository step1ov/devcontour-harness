/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тесты портят сырой JSON политики до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HarnessError,
  WORKSPACE_OWNER,
  type ErrorCode,
  type FailureKind,
} from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { BlockedError, classifyFailure } from '../src/engine/classify.ts';
import { TaskFailure, failureFingerprint, repairPolicy } from '../src/engine/failure.ts';
import { repairDecision } from '../src/engine/repair.ts';
import { WorkflowQueue } from '../src/control/workflow.ts';
import { engineOf, graphOf, policyOf, ready } from './engine-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, implement } from './runner-fixture.ts';

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};

/** Довести поручение до отказа заданного класса. */
function breakWork(engine: Engine, workId: string, kind: FailureKind, message: string) {
  const a = engine.claim('c1')!;
  assert.equal(a.workId, workId);
  engine.fail(a.id, a.token, message, { kind });
  return a;
}
const decide = (engine: Engine, options = { budgetLeft: 6, maxAttempts: 3 }) =>
  engine.read((v) => repairDecision(v, v.works(), options));

test('T15: отпечаток совпадает у одинаковых причин и расходится у разных; класс входит в отпечаток', () => {
  // Сообщения одной причины отличаются идентификаторами, SHA, путями и временем.
  // Если считать их разными, предел одинаковых повторов не сработает никогда.
  const first = failureFingerprint(
    'gate',
    'candidate/typecheck: 3 ошибки в /tmp/harness-a1b2c3/worktrees/R-7 at 2026-09-24T10:00:00Z',
  );
  const second = failureFingerprint(
    'gate',
    'candidate/typecheck: 5 ошибки в /tmp/harness-f9e8d7/worktrees/R-12 at 2026-09-24T11:30:00Z',
  );
  assert.equal(first, second);
  assert.notEqual(first, failureFingerprint('gate', 'candidate/lint: неиспользуемый импорт'));
  const message = 'candidate/independent-review: результат отклонён';
  assert.notEqual(failureFingerprint('gate', message), failureFingerprint('review', message));
  // UUID запроса, SHA и путь прогона не создают новой причины.
  assert.equal(
    failureFingerprint(
      'environment',
      'connection reset, request id 11111111-aaaa-4bbb-8ccc-111111111111',
    ),
    failureFingerprint(
      'environment',
      'connection reset, request id 22222222-dddd-4eee-8fff-222222222222',
    ),
  );
  assert.equal(
    failureFingerprint('environment', 'connection reset in R-33333333-bbbb-4ccc-8ddd-333333333333'),
    failureFingerprint('environment', 'connection reset in R-44444444-eeee-4fff-8aaa-444444444444'),
  );
  assert.notEqual(
    failureFingerprint('environment', 'connection reset'),
    failureFingerprint('environment', 'socket hang up'),
  );
});

test('T15: предел одинаковых повторов задан числом, а не сам собой', () => {
  assert.equal(repairPolicy.gate.repeats, 2);
  assert.equal(repairPolicy.review.repeats, 2);
  assert.equal(repairPolicy.environment.repeats, 1);
  assert.equal(repairPolicy['empty-result'].repeats, 1);
  assert.equal(repairPolicy['provider-auth'].action, 'stop');
  assert.equal(repairPolicy.cancelled.action, 'stop');
  assert.equal(repairPolicy['stale-base'].action, 'stop');
  assert.equal(repairPolicy.unknown.action, 'stop');
});

test('Классификатор узнаёт настоящие тексты отказов; класс из точки отказа не переопределяется', () => {
  const cases: [string, FailureKind][] = [
    ['claude: runtime завершился с кодом 1: Credit balance is too low', 'provider-auth'],
    ['claude: runtime завершился с кодом 1: Insufficient credits to use this API', 'provider-auth'],
    ['codex: runtime завершился с кодом 1: 401 Unauthorized: OAuth token expired', 'provider-auth'],
    ['claude: runtime завершился с кодом 1: Not logged in', 'provider-auth'],
    [
      "claude: runtime завершился с кодом 1: You've hit your session limit · resets 2:40am. Лог: /tmp/a",
      'provider-auth',
    ],
    ['codex: runtime завершился с кодом 1: Rate limit reached for requests', 'provider-auth'],
    ['claude: runtime завершился с кодом 1: Claude usage limit reached', 'provider-auth'],
    ['claude: runtime завершился с кодом 143 (исчерпан лимит времени прогона: 900 с)', 'timeout'],
    ['codex: runtime завершился с кодом 1: connection reset by peer', 'environment'],
    ['claude: runtime завершился с кодом 1: socket hang up', 'environment'],
    [
      'codex: runtime завершился с кодом -1: ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired',
      'environment',
    ],
    ['claude: runtime завершился с кодом 143 (прогон прерван). Лог: /tmp/a', 'environment'],
    ['Истёк срок владения. Повторите явно.', 'timeout'],
    ['Исполнитель изменил HEAD; интеграцией владеет harness', 'unknown'],
  ];
  for (const [message, expected] of cases)
    assert.equal(classifyFailure(new Error(message), message), expected, message);
  assert.equal(
    classifyFailure(new BlockedError('codex: runtime не запускается'), 'x'),
    'environment',
  );
  assert.equal(
    classifyFailure(new TaskFailure('gate', 'candidate/tests: 401 Unauthorized в ответе'), 'x'),
    'gate',
  );
  // Отказ приёмки движка называет класс своим кодом.
  for (const [code, kind] of [
    ['GATE_FAILED', 'gate'],
    ['REVIEW_REJECTED', 'review'],
    ['SCOPE_VIOLATION', 'scope-violation'],
    ['BUDGET_EXHAUSTED', 'budget'],
  ] as const)
    assert.equal(classifyFailure(new HarnessError(code, 'x'), 'x'), kind, code);
  assert.equal(classifyFailure(new HarnessError('NOT_READY', 'x'), 'x'), 'unknown');
});

test('T15: класс и отпечаток отказа записаны на попытке и поручении — решение принимается по состоянию', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [] }));
  breakWork(engine, 'a', 'gate', 'candidate/typecheck: 3 ошибки');
  const [work, attempt] = engine.read((v) => [v.work('a')!, v.attempts('a')[0]!] as const);
  assert.equal(work.failureKind, 'gate');
  assert.equal(attempt.failureKind, 'gate');
  assert.equal(work.failureFingerprint, attempt.failureFingerprint);
});

test('T15: каждый чинимый класс получает повтор; отказ провайдера — остановку с причиной', () => {
  const { engine, store } = engineOf(policyOf((p) => ((p as any).maxAttempts = 10)));
  ready(engine, graphOf({ a: [] }));
  for (const kind of [
    'gate',
    'review',
    'empty-result',
    'timeout',
    'merge',
    'scope-violation',
  ] as const) {
    breakWork(engine, 'a', kind, `Отказ класса ${kind}`);
    const decision = decide(engine, { budgetLeft: 6, maxAttempts: 10 })!;
    assert.equal(decision.action, 'retry', `${kind} чинится повтором`);
    assert.equal(decision.action === 'retry' && decision.kind, kind);
    engine.retry('a');
  }
  breakWork(engine, 'a', 'provider-auth', 'Credit balance too low');
  const stop = decide(engine, { budgetLeft: 6, maxAttempts: 10 })!;
  assert.equal(stop.action, 'stop');
  assert.match(stop.reason, /кредитов|авторизован/);
  void store;
});

test('T15: одна и та же причина чинится до предела класса, затем остановка; другая причина — новая гипотеза', () => {
  const { engine } = engineOf(policyOf((p) => ((p as any).maxAttempts = 10)));
  ready(engine, graphOf({ a: [] }));
  const options = { budgetLeft: 20, maxAttempts: 10 };
  for (let i = 0; i < repairPolicy.gate.repeats; i++) {
    breakWork(engine, 'a', 'gate', 'candidate/typecheck: та же ошибка');
    assert.equal(decide(engine, options)!.action, 'retry');
    engine.retry('a');
  }
  breakWork(engine, 'a', 'gate', 'candidate/typecheck: та же ошибка');
  const exhausted = decide(engine, options)!;
  assert.equal(exhausted.action, 'stop');
  assert.match(exhausted.reason, /одна и та же причина 3 раз/);
  engine.retry('a');
  breakWork(engine, 'a', 'gate', 'candidate/lint: другая ошибка');
  assert.equal(decide(engine, options)!.action, 'retry');
});

/** Отказ ревью с разным текстом, но названным свойством или классом входов. */
function rejectBy(
  engine: Engine,
  text: string,
  named: { unbound?: string[]; classes?: string[]; kind?: FailureKind } = {},
) {
  const a = engine.claim('c1')!;
  engine.fail(a.id, a.token, `Независимое ревью отклонило результат: ${text}`, {
    kind: named.kind ?? 'review',
    properties: { bound: [], unbound: named.unbound ?? [], classes: named.classes ?? [] },
  });
  return a;
}

test('Пробел приёмки: два отказа ревью подряд по одному свойству останавливают слепые повторы, хотя тексты разные', () => {
  const { engine } = engineOf(policyOf((p) => ((p as any).maxAttempts = 10)));
  ready(engine, graphOf({ a: [] }));
  const options = { budgetLeft: 20, maxAttempts: 10 };
  const first = rejectBy(engine, 'теряет оптимум на входе [1,2]', { unbound: ['REQ-optimal'] });
  assert.equal(decide(engine, options)!.action, 'retry', 'первый отказ — обычный повтор');
  engine.retry('a');
  const second = rejectBy(engine, 'теряет оптимум на входе [3,3,4]', { unbound: ['REQ-optimal'] });
  const stop = decide(engine, options)!;
  assert.equal(stop.action, 'stop');
  assert.equal(stop.kind, 'review');
  assert.deepEqual(stop.action === 'stop' && stop.gap, {
    key: 'property:REQ-optimal',
    runs: [first.id, second.id],
  });
  assert.match(stop.reason, /пробел приёмки/);
  assert.match(stop.reason, /свойству «REQ-optimal»/);
  // Отпечатки разные: прежний предел одинаковых причин этого не поймал бы.
  const prints = engine.read((v) => v.attempts('a').map((x) => x.failureFingerprint));
  assert.notEqual(prints[0], prints[1]);
});

test('Пробел приёмки: разные свойства, отказ gate между ними и смена основания серию обрывают; окружение — нет', () => {
  const options = { budgetLeft: 20, maxAttempts: 10 };
  {
    const { engine } = engineOf(policyOf((p) => ((p as any).maxAttempts = 10)));
    ready(engine, graphOf({ a: [] }));
    rejectBy(engine, 'x', { unbound: ['REQ-a'] });
    engine.retry('a');
    rejectBy(engine, 'y', { unbound: ['REQ-b'] });
    assert.equal(decide(engine, options)!.action, 'retry', 'другое свойство — новая гипотеза');
    engine.retry('a');
    breakWork(engine, 'a', 'gate', 'candidate/tests: упал');
    engine.retry('a');
    rejectBy(engine, 'z', { unbound: ['REQ-b'] });
    assert.equal(decide(engine, options)!.action, 'retry', 'отказ gate между отказами ревью');
  }
  {
    const { engine } = engineOf(policyOf((p) => ((p as any).maxAttempts = 10)));
    ready(engine, graphOf({ a: [] }));
    rejectBy(engine, 'x', { unbound: ['REQ-a'] });
    engine.retry('a');
    breakWork(engine, 'a', 'environment', 'connection reset by peer');
    engine.retry('a');
    engine.clearFailure(['environment']);
    rejectBy(engine, 'y', { unbound: ['REQ-a'] });
    const stop = decide(engine, options)!;
    assert.equal(stop.action, 'stop', 'обрыв окружения серию не обнуляет');
    assert.ok(stop.action === 'stop' && stop.gap);
  }
  {
    const { engine, store } = engineOf(policyOf((p) => ((p as any).maxAttempts = 10)));
    ready(engine, graphOf({ a: [] }));
    rejectBy(engine, 'x', { unbound: ['REQ-a'] });
    engine.retry('a');
    // Согласовано новое основание поручения: прежняя серия к нему не относится.
    store.transact('run.phase', (tx) => {
      const [a] = tx.attempts('a');
      tx.putAttempt({ ...a!, episodeBasis: 'f'.repeat(64) });
    });
    rejectBy(engine, 'y', { unbound: ['REQ-a'] });
    assert.equal(decide(engine, options)!.action, 'retry');
  }
});

test('Пробел приёмки: класс входов без свойства сравнивается без регистра и лишних пробелов; замечания класс не дают', () => {
  const { engine } = engineOf(policyOf((p) => ((p as any).maxAttempts = 10)));
  ready(engine, graphOf({ a: [] }));
  const options = { budgetLeft: 20, maxAttempts: 10 };
  rejectBy(engine, 'x', { classes: ['Равные оптимумы,  больше шести предметов'] });
  engine.retry('a');
  rejectBy(engine, 'y', { classes: ['равные оптимумы, больше шести предметов '] });
  const stop = decide(engine, options)!;
  assert.equal(stop.action, 'stop');
  assert.equal(
    stop.action === 'stop' && stop.gap?.key,
    'class:равные оптимумы, больше шести предметов',
  );
  assert.match(stop.reason, /классу входов/);
  // Без названного свойства и класса — прежнее правило одинаковых отпечатков.
  const plain = engineOf(policyOf((p) => ((p as any).maxAttempts = 10)));
  ready(plain.engine, graphOf({ a: [] }));
  rejectBy(plain.engine, 'x');
  plain.engine.retry('a');
  rejectBy(plain.engine, 'y');
  assert.equal(decide(plain.engine, options)!.action, 'retry');
});

test('T15/T14: отмена человеком не превращается в повтор, даже рядом с чинимым поручением', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [], b: [] }));
  breakWork(engine, 'a', 'gate', 'candidate/typecheck: ошибка');
  engine.cancel('b', 'решение человека');
  const decision = decide(engine)!;
  assert.equal(decision.action, 'stop');
  assert.equal(decision.workId, 'b');
  assert.match(decision.reason, /Отмена не превращается в повтор/);
});

test('T15: бюджет восстановлений группы и бюджет попыток поручения останавливают каждый своей причиной', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [] }));
  breakWork(engine, 'a', 'gate', 'candidate/typecheck: ошибка');
  const spent = decide(engine, { budgetLeft: 0, maxAttempts: 3 })!;
  assert.equal(spent.action, 'stop');
  assert.match(spent.reason, /бюджет автоматических восстановлений/);
  const capped = decide(engine, { budgetLeft: 6, maxAttempts: 1 })!;
  assert.equal(capped.action, 'stop');
  assert.match(capped.reason, /сбросом/);
});

test('T15/T04: потерянное владение чинится как окружение, а не по классу прошлой попытки', () => {
  const { engine, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  breakWork(engine, 'a', 'gate', 'candidate/typecheck: ошибка');
  engine.retry('a');
  assert.equal(
    engine.read((v) => v.work('a')!.failureKind),
    undefined,
    'повтор снимает класс',
  );
  engine.claim('c1');
  clock.now += 10 * 60_000;
  engine.lead('c1');
  engine.expire();
  assert.equal(
    engine.read((v) => v.work('a')!.failureKind),
    'environment',
  );
  const decision = decide(engine)!;
  assert.equal(decision.action, 'retry');
  assert.equal(decision.action === 'retry' && decision.kind, 'environment');
});

/* ------------------------------------------------------------------ */
/* Техническая очередь                                                  */
/* ------------------------------------------------------------------ */

test('T15: задание ставится идемпотентно; истёкший владелец fenced; изменившийся вход — stale', () => {
  const { engine, store, clock } = engineOf();
  const policy = engine.policy;
  ready(engine, graphOf({ a: [] }));
  const flow = new WorkflowQueue(store, policy, () => clock.now);
  const request = {
    kind: 'graph' as const,
    id: 'g',
    authorRuntime: 'codex' as const,
    maxAttempts: 2,
  };
  const job = flow.start(request);
  assert.equal(flow.start(request).key, job.key, 'повтор постановки — то же задание');
  assert.throws(
    () => flow.start({ ...request, authorRuntime: 'claude' }),
    refused('INVALID_INPUT'),
  );
  const first = flow.claim(job.key)!;
  assert.equal(flow.claim(job.key), undefined, 'действующее владение не перехватывается');
  clock.now += policy.leaseMs + 1;
  const replacement = flow.claim(job.key)!;
  assert.notEqual(first.token, replacement.token);
  assert.throws(() => flow.finish(first), refused('LEASE_STALE'));
  flow.finish(replacement);
  assert.equal(flow.get(job.key).stage, 1);
  // Новая редакция графа меняет вход: задание устаревает, новое — другим ключом.
  engine.register(graphOf({ a: [], b: [] }, '2'), { trusted: () => false, reachable: () => true });
  assert.equal(flow.claim(job.key), undefined);
  assert.equal(flow.get(job.key).status, 'stale');
  assert.notEqual(flow.start(request).key, job.key);
});

test('T15/T27: смена политики делает задание stale — и ожидающее, и прерванное; применение политики стадии не начинает', () => {
  const { engine, store, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const flow = new WorkflowQueue(store, engine.policy, () => clock.now);
  const queued = flow.start({ kind: 'graph', id: 'g', authorRuntime: 'codex' });
  const running = flow.claim(queued.key)!;
  const changed = new WorkflowQueue(
    store,
    policyOf((p) => ((p as any).maxAttempts = 7)),
    () => clock.now,
  );
  changed.fail(running, 'Предмет изменился во время ревью');
  assert.equal(changed.get(queued.key).status, 'stale');
  ready(engine, graphOf({ x: [] }, '1', 'g2'));
  const waiting = flow.start({ kind: 'graph', id: 'g2', authorRuntime: 'codex' });
  assert.equal(changed.claim(waiting.key), undefined);
  assert.equal(changed.get(waiting.key).status, 'stale', 'ожидающее задание под новой политикой');
  ready(engine, graphOf({ y: [] }, '1', 'g3'));
  const other = flow.start({ kind: 'graph', id: 'g3', authorRuntime: 'codex' });
  store.transact('config.started', (tx) =>
    tx.setControl({ ...tx.control(), paused: true, pauseReason: 'reconfigure' }),
  );
  assert.equal(flow.claim(other.key), undefined, 'reconfigure держит стадии');
  assert.equal(flow.get(other.key).attempts, 0);
});

test('T27: неприменённый запрос reconfigure держит стадии и до паузы операции; после применения — продолжаются', () => {
  const { engine, store, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const flow = new WorkflowQueue(store, engine.policy, () => clock.now);
  const job = flow.start({ kind: 'graph', id: 'g', authorRuntime: 'codex' });
  engine.requestReconfigure('op-1', engine.policyState().loaded);
  assert.notEqual(
    store.read((v) => v.control().pauseReason),
    'reconfigure',
    'паузы операции ещё нет',
  );
  assert.equal(flow.claim(job.key), undefined, 'запрос держит стадии');
  assert.equal(flow.get(job.key).attempts, 0);
  store.transact('config.started', (tx) =>
    tx.setControl({
      ...tx.control(),
      reconfigure: { ...tx.control().reconfigure!, appliedAt: new Date(clock.now).toISOString() },
    }),
  );
  assert.ok(flow.claim(job.key), 'применённый запрос стадии не держит');
});

test('T15: сорванное восстановление не оставляет ни учёта без повтора, ни повтора без учёта', () => {
  const { engine, store, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  breakWork(engine, 'a', 'gate', 'candidate/typecheck: ошибка');
  const flow = new WorkflowQueue(store, engine.policy, () => clock.now);
  const job = flow.claim(flow.start({ kind: 'graph', id: 'g', authorRuntime: 'codex' }).key)!;
  assert.throws(
    () =>
      flow.repair(job, 'repair:gate', () => {
        engine.retry('a');
        throw new Error('Прерывание между решением и его исполнением');
      }),
    /Прерывание/,
  );
  assert.equal(flow.get(job.key).repairs, undefined);
  assert.equal(
    engine.read((v) => v.work('a')!.status),
    'failed',
  );
  flow.repair(job, 'repair:gate', () => engine.retry('a'));
  assert.equal(flow.get(job.key).repairs, 1);
  assert.equal(
    engine.read((v) => v.work('a')!.status),
    'ready',
  );
  assert.deepEqual(
    store.read((v) =>
      v.local('workflow-jobs', WORKSPACE_OWNER, job.key)!.history.map((h) => h.event),
    ),
    ['running', 'repair:gate'],
  );
});

/* ------------------------------------------------------------------ */
/* Ведущий цикл через Harness.run                                       */
/* ------------------------------------------------------------------ */

const wrong = (text: string) => implement({ 'src/greet.js': `exports.greet = () => '${text}';\n` });

test('T15: run сам чинит упавшее поручение и учитывает это в задании; стадия сохранена', async () => {
  const ctx = hsetup({ scenario: { writer: [wrong('A'), implement()], reviewer: approve() } });
  const h = ctx.open();
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(data.works[0]!.status, 'done');
  assert.equal(
    h.engine.read((v) => v.attempts('add-greeting').length),
    2,
  );
  assert.equal(data.workflow?.status, 'completed');
  assert.equal(data.workflow?.stage, 2);
  assert.equal(data.workflow?.repairs, 1);
  assert.ok(data.workflow?.history.some((e) => e.event === 'repair:gate'));
  assert.ok(!JSON.stringify(data.workflow).includes('token'), 'владение наружу не выдаётся');
  h.close();
});

test('T15: одна и та же причина сверх предела класса останавливает задание с причиной; попыток не больше разрешённого', async () => {
  const ctx = hsetup({
    scenario: { writer: wrong('A'), reviewer: approve() },
    policy: (p: any) => (p.maxAttempts = 6),
  });
  const h = ctx.open();
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(data.works[0]!.status, 'failed');
  assert.equal(
    h.engine.read((v) => v.attempts('add-greeting').length),
    repairPolicy.gate.repeats + 1,
  );
  assert.equal(data.workflow?.status, 'failed');
  assert.equal(data.workflow?.repairs, repairPolicy.gate.repeats);
  assert.match(data.workflow.error!, /одна и та же причина/);
  h.close();
});

test('Пробел приёмки в run: второй отказ ревью по тому же свойству останавливает задание — третьей попытки нет', async () => {
  const rejecting = (input: string, open: number) => ({
    result: {
      ...approve().result,
      approved: false,
      summary: `Неверный ответ на входе ${input}`,
      findings: [
        {
          severity: 'blocking',
          message: `greet ломается на ${input}`,
          path: null,
          line: null,
          rule: 'acceptance',
          consequence: null,
          evidence: null,
          reproduction: {
            property: 'REQ-greeting',
            input,
            inputClass: 'имена с пробелами по краям',
            expected: null,
            actual: null,
            command: null,
            executed: false,
            run: null,
          },
        },
      ],
      previous: Array.from({ length: open }, (_, i) => ({
        id: `$open:${i}`,
        status: 'open',
        basis: 'Дефект класса остаётся',
      })),
    },
  });
  const ctx = hsetup({
    scenario: {
      writer: implement(),
      // Первый шаг reviewer — ревью плана.
      reviewer: [approve(), rejecting('" Ada"', 0), rejecting('"Ada  "', 1), approve()],
    },
    policy: (p: any) => (p.maxAttempts = 6),
  });
  const h = ctx.open();
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  const attempts = h.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts.length, 2, 'третья слепая попытка не выдана');
  assert.notEqual(attempts[0]!.failureFingerprint, attempts[1]!.failureFingerprint);
  assert.deepEqual(attempts[1]!.unboundProperties, ['REQ-greeting']);
  assert.equal(data.works[0]!.status, 'failed');
  assert.equal(data.workflow?.status, 'failed');
  assert.equal(data.workflow?.repairs, 1);
  assert.match(data.workflow.error!, /пробел приёмки.*REQ-greeting/);
  h.close();
});

test('T15: бюджет восстановлений тратится накопительно, переживает рестарт и останавливает работу сам', async () => {
  const ctx = hsetup({
    scenario: { writer: [wrong('A'), wrong('B'), wrong('C'), implement()], reviewer: approve() },
    policy: (p: any) => {
      p.maxAttempts = 10;
      p.repairBudget = 2;
    },
  });
  let h = ctx.open();
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(
    h.engine.read((v) => v.attempts('add-greeting').length),
    3,
  );
  assert.equal(data.workflow?.repairs, 2);
  assert.equal(data.workflow?.status, 'failed');
  assert.match(data.workflow.error!, /бюджет автоматических восстановлений/);
  h.close();
  // Новый процесс: учёт не обнуляется, остановленное задание само не продолжается.
  h = ctx.open();
  const again = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(again.workflow?.repairs, 2);
  assert.equal(again.workflow?.status, 'failed');
  assert.equal(
    h.engine.read((v) => v.attempts('add-greeting').length),
    3,
    'новых попыток нет',
  );
  assert.equal(ctx.calls('claude', 'writer'), 3);
  h.close();
});

test('T15: отказ провайдера останавливает задание без восстановления; поручение остаётся упавшим', async () => {
  const ctx = hsetup({
    scenario: {
      writer: { exit: 1, stderr: 'Credit balance is too low', started: false },
      reviewer: approve(),
    },
  });
  const h = ctx.open();
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(data.works[0]!.status, 'failed');
  assert.equal(data.workflow?.status, 'failed');
  assert.equal(data.workflow?.repairs, 0);
  assert.match(data.workflow.error!, /кредитов|авторизован/);
  assert.equal(
    h.engine.read((v) => v.control().pauseReason),
    'runtime',
  );
  h.close();
});

test('T15/T14: восстановление снимает только свою причину паузы; паузу человека не снимает', async () => {
  for (const [reason, failures, stays] of [
    ['runtime', ['environment'], false],
    ['runtime', ['provider-auth'], true],
    ['runtime', ['environment', 'provider-auth'], true],
    ['runtime', ['provider-auth', 'environment'], true],
    ['operator', undefined, true],
  ] as const) {
    const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
    const h = ctx.open();
    // Поручение уже упало по окружению; выдача остановлена названной причиной.
    const { graph } = h.engine.register(ctx.graph, { trusted: () => false, reachable: () => true });
    await h.review({ kind: 'plan', graph: ctx.graph, author: 'claude' });
    h.engine.approve(graph.id, 'agent');
    h.engine.lead('setup');
    h.engine.resume();
    const a = h.engine.claim('setup')!;
    h.engine.fail(a.id, a.token, 'runtime: транспорт оборван', { kind: 'environment' });
    h.engine.release('setup');
    h.store.transact('scheduler.paused', (tx) =>
      tx.setControl({
        ...tx.control(),
        paused: true,
        pauseReason: reason,
        pauseFailures: failures ? [...failures] : undefined,
      }),
    );
    const data = await h.run({ graph: ctx.graph, author: 'claude' });
    const label = `${reason}/${failures?.join('+') ?? '—'}`;
    assert.equal(data.workflow?.repairs, 1, label + ': повтор назначен');
    const control = h.engine.read((v) => v.control());
    assert.equal(control.paused, stays, label);
    assert.ok(
      !(control.pauseFailures ?? []).includes('environment'),
      label + ': своя причина снята',
    );
    assert.equal(data.works[0]!.status, stays ? 'ready' : 'done', label);
    if (reason === 'operator') assert.equal(control.pauseReason, 'operator');
    h.close();
  }
});

test('T14: run снимает штатную остановку, но не паузу человека, поставленную до неё', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  h.engine.pause('operator');
  h.engine.pause('shutdown');
  const held = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(
    h.engine.read((v) => v.control().pauseReason),
    'operator',
  );
  assert.equal(held.works[0]!.status, 'ready');
  assert.equal(held.workflow?.stage, 1, 'стадия согласования пройдена и сохранена');
  assert.equal(held.workflow?.attempts, 0, 'ожидание не тратит попытку стадии');
  h.engine.resume();
  h.engine.pause('shutdown');
  const done = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(
    h.engine.read((v) => v.control().paused),
    false,
  );
  assert.equal(done.works[0]!.status, 'done');
  assert.equal(done.workflow?.status, 'completed');
  h.close();
});

test('T15: задание, прерванное вместе с процессом, продолжается новым с сохранённой стадии, без повторного ревью плана', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  let h = ctx.open();
  h.engine.pause('operator');
  const first = await h.run({ graph: ctx.graph, author: 'claude' });
  const reviews = ctx.calls('codex', 'reviewer');
  // Процесс погиб посреди стадии исполнения: владение заданием осталось за ним.
  const dead = h.workflows.claim(first.workflow!.key)!;
  assert.equal(dead.stage, 1);
  h.close();
  h = ctx.open();
  h.store.transact('workflow.updated', (tx) =>
    tx.putLocal('workflow-jobs', WORKSPACE_OWNER, dead.key, {
      ...tx.local('workflow-jobs', WORKSPACE_OWNER, dead.key)!,
      leaseUntil: 0,
    }),
  );
  h.engine.resume();
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(data.works[0]!.status, 'done');
  assert.equal(data.workflow?.status, 'completed');
  assert.equal(
    ctx.calls('codex', 'reviewer'),
    reviews + 2,
    'план не ревьюится заново: только ревью кода двух фаз',
  );
  h.close();
});

test('Оператор: run без согласования отклоняется; автоматического ревью, задания и запуска очереди нет', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: any) => (p.approvalMode = 'operator'),
  });
  const h = ctx.open();
  await assert.rejects(h.run({ graph: ctx.graph, author: 'claude' }), refused('APPROVAL_REQUIRED'));
  assert.equal(ctx.calls('codex', 'reviewer'), 0);
  assert.deepEqual(h.workflows.list(), []);
  assert.equal(
    h.engine.read((v) => v.control().paused),
    true,
  );
  h.close();
});

test('Очередь хоста: свои предметы и владелец задания — те же правила fencing, устаревания и попыток', () => {
  const { engine, store, clock } = engineOf();
  let digest = 'a'.repeat(64);
  let refuse: string | undefined;
  const flow = new WorkflowQueue(store, engine.policy, () => clock.now, {
    input: (kind) => {
      if (kind !== 'board') return undefined;
      if (refuse) throw new HarnessError('INVALID_INPUT', refuse);
      return { digest, owner: 'lib' };
    },
  });
  const job = flow.start({ kind: 'board', id: 'B-1', authorRuntime: 'claude' });
  assert.equal(job.owner, 'lib');
  assert.deepEqual(flow.list().length, 0, 'задание хранится за владельцем, а не в общих');
  assert.equal(flow.list('lib')[0]?.key, job.key);
  assert.equal(flow.start({ kind: 'board', id: 'B-1', authorRuntime: 'claude' }).key, job.key);
  assert.throws(() => flow.start({ kind: 'other', id: 'X', authorRuntime: 'claude' }), /не найден/);
  const claimed = flow.claim(job.key, 'lib')!;
  assert.equal(claimed.status, 'running');
  flow.heartbeat(claimed);
  const next = flow.finish(claimed, false, 3);
  assert.equal(next.stage, 1);
  assert.equal(next.status, 'queued', 'три стадии хоста: после первой работа продолжается');
  // Недопустимый вход: постановка отклоняется его текстом, поставленное задание устаревает.
  refuse = 'Доска потеряла подготовку';
  assert.throws(
    () => flow.start({ kind: 'board', id: 'B-2', authorRuntime: 'claude' }),
    /Доска потеряла подготовку/,
  );
  assert.equal(flow.claim(job.key, 'lib'), undefined);
  assert.equal(flow.get(job.key, 'lib').status, 'stale');
  // Изменившийся digest входа — тоже устаревшее задание.
  refuse = undefined;
  const second = flow.start({ kind: 'board', id: 'B-3', authorRuntime: 'codex' });
  digest = 'b'.repeat(64);
  assert.equal(flow.claim(second.key, 'lib'), undefined);
  assert.equal(flow.get(second.key, 'lib').status, 'stale');
  // Предмет перешёл к другому владельцу при том же digest — задание устарело.
  let owner = 'lib';
  const moving = new WorkflowQueue(store, engine.policy, () => clock.now, {
    input: () => ({ digest: 'c'.repeat(64), owner }),
  });
  const third = moving.start({ kind: 'board', id: 'B-4', authorRuntime: 'claude' });
  owner = 'app';
  assert.equal(moving.claim(third.key, 'lib'), undefined);
  assert.equal(moving.get(third.key, 'lib').status, 'stale');
  store.close();
});
