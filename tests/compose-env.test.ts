/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тест правит сырой JSON политики до разбора схемой.
 */
/**
 * 0.1.0-alpha.70 (follow-up a69): сервисы попытки в docker compose.
 * `env-up` снимает остатки проекта попытки, поднимает стек с `--wait`,
 * дописывает динамические порты в файл окружения попытки (gates получают их
 * в окружении), при отказе готовности — `ps -a` и хвосты журналов
 * нездоровых сервисов, замаскированные; `env-down` — `down -v`;
 * `env-sweep` — уборка проектов hx-* попыток, которых нет среди идущих.
 * Docker не запускается: подставной `docker` записывает вызовы.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeDown,
  composeSweep,
  composeUp,
  ownedComposeProjects,
  servicePortEnv,
  servicePortsFromFile,
  type DockerRun,
} from '../src/environment/compose-env.ts';
import { composeProjectName } from '../src/environment/attempt-ports.ts';

const ps = JSON.stringify([
  {
    Service: 'db',
    State: 'running',
    Health: 'healthy',
    Publishers: [{ URL: '127.0.0.1', TargetPort: 5432, PublishedPort: 21543, Protocol: 'tcp' }],
  },
  {
    Service: 'rabbit',
    State: 'exited',
    ExitCode: 1,
    Publishers: [],
  },
]);

function fake(upCode: number) {
  const calls: string[][] = [];
  const docker: DockerRun = (args) => {
    calls.push(args);
    if (args.includes('up'))
      return Promise.resolve({
        code: upCode,
        stdout: '',
        stderr: upCode ? 'dependency failed to start: container rabbit is unhealthy' : '',
      });
    if (args.includes('ps')) return Promise.resolve({ code: 0, stdout: ps, stderr: '' });
    if (args.includes('logs'))
      return Promise.resolve({
        code: 0,
        stdout: 'eacces .erlang.cookie secret-pass-123',
        stderr: '',
      });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  return { calls, docker };
}

test('env-up: остатки сняты, стек с --wait, порты в файле окружения; отказ готовности — ps и журналы, замаскированные', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'compose-env-')));
  const file = join(dir, 'attempt-env.json');
  writeFileSync(
    file,
    JSON.stringify({ HARNESS_ATTEMPT_ID: 'r1', COMPOSE_PROJECT_NAME: 'hx-app-abc' }),
  );
  const env = { COMPOSE_PROJECT_NAME: 'hx-app-abc', HARNESS_ATTEMPT_ENV_FILE: file };
  const ok = fake(0);
  const up = await composeUp({
    env,
    cwd: dir,
    files: ['compose.yml'],
    waitTimeoutS: 30,
    docker: ok.docker,
  });
  assert.equal(up.ok, true);
  assert.deepEqual(ok.calls[0], [
    'compose',
    '-p',
    'hx-app-abc',
    '-f',
    'compose.yml',
    'down',
    '-v',
    '--remove-orphans',
    '-t',
    '2',
  ]);
  assert.deepEqual(ok.calls[1], [
    'compose',
    '-p',
    'hx-app-abc',
    '-f',
    'compose.yml',
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '30',
  ]);
  assert.deepEqual(up.env, { HX_DB_5432: '21543' });
  assert.equal(servicePortEnv('my-api', 3000), 'HX_MY_API_3000');
  const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  assert.equal(written.HX_DB_5432, '21543');
  assert.equal(written.HARNESS_ATTEMPT_ID, 'r1', 'прежние переменные попытки сохранены');
  assert.deepEqual(servicePortsFromFile(readFileSync(file, 'utf8')), { HX_DB_5432: '21543' });
  assert.deepEqual(
    (
      JSON.parse(readFileSync(join(dir, 'compose-services.json'), 'utf8')) as {
        services: Record<string, { ports: unknown }>;
      }
    ).services.db?.ports,
    { '5432': { host: '127.0.0.1', port: 21543 } },
  );

  const bad = fake(1);
  const failed = await composeUp({
    env,
    cwd: dir,
    docker: bad.docker,
    redact: (s) => s.replaceAll('secret-pass-123', '***'),
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(
    failed.readiness?.services.map((s) => [s.service, s.state]),
    [
      ['db', 'running'],
      ['rabbit', 'exited'],
    ],
  );
  assert.match(failed.readiness?.error ?? '', /rabbit is unhealthy/);
  assert.equal(failed.readiness?.logs.rabbit, 'eacces .erlang.cookie ***');
  assert.ok(bad.calls.some((c) => c.includes('logs') && c.includes('rabbit')));
  assert.ok(
    !bad.calls.some((c) => c.includes('logs') && c.includes('db')),
    'здоровый сервис без журнала',
  );
  assert.match(readFileSync(join(dir, 'compose-readiness.json'), 'utf8'), /rabbit/);

  const down = fake(0);
  assert.deepEqual(await composeDown({ env, cwd: dir, docker: down.docker }), {
    project: 'hx-app-abc',
    ok: true,
  });
  assert.deepEqual(down.calls[0], [
    'compose',
    '-p',
    'hx-app-abc',
    'down',
    '-v',
    '--remove-orphans',
    '-t',
    '2',
  ]);
  await assert.rejects(composeUp({ env: {}, cwd: dir, docker: ok.docker }), /COMPOSE_PROJECT_NAME/);
});

test('env-sweep: только записи env-up известных попыток в каталоге controller, проект — выведенный; живость — перед снятием', async () => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-state-')));
  const write = (dir: string, file: string, data: Record<string, unknown>) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(data));
  };
  const record = (attempt: string, repo = 'app', project = composeProjectName(attempt, repo)) =>
    write(join(state, 'artifacts', attempt), `compose-services.${repo}.json`, {
      owner: 'harness-env-up',
      project,
      attemptId: attempt,
      repositoryId: repo,
      services: {},
    });
  record('r-live');
  record('r-dead');
  record('r-racy');
  // Подлог: имя проекта не выведено из попытки (чужой стек).
  record('r-forged', 'app', 'hx-other-install-123');
  // Подлог в рабочем дереве и запись неизвестной попытки — не читаются.
  write(join(state, 'worktrees', 'r-dead', 'src'), 'compose-services.app.json', {
    owner: 'harness-env-up',
    project: 'hx-victim',
    attemptId: 'r-dead',
    repositoryId: 'app',
  });
  record('r-unknown');
  const known = ['r-live', 'r-dead', 'r-racy', 'r-forged'].map((id) => ({
    id,
    dir: join(state, 'artifacts', id),
  }));
  const owned = await ownedComposeProjects(known, ['app']);
  assert.deepEqual(owned.map((o) => o.attemptId).sort(), ['r-dead', 'r-live', 'r-racy']);
  const name = (a: string) => composeProjectName(a, 'app');
  const calls: string[][] = [];
  const docker: DockerRun = (args) => {
    calls.push(args);
    if (args[0] === 'ps')
      return Promise.resolve({
        code: 0,
        stdout:
          [
            name('r-live'),
            name('r-dead'),
            name('r-racy'),
            name('r-unknown'),
            'hx-victim',
            'hx-other-install-123',
          ].join('\n') + '\n',
        stderr: '',
      });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const alive = (a: string) => a === 'r-live';
  const dry = await composeSweep({ env: {}, cwd: '/', owned, alive, docker });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.stale, [name('r-dead'), name('r-racy')].sort());
  assert.deepEqual(dry.removed, []);
  assert.equal(dry.ignored, 3, 'неизвестная попытка, подлог в дереве и чужой стек не тронуты');
  // Попытка r-racy началась между списком и снятием: второй запрос живости
  // (перепроверка перед снятием) её видит — стек остаётся. Без перепроверки
  // тест падает.
  const asked = new Map<string, number>();
  const real = await composeSweep({
    env: {},
    cwd: '/',
    owned,
    alive: (a) => {
      const n = (asked.get(a) ?? 0) + 1;
      asked.set(a, n);
      return a === 'r-live' || (a === 'r-racy' && n > 1);
    },
    confirm: true,
    docker,
  });
  assert.deepEqual(real.removed, [name('r-dead')]);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'compose').map((c) => c[2]),
    [name('r-dead')],
  );
});

test('CLI env-up: подставной docker в PATH; отказ готовности — код 1 и диагностика в stderr', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'compose-cli-')));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
case "$*" in
  *" up "*) echo "container db is unhealthy" >&2; exit 1 ;;
  *" ps "*) echo '[{"Service":"db","State":"running","Health":"unhealthy","Publishers":[]}]' ;;
  *" logs "*) echo "db: not ready pass=z9q" ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const r = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), cli, 'env-up', '--wait', '5'],
    {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        COMPOSE_PROJECT_NAME: 'hx-app-x',
        // Объявленный секрет политики с несекретным именем и коротким значением.
        DB_PASS: 'z9q',
        HARNESS_SECRET_NAMES: 'DB_PASS',
      },
    },
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /стек hx-app-x не готов: container db is unhealthy/);
  assert.match(r.stderr, /--- db .*\n.*db: not ready pass=/);
  assert.doesNotMatch(r.stderr + r.stdout, /z9q/, 'объявленный секрет замаскирован');
  const noProject = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), cli, 'env-up'],
    {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMPOSE_PROJECT_NAME: '' },
    },
  );
  assert.notEqual(noProject.status, 0);
  assert.match(noProject.stdout + noProject.stderr, /NOT_READY/);
});

test('ревью 1: gate фазы получает порты сервисов, поднятых setup этой фазы; порты прошлой фазы не переносятся', async () => {
  const { setup, runAll, implement, approve } = await import('./runner-fixture.ts');
  const up = `const fs=require('fs');const f=process.env.HARNESS_ATTEMPT_ENV_FILE;const d=JSON.parse(fs.readFileSync(f,'utf8'));
if(d.HX_DB_5432) {console.error('stale port '+d.HX_DB_5432);process.exit(3)}
d.HX_DB_5432=process.env.DEVCONTOUR_PHASE==='candidate'?'21001':'21002';d.HARNESS_SERVICE_PORT_KEYS='HX_DB_5432';fs.writeFileSync(f,JSON.stringify(d));`;
  const gate = `const want=process.env.DEVCONTOUR_PHASE==='candidate'?'21001':'21002';const ok=process.env.HX_DB_5432===want&&process.env.HX_DB_USER==='app';
require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase classname="svc" name="port">'+(ok?'':'<failure message="got '+process.env.HX_DB_5432+' want '+want+'"/>')+'</testcase></testsuite>');process.exit(ok?0:1);`;
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: Record<string, any>) => {
      delete p.harnessMode;
      p.maxAttempts = 1;
      p.repositories[0].gates[0].command = [process.execPath, '-e', gate];
      // Переменная политики с тем же префиксом — не порт: остаётся (ревью 2).
      p.environment = { ...p.environment, values: { ...p.environment.values, HX_DB_USER: 'app' } };
      p.repositories[0].lifecycle = {
        setup: [{ id: 'services', command: [process.execPath, '-e', up], timeoutMs: 30_000 }],
        ready: [],
        teardown: [{ id: 'down', command: [process.execPath, '-e', '0'], timeoutMs: 30_000 }],
      };
    },
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  const gates = a.evidence.filter((e) => e.kind === 'test');
  assert.deepEqual(
    gates.map((e) => [e.phase, e.passed]),
    [
      ['candidate', true],
      ['integration', true],
    ],
  );
});

test('ревью 1: env-up там, где файл окружения не записать (gate под границей), — стек поднят, предупреждение вместо исключения; маска до обрезки', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'compose-ro-')));
  const ro = join(dir, 'ro');
  mkdirSync(ro);
  writeFileSync(join(ro, 'attempt-env.json'), '{}');
  chmodSync(ro, 0o500);
  try {
    const up = await composeUp({
      env: {
        COMPOSE_PROJECT_NAME: 'hx-app-ro',
        HARNESS_ATTEMPT_ENV_FILE: join(ro, 'attempt-env.json'),
      },
      cwd: dir,
      docker: fake(0).docker,
    });
    assert.equal(up.ok, true);
    assert.match(up.warnings?.join('\n') ?? '', /не записан.*для шагов lifecycle/);
  } finally {
    chmodSync(ro, 0o700);
  }
  // Секрет на границе обрезки маскируется целиком: маска — до обрезки.
  const secret = 'S3CRET-VALUE-XYZ';
  // Секрет пересекает границу обрезки хвоста (8000): обрезка до маски
  // оставила бы «ALUE-XYZ».
  const long = secret + 'x'.repeat(8000 - 8);
  const bad: DockerRun = (args) =>
    Promise.resolve(
      args.includes('up')
        ? { code: 1, stdout: '', stderr: 'boom' }
        : args.includes('ps')
          ? { code: 0, stdout: ps, stderr: '' }
          : args.includes('logs')
            ? { code: 0, stdout: long, stderr: '' }
            : { code: 0, stdout: '', stderr: '' },
    );
  const failed = await composeUp({
    env: { COMPOSE_PROJECT_NAME: 'hx-app-ro' },
    cwd: dir,
    docker: bad,
    redact: (t) => t.replaceAll(secret, '***'),
  });
  assert.doesNotMatch(failed.readiness?.logs.rabbit ?? '', /VALUE-XYZ|ALUE/);
});
