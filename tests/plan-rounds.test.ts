/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тесты правят сырой JSON политики до разбора схемой.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_VERSION,
  HarnessError,
  contextChanges,
  contextDigest,
  contextDigestMatches,
  canonicalContextDigest,
  roundBudget,
  sha256,
  sourceDigest,
  type ContextSnapshot,
  type ErrorCode,
  type RuntimeAdapter,
  type RuntimeName,
  type RuntimeRequest,
} from '../src/contracts/index.ts';
import { Harness } from '../src/control/harness.ts';
import { planRoundEpoch } from '../src/control/review.ts';
import { reviewSummaries } from '../src/control/review-summary.ts';
import { graphOf, policyOf } from './engine-fixture.ts';

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};

function reviewers() {
  const requests: RuntimeRequest[] = [];
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: (request) => {
      requests.push(request);
      return Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'controlled',
        output: { approved: true, summary: 'ok', findings: [], previous: [] },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 0,
          complete: true,
          source: 'claude-result',
        },
        diagnostics: { exitCode: 0 },
      });
    },
  });
  return { requests, adapters: { codex: adapter('codex'), claude: adapter('claude') } };
}

const source = (id: string, text: string, kind = 'files') => {
  const entry = {
    id,
    kind,
    version: '1',
    required: true,
    files: [
      {
        path: `${id}.md`,
        digest: sha256(text),
        bytes: Buffer.byteLength(text),
        content: { encoding: 'utf8' as const, data: text },
      },
    ],
    references: [],
  };
  return { ...entry, digest: sourceDigest(entry) };
};
const snap = (...sources: ReturnType<typeof source>[]): ContextSnapshot => ({
  apiVersion: API_VERSION,
  sources,
  missing: [],
});
const graphWith = (...context: string[]) => {
  const graph = graphOf({ a: [] });
  graph.orders[0]!.context = context;
  return graph;
};
const open = (maxAttempts = 3) => {
  const { requests, adapters } = reviewers();
  const policy = policyOf((p: any) => (p.maxAttempts = maxAttempts));
  const h = Harness.open({
    policy,
    stateDir: mkdtempSync(join(tmpdir(), 'harness-plan-rounds-')),
    baseDir: process.cwd(),
    adapters,
  });
  return { h, requests };
};

test('A68-1b: каноническая форма снимка не зависит от порядка источников', () => {
  const a = source('alpha', 'A');
  const b = source('beta', 'B');
  const one = snap(a, b);
  const two = snap(b, a);
  assert.equal(canonicalContextDigest(one), canonicalContextDigest(two));
  assert.notEqual(contextDigest(one), contextDigest(two), 'digest — байты снимка, как прежде');
  assert.ok(contextDigestMatches(contextDigest(two), two));
  assert.ok(contextDigestMatches(contextDigest(one), two), 'каноническая форма узнаётся');
  assert.ok(!contextDigestMatches(contextDigest(snap(a)), two));
  const changes = contextChanges(snap(a, b), snap(source('beta', 'B2'), source('gamma', 'G')));
  assert.deepEqual(
    { added: changes.added, removed: changes.removed, changed: changes.changed },
    { added: ['gamma'], removed: ['alpha'], changed: ['beta'] },
  );
});

test('A68-1b: те же источники в другом порядке — прежний раунд без вызова reviewer', async () => {
  const { h, requests } = open();
  const graph = graphWith('alpha', 'beta');
  const a = source('alpha', 'A');
  const b = source('beta', 'B');
  const first = await h.review({ kind: 'plan', graph, context: snap(a, b), author: 'claude' });
  const again = await h.review({ kind: 'plan', graph, context: snap(b, a), author: 'claude' });
  assert.equal(again.round, first.round);
  assert.equal(requests.length, 1, 'нового вызова нет');
  h.close();
});

test('A68-1: повторное ревью неизменённого плана с другим контекстом не тратит предел и называет изменение', async () => {
  // maxAttempts 1 — предел раундов 2.
  const { h, requests } = open(1);
  const graph = graphWith('alpha');
  const a = source('alpha', 'A');
  const first = await h.review({ kind: 'plan', graph, context: snap(a), author: 'claude' });
  assert.equal(first.counted, true);
  // Ответ на вопрос исполнителя в контексте: тот же план — бесплатный раунд.
  const answer = source('input-1', 'ответ', 'input-answer');
  const second = await h.review({
    kind: 'plan',
    graph,
    context: snap(a, answer),
    author: 'claude',
  });
  assert.equal(second.round, 2);
  assert.equal(second.counted, false, 'тот же план — предел не тратится');
  assert.deepEqual(second.changes, {
    plan: false,
    policy: false,
    reviewer: false,
    context: { added: ['input-1'], removed: [], changed: [] },
  });
  // Изменённый план — засчитанный раунд (2 из 2).
  const changed = structuredClone(graph);
  changed.orders[0]!.title = 'Изменённый план';
  const third = await h.review({
    kind: 'plan',
    graph: changed,
    context: snap(a, answer),
    author: 'claude',
  });
  assert.equal(third.counted, true);
  assert.equal(third.changes?.plan, true);
  const [row] = h.engine.read((v) => reviewSummaries(v, h.policy));
  assert.deepEqual(row!.rounds, { used: 2, max: 2, remaining: 0, free: 1 });
  assert.match(row!.line, /раундов 2\/2, осталось 0/);
  // Предел исчерпан: ещё одно изменение плана — отказ до вызова с причиной.
  const more = structuredClone(changed);
  more.orders[0]!.title = 'Ещё раз';
  await assert.rejects(
    h.review({ kind: 'plan', graph: more, context: snap(a, answer), author: 'claude' }),
    (e: unknown) => {
      refused('ATTEMPTS_EXHAUSTED')(e);
      assert.match((e as Error).message, /2 из 2; новый раунд нужен: изменился план/);
      return true;
    },
  );
  // А повтор неизменённого плана с новым контекстом при исчерпанном пределе — можно.
  const fourth = await h.review({
    kind: 'plan',
    graph: changed,
    context: snap(a, answer, source('doc', 'решение владельца')),
    author: 'claude',
  });
  assert.equal(fourth.counted, false);
  assert.equal(requests.length, 4);
  h.close();
});

test('A68-1e: доработка принятой работы начинает свою эпоху раундов', () => {
  const rounds = [
    { round: 1, at: '2026-01-01T10:00:00.000Z' },
    { round: 2, at: '2026-01-01T11:00:00.000Z' },
    { round: 3, at: '2026-01-01T12:00:00.000Z', counted: false },
    { round: 4, at: '2026-01-01T14:00:00.000Z' },
  ];
  assert.deepEqual(roundBudget(rounds, 6), { used: 3, free: 1, max: 6, remaining: 3 });
  assert.deepEqual(roundBudget(rounds, 6, { since: '2026-01-01T13:00:00.000Z' }), {
    used: 1,
    free: 0,
    max: 6,
    remaining: 5,
    since: '2026-01-01T13:00:00.000Z',
  });
  // Раунды хоста до harness засчитаны, пока эпохи нет.
  assert.equal(roundBudget([{ round: 5, at: rounds[0]!.at }], 6).used, 5);
  const view = {
    works: () => [
      { rework: { fresh: true, reopenedAt: '2026-01-01T13:00:00.000Z' } },
      { rework: { fresh: false, reopenedAt: '2026-01-01T15:00:00.000Z' } },
      { rework: { fresh: true, resumed: true as const, reopenedAt: '2026-01-01T16:00:00.000Z' } },
      {},
    ],
  };
  assert.equal(planRoundEpoch(view, 'g'), '2026-01-01T13:00:00.000Z', 'только своя доработка');
});
