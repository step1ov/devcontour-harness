/**
 * alpha.72, P9-6: метки поручения через коннектор (`tasks[].labels`) —
 * Relay их не хранит, они часть сопоставления. `release.docs: required` без
 * задачи docs — предупреждение source-check и doctor.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionPolicySchema } from '../src/contracts/index.ts';
import { openConnector, parseConfig } from '../src/integrations/connector/index.ts';
import { fakeSuiteBackend, scenario } from '../src/integrations/connector/testing.ts';
import { RELEASE_DOCS_UNMARKED, releaseDocsUnmarked } from '../src/control/release-docs.ts';
import { doctor } from '../src/control/doctor.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { graphOf, policyOf, ready } from './engine-fixture.ts';

const withLabels = (config: Record<string, unknown>, labels: string[]) => {
  (config.tasks as Record<string, unknown>[])[0]!.labels = labels;
};

test('alpha.72: tasks[].labels — метка в поручении снимка; постановка задачи та же, ревизия набора новая', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const open = (cfg: Record<string, unknown>) =>
      openConnector(parseConfig(structuredClone(cfg), s.root), {
        stateDir: s.state,
        transport: s.project.transport(),
      });
    const plain = await open(s.config);
    const before = await plain.source.snapshot();
    plain.close();
    assert.equal(before.graph.orders[0]!.labels, undefined, 'без поля меток нет');
    const cfg = structuredClone(s.config) as Record<string, unknown>;
    withLabels(cfg, ['docs']);
    const labelled = await open(cfg);
    const after = await labelled.source.snapshot();
    labelled.close();
    assert.deepEqual(after.graph.orders[0]!.labels, ['docs']);
    assert.notEqual(after.revision, before.revision, 'метка — новое поручение, новое согласование');
    assert.equal(
      after.manifest.tasks[0]!.semanticDigest,
      before.manifest.tasks[0]!.semanticDigest,
      'метка не постановка: принятый результат не становится прежним',
    );
    // Неизвестная метка — отказ схемы, как у задачи плана.
    const bad = structuredClone(s.config) as Record<string, unknown>;
    withLabels(bad, ['Bad Label']);
    assert.throws(() => parseConfig(bad, s.root));
  } finally {
    await s.cleanup();
  }
});

test('alpha.72: source-check — release.docs: required без задачи docs предупреждает; с меткой — нет', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const check = async (cfg: Record<string, unknown>, docs?: 'required' | 'advisory') => {
      const policy = executionPolicySchema.parse({
        ...structuredClone(s.policy),
        ...(docs ? { release: { docs } } : {}),
      });
      const c = await openConnector(parseConfig(structuredClone(cfg), s.root), {
        stateDir: s.state,
        transport: s.project.transport(),
      });
      try {
        return (await c.check(policy)).warnings ?? [];
      } finally {
        c.close();
      }
    };
    assert.ok((await check(s.config, 'required')).includes(RELEASE_DOCS_UNMARKED));
    assert.ok(!(await check(s.config, 'advisory')).includes(RELEASE_DOCS_UNMARKED));
    assert.ok(!(await check(s.config)).includes(RELEASE_DOCS_UNMARKED));
    const cfg = structuredClone(s.config) as Record<string, unknown>;
    withLabels(cfg, ['docs']);
    assert.ok(!(await check(cfg, 'required')).includes(RELEASE_DOCS_UNMARKED));
  } finally {
    await s.cleanup();
  }
});

test('alpha.72: doctor — работы из коннектора без метки docs при release.docs: required — предупреждение', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-docs-doctor-')));
  const policy = policyOf((p) => {
    p.release = { docs: 'required' };
  });
  const store = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  const engine = new Engine({ host: standaloneHost(store, policy), policy });
  const graph = graphOf({ w: [] });
  for (const o of graph.orders) o.source = { ...o.source, connector: 'relay-v1-http-abc' };
  ready(engine, graph);
  assert.equal(
    store.read((v) => releaseDocsUnmarked(v, policy)),
    true,
  );
  assert.equal(
    store.read((v) => releaseDocsUnmarked(v, { release: { docs: 'advisory' } })),
    false,
  );
  store.close();
  const report = await doctor(policy, {}, dir, undefined, undefined, {
    resourceDatabase: false,
  });
  assert.ok(report.warnings?.includes(RELEASE_DOCS_UNMARKED), JSON.stringify(report.warnings));
  // Работы из файлов (план ведущего) несут метки сами: не предупреждение doctor.
  const files = graphOf({ w: [] });
  const dir2 = realpathSync(mkdtempSync(join(tmpdir(), 'harness-docs-doctor-')));
  const store2 = new SqliteExecutionStore(join(dir2, 'state.sqlite'), 'test');
  ready(new Engine({ host: standaloneHost(store2, policy), policy }), files);
  assert.equal(
    store2.read((v) => releaseDocsUnmarked(v, policy)),
    false,
  );
  store2.close();
});
