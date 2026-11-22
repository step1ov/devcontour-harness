/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument --
 * Тест правит сырой JSON примера до разбора схемой.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandPaths,
  executionDigest,
  executionPolicySchema,
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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo } from './git-fixture.ts';
import { changedFacts, resolveInTree, resolvedHostFiles } from '../src/engine/infra-guard.ts';
import { reusableImplementation } from '../src/engine/reuse.ts';
import { infraPendingOf } from '../src/engine/engine.ts';
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
const teardownScript = `
const fs = require('fs');
const mode = fs.readFileSync('.harness/infra/mode.txt', 'utf8').trim();
const extra = fs.existsSync('.harness/infra/extra.js') ? 'present' : 'absent';
fs.appendFileSync(process.env.MARKER, mode + ':' + extra + '\\n');
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
      '.harness/teardown.js': teardownScript,
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
        teardown: [{ id: 'down', command: [process.execPath, '.harness/teardown.js'] }],
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
  assert.equal(lines[0], 'base:absent');
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
  assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), ['base:absent']);
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
