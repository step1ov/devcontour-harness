/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тест правит сырой JSON политики до разбора схемой.
 */
/**
 * 0.1.0-alpha.75 (P11-5): выходы gates, которые исполнитель гонял сам (JUnit,
 * `artifacts`, каталоги UI-раннера), не идут в кандидата; изменение уже
 * отслеживаемого файла под тем же путём остаётся правкой исполнителя.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateSchema } from '../src/contracts/index.ts';
import { dropGateOutputs, gateOutputPaths } from '../src/verification/gate-outputs.ts';
import { repo } from './git-fixture.ts';
import { approve, greet, implement, runAll, setup } from './runner-fixture.ts';

test('gateOutputPaths: отчёт, artifacts и каталоги UI-раннера (умолчания Playwright только у UI gate)', () => {
  const gates = [
    { id: 'unit', kind: 'test', command: ['x'], report: { type: 'junit', path: 'out/unit.xml' } },
    { id: 'lint', kind: 'check', command: ['x'] },
    {
      id: 'e2e',
      kind: 'test',
      command: ['x'],
      report: { type: 'junit', path: 'test-results/e2e.xml' },
      artifacts: ['shots/'],
      ui: { type: 'browser' },
    },
  ].map((g) => gateSchema.parse(g));
  assert.deepEqual(gateOutputPaths(gates), [
    'out/unit.xml',
    'playwright-report',
    'shots',
    'test-results',
    'test-results/e2e.xml',
  ]);
  assert.deepEqual(gateOutputPaths([gates[0]!, gates[1]!]), ['out/unit.xml']);
});

test('dropGateOutputs: новые файлы под выходами убраны из индекса; отслеживаемый файл и исходники — нет', async () => {
  const r = repo({ 'README.md': 'app\n', 'test-results/keep.txt': 'tracked\n' });
  mkdirSync(join(r.dir, 'test-results', 'admin'), { recursive: true });
  writeFileSync(join(r.dir, 'test-results', 'admin.xml'), '<testsuite/>');
  writeFileSync(join(r.dir, 'test-results', 'admin', '.last-run.json'), '{}');
  writeFileSync(join(r.dir, 'test-results', 'keep.txt'), 'changed\n');
  writeFileSync(join(r.dir, 'test-results-notes.md'), 'source\n');
  r.git('add', '-A');
  const dropped = await dropGateOutputs(r.dir, ['test-results']);
  assert.deepEqual(dropped.sort(), ['test-results/admin.xml', 'test-results/admin/.last-run.json']);
  const staged = r.git('diff', '--cached', '--name-only').split('\n').sort();
  assert.deepEqual(staged, ['test-results-notes.md', 'test-results/keep.txt']);
  // Файлы остались в дереве: убран только индекс.
  assert.equal(readFileSync(join(r.dir, 'test-results', 'admin.xml'), 'utf8'), '<testsuite/>');
  assert.deepEqual(await dropGateOutputs(r.dir, []), []);
});

test('облегчённый режим: отчёт gate, записанный самопроверкой исполнителя, не нарушает область; кандидат без него', async () => {
  const ctx = setup({
    scenario: {
      writer: implement({ 'src/greet.js': greet, 'test-results/junit.xml': '<testsuite/>\n' }),
      reviewer: approve(),
    },
    policy: (p: any) => {
      p.harnessMode = 'light';
      p.maxAttempts = 1;
      p.repositories[0].gates[0].report = { type: 'junit', path: 'test-results/junit.xml' };
    },
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  const files = ctx.repo.git('ls-tree', '-r', '--name-only', a.candidateSha!).split('\n');
  assert.ok(files.includes('src/greet.js'));
  assert.ok(!files.includes('test-results/junit.xml'));
  const log = execFileSync('find', [ctx.state, '-name', 'gate-outputs.json'], { encoding: 'utf8' })
    .trim()
    .split('\n')[0]!;
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')).dropped, ['test-results/junit.xml']);
});
