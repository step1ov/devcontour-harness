import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectFactsSchema, type ProjectFacts } from '../src/contracts/index.ts';
import { inspectProject } from '../src/init/inspect.ts';
import { planProject } from '../src/init/project.ts';
import type { ToolProbe } from '../src/toolchains/probe.ts';

const fixture = fileURLToPath(new URL('./fixtures/standalone/npm-app', import.meta.url));
const which = (name: string) => execFileSync('which', [name], { encoding: 'utf8' }).trim();

/** Ответы проб по имени исполняемого файла; argv каждой пробы записывается. */
function recordingProbe(answers: Record<string, string | null> = {}) {
  const calls: string[][] = [];
  const defaults: Record<string, string | null> = {
    git: 'git version 2.50.1',
    node: 'v24.3.0',
    npm: '11.4.2',
    pnpm: '10.12.3',
    claude: '2.0.14 (Claude Code)',
    codex: 'codex-cli 0.50.0',
  };
  const probe: ToolProbe = (argv) => {
    calls.push(argv);
    const answer = { ...defaults, ...answers }[basename(argv[0]!)];
    return Promise.resolve(
      answer === null || answer === undefined
        ? { code: 1, stdout: '', stderr: 'broken', timedOut: false }
        : { code: 0, stdout: answer + '\n', stderr: '', timedOut: false },
    );
  };
  return { probe, calls };
}

/**
 * Изолированный PATH: git, node и менеджеры — ссылками на настоящие, runtime —
 * только названные заглушки. Чужие claude/codex из PATH машины не видны.
 */
function binDir(scratch: string, runtimes: string[]) {
  const bin = join(scratch, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['git', 'node', 'npm']) symlinkSync(which(name), join(bin, name));
  for (const name of ['pnpm', ...runtimes]) {
    writeFileSync(join(bin, name), '#!/bin/sh\necho stub\n');
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

function project(
  edit?: (dir: string) => void,
  options: { commit?: boolean; runtimes?: string[] } = {},
) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-inspect-')));
  const root = join(scratch, 'app');
  cpSync(fixture, root, { recursive: true });
  edit?.(root);
  const bin = binDir(scratch, options.runtimes ?? ['claude', 'codex']);
  const env = {
    ...process.env,
    PATH: bin,
    HARNESS_STATE_HOME: join(scratch, 'state-home'),
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env }).trim();
  git('init', '-q', '-b', 'main');
  if (options.commit !== false) {
    git('add', '-A');
    git('commit', '-qm', 'init');
  }
  return { scratch, root, env, git };
}

type Pkg = { scripts?: Record<string, string>; packageManager?: string };
const readPkg = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Pkg;

const codes = (facts: ProjectFacts) => facts.diagnostics.map((d) => d.code).sort();
const pnpm = (dir: string) => {
  rmSync(join(dir, 'package-lock.json'));
  writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
};

/** Каждый файл дерева, включая .git, с содержимым и mtime: инспекция ничего не пишет. */
function snapshot(root: string) {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path, r);
      else
        out[r] =
          createHash('sha256').update(readFileSync(path)).digest('hex') +
          ':' +
          statSync(path).mtimeMs;
    }
  };
  walk(root, '');
  return out;
}

test('H01-A: npm fixture — воспроизводимые факты без проблем', async () => {
  const p = project();
  const { probe } = recordingProbe();
  const first = await inspectProject({ repository: p.root, env: p.env, probe });
  const second = await inspectProject({ repository: p.root, env: p.env, probe });
  assert.deepEqual(first, second);
  projectFactsSchema.parse(first);
  assert.equal(first.ready, true, JSON.stringify(first.diagnostics));
  assert.deepEqual(first.diagnostics, []);
  assert.equal(first.git.root, p.root);
  assert.equal(first.git.worktree, 'main');
  assert.equal(first.git.baseSha, p.git('rev-parse', 'HEAD'));
  assert.equal(first.git.branch, 'main');
  assert.equal(first.git.dirty, false);
  assert.deepEqual(first.git.changes, []);
  assert.deepEqual(first.lockfiles, ['package-lock.json']);
  assert.deepEqual(first.packageManager, {
    status: 'detected',
    name: 'npm',
    lockfile: 'package-lock.json',
  });
  assert.deepEqual(
    first.profiles.map((x) => x.id),
    ['npm-ci'],
  );
  assert.match(first.profiles[0]!.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.checks, ['check', 'test']);
  assert.deepEqual(
    first.tools.map((t) => [t.name, t.status]),
    [
      ['git', 'ok'],
      ['node', 'ok'],
      ['npm', 'ok'],
    ],
  );
  assert.deepEqual(first.tools[2]!.required, { version: '11.4.2', source: 'profile npm-ci@0.1.0' });
  assert.deepEqual(first.markers, { devcontour: [], harnessProject: false });
});

test('H01-A: pnpm fixture — профиль pnpm-frozen и версия из packageManager', async () => {
  const p = project((dir) => {
    pnpm(dir);
    const pkg = readPkg(dir);
    pkg.packageManager = 'pnpm@10.12.3';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  });
  const facts = await inspectProject({
    repository: p.root,
    env: p.env,
    probe: recordingProbe().probe,
  });
  assert.equal(facts.ready, true, JSON.stringify(facts.diagnostics));
  assert.deepEqual(facts.packageManager, {
    status: 'detected',
    name: 'pnpm',
    lockfile: 'pnpm-lock.yaml',
    declared: { name: 'pnpm', version: '10.12.3' },
  });
  assert.deepEqual(
    facts.profiles.map((x) => x.id),
    ['pnpm-frozen'],
  );
  const tool = facts.tools.find((t) => t.name === 'pnpm')!;
  assert.deepEqual(tool, {
    name: 'pnpm',
    status: 'ok',
    version: '10.12.3',
    required: { version: '10.12.3', source: 'package.json#packageManager' },
  });
});

test('H01-A: два lockfile, нет профиля, worktree, нет коммита, подкаталог — разные причины', async () => {
  const { probe } = recordingProbe();
  const both = project((dir) =>
    writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n"),
  );
  const ambiguous = await inspectProject({ repository: both.root, env: both.env, probe });
  assert.deepEqual(codes(ambiguous), ['stack-ambiguous']);
  assert.equal(ambiguous.ready, false);
  assert.equal(ambiguous.packageManager.status, 'ambiguous');
  assert.deepEqual(
    ambiguous.profiles.map((x) => x.id),
    ['npm-ci', 'pnpm-frozen'],
  );

  const none = project((dir) => {
    rmSync(join(dir, 'package-lock.json'));
    writeFileSync(join(dir, 'yarn.lock'), '');
  });
  const unsupported = await inspectProject({ repository: none.root, env: none.env, probe });
  assert.deepEqual(codes(unsupported), ['stack-unsupported']);
  assert.deepEqual(unsupported.lockfiles, ['yarn.lock']);
  assert.deepEqual(unsupported.profiles, []);

  const main = project();
  const linked = join(main.scratch, 'linked');
  main.git('worktree', 'add', '-q', '-b', 'side', linked);
  const worktree = await inspectProject({ repository: linked, env: main.env, probe });
  assert.deepEqual(codes(worktree), ['git-worktree']);
  assert.equal(worktree.git.worktree, 'linked');

  const empty = project(undefined, { commit: false });
  const noCommits = await inspectProject({ repository: empty.root, env: empty.env, probe });
  assert.deepEqual(codes(noCommits), ['no-commits']);
  assert.equal(noCommits.git.baseSha, null);

  const inside = await inspectProject({ repository: join(main.root, 'src'), env: main.env, probe });
  assert.deepEqual(codes(inside), ['inside-repository']);
  assert.equal(inside.git.root, main.root);

  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'harness-inspect-plain-')));
  const notGit = await inspectProject({ repository: plain, env: main.env, probe });
  assert.deepEqual(codes(notGit), ['not-git-repository']);
  const missing = await inspectProject({ repository: join(plain, 'nope'), env: main.env, probe });
  assert.deepEqual(codes(missing), ['path-missing']);
  for (const facts of [ambiguous, unsupported, worktree, noCommits, inside, notGit, missing])
    for (const d of facts.diagnostics) assert.ok(d.message && d.action, d.code);
});

test('H01-B: инспекция не меняет файлы, refs и индекс и не создаёт state', async () => {
  const p = project((dir) => writeFileSync(join(dir, 'devcontour.config.json'), '{}\n'));
  writeFileSync(join(p.root, 'untracked.txt'), 'x\n');
  mkdirSync(join(p.root, 'notes'));
  writeFileSync(join(p.root, 'notes', 'draft.md'), 'x\n');
  // Индекс устарел относительно файла: обычный `git status` переписал бы его.
  writeFileSync(join(p.root, 'src', 'greet.js'), readFileSync(join(p.root, 'src', 'greet.js')));
  const before = snapshot(p.root);
  const facts = await inspectProject({
    repository: p.root,
    env: p.env,
    probe: recordingProbe().probe,
  });
  assert.deepEqual(snapshot(p.root), before);
  assert.equal(existsSync(join(p.root, '.harness')), false);
  assert.equal(existsSync(join(p.scratch, 'state-home')), false);
  assert.deepEqual(facts.markers.devcontour, ['devcontour.config.json']);
  assert.ok(codes(facts).includes('devcontour-owned'));
  assert.equal(facts.diagnostics.find((d) => d.code === 'devcontour-owned')!.severity, 'info');
  assert.equal(facts.git.dirty, true);
  // Новый каталог раскрывается до файлов: хост отличает свои записи от чужих.
  assert.deepEqual(facts.git.changes, ['notes/draft.md', 'untracked.txt']);
  assert.ok(codes(facts).includes('dirty-checkout'));
});

test('H01-C: init --plan и inspectProject видят один корень и один профиль', async () => {
  const p = project();
  const { probe } = recordingProbe();
  const facts = await inspectProject({ repository: p.root, env: p.env, probe });
  const planned = await planProject({ repository: p.root, env: p.env, probe, plan: true });
  assert.equal(planned.root, facts.git.root);
  assert.deepEqual(planned.profile, facts.profiles[0]);
  assert.equal(existsSync(join(p.root, '.harness')), false);
});

test('H01-D: нет CLI, сбой --version и неизвестная авторизация различимы; scripts не исполняются', async () => {
  const marker = (dir: string) => join(dir, 'ran');
  const p = project(
    (dir) => {
      const pkg = readPkg(dir);
      const touch = `node -e "require('fs').writeFileSync('${marker(dir)}','')"`;
      pkg.scripts = { ...pkg.scripts, preinstall: touch, prepare: touch, pretest: touch };
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    },
    { runtimes: ['codex'] },
  );
  const { probe, calls } = recordingProbe({ codex: null });
  const facts = await inspectProject({ repository: p.root, env: p.env, probe });
  assert.deepEqual(facts.runtimes, [
    { runtime: 'claude', status: 'missing', auth: 'unknown' },
    { runtime: 'codex', status: 'version-error', auth: 'unknown' },
  ]);
  assert.deepEqual(
    facts.diagnostics.map((d) => [d.code, d.severity]),
    [
      ['runtime-missing', 'warning'],
      ['runtime-version-error', 'warning'],
    ],
  );
  const available = await inspectProject({
    repository: p.root,
    env: p.env,
    probe: recordingProbe().probe,
    runtimes: ['codex'],
  });
  assert.deepEqual(available.runtimes, [
    { runtime: 'codex', status: 'available', version: '0.50.0', auth: 'unknown' },
  ]);
  // Единственные процессы — пробы `--version`; npm scripts не запускались.
  for (const argv of calls) assert.deepEqual(argv.slice(1), ['--version']);
  assert.equal(existsSync(marker(p.root)), false);
});

test('H01-D: отсутствующий менеджер и несовпадение версии — разные причины', async () => {
  const p = project();
  rmSync(join(p.scratch, 'bin', 'npm'));
  const missing = await inspectProject({
    repository: p.root,
    env: p.env,
    probe: recordingProbe().probe,
  });
  assert.ok(codes(missing).includes('tool-missing'));
  assert.equal(missing.ready, false);
  symlinkSync(which('npm'), join(p.scratch, 'bin', 'npm'));
  const old = await inspectProject({
    repository: p.root,
    env: p.env,
    probe: recordingProbe({ npm: '10.9.0' }).probe,
  });
  assert.deepEqual(codes(old), ['tool-version-mismatch']);
  assert.equal(old.ready, true);
});
