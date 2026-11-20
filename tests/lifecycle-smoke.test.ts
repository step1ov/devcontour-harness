/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call --
   Политика fixture правится как сырой JSON до разбора схемой. */
/**
 * `harness smoke` и preflight окружения перед `run`: lifecycle, `prepare` и
 * teardown проекта без gates и без моделей — замер каждого шага, класс отказа
 * (crash, missing-tool, timeout, cleanup, port-busy, tree-changed) и совет;
 * кэш успеха по (дерево базы, digest политики); отказ preflight останавливает
 * `run` до ревью плана и первой попытки.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HarnessError,
  TaskFailure,
  cliDataSchemas,
  cliErrorSchema,
  executionDigest,
  executionPolicySchema,
  type ExecutionPolicy,
} from '../src/contracts/index.ts';
import { classifyLifecycleFailure, smokeLifecycle } from '../src/control/lifecycle-smoke.ts';
import { CleanupFailure } from '../src/environment/lifecycle.ts';
import { lifecyclePreflight } from '../src/control/preflight.ts';
import { example } from './fixtures.ts';
import { repo } from './git-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** Шаг, отмечающий запуск в `marks/<id>` и завершающийся кодом `code`. */
const mark = (marks: string, id: string, code = 0, extra = '') => ({
  id,
  command: [
    process.execPath,
    '-e',
    `const fs=require('fs');fs.mkdirSync(${JSON.stringify(marks)},{recursive:true});` +
      `fs.appendFileSync(${JSON.stringify(join(marks, 'order'))},${JSON.stringify(id + '\n')});` +
      `${extra}process.exit(${code})`,
  ],
  timeoutMs: 20000,
});

type Steps = {
  setup?: unknown[];
  ready?: unknown[];
  teardown?: unknown[];
  prepare?: unknown[];
};

function fixture(steps: (marks: string) => Steps = () => ({}), tune?: (p: any) => void) {
  const r = repo({ 'README.md': 'app\n' });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-smoke-')));
  const marks = join(root, 'marks');
  const state = join(root, 'state');
  const raw = structuredClone(example('policy')) as Record<string, any>;
  const repository = raw.repositories[0];
  repository.path = r.dir;
  // Gate отмечает запуск: smoke его не исполняет.
  repository.gates[0].command = mark(marks, 'gate-unit').command;
  const s = steps(marks);
  repository.lifecycle = {
    setup: s.setup ?? [mark(marks, 'start')],
    ready: s.ready ?? [mark(marks, 'ready')],
    teardown: s.teardown ?? [mark(marks, 'stop')],
  };
  repository.prepare = s.prepare ?? [mark(marks, 'seed')];
  raw.isolation = { mode: 'none', domains: [] };
  raw.runTimeoutMs = 60000;
  tune?.(raw);
  const policy: ExecutionPolicy = executionPolicySchema.parse(raw);
  r.git('update-ref', policy.repositories[0]!.targetRef, 'HEAD');
  const policyPath = join(root, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(raw, null, 2));
  const order = () =>
    existsSync(join(marks, 'order'))
      ? readFileSync(join(marks, 'order'), 'utf8').trim().split('\n')
      : [];
  const smoke = (over: Partial<Parameters<typeof smokeLifecycle>[0]> = {}) =>
    smokeLifecycle({
      policy,
      baseDir: root,
      stateDir: state,
      rev: 'HEAD',
      resourceDatabase: join(root, 'resources.sqlite'),
      ...over,
    });
  return { r, root, marks, state, policy, policyPath, order, smoke };
}

test('smoke: lifecycle и prepare по порядку, замер каждого шага, gates не исполняются', async () => {
  const f = fixture();
  const data = await f.smoke();
  assert.equal(data.passed, true, JSON.stringify(data.failure));
  assert.equal(data.sha, f.r.head());
  assert.deepEqual(f.order(), ['start', 'ready', 'seed', 'stop'], 'gate не исполнялся');
  assert.deepEqual(
    data.steps.map((s) => `${s.stage}/${s.id}:${s.status}`),
    [
      'worktree/worktree:passed',
      'setup/start:passed',
      'ready/ready:passed',
      'prepare/seed:passed',
      'teardown/stop:passed',
    ],
  );
  for (const s of data.steps) assert.ok(Number.isInteger(s.durationMs) && s.durationMs >= 0);
  assert.equal(data.steps[1]!.exitCode, 0);
  assert.ok(existsSync(data.steps[1]!.log!), 'лог шага сохранён');
  assert.equal(data.failure, undefined);
  // Рабочее дерево проверки убрано: в репозитории одно (основное) дерево.
  assert.equal(
    f.r
      .git('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree ')).length,
    1,
  );
  assert.equal(existsSync(join(f.state, 'state.sqlite')), false, 'база состояния не создаётся');
});

test('smoke: установка, упавшая на пределе времени запроса к реестру, — environment, а не crash', async () => {
  // Поддельный pnpm печатает вывод pnpm 11 при TimeoutError загрузки и выходит с кодом 1.
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'harness-smoke-pnpm-')));
  const pnpm = join(bin, 'pnpm');
  const output = [
    'Progress: resolved 1111, reused 0, downloaded 1100, added 1108',
    '[WARN] GET https://registry.npmjs.org/next/-/next-16.3.4.tgz error (23). Will retry in 1 minute. 1 retries left.',
    '[23] The operation was aborted due to timeout',
    '',
    'TimeoutError: The operation was aborted due to timeout',
    '    at new DOMException (node:internal/per_context/domexception:76:18)',
    '    at Timeout._onTimeout (node:internal/abort_controller:210:9)',
    '    at listOnTimeout (node:internal/timers:685:17)',
  ].join('\n');
  writeFileSync(
    pnpm,
    `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(output + '\n')});process.exit(1);\n`,
    { mode: 0o755 },
  );
  const f = fixture(() => ({
    prepare: [{ id: 'install', command: [pnpm, 'install', '--frozen-lockfile'], timeoutMs: 20000 }],
  }));
  const data = await f.smoke();
  assert.equal(data.passed, false);
  assert.equal(data.failure!.class, 'environment', JSON.stringify(data.failure));
  assert.equal(data.failure!.stage, 'prepare');
  assert.equal(data.failure!.step, 'install');
  assert.match(
    data.failure!.message,
    /^dependency-network: TimeoutError: The operation was aborted due to timeout\. Шаг install: exit=1/,
  );
  assert.match(data.failure!.advice, /отказ сети или реестра/);
  // Тот же код без сетевой подписи — по-прежнему crash.
  writeFileSync(pnpm, `#!${process.execPath}\nconsole.error('boom');process.exit(1);\n`, {
    mode: 0o755,
  });
  assert.equal((await f.smoke()).failure!.class, 'crash');
});

test('smoke: падение шага — crash с шагом и логом; teardown исполняется', async () => {
  const f = fixture((m) => ({ prepare: [mark(m, 'seed', 3)] }));
  const data = await f.smoke();
  assert.equal(data.passed, false);
  assert.equal(data.failure!.class, 'crash');
  assert.equal(data.failure!.stage, 'prepare');
  assert.equal(data.failure!.step, 'seed');
  assert.match(data.failure!.advice, /кодом 3/);
  assert.match(data.failure!.advice, /Лог шага: .*seed\.log/);
  assert.deepEqual(f.order(), ['start', 'ready', 'seed', 'stop'], 'уборка после отказа');
  assert.equal(data.steps.find((s) => s.id === 'seed')!.exitCode, 3);
});

test('smoke: нет исполняемого файла — missing-tool; код 127 оболочки — тоже', async () => {
  const absent = fixture(() => ({
    setup: [{ id: 'start', command: ['harness-test-no-such-tool-x9'], timeoutMs: 5000 }],
  }));
  const a = await absent.smoke();
  assert.equal(a.passed, false);
  assert.equal(a.failure!.class, 'missing-tool', JSON.stringify(a.failure));
  assert.equal(a.failure!.step, 'start');
  assert.match(a.failure!.advice, /ENOENT/);
  assert.deepEqual(absent.order(), ['stop'], 'teardown после отказа setup');

  const shell = fixture((m) => ({ ready: [mark(m, 'ready', 127)] }));
  const b = await shell.smoke();
  assert.equal(b.failure!.class, 'missing-tool');
  assert.equal(b.failure!.stage, 'ready');
});

test('smoke: шаг дольше своего timeoutMs — timeout; только teardown упал — cleanup', async () => {
  const slow = fixture(() => ({
    setup: [
      {
        id: 'start',
        command: [process.execPath, '-e', 'setTimeout(()=>{},30000)'],
        timeoutMs: 300,
      },
    ],
  }));
  const t = await slow.smoke();
  assert.equal(t.passed, false);
  assert.equal(t.failure!.class, 'timeout', JSON.stringify(t.failure));
  assert.equal(t.failure!.step, 'start');
  assert.equal(t.steps.find((s) => s.id === 'start')!.timedOut, true);

  const stop = fixture((m) => ({ teardown: [mark(m, 'stop', 1)] }));
  const c = await stop.smoke();
  assert.equal(c.passed, false);
  assert.equal(c.failure!.class, 'cleanup', JSON.stringify(c.failure));
  assert.equal(c.failure!.stage, 'teardown');
  assert.deepEqual(stop.order(), ['start', 'ready', 'seed', 'stop']);
});

test('smoke: подготовка меняет отслеживаемый файл — tree-changed', async () => {
  const f = fixture((m) => ({
    prepare: [mark(m, 'seed', 0, "fs.writeFileSync('README.md','changed\\n');")],
  }));
  const data = await f.smoke();
  assert.equal(data.passed, false);
  assert.equal(data.failure!.class, 'tree-changed', JSON.stringify(data.failure));
});

test('smoke: порт ресурса занят чужим процессом до окружения — port-busy, шаги не исполняются', async () => {
  const port = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('up')); setTimeout(() => {}, 120000);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      holder.once('exit', (code) => reject(new Error('держатель порта завершился: ' + code)));
      holder.stdout.on('data', (d: Buffer) => d.toString().includes('up') && resolve());
    });
    const f = fixture(undefined, (p) => {
      p.resources = [{ id: 'web-port', kind: 'port', value: String(port) }];
      p.repositories[0].gates[0].resources = ['web-port'];
    });
    const data = await f.smoke();
    assert.equal(data.passed, false);
    assert.equal(data.failure!.class, 'port-busy', JSON.stringify(data.failure));
    assert.match(data.failure!.advice, new RegExp(`lsof -nP -iTCP:${port}`));
    assert.deepEqual(f.order(), [], 'lifecycle не начинался');
  } finally {
    holder.kill();
  }
});

test('CLI smoke: JSON по схеме, exit 0 и 4 (LIFECYCLE_FAILED), --human — таблица и совет', () => {
  const run = (policyPath: string, state: string, ...extra: string[]) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        cli,
        'smoke',
        '--state',
        state,
        '--policy',
        policyPath,
        '--sha',
        'HEAD',
        ...extra,
      ],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 120_000 },
    );
  const ok = fixture();
  const pass = run(ok.policyPath, ok.state);
  assert.equal(pass.status, 0, pass.stderr);
  const envelope = JSON.parse(pass.stdout) as { command: string; data: unknown };
  assert.equal(envelope.command, 'smoke');
  const data = cliDataSchemas.smoke.parse(envelope.data);
  assert.equal(data.passed, true);
  assert.match(pass.stderr, /harness smoke: setup\/start passed/);
  assert.deepEqual(ok.order(), ['start', 'ready', 'seed', 'stop']);

  const bad = fixture((m) => ({ ready: [mark(m, 'ready', 2)] }));
  const fail = run(bad.policyPath, bad.state);
  assert.equal(fail.status, 4, fail.stderr);
  const failed = cliDataSchemas.smoke.parse((JSON.parse(fail.stdout) as { data: unknown }).data);
  assert.equal(failed.failure!.class, 'crash');
  const human = run(bad.policyPath, bad.state, '--human');
  assert.equal(human.status, 4);
  assert.match(human.stdout, /окружение FAIL/);
  assert.match(human.stdout, /\nready\/ready\s+failed\s+2/);
  assert.match(human.stdout, /\nотказ: crash \(ready\/ready\)/);
  assert.match(human.stdout, /\nчто сделать: /);

  // Флаг чужой команды — отказ входа.
  const wrong = run(ok.policyPath, ok.state, '--gate', 'unit');
  assert.equal(wrong.status, 2);
  assert.equal(
    cliErrorSchema.parse((JSON.parse(wrong.stdout) as { error: unknown }).error).code,
    'INVALID_INPUT',
  );
});

test('preflight: успех кэшируется по (дерево базы, политика); отказ не кэшируется; новое дерево — новая проверка', async () => {
  const f = fixture();
  const input = {
    policy: f.policy,
    baseDir: f.root,
    stateDir: f.state,
    repositoryIds: ['app', 'app'],
    resourceDatabase: join(f.root, 'resources.sqlite'),
  };
  const first = await lifecyclePreflight(input);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.cached, false);
  assert.equal(first[0]!.result.passed, true);
  const second = await lifecyclePreflight(input);
  assert.equal(second[0]!.cached, true);
  assert.equal(second[0]!.key, first[0]!.key);
  assert.deepEqual(f.order(), ['start', 'ready', 'seed', 'stop'], 'окружение поднято один раз');
  assert.equal(readdirSync(join(f.state, 'preflight')).length, 1);

  // Коммит без изменения дерева — тот же ключ (дерево, а не SHA).
  f.r.git('commit', '-q', '--allow-empty', '-m', 'empty');
  f.r.git('update-ref', f.policy.repositories[0]!.targetRef, 'HEAD');
  assert.equal((await lifecyclePreflight(input))[0]!.cached, true);

  // Другое дерево базы — новая проверка.
  writeFileSync(join(f.r.dir, 'NEW.md'), 'x\n');
  f.r.git('add', 'NEW.md');
  f.r.git('commit', '-q', '-m', 'new');
  f.r.git('update-ref', f.policy.repositories[0]!.targetRef, 'HEAD');
  const third = await lifecyclePreflight(input);
  assert.equal(third[0]!.cached, false);
  assert.notEqual(third[0]!.key, first[0]!.key);

  // Другая исполнительная политика — новый ключ; включение самого флага — нет.
  const flagged = { ...f.policy, lifecyclePreflight: 'cached' as const };
  assert.equal(executionDigest(flagged), executionDigest(f.policy));
  assert.equal((await lifecyclePreflight({ ...input, policy: flagged }))[0]!.cached, true);
  const tuned = { ...f.policy, runTimeoutMs: 61000 };
  assert.equal((await lifecyclePreflight({ ...input, policy: tuned }))[0]!.cached, false);

  // Отказ записан, но не переиспользуется: повтор снова поднимает окружение.
  const bad = fixture((m) => ({ setup: [mark(m, 'start', 5)] }));
  const badInput = { ...input, policy: bad.policy, baseDir: bad.root, stateDir: bad.state };
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      lifecyclePreflight(badInput),
      (e: unknown) =>
        e instanceof HarnessError &&
        e.code === 'LIFECYCLE_FAILED' &&
        /\(crash\) на шаге setup\/start/.test(e.message) &&
        /harness smoke --state <state> --sha refs\/heads\/harness\/accepted/.test(e.message) &&
        /Попытки не начаты/.test(e.message),
    );
  assert.deepEqual(bad.order(), ['start', 'stop', 'start', 'stop']);
});

test('preflight: без окружения в политике проверки нет', async () => {
  const f = fixture();
  const plain = executionPolicySchema.parse({
    ...f.policy,
    repositories: [{ ...f.policy.repositories[0]!, lifecycle: undefined, prepare: [] }],
  });
  const out = await lifecyclePreflight({
    policy: plain,
    baseDir: f.root,
    stateDir: f.state,
    repositoryIds: ['app'],
  });
  assert.deepEqual(out, []);
  assert.equal(existsSync(join(f.state, 'preflight')), false);
});

test('run с lifecyclePreflight: отказ окружения — LIFECYCLE_FAILED до ревью плана и попытки; успех — запуск идёт', async () => {
  const { hsetup } = await import('./harness-fixture.ts');
  const { approve, implement } = await import('./runner-fixture.ts');
  const marks = realpathSync(mkdtempSync(join(tmpdir(), 'harness-preflight-marks-')));
  const withEnv = (code: number) => (p: any) => {
    p.lifecyclePreflight = 'cached';
    p.repositories[0].lifecycle = {
      setup: [mark(marks, 'start', code)],
      teardown: [mark(marks, 'stop')],
    };
  };
  const failing = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: withEnv(4),
  });
  const h = failing.open();
  try {
    await assert.rejects(
      h.run({ graph: failing.graph, author: 'claude' }),
      (e: unknown) =>
        e instanceof HarnessError && e.code === 'LIFECYCLE_FAILED' && /\(crash\)/.test(e.message),
    );
    assert.equal(failing.calls('codex', 'reviewer'), 0, 'ревью плана не начиналось');
    assert.equal(failing.calls('claude', 'writer'), 0, 'попытки не было');
    assert.equal(
      h.engine.read((v) => v.attempts().length),
      0,
    );
  } finally {
    h.close();
  }

  const passing = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: withEnv(0),
  });
  // Первый запуск: целевой ветки ещё нет — её создаёт run до preflight.
  passing.repo.git('update-ref', '-d', passing.policy.repositories[0]!.targetRef);
  const p = passing.open();
  try {
    const data = await p.run({ graph: passing.graph, author: 'claude' });
    assert.equal(data.works[0]!.status, 'done', JSON.stringify(data.works));
    assert.equal(readdirSync(join(passing.state, 'preflight')).length, 1, 'успех записан');
  } finally {
    p.close();
  }
});

test('preflight: ключ меняют дерево зависимости, окружение процесса и обход зависших; нехватка переменной — отказ до кэша', async () => {
  const lib = repo({ 'lib.md': 'v1\n' });
  const f = fixture(undefined, (p) => {
    p.repositories.push({
      id: 'lib',
      path: lib.dir,
      targetRef: 'refs/heads/harness/accepted',
      gates: [{ id: 'lib-unit', kind: 'check', command: [process.execPath, '-e', '0'] }],
    });
    p.repositories[0].dependsOn = ['lib'];
    p.environment = { inherit: ['SMOKE_TEST_VALUE'] };
    // Привязка только зависимости: её сборка снимка — тоже вход окружения.
    p.repositories[1].environment = { inherit: ['SMOKE_LIB_VALUE'] };
  });
  lib.git('update-ref', 'refs/heads/harness/accepted', 'HEAD');
  const input = {
    policy: f.policy,
    baseDir: f.root,
    stateDir: f.state,
    repositoryIds: ['app'],
    resourceDatabase: join(f.root, 'resources.sqlite'),
    environment: { ...process.env, SMOKE_TEST_VALUE: 'one', SMOKE_LIB_VALUE: 'a' },
  };
  const first = await lifecyclePreflight(input);
  assert.equal(first[0]!.cached, false);
  assert.ok(
    first[0]!.result.steps.some((s) => s.stage === 'dependencies'),
    JSON.stringify(first[0]!.result.steps),
  );
  assert.equal((await lifecyclePreflight(input))[0]!.cached, true);
  // Изменилась только зависимость — новая проверка.
  writeFileSync(join(lib.dir, 'lib.md'), 'v2\n');
  lib.git('commit', '-qam', 'v2');
  lib.git('update-ref', 'refs/heads/harness/accepted', 'HEAD');
  assert.equal((await lifecyclePreflight(input))[0]!.cached, false);
  assert.equal((await lifecyclePreflight(input))[0]!.cached, true);
  // Другое значение наследуемой переменной — новая проверка.
  const other = { ...input, environment: { ...input.environment, SMOKE_TEST_VALUE: 'two' } };
  assert.equal((await lifecyclePreflight(other))[0]!.cached, false);
  // Значение привязки зависимости — тоже.
  const libValue = { ...input, environment: { ...input.environment, SMOKE_LIB_VALUE: 'b' } };
  assert.equal((await lifecyclePreflight(libValue))[0]!.cached, false);
  // Другой обход зависших — новая проверка.
  const stall = {
    ...input,
    policy: {
      ...f.policy,
      stallSweep: { intervalMs: 1000, quietMs: 2000, stalledMs: 3000, action: 'stop' as const },
    },
  };
  assert.equal((await lifecyclePreflight(stall))[0]!.cached, false);
  // Переменной нет — отказ до кэша, хотя успех на этом дереве записан.
  const env: NodeJS.ProcessEnv = { ...input.environment };
  delete env.SMOKE_TEST_VALUE;
  const noLib: NodeJS.ProcessEnv = { ...input.environment };
  delete noLib.SMOKE_LIB_VALUE;
  await assert.rejects(
    lifecyclePreflight({ ...input, environment: noLib }),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'LIFECYCLE_FAILED' &&
      /SMOKE_LIB_VALUE/.test(e.message),
  );
  await assert.rejects(
    lifecyclePreflight({ ...input, environment: env }),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'LIFECYCLE_FAILED' &&
      /SMOKE_TEST_VALUE/.test(e.message),
  );
});

test('smoke: отмена после последнего шага — CANCELLED, а не PASS; промах хранилища — пояснение шага, не отказ', async () => {
  const f = fixture();
  const abort = new AbortController();
  await assert.rejects(
    f.smoke({
      signal: abort.signal,
      // Последний шаг перед teardown прошёл — отмена до уборки.
      onStep: (s) => s.stage === 'prepare' && abort.abort(new Error('стоп')),
    }),
    (e: unknown) => e instanceof HarnessError && e.code === 'CANCELLED',
  );
  assert.deepEqual(f.order(), ['start', 'ready', 'seed', 'stop'], 'teardown исполнен');

  const store = fixture(undefined, (p) => {
    p.repositories[0].dependencyStore = { manager: 'pnpm' };
  });
  const data = await store.smoke();
  assert.equal(data.passed, true, JSON.stringify(data.failure));
  const step = data.steps.find((s) => s.stage === 'dependency-store')!;
  assert.equal(step.status, 'passed');
  assert.match(step.detail ?? '', /^miss: isolation\.mode: none/);
});

test('classifyLifecycleFailure: исходный отказ не приписывается teardown; уборка после предела не прячет упавший шаг', () => {
  const policy = fixture().policy;
  const teardown = {
    stage: 'teardown',
    id: 'stop',
    durationMs: 5,
    ok: false,
    exitCode: 1,
    timedOut: false,
    aborted: false,
  };
  // Отказ сверки подготовки (не шаг), затем упал teardown — класс исходного отказа.
  const guarded = classifyLifecycleFailure(
    new CleanupFailure('guard; Очистка окружения не завершена', new Error('защищённые пути')),
    teardown,
    { policy, timedOut: false },
  );
  assert.equal(guarded.class, 'environment');
  assert.equal(guarded.stage, undefined);
  // setup упал сам, предел истёк позже (медленный teardown) — crash шага setup.
  const crashed = classifyLifecycleFailure(
    new HarnessError('CANCELLED', 'Проверка gates прервана: исчерпан предел'),
    { ...teardown, stage: 'setup', id: 'start', exitCode: 2 },
    { policy, timedOut: true },
  );
  assert.equal(crashed.class, 'crash');
  assert.equal(crashed.step, 'start');
  // Шаг отменён пределом — timeout.
  const cut = classifyLifecycleFailure(
    new HarnessError('CANCELLED', 'предел'),
    { ...teardown, stage: 'setup', id: 'start', exitCode: 143, aborted: true },
    { policy, timedOut: true },
  );
  assert.equal(cut.class, 'timeout');
  // setup упал сам, затем проверка замолкла в teardown (stallSweep) — тоже crash шага.
  const stalled = classifyLifecycleFailure(
    new TaskFailure('stalled', 'замолкла'),
    { ...teardown, stage: 'setup', id: 'start', exitCode: 2 },
    { policy, timedOut: false },
  );
  assert.equal(stalled.class, 'crash');
});
