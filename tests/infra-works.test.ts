/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument --
 * Тест правит сырой JSON примера до разбора схемой.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandPaths,
  digestOf,
  executionDigest,
  executionPolicySchema,
  hostStepFiles,
  infraViolations,
  isolationDigest,
  planDraftSchema,
  policyIssues,
  resolutionFile,
  workGraphDigest,
  workGraphSchema,
  workOrderDigest,
  workOrderSchema,
} from '../src/contracts/index.ts';
import { scopeViolations } from '../src/engine/scope.ts';
import { crossIssues } from '../src/validate.ts';
import { example } from './fixtures.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { repo } from './git-fixture.ts';
import { changedFacts, resolveInTree, resolvedHostFiles } from '../src/engine/infra-guard.ts';
import { reusableImplementation } from '../src/engine/reuse.ts';
import { infraPendingOf } from '../src/engine/engine.ts';
import {
  baseCheckoutEnv,
  removeBaseCheckout,
  withBaseCheckout,
} from '../src/environment/trusted-tree.ts';
import { explainStop } from '../src/projections/stop.ts';
import { draftIssues } from '../src/planning/issues.ts';
import { planningFactsOf } from '../src/planning/facts.ts';

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
  // Значения со списком: каждая часть — путь (`--env шаблон:имя`, `--x=a:b`).
  assert.deepEqual(
    commandPaths([
      'node',
      'b.mjs',
      '--env',
      '.harness/env/c.env.template:compose.env',
      '--x=a.js,b/c',
    ]),
    ['b.mjs', '.harness/env/c.env.template', 'compose.env', 'a.js', 'b/c'],
  );
  // Шаблон без неизменного каталога — весь каталог команды (корень — `.`).
  assert.deepEqual(commandPaths(['node', '--test', '**/*.test.mjs']), ['.']);
  assert.deepEqual(commandPaths(['node', '--test', '*.test.mjs'], 'e2e'), ['e2e/']);
  // Строка оболочки путей не даёт (её покрывает исполнение по доверенной базе).
  assert.deepEqual(commandPaths(['sh', '-c', 'node .harness/infra/x.mjs']), []);
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
  // Окружение совместной проверки, превью, генераторы и шаблон без каталога
  // тоже шаги на хосте.
  const joint = policyIssues(
    infraPolicy((p) => {
      p.workspaceLifecycle = {
        teardown: [{ id: 'down', command: ['node', '.harness/infra/joint.mjs'] }],
      };
    }),
  );
  assert.ok(joint.some((i) => /файл шага на хосте \.harness\/infra\/joint\.mjs/.test(i.message)));
  const preview = policyIssues(
    infraPolicy((p) => {
      p.repositories[0].previews = [
        { id: 'web', start: ['node', '.harness/infra/serve.mjs'], build: [] },
      ];
    }),
  );
  assert.ok(preview.some((i) => /\.harness\/infra\/serve\.mjs/.test(i.message)));
  const rootGlob = policyIssues(
    infraPolicy((p) => {
      p.repositories[0].prepare = [{ id: 'p', command: ['node', '--test', '**/*.mjs'] }];
    }),
  );
  assert.ok(rootGlob.some((i) => /покрывает файл шага на хосте \./.test(i.message)));
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

test('alpha.67 infra: существующие файлы области — только по gateChanges, какой бы командой gate их ни читал; новые — можно; файлы разрешения и ссылки — нет; шаги на хосте — никогда', () => {
  const base = new Set([
    '.harness/acceptance/old.test.mjs',
    // Помощник, которого argv gate не называет (импорт теста или npm run accept).
    '.harness/infra/helper.mjs',
  ]);
  const input = {
    kind: 'infra' as const,
    paths: ['.harness/acceptance/', '.harness/infra/'],
    hostFiles: ['.harness/infra/bridge.mjs'],
    gateChanges: [] as string[],
    inBase: (p: string) => base.has(p),
    isLink: (p: string) => p === '.harness/infra/link.mjs',
  };
  const changed = [
    '.harness/acceptance/old.test.mjs',
    '.harness/acceptance/new.test.mjs',
    '.harness/infra/helper.mjs',
    '.harness/infra/bridge.mjs',
    '.harness/infra/bridge-next.mjs',
    '.harness/acceptance/package.json',
    '.harness/acceptance/node_modules/assert/index.js',
    '.harness/acceptance/.mocharc.json',
    '.harness/infra/link.mjs',
  ];
  assert.deepEqual(infraViolations(changed, input), {
    host: ['.harness/infra/bridge.mjs'],
    link: ['.harness/infra/link.mjs'],
    gate: [
      '.harness/acceptance/old.test.mjs',
      '.harness/infra/helper.mjs',
      '.harness/acceptance/package.json',
      '.harness/acceptance/node_modules/assert/index.js',
      '.harness/acceptance/.mocharc.json',
    ],
  });
  assert.deepEqual(
    infraViolations(changed, {
      ...input,
      gateChanges: [
        '.harness/acceptance/old.test.mjs',
        '.harness/infra/helper.mjs',
        '.harness/acceptance/package.json',
        '.harness/acceptance/node_modules/',
        '.harness/acceptance/.mocharc.json',
      ],
    }).gate,
    [],
  );
  assert.deepEqual(infraViolations(changed, { ...input, kind: 'product' }), {
    host: [],
    gate: [],
    link: [],
  });
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

test('alpha.67 infra: правка существующего помощника gate, которого argv gate не называет, — scope-violation без gateChanges', async () => {
  const work = await outcome(
    setup({
      scenario: {
        writer: implement({
          '.harness/infra/helper.js': 'module.exports = () => true; // weaker\n',
        }),
        reviewer: approve(),
      },
      files: {
        '.harness/acceptance/run.js': passGate,
        '.harness/infra/helper.js': 'module.exports = (x) => x === 42;\n',
      },
      policy: (p: any) => {
        p.maxAttempts = 1;
        p.repositories[0].protectedPaths = [...p.repositories[0].protectedPaths, '.harness/'];
        p.repositories[0].infra = { paths: ['.harness/acceptance/', '.harness/infra/'] };
        p.repositories[0].gates[0].command = [process.execPath, '.harness/acceptance/run.js'];
      },
      graph: (g: any) =>
        Object.assign(g.orders[0], { kind: 'infra', writeScope: ['.harness/infra'] }),
    }),
  );
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'scope-violation');
  assert.match(work.failure!, /без согласования планом: \.harness\/infra\/helper\.js/);
});

// Teardown на хосте читает файл области сам (импорт, файл по умолчанию):
// argv его не называет. Исполняется он по доверенной базе.
// Teardown — мост с явным проектом (`compose-bridge.mjs`): правило infraIssues.
const teardownScript = `
import fs from 'node:fs';
import path from 'node:path';
const mode = fs.readFileSync('.harness/infra/mode.txt', 'utf8').trim();
const extra = fs.existsSync('.harness/infra/extra.js') ? 'present' : 'absent';
const where = path.basename(process.cwd()).startsWith('trusted-base-') ? 'base-checkout' : 'tree';
const own = JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON)[process.env.DEVCONTOUR_REPOSITORY_ID];
const alias = JSON.parse(process.env.HARNESS_COMPONENTS_JSON)[process.env.DEVCONTOUR_REPOSITORY_ID];
const components = own === process.cwd() && alias === own ? 'components-base' : 'components-candidate:' + own;
fs.appendFileSync(process.env.MARKER, [mode, extra, where, components].join(':') + '\\n');
`;
const teardownRun = (
  marker: string,
  order: Record<string, unknown>,
  writer: Record<string, string>,
) =>
  setup({
    scenario: { writer: implement(writer), reviewer: approve() },
    files: {
      '.harness/acceptance/run.js': passGate,
      '.harness/compose-bridge.mjs': teardownScript,
      '.harness/infra/mode.txt': 'base\n',
    },
    policy: (p: any) => {
      p.maxAttempts = 1;
      p.environment.values.MARKER = marker;
      p.repositories[0].protectedPaths = [...p.repositories[0].protectedPaths, '.harness/'];
      p.repositories[0].infra = { paths: ['.harness/acceptance/', '.harness/infra/'] };
      p.repositories[0].gates[0].command = [process.execPath, '.harness/acceptance/run.js'];
      p.repositories[0].lifecycle = {
        setup: [],
        ready: [],
        teardown: [{ id: 'down', command: [process.execPath, '.harness/compose-bridge.mjs'] }],
      };
    },
    graph: (g: any) => Object.assign(g.orders[0], order),
  });

test('alpha.67 infra: teardown на хосте исполняет доверенную базу области, а не код кандидата; принятый кандидат свои изменения сохраняет', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'harness-infra-marker-')), 'marker');
  const ctx = teardownRun(
    marker,
    {
      kind: 'infra',
      writeScope: ['.harness/infra'],
      gateChanges: ['.harness/infra/mode.txt'],
    },
    { '.harness/infra/mode.txt': 'candidate\n', '.harness/infra/extra.js': 'evil()\n' },
  );
  const repoDir = ctx.policy.repositories[0]!.path;
  const work = await outcome(ctx);
  assert.equal(work.status, 'done', work.failure);
  // Каждая фаза окружения (кандидат и интеграция) — по базе: файл кандидата
  // в кандидате не виден teardown; интеграция — уже после ревью кода.
  const lines = readFileSync(marker, 'utf8').trim().split('\n');
  assert.equal(lines[0], 'base:absent:base-checkout:components-base');
  // Отдельный checkout базы убран.
  assert.doesNotMatch(
    execFileSync('git', ['worktree', 'list'], { cwd: repoDir, encoding: 'utf8' }),
    /trusted-base-/,
  );
  assert.equal(
    execFileSync('git', ['show', `${work.resultSha}:.harness/infra/mode.txt`], {
      cwd: repoDir,
      encoding: 'utf8',
    }),
    'candidate\n',
  );
});

test('alpha.67 infra: отклонённый кандидат — teardown всё равно по доверенной базе', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'harness-infra-marker-')), 'marker');
  const work = await outcome(
    teardownRun(
      marker,
      { kind: 'infra', writeScope: ['.harness/infra'] },
      { '.harness/infra/mode.txt': 'candidate\n', '.harness/infra/extra.js': 'evil()\n' },
    ),
  );
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'scope-violation');
  assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), [
    'base:absent:base-checkout:components-base',
  ]);
});

test('alpha.67 infra: ссылки доверенной базы — файл шага на хосте защищён и по цели; ссылка в кандидате видна', async () => {
  const r = repo({
    '.harness/infra/bridge-impl.mjs': 'export {};\n',
    'README.md': 'x\n',
  });
  symlinkSync('infra/bridge-impl.mjs', join(r.dir, '.harness/bridge.mjs'));
  symlinkSync('.harness/infra', join(r.dir, 'tools-link'));
  symlinkSync('../../outside', join(r.dir, '.harness/escape'));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'links');
  const base = r.head();
  assert.equal(
    await resolveInTree(r.dir, base, '.harness/bridge.mjs'),
    '.harness/infra/bridge-impl.mjs',
  );
  assert.equal(
    await resolveInTree(r.dir, base, 'tools-link/bridge-impl.mjs'),
    '.harness/infra/bridge-impl.mjs',
  );
  assert.equal(await resolveInTree(r.dir, base, '.harness/escape'), undefined);
  assert.deepEqual((await resolvedHostFiles(r.dir, base, ['.harness/bridge.mjs'])).sort(), [
    '.harness/bridge.mjs',
    '.harness/infra/bridge-impl.mjs',
  ]);
  // Кандидат: правка цели и новая ссылка.
  writeFileSync(join(r.dir, '.harness/infra/bridge-impl.mjs'), 'evil();\n');
  symlinkSync('../bridge.mjs', join(r.dir, '.harness/infra/alias.mjs'));
  r.git('add', '-A');
  const changed = ['.harness/infra/alias.mjs', '.harness/infra/bridge-impl.mjs'];
  const facts = await changedFacts(r.dir, base, undefined, changed);
  assert.deepEqual([...facts.links], ['.harness/infra/alias.mjs']);
  assert.deepEqual([...facts.present], ['.harness/infra/bridge-impl.mjs']);
  const v = infraViolations(changed, {
    kind: 'infra',
    paths: ['.harness/infra/'],
    hostFiles: await resolvedHostFiles(r.dir, base, ['.harness/bridge.mjs']),
    gateChanges: [],
    inBase: (p) => facts.present.has(p),
    isLink: (p) => facts.links.has(p),
  });
  assert.deepEqual(v, {
    host: ['.harness/infra/bridge-impl.mjs'],
    link: ['.harness/infra/alias.mjs'],
    gate: [],
  });
});

test('alpha.67 infra: кандидат работы инфраструктуры не берётся повторно — шаги на хосте начинаются с базы', () => {
  const view = {
    attempts: () => [{ id: 'r1', status: 'failed', candidateSha: 'a'.repeat(40) }],
  } as any;
  const work = { id: 'w', approvedDigest: 'd', order: { kind: 'infra' } } as any;
  const decision = reusableImplementation(view, work, 'r2', 'basis');
  assert.equal(decision.reuse, false);
  assert.match((decision as { reason: string }).reason, /работа инфраструктуры/);
});

test('alpha.67 infra: область роли не сужает работу инфраструктуры в validate и plan-check', () => {
  const p = infraPolicy((raw) => (raw.roles.developer.writePaths = ['src']));
  const infra = order('infra-a', { kind: 'infra', writeScope: ['.harness/infra'] });
  assert.deepEqual(crossIssues(graphOf(infra), p), []);
  // Продуктовой работе правило прежнее.
  assert.ok(
    crossIssues(graphOf(order('prod-a', { writeScope: ['docs'] })), p).some((i) =>
      /не пересекается с областью роли/.test(i.message),
    ),
  );
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
        repositoryId: p.repositories[0]!.id,
        writePaths: ['.harness/infra'],
      },
    ],
  });
  const facts = planningFactsOf(p, { baseDir: '/' });
  const issues = draftIssues(draft, { facts });
  assert.ok(
    !issues.some((i) => /не пересекаются с областью роли/.test(i.message)),
    JSON.stringify(issues),
  );
  // Продуктовая задача с той же областью — прежний отказ.
  const product = planDraftSchema.parse({
    ...draft,
    tasks: [{ ...draft.tasks[0]!, kind: undefined }],
  });
  assert.ok(
    draftIssues(product, { facts }).some((i) => /не пересекаются с областью роли/.test(i.message)),
  );
});

test('alpha.67 infra: продуктовая работа со связанным репозиторием зависит от его работ инфраструктуры; открытая инфраструктура прежнего графа держит выдачу', () => {
  const p = infraPolicy();
  const infra = order('infra-a', { kind: 'infra', writeScope: ['.harness/infra'] });
  // Связанный репозиторий: та же проверка по relatedRepositories.
  const other = { ...p, repositories: [...p.repositories, { ...p.repositories[0]!, id: 'other' }] };
  const related = order('prod-b', {
    repositoryId: 'other',
    relatedRepositories: ['other', p.repositories[0]!.id],
  });
  assert.ok(
    crossIssues(graphOf(infra, related), other).some((i) =>
      /prod-b не зависит от работ инфраструктуры своего репозитория: infra-a/.test(i.message),
    ),
  );
  const repoId = p.repositories[0]!.id;
  const w = (id: string, graphId: string, kind: string | undefined, status: string) =>
    ({
      id,
      graphId,
      status,
      order: { kind, repositoryId: repoId, relatedRepositories: [] },
    }) as any;
  const works = [w('infra-a', 'g1', 'infra', 'failed'), w('prod-a', 'g2', undefined, 'ready')];
  const view = { graphs: () => [{ id: 'g1' }, { id: 'g2' }], works: () => works } as any;
  assert.deepEqual(infraPendingOf(works[1], view), ['infra-a']);
  // Позднейший граф прежний не держит; принятая инфраструктура — тоже.
  assert.deepEqual(infraPendingOf(w('prod-0', 'g1', undefined, 'ready'), view), []);
  works[0].status = 'done';
  assert.deepEqual(infraPendingOf(works[1], view), []);
});

test('alpha.67 infra: checkout доверенной базы — дерево кандидата не меняется (ссылка на внешний каталог, удаления, файл вместо каталога), checkout убран', async () => {
  const r = repo({
    '.harness/infra/a/x.mjs': 'a\n',
    '.harness/infra/gone.mjs': 'g\n',
    '.harness/infra/dir/y.mjs': 'y\n',
    'README.md': 'x\n',
  });
  const base = r.head();
  const outside = mkdtempSync(join(tmpdir(), 'harness-outside-'));
  writeFileSync(join(outside, 'x.mjs'), 'outside\n');
  // Кандидат: предок заменён ссылкой наружу, файл удалён, каталог стал файлом.
  rmSync(join(r.dir, '.harness/infra/a'), { recursive: true });
  symlinkSync(outside, join(r.dir, '.harness/infra/a'));
  rmSync(join(r.dir, '.harness/infra/gone.mjs'));
  rmSync(join(r.dir, '.harness/infra/dir'), { recursive: true });
  writeFileSync(join(r.dir, '.harness/infra/dir'), 'file now\n');
  const env = mkdtempSync(join(tmpdir(), 'harness-env-'));
  const seen = await withBaseCheckout(r.dir, base, env, (cwd) =>
    Promise.resolve({
      x: readFileSync(join(cwd, '.harness/infra/a/x.mjs'), 'utf8'),
      gone: readFileSync(join(cwd, '.harness/infra/gone.mjs'), 'utf8'),
      y: readFileSync(join(cwd, '.harness/infra/dir/y.mjs'), 'utf8'),
      cwd,
    }),
  );
  assert.deepEqual([seen.x, seen.gone, seen.y], ['a\n', 'g\n', 'y\n']);
  assert.equal(readFileSync(join(outside, 'x.mjs'), 'utf8'), 'outside\n');
  assert.equal(readFileSync(join(r.dir, '.harness/infra/dir'), 'utf8'), 'file now\n');
  assert.equal(existsSync(join(r.dir, '.harness/infra/gone.mjs')), false);
  assert.equal(existsSync(seen.cwd), false);
  assert.doesNotMatch(r.git('worktree', 'list'), /trusted-base-/);
  // Отказ шага тоже убирает checkout.
  let failedAt = '';
  await assert.rejects(
    withBaseCheckout(r.dir, base, env, (cwd) => {
      failedAt = cwd;
      return Promise.reject(new Error('teardown failed'));
    }),
    /teardown failed/,
  );
  assert.equal(existsSync(failedAt), false);
});

test('alpha.67 infra: новые файлы, затеняющие базу рядом, и конфигурация Python — только по gateChanges', async () => {
  for (const p of [
    '.harness/acceptance/conftest.py',
    '.harness/acceptance/pytest.ini',
    '.harness/acceptance/pyproject.toml',
    '.harness/acceptance/__mocks__/fs.js',
    '.harness/acceptance/x.pth',
    '.harness/acceptance/sitecustomize.py',
  ])
    assert.ok(resolutionFile(p), p);
  assert.equal(resolutionFile('.harness/acceptance/new.test.mjs'), false);
  const r = repo({
    '.harness/infra/lib/index.js': 'module.exports = 1;\n',
    '.harness/infra/util.mjs': 'export {};\n',
    '.harness/infra/case\tgolden.json': '{}\n',
    '.harness/infra/A.mjs': 'export {};\n',
    'README.md': 'x\n',
  });
  const base = r.head();
  writeFileSync(join(r.dir, '.harness/infra/lib.js'), 'module.exports = 2;\n');
  writeFileSync(join(r.dir, '.harness/infra/util.js'), 'x\n');
  mkdirSync(join(r.dir, '.harness/infra/util'));
  writeFileSync(join(r.dir, '.harness/infra/util/index.js'), 'x\n');
  writeFileSync(join(r.dir, '.harness/infra/fresh.test.mjs'), 'x\n');
  writeFileSync(join(r.dir, '.harness/infra/case\tgolden.json'), '{"weaker":1}\n');
  symlinkSync('A.mjs', join(r.dir, '.harness/infra/[A].mjs'));
  r.git('add', '-A');
  const changed = [
    '.harness/infra/lib.js',
    '.harness/infra/util.js',
    '.harness/infra/util/index.js',
    '.harness/infra/fresh.test.mjs',
    '.harness/infra/case\tgolden.json',
    '.harness/infra/[A].mjs',
  ];
  const facts = await changedFacts(r.dir, base, undefined, changed);
  // Имя с табуляцией — существующий файл; `[A].mjs` — ссылка, а не `A.mjs`.
  assert.deepEqual([...facts.present], ['.harness/infra/case\tgolden.json']);
  assert.deepEqual([...facts.links], ['.harness/infra/[A].mjs']);
  assert.deepEqual([...facts.shadows].sort(), [
    '.harness/infra/lib.js',
    '.harness/infra/util.js',
    '.harness/infra/util/index.js',
  ]);
  const v = infraViolations(changed, {
    kind: 'infra',
    paths: ['.harness/infra/'],
    hostFiles: [],
    gateChanges: [],
    inBase: (p) => facts.present.has(p),
    isLink: (p) => facts.links.has(p),
    isShadow: (p) => facts.shadows.has(p),
  });
  assert.deepEqual(v.link, ['.harness/infra/[A].mjs']);
  assert.deepEqual(v.gate.sort(), [
    '.harness/infra/case\tgolden.json',
    '.harness/infra/lib.js',
    '.harness/infra/util.js',
    '.harness/infra/util/index.js',
  ]);
});

test('alpha.67 infra: превью репозитория с областью инфраструктуры — в digest исполнения (маршрут reapprove), граница изоляции и digest без области прежние', () => {
  const preview = (p: any) =>
    (p.repositories[0].previews = [{ id: 'web', start: ['node', 'serve.mjs'] }]);
  const legacy = (p: ReturnType<typeof policyWith>) =>
    digestOf({
      ...p,
      budgets: undefined,
      prices: undefined,
      stallSweep: undefined,
      inputPolicy: undefined,
      lifecyclePreflight: undefined,
      toolchain: undefined,
      repositories: p.repositories.map((r) => ({ ...r, previews: undefined })),
      recovery: undefined,
    });
  // Без области — тот же digest, что прежняя формула, и превью в него не входят.
  const plain = policyWith(preview);
  assert.equal(executionDigest(plain), legacy(plain));
  assert.equal(executionDigest(plain), executionDigest(policyWith()));
  // С областью — превью меняют digest исполнения, но не границу изоляции.
  const infra = infraPolicy();
  const infraPreview = infraPolicy(preview);
  assert.notEqual(executionDigest(infra), executionDigest(infraPreview));
  assert.equal(isolationDigest(infra), isolationDigest(infraPreview));
  const gate = infraPolicy((p) => (p.repositories[0].gates[0].command = ['node', 'other.mjs']));
  assert.equal(isolationDigest(infra), isolationDigest(gate));
  assert.notEqual(executionDigest(infra), executionDigest(gate));
});

test('alpha.67 infra: продуктовая работа, которую держит инфраструктура прежнего графа, называет её в диагнозе', () => {
  const d = explainStop({
    kind: 'work',
    work: { id: 'prod-a', status: 'ready', attempt: 0, infraWaitingOn: ['infra-a'] },
    repair: {},
    maxAttempts: 3,
    records: [],
    now: 0,
  } as any);
  assert.equal(d.actor, null);
  assert.equal(d.action, 'wait');
  assert.match(
    d.message,
    /Ждёт работы инфраструктуры прежнего графа infra-a.*harness explain --work infra-a/,
  );
});

test('alpha.67 infra: checkout базы — запись пути до создания, уборка оставшихся от прежней попытки, ошибка уборки не подменяет итог', async () => {
  const r = repo({ '.harness/infra/a.mjs': 'a\n', 'README.md': 'x\n' });
  const base = r.head();
  const env = realpathSync(mkdtempSync(join(tmpdir(), 'harness-env-')));
  // Прежняя попытка упала после создания checkout: он зарегистрирован и на диске.
  const stale = join(env, 'trusted-base-crashed');
  r.git('worktree', 'add', '--detach', stale, base);
  const recorded: string[] = [];
  const notes: string[] = [];
  const value = await withBaseCheckout(r.dir, base, env, (cwd) => Promise.resolve(cwd), {
    prior: [stale],
    record: (path) => (recorded.push(path), Promise.resolve()),
    leftover: (_path, note) => (notes.push(note), Promise.resolve()),
  });
  assert.equal(existsSync(stale), false);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0], value);
  assert.equal(notes.length, 0);
  assert.doesNotMatch(r.git('worktree', 'list'), /trusted-base-/);
  // Каталог, который не удалить: итог teardown прежний, заметка — отдельно.
  let locked = '';
  const result = await withBaseCheckout(
    r.dir,
    base,
    env,
    (cwd) => {
      locked = join(cwd, 'locked');
      mkdirSync(locked);
      writeFileSync(join(locked, 'f'), 'x');
      chmodSync(locked, 0o500);
      return Promise.resolve('teardown ok');
    },
    { leftover: (_path, note) => (notes.push(note), Promise.resolve()) },
  );
  chmodSync(locked, 0o700);
  assert.equal(result, 'teardown ok');
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /checkout базы .* не убран/);
  // Своя запись worktree убрана и без общего prune.
  assert.doesNotMatch(r.git('worktree', 'list'), new RegExp(basename(dirname(locked))));
  // Отказ teardown не подменяется заметкой уборки.
  await assert.rejects(
    withBaseCheckout(r.dir, base, env, () => Promise.reject(new Error('teardown failed'))),
    /teardown failed/,
  );
  // Чужой каталог в каталоге окружения не трогается.
  assert.match((await removeBaseCheckout(r.dir, env, join(env, 'other'))) ?? '', /не тронут/);
});

test('alpha.67 infra: окружение teardown в checkout базы — свой компонент на checkout, проект compose не подставляется', () => {
  const env = baseCheckoutEnv(
    {
      DEVCONTOUR_REPOSITORY_ID: 'app',
      DEVCONTOUR_COMPONENTS_JSON: JSON.stringify({ app: '/w/R-1_Tree', lib: '/deps/lib' }),
      HARNESS_COMPONENTS_JSON: JSON.stringify({ app: '/w/R-1_Tree', lib: '/deps/lib' }),
    },
    '/w/R-1_Tree',
    '/env/trusted-base-x',
  );
  for (const k of ['DEVCONTOUR_COMPONENTS_JSON', 'HARNESS_COMPONENTS_JSON'])
    assert.deepEqual(JSON.parse(env[k]!), { app: '/env/trusted-base-x', lib: '/deps/lib' });
  // Проект compose не подставляется: его называет сам teardown (`-p`, мост).
  assert.equal(env.COMPOSE_PROJECT_NAME, undefined);
});

test('alpha.67 infra: затенение — без регистра, все расширения сняты; sitecustomize — любой сегмент; teardown без явного проекта — ошибка политики', async () => {
  assert.ok(resolutionFile('.harness/acceptance/sitecustomize/__init__.py'));
  assert.ok(resolutionFile('.harness/acceptance/UserCustomize.py'));
  const r = repo({
    '.harness/infra/gate.test.js': 'x\n',
    '.harness/infra/x.ts': 'x\n',
    '.harness/infra/lib/index.js': 'x\n',
    'README.md': 'x\n',
  });
  const base = r.head();
  for (const p of ['gate.test', 'x.d.ts', 'Lib.js', 'fresh.mjs'])
    writeFileSync(join(r.dir, '.harness/infra', p), 'x\n');
  r.git('add', '-A');
  const facts = await changedFacts(r.dir, base, undefined, [
    '.harness/infra/gate.test',
    '.harness/infra/x.d.ts',
    '.harness/infra/Lib.js',
    '.harness/infra/fresh.mjs',
  ]);
  assert.deepEqual([...facts.shadows].sort(), [
    '.harness/infra/Lib.js',
    '.harness/infra/gate.test',
    '.harness/infra/x.d.ts',
  ]);
  const issues = (teardown: string[][]) =>
    policyIssues(
      infraPolicy((p) => {
        p.repositories[0].lifecycle = {
          setup: [],
          ready: [],
          teardown: teardown.map((command, i) => ({ id: 'd' + i, command })),
        };
      }),
    ).filter((i) => /чистом checkout базы/.test(i.message));
  assert.deepEqual(issues([['node', '.harness/compose-bridge.mjs', 'teardown']]), []);
  assert.deepEqual(issues([['docker', 'compose', '-p', 'hx', 'down']]), []);
  assert.deepEqual(issues([['podman-compose', '--project-name=hx', 'down']]), []);
  assert.equal(issues([['docker', 'compose', 'down']]).length, 1);
  const bad = issues([['node', '.harness/infra/down.mjs']]);
  assert.equal(bad[0]!.code, 'INVALID_INPUT');
  assert.deepEqual(bad[0]!.path, ['repositories', 0, 'lifecycle', 'teardown', 0]);
  // Без области инфраструктуры — правила нет.
  assert.deepEqual(
    policyIssues(
      policyWith((p) => {
        p.repositories[0].lifecycle = {
          setup: [],
          ready: [],
          teardown: [{ id: 'd', command: ['true'] }],
        };
      }),
    ).filter((i) => /чистом checkout базы/.test(i.message)),
    [],
  );
});

test('alpha.67 infra: упавшая работа, которую повторил бы controller, при открытой инфраструктуре прежнего графа — ожидание, а не повтор', () => {
  const d = explainStop({
    kind: 'work',
    work: {
      id: 'prod-a',
      status: 'failed',
      attempt: 1,
      failureKind: 'gate',
      infraWaitingOn: ['infra-a'],
    },
    repair: { sameFailureRepairs: 0, groupRepairsUsed: 0, groupRepairBudget: 5 },
    maxAttempts: 3,
    records: [],
    now: 0,
  } as any);
  assert.equal(d.action, 'wait');
  assert.equal(d.retryPlanned, false);
  assert.match(d.message, /Ждёт работы инфраструктуры прежнего графа infra-a/);
});

test('alpha.67 infra: уборка checkout — только записанные и зарегистрированные worktree; каталог lifecycle с тем же префиксом остаётся; сбой записи не останавливает teardown; неубранный собирается следующей очисткой', async () => {
  const r = repo({ '.harness/infra/a.mjs': 'a\n', 'README.md': 'x\n' });
  const base = r.head();
  const env = realpathSync(mkdtempSync(join(tmpdir(), 'harness-env-')));
  // Состояние моста в каталоге окружения с тем же префиксом — не checkout.
  const state = join(env, 'trusted-base-state');
  mkdirSync(state);
  writeFileSync(join(state, 'ports.json'), '{}');
  // Зарегистрированный, но не записанный checkout (падение до записи).
  const unrecorded = join(env, 'trusted-base-unrecorded');
  r.git('worktree', 'add', '--detach', unrecorded, base);
  let ran = false;
  await withBaseCheckout(r.dir, base, env, () => ((ran = true), Promise.resolve()), {
    record: () => Promise.reject(new Error('disk full')),
    leftover: () => Promise.reject(new Error('disk full')),
  });
  assert.equal(ran, true, 'сбой записи в запись окружения не остановил teardown');
  assert.equal(readFileSync(join(state, 'ports.json'), 'utf8'), '{}');
  assert.equal(existsSync(unrecorded), false);
  assert.match((await removeBaseCheckout(r.dir, env, state)) ?? '', /не checkout harness/);
  // Неубранный checkout, записанный в trustedLeftovers, собирается при следующей уборке.
  const left = join(env, 'trusted-base-left');
  r.git('worktree', 'add', '--detach', left, base);
  const collected: string[] = [];
  await withBaseCheckout(r.dir, base, env, () => Promise.resolve(), {
    prior: [left],
    collected: (p) => (collected.push(p), Promise.resolve()),
  });
  assert.deepEqual(collected, [left]);
  assert.equal(existsSync(left), false);
  assert.equal(existsSync(state), true);
});

test('alpha.67 infra: повтор восстановления (recovery retry) при открытой инфраструктуре прежнего графа — ожидание, а не решение человека', () => {
  const d = explainStop({
    kind: 'work',
    work: {
      id: 'prod-a',
      status: 'failed',
      attempt: 1,
      failureKind: 'gate',
      recovery: { status: 'retry' },
      infraWaitingOn: ['infra-a'],
    },
    repair: { outlook: 'retry', sameFailureRepairs: 0, groupRepairsUsed: 0, groupRepairBudget: 5 },
    maxAttempts: 3,
    records: [],
    now: 0,
  } as any);
  assert.equal(d.actor, null);
  assert.equal(d.action, 'wait');
  assert.match(d.message, /Ждёт работы инфраструктуры прежнего графа infra-a/);
});
