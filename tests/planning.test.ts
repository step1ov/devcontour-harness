import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  API_VERSION,
  planDraft,
  planDraftSchema,
  sha256,
  type PlanningFacts,
  type SourceRef,
} from '../src/contracts/index.ts';
import { checkGaps, draftIssues, draftToGraph } from '../src/index.ts';

const contractDigest = 'c'.repeat(64);
const facts: PlanningFacts = {
  repositories: [
    { id: 'app', kind: 'product', path: '/work/app' },
    { id: 'lib', kind: 'library', path: '/work/lib' },
  ],
  roles: [
    {
      repositoryId: 'app',
      roles: [
        { role: 'backend', writePaths: ['src'], requiresContract: false },
        { role: 'api', requiresContract: true },
      ],
    },
    { repositoryId: 'lib', roles: [{ role: 'backend', requiresContract: false }] },
  ],
  gates: [
    {
      repositoryId: 'app',
      gates: [
        { id: 'unit', kind: 'test' },
        { id: 'lint', kind: 'check' },
      ],
      groups: {
        all: ['unit', 'lint'],
        checks: ['lint'],
        bad: ['nope'],
        loop: ['@loop2'],
        loop2: ['@loop'],
      },
    },
    { repositoryId: 'lib', gates: [{ id: 'unit', kind: 'test' }] },
  ],
  contextPacks: [{ id: 'notes', version: '1', files: ['notes/a.md'] }],
  resources: [{ id: 'db', kind: 'service' }],
  contracts: [
    {
      id: 'api-v1',
      digest: contractDigest,
      title: 'API',
      source: { kind: 'file', path: 'api.md' },
    },
  ],
};
const text = 'The app greets the user by name';
const requirement = {
  id: 'REQ-greet',
  source: 'docs/spec.md',
  digest: sha256(text),
  text,
  gate: 'unit',
  scenario: 'greets a named user',
  testId: 'greet.greets',
};
const task = (over: Record<string, unknown> = {}) => ({
  key: 'T1',
  title: 'Greet users',
  description: 'Implement the greeting',
  role: 'backend',
  repositoryId: 'app',
  dependsOn: [],
  acceptance: ['greets by name'],
  contracts: [],
  ...over,
});
const draftOf = (...tasks: Record<string, unknown>[]) =>
  planDraftSchema.parse({ title: 'Plan', description: '', tasks });
const brief = (issues: { code: string; path: (string | number)[] }[]) =>
  issues.map((i) => [i.code, i.path.join('.')]);

test('H2-02: draftIssues — структурные проблемы в порядке: повтор, зависимости, цикл, затем факты', () => {
  const draft = draftOf(
    task({ key: 'A', dependsOn: ['A', 'X'], role: 'qa' }),
    task({ key: 'B', dependsOn: ['C'] }),
    task({ key: 'C', dependsOn: ['B'] }),
    task({ key: 'A' }),
  );
  const issues = draftIssues(draft, { facts });
  assert.deepEqual(brief(issues), [
    ['GRAPH_DUPLICATE_ID', 'tasks.3.key'],
    ['GRAPH_CYCLE', 'tasks.0.dependsOn.0'],
    ['GRAPH_UNKNOWN_DEPENDENCY', 'tasks.0.dependsOn.1'],
    ['GRAPH_CYCLE', 'tasks.1.dependsOn'],
    ['INVALID_INPUT', 'tasks.0.role'],
  ]);
  assert.deepEqual(
    issues.map((i) => i.message),
    [
      'Повтор ключа задачи плана: A',
      'Задача плана зависит от себя: A',
      'Неизвестная зависимость плана X',
      'Цикл зависимостей плана: B → C → B',
      'Роль не объявлена для репозитория app: qa',
    ],
  );
});

test('H2-02: draftIssues с facts — каждая ссылка на факты проекта, в порядке полей задачи', () => {
  const badDigest = { ...requirement, gate: 'lint', digest: sha256('other text') };
  const draft = draftOf(
    task({
      key: 'X',
      role: 'qa',
      scope: 'workspace',
      relatedRepositories: ['app', 'ghost'],
      contextPacks: ['nopack'],
      resources: ['gpu'],
      contracts: ['ghost-contract'],
      gates: ['e2e', '@loop'],
      requirements: [badDigest, requirement],
    }),
    task({ key: 'Y', writePaths: ['docs'] }),
    task({ key: 'Z', role: 'api' }),
    task({ key: 'W', repositoryId: 'ghost', role: 'qa', contracts: ['ghost-contract'] }),
    task({ key: 'OK', writePaths: ['src/greet.ts'], gates: ['@all'], requirements: [requirement] }),
  );
  const issues = draftIssues(draft, { facts });
  assert.deepEqual(brief(issues), [
    ['INVALID_INPUT', 'tasks.0.role'],
    ['INVALID_INPUT', 'tasks.0.relatedRepositories.1'],
    ['INVALID_INPUT', 'tasks.0.contextPacks.0'],
    ['INVALID_INPUT', 'tasks.0.resources.0'],
    ['INVALID_INPUT', 'tasks.0.contracts.0'],
    ['GATE_UNKNOWN', 'tasks.0.gates.0'],
    ['GATE_GROUP_CYCLE', 'tasks.0.gates.1'],
    ['INVALID_INPUT', 'tasks.0.requirements.0.digest'],
    ['INVALID_INPUT', 'tasks.0.requirements.0.gate'],
    ['INVALID_INPUT', 'tasks.0.requirements.1.gate'],
    ['INVALID_INPUT', 'tasks.1.writePaths'],
    ['INVALID_INPUT', 'tasks.2.contracts'],
    // Неизвестный репозиторий: остальные проверки задачи пропускаются.
    ['INVALID_INPUT', 'tasks.3.repositoryId'],
  ]);
  const message = (path: string) => issues.find((i) => i.path.join('.') === path)!.message;
  assert.equal(
    message('tasks.0.contracts.0'),
    'Контракт не объявлен в фактах проекта: ghost-contract; digest не выдумывается',
  );
  assert.equal(message('tasks.0.gates.0'), 'Проверка вне профиля app: e2e');
  assert.equal(message('tasks.0.gates.1'), 'Цикл в группах gates: loop → loop2 → loop');
  assert.match(message('tasks.0.requirements.0.gate'), /test gate: lint/);
  assert.match(message('tasks.0.requirements.1.gate'), /вне области задачи: unit/);
  assert.match(message('tasks.3.repositoryId'), /: ghost$/);
});

test('H2-02: draftIssues — gate требования вне явной области задачи; без gates область — все gates', () => {
  const outside = draftOf(task({ gates: ['lint'], requirements: [requirement] }));
  assert.deepEqual(brief(draftIssues(outside, { facts })), [
    ['INVALID_INPUT', 'tasks.0.requirements.0.gate'],
  ]);
  const whole = draftOf(task({ requirements: [requirement] }));
  assert.deepEqual(draftIssues(whole, { facts }), []);
  const group = draftOf(task({ gates: ['@bad'] }));
  assert.deepEqual(draftIssues(group, { facts }), [
    {
      code: 'GATE_UNKNOWN',
      path: ['tasks', 0, 'gates', 0],
      message: 'Проверка вне профиля app: nope',
    },
  ]);
});

test('H2-01: draftIssues без facts — только структура (host mapping DevContour 400/404)', () => {
  const host = planDraft(
    {
      featureId: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{1,48}$/)
        .optional(),
      assignee: z
        .string()
        .regex(/^[A-Za-z0-9_.@-]{1,80}$/)
        .optional(),
    },
    {
      keyOrder: [
        'featureId',
        'requirements',
        'assignee',
        'scope',
        'relatedRepositories',
        'contextPacks',
        'writePaths',
        'gates',
        'properties',
        'resources',
        'repositoryId',
        'key',
        'title',
        'description',
        'role',
        'dependsOn',
        'acceptance',
        'contracts',
      ],
    },
  );
  const plan = (...tasks: Record<string, unknown>[]) =>
    host.parse({ title: 'Plan', description: '', tasks });
  // Неизвестные хосту роли, gates и контракты — его host-проверки, не draftIssues.
  const unknownFacts = plan(
    task({
      key: 'a',
      role: 'qa',
      repositoryId: 'ghost',
      gates: ['e2e'],
      contracts: ['x'],
      featureId: 'greet',
      assignee: 'anton',
      dependsOn: ['T-1'],
    }),
  );
  assert.deepEqual(draftIssues(unknownFacts, { known: ['T-1'] }), []);
  assert.deepEqual(draftIssues(unknownFacts), [
    {
      code: 'GRAPH_UNKNOWN_DEPENDENCY',
      path: ['tasks', 0, 'dependsOn', 0],
      message: 'Неизвестная зависимость плана T-1',
    },
  ]);
  const status = (draft: z.output<typeof host>, known: string[]) => {
    const first = draftIssues(draft, { known })[0];
    if (!first) return 200;
    return first.code === 'GRAPH_UNKNOWN_DEPENDENCY' ? 404 : 400;
  };
  assert.equal(status(plan(task({ key: 'a', dependsOn: ['T-9'] })), ['T-1']), 404);
  assert.equal(status(plan(task({ key: 'a' }), task({ key: 'a' })), []), 400);
  assert.equal(
    status(plan(task({ key: 'a', dependsOn: ['b'] }), task({ key: 'b', dependsOn: ['a'] })), []),
    400,
  );
  assert.equal(status(plan(task({ key: 'a', dependsOn: ['T-1'] })), ['T-1']), 200);
});

test('H2-02: draftIssues — known разрешает зависимость, но не ключ самого draft и не цикл', () => {
  const draft = draftOf(task({ key: 'T1', dependsOn: ['T-7', 'T2'] }), task({ key: 'T2' }));
  assert.deepEqual(draftIssues(draft, { known: ['T-7'] }), []);
  assert.deepEqual(brief(draftIssues(draft, { known: [] })), [
    ['GRAPH_UNKNOWN_DEPENDENCY', 'tasks.0.dependsOn.0'],
  ]);
  const self = draftOf(task({ key: 'T1', dependsOn: ['T1'] }));
  assert.deepEqual(brief(draftIssues(self, { known: ['T1'] })), [
    ['GRAPH_CYCLE', 'tasks.0.dependsOn.0'],
  ]);
});

test('H2-02: checkGaps — план подготовки проверок; draft и его gates не меняются', () => {
  const draft = draftOf(
    task({ key: 'e2e-only', gates: ['e2e'] }),
    task({ key: 'with-unit', gates: ['unit', 'e2e'] }),
    task({ key: 'lint-only', gates: ['@checks'] }),
    task({ key: 'all-gates' }),
    task({ key: 'bad-group', gates: ['unit', '@bad'] }),
    task({ key: 'cycle', gates: ['unit', '@loop'] }),
    task({ key: 'ghost', repositoryId: 'ghost' }),
  );
  const before = structuredClone(draft);
  const gaps = checkGaps(draft, facts);
  const issues = draftIssues(draft, { facts });
  assert.deepEqual(draft, before);
  assert.deepEqual(draft.tasks[1]!.gates, ['unit', 'e2e']);
  assert.ok(issues.some((i) => i.code === 'GATE_UNKNOWN'));
  const app = { repositoryId: 'app', testGates: ['unit'] };
  assert.deepEqual(gaps, [
    { kind: 'gate-undeclared', taskKey: 'e2e-only', ...app, ref: 'e2e', action: 'declare-gate' },
    { kind: 'test-gate-missing', taskKey: 'e2e-only', ...app, action: 'add-test-gate' },
    { kind: 'gate-undeclared', taskKey: 'with-unit', ...app, ref: 'e2e', action: 'declare-gate' },
    { kind: 'test-gate-missing', taskKey: 'lint-only', ...app, action: 'add-test-gate' },
    { kind: 'gate-undeclared', taskKey: 'bad-group', ...app, ref: '@bad', action: 'declare-gate' },
  ]);
});

const source: SourceRef = { connector: 'files', ref: 'work/g1.json', revision: 'r1' };

test('H2-01: draftToGraph — mapping задач в поручения, digest контракта из facts', () => {
  const consumers = [{ repositoryId: 'lib', gates: ['unit'] }];
  const draft = draftOf(
    task({
      key: 'build',
      writePaths: ['src'],
      gates: ['unit'],
      properties: ['greet.named'],
      resources: ['db'],
      contracts: ['api-v1'],
      contextPacks: ['notes'],
      requirements: [requirement],
      consumers,
      approved: true,
      status: 'done',
    }),
    task({
      key: 'docs',
      dependsOn: ['build'],
      scope: 'workspace',
      relatedRepositories: ['app', 'lib'],
    }),
  );
  const { graph, issues } = draftToGraph(draft, {
    graphId: 'g1',
    source,
    facts,
    idOf: (key) => 'H-' + key,
  });
  assert.deepEqual(issues, []);
  const common = {
    apiVersion: API_VERSION,
    title: 'Greet users',
    goal: 'Implement the greeting',
    acceptance: ['greets by name'],
    role: 'backend',
    repositoryId: 'app',
  };
  assert.deepStrictEqual(graph, {
    apiVersion: API_VERSION,
    id: 'g1',
    source,
    orders: [
      {
        ...common,
        id: 'H-build',
        source: { connector: 'files', ref: 'H-build', revision: 'r1' },
        relatedRepositories: [],
        writeScope: ['src'],
        dependsOn: [],
        gates: ['unit'],
        consumers,
        properties: ['greet.named'],
        resources: ['db'],
        requirements: [requirement],
        contracts: [{ id: 'api-v1', digest: contractDigest }],
        context: ['notes'],
      },
      {
        ...common,
        id: 'H-docs',
        source: { connector: 'files', ref: 'H-docs', revision: 'r1' },
        relatedRepositories: ['app', 'lib'],
        writeScope: ['.'],
        dependsOn: ['H-build'],
        requirements: [],
        contracts: [],
        context: [],
      },
    ],
    prerequisites: [],
  });
});

test('H2-02: draftToGraph — неизвестный контракт: issue без графа, digest не подставляется', () => {
  const draft = draftOf(task({ contracts: ['api-v1', 'ghost'] }));
  const result = draftToGraph(draft, { graphId: 'g1', source, facts });
  assert.equal(result.graph, undefined);
  assert.deepEqual(result.issues, [
    {
      code: 'INVALID_INPUT',
      path: ['tasks', 0, 'contracts', 1],
      message: 'Контракт не объявлен в фактах проекта: ghost; digest не выдумывается',
    },
  ]);
  const noContracts = draftToGraph(draft, {
    graphId: 'g1',
    source,
    facts: { ...facts, contracts: [] },
  });
  assert.equal(noContracts.graph, undefined);
  assert.deepEqual(brief(noContracts.issues), [
    ['INVALID_INPUT', 'tasks.0.contracts.0'],
    ['INVALID_INPUT', 'tasks.0.contracts.1'],
  ]);
});

test('H2-02: draftToGraph — пределы WorkOrder — issues, а не отказ схемы draft', () => {
  const at = (draft: ReturnType<typeof draftOf>) => {
    const r = draftToGraph(draft, { graphId: 'g1', source, facts });
    assert.equal(r.graph, undefined);
    return brief(r.issues);
  };
  const many = Array.from({ length: 31 }, (_, i) => `criterion ${i}`);
  assert.deepEqual(at(draftOf(task({ acceptance: many }))), [
    ['INVALID_INPUT', 'graph.orders.0.acceptance'],
  ]);
  const long = 'k'.repeat(81);
  // Ключ длиннее ID поручения назван один раз: и у задачи, и в зависимости от неё.
  assert.deepEqual(at(draftOf(task({ key: long }), task({ key: 'T2', dependsOn: [long] }))), [
    ['INVALID_INPUT', 'tasks.0.key'],
  ]);
  const exact = draftOf(task({ key: 'k'.repeat(80), acceptance: many.slice(1) }));
  assert.ok(draftToGraph(exact, { graphId: 'g1', source, facts }).graph);
  assert.deepEqual(
    at(
      draftOf(
        task({
          title: ' Greet users',
          description: 'Implement the greeting\n',
          acceptance: ['fine ', ' greets'],
        }),
      ),
    ),
    [
      ['INVALID_INPUT', 'graph.orders.0.title'],
      ['INVALID_INPUT', 'graph.orders.0.goal'],
      ['INVALID_INPUT', 'graph.orders.0.acceptance.0'],
      ['INVALID_INPUT', 'graph.orders.0.acceptance.1'],
    ],
  );
  const contracts = Array.from({ length: 31 }, (_, i) => `c${i}`);
  const wide = {
    ...facts,
    contracts: contracts.map((id) => ({ id, digest: contractDigest })),
  };
  const r = draftToGraph(draftOf(task({ contracts })), { graphId: 'g1', source, facts: wide });
  assert.equal(r.graph, undefined);
  assert.deepEqual(brief(r.issues), [['INVALID_INPUT', 'graph.orders.0.contracts']]);
});

test('H2-02: draftToGraph — ID из idOf, неизвестная зависимость, component со связанными', () => {
  const r = draftToGraph(
    draftOf(
      task({ key: 'T1', dependsOn: ['ghost'] }),
      task({ key: 'T2', relatedRepositories: ['app', 'lib'] }),
    ),
    { graphId: 'g1', source, facts, idOf: (key) => key + '!' },
  );
  assert.equal(r.graph, undefined);
  assert.deepEqual(brief(r.issues), [
    ['INVALID_INPUT', 'tasks.0.key'],
    ['INVALID_INPUT', 'tasks.1.key'],
    ['GRAPH_UNKNOWN_DEPENDENCY', 'tasks.0.dependsOn.0'],
    ['INVALID_INPUT', 'tasks.1.relatedRepositories'],
  ]);
  assert.equal(r.issues[2]!.message, 'Неизвестная зависимость плана ghost');
});

test('H2-01: planDraft — расширение хоста, коллизия с общим полем, keyOrder', () => {
  const host = planDraft({ featureId: z.string().optional() });
  const parsed = host.parse({
    title: 'Plan',
    description: '',
    tasks: [task({ featureId: 'greet', approved: true })],
  });
  assert.equal(parsed.tasks[0]!.featureId, 'greet');
  assert.equal('approved' in parsed.tasks[0]!, false);
  assert.equal(parsed.tasks[0]!.scope, 'component');
  assert.deepEqual(Object.keys(host.shape.tasks.element.shape).slice(-1), ['featureId']);
  const standalone = draftOf(task({ consumers: [{ repositoryId: 'lib', gates: ['unit'] }] }));
  assert.deepEqual(standalone.tasks[0]!.consumers, [{ repositoryId: 'lib', gates: ['unit'] }]);
  assert.equal('consumers' in planDraft().shape.tasks.element.shape, false);
  assert.throws(
    () => planDraft({ role: z.string() }),
    (e: Error & { code?: string }) =>
      e.code === 'INVALID_INPUT' &&
      e.message === 'Расширение задачи draft не переопределяет общее поле: role',
  );
  const shared = Object.keys(planDraft().shape.tasks.element.shape);
  const reversed = [...shared, 'featureId'].reverse();
  const ordered = planDraft({ featureId: z.string().optional() }, { keyOrder: reversed });
  assert.deepEqual(Object.keys(ordered.shape.tasks.element.shape), reversed);
  for (const keyOrder of [shared, [...shared, 'featureId', 'featureId'], [...shared, 'other']])
    assert.throws(
      () => planDraft({ featureId: z.string().optional() }, { keyOrder }),
      (e: Error & { code?: string }) =>
        e.code === 'INVALID_INPUT' &&
        e.message === 'keyOrder: ожидается перестановка всех ключей задачи draft',
    );
});

test('H2-01: планы 16 и 30 задач принимаются, 31 — нет; 40 acceptance/dependsOn/contracts парсятся (M-6)', () => {
  const tasks = (n: number) => Array.from({ length: n }, (_, i) => task({ key: `T${i}` }));
  for (const schema of [planDraftSchema, planDraft()]) {
    for (const n of [16, 30])
      assert.equal(
        schema.safeParse({ title: 'Plan', description: '', tasks: tasks(n) }).success,
        true,
      );
    const over = schema.safeParse({ title: 'Plan', description: '', tasks: tasks(31) });
    assert.equal(over.success, false);
    assert.deepEqual(over.error.issues[0]!.path, ['tasks']);
  }
  const forty = Array.from({ length: 40 }, (_, i) => `item ${i}`);
  const wide = planDraftSchema.parse({
    title: 'Plan',
    description: '',
    tasks: [task({ acceptance: forty, dependsOn: forty, contracts: forty })],
  });
  assert.equal(wide.tasks[0]!.acceptance.length, 40);
  assert.equal(wide.tasks[0]!.dependsOn.length, 40);
  assert.equal(wide.tasks[0]!.contracts.length, 40);
});

test('H2-02: draftToGraph — задача workspace без связанных репозиториев — issue, а не тихая задача компонента', () => {
  const r = draftToGraph(draftOf(task({ key: 'T1', scope: 'workspace' })), {
    graphId: 'g1',
    source,
    facts,
  });
  assert.equal(r.graph, undefined);
  assert.deepEqual(brief(r.issues), [['INVALID_INPUT', 'tasks.0.relatedRepositories']]);
});
