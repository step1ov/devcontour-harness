/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тест правит сырой JSON политики до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { HarnessError, digestOf } from '../src/contracts/index.ts';
import { approve, greet, implement, runAll, setup, target } from './runner-fixture.ts';
import { engineOf, graphOf, ready, sha } from './engine-fixture.ts';
import { junit, nodeGate } from './git-fixture.ts';
import { knap, propertySetup } from './property-fixture.ts';

// Работу уже сделала зависимость: greet есть на базе, исполнитель ничего не меняет.
const confirmed = (
  gates = ['unit'],
  evidence = 'unit passes on the base: greet returns Hello, Ada!',
) => {
  const r = approve('Приёмка уже выполнена на базе');
  (r.result as Record<string, unknown>).alreadySatisfied = { gates, evidence };
  return r;
};

function run(reviewer: unknown, files: Record<string, string> = { 'src/greet.js': greet }) {
  return setup({
    files,
    scenario: { writer: implement({}), reviewer },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 1),
  });
}

test('пустой результат с подтверждением reviewer: задача done без нового коммита, result SHA = база, одна попытка', async () => {
  const ctx = run(confirmed());
  const before = target(ctx);
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'done', work.failure);
  assert.equal(work.resultSha, before, 'результат — база');
  assert.equal(target(ctx), before, 'target не сдвинут новым коммитом');
  const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts.length, 1, 'лишних попыток нет');
  const a = attempts[0]!;
  assert.equal(a.candidateSha, a.baseSha);
  const reviews = a.evidence.filter((e) => e.kind === 'review' && e.passed);
  assert.deepEqual(
    reviews.map((e) => [e.phase, e.alreadySatisfied?.gates]),
    [
      ['candidate', ['unit']],
      ['integration', ['unit']],
    ],
  );
  assert.ok(
    a.evidence.some(
      (e) => e.kind === 'test' && e.phase === 'integration' && e.sha === before && e.passed,
    ),
    'gates задачи прошли на базе',
  );
});

test('пустой результат без подтверждения, с негодным подтверждением или с красными gates на базе — empty-result', async () => {
  const cases: [string, unknown, Record<string, string> | undefined, RegExp, boolean][] = [
    ['одобрение без alreadySatisfied', approve(), undefined, /не содержит alreadySatisfied/, true],
    ['gate вне области', confirmed(['lint']), undefined, /вне области задачи: lint/, true],
    ['пустое основание', confirmed(['unit'], 'ok'), undefined, /короче 20 знаков/, true],
    ['gates на базе красные', confirmed(), {}, /проверки задачи на базе не проходят/, false],
  ];
  for (const [name, reviewer, files, reason, reviewed] of cases) {
    const ctx = run(reviewer, files);
    const before = target(ctx);
    await runAll(ctx);
    const work = ctx.engine.read((v) => v.work('add-greeting')!);
    assert.equal(work.status, 'failed', name);
    assert.equal(work.failureKind, 'empty-result', name);
    assert.match(work.failure!, reason, name);
    assert.equal(target(ctx), before, name);
    assert.equal(
      existsSync(`${ctx.scenarioPath}.codex.reviewer.count`),
      reviewed,
      `${name}: reviewer ${reviewed ? 'вызван' : 'не вызывается при красных gates'}`,
    );
  }
});

test('engine: попытка без изменений не принимается без подтверждения ревью обеих фаз', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  const base = sha('a');
  engine.phase(a.id, a.token, 'running', { baseSha: base });
  engine.phase(a.id, a.token, 'verifying', { candidateSha: base });
  const record = (phase: 'candidate' | 'integration', confirm: boolean) => {
    engine.evidence(a.id, a.token, {
      kind: 'test',
      phase,
      sha: base,
      gate: 'unit',
      passed: true,
      command: ['npm', 'test'],
      exitCode: 0,
      log: '',
      digest: digestOf(phase),
      summary: 'ok',
    });
    engine.evidence(a.id, a.token, {
      kind: 'review',
      phase,
      sha: base,
      gate: 'independent-review',
      passed: true,
      command: ['codex'],
      exitCode: 0,
      log: '',
      digest: digestOf('r' + phase),
      summary: 'ok',
      findings: [],
      ...(confirm
        ? { alreadySatisfied: { gates: ['unit'], evidence: 'unit green on the base commit' } }
        : {}),
    });
  };
  record('candidate', true);
  engine.phase(a.id, a.token, 'integrating', { integrationSha: base });
  record('integration', false);
  assert.throws(
    () => engine.finish(a.id, a.token, base),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'REVIEW_REJECTED' &&
      /не подтвердило, что приёмка уже выполнена/.test(e.message),
  );
  record('integration', true);
  engine.finish(a.id, a.token, base);
  assert.equal(
    engine.read((v) => v.work('a')!.status),
    'done',
  );
});

test('поручение с договором проверки: подтверждение без проверки договора — empty-result; с ней — done на базе', async () => {
  const smoke = {
    id: 'smoke',
    kind: 'test',
    command: nodeGate(junit('<testcase classname="smoke" name="ok"/>')),
    report: { type: 'junit', path: '.reports/smoke.xml' },
  };
  for (const [gates, done] of [
    [['smoke'], false],
    [['smoke', 'properties'], true],
  ] as const) {
    const ctx = propertySetup({
      writer: implement({}),
      reviewer: confirmed(
        [...gates],
        'the base already solves knapsack: properties and smoke are green',
      ),
      files: { 'src/knap.mjs': knap.correct },
      gates: ['properties', 'smoke'],
      policy: (p: any) => {
        (p.repositories[0].gates as unknown[]).push(smoke);
        p.maxAttempts = 1;
      },
    });
    const before = target(ctx);
    await runAll(ctx);
    const work = ctx.engine.read((v) => v.work('add-greeting')!);
    if (done) {
      assert.equal(work.status, 'done', work.failure);
      assert.equal(work.resultSha, before);
    } else {
      assert.equal(work.failureKind, 'empty-result');
      assert.match(work.failure!, /не названы проверки договора поручения: properties/);
    }
  }
});
