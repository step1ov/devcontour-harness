/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument --
 * Тест правит сырой JSON примера и читает JSON-ответы CLI как есть.
 */
/**
 * Lifecycle-основа моста Turbo Starter без Docker и pnpm: каталог окружения
 * фазы передаётся шагам lifecycle и gates, а среда процесса, убитого при
 * активном окружении, очищается новым процессом по тому же state (S04).
 * «Ресурс» среды — файл во внешнем каталоге, который создаёт setup и
 * удаляет teardown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approve, bin, implement } from './runner-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const cleanup = fileURLToPath(
  new URL('../scripts/acceptance/starter-cleanup.mjs', import.meta.url),
);
const example = fileURLToPath(new URL('../examples/single-task', import.meta.url));
const tsx = import.meta.resolve('tsx');

/** Gate: записывает своё окружение; при файле block ждёт исчезновения владельца среды. */
const gateScript = `
const fs = require('fs'), path = require('path');
const res = process.env.LIFECYCLE_RESOURCES, dir = process.env.DEVCONTOUR_ENVIRONMENT_DIR;
fs.writeFileSync(path.join(res, 'gate-' + process.env.DEVCONTOUR_PHASE + '.json'), JSON.stringify({
  dir, alias: process.env.HARNESS_ENVIRONMENT_DIR, cwd: process.cwd(),
  resource: fs.existsSync(path.join(res, process.env.DEVCONTOUR_RUN_ID + '-' + process.env.DEVCONTOUR_PHASE)),
}));
if (fs.existsSync(path.join(res, 'block'))) {
  const owner = JSON.parse(fs.readFileSync(path.join(dir, 'environment.json'), 'utf8')).ownerPid;
  const alive = () => { try { process.kill(owner, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const wait = () => alive() ? setTimeout(wait, 100) : process.exit(1);
  wait();
} else require(process.cwd() + '/test/run.js');
`;
const resourceStep = (op: 'create' | 'remove') => [
  process.execPath,
  '-e',
  `const fs=require('fs'),p=require('path');const f=p.join(process.env.LIFECYCLE_RESOURCES,process.env.DEVCONTOUR_RUN_ID+'-'+process.env.DEVCONTOUR_PHASE);` +
    (op === 'create'
      ? `fs.writeFileSync(f,'x');fs.writeFileSync(p.join(process.env.DEVCONTOUR_ENVIRONMENT_DIR,'setup-saw-dir'),process.env.HARNESS_ENVIRONMENT_DIR)`
      : `fs.rmSync(f,{force:true})`),
];

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'starter-lifecycle-')));
  const app = join(root, 'app');
  cpSync(example, app, { recursive: true });
  const resources = join(root, 'resources');
  mkdirSync(resources);
  writeFileSync(join(root, 'gate.cjs'), gateScript);
  const scenario = join(root, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ writer: implement(), reviewer: approve() }));
  const policy = JSON.parse(readFileSync(join(app, 'policy.json'), 'utf8'));
  policy.isolation = { mode: 'none', domains: [] };
  policy.environment = { values: { FIXTURE_SCENARIO: scenario } };
  policy.leaseMs = 5000;
  policy.maxAttempts = 1;
  const repo = policy.repositories[0];
  repo.environment = { values: { LIFECYCLE_RESOURCES: resources } };
  repo.gates[0].command = [process.execPath, join(root, 'gate.cjs')];
  repo.lifecycle = {
    setup: [{ id: 'resource-create', command: resourceStep('create') }],
    ready: [],
    teardown: [{ id: 'resource-remove', command: resourceStep('remove') }],
  };
  writeFileSync(join(app, 'policy.json'), JSON.stringify(policy, null, 2));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: app,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    HARNESS_CLAUDE_BIN: bin('fake-claude'),
    HARNESS_CODEX_BIN: bin('fake-codex'),
  };
  const state = join(root, 'state');
  const runArgs = [
    '--import',
    tsx,
    cli,
    'run',
    '--graph',
    'graph.json',
    '--policy',
    'policy.json',
    '--state',
    state,
  ];
  const cleanupIn = (runId: string) => {
    const r = spawnSync(
      process.execPath,
      ['--import', tsx, cleanup, '--state', state, '--run', runId],
      {
        encoding: 'utf8',
        env,
      },
    );
    return { status: r.status, json: JSON.parse(r.stdout) };
  };
  return { root, app, resources, state, git, env, runArgs, cleanupIn };
}
const receipts = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? receipts(join(dir, e.name))
      : e.name === 'environment.json'
        ? [join(dir, e.name)]
        : [],
  );

test('S04/lifecycle: каталог окружения фазы передан шагам и gates, лежит вне worktree и в receipt', () => {
  const p = project();
  const r = spawnSync(process.execPath, p.runArgs, { cwd: p.app, encoding: 'utf8', env: p.env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const run = JSON.parse(r.stdout);
  assert.equal(run.data.works[0].status, 'done');
  for (const phase of ['candidate', 'integration']) {
    const gate = JSON.parse(readFileSync(join(p.resources, `gate-${phase}.json`), 'utf8'));
    assert.match(gate.dir, new RegExp(`/artifacts/[^/]+/${phase}/environment$`));
    assert.equal(gate.alias, gate.dir, 'HARNESS_ENVIRONMENT_DIR — псевдоним');
    assert.ok(!gate.dir.startsWith(gate.cwd), 'каталог окружения вне worktree');
    assert.equal(gate.resource, true, 'gate идёт после setup');
    assert.equal(readFileSync(join(gate.dir, 'setup-saw-dir'), 'utf8'), gate.dir);
    const receipt = JSON.parse(readFileSync(join(gate.dir, 'environment.json'), 'utf8'));
    assert.equal(receipt.status, 'cleaned');
    assert.equal(receipt.devcontourEnv.DEVCONTOUR_ENVIRONMENT_DIR, gate.dir);
  }
  assert.deepEqual(
    readdirSync(p.resources).filter((f) => !f.startsWith('gate-')),
    [],
    'teardown удалил ресурсы обеих фаз',
  );
});

test('S04/lifecycle: процесс убит при активной среде → новый процесс очищает её по тому же state', async () => {
  const p = project();
  writeFileSync(join(p.resources, 'block'), '');
  const target = () => p.git('rev-parse', '--verify', '-q', 'refs/heads/harness/accepted');
  const child = spawn(process.execPath, p.runArgs, { cwd: p.app, env: p.env, stdio: 'ignore' });
  const exited = new Promise<{ signal: string | null }>((r) =>
    child.on('exit', (_c, signal) => r({ signal })),
  );
  const deadline = Date.now() + 240000; // общая нагруженная машина
  while (!existsSync(join(p.resources, 'gate-candidate.json'))) {
    assert.ok(Date.now() < deadline, 'gate не стартовал');
    await new Promise((r) => setTimeout(r, 100));
  }
  const before = target();
  child.kill('SIGKILL');
  assert.equal((await exited).signal, 'SIGKILL');
  const [receiptPath] = receipts(join(p.state, 'artifacts'));
  const receipt = JSON.parse(readFileSync(receiptPath!, 'utf8'));
  assert.equal(receipt.status, 'active');
  const runId = receipt.runId as string;
  assert.ok(existsSync(join(p.resources, `${runId}-candidate`)), 'ресурс среды жив');
  // Пока аренда попытки не истекла, очистка не трогает её.
  const early = p.cleanupIn(runId);
  assert.equal(early.json.ok, false);
  assert.equal(early.json.error.code, 'NOT_READY');
  assert.ok(existsSync(join(p.resources, `${runId}-candidate`)));
  // Аренда истекает не раньше leaseMs после последнего продления; под нагрузкой
  // ждём её истечения опросом (ограниченно), а не фиксированной паузой.
  await new Promise((r) => setTimeout(r, 5500));
  let first = p.cleanupIn(runId);
  for (let i = 0; i < 25 && first.json?.error?.code === 'NOT_READY'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    first = p.cleanupIn(runId);
  }
  assert.equal(first.status, 0, JSON.stringify(first.json));
  assert.equal(first.json.data.status, 'cleaned');
  assert.deepEqual(first.json.data.receipts, [receiptPath]);
  assert.equal(first.json.attempt.status, 'expired');
  assert.ok(!existsSync(join(p.resources, `${runId}-candidate`)), 'ресурс удалён');
  assert.equal(JSON.parse(readFileSync(receiptPath!, 'utf8')).status, 'cleaned');
  assert.ok(
    existsSync(join(receiptPath!, '..', 'setup', 'resource-create.log')),
    'evidence сохранены',
  );
  assert.equal(
    p
      .git('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree ')).length,
    1,
    'рабочее дерево прерванной попытки убрано',
  );
  const second = p.cleanupIn(runId);
  assert.equal(second.json.data.status, 'nothing-pending');
  assert.equal(target(), before, 'target не сдвинут');
});
