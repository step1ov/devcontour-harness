/**
 * P8-1 (0.1.0-alpha.70): граница записи облегчённого режима и git внутри
 * дерева попытки. Gate, который делает `git stash`, `git diff --exit-code`,
 * `git checkout -- .` и `git commit` в связанном дереве попытки, работает
 * под границей; запись в файлы основного рабочего дерева и в прочие файлы
 * общего `.git` (config, hooks) по-прежнему закрыта.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitWorktreeGuardEntries, writeGuardSupport } from '../src/environment/write-guard.ts';
import { runCheck } from '../src/verification/gates.ts';
import { repo } from './git-fixture.ts';

const supported = writeGuardSupport().ok;
// Без кешей по умолчанию: временные репозитории теста лежат в TMPDIR, а он
// (DARWIN_USER_TEMP_DIR) — среди открытых кешей.
const light = {
  config: {
    isolation: { mode: 'os' as const, domains: [] },
    harnessMode: 'light' as const,
    writeGuard: { replace: ['~/.npm/_cacache'] },
  },
};
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function attemptTree(branch?: string) {
  const r = repo({ 'README.md': 'app\n', 'src/a.js': 'a\n' });
  const tree = join(realpathSync(mkdtempSync(join(tmpdir(), 'attempt-tree-'))), 'w');
  if (branch) r.git('worktree', 'add', '-q', '-b', branch, tree);
  else r.git('worktree', 'add', '-q', '--detach', tree);
  return { r, tree };
}

test('метаданные дерева попытки: свой gitdir целиком, из общего — objects, ветка и stash', () => {
  const { r, tree } = attemptTree('attempt-1');
  const common = realpathSync(join(r.dir, '.git'));
  const entries = gitWorktreeGuardEntries(tree);
  assert.deepEqual(entries, [
    { subpath: join(common, 'worktrees', 'w') },
    { subpath: join(common, 'objects') },
    { prefix: join(common, 'refs', 'heads', 'attempt-1') },
    { prefix: join(common, 'logs', 'refs', 'heads', 'attempt-1') },
    { prefix: join(common, 'refs', 'stash') },
    { prefix: join(common, 'logs', 'refs', 'stash') },
  ]);
  // Основной checkout и каталог вне git — ничего сверх их самих.
  assert.deepEqual(gitWorktreeGuardEntries(r.dir), []);
  assert.deepEqual(
    gitWorktreeGuardEntries(realpathSync(mkdtempSync(join(tmpdir(), 'no-git-')))),
    [],
  );
});

test(
  'gate с git stash / diff --exit-code / checkout -- . / commit в дереве попытки работает под границей; основное дерево и .git/config закрыты',
  { skip: !supported },
  async () => {
    for (const branch of ['attempt-2', undefined]) {
      const { r, tree } = attemptTree(branch);
      const main = join(r.dir, 'src', 'a.js');
      const script = [
        'set -e',
        'echo changed > src/a.js',
        'git stash -q',
        'git diff --exit-code',
        'git stash pop -q',
        'git checkout -- .',
        'git diff --exit-code',
        'echo b > src/b.js',
        'git add -A',
        'git commit -qm gate',
        'git stash list > /dev/null',
        `( echo hacked > ${main} ) 2>/dev/null && echo main=open || echo main=denied`,
        `( echo x >> ${join(r.dir, '.git', 'config')} ) 2>/dev/null && echo config=open || echo config=denied`,
      ].join('\n');
      const result = await runCheck(light, {
        argv: ['/bin/sh', '-c', script],
        cwd: tree,
        env,
        signal: new AbortController().signal,
        write: [tree],
        readable: [],
        controller: [],
        settingsDir: mkdtempSync(join(tmpdir(), 'guard-git-settings-')),
      });
      assert.equal(result.code, 0, `${branch ?? 'detached'}: ${result.stderr}`);
      assert.match(result.stdout, /main=denied/);
      assert.match(result.stdout, /config=denied/);
      assert.equal(readFileSync(main, 'utf8'), 'a\n', 'основное дерево не тронуто');
      assert.equal(
        execFileSync('git', ['-C', tree, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(),
        'gate',
      );
    }
  },
);
