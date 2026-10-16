import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_VERSION,
  HarnessError,
  digestOf,
  executionPolicySchema,
  expandGateRefs,
  graphIssues,
  policyIssues,
  runEventSchema,
  runResultSchema,
  selectReviewer,
  workGraphDigest,
  workGraphSchema,
  type WorkGraphInput,
} from '../src/contracts/index.ts';
import { validateInputs } from '../src/validate.ts';
import { clone, example } from './fixtures.ts';

const graphInput = () => clone(example('graph')) as unknown as WorkGraphInput;
const order = (id: string, dependsOn: string[] = []) => ({
  ...(graphInput().orders[0] as object),
  id,
  dependsOn,
});
const graphWith = (orders: object[], prerequisites: object[] = []) =>
  workGraphSchema.parse({ ...graphInput(), orders, prerequisites });

test('Пример поручения и политики проходит validate и даёт стабильные digests', () => {
  const a = validateInputs({ graph: example('graph'), policy: example('policy') });
  const reordered = Object.fromEntries(Object.entries(example('graph')).reverse());
  const b = validateInputs({ graph: reordered, policy: example('policy') });
  assert.equal(a.graphDigest, b.graphDigest, 'порядок ключей не меняет digest');
  assert.match(a.policyDigest, /^[a-f0-9]{64}$/);
  assert.equal(a.orders, 1);
});

test('Изменение любого поля поручения меняет digest графа', () => {
  const base = workGraphSchema.parse(graphInput());
  for (const mutate of [
    (g: WorkGraphInput) => (g.orders[0]!.acceptance = ['другой критерий']),
    (g: WorkGraphInput) => (g.orders[0]!.writeScope = ['src']),
    (g: WorkGraphInput) => (g.orders[0]!.gates = []),
    (g: WorkGraphInput) => (g.orders[0]!.source.revision = '2'),
  ]) {
    const changed = graphInput();
    mutate(changed);
    assert.notEqual(workGraphDigest(workGraphSchema.parse(changed)), workGraphDigest(base));
  }
});

test('Граф: повтор ID, неизвестная зависимость, цикл и самозависимость отклоняются с кодом', () => {
  const codes = (g: ReturnType<typeof graphWith>) => graphIssues(g).map((i) => i.code);
  assert.deepEqual(codes(graphWith([order('a'), order('a')])), ['GRAPH_DUPLICATE_ID']);
  assert.deepEqual(codes(graphWith([order('a', ['ghost'])])), ['GRAPH_UNKNOWN_DEPENDENCY']);
  assert.deepEqual(codes(graphWith([order('a', ['a'])])), ['GRAPH_CYCLE']);
  const cycle = graphIssues(graphWith([order('a', ['b']), order('b', ['c']), order('c', ['a'])]));
  assert.equal(cycle.length, 1, 'один цикл называется один раз');
  assert.equal(cycle[0]!.code, 'GRAPH_CYCLE');
  assert.match(cycle[0]!.message, /a → b → c → a|b → c → a → b|c → a → b → c/);
  assert.deepEqual(codes(graphWith([order('a'), order('b', ['a'])])), []);
});

test('Внешняя зависимость принимается только подтверждённой предпосылкой с SHA', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(
    graphIssues(
      graphWith(
        [order('b', ['a'])],
        [
          {
            id: 'a',
            repositoryId: 'app',
            resultSha: sha,
            receipt: { kind: 'engine', runId: 'r1' },
          },
        ],
      ),
    ),
    [],
  );
  // Отметка «done» без receipt и SHA не является предпосылкой.
  assert.throws(() =>
    graphWith([order('b', ['a'])], [{ id: 'a', repositoryId: 'app', status: 'done' }]),
  );
  assert.throws(() =>
    graphWith(
      [order('b', ['a'])],
      [
        {
          id: 'a',
          repositoryId: 'app',
          resultSha: 'short',
          receipt: { kind: 'engine', runId: 'r' },
        },
      ],
    ),
  );
});

test('Поручение: путь вне репозитория, glob, лишнее поле и чужая apiVersion отклоняются', () => {
  for (const writeScope of [['../x'], ['/abs'], ['src/*'], ['a\\b'], ['./src']]) {
    const g = graphInput();
    g.orders[0]!.writeScope = writeScope;
    assert.equal(workGraphSchema.safeParse(g).success, false, writeScope[0]);
  }
  const extra = graphInput() as WorkGraphInput & { status?: string };
  (extra.orders[0] as Record<string, unknown>).status = 'done';
  assert.equal(workGraphSchema.safeParse(extra).success, false, 'поручение не несёт статус');
  const version = graphInput();
  (version as Record<string, unknown>).apiVersion = 'devcontour-harness/v0';
  assert.equal(workGraphSchema.safeParse(version).success, false);
});

test('Reviewer: по умолчанию тот же вендор отклонён, явно разрешённый — проходит', () => {
  const cross = executionPolicySchema.parse(example('policy'));
  const same = executionPolicySchema.parse(example('policy-same-vendor'));
  for (const kind of ['code', 'plan', 'contract'] as const) {
    const ok = selectReviewer(cross, kind, { runtime: 'claude' }, 'developer');
    assert.equal(ok.ok && ok.reviewer.runtime, 'codex');
    const refused = selectReviewer(cross, kind, { runtime: 'codex' }, 'developer');
    assert.equal(!refused.ok && refused.code, 'REVIEWER_SAME_VENDOR');
    const allowed = selectReviewer(same, kind, { runtime: 'claude' }, 'developer');
    assert.equal(allowed.ok && allowed.sameVendor, true);
  }
  // Политика с недопустимой парой не проходит validate до запуска.
  const bad = clone(example('policy')) as { review: { code: { reviewer: { runtime: string } } } };
  bad.review.code.reviewer.runtime = 'claude';
  assert.deepEqual(
    policyIssues(executionPolicySchema.parse(bad)).map((i) => i.code),
    ['REVIEWER_SAME_VENDOR'],
  );
  assert.throws(
    () => validateInputs({ graph: example('graph'), policy: bad }),
    (e: unknown) => e instanceof HarnessError && e.code === 'REVIEWER_SAME_VENDOR',
  );
});

test('Группы gates: раскрытие по одному разу, цикл и неизвестный член отклоняются', () => {
  const gate = (id: string) => ({ id, kind: 'check' as const, command: ['true'], timeoutMs: 1 });
  const repo = {
    id: 'app',
    gates: [gate('lint'), gate('unit'), gate('e2e')],
    gateGroups: { fast: ['lint', 'unit'], all: ['@fast', 'unit', 'e2e', '@fast'] },
  };
  assert.deepEqual(expandGateRefs(repo, ['@all', 'lint']), ['lint', 'unit', 'e2e']);
  assert.deepEqual(expandGateRefs(repo, undefined), ['lint', 'unit', 'e2e']);
  assert.throws(
    () => expandGateRefs({ ...repo, gateGroups: { a: ['@b'], b: ['@a'] } }, ['@a']),
    (e: Error & { code?: string }) => e.code === 'GATE_GROUP_CYCLE',
  );
  assert.throws(
    () => expandGateRefs(repo, ['@missing']),
    (e: Error & { code?: string }) => e.code === 'GATE_UNKNOWN',
  );
  assert.throws(
    () => expandGateRefs(repo, ['deploy']),
    (e: Error & { code?: string }) => e.code === 'GATE_UNKNOWN',
  );
});

test('Событие не может нести токен владения или секрет', () => {
  const event = {
    apiVersion: API_VERSION,
    seq: 1,
    at: '2026-01-01T00:00:00.000Z',
    type: 'attempt.claimed',
    runId: 'r1',
    payload: { owner: 'controller-1', attempt: 1 },
  };
  assert.equal(runEventSchema.safeParse(event).success, true);
  for (const payload of [
    { token: 'x' },
    { leaseToken: 'x' },
    { nested: { apiKey: 'x' } },
    { list: [{ password: 'x' }] },
  ])
    assert.equal(
      runEventSchema.safeParse({ ...event, payload }).success,
      false,
      JSON.stringify(payload),
    );
});

test('Результат accepted требует integration и result SHA, отказ — причину', () => {
  const sha = 'b'.repeat(40);
  const digest = digestOf('x');
  const base = {
    apiVersion: API_VERSION,
    workOrderId: 'add-greeting',
    graphId: 'greeting',
    source: { connector: 'files', ref: 'add-greeting', revision: '1' },
    runId: 'r1',
    attempt: 1,
    repositoryId: 'app',
    targetRef: 'refs/heads/harness/accepted',
    inputs: {
      harnessVersion: '0.1.0-alpha.0',
      stateVersion: 1,
      workOrderDigest: digest,
      graphDigest: digest,
      policyDigest: digest,
    },
    evidence: [],
    finishedAt: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(
    runResultSchema.safeParse({ ...base, outcome: 'accepted', shas: { candidate: sha } }).success,
    false,
  );
  assert.equal(
    runResultSchema.safeParse({
      ...base,
      outcome: 'accepted',
      shas: { candidate: sha, integration: sha, result: sha },
    }).success,
    true,
  );
  assert.equal(
    runResultSchema.safeParse({ ...base, outcome: 'rejected', shas: {} }).success,
    false,
  );
  assert.equal(
    runResultSchema.safeParse({
      ...base,
      outcome: 'rejected',
      shas: {},
      stopReason: { code: 'GATE_FAILED', message: 'unit failed' },
    }).success,
    true,
  );
});
