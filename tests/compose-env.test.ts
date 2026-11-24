/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
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
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeDown,
  composeSweep,
  composeUp,
  servicePortEnv,
  servicePortsFromFile,
  type DockerRun,
} from '../src/environment/compose-env.ts';

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

test('env-sweep: снимаются только проекты hx-* не идущих попыток; --dry-run — только список', async () => {
  const calls: string[][] = [];
  const docker: DockerRun = (args) => {
    calls.push(args);
    if (args[0] === 'ps')
      return Promise.resolve({
        code: 0,
        stdout: 'hx-app-live\nhx-app-dead\nhx-app-dead\nother-project\n',
        stderr: '',
      });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const keep = new Set(['hx-app-live']);
  const dry = await composeSweep({ env: {}, cwd: '/', keep, dryRun: true, docker });
  assert.deepEqual(dry.stale, ['hx-app-dead']);
  assert.deepEqual(dry.removed, []);
  assert.equal(calls.filter((c) => c[0] === 'compose').length, 0);
  const real = await composeSweep({ env: {}, cwd: '/', keep, docker });
  assert.deepEqual(real.removed, ['hx-app-dead']);
  assert.deepEqual(real.kept, ['hx-app-live']);
  assert.deepEqual(calls.at(-1), [
    'compose',
    '-p',
    'hx-app-dead',
    'down',
    '-v',
    '--remove-orphans',
    '-t',
    '2',
  ]);
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
  *" logs "*) echo "db: not ready" ;;
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
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMPOSE_PROJECT_NAME: 'hx-app-x' },
    },
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /стек hx-app-x не готов: container db is unhealthy/);
  assert.match(r.stderr, /--- db .*\n.*db: not ready/);
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
d.HX_DB_5432=process.env.DEVCONTOUR_PHASE==='candidate'?'21001':'21002';fs.writeFileSync(f,JSON.stringify(d));`;
  const gate = `const want=process.env.DEVCONTOUR_PHASE==='candidate'?'21001':'21002';const ok=process.env.HX_DB_5432===want;
require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase classname="svc" name="port">'+(ok?'':'<failure message="got '+process.env.HX_DB_5432+' want '+want+'"/>')+'</testcase></testsuite>');process.exit(ok?0:1);`;
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: Record<string, any>) => {
      delete p.harnessMode;
      p.maxAttempts = 1;
      p.repositories[0].gates[0].command = [process.execPath, '-e', gate];
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
