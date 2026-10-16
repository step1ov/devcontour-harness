import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  API_VERSION,
  digestOf,
  publishedSchemas,
  sha256,
  sourceDigest,
} from '../src/contracts/index.ts';
import { example } from './fixtures.ts';

type Name = keyof typeof publishedSchemas;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const compiled = new Map<Name, ReturnType<typeof ajv.compile>>();
const published = (name: Name) => {
  if (!compiled.has(name))
    compiled.set(
      name,
      ajv.compile(
        JSON.parse(
          readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'),
        ) as object,
      ),
    );
  return compiled.get(name)!;
};

const sha = 'b'.repeat(40);
const d = digestOf('x');
const result = {
  apiVersion: API_VERSION,
  workOrderId: 'add-greeting',
  graphId: 'greeting',
  source: { connector: 'files', ref: 'add-greeting', revision: '1' },
  runId: 'r1',
  attempt: 1,
  repositoryId: 'app',
  targetRef: 'refs/heads/harness/accepted',
  inputs: {
    harnessVersion: '0.1.0',
    stateVersion: 1,
    workOrderDigest: d,
    graphDigest: d,
    policyDigest: d,
  },
  checked: { dependencies: [], freshness: [], consumers: [] },
  evidence: [],
  finishedAt: '2026-01-01T00:00:00.000Z',
};
const accepted = {
  ...result,
  outcome: 'accepted',
  shas: { base: sha, candidate: sha, integration: sha, result: sha },
};
const claimed = {
  apiVersion: API_VERSION,
  seq: 1,
  at: '2026-01-01T00:00:00.000Z',
  type: 'attempt.claimed',
  payload: {
    owner: 'c',
    runtime: 'claude',
    reviewer: 'codex',
    policyDigest: d,
    engineVersion: '0.1.0',
  },
};
const text = 'Правило один.';
const entry = {
  id: 'rules',
  kind: 'files',
  version: '1',
  required: true,
  files: [
    {
      path: 'rules.md',
      digest: sha256(text),
      bytes: Buffer.byteLength(text),
      content: { encoding: 'utf8', data: text },
    },
  ],
  references: [],
};
const context = {
  apiVersion: API_VERSION,
  sources: [{ ...entry, digest: sourceDigest(entry as never) }],
  missing: [],
};
const graph = example('graph') as { orders: Record<string, unknown>[] };
const withOrder = (patch: Record<string, unknown>) => ({
  ...graph,
  orders: [{ ...graph.orders[0], ...patch }],
});
const policy = example('policy') as { repositories: Record<string, unknown>[] };
const withRepo = (patch: Record<string, unknown>) => ({
  ...policy,
  repositories: [{ ...policy.repositories[0], ...patch }],
});

/**
 * Одни и те же входы обязаны получить одинаковый вердикт от Zod и от
 * опубликованной JSON Schema. Отрицательные примеры — ограничения, которые
 * раньше терялись при генерации.
 */
const corpus: [Name, string, unknown, boolean][] = [
  ['work-graph', 'пример', graph, true],
  ['work-graph', 'writeScope ../outside', withOrder({ writeScope: ['../outside'] }), false],
  ['work-graph', 'writeScope glob', withOrder({ writeScope: ['src/*'] }), false],
  ['work-graph', 'writeScope ./src', withOrder({ writeScope: ['./src'] }), false],
  ['work-graph', 'лишнее поле status', withOrder({ status: 'done' }), false],
  ['execution-policy', 'пример', policy, true],
  ['execution-policy', 'пустой предел бюджета', { ...policy, budgets: { work: {} } }, false],
  [
    'execution-policy',
    'предел только времени',
    { ...policy, budgets: { work: { timeMs: 1000 } } },
    true,
  ],
  [
    'execution-policy',
    'test gate без отчёта',
    withRepo({ gates: [{ id: 'unit', kind: 'test', command: ['x'] }] }),
    false,
  ],
  ['execution-policy', 'targetRef main.', withRepo({ targetRef: 'refs/heads/main.' }), false],
  ['execution-policy', 'targetRef a.lock/b', withRepo({ targetRef: 'refs/heads/a.lock/b' }), false],
  [
    'execution-policy',
    'env HARNESS_',
    { ...policy, environment: { values: { HARNESS_X: '1' } } },
    false,
  ],
  [
    'execution-policy',
    'больше 100 групп',
    withRepo({
      gateGroups: Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['g' + i, ['unit']])),
    }),
    false,
  ],
  ['run-result', 'accepted', accepted, true],
  [
    'run-result',
    'accepted без SHA',
    { ...result, outcome: 'accepted', shas: { candidate: sha } },
    false,
  ],
  ['run-result', 'rejected без причины', { ...result, outcome: 'rejected', shas: {} }, false],
  [
    'run-result',
    'rejected с причиной',
    { ...result, outcome: 'rejected', shas: {}, stopReason: { code: 'GATE_FAILED', message: 'x' } },
    true,
  ],
  [
    'run-result',
    'rejected с result SHA',
    {
      ...result,
      outcome: 'rejected',
      shas: { result: sha },
      stopReason: { code: 'GATE_FAILED', message: 'x' },
    },
    false,
  ],
  ['run-event', 'attempt.claimed', claimed, true],
  [
    'run-event',
    'token в нагрузке',
    { ...claimed, payload: { ...claimed.payload, token: 't' } },
    false,
  ],
  ['run-event', 'произвольная нагрузка', { ...claimed, payload: { arbitrary: 'x' } }, false],
  ['run-event', 'неизвестный тип', { ...claimed, type: 'run.claimed' }, false],
  ['context-snapshot', 'снимок', context, true],
  [
    'context-snapshot',
    'файл без содержимого',
    {
      ...context,
      sources: [{ ...context.sources[0], files: [{ path: 'rules.md', digest: d, bytes: 1 }] }],
    },
    false,
  ],
];

for (const [name, label, value, expected] of corpus)
  test(`JSON Schema ${name} и Zod согласны: ${label}`, () => {
    const zod = publishedSchemas[name].safeParse(value).success;
    const json = published(name)(value);
    assert.equal(zod, expected, 'Zod');
    assert.equal(
      json,
      expected,
      'JSON Schema: ' + JSON.stringify(published(name).errors?.slice(0, 2)),
    );
  });

test('Каждая опубликованная схема есть в каталоге и компилируется', () => {
  for (const name of Object.keys(publishedSchemas) as Name[])
    assert.equal(typeof published(name), 'function');
});
