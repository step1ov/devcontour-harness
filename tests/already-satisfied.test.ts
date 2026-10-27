/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
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

const confirmed = (
  gates = ['unit'],
  evidence = 'unit passes on the base: greet returns Hello, Ada!',
) => {
  const r = approve('Приёмка уже выполнена на базе');
  (r.result as Record<string, unknown>).alreadySatisfied = { gates, evidence };
  return r;
};

function run(
  reviewer: unknown,
  files: Record<string, string> = { 'src/greet.js': greet },
  patch?: { policy?: (p: any) => void; graph?: (g: any) => void },
) {
  return setup({
    files,
    scenario: { writer: implement({}), reviewer },
    policy: (p: any) => {
      p.maxAttempts = 1;
      patch?.policy?.(p);
    },
    ...(patch?.graph ? { graph: patch.graph } : {}),
  });
}

/** Зависимость `dep` пишет greet; поручение add-greeting от неё зависит и не меняет ничего. */
function withDependency(reviewer: unknown) {
  return setup({
    files: {},
    scenario: { writer: [implement(), implement({})], reviewer },
    policy: (p: any) => (p.maxAttempts = 1),
    graph: (g: any) => {
      const order = g.orders[0];
      g.orders = [
        { ...order, id: 'dep', source: { ...order.source, ref: 'dep' } },
        { ...order, dependsOn: ['dep'] },
      ];
    },
  });
}

test('пустой результат при общем gate и без зависимости, сделавшей работу, — решение ведущего, а не done', async () => {
  // Новых тестов ещё нет, общий unit зелёный и на базе: этого мало.
  const ctx = run(confirmed());
  const before = target(ctx);
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'needs-lead');
  assert.match(work.failure!, /нет механического основания/);
  assert.equal(target(ctx), before);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.ok(!a.evidence.some((e) => e.kind === 'review' && e.passed), 'одобрение не засчитано');
});

test('работу сделала зависимость: задача done без нового коммита, result SHA = голова после зависимости, одна попытка', async () => {
  const ctx = withDependency(confirmed());
  await runAll(ctx);
  const dep = ctx.engine.read((v) => v.work('dep')!);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(dep.status, 'done', dep.failure);
  assert.equal(work.status, 'done', work.failure);
  assert.equal(work.resultSha, dep.resultSha, 'нового коммита нет');
  assert.equal(target(ctx), dep.resultSha);
  const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts.length, 1, 'лишних попыток нет');
  const a = attempts[0]!;
  assert.equal(a.candidateSha, a.baseSha);
  const depCandidate = ctx.engine.read((v) => v.attempts('dep')[0]!.candidateSha);
  assert.deepEqual(
    a.evidence
      .filter((e) => e.kind === 'review' && e.passed)
      .map((e) => [e.phase, e.alreadySatisfied?.gates, e.alreadySatisfied?.basis]),
    ['candidate', 'integration'].map((phase) => [
      phase,
      ['unit'],
      { kind: 'dependency', workId: 'dep', sha: depCandidate, paths: ['src/greet.js'] },
    ]),
  );

  // Основание по зависимости — только когда её принятый результат входит в
  // проверяемый SHA. Тот же дерево, но коммит мимо результата зависимости:
  // основания нет, решение — за ведущим.
  const decide = (checked: string) =>
    (
      ctx.runner as unknown as {
        alreadySatisfied(...args: unknown[]): Promise<{ ok: boolean; kind?: string }>;
      }
    ).alreadySatisfied(work, ctx.repo.dir, checked, ctx.policy.repositories[0]!.gates, {
      gates: ['unit'],
      evidence: 'unit passes on the base: greet returns Hello, Ada!',
    });
  assert.equal((await decide(dep.resultSha!)).ok, true, 'результат зависимости в SHA — основание');
  const sibling = ctx.repo.git(
    'commit-tree',
    `${dep.resultSha}^{tree}`,
    '-p',
    ctx.engine.read((v) => v.attempts('dep')[0]!.baseSha!),
    '-m',
    'same tree, not on top of the dependency result',
  );
  const outside = await decide(sibling);
  assert.equal(outside.ok, false, 'результат зависимости не в SHA — основания нет');
  assert.equal(outside.kind, 'needs-lead');
});

test('пустой результат без подтверждения, с негодным подтверждением, с красными gates на базе или без подтверждения integration — empty-result', async () => {
  const lint = (p: any) =>
    p.repositories[0].gates.push({
      id: 'lint',
      kind: 'check',
      command: [process.execPath, '-e', 'process.exit(0)'],
    });
  const cases: [string, () => ReturnType<typeof setup>, RegExp, boolean][] = [
    ['одобрение без alreadySatisfied', () => run(approve()), /не содержит alreadySatisfied/, true],
    ['gate вне области', () => run(confirmed(['lint'])), /вне области задачи: lint/, true],
    [
      'ни одного test gate',
      () =>
        run(confirmed(['lint']), undefined, {
          policy: lint,
          graph: (g: any) => (g.orders[0].gates = ['unit', 'lint']),
        }),
      /не назван ни один test gate/,
      true,
    ],
    ['пустое основание', () => run(confirmed(['unit'], 'ok')), /короче 20 знаков/, true],
    [
      'gates на базе красные',
      () => run(confirmed(), {}),
      /проверки задачи на базе не проходят/,
      false,
    ],
    [
      'integration без подтверждения',
      () => withDependency([approve(), approve(), confirmed(), approve()]),
      /не содержит alreadySatisfied/,
      true,
    ],
  ];
  for (const [name, make, reason, reviewed] of cases) {
    const ctx = make();
    await runAll(ctx);
    const work = ctx.engine.read((v) => v.work('add-greeting')!);
    assert.equal(work.status, 'failed', name);
    assert.equal(work.failureKind, 'empty-result', name);
    assert.match(work.failure!, reason, name);
    assert.equal(
      existsSync(`${ctx.scenarioPath}.codex.reviewer.count`),
      reviewed,
      `${name}: reviewer ${reviewed ? 'вызван' : 'не вызывается при красных gates'}`,
    );
  }
});

test('engine.finish повторяет правило целиком: обе фазы, основание и его сверка с принятой зависимостью', () => {
  type E = ReturnType<typeof engineOf>['engine'];
  const evidence = (
    engine: E,
    a: { id: string; token: string },
    phase: 'candidate' | 'integration',
    at: string,
    confirm?: Record<string, unknown>,
  ) => {
    engine.evidence(a.id, a.token, {
      kind: 'test',
      phase,
      sha: at,
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
      sha: at,
      gate: 'independent-review',
      passed: true,
      command: ['codex'],
      exitCode: 0,
      log: '',
      digest: digestOf('r' + phase),
      summary: 'ok',
      findings: [],
      ...(confirm ? { alreadySatisfied: confirm as never } : {}),
    });
  };
  const depBasis = { kind: 'dependency', workId: 'dep', sha: sha('c'), paths: ['src/greet.js'] };
  const claim = (basis?: Record<string, unknown>) => ({
    gates: ['unit'],
    evidence: 'unit green on the base commit',
    ...(basis ? { basis } : {}),
  });
  const attempt = (candidate?: Record<string, unknown>, integration?: Record<string, unknown>) => {
    const { engine } = engineOf();
    ready(engine, graphOf({ dep: [], a: ['dep'] }));
    const d = engine.claim('c1')!;
    engine.phase(d.id, d.token, 'running', { baseSha: sha('b') });
    engine.phase(d.id, d.token, 'verifying', { candidateSha: sha('c') });
    evidence(engine, d, 'candidate', sha('c'));
    engine.phase(d.id, d.token, 'integrating', { integrationSha: sha('d') });
    evidence(engine, d, 'integration', sha('d'));
    engine.finish(d.id, d.token, sha('d'));
    const a = engine.claim('c1')!;
    engine.phase(a.id, a.token, 'running', { baseSha: sha('d') });
    engine.phase(a.id, a.token, 'verifying', { candidateSha: sha('d') });
    evidence(engine, a, 'candidate', sha('d'), candidate);
    engine.phase(a.id, a.token, 'integrating', { integrationSha: sha('d') });
    evidence(engine, a, 'integration', sha('d'), integration);
    return () => {
      engine.finish(a.id, a.token, sha('d'));
      return engine.read((v) => v.work('a')!.status);
    };
  };
  const refused = (e: unknown) =>
    e instanceof HarnessError &&
    e.code === 'REVIEW_REJECTED' &&
    /не подтвердило, что приёмка уже выполнена/.test(e.message);
  assert.throws(attempt(claim(depBasis), undefined), refused, 'integration без подтверждения');
  assert.throws(attempt(undefined, claim(depBasis)), refused, 'candidate без подтверждения');
  assert.throws(attempt(claim(), claim()), refused, 'без основания');
  const wrongSha = { ...depBasis, sha: sha('e') };
  assert.throws(attempt(claim(wrongSha), claim(wrongSha)), refused, 'не кандидат зависимости');
  const outside = { ...depBasis, paths: ['README.md'] };
  assert.throws(attempt(claim(outside), claim(outside)), refused, 'вне области записи');
  assert.equal(attempt(claim(depBasis), claim(depBasis))(), 'done');
});

test('поручение с договором проверки: подтверждение без проверки договора — empty-result; с ней — done на базе', async () => {
  const smoke = {
    id: 'smoke',
    kind: 'test',
    command: nodeGate(junit('<testcase classname="smoke" name="ok"/>')),
    report: { type: 'junit', path: '.reports/smoke.xml' },
  };
  for (const [gates, scope, expected] of [
    [['smoke'], ['properties', 'smoke'], 'empty-result'],
    // Проверка договора вне суженной области не исполнена: основания нет.
    // (Поручение со свойствами такую область не получит: её отклоняет регистрация.)
    [['smoke'], ['smoke'], 'needs-lead'],
    [['smoke', 'properties'], ['properties', 'smoke'], 'done'],
  ] as const) {
    const ctx = propertySetup({
      writer: implement({}),
      reviewer: confirmed(
        [...gates],
        'the base already solves knapsack: properties and smoke are green',
      ),
      files: { 'src/knap.mjs': knap.correct },
      gates: [...scope],
      ...((scope as readonly string[]).includes('properties')
        ? {}
        : { properties: false as const }),
      policy: (p: any) => {
        (p.repositories[0].gates as unknown[]).push(smoke);
        p.maxAttempts = 1;
      },
    });
    const before = target(ctx);
    await runAll(ctx);
    const work = ctx.engine.read((v) => v.work('add-greeting')!);
    if (expected === 'done') {
      assert.equal(work.status, 'done', work.failure);
      assert.equal(work.resultSha, before);
      const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
      assert.deepEqual(
        a.evidence.find((e) => e.kind === 'review' && e.passed)?.alreadySatisfied?.basis,
        { kind: 'contract', gates: ['properties'] },
      );
    } else {
      assert.equal(work.failureKind, expected, work.failure);
      assert.match(
        work.failure!,
        expected === 'needs-lead'
          ? /проверки договора поручения вне области задачи: properties/
          : /не названы проверки договора поручения: properties/,
      );
    }
  }
});
