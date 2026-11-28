import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewProbes, type ProbeSpec } from '../src/agents/review-probe.ts';
import { isolationSupport } from '../src/environment/isolation.ts';
import { controllerTemp } from '../src/environment/controller-temp.ts';
import { approve, implement, setup } from './runner-fixture.ts';
import { write } from './git-fixture.ts';

const probeDirs = () => readdirSync(controllerTemp.dir()).filter((n) => n.startsWith('hx-probe-'));

type Copy = { cwd: string; links: string[]; dispose: () => Promise<void> };
const made = (c: Awaited<ReturnType<ReturnType<typeof setup>['runner']['probeCopy']>>): Copy => {
  assert.ok('cwd' in c, 'копия создана: ' + JSON.stringify(c));
  return c;
};

test('A4, ревью A1 M3: копия коммита чиста для git status, видит игнорируемые файлы кандидата (node_modules, .env); дерево кандидата не меняется; копия убирается', async (t) => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  write(ctx.repo.dir, {
    '.gitignore': 'node_modules/\n.env\n',
    'node_modules/dep/index.js': 'module.exports = 1;\n',
    '.env': 'API_URL=http://localhost\n',
  });
  const sha = ctx.repo.git('rev-parse', 'HEAD');
  const before = ctx.repo.git('status', '--porcelain', '--untracked-files=all');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-copy-')));
  const copy = made(await ctx.runner.probeCopy(ctx.repo.dir, sha, dir));
  assert.notEqual(copy.cwd, ctx.repo.dir);
  assert.equal(ctx.repo.git('-C', copy.cwd, 'rev-parse', 'HEAD'), sha);
  // Проверка чистого дерева проходит в копии так же, как в кандидате.
  assert.equal(ctx.repo.git('-C', copy.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.ok(existsSync(join(copy.cwd, 'node_modules/dep/index.js')));
  assert.equal(await readFile(join(copy.cwd, '.env'), 'utf8'), 'API_URL=http://localhost\n');
  assert.deepEqual([...copy.links].sort(), ['.env', 'node_modules']);
  const support = isolationSupport();
  if (support.ok) {
    for (const harnessMode of ['strict', 'light'] as const) {
      const spec = (writable: boolean): ProbeSpec => ({
        cwd: copy.cwd,
        controller: [],
        readable: [copy.cwd, ctx.repo.dir],
        isolation: { mode: 'os', domains: [] },
        harnessMode,
        commandTimeoutMs: 30000,
        budgetMs: 120000,
        deadline: Date.now() + 600000,
        env: ['PATH', 'HOME'],
        secrets: [],
        settingsDir: join(dir, `settings-${harnessMode}-${writable}`),
        log: join(dir, `${harnessMode}-${writable}.jsonl`),
        ...(writable ? { writable: true } : {}),
      });
      const wrote = await new ReviewProbes(spec(true)).run({
        argv: ['sh', '-c', `mkdir -p dist && echo built > dist/${harnessMode}.txt`],
      });
      assert.equal(wrote.status, 'passed', harnessMode + ': ' + wrote.stderr);
      assert.equal(await readFile(join(copy.cwd, `dist/${harnessMode}.txt`), 'utf8'), 'built\n');
      // Облегчённый режим — граница записи, не песочница: каталог кандидата
      // теста лежит во временном каталоге пользователя, открытом на запись
      // (docs/light-mode.md); границу ссылки и только чтения проверяет строгий.
      if (harnessMode === 'light') continue;
      // Запись через ссылку попадает в кандидата — отклоняется.
      const through = await new ReviewProbes(spec(true)).run({
        argv: ['sh', '-c', 'echo x > node_modules/dep/planted.js'],
      });
      assert.equal(through.status, 'failed', harnessMode + ': запись через ссылку');
      assert.ok(!existsSync(join(ctx.repo.dir, 'node_modules/dep/planted.js')));
      // Без копии (прежнее поведение) запись в дерево отклоняется.
      const readOnly = await new ReviewProbes(spec(false)).run({
        argv: ['sh', '-c', 'echo x > other.txt'],
      });
      assert.equal(readOnly.status, 'failed', harnessMode);
    }
  } else t.diagnostic('песочница ОС недоступна: запись в копию проверена без неё');
  // Проверяемое дерево не изменилось.
  assert.equal(ctx.repo.git('status', '--porcelain', '--untracked-files=all'), before);
  assert.ok(!existsSync(join(ctx.repo.dir, 'dist')));
  await copy.dispose();
  assert.ok(!existsSync(copy.cwd), 'копия убрана');
  assert.doesNotMatch(ctx.repo.git('worktree', 'list'), /hx-probe-/);
  ctx.store.close();
});

// P11-4: в пилоте 12 ни одно ревью не смогло повторить gates в копии:
// pnpm отказывался от `node_modules`-ссылки (ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH),
// а gate с путём JUnit в argv отклонялся как «запись в дерево только для чтения».
test('P11-4: в копии проверок node_modules — настоящий каталог; gate с путём JUnit в argv исполняется, отчёт перенесён в scratch', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  write(ctx.repo.dir, {
    '.gitignore': 'node_modules/\npackages/a/node_modules/\n',
    'node_modules/dep/index.js': 'module.exports = 1;\n',
    'node_modules/.modules.yaml': 'layout: 5\n',
    'packages/a/package.json': '{}\n',
    'packages/a/node_modules/inner/index.js': 'module.exports = 2;\n',
  });
  ctx.repo.git('add', '-A');
  ctx.repo.git('commit', '-q', '-m', 'workspace');
  const sha = ctx.repo.git('rev-parse', 'HEAD');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-copy-')));
  const copy = made(await ctx.runner.probeCopy(ctx.repo.dir, sha, dir));
  for (const m of ['node_modules', 'packages/a/node_modules']) {
    const st = lstatSync(join(copy.cwd, m));
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), `${m} — каталог, не ссылка`);
  }
  assert.ok(lstatSync(join(copy.cwd, 'node_modules/dep')).isSymbolicLink());
  assert.ok(existsSync(join(copy.cwd, 'node_modules/dep/index.js')));
  assert.ok(existsSync(join(copy.cwd, 'node_modules/.modules.yaml')));
  assert.ok(existsSync(join(copy.cwd, 'packages/a/node_modules/inner/index.js')));
  assert.equal(ctx.repo.git('-C', copy.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
  const script = [
    "const fs = require('fs');",
    // Файл состояния в node_modules копии (как каталог состояния задач pnpm).
    "if (fs.lstatSync('node_modules').isSymbolicLink()) { console.error('node_modules is a symbolic link'); process.exit(1); }",
    "fs.writeFileSync('node_modules/.task-state', 'x');",
    "const dest = process.argv.find((a) => a.startsWith('--dest=')).slice(7);",
    "fs.mkdirSync(require('path').dirname(dest), { recursive: true });",
    'fs.writeFileSync(dest, \'<testsuite tests="1"><testcase classname="a" name="b"/></testsuite>\');',
  ].join('\n');
  const spec: ProbeSpec = {
    cwd: copy.cwd,
    controller: [],
    readable: [copy.cwd, ctx.repo.dir],
    isolation: { mode: 'none', domains: [] },
    harnessMode: 'light',
    commandTimeoutMs: 30000,
    budgetMs: 120000,
    deadline: Date.now() + 600000,
    env: ['PATH', 'HOME'],
    secrets: [],
    settingsDir: join(dir, 'settings'),
    log: join(dir, 'probes.jsonl'),
    writable: true,
    gates: [
      {
        id: 'unit',
        kind: 'test',
        command: [process.execPath, '-e', script, '--', '--dest=reports/junit.xml'],
        timeoutMs: 30000,
        report: { type: 'junit', path: 'reports/junit.xml' },
      },
    ],
  };
  const r = await new ReviewProbes(spec).run({ gate: 'unit' });
  assert.equal(r.status, 'passed', `${r.note}\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.gate?.report?.status, 'fresh');
  assert.equal(r.gate?.report?.tests, 1);
  assert.ok(!existsSync(join(ctx.repo.dir, 'node_modules/.task-state')), 'кандидат не тронут');
  assert.ok(!existsSync(join(ctx.repo.dir, 'reports')));
  await copy.dispose();
  ctx.store.close();
});

// Ревью alpha.77 H1: writer тонкого режима уже прогнал gates, и `reports/`
// кандидата существует (игнорируемый). Ссылка на него в копии уводила отчёт
// gate копии в кандидата: EPERM под write guard (пилот) или перезапись.
const junitGate = (id: string, path: string): NonNullable<ProbeSpec['gates']>[number] => ({
  id,
  kind: 'test',
  command: [
    process.execPath,
    '-e',
    [
      "const fs = require('fs');",
      "const dest = process.argv.find((a) => a.startsWith('--dest=')).slice(7);",
      "fs.mkdirSync(require('path').dirname(dest), { recursive: true });",
      'fs.writeFileSync(dest, \'<testsuite tests="1"><testcase classname="a" name="b"/></testsuite>\');',
    ].join('\n'),
    '--',
    '--dest=' + path,
  ],
  timeoutMs: 30000,
  report: { type: 'junit', path },
});
const lightSpec = (
  cwd: string,
  candidate: string,
  dir: string,
  gates: ProbeSpec['gates'],
): ProbeSpec => ({
  cwd,
  controller: [],
  readable: [cwd, candidate],
  isolation: { mode: 'none', domains: [] },
  harnessMode: 'light',
  commandTimeoutMs: 30000,
  budgetMs: 120000,
  deadline: Date.now() + 600000,
  env: ['PATH', 'HOME'],
  secrets: [],
  settingsDir: join(dir, 'settings'),
  log: join(dir, 'probes.jsonl'),
  writable: true,
  gates,
});

test('ревью alpha.77 H1: существующий игнорируемый reports/ кандидата — в копии настоящий каталог; отчёт gate пишется в копию, кандидат не тронут', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  write(ctx.repo.dir, {
    '.gitignore': 'reports/\ncoverage/\n',
    'reports/junit.xml': '<testsuite tests="9"/>',
    'reports/other.txt': 'keep\n',
    'coverage/lcov.info': 'TN:\n',
  });
  ctx.repo.git('add', '.gitignore');
  ctx.repo.git('commit', '-q', '-m', 'ignore reports');
  const sha = ctx.repo.git('rev-parse', 'HEAD');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-copy-')));
  const copy = made(await ctx.runner.probeCopy(ctx.repo.dir, sha, dir, ['reports/junit.xml']));
  const st = lstatSync(join(copy.cwd, 'reports'));
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), 'reports — каталог копии, не ссылка');
  assert.ok(lstatSync(join(copy.cwd, 'reports/other.txt')).isSymbolicLink(), 'прочее — ссылки');
  assert.ok(!existsSync(join(copy.cwd, 'reports/junit.xml')), 'прежний отчёт не повторён');
  assert.ok(lstatSync(join(copy.cwd, 'coverage')).isSymbolicLink(), 'не отчётный каталог — ссылка');
  assert.equal(ctx.repo.git('-C', copy.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
  const r = await new ReviewProbes(
    lightSpec(copy.cwd, ctx.repo.dir, dir, [junitGate('unit', 'reports/junit.xml')]),
  ).run({ gate: 'unit' });
  assert.equal(r.status, 'passed', `${r.note}\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.gate?.report?.status, 'fresh');
  assert.equal(
    await readFile(join(ctx.repo.dir, 'reports/junit.xml'), 'utf8'),
    '<testsuite tests="9"/>',
    'отчёт кандидата не перезаписан',
  );
  await copy.dispose();
  ctx.store.close();
});

test('ревью alpha.77 H1: отчёт, записанный через ссылку внутри копии, не принимается', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  const sha = ctx.repo.git('rev-parse', 'HEAD');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-copy-')));
  const copy = made(await ctx.runner.probeCopy(ctx.repo.dir, sha, dir));
  mkdirSync(join(copy.cwd, 'elsewhere'));
  symlinkSync('elsewhere', join(copy.cwd, 'rep'));
  const r = await new ReviewProbes(
    lightSpec(copy.cwd, ctx.repo.dir, dir, [junitGate('unit', 'rep/junit.xml')]),
  ).run({ gate: 'unit' });
  assert.equal(r.gate?.report?.status, 'missing', JSON.stringify(r.gate?.report));
  await copy.dispose();
  ctx.store.close();
});

test('ревью A1 M3/L4: отказ создания копии или подмодули — причина, временный каталог убран', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-copy-')));
  const leftBefore = probeDirs().length;
  const failed = await ctx.runner.probeCopy(ctx.repo.dir, 'f'.repeat(40), dir);
  assert.ok('skipped' in failed && /^copy-failed: /.test(failed.skipped), JSON.stringify(failed));
  assert.equal(probeDirs().length, leftBefore, 'временный каталог убран при отказе');
  write(ctx.repo.dir, { '.gitmodules': '[submodule "lib"]\n\tpath = lib\n\turl = ../lib\n' });
  ctx.repo.git('add', '.gitmodules');
  ctx.repo.git('commit', '-qm', 'submodule');
  const sub = await ctx.runner.probeCopy(ctx.repo.dir, ctx.repo.git('rev-parse', 'HEAD'), dir);
  assert.ok('skipped' in sub && /^submodules: /.test(sub.skipped), JSON.stringify(sub));
  assert.equal(probeDirs().length, leftBefore);
  ctx.store.close();
});

test('ревью A1 L4: брошенные копии старше предела попытки убираются при старте controller; свежие — нет', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  const stale = join(controllerTemp.dir(), `hx-probe-stale${process.pid}`);
  const fresh = join(controllerTemp.dir(), `hx-probe-fresh${process.pid}`);
  mkdirSync(join(stale, 'tree'), { recursive: true });
  mkdirSync(join(fresh, 'tree'), { recursive: true });
  const old = (Date.now() - ctx.policy.runTimeoutMs - 3_600_000) / 1000;
  utimesSync(stale, old, old);
  await ctx.runner.sweepProbeCopies();
  assert.ok(!existsSync(stale), 'брошенная копия убрана');
  assert.ok(existsSync(fresh), 'свежая копия (идущее ревью) цела');
  await ctx.runner.sweepProbeCopies(Date.now() + ctx.policy.runTimeoutMs + 3_600_000);
  assert.ok(!existsSync(fresh));
  ctx.store.close();
});
