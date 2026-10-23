/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call --
 * Тест читает JSON-ответ CLI как есть; его форму проверяет сам CLI схемой команды.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitCodes, initDataSchema } from '../src/contracts/index.ts';
import { initProject } from '../src/init/project.ts';

/**
 * `harness init` через настоящий CLI: exit codes, конверт, `--plan` и
 * `--human`; npm — установленный (версия закреплена `packageManager`).
 */
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/standalone/npm-app', import.meta.url));
const npm = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();

function project(edit?: (dir: string) => void) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-cli-init-')));
  const root = join(scratch, 'app');
  cpSync(fixture, root, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  pkg.packageManager = 'npm@' + npm;
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  edit?.(root);
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    HARNESS_STATE_HOME: join(scratch, 'state-home'),
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const harness = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd: scratch,
      encoding: 'utf8',
      env,
    });
    let json: any;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = undefined;
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  return { scratch, root, git, env, harness };
}

/** sha256 всех файлов вне `.git` и `.harness` плюс git status без `.harness/`. */
function outside(root: string) {
  const files: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (r === '.git' || r === '.harness') continue;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else
        files[r] = createHash('sha256')
          .update(readFileSync(join(dir, e.name)))
          .digest('hex');
    }
  };
  walk(root, '');
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((l) => l && !l.startsWith('?? .harness'));
  return { files, status };
}

test('H1-02: init --plan → exit 0 без записи; init → created; повтор → created пуст; данные CLI = библиотеки', async () => {
  const p = project();
  const before = outside(p.root);
  const plan = p.harness('init', '--repository', p.root, '--plan');
  assert.equal(plan.status, exitCodes.ok, plan.stderr + plan.stdout);
  assert.equal(plan.json.ok, true);
  assert.equal(plan.json.command, 'init');
  initDataSchema.parse(plan.json.data);
  assert.equal(plan.json.data.mode, 'plan');
  assert.equal(existsSync(join(p.root, '.harness')), false);
  // Одна реализация: данные CLI равны данным библиотеки на том же входе.
  const lib = await initProject({ repository: p.root, env: p.env, plan: true });
  assert.deepEqual(plan.json.data, JSON.parse(JSON.stringify(lib)));

  const init = p.harness('init', '--repository', p.root);
  assert.equal(init.status, exitCodes.ok, init.stderr + init.stdout);
  assert.equal(init.json.data.created.length, 4);
  assert.ok(init.json.data.created.at(-1).endsWith('/.harness/project.json'));
  const again = p.harness('init', '--repository', p.root);
  assert.equal(again.status, exitCodes.ok);
  assert.deepEqual(again.json.data.created, []);
  assert.equal(again.json.data.projectId, init.json.data.projectId);
  assert.equal(again.json.data.manifest.paths.state, init.json.data.manifest.paths.state);
  assert.deepEqual(outside(p.root), before);
});

test('H1-02: --human — текст на stdout, exit тот же; отказ — JSON-конверт', () => {
  const p = project();
  const human = p.harness('init', '--repository', p.root, '--plan', '--human');
  assert.equal(human.status, exitCodes.ok, human.stderr);
  assert.equal(human.json, undefined, 'успех при --human — не JSON');
  assert.match(human.stdout, /^init plan: new p-[0-9a-f]{16}\n/);
  assert.match(human.stdout, /\ncreate .*\/\.harness\/project\.json\n/);
  assert.match(human.stdout, /\n {2}harness run --graph /);
  mkdirSync(join(p.root, '.devcontour-local'));
  const refused = p.harness('init', '--repository', p.root, '--human');
  assert.equal(refused.status, exitCodes.refused);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.error.code, 'CONTROLLER_BUSY');
});

test('H1-02: конфликт плана — --plan даёт данные с exit 3, apply — PATH_CONFLICT exit 3', () => {
  const p = project();
  const outsideDir = join(p.scratch, 'elsewhere');
  mkdirSync(outsideDir);
  symlinkSync(outsideDir, join(p.root, '.harness'));
  const plan = p.harness('init', '--repository', p.root, '--plan');
  assert.equal(plan.status, exitCodes.refused, plan.stderr);
  assert.equal(plan.json.ok, true);
  assert.equal(plan.json.data.conflicts, 4);
  const apply = p.harness('init', '--repository', p.root);
  assert.equal(apply.status, exitCodes.refused);
  assert.equal(apply.json.error.code, 'PATH_CONFLICT');
  assert.deepEqual(apply.json.error.issues[0], {
    path: [join(p.root, '.harness')],
    message: 'symlink',
  });
  assert.deepEqual(readdirSync(outsideDir), []);
});

test('H1-02: иной --writer → PATH_CONFLICT content-differs на project.json', () => {
  const p = project();
  assert.equal(p.harness('init', '--repository', p.root).status, exitCodes.ok);
  const manifest = readFileSync(join(p.root, '.harness/project.json'), 'utf8');
  const other = p.harness('init', '--repository', p.root, '--writer', 'codex');
  assert.equal(other.status, exitCodes.refused);
  assert.equal(other.json.error.code, 'PATH_CONFLICT');
  assert.deepEqual(other.json.error.issues, [
    { path: [join(p.root, '.harness/project.json')], message: 'content-differs' },
  ]);
  assert.equal(readFileSync(join(p.root, '.harness/project.json'), 'utf8'), manifest);
  const bad = p.harness('init', '--repository', p.root, '--writer', 'fixture');
  assert.equal(bad.status, exitCodes.input);
});

test('H1-02: нет script → --plan exit 3 с данными, apply NOT_READY exit 3', () => {
  const p = project((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    delete pkg.scripts.test;
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  });
  const plan = p.harness('init', '--repository', p.root, '--plan');
  assert.equal(plan.status, exitCodes.refused);
  assert.equal(plan.json.data.toolchain.ready, false);
  const apply = p.harness('init', '--repository', p.root);
  assert.equal(apply.status, exitCodes.refused);
  assert.equal(apply.json.error.code, 'NOT_READY');
  assert.equal(existsSync(join(p.root, '.harness')), false);
});

test('H1-02: вход — не корень Git, state внутри, неоднозначный стек; --plan у чужой команды', () => {
  const p = project((dir) => writeFileSync(join(dir, 'pnpm-lock.yaml'), 'x: 1\n'));
  const sub = p.harness('init', '--repository', join(p.root, 'src'));
  assert.equal(sub.status, exitCodes.input);
  assert.deepEqual(sub.json.error.issues, [{ path: ['--repository'], message: 'not-git-root' }]);
  const missing = p.harness('init');
  assert.equal(missing.status, exitCodes.input);
  const ambiguous = p.harness('init', '--repository', p.root);
  assert.equal(ambiguous.status, exitCodes.refused);
  assert.equal(ambiguous.json.error.code, 'NOT_READY');
  assert.deepEqual(ambiguous.json.error.issues, [
    { path: ['--profile'], message: 'stack-ambiguous' },
  ]);
  const inside = p.harness(
    'init',
    '--repository',
    p.root,
    '--profile',
    'npm-ci',
    '--state',
    join(p.root, 'state'),
  );
  assert.equal(inside.status, exitCodes.input);
  assert.deepEqual(inside.json.error.issues, [
    { path: ['--state'], message: 'state-inside-repository' },
  ]);
  const foreign = p.harness('status', '--state', p.scratch, '--plan');
  assert.equal(foreign.status, exitCodes.input);
  assert.equal(existsSync(join(p.root, '.harness')), false);
});
