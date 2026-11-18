import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskFailure, type EvidenceRecord } from '../src/contracts/index.ts';
import { ensurePortsFree, portBusy } from '../src/environment/port-probe.ts';
import { command, processInventory, processTable } from '../src/environment/process.ts';
import { leaseScope, recordSurvivors, survivorRecords } from '../src/environment/survivors.ts';
import { runGatesAt, type GatesAtContext } from '../src/verification/gates-at.ts';
import { write } from './git-fixture.ts';
import { approve, greet, implement, runAll, setup } from './runner-fixture.ts';

// Порт ресурса, который держит процесс, переживший прежнюю попытку (или
// чужой процесс), ронял gate следующей попытки, и провал засчитывался.
// Теперь порты аренды проверяются перед каждой фазой: переживший процесс
// прежней попытки останавливается, чужой — отказ окружения `resource-busy`,
// не засчитанный.

/** Свободный порт ≥ 1024 (выдан ядром и сразу отпущен). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

/** Процесс, слушающий порт на 127.0.0.1; запущен тестом и им же останавливается. */
async function holder(port: number, detached = false): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('up')); setTimeout(() => {}, 120000);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], detached },
  );
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error('держатель порта завершился: ' + code)));
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('up')) resolve();
    });
  });
  child.removeAllListeners('exit');
  return child;
}
const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once('exit', () => resolve()));
const stopHolder = async (child: ChildProcess) => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited(child);
  }
};

/** Gate привязывает порт ресурса (как служба проверки) и затем исполняет тесты. */
const gate = (port: number) => `
const net = require('net');
const s = net.createServer();
s.once('error', (e) => { console.error('gate: ' + e.code); process.exit(1); });
s.listen(${port}, '127.0.0.1', () => s.close(() => require('./run.js')));
`;

function fixture(port: number) {
  return setup({
    scenario: { writer: implement(), reviewer: approve() },
    files: { 'test/gate.js': gate(port) },
    policy: (p) => {
      p.resources = [{ id: 'web-port', kind: 'port', value: String(port) }];
      const raw = p as { repositories: { gates: { command: string[]; resources?: string[] }[] }[] };
      raw.repositories[0]!.gates[0]!.command = [process.execPath, 'test/gate.js'];
      raw.repositories[0]!.gates[0]!.resources = ['web-port'];
    },
  });
}

test('порт ресурса держит чужой процесс — попытка: environment/resource-busy, не засчитана; сообщение называет порт, PID и команду', async () => {
  const port = await freePort();
  const ctx = fixture(port);
  const foreign = await holder(port);
  try {
    await runAll(ctx);
    const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
    const first = attempts[0]!;
    assert.equal(first.status, 'failed');
    assert.equal(first.failureKind, 'environment', first.error);
    assert.match(
      first.error ?? '',
      new RegExp(
        `Порт ${port} \\(ресурс web-port\\) занят до начала фазы: его слушает PID ${foreign.pid} \\(node\\)`,
      ),
    );
    assert.ok(
      !first.evidence.some((e) => e.kind === 'test'),
      'gate не исполнялся: проверка — до фазы',
    );
    const diagnosed = ctx.store
      .events()
      .flatMap((e) => (e.type === 'attempt.diagnosed' && e.runId === first.id ? [e.payload] : []));
    assert.deepEqual(diagnosed, [
      { failureKind: 'environment', cause: 'resource-busy', counted: false },
    ]);
    const work = ctx.engine.read((v) => v.work('add-greeting'))!;
    assert.equal(work.attempt, 0, 'предел попыток не тронут');
    assert.equal(foreign.exitCode, null, 'чужой процесс не остановлен');
    assert.equal(foreign.signalCode, null);
  } finally {
    await stopHolder(foreign);
  }
});

test('порт ресурса держит записанный переживший процесс прежней попытки — он остановлен, попытка проходит', async () => {
  const port = await freePort();
  const ctx = fixture(port);
  const survivor = await holder(port, true);
  const database = join(ctx.state, 'resources.sqlite');
  try {
    const start = (await processTable(true)).find((r) => r.pid === survivor.pid)!.start;
    recordSurvivors(
      { database, owner: 'earlier-attempt' },
      [{ pid: survivor.pid!, start }],
      'unit',
    );
    await runAll(ctx);
    const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.status, 'succeeded', attempts[0]!.error);
    assert.ok(attempts[0]!.evidence.every((e) => e.passed));
    await exited(survivor);
    assert.deepEqual(survivorRecords(database), [], 'запись остановленного снята');
  } finally {
    await stopHolder(survivor);
  }
});

test('запись того же PID с другим временем старта — не переживший: отказ resource-busy, процесс не остановлен', async () => {
  const port = await freePort();
  const foreign = await holder(port);
  const database = join(mkdtempSync(join(tmpdir(), 'ports-')), 'resources.sqlite');
  try {
    recordSurvivors(
      { database, owner: 'earlier' },
      [{ pid: foreign.pid!, start: 'Thu Jan  1 00:00:00 1970' }],
      'unit',
    );
    const error = await ensurePortsFree({
      database,
      owner: 'now',
      ports: [{ id: 'web-port', port }],
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof TaskFailure, String(error));
    assert.equal(error.kind, 'environment');
    assert.equal(error.diagnosis, 'resource-busy');
    assert.equal(foreign.exitCode, null);
  } finally {
    await stopHolder(foreign);
  }
});

test('свободный порт — проба быстрая и ничего не меняет; занятость видна на любом адресе', async () => {
  const port = await freePort();
  const started = performance.now();
  await ensurePortsFree({
    database: '/nonexistent/never-opened.sqlite',
    owner: 'x',
    ports: [{ id: 'p', port }],
  });
  assert.ok(performance.now() - started < 500, 'проба — миллисекунды');
  // Внутри окружения фазы проверки нет.
  const held = await holder(port);
  try {
    assert.equal(await portBusy(port), true);
    await ensurePortsFree({
      database: '/nonexistent/never-opened.sqlite',
      owner: 'x',
      ports: [{ id: 'p', port }],
      environment: true,
    });
  } finally {
    await stopHolder(held);
  }
  assert.equal(await portBusy(port), false);
  for (const host of ['0.0.0.0', '::1']) {
    const server = createServer();
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen({ host, port }, () => resolve(true));
    });
    if (!listening) continue; // нет IPv6 на хосте
    try {
      assert.equal(await portBusy(port), true, `занятость на ${host} видна`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
});

test('переживший остановку потомок записан в базу аренды вместе со временем старта', async () => {
  const database = join(mkdtempSync(join(tmpdir(), 'ports-')), 'resources.sqlite');
  // Зомби: сигнал доходит, но процесс остаётся в таблице, пока родитель
  // (exec'нутый sleep) его не подберёт, — так он «переживает» остановку.
  const parent = spawn('/bin/sh', ['-c', 'sleep 0 & exec sleep 30'], { stdio: 'ignore' });
  try {
    let zombie: number | undefined;
    for (let i = 0; i < 100 && !zombie; i++) {
      await new Promise((r) => setTimeout(r, 20));
      zombie = (await processTable()).find((r) => r.ppid === parent.pid)?.pid;
    }
    assert.ok(zombie, 'зомби-потомок найден');
    const marked = processInventory.marked;
    const ghost = zombie;
    processInventory.marked = () => Promise.resolve([ghost]);
    try {
      const error = await leaseScope
        .run({ database, owner: 'attempt-1', ports: [] }, () =>
          command([process.execPath, '-e', ''], process.cwd(), {
            contain: true,
            activity: { kind: 'step', label: 'dev-server' },
            timeoutMs: 30000,
          }),
        )
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      assert.ok(error instanceof TaskFailure && error.diagnosis === 'process-reap', String(error));
    } finally {
      processInventory.marked = marked;
    }
    const records = survivorRecords(database);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.pid, zombie);
    assert.equal(records[0]!.owner, 'attempt-1');
    assert.equal(records[0]!.label, 'dev-server');
    assert.ok(records[0]!.start.length > 0);
  } finally {
    parent.kill('SIGKILL');
  }
});

test('gates-at: порт ресурса держит чужой процесс — отказ environment/resource-busy до gates, evidence нет', async () => {
  const port = await freePort();
  const ctx = fixture(port);
  write(ctx.repo.dir, { 'src/greet.js': greet });
  ctx.repo.git('add', '-A');
  ctx.repo.git('commit', '-q', '-m', 'greet');
  const context: GatesAtContext = {
    policy: ctx.policy,
    stateDir: ctx.state,
    repoPath: () => ctx.repo.dir,
    boundary: () => ({ hidden: [ctx.state], readable: [join(ctx.repo.dir, '.git')] }),
    resourceDatabase: join(ctx.state, 'resources.sqlite'),
  };
  const recorded: EvidenceRecord[] = [];
  const foreign = await holder(port);
  try {
    const error = await runGatesAt(context, {
      id: 'GA-busy',
      repositoryId: 'app',
      sha: ctx.repo.head(),
      gates: ['unit'],
      record: (e) => recorded.push(e),
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof TaskFailure, String(error));
    assert.equal(error.kind, 'environment');
    assert.equal(error.diagnosis, 'resource-busy');
    assert.match(error.message, new RegExp(`Порт ${port} .*PID ${foreign.pid}`));
    assert.deepEqual(recorded, []);
  } finally {
    await stopHolder(foreign);
  }
  // Порт свободен — та же проверка проходит.
  const result = await runGatesAt(context, {
    id: 'GA-free',
    repositoryId: 'app',
    sha: ctx.repo.head(),
    gates: ['unit'],
    record: () => undefined,
  });
  assert.equal(result.failure, undefined, JSON.stringify(result.evidence.map((e) => e.summary)));
});
