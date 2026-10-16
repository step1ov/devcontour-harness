import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HarnessError,
  WORKSPACE_OWNER,
  digestOf,
  type ErrorCode,
  type PropertyReport,
} from '../src/contracts/index.ts';
import { implementationBasis } from '../src/engine/reuse.ts';
import {
  corpusWitness,
  propertyCoverage,
  propertySeed,
  readPropertyReport,
  type CheckManifest,
} from '../src/verification/property.ts';
import { effectiveChecks } from '../src/verification/checks.ts';
import { implement, runAll, target } from './runner-fixture.ts';
import { check, knap, propertySetup } from './property-fixture.ts';

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};
const passed = (testId: string, cases = 120, families?: Record<string, number>) => ({
  testId,
  status: 'passed' as const,
  cases,
  ...(families ? { families } : {}),
});
const manifest: CheckManifest = {
  properties: [
    { id: 'p', minCases: 100, families: [{ id: 'boundary', minCases: 30 }] },
    { id: 'q', minCases: 10, families: [] },
  ],
};
const junit = (ids: string[], status: 'passed' | 'failed' = 'passed') => ({
  cases: ids.map((id) => ({ id, status })),
  truncated: false,
});

test('AC01/AC02: пустой отчёт, ноль входов, отсутствующее, повторённое, короткое или скрытое свойство — не полное покрытие', () => {
  const report = (properties: PropertyReport['properties']): PropertyReport => ({
    version: 1,
    properties,
  });
  assert.match(propertyCoverage(report([]), undefined, undefined).join(), /отчёт свойств пуст/);
  assert.match(
    propertyCoverage(report([passed('p', 0)]), undefined, undefined).join(),
    /passed без единого/,
  );
  const full = report([passed('p', 120, { boundary: 30 }), passed('q', 10)]);
  assert.deepEqual(propertyCoverage(full, manifest, junit(['p', 'q'])), []);
  assert.match(
    propertyCoverage(report([passed('p', 120, { boundary: 30 })]), manifest, junit(['p'])).join(),
    /обязательное свойство q отсутствует/,
  );
  assert.match(
    propertyCoverage(
      report([passed('p', 120, { boundary: 30 }), passed('p'), passed('q')]),
      manifest,
      junit(['p', 'q']),
    ).join(),
    /свойство p указано в отчёте 2 раза/,
  );
  assert.match(
    propertyCoverage(
      report([passed('p', 99, { boundary: 30 }), passed('q')]),
      manifest,
      undefined,
    ).join(),
    /проверено 99 входов из обязательных 100/,
  );
  assert.match(
    propertyCoverage(
      report([passed('p', 120, { boundary: 5 }), passed('q')]),
      manifest,
      undefined,
    ).join(),
    /семейство boundary: проверено 5 входов из обязательных 30/,
  );
  // Имя testcase, скрытое хешем, не подтверждает свойство.
  assert.match(
    propertyCoverage(full, manifest, {
      cases: [
        { id: 'p', status: 'passed' },
        { id: 'q', status: 'passed', opaque: true },
      ],
      truncated: false,
    }).join(),
    /testcase q отсутствует в JUnit/,
  );
  assert.match(
    propertyCoverage(full, manifest, { cases: [], truncated: true }).join(),
    /список testcases обрезан/,
  );
  assert.match(
    propertyCoverage(full, manifest, junit(['p', 'q'], 'failed')).join(),
    /testcase p: failed, хотя отчёт свойств сообщает passed/,
  );
});

test('F01: покрытие корпуса доказывается свидетельством, а не счётом; провал случая — провал при зелёных свойствах', () => {
  const cases = [
    { id: 'K-1', property: 'p' },
    { id: 'K-2', property: 'p' },
  ];
  const withCorpus: CheckManifest = { ...manifest, corpus: { digest: 'a'.repeat(64), cases } };
  const props = [passed('p', 120, { boundary: 30 }), passed('q', 10)];
  const ok = {
    version: 1 as const,
    properties: props,
    corpus: {
      digest: 'a'.repeat(64),
      executed: 2,
      passed: 2,
      witness: corpusWitness(cases.map((c) => ({ id: c.id, passed: true }))),
      failed: [],
    },
  };
  assert.deepEqual(propertyCoverage(ok, withCorpus, undefined), []);
  const lie = {
    ...ok,
    corpus: { ...ok.corpus, witness: corpusWitness([{ id: 'K-1', passed: true }]) },
  };
  assert.match(propertyCoverage(lie, withCorpus, undefined).join(), /не все обязательные случаи/);
  const other = { ...ok, corpus: { ...ok.corpus, digest: 'b'.repeat(64) } };
  assert.match(propertyCoverage(other, withCorpus, undefined).join(), /корпус другой версии/);
  const failing = {
    ...ok,
    corpus: {
      ...ok.corpus,
      passed: 1,
      failed: [{ id: 'K-2', property: 'p' }],
      witness: corpusWitness([
        { id: 'K-1', passed: true },
        { id: 'K-2', passed: false },
      ]),
    },
  };
  assert.match(
    propertyCoverage(failing, withCorpus, undefined).join(),
    /случаи корпуса провалены: 1/,
  );
  assert.match(
    propertyCoverage({ ...ok, corpus: undefined }, withCorpus, undefined).join(),
    /обязательный корпус \(2 случаев\) не выполнялся/,
  );
});

test('Отчёт свойств читается только как обычный файл внутри своего каталога', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-report-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'harness-outside-')));
  writeFileSync(join(outside, 'report.json'), JSON.stringify({ version: 1, properties: [] }));
  symlinkSync(join(outside, 'report.json'), join(dir, 'report.json'));
  assert.equal(
    (await readPropertyReport(join(dir, 'report.json'), dir)).problem,
    'отчёт свойств — symlink',
  );
  assert.equal(
    (await readPropertyReport(join(outside, 'report.json'), dir)).problem,
    'отчёт свойств вне каталога отчёта',
  );
  writeFileSync(join(dir, 'bad.json'), '{');
  assert.equal(
    (await readPropertyReport(join(dir, 'bad.json'), dir)).problem,
    'отчёт свойств — не JSON',
  );
});

test('Seed задаёт controller: отказ воспроизводим, отчёт с контрпримером сохранён, evidence привязано к закреплённому эталону', async () => {
  const ctx = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.firstThree }),
    policy: (p) => (p.maxAttempts = 1),
  });
  const before = target(ctx);
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  const e = a.evidence.find((x) => x.gate === 'properties')!;
  assert.equal(e.passed, false);
  assert.equal(e.property?.seed, propertySeed(a.id, 'candidate', 'properties'));
  assert.match(e.property.reproduce, new RegExp(`^DEVCONTOUR_SEED=${e.property.seed} `));
  const failing = e.property?.report?.properties.find((p) => p.testId === 'knapsack-optimal');
  assert.equal(failing?.status, 'failed');
  assert.ok(failing?.counterexample, 'контрпример сохранён при отказе');
  assert.deepEqual(
    e.property?.artifacts.map((x) => x.path),
    ctx.contract.artifacts!.map((x) => x.path),
  );
  assert.equal(e.property?.contracts.knap, digestOf(ctx.contract));
  assert.match(a.error!, /свойство knapsack-optimal нарушено/);
  assert.equal(target(ctx), before, 'отказ до ревью и интеграции');
});

test('T18: недобор выборки не скрывается зелёным JUnit и кодом 0', async () => {
  const ctx = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    files: { 'check.mjs': check(50) },
    policy: (p) => (p.maxAttempts = 1),
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  const e = a.evidence.find((x) => x.gate === 'properties')!;
  assert.equal(e.exitCode, 0, 'проверка завершилась успешно');
  assert.equal(
    e.tests?.every((t) => t.status === 'passed'),
    true,
    'JUnit зелёный',
  );
  assert.equal(e.passed, false);
  assert.match(e.summary, /свойство reach-complete: проверено 70 входов из обязательных 100/);
  assert.equal(a.status, 'failed');
});

test('Поручение без свойств остаётся на прежнем уровне доказательства', async () => {
  const ctx = propertySetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    properties: false,
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  assert.equal(a.evidence.find((x) => x.gate === 'properties')?.property?.level, 'legacy');
});

test('AC16: попытка не может править закреплённый checker контракта', async () => {
  const ctx = propertySetup({
    writer: implement({
      'src/knap.mjs': knap.firstThree,
      'oracle.mjs': 'export const best = () => 0;\n',
    }),
    // Эталон внутри области записи поручения: защищает его только контракт.
    writeScope: ['src', 'oracle.mjs'],
    policy: (p) => (p.maxAttempts = 1),
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.failureKind, 'scope-violation');
  assert.match(a.error!, /Изменены защищённые файлы: oracle\.mjs/);
});

test('T18: чужая версия проверок отклоняется в finish (и в recovery, который принимает через finish) и в evidence; reuse её не берёт', async () => {
  const ctx = propertySetup({ writer: implement({ 'src/knap.mjs': knap.correct }) });
  const { engine } = ctx;
  const { graph } = engine.register(ctx.graph, { trusted: () => false, reachable: () => true });
  await ctx.runner.init();
  engine.recordReview({
    id: 'RV-plan-1',
    kind: 'plan',
    subject: graph.id,
    digest: graph.digest,
    round: 1,
    at: new Date().toISOString(),
    approved: true,
    summary: 'ok',
    authorRuntime: 'claude',
    reviewerRuntime: 'codex',
    sameVendor: false,
    reviewerBinding: engine.reviewerBinding('plan', 'claude')!,
    findings: [],
    artifact: 'x',
  });
  engine.approve(graph.id, 'agent');
  engine.resume();
  engine.lead('c1');
  const a = engine.claim('c1')!;
  const pinned = a.checks!.effective;
  const sha = 'c'.repeat(40);
  engine.phase(a.id, a.token, 'verifying', { candidateSha: sha });
  engine.phase(a.id, a.token, 'integrating', { integrationSha: sha });
  // Версия корпуса поручения сменилась в обход принятия (подмена записи).
  engine.host.store.transact('checks.adopted', (tx) => {
    const w = tx.work('add-greeting')!;
    tx.putWork({ ...w, checkVersion: { suite: 'KS-knap', number: 1, digest: 'e'.repeat(64) } });
  });
  assert.notEqual(
    effectiveChecks(
      engine.read((v) => v.work('add-greeting')!),
      a.policyDigest,
    ),
    pinned,
  );
  assert.throws(() => engine.finish(a.id, a.token, sha), refused('APPROVAL_STALE'));
  assert.throws(
    () =>
      engine.evidence(a.id, a.token, {
        kind: 'test',
        phase: 'candidate',
        sha,
        gate: 'properties',
        passed: true,
        command: ['x'],
        exitCode: 0,
        log: '',
        digest: 'd'.repeat(64),
        summary: 'ok',
        checks: 'f'.repeat(64),
      }),
    refused('APPROVAL_STALE'),
  );
  // Основание reuse включает закреплённый корпус: другая версия — другое основание.
  const w = engine.read((v) => v.work('add-greeting')!);
  const corpusA = {
    ...a,
    checks: { effective: pinned, corpus: { suite: 'KS-knap', number: 1, digest: 'a'.repeat(64) } },
  };
  const corpusB = {
    ...a,
    checks: { effective: pinned, corpus: { suite: 'KS-knap', number: 2, digest: 'b'.repeat(64) } },
  };
  assert.notEqual(
    implementationBasis(w, corpusA, sha, '1'),
    implementationBasis(w, corpusB, sha, '1'),
  );
  void WORKSPACE_OWNER;
});

test('T18: новая версия корпуса не меняет принятое поручение задним числом', async () => {
  const ctx = propertySetup({
    writer: [
      implement({ 'src/knap.mjs': knap.firstThree }),
      implement({ 'src/knap.mjs': knap.correct }),
    ],
  });
  await runAll(ctx);
  const failed = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  ctx.engine.retry('add-greeting');
  await ctx.runner.drain();
  const done = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(done.status, 'done');
  const result = await ctx.runner.submitCase({
    workId: 'add-greeting',
    property: 'knapsack-optimal',
    input: JSON.stringify({
      items: [
        { w: 1, v: 1 },
        { w: 1, v: 1 },
        { w: 1, v: 1 },
        { w: 1, v: 9 },
      ],
      cap: 4,
    }),
    expected: '12',
    sourceSha: failed.candidateSha,
    key: 'case-after-accepted',
  });
  assert.equal(result.decision.outcome, 'confirmed');
  assert.match(result.adoption[0]!.results['add-greeting']!, /уже принято/);
  const after = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.deepEqual(after.checkVersion, done.checkVersion);
  assert.equal(after.resultSha, done.resultSha);
});
