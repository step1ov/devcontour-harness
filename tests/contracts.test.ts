import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_VERSION,
  HarnessError,
  CONTEXT_LIMITS,
  canonicalJson,
  pinnedBytes,
  contextIssues,
  digestOf,
  eventPayloads,
  executionPolicySchema,
  expandGateRefs,
  findingId,
  graphIssues,
  policyDigest,
  policyIssues,
  reviewIssues,
  reviewResultSchema,
  runEventSchema,
  runResultSchema,
  selectReviewer,
  sha256,
  sourceDigest,
  workGraphDigest,
  workGraphSchema,
  type ContextSnapshot,
  type PinnedFile,
  type EventType,
  type WorkGraphInput,
} from '../src/contracts/index.ts';
import { validateInputs } from '../src/validate.ts';
import { clone, example } from './fixtures.ts';
import { validPayloads } from './fixtures-events.ts';

const graphInput = () => clone(example('graph')) as unknown as WorkGraphInput;
const order = (id: string, dependsOn: string[] = []) => ({
  ...(graphInput().orders[0] as object),
  id,
  dependsOn,
});
const graphWith = (orders: object[], prerequisites: object[] = []) =>
  workGraphSchema.parse({ ...graphInput(), orders, prerequisites });

test('Канонический JSON и digests примера равны закреплённым значениям', () => {
  // Эталоны: смена формулы digest — несовместимое изменение договора, а не рефакторинг.
  assert.equal(
    canonicalJson({ b: [1, { d: undefined, c: 'x' }], a: null }),
    '{"a":null,"b":[1,{"c":"x"}]}',
  );
  const graph = workGraphSchema.parse(example('graph'));
  assert.equal(
    workGraphDigest(graph),
    '1328a41de2b74096de57553d096d2f7782b5b1e235bb0956d20ea78d6f266c2c',
  );
  assert.equal(
    policyDigest(executionPolicySchema.parse(example('policy'))),
    '85f4cf1781095bf157271cd6668a31b8a92203a0e8ca3e3f92670ed9e4c3c8c1',
  );
  const reordered = Object.fromEntries(Object.entries(example('graph')).reverse());
  assert.equal(
    validateInputs({ graph: reordered, policy: example('policy') }).graphDigest,
    workGraphDigest(graph),
  );
});

test('Изменение каждого поля поручения меняет digest графа', () => {
  const base = workGraphDigest(workGraphSchema.parse(graphInput()));
  const changes: Record<string, (o: Record<string, unknown>) => void> = {
    id: (o) => (o.id = 'other-id'),
    source: (o) => (o.source = { connector: 'files', ref: 'add-greeting', revision: '2' }),
    title: (o) => (o.title = 'Другое название'),
    goal: (o) => (o.goal = 'Другая цель поручения целиком.'),
    acceptance: (o) => (o.acceptance = ['другой критерий']),
    role: (o) => (o.role = 'tester'),
    repositoryId: (o) => (o.repositoryId = 'web'),
    relatedRepositories: (o) => (o.relatedRepositories = ['app', 'web']),
    writeScope: (o) => (o.writeScope = ['src']),
    dependsOn: (o) => (o.dependsOn = ['x']),
    gates: (o) => (o.gates = []),
    consumers: (o) => (o.consumers = [{ repositoryId: 'web', gates: ['unit'] }]),
    properties: (o) => (o.properties = ['p1']),
    resources: (o) => (o.resources = ['db']),
    requirements: (o) =>
      (o.requirements = [
        {
          id: 'REQ-1',
          source: 'a.md',
          digest: sha256('abc'),
          text: 'abc',
          gate: 'unit',
          scenario: 'xyz',
        },
      ]),
    contracts: (o) => (o.contracts = [{ id: 'api', digest: sha256('api') }]),
    context: (o) => (o.context = ['rules']),
  };
  const fields = Object.keys(workGraphSchema.shape.orders.element.shape).filter(
    (k) => k !== 'apiVersion',
  );
  assert.deepEqual(Object.keys(changes).sort(), fields.sort(), 'каждое поле поручения проверено');
  for (const [field, change] of Object.entries(changes)) {
    const changed = graphInput();
    change(changed.orders[0] as unknown as Record<string, unknown>);
    assert.notEqual(workGraphDigest(workGraphSchema.parse(changed)), base, field);
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

test('Форма предпосылки: только receipt с полным SHA; отметка done не предпосылка', () => {
  // Тест формы. Доверие receipt и наличие SHA в target ref проверяет движок (этап 1).
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
  for (const writeScope of [['../x'], ['/abs'], ['src/*'], ['a\\b'], ['./src'], ['a/../b']]) {
    const g = graphInput();
    g.orders[0]!.writeScope = writeScope;
    assert.equal(workGraphSchema.safeParse(g).success, false, writeScope[0]);
  }
  const extra = graphInput();
  (extra.orders[0] as Record<string, unknown>).status = 'done';
  assert.equal(workGraphSchema.safeParse(extra).success, false, 'поручение не несёт статус');
  const version = graphInput();
  (version as Record<string, unknown>).apiVersion = 'devcontour-harness/v0';
  assert.equal(workGraphSchema.safeParse(version).success, false);
});

test('Reviewer: все четыре пары writer/reviewer по правилу вендора, для code, plan и contract', () => {
  const withReviewer = (runtime: 'codex' | 'claude', vendor?: string) => {
    const p = clone(example('policy')) as { review: Record<string, unknown> };
    for (const k of ['code', 'plan', 'contract'])
      p.review[k] = { reviewer: { runtime }, ...(vendor ? { vendor } : {}) };
    return executionPolicySchema.parse(p);
  };
  for (const kind of ['code', 'plan', 'contract'] as const)
    for (const writer of ['claude', 'codex'] as const)
      for (const reviewer of ['claude', 'codex'] as const) {
        const same = writer === reviewer;
        const strict = selectReviewer(withReviewer(reviewer), kind, { runtime: writer });
        assert.equal(strict.ok, !same, `${kind} ${writer}→${reviewer} по умолчанию`);
        if (!strict.ok) assert.equal(strict.code, 'REVIEWER_SAME_VENDOR');
        const allowed = selectReviewer(withReviewer(reviewer, 'same-vendor-allowed'), kind, {
          runtime: writer,
        });
        assert.equal(allowed.ok, true, `${kind} ${writer}→${reviewer} с разрешением`);
        assert.equal(allowed.ok && allowed.sameVendor, same);
        assert.equal(allowed.ok && allowed.reviewer.runtime, reviewer);
      }
  // Автор вне harness: его вендор не совпадает ни с одним runtime.
  for (const reviewer of ['claude', 'codex'] as const)
    assert.equal(selectReviewer(withReviewer(reviewer), 'plan', { runtime: 'external' }).ok, true);
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
  for (const ref of ['@missing', 'deploy'])
    assert.throws(
      () => expandGateRefs(repo, [ref]),
      (e: Error & { code?: string }) => e.code === 'GATE_UNKNOWN',
    );
});

const event = (type: string, payload: unknown) => ({
  apiVersion: API_VERSION,
  seq: 1,
  at: '2026-01-01T00:00:00.000Z',
  type,
  runId: 'r1',
  payload,
});

test('Нагрузка каждого типа события закрыта: валидная принимается, с токеном или лишним полем — нет', () => {
  assert.deepEqual(
    Object.keys(validPayloads).sort(),
    Object.keys(eventPayloads).sort(),
    'фикстура на каждый тип',
  );
  for (const type of Object.keys(eventPayloads) as EventType[]) {
    const valid = validPayloads[type];
    assert.equal(runEventSchema.safeParse(event(type, valid)).success, true, type + ': валидная');
    assert.equal(
      runEventSchema.safeParse(event(type, { ...valid, token: 'secret-token' })).success,
      false,
      type + ': token',
    );
    assert.equal(
      runEventSchema.safeParse(event(type, { ...valid, arbitrary: 'x' })).success,
      false,
      type + ': лишнее поле',
    );
  }
  assert.equal(
    runEventSchema.safeParse(event('run.claimed', validPayloads['attempt.claimed'])).success,
    false,
  );
});

const resultBase = () => {
  const d = digestOf('x');
  return {
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
      workOrderDigest: d,
      graphDigest: d,
      policyDigest: d,
    },
    checked: { dependencies: [], freshness: [], consumers: [] },
    evidence: [],
    finishedAt: '2026-01-01T00:00:00.000Z',
  };
};

test('Результат accepted требует все SHA, иной исход — причину с кодом и без result SHA', () => {
  const sha = 'b'.repeat(40);
  const all = { base: sha, candidate: sha, integration: sha, result: sha };
  const ok = (v: object) => runResultSchema.safeParse({ ...resultBase(), ...v }).success;
  assert.equal(ok({ outcome: 'accepted', shas: all }), true);
  for (const missing of ['base', 'candidate', 'integration', 'result']) {
    const shas: Record<string, string> = { ...all };
    delete shas[missing];
    assert.equal(ok({ outcome: 'accepted', shas }), false, missing);
  }
  assert.equal(ok({ outcome: 'rejected', shas: {} }), false);
  assert.equal(
    ok({ outcome: 'rejected', shas: {}, stopReason: { code: 'NO_SUCH', message: 'x' } }),
    false,
  );
  assert.equal(
    ok({ outcome: 'rejected', shas: {}, stopReason: { code: 'GATE_FAILED', message: 'unit' } }),
    true,
  );
  assert.equal(
    ok({
      outcome: 'rejected',
      shas: { result: sha },
      stopReason: { code: 'GATE_FAILED', message: 'x' },
    }),
    false,
  );
});

const file = (path: string, text: string) => ({
  path,
  digest: sha256(text),
  bytes: Buffer.byteLength(text),
  content: { encoding: 'utf8' as const, data: text },
});
const snapshot = (files: PinnedFile[] = [file('rules.md', 'Правило один.')]): ContextSnapshot => {
  const entry = { id: 'rules', kind: 'files', version: '1', required: true, files, references: [] };
  return {
    apiVersion: API_VERSION,
    sources: [{ ...entry, digest: sourceDigest(entry) }],
    missing: [],
  };
};

test('Контекст: содержимое сверяется с digest, размером и digest источника', () => {
  assert.deepEqual(contextIssues(snapshot()), []);
  const forged = snapshot();
  forged.sources[0]!.files[0]!.content = { encoding: 'utf8', data: 'Подменённое правило.' };
  assert.match(contextIssues(forged).join('\n'), /digest не совпадает с содержимым/);
  const resized = snapshot();
  resized.sources[0]!.files[0]!.bytes += 1;
  assert.match(contextIssues(resized).join('\n'), /размер не совпадает/);
  const swapped = snapshot();
  swapped.sources[0]!.files = [file('rules.md', 'Другое правило.')];
  assert.match(contextIssues(swapped).join('\n'), /digest источника не совпадает/);
  const graph = clone(example('graph')) as { orders: { context?: string[] }[] };
  graph.orders[0]!.context = ['rules', 'missing'];
  assert.throws(
    () => validateInputs({ graph, policy: example('policy'), context: snapshot() }),
    (e: unknown) => e instanceof HarnessError && /missing/.test(JSON.stringify(e.issues)),
  );
  const duplicate = snapshot([file('rules.md', 'а'), file('rules.md', 'б')]);
  assert.match(contextIssues(duplicate).join('\n'), /повтор файла/);
  const big = 'x'.repeat(CONTEXT_LIMITS.fileBytes + 1);
  assert.match(contextIssues(snapshot([file('big.md', big)])).join('\n'), /больше предела/);
  const bytes = Buffer.from([0, 1, 2, 255]);
  const binary = {
    path: 'blob.bin',
    digest: sha256(bytes),
    bytes: 4,
    content: { encoding: 'base64' as const, data: bytes.toString('base64') },
  };
  assert.deepEqual(contextIssues(snapshot([binary])), [], 'base64 сверяется по байтам');
  assert.deepEqual([...pinnedBytes(binary)], [0, 1, 2, 255]);
  assert.throws(
    () => pinnedBytes({ ...binary, content: { encoding: 'base64', data: 'AAAA' } }),
    /не совпадает/,
  );
  graph.orders[0]!.context = ['rules'];
  assert.match(
    String(validateInputs({ graph, policy: example('policy'), context: snapshot() }).contextDigest),
    /^[a-f0-9]{64}$/,
  );
});

test('Ревью: approved при блокирующей находке и неназванная прежняя находка — отказ', () => {
  const blocking = { severity: 'blocking' as const, message: 'Нет отказа на цикл' };
  const prev = [{ id: findingId('graph-1', blocking), severity: 'blocking' as const }];
  assert.equal(findingId('graph-1', blocking), findingId('graph-1', { ...blocking }));
  assert.notEqual(findingId('graph-1', blocking), findingId('graph-2', blocking));
  assert.notEqual(
    findingId('graph-1', blocking),
    findingId('graph-1', { ...blocking, rule: 'feasibility' }),
  );
  assert.notEqual(
    findingId('graph-1', blocking),
    findingId('graph-1', { message: 'Другой текст' }),
  );
  const parse = (v: object) => reviewResultSchema.parse({ summary: 's', findings: [], ...v });
  assert.deepEqual(reviewIssues(parse({ approved: true, findings: [blocking] }), []), [
    'approved при блокирующей находке',
  ]);
  assert.match(
    reviewIssues(parse({ approved: true }), prev).join('\n'),
    /Не названо состояние прежней находки/,
  );
  const transition = (status: string, basis: string) => [{ id: prev[0]!.id, status, basis }];
  assert.match(
    reviewIssues(
      parse({ approved: true, previous: transition('open', 'не исправлено') }),
      prev,
    ).join('\n'),
    /approved при блокирующей находке/,
  );
  assert.deepEqual(
    reviewIssues(
      parse({ approved: true, previous: transition('closed', 'добавлен отказ на цикл') }),
      prev,
    ),
    [],
  );
  assert.deepEqual(
    reviewIssues(
      parse({
        approved: true,
        previous: transition('withdrawn', 'находка ошибочна: цикл уже отклонён'),
      }),
      prev,
    ),
    [],
    'снятая находка не блокирует',
  );
  assert.match(
    reviewIssues(
      parse({
        approved: false,
        previous: [...transition('closed', 'исправлено'), ...transition('open', 'нет')],
      }),
      prev,
    ).join('\n'),
    /названо дважды/,
  );
  assert.match(
    reviewIssues(
      parse({
        approved: false,
        previous: [{ id: digestOf('чужая'), status: 'closed', basis: 'xxx' }],
      }),
      [],
    ).join('\n'),
    /неизвестной находки/,
  );
});
