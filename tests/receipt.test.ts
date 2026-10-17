/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
 * Тесты подделывают переносимый результат как сырой JSON.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runResultSchema, sha256 } from '../src/contracts/index.ts';
import { resultProblems, type ReceiverContext } from '../src/verification/acceptance.ts';
import { graphOf, policyOf, sha } from './engine-fixture.ts';
import { attempt, consumerAttempt, forge } from './receipt-fixtures.ts';

test('S2-R3-02: неявная область gates (все gates репозитория) раскрывается по политике получателя; репозитория нет в политике — отказ', () => {
  const graph = graphOf({ a: [] });
  delete (graph.orders[0] as any).gates;
  const f = attempt(graph);
  const { result, context } = f.done();
  assert.deepEqual(resultProblems(result, context), [], 'штатный результат');
  const forged = forge(result, (r) => {
    r.inputs.requiredGates = [];
    r.evidence = r.evidence.filter((x: any) => x.kind === 'review');
  });
  assert.match(resultProblems(forged, context).join('; '), /unit/, 'unit обязателен по политике');
  const blind = { ...context, policy: { ...context.policy, repositories: [] } };
  assert.match(
    resultProblems(result, blind).join('; '),
    /не описан в политике получателя/,
    'без описания репозитория область не доказать',
  );
  // Прежний формат (без requiredGates) с явной областью — прежний уровень.
  const explicit = attempt(graphOf({ a: [] }));
  const legacy = explicit.done();
  const old = forge(legacy.result, (r) => delete r.inputs.requiredGates);
  assert.deepEqual(resultProblems(old, legacy.context), []);
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
  // Потребитель, которого нет в политике получателя, — отказ, а не PASS.
  const blind = {
    ...context,
    policy: {
      ...context.policy,
      repositories: context.policy.repositories.filter((r) => r.id !== 'web'),
    },
  };
  assert.match(resultProblems(result, blind).join('; '), /потребитель web не описан/);
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
  // Зависимость репозитория в политике получателя обязана иметь снимок.
  const withDependency = {
    ...context,
    policy: {
      ...context.policy,
      repositories: [
        ...context.policy.repositories.map((r) =>
          r.id === 'app' ? { ...r, dependsOn: ['lib'] } : r,
        ),
        { ...context.policy.repositories[0]!, id: 'lib', path: 'lib', dependsOn: [] },
      ],
    },
  };
  assert.match(resultProblems(result, withDependency).join('; '), /ожидались ровно \[lib\]/);
  f.store.close();
});

const withRepos = (context: ReceiverContext, patch: (repos: any[]) => any[]): ReceiverContext => ({
  ...context,
  policy: { ...context.policy, repositories: patch(structuredClone(context.policy.repositories)) },
});
const libRepo = (context: ReceiverContext) => ({
  ...structuredClone(context.policy.repositories[0]!),
  id: 'lib',
  path: 'lib',
  targetRef: 'refs/heads/lib-accepted',
  dependsOn: [],
});

test('S2-R4-01: результат другого репозитория, источника, редакции, графа, ветки или контекста — отказ получателя', () => {
  const f = attempt(graphOf({ a: [] }));
  const { result, context } = f.done();
  assert.deepEqual(resultProblems(result, context), [], 'положительный round-trip');
  const variants: Record<string, (r: any) => void> = {
    'identity-repository': (r) => (r.repositoryId = 'foreign'),
    'identity-source-connector': (r) => (r.source.connector = 'other'),
    'identity-source-ref': (r) => (r.source.ref = 'other'),
    'identity-source-revision': (r) => (r.source.revision = 'unrelated-new-revision'),
    'identity-target': (r) => (r.targetRef = 'refs/heads/unrelated'),
    'identity-graph': (r) => (r.graphId = 'other-graph'),
    'identity-context': (r) => (r.inputs.contextDigest = 'c'.repeat(64)),
  };
  for (const [name, change] of Object.entries(variants))
    assert.notDeepEqual(resultProblems(forge(result, change), context), [], name);
  // Контекст: получатель знает согласованный снимок — результат без него отклонён.
  const bound = { ...context, contextDigest: 'c'.repeat(64) };
  assert.match(resultProblems(result, bound).join('; '), /снимок контекста/);
  assert.deepEqual(
    resultProblems(
      forge(result, (r) => (r.inputs.contextDigest = 'c'.repeat(64))),
      bound,
    ),
    [],
  );
  f.store.close();
});

test('S2-R4-02: testcase подтверждает только решающая test-запись нужной версии; ревью под именем gate и чужая версия — отказ', () => {
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
  f.evidence('unit', 'integration', { tests: [{ id: 'required-test', status: 'passed' }] });
  const { result, context } = f.done();
  assert.deepEqual(resultProblems(result, context), []);
  const variants: Record<string, (r: any) => void> = {
    'named-test-via-review-kind': (r) => {
      const proof = r.evidence.findLast((x: any) => x.tests);
      const forged = { ...structuredClone(proof), id: 'forged-review', kind: 'review' };
      delete proof.tests;
      r.evidence.push(forged);
    },
    'named-test-via-stale-version': (r) => {
      const proof = r.evidence.findLast((x: any) => x.tests);
      const forged = { ...structuredClone(proof), id: 'stale-proof', checks: 'f'.repeat(64) };
      delete proof.tests;
      r.evidence.unshift(forged);
    },
    'named-test-via-earlier-run': (r) => {
      const proof = r.evidence.findLast((x: any) => x.tests);
      const earlier = { ...structuredClone(proof), id: 'earlier' };
      delete proof.tests;
      r.evidence.splice(r.evidence.indexOf(proof), 0, earlier);
    },
  };
  for (const [name, change] of Object.entries(variants))
    assert.notDeepEqual(resultProblems(forge(result, change), context), [], name);
  // Каждое правило целостности записи — отдельно: лишняя запись нарушает
  // только его, решающие записи не тронуты.
  const extra = (r: any, record: Record<string, unknown>) =>
    r.evidence.push({ ...structuredClone(r.evidence[0]), id: 'extra', ...record });
  const integrity: Record<string, [(r: any) => void, RegExp]> = {
    'ревью под именем gate': [
      (r) =>
        extra(r, {
          kind: 'review',
          gate: 'unit',
          reviewer: { runtime: 'codex', sameVendor: false },
        }),
      /не согласован с gate unit/,
    ],
    'test под именем ревью': [
      (r) => extra(r, { kind: 'test', gate: 'independent-review' }),
      /не согласован с gate independent-review/,
    ],
    'список тестов у записи кандидата': [
      (r) =>
        (r.evidence.find((x: any) => x.gate === 'unit' && x.phase === 'candidate').tests = [
          { id: 'x', status: 'passed' },
        ]),
      /список тестов у записи не собственной проверки интеграции/,
    ],
  };
  for (const [name, [change, pattern]] of Object.entries(integrity))
    assert.match(resultProblems(forge(result, change), context).join('; '), pattern, name);
  // То же на стороне движка: запись ревью под именем gate не записывается.
  const g = attempt(graphOf({ a: [] }));
  assert.throws(
    () => g.evidence('unit', 'integration', { kind: 'review' }),
    /не может относиться к gate unit/,
  );
  assert.throws(
    () => g.evidence('independent-review', 'integration', { kind: 'test' }),
    /не может относиться к gate independent-review/,
  );
  f.store.close();
  g.store.close();
});

test('S2-R4-03: область и входы потребителя — ровно по политике получателя; лишнее, повтор, пропуск и противоречие — отказ', () => {
  const f = consumerAttempt();
  const { result, context } = f.done();
  assert.deepEqual(resultProblems(result, context), []);
  const variants: Record<string, (r: any) => void> = {
    'consumer-extra-gate-without-PASS': (r) => r.checked.consumers[0].gates.push('not-run'),
    'consumer-duplicate-gate': (r) => r.checked.consumers[0].gates.push('e2e'),
    'consumer-empty-freshness': (r) => (r.checked.consumers[0].freshness = []),
    'consumer-unknown-freshness': (r) =>
      r.checked.consumers[0].freshness.push({
        repositoryId: 'foreign',
        snapshot: sha('a'),
        head: sha('a'),
        fresh: true,
      }),
    'consumer-duplicate-provider-with-other-SHA': (r) =>
      r.checked.consumers[0].dependencies.push({
        ...r.checked.consumers[0].dependencies[0],
        sha: sha('a'),
      }),
  };
  for (const [name, change] of Object.entries(variants))
    assert.notDeepEqual(resultProblems(forge(result, change), context), [], name);
  // Потребитель зависит и от lib: полный closure принимается, неполный — нет.
  const consumerLib = withRepos(context, (repos) => [
    ...repos.map((r) => (r.id === 'web' ? { ...r, dependsOn: ['app', 'lib'] } : r)),
    libRepo(context),
  ]);
  const complete = forge(result, (r) => {
    r.checked.consumers[0].dependencies.push({
      repositoryId: 'lib',
      sha: sha('a'),
      tree: sha('a'),
      artifacts: [],
    });
    r.checked.consumers[0].freshness.push({
      repositoryId: 'lib',
      snapshot: sha('a'),
      head: sha('a'),
      fresh: true,
    });
  });
  assert.deepEqual(resultProblems(complete, consumerLib), [], 'полный closure потребителя');
  assert.notDeepEqual(
    resultProblems(
      forge(complete, (r) => {
        r.checked.consumers[0].dependencies = r.checked.consumers[0].dependencies.filter(
          (x: any) => x.repositoryId !== 'lib',
        );
        r.checked.consumers[0].freshness = r.checked.consumers[0].freshness.filter(
          (x: any) => x.repositoryId !== 'lib',
        );
      }),
      consumerLib,
    ),
    [],
    'consumer-dependency-omitted',
  );
  // Транзитивная зависимость: web → app → lib требует снимка lib у потребителя.
  const transitive = withRepos(context, (repos) => [
    ...repos.map((r) => (r.id === 'app' ? { ...r, dependsOn: ['lib'] } : r)),
    libRepo(context),
  ]);
  assert.match(
    resultProblems(result, transitive).join('; '),
    /потребитель web: снимки зависимостей \[app\] — ожидались ровно \[lib, app\]/,
  );
  // Потребитель, который в политике получателя не зависит от провайдера, — отказ.
  const unrelated = withRepos(context, (repos) =>
    repos.map((r) => (r.id === 'web' ? { ...r, dependsOn: [] } : r)),
  );
  assert.match(resultProblems(result, unrelated).join('; '), /потребитель web не зависит от app/);
  // Собственная зависимость lib: два снимка и снимок без свежести — отказ.
  const ownLib = withRepos(context, (repos) => [
    ...repos.map((r) => (r.id === 'app' ? { ...r, dependsOn: ['lib'] } : r)),
    libRepo(context),
  ]);
  const ownVariants: Record<string, (r: any) => void> = {
    'own-duplicate-dependency': (r) =>
      (r.checked.dependencies = [
        { repositoryId: 'lib', sha: sha('a'), tree: sha('a'), artifacts: [] },
        { repositoryId: 'lib', sha: sha('b'), tree: sha('b'), artifacts: [] },
      ]),
    'own-dependency-without-freshness': (r) =>
      (r.checked.dependencies = [
        { repositoryId: 'lib', sha: sha('a'), tree: sha('a'), artifacts: [] },
      ]),
  };
  for (const [name, change] of Object.entries(ownVariants))
    assert.notDeepEqual(resultProblems(forge(result, change), ownLib), [], name);
  f.store.close();
});

test('S2-R4-04: ревью подтверждено reviewer-ом политики получателя; тот же вендор — только явным разрешением; reviewer пропал или противоречит — отказ', () => {
  const f = attempt(graphOf({ a: [] }));
  const { result, context } = f.done();
  assert.deepEqual(resultProblems(result, context), [], 'claude → codex');
  assert.equal(result.inputs.writer?.runtime, 'claude');
  const reviews = (r: any, change: (x: any) => void) =>
    r.evidence.forEach((x: any) => x.kind === 'review' && change(x));
  const variants: Record<string, (r: any) => void> = {
    'review-same-vendor-without-permission': (r) =>
      reviews(r, (x) => (x.reviewer = { runtime: 'claude', sameVendor: true })),
    'review-without-identity': (r) => reviews(r, (x) => delete x.reviewer),
    'review-identity-contradicts-vendor': (r) => reviews(r, (x) => (x.reviewer.sameVendor = true)),
    'review-other-reviewer': (r) =>
      reviews(r, (x) => (x.reviewer = { runtime: 'claude', sameVendor: false })),
    'writer-not-assigned': (r) => (r.inputs.writer = { runtime: 'codex' }),
    'reviewer-on-test-record': (r) =>
      (r.evidence.find((x: any) => x.kind === 'test').reviewer = {
        runtime: 'codex',
        sameVendor: false,
      }),
  };
  for (const [name, change] of Object.entries(variants))
    assert.notDeepEqual(resultProblems(forge(result, change), context), [], name);
  f.store.close();
  // Явное разрешение того же вендора: обе пары проходят; без разрешения у
  // получателя тот же результат отклонён.
  for (const runtime of ['claude', 'codex'] as const) {
    const allowed = policyOf((p: any) => {
      p.roles.developer.writer.runtime = runtime;
      p.review.code = { reviewer: { runtime }, vendor: 'same-vendor-allowed' };
    });
    const same = attempt(graphOf({ a: [] }), allowed);
    const done = same.done();
    assert.deepEqual(resultProblems(done.result, done.context), [], `${runtime} → ${runtime}`);
    assert.ok(done.result.evidence.some((x) => x.reviewer?.sameVendor === true));
    const strict = {
      ...done.context,
      policy: {
        ...done.context.policy,
        review: {
          ...done.context.policy.review,
          code: { reviewer: { runtime }, vendor: 'different-vendor' as const },
        },
      },
    };
    assert.match(resultProblems(done.result, strict).join('; '), /того же вендора/);
    same.store.close();
  }
});

test('S2-R5-01: генеративный gate потребителя (legacy) переносим; его запись не доказывает договор свойств провайдера', () => {
  const f = consumerAttempt();
  const { result, context } = f.done();
  const own = structuredClone(result) as any;
  own.evidence.find((x: any) => x.consumer && x.gate === 'e2e').property = { level: 'legacy' };
  assert.deepEqual(
    resultProblems(runResultSchema.parse(own), context),
    [],
    'штатный результат с property gate потребителя подтверждается',
  );
  const manifest = { digest: 'a'.repeat(64), properties: ['p'] };
  const variants: Record<string, (r: any) => void> = {
    'уровень manifest у потребителя': (r) =>
      (r.evidence.find((x: any) => x.consumer && x.gate === 'e2e').property = {
        level: 'manifest',
        manifest,
      }),
    'манифест при уровне legacy': (r) =>
      (r.evidence.find((x: any) => x.consumer && x.gate === 'e2e').property = {
        level: 'legacy',
        manifest,
      }),
    'сведения о свойствах у ревью': (r) =>
      (r.evidence.find((x: any) => x.kind === 'review').property = { level: 'legacy' }),
  };
  for (const [name, change] of Object.entries(variants)) {
    const forged = structuredClone(own);
    change(forged);
    // Отказ схемы — тоже отказ получателя.
    const parsed = runResultSchema.safeParse(forged);
    assert.ok(
      !parsed.success || resultProblems(parsed.data, context).length,
      name + ': подделка подтверждена',
    );
  }
  f.store.close();
});
