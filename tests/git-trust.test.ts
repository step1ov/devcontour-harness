import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, hostGitArgs } from '../src/environment/process.ts';
import { UntrustedCheckoutError, resetGitTrust } from '../src/environment/git-trust.ts';
import { repo } from './git-fixture.ts';

/**
 * Git хоста над деревом, где исполнялся чужой код, не уходит в конфигурацию,
 * которую этот код написал: `core.fsmonitor` из неё исполнился бы на хосте.
 * Тесты строят то, что могла бы оставить проверка без песочницы, и
 * проверяют, что программа из такой конфигурации не запускается.
 */
const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const raw = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

/** Программа-«ловушка»: если git её запустит, появится файл-маркер. */
function trap() {
  const dir = tmp('harness-git-trap-');
  const marker = join(dir, 'executed');
  const script = join(dir, 'hook.sh');
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(script, 0o755);
  return { script, marker };
}
async function worktree() {
  const r = repo();
  const wt = join(tmp('harness-git-wt-'), 'wt');
  await git(r.dir, 'worktree', 'add', '--detach', wt, r.head());
  return { r, wt };
}
const refused = (e: unknown) => e instanceof UntrustedCheckoutError;

test('GT01: подменённый файл .git рабочего дерева с fsmonitor внутри дерева — git хоста не запускается', async () => {
  const { wt } = await worktree();
  const t = trap();
  // Самопроверка ловушки: без защиты такой checkout исполняет программу.
  const probe = await worktree();
  raw(probe.wt, 'init', '-q', 'evil');
  raw(join(probe.wt, 'evil'), 'config', 'core.fsmonitor', t.script);
  writeFileSync(join(probe.wt, '.git'), `gitdir: ${join(probe.wt, 'evil', '.git')}\n`);
  raw(probe.wt, 'status');
  assert.ok(existsSync(t.marker), 'ловушка срабатывает у незащищённого git');

  const t2 = trap();
  raw(wt, 'init', '-q', 'evil');
  raw(join(wt, 'evil'), 'config', 'core.fsmonitor', t2.script);
  writeFileSync(join(wt, '.git'), `gitdir: ${join(wt, 'evil', '.git')}\n`);
  await assert.rejects(git(wt, 'status', '--porcelain'), refused);
  await assert.rejects(git(wt, 'rev-parse', 'HEAD'), refused);
  assert.equal(existsSync(t2.marker), false, 'fsmonitor из чужой конфигурации не исполнен');
});

test('GT02: .git известного дерева указывает на репозиторий вне дерева — отказ; неизвестное дерево вглубь себя — отказ', async () => {
  const { wt } = await worktree();
  const t = trap();
  const outside = tmp('harness-git-evil-');
  raw(outside, 'init', '-q');
  raw(outside, 'config', 'core.fsmonitor', t.script);
  writeFileSync(join(wt, '.git'), `gitdir: ${join(outside, '.git')}\n`);
  await assert.rejects(git(wt, 'status', '--porcelain'), /изменён после создания/);
  assert.equal(existsSync(t.marker), false);

  // Дерево, о котором процесс не знает (перезапуск): структура всё равно сверяется.
  const other = await worktree();
  resetGitTrust();
  const t2 = trap();
  raw(other.wt, 'init', '-q', 'evil');
  raw(join(other.wt, 'evil'), 'config', 'core.fsmonitor', t2.script);
  writeFileSync(join(other.wt, '.git'), `gitdir: ${join(other.wt, 'evil', '.git')}\n`);
  await assert.rejects(git(other.wt, 'status'), /внутрь самого дерева/);
  assert.equal(existsSync(t2.marker), false);
});

test('GT03: .git/commondir обычного checkout уводит в чужую конфигурацию — git хоста не запускается', async () => {
  const r = repo();
  const t = trap();
  raw(r.dir, 'init', '-q', '--bare', 'evil');
  raw(r.dir, '--git-dir=evil', 'config', 'core.fsmonitor', t.script);
  writeFileSync(join(r.dir, '.git', 'commondir'), '../evil\n');
  await assert.rejects(git(r.dir, 'status', '--porcelain'), /commondir перенаправляет git/);
  assert.throws(() => hostGitArgs(r.dir, ['status']), refused);
  assert.equal(existsSync(t.marker), false);
});

test('GT04: вложенный репозиторий внутри известного дерева — отказ, даже если git идёт из подкаталога', async () => {
  const { wt } = await worktree();
  mkdirSync(join(wt, 'sub'));
  raw(join(wt, 'sub'), 'init', '-q');
  await assert.rejects(git(join(wt, 'sub'), 'status'), /вложенный репозиторий/);
  // Каталог-«голый репозиторий» без .git — тоже.
  mkdirSync(join(wt, 'bare'));
  raw(join(wt, 'bare'), 'init', '-q', '--bare');
  await assert.rejects(git(join(wt, 'bare'), 'status'), /вложенный репозиторий/);
});

test('GT05: исполняемые настройки настоящего репозитория хост не исполняет: fsmonitor и hooks', async () => {
  const r = repo();
  const t = trap();
  raw(r.dir, 'config', 'core.fsmonitor', t.script);
  await git(r.dir, 'status', '--porcelain');
  assert.equal(existsSync(t.marker), false, 'fsmonitor снят флагом');
  const hook = trap();
  writeFileSync(join(r.dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch '${hook.marker}'\n`);
  chmodSync(join(r.dir, '.git', 'hooks', 'pre-commit'), 0o755);
  writeFileSync(join(r.dir, 'x.txt'), 'x');
  await git(r.dir, 'add', 'x.txt');
  await git(r.dir, 'commit', '-q', '-m', 'x');
  assert.equal(existsSync(hook.marker), false, 'hooks репозитория не исполнены');
});

test('GT06: обычные пути работают: дерево, его удаление и повторное создание, голый репозиторий, неизвестное дерево', async () => {
  const { r, wt } = await worktree();
  assert.equal(await git(wt, 'rev-parse', 'HEAD'), r.head());
  mkdirSync(join(wt, 'src'));
  assert.equal(await git(join(wt, 'src'), 'rev-parse', '--show-prefix'), 'src/');
  await git(r.dir, 'worktree', 'remove', '--force', wt);
  await git(r.dir, 'worktree', 'add', '--detach', wt, r.head());
  assert.equal(await git(wt, 'rev-parse', 'HEAD'), r.head());
  const bare = tmp('harness-git-bare-');
  raw(bare, 'init', '-q', '--bare');
  assert.equal(await git(bare, 'rev-parse', '--is-bare-repository'), 'true');
  resetGitTrust();
  assert.equal(await git(wt, 'rev-parse', 'HEAD'), r.head());
});
