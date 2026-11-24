/**
 * P8-1 (0.1.0-alpha.70, ревью 4): под границей записи git дерева попытки —
 * как в alpha.69: каталог git закрыт, работают только команды для чтения;
 * index, ссылки, stash, объекты и config владельца закрыты, stash владельца
 * и на чтение. Исполнитель получает те же правила (тот же gitWorktreeGuard).
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GUARDED_GIT_DENIAL,
  gitWorktreeGuard,
  writeGuardSupport,
} from '../src/environment/write-guard.ts';
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
  // Ветка владельца и запись в его stash — до дерева попытки.
  r.git('branch', 'other');
  execFileSync('sh', ['-c', 'echo owner > README.md'], { cwd: r.dir });
  r.git('stash', 'push', '-q', '-m', 'owner-stash');
  const tree = join(realpathSync(mkdtempSync(join(tmpdir(), 'attempt-tree-'))), 'w');
  if (branch) r.git('worktree', 'add', '-q', '-b', branch, tree);
  else r.git('worktree', 'add', '-q', '--detach', tree);
  return { r, tree };
}

const packs = (common: string) =>
  readdirSync(join(common, 'objects', 'pack'))
    .filter((f) => !f.startsWith('tmp'))
    .sort();

test('git дерева попытки под границей: каталог git закрыт (как alpha.69), stash владельца не читается', () => {
  const { r, tree } = attemptTree('harness/run-a1');
  const common = realpathSync(join(r.dir, '.git'));
  assert.deepEqual(gitWorktreeGuard(tree)!.entries, [
    { denyRead: join(common, 'refs', 'stash') },
    { denyRead: join(common, 'logs', 'refs', 'stash') },
  ]);
  // Основной checkout и каталог вне git — ничего сверх их самих.
  assert.equal(gitWorktreeGuard(r.dir), undefined);
  assert.equal(gitWorktreeGuard(realpathSync(mkdtempSync(join(tmpdir(), 'no-git-')))), undefined);
});

test(
  'под границей: git для чтения работает; add, commit, stash, checkout -- ., reset, checkout ветки, ветки, общие объекты и config закрыты; дерево попытки и владелец не тронуты',
  { skip: !supported },
  async () => {
    const { r, tree } = attemptTree('harness/run-a1');
    const common = realpathSync(join(r.dir, '.git'));
    r.git('repack', '-adq');
    const before = {
      packs: packs(common),
      other: r.git('rev-parse', 'other'),
      own: r.git('rev-parse', 'harness/run-a1'),
      head: readFileSync(join(common, 'worktrees', 'w', 'HEAD'), 'utf8'),
    };
    const main = join(r.dir, 'src', 'a.js');
    const ok = (name: string, cmd: string) =>
      `${cmd} >/dev/null 2>&1 && echo ${name}=ok || echo ${name}=fail`;
    const script = [
      'echo changed > src/a.js',
      ok('status', 'git status --porcelain'),
      'git status --porcelain | grep -q "src/a.js" && echo seen=yes || echo seen=no',
      ok('diff', 'git diff'),
      ok('diffexit', 'git diff --exit-code'),
      ok('log', 'git log -1'),
      ok('show', 'git show HEAD:src/a.js'),
      ok('add', 'git add -A'),
      ok('commit', 'git -c user.name=t -c user.email=t@t commit -qam gate'),
      ok('stash', 'git stash'),
      ok('restore', 'git checkout -- .'),
      ok('reset', 'git reset --hard'),
      ok('switch', 'git checkout -q other'),
      ok('branch', 'git branch -f other HEAD'),
      ok('ref', 'git update-ref refs/heads/main HEAD'),
      ok('pop', 'git stash pop'),
      ok('apply', 'git stash apply'),
      ok('cfg', `sh -c 'echo x >> ${join(common, 'config')}'`),
      ok('objects', `sh -c 'echo x > ${join(common, 'objects', 'pack', 'planted.pack')}'`),
      ok('main', `sh -c 'echo hacked > ${main}'`),
      'true',
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
    assert.equal(result.code, 0, result.stdout + '|' + result.stderr);
    // Git для чтения: необязательное обновление index без блокировки пропускается.
    for (const line of ['status=ok', 'seen=yes', 'diff=ok', 'diffexit=fail', 'log=ok', 'show=ok'])
      assert.match(result.stdout, new RegExp(line), result.stdout);
    for (const name of [
      'add',
      'commit',
      'stash',
      'restore',
      'reset',
      'switch',
      'branch',
      'ref',
      'pop',
      'apply',
      'cfg',
      'objects',
      'main',
    ])
      assert.match(result.stdout, new RegExp(`${name}=fail`), result.stdout);
    // Дерево попытки: правка осталась (checkout/reset/stash не прошли), stash
    // владельца не наложен.
    assert.equal(readFileSync(join(tree, 'src', 'a.js'), 'utf8'), 'changed\n');
    assert.equal(readFileSync(join(tree, 'README.md'), 'utf8'), 'app\n');
    assert.equal(
      readFileSync(join(common, 'worktrees', 'w', 'HEAD'), 'utf8'),
      before.head,
      'HEAD дерева не переключён',
    );
    // Владелец: основное дерево, ветки, stash, config, паки — прежние.
    assert.equal(readFileSync(main, 'utf8'), 'a\n');
    assert.equal(r.git('rev-parse', 'other'), before.other);
    assert.equal(r.git('rev-parse', 'harness/run-a1'), before.own);
    assert.match(r.git('stash', 'list'), /owner-stash/);
    assert.doesNotMatch(readFileSync(join(common, 'config'), 'utf8'), /^x$/m);
    assert.deepEqual(packs(common), before.packs);
    assert.match(
      "fatal: Unable to create '/r/.git/worktrees/w/index.lock': Operation not permitted",
      GUARDED_GIT_DENIAL,
    );
  },
);
