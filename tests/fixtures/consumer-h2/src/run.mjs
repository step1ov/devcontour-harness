/**
 * H2: DevContour-подобный хост планирования на установленном пакете. Каждая
 * проверка сравнивает ответ хоста с прежними байтами схем, разделами prompt
 * и статусами импорта плана. Отчёт — JSON на stdout; exit 1 при любом
 * расхождении.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { z } from 'zod';
import * as root from 'devcontour-harness';
import * as contracts from 'devcontour-harness/contracts';
import {
  DomainError,
  hostInstructions,
  importPlan,
  keyOrder,
  hostTaskFields,
  planInputSchema,
  planResult,
  planSchema,
  plannerPrompt,
  planningFacts,
} from './devcontour-planning.mjs';

const checks = [];
const norm = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const check = (name, actual, expected) =>
  checks.push({
    name,
    ok: JSON.stringify(norm(actual)) === JSON.stringify(norm(expected)),
    actual: norm(actual),
    expected: norm(expected),
  });
const failure = (fn) => {
  try {
    fn();
    return { thrown: false };
  } catch (e) {
    return { thrown: true, code: e.code ?? null, status: e.status ?? null, message: e.message };
  }
};
const expected = (name) => readFileSync(new URL('../expected/' + name, import.meta.url), 'utf8');

// Одна копия zod у хоста и пакета: схемы хоста и общие поля — одного экземпляра.
const require = createRequire(import.meta.url);
const harnessRequire = createRequire(require.resolve('devcontour-harness'));
check(
  'zod: one copy for host and package',
  require.resolve('zod') === harnessRequire.resolve('zod'),
  true,
);

// Одна реализация: корень и ./contracts отдают те же объекты.
check(
  'identity: root === ./contracts',
  [
    'planDraft',
    'planDraftJsonSchema',
    'planDraftTaskShape',
    'planDraftSchema',
    'planningFactsSchema',
  ].filter((k) => root[k] === undefined || root[k] !== contracts[k]),
  [],
);
check(
  'identity: planning exports',
  [
    'planningRequest',
    'planningBasis',
    'draftIssues',
    'checkGaps',
    'draftToGraph',
    'planCheck',
  ].filter((k) => typeof root[k] !== 'function'),
  [],
);

// M-5/K1: схема плана хоста байтово прежняя (runtime и вход каталога).
check(
  'M-5 planSchema bytes (draft-7)',
  JSON.stringify(planSchema) === expected('devcontour-plan-schema.json'),
  true,
);
check(
  'M-5 plan input schema bytes (catalogDigest)',
  JSON.stringify(planInputSchema) === expected('devcontour-plan-input-schema.json'),
  true,
);
check(
  'K1 without keyOrder bytes differ',
  JSON.stringify(root.planDraftJsonSchema(root.planDraft(hostTaskFields))) ===
    expected('devcontour-plan-schema.json'),
  false,
);
check(
  'K1 keyOrder must be a permutation',
  failure(() => root.planDraft(hostTaskFields, { keyOrder: keyOrder.slice(1) })).code,
  'INVALID_INPUT',
);
check(
  'extension does not override shared fields',
  failure(() => root.planDraft({ key: z.string() })).code,
  'INVALID_INPUT',
);

// OP-PLAN-01: общий prompt и продуктовые строки хоста отдельным блоком перед brief.
const config = {
  repositories: [
    {
      id: 'main',
      name: 'Shop',
      kind: 'app',
      path: '/srv/shop',
      roles: {
        engine: { title: 'Engine', writePaths: ['src/engine'], requiresContract: true },
        'qa-api': { requiresContract: false },
      },
      gates: [
        { id: 'lint', kind: 'check' },
        { id: 'api-tests', kind: 'test' },
      ],
      groups: { all: ['lint', 'api-tests'] },
    },
  ],
  contextPacks: [{ id: 'mobile-testing', version: '1', files: ['docs/mobile.md'] }],
  resources: [{ id: 'db', kind: 'postgres' }],
};
const contractRecords = [
  {
    id: 'orders-api',
    digest: 'a'.repeat(64),
    title: 'Orders API',
    source: { connector: 'files', ref: 'contracts/orders.json', revision: '3' },
    checks: [{ gate: 'api-tests' }],
  },
];
const brief = 'Customers can cancel an order before shipment.';
const request = plannerPrompt(config, contractRecords, brief);
const sections = request.prompt.split('\n\n');
const hostAt = sections.findIndex((s) => s.startsWith('Host instructions:\n'));
const briefAt = sections.findIndex((s) => s.startsWith('User brief:\n'));
check(
  'OP-PLAN-01 request fields',
  [
    request.readOnly,
    request.recommendedTasks,
    request.maxTasks,
    /^[a-f0-9]{64}$/.test(request.basis),
  ],
  [true, 15, 30, true],
);
check(
  'OP-PLAN-01 S1 without product planner',
  [
    sections[0].startsWith('Inspect the repository read-only.'),
    sections[0].includes('You are a product planner.'),
    sections[0].includes('at most 15 tasks'),
  ],
  [true, false, true],
);
check(
  'OP-PLAN-01 S12 host block before brief, brief last',
  [hostAt > 0, briefAt, request.prompt.endsWith('User brief:\n' + brief)],
  [true, hostAt + hostInstructions.length, true],
);
check(
  'OP-PLAN-01 host instructions once, not in shared sections',
  hostInstructions.map((line) => [
    request.prompt.split(line).length - 1,
    sections.slice(0, hostAt).some((s) => s.includes(line)),
  ]),
  hostInstructions.map(() => [1, false]),
);
check(
  'OP-PLAN-01 declared roles without builtin',
  sections[1].endsWith(JSON.stringify(planningFacts(config, contractRecords).roles)),
  true,
);
check(
  'M-4 contracts whole in prompt',
  sections.some(
    (s) =>
      s.startsWith('Approved contracts available') && s.endsWith(JSON.stringify(contractRecords)),
  ),
  true,
);
check(
  'OP-PLAN-01 same inputs same prompt and basis',
  [
    plannerPrompt(config, contractRecords, brief).prompt === request.prompt,
    plannerPrompt(config, contractRecords, brief + ' Refund included.').basis === request.basis,
  ],
  [true, false],
);
const noRoles = failure(() =>
  plannerPrompt({ ...config, repositories: [{ ...config.repositories[0], roles: {} }] }, [], brief),
);
check(
  'OP-PLAN-01 no roles refusal',
  [noRoles.code, noRoles.message],
  [
    'INVALID_INPUT',
    'В конфигурации не объявлено ни одной роли: планировать некому. Объявите роли в профиле или в workspace.',
  ],
);
check(
  'OP-PLAN-01 empty brief refusal',
  failure(() => plannerPrompt(config, [], '  ')).code,
  'INVALID_INPUT',
);

// OP-PLAN-02/03: импорт плана хоста — прежние статусы и тексты.
const task = (key, extra = {}) => ({
  key,
  title: 'Task ' + key,
  description: 'Implement ' + key + ' end to end',
  role: 'engine',
  dependsOn: [],
  acceptance: ['Observable result of ' + key],
  contracts: [],
  ...extra,
});
const store = () => ({
  roles: ['engine', 'qa-api'],
  member: 'lead@team',
  tasks: [{ id: 'T1', key: 'old', dependsOn: [] }],
});
const plan = (tasks) => ({ title: 'Cancel orders', description: 'First slice', tasks });
const imported = store();
const ok = importPlan(
  imported,
  plan([
    task('api', {
      featureId: 'cancel-order',
      assignee: 'dev@team',
      approved: true,
      status: 'done',
    }),
    task('tests', {
      role: 'qa-api',
      dependsOn: ['api', 'T1'],
      consumers: [{ repositoryId: 'x', gates: ['y'] }],
    }),
  ]),
);
const [api, tests] = imported.tasks.slice(1);
check(
  'AC14 host metadata roundtrip, extra keys dropped',
  [
    ok.tasks,
    ok.issues,
    api.featureId,
    api.assignee,
    tests.assignee,
    tests.dependsOn,
    'approved' in api,
    api.status,
    'consumers' in tests,
    api.scope,
    api.repositoryId,
  ],
  [
    2,
    [],
    'cancel-order',
    'dev@team',
    'lead@team',
    ['T2', 'T1'],
    false,
    'draft',
    false,
    'component',
    'main',
  ],
);
const duplicate = failure(() => importPlan(store(), plan([task('a'), task('a')])));
check(
  'C6 duplicate key → 400',
  [duplicate.status, duplicate.message],
  [400, 'Ключи задач должны быть уникальны'],
);
const unknown = failure(() => importPlan(store(), plan([task('a', { dependsOn: ['ghost'] })])));
check(
  'C6 unknown dependency → 404',
  [unknown.status, unknown.message],
  [404, 'Неизвестная зависимость плана ghost'],
);
const cycle = failure(() =>
  importPlan(store(), plan([task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })])),
);
check(
  'cycle → host assertDag 409',
  [cycle.status, cycle.message.startsWith('Цикл зависимостей: '), cycle.message.includes('T2')],
  [409, true, true],
);
const hostFirst = failure(() =>
  importPlan(store(), plan([task('a', { role: 'designer' }), task('a')])),
);
check(
  'host per-task checks before draftIssues',
  [hostFirst.status, hostFirst.message],
  [400, 'Роль не объявлена: designer'],
);
check(
  'draftIssues without facts: structure only',
  root.draftIssues(
    planResult.parse(plan([task('a', { role: 'unknown-role', repositoryId: 'nowhere' })])),
  ),
  [],
);
check(
  'AC16 16 and 30 tasks accepted, 31 refused',
  [16, 30, 31].map(
    (n) => planResult.safeParse(plan(Array.from({ length: n }, (_, i) => task('t' + i)))).success,
  ),
  [true, true, false],
);
check('DomainError is host class', duplicate.thrown && new DomainError('x').status, 409);

const failed = checks.filter((c) => !c.ok);
process.stdout.write(
  JSON.stringify(
    { ok: failed.length === 0, total: checks.length, failed: failed.map((c) => c.name), checks },
    null,
    2,
  ) + '\n',
);
process.exit(failed.length ? 1 : 0);
