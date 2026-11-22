/**
 * CLI `gates --sha --gate`: gates на коммите вне попытки поверх `runGatesAt`
 * в отдельном процессе — исходы по gates, exit 0/3, `--fail-fast`, отказ на
 * неизвестном gate; ни базы состояния, ни попыток.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { cliCommands, cliDataSchemas, cliErrorSchema } from '../src/contracts/index.ts';

import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { example } from './fixtures.ts';
import { repo } from './git-fixture.ts';

type GatesData = z.infer<typeof cliDataSchemas.gates>;

/** Рабочих деревьев репозитория (основное — одно). */
const worktrees = (r: ReturnType<typeof repo>) =>
  r
    .git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/**
 * Gate пишет JUnit с исходом по файлу `ok-<id>` в дереве и отмечает запуск в
 * `ran/`; с файлом `hang-<id>` он зависает на минуту.
 */
const gateScript = (id: string, marks: string) => [
  process.execPath,
  '-e',
  `const fs=require('fs');fs.mkdirSync(${JSON.stringify(marks)},{recursive:true});` +
    `fs.writeFileSync(${JSON.stringify(join(marks, id))},'');` +
    `const ok=fs.existsSync('ok-${id}');` +
    `if(fs.existsSync('hang-${id}'))setTimeout(()=>{},60000);else{` +
    `fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="${id}">'+(ok?'':'<failure message="no"/>')+'</testcase></testsuite>');` +
    `process.exit(ok?0:1)}`,
];

function fixture(options: { files?: Record<string, string>; runTimeoutMs?: number } = {}) {
  const r = repo({ 'README.md': 'app\n', 'ok-unit': '', 'ok-lint': '', ...options.files });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-gates-cli-')));
  const marks = join(root, 'ran');
  const state = join(root, 'state');
  const policy = structuredClone(example('policy')) as {
    repositories: Record<string, unknown>[];
    [key: string]: unknown;
  };
  policy.repositories[0]!.path = r.dir;
  policy.repositories[0]!.gates = ['lint', 'unit', 'e2e'].map((id) => ({
    id,
    kind: 'test',
    command: gateScript(id, marks),
    report: { type: 'junit', path: `reports/${id}.xml` },
    ...(id === 'e2e' ? { dependsOn: ['unit'] } : { dependsOn: [] }),
  }));
  policy.isolation = { mode: 'none', domains: [] };
  policy.runTimeoutMs = options.runTimeoutMs ?? 60000;
  const policyPath = join(root, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(policy, null, 2));
  const harness = (...args: string[]) => {
    const run = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), cli, ...args],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
        timeout: 120_000,
      },
    );
    // `--human` печатает таблицу вместо конверта.
    if (args.includes('--human'))
      return { status: run.status, stdout: run.stdout, stderr: run.stderr };
    const json = JSON.parse(run.stdout) as { ok: boolean; data?: unknown; error?: unknown };
    const data = json.ok ? cliDataSchemas.gates.parse(json.data) : undefined;
    const error = json.ok ? undefined : cliErrorSchema.parse(json.error);
    return { status: run.status, ok: json.ok, data, error, stdout: run.stdout, stderr: run.stderr };
  };
  /** Тот же вызов без ожидания: процесс CLI для сигнала. */
  const start = (...args: string[]) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    let stdout = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    const done = new Promise<{ status: number | null; stdout: string }>((resolve) =>
      child.on('close', (status) => resolve({ status, stdout })),
    );
    return { child, done };
  };
  const ran = () => (existsSync(marks) ? readdirSync(marks).sort() : []);
  return { r, root, state, policyPath, harness, start, ran, marks };
}

test('gates: проходящий и непрошедший gate на коммите — исходы по gates, exit 0/3, попыток нет', () => {
  assert.ok('gates' in cliCommands && 'gates' in cliDataSchemas);
  const { r, state, policyPath, harness, ran } = fixture();
  const head = r.head();

  const pass = harness(
    'gates',
    '--state',
    state,
    '--policy',
    policyPath,
    '--sha',
    'HEAD',
    '--gate',
    'unit',
  );
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(pass.data!.sha, head, 'HEAD разрешён в SHA');
  assert.equal(pass.data!.passed, true);
  assert.equal(pass.data!.repositoryId, 'app');
  assert.deepEqual(
    pass.data!.gates.map((g: GatesData['gates'][number]) => [g.gate, g.status]),
    [['unit', 'passed']],
  );
  assert.equal(pass.data!.gates[0]!.exitCode, 0);
  assert.match(pass.stderr, /harness gates: unit passed/);

  // e2e падает (нет ok-e2e), предпосылка unit идёт первой; все gates по умолчанию.
  const fail = harness('gates', '--state', state, '--policy', policyPath, '--sha', head);
  assert.equal(fail.status, 3, fail.stderr);
  assert.equal(fail.ok, true, 'провал gate — данные проверки, не ошибка');
  assert.equal(fail.data!.passed, false);
  assert.deepEqual(
    fail.data!.gates.map((g: GatesData['gates'][number]) => [g.gate, g.status]),
    [
      ['lint', 'passed'],
      ['unit', 'passed'],
      ['e2e', 'failed'],
    ],
  );
  assert.notEqual(fail.data!.gates[2]!.exitCode, 0);
  assert.ok(existsSync(fail.data!.gates[2]!.log!), 'лог gate сохранён');
  assert.deepEqual(ran(), ['e2e', 'lint', 'unit']);

  // Ни базы состояния, ни попыток, ни привязки: только логи проверок.
  assert.deepEqual(readdirSync(state), ['gates-at']);
  assert.equal(
    r
      .git('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree ')).length,
    1,
  );
  assert.equal(r.git('status', '--porcelain'), '', 'checkout репозитория не тронут');

  // Таблица для человека — тот же exit.
  const human = harness(
    'gates',
    '--state',
    state,
    '--policy',
    policyPath,
    '--sha',
    head,
    '--human',
  );
  assert.equal(human.status, 3);
  assert.match(human.stdout, /^app @ [0-9a-f]{12} — FAIL/);
  assert.match(human.stdout, /\ne2e +failed +1/);
});

test('gates --fail-fast: после первого провала следующие gates не исполняются и названы skipped', () => {
  const { r, state, policyPath, harness, ran } = fixture();
  // lint падает первым: без ok-lint.
  r.git('rm', '-q', 'ok-lint');
  r.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'no lint');
  const sha = r.head();

  const fast = harness(
    'gates',
    '--state',
    state,
    '--policy',
    policyPath,
    '--sha',
    sha,
    '--fail-fast',
  );
  assert.equal(fast.status, 3, fast.stderr);
  assert.equal(fast.data!.failFast, true);
  assert.deepEqual(
    fast.data!.gates.map((g: GatesData['gates'][number]) => [g.gate, g.status]),
    [
      ['lint', 'failed'],
      ['unit', 'skipped'],
      ['e2e', 'skipped'],
    ],
  );
  assert.deepEqual(ran(), ['lint'], 'после провала gates не запускались');

  // Без флага провал не останавливает проверку (диагностика всех исходов).
  const all = harness('gates', '--state', state, '--policy', policyPath, '--sha', sha);
  assert.deepEqual(
    all.data!.gates.map((g: GatesData['gates'][number]) => [g.gate, g.status]),
    [
      ['lint', 'failed'],
      ['unit', 'passed'],
      ['e2e', 'failed'],
    ],
  );
});

test('gates: неизвестный gate, неизвестный коммит и пустой --gate — ясный отказ до исполнения', () => {
  const { state, policyPath, harness, ran } = fixture();
  const unknown = harness(
    'gates',
    '--state',
    state,
    '--policy',
    policyPath,
    '--sha',
    'HEAD',
    '--gate',
    'unit,nope',
  );
  assert.equal(unknown.status, 2);
  assert.equal(unknown.error?.code, 'GATE_UNKNOWN');
  assert.match(unknown.error.message, /Проверка вне профиля app: nope/);
  const commit = harness(
    'gates',
    '--state',
    state,
    '--policy',
    policyPath,
    '--sha',
    'f'.repeat(40),
  );
  assert.equal(commit.error?.code, 'NOT_FOUND');
  assert.match(commit.error.message, /Коммит f+ не найден в app/);
  const empty = harness(
    'gates',
    '--state',
    state,
    '--policy',
    policyPath,
    '--sha',
    'HEAD',
    '--gate',
    ',',
  );
  assert.equal(empty.error?.code, 'INVALID_INPUT');
  const noSha = harness('gates', '--state', state, '--policy', policyPath);
  assert.equal(noSha.error?.code, 'INVALID_INPUT');
  assert.match(noSha.error.message, /gates требует --sha/);
  // Флаги команды не принимаются другими командами.
  const other = harness('status', '--state', state, '--fail-fast');
  assert.equal(other.error?.code, 'INVALID_INPUT');
  assert.deepEqual(ran(), [], 'ни один gate не исполнен');
  assert.equal(existsSync(state), false, 'отказ ничего не создал');
});

test('gates: непрошедшая предпосылка dependsOn без --fail-fast — зависимый gate not-run, остальные исполнены', () => {
  const { r, state, policyPath, harness, ran } = fixture();
  r.git('rm', '-q', 'ok-unit');
  r.git('commit', '-q', '-m', 'no unit');
  const res = harness('gates', '--state', state, '--policy', policyPath, '--sha', 'HEAD');
  assert.equal(res.status, 3, res.stderr);
  assert.deepEqual(
    res.data!.gates.map((g) => [g.gate, g.status]),
    [
      ['lint', 'passed'],
      ['unit', 'failed'],
      ['e2e', 'not-run'],
    ],
  );
  assert.match(res.data!.gates[2]!.message ?? '', /не прошла предпосылка unit/);
  assert.equal(res.data!.gates[2]!.exitCode, undefined);
  assert.deepEqual(ran(), ['lint', 'unit']);
});

test('gates: предел проверки runTimeoutMs — отказ CANCELLED, прерванный gate cancelled, следующие not-run', () => {
  const { r, state, policyPath, harness, ran } = fixture({
    files: { 'hang-unit': '' },
    runTimeoutMs: 3000,
  });
  const res = harness('gates', '--state', state, '--policy', policyPath, '--sha', 'HEAD');
  assert.equal(res.status, 3, res.stderr);
  assert.equal(res.error?.code, 'CANCELLED');
  assert.match(res.error.message, /исчерпан предел проверки runTimeoutMs \(3 с\)/);
  assert.deepEqual(
    res.error.issues.map((i) => [i.path.join('.'), i.message.split(':')[0]]),
    [
      ['gates.lint', 'passed'],
      ['gates.unit', 'cancelled'],
      ['gates.e2e', 'not-run'],
    ],
  );
  assert.deepEqual(ran(), ['lint', 'unit']);
  assert.equal(worktrees(r), 1, 'рабочее дерево прерванной проверки убрано');
});

test('gates: SIGINT — отказ CANCELLED, исполнявшийся gate cancelled, дерево убрано', async () => {
  const { r, state, policyPath, start, marks } = fixture({ files: { 'hang-lint': '' } });
  const { child, done } = start('gates', '--state', state, '--policy', policyPath, '--sha', 'HEAD');
  const deadline = Date.now() + 60_000;
  while (!existsSync(join(marks, 'lint')) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill('SIGINT');
  const { status, stdout } = await done;
  const json = JSON.parse(stdout) as { ok: boolean; error?: unknown };
  const error = cliErrorSchema.parse(json.error);
  assert.equal(status, 3);
  assert.equal(error.code, 'CANCELLED');
  assert.match(error.message, /прервана сигналом/);
  assert.deepEqual(
    error.issues.map((i) => [i.path.join('.'), i.message.split(':')[0]]),
    [
      ['gates.lint', 'cancelled'],
      ['gates.unit', 'not-run'],
      ['gates.e2e', 'not-run'],
    ],
  );
  assert.equal(worktrees(r), 1);
});

test('gates: инициализированный каталог состояния — политика из привязки, binding и база не меняются', () => {
  const { r, state, policyPath, harness } = fixture();
  mkdirSync(state, { recursive: true });
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as unknown;
  writeFileSync(join(state, 'binding.json'), JSON.stringify({ policy, baseDir: r.dir }, null, 2));
  new SqliteExecutionStore(join(state, 'state.sqlite'), 'test').close();
  const snapshot = () =>
    Object.fromEntries(
      readdirSync(state)
        .filter((f) => f !== 'gates-at')
        .map((f) => {
          const st = statSync(join(state, f));
          return [f, [readFileSync(join(state, f)).toString('base64'), st.mtimeMs, st.size]];
        }),
    );
  const before = snapshot();
  const res = harness('gates', '--state', state, '--sha', 'HEAD', '--gate', 'unit');
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(
    res.data!.gates.map((g) => g.status),
    ['passed'],
  );
  assert.deepEqual(snapshot(), before, 'binding.json и state.sqlite не тронуты');
  assert.deepEqual(readdirSync(state).sort(), ['binding.json', 'gates-at', 'state.sqlite']);
});

test('gates: предупреждение пробы портов (порт на всех адресах держит чужой процесс) — в data.warnings и в таблице', async () => {
  const { createServer } = await import('node:net');
  const listen = (port: number, host: string) =>
    new Promise<import('node:net').Server>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen({ host, port }, () => resolve(server));
    });
  const close = (server: import('node:net').Server) =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  const probe = await listen(0, '127.0.0.1');
  const port = (probe.address() as { port: number }).port;
  await close(probe);
  // Чужой процесс: держит порт на 0.0.0.0.
  const foreign = spawn(
    process.execPath,
    [
      '-e',
      `require('net').createServer().listen(${port}, '0.0.0.0', () => console.log('up')); setTimeout(() => {}, 120000);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      foreign.once('exit', (code) => reject(new Error('держатель порта завершился: ' + code)));
      foreign.stdout.on('data', (d: Buffer) => d.toString().includes('up') && resolve());
    });
    // Linux не даёт привязать loopback рядом с 0.0.0.0: там это отказ, не предупреждение.
    const beside = await listen(port, '127.0.0.1').then(close, () => false);
    if (beside === false) return;

    const { root, state, policyPath } = fixture();
    const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as {
      resources?: unknown[];
      repositories: { gates: { id: string; resources?: string[] }[] }[];
    };
    policy.resources = [{ id: 'web-port', kind: 'port', value: String(port) }];
    policy.repositories[0]!.gates.find((g) => g.id === 'unit')!.resources = ['web-port'];
    writeFileSync(policyPath, JSON.stringify(policy, null, 2));
    // База ресурсов машины — под временным HOME, не общая.
    const home = join(root, 'home');
    mkdirSync(home);
    const run = (...extra: string[]) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          cli,
          'gates',
          '--state',
          state,
          '--policy',
          policyPath,
          '--sha',
          'HEAD',
          '--gate',
          'unit',
          ...extra,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: '', HOME: home },
          timeout: 120_000,
        },
      );
    const json = run();
    assert.equal(json.status, 0, json.stderr);
    const data = cliDataSchemas.gates.parse((JSON.parse(json.stdout) as { data: unknown }).data);
    assert.equal(data.passed, true);
    assert.equal(data.warnings?.length, 1, JSON.stringify(data.warnings));
    assert.match(
      data.warnings[0]!,
      new RegExp(`^Порт ${port} \\(ресурс web-port\\) на всех адресах`),
    );
    const human = run('--human');
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, new RegExp(`\\nпредупреждение: Порт ${port} \\(ресурс web-port\\)`));
  } finally {
    foreign.kill();
  }
});
