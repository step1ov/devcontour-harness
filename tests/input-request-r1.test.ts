/**
 * H02, правки по независимому ревью (раунд 1): порт хоста и барьер политики,
 * выход из вопроса после новой редакции графа, ответ, не теряющийся при
 * выдаче, маскирование, перенос допущений, вопрос вне схемы, пределы.
 * Runtime — fixture, живых моделей нет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HarnessError,
  WORKSPACE_OWNER,
  contextDigest,
  executionPolicySchema,
  latestAnswer,
  sha256,
  sourceDigest,
  type ContextSnapshot,
  type ExecutionHost,
  type ExecutionPolicy,
  type InputOutcome,
  type InputQuestion,
  type RuntimeAdapter,
  workGraphSchema,
} from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { inputContextSource, unappliedInputs, withInput } from '../src/engine/input-requests.ts';
import { approve, bin, greet, implement, runAll, setup } from './runner-fixture.ts';
import { Runner } from '../src/engine/runner.ts';
import { hsetup } from './harness-fixture.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { repairDecision } from '../src/engine/repair.ts';
import { explainStop } from '../src/projections/stop.ts';
import { handoffPack } from '../src/handoff/pack.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { prompt } from '../src/engine/prompt.ts';
import {
  evaluateInput,
  inputPolicyText,
  normalizeImplementation,
} from '../src/engine/input-policy.ts';
import { statusOf } from '../src/control/status.ts';
import { executionEnvironment } from '../src/environment/lifecycle.ts';
import {
  engineOf,
  graphOf,
  planReview,
  policyOf,
  ready,
  sha,
  trustNone,
} from './engine-fixture.ts';

export const question = (severity = 8, extra: Partial<InputQuestion> = {}): InputQuestion => ({
  question: 'Какой формат приветствия?',
  options: [
    { id: 'hello', label: 'Hello, <name>!', consequence: null },
    { id: 'hi', label: 'Hi <name>', consequence: null },
  ],
  recommended: 'hello',
  severity,
  rationale: 'Текст виден пользователю',
  affects: [],
  ...extra,
});

export const outcome = (severity = 8): InputOutcome => ({
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

export const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    return e.code;
  }
};

/** Хост со своим согласованием контекста (как DevContour): снимок поручения — в памяти хоста. */
function hostEngine(
  policy: ExecutionPolicy,
  dir: string,
  approved: Map<string, string | null>,
  calls: { method: string; request: unknown }[] = [],
) {
  const store = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') };
  let n = 0;
  const host: ExecutionHost = {
    ...standaloneHost(store, policy),
    input: {
      contextDigestOf: (work) => approved.get(work.id) ?? null,
      review: (_work, _digest, _actor, _view, request) => {
        calls.push({ method: 'review', request });
        return { round: 1, approved: true, reviewerBinding: null };
      },
      activate: (_tx, work, target, request) => {
        calls.push({ method: 'activate', request });
        approved.set(work.id, target.contextDigest);
      },
    },
  };
  const engine = new Engine({
    host,
    policy,
    now: () => clock.now,
    id: () => `id-${String(++n).padStart(6, '0')}-${dir.slice(-6)}-${policy.maxAttempts}`,
  });
  return { engine, store, clock };
}

test('M-1: у хоста с портом согласования applyInput проверяет применённую политику и актёра', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-h02r1-'));
  const approved = new Map<string, string | null>();
  const a = hostEngine(policyOf(), dir, approved);
  ready(a.engine, graphOf({ w: [] }));
  const attempt = a.engine.claim('c1')!;
  a.engine.fail(attempt.id, attempt.token, 'вопрос', { kind: 'needs-input', input: outcome() });
  const [request] = a.engine.inputRequests();
  const answered = a.engine.answerInput(
    request!.id,
    { text: 'Hello', actor: { kind: 'operator' } },
    1,
  ).request;
  const snapshot = withInput(undefined, inputContextSource(answered, latestAnswer(answered)!));
  const digest = contextDigest(snapshot);
  a.store.transact('run.context', (tx) =>
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
  );
  const proposal = a.engine.proposeTarget(request!.id, digest);
  assert.deepEqual(proposal.problems, []);
  const options = {
    answerDigest: latestAnswer(answered)!.digest,
    expectedVersion: answered.version,
    contextDigest: digest,
    targetDigest: proposal.target!.digest,
  };
  // Актёр не по режиму политики — отказ и у хоста с портом.
  assert.equal(
    code(() => a.engine.applyInput(request!.id, { ...options, actor: 'operator' })),
    'APPROVAL_REQUIRED',
  );
  // Процесс с другой, не применённой политикой — отказ до активации хостом.
  const b = hostEngine(
    policyOf((p) => (p.maxAttempts = 5)),
    dir,
    approved,
  );
  assert.ok(
    b.engine.proposeTarget(request!.id, digest).problems.some((p) => /не с применённой/.test(p)),
  );
  assert.equal(
    code(() => b.engine.applyInput(request!.id, { ...options, actor: 'agent' })),
    'APPROVAL_STALE',
  );
  assert.equal(approved.get('w'), undefined, 'хост ничего не активировал');
  assert.equal(a.engine.inputRequest(request!.id).lifecycle, 'answered');
  // Под применённой политикой — активация портом и обычный повтор.
  const applied = a.engine.applyInput(request!.id, { ...options, actor: 'agent' });
  assert.equal(applied.applied, true);
  assert.equal(approved.get('w'), digest);
  void sha;
  void planReview;
});

/** Граф w; попытка остановилась с вопросом (standalone). */
function stopped(patch: (p: Record<string, unknown>) => void = () => {}) {
  const env = engineOf(policyOf(patch));
  const graph = ready(env.engine, graphOf({ w: [], x: [] }));
  const attempt = env.engine.claim('c1')!;
  env.engine.fail(attempt.id, attempt.token, 'вопрос', { kind: 'needs-input', input: outcome() });
  const [request] = env.engine.inputRequests({ workId: attempt.workId });
  return { ...env, graph, attempt, request: request! };
}

test('m-1: manifest ответа не JSON — причина «не прочитан», а не сбой', () => {
  const env = stopped();
  const text = 'not json';
  const entry = {
    id: 'input-' + env.request.id.slice(3),
    kind: 'input-answer',
    version: 'r1',
    required: true,
    files: [],
    references: [
      {
        path: `input/${env.request.id}.manifest.json`,
        digest: sha256(Buffer.from(text)),
        bytes: Buffer.byteLength(text),
        content: { encoding: 'utf8' as const, data: text },
      },
    ],
  };
  const snapshot = withInput(undefined, { ...entry, digest: sourceDigest(entry) });
  const found = env.engine.read((v) => env.engine.unappliedInputs(v, snapshot));
  assert.deepEqual(
    found.map((f) => f.reason),
    ['manifest ответа не прочитан'],
  );
});

test('m-3: тот же текст от другого актёра или с другой ссылкой хоста — новая версия, не повтор', () => {
  const env = stopped();
  const id = env.request.id;
  env.engine.answerInput(id, { text: 'ISO', actor: { kind: 'operator' }, messageRef: 'm-1' }, 1);
  const lead = env.engine.answerInput(
    id,
    { text: 'ISO', actor: { kind: 'lead' }, messageRef: 'm-2' },
    2,
  );
  assert.equal(lead.changed, true);
  assert.deepEqual(
    lead.request.answers.map((a) => [a.revision, a.actor.kind, a.messageRef]),
    [
      [1, 'operator', 'm-1'],
      [2, 'lead', 'm-2'],
    ],
  );
  const again = env.engine.answerInput(
    id,
    { text: 'ISO', actor: { kind: 'lead' }, messageRef: 'm-2' },
    2,
  );
  assert.equal(again.changed, false);
});

test('m-10: пределы ответа и закрытия — INVALID_INPUT, а не исключение схемы', () => {
  const env = stopped();
  const id = env.request.id;
  const long = () =>
    env.engine.answerInput(id, { text: 'x'.repeat(3001), actor: { kind: 'operator' } }, 1);
  assert.equal(code(long), 'INVALID_INPUT');
  assert.equal(
    code(() =>
      env.engine.answerInput(
        id,
        { text: 'ok', actor: { kind: 'operator' }, messageRef: 'r'.repeat(301) },
        1,
      ),
    ),
    'INVALID_INPUT',
  );
  assert.equal(
    code(() =>
      env.engine.supersedeInput(id, { by: 'lead', reason: 'x', successor: 's'.repeat(201) }, 1),
    ),
    'INVALID_INPUT',
  );
  assert.equal(env.engine.inputRequest(id).version, 1, 'ничего не записано');
});

test('m-2: длинный изменённый критический путь не роняет запись вопроса — попытка не остаётся активной', async () => {
  const deep = `src/${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(150)}.js`;
  const ctx = setup({
    scenario: {
      writer: {
        files: { [deep]: 'x\n' },
        result: {
          completed: false,
          summary: 'вопрос',
          discoveries: [],
          inputRequest: question(3),
          assumptions: [],
        },
      },
    },
    policy: (p) => (p.inputPolicy = { threshold: 7, criticalPaths: ['src'] }),
  });
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.failureKind, 'needs-input', work.failure);
  const [request] = ctx.engine.inputRequests({ workId: 'add-greeting' });
  assert.equal(request!.criticalHits[0]!.length, 500);
  assert.deepEqual(request!.floors, ['critical-path']);
});

test('M-4: секрет профиля в вопросе и допущениях writer маскируется до записи — и у библиотечного адаптера без маски', async () => {
  process.env.HARNESS_TEST_INPUT_SECRET = 'tok-7f3a9c';
  const secret = 'tok-7f3a9c';
  try {
    // Библиотечный адаптер, который не маскирует ответ сам: секрет попадает
    // в структурированный ответ после CLI fixture.
    const leaking = (inner: RuntimeAdapter): RuntimeAdapter => ({
      runtime: inner.runtime,
      capabilities: () => inner.capabilities(),
      invoke: async (request, signal) => {
        const response = await inner.invoke(request, signal);
        if (request.task !== 'implement') return response;
        const output = structuredClone(response.output) as {
          inputRequest: InputQuestion;
          assumptions: { question: string; rationale: string }[];
        };
        output.inputRequest.question = `Использовать токен ${secret} или новый?`;
        output.inputRequest.options[0]!.label = secret;
        output.assumptions[0]!.rationale = `${secret} не в коде`;
        return { ...response, output };
      },
    });
    const ctx = setup({
      scenario: {
        writer: {
          files: { 'src/greet.js': "exports.greet = () => 'draft';\n" },
          result: {
            completed: false,
            summary: 'вопрос',
            discoveries: [],
            inputRequest: question(9),
            assumptions: [
              { question: 'Где хранить?', chosen: 'env', rationale: '-', severity: 2, affects: [] },
            ],
          },
        },
      },
      policy: (p) => {
        p.inputPolicy = { threshold: 7, criticalPaths: [] };
        (p as { environment: { secrets: Record<string, string> } }).environment.secrets = {
          TOKEN: 'HARNESS_TEST_INPUT_SECRET',
        };
      },
      runner: {
        adapters: {
          claude: leaking(cliAdapter('claude', { executable: bin('fake-claude') })),
          codex: cliAdapter('codex', { executable: bin('fake-codex') }),
        },
      },
    });
    await runAll(ctx);
    const [request] = ctx.engine.inputRequests({ workId: 'add-greeting' });
    const attempt = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(attempt.failureKind, 'needs-input', attempt.error);
    const stored = JSON.stringify({ request, assumptions: attempt.assumptions });
    assert.doesNotMatch(stored, /tok-7f3a9c/);
    assert.match(request!.question.question, /Использовать токен .+ или новый\?/);
  } finally {
    delete process.env.HARNESS_TEST_INPUT_SECRET;
  }
});

test('M-6: вопрос вне схемы (длинный текст, ID с пробелом) — needs-input с записью исправлений, а не потерянный вопрос', async () => {
  const ctx = setup({
    scenario: {
      writer: {
        files: { 'src/greet.js': "exports.greet = () => 'draft';\n" },
        result: {
          completed: false,
          summary: 'вопрос',
          discoveries: [],
          inputRequest: {
            question: 'Q'.repeat(1600),
            options: [
              { id: 'Option A', label: 'A', consequence: null },
              { id: 'Option B', label: 'B', consequence: null },
            ],
            recommended: 'Option A',
            severity: 8,
            rationale: 'r',
            affects: [],
          },
          assumptions: [],
        },
      },
    },
    policy: (p) => (p.inputPolicy = { threshold: 7, criticalPaths: [] }),
  });
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.failureKind, 'needs-input', work.failure);
  const [request] = ctx.engine.inputRequests({ workId: 'add-greeting' });
  assert.equal(request!.question.question.length, 1500);
  assert.deepEqual(
    request!.question.options.map((o) => o.id),
    ['Option-A', 'Option-B'],
  );
  assert.equal(request!.question.recommended, 'Option-A');
  assert.ok(request!.normalized?.some((n) => /усечено до 1500/.test(n)));
  assert.ok(request!.normalized?.some((n) => /ID вне схемы \(8 знаков\) → Option-A/.test(n)));
  assert.ok(!request!.normalized?.some((n) => /Option A/.test(n)), 'исходный ID не повторяется');
});

test('M-6: пределы названы в запросе writer; ответ вне схемы без вопроса не исправляется', () => {
  const text = inputPolicyText({ threshold: 7, criticalPaths: [] });
  assert.match(text, /question up to 1500 characters/);
  assert.match(text, /\[A-Za-z0-9_-\]\{1,40\} \(no spaces\)/);
  assert.match(inputPolicyText({ threshold: 11, criticalPaths: [] }), /up to 6 options/);
  assert.equal(normalizeImplementation({ completed: true, summary: 1 }), undefined);
  assert.equal(normalizeImplementation({ completed: false, inputRequest: null }), undefined);
});

/** Ответ, снимок с ним, раунд ревью этого снимка и предложение основания. */
function prepare(env: ReturnType<typeof stopped>, text = 'Hello') {
  const current = env.engine.inputRequest(env.request.id);
  const answered =
    latestAnswer(current)?.text === text
      ? current
      : env.engine.answerInput(
          env.request.id,
          { text, actor: { kind: 'operator' } },
          current.version,
        ).request;
  const snapshot = withInput(undefined, inputContextSource(answered, latestAnswer(answered)!));
  const digest = contextDigest(snapshot);
  env.store.transact('run.context', (tx) =>
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
  );
  env.engine.recordReview({
    ...planReview(env.engine, env.graph, env.engine.reviews('plan', env.graph.id).length + 1),
    contextDigest: digest,
  });
  const proposal = env.engine.proposeTarget(env.request.id, digest);
  const apply = () =>
    env.engine.applyInput(env.request.id, {
      answerDigest: latestAnswer(answered)!.digest,
      expectedVersion: env.engine.inputRequest(env.request.id).version,
      contextDigest: digest,
      targetDigest: proposal.target!.digest,
      actor: 'agent',
    });
  return { answered, digest, proposal, apply };
}

test('M-3: согласование сменилось после apply — при выдаче ответ не теряется: запрос снова answered, работа держится и применяется заново', () => {
  const env = stopped();
  const first = prepare(env);
  assert.equal(first.apply().applied, true);
  // Новое согласование без снимка с ответом (как run без --context).
  env.engine.recordReview(
    planReview(env.engine, env.graph, env.engine.reviews('plan', env.graph.id).length + 1),
  );
  env.engine.approve(env.graph.id, 'agent', { bindContext: true });
  env.clock.now += 1000;
  const claimed = env.engine.claim('c1');
  assert.notEqual(claimed?.workId, 'w', 'работа без ответа не выдана');
  const request = env.engine.inputRequest(env.request.id);
  assert.equal(request.lifecycle, 'answered');
  assert.equal(request.target, undefined);
  assert.equal(request.stale?.reason, 'context');
  assert.ok(
    env.engine
      .read((v) => env.engine.blockers(v.work('w')!, v))
      .some((b) => b.code === 'INPUT_REQUIRED'),
  );
  assert.equal(env.store.events(0, 500).filter((e) => e.type === 'input.stale').length, 1);
  if (claimed) env.engine.fail(claimed.id, claimed.token, 'x', { kind: 'gate' });
  // Новый снимок с тем же ответом, ревью и применение: работа готова и с ответом.
  const second = prepare(env);
  const applied = second.apply();
  assert.equal(applied.applied, true);
  assert.equal(env.engine.inputRequest(env.request.id).stale, undefined);
  env.clock.now += 1000;
  const next = env.engine.claim('c1')!;
  assert.equal(next.workId, 'w');
  assert.equal(next.input?.requestId, env.request.id);
  assert.equal(next.pinned?.contextDigest, second.digest);
});

test('M-3: запрос продолжения называет ответ в снимке, только если он связан с попыткой', () => {
  const env = stopped();
  const base = env.engine.read((v) => ({
    work: v.work('w')!,
    attempt: v.attempt(env.attempt.id)!,
  }));
  const text = (input: boolean) =>
    prompt({
      work: base.work,
      attempt: {
        ...base.attempt,
        continuedFrom: {
          runId: env.attempt.id,
          kind: 'unfinished',
          reason: 'needs-input',
          applied: true,
          files: ['src/a.js'],
        },
        ...(input
          ? {
              input: {
                requestId: env.request.id,
                answerDigest: sha('a').slice(0, 64),
                targetDigest: sha('b').slice(0, 64),
              },
            }
          : {}),
      },
      history: [],
      gates: [],
    });
  assert.match(text(true), /the answer is in the pinned context below/);
  assert.doesNotMatch(text(false), /the answer is in the pinned context/);
  assert.match(text(false), /if the pinned context below has an input-answer source/);
  assert.doesNotMatch(text(false), /no answer is attached/, 'перенесённый ответ не отрицается');
});

test('M-2: новая редакция графа держит вопрос; выход с сохранением ответа — supersede и перенос ответа в контекст новой редакции', () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  ready(h.engine, ctx.graph, 'controller');
  const a = h.engine.claim('controller')!;
  h.engine.fail(a.id, a.token, 'вопрос', { kind: 'needs-input', input: outcome() });
  const id = h.inputRequests({ workId: a.workId })[0]!.id;
  h.answerInput(id, { text: 'Hello, <name>!', actor: { kind: 'operator' } }, 1);
  // Новая редакция графа: добавлено поручение.
  const raw = structuredClone(ctx.graph) as unknown as {
    source: { revision: string };
    orders: Record<string, unknown>[];
  };
  raw.source.revision = '2';
  raw.orders.push({
    ...raw.orders[0],
    id: 'extra',
    source: { connector: 'files', ref: 'extra', revision: '1' },
  });
  // Новая редакция постановки самой работы (ревизия её источника).
  raw.orders[0] = {
    ...raw.orders[0],
    goal: String(raw.orders[0]!.goal) + ' Уточнено.',
    source: { connector: 'files', ref: 'add-greeting', revision: '2' },
  };
  const next = workGraphSchema.parse(raw);
  const { graph } = h.engine.register(next, trustNone);
  h.engine.recordReview(planReview(h.engine, graph, h.engine.reviews('plan', graph.id).length + 1));
  h.engine.approve(graph.id, 'agent');
  const work = h.engine.read((v) => v.work(a.workId)!);
  assert.equal(work.status, 'ready');
  // Вопрос по-прежнему держит работу, и explain его называет.
  const diagnosis = stopInputsOf(h, {
    maxAttempts: h.policy.maxAttempts,
    repairBudget: h.policy.repairBudget,
  })
    .filter((i) => i.kind === 'work' && i.work.id === a.workId)
    .map(explainStop)[0]!;
  assert.deepEqual([diagnosis.code, diagnosis.action], ['INPUT_REQUIRED', 'apply-input']);
  assert.ok(
    h.proposeTarget(id, null).problems.some((p) => /supersedeInput/.test(p)),
    'предложение называет выход',
  );
  // Выход: заменить вопрос новой редакцией работы и перенести ответ в контекст.
  h.supersedeInput(id, { by: 'lead', reason: 'новая редакция графа', successor: a.workId }, 2);
  const { digest } = h.inputContext(id);
  h.engine.recordReview({
    ...planReview(h.engine, graph, h.engine.reviews('plan', graph.id).length + 1),
    contextDigest: digest,
  });
  h.engine.approve(graph.id, 'agent', { bindContext: true });
  const claimed = h.engine.claim('controller')!;
  assert.equal(claimed.workId, a.workId);
  assert.equal(claimed.pinned?.contextDigest, digest, 'ответ — в контексте новой попытки');
  // m-5: снимок для неблокирующего запроса не строится.
  h.engine.recordAssumptions(claimed.id, claimed.token, {
    assumptions: [],
    followUps: [{ question: question(3), effectiveSeverity: 10, floors: ['declared'] }],
    criticalHits: [],
    callId: null,
  });
  const follow = h.inputRequests({ workId: a.workId }).find((r) => r.kind === 'follow-up')!;
  h.answerInput(follow.id, { text: 'оставить', actor: { kind: 'lead' } }, follow.version);
  assert.equal(
    code(() => h.inputContext(follow.id)),
    'NOT_READY',
  );
  h.close();
});

const exhausted = {
  stream: fileURLToPath(
    new URL('./fixtures/context-exhaustion/blocking-limit.jsonl', import.meta.url),
  ),
  exit: 1,
};
const withAssumption = (severity: number) => ({
  files: { 'src/greet.js': greet },
  result: {
    completed: true,
    summary: 'Добавлена greet',
    discoveries: [],
    inputRequest: null,
    assumptions: [
      { question: 'Регистр имени?', chosen: 'как передано', rationale: 'r', severity, affects: [] },
    ],
  },
});

/** Новый процесс над тем же каталогом состояния с другой политикой. */
function reopen(ctx: ReturnType<typeof setup>, patch: (p: Record<string, unknown>) => void) {
  const raw = structuredClone(ctx.policy) as unknown as Record<string, unknown>;
  patch(raw);
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
  return { store, engine, runner };
}

test('M-5: взятый кандидат несёт решения его попытки — они записаны в новую попытку, reviewer их видит', async () => {
  const ctx = setup({
    writer: 'claude',
    reviewer: 'claude',
    vendor: 'same-vendor-allowed',
    scenario: {
      writer: withAssumption(3),
      reviewer: [exhausted, { ...approve(), recordPrompt: true }],
    },
    policy: (p) => {
      p.inputPolicy = { threshold: 7, criticalPaths: [] };
      (p as { maxAttempts: number }).maxAttempts = 5;
    },
  });
  await runAll(ctx);
  ctx.engine.retry('add-greeting');
  ctx.engine.resume();
  await ctx.runner.drain();
  const [first, second] = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(first!.failureKind, 'context-exhausted', first!.error);
  assert.equal(second!.reusedFrom?.runId, first!.id, 'кандидат взят');
  assert.deepEqual(
    second!.assumptions?.map((a) => a.question),
    ['Регистр имени?'],
  );
  const reviewer = readFileSync(`${ctx.scenarioPath}.reviewer.1.prompt`, 'utf8');
  assert.match(reviewer, /Decisions the writer made on its own[\s\S]*Регистр имени/);
});

test('M-5: решения кандидата переоцениваются по политике новой попытки — не ниже порога останавливают', async () => {
  const ctx = setup({
    writer: 'claude',
    reviewer: 'claude',
    vendor: 'same-vendor-allowed',
    scenario: { writer: withAssumption(8), reviewer: [exhausted, approve()] },
    policy: (p) => {
      p.inputPolicy = { threshold: 11, criticalPaths: [] };
      (p as { maxAttempts: number }).maxAttempts = 5;
    },
  });
  await runAll(ctx);
  ctx.store.close();
  const next = reopen(ctx, (p) => (p.inputPolicy = { threshold: 7, criticalPaths: [] }));
  next.engine.retry('add-greeting');
  await next.runner.init();
  next.engine.resume();
  await next.runner.drain();
  const attempts = next.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts[1]!.reusedFrom?.runId, attempts[0]!.id);
  assert.equal(attempts[1]!.failureKind, 'needs-input', attempts[1]!.error);
  next.store.close();
});

test('M-5: продолжение черновика показывает решения прежней попытки writer и reviewer', async () => {
  const ctx = setup({
    scenario: {
      writer: [
        {
          files: { 'src/greet.js': "exports.greet = () => 'draft';\n" },
          result: {
            completed: false,
            summary: 'не успел',
            discoveries: [],
            inputRequest: null,
            assumptions: [
              {
                question: 'Регистр имени?',
                chosen: 'как передано',
                rationale: 'r',
                severity: 2,
                affects: [],
              },
            ],
          },
        },
        { ...implement(), recordPrompt: true },
      ],
      reviewer: { ...approve(), recordPrompt: true },
    },
    policy: (p) => (p.inputPolicy = { threshold: 7, criticalPaths: [] }),
  });
  await runAll(ctx);
  ctx.engine.retry('add-greeting');
  ctx.engine.resume();
  await ctx.runner.drain();
  const second = ctx.engine.read((v) => v.attempts('add-greeting')[1]!);
  assert.equal(second.continuedFrom?.applied, true);
  assert.equal(second.status, 'succeeded', second.error);
  const writer = readFileSync(`${ctx.scenarioPath}.writer.1.prompt`, 'utf8');
  assert.match(writer, /Decisions the previous attempt made[\s\S]*Регистр имени/);
  const reviewer = readFileSync(`${ctx.scenarioPath}.reviewer.0.prompt`, 'utf8');
  assert.match(reviewer, /Decisions the writer made on its own[\s\S]*Регистр имени/);
});

test('m-12: в автономном режиме заданный вопрос записан и решением исполнителя', () => {
  const out = evaluateInput(
    { completed: false, inputRequest: question(9, { affects: ['api'] }), assumptions: [] },
    { threshold: 11, criticalPaths: [] },
    [],
  );
  assert.equal(out.decision.kind, 'declined');
  assert.deepEqual(
    out.assumptions.map((a) => [a.question, a.chosen, a.effectiveSeverity]),
    [['Какой формат приветствия?', 'Hello, <name>!', 10]],
  );
  assert.equal(out.followUps.length, 1);
});

test('m-6: у принятой работы статус не показывает вопрос', () => {
  const env = stopped();
  env.store.transact('run.phase', (tx) => tx.putWork({ ...tx.work('w')!, status: 'done' }));
  const status = statusOf({ engine: env.engine, policy: env.engine.policy });
  assert.equal(status.works.find((w) => w.id === 'w')!.input, undefined);
  assert.ok(status.works.find((w) => w.id === 'x'));
});

test('m-7: Harness загружает снимок, закреплённый при выдаче, а не согласование, сменившееся после неё', () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  const { graph } = h.engine.register(ctx.graph, trustNone);
  const snap = (text: string) => {
    const file = {
      path: 'notes.md',
      digest: sha256(Buffer.from(text)),
      bytes: Buffer.byteLength(text),
      content: { encoding: 'utf8' as const, data: text },
    };
    const entry = {
      id: 'notes',
      kind: 'doc',
      version: '1',
      required: false,
      files: [file],
      references: [],
    };
    const snapshot = withInput(undefined, { ...entry, digest: sourceDigest(entry) });
    const digest = contextDigest(snapshot);
    h.store.transact('run.context', (tx) =>
      tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
    );
    h.engine.recordReview({
      ...planReview(h.engine, graph, h.engine.reviews('plan', graph.id).length + 1),
      contextDigest: digest,
    });
    h.engine.approve(graph.id, 'agent', { bindContext: true });
    return digest;
  };
  const first = snap('первый');
  h.engine.lead('controller');
  h.engine.resume();
  const attempt = h.engine.claim('controller')!;
  assert.equal(attempt.pinned?.contextDigest, first);
  const second = snap('второй');
  const contextOf = (
    h as unknown as {
      contextOf: (
        g: string,
        a?: unknown,
      ) => { sources: { files: { content: { data: string } }[] }[] } | undefined;
    }
  ).contextOf.bind(h);
  assert.equal(contextOf(graph.id, attempt)?.sources[0]!.files[0]!.content.data, 'первый');
  assert.equal(contextOf(graph.id)?.sources[0]!.files[0]!.content.data, 'второй');
  assert.notEqual(first, second);
  h.close();
});

test('m-11: вызов writer, который не запустился (unavailable), не подтверждает доставку ответа', async () => {
  let down = false;
  const flaky = (inner: RuntimeAdapter): RuntimeAdapter => ({
    runtime: inner.runtime,
    capabilities: () => inner.capabilities(),
    invoke: (request, signal) =>
      down && request.task === 'implement'
        ? Promise.resolve({
            status: 'unavailable' as const,
            model: null,
            runtimeVersion: null,
            text: '',
            usage: {
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              reportedUsd: null,
              complete: false,
              source: 'unavailable' as const,
            },
            diagnostics: { exitCode: null, reason: 'spawn ENOENT' },
          })
        : inner.invoke(request, signal),
  });
  let load: (digest: string) => ContextSnapshot | undefined = () => undefined;
  const ctx = setup({
    scenario: {
      writer: [
        {
          files: { 'src/greet.js': "exports.greet = () => 'draft';\n" },
          result: {
            completed: false,
            summary: 'вопрос',
            discoveries: [],
            inputRequest: question(9),
            assumptions: [],
          },
        },
        implement(),
      ],
      reviewer: approve(),
    },
    policy: (p) => {
      p.inputPolicy = { threshold: 7, criticalPaths: [] };
      (p as { maxAttempts: number }).maxAttempts = 5;
    },
    runner: {
      // Загрузчик хоста по закреплению попытки (как у Harness).
      context: (_work, attempt) => {
        const pin = attempt.pinned?.contextDigest;
        return pin ? load(pin) : undefined;
      },
      adapters: {
        claude: flaky(cliAdapter('claude', { executable: bin('fake-claude') })),
        codex: cliAdapter('codex', { executable: bin('fake-codex') }),
      },
    },
  });
  load = (digest) => ctx.engine.read((v) => v.local('context-snapshots', WORKSPACE_OWNER, digest));
  const graph = await runAll(ctx);
  const [request] = ctx.engine.inputRequests({ workId: 'add-greeting' });
  const answered = ctx.engine.answerInput(
    request!.id,
    { text: 'Hello', actor: { kind: 'operator' } },
    1,
  ).request;
  const snapshot = withInput(undefined, inputContextSource(answered, latestAnswer(answered)!));
  const digest = contextDigest(snapshot);
  ctx.store.transact('run.context', (tx) =>
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
  );
  ctx.engine.recordReview({
    ...planReview(ctx.engine, graph, ctx.engine.reviews('plan', graph.id).length + 1),
    authorRuntime: 'claude',
    reviewerBinding: ctx.engine.reviewerBinding('plan', 'claude')!,
    contextDigest: digest,
  });
  const proposal = ctx.engine.proposeTarget(request!.id, digest);
  assert.deepEqual(proposal.problems, []);
  ctx.engine.applyInput(request!.id, {
    answerDigest: latestAnswer(answered)!.digest,
    expectedVersion: answered.version,
    contextDigest: digest,
    targetDigest: proposal.target!.digest,
    actor: 'agent',
  });
  down = true;
  ctx.engine.resume();
  await ctx.runner.drain();
  assert.equal(ctx.engine.inputRequest(request!.id).delivered, undefined, 'runtime не запустился');
  down = false;
  ctx.engine.retry('add-greeting');
  ctx.engine.resume();
  await ctx.runner.drain();
  assert.ok(ctx.engine.inputRequest(request!.id).delivered, 'вызов writer состоялся');
});

/** Библиотечный адаптер без маски: подменяет ответ writer после CLI fixture. */
const rewriting =
  (change: (output: Record<string, unknown>) => void) =>
  (inner: RuntimeAdapter): RuntimeAdapter => ({
    runtime: inner.runtime,
    capabilities: () => inner.capabilities(),
    invoke: async (request, signal) => {
      const response = await inner.invoke(request, signal);
      if (request.task !== 'implement') return response;
      const output = structuredClone(response.output) as Record<string, unknown>;
      change(output);
      return { ...response, output };
    },
  });

async function leakRun(change: (output: Record<string, unknown>) => void) {
  process.env.HARNESS_TEST_INPUT_SECRET = 'tok-7f';
  try {
    const ctx = setup({
      scenario: {
        writer: {
          files: { 'src/greet.js': "exports.greet = () => 'draft';\n" },
          result: {
            completed: false,
            summary: 'вопрос',
            discoveries: [],
            inputRequest: question(9),
            assumptions: [],
          },
        },
      },
      policy: (p) => {
        p.inputPolicy = { threshold: 7, criticalPaths: [] };
        (p as { environment: { secrets: Record<string, string> } }).environment.secrets = {
          TOKEN: 'HARNESS_TEST_INPUT_SECRET',
        };
      },
      runner: {
        adapters: {
          claude: rewriting(change)(cliAdapter('claude', { executable: bin('fake-claude') })),
          codex: cliAdapter('codex', { executable: bin('fake-codex') }),
        },
      },
    });
    await runAll(ctx);
    const work = ctx.engine.read((v) => v.work('add-greeting')!);
    const [request] = ctx.engine.inputRequests({ workId: 'add-greeting' });
    return { work, request };
  } finally {
    delete process.env.HARNESS_TEST_INPUT_SECRET;
  }
}

test('R2-2: секрет в ID варианта вне схемы — ни в исправленном вопросе, ни в записи исправлений', async () => {
  const { work, request } = await leakRun((output) => {
    const q = output.inputRequest as InputQuestion;
    q.options[0]!.id = 'use tok-7f3a9c';
    q.recommended = 'use tok-7f3a9c';
  });
  assert.equal(work.failureKind, 'needs-input', work.failure);
  assert.ok(request!.normalized?.length);
  assert.doesNotMatch(JSON.stringify(request), /tok-7f/);
});

test('R2-7: вопрос на пределе длины с секретом — после маски он длиннее предела, но вопрос записан, а не потерян', async () => {
  const { work, request } = await leakRun((output) => {
    const q = output.inputRequest as InputQuestion;
    // Маска `[REDACTED]` длиннее секрета: 1500 знаков становятся 1504.
    q.question = 'Q'.repeat(1493) + ' tok-7f';
  });
  assert.equal(work.failureKind, 'needs-input', work.failure);
  assert.ok(request!.question.question.length <= 1500);
  assert.doesNotMatch(JSON.stringify(request), /tok-7f/);
});

test('R2-3: область вне схемы не снимает минимум — синоним распознан, нераспознанная даёт потолок', () => {
  const ask = (affects: unknown[]) =>
    normalizeImplementation({
      completed: false,
      summary: 's',
      inputRequest: {
        ...question(4),
        options: [{ id: 'Option A', label: 'A', consequence: null }],
        recommended: null,
        affects,
      },
      assumptions: [],
    })!.output;
  const api = ask(['API']);
  assert.deepEqual(api.inputRequest!.affects, ['api']);
  const policy = { threshold: 7, criticalPaths: [] };
  assert.equal(evaluateInput(api, policy, []).decision.kind, 'stop');
  const unknown = ask(['security']);
  assert.deepEqual(unknown.inputRequest!.affects, []);
  assert.equal(unknown.inputRequest!.severity, 10);
  assert.equal(evaluateInput(unknown, policy, []).decision.kind, 'stop');
});

/** Снимок с последним ответом запроса (по digest) и раунд ревью плана этого снимка. */
function reviewSnapshot(
  env: ReturnType<typeof stopped>,
  graph: { id: string; digest: string },
  answerIndex = -1,
) {
  const request = env.engine.inputRequest(env.request.id);
  const answer = request.answers.at(answerIndex)!;
  const snapshot = withInput(undefined, inputContextSource(request, answer));
  const digest = contextDigest(snapshot);
  env.store.transact('run.context', (tx) =>
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
  );
  env.engine.recordReview({
    ...planReview(env.engine, graph, env.engine.reviews('plan', graph.id).length + 1),
    contextDigest: digest,
  });
  return digest;
}

/** Новая редакция графа (та же работа, другая ревизия источника), согласованная без контекста. */
function revise(env: ReturnType<typeof stopped>) {
  const raw = structuredClone(graphOf({ w: [], x: [] }, '2')) as unknown as {
    orders: Record<string, unknown>[];
  };
  raw.orders[0] = { ...raw.orders[0], goal: String(raw.orders[0]!.goal) + ' Уточнено.' };
  const { graph } = env.engine.register(workGraphSchema.parse(raw), trustNone);
  env.engine.recordReview(
    planReview(env.engine, graph, env.engine.reviews('plan', graph.id).length + 1),
  );
  env.engine.approve(graph.id, 'agent');
  return graph;
}

test('R2-1: замена при действующей исходной остановке ответ не переносит — изменение требований не возобновляет работу обходом applyInput', () => {
  const env = stopped();
  const answered = env.engine.answerInput(
    env.request.id,
    { text: 'Новые критерии', kind: 'requirement-change', actor: { kind: 'operator' } },
    1,
  ).request;
  const closed = env.engine.supersedeInput(
    env.request.id,
    { by: 'lead', reason: 'изменение требований', successor: 'w' },
    answered.version,
  ).request;
  assert.equal(closed.closed?.carry, false);
  reviewSnapshot(env, env.graph);
  assert.equal(
    code(() => env.engine.approve(env.graph.id, 'agent', { bindContext: true })),
    'INPUT_REQUIRED',
  );
});

test('R2-1: перенесённый ответ не активируется под идущей попыткой соседа; после её окончания — согласуется', () => {
  const env = stopped();
  const answered = env.engine.answerInput(
    env.request.id,
    { text: 'Hello', actor: { kind: 'operator' } },
    1,
  ).request;
  const graph = revise(env);
  env.clock.now += 1000;
  const sibling = env.engine.claim('c1')!;
  assert.equal(sibling.workId, 'x');
  const closed = env.engine.supersedeInput(
    env.request.id,
    { by: 'lead', reason: 'новая редакция', successor: 'w' },
    answered.version,
  ).request;
  assert.equal(closed.closed?.carry, true);
  reviewSnapshot(env, graph);
  const before = env.engine.read((v) => v.graph(graph.id)!.approval);
  assert.equal(
    code(() => env.engine.approve(graph.id, 'agent', { bindContext: true })),
    'NOT_READY',
  );
  assert.deepEqual(
    env.engine.read((v) => v.graph(graph.id)!.approval),
    before,
  );
  env.engine.fail(sibling.id, sibling.token, 'x', { kind: 'gate' });
  assert.equal(env.engine.approve(graph.id, 'agent', { bindContext: true }).changed, true);
});

test('R2-1: переносится только последняя версия ответа', () => {
  const env = stopped();
  env.engine.answerInput(env.request.id, { text: 'v1', actor: { kind: 'operator' } }, 1);
  const v2 = env.engine.answerInput(
    env.request.id,
    { text: 'v2', actor: { kind: 'operator' } },
    2,
  ).request;
  const graph = revise(env);
  env.engine.supersedeInput(
    env.request.id,
    { by: 'lead', reason: 'редакция', successor: 'w' },
    v2.version,
  );
  reviewSnapshot(env, graph, 0);
  assert.equal(
    code(() => env.engine.approve(graph.id, 'agent', { bindContext: true })),
    'INPUT_REQUIRED',
  );
  reviewSnapshot(env, graph);
  assert.equal(env.engine.approve(graph.id, 'agent', { bindContext: true }).changed, true);
});

test('R2-5: два вопроса в графе — применение второго не делает первое устаревшим, ответы связаны с попытками', () => {
  const env = stopped();
  env.clock.now += 1000;
  const xa = env.engine.claim('c1')!;
  assert.equal(xa.workId, 'x');
  env.engine.fail(xa.id, xa.token, 'вопрос', { kind: 'needs-input', input: outcome() });
  const reqW = env.request;
  const reqX = env.engine.inputRequests({ workId: 'x' })[0]!;
  const answer = (id: string) =>
    env.engine.answerInput(id, { text: 'Hello ' + id, actor: { kind: 'operator' } }, 1).request;
  const aw = answer(reqW.id);
  const ax = answer(reqX.id);
  const apply = (request: typeof aw, base: ReturnType<typeof withInput> | undefined) => {
    const snapshot = withInput(base, inputContextSource(request, latestAnswer(request)!));
    const digest = contextDigest(snapshot);
    env.store.transact('run.context', (tx) =>
      tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
    );
    env.engine.recordReview({
      ...planReview(env.engine, env.graph, env.engine.reviews('plan', env.graph.id).length + 1),
      contextDigest: digest,
    });
    const proposal = env.engine.proposeTarget(request.id, digest);
    assert.deepEqual(proposal.problems, []);
    const result = env.engine.applyInput(request.id, {
      answerDigest: latestAnswer(request)!.digest,
      expectedVersion: request.version,
      contextDigest: digest,
      targetDigest: proposal.target!.digest,
      actor: 'agent',
    });
    assert.equal(result.applied, true);
    return snapshot;
  };
  const sw = apply(aw, undefined);
  apply(ax, sw);
  env.clock.now += 1000;
  const first = env.engine.claim('c1')!;
  const second = env.engine.claim('c1')!;
  assert.deepEqual([first.workId, second.workId].sort(), ['w', 'x']);
  assert.ok(first.input && second.input, 'оба ответа связаны с попытками');
  assert.equal(env.engine.inputRequest(reqW.id).lifecycle, 'applied');
  assert.equal(env.engine.inputRequest(reqW.id).stale, undefined);
});

test('R2-6/R3-4: продолжение не выдаёт вопрос за решение, переоценивает решения прежней попытки, и не записанное заново решение не ниже порога останавливает', async () => {
  const ctx = setup({
    scenario: {
      writer: [
        {
          files: { 'src/greet.js': greet },
          result: {
            completed: true,
            summary: 'готово',
            discoveries: [],
            inputRequest: null,
            assumptions: [
              { question: 'Формат даты?', chosen: 'ISO', rationale: 'r', severity: 8, affects: [] },
              {
                question: 'Регистр имени?',
                chosen: 'как есть',
                rationale: 'r',
                severity: 2,
                affects: [],
              },
            ],
          },
        },
        { ...implement(), recordPrompt: true },
      ],
      reviewer: { ...approve(), recordPrompt: true },
    },
    policy: (p) => {
      p.inputPolicy = { threshold: 7, criticalPaths: [] };
      (p as { maxAttempts: number }).maxAttempts = 5;
    },
  });
  await runAll(ctx);
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.failureKind),
    'needs-input',
  );
  const [request] = ctx.engine.inputRequests({ workId: 'add-greeting' });
  assert.equal(request!.question.question, 'Формат даты?');
  ctx.store.close();
  // Новая политика: изменённый черновиком путь критичен.
  const next = reopen(ctx, (p) => (p.inputPolicy = { threshold: 7, criticalPaths: ['src'] }));
  next.engine.cancelInput(
    request!.id,
    { by: 'operator', reason: 'решим в ревью' },
    request!.version,
  );
  next.engine.retry('add-greeting');
  await next.runner.init();
  next.engine.resume();
  await next.runner.drain();
  const writer = readFileSync(`${ctx.scenarioPath}.writer.1.prompt`, 'utf8');
  const block = writer.slice(writer.indexOf('Decisions the previous attempt made'));
  assert.match(block, /Регистр имени\?","chosen":"как есть","rationale":"r","severity":10/);
  assert.doesNotMatch(block.split('\n')[0]!, /Формат даты/, 'вопрос — не решение');
  // R3-4: решение, не записанное writer заново и теперь не ниже порога,
  // останавливает попытку, как у взятого кандидата.
  const second = next.engine.read((v) => v.attempts('add-greeting')[1]!);
  assert.equal(second.failureKind, 'needs-input', second.error);
  const asked = next.engine
    .inputRequests({ workId: 'add-greeting' })
    .find((r) => r.runId === second.id)!;
  assert.equal(asked.question.question, 'Регистр имени?');
  next.store.close();
});

test('R2-8/m-2: запись вопроса отклонена — отказ пишется без него (unfinished с причиной), попытка не остаётся активной', async () => {
  const ctx = setup({
    scenario: { writer: asks9() },
    policy: (p) => (p.inputPolicy = { threshold: 7, criticalPaths: [] }),
  });
  const original = ctx.engine.fail.bind(ctx.engine);
  let refused = 0;
  ctx.engine.fail = (id, token, error, options = {}) => {
    if (options.input) {
      refused++;
      throw new Error('запись запроса отклонена хранилищем');
    }
    return original(id, token, error, options);
  };
  await runAll(ctx);
  const [attempt] = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(refused, 1);
  assert.equal(attempt!.status, 'failed');
  assert.equal(attempt!.failureKind, 'unfinished');
  assert.match(attempt!.error ?? '', /Вопрос исполнителя не записан: запись запроса отклонена/);
  assert.deepEqual(ctx.engine.inputRequests(), []);
});

function asks9() {
  return {
    files: { 'src/greet.js': "exports.greet = () => 'draft';\n" },
    result: {
      completed: false,
      summary: 'вопрос',
      discoveries: [],
      inputRequest: question(9),
      assumptions: [],
    },
  };
}

test('R3-5: очень короткие наследуемые значения без секретного имени не вырезаются из вывода; остальные маскируются', () => {
  const { redact } = executionEnvironment(
    [
      {
        inherit: ['FORCE_COLOR', 'FLAG', 'NODE_ENV', 'MY_API_TOKEN', 'LONG_OPAQUE'],
        values: {},
        secrets: { DECLARED: 'D' },
      },
    ],
    {},
    {
      PATH: '/bin',
      FORCE_COLOR: '1',
      FLAG: 'true',
      NODE_ENV: 'production',
      MY_API_TOKEN: 'tk-42',
      LONG_OPAQUE: 'abcdefghijklmnopqrstuvwx',
      D: 'z9',
    },
  );
  const text = 'opt1 true production tk-42 abcdefghijklmnopqrstuvwx z9';
  assert.equal(redact(text), 'opt1 true [REDACTED] [REDACTED] [REDACTED] [REDACTED]');
});

test('R3-3: нераспознанная область — критичность с минимумом: в автономном режиме запрос ведущему', () => {
  const normalized = normalizeImplementation({
    completed: false,
    summary: 's',
    inputRequest: {
      ...question(4),
      options: [{ id: 'Option A', label: 'A', consequence: null }],
      recommended: null,
    },
    assumptions: [
      {
        question: 'Хранить пароли?',
        chosen: 'хэш',
        rationale: 'r',
        severity: 3,
        affects: ['security'],
      },
    ],
  })!.output;
  const out = evaluateInput(
    { completed: true, inputRequest: null, assumptions: normalized.assumptions },
    { threshold: 11, criticalPaths: [] },
    [],
  );
  assert.deepEqual(out.assumptions[0]!.floors, ['declared']);
  assert.equal(out.assumptions[0]!.effectiveSeverity, 10);
  assert.equal(out.followUps.length, 1, 'ведущий получает запрос');
});

/** Новая редакция графа: другие поручения не меняются, `change` правит граф. */
function reviseGraph(
  env: ReturnType<typeof stopped>,
  revision: string,
  change: (orders: Record<string, unknown>[]) => void,
) {
  const raw = structuredClone(graphOf({ w: [], x: [] })) as unknown as {
    source: { revision: string };
    orders: Record<string, unknown>[];
  };
  raw.source.revision = revision;
  change(raw.orders);
  const { graph } = env.engine.register(workGraphSchema.parse(raw), trustNone);
  env.engine.recordReview(
    planReview(env.engine, graph, env.engine.reviews('plan', graph.id).length + 1),
  );
  env.engine.approve(graph.id, 'agent');
  return graph;
}
const addOrder = (id: string) => (orders: Record<string, unknown>[]) =>
  void orders.push({ ...orders[0], id, source: { connector: 'files', ref: id, revision: '1' } });

test('R3-1: изменение требований переносится, только если изменилась постановка самой работы', () => {
  const env = stopped();
  const answered = env.engine.answerInput(
    env.request.id,
    { text: 'Новый критерий', kind: 'requirement-change', actor: { kind: 'operator' } },
    1,
  ).request;
  // Новая редакция графа, постановка w прежняя.
  const unrelated = reviseGraph(env, '2', addOrder('y'));
  env.engine.supersedeInput(
    env.request.id,
    { by: 'lead', reason: 'ревизия', successor: 'w' },
    answered.version,
  );
  assert.equal(env.engine.inputRequest(env.request.id).closed?.carry, false);
  reviewSnapshot(env, unrelated);
  assert.equal(
    code(() => env.engine.approve(unrelated.id, 'agent', { bindContext: true })),
    'INPUT_REQUIRED',
  );
  // Редакция, изменившая постановку w: требование вошло в неё — перенос допустим.
  const changed = reviseGraph(env, '3', (orders) => {
    addOrder('y')(orders);
    orders[0] = { ...orders[0], goal: String(orders[0]!.goal) + ' С новым критерием.' };
  });
  reviewSnapshot(env, changed);
  assert.equal(env.engine.approve(changed.id, 'agent', { bindContext: true }).changed, true);
});

test('R3-2: замена до новой редакции графа — перенос решается при переносе, а не навсегда при замене', () => {
  const env = stopped();
  const answered = env.engine.answerInput(
    env.request.id,
    { text: 'Hello', actor: { kind: 'operator' } },
    1,
  ).request;
  env.engine.supersedeInput(
    env.request.id,
    { by: 'lead', reason: 'будет редакция', successor: 'w' },
    answered.version,
  );
  assert.equal(
    env.engine.inputRequest(env.request.id).closed?.carry,
    false,
    'остановка ещё держалась',
  );
  const graph = reviseGraph(env, '2', (orders) => {
    addOrder('y')(orders);
    orders[0] = {
      ...orders[0],
      goal: String(orders[0]!.goal) + ' Уточнено.',
      source: { connector: 'files', ref: 'w', revision: '2' },
    };
  });
  reviewSnapshot(env, graph);
  assert.equal(env.engine.approve(graph.id, 'agent', { bindContext: true }).changed, true);
});

test('R3-2: run со снимком перенесённого ответа при идущей попытке соседа — NOT_READY до платного ревью', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  const raw = structuredClone(ctx.graph) as unknown as {
    source: { revision: string };
    orders: Record<string, unknown>[];
  };
  raw.orders.push({
    ...raw.orders[0],
    id: 'extra',
    source: { connector: 'files', ref: 'extra', revision: '1' },
  });
  const g1 = workGraphSchema.parse(raw);
  ready(h.engine, g1, 'controller');
  const a = h.engine.claim('controller')!;
  assert.equal(a.workId, 'add-greeting');
  h.engine.fail(a.id, a.token, 'вопрос', { kind: 'needs-input', input: outcome() });
  const id = h.inputRequests({ workId: a.workId })[0]!.id;
  h.answerInput(id, { text: 'Hello', actor: { kind: 'operator' } }, 1);
  raw.source.revision = '2';
  raw.orders.push({
    ...raw.orders[0],
    id: 'third',
    source: { connector: 'files', ref: 'third', revision: '1' },
  });
  raw.orders[0] = {
    ...raw.orders[0],
    goal: String(raw.orders[0]!.goal) + ' Уточнено.',
    source: { connector: 'files', ref: 'add-greeting', revision: '2' },
  };
  const g2 = workGraphSchema.parse(raw);
  const { graph } = h.engine.register(g2, trustNone);
  h.engine.recordReview(planReview(h.engine, graph, h.engine.reviews('plan', graph.id).length + 1));
  h.engine.approve(graph.id, 'agent');
  const sibling = h.engine.claim('controller')!;
  assert.equal(sibling.workId, 'extra');
  h.supersedeInput(id, { by: 'lead', reason: 'редакция', successor: a.workId }, 2);
  const { snapshot } = h.inputContext(id);
  const reviews = ctx.calls('codex', 'reviewer');
  await assert.rejects(
    h.run({ graph: g2, context: snapshot, author: 'claude' }),
    (e: unknown) => e instanceof HarnessError && e.code === 'NOT_READY',
  );
  assert.equal(ctx.calls('codex', 'reviewer'), reviews, 'ревью плана не вызывалось');
  h.close();
});

test('Q3: порт хоста получает запрос и ответ в review и activate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-h02r4-'));
  const approved = new Map<string, string | null>();
  const calls: { method: string; request: unknown }[] = [];
  const a = hostEngine(policyOf(), dir, approved, calls);
  ready(a.engine, graphOf({ w: [] }));
  const attempt = a.engine.claim('c1')!;
  a.engine.fail(attempt.id, attempt.token, 'вопрос', { kind: 'needs-input', input: outcome() });
  const [request] = a.engine.inputRequests();
  const answered = a.engine.answerInput(
    request!.id,
    { text: 'Hello', actor: { kind: 'operator' } },
    1,
  ).request;
  const snapshot = withInput(undefined, inputContextSource(answered, latestAnswer(answered)!));
  const digest = contextDigest(snapshot);
  a.store.transact('run.context', (tx) =>
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
  );
  const proposal = a.engine.proposeTarget(request!.id, digest);
  a.engine.applyInput(request!.id, {
    answerDigest: latestAnswer(answered)!.digest,
    expectedVersion: answered.version,
    contextDigest: digest,
    targetDigest: proposal.target!.digest,
    actor: 'agent',
  });
  const expected = { id: request!.id, answerDigest: latestAnswer(answered)!.digest, mode: 'apply' };
  assert.deepEqual(calls.at(-1), { method: 'activate', request: expected });
  assert.ok(
    calls.some(
      (c) => c.method === 'review' && JSON.stringify(c.request) === JSON.stringify(expected),
    ),
  );
});

test('Q4: wire-схема ответа writer экспортирована корнем пакета', async () => {
  const root = (await import('../src/index.ts')) as unknown as Record<string, unknown>;
  const { implementationOutputSchema } = await import('../src/agents/schemas.ts');
  assert.equal(root.implementationOutputSchema, implementationOutputSchema);
});

/** Ответ, снимок, раунд ревью снимка для `graph` и применение. */
function applyOn(env: ReturnType<typeof stopped>, graph: { id: string; digest: string }) {
  const current = env.engine.inputRequest(env.request.id);
  const answered = latestAnswer(current)
    ? current
    : env.engine.answerInput(
        env.request.id,
        { text: 'Hello', actor: { kind: 'operator' } },
        current.version,
      ).request;
  const digest = reviewSnapshot(env, graph);
  const proposal = env.engine.proposeTarget(env.request.id, digest);
  assert.deepEqual(proposal.problems, []);
  const result = env.engine.applyInput(env.request.id, {
    answerDigest: latestAnswer(answered)!.digest,
    expectedVersion: answered.version,
    contextDigest: digest,
    targetDigest: proposal.target!.digest,
    actor: 'agent',
  });
  return { digest, result };
}

test('Q1: согласование другой работы того же графа не мешает применить ответ и не делает применённый устаревшим', () => {
  // Новая редакция графа добавляет работу y, постановка w прежняя.
  const before = stopped();
  const g2 = reviseGraph(before, '2', addOrder('y'));
  const { result } = applyOn(before, g2);
  assert.equal(result.applied, true, 'остановка w держится: применение, а не перенос');

  const env = stopped();
  const { digest } = applyOn(env, env.graph);
  // После применения согласована новая работа графа (граф сменил digest).
  const raw = structuredClone(graphOf({ w: [], x: [] })) as unknown as {
    source: { revision: string };
    orders: Record<string, unknown>[];
  };
  raw.source.revision = '2';
  addOrder('y')(raw.orders);
  const { graph } = env.engine.register(workGraphSchema.parse(raw), trustNone);
  env.engine.recordReview({
    ...planReview(env.engine, graph, env.engine.reviews('plan', graph.id).length + 1),
    contextDigest: digest,
  });
  env.engine.approve(graph.id, 'agent', { bindContext: true });
  env.clock.now += 1000;
  const claimed = [env.engine.claim('c1'), env.engine.claim('c1')].filter(Boolean);
  const w = claimed.find((a) => a!.workId === 'w');
  assert.ok(w, 'w выдана');
  assert.equal(w.input?.requestId, env.request.id, 'ответ связан с попыткой');
  assert.equal(env.engine.inputRequest(env.request.id).stale, undefined);
});

test('Q6: загрузчик контекста хоста, не учитывающий закрепление, отказывает сразу — до вызова writer', async () => {
  const snap = (text: string) => {
    const file = {
      path: 'notes.md',
      digest: sha256(Buffer.from(text)),
      bytes: Buffer.byteLength(text),
      content: { encoding: 'utf8' as const, data: text },
    };
    const entry = {
      id: 'notes',
      kind: 'doc',
      version: '1',
      required: false,
      files: [file],
      references: [],
    };
    return withInput(undefined, { ...entry, digest: sourceDigest(entry) });
  };
  const pinned = snap('закреплённый');
  const other = snap('другой');
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    runner: { context: () => other },
  });
  await ctx.runner.init();
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  const digest = contextDigest(pinned);
  ctx.store.transact('run.context', (tx) =>
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, pinned),
  );
  ctx.engine.recordReview({
    ...planReview(ctx.engine, graph, 1),
    authorRuntime: 'claude',
    reviewerBinding: ctx.engine.reviewerBinding('plan', 'claude')!,
    contextDigest: digest,
  });
  ctx.engine.approve(graph.id, 'agent', { bindContext: true });
  ctx.engine.resume();
  await ctx.runner.drain();
  const [attempt] = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempt!.pinned?.contextDigest, digest);
  assert.equal(attempt!.status, 'failed');
  assert.match(attempt!.error ?? '', /закреплённым при выдаче/);
  assert.equal(existsSync(`${ctx.scenarioPath}.claude.writer.count`), false, 'writer не вызывался');
});

test('Q2: carryInput у хоста с портом — перенос одной транзакцией: правило переноса, политика, без идущих попыток, activate(carry), повтор', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-h02r4-carry-'));
  const approved = new Map<string, string | null>();
  const calls: { method: string; request: unknown }[] = [];
  const a = hostEngine(policyOf(), dir, approved, calls);
  ready(a.engine, graphOf({ w: [], x: [] }));
  const attempt = a.engine.claim('c1')!;
  a.engine.fail(attempt.id, attempt.token, 'вопрос', { kind: 'needs-input', input: outcome() });
  const [request] = a.engine.inputRequests({ workId: 'w' });
  const answered = a.engine.answerInput(
    request!.id,
    { text: 'Hello', actor: { kind: 'operator' } },
    1,
  ).request;
  // Новая редакция постановки w; согласование графа без контекста.
  const raw = structuredClone(graphOf({ w: [], x: [] })) as unknown as {
    source: { revision: string };
    orders: Record<string, unknown>[];
  };
  raw.source.revision = '2';
  raw.orders[0] = {
    ...raw.orders[0],
    goal: String(raw.orders[0]!.goal) + ' Уточнено.',
    source: { connector: 'files', ref: 'w', revision: '2' },
  };
  const { graph } = a.engine.register(workGraphSchema.parse(raw), trustNone);
  a.engine.recordReview(planReview(a.engine, graph, a.engine.reviews('plan', graph.id).length + 1));
  a.engine.approve(graph.id, 'agent');
  // Соседняя попытка идёт (w держит вопрос) — перенос ждёт.
  a.clock.now += 1000;
  const sibling = a.engine.claim('c1')!;
  assert.equal(sibling.workId, 'x');
  const closed = a.engine.supersedeInput(
    request!.id,
    { by: 'lead', reason: 'редакция', successor: 'w' },
    answered.version,
  ).request;
  const snapshot = withInput(undefined, inputContextSource(closed, latestAnswer(closed)!));
  const digest = contextDigest(snapshot);
  a.store.transact('run.context', (tx) =>
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
  );
  const proposal = a.engine.proposeCarry(request!.id, digest);
  assert.ok(proposal.problems.some((p) => /идут попытки/.test(p)));
  const carryOptions = {
    contextDigest: digest,
    actor: 'agent' as const,
    expectedVersion: closed.version,
    targetDigest: proposal.target!.digest,
  };
  const waiting = a.engine.carryInput(request!.id, carryOptions);
  assert.equal(waiting.carried, false);
  assert.equal(approved.get('w'), undefined);
  a.engine.fail(sibling.id, sibling.token, 'x', { kind: 'gate' });
  // Процесс с неприменённой политикой не переносит.
  const b = hostEngine(
    policyOf((p) => (p.maxAttempts = 5)),
    dir,
    approved,
  );
  assert.equal(
    code(() => b.engine.carryInput(request!.id, carryOptions)),
    'APPROVAL_STALE',
  );
  const carried = a.engine.carryInput(request!.id, carryOptions);
  assert.equal(carried.carried, true);
  assert.equal(approved.get('w'), digest);
  assert.deepEqual(calls.at(-1), {
    method: 'activate',
    request: { id: request!.id, answerDigest: latestAnswer(closed)!.digest, mode: 'carry' },
  });
  assert.equal(a.engine.inputRequest(request!.id).lifecycle, 'superseded');
  assert.equal(a.engine.inputRequest(request!.id).target?.contextDigest, digest);
  assert.equal(a.engine.carryInput(request!.id, carryOptions).changed, false);
  a.clock.now += 1000;
  const next = a.engine.claim('c1')!;
  assert.equal(next.workId, 'w');
  assert.equal(next.pinned?.contextDigest, digest);
});

/** Ответ на вопрос w с видом `kind`, затем замена. */
function supersedeWith(
  env: ReturnType<typeof stopped>,
  kind: 'clarification' | 'requirement-change',
) {
  const answered = env.engine.answerInput(
    env.request.id,
    { text: 'Ответ', kind, actor: { kind: 'operator' } },
    1,
  ).request;
  return env.engine.supersedeInput(
    env.request.id,
    { by: 'lead', reason: 'замена', successor: 'w' },
    answered.version,
  ).request;
}

test('R5-1: пересинхронизация трекера (только ревизия источника постановки) не открывает перенос изменения требований', () => {
  const env = stopped();
  const bump = reviseGraph(env, '2', (orders) => {
    orders[0] = { ...orders[0], source: { connector: 'files', ref: 'w', revision: '2' } };
  });
  supersedeWith(env, 'requirement-change');
  assert.equal(
    env.engine.read((v) => env.engine.carryAllowed(v, env.engine.inputRequest(env.request.id))),
    false,
  );
  reviewSnapshot(env, bump);
  assert.equal(
    code(() => env.engine.approve(bump.id, 'agent', { bindContext: true })),
    'INPUT_REQUIRED',
  );
});

test('R5-6: экспортированный unappliedInputs без правила переноса движка — ошибка, а не решение по отметке замены', () => {
  const env = stopped();
  supersedeWith(env, 'clarification');
  const request = env.engine.inputRequest(env.request.id);
  const snapshot = withInput(undefined, inputContextSource(request, latestAnswer(request)!));
  const loose = unappliedInputs as unknown as (v: unknown, s: unknown) => unknown;
  assert.throws(() => env.engine.read((v) => loose(v, snapshot)), /mayCarry/);
  assert.deepEqual(
    env.engine.read((v) => unappliedInputs(v, snapshot, (r) => env.engine.carryAllowed(v, r))),
    env.engine.read((v) => env.engine.unappliedInputs(v, snapshot)),
  );
});

/** Заменённый вопрос w после новой редакции постановки w, снимок с ответом прошёл ревью. */
function carryReady(patch: (p: Record<string, unknown>) => void = () => {}) {
  const env = stopped(patch);
  const answered = env.engine.answerInput(
    env.request.id,
    { text: 'Hello', actor: { kind: 'operator' } },
    1,
  ).request;
  const graph = reviseGraph(env, '2', (orders) => {
    orders[0] = { ...orders[0], goal: String(orders[0]!.goal) + ' Уточнено.' };
  });
  const closed = env.engine.supersedeInput(
    env.request.id,
    { by: 'lead', reason: 'редакция', successor: 'w' },
    answered.version,
  ).request;
  const digest = reviewSnapshot(env, graph);
  const proposal = env.engine.proposeCarry(env.request.id, digest);
  const options = {
    contextDigest: digest,
    actor: 'agent' as const,
    expectedVersion: closed.version,
    targetDigest: proposal.target!.digest,
  };
  /** Работа снова остановлена (как у хоста, где редакция не сбрасывает статус). */
  const setWork = (patchWork: Record<string, unknown>) =>
    env.store.transact('run.phase', (tx) => tx.putWork({ ...tx.work('w')!, ...patchWork }));
  return { env, graph, digest, proposal, options, setWork };
}

test('R5-2: carryInput требует точную версию и основание из proposeCarry', () => {
  const c = carryReady();
  assert.deepEqual(c.proposal.problems, []);
  assert.equal(
    code(() => c.env.engine.carryInput(c.env.request.id, { ...c.options, expectedVersion: 1 })),
    'REVISION_CONFLICT',
  );
  // Новый раунд ревью после предложения: перенос — не на том ревью, что видел вызывающий.
  reviewSnapshot(c.env, c.graph);
  assert.equal(
    code(() => c.env.engine.carryInput(c.env.request.id, c.options)),
    'APPROVAL_STALE',
  );
});

test('R5-2: исчерпанные попытки и бюджет — {blocker} до активации; иной отказ не возвращается в очередь', () => {
  const tight = carryReady((p) => (p.maxAttempts = 1));
  tight.setWork({ status: 'failed', failureKind: 'needs-input', attempt: 1 });
  const before = tight.env.engine.read((v) => v.graph(tight.graph.id)!.approval);
  const blocked = tight.env.engine.carryInput(tight.env.request.id, tight.options);
  assert.equal(blocked.carried, false);
  assert.equal('blocker' in blocked && blocked.blocker?.code, 'ATTEMPTS_EXHAUSTED');
  assert.deepEqual(
    tight.env.engine.read((v) => v.graph(tight.graph.id)!.approval),
    before,
    'согласование не переключено',
  );

  const budget = carryReady((p) => (p.budgets = { work: { usd: 1 }, onUnknown: 'stop' }));
  budget.env.store.transact('usage.recorded', (tx) =>
    tx.putLocal('usage', 'app', 'call-x', {
      id: 'call-x',
      repositoryId: 'app',
      runId: budget.env.attempt.id,
      workId: 'w',
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
  const held = budget.env.engine.carryInput(budget.env.request.id, budget.options);
  assert.equal(held.carried, false);
  assert.equal('blocker' in held && held.blocker?.code, 'BUDGET_EXHAUSTED');

  const gate = carryReady();
  gate.setWork({ status: 'failed', failureKind: 'gate' });
  const carried = gate.env.engine.carryInput(gate.env.request.id, gate.options);
  assert.equal(carried.carried, true);
  assert.equal(
    gate.env.engine.read((v) => v.work('w')!.status),
    'failed',
    'отказ gate — не повтор переноса',
  );
});

test('R5-3: перенесённый ответ — связан с попыткой; согласование без него до выдачи — запись устаревания, работа держится до нового переноса', () => {
  const c = carryReady();
  assert.equal(c.env.engine.carryInput(c.env.request.id, c.options).carried, true);
  // Согласование сменилось на снимок без ответа (как run с другим контекстом).
  c.env.engine.recordReview(
    planReview(c.env.engine, c.graph, c.env.engine.reviews('plan', c.graph.id).length + 1),
  );
  c.env.engine.approve(c.graph.id, 'agent', { bindContext: true });
  c.env.clock.now += 1000;
  const first = c.env.engine.claim('c1');
  assert.notEqual(first?.workId, 'w', 'w без перенесённого ответа не выдана');
  const stale = c.env.engine.inputRequest(c.env.request.id);
  assert.equal(stale.lifecycle, 'superseded');
  assert.equal(stale.target, undefined);
  assert.equal(stale.stale?.reason, 'context');
  assert.ok(
    c.env.engine
      .read((v) => c.env.engine.blockers(v.work('w')!, v))
      .some((b) => b.code === 'INPUT_REQUIRED' && /carryInput/.test(b.message)),
  );
  if (first) c.env.engine.fail(first.id, first.token, 'x', { kind: 'gate' });
  // Новый перенос — работа выдаётся с ответом, связанным с попыткой.
  const digest = reviewSnapshot(c.env, c.graph);
  const proposal = c.env.engine.proposeCarry(c.env.request.id, digest);
  assert.equal(
    c.env.engine.carryInput(c.env.request.id, {
      ...c.options,
      contextDigest: digest,
      expectedVersion: stale.version,
      targetDigest: proposal.target!.digest,
    }).carried,
    true,
  );
  assert.equal(c.env.engine.inputRequest(c.env.request.id).stale, undefined);
  c.env.clock.now += 1000;
  const next = c.env.engine.claim('c1')!;
  assert.equal(next.workId, 'w');
  assert.equal(next.input?.requestId, c.env.request.id);
  assert.equal(c.env.engine.inputDelivered(next.id, next.token, 'call-1'), true);
});

test('R5-4: закреплённого снимка нет — отказ при загрузке, до вызова writer, попытка не засчитана', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    runner: { context: () => undefined },
  });
  await ctx.runner.init();
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  const text = 'закреплённый';
  const file = {
    path: 'notes.md',
    digest: sha256(Buffer.from(text)),
    bytes: Buffer.byteLength(text),
    content: { encoding: 'utf8' as const, data: text },
  };
  const entry = {
    id: 'notes',
    kind: 'doc',
    version: '1',
    required: false,
    files: [file],
    references: [],
  };
  const snapshot = withInput(undefined, { ...entry, digest: sourceDigest(entry) });
  const digest = contextDigest(snapshot);
  ctx.store.transact('run.context', (tx) =>
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
  );
  ctx.engine.recordReview({
    ...planReview(ctx.engine, graph, 1),
    authorRuntime: 'claude',
    reviewerBinding: ctx.engine.reviewerBinding('plan', 'claude')!,
    contextDigest: digest,
  });
  ctx.engine.approve(graph.id, 'agent', { bindContext: true });
  ctx.engine.resume();
  await ctx.runner.drain();
  const [attempt] = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempt!.status, 'failed');
  assert.equal(attempt!.blocked, true, 'не засчитана');
  assert.match(attempt!.error ?? '', /закреплённый при выдаче, не найден/);
  assert.equal(existsSync(`${ctx.scenarioPath}.claude.writer.count`), false, 'writer не вызывался');
});

test('R6-3: пересинхронизация трекера (только ревизия постановки) не мешает применить ответ и не делает применённый устаревшим', () => {
  const bumpW = (orders: Record<string, unknown>[]) => {
    orders[0] = { ...orders[0], source: { connector: 'files', ref: 'w', revision: '2' } };
  };
  // До применения: остановка держится, применение, а не перенос.
  const before = stopped();
  const g2 = reviseGraph(before, '2', bumpW);
  assert.equal(applyOn(before, g2).result.applied, true);

  // После применения: ре-синхронизация и новое согласование с тем же снимком.
  const env = stopped();
  const { digest } = applyOn(env, env.graph);
  const raw = structuredClone(graphOf({ w: [], x: [] })) as unknown as {
    source: { revision: string };
    orders: Record<string, unknown>[];
  };
  raw.source.revision = '2';
  bumpW(raw.orders);
  const { graph } = env.engine.register(workGraphSchema.parse(raw), trustNone);
  env.engine.recordReview({
    ...planReview(env.engine, graph, env.engine.reviews('plan', graph.id).length + 1),
    contextDigest: digest,
  });
  env.engine.approve(graph.id, 'agent', { bindContext: true });
  env.clock.now += 1000;
  const claimed = [env.engine.claim('c1'), env.engine.claim('c1')].filter(Boolean);
  const w = claimed.find((a) => a!.workId === 'w');
  assert.ok(w, 'w выдана');
  assert.equal(w.input?.requestId, env.request.id);
  assert.equal(env.engine.inputRequest(env.request.id).stale, undefined);
});

test('R6-1/R6-4: устаревший перенесённый ответ виден в статусе, explain и пакете передачи; выходы — снять (input-cancel) или перенести снова', () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  const g1 = ready(h.engine, ctx.graph, 'controller');
  const a = h.engine.claim('controller')!;
  h.engine.fail(a.id, a.token, 'вопрос', { kind: 'needs-input', input: outcome() });
  const id = h.inputRequests({ workId: a.workId })[0]!.id;
  h.answerInput(id, { text: 'Hello', actor: { kind: 'operator' } }, 1);
  const raw = structuredClone(ctx.graph) as unknown as {
    source: { revision: string };
    orders: Record<string, unknown>[];
  };
  raw.source.revision = '2';
  raw.orders[0] = { ...raw.orders[0], goal: String(raw.orders[0]!.goal) + ' Уточнено.' };
  const { graph } = h.engine.register(workGraphSchema.parse(raw), trustNone);
  void g1;
  h.engine.recordReview(planReview(h.engine, graph, h.engine.reviews('plan', graph.id).length + 1));
  h.engine.approve(graph.id, 'agent');
  const closed = h.supersedeInput(
    id,
    { by: 'lead', reason: 'редакция', successor: a.workId },
    2,
  ).request;
  const { digest } = h.inputContext(id);
  h.engine.recordReview({
    ...planReview(h.engine, graph, h.engine.reviews('plan', graph.id).length + 1),
    contextDigest: digest,
  });
  const proposal = h.proposeCarry(id, digest);
  h.carryInput(id, {
    contextDigest: digest,
    actor: 'agent',
    expectedVersion: closed.version,
    targetDigest: proposal.target!.digest,
  });
  // Согласование ушло на снимок без ответа до выдачи — перенос устарел.
  h.engine.recordReview(planReview(h.engine, graph, h.engine.reviews('plan', graph.id).length + 1));
  h.engine.approve(graph.id, 'agent', { bindContext: true });
  assert.equal(h.engine.claim('controller'), undefined, 'работа держится');
  const stale = h.inputRequest(id);
  assert.equal(stale.stale?.reason, 'context');
  // R6-4: состояние видно.
  const work = h.status().works.find((w) => w.id === a.workId)!;
  assert.equal(work.input?.state, 'carry-stale');
  const diagnosis = stopInputsOf(h, {
    maxAttempts: h.policy.maxAttempts,
    repairBudget: h.policy.repairBudget,
  })
    .filter((i) => i.kind === 'work' && i.work.id === a.workId)
    .map(explainStop)[0]!;
  assert.equal(diagnosis.code, 'INPUT_REQUIRED');
  assert.match(diagnosis.message, /carryInput/);
  assert.match(diagnosis.message, /input-cancel/);
  assert.equal(handoffPack(h).inputs?.[0]?.state, 'carry-stale');
  // R6-1: выход «снять» — работа продолжается без перенесённого ответа.
  const released = h.cancelInput(
    id,
    { by: 'operator', reason: 'ответ больше не нужен' },
    stale.version,
  );
  assert.equal(released.changed, true);
  assert.equal(released.request.lifecycle, 'cancelled');
  assert.ok(
    !h
      .status()
      .works.find((w) => w.id === a.workId)!
      .blockers.some((b) => b.code === 'INPUT_REQUIRED'),
  );
  assert.equal(h.engine.claim('controller')?.workId, a.workId, 'работа выдана без ответа');
  h.close();
});

/** Заменённый вопрос, чей перенесённый ответ устарел до выдачи (`carry-stale`). */
const staleCarried = () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  ready(h.engine, ctx.graph, 'controller');
  const a = h.engine.claim('controller')!;
  h.engine.fail(a.id, a.token, 'вопрос', { kind: 'needs-input', input: outcome() });
  const id = h.inputRequests({ workId: a.workId })[0]!.id;
  h.answerInput(id, { text: 'Hello', actor: { kind: 'operator' } }, 1);
  const raw = structuredClone(ctx.graph) as unknown as {
    source: { revision: string };
    orders: Record<string, unknown>[];
  };
  raw.source.revision = '2';
  raw.orders[0] = { ...raw.orders[0], goal: String(raw.orders[0]!.goal) + ' Уточнено.' };
  const { graph } = h.engine.register(workGraphSchema.parse(raw), trustNone);
  h.engine.recordReview(planReview(h.engine, graph, h.engine.reviews('plan', graph.id).length + 1));
  h.engine.approve(graph.id, 'agent');
  const superseded = h.supersedeInput(
    id,
    { by: 'lead', reason: 'редакция', successor: a.workId },
    2,
  ).request;
  const replaced = superseded.closed!;
  assert.equal(replaced.successor, a.workId);
  assert.equal(replaced.carry, true);
  const { digest } = h.inputContext(id);
  h.engine.recordReview({
    ...planReview(h.engine, graph, h.engine.reviews('plan', graph.id).length + 1),
    contextDigest: digest,
  });
  const proposal = h.proposeCarry(id, digest);
  h.carryInput(id, {
    contextDigest: digest,
    actor: 'agent',
    expectedVersion: superseded.version,
    targetDigest: proposal.target!.digest,
  });
  h.engine.recordReview(planReview(h.engine, graph, h.engine.reviews('plan', graph.id).length + 1));
  h.engine.approve(graph.id, 'agent', { bindContext: true });
  assert.equal(h.engine.claim('controller'), undefined, 'работа держится');
  const stale = h.inputRequest(id);
  assert.equal(stale.stale?.reason, 'context');
  return { h, a, id, replaced, stale };
};

test('R7-2: снятие устаревшего переноса сохраняет запись замены (преемник, перенос, причина) прежним закрытием', () => {
  const { h, id, replaced, stale } = staleCarried();
  const released = h.cancelInput(
    id,
    { by: 'operator', reason: 'ответ больше не нужен' },
    stale.version,
  ).request;
  assert.equal(released.lifecycle, 'cancelled');
  assert.equal(released.closed?.by, 'operator');
  assert.equal(released.closed?.reason, 'ответ больше не нужен');
  assert.equal(released.closed?.successor, undefined, 'снятие — не замена');
  assert.deepEqual(released.closed?.previous, replaced, 'запись замены сохранена');
  // Сохранённая запись проходит схему и читается заново тем же.
  assert.deepEqual(h.inputRequest(id).closed?.previous, replaced);
  h.close();
});

test('R7-5: отчёт считает устаревший перенос ждущим (carryStale), как проекции, а не закрытым', () => {
  const { h, a, id, stale } = staleCarried();
  assert.equal(h.status().works.find((w) => w.id === a.workId)!.input?.state, 'carry-stale');
  const waiting = h.report().inputs!;
  assert.equal(waiting.carryStale, 1);
  assert.equal(waiting.closed, 0, 'не закрыт');
  assert.equal(waiting.questions, 1);
  // Снятый перенос — уже закрыт.
  h.cancelInput(id, { by: 'operator', reason: 'ответ больше не нужен' }, stale.version);
  const released = h.report().inputs!;
  assert.equal(released.carryStale, 0);
  assert.equal(released.closed, 1);
  h.close();
});

test('R6-2: закреплённого снимка нет у одной работы — держится только она, очередь не на паузе, другая работа исполняется', async () => {
  const text = 'закреплённый';
  const file = {
    path: 'notes.md',
    digest: sha256(Buffer.from(text)),
    bytes: Buffer.byteLength(text),
    content: { encoding: 'utf8' as const, data: text },
  };
  const entry = {
    id: 'notes',
    kind: 'doc',
    version: '1',
    required: false,
    files: [file],
    references: [],
  };
  const snapshot = withInput(undefined, { ...entry, digest: sourceDigest(entry) });
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => ((p as { concurrency: number }).concurrency = 1),
    graph: (g) => {
      const orders = g.orders as Record<string, unknown>[];
      orders.push({
        ...orders[0],
        id: 'extra',
        source: { connector: 'files', ref: 'extra', revision: '1' },
      });
    },
    // Снимок у хоста потерян только для первой работы.
    runner: { context: (work) => (work.id === 'add-greeting' ? undefined : snapshot) },
  });
  await ctx.runner.init();
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  const digest = contextDigest(snapshot);
  ctx.store.transact('run.context', (tx) =>
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
  );
  ctx.engine.recordReview({
    ...planReview(ctx.engine, graph, 1),
    authorRuntime: 'claude',
    reviewerBinding: ctx.engine.reviewerBinding('plan', 'claude')!,
    contextDigest: digest,
  });
  ctx.engine.approve(graph.id, 'agent', { bindContext: true });
  ctx.engine.resume();
  await ctx.runner.drain();
  const lost = ctx.engine.read((v) => v.attempts('add-greeting'))[0]!;
  assert.equal(lost.failureKind, 'needs-lead');
  assert.equal(lost.blocked, true, 'не засчитана');
  assert.match(lost.error ?? '', /Работа add-greeting: снимок контекста .* не найден/);
  assert.equal(ctx.engine.read((v) => v.control()).paused, false, 'очередь не на паузе');
  assert.equal(
    ctx.engine.read((v) => v.work('extra')!.status),
    'done',
    'другая работа исполнена',
  );
});

test('R7-3: отказ из-за потерянного снимка объясняется как отказ до начала работы, не засчитан и не повторяется сам', async () => {
  const text = 'закреплённый';
  const file = {
    path: 'notes.md',
    digest: sha256(Buffer.from(text)),
    bytes: Buffer.byteLength(text),
    content: { encoding: 'utf8' as const, data: text },
  };
  const entry = {
    id: 'notes',
    kind: 'doc',
    version: '1',
    required: false,
    files: [file],
    references: [],
  };
  const snapshot = withInput(undefined, { ...entry, digest: sourceDigest(entry) });
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => ((p as { concurrency: number }).concurrency = 1),
    graph: (g) => {
      const orders = g.orders as Record<string, unknown>[];
      orders.push({
        ...orders[0],
        id: 'extra',
        source: { connector: 'files', ref: 'extra', revision: '1' },
      });
    },
    // Снимок у хоста потерян только для первой работы.
    runner: { context: (work) => (work.id === 'add-greeting' ? undefined : snapshot) },
  });
  await ctx.runner.init();
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  const digest = contextDigest(snapshot);
  ctx.store.transact('run.context', (tx) =>
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, digest, snapshot),
  );
  ctx.engine.recordReview({
    ...planReview(ctx.engine, graph, 1),
    authorRuntime: 'claude',
    reviewerBinding: ctx.engine.reviewerBinding('plan', 'claude')!,
    contextDigest: digest,
  });
  ctx.engine.approve(graph.id, 'agent', { bindContext: true });
  ctx.engine.resume();
  await ctx.runner.drain();
  const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts.length, 1, 'одна попытка: повтора нет');
  assert.equal(attempts[0]!.blocked, true);
  const work = ctx.engine.read((v) => v.work('add-greeting'))!;
  assert.equal(work.status, 'failed');
  assert.equal(work.attempt, 0, 'попытка не засчитана');
  // Диагноз: фаза preflight, неполные входы, решение ведущего, без повтора.
  const source = {
    engine: ctx.engine,
    policy: ctx.policy,
    workflows: { list: () => [], continues: () => false },
  };
  const input = stopInputsOf(source, {
    maxAttempts: ctx.policy.maxAttempts,
    repairBudget: ctx.policy.repairBudget,
    workId: 'add-greeting',
  }).find((i) => i.kind === 'work')!;
  assert.equal(input.kind === 'work' && input.work.preflight, true);
  const diagnosis = explainStop(input);
  assert.equal(diagnosis.phase, 'preflight');
  assert.equal(diagnosis.actor, 'lead');
  assert.equal(diagnosis.action, 'diagnose-failure');
  assert.equal(diagnosis.retryPlanned, false);
  assert.match(diagnosis.message, /до начала/);
  assert.match(diagnosis.message, /снимок контекста .* не найден/);
  assert.doesNotMatch(diagnosis.message, /Пустой результат/);
  // Решение восстановления группы — остановка с той же причиной.
  const decision = ctx.engine.read((v) =>
    repairDecision(v, v.works(graph.id), { budgetLeft: 6, maxAttempts: ctx.policy.maxAttempts }),
  )!;
  assert.equal(decision.action, 'stop');
  assert.equal(decision.workId, 'add-greeting');
  assert.match(decision.reason, /отказала до начала, при загрузке своих входов/);
  assert.doesNotMatch(decision.reason, /не изменил ни файла/);
  // Новый проход очереди работу не выдаёт сам: попытка по-прежнему одна.
  await ctx.runner.drain();
  assert.equal(ctx.engine.read((v) => v.attempts('add-greeting')).length, 1);
});
