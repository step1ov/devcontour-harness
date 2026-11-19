/**
 * Удалённая ветка принятой работы (`acceptedTargets().remote`) на настоящем
 * git, без CLI: только локальные ref, config и reflog. Partial clone не
 * догружает недостающий объект (транспорт и ленивая догрузка запрещены),
 * upstream берётся ровно у целевой ветки, испорченная ref — «неизвестно» с
 * причиной на обоих языках, без reflog — без времени.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptedTargets } from '../src/control/target.ts';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const gitIn =
  (cwd: string) =>
  (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();

function repo(branch = 'main') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-remote-')));
  const app = join(root, 'app');
  mkdirSync(app);
  const git = gitIn(app);
  git('init', '-q', '-b', branch);
  git('commit', '-q', '--allow-empty', '-m', 'a');
  return { root, app, git, sha: git('rev-parse', 'HEAD') };
}

const check = (app: string, ref: string, acceptedSha: string) =>
  acceptedTargets({ repositories: [{ id: 'app', path: app, targetRef: ref }] as never }, (p) => p, [
    { id: 'w', repositoryId: 'app', acceptedSha },
  ]).get('w')!;

/** Число файлов объектов (git здесь не вызывается: в partial clone он сам догружает). */
function objectFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true }))
    n += e.isDirectory() ? objectFiles(join(dir, e.name)) : 1;
  return n;
}

test('P2-c: partial clone — недостающий объект не догружается из удалённого репозитория', () => {
  const r = repo();
  const origin = join(r.root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  r.git('push', '-q', origin, 'main');
  // Коммит, которого нет локально: только в удалённом репозитории.
  const other = gitIn(r.root);
  other('clone', '-q', origin, 'other');
  const o = gitIn(join(r.root, 'other'));
  o('commit', '-q', '--allow-empty', '-m', 'b');
  o('push', '-q', 'origin', 'main');
  const missing = o('rev-parse', 'HEAD');
  // Локальный репозиторий — promisor: обычный git догрузил бы объект сам.
  r.git('config', 'core.repositoryformatversion', '1');
  r.git('config', 'extensions.partialClone', 'origin');
  r.git('remote', 'add', 'origin', 'file://' + origin);
  r.git('config', 'remote.origin.promisor', 'true');
  r.git('config', 'branch.main.remote', 'origin');
  r.git('config', 'branch.main.merge', 'refs/heads/main');
  mkdirSync(join(r.app, '.git/refs/remotes/origin'), { recursive: true });
  writeFileSync(join(r.app, '.git/refs/remotes/origin/main'), missing + '\n');
  const objects = join(r.app, '.git/objects');
  const before = objectFiles(objects);

  const t = check(r.app, 'refs/heads/main', r.sha);
  assert.equal(t.remote!.state, 'unknown', JSON.stringify(t.remote));
  assert.equal(t.remote!.reason, 'удалённая ветка не прочитана');
  assert.equal(t.remote!.lineEn, 'unknown (the remote branch could not be read)');
  // Принятый SHA, которого нет локально: сверка дрейфа тоже без догрузки.
  const drift = check(r.app, 'refs/heads/main', missing);
  assert.equal(drift.unavailable, 'принятый коммит не прочитан');
  assert.equal(objectFiles(objects), before, 'ни один объект не загружен');
  rmSync(r.root, { recursive: true, force: true });
});

test('P2-c: upstream — ровно целевой ветки; ветки <ref>/… своим upstream её не подменяют', () => {
  const r = repo();
  const origin = join(r.root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  r.git('remote', 'add', 'origin', origin);
  r.git('push', '-q', '-u', 'origin', 'main');
  // Целевой ветки нет, есть её «потомок» с upstream, где принятый коммит есть.
  r.git('branch', '-q', '--track', 'harness-tmp', 'origin/main');
  r.git('branch', '-q', '-m', 'harness-tmp', 'feat/child');
  const t = check(r.app, 'refs/heads/feat', r.sha);
  assert.equal(t.unavailable, 'ref не прочитан');
  assert.equal(t.remote!.state, 'unknown', JSON.stringify(t.remote));
  assert.equal(t.remote!.reason, 'нет удалённой ветки');
  rmSync(r.root, { recursive: true, force: true });
});

test('P2-c: испорченная remote-tracking ref — «неизвестно» на обоих языках; без reflog — без времени', () => {
  const r = repo();
  const origin = join(r.root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  r.git('remote', 'add', 'origin', origin);
  r.git('push', '-q', '-u', 'origin', 'main');
  let t = check(r.app, 'refs/heads/main', r.sha);
  assert.equal(t.remote!.state, 'pushed');
  assert.equal(t.remote!.pushRemote, 'origin');
  assert.equal(t.remote!.pushRef, 'refs/heads/main');
  assert.ok(t.remote!.checkedAt);

  rmSync(join(r.app, '.git/logs/refs/remotes'), { recursive: true, force: true });
  t = check(r.app, 'refs/heads/main', r.sha);
  assert.equal(t.remote!.state, 'pushed');
  assert.equal(t.remote!.checkedAt, undefined, 'нет reflog — время неизвестно, а не «сейчас»');

  writeFileSync(join(r.app, '.git/refs/remotes/origin/main'), '1'.repeat(40) + '\n');
  t = check(r.app, 'refs/heads/main', r.sha);
  assert.equal(t.remote!.state, 'unknown');
  assert.equal(t.remote!.line, 'неизвестно (удалённая ветка не прочитана)');
  assert.equal(t.remote!.lineEn, 'unknown (the remote branch could not be read)');
  // Причина — класс, без путей машины.
  assert.ok(!JSON.stringify(t).includes(r.root));
  rmSync(r.root, { recursive: true, force: true });
});

test('P2-c: upstream в локальную ветку — удалённой нет; два репозитория — у каждого своя ветка', () => {
  const r = repo();
  r.git('branch', '-q', 'base');
  r.git('branch', '-q', '--set-upstream-to=base', 'main');
  assert.equal(check(r.app, 'refs/heads/main', r.sha).remote!.reason, 'нет удалённой ветки');

  const s = repo('trunk');
  const origin = join(s.root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  s.git('remote', 'add', 'origin', origin);
  s.git('push', '-q', '-u', 'origin', 'trunk');
  s.git('commit', '-q', '--allow-empty', '-m', 'local');
  const local = s.git('rev-parse', 'HEAD');
  const both = acceptedTargets(
    {
      repositories: [
        { id: 'a', path: r.app, targetRef: 'refs/heads/main' },
        { id: 'b', path: s.app, targetRef: 'refs/heads/trunk' },
      ] as never,
    },
    (p) => p,
    [
      { id: 'wa', repositoryId: 'a', acceptedSha: r.sha },
      { id: 'wb', repositoryId: 'b', acceptedSha: local },
      { id: 'wb0', repositoryId: 'b', acceptedSha: s.sha },
    ],
  );
  assert.equal(both.get('wa')!.remote!.state, 'unknown');
  assert.equal(both.get('wb')!.remote!.state, 'not-pushed');
  assert.equal(both.get('wb')!.remote!.trackingRef, 'origin/trunk');
  assert.equal(both.get('wb0')!.remote!.state, 'pushed', 'предок вершины удалённой ветки');
  rmSync(r.root, { recursive: true, force: true });
  rmSync(s.root, { recursive: true, force: true });
});
