/**
 * H02: остановка исполнителя с вопросом и продолжение после ответа.
 *
 * Writer fixture (`fake-claude`/`fake-codex`) отдаёт структурированный ответ
 * из сценария: вопрос (`inputRequest`) при `completed: false`, допущения
 * (`assumptions`). Порог вопросов — `inputPolicy` политики, закреплённый в
 * попытке при выдаче. Живых моделей нет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HarnessError,
  executionDigest,
  executionPolicySchema,
  implementationResultSchema,
  inputPolicyOf,
  sha256,
  type EventType,
  type InputOutcome,
  type InputQuestion,
  type RunEvent,
} from '../src/contracts/index.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { Engine } from '../src/engine/engine.ts';
import { Runner } from '../src/engine/runner.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { repairDecision } from '../src/engine/repair.ts';
import { blockingRequest, requestsOf } from '../src/engine/input-requests.ts';
import { evaluateInput, inputPolicyText } from '../src/engine/input-policy.ts';
import { engineOf, graphOf, policyOf, ready, trustNone, planReview } from './engine-fixture.ts';
import { bin, greet, runAll, setup } from './runner-fixture.ts';

/** Новый процесс над тем же каталогом состояния и репозиторием с другой политикой. */
function setupOver(ctx: ReturnType<typeof setup>, raw: Record<string, unknown>) {
  const policy = executionPolicySchema.parse(raw);
  const store = new SqliteExecutionStore(join(ctx.state, 'state.sqlite'), 'test');
  const engine = new Engine({ host: standaloneHost(store, policy), policy });
  const adapter = (name: 'claude' | 'codex') =>
    cliAdapter(name, { executable: bin(`fake-${name}`), toolProfiles: policy.toolProfiles });
  const runner = new Runner({
    engine,
    stateDir: ctx.state,
    baseDir: ctx.repo.dir,
    adapters: { claude: adapter('claude'), codex: adapter('codex') },
    owner: 'runner-1',
    resourceDatabase: join(ctx.state, 'resources.sqlite'),
  });
  return { policy, store, engine, runner };
}

const QUESTION_TEXT = 'Какой формат приветствия выбрать для пользователей?';

const question = (severity: number, extra: Partial<InputQuestion> = {}): InputQuestion => ({
  question: QUESTION_TEXT,
  options: [
    { id: 'hello', label: 'Hello, <name>!', consequence: null },
    { id: 'hi', label: 'Hi <name>', consequence: 'короче, но меняет текст' },
  ],
  recommended: 'hello',
  severity,
  rationale: 'Текст виден пользователю',
  affects: [],
  ...extra,
});

/** Шаг writer: правит файлы и останавливается с вопросом. */
const asks = (
  severity: number,
  extra: Partial<InputQuestion> = {},
  files: Record<string, string> = { 'src/greet.js': "exports.greet = () => 'draft';\n" },
) => ({
  files,
  result: {
    completed: false,
    summary: 'Нужен ответ',
    discoveries: [],
    inputRequest: question(severity, extra),
    assumptions: [],
  },
});

const assumption = (severity: number, affects: InputQuestion['affects'] = []) => ({
  question: 'Регистр имени?',
  chosen: 'как передано',
  rationale: 'не трогать вход',
  severity,
  affects,
});

const withThreshold =
  (threshold: number, criticalPaths: string[] = []) =>
  (p: Record<string, unknown>) => {
    p.inputPolicy = { threshold, criticalPaths };
  };

const ofType = <T extends EventType>(events: RunEvent[], type: T) =>
  events.flatMap((e) => (e.type === type ? [e as Extract<RunEvent, { type: T }>] : []));

const W = 'add-greeting';

function stateOf(ctx: ReturnType<typeof setup>) {
  return ctx.engine.read((v) => ({
    work: v.work(W)!,
    attempts: v.attempts(W),
    requests: requestsOf(v, v.work(W)),
  }));
}

/* ------------------------------------------------------------------ */
/* Остановка (S2)                                                      */
/* ------------------------------------------------------------------ */

test('H02-A: вопрос не ниже порога — needs-input, процесс завершён, попытка засчитана, автоповтора нет', async () => {
  const ctx = setup({ scenario: { writer: [asks(8), asks(8)] }, policy: withThreshold(7) });
  await runAll(ctx);
  const { work, attempts, requests } = stateOf(ctx);
  assert.deepEqual(
    attempts.map((a) => [a.status, a.failureKind]),
    [['failed', 'needs-input']],
  );
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'needs-input');
  assert.equal(work.attempt, 1, 'попытка засчитана');
  assert.equal(work.activeRunId, undefined, 'владения нет');
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request!.kind, 'question');
  assert.equal(request!.blocking, true);
  assert.equal(request!.lifecycle, 'pending');
  assert.equal(request!.effectiveSeverity, 8);
  assert.deepEqual(request!.floors, []);
  assert.equal(request!.runId, attempts[0]!.id);
  assert.equal(request!.originBasis.inputPolicy.threshold, 7);
  // Вызов исполнителя записан и в учёте, и в запросе: бюджет вызова учтён.
  const calls = ctx.engine.read((v) =>
    v.locals('usage').filter((c) => c.value.runId === attempts[0]!.id),
  );
  assert.ok(calls.some((c) => c.value.id === request!.callId));
  // Автоматического восстановления нет: ни повтора, ни остановки задания.
  assert.equal(
    ctx.engine.read((v) => repairDecision(v, [work], { budgetLeft: 10, maxAttempts: 3 })),
    undefined,
  );
  ctx.engine.resume();
  await ctx.runner.drain();
  assert.equal(stateOf(ctx).attempts.length, 1, 'новая попытка без ответа не выдана');
  // Текста вопроса нет ни в событиях, ни в причине отказа.
  const events = ctx.store.events(0, 500);
  assert.doesNotMatch(JSON.stringify(events), /Какой формат приветствия/);
  assert.doesNotMatch(work.failure ?? '', /Какой формат приветствия/);
  const [requested] = ofType(events, 'input.requested');
  assert.equal(requested!.payload.requestId, request!.id);
  assert.equal(requested!.payload.blocking, true);
});

for (const [severity, expected] of [
  [6, 'unfinished'],
  [7, 'needs-input'],
  [8, 'needs-input'],
] as const)
  test(`inputPolicy: порог 7, самооценка ${severity} — ${expected}`, async () => {
    const ctx = setup({ scenario: { writer: asks(severity) }, policy: withThreshold(7) });
    await runAll(ctx);
    const { work, requests } = stateOf(ctx);
    assert.equal(work.failureKind, expected);
    assert.equal(requests.length, 1);
    if (expected === 'unfinished') {
      // Вопрос ниже порога — нарушение запроса: записан отклонённым, работу не держит.
      assert.equal(requests[0]!.blocking, false);
      assert.equal(requests[0]!.lifecycle, 'cancelled');
      assert.equal(requests[0]!.closed?.by, 'controller');
      assert.equal(
        ctx.engine.read((v) => blockingRequest(v, work)),
        undefined,
      );
      assert.equal(ctx.engine.retry(W).changed, true, 'обычный повтор доступен');
    } else {
      assert.equal(requests[0]!.lifecycle, 'pending');
      assert.equal(requests[0]!.blocking, true);
    }
  });

test('inputPolicy: объявленная критическая область поднимает самооценку 2 до 10 (floor declared)', async () => {
  const ctx = setup({
    scenario: { writer: asks(2, { affects: ['api'] }) },
    policy: withThreshold(7),
  });
  await runAll(ctx);
  const { work, requests } = stateOf(ctx);
  assert.equal(work.failureKind, 'needs-input');
  assert.equal(requests[0]!.effectiveSeverity, 10);
  assert.equal(requests[0]!.question.severity, 2, 'самооценка сохранена как есть');
  assert.deepEqual(requests[0]!.floors, ['declared']);
});

test('inputPolicy: изменённый критический путь поднимает самооценку 3 до 10 (floor critical-path)', async () => {
  const ctx = setup({ scenario: { writer: asks(3) }, policy: withThreshold(7, ['src']) });
  await runAll(ctx);
  const { work, requests } = stateOf(ctx);
  assert.equal(work.failureKind, 'needs-input');
  assert.equal(requests[0]!.effectiveSeverity, 10);
  assert.deepEqual(requests[0]!.floors, ['critical-path']);
  assert.deepEqual(requests[0]!.criticalHits, ['src/greet.js']);
});

test('inputPolicy: порог 1 — любой вопрос останавливает', async () => {
  const ctx = setup({ scenario: { writer: asks(1) }, policy: withThreshold(1) });
  await runAll(ctx);
  assert.equal(stateOf(ctx).work.failureKind, 'needs-input');
});

test('inputPolicy: порог 11 — автономно: остановок нет, все допущения записаны, критическое — неблокирующий запрос, согласование не меняется', async () => {
  const ctx = setup({
    scenario: {
      writer: {
        files: { 'src/greet.js': greet },
        result: {
          completed: true,
          summary: 'Добавлена greet',
          discoveries: [],
          inputRequest: null,
          assumptions: [assumption(9, ['contract']), assumption(2)],
        },
      },
      reviewer: {
        result: {
          approved: true,
          summary: 'ok',
          findings: [],
          discoveries: [],
          execution: { commands: [], noCommandsReason: 'diff' },
          previous: [],
        },
      },
    },
    policy: withThreshold(11),
  });
  const graph = await runAll(ctx);
  const approvalBefore = ctx.engine.read((v) => v.graph(graph.id)!.approval);
  const { work, attempts, requests } = stateOf(ctx);
  assert.equal(work.status, 'done', 'автономный режим не останавливается');
  assert.deepEqual(
    attempts[0]!.assumptions!.map((a) => [a.effectiveSeverity, a.floors]),
    [
      [10, ['declared']],
      [2, []],
    ],
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.kind, 'follow-up');
  assert.equal(requests[0]!.blocking, false);
  assert.equal(requests[0]!.lifecycle, 'pending');
  assert.deepEqual(
    ctx.engine.read((v) => v.graph(graph.id)!.approval),
    approvalBefore,
  );
  const [summary] = ofType(ctx.store.events(0, 500), 'attempt.assumptions');
  assert.deepEqual(
    { ...summary!.payload, digest: undefined },
    { count: 2, maxSeverity: 10, floors: 1, followUps: 1, digest: undefined },
  );
  assert.doesNotMatch(JSON.stringify(ctx.store.events(0, 500)), /Регистр имени/);
});

test('inputPolicy: готово, но развилка не ниже порога — needs-input без кандидата, черновик сохранён', async () => {
  const ctx = setup({
    scenario: {
      writer: {
        files: { 'src/greet.js': greet },
        result: {
          completed: true,
          summary: 'Добавлена greet',
          discoveries: [],
          inputRequest: null,
          assumptions: [assumption(8)],
        },
      },
    },
    policy: withThreshold(7),
  });
  await runAll(ctx);
  const { work, attempts, requests } = stateOf(ctx);
  assert.equal(work.failureKind, 'needs-input');
  assert.equal(attempts[0]!.candidateSha, undefined, 'кандидата нет');
  assert.ok(attempts[0]!.partial, 'черновик сохранён');
  assert.equal(requests[0]!.draft?.digest, attempts[0]!.partial.digest);
  assert.deepEqual(requests[0]!.question.options, [
    { id: 'chosen', label: 'как передано', consequence: null },
  ]);
  assert.deepEqual(attempts[0]!.assumptions!.length, 1);
});

test('Ответ writer: completed=true вместе с вопросом невалиден; без новых полей — прежний формат', () => {
  const base = { completed: true, summary: 's', discoveries: [] };
  assert.equal(
    implementationResultSchema.safeParse({ ...base, inputRequest: question(5) }).success,
    false,
  );
  const old = implementationResultSchema.parse(base);
  assert.deepEqual(old.assumptions, []);
  assert.equal(old.inputRequest, undefined);
  assert.equal(
    implementationResultSchema.safeParse({
      ...base,
      completed: false,
      inputRequest: question(5, { recommended: 'nope' }),
    }).success,
    false,
    'рекомендуемый вариант — из вариантов',
  );
});

test('inputPolicy вне executionDigest и закрепляется в попытке при выдаче; текст запроса называет порог', () => {
  const p7 = policyOf((p) => (p.inputPolicy = { threshold: 7, criticalPaths: [] }));
  const p3 = policyOf((p) => (p.inputPolicy = { threshold: 3, criticalPaths: ['src'] }));
  const none = policyOf();
  assert.equal(executionDigest(p7), executionDigest(p3));
  assert.equal(executionDigest(p7), executionDigest(none));
  assert.deepEqual(inputPolicyOf(none), { threshold: 7, criticalPaths: [] });
  const { engine } = engineOf(p3);
  ready(engine, graphOf({ a: [] }));
  const attempt = engine.claim('c1')!;
  assert.deepEqual(attempt.inputPolicy, { threshold: 3, criticalPaths: ['src'] });
  assert.match(inputPolicyText(attempt.inputPolicy), /input threshold 3/);
  assert.match(inputPolicyText({ threshold: 11, criticalPaths: [] }), /You never stop to ask/);
  // Исход определяется закреплённым порогом, а не текущей политикой.
  const output = { completed: false, inputRequest: question(5), assumptions: [] };
  assert.equal(evaluateInput(output, attempt.inputPolicy, []).decision.kind, 'stop');
  assert.equal(evaluateInput(output, inputPolicyOf(p7), []).decision.kind, 'declined');
});

test('inputPolicy: смена порога действует со следующей попытки', async () => {
  const ctx = setup({ scenario: { writer: [asks(5), asks(5)] }, policy: withThreshold(7) });
  await runAll(ctx);
  assert.equal(stateOf(ctx).work.failureKind, 'unfinished', 'порог 7: вопрос 5 — не остановка');
  ctx.store.close();
  // Новый процесс с порогом 4: попытка 2 закрепляет его.
  const raw = structuredClone(ctx.policy) as unknown as Record<string, unknown>;
  raw.inputPolicy = { threshold: 4, criticalPaths: [] };
  const next = setupOver(ctx, raw);
  next.engine.retry(W);
  await next.runner.init();
  next.engine.resume();
  await next.runner.drain();
  const attempts = next.engine.read((v) => v.attempts(W));
  assert.deepEqual(
    attempts.map((a) => [a.inputPolicy?.threshold, a.failureKind]),
    [
      [7, 'unfinished'],
      [4, 'needs-input'],
    ],
  );
});

/* ------------------------------------------------------------------ */
/* Черновик и область (H02-J), атомарность (H02-B), блокер (H02-C)     */
/* ------------------------------------------------------------------ */

test('H02-J: допустимая правка и вопрос — после рестарта черновик доступен по digest', async () => {
  const ctx = setup({ scenario: { writer: asks(9) }, policy: withThreshold(7) });
  await runAll(ctx);
  const runId = stateOf(ctx).attempts[0]!.id;
  ctx.store.close();
  const reopened = new SqliteExecutionStore(join(ctx.state, 'state.sqlite'), 'test');
  const { attempt, request } = reopened.read((v) => ({
    attempt: v.attempt(runId)!,
    request: v.locals('input-requests')[0]!.value,
  }));
  reopened.close();
  assert.ok(attempt.partial);
  assert.equal(request.draft?.digest, attempt.partial.digest);
  assert.deepEqual(request.draft?.files, ['src/greet.js']);
  assert.equal(sha256(readFileSync(attempt.partial.patch, 'utf8')), attempt.partial.digest);
});

test('H02-J: правка вне области и вопрос — нарушение области, а не needs-input; запроса нет', async () => {
  const ctx = setup({
    scenario: { writer: asks(9, {}, { 'README.md': 'changed\n' }) },
    policy: withThreshold(7),
  });
  await runAll(ctx);
  const { work, requests } = stateOf(ctx);
  assert.equal(work.failureKind, 'scope-violation');
  assert.deepEqual(requests, []);
});

const outcome = (severity = 8): InputOutcome => ({
  question: {
    question: question(severity),
    effectiveSeverity: severity,
    floors: [],
    mode: 'request',
  },
  assumptions: [],
  followUps: [],
  criticalHits: [],
  callId: 'call-1',
});

test('H02-B: запрос и отказ попытки — одна транзакция: неверный запрос не оставляет ни отказа, ни запроса', () => {
  const { engine, store } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  const before = store.events(0, 500).length;
  const broken = outcome();
  broken.question!.question = { ...broken.question!.question, recommended: 'nope' };
  assert.throws(() => engine.fail(a.id, a.token, 'вопрос', { kind: 'needs-input', input: broken }));
  assert.equal(
    engine.read((v) => v.attempt(a.id)!.status),
    'active',
    'попытка не закончена',
  );
  assert.deepEqual(
    engine.read((v) => v.locals('input-requests')),
    [],
  );
  assert.equal(store.events(0, 500).length, before);
  engine.fail(a.id, a.token, 'вопрос', { kind: 'needs-input', input: outcome() });
  const after = store
    .events(0, 500)
    .slice(before)
    .map((e) => e.type);
  assert.deepEqual(after, ['attempt.failed', 'attempt.diagnosed', 'input.requested']);
  assert.equal(
    engine.read((v) => v.attempt(a.id)!.status),
    'failed',
  );
});

test('H02-C: без ответа ни повтор, ни сброс, ни снятие чужого удержания, ни новая редакция графа не продолжают работу', () => {
  const { engine, clock } = engineOf();
  const graph = graphOf({ a: [], b: [] });
  ready(engine, graph);
  const a = engine.claim('c1')!;
  engine.fail(a.id, a.token, 'вопрос', { kind: 'needs-input', input: outcome() });
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'ok';
    } catch (e) {
      return (e as HarnessError).code;
    }
  };
  assert.equal(
    code(() => engine.retry(a.workId)),
    'INPUT_REQUIRED',
  );
  assert.equal(
    code(() => engine.retry(a.workId, { reason: 'сброс' })),
    'INPUT_REQUIRED',
  );
  // Чужое удержание и его снятие ожидания ответа не снимают.
  engine.hold([a.workId], 'op-1', 'операция');
  engine.releaseHold('op-1');
  assert.ok(
    engine
      .read((v) => engine.blockers(v.work(a.workId)!, v))
      .some((b) => b.code === 'INPUT_REQUIRED'),
  );
  // Новая редакция графа делает поручение черновиком, согласование — готовым,
  // но выдачи нет, пока вопрос открыт.
  const next = graphOf({ a: [], b: [] }, '2');
  const { graph: state } = engine.register(next, trustNone);
  engine.recordReview(planReview(engine, state, engine.reviews('plan', state.id).length + 1));
  engine.approve(state.id, 'agent');
  clock.now += 1000;
  const claimed = [engine.claim('c1'), engine.claim('c1')].filter(Boolean).map((x) => x!.workId);
  assert.ok(!claimed.includes(a.workId), 'поручение с вопросом не выдано');
  assert.equal(
    engine.read((v) => v.work(a.workId)!.status),
    'ready',
  );
});
