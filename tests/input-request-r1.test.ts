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
} from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { inputContextSource, unappliedInputs, withInput } from '../src/engine/input-requests.ts';
import { runAll, setup } from './runner-fixture.ts';
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
