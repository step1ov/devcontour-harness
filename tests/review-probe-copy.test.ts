import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewProbes, type ProbeSpec } from '../src/agents/review-probe.ts';
import { isolationSupport } from '../src/environment/isolation.ts';
import { controllerTemp } from '../src/environment/controller-temp.ts';
import { approve, implement, setup } from './runner-fixture.ts';
import { write } from './git-fixture.ts';

const probeDirs = () => readdirSync(controllerTemp.dir()).filter((n) => n.startsWith('hx-probe-'));

test('A4: проверки reviewer пишут в одноразовую копию коммита; проверяемое дерево не меняется; копия убирается', async (t) => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  write(ctx.repo.dir, {
    '.gitignore': 'node_modules/\n',
    'node_modules/dep/index.js': 'module.exports = 1;\n',
  });
  const sha = ctx.repo.git('rev-parse', 'HEAD');
  const before = ctx.repo.git('status', '--porcelain', '--untracked-files=all');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-copy-')));
  const copy = await ctx.runner.probeCopy(ctx.repo.dir, sha, dir);
  assert.ok(copy, 'копия создана');
  assert.notEqual(copy.cwd, ctx.repo.dir);
  assert.equal(ctx.repo.git('-C', copy.cwd, 'rev-parse', 'HEAD'), sha);
  // Установленные зависимости проверяемого дерева видны в копии.
  assert.ok(existsSync(join(copy.cwd, 'node_modules/dep/index.js')));
  const support = isolationSupport();
  if (support.ok) {
    const spec = (writable: boolean): ProbeSpec => ({
      cwd: copy.cwd,
      controller: [],
      readable: [copy.cwd, ctx.repo.dir],
      isolation: { mode: 'os', domains: [] },
      commandTimeoutMs: 30000,
      budgetMs: 120000,
      deadline: Date.now() + 600000,
      env: ['PATH', 'HOME'],
      secrets: [],
      settingsDir: join(dir, writable ? 'settings-w' : 'settings-r'),
      log: join(dir, writable ? 'w.jsonl' : 'r.jsonl'),
      ...(writable ? { writable: true } : {}),
    });
    const wrote = await new ReviewProbes(spec(true)).run({
      argv: ['sh', '-c', 'mkdir -p dist && echo built > dist/out.txt'],
    });
    assert.equal(wrote.status, 'passed', wrote.stderr);
    assert.equal(await readFile(join(copy.cwd, 'dist/out.txt'), 'utf8'), 'built\n');
    // Без копии (прежнее поведение) запись в дерево отклоняется.
    const readOnly = await new ReviewProbes(spec(false)).run({
      argv: ['sh', '-c', 'echo x > other.txt'],
    });
    assert.equal(readOnly.status, 'failed');
  } else t.diagnostic('песочница ОС недоступна: запись в копию проверена без неё');
  // Проверяемое дерево не изменилось.
  assert.equal(ctx.repo.git('status', '--porcelain', '--untracked-files=all'), before);
  assert.ok(!existsSync(join(ctx.repo.dir, 'dist')));
  await copy.dispose();
  assert.ok(!existsSync(copy.cwd), 'копия убрана');
  assert.doesNotMatch(ctx.repo.git('worktree', 'list'), /hx-probe-/);
  ctx.store.close();
});

test('A4: отказ создания копии — undefined, временный каталог убран', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-copy-')));
  const leftBefore = probeDirs().length;
  const copy = await ctx.runner.probeCopy(ctx.repo.dir, 'f'.repeat(40), dir);
  assert.equal(copy, undefined);
  assert.equal(probeDirs().length, leftBefore, 'временный каталог убран при отказе');
  ctx.store.close();
});
