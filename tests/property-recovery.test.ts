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

test('Основание эпизода — формула хоста: эпизод, подписанный хостом, не закрывается выдачей как «новое основание»; формула harness закрыла бы его', async () => {
  const ctx = approved();
  const { Engine } = await import('../src/engine/engine.ts');
  const { sha256 } = await import('../src/contracts/index.ts');
  const hostBasis = (w: { approvedDigest?: string }) => sha256('host:' + (w.approvedDigest ?? ''));
  const host = new Engine({
    host: {
      ...ctx.engine.host,
      basis: { ...ctx.engine.host.basis, episodeBasis: (w) => hostBasis(w) },
    },
    policy: ctx.engine.policy,
  });
  const first = failAs(host, 'gate', [P]);
  assert.equal(
    host.read((v) => v.attempt(first.attempt.id)!.episodeBasis),
    hostBasis(work(host)),
    'попытка подписана формулой хоста',
  );
  host.retry('add-greeting');
  failAs(host, 'gate', [P]);
  const opened = work(host).recovery!;
  assert.equal(opened.basis, hostBasis(work(host)));
  host.retry('add-greeting');
  assert.equal(host.claim('c1'), undefined, 'эпизод хоста держит выдачу');
  assert.equal(work(host).recovery?.id, opened.id, 'и не закрыт как новое основание');
  // Тот же эпизод под формулой harness — «новое основание»: закрывается выдачей.
  assert.ok(ctx.engine.claim('c1'), 'формула harness отличается и эпизод закрывает');
  assert.match(work(ctx.engine).recoveryHistory!.at(-1)!.reason!, /новое основание/);
});

test('Разбор ведущего: назначение хоста (модель, профиль инструментов) и его границы доходят до вызова; окружение — с окружением профиля', async () => {
  const ctx = approved();
  const { engine } = ctx;
  failAs(engine, 'gate', [P]);
  engine.retry('add-greeting');
  failAs(engine, 'gate', [P]);
  assert.ok(work(engine).recovery);
  const { analyzeRecovery } = await import('../src/control/recovery.ts');
  const { executionPolicySchema } = await import('../src/contracts/index.ts');
  const policy = executionPolicySchema.parse({
    ...engine.policy,
    toolProfiles: {
      lead: { runtime: 'codex', environment: { values: { PROFILE_MARKER: 'lead-profile' } } },
    },
  });
  const seen: import('../src/contracts/index.ts').RuntimeRequest[] = [];
  const decision = await analyzeRecovery(
    {
      engine,
      policy,
      adapters: {
        codex: {
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
          invoke: (request) => {
            seen.push(request);
            return Promise.resolve({
              status: 'ok' as const,
              output: {
                action: 'environment',
                reason: 'Причина в окружении проверки.',
                evidence: ['лог'],
                hypothesis: null,
                plan: null,
                cases: null,
                proposal: null,
                conflict: null,
              },
              model: 'lead-model',
              runtimeVersion: null,
              text: '',
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reportedUsd: null,
                complete: true,
                source: 'fixture',
              },
              diagnostics: { exitCode: 0 },
            });
          },
        },
      },
      stateDir: ctx.state,
      cwd: ctx.repo.dir,
      binding: { model: 'lead-model', toolProfile: 'lead' },
      boundary: { hidden: ['/secret/area'], readable: ['/shared/notes'] },
    },
    work(engine),
    'codex',
    AbortSignal.timeout(10_000),
  );
  assert.equal(decision.action, 'environment');
  const request = seen[0]!;
  assert.deepEqual(request.binding, { model: 'lead-model', toolProfile: 'lead', runtime: 'codex' });
  assert.equal(request.env.PROFILE_MARKER, 'lead-profile', 'окружение профиля');
  assert.ok(request.sandbox.denied.includes('/secret/area'));
  assert.ok(request.sandbox.readable?.includes('/shared/notes'));
  assert.deepEqual(request.sandbox.writable, [], 'разбор не правит файлы');
  assert.deepEqual(
    request.subject,
    {
      workId: 'add-greeting',
      attemptId: work(engine).recovery!.runs.at(-1),
      phase: 'property-recovery',
    },
    'предмет вызова — поручение эпизода',
  );
});

test('Основание корпуса — формула хоста: прежний корпус KS-<id> хоста находится и сохраняет привязку; формула harness дала бы новый корпус', async () => {
  const ctx = approved();
  const { Engine } = await import('../src/engine/engine.ts');
  const { CorpusStore } = await import('../src/verification/corpus.ts');
  const { corpusBindingHolds, contractDocuments } = await import('../src/verification/checks.ts');
  const { sha256 } = await import('../src/contracts/index.ts');
  const hostBasis = (c: { id: string }) => sha256('host-basis:' + c.id);
  const host = new Engine({
    host: { ...ctx.engine.host, basis: { ...ctx.engine.host.basis, suiteBasis: hostBasis } },
    policy: ctx.engine.policy,
  });
  const hostCorpus = new CorpusStore(host);
  const w = work(host);
  const ref = host.read((v) => hostCorpus.suiteFor(v, w, P));
  assert.equal(ref.suite.id, 'KS-knap');
  assert.equal(ref.suite.basis, hostBasis({ id: 'knap' }), 'основание — формула хоста');
  // Корпус, записанный хостом прежде (его формулой основания).
  host.host.store.transact('checks.recorded', (tx) =>
    tx.putLocal('check-suites', ref.suite.repositoryId, ref.suite.id, {
      ...ref.suite,
      revision: 1,
    }),
  );
  const again = host.read((v) => hostCorpus.suiteFor(v, w, P));
  assert.equal(again.suite.id, 'KS-knap', 'хост находит свой прежний корпус');
  assert.equal(again.suite.revision, 1);
  const contracts = host.read((v) => contractDocuments(w.order, v));
  assert.ok(corpusBindingHolds(again.suite, contracts, hostBasis), 'привязка держится');
  // Формула harness для того же корпуса — «другое основание»: новый корпус.
  const plain = new CorpusStore(ctx.engine);
  const other = ctx.engine.read((v) => plain.suiteFor(v, w, P));
  assert.notEqual(other.suite.id, 'KS-knap');
  assert.equal(corpusBindingHolds(again.suite, contracts), false);
});
