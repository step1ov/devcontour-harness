/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тест правит сырой JSON политики и графа до разбора схемой.
 */
/**
 * 0.1.0-alpha.76 (R3): регрессионные gates поручения — проверки цели, которые
 * работа не меняет. Область по фазам, проверка графа, план и digest области.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  digestOf,
  executionPolicySchema,
  orderGateScope,
  sha256,
  planDraftSchema,
  workGraphSchema,
  type WorkGraph,
} from '../src/contracts/index.ts';
import { draftToGraph } from '../src/index.ts';
import { THIN_TASK_SIZE_SECTION } from '../src/planning/request.ts';
import { validationIssues } from '../src/validate.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { engineOf } from './engine-fixture.ts';
import { example } from './fixtures.ts';

/** Политика примера с gates install → unit, install → legacy и проверкой lint. */
const policy = () => {
  const raw = structuredClone(example('policy')) as Record<string, any>;
  const unit = raw.repositories[0].gates[0];
  raw.repositories[0].gates = [
    { id: 'install', kind: 'check', command: ['npm', 'ci'] },
    { ...unit, dependsOn: ['install'] },
    { ...unit, id: 'legacy', dependsOn: ['install'], report: { type: 'junit', path: 'l.xml' } },
    { id: 'lint', kind: 'check', command: ['npm', 'run', 'lint'] },
  ];
  return executionPolicySchema.parse(raw);
};
const graph = (order: Record<string, unknown>): WorkGraph => {
  const raw = structuredClone(example('graph')) as Record<string, any>;
  Object.assign(raw.orders[0], order);
  for (const [k, v] of Object.entries(order)) if (v === undefined) delete raw.orders[0][k];
  return workGraphSchema.parse(raw);
};
const issues = (order: Record<string, unknown>) =>
  validationIssues(graph(order), policy()).map((i) => `${i.path.join('.')}: ${i.message}`);

test('orderGateScope: без regressionGates — прежняя область; свои и регрессионные без повторов', () => {
  const repo = policy().repositories[0]!;
  const all = ['install', 'unit', 'legacy', 'lint'];
  assert.deepEqual(orderGateScope(repo, {}), { own: all, regression: [] });
  assert.deepEqual(orderGateScope(repo, { gates: ['install', 'unit'] }), {
    own: ['install', 'unit'],
    regression: [],
  });
  // Без gates: своя область — все gates, кроме регрессионных.
  assert.deepEqual(orderGateScope(repo, { regressionGates: ['legacy'] }), {
    own: ['install', 'unit', 'lint'],
    regression: ['legacy'],
  });
  assert.deepEqual(
    orderGateScope(repo, { gates: ['install', 'unit'], regressionGates: ['legacy', 'unit'] }),
    { own: ['install', 'unit'], regression: ['legacy'] },
  );
});

test('validate: regressionGates — известные ссылки, без повтора своих, предпосылки в областях, требования — только свои', () => {
  const own = { gates: ['install', 'unit'] };
  assert.deepEqual(issues({ ...own, regressionGates: ['legacy'] }), []);
  assert.deepEqual(issues({ gates: undefined, regressionGates: ['legacy'] }), []);
  assert.match(
    issues({ ...own, regressionGates: ['nope'] }).join('\n'),
    /orders\.0\.regressionGates: Проверка вне профиля .*nope/,
  );
  assert.match(
    issues({ ...own, regressionGates: ['unit', 'legacy'] }).join('\n'),
    /Gate и в gates, и в regressionGates: unit/,
  );
  // Предпосылка регрессионного gate вне обеих областей.
  const lone = policy();
  lone.repositories[0]!.gates.find((g) => g.id === 'legacy')!.dependsOn = ['lint'];
  assert.match(
    validationIssues(graph({ ...own, regressionGates: ['legacy'] }), lone)
      .map((i) => i.message)
      .join('\n'),
    /Регрессионный gate legacy требует lint/,
  );
  // Без gates: свой gate не зависит от регрессионного, своя область — с test gate.
  assert.match(
    issues({ gates: undefined, regressionGates: ['install'] }).join('\n'),
    /Gate unit своей области требует регрессионный install/,
  );
  assert.match(
    issues({ gates: undefined, regressionGates: ['unit', 'legacy'] }).join('\n'),
    /Своя область поручения .* должна включать test gate/,
  );
  // Требование доказывает свой gate, а не регрессионный.
  const text = 'Legacy still works';
  const requirement = {
    id: 'REQ-legacy',
    source: 'docs/spec.md',
    digest: sha256(text),
    text,
    gate: 'legacy',
    scenario: 'legacy keeps working',
  };
  assert.match(
    issues({ gates: undefined, regressionGates: ['legacy'], requirements: [requirement] }).join(
      '\n',
    ),
    /requirements\.0\.gate: Требование ссылается на регрессионный gate/,
  );
});

test('план: regressionGates задачи draft переходят в поручение; тонкий запрос планирования их называет', () => {
  const draft = planDraftSchema.parse({
    title: 'Plan',
    description: 'Two works',
    tasks: [
      {
        key: 'T1',
        title: 'Greet users',
        description: 'Implement the greeting',
        role: 'developer',
        repositoryId: 'app',
        dependsOn: [],
        acceptance: ['greets by name'],
        contracts: [],
        gates: ['unit'],
        regressionGates: ['legacy'],
      },
    ],
  });
  const facts = {
    repositories: [{ id: 'app', path: '/work/app' }],
    roles: [{ repositoryId: 'app', roles: [{ role: 'developer', requiresContract: false }] }],
    gates: [
      {
        repositoryId: 'app',
        gates: [
          { id: 'unit', kind: 'test' },
          { id: 'legacy', kind: 'test' },
        ],
      },
    ],
    contextPacks: [],
    resources: [],
    contracts: [],
  };
  const { graph: built, issues: found } = draftToGraph(draft, {
    graphId: 'g1',
    source: { connector: 'files', ref: 'work/g1.json', revision: '1' },
    facts,
  });
  assert.deepEqual(found, []);
  assert.deepEqual(built!.orders[0]!.regressionGates, ['legacy']);
  assert.match(THIN_TASK_SIZE_SECTION, /regressionGates: the harness runs them after the review/);
  assert.match(THIN_TASK_SIZE_SECTION, /the writer does not run them/);
});

test('digest области: без regressionGates — прежний, с ними — другой', () => {
  const host = standaloneHost({} as never, policy());
  const scope = (order: Record<string, unknown>) =>
    host.basis.scopeDigest({ order: graph(order).orders[0]! } as never, {} as never);
  const gates = ['install', 'unit'];
  assert.equal(scope({ gates }), digestOf({ gates, consumers: null }));
  assert.notEqual(scope({ gates, regressionGates: ['legacy'] }), scope({ gates }));
});

test('удержание gate: регрессионный gate — тоже gate работы', () => {
  const p = policy();
  const { engine, store } = engineOf(p);
  const repo = p.repositories[0]!.id;
  const hold = { workId: 'other', repositoryId: repo, gate: 'legacy', digest: 'd' } as never;
  const order = (o: Record<string, unknown>) => ({ order: graph(o).orders[0]! }) as never;
  assert.deepEqual(engine.gateHoldsOf(order({ gates: ['install', 'unit'] }), [hold]), []);
  assert.equal(
    engine.gateHoldsOf(order({ gates: ['install', 'unit'], regressionGates: ['legacy'] }), [hold])
      .length,
    1,
  );
  store.close();
});
