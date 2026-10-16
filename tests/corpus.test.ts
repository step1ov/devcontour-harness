import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { HarnessError, workGraphSchema, type ErrorCode } from '../src/contracts/index.ts';
import {
  CorpusStore,
  portableSuite,
  scrubLocalPaths,
  verifySuite,
} from '../src/verification/corpus.ts';
import { planReview } from './engine-fixture.ts';
import { caseHooks } from '../src/verification/confirm.ts';
import { approve, implement, runAll, target } from './runner-fixture.ts';
import { knap, propertyHarness, propertySetup, rejection } from './property-fixture.ts';

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};
/** Контрпример первых трёх предметов: четвёртый предмет нужен оптимуму. */
const input = JSON.stringify({
  items: [
    { w: 1, v: 1 },
    { w: 1, v: 1 },
    { w: 1, v: 1 },
    { w: 1, v: 9 },
  ],
  cap: 4,
});

test('T17: пример подтверждается закреплённым эталоном дважды на дефектном SHA; только подтверждённый случай — новая версия корпуса; повтор ключа не дублирует', async () => {
  const ctx = propertySetup({
    writer: [
      implement({ 'src/knap.mjs': knap.firstThree }),
      implement({ 'src/knap.mjs': knap.correct }),
    ],
  });
  await ctx.runner.init();
  await runAll(ctx);
  const failed = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(failed.failureKind, 'gate', failed.error);
  // Ожидание источника неверно — эталон его опровергает, корпус не меняется.
  const wrong = await ctx.runner.submitCase({
    workId: 'add-greeting',
    property: 'knapsack-optimal',
    input,
    expected: '3',
    key: 'case-wrong-expected',
  });
  assert.equal(wrong.decision.outcome, 'refuted');
  assert.equal(wrong.version, null, 'опровергнутое не создаёт версию');
  // Неизвестное свойство, замаскированный вход, не JSON — отклонены.
  for (const [key, raw] of [
    ['case-unknown-prop', { property: 'other-property', input }],
    ['case-masked-input', { property: 'knapsack-optimal', input: '{"x":"[REDACTED]"}' }],
    ['case-not-json-input', { property: 'knapsack-optimal', input: 'rm -rf /' }],
  ] as const) {
    const r = await ctx.runner.submitCase({ workId: 'add-greeting', key, ...raw });
    assert.equal(r.decision.outcome, 'rejected', key);
  }
  // Верное ожидание: эталон даёт 12, реализация на кандидате — 3.
  const ok = await ctx.runner.submitCase({
    workId: 'add-greeting',
    property: 'knapsack-optimal',
    input,
    expected: '12',
    key: 'case-confirmed-1',
  });
  assert.equal(ok.decision.outcome, 'confirmed', ok.decision.reason);
  assert.equal(ok.decision.observed?.repeats, 2, 'эталон и реализация запущены дважды');
  assert.equal(ok.decision.observed?.expected, '12');
  assert.equal(ok.decision.source.sha, failed.candidateSha);
  assert.deepEqual(ok.decision.method?.command, ctx.policy.repositories[0]!.gates[0]!.command);
  assert.equal(ok.version?.number, 1);
  assert.equal(ok.version?.cases, 1);
  // Поручение не занято попыткой — версия принята сразу.
  const w = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(w.checkVersion?.number, 1);
  assert.equal(w.checkVersion?.digest, ok.version?.digest);
  // Повтор с тем же ключом возвращает прежнее решение, без второго подтверждения.
  const again = await ctx.runner.submitCase({
    workId: 'add-greeting',
    property: 'knapsack-optimal',
    input,
    expected: '12',
    key: 'case-confirmed-1',
  });
  assert.equal(again.repeated, true);
  assert.equal(again.decision.id, ok.decision.id);
  // Тот же вход под другим ключом — тот же случай, новой версии нет.
  const same = await ctx.runner.submitCase({
    workId: 'add-greeting',
    property: 'knapsack-optimal',
    input: JSON.stringify(JSON.parse(input)),
    expected: '12',
    key: 'case-confirmed-2',
  });
  assert.equal(same.decision.caseId, ok.decision.caseId);
  const suite = ctx.runner.corpus.read(ok.suite);
  assert.equal(suite.versions.length, 1);
  assert.equal(Object.keys(suite.cases).length, 1);
  assert.equal(
    suite.decisions.length,
    6,
    'история решений только дополняется: повтор ключа — без решения',
  );
  // Следующая попытка закрепляет корпус и исполняет его в gate.
  ctx.engine.retry('add-greeting');
  await ctx.runner.drain();
  const next = ctx.engine.read((v) => v.attempts('add-greeting')[1]!);
  assert.equal(next.status, 'succeeded', next.error);
  assert.equal(next.checks?.corpus?.digest, ok.version?.digest);
  const e = next.evidence.find((x) => x.gate === 'properties' && x.phase === 'candidate')!;
  assert.equal(e.property?.manifest?.corpus?.cases, 1);
  assert.equal(e.property?.report?.corpus?.executed, 1);
  assert.equal(e.checks, next.checks?.effective);
});

test('T17: пример reviewer — гипотеза: на верной реализации он опровергнут, команда воспроизведения не исполняется, корпус не меняется', async () => {
  const ctx = propertySetup({
    writer: [implement({ 'src/knap.mjs': knap.correct })],
    reviewer: [
      rejection({ property: 'knapsack-optimal', input, expected: '3', actual: '12' }),
      approve(),
    ],
    policy: (p) => (p.maxAttempts = 1),
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.failureKind, 'review');
  assert.deepEqual(a.properties, ['knapsack-optimal'], 'отказ связан с объявленным свойством');
  const suites = ctx.engine.read((v) => v.locals('check-suites').map((x) => x.value));
  assert.equal(suites.length, 1);
  const [decision] = suites[0]!.decisions;
  assert.equal(decision?.outcome, 'refuted', decision?.reason);
  assert.equal(decision?.origin.kind, 'review');
  assert.deepEqual(decision?.method?.command, ctx.policy.repositories[0]!.gates[0]!.command);
  assert.equal(suites[0]!.versions.length, 0);
});

test('T17/AC17: принятие ждёт окончания активной попытки; сбой после записи версии продолжается без второго подтверждения', async () => {
  const ctx = propertySetup({ writer: implement({ 'src/knap.mjs': knap.firstThree }) });
  await runAll(ctx);
  const failed = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  // Поручение снова занято попыткой: принятие версии удерживает выдачу и ждёт.
  ctx.engine.retry('add-greeting');
  await ctx.runner.init();
  ctx.engine.lead(ctx.runner.owner);
  const busy = ctx.engine.claim(ctx.runner.owner)!;
  caseHooks.afterRecord = () => {
    throw new Error('сбой после записи версии');
  };
  try {
    await assert.rejects(
      ctx.runner.submitCase({
        workId: 'add-greeting',
        property: 'knapsack-optimal',
        input,
        expected: '12',
        sourceSha: failed.candidateSha,
        key: 'case-crash-after-record',
      }),
      /сбой после записи версии/,
    );
  } finally {
    caseHooks.afterRecord = () => undefined;
  }
  const suite = ctx.engine.read((v) => v.locals('check-suites')[0]!.value);
  assert.equal(suite.versions.length, 1, 'версия записана до сбоя');
  assert.equal(suite.pending[0]?.status, 'waiting');
  // Повтор ключа: прежнее решение, принятие продолжается; поручение занято — ждёт.
  const again = await ctx.runner.submitCase({
    workId: 'add-greeting',
    property: 'knapsack-optimal',
    input,
    expected: '12',
    sourceSha: failed.candidateSha,
    key: 'case-crash-after-record',
  });
  assert.equal(again.repeated, true);
  const held = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.match(held.hold?.operation ?? '', /^checks:AD-/);
  assert.equal(held.checkVersion, undefined, 'посреди попытки версия не принимается');
  // Попытка под прежней версией проверок не принимается после смены и не
  // меняется принятием: она закончится, и принятие завершится до выдачи.
  ctx.engine.fail(busy.id, busy.token, 'остановлено тестом', {
    kind: 'environment',
    blocked: true,
  });
  ctx.runner.corpus.resume();
  const adopted = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(adopted.checkVersion?.number, 1);
  assert.equal(adopted.hold, undefined, 'своё удержание снято');
  assert.equal(
    ctx.engine.read((v) => v.locals('check-suites')[0]!.value.decisions.length),
    1,
    'второго подтверждения нет',
  );
});

test('AC17: две добавки к одной версии не теряются — вторая версия содержит оба случая', async () => {
  const ctx = propertySetup({ writer: implement({ 'src/knap.mjs': knap.firstThree }) });
  await runAll(ctx);
  const other = JSON.stringify({
    items: [
      { w: 2, v: 1 },
      { w: 2, v: 1 },
      { w: 2, v: 1 },
      { w: 2, v: 8 },
    ],
    cap: 4,
  });
  const [a, b] = await Promise.all([
    ctx.runner.submitCase({
      workId: 'add-greeting',
      property: 'knapsack-optimal',
      input,
      expected: '12',
      key: 'case-concurrent-a',
    }),
    ctx.runner.submitCase({
      workId: 'add-greeting',
      property: 'knapsack-optimal',
      input: other,
      expected: '9',
      key: 'case-concurrent-b',
    }),
  ]);
  assert.equal(a.decision.outcome, 'confirmed', a.decision.reason);
  assert.equal(b.decision.outcome, 'confirmed', b.decision.reason);
  const suite = ctx.engine.read((v) => v.locals('check-suites')[0]!.value);
  assert.equal(Object.keys(suite.cases).length, 2);
  assert.equal(suite.versions.at(-1)!.cases.length, 2, 'последняя версия — оба случая');
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.checkVersion?.digest),
    suite.versions.at(-1)!.digest,
  );
  void target;
  void readFileSync;
});

test('F04/F10: в operator mode данные корпуса записываются, но принятие ждёт оператора и удерживает выдачу; чужое удержание не снимается', async () => {
  const ctx = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.firstThree }),
    policy: (p) => (p.approvalMode = 'operator'),
  });
  await ctx.runner.init();
  const { graph } = ctx.engine.register(ctx.graph, { trusted: () => false, reachable: () => true });
  ctx.engine.recordReview(planReview(ctx.engine, graph, 1));
  ctx.engine.approve(graph.id, 'operator');
  ctx.engine.resume();
  await ctx.runner.drain();
  const failed = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  ctx.engine.retry('add-greeting');
  const r = await ctx.runner.submitCase({
    workId: 'add-greeting',
    property: 'knapsack-optimal',
    input,
    expected: '12',
    sourceSha: failed.candidateSha,
    key: 'case-operator-mode',
  });
  assert.equal(r.decision.outcome, 'confirmed');
  assert.equal(r.adoption[0]?.awaitingOperator, true);
  const held = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(held.checkVersion, undefined);
  assert.match(held.hold!.operation, /^checks:AD-/);
  ctx.engine.lead(ctx.runner.owner);
  assert.equal(ctx.engine.claim(ctx.runner.owner), undefined, 'выдача удержана до подтверждения');
  assert.throws(
    () => ctx.runner.corpus.adopt(r.suite, r.adoption[0]!.id),
    refused('APPROVAL_REQUIRED'),
  );
  // Чужая операция удержание не снимает.
  assert.throws(
    () => ctx.runner.corpus.abandon(r.suite, r.adoption[0]!.id, 'checks:AD-foreign'),
    refused('INVALID_INPUT'),
  );
  ctx.runner.corpus.approveAdoption(r.suite, r.adoption[0].id);
  const adopted = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(adopted.checkVersion?.number, 1);
  assert.equal(adopted.hold, undefined);
  assert.ok(ctx.engine.claim(ctx.runner.owner), 'после подтверждения выдача возвращена');
});

test('F05: истёкший токен подтверждения не продлевается и не записывает решение', async () => {
  let now = Date.now();
  const ctx = propertySetup({ writer: implement({ 'src/knap.mjs': knap.firstThree }) });
  const engine = new (await import('../src/engine/engine.ts')).Engine({
    host: ctx.engine.host,
    policy: ctx.policy,
    now: () => now,
  });
  const corpus = new CorpusStore(engine);
  ctx.engine.register(ctx.graph, { trusted: () => false, reachable: () => true });
  const ref = ctx.engine.read((v) => {
    const w = v.work('add-greeting')!;
    return corpus.suiteFor(v, w, 'knapsack-optimal');
  });
  const begun = corpus.begin(ref.suite, 'case-expired-token');
  assert.ok(begun.token);
  now += ctx.policy.leaseMs * 4 + 1;
  corpus.heartbeat(ref.suite.id, 'case-expired-token', begun.token);
  assert.ok(
    corpus.read(ref.suite.id).operations['case-expired-token']!.leaseUntil! <= now,
    'продление не вернуло владение',
  );
  assert.throws(
    () =>
      corpus.record(
        corpus.read(ref.suite.id),
        'case-expired-token',
        begun.token,
        {
          property: 'knapsack-optimal',
          input,
          inputHash: 'a'.repeat(64),
          outcome: 'refuted',
          reason: 'x',
          source: { sha: 'c'.repeat(40) },
          origin: { kind: 'agent' },
        },
        () => 'b'.repeat(40),
        { works: [], actor: 'agent' },
      ),
    refused('LEASE_STALE'),
  );
  // Новый владелец получает операцию после истечения прежнего.
  assert.ok(corpus.begin(ref.suite, 'case-expired-token').token);
});

test('AC04/AC07: неполный договор проверки отклоняется до вызова модели; свойство без договора не согласуется', async () => {
  const ctx = propertySetup({ writer: implement({ 'src/knap.mjs': knap.correct }) });
  const h = propertyHarness(ctx);
  const weak = {
    ...ctx.contract,
    id: 'weak',
    checks: {
      ...ctx.contract.checks!,
      obligations: [
        {
          ...ctx.contract.checks!.obligations[0]!,
          method: {
            ...ctx.contract.checks!.obligations[0]!.method,
            kind: 'scenario' as const,
            artifacts: [],
          },
        },
      ],
    },
  };
  await assert.rejects(
    h.review({ kind: 'contract', contract: weak, author: 'claude' }),
    (e: unknown) => {
      assert.ok(e instanceof HarnessError);
      assert.equal(e.code, 'INVALID_INPUT');
      assert.match(e.message, /нужен независимый способ проверки/);
      assert.match(e.message, /не ссылается на закреплённый checker/);
      return true;
    },
  );
  // Закреплённый файл, которого нет в целевой ветке, — тоже отказ до модели.
  const moved = {
    ...ctx.contract,
    id: 'moved',
    artifacts: [{ path: 'oracle.mjs', blob: 'f'.repeat(40) }, ...ctx.contract.artifacts!.slice(1)],
  };
  await assert.rejects(
    h.review({ kind: 'contract', contract: moved, author: 'claude' }),
    /не совпадают с целевой веткой.*oracle\.mjs/,
  );
  assert.equal(
    existsSync(ctx.scenarioPath + '.codex.reviewer.count'),
    false,
    'reviewer не вызывался',
  );
  // Поручение со свойством, которого нет в договорах, не согласуется.
  const graph = workGraphSchema.parse({
    ...ctx.graph,
    id: 'g-unknown',
    source: { connector: 'files', ref: 'g-unknown', revision: '1' },
    orders: [
      {
        ...ctx.graph.orders[0],
        id: 'unknown-prop',
        source: { connector: 'files', ref: 'unknown-prop', revision: '1' },
        properties: ['not-in-contract'],
      },
    ],
  });
  const { graph: state } = h.engine.register(graph, {
    trusted: () => false,
    reachable: () => true,
  });
  h.engine.recordReview(planReview(h.engine, state, 1));
  assert.throws(() => h.engine.approve(state.id, 'agent'), /свойство not-in-contract не объявлено/);
  h.close();
});

test('F09/F14/F16/F17/F19/F22: переносимая запись корпуса без локальных путей; законный текст сохранён; очистка идемпотентна', () => {
  const root = '/srv/work/space dir';
  const roots = [root, 'C:\\Proj\\app'];
  const cases: [string, string][] = [
    [`Error at ${root}/src/knap.mjs:3`, 'Error at <local-path>/src/knap.mjs:3'],
    [`see ${['', 'Users', 'ann', 'x.js'].join('/')} now`, 'see <local-path> now'],
    ['at file:///tmp/x/y.js)', 'at <local-path>)'],
    ['\\nfile:///etc/z', '\\n<local-path>'],
    [`\\n${root}/a`, '\\n<local-path>/a'],
    ['C:\\\\Proj\\\\app\\\\src', '<local-path>\\\\src'],
    [
      'GET /api/tasks?id=1 and https://example.com/a?b=c',
      'GET /api/tasks?id=1 and https://example.com/a?b=c',
    ],
    ['пример/tmp и café/tmp, 2026-01-01, 3/4', 'пример/tmp и café/tmp, 2026-01-01, 3/4'],
  ];
  for (const [text, want] of cases) {
    const once = scrubLocalPaths(text, roots);
    assert.equal(once, want, text);
    assert.equal(scrubLocalPaths(once, roots), once, 'идемпотентно: ' + text);
  }
});

test('Переносимый корпус проверяется по своим случаям: подменённый digest или случай отклоняется; команда checker не переносится', async () => {
  const ctx = propertySetup({ writer: implement({ 'src/knap.mjs': knap.firstThree }) });
  await runAll(ctx);
  const r = await ctx.runner.submitCase({
    workId: 'add-greeting',
    property: 'knapsack-optimal',
    input,
    expected: '12',
    key: 'case-portable',
  });
  assert.equal(r.decision.outcome, 'confirmed');
  const suite = ctx.runner.corpus.read(r.suite);
  const portable = portableSuite(suite, [ctx.repo.dir, ctx.state]);
  assert.equal(verifySuite(portable).size, 1);
  assert.equal('command' in (portable.decisions[0]!.method ?? {}), false);
  assert.doesNotMatch(
    JSON.stringify(portable),
    new RegExp(ctx.repo.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  const tampered = {
    ...portable,
    cases: portable.cases.map((c) => ({ ...c, expected: '13' })),
  };
  assert.throws(() => verifySuite(tampered), /не совпадает с её случаями/);
});
