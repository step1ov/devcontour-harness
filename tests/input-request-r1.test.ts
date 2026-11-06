/**
 * H02, правки по независимому ревью (раунд 1): порт хоста и барьер политики,
 * выход из вопроса после новой редакции графа, ответ, не теряющийся при
 * выдаче, маскирование, перенос допущений, вопрос вне схемы, пределы.
 * Runtime — fixture, живых моделей нет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HarnessError,
  WORKSPACE_OWNER,
  contextDigest,
  latestAnswer,
  sha256,
  sourceDigest,
  type ExecutionHost,
  type ExecutionPolicy,
  type InputOutcome,
  type InputQuestion,
  type RuntimeAdapter,
} from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { inputContextSource, unappliedInputs, withInput } from '../src/engine/input-requests.ts';
import { bin, runAll, setup } from './runner-fixture.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { inputPolicyText, normalizeImplementation } from '../src/engine/input-policy.ts';
import { engineOf, graphOf, planReview, policyOf, ready, sha } from './engine-fixture.ts';

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
function hostEngine(policy: ExecutionPolicy, dir: string, approved: Map<string, string | null>) {
  const store = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') };
  let n = 0;
  const host: ExecutionHost = {
    ...standaloneHost(store, policy),
    input: {
      contextDigestOf: (work) => approved.get(work.id) ?? null,
      review: () => ({ round: 1, approved: true, reviewerBinding: null }),
      activate: (_tx, work, target) => void approved.set(work.id, target.contextDigest),
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
  const found = env.engine.read((v) => unappliedInputs(v, snapshot));
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
  assert.ok(request!.normalized?.some((n) => /Option A/.test(n)));
});

test('M-6: пределы названы в запросе writer; ответ вне схемы без вопроса не исправляется', () => {
  const text = inputPolicyText({ threshold: 7, criticalPaths: [] });
  assert.match(text, /question up to 1500 characters/);
  assert.match(text, /\[A-Za-z0-9_-\]\{1,40\} \(no spaces\)/);
  assert.match(inputPolicyText({ threshold: 11, criticalPaths: [] }), /up to 6 options/);
  assert.equal(normalizeImplementation({ completed: true, summary: 1 }), undefined);
  assert.equal(normalizeImplementation({ completed: false, inputRequest: null }), undefined);
});
