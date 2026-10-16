import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_VERSION,
  digestOf,
  sha256,
  type ContractDocument,
  type WorkGraph,
} from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { CorpusStore, suiteBasis } from '../src/verification/corpus.ts';
import { ready, sha } from './engine-fixture.ts';
import { propertySetup } from './property-fixture.ts';

/** Техническое ревью документа контракта (управляемое, без модели). */
function reviewed(e: Engine, doc: ContractDocument, round = 1) {
  e.recordReview(
    {
      id: `RV-contract-${doc.id}-${round}-${digestOf(doc).slice(0, 8)}`,
      kind: 'contract',
      subject: doc.id,
      digest: digestOf(doc),
      round,
      at: new Date().toISOString(),
      approved: true,
      summary: 'контракт годен',
      authorRuntime: 'claude',
      reviewerRuntime: 'codex',
      sameVendor: false,
      reviewerBinding: e.reviewerBinding('contract', 'claude')!,
      findings: [],
      artifact: 'controlled',
    },
    doc,
  );
}

/** Подтверждённый случай свойства принят поручением: новая версия корпуса. */
function adoptCase(e: Engine, repoHead: string, value: number) {
  const corpus = new CorpusStore(e);
  const ref = e.read((v) => corpus.suiteFor(v, v.work('add-greeting')!, 'knapsack-optimal'));
  const key = `rebind-${ref.suite.id}-${value}`;
  const begun = corpus.begin(ref.suite, key);
  const input = JSON.stringify({ items: [{ w: 0, v: value }], cap: 0 });
  const recorded = corpus.record(
    ref.suite,
    key,
    begun.token!,
    {
      property: 'knapsack-optimal',
      input,
      inputHash: sha256(input),
      outcome: 'confirmed',
      reason: 'управляемое подтверждение',
      source: { sha: repoHead },
      origin: { kind: 'agent' },
      observed: {
        expected: String(value),
        actual: '0',
        equal: false,
        repeats: 2,
        durationsMs: [1, 1],
      },
    },
    () => sha('b'),
    { works: ['add-greeting'], actor: 'agent' },
  );
  corpus.adopt(ref.suite.id, recorded.pending!.id);
  return { corpus, suite: corpus.read(ref.suite.id) };
}

/** Новая редакция графа: поручение ссылается на `contracts`. */
function revision(graph: WorkGraph, n: number, contracts: ContractDocument[]): WorkGraph {
  const next = structuredClone(graph);
  next.source.revision = String(n);
  next.orders[0]!.source.revision = String(n);
  next.orders[0]!.contracts = contracts.map((c) => ({ id: c.id, digest: digestOf(c) }));
  return next;
}

const plain = (id: string, content: string): ContractDocument => ({
  apiVersion: API_VERSION,
  id,
  title: 'API ' + id,
  content,
});

test('S2-R1-05: тот же ID контракта с новыми правилами ответа не наследует прежний корпус; новый корпус — отдельный, принятая история сохранена', () => {
  const ctx = propertySetup({ writer: {} });
  const e = ctx.engine;
  ready(e, ctx.graph);
  const old = adoptCase(e, ctx.repo.head(), 5);
  const binding = e.read((v) => v.work('add-greeting')!.checkVersion)!;
  assert.equal(binding.suite, old.suite.id);
  // Новая редакция того же ID: другие правила ответа — другое основание.
  const changed = structuredClone(ctx.contract);
  changed.checks!.obligations[0]!.answer.rules = 'Значение оптимума плюс единица';
  assert.notEqual(suiteBasis(changed), old.suite.basis);
  reviewed(e, changed, 2);
  ready(e, revision(ctx.graph, 2, [changed]));
  assert.equal(
    e.read((v) => v.work('add-greeting')!.checkVersion),
    undefined,
    'привязка к корпусу прежнего основания снята',
  );
  const fresh = e.read((v) =>
    old.corpus.suiteFor(v, v.work('add-greeting')!, 'knapsack-optimal'),
  ).suite;
  assert.notEqual(fresh.id, old.suite.id, 'новое основание — отдельный корпус');
  assert.equal(fresh.basis, suiteBasis(changed));
  assert.equal(fresh.contractDigest, digestOf(changed));
  assert.deepEqual(fresh.versions, []);
  const a = e.claim('c1')!;
  assert.equal(a.checks?.corpus, undefined, 'попытка не получает прежний корпус');
  e.cancel('add-greeting');
  // Принятие в новом корпусе привязывает поручение к нему; прежний корпус — история.
  e.retry('add-greeting', { reason: 'новая попытка' });
  const next = adoptCase(e, ctx.repo.head(), 7);
  assert.equal(next.suite.id, fresh.id);
  assert.equal(
    e.read((v) => v.work('add-greeting')!.checkVersion?.suite),
    fresh.id,
  );
  assert.equal(
    old.corpus.read(old.suite.id).adoptions.length,
    1,
    'принятия прежнего корпуса сохранены',
  );
  assert.deepEqual(old.corpus.read(old.suite.id).versions, old.suite.versions);
  ctx.store.close();
});

test('S2-R1-05/F08: переход на новый ID контракта снимает прежнюю привязку; новый корпус принимается', () => {
  const ctx = propertySetup({ writer: {} });
  const e = ctx.engine;
  ready(e, ctx.graph);
  const old = adoptCase(e, ctx.repo.head(), 5);
  const renamed: ContractDocument = { ...structuredClone(ctx.contract), id: 'knap-v2' };
  reviewed(e, renamed);
  ready(e, revision(ctx.graph, 2, [renamed]));
  assert.equal(
    e.read((v) => v.work('add-greeting')!.checkVersion),
    undefined,
  );
  const fresh = adoptCase(e, ctx.repo.head(), 7);
  assert.equal(fresh.suite.id, 'KS-knap-v2');
  assert.equal(fresh.suite.contractId, 'knap-v2');
  assert.equal(
    e.read((v) => v.work('add-greeting')!.checkVersion?.suite),
    'KS-knap-v2',
  );
  assert.equal(old.corpus.read(old.suite.id).adoptions.length, 1);
  ctx.store.close();
});

test('S2-R1-05/F11: изменение постороннего контракта или текста без смены основания сохраняет корпус договора проверки', () => {
  const ctx = propertySetup({ writer: {} });
  const e = ctx.engine;
  const api1 = plain('api', 'Plain API contract v1');
  reviewed(e, api1);
  const graph = revision(ctx.graph, 1, [ctx.contract, api1]);
  ready(e, graph);
  const { suite } = adoptCase(e, ctx.repo.head(), 5);
  const before = e.read((v) => v.work('add-greeting')!.checkVersion)!;
  assert.equal(before.suite, suite.id);
  // Посторонний контракт сменил редакцию.
  const api2 = plain('api', 'Plain API contract v2');
  reviewed(e, api2, 2);
  ready(e, revision(graph, 2, [ctx.contract, api2]));
  assert.deepEqual(
    e.read((v) => v.work('add-greeting')!.checkVersion),
    before,
    'корпус не снят',
  );
  // Тот же договор проверки, изменён только поясняющий текст: основание то же.
  const retitled = { ...structuredClone(ctx.contract), content: 'Тот же договор, другой текст.' };
  assert.equal(suiteBasis(retitled), suite.basis);
  reviewed(e, retitled, 2);
  ready(e, revision(graph, 3, [retitled, api2]));
  assert.deepEqual(
    e.read((v) => v.work('add-greeting')!.checkVersion),
    before,
  );
  const a = e.claim('c1')!;
  assert.equal(a.checks?.corpus?.digest, before.digest, 'попытка исполняет прежний корпус');
  ctx.store.close();
});
