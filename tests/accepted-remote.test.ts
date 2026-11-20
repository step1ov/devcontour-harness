/**
 * Удалённая ветка принятой работы (`acceptedTargets().remote`) на настоящем
 * git, без CLI: только локальные ref, config и reflog. Partial clone не
 * догружает недостающий объект (транспорт и ленивая догрузка запрещены),
 * upstream берётся ровно у целевой ветки, испорченная ref — «неизвестно» с
 * причиной на обоих языках, без reflog — без времени.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptedTargetSchema } from '../src/contracts/index.ts';
import { acceptedTargets, remoteOf } from '../src/control/target.ts';

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
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
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
  // Каждый запуск транспорта (догрузка через file://) оставляет след.
  const marker = join(r.root, 'transport.log');
  const uploadPack = join(r.root, 'upload-pack.sh');
  writeFileSync(uploadPack, `#!/bin/sh\necho run >> '${marker}'\nexec git-upload-pack "$@"\n`, {
    mode: 0o755,
  });
  r.git('config', 'remote.origin.uploadpack', uploadPack);
  r.git('config', 'branch.main.remote', 'origin');
  r.git('config', 'branch.main.merge', 'refs/heads/main');
  mkdirSync(join(r.app, '.git/refs/remotes/origin'), { recursive: true });
  writeFileSync(join(r.app, '.git/refs/remotes/origin/main'), missing + '\n');
  const objects = join(r.app, '.git/objects');
  const before = objectFiles(objects);

  // Унаследованный список протоколов и разрешение в config запрет не снимают.
  // На git, который знает GIT_NO_LAZY_FETCH (как этот), догрузку закрывает и
  // он сам; запрет транспорта проверяется отдельно ниже.
  r.git('config', 'protocol.file.allow', 'always');
  const saved = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = 'file:ssh:https';
  let t, drift;
  try {
    t = check(r.app, 'refs/heads/main', r.sha);
    // Принятый SHA, которого нет локально: сверка дрейфа тоже без догрузки.
    drift = check(r.app, 'refs/heads/main', missing);
  } finally {
    if (saved === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = saved;
  }
  assert.equal(t.remote!.state, 'unknown', JSON.stringify(t.remote));
  assert.equal(t.remote!.reason, 'удалённая ветка не прочитана');
  assert.equal(t.remote!.lineEn, 'unknown (the remote branch could not be read)');
  assert.equal(drift.unavailable, 'принятый коммит не прочитан');
  assert.equal(objectFiles(objects), before, 'ни один объект не загружен');
  assert.ok(!existsSync(marker), 'транспорт не запускался');
  // Запрет транспорта сам по себе (тот же env, что у сверки): fetch с
  // разрешением в config всё равно отклонён.
  const fetch = spawnSync('git', ['fetch', '-q', 'origin', 'main'], {
    cwd: r.app,
    env: { ...env, GIT_ALLOW_PROTOCOL: '' },
    encoding: 'utf8',
  });
  assert.notEqual(fetch.status, 0);
  assert.match(fetch.stderr, /transport 'file' not allowed/);
  assert.ok(!existsSync(marker));
  // Контроль: обычный git в этом репозитории догружает объект через транспорт.
  r.git('rev-parse', '--verify', `${missing}^{commit}`);
  assert.ok(existsSync(marker), 'сценарий действительно вызывает транспорт');
  assert.ok(objectFiles(objects) > before);
  rmSync(r.root, { recursive: true, force: true });
});

test('P2-c: upstream — ровно целевой ветки; ветки <ref>/… своим upstream её не подменяют', () => {
  const r = repo();
  const origin = join(r.root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
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
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
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
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
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

test('P2-c: неполная история (shallow) — «неизвестно», а не «ещё нет»', () => {
  const r = repo();
  const accepted = r.sha;
  r.git('commit', '-q', '--allow-empty', '-m', 'b');
  const b = r.git('rev-parse', 'HEAD');
  r.git('commit', '-q', '--allow-empty', '-m', 'c');
  const c = r.git('rev-parse', 'HEAD');
  r.git('update-ref', 'refs/remotes/origin/main', c);
  // Контроль: с полной историей принятый коммит — предок вершины.
  assert.equal(check(r.app, 'refs/heads/main', accepted).remote!.state, 'pushed');
  // Граница shallow на b: предки b на этой машине не видны.
  writeFileSync(join(r.app, '.git/shallow'), b + '\n');
  const t = check(r.app, 'refs/heads/main', accepted);
  assert.equal(t.remote!.state, 'unknown', JSON.stringify(t.remote));
  assert.equal(t.remote!.reason, 'история на этой машине неполная (shallow)');
  assert.equal(t.remote!.lineEn, 'unknown (the history on this machine is incomplete (shallow))');
  // Видимый предок по-прежнему «уже в удалённой ветке».
  assert.equal(check(r.app, 'refs/heads/main', b).remote!.state, 'pushed');
  rmSync(r.root, { recursive: true, force: true });
});

test('P2-c: чтение reflog не проверяет подпись вершины (внешняя программа не запускается)', () => {
  const r = repo();
  // Вершина удалённой ветки — подписанный потомок принятого коммита.
  r.git('commit', '-q', '--allow-empty', '-m', 'b');
  const body = r.git('cat-file', 'commit', 'HEAD');
  const [head, ...rest] = body.split('\n\n');
  const signedText = `${head}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----\n\n${rest.join('\n\n')}\n`;
  const signed = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: r.app,
    input: signedText,
    encoding: 'utf8',
  }).trim();
  r.git('update-ref', '-m', 'fetch', 'refs/remotes/origin/main', signed);
  const marker = join(r.root, 'gpg.log');
  const gpg = join(r.root, 'gpg.sh');
  writeFileSync(gpg, `#!/bin/sh\necho run >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  r.git('config', 'log.showSignature', 'true');
  r.git('config', 'gpg.program', gpg);
  const t = check(r.app, 'refs/heads/main', r.sha);
  assert.equal(t.remote!.state, 'pushed');
  assert.ok(t.remote!.checkedAt);
  assert.ok(!existsSync(marker), 'программа проверки подписи не запускалась');
  // Контроль: тот же reflog без флага запускает её.
  r.git('reflog', 'show', '-n', '1', '--format=%gd', 'refs/remotes/origin/main');
  assert.ok(existsSync(marker), 'сценарий действительно проверяет подпись');
  rmSync(r.root, { recursive: true, force: true });
});

test('P2-c: имя удалённой ветки длиннее предела договора — без trackingRef и адреса отправки, вывод по схеме', () => {
  const r = repo();
  const long = ['a', 'b', 'c'].map((x) => x.repeat(190)).join('/');
  r.git('remote', 'add', 'origin', join(r.root, 'nowhere.git'));
  r.git('config', 'branch.main.remote', 'origin');
  r.git('config', 'branch.main.merge', `refs/heads/${long}`);
  const t = check(r.app, 'refs/heads/main', r.sha);
  acceptedTargetSchema.parse(t);
  assert.equal(t.remote!.state, 'unknown');
  assert.equal(t.remote!.trackingRef, undefined);
  assert.equal(t.remote!.pushRef, undefined, 'адрес отправки не обрезается: его нет');
  assert.ok(t.remote!.line.length <= 500);
  rmSync(r.root, { recursive: true, force: true });
});

test('P2-c: границы имён — ровно предел сохраняется точно, сверх предела поля нет', () => {
  const at = (remote: number, ref: number, short: number) =>
    remoteOf('not-pushed', {
      short: 's'.repeat(short),
      push: { remote: 'r'.repeat(remote), ref: 'f'.repeat(ref) },
    });
  const ok = at(200, 500, 500);
  assert.equal(ok.pushRemote, 'r'.repeat(200));
  assert.equal(ok.pushRef, 'f'.repeat(500));
  assert.equal(ok.trackingRef, 's'.repeat(500));
  for (const [r, f] of [
    [201, 500],
    [200, 501],
  ] as const) {
    const x = at(r, f, 10);
    assert.equal(x.pushRemote, undefined);
    assert.equal(x.pushRef, undefined, 'адрес отправки — оба поля или ни одного');
    assert.equal(x.trackingRef, 's'.repeat(10));
  }
  assert.equal(at(1, 1, 501).trackingRef, undefined);
  assert.equal(at(1, 1, 501).pushRef, 'f');
  for (const state of ['pushed', 'not-pushed'] as const) {
    const x = remoteOf(state, { short: 'o/' + 'n'.repeat(600) });
    acceptedTargetSchema.shape.remote.parse(x);
    assert.equal(x.trackingRef, undefined);
    assert.ok(x.line.length <= 500 && x.lineEn.length <= 500);
  }
});
