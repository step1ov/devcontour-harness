/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-argument --
 * Тест читает JSON-ответ CLI как есть; его форму проверяет сам CLI схемой команды.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionPolicySchema, type GatePolicy } from '../src/contracts/index.ts';
import { redactor } from '../src/environment/redaction.ts';
import { inspectPolicy } from '../src/toolchains/index.ts';
import { runGate } from '../src/verification/gates.ts';

/**
 * Round 2 (F03, F04). Диагностика toolchain с настоящей пробой версий не
 * запускает исполняемые файлы проекта, как бы PATH на них ни указывал
 * (прямо, symlink файла, symlink каталога, worktree каталога состояния).
 * Защита от cache Turbo не обходится обёрткой в package script и действует
 * во время gate независимо от preflight.
 */
const policyOf = (repository: Record<string, unknown>) =>
  executionPolicySchema.parse({
    policyVersion: 1,
    repositories: [
      { id: 'app', path: 'repo', targetRef: 'refs/heads/harness/accepted', ...repository },
    ],
    roles: { developer: { writer: { runtime: 'claude' } } },
    review: {
      code: { reviewer: { runtime: 'codex' } },
      plan: { reviewer: { runtime: 'codex' } },
      contract: { reviewer: { runtime: 'codex' } },
    },
    isolation: { mode: 'none', domains: [] },
  });
const pnpmGate = {
  prepare: [{ id: 'install', command: ['pnpm', 'install', '--frozen-lockfile'] }],
  gates: [
    {
      id: 'unit',
      kind: 'test',
      command: ['pnpm', 'run', 'test'],
      report: { type: 'junit', path: '.reports/junit.xml' },
    },
  ],
};
const tree = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => {
      const p = join(e.parentPath, e.name);
      return `${p}:${e.isSymbolicLink() ? 'link' : statSync(p).mtimeMs}`;
    })
    .sort();

function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-tc-sec-')));
  const repo = join(dir, 'repo');
  const marks = join(dir, 'marks');
  mkdirSync(join(repo, 'tools'), { recursive: true });
  mkdirSync(marks);
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'app', packageManager: 'pnpm@10.12.3', scripts: { test: 'x' } }),
  );
  writeFileSync(join(repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  const evil = join(repo, 'tools', 'pnpm');
  writeFileSync(
    evil,
    `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(join(marks, 'DOCTOR_EXECUTED_PROJECT'))}\necho 10.12.3\n`,
  );
  chmodSync(evil, 0o755);
  // Положительный контроль: внешний инструмент с тем же поведением пробой запускается.
  const external = join(dir, 'external');
  mkdirSync(external);
  writeFileSync(
    join(external, 'pnpm'),
    `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(join(marks, 'EXTERNAL_PROBED'))}\necho 10.12.3\n`,
  );
  chmodSync(join(external, 'pnpm'), 0o755);
  return { dir, repo, marks, evil, external };
}

test('F03/T02: PATH, указывающий на код проекта (прямо, symlink файла, symlink каталога, worktree), не запускается пробой', async () => {
  const p = project();
  const state = join(p.dir, 'state');
  mkdirSync(join(state, 'repos/app/worktrees/a1/tools'), { recursive: true });
  const inWorktree = join(state, 'repos/app/worktrees/a1/tools/pnpm');
  writeFileSync(inWorktree, readFileSync(p.evil, 'utf8'));
  chmodSync(inWorktree, 0o755);
  const fileLink = join(p.dir, 'filelink');
  mkdirSync(fileLink);
  symlinkSync(p.evil, join(fileLink, 'pnpm'));
  const dirLink = join(p.dir, 'dirlink');
  symlinkSync(join(p.repo, 'tools'), dirLink);
  const stateLink = join(p.dir, 'statelink');
  mkdirSync(stateLink);
  symlinkSync(inWorktree, join(stateLink, 'pnpm'));

  const variants: [string, string, string[]][] = [
    ['прямо в репозиторий', join(p.repo, 'tools'), []],
    ['symlink файла снаружи', fileLink, []],
    ['symlink каталога PATH', dirLink, []],
    ['worktree каталога состояния', stateLink, [state]],
  ];
  for (const [name, PATH, protectedRoots] of variants) {
    const before = tree(p.dir);
    const [report] = await inspectPolicy(policyOf(pnpmGate), p.dir, {
      env: { PATH, HOME: p.dir },
      protectedRoots,
    });
    assert.ok(
      !existsSync(join(p.marks, 'DOCTOR_EXECUTED_PROJECT')),
      name + ': код проекта запущен',
    );
    assert.deepEqual(tree(p.dir), before, name + ': файлы изменились');
    const problem = report!.problems.find((x) => x.code === 'TOOL_IN_PROJECT');
    assert.ok(problem, name + ': ' + JSON.stringify(report!.problems));
    assert.deepEqual(problem.field, ['repositories', 0, 'prepare', 0, 'command']);
  }
  // Контроль: внешний инструмент пробой исполняется — отсутствие метки выше не случайность.
  const [control] = await inspectPolicy(policyOf(pnpmGate), p.dir, {
    env: { PATH: p.external, HOME: p.dir },
  });
  assert.ok(existsSync(join(p.marks, 'EXTERNAL_PROBED')));
  assert.deepEqual(control!.problems, []);
  assert.equal(control!.tools.find((t) => t.name === 'pnpm')!.version, '10.12.3');
});

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
test('F03/T02: run preflight и doctor через CLI не запускают проектный файл по symlink в PATH', () => {
  const p = project();
  const link = join(p.dir, 'filelink');
  mkdirSync(link);
  symlinkSync(p.evil, join(link, 'pnpm'));
  writeFileSync(join(p.dir, 'policy.json'), JSON.stringify(policyOf(pnpmGate)));
  writeFileSync(
    join(p.dir, 'graph.json'),
    JSON.stringify({
      apiVersion: 'devcontour-harness/v1alpha1',
      id: 'g',
      source: { connector: 'files', ref: 'graph.json', revision: '1' },
      orders: [
        {
          apiVersion: 'devcontour-harness/v1alpha1',
          id: 'w',
          source: { connector: 'files', ref: 'w', revision: '1' },
          title: 'Task',
          goal: 'Change something useful',
          acceptance: ['works'],
          role: 'developer',
          repositoryId: 'app',
          writeScope: ['src'],
          gates: ['unit'],
        },
      ],
    }),
  );
  const runtime = join(p.dir, 'runtime');
  writeFileSync(
    runtime,
    `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(join(p.marks, 'RUNTIME'))}\necho 1.0.0\n`,
  );
  chmodSync(runtime, 0o755);
  const harness = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd: p.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        PATH: link + ':' + dirname(process.execPath),
        HARNESS_CLAUDE_BIN: runtime,
        HARNESS_CODEX_BIN: runtime,
      },
    });
    return { status: r.status, json: JSON.parse(r.stdout) };
  };
  const state = join(p.dir, 'state');
  const run = harness('run', '--graph', 'graph.json', '--policy', 'policy.json', '--state', state);
  assert.equal(run.status, 3);
  assert.ok(
    run.json.error.issues.some((i: any) => /TOOL_IN_PROJECT/.test(i.message)),
    JSON.stringify(run.json.error),
  );
  assert.deepEqual(readdirSync(p.marks), [], 'ни проектный файл, ни runtime не запускались');
  assert.ok(!existsSync(state));
  const doc = harness('doctor', '--policy', 'policy.json');
  assert.equal(doc.status, 0);
  assert.ok(doc.json.data.problems.some((x: string) => /TOOL_IN_PROJECT/.test(x)));
  assert.ok(!existsSync(join(p.marks, 'DOCTOR_EXECUTED_PROJECT')));
});

function turboRepo(scripts: Record<string, string>, pkgScripts: Record<string, string> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-tc-turbo-')));
  const files: Record<string, string> = {
    'repo/package.json': JSON.stringify({
      name: 'mono',
      packageManager: 'pnpm@10.12.3',
      scripts,
      devDependencies: { turbo: '2.11.10' },
    }),
    'repo/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'repo/pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'repo/turbo.json': JSON.stringify({ tasks: { test: {} } }),
    'repo/packages/a/package.json': JSON.stringify({
      name: '@x/a',
      scripts: { test: 'node --test', ...pkgScripts },
    }),
    'bin/pnpm': '#!/bin/sh\necho 10.12.3\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  chmodSync(join(dir, 'bin/pnpm'), 0o755);
  return dir;
}
const wrapped = async (
  command: string[],
  scripts: Record<string, string>,
  pkg?: Record<string, string>,
) => {
  const dir = turboRepo(scripts, pkg);
  const [report] = await inspectPolicy(
    policyOf({
      gates: [
        {
          id: 'unit',
          kind: 'test',
          command,
          report: { type: 'junit', path: 'packages/a/.reports/junit.xml' },
        },
      ],
    }),
    dir,
    { env: { PATH: join(dir, 'bin'), HOME: dir } },
  );
  return report!.problems.map((p) => p.code);
};

test('F04/T03: turbo в package script (прямо, через другой script, через --filter) без --force — CACHE_REPLAY; неразбираемый script — SCRIPT_UNRESOLVED', async () => {
  const turbo = 'turbo run test --filter=@x/a';
  assert.deepEqual(await wrapped(['pnpm', 'run', 'acceptance'], { acceptance: turbo }), [
    'CACHE_REPLAY',
  ]);
  assert.deepEqual(await wrapped(['pnpm', 'acceptance'], { acceptance: turbo }), ['CACHE_REPLAY']);
  assert.deepEqual(
    await wrapped(['pnpm', 'run', 'ci'], { ci: 'pnpm run acceptance', acceptance: turbo }),
    ['CACHE_REPLAY'],
  );
  assert.deepEqual(
    await wrapped(['pnpm', 'run', 'ci'], { ci: 'pnpm --filter @x/a run t' }, { t: turbo }),
    ['CACHE_REPLAY'],
  );
  assert.deepEqual(
    await wrapped(['pnpm', 'run', 'acceptance'], { acceptance: 'pnpm exec ' + turbo }),
    ['CACHE_REPLAY'],
  );
  // Свежесть, выраженная в самом script, принимается.
  assert.deepEqual(
    await wrapped(['pnpm', 'run', 'acceptance'], { acceptance: turbo + ' --force' }),
    [],
  );
  assert.deepEqual(
    await wrapped(['pnpm', 'run', 'acceptance'], { acceptance: 'TURBO_FORCE=true ' + turbo }),
    [],
  );
  // Неразбираемая оболочка в turbo-проекте: доказать нельзя — отказ, а не догадка.
  for (const script of [`sh -c "${turbo}"`, '$(echo turbo) run test', `${turbo} | tee out.log`])
    assert.deepEqual(
      await wrapped(['pnpm', 'run', 'acceptance'], { acceptance: script }),
      ['SCRIPT_UNRESOLVED'],
      script,
    );
});

test('F04/T03: test gate исполняется с TURBO_FORCE=true и GOFLAGS …-count=1 при любой обёртке; check gate — без них', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-tc-fresh-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'],
    { cwd: dir },
  );
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const script = `const e=process.env;require('fs').writeFileSync(e.HARNESS_REPORT_PATH||'/dev/null','<testsuite><testcase classname="env" name="'+[e.TURBO_FORCE,e.GOFLAGS].join('|')+'"/></testsuite>');console.log('ENV',e.TURBO_FORCE,e.GOFLAGS)`;
  const seen: Record<string, string> = {};
  for (const kind of ['test', 'check'] as const) {
    const gate = {
      id: kind,
      kind,
      command: [process.execPath, '-e', script],
      timeoutMs: 20000,
      ...(kind === 'test' ? { report: { type: 'junit', path: '.reports/junit.xml' } } : {}),
    } as GatePolicy;
    const evidence = await runGate({
      policy: { isolation: { mode: 'none', domains: [] } },
      record: (e) => ({ ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() }),
      cwd: dir,
      sha,
      phase: 'candidate',
      gate,
      artifactDir: mkdtempSync(join(tmpdir(), 'harness-tc-art-')),
      signal: new AbortController().signal,
      execution: {
        env: { PATH: process.env.PATH, GOFLAGS: '-mod=readonly' },
        redact: redactor([]),
      },
      boundary: { hidden: [], readable: [] },
    });
    seen[kind] = readFileSync(evidence.log, 'utf8');
    if (kind === 'test')
      assert.deepEqual(evidence.tests, [
        { id: 'env.true|-mod=readonly -count=1', status: 'passed' },
      ]);
  }
  assert.match(
    seen.test!,
    /^# harness gate test: .* fresh=\{"TURBO_FORCE":"true","GOFLAGS":"-mod=readonly -count=1"\}$/m,
  );
  assert.match(seen.check!, /ENV undefined -mod=readonly/);
});
