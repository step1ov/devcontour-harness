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
  WORKSPACE_OWNER,
  contextDigest,
  latestAnswer,
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
import {
  blockingRequest,
  inputContextSource,
  inputManifestOf,
  requestsOf,
  withInput,
} from '../src/engine/input-requests.ts';
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

/* ------------------------------------------------------------------ */
/* Ответ и продолжение (S3)                                            */
/* ------------------------------------------------------------------ */

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    return e.code;
  }
};

/** Граф a, b; попытка `a` остановилась с вопросом. */
function stopped(patch: (p: Record<string, unknown>) => void = () => {}) {
  const env = engineOf(policyOf(patch));
  const graph = ready(env.engine, graphOf({ a: [], b: [] }));
  const attempt = env.engine.claim('c1')!;
  assert.equal(attempt.workId, 'a');
  env.engine.fail(attempt.id, attempt.token, 'вопрос', { kind: 'needs-input', input: outcome() });
  const [request] = env.engine.inputRequests({ workId: 'a' });
  return { ...env, graph, attempt, request: request! };
}

/**
 * Ответ, снимок контекста с ним (по digest в `context-snapshots`) и раунд
 * ревью плана этого снимка; ничего не активирует.
 */
function prepare(
  env: ReturnType<typeof stopped>,
  text = 'Hello, <name>!',
  approved = true,
  messages: { id: string; revision: number; digest: string }[] = [],
) {
  const current = env.engine.inputRequest(env.request.id);
  const answered =
    latestAnswer(current)?.text === text
      ? current
      : env.engine.answerInput(
          env.request.id,
          { text, optionId: 'hello', actor: { kind: 'operator' } },
          current.version,
        ).request;
  const snapshot = withInput(
    undefined,
    inputContextSource(answered, latestAnswer(answered)!, messages),
  );
  const digest = contextDigest(snapshot);
  env.store.transact('run.context', (tx) =>
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
  );
  env.engine.recordReview({
    ...planReview(
      env.engine,
      env.graph,
      env.engine.reviews('plan', env.graph.id).length + 1,
      approved,
    ),
    contextDigest: digest,
  });
  const proposal = env.engine.proposeTarget(env.request.id, digest);
  return { answered, snapshot, digest, proposal };
}

const applyWith = (
  env: ReturnType<typeof stopped>,
  prepared: ReturnType<typeof prepare>,
  extra: Partial<Parameters<Engine['applyInput']>[1]> = {},
) =>
  env.engine.applyInput(env.request.id, {
    answerDigest: latestAnswer(prepared.answered)!.digest,
    expectedVersion: prepared.answered.version,
    contextDigest: prepared.digest,
    targetDigest: prepared.proposal.target!.digest,
    actor: 'agent',
    ...extra,
  });

test('Ответ: новая неизменяемая версия; повтор того же — без записи; CAS версии; закрытый — отказ', () => {
  const env = stopped();
  const r = env.request;
  const first = env.engine.answerInput(r.id, { text: 'ISO', actor: { kind: 'operator' } }, 1);
  assert.equal(first.changed, true);
  assert.equal(first.request.lifecycle, 'answered');
  assert.equal(first.request.version, 2);
  // Повтор после обрыва связи (прежняя версия) — тот же ответ.
  const again = env.engine.answerInput(r.id, { text: 'ISO', actor: { kind: 'operator' } }, 1);
  assert.equal(again.changed, false);
  assert.equal(again.answer.digest, first.answer.digest);
  assert.equal(
    code(() => env.engine.answerInput(r.id, { text: 'Unix', actor: { kind: 'lead' } }, 1)),
    'REVISION_CONFLICT',
  );
  const second = env.engine.answerInput(r.id, { text: 'Unix', actor: { kind: 'lead' } }, 2);
  assert.deepEqual(
    second.request.answers.map((a) => [a.revision, a.text]),
    [
      [1, 'ISO'],
      [2, 'Unix'],
    ],
  );
  assert.equal(
    code(() =>
      env.engine.answerInput(r.id, { text: 'x', optionId: 'nope', actor: { kind: 'lead' } }, 3),
    ),
    'INVALID_INPUT',
  );
  // Ответ не снимает блокировку: повтор и выдача по-прежнему закрыты.
  assert.equal(
    code(() => env.engine.retry('a')),
    'INPUT_REQUIRED',
  );
  env.engine.cancelInput(r.id, { by: 'operator', reason: 'не нужен' }, 3);
  assert.equal(
    code(() => env.engine.answerInput(r.id, { text: 'поздно', actor: { kind: 'operator' } }, 4)),
    'NOT_READY',
  );
  const events = env.store.events(0, 500).filter((e) => e.type.startsWith('input.'));
  assert.deepEqual(
    events.map((e) => e.type),
    ['input.requested', 'input.answered', 'input.answered', 'input.closed'],
  );
  assert.doesNotMatch(JSON.stringify(events), /Unix|ISO/, 'текста ответа в событиях нет');
});

test('H02-C: ответ без нового ревью и согласования, подстановка старого контекста и обходное согласование не продолжают работу', () => {
  const env = stopped();
  const answered = env.engine.answerInput(
    env.request.id,
    { text: 'Hello', optionId: 'hello', actor: { kind: 'operator' } },
    1,
  ).request;
  const answer = latestAnswer(answered)!;
  // Без ревью снимка с ответом: последний раунд — исходный, без контекста.
  const old = env.engine.proposeTarget(env.request.id, null);
  assert.ok(old.problems.length, 'предложение называет причины');
  assert.equal(
    code(() =>
      env.engine.applyInput(env.request.id, {
        answerDigest: answer.digest,
        expectedVersion: answered.version,
        contextDigest: null,
        targetDigest: old.target!.digest,
        actor: 'agent',
      }),
    ),
    'INVALID_INPUT',
    'снимок без ответа не применяется',
  );
  // Обычное согласование графа не возобновляет работу и не снимает блокировку.
  env.engine.approve(env.graph.id, 'agent');
  assert.equal(
    code(() => env.engine.retry('a')),
    'INPUT_REQUIRED',
  );
  // Ревью снимка с ответом есть, но активировать его согласованием в обход
  // applyInput нельзя.
  const prepared = prepare(env, 'Hello');
  assert.equal(
    code(() => env.engine.approve(env.graph.id, 'agent', { bindContext: true })),
    'INPUT_REQUIRED',
  );
  assert.equal(
    env.engine.read((v) => v.graph(env.graph.id)!.approval?.context),
    undefined,
  );
  // Подстановка старого digest контекста при новом раунде — отказ.
  assert.equal(
    code(() => applyWith(env, prepared, { contextDigest: null })),
    'APPROVAL_REQUIRED',
  );
  assert.equal(
    env.engine.read((v) => v.work('a')!.status),
    'failed',
  );
  assert.equal(applyWith(env, prepared).applied, true);
});

test('H02-D: снимок с ответом проходит ревью и применяется; manifest называет точные версии ответа и сообщений', () => {
  const env = stopped();
  const messages = [{ id: 'msg-7', revision: 2, digest: sha256('сообщение') }];
  const prepared = prepare(env, 'Hello, <name>!', true, messages);
  const source = prepared.snapshot.sources.find((s) => s.kind === 'input-answer')!;
  assert.deepEqual(inputManifestOf(source), {
    requestId: env.request.id,
    answerDigest: latestAnswer(prepared.answered)!.digest,
    revision: 1,
    messages,
  });
  assert.equal(source.version, 'r1', 'версия обсуждения — в version, не в revision');
  assert.equal(source.revision, undefined);
  assert.deepEqual(prepared.proposal.problems, []);
  const result = applyWith(env, prepared);
  assert.equal(result.applied, true);
  assert.equal(result.changed, true);
  const after = env.engine.read((v) => ({
    graph: v.graph(env.graph.id)!,
    work: v.work('a')!,
    request: env.engine.inputRequest(env.request.id),
  }));
  assert.equal(after.graph.approval?.context?.digest, prepared.digest);
  assert.equal(after.work.status, 'ready');
  assert.equal(after.work.attempt, 1, 'попытки не сброшены');
  assert.equal(after.request.lifecycle, 'applied');
  assert.equal(after.request.target?.contextDigest, prepared.digest);
  assert.equal(after.request.target?.review?.round, 2);
  // Выдача закрепляет снимок с ответом и связывает ответ с попыткой.
  env.clock.now += 1000;
  const next = env.engine.claim('c1')!;
  assert.equal(next.workId, 'a');
  assert.equal(next.pinned?.contextDigest, prepared.digest);
  assert.deepEqual(next.input, {
    requestId: env.request.id,
    answerDigest: latestAnswer(prepared.answered)!.digest,
    targetDigest: after.request.target.digest,
  });
  assert.equal(env.engine.inputRequest(env.request.id).delivered, undefined, 'claim — не доставка');
});

test('H02-E: гонки — answer/cancel, два apply, apply после смены основания, устаревший ответ', () => {
  // answer и cancel одной версии: исход один.
  const race = stopped();
  const answered = race.engine.answerInput(
    race.request.id,
    { text: 'A', actor: { kind: 'operator' } },
    1,
  );
  assert.equal(
    code(() => race.engine.cancelInput(race.request.id, { by: 'lead', reason: 'x' }, 1)),
    'REVISION_CONFLICT',
    'отмена по устаревшей версии отклонена',
  );
  assert.equal(race.engine.inputRequest(race.request.id).lifecycle, 'answered');
  assert.equal(answered.changed, true);

  // Два apply: второй — тот же результат без второй записи и второй попытки.
  const env = stopped();
  const prepared = prepare(env);
  const one = applyWith(env, prepared);
  const two = applyWith(env, prepared);
  assert.equal(one.changed, true);
  assert.equal(two.applied, true);
  assert.equal(two.changed, false);
  assert.equal(env.store.events(0, 500).filter((e) => e.type === 'input.applied').length, 1);
  assert.equal(env.store.events(0, 500).filter((e) => e.type === 'work.retried').length, 1);

  // Основание сменилось после предложения (новый раунд ревью) — устаревшее.
  const moved = stopped();
  const p = prepare(moved);
  moved.engine.recordReview({
    ...planReview(
      moved.engine,
      moved.graph,
      moved.engine.reviews('plan', moved.graph.id).length + 1,
    ),
    contextDigest: p.digest,
  });
  assert.equal(
    code(() => applyWith(moved, p)),
    'APPROVAL_STALE',
  );
  // Новый ответ после снимка: снимок несёт прежнюю версию — не применяется.
  const re = stopped();
  const first = prepare(re, 'v1');
  const v2 = re.engine.answerInput(
    re.request.id,
    { text: 'v2', actor: { kind: 'operator' } },
    first.answered.version,
  ).request;
  assert.equal(
    code(() => applyWith(re, first)),
    'REVISION_CONFLICT',
  );
  assert.equal(
    code(() => applyWith(re, first, { expectedVersion: v2.version })),
    'APPROVAL_STALE',
    'применяется только последний ответ',
  );
  // Работа отменена — её вопрос закрыт, поздний apply ничего не возобновляет.
  const gone = stopped();
  const g = prepare(gone);
  gone.engine.cancel('a', 'отменено', 'operator');
  assert.equal(gone.engine.inputRequest(gone.request.id).lifecycle, 'cancelled');
  assert.equal(
    code(() => applyWith(gone, g)),
    'NOT_READY',
  );
  assert.equal(
    gone.engine.read((v) => v.work('a')!.status),
    'cancelled',
  );
  // Изменение требований — не продолжение.
  const change = stopped();
  const c = change.engine.answerInput(
    change.request.id,
    { text: 'Новые критерии', kind: 'requirement-change', actor: { kind: 'operator' } },
    1,
  ).request;
  assert.equal(change.engine.proposeTarget(change.request.id, null).problems.length > 0, true);
  const sup = change.engine.supersedeInput(
    change.request.id,
    { by: 'lead', reason: 'новая ревизия', successor: 'a-v2' },
    c.version,
  );
  assert.equal(sup.request.lifecycle, 'superseded');
  assert.equal(sup.request.closed?.successor, 'a-v2');
});

test('H02-E: смена политики после предложения — основание устарело, применения нет', () => {
  const env = stopped();
  const prepared = prepare(env);
  // Процесс с другой исполнительной политикой над тем же хранилищем.
  const other = engineOf(
    policyOf((p) => (p.maxAttempts = 5)),
    env.dir,
  );
  assert.equal(
    code(() => applyWith({ ...env, engine: other.engine }, prepared)),
    'APPROVAL_STALE',
    'процесс не с применённой политикой не применяет',
  );
  // Даже вправе принять свою политику, он получил бы другое основание продолжения.
  assert.notEqual(
    other.engine.read((v) => other.engine.host.basis.policyDigest(v.work('a')!, v)),
    prepared.proposal.target!.policyDigest,
  );
  assert.equal(env.engine.inputRequest(env.request.id).lifecycle, 'answered');
});

test('H02-F: пауза оператора, чужое удержание, бюджет и предел попыток остаются после ответа', () => {
  // Пауза и удержание: apply возвращает в очередь, но выдачи нет.
  const env = stopped();
  const prepared = prepare(env);
  env.engine.pause('operator');
  env.engine.hold(['a'], 'op-1', 'операция');
  assert.equal(applyWith(env, prepared).applied, true);
  const control = env.engine.read((v) => v.control());
  assert.equal(control.paused, true);
  assert.equal(control.pauseReason, 'operator');
  assert.equal(
    env.engine.read((v) => v.work('a')!.hold?.operation),
    'op-1',
  );
  assert.equal(env.engine.claim('c1'), undefined, 'пауза держит выдачу');

  // Предел попыток: ответ сохранён, apply не продолжает и попыток не добавляет.
  const tight = stopped((p) => (p.maxAttempts = 1));
  const t = prepare(tight);
  const refused = applyWith(tight, t);
  assert.equal(refused.applied, false);
  assert.equal(refused.applied === false && refused.blocker?.code, 'ATTEMPTS_EXHAUSTED');
  assert.equal(tight.engine.inputRequest(tight.request.id).lifecycle, 'answered');
  assert.equal(
    tight.engine.read((v) => v.work('a')!.attempt),
    1,
  );
  assert.equal(
    tight.engine.read((v) => v.work('a')!.status),
    'failed',
  );
  // Явный сброс с причиной — то же правило, что у retry.
  const reset = applyWith(tight, t, { reset: { reason: 'ответ получен' } });
  assert.equal(reset.applied, true);
  assert.equal(
    tight.engine.read((v) => v.work('a')!.attempt),
    0,
  );

  // Бюджет: неизвестная стоимость вызовов при onUnknown=stop держит продолжение.
  const budget = stopped((p) => (p.budgets = { work: { usd: 1 }, onUnknown: 'stop' }));
  budget.store.transact('usage.recorded', (tx) =>
    tx.putLocal('usage', 'app', 'call-x', {
      id: 'call-x',
      repositoryId: 'app',
      runId: budget.attempt.id,
      workId: 'a',
      stage: 'implementation',
      runtime: 'claude',
      model: null,
      runtimeVersion: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      outcome: 'returned',
      promptBytes: 1,
      promptDigest: sha256('p'),
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reportedUsd: null,
        complete: false,
        source: 'unavailable',
      },
      costUsd: 5,
      costSource: 'provider-reported',
    }),
  );
  const b = prepare(budget);
  const blocked = applyWith(budget, b);
  assert.equal(blocked.applied, false);
  assert.equal(blocked.applied === false && blocked.blocker?.code, 'BUDGET_EXHAUSTED');
  assert.equal(budget.engine.inputRequest(budget.request.id).lifecycle, 'answered');
});

test('H02-I: соседняя активная попытка сохраняет согласование; новый контекст не активируется до её окончания', () => {
  const env = stopped();
  env.clock.now += 1000;
  const sibling = env.engine.claim('c1')!;
  assert.equal(sibling.workId, 'b');
  const before = env.engine.read((v) => v.graph(env.graph.id)!.approval);
  const prepared = prepare(env);
  // Подготовка ревью ответа согласования соседа не меняет.
  assert.deepEqual(
    env.engine.read((v) => v.graph(env.graph.id)!.approval),
    before,
  );
  assert.ok(prepared.proposal.problems.some((p) => p.includes(sibling.id)));
  const waiting = applyWith(env, prepared);
  assert.equal(waiting.applied, false);
  assert.deepEqual('active' in waiting && waiting.active, [{ id: sibling.id, workId: 'b' }]);
  assert.equal(
    code(() => env.engine.approve(env.graph.id, 'agent', { bindContext: true })),
    'INPUT_REQUIRED',
    'обходное согласование тоже не активирует',
  );
  assert.deepEqual(
    env.engine.read((v) => v.graph(env.graph.id)!.approval),
    before,
  );
  assert.equal(env.engine.inputRequest(env.request.id).lifecycle, 'answered');
  env.engine.fail(sibling.id, sibling.token, 'отказ', { kind: 'gate' });
  assert.equal(applyWith(env, prepared).applied, true);
});

test('H02-K: доставку подтверждает только начало вызова; падения между apply, claim и вызовом её не создают; смена основания не приписывает ответ', () => {
  const env = stopped();
  const prepared = prepare(env);
  applyWith(env, prepared);
  env.clock.now += 1000;
  const first = env.engine.claim('c1')!;
  assert.ok(first.input);
  // Падение между claim и вызовом: владение истекает, доставки нет.
  env.clock.now += 120_000;
  env.engine.expire();
  assert.equal(env.engine.inputRequest(env.request.id).delivered, undefined);
  // Повтор apply — тот же результат, второй попытки он не создаёт.
  assert.equal(applyWith(env, prepared).changed, false);
  env.engine.lead('c1');
  env.engine.retry('a');
  env.clock.now += 1000;
  const second = env.engine.claim('c1')!;
  assert.equal(second.workId, 'a');
  assert.ok(second.input, 'основание прежнее — ответ связан');
  assert.equal(env.engine.inputDelivered(second.id, second.token, 'call-9'), true);
  assert.equal(env.engine.inputDelivered(second.id, second.token, 'call-10'), false, 'один раз');
  const delivered = env.engine.inputRequest(env.request.id).delivered!;
  assert.deepEqual([delivered.runId, delivered.callId], [second.id, 'call-9']);
  assert.equal(env.store.events(0, 500).filter((e) => e.type === 'input.delivered').length, 1);
  // Смена основания после apply: ответ новой попытке не приписывается.
  const moved = stopped();
  const m = prepare(moved);
  applyWith(moved, m);
  moved.engine.recordReview(
    planReview(moved.engine, moved.graph, moved.engine.reviews('plan', moved.graph.id).length + 1),
  );
  moved.engine.approve(moved.graph.id, 'agent', { bindContext: true });
  moved.clock.now += 1000;
  const unrelated = moved.engine.claim('c1')!;
  assert.equal(unrelated.workId, 'a');
  assert.equal(unrelated.input, undefined);
  assert.equal(moved.engine.inputDelivered(unrelated.id, unrelated.token, 'call-1'), false);
  assert.equal(moved.engine.inputRequest(moved.request.id).delivered, undefined);
});

test('H02-G: состояние без вопросов (формы alpha.35) читается: запросов нет, выдача и повтор как прежде', () => {
  const { engine, store, dir } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  engine.fail(a.id, a.token, 'проверка', { kind: 'gate' });
  // Попытка в форме alpha.35: без полей H02.
  store.transact('run.phase', (tx) => {
    const old = { ...tx.attempt(a.id)! };
    delete old.inputPolicy;
    delete old.assumptions;
    delete old.input;
    if (old.pinned) {
      const pinned = { ...old.pinned };
      delete pinned.contextDigest;
      old.pinned = pinned;
    }
    tx.putAttempt(old);
  });
  store.close();
  const reopened = engineOf(policyOf(), dir);
  assert.deepEqual(reopened.engine.inputRequests(), []);
  const work = reopened.engine.read((v) => v.work('a')!);
  assert.ok(
    !reopened.engine
      .read((v) => reopened.engine.blockers(work, v))
      .some((b) => b.code === 'INPUT_REQUIRED'),
  );
  assert.equal(reopened.engine.retry('a').changed, true);
  assert.equal(
    reopened.engine.read((v) => v.attempt(a.id)!.inputPolicy),
    undefined,
  );
});

/** Шаг reviewer с записью запроса. */
const reviewOk = (recordPrompt = false) => ({
  recordPrompt,
  result: {
    approved: true,
    summary: 'ok',
    findings: [],
    discoveries: [],
    execution: { commands: [], noCommandsReason: 'diff' },
    previous: [],
  },
});

test('H02-D/K: следующая попытка и оба ревью получают ровно закреплённый снимок с ответом; доставка — по вызову writer', async () => {
  const ctx = setup({
    scenario: {
      writer: [
        asks(9),
        {
          recordPrompt: true,
          observe: ['src/greet.js'],
          files: { 'src/greet.js': greet },
          result: { completed: true, summary: 'Добавлена greet', discoveries: [] },
        },
      ],
      reviewer: [reviewOk(true), reviewOk(true)],
    },
    policy: withThreshold(7),
  });
  const graph = await runAll(ctx);
  const [request] = ctx.engine.inputRequests({ workId: W });
  const answered = ctx.engine.answerInput(
    request!.id,
    {
      text: 'Use the greeting Hello, <name>! exactly',
      optionId: 'hello',
      actor: { kind: 'operator' },
    },
    request!.version,
  ).request;
  const snapshot = withInput(undefined, inputContextSource(answered, latestAnswer(answered)!));
  const digest = contextDigest(snapshot);
  ctx.store.transact('run.context', (tx) =>
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
  );
  ctx.engine.recordReview({
    ...planReview(ctx.engine, graph, ctx.engine.reviews('plan', graph.id).length + 1),
    authorRuntime: ctx.policy.roles.developer!.writer.runtime,
    reviewerRuntime: ctx.policy.review.plan.reviewer.runtime,
    reviewerBinding: ctx.engine.reviewerBinding(
      'plan',
      ctx.policy.roles.developer!.writer.runtime,
    )!,
    contextDigest: digest,
  });
  const proposal = ctx.engine.proposeTarget(request!.id, digest);
  assert.deepEqual(proposal.problems, []);
  const applied = ctx.engine.applyInput(request!.id, {
    answerDigest: latestAnswer(answered)!.digest,
    expectedVersion: answered.version,
    contextDigest: digest,
    targetDigest: proposal.target!.digest,
    actor: 'agent',
  });
  assert.equal(applied.applied, true);
  // Переписка после снимка снимок не меняет: он неизменяем по digest.
  const runner = ctx.runner as unknown as {
    options: { context?: (w: unknown, a: unknown) => unknown };
  };
  runner.options.context = (_w, attempt) =>
    ctx.engine.read((v) =>
      v.local(
        'context-snapshots',
        WORKSPACE_OWNER,
        (attempt as { pinned?: { contextDigest?: string } }).pinned!.contextDigest!,
      ),
    );
  ctx.engine.resume();
  await ctx.runner.drain();
  const attempts = ctx.engine.read((v) => v.attempts(W));
  const second = attempts[1]!;
  assert.equal(
    ctx.engine.read((v) => v.work(W)!.status),
    'done',
    second.error,
  );
  assert.equal(second.contextSnapshot, digest);
  assert.equal(second.input?.requestId, request!.id);
  assert.equal(second.continuedFrom?.reason, 'needs-input');
  assert.equal(second.continuedFrom?.applied, true, 'черновик наложен');
  const writer = readFileSync(`${ctx.scenarioPath}.writer.1.prompt`, 'utf8');
  assert.match(writer, /Use the greeting Hello, <name>! exactly/);
  assert.match(writer, /stopped to ask a question/);
  assert.match(writer, /input threshold 7/);
  for (const i of [0, 1])
    assert.match(
      readFileSync(`${ctx.scenarioPath}.reviewer.${i}.prompt`, 'utf8'),
      /Use the greeting Hello, <name>! exactly/,
      'оба ревью видят тот же ответ',
    );
  const delivered = ctx.engine.inputRequest(request!.id).delivered!;
  assert.equal(delivered.runId, second.id);
  assert.ok(
    ctx.engine
      .read((v) => v.locals('usage'))
      .some((c) => c.value.id === delivered.callId && c.value.stage === 'implementation'),
  );
});
