/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return --
 * Тест правит сырой JSON примера до разбора схемой.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandPaths,
  executionDigest,
  executionPolicySchema,
  gateDefinitionFiles,
  hostStepFiles,
  infraViolations,
  isolationDigest,
  planDraftSchema,
  policyIssues,
  workGraphDigest,
  workGraphSchema,
  workOrderDigest,
  workOrderSchema,
} from '../src/contracts/index.ts';
import { scopeViolations } from '../src/engine/scope.ts';
import { crossIssues } from '../src/validate.ts';
import { example } from './fixtures.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';

const policyWith = (edit: (p: any) => void = () => {}) => {
  const raw = structuredClone(example('policy')) as any;
  edit(raw);
  return executionPolicySchema.parse(raw);
};
const infraPolicy = (edit: (p: any) => void = () => {}) =>
  policyWith((p) => {
    p.repositories[0].protectedPaths = [...p.repositories[0].protectedPaths, '.harness/'];
    p.repositories[0].infra = { paths: ['.harness/acceptance/', '.harness/infra/'] };
    p.repositories[0].gates[0].command = ['node', '--test', '.harness/acceptance/*.test.mjs'];
    edit(p);
  });

const order = (id: string, over: Record<string, unknown> = {}) => ({
  ...(structuredClone((example('graph') as any).orders[0]) as Record<string, unknown>),
  id,
  source: { connector: 'files', ref: id, revision: '1' },
  ...over,
});
const graphOf = (...orders: Record<string, unknown>[]) =>
  workGraphSchema.parse({ ...(example('graph') as any), orders });

test('alpha.67 infra: пути команд — скрипт, флаг со значением, каталог шаблона; не пути — пропуск', () => {
  assert.deepEqual(
    commandPaths(['node', '.harness/compose-bridge.mjs', 'exec', '--', 'pnpm', 'test']),
    ['.harness/compose-bridge.mjs'],
  );
  assert.deepEqual(commandPaths(['node', '--test', '.harness/acceptance/*.test.mjs']), [
    '.harness/acceptance/',
  ]);
  assert.deepEqual(
    commandPaths(['x', '--out=reports/a.xml', '-v', '/abs/p.js', 'https://h/x.js']),
    ['reports/a.xml'],
  );
  assert.deepEqual(commandPaths(['bash', 'run.sh'], 'scripts'), ['scripts/run.sh']);
  assert.deepEqual(commandPaths(['bash', '../../escape.sh'], 'a'), []);
});

test('alpha.67 infra: policyIssues — корни доверия, вне protectedPaths и файлы шагов на хосте отклоняются', () => {
  assert.deepEqual(policyIssues(infraPolicy()), []);
  const trust = policyIssues(infraPolicy((p) => (p.repositories[0].infra.paths = ['.harness/'])));
  assert.ok(
    trust.some((i) => /корень доверия \.harness\/policy\.json/.test(i.message)),
    JSON.stringify(trust),
  );
  const exposed = policyIssues(
    infraPolicy((p) => (p.repositories[0].infra.paths = ['tools/infra/'])),
  );
  assert.ok(exposed.some((i) => /вне protectedPaths/.test(i.message)));
  const host = policyIssues(
    infraPolicy((p) => {
      p.repositories[0].lifecycle = {
        setup: [{ id: 'up', command: ['node', '.harness/infra/bridge.mjs', 'setup'] }],
        teardown: [{ id: 'down', command: ['node', '.harness/infra/bridge.mjs', 'teardown'] }],
      };
    }),
  );
  assert.ok(host.some((i) => /файл шага на хосте \.harness\/infra\/bridge\.mjs/.test(i.message)));
  assert.deepEqual(
    hostStepFiles(
      infraPolicy((p) => {
        p.repositories[0].prepare = [{ id: 'p', command: ['node', '.harness/setup.mjs'] }];
      }).repositories[0]!,
    ),
    ['.harness/setup.mjs'],
  );
  assert.deepEqual(gateDefinitionFiles(infraPolicy().repositories[0]!), ['.harness/acceptance/']);
});

test('alpha.67 infra: digest — политика и поручение без новых полей прежние; область инфраструктуры — новое ревью плана', () => {
  const plain = policyWith();
  const raw = structuredClone(example('policy')) as any;
  assert.equal('infra' in plain.repositories[0]!, false);
  assert.equal(executionDigest(plain), executionDigest(executionPolicySchema.parse(raw)));
  const withInfra = infraPolicy();
  const sameGatesNoInfra = infraPolicy((p) => delete p.repositories[0].infra);
  assert.notEqual(isolationDigest(withInfra), isolationDigest(sameGatesNoInfra));
  assert.notEqual(executionDigest(withInfra), executionDigest(sameGatesNoInfra));
  // Поручение без kind — без поля (умолчания нет), digest прежний.
  const parsed = workOrderSchema.parse(order('a'));
  assert.equal('kind' in parsed, false);
  assert.equal('gateChanges' in parsed, false);
  assert.notEqual(
    workOrderDigest(parsed),
    workOrderDigest(workOrderSchema.parse(order('a', { kind: 'infra' }))),
  );
  // Draft самостоятельного проекта несёт вид работы и изменения gates.
  const draft = planDraftSchema.parse({
    title: 'Infra',
    description: '',
    tasks: [
      {
        key: 'bridge',
        title: 'Bridge v2',
        description: 'Write the next compose bridge',
        role: 'developer',
        dependsOn: [],
        acceptance: ['bridge test passes'],
        contracts: [],
        kind: 'infra',
        gateChanges: ['.harness/acceptance/bridge.test.mjs'],
      },
    ],
  });
  assert.equal(draft.tasks[0]!.kind, 'infra');
});

test('alpha.67 infra: crossIssues — область инфраструктуры, gateChanges и порядок продуктовых работ после инфраструктуры', () => {
  const p = infraPolicy();
  const infra = order('infra-a', {
    kind: 'infra',
    writeScope: ['.harness/infra'],
    gateChanges: ['.harness/infra/x.mjs'],
  });
  const product = order('prod-a', { dependsOn: ['infra-a'] });
  assert.deepEqual(crossIssues(graphOf(infra, product), p), []);
  // Транзитивная зависимость тоже годится.
  assert.deepEqual(
    crossIssues(graphOf(infra, product, order('prod-b', { dependsOn: ['prod-a'] })), p),
    [],
  );
  const loose = crossIssues(graphOf(infra, order('prod-a')), p);
  assert.ok(
    loose.some((i) =>
      /не зависит от работ инфраструктуры своего репозитория: infra-a/.test(i.message),
    ),
  );
  const outside = crossIssues(graphOf(order('infra-a', { kind: 'infra', writeScope: ['src'] })), p);
  assert.ok(outside.some((i) => /вне области инфраструктуры/.test(i.message)));
  const noScope = crossIssues(
    graphOf(order('infra-a', { kind: 'infra', writeScope: ['.harness/infra'] })),
    policyWith(),
  );
  assert.ok(noScope.some((i) => /без области инфраструктуры/.test(i.message)));
  const productGate = crossIssues(
    graphOf(order('prod-a', { gateChanges: ['.harness/acceptance/a.test.mjs'] })),
    p,
  );
  assert.ok(productGate.some((i) => /только у работы инфраструктуры/.test(i.message)));
  assert.notEqual(workGraphDigest(graphOf(infra)), workGraphDigest(graphOf(order('infra-a'))));
});

test('alpha.67 infra: scopeViolations — продуктовой работе область инфраструктуры защищена, инфраструктурной — только она', () => {
  const base = {
    protected: ['.github/', '.harness/'],
    pinned: [],
    writeScope: ['.'],
    role: ['src'],
  };
  const paths = ['.harness/acceptance/', '.harness/infra/'];
  const product = scopeViolations(['src/a.js', '.harness/infra/x.mjs'], {
    ...base,
    infra: { kind: 'product', paths },
  });
  assert.deepEqual(product.forbidden, ['.harness/infra/x.mjs']);
  // Инфраструктура: внутри области — можно, роль её не сужает; прочие защищённые — нет.
  const infra = scopeViolations(['.harness/infra/x.mjs', '.harness/policy.json', 'src/a.js'], {
    ...base,
    writeScope: ['.harness/infra'],
    infra: { kind: 'infra', paths },
  });
  assert.deepEqual(infra.forbidden, ['.harness/policy.json']);
  assert.deepEqual(infra.outside, ['.harness/policy.json', 'src/a.js']);
  // Без области инфраструктуры правило прежнее.
  assert.deepEqual(scopeViolations(['.harness/infra/x.mjs'], base).forbidden, [
    '.harness/infra/x.mjs',
  ]);
});

test('alpha.67 infra: файлы gates доверенной базы — только по gateChanges; новые — можно; файлы шагов на хосте — никогда', () => {
  const input = {
    kind: 'infra' as const,
    paths: ['.harness/acceptance/', '.harness/infra/'],
    gateFiles: ['.harness/acceptance/'],
    hostFiles: ['.harness/infra/bridge.mjs'],
    gateChanges: [] as string[],
    inBase: (p: string) => p === '.harness/acceptance/old.test.mjs',
  };
  const changed = [
    '.harness/acceptance/old.test.mjs',
    '.harness/acceptance/new.test.mjs',
    '.harness/infra/bridge.mjs',
    '.harness/infra/bridge-next.mjs',
  ];
  assert.deepEqual(infraViolations(changed, input), {
    host: ['.harness/infra/bridge.mjs'],
    gate: ['.harness/acceptance/old.test.mjs'],
  });
  assert.deepEqual(
    infraViolations(changed, { ...input, gateChanges: ['.harness/acceptance/old.test.mjs'] }).gate,
    [],
  );
  assert.deepEqual(infraViolations(changed, { ...input, kind: 'product' }), { host: [], gate: [] });
});

// --- Исполнение: runner применяет правила к настоящему diff кандидата. ---

const passGate = `
const fs = require('fs');
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,
  '<testsuite><testcase classname="infra" name="ok"></testcase></testsuite>');
`;
const infraRun = (options: { writer: Record<string, string>; order: Record<string, unknown> }) =>
  setup({
    scenario: { writer: implement(options.writer), reviewer: approve() },
    files: { '.harness/acceptance/run.js': passGate },
    policy: (p: any) => {
      p.maxAttempts = 1;
      p.repositories[0].protectedPaths = [...p.repositories[0].protectedPaths, '.harness/'];
      p.repositories[0].infra = { paths: ['.harness/acceptance/', '.harness/infra/'] };
      p.repositories[0].gates[0].command = [process.execPath, '.harness/acceptance/run.js'];
    },
    graph: (g: any) => Object.assign(g.orders[0], options.order),
  });
const outcome = async (ctx: ReturnType<typeof setup>) => {
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work(ctx.graph.orders[0]!.id)!);
  ctx.store.close();
  return work;
};

test('alpha.67 infra: работа инфраструктуры пишет в свою область и принимается обычным циклом с ревью кода', async () => {
  const work = await outcome(
    infraRun({
      writer: { '.harness/infra/bridge-next.mjs': 'export const next = 1;\n' },
      order: { kind: 'infra', writeScope: ['.harness/infra'] },
    }),
  );
  assert.equal(work.status, 'done', work.failure);
});

test('alpha.67 infra: правка файла gate базы без gateChanges — scope-violation; с gateChanges — принимается', async () => {
  const changed = passGate + '// stronger\n';
  const refused = await outcome(
    infraRun({
      writer: { '.harness/acceptance/run.js': changed },
      order: { kind: 'infra', writeScope: ['.harness/acceptance'] },
    }),
  );
  assert.equal(refused.status, 'failed');
  assert.equal(refused.failureKind, 'scope-violation');
  assert.match(
    refused.failure!,
    /файлы gates доверенной базы без согласования планом: \.harness\/acceptance\/run\.js/,
  );
  const approved = await outcome(
    infraRun({
      writer: { '.harness/acceptance/run.js': changed },
      order: {
        kind: 'infra',
        writeScope: ['.harness/acceptance'],
        gateChanges: ['.harness/acceptance/run.js'],
      },
    }),
  );
  assert.equal(approved.status, 'done', approved.failure);
});

test('alpha.67 infra: продуктовая работа не меняет область инфраструктуры', async () => {
  const work = await outcome(
    infraRun({
      writer: { '.harness/infra/bridge-next.mjs': 'export const next = 1;\n' },
      order: { writeScope: ['.'] },
    }),
  );
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'scope-violation');
  assert.match(work.failure!, /защищённые файлы: \.harness\/infra\/bridge-next\.mjs/);
});
