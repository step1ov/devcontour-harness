/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
 * Тест правит сырой JSON политики до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executionDigest,
  executionPolicySchema,
  generatorIssues,
  policyDigest,
  policyIssues,
} from '../src/contracts/index.ts';
import { scopeViolations } from '../src/engine/scope.ts';
import { selectGenerators } from '../src/verification/generators.ts';
import { example } from './fixtures.ts';
import { approve, implement, runAll, setup, target } from './runner-fixture.ts';

// Данные правит роль admin (apps/admin), модуль из них строит скрипт роли
// mobile; общий test gate сверяет их между собой.
const DATA = 'apps/admin/data/catalog.json';
const OUT = 'apps/mobile/src/generated';
const render = `
const render = (items) => {
  const sorted = items.slice().sort();
  return {
    'apps/mobile/src/generated/catalog.ts':
      'export const catalog = [\\n' + sorted.map((i) => '  ' + JSON.stringify(i) + ',\\n').join('') + '];\\n',
    'apps/mobile/src/generated/count.ts': 'export const count = ' + sorted.length + ';\\n',
  };
};
`;
const gen = `
const fs = require('fs');
${render}
const items = JSON.parse(fs.readFileSync('apps/admin/data/catalog.json', 'utf8'));
fs.mkdirSync('apps/mobile/src/generated', { recursive: true });
for (const [path, text] of Object.entries(render(items))) fs.writeFileSync(path, text);
if (process.argv.includes('--outside')) fs.writeFileSync('apps/mobile/extra.txt', 'x');
if (process.argv.includes('--fail')) { console.error('generator broke'); process.exit(3); }
if (process.argv.includes('--map')) fs.writeFileSync('apps/mobile/src/generated/catalog.ts.map', '{}');
if (process.argv.includes('--link')) fs.symlinkSync('../../../admin/data/catalog.json', 'apps/mobile/src/generated/data.json');
if (process.argv.includes('--needs-dep')) require(process.cwd() + '/node_modules/dep');
if (process.argv.includes('--commit'))
  require('child_process').execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'sneak']);
if (process.env.GEN_SLEEP_MS && (!process.env.GEN_SLEEP_PHASE || process.env.DEVCONTOUR_PHASE === process.env.GEN_SLEEP_PHASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.GEN_SLEEP_MS));
if (process.env.GEN_MARK) fs.appendFileSync(process.env.GEN_MARK, 'ran\\n');
`;
const check = `
const fs = require('fs');
${render}
let message = '';
try {
  const expected = render(JSON.parse(fs.readFileSync('apps/admin/data/catalog.json', 'utf8')));
  for (const [path, text] of Object.entries(expected))
    if (!fs.existsSync(path) || fs.readFileSync(path, 'utf8') !== text) message += path + ' stale; ';
  for (const f of fs.readdirSync('apps/mobile/src/generated'))
    if (f !== 'node_modules' && !f.endsWith('.map') && !expected['apps/mobile/src/generated/' + f]) message += f + ' unexpected; ';
} catch (e) { message = String(e.message); }
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,
  '<testsuite><testcase classname="catalog" name="in-sync">' + (message ? '<failure message="' + message.replace(/[<&"]/g, '') + '"/>' : '') + '</testcase></testsuite>');
`;
const items = ['banana', 'cherry', 'date', 'elder', 'fig', 'grape'];
const data = (list: string[]) => JSON.stringify(list, null, 2) + '\n';
// Те же байты, что строит генератор.
const outputs = (list: string[]) => {
  const sorted = list.slice().sort();
  return {
    [`${OUT}/catalog.ts`]:
      'export const catalog = [\n' +
      sorted.map((i) => `  ${JSON.stringify(i)},\n`).join('') +
      '];\n',
    [`${OUT}/count.ts`]: `export const count = ${sorted.length};\n`,
  };
};

const generator = (extra: Record<string, unknown> = {}) => ({
  id: 'catalog',
  command: [process.execPath, 'apps/mobile/scripts/gen.js'],
  inputs: ['apps/admin/data'],
  tool: ['apps/mobile/scripts'],
  outputs: [OUT],
  ...extra,
});

function fixture(options: {
  writer: unknown;
  reviewer?: unknown;
  generators?: unknown[];
  maxAttempts?: number;
  runner?: Parameters<typeof setup>[0]['runner'];
  environment?: Record<string, string>;
  policy?: (p: any) => void;
  graph?: (g: any) => void;
}) {
  const ctx = setup({
    scenario: { writer: options.writer, reviewer: options.reviewer ?? approve() },
    files: {
      [DATA]: data(items),
      'apps/admin/README.md': 'admin\n',
      'apps/mobile/scripts/gen.js': gen,
      'test/check.js': check,
      '.gitignore': 'node_modules/\n*.map\n',
      ...outputs(items),
    },
    policy: (p: any) => {
      const repo = p.repositories[0];
      repo.gates[0].command = [process.execPath, 'test/check.js'];
      repo.protectedPaths = ['.github/', 'test/'];
      // Выход защищён от исполнителя, но генератор controller пишет его.
      repo.generatedPaths = [OUT];
      repo.generators = options.generators ?? [generator()];
      p.roles.developer.writePaths = ['apps/admin'];
      p.maxAttempts = options.maxAttempts ?? 1;
      if (options.environment) Object.assign(p.environment.values, options.environment);
      options.policy?.(p);
    },
    graph: (g: any) => {
      g.orders[0].writeScope = ['apps/admin'];
      options.graph?.(g);
    },
    ...(options.runner ? { runner: options.runner } : {}),
  });
  const attempts = () => ctx.engine.read((v) => v.attempts('add-greeting'));
  const work = () => ctx.engine.read((v) => v.work('add-greeting')!);
  const stages = (i = 0) => (attempts()[i]?.timings ?? []).map((t) => t.stage);
  return { ctx, attempts, work, stages };
}

test('assertScope: выходы исполненных генераторов (allowed) снимают защиту и область поручения/роли, но не закреплённые пути', () => {
  const rules = {
    protected: ['.github/', OUT],
    pinned: ['contracts/oracle.json'],
    writeScope: ['apps/admin'],
    role: ['apps/admin'],
  };
  const changed = [DATA, `${OUT}/catalog.ts`];
  // Без allowed — как прежде: выход защищён и вне области.
  assert.deepEqual(scopeViolations(changed, rules), {
    forbidden: [`${OUT}/catalog.ts`],
    outside: [`${OUT}/catalog.ts`],
  });
  assert.deepEqual(scopeViolations(changed, { ...rules, allowed: [OUT] }), {
    forbidden: [],
    outside: [],
  });
  // Закреплённый эталон генератор не правит; прочие пути вне выходов — как прежде.
  assert.deepEqual(
    scopeViolations(['contracts/oracle.json', 'apps/mobile/app.ts', '.github/x.yml'], {
      ...rules,
      allowed: ['contracts', 'apps/mobile/src'],
    }),
    {
      forbidden: ['contracts/oracle.json', '.github/x.yml'],
      outside: ['apps/mobile/app.ts', '.github/x.yml'],
    },
  );
});

test('selectGenerators: изменение входа, инструмента или выхода (путь или префикс) выбирает генератор, прочее — нет', () => {
  const parsed = executionPolicySchema.parse({
    ...example('policy'),
    repositories: [
      {
        ...(example('policy') as any).repositories[0],
        generators: [
          generator(),
          generator({ id: 'other', inputs: ['b/in.json'], tool: [], outputs: ['b/out'] }),
        ],
      },
    ],
  });
  const gens = parsed.repositories[0]!.generators!;
  const ids = (changed: string[]) => selectGenerators(gens, changed).map((g) => g.id);
  assert.deepEqual(ids([DATA]), ['catalog']);
  assert.deepEqual(ids(['apps/mobile/scripts/gen.js']), ['catalog']);
  assert.deepEqual(ids([`${OUT}/count.ts`]), ['catalog']);
  assert.deepEqual(ids(['apps/admin/README.md', 'apps/admin/data-old/x', 'b/in.json.bak']), []);
  assert.deepEqual(ids(['b/in.json', DATA]), ['catalog', 'other']);
});

test('Генератор: правка данных исполнителем — кандидат одним коммитом несёт перегенерированный выход другой роли, gate зелёный', async () => {
  const next = ['apple', ...items];
  const f = fixture({ writer: implement({ [DATA]: data(next) }) });
  const before = target(f.ctx);
  await runAll(f.ctx);
  const work = f.work();
  assert.equal(work.status, 'done', work.failure);
  const a = f.attempts()[0]!;
  const git = f.ctx.repo.git;
  assert.equal(git('rev-parse', `${a.candidateSha}^`), before, 'ровно один коммит поверх базы');
  for (const [path, text] of Object.entries(outputs(next)))
    assert.equal(git('show', `${a.candidateSha}:${path}`) + '\n', text, path);
  assert.deepEqual(git('diff', '--name-only', before, a.candidateSha!).split('\n').sort(), [
    DATA,
    `${OUT}/catalog.ts`,
    `${OUT}/count.ts`,
  ]);
  assert.ok(a.evidence.filter((e) => e.kind === 'test').every((e) => e.passed));
  assert.ok(f.stages().includes('generate:catalog'), f.stages().join(','));
  assert.ok(f.stages().includes('integration-generate:catalog'), 'integration перепроверяет выход');
  const dir = join(f.ctx.state, 'artifacts', a.id);
  assert.ok(existsSync(join(dir, 'candidate', 'generate', 'catalog.log')));
  const receipt = JSON.parse(
    readFileSync(join(dir, 'candidate', 'generate', 'generators.json'), 'utf8'),
  );
  assert.equal(receipt.mode, 'write');
  assert.deepEqual(receipt.generators[0].changed.sort(), [`${OUT}/catalog.ts`, `${OUT}/count.ts`]);
  const integration = JSON.parse(
    readFileSync(join(dir, 'integration', 'generate', 'generators.json'), 'utf8'),
  );
  assert.deepEqual(integration.generators[0].changed, []);
  // Исполнитель знает, что выходы строит harness.
  assert.equal(target(f.ctx), work.resultSha);
});

test('Генератор: правка выхода исполнителем перезаписывается, лишний файл в каталоге выхода убирается', async () => {
  const next = [...items, 'kiwi'];
  const f = fixture({
    writer: implement({
      [DATA]: data(next),
      [`${OUT}/catalog.ts`]: 'export const catalog = ["hand"];\n',
      [`${OUT}/stray.ts`]: 'export {};\n',
    }),
  });
  await runAll(f.ctx);
  const work = f.work();
  assert.equal(work.status, 'done', work.failure);
  const git = f.ctx.repo.git;
  for (const [path, text] of Object.entries(outputs(next)))
    assert.equal(git('show', `${work.resultSha}:${path}`) + '\n', text, path);
  assert.throws(() => git('cat-file', '-e', `${work.resultSha}:${OUT}/stray.ts`));
});

test('Генератор, изменивший путь вне своих выходов, — scope-violation с путём; target не двигается', async () => {
  const f = fixture({
    writer: implement({ [DATA]: data(['apple', ...items]) }),
    generators: [
      generator({ command: [process.execPath, 'apps/mobile/scripts/gen.js', '--outside'] }),
    ],
  });
  const before = target(f.ctx);
  await runAll(f.ctx);
  const work = f.work();
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'scope-violation', work.failure);
  assert.match(
    work.failure!,
    /Генератор catalog изменил пути вне своих выходов: apps\/mobile\/extra\.txt/,
  );
  assert.equal(target(f.ctx), before);
});

test('Упавший генератор — отказ класса gate с выводом команды', async () => {
  const f = fixture({
    writer: implement({ [DATA]: data(['apple', ...items]) }),
    generators: [
      generator({ command: [process.execPath, 'apps/mobile/scripts/gen.js', '--fail'] }),
    ],
  });
  await runAll(f.ctx);
  const work = f.work();
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'gate', work.failure);
  assert.match(work.failure!, /Генератор catalog не выполнился: exit=3: .*generator broke/);
  const timing = f.attempts()[0]!.timings!.find((t) => t.stage === 'generate:catalog');
  assert.equal(timing?.outcome, 'failed');
});

test('Генератор не исполняется, когда изменение не задевает его входы, инструмент и выходы', async () => {
  const mark = join(realpathSync(mkdtempSync(join(tmpdir(), 'gen-mark-'))), 'ran');
  const f = fixture({
    writer: implement({ 'apps/admin/README.md': 'admin v2\n' }),
    environment: { GEN_MARK: mark },
  });
  await runAll(f.ctx);
  const work = f.work();
  assert.equal(work.status, 'done', work.failure);
  assert.ok(!f.stages().some((s) => s.includes('generate')), f.stages().join(','));
  assert.ok(!existsSync(mark), 'генератор не запускался');
  assert.ok(
    !existsSync(join(f.ctx.state, 'artifacts', f.attempts()[0]!.id, 'candidate', 'generate')),
  );
});

test('Integration на сдвинутой базе с устаревшим выходом — отказ класса merge, повтор от новой базы перегенерирует выход', async () => {
  const mine = ['apple', ...items];
  const theirs = [...items, 'zucchini'];
  let moved = '';
  const f = fixture({
    writer: [implement({ [DATA]: data(mine) }), implement({})],
    maxAttempts: 3,
    runner: {
      hooks: {
        // Чужая работа принята, пока кандидат проверяется: данные и выход
        // согласованы на ней, слияние текста проходит, но выход слияния устарел.
        implemented: () => {
          if (moved) return;
          const git = (...args: string[]) =>
            execFileSync('git', args, {
              cwd: f.ctx.repo.dir,
              encoding: 'utf8',
              env: {
                ...process.env,
                GIT_INDEX_FILE: join(f.ctx.state, 'foreign-index'),
                GIT_AUTHOR_NAME: 't',
                GIT_AUTHOR_EMAIL: 't@t',
                GIT_COMMITTER_NAME: 't',
                GIT_COMMITTER_EMAIL: 't@t',
              },
            }).trim();
          const ref = f.ctx.policy.repositories[0]!.targetRef;
          git('read-tree', ref);
          for (const [path, text] of Object.entries({ [DATA]: data(theirs), ...outputs(theirs) })) {
            const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
              cwd: f.ctx.repo.dir,
              input: text,
              encoding: 'utf8',
            }).trim();
            git('update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
          }
          moved = git(
            'commit-tree',
            git('write-tree'),
            '-p',
            git('rev-parse', ref),
            '-m',
            'foreign',
          );
          git('update-ref', ref, moved);
        },
      },
    },
  });
  await runAll(f.ctx);
  assert.ok(moved);
  const first = f.attempts()[0]!;
  assert.equal(first.failureKind, 'merge', first.error);
  assert.match(first.error!, /Генератор catalog: закоммиченный выход устарел на этой базе/);
  assert.ok(first.timings!.some((t) => t.stage === 'integration-generate:catalog'));
  assert.equal(target(f.ctx), moved, 'чужой коммит остался вершиной');
  // Класс merge — повтор по таблице восстановления (его выдаёт цикл ведущего).
  f.ctx.engine.retry('add-greeting');
  f.ctx.engine.resume();
  await f.ctx.runner.drain();
  const second = f.attempts()[1];
  const work = f.work();
  assert.equal(work.status, 'done', work.failure);
  assert.equal(second!.baseSha, moved, 'повтор ответвлён от новой базы');
  const merged = [...mine, 'zucchini'];
  for (const [path, text] of Object.entries(outputs(merged)))
    assert.equal(f.ctx.repo.git('show', `${work.resultSha}:${path}`) + '\n', text, path);
});

test('Взятый кандидат: генератор исполняется заново и не меняет дерево; кандидат принимается без новой реализации', async () => {
  const crash = {
    exit: 1,
    stderr: 'ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed',
  };
  const f = fixture({
    writer: implement({ [DATA]: data(['apple', ...items]) }),
    reviewer: [crash, approve()],
    maxAttempts: 5,
  });
  await runAll(f.ctx);
  assert.equal(f.attempts()[0]!.failureKind, 'environment');
  f.ctx.engine.retry('add-greeting');
  f.ctx.engine.resume();
  await f.ctx.runner.drain();
  const second = f.attempts()[1]!;
  assert.equal(second.status, 'succeeded', second.error);
  assert.ok(second.reusedFrom, 'кандидат взят');
  assert.ok(f.stages(1).includes('generate:catalog'), f.stages(1).join(','));
  const receipt = JSON.parse(
    readFileSync(
      join(f.ctx.state, 'artifacts', second.id, 'candidate', 'generate', 'generators.json'),
      'utf8',
    ),
  );
  assert.equal(receipt.mode, 'verify');
  assert.deepEqual(receipt.generators[0].changed, []);
});

test('Политика без generators: digest прежний; поле generators меняет digest и не подставляется', () => {
  const raw = example('policy');
  const parsed = executionPolicySchema.parse(raw);
  assert.equal('generators' in parsed.repositories[0]!, false, 'умолчание не подставляется');
  // Те же значения, что зафиксированы для alpha.5 (review-protocol.test.ts).
  assert.equal(
    executionDigest(parsed),
    '283ae58f297b00c742c2ad627c4ade43748a2e64961bf1148465aa7ca18e8aa2',
  );
  assert.equal(
    policyDigest(parsed),
    'fe2c6fe7a4c099a27c1b32d2f2fd295a887abcb83ea6f8c41dd408b561e00279',
  );
  const withGen = executionPolicySchema.parse({
    ...raw,
    repositories: [{ ...(raw as any).repositories[0], generators: [generator()] }],
  });
  assert.notEqual(executionDigest(withGen), executionDigest(parsed));
  assert.equal(withGen.repositories[0]!.generators![0]!.timeoutMs, 120000);
  assert.deepEqual(policyIssues(withGen), []);
});

test('Схема и согласованность generators: пустые команда и выходы, ID, предел 10, пересечения выходов', () => {
  const raw = example('policy') as any;
  const repoWith = (generators: unknown[], extra: Record<string, unknown> = {}) => ({
    ...raw,
    repositories: [{ ...raw.repositories[0], ...extra, generators }],
  });
  const parse = (generators: unknown[]) =>
    executionPolicySchema.safeParse(repoWith(generators)).success;
  assert.equal(parse([generator({ command: [] })]), false, 'пустая команда');
  assert.equal(parse([generator({ outputs: [] })]), false, 'без выходов');
  assert.equal(parse([generator({ inputs: [] })]), false, 'без входов');
  assert.equal(parse([generator({ outputs: ['../x'] })]), false, 'путь вне корня');
  assert.equal(parse([generator({ id: 'x'.repeat(61) })]), false, 'ID длиннее 60');
  assert.equal(parse([generator({ extra: 1 })]), false, 'неизвестное поле');
  assert.equal(
    parse(
      Array.from({ length: 11 }, (_, i) =>
        generator({ id: 'g' + i, inputs: ['in' + i], outputs: ['out' + i] }),
      ),
    ),
    false,
    'не больше 10',
  );
  const messages = (generators: unknown[], extra?: Record<string, unknown>) => {
    const policy = executionPolicySchema.parse(repoWith(generators, extra));
    const issues = policyIssues(policy);
    assert.deepEqual(
      issues,
      generatorIssues(policy.repositories[0]!, ['repositories', 0, 'generators']),
    );
    return issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };
  assert.deepEqual(
    messages([generator(), generator({ inputs: ['other'], outputs: ['elsewhere'] })]),
    ['repositories.0.generators.1.id: Повтор генератора catalog'],
  );
  assert.deepEqual(
    messages([generator(), generator({ id: 'b', inputs: ['b'], outputs: ['apps/mobile/src'] })]),
    [
      'repositories.0.generators.0.outputs.0: Выходы генераторов catalog (apps/mobile/src/generated) и b (apps/mobile/src) пересекаются',
    ],
  );
  assert.deepEqual(messages([generator({ inputs: ['apps/mobile/src/generated/seed.json'] })]), [
    'repositories.0.generators.0.outputs.0: Выход генератора catalog (apps/mobile/src/generated) пересекает вход генератора catalog (apps/mobile/src/generated/seed.json)',
  ]);
  assert.deepEqual(
    messages([generator(), generator({ id: 'b', inputs: ['x'], tool: [OUT], outputs: ['y'] })]),
    [
      'repositories.0.generators.0.outputs.0: Выход генератора catalog (apps/mobile/src/generated) пересекает инструмент генератора b (apps/mobile/src/generated)',
    ],
  );
  assert.deepEqual(messages([generator({ outputs: ['.devcontour/cache'] })]), [
    'repositories.0.generators.0.outputs.0: Выход генератора catalog (.devcontour/cache) пересекает служебный каталог .devcontour',
  ]);
  assert.deepEqual(messages([generator()], { protectedPaths: ['apps/mobile/'] }), [
    'repositories.0.generators.0.outputs.0: Выход генератора catalog (apps/mobile/src/generated) пересекает защищённый путь apps/mobile/',
  ]);
});

const genWith = (...flags: string[]) =>
  generator({ command: [process.execPath, 'apps/mobile/scripts/gen.js', ...flags] });

test('Вопрос исполнителя: генератор не исполняется, ручная правка выхода остаётся правкой исполнителя — scope-violation', async () => {
  const mark = join(realpathSync(mkdtempSync(join(tmpdir(), 'gen-mark-'))), 'ran');
  const f = fixture({
    writer: {
      files: {
        [DATA]: data(['apple', ...items]),
        [`${OUT}/count.ts`]: 'export const count = 0;\n',
      },
      result: {
        completed: false,
        summary: 'Нужен ответ',
        discoveries: [],
        inputRequest: {
          question: 'Сортировать каталог?',
          options: [
            { id: 'yes', label: 'Да', consequence: null },
            { id: 'no', label: 'Нет', consequence: 'меняет порядок' },
          ],
          recommended: 'yes',
          severity: 9,
          rationale: 'Порядок виден пользователю',
          affects: [],
        },
        assumptions: [],
      },
    },
    environment: { GEN_MARK: mark },
  });
  await runAll(f.ctx);
  const work = f.work();
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'scope-violation', work.failure);
  assert.match(work.failure!, /apps\/mobile\/src\/generated\/count\.ts/);
  assert.ok(!existsSync(mark), 'генератор не запускался');
  assert.ok(!f.stages().some((s) => s.includes('generate')), f.stages().join(','));
  // Без ручной правки выхода тот же вопрос — needs-input, а не нарушение области.
  const g = fixture({
    writer: {
      files: { [DATA]: data(['apple', ...items]) },
      result: {
        completed: false,
        summary: 'Нужен ответ',
        discoveries: [],
        inputRequest: {
          question: 'Сортировать каталог?',
          options: [
            { id: 'yes', label: 'Да', consequence: null },
            { id: 'no', label: 'Нет', consequence: 'меняет порядок' },
          ],
          recommended: 'yes',
          severity: 9,
          rationale: 'Порядок виден пользователю',
          affects: [],
        },
        assumptions: [],
      },
    },
  });
  await runAll(g.ctx);
  assert.equal(g.work().failureKind, 'needs-input', g.work().failure);
  assert.ok(!g.stages().some((s) => s.includes('generate')));
});

test('Генератору нужны зависимости проекта: на взятом кандидате и integration он исполняется после gate установки', async () => {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'gen-npm-')));
  const npm = join(bin, 'npm');
  writeFileSync(
    npm,
    `#!${process.execPath}
const fs = require('fs');
fs.mkdirSync('node_modules/dep', { recursive: true });
fs.writeFileSync('node_modules/dep/index.js', 'module.exports = 1;\\n');
// Пакет workspace в каталоге выхода: установка кладёт и его node_modules.
fs.mkdirSync('apps/mobile/src/generated/node_modules/inner', { recursive: true });
fs.writeFileSync('apps/mobile/src/generated/node_modules/inner/index.js', 'module.exports = 2;\\n');
`,
  );
  chmodSync(npm, 0o755);
  const crash = {
    exit: 1,
    stderr: 'ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed',
  };
  const f = fixture({
    writer: implement({ [DATA]: data(['apple', ...items]) }),
    reviewer: [crash, approve()],
    maxAttempts: 5,
    generators: [genWith('--needs-dep')],
    policy: (p) => {
      const repo = p.repositories[0];
      // Установка — после test gate в порядке политики: проверка ждёт её.
      repo.gates = [
        { ...repo.gates[0], dependsOn: ['deps'] },
        { id: 'deps', kind: 'check', command: [npm, 'ci'] },
      ];
    },
    graph: (g) => (g.orders[0].gates = ['unit', 'deps']),
  });
  await runAll(f.ctx);
  const first = f.attempts()[0]!;
  assert.equal(first.failureKind, 'environment', first.error);
  assert.ok(first.timings!.some((t) => t.stage === 'generate:catalog'));
  f.ctx.engine.retry('add-greeting');
  f.ctx.engine.resume();
  await f.ctx.runner.drain();
  const second = f.attempts()[1]!;
  assert.equal(second.status, 'succeeded', second.error);
  assert.ok(second.reusedFrom, 'кандидат взят');
  const stages = f.stages(1);
  for (const [phase, generate] of [
    ['candidate', 'generate:catalog'],
    ['integration', 'integration-generate:catalog'],
  ] as const) {
    const install = stages.indexOf(`${phase}-test:deps`);
    assert.ok(install >= 0, stages.join(','));
    assert.ok(
      stages.indexOf(generate) > install,
      `${generate} после установки: ${stages.join(',')}`,
    );
    assert.ok(stages.indexOf(generate) < stages.indexOf(`${phase}-test:unit`), stages.join(','));
  }
});

test('Неотслеживаемый файл подготовки integration не попадает в индекс после проверки генератора', async () => {
  const f = fixture({
    writer: implement({ [DATA]: data(['apple', ...items]) }),
    policy: (p) =>
      (p.repositories[0].prepare = [
        {
          id: 'junk',
          command: [
            process.execPath,
            '-e',
            "if (process.env.DEVCONTOUR_PHASE === 'integration') require('fs').writeFileSync('junk.txt', 'x')",
          ],
        },
      ]),
  });
  await runAll(f.ctx);
  const work = f.work();
  assert.equal(work.status, 'done', work.failure);
  assert.ok(f.stages().includes('integration-generate:catalog'));
  assert.throws(() => f.ctx.repo.git('cat-file', '-e', `${work.resultSha}:junk.txt`));
});

for (const [name, gen, kind, reason] of [
  ['коммит в генераторе', genWith('--commit'), 'scope-violation', /Генератор catalog изменил HEAD/],
  [
    'выход, скрытый .gitignore',
    genWith('--map'),
    'gate',
    /Генератор catalog записал в выход файлы, скрытые \.gitignore .*catalog\.ts\.map/,
  ],
  [
    'символическая ссылка в выходе',
    genWith('--link'),
    'scope-violation',
    /Генератор catalog: в выходе символические ссылки: apps\/mobile\/src\/generated\/data\.json/,
  ],
  [
    'нет каталога cwd',
    generator({ cwd: 'apps/nowhere' }),
    'gate',
    /Генератор catalog: каталог cwd apps\/nowhere не найден в дереве \(ENOENT\)/,
  ],
] as const)
  test(`Генератор: ${name} — ${kind}; target не двигается`, async () => {
    const f = fixture({
      writer: implement({ [DATA]: data(['apple', ...items]) }),
      generators: [gen],
    });
    const before = target(f.ctx);
    await runAll(f.ctx);
    const work = f.work();
    assert.equal(work.status, 'failed');
    assert.equal(work.failureKind, kind, work.failure);
    assert.match(work.failure!, reason);
    assert.equal(target(f.ctx), before);
  });

test('Пересечение путей генераторов — без учёта регистра', () => {
  const raw = example('policy') as any;
  const policy = executionPolicySchema.parse({
    ...raw,
    repositories: [
      {
        ...raw.repositories[0],
        generators: [
          generator(),
          generator({ id: 'b', inputs: ['x'], tool: [], outputs: ['Apps/Mobile/src'] }),
        ],
      },
    ],
  });
  assert.deepEqual(
    generatorIssues(policy.repositories[0]!).map((i) => i.message),
    ['Выходы генераторов catalog (apps/mobile/src/generated) и b (Apps/Mobile/src) пересекаются'],
  );
});

test('Игнорируемые файлы, бывшие в выходе до генератора, не отказ; изменённый генератором — отказ', async () => {
  const leftovers = {
    [DATA]: data(['apple', ...items]),
    [`${OUT}/catalog.ts.map`]: '{"old":true}',
    [`${OUT}/node_modules/inner/index.js`]: 'module.exports = 2;\n',
  };
  const ok = fixture({ writer: implement(leftovers) });
  await runAll(ok.ctx);
  assert.equal(ok.work().status, 'done', ok.work().failure);
  // Генератор перезаписал игнорируемый файл, бывший в выходе: в коммит он не попадёт.
  const bad = fixture({ writer: implement(leftovers), generators: [genWith('--map')] });
  await runAll(bad.ctx);
  assert.equal(bad.work().failureKind, 'gate', bad.work().failure);
  assert.match(bad.work().failure!, /скрытые \.gitignore .*catalog\.ts\.map/);
  assert.doesNotMatch(bad.work().failure!, /node_modules/);
  // Отказ — на кандидате, при записи: сравнение только по путям пропустило бы
  // бывший файл здесь и отказало бы лишь на integration (там его нет).
  const failed = bad.attempts()[0]!;
  assert.equal(failed.candidateSha, undefined, 'кандидат не создан');
  assert.equal(failed.timings!.find((t) => t.stage === 'generate:catalog')?.outcome, 'failed');
  assert.ok(!failed.timings!.some((t) => t.stage.startsWith('integration-')));
});

test('Генерация получает свой предел фазы: исполнитель и генератор вместе дольше runTimeoutMs, попытка принимается', async () => {
  // Каждый из двух шагов — 54 % предела попытки, вместе — 108 %. Запас каждой
  // фазы — 46 % предела (11 с) на запуск процессов, git и проверки: под
  // нагрузкой полного прогона накладные расходы фазы доходили до 7 с, и запаса
  // в 6 с не хватало. Если бы генерация шла в счёт времени исполнителя, фаза
  // исполнителя превысила бы предел (26 с сна против 24 с) при любой нагрузке.
  // Генератор спит только при записи на кандидате: проверка генератора на
  // integration — отдельная фаза, к свойству не относится.
  const runTimeoutMs = 24_000;
  const stepMs = 13_000;
  const f = fixture({
    writer: { ...implement({ [DATA]: data(['apple', ...items]) }), sleepMs: stepMs },
    environment: { GEN_SLEEP_MS: String(stepMs), GEN_SLEEP_PHASE: 'candidate' },
    policy: (p) => (p.runTimeoutMs = runTimeoutMs),
  });
  await runAll(f.ctx);
  const work = f.work();
  assert.equal(work.status, 'done', work.failure);
  const timings = f.attempts()[0]!.timings!;
  const at = (stage: string) => {
    const t = timings.find((x) => x.stage === stage);
    assert.ok(t?.finishedAt, `стадия ${stage} завершена`);
    return { start: Date.parse(t.startedAt), end: Date.parse(t.finishedAt) };
  };
  const implementation = at('implementation');
  const generate = at('generate:catalog');
  // Измеренные, а не заданные длительности: исполнитель до генерации и
  // генератор каждый не меньше своего сна, а вместе — дольше предела попытки.
  assert.ok(generate.start - implementation.start >= stepMs, 'исполнитель спал до генерации');
  assert.ok(generate.end - generate.start >= stepMs, 'генератор спал');
  assert.ok(generate.end - implementation.start > runTimeoutMs, 'вместе дольше runTimeoutMs');
});
