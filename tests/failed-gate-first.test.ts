/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment --
 * Фикстура правит сырой JSON политики.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failedFirst } from '../src/verification/gate-scope.ts';
import { approve, implement, setup } from './runner-fixture.ts';
import { node } from './components-fixture.ts';
import { planReview, trustNone } from './engine-fixture.ts';

const g = (id: string, kind: 'check' | 'test', dependsOn?: string[]) => ({
  id,
  kind,
  ...(dependsOn ? { dependsOn } : {}),
});

test('failedFirst: упавший gate и замыкание его предпосылок — первыми, остальные в прежнем порядке', () => {
  const gates = [
    g('install', 'check', []),
    g('lint', 'check', ['install']),
    g('build', 'check', ['install']),
    g('unit', 'test', ['install']),
    g('acceptance', 'test', ['build']),
  ];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  assert.deepEqual(ids(failedFirst(gates, gates, 'acceptance')), [
    'install',
    'build',
    'acceptance',
    'lint',
    'unit',
  ]);
  assert.deepEqual(ids(failedFirst(gates, gates, 'unit')), [
    'install',
    'unit',
    'lint',
    'build',
    'acceptance',
  ]);
  // Нет провала или gate вне области — порядок прежний.
  assert.deepEqual(ids(failedFirst(gates, gates)), ids(gates));
  assert.deepEqual(ids(failedFirst(gates, gates.slice(0, 3), 'acceptance')), [
    'install',
    'lint',
    'build',
  ]);
  // Режим порядка массива (без dependsOn): более ранние check gates — предпосылки.
  const array = [g('a', 'check'), g('b', 'check'), g('t', 'test')];
  assert.deepEqual(ids(failedFirst(array, array, 't')), ['a', 'b', 't']);
});

test('после провала gate следующая попытка исполняет его первым (кандидат и интеграция)', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-order-')));
  const log = join(dir, 'runs.log');
  const append = (label: string) =>
    `require('fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(label)} + ':' + process.env.DEVCONTOUR_PHASE + '\\n');`;
  const ctx = setup({
    scenario: {
      writer: [implement({ 'src/greet.js': "exports.greet = () => 'nope';\n" }), implement()],
      reviewer: approve(),
    },
    graph: (gr: any) => (gr.orders[0].gates = ['lint', 'unit']),
    policy: (p: any) => {
      p.maxAttempts = 2;
      const repo = p.repositories[0];
      repo.gates[0].command = [
        process.execPath,
        '-e',
        append('unit') + "require(process.cwd() + '/test/run.js');",
      ];
      // unit не зависит от lint: явный граф, а не порядок массива.
      repo.gates[0].dependsOn = [];
      repo.gates.unshift({ id: 'lint', kind: 'check', command: node(append('lint')) });
    },
  });
  await ctx.runner.init();
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(planReview(ctx.engine, graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  await ctx.runner.drain();
  if (ctx.engine.read((v) => v.attempts('add-greeting').length) === 1) {
    ctx.engine.retry('add-greeting');
    ctx.engine.resume();
    await ctx.runner.drain();
  }
  const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]!.status, 'succeeded', attempts[1]!.error);
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  assert.deepEqual(lines.slice(0, 2), ['lint:candidate', 'unit:candidate'], 'первая попытка');
  assert.deepEqual(
    lines.slice(2).filter((l) => l.endsWith(':candidate')),
    ['unit:candidate', 'lint:candidate'],
    'вторая попытка: упавший unit первым',
  );
  const integration = lines.filter((l) => l.endsWith(':integration'));
  if (integration.length) assert.deepEqual(integration, ['unit:integration', 'lint:integration']);
  ctx.store.close();
});
