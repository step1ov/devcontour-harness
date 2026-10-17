/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument --
 * Тесты подделывают переносимый результат как сырой JSON.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  digestOf,
  runResultSchema,
  sha256,
  type ExecutionPolicy,
  type RunResult,
  type WorkGraph,
} from '../src/contracts/index.ts';
import { runResult } from '../src/engine/result.ts';
import { resultProblems } from '../src/verification/acceptance.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';

/**
 * Проверка переносимого результата получателем: каждое условие приёмки,
 * проверяемое по результату, повторяется против того, что знает получатель.
 * Попытка проводится управляемо через engine (запись evidence — как после
 * настоящих gates и ревью); результат строится и сериализуется штатно.
 */
function attempt(graph: WorkGraph, policy: ExecutionPolicy = policyOf()) {
  const { engine: e, store } = engineOf(policy);
  ready(e, graph);
  const a = e.claim('c1')!;
  e.phase(a.id, a.token, 'verifying', { baseSha: sha('a'), candidateSha: sha('c') });
  e.phase(a.id, a.token, 'integrating', { integrationSha: sha('b') });
  const evidence = (
    gate: string,
    phase: 'candidate' | 'integration',
    extra: Record<string, unknown> = {},
  ) =>
    e.evidence(a.id, a.token, {
      kind: gate === 'independent-review' ? 'review' : 'test',
      phase,
      sha: sha(phase === 'candidate' ? 'c' : 'b'),
      gate,
      passed: true,
      command: ['controlled'],
      exitCode: 0,
      log: '',
      digest: digestOf(gate + phase),
      summary: 'ok',
      ...extra,
    } as any);
  for (const phase of ['candidate', 'integration'] as const) {
    evidence('unit', phase);
    evidence('independent-review', phase);
    if (graph.orders[0]!.requirements.length) evidence('requirement-source', phase);
  }
  const done = () => {
    e.finish(a.id, a.token, sha('b'));
    const result = runResultSchema.parse(
      JSON.parse(
        JSON.stringify(
          runResult(
            e.read((v) => v.attempt(a.id)!),
            e.version,
          ),
        ),
      ),
    );
    const repo = (id: string) => policy.repositories.find((r) => r.id === id)!;
    return {
      result,
      context: {
        order: e.read((v) => v.work(a.workId)!.order),
        contracts: [],
        repository: repo('app'),
        consumerRepository: repo,
      },
    };
  };
  return { e, store, a, evidence, done };
}

const forge = (result: RunResult, change: (r: any) => void) => {
  const forged = structuredClone(result) as any;
  change(forged);
  return runResultSchema.parse(forged);
};

test('S2-R3-02: неявная область gates (все gates репозитория) у получателя без политики — отказ; с политикой — нужны все gates', () => {
  const graph = graphOf({ a: [] });
  delete (graph.orders[0] as any).gates;
  const f = attempt(graph);
  const { result, context } = f.done();
  assert.deepEqual(resultProblems(result, context), [], 'штатный результат');
  const forged = forge(result, (r) => {
    r.inputs.requiredGates = [];
    r.evidence = r.evidence.filter((x: any) => x.kind === 'review');
  });
  assert.match(
    resultProblems(forged, { order: context.order, contracts: [] }).join('; '),
    /нужна политика репозитория получателя/,
    'без политики неявную область не доказать',
  );
  assert.match(
    resultProblems(result, { order: context.order, contracts: [] }).join('; '),
    /нужна политика репозитория получателя/,
    'и штатный результат без политики не принимается за PASS',
  );
  assert.match(resultProblems(forged, context).join('; '), /unit/, 'с политикой — unit обязателен');
  // Прежний формат (без requiredGates) с явной областью — прежний уровень.
  const explicit = attempt(graphOf({ a: [] }));
  const legacy = explicit.done();
  const old = forge(legacy.result, (r) => delete r.inputs.requiredGates);
  assert.deepEqual(resultProblems(old, { order: legacy.context.order, contracts: [] }), []);
  f.store.close();
  explicit.store.close();
});

test('S2-R3-03: запись check, property или consumer без потребителя не доказывает test gate; противоречащий вид и принадлежность — отказ', () => {
  const f = attempt(graphOf({ a: [] }));
  const { result, context } = f.done();
  assert.deepEqual(resultProblems(result, context), []);
  for (const kind of ['check', 'property', 'consumer'] as const) {
    const forged = forge(result, (r) =>
      r.evidence.forEach((x: any) => {
        if (x.kind === 'test') x.kind = kind;
      }),
    );
    assert.notDeepEqual(resultProblems(forged, context), [], kind + ' вместо test');
  }
  // test, приписанный потребителю, и consumer без потребителя.
  const owned = forge(
    result,
    (r) => (r.evidence.find((x: any) => x.kind === 'test').consumer = 'web'),
  );
  assert.match(resultProblems(owned, context).join('; '), /не согласован/);
  f.store.close();
});

/** Поручение app, проверяемое потребителем web (gates — группой) против своего результата. */
function consumerAttempt() {
  const policy = policyOf((p: any) => {
    const app = p.repositories[0];
    p.repositories.push({
      ...structuredClone(app),
      id: 'web',
      path: 'web',
      targetRef: 'refs/heads/web-accepted',
      dependsOn: ['app'],
      gates: [
        { ...app.gates[0], id: 'e2e' },
        { ...app.gates[0], id: 'smoke' },
      ],
      gateGroups: { ci: ['e2e', 'smoke'] },
    });
  });
  const graph = graphOf({ a: [] });
  graph.orders[0]!.consumers = [{ repositoryId: 'web', gates: ['@ci'] }];
  const f = attempt(graph, policy);
  f.evidence('e2e', 'integration', { consumer: 'web' });
  f.evidence('smoke', 'integration', { consumer: 'web' });
  f.e.consumerChecked(f.a.id, f.a.token, 'web', {
    sha: sha('d'),
    tree: sha('e'),
    dependencies: [{ repositoryId: 'app', sha: sha('b'), tree: sha('e'), artifacts: [] }],
    // Голова потребителя ушла вперёд: снимок устарел, но описан правдиво.
    freshness: [{ repositoryId: 'web', snapshot: sha('d'), head: sha('f'), fresh: false }],
    observedAt: '2026-01-01T00:00:00.000Z',
  });
  return f;
}

test('S2-R3-04/T21/T22: объявленный потребитель — описан, его gates (группой) прошли на integration против результата провайдера; устаревший, но правдивый снимок не отказ', () => {
  const f = consumerAttempt();
  const { result, context } = f.done();
  assert.deepEqual(
    resultProblems(result, context),
    [],
    'штатный результат, свежесть false правдива',
  );
  const variants: Record<string, (r: any) => void> = {
    'потребитель опущен': (r) => {
      r.checked.consumers = [];
      r.evidence = r.evidence.filter((x: any) => !x.consumer);
    },
    'описание есть, evidence нет': (r) => (r.evidence = r.evidence.filter((x: any) => !x.consumer)),
    'проверка потребителя провалена': (r) =>
      (r.evidence.find((x: any) => x.consumer).passed = false),
    'один gate группы не проверен': (r) => {
      r.evidence = r.evidence.filter((x: any) => x.gate !== 'smoke');
      r.checked.consumers[0].gates = ['e2e'];
    },
    'проверен кандидат, а не результат': (r) =>
      (r.checked.consumers[0].dependencies[0].sha = sha('c')),
    'провайдер не записан': (r) => (r.checked.consumers[0].dependencies = []),
    'другая версия проверок': (r) =>
      (r.evidence.find((x: any) => x.consumer).checks = 'f'.repeat(64)),
    'ложная свежесть': (r) => (r.checked.consumers[0].freshness[0].fresh = true),
    'устаревание при равных снимке и голове': (r) =>
      (r.checked.consumers[0].freshness[0].head = r.checked.consumers[0].freshness[0].snapshot),
    'снимок свежести не тот': (r) => (r.checked.consumers[0].freshness[0].snapshot = sha('a')),
    'лишний потребитель': (r) =>
      r.checked.consumers.push({ ...r.checked.consumers[0], repositoryId: 'other' }),
    'потребитель дважды': (r) => r.checked.consumers.push(r.checked.consumers[0]),
    'evidence необъявленного потребителя': (r) =>
      r.evidence.push({ ...r.evidence.find((x: any) => x.consumer), id: 'x', consumer: 'other' }),
  };
  for (const [name, change] of Object.entries(variants))
    assert.notDeepEqual(resultProblems(forge(result, change), context), [], name);
  // Группа gates потребителя без его политики у получателя — отказ, а не PASS.
  const blind = { ...context, consumerRepository: undefined };
  assert.match(resultProblems(result, blind).join('; '), /нужна его политика/);
  f.store.close();
});

test('S2-R3-05/T06/T18: названный testcase доказан у получателя списком тестов интеграции; источник требования нельзя убрать', () => {
  const graph = graphOf({ a: [] });
  const text = 'The named scenario must run.';
  graph.orders[0]!.requirements = [
    {
      id: 'REQ-1',
      source: 'requirements.md',
      text,
      digest: sha256(text),
      gate: 'unit',
      scenario: 'Named scenario',
      testId: 'required-test',
    },
  ];
  const f = attempt(graph);
  assert.throws(() => f.e.finish(f.a.id, f.a.token, sha('b')), /Сценарий не подтверждён/);
  f.evidence('unit', 'integration', {
    tests: [
      { id: 'required-test', status: 'passed' },
      { id: 'other', status: 'passed' },
    ],
  });
  const { result, context } = f.done();
  assert.ok(
    result.evidence.some((x) => x.tests?.some((t) => t.id === 'required-test')),
    'список тестов перенесён в результат',
  );
  assert.deepEqual(resultProblems(result, context), [], 'положительный round-trip');
  const proof = (r: any) => r.evidence.findLast((x: any) => x.gate === 'unit' && x.tests);
  const variants: Record<string, (r: any) => void> = {
    'список тестов потерян': (r) => r.evidence.forEach((x: any) => delete x.tests),
    'тест не тот': (r) => (proof(r).tests[0].id = 'renamed'),
    'тест не прошёл': (r) => (proof(r).tests[0].status = 'failed'),
    'тест скрыт': (r) => (proof(r).tests[0].opaque = true),
    'тест дважды': (r) => proof(r).tests.push({ id: 'required-test', status: 'passed' }),
    'список обрезан': (r) => (proof(r).testsTruncated = true),
    'доказательство на кандидате': (r) => {
      proof(r).phase = 'candidate';
      proof(r).sha = r.shas.candidate;
    },
    'доказательство потребителя': (r) => {
      proof(r).kind = 'consumer';
      proof(r).consumer = 'web';
    },
    'источник требования убран': (r) => {
      r.inputs.requiredGates = r.inputs.requiredGates.filter(
        (g: string) => g !== 'requirement-source',
      );
      r.evidence = r.evidence.filter((x: any) => x.gate !== 'requirement-source');
    },
    'источник требования только на кандидате': (r) =>
      (r.evidence = r.evidence.filter(
        (x: any) => !(x.gate === 'requirement-source' && x.phase === 'integration'),
      )),
  };
  for (const [name, change] of Object.entries(variants))
    assert.notDeepEqual(resultProblems(forge(result, change), context), [], name);
  f.store.close();
});

test('Получатель повторяет каждое проверяемое условие приёмки: подделка любого поля доказательства отклоняется', () => {
  const f = attempt(graphOf({ a: [] }));
  const { result, context } = f.done();
  assert.deepEqual(resultProblems(result, context), []);
  const review = (r: any, phase: string) =>
    r.evidence.find((x: any) => x.kind === 'review' && x.phase === phase);
  const unit = (r: any, phase: string) =>
    r.evidence.find((x: any) => x.gate === 'unit' && x.phase === phase);
  const variants: Record<string, (r: any) => void> = {
    'не принят': (r) => {
      r.outcome = 'rejected';
      delete r.shas.result;
      r.stopReason = { code: 'GATE_FAILED', message: 'x' };
    },
    'другое поручение': (r) => (r.inputs.workOrderDigest = 'e'.repeat(64)),
    'integration ≠ result': (r) => (r.shas.integration = sha('e')),
    'gate кандидата провален': (r) => (unit(r, 'candidate').passed = false),
    'gate интеграции на чужом SHA': (r) => (unit(r, 'integration').sha = sha('e')),
    'ревью кандидата нет': (r) =>
      (r.evidence = r.evidence.filter((x: any) => x !== review(r, 'candidate'))),
    'ревью интеграции отклонено': (r) => (review(r, 'integration').passed = false),
    'ревью записано как test': (r) => (review(r, 'integration').kind = 'test'),
    'область сокращена': (r) => (r.inputs.requiredGates = []),
    'gate интеграции записан под другой версией': (r) =>
      (unit(r, 'integration').checks = 'f'.repeat(64)),
    'зависимость с ложной свежестью': (r) => {
      r.checked.dependencies = [
        { repositoryId: 'lib', sha: sha('d'), tree: sha('e'), artifacts: [] },
      ];
      r.checked.freshness = [
        { repositoryId: 'lib', snapshot: sha('d'), head: sha('d'), fresh: false },
      ];
    },
    'свежесть не того снимка': (r) => {
      r.checked.dependencies = [
        { repositoryId: 'lib', sha: sha('d'), tree: sha('e'), artifacts: [] },
      ];
      r.checked.freshness = [
        { repositoryId: 'lib', snapshot: sha('a'), head: sha('a'), fresh: true },
      ];
    },
  };
  for (const [name, change] of Object.entries(variants))
    assert.notDeepEqual(resultProblems(forge(result, change), context), [], name);
  // Прямая зависимость репозитория получателя обязана иметь снимок.
  const withDependency = { ...context, repository: { ...context.repository, dependsOn: ['lib'] } };
  assert.match(resultProblems(result, withDependency).join('; '), /снимок зависимости lib/);
  f.store.close();
});
