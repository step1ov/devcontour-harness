import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionPolicySchema, type EvidenceRecord } from '../src/contracts/index.ts';
import { executionEnvironment } from '../src/environment/lifecycle.ts';
import { ToolchainPinError, pinnedPath, resolveNodePin } from '../src/environment/toolchain-pin.ts';
import { runGatesAt, type GatesAtContext } from '../src/verification/gates-at.ts';
import { doctor } from '../src/control/doctor.ts';
import { planProject } from '../src/init/project.ts';
import type { ToolProbe } from '../src/toolchains/probe.ts';
import { greet, implement, approve, runAll, setup } from './runner-fixture.ts';
import { write } from './git-fixture.ts';

/**
 * Домашний каталог с установленным через nvm «node» `version`: обёртка
 * отвечает на `-v` своей версией, остальное передаёт настоящему node и
 * записывает вызов в `calls.log` (так видно, что процесс нашёл её в PATH).
 */
function fakeHome(version = '99.1.2') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'harness-pin-home-')));
  const bin = join(home, '.nvm', 'versions', 'node', 'v' + version, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(home, 'calls.log');
  writeFileSync(
    join(bin, 'node'),
    `#!/bin/sh\nif [ "$1" = "-v" ]; then echo v${version}; exit 0; fi\necho "$*" >> '${log}'\nexec '${process.execPath}' "$@"\n`,
  );
  chmodSync(join(bin, 'node'), 0o755);
  return { home, bin, log, env: { ...process.env, HOME: home, NVM_DIR: join(home, '.nvm') } };
}

/** Gate, который печатает версию node из PATH и сам PATH. */
const nodeGate = {
  id: 'node-version',
  kind: 'check',
  command: ['/bin/sh', '-c', 'node -v; echo "PATH=$PATH"'],
};

test('toolchain pin: версия разрешается в каталог nvm и ставится первой в PATH окружения фазы', () => {
  const f = fakeHome();
  const r = resolveNodePin({ node: '99.1' }, f.env);
  assert.equal(r.binDir, f.bin);
  assert.equal(r.version, '99.1.2');
  const env = executionEnvironment(
    [],
    {},
    { ...f.env, PATH: `/usr/bin${delimiter}${f.bin}` },
    {
      node: '99',
    },
  );
  assert.equal(env.env.PATH!.split(delimiter)[0], f.bin, 'закреплённый каталог первым');
  assert.equal(env.env.PATH!.split(delimiter).filter((d) => d === f.bin).length, 1);
  assert.equal(pinnedPath('/a:/b', '/b'), '/b:/a');
  // Абсолютный каталог — как есть.
  assert.equal(resolveNodePin({ node: f.bin }, f.env).version, '99.1.2');
  assert.throws(
    () => executionEnvironment([], {}, f.env, { node: '98.7.6' }),
    (e: unknown) =>
      e instanceof ToolchainPinError && /policy\.toolchain\.node=98\.7\.6/.test(e.message),
  );
  assert.throws(
    () => executionEnvironment([], {}, f.env, { node: join(f.home, 'missing') }),
    ToolchainPinError,
  );
  assert.throws(() => executionPolicySchema.shape.toolchain.parse({ node: 'latest' }));
});

test('toolchain pin: gate и writer попытки получают закреплённый node, заголовок лога и evidence называют toolchain', async () => {
  const f = fakeHome();
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      p.toolchain = { node: '99.1.2' };
      (p.repositories as { gates: unknown[] }[])[0]!.gates.push(nodeGate);
    },
    graph: (g) => (g.orders as { gates: string[] }[])[0]!.gates.push('node-version'),
    runner: { environment: f.env },
  });
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work(ctx.graph.orders[0]!.id)!);
  assert.equal(work.status, 'done', work.failure ?? '');
  const evidence = ctx.engine
    .read((v) => v.attempts(work.id))
    .flatMap((a) => a.evidence)
    .filter((e) => e.gate === 'node-version');
  assert.ok(evidence.length >= 1);
  for (const e of evidence) {
    const log = readFileSync(e.log, 'utf8');
    assert.match(log, /^# toolchain: node v99\.1\.2 \(/m, log);
    assert.match(log, /^v99\.1\.2$/m, 'node -v внутри gate — закреплённый');
    assert.match(log, new RegExp(`^PATH=${f.bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
    assert.equal(e.toolchain?.node?.version, '99.1.2');
    assert.equal(e.toolchain?.node?.path, join(f.bin, 'node'));
  }
  // Writer (fake runtime с `#!/usr/bin/env node`) нашёл node в закреплённом каталоге.
  assert.match(readFileSync(f.log, 'utf8'), /fake-(claude|codex)/);
});

test('toolchain pin: harness gates (gates-at) исполняется с тем же PATH, что попытка', async () => {
  const f = fakeHome();
  const ctx = setup({
    scenario: {},
    policy: (p) => {
      p.toolchain = { node: '99' };
      (p.repositories as { gates: unknown[] }[])[0]!.gates.push(nodeGate);
    },
  });
  write(ctx.repo.dir, { 'src/greet.js': greet });
  ctx.repo.git('add', '-A');
  ctx.repo.git('commit', '-q', '-m', 'greet');
  const context: GatesAtContext = {
    policy: ctx.policy,
    stateDir: ctx.state,
    repoPath: () => ctx.repo.dir,
    boundary: () => ({ hidden: [ctx.state], readable: [join(ctx.repo.dir, '.git')] }),
    resourceDatabase: join(ctx.state, 'resources.sqlite'),
    // Оболочка вызывающего с другим node первым в PATH: закрепление сильнее.
    environment: { ...f.env, PATH: `/usr/bin${delimiter}${process.env.PATH}` },
  };
  const recorded: EvidenceRecord[] = [];
  const result = await runGatesAt(context, {
    id: 'GA-pin',
    repositoryId: 'app',
    sha: ctx.repo.head(),
    gates: ['node-version'],
    record: (e) => recorded.push(e),
  });
  assert.equal(result.failure, undefined);
  const e = recorded.find((x) => x.gate === 'node-version')!;
  assert.equal(e.toolchain?.node?.version, '99.1.2');
  assert.match(readFileSync(e.log, 'utf8'), /^v99\.1\.2$/m);
});

test('toolchain pin: незакреплённый в системе node — отказ окружения до работы, попытка не засчитана', async () => {
  const f = fakeHome();
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      p.toolchain = { node: '98.7.6' };
    },
    runner: { environment: f.env },
  });
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work(ctx.graph.orders[0]!.id)!);
  const attempts = ctx.engine.read((v) => v.attempts(work.id));
  assert.ok(attempts.length >= 1);
  for (const a of attempts) {
    assert.equal(a.failureKind, 'environment', a.error ?? '');
    assert.match(a.error ?? '', /policy\.toolchain\.node=98\.7\.6/);
  }
  assert.equal(work.attempt, 0, 'ни одна попытка не засчитана');
  // Причина — сам закреплённый toolchain, а не общий отказ до работы.
  const causes = ctx.store
    .events()
    .filter((e) => e.type === 'attempt.diagnosed')
    .map((e) => (e.payload as { cause: string }).cause);
  assert.ok(causes.length >= 1);
  assert.ok(
    causes.every((c) => c === 'toolchain'),
    causes.join(),
  );
  assert.ok(
    !existsSync(f.log) || !/fake-/.test(readFileSync(f.log, 'utf8')),
    'writer не вызывался',
  );
});

test('P2-10: дефект под другим node, чем успешный прогон того же gate, — засчитанный провал gate с заметкой о node', async () => {
  const ctx = setup({
    scenario: {
      writer: implement({ 'src/greet.js': "exports.greet = () => 'broken';\n" }),
      reviewer: approve(),
    },
    policy: (p) => {
      p.maxAttempts = 2;
    },
  });
  // Итог `harness gates` на базе: unit прошёл под другим node.
  const ga = join(ctx.state, 'gates-at', 'GA-base');
  mkdirSync(ga, { recursive: true });
  writeFileSync(
    join(ga, 'result.json'),
    JSON.stringify({
      at: new Date(Date.now() - 60_000).toISOString(),
      data: {
        id: 'GA-base',
        repositoryId: 'app',
        sha: ctx.repo.head(),
        passed: true,
        gates: [
          {
            gate: 'unit',
            status: 'passed',
            toolchain: { node: { version: '1.2.3', path: '/opt/other-node/bin/node' } },
          },
        ],
      },
    }),
  );
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work(ctx.graph.orders[0]!.id)!);
  const attempts = ctx.engine.read((v) => v.attempts(work.id));
  assert.ok(attempts.length >= 1);
  const first = attempts[0]!;
  // Настоящий дефект остаётся дефектом: класс gate, попытка засчитана.
  assert.equal(first.failureKind, 'gate', first.error ?? '');
  const note =
    /node v\S+ \(.+\) отличается от последнего успешного прогона этого gate в harness gates GA-base[^:]*: v1\.2\.3 \(\/opt\/other-node\/bin\/node\); закрепите policy\.toolchain\.node/;
  assert.match(first.error ?? '', note);
  const failed = first.evidence.find((e) => e.gate === 'unit' && !e.passed)!;
  assert.match(failed.summary ?? '', note);
  assert.match(readFileSync(failed.log, 'utf8'), note);
  const diagnosed = ctx.store
    .events()
    .filter((e) => e.type === 'attempt.diagnosed')
    .map((e) => e.payload as { cause: string; counted: boolean });
  assert.equal(diagnosed[0]?.cause, 'none');
  assert.equal(diagnosed[0]?.counted, true);
  assert.ok(work.attempt >= 1, 'провал засчитан');
});

test('P2-10: провал под тем же node, что успешный запуск на базе, — по-прежнему дефект (gate)', async () => {
  const ctx = setup({
    scenario: {
      writer: implement({ 'src/greet.js': "exports.greet = () => 'broken';\n" }),
      reviewer: approve(),
    },
    policy: (p) => {
      p.maxAttempts = 1;
    },
  });
  const ga = join(ctx.state, 'gates-at', 'GA-base');
  mkdirSync(ga, { recursive: true });
  const node = execFileSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(ga, 'result.json'),
    JSON.stringify({
      at: new Date().toISOString(),
      data: {
        id: 'GA-base',
        repositoryId: 'app',
        sha: ctx.repo.head(),
        gates: [
          {
            gate: 'unit',
            status: 'passed',
            toolchain: { node: { version: process.version.slice(1), path: node } },
          },
        ],
      },
    }),
  );
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work(ctx.graph.orders[0]!.id)!);
  const first = ctx.engine.read((v) => v.attempts(work.id))[0]!;
  assert.equal(first.failureKind, 'gate', first.error ?? '');
  assert.doesNotMatch(first.error ?? '', /отличается от последнего успешного прогона/);
});

test('doctor: node первым в PATH отличается от закреплённого — предупреждение и разрешённое закрепление', async () => {
  const f = fakeHome();
  const ctx = setup({ scenario: {}, policy: (p) => (p.toolchain = { node: '99.1.2' }) });
  const report = await doctor(ctx.policy, {}, undefined, undefined, undefined, {
    resourceDatabase: false,
    environment: f.env,
  });
  assert.equal(report.toolchainPin?.binDir, f.bin);
  assert.equal(report.toolchainPin?.version, '99.1.2');
  assert.equal(report.toolchainPin?.matches, false);
  assert.ok(
    report.warnings?.some((w) =>
      /^toolchain-pin: node первым в PATH .* отличается от закреплённого/.test(w),
    ),
    JSON.stringify(report.warnings),
  );
  // Тот же node первым в PATH — без предупреждения.
  const same = await doctor(ctx.policy, {}, undefined, undefined, undefined, {
    resourceDatabase: false,
    environment: { ...f.env, PATH: f.bin + delimiter + process.env.PATH },
  });
  assert.equal(same.toolchainPin?.matches, true);
  assert.ok(!same.warnings?.some((w) => w.startsWith('toolchain-pin')));
  // Незакреплённый в системе — проблема; без закрепления — совет в notes.
  const missing = await doctor(
    executionPolicySchema.parse({ ...ctx.policy, toolchain: { node: '98.7.6' } }),
    {},
    undefined,
    undefined,
    undefined,
    { resourceDatabase: false, environment: f.env },
  );
  assert.ok(missing.problems.some((p) => /^toolchain-pin: .*98\.7\.6/.test(p)));
  const none = await doctor(
    executionPolicySchema.parse({ ...ctx.policy, toolchain: undefined }),
    {},
    undefined,
    undefined,
    undefined,
    { resourceDatabase: false, environment: f.env },
  );
  assert.ok(none.notes?.some((n) => /^toolchain-pin: node не закреплён/.test(n)));
});

test('init: предлагает policy.toolchain.node — версию .nvmrc, если она установлена, иначе node, запустивший init', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/standalone/npm-app', import.meta.url));
  const probe: ToolProbe = (argv) =>
    Promise.resolve({
      code: 0,
      stdout: argv.some((a) => /(^|\/)npm(-cli\.js)?$/.test(a)) ? '11.4.2\n' : 'v24.3.0\n',
      stderr: '',
      timedOut: false,
    });
  const make = (nvmrc?: string) => {
    const f = fakeHome();
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-pin-init-')));
    const root = join(scratch, 'app');
    cpSync(fixture, root, { recursive: true });
    if (nvmrc) writeFileSync(join(root, '.nvmrc'), nvmrc);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-qm', 'init');
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    for (const r of ['claude', 'codex']) {
      writeFileSync(join(bin, r), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, r), 0o755);
    }
    const env: NodeJS.ProcessEnv = {
      ...f.env,
      HARNESS_STATE_HOME: join(scratch, 'state-home'),
      HARNESS_CLAUDE_BIN: join(bin, 'claude'),
      HARNESS_CODEX_BIN: join(bin, 'codex'),
      CLAUDECODE: '1',
    };
    delete env.CODEX_THREAD_ID;
    return { root, env };
  };
  const a = make('v99.1.2\n');
  const planned = await planProject({ repository: a.root, env: a.env, probe });
  assert.deepEqual(planned.policy.toolchain, { node: '99.1.2' });
  assert.deepEqual(planned.toolchainPin, { node: '99.1.2', version: '99.1.2', source: '.nvmrc' });
  const b = make('v97.0.0\n');
  const fallback = await planProject({ repository: b.root, env: b.env, probe });
  const current = process.version.slice(1);
  assert.deepEqual(fallback.policy.toolchain, { node: current });
  assert.equal(fallback.toolchainPin?.source, 'node, запустивший init');
});
