/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тест правит сырой JSON политики до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { HarnessError, digestOf, workGraphSchema, type ErrorCode } from '../src/contracts/index.ts';
import { tmpdir } from 'node:os';
import {
  CorpusStore,
  canonicalJson,
  portableSuite,
  scrubLocalPaths,
  verifySuite,
} from '../src/verification/corpus.ts';
import { planReview } from './engine-fixture.ts';
import { caseHooks } from '../src/verification/confirm.ts';
import { approve, implement, runAll, target } from './runner-fixture.ts';
import { Harness } from '../src/control/harness.ts';
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

test('AC13/AC19: подтверждённый дефект останавливает следующего кандидата на gate до ревью; самопроверка исполнителя его ловит; полный корпус больше 20 случаев подсказки исполняется', async () => {
  const ctx = propertySetup({
    writer: [
      implement({ 'src/knap.mjs': knap.zeroWeight }),
      { ...implement({ 'src/knap.mjs': knap.zeroWeight }), selfCheck: true, recordPrompt: true },
      { ...implement({ 'src/knap.mjs': knap.correct }), selfCheck: true },
    ],
  });
  await ctx.runner.init();
  await runAll(ctx);
  const first = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(first.failureKind, 'gate', first.error);
  // 25 подтверждённых случаев одного класса: больше, чем показывает подсказка.
  for (let v = 1; v <= 25; v++) {
    const r = await ctx.runner.submitCase({
      workId: 'add-greeting',
      property: 'knapsack-optimal',
      input: JSON.stringify({ items: [{ w: 0, v }], cap: 0 }),
      expected: String(v),
      key: `case-zero-${v}`,
    });
    assert.equal(r.decision.outcome, 'confirmed', r.decision.reason);
  }
  const bound = ctx.engine.read((v) => v.work('add-greeting')!.checkVersion)!;
  assert.equal(ctx.runner.corpus.read(bound.suite).versions.at(-1)!.cases.length, 25);
  const reviews = () => {
    const file = `${ctx.scenarioPath}.codex.reviewer.count`;
    return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  };
  const before = reviews();
  ctx.engine.retry('add-greeting');
  await ctx.runner.drain();
  const second = ctx.engine.read((v) => v.attempts('add-greeting')[1]!);
  assert.equal(second.failureKind, 'gate', second.error);
  assert.equal(reviews(), before, 'кандидат остановлен до нового ревью');
  const gate = second.evidence.find((e) => e.gate === 'properties' && e.phase === 'candidate')!;
  assert.equal(gate.passed, false);
  assert.equal(gate.property?.manifest?.corpus?.cases, 25);
  assert.equal(gate.property?.report?.corpus?.executed, 25);
  assert.equal(second.checks?.corpus?.digest, bound.digest);
  // Подсказка показала 20 случаев, а исполнялись все 25.
  const prompt = readFileSync(`${ctx.scenarioPath}.writer.1.prompt`, 'utf8');
  assert.match(prompt, /25 cases confirmed by the pinned oracle/);
  assert.match(prompt, /First 20 shown/);
  assert.match(prompt, /Self-check: run `/);
  // Самопроверка исполнителя поймала тот же дефект на рабочем дереве.
  const self = JSON.parse(readFileSync(`${ctx.scenarioPath}.writer.1.selfcheck`, 'utf8')) as {
    code: number;
    output: string;
  };
  assert.equal(self.code, 1, self.output);
  assert.match(self.output, /FAIL knapsack-optimal: input=/);
  assert.match(self.output, /CORPUS knapsack-optimal \[K-[a-f0-9]+\]: ожидалось \d+, получено 0/);
  assert.match(self.output, /diagnostic|failing/);
  // Два отказа по свойству подряд: третья выдача — только после решения.
  const recovery = ctx.engine.read((v) => v.work('add-greeting')!.recovery)!;
  assert.equal(recovery.status, 'awaiting-lead');
  ctx.engine.recoveryDecide(
    'add-greeting',
    recovery.id,
    {
      action: 'new-approach',
      reason: 'Ноль веса пропускается: такие предметы надо брать всегда.',
      evidence: ['корпус: 25 случаев с нулевым весом'],
      hypothesis: 'Предметы нулевого веса не тратят вместимость.',
      plan: 'Полный корпус и генератор на кандидате.',
      source: { kind: 'operator' },
      decidedAt: new Date().toISOString(),
    },
    recovery.version,
  );
  ctx.engine.retry('add-greeting');
  await ctx.runner.drain();
  const done = ctx.engine.read((v) => v.attempts('add-greeting')[2]!);
  assert.equal(done.status, 'succeeded', done.error);
  for (const phase of ['candidate', 'integration'] as const) {
    const e = done.evidence.find((x) => x.gate === 'properties' && x.phase === phase)!;
    assert.equal(e.passed, true, e.summary);
    assert.equal(e.property?.report?.corpus?.passed, 25);
    assert.equal(e.checks, done.checks?.effective);
  }
  const fixed = JSON.parse(readFileSync(`${ctx.scenarioPath}.writer.2.selfcheck`, 'utf8')) as {
    code: number;
    output: string;
  };
  assert.equal(fixed.code, 0, fixed.output);
});

test('S2.5: без самопроверки gates те же: поручение без свойств не получает самопроверку, а поручение со свойствами без неё всё равно останавливается gate', async () => {
  const ctx = propertySetup({
    writer: { ...implement({ 'src/knap.mjs': knap.zeroWeight }), recordPrompt: true },
    properties: false,
  });
  await ctx.runner.init();
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  const prompt = readFileSync(`${ctx.scenarioPath}.writer.0.prompt`, 'utf8');
  assert.doesNotMatch(prompt, /Self-check: run/, 'прежний уровень — без самопроверки');
  // Gate исполняется независимо от самопроверки: дефект нулевого веса — отказ gate.
  assert.equal(a.failureKind, 'gate', a.error);
});

test('AC05: эксперимент по таймауту — inconclusive и ничего не ослабляет; ограниченный успех хранит версии и пределы вывода; ссылка закрепляет digest, reviewer читает результат', async () => {
  const ctx = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    reviewer: { ...approve(), recordPrompt: true },
    files: {
      // Прототип: перебор растёт экспоненциально, на размере 40 не успевает.
      'spike.mjs': `const n = Number(process.env.HARNESS_SPIKE_SIZE);
let x = 0;
for (let i = 0; i < 2 ** Math.min(n, 60); i++) x += i % 7;
console.log('size', n, x);
`,
    },
  });
  const h = propertyHarness(ctx);
  const head = ctx.repo.head();
  const timedOut = await h.spike({
    command: [process.execPath, 'spike.mjs'],
    sizes: [4, 40, 50],
    timeoutMs: 3000,
    question: 'Успевает ли полный перебор на 40 предметах',
  });
  assert.equal(timedOut.outcome, 'inconclusive');
  assert.deepEqual(
    timedOut.results.map((r) => r.outcome),
    ['ok', 'timeout'],
    'после таймаута большие размеры не запускаются',
  );
  assert.match(timedOut.limits, /не доказательство невыполнимости/);
  assert.equal(timedOut.sha, head);
  const bounded = await h.spike({
    command: [process.execPath, 'spike.mjs'],
    sizes: [4, 8],
    seed: 9,
    timeoutMs: 20000,
    question: 'Перебор на малых входах укладывается в бюджет',
  });
  assert.equal(bounded.outcome, 'feasible');
  assert.equal(bounded.seed, 9);
  assert.deepEqual(bounded.sizes, [4, 8]);
  assert.match(bounded.limits, /Не доказывает верхней границы на любом входе/);
  assert.equal(bounded.environment.node, process.version);
  assert.match(bounded.digest, /^[a-f0-9]{64}$/);
  assert.equal(h.spikes().length, 2);
  const failing = await h.spike({
    command: [process.execPath, '-e', 'process.exit(3)'],
    sizes: [1],
    timeoutMs: 5000,
    question: 'Команда эксперимента с ошибкой',
  });
  assert.equal(failing.outcome, 'failed');
  // Ссылка тяжёлого обязательства закрепляет digest эксперимента.
  const withSpike = (spike: { id: string; digest: string }, id: string, digest?: string) => {
    const doc = structuredClone(ctx.contract);
    doc.id = id;
    doc.checks!.obligations[0]!.hard = true;
    doc.checks!.obligations[0]!.feasibility = { spike: spike.id, digest: digest ?? spike.digest };
    return doc;
  };
  await assert.rejects(
    h.review({
      kind: 'contract',
      contract: withSpike(bounded, 'knap-stale', 'f'.repeat(64)),
      author: 'claude',
    }),
    /изменился после ссылки/,
  );
  await assert.rejects(
    h.review({
      kind: 'contract',
      contract: withSpike({ id: 'SP-unknown', digest: 'a'.repeat(64) }, 'knap-unknown'),
      author: 'claude',
    }),
    /эксперимент SP-unknown не найден/,
  );
  assert.equal(existsSync(ctx.scenarioPath + '.codex.reviewer.count'), false, 'до модели');
  const hard = withSpike(timedOut, 'knap-hard');
  const reviewed = await h.review({ kind: 'contract', contract: hard, author: 'claude' });
  assert.equal(reviewed.approved, true, reviewed.summary);
  const prompt = readFileSync(ctx.scenarioPath + '.reviewer.0.prompt', 'utf8');
  assert.ok(prompt.includes(timedOut.id) && prompt.includes('inconclusive'));
  assert.match(prompt, /a timeout is inconclusive/);
  // Неопределённый эксперимент ничего не меняет в договоре сам.
  assert.equal(hard.checks!.obligations[0]!.hard, true);
  h.close();
});

test('S2-R2-06/T30: эксперимент не сохраняет и не возвращает известные значения окружения — в argv, вопросе и в кодированной форме; без секрета — отказ до worktree и записи', async () => {
  const secret = 'spike"secret-99012';
  process.env.HARNESS_SPIKE_SECRET = secret;
  try {
    const ctx = propertySetup({
      writer: implement({ 'src/knap.mjs': knap.correct }),
      policy: (p: any) => (p.environment.secrets = { TOKEN: 'HARNESS_SPIKE_SECRET' }),
    });
    const h = propertyHarness(ctx);
    const spike = await h.spike({
      command: [process.execPath, '-e', 'process.exit(0)', '--', '--token=' + secret],
      sizes: [1],
      timeoutMs: 20000,
      question: 'Укладывается ли перебор с токеном ' + JSON.stringify(secret),
    });
    assert.equal(spike.outcome, 'feasible');
    assert.equal(spike.command.at(-1), '--token=[REDACTED]', 'команда сохранена маскированной');
    assert.match(spike.question, /\[REDACTED\]/);
    const forms = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
    for (const text of [JSON.stringify(spike), JSON.stringify(h.spikes())])
      for (const form of forms) assert.ok(!text.includes(form), 'значение в записи: ' + form);
    const { digest, ...rest } = spike;
    assert.equal(digest, digestOf(rest), 'digest — от сохранённой маскированной формы');
    // Путь отказа: команда, которую нельзя запустить, — в ошибке или записи значения нет.
    const broken = await h
      .spike({
        command: ['/nonexistent-' + secret],
        sizes: [1],
        timeoutMs: 5000,
        question: 'Отказ запуска',
      })
      .then(
        (x) => JSON.stringify(x),
        (e: unknown) => String((e as Error).message) + ' [error]',
      );
    assert.match(broken, /\[error\]$/, 'запуск невозможной команды — отказ');
    for (const form of forms) assert.ok(!broken.includes(form), 'значение на пути отказа');
    h.close();
  } finally {
    delete process.env.HARNESS_SPIKE_SECRET;
  }
  // Секрет окружения не задан — отказ до эксперимента, без записи.
  const missing = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    policy: (p: any) => (p.environment.secrets = { TOKEN: 'HARNESS_SPIKE_NOT_SET_41' }),
  });
  const h2 = propertyHarness(missing);
  await assert.rejects(
    h2.spike({
      command: [process.execPath, '-e', '0'],
      sizes: [1],
      timeoutMs: 5000,
      question: 'Без секрета окружения',
    }),
    (e: unknown) => e instanceof HarnessError && e.code === 'RUNTIME_UNAVAILABLE',
  );
  assert.equal(h2.spikes().length, 0);
  assert.ok(!existsSync(join(missing.state, 'spikes')), 'worktree не создавался');
  h2.close();
});

test('S2-R3-06/T30: отказ запуска эксперимента не несёт известного значения ни в одном поле ошибки — path, spawnargs, stack, сериализация; класс и код ENOENT сохранены', async () => {
  const secret = 'spike-error"66328';
  const forms = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
  const ctx = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    policy: (p: any) => (p.environment.secrets = { TOKEN: 'HARNESS_SPIKE_ERROR_SECRET' }),
  });
  ctx.store.close();
  const h = Harness.open({
    policy: ctx.policy,
    stateDir: ctx.state,
    baseDir: ctx.repo.dir,
    environment: { ...process.env, HARNESS_SPIKE_ERROR_SECRET: secret },
    adapters: {},
  });
  const error = await h
    .spike({
      command: ['/nonexistent/spike-' + secret, '--token=' + secret],
      sizes: [1],
      timeoutMs: 5000,
      question: 'Отказ запуска',
    })
    .then(
      () => assert.fail('команда не могла запуститься'),
      (e: unknown) => e,
    );
  assert.ok(error instanceof Error, 'класс ошибки сохранён');
  const fields = error as NodeJS.ErrnoException & { spawnargs?: string[] };
  assert.equal(fields.code, 'ENOENT', 'код отказа сохранён');
  const views = [
    error.message,
    String(error.stack),
    String(fields.path),
    JSON.stringify(fields.spawnargs),
    JSON.stringify(error),
    JSON.stringify(
      Object.getOwnPropertyNames(error).map(
        (k) => (error as unknown as Record<string, unknown>)[k],
      ),
    ),
  ];
  for (const text of views)
    for (const form of forms) assert.ok(!text.includes(form), `значение в ошибке: ${text}`);
  assert.match(JSON.stringify(error), /\[REDACTED\]/, 'поля ошибки замаскированы, а не удалены');
  assert.equal(h.spikes().length, 0);
  h.close();
});

// Перенесено из потребителя (DevContour check-findings F17/F19/F22 и остатки
// F09/F16): очистка переносимой записи — правило harness.

test('F17: очистка сохраняет законный текст: маршруты, URL с запросом, другие схемы, Unicode, даты и дроби', () => {
  const roots = ['/data/Synthetic Space/project', '/tmp'];
  for (const text of [
    'route /api/users and /api/v1/tasks/7 answered 404',
    'see https://example.com/~/api/v1 and https://example.com/home/page',
    'redirect https://example.test/?next=/tmp/file.json kept',
    'profile://example.test/a and git+ssh://host/x stay',
    'relative src/модуль/файл.mjs, пример/tmp/file and tests/a b.mjs',
    'on 2026/10/08 the ratio was 1/2; /tmpfoo, /tmp-file and /tmp2 are not roots',
    'paths outside known roots stay: /data/input.json and /secret.json',
  ])
    assert.equal(scrubLocalPaths(text, roots), text);
  assert.equal(scrubLocalPaths('at /tmp/x.json', roots), 'at <local-path>/x.json');
  assert.equal(scrubLocalPaths('file:///tmp/x.json', roots), '<local-path>');
});

test('F19: очистка идемпотентна, в том числе при двойных разделителях и корне, повторённом внутри пути', () => {
  const roots = ['/data/project', '/data/Synthetic Space/project', tmpdir(), '/tmp'];
  for (const text of [
    'historic /data//cache//nested/private.json',
    'Error at /data/project/data/project/data/project/input.json',
    'at /data/Synthetic Space/project//nested//x.json and /Users/a//b.json',
    'file:////host//share and C:\\\\Users\\\\x and <local-path>/x',
    `${tmpdir()}${tmpdir()}${tmpdir()}/a and ${tmpdir()}//b`,
  ]) {
    const once = scrubLocalPaths(text, roots);
    assert.equal(scrubLocalPaths(once, roots), once, text);
  }
});

test('F09/F16/F17: путь после экранированного перевода строки или двоеточия снят; комбинируемые знаки и рамка ссылки сохранены', () => {
  const ws = '/srv/synthetic-ws';
  const roots = [ws, '/tmp'];
  const actual = canonicalJson({
    error: `Error:\n${ws}/private.json\n\tC:\\Users\\Synthetic\\private.json`,
  });
  const out = scrubLocalPaths(actual, roots);
  assert.equal(out.includes('synthetic'), false, out);
  assert.equal(out.includes('Synthetic'), false, out);
  assert.equal(scrubLocalPaths('ENOENT:/tmp/x.json', roots), 'ENOENT:<local-path>/x.json');
  const combining = 'café/tmp/file';
  assert.equal(scrubLocalPaths(combining, roots), combining);
  assert.equal(
    scrubLocalPaths('see [input](file:///tmp/input.json), then', roots),
    'see [input](<local-path>), then',
  );
  for (const text of [out, 'see [input](<local-path>), then'])
    assert.equal(scrubLocalPaths(text, roots), text);
});

test('F22: file:// после экранированных \\n, \\r, \\t снимается, а не читается другой схемой', () => {
  for (const escape of ['n', 'r', 't']) {
    const actual = canonicalJson({ error: `Error:\\${escape}file:///srv/synthetic/private.json` });
    const raw = JSON.stringify({
      error: `Error:${escape === 'n' ? '\n' : escape === 'r' ? '\r' : '\t'}file:///srv/synthetic/private.json`,
    });
    for (const text of [actual, raw]) {
      const out = scrubLocalPaths(text, []);
      assert.equal(out.includes('synthetic'), false, out);
      assert.equal(scrubLocalPaths(out, []), out);
    }
  }
  const kept = JSON.stringify({ see: 'line\nhttps://example.com/a?b=1' });
  assert.equal(scrubLocalPaths(kept, []), kept);
});

// Перенесено из потребителя (DevContour check-corpus AC14, AC18): правила
// корпуса и генеративного gate — правила harness.

test('AC14: реализация, подогнанная под подтверждённый случай, ловится генератором на другом входе класса; контрпример воспроизводится по seed', async () => {
  const fitted = knap.fitted(
    JSON.parse(input) as { items: { w: number; v: number }[]; cap: number },
    12,
  );
  const ctx = propertySetup({
    writer: [implement({ 'src/knap.mjs': knap.firstThree }), implement({ 'src/knap.mjs': fitted })],
  });
  await ctx.runner.init();
  await runAll(ctx);
  const ok = await ctx.runner.submitCase({
    workId: 'add-greeting',
    property: 'knapsack-optimal',
    input,
    expected: '12',
    key: 'case-first-three',
  });
  assert.equal(ok.decision.outcome, 'confirmed', ok.decision.reason);
  ctx.engine.retry('add-greeting');
  await ctx.runner.drain();
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[1]!);
  const gate = a.evidence.find((e) => e.gate === 'properties' && e.phase === 'candidate')!;
  assert.equal(gate.passed, false, 'подгонка не проходит');
  const report = gate.property!.report!;
  // Корпус пройден, но покрытие класса — генератор, и он нашёл другой вход.
  assert.equal(report.corpus?.passed, 1);
  assert.deepEqual(report.corpus?.failed, []);
  const entry = report.properties.find((p) => p.testId === 'knapsack-optimal')!;
  assert.equal(entry.status, 'failed');
  assert.equal(entry.counterexample?.case, undefined, 'вход генератора, не случай корпуса');
  assert.notEqual(
    JSON.stringify(entry.counterexample?.original),
    JSON.stringify(JSON.parse(input)),
  );
  // Тот же seed воспроизводит тот же контрпример вне контура.
  const root = mkdtempSync(join(tmpdir(), 'harness-replay-'));
  const tree = join(root, 'tree');
  ctx.repo.git('worktree', 'add', '--detach', tree, a.candidateSha!);
  try {
    const out = join(root, 'replay.json');
    // Отказ свойства — ненулевой код выхода; отчёт при этом записан.
    spawnSync(process.execPath, ['check.mjs'], {
      cwd: tree,
      env: {
        PATH: process.env.PATH,
        DEVCONTOUR_SEED: String(gate.property!.seed),
        DEVCONTOUR_PROPERTIES: 'knapsack-optimal',
        DEVCONTOUR_PROPERTY_REPORT: out,
      },
      stdio: 'ignore',
    });
    const replay = JSON.parse(readFileSync(out, 'utf8')) as typeof report;
    assert.deepEqual(replay.properties[0]!.counterexample, entry.counterexample);
  } finally {
    ctx.repo.git('worktree', 'remove', '--force', tree);
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC18: быстрый маршрут не удаляет, не заменяет ожидание и не меняет checker; тот же вход с другим ожиданием — конфликт, принятое не переписано', async () => {
  const ctx = propertySetup({ writer: implement({ 'src/knap.mjs': knap.firstThree }) });
  await ctx.runner.init();
  await runAll(ctx);
  const ok = await ctx.runner.submitCase({
    workId: 'add-greeting',
    property: 'knapsack-optimal',
    input,
    expected: '12',
    key: 'case-confirmed',
  });
  assert.equal(ok.decision.outcome, 'confirmed', ok.decision.reason);
  for (const change of ['remove', 'replace-expected', 'tolerance', 'coverage', 'checker'])
    await assert.rejects(
      ctx.runner.submitCase({
        workId: 'add-greeting',
        property: 'knapsack-optimal',
        input,
        key: 'case-change-' + change,
        change,
      }),
      (e: unknown) =>
        e instanceof HarnessError &&
        e.code === 'INVALID_INPUT' &&
        /только добавляет подтверждённые случаи/.test(e.message),
    );
  const corpus = ctx.runner.corpus;
  const suite = corpus.read(ok.suite);
  const begun = corpus.begin(suite, 'case-conflict');
  assert.ok(begun.token);
  const conflict = corpus.record(
    corpus.read(ok.suite),
    'case-conflict',
    begun.token,
    {
      property: 'knapsack-optimal',
      input,
      inputHash: 'a'.repeat(64),
      outcome: 'confirmed',
      reason: 'подделка',
      source: { sha: 'c'.repeat(40) },
      observed: { expected: '6', actual: '0', equal: false, repeats: 2, durationsMs: [] },
      origin: { kind: 'agent' },
    },
    () => 'f'.repeat(40),
    { works: ['add-greeting'], actor: 'agent' },
  );
  assert.equal(conflict.decision.outcome, 'inconclusive');
  assert.match(conflict.decision.reason, /конфликт ожиданий/);
  const after = corpus.read(ok.suite);
  assert.equal(after.versions.length, 1, 'новой версии нет');
  assert.equal(after.cases[ok.decision.caseId!]!.expected, '12', 'принятое не переписано');
});
