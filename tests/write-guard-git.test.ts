/**
 * P8-1 (0.1.0-alpha.70, ревью 1): граница записи облегчённого режима и git
 * внутри дерева попытки. Gate с `git add`, `git commit`, `git checkout -- .`
 * и `git diff --exit-code` в связанном дереве попытки работает под
 * границей; основное дерево, `.git/config`, ветки владельца, общие объекты
 * и паки, stash владельца закрыты; объекты gate переносятся после него.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitWorktreeGuard, writeGuardSupport } from '../src/environment/write-guard.ts';
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

function attemptTree() {
  const r = repo({ 'README.md': 'app\n', 'src/a.js': 'a\n' });
  // Ветка владельца и запись в его stash — до дерева попытки.
  r.git('branch', 'other');
  execFileSync('sh', ['-c', 'echo owner > README.md'], { cwd: r.dir });
  r.git('stash', 'push', '-q', '-m', 'owner-stash');
  const tree = join(realpathSync(mkdtempSync(join(tmpdir(), 'attempt-tree-'))), 'w');
  r.git('worktree', 'add', '-q', '--detach', tree);
  return { r, tree };
}

const packs = (common: string) =>
  readdirSync(join(common, 'objects', 'pack'))
    .filter((f) => !f.startsWith('tmp'))
    .sort();

test('каталог git дерева попытки: открыт только его gitdir, объекты — в своё хранилище, общее — только чтение', () => {
  const { r, tree } = attemptTree();
  const common = realpathSync(join(r.dir, '.git'));
  const guard = gitWorktreeGuard(tree, {})!;
  assert.deepEqual(guard.entries, [{ subpath: join(common, 'worktrees', 'w') }]);
  assert.equal(guard.env.GIT_OBJECT_DIRECTORY, join(common, 'worktrees', 'w', 'hx-objects'));
  assert.equal(guard.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, join(common, 'objects'));
  assert.equal(guard.env.GIT_CONFIG_KEY_0, 'gc.auto');
  assert.equal(gitWorktreeGuard(tree, { GIT_CONFIG_COUNT: '2' })!.env.GIT_CONFIG_KEY_2, 'gc.auto');
  // Основной checkout и каталог вне git — ничего сверх их самих.
  assert.equal(gitWorktreeGuard(r.dir), undefined);
  assert.equal(gitWorktreeGuard(realpathSync(mkdtempSync(join(tmpdir(), 'no-git-')))), undefined);
});

test(
  'gate под границей: add/commit/checkout/diff в дереве попытки работают; ветки, общие объекты и stash владельца закрыты',
  { skip: !supported },
  async () => {
    const { r, tree } = attemptTree();
    const common = realpathSync(join(r.dir, '.git'));
    r.git('repack', '-adq');
    const before = { packs: packs(common), other: r.git('rev-parse', 'other') };
    const main = join(r.dir, 'src', 'a.js');
    const script = [
      'set -e',
      'echo changed > src/a.js',
      'git checkout -- .',
      'git diff --exit-code',
      'echo b > src/b.js',
      'git add -A',
      'git commit -qm gate',
      'git diff --exit-code',
      `( echo hacked > ${main} ) 2>/dev/null && echo main=open || echo main=denied`,
      `( echo x >> ${join(common, 'config')} ) 2>/dev/null && echo config=open || echo config=denied`,
      `( echo x > ${join(common, 'objects', 'pack', 'planted.pack')} ) 2>/dev/null && echo objects=open || echo objects=denied`,
      'git branch -f other HEAD 2>/dev/null && echo branch=open || echo branch=denied',
      'git update-ref refs/heads/main HEAD 2>/dev/null && echo ref=open || echo ref=denied',
      'echo s > src/s.js; git add src/s.js',
      'git stash -q 2>/dev/null && echo stash=open || echo stash=denied',
      'git stash pop -q 2>/dev/null && echo pop=open || echo pop=denied',
      'git repack -adq 2>/dev/null || true',
      'git gc -q --prune=now 2>/dev/null || true',
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
    assert.equal(
      result.code,
      0,
      result.stdout + '|' + result.stderr + '|' + JSON.stringify(result.diagnostics),
    );
    for (const line of [
      'main=denied',
      'config=denied',
      'objects=denied',
      'branch=denied',
      'ref=denied',
      'stash=denied',
      'pop=denied',
    ])
      assert.match(result.stdout, new RegExp(line), result.stdout);
    assert.equal(readFileSync(main, 'utf8'), 'a\n', 'основное дерево не тронуто');
    assert.equal(r.git('rev-parse', 'other'), before.other, 'ветка владельца на месте');
    assert.match(r.git('stash', 'list'), /owner-stash/, 'stash владельца на месте');
    assert.deepEqual(packs(common), before.packs, 'паки владельца не перепакованы');
    // Коммит gate перенесён в общее хранилище: обычный git его читает.
    const head = execFileSync('git', ['-C', tree, 'log', '-1', '--format=%s'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(head, 'gate');
    execFileSync('git', [
      '-C',
      r.dir,
      'cat-file',
      '-e',
      `${execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}^{tree}`,
    ]);
  },
);
