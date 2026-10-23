import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_VERSION,
  HarnessError,
  contractDocumentSchema,
  digestOf,
  executionPolicySchema,
  type ContextSnapshot,
  type ExecutionPolicy,
  type PlanningFacts,
} from '../src/contracts/index.ts';
import {
  planningBasis,
  planningFactsOf,
  planningRequest,
  standaloneInstructions,
} from '../src/planning/index.ts';
import { generatePolicy } from '../src/init/policy.ts';
import { resolveProfile } from '../src/profiles/resolve.ts';

const fixture = fileURLToPath(new URL('./fixtures/standalone/npm-app', import.meta.url));

/** Тексты разделов S1–S13 — договор H2 §1.4, записаны независимо от реализации. */
const S = {
  s1: (n: number) =>
    `Inspect the repository read-only. Propose a small first vertical slice, at most ${n} tasks. Do not edit files, run implementation agents, commit, or mark tasks done. Independent plan review follows; the coordinator handles approval according to project policy.`,
  s2: "Declared roles, by repository. A task may only use a role declared for its own repository; no other role exists. Where a role has writePaths, the task's writePaths must lie inside them, or the executor can change nothing. A role marked requiresContract needs an approved contract bound to its task: ",
  s3: 'Configured checks, by repository. A task proves itself with gates: a subset of these that must include a test gate; a named group is referenced as "@name" instead of listing its members, and nothing is inherited implicitly. A task in a library proves its consumers only when it declares them: consumers lists dependent components and their gates or groups, run against the integrated result of the task. Requirements link to a test gate from that same subset: ',
  s4: 'Use a DAG with stable local keys. Roles owning separate surfaces can work in parallel once their shared contracts are agreed; test scenarios can be prepared early. Each task must have observable acceptance criteria. Return only the requested JSON structure.',
  s5: 'Keep component tasks scoped to their repository. Use scope=workspace and relatedRepositories only for work spanning multiple components. Component rules and task histories are local; the coordinator owns shared contracts and dependency links.',
  s6a: 'Available repositories: ',
  s6b: '. Every task must set repositoryId to a registered ID. Dependencies may cross repositories. Inspect the required repositories read-only.',
  s7: 'Assign narrow writePaths from actual repository structure. Use contextPacks IDs for relevant custom libraries and mobile testing; never invent IDs. Declare resources needed by task-level MCP work. Other-layer changes become dependent tasks, not scope expansion.',
  s8: 'When the specification has REQ-* sections, preserve exact id/source/text/digest bindings from the requirement snapshot you were given. Link each requirement to a configured test gate and an observable scenario; never invent a digest. Where the gate reports individual testcases, also name the testId that proves the scenario, exactly as the report spells it; acceptance verifies that this testcase ran and passed on the accepted commit.',
  s9: 'Available context packs: ',
  s10: 'Available resource IDs: ',
  s11: 'Approved contracts available (only reference these IDs, or use an empty contracts array): ',
};

const contract = {
  id: 'pricing-api',
  digest: 'a'.repeat(64),
  title: 'Pricing API',
  repositoryId: 'api',
  content: 'GET /price returns cents',
  source: { connector: 'store', ref: 'contracts/pricing.md', revision: 'b'.repeat(40) },
  checks: { version: 1, gate: 'unit', obligations: [{ property: 'price-nonneg' }] },
  artifacts: [{ path: 'checks/price.mjs', blob: 'c'.repeat(40) }],
};

/** Факты с пользовательскими ролями: ни одной встроенной (engine, qa-api). */
const facts = (): PlanningFacts => ({
  repositories: [
    { id: 'api', name: 'API', kind: 'library', path: '/work/api' },
    { id: 'web', kind: 'product', path: '/work/web' },
  ],
  roles: [
    {
      repositoryId: 'api',
      roles: [
        { role: 'backend-dev', writePaths: ['src'], requiresContract: true },
        { role: 'tester', requiresContract: false },
      ],
    },
    {
      repositoryId: 'web',
      roles: [{ role: 'frontend-dev', title: 'UI', requiresContract: false }],
    },
  ],
  gates: [
    {
      repositoryId: 'api',
      gates: [
        { id: 'lint', kind: 'check' },
        { id: 'unit', kind: 'test' },
      ],
      groups: { all: ['lint', 'unit'] },
    },
    { repositoryId: 'web', gates: [{ id: 'e2e', kind: 'test' }] },
  ],
  contextPacks: [{ id: 'ui-kit', version: '3', repositoryId: 'web', files: ['README.md'] }],
  resources: [{ id: 'sim', kind: 'device' }],
  contracts: [contract],
});

function expectedShared(f: PlanningFacts, n = 15) {
  return [
    S.s1(n),
    S.s2 + JSON.stringify(f.roles),
    S.s3 + JSON.stringify(f.gates),
    S.s4,
    S.s5,
    S.s6a +
      JSON.stringify(f.repositories.map(({ id, name, kind, path }) => ({ id, name, kind, path }))) +
      S.s6b,
    S.s7,
    S.s8,
    S.s9 + JSON.stringify(f.contextPacks),
    S.s10 + JSON.stringify(f.resources.map(({ id, kind }) => ({ id, kind }))),
    S.s11 + JSON.stringify(f.contracts),
  ];
}

const refusal = (message: string) => (error: unknown) =>
  error instanceof HarnessError && error.code === 'INVALID_INPUT' && error.message === message;

test('H2-01: prompt — разделы S1–S11 и S13 в договорном порядке и дословно; без host-инструкций S12 нет', () => {
  const f = facts();
  const request = planningRequest({ brief: 'Add a price endpoint', facts: f });
  assert.equal(
    request.prompt,
    [...expectedShared(f), 'User brief:\nAdd a price endpoint'].join('\n\n'),
  );
  assert.equal(request.readOnly, true);
  assert.equal(request.recommendedTasks, 15);
  assert.equal(request.maxTasks, 30);
  assert.equal(request.basis, planningBasis('Add a price endpoint', f));
  assert.doesNotMatch(request.prompt, /Host instructions:/);
  // Продуктовые строки DevContour в общий prompt не входят.
  assert.doesNotMatch(
    request.prompt,
    /You are a product planner|requirements_snapshot|design references/,
  );
  // Пустые и пробельные host-строки отбрасываются: блока нет.
  assert.equal(
    planningRequest({ brief: 'Add a price endpoint', facts: f, hostInstructions: ['', '  \n'] })
      .prompt,
    request.prompt,
  );
});

test('H2-01: host-блок S12 перед brief, brief последний; recommendedTasks попадает в S1', () => {
  const f = facts();
  const host = ['You are a product planner.', '', 'Include design references.'];
  const request = planningRequest({
    brief: 'Ship it\nwith details',
    facts: f,
    hostInstructions: host,
    recommendedTasks: 7,
  });
  const sections = [
    ...expectedShared(f, 7),
    'Host instructions:\nYou are a product planner.\n\nInclude design references.',
    'User brief:\nShip it\nwith details',
  ];
  assert.equal(request.prompt, sections.join('\n\n'));
  assert.equal(request.recommendedTasks, 7);
  assert.ok(request.prompt.endsWith('User brief:\nShip it\nwith details'));
  assert.ok(
    request.prompt.indexOf('Host instructions:\n') < request.prompt.indexOf('User brief:\n') &&
      request.prompt.indexOf(S.s11) < request.prompt.indexOf('Host instructions:\n'),
  );
  assert.ok(request.prompt.startsWith(S.s1(7)), '«You are a product planner.» не входит в S1');
});

test('H2-01: роли — только объявленные пользователем; контракты в prompt целиком (M-4)', () => {
  const f = facts();
  const { prompt } = planningRequest({ brief: 'x y z', facts: f });
  for (const role of ['backend-dev', 'tester', 'frontend-dev'])
    assert.ok(prompt.includes(`"${role}"`));
  for (const builtin of ['engine', 'qa-api', 'designer', 'developer'])
    assert.ok(!prompt.includes(`"${builtin}"`), builtin);
  // Запись контракта без проекции: source, checks, artifacts, content.
  assert.ok(prompt.includes(S.s11 + JSON.stringify([contract])));
  assert.ok(prompt.includes('"source":{"connector":"store","ref":"contracts/pricing.md"'));
  assert.ok(prompt.includes('"checks":{"version":1,"gate":"unit"'));
  assert.ok(prompt.includes('"groups":{"all":["lint","unit"]}'));
});

test('H2-01: три отказа INVALID_INPUT с договорными текстами', () => {
  const noRoles = { ...facts(), roles: [{ repositoryId: 'api', roles: [] }] };
  assert.throws(
    () => planningRequest({ brief: 'Do it', facts: noRoles }),
    refusal(
      'В конфигурации не объявлено ни одной роли: планировать некому. Объявите роли в профиле или в workspace.',
    ),
  );
  assert.throws(
    () => planningRequest({ brief: 'Do it', facts: { ...facts(), roles: [] } }),
    refusal(
      'В конфигурации не объявлено ни одной роли: планировать некому. Объявите роли в профиле или в workspace.',
    ),
  );
  for (const brief of ['', '  \n\t'])
    assert.throws(
      () => planningRequest({ brief, facts: facts() }),
      refusal('Пустая постановка: планировать нечего'),
    );
  for (const recommendedTasks of [0, 31, 2.5, Number.NaN, -1])
    assert.throws(
      () => planningRequest({ brief: 'Do it', facts: facts(), recommendedTasks }),
      refusal('recommendedTasks: ожидается целое 1–30'),
      String(recommendedTasks),
    );
  for (const recommendedTasks of [1, 30])
    assert.equal(
      planningRequest({ brief: 'Do it', facts: facts(), recommendedTasks }).recommendedTasks,
      recommendedTasks,
    );
});

test('H2-02: basis = digestOf({ brief, facts }) и меняется при смене brief, gate или контракта', () => {
  const f = facts();
  const basis = planningBasis('brief', f);
  assert.equal(basis, digestOf({ brief: 'brief', facts: f }));
  assert.match(basis, /^[0-9a-f]{64}$/);
  assert.equal(planningBasis('brief', facts()), basis, 'детерминирован');
  assert.notEqual(planningBasis('brief 2', f), basis);
  const gate = facts();
  gate.gates[0]!.gates[1]!.kind = 'check';
  assert.notEqual(planningBasis('brief', gate), basis);
  const added = facts();
  added.gates[1]!.gates.push({ id: 'smoke', kind: 'test' });
  assert.notEqual(planningBasis('brief', added), basis);
  const changed = facts();
  changed.contracts[0] = { ...contract, digest: 'd'.repeat(64) };
  assert.notEqual(planningBasis('brief', changed), basis);
  const content = facts();
  content.contracts[0] = { ...contract, content: 'GET /price returns euros' };
  assert.notEqual(planningBasis('brief', content), basis);
});

test('H2-01: planningFactsOf из политики H1 (generatePolicy, npm-app)', () => {
  const generated = generatePolicy({ profile: resolveProfile('npm-ci'), writer: 'claude' });
  const policy = executionPolicySchema.parse(generated.input);
  const baseDir = join(fixture, '.harness');
  const f = planningFactsOf(policy, { baseDir });
  assert.deepEqual(f, {
    repositories: [{ id: 'app', kind: 'product', path: resolve(fixture) }],
    roles: [{ repositoryId: 'app', roles: [{ role: 'developer', requiresContract: false }] }],
    gates: [
      {
        repositoryId: 'app',
        gates: [
          { id: 'check', kind: 'check' },
          { id: 'unit-tests', kind: 'test' },
        ],
      },
    ],
    contextPacks: [],
    resources: [],
    contracts: [],
  });
  const request = planningRequest({
    brief: 'Greet by name',
    facts: f,
    hostInstructions: standaloneInstructions({ requirements: [] }),
  });
  assert.ok(request.prompt.includes('"role":"developer"'));
  assert.ok(request.prompt.includes('"id":"unit-tests","kind":"test"'));
  assert.ok(request.prompt.includes(JSON.stringify(resolve(fixture))));
});

test('H2-01: planningFactsOf — multi-repo, gateGroups, роли репозитория, контекст, ресурсы, контракты', () => {
  const policy: ExecutionPolicy = executionPolicySchema.parse({
    policyVersion: 1,
    repositories: [
      {
        id: 'api',
        path: '../api',
        kind: 'library',
        targetRef: 'refs/heads/accepted',
        gates: [
          { id: 'lint', kind: 'check', command: ['npm', 'run', 'lint'], timeoutMs: 1000 },
          {
            id: 'unit',
            kind: 'test',
            command: ['npm', 'test'],
            timeoutMs: 1000,
            report: { type: 'junit', path: '.reports/junit.xml' },
          },
        ],
        gateGroups: { fast: ['lint'], all: ['@fast', 'unit'] },
        roles: {
          'backend-dev': {
            writer: { runtime: 'codex' },
            writePaths: ['src/api'],
            requiresContract: true,
          },
          'api-tester': { writer: { runtime: 'claude' }, writePaths: ['test'] },
        },
      },
      {
        id: 'web',
        path: '/abs/web',
        targetRef: 'refs/heads/accepted',
        dependsOn: ['api'],
        gates: [
          {
            id: 'e2e',
            kind: 'test',
            command: ['npm', 'run', 'e2e'],
            timeoutMs: 1000,
            report: { type: 'junit', path: 'r.xml' },
          },
        ],
      },
    ],
    roles: {
      'backend-dev': { writer: { runtime: 'claude' }, writePaths: ['src'] },
      'ui-dev': { writer: { runtime: 'claude' } },
    },
    review: {
      code: { reviewer: { runtime: 'codex' } },
      plan: { reviewer: { runtime: 'codex' } },
      contract: { reviewer: { runtime: 'codex' } },
    },
    resources: [{ id: 'phone', kind: 'device', value: 'iPhone 15' }],
  });
  const pinned = (path: string) => ({
    path,
    digest: 'e'.repeat(64),
    bytes: 1,
    content: { encoding: 'utf8' as const, data: 'x' },
  });
  const context: ContextSnapshot = {
    apiVersion: API_VERSION,
    sources: [
      {
        id: 'ui-kit',
        kind: 'pack',
        version: '2',
        repositoryId: 'web',
        required: true,
        files: [pinned('kit/README.md')],
        references: [pinned('kit/tokens.json')],
        digest: 'f'.repeat(64),
      },
      {
        id: 'notes',
        kind: 'notes',
        version: '1',
        required: false,
        files: [],
        references: [],
        digest: '0'.repeat(64),
      },
    ],
    missing: [],
  };
  const doc = contractDocumentSchema.parse({
    apiVersion: API_VERSION,
    id: 'pricing',
    repositoryId: 'api',
    title: 'Pricing contract',
    content: 'Prices are integer cents.',
    artifacts: [{ path: 'checks/price.mjs', blob: '1'.repeat(40) }],
  });
  const baseDir = '/proj/.harness';
  const f = planningFactsOf(policy, { baseDir, context, contracts: [doc] });
  assert.deepEqual(f.repositories, [
    { id: 'api', kind: 'library', path: resolve(baseDir, '../api') },
    { id: 'web', kind: 'product', path: '/abs/web' },
  ]);
  // Роли политики по порядку, затем роли только репозитория; роль репозитория
  // целиком заменяет роль политики; title не выводится.
  assert.deepEqual(f.roles, [
    {
      repositoryId: 'api',
      roles: [
        { role: 'backend-dev', writePaths: ['src/api'], requiresContract: true },
        { role: 'ui-dev', requiresContract: false },
        { role: 'api-tester', writePaths: ['test'], requiresContract: false },
      ],
    },
    {
      repositoryId: 'web',
      roles: [
        { role: 'backend-dev', writePaths: ['src'], requiresContract: false },
        { role: 'ui-dev', requiresContract: false },
      ],
    },
  ]);
  assert.deepEqual(f.gates, [
    {
      repositoryId: 'api',
      gates: [
        { id: 'lint', kind: 'check' },
        { id: 'unit', kind: 'test' },
      ],
      groups: { fast: ['lint'], all: ['@fast', 'unit'] },
    },
    { repositoryId: 'web', gates: [{ id: 'e2e', kind: 'test' }] },
  ]);
  assert.ok(!('groups' in f.gates[1]!));
  assert.deepEqual(f.contextPacks, [
    {
      id: 'ui-kit',
      version: '2',
      repositoryId: 'web',
      files: ['kit/README.md', 'kit/tokens.json'],
    },
    { id: 'notes', version: '1', files: [] },
  ]);
  assert.deepEqual(f.resources, [{ id: 'phone', kind: 'device' }]);
  assert.deepEqual(f.contracts, [{ ...doc, digest: digestOf(doc) }]);
  const { prompt } = planningRequest({ brief: 'Price it', facts: f });
  assert.ok(prompt.includes(S.s11 + JSON.stringify([{ ...doc, digest: digestOf(doc) }])));
  assert.ok(!prompt.includes('iPhone 15'), 'значение ресурса в prompt не попадает');
  // Контракт изменён — basis другой.
  const other = planningFactsOf(policy, {
    baseDir,
    context,
    contracts: [{ ...doc, content: 'Prices are integer euros.' }],
  });
  assert.notEqual(planningBasis('Price it', other), planningBasis('Price it', f));
});

test('H2-01: standaloneInstructions — T1–T5, T6 только с требованиями; без templates/ и skills/', () => {
  const plain = standaloneInstructions({ requirements: [] });
  assert.deepEqual(plain, [
    'You are the lead agent and write this draft yourself: a JSON document matching schemas/plan-draft.schema.json of the installed harness package. No other model is called for planning. Check it with harness plan-check; the draft approves nothing — plan review and approval follow.',
    'Task keys become work order IDs (1–80 characters of A-Z, a-z, 0-9, _ and -). description becomes the order goal and acceptance its criteria, without surrounding whitespace: description 10–12000 characters, at most 30 acceptance items of 3–1500 characters, at most 30 contracts. Omitted writePaths mean the whole repository. A library task proves its consumers with consumers: [{ "repositoryId", "gates" }].',
    'Gates run on the candidate and integration commits of a task, never on its base. Put a new feature test in the same task as the behaviour it proves and bind it through a requirement (test gate, scenario, testId): it may fail before the implementation and must pass on the accepted commit. Never plan a task whose own gates are expected to fail.',
    'If a needed check is not configured, reference it anyway: do not drop it or replace it with a weaker gate or a typecheck. plan-check reports it in checkPlan; prepare the check (a policy gate, or a bootstrap task proven by existing gates) and verify it before the main implementation is approved. A project already failing on its base is a separate first task, not an expected red.',
    'Ask the user a short question for every real ambiguity of the goal instead of guessing; the answer goes into the brief, and a changed brief makes this draft stale.',
  ]);
  const requirements = [
    {
      repositoryId: 'app',
      source: 'docs/spec.md',
      requirements: [{ id: 'REQ-greet', text: 'Greets by name', digest: '2'.repeat(64) }],
    },
  ];
  const withReq = standaloneInstructions({ requirements });
  assert.deepEqual(withReq.slice(0, 5), plain);
  assert.equal(
    withReq[5],
    'Requirement snapshots at HEAD (copy id, source, text and digest exactly; no other requirements exist): ' +
      JSON.stringify(requirements),
  );
  assert.equal(withReq.length, 6);
  const { prompt } = planningRequest({ brief: 'Greet', facts: facts(), hostInstructions: withReq });
  assert.ok(
    prompt.endsWith('Host instructions:\n' + withReq.join('\n\n') + '\n\nUser brief:\nGreet'),
  );
  assert.doesNotMatch(prompt, /templates\/|skills\//);
});
