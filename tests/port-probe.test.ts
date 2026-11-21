import './temp-scope.ts';
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
import { doctor } from '../src/control/doctor.ts';
import { doctorDataSchema } from '../src/contracts/cli.ts';
import { osBootId } from '../src/environment/os-tools.ts';
import { DatabaseSync } from 'node:sqlite';
import { hostname } from 'node:os';
import { ResourcePool } from '../src/environment/resources.ts';
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

const listen = (port: number, host: string) =>
  `require('net').createServer().listen(${port}, ${JSON.stringify(host)}, () => console.log('up ' + process.pid)); setTimeout(() => {}, 120000);`;
/**
 * Процесс, слушающий порт (по умолчанию на 127.0.0.1); запущен тестом и им же
 * останавливается. `script` — свой код вместо слушателя: печатает
 * `up <pid слушателя>`, когда порт занят. Возвращает и PID слушателя.
 */
async function holder(
  port: number,
  detached = false,
  { host = '127.0.0.1', script }: { host?: string; script?: string } = {},
): Promise<ChildProcess & { listener: number }> {
  const child = spawn(process.execPath, ['-e', script ?? listen(port, host)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    detached,
  });
  const listener = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error('держатель порта завершился: ' + code)));
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /up (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
  });
  child.removeAllListeners('exit');
  return Object.assign(child, { listener });
}
/** Родитель, чей потомок слушает порт; оба живут, пока их не остановят. */
const parentOf = (port: number) => `
const { spawn } = require('child_process');
const c = spawn(process.execPath, ['-e', ${JSON.stringify(listen(port, '127.0.0.1'))}], { stdio: ['ignore', 'pipe', 'inherit'] });
c.stdout.on('data', (d) => process.stdout.write(d));
setTimeout(() => {}, 120000);
`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number) => {
  for (let i = 0; i < 200 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
};
const startOf = async (pid: number) => (await processTable(true)).find((r) => r.pid === pid)!.start;
const tempDatabase = () => join(mkdtempSync(join(tmpdir(), 'ports-')), 'resources.sqlite');
/** Можно ли привязать 127.0.0.1, пока порт на 0.0.0.0 занят (macOS — да, Linux — нет). */
async function loopbackBesideWildcard(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen({ host: '127.0.0.1', port, exclusive: true }, () => s.close(() => resolve(true)));
  });
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
const gate = (port: number, host = '127.0.0.1') => `
const net = require('net');
const s = net.createServer();
s.once('error', (e) => { console.error('gate: ' + e.code); process.exit(1); });
s.listen(${port}, ${JSON.stringify(host)}, () => s.close(() => require('./run.js')));
`;

function fixture(port: number, host?: string) {
  return setup({
    scenario: { writer: implement(), reviewer: approve() },
    files: { 'test/gate.js': gate(port, host) },
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

test('переживший — родитель держателя: остановлены оба, запись снята', async () => {
  const port = await freePort();
  const database = tempDatabase();
  const parent = await holder(port, true, { script: parentOf(port) });
  try {
    assert.notEqual(parent.listener, parent.pid, 'порт слушает потомок');
    recordSurvivors(
      { database, owner: 'earlier' },
      [{ pid: parent.pid!, start: await startOf(parent.pid!) }],
      'unit',
    );
    const warnings = await ensurePortsFree({ database, owner: 'now', ports: [{ id: 'p', port }] });
    assert.deepEqual(warnings, []);
    assert.ok(await gone(parent.listener), 'слушатель остановлен');
    await exited(parent);
    assert.equal(await portBusy(port), false);
    assert.deepEqual(survivorRecords(database), [], 'запись снята');
  } finally {
    await stopHolder(parent);
    if (alive(parent.listener)) process.kill(parent.listener, 'SIGKILL');
  }
});

test('записан потомок держателя (не предок) — порт занят чужим: resource-busy, никто не остановлен', async () => {
  const port = await freePort();
  const database = tempDatabase();
  // Держатель — родитель, слушающий сам; потомок — записанный процесс.
  const script = `
const { spawn } = require('child_process');
const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('up ' + process.pid + ' child ' + c.pid));
setTimeout(() => {}, 120000);
`;
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const child = await new Promise<number>((resolve) => {
    let out = '';
    parent.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /child (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
  });
  try {
    recordSurvivors(
      { database, owner: 'earlier' },
      [{ pid: child, start: await startOf(child) }],
      'unit',
    );
    const error = await ensurePortsFree({
      database,
      owner: 'now',
      ports: [{ id: 'p', port }],
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof TaskFailure && error.diagnosis === 'resource-busy', String(error));
    assert.match(error.message, new RegExp(`PID ${parent.pid} \\(node\\)`));
    assert.ok(alive(parent.pid!), 'держатель жив');
    assert.ok(alive(child), 'записанный потомок жив');
    assert.equal(survivorRecords(database).length, 1, 'запись не снята');
  } finally {
    if (alive(child)) process.kill(child, 'SIGKILL');
    await stopHolder(parent);
  }
});

test('lsof не ответил — держатель не определён: resource-busy с причиной', async () => {
  const port = await freePort();
  const held = await holder(port);
  const tool = processInventory.tool;
  processInventory.tool = (cmd, args, timeout, partial) =>
    cmd.endsWith('lsof')
      ? Promise.resolve({ error: 'lsof: ENOENT' })
      : tool(cmd, args, timeout, partial);
  try {
    const error = await ensurePortsFree({
      database: tempDatabase(),
      owner: 'now',
      ports: [{ id: 'p', port }],
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof TaskFailure && error.diagnosis === 'resource-busy', String(error));
    assert.match(error.message, /держатель не определён \(lsof: ENOENT\)/);
    assert.equal(held.exitCode, null);
  } finally {
    processInventory.tool = tool;
    await stopHolder(held);
  }
});

test('чужой процесс держит порт только на всех адресах, loopback свободен (AirPlay на macOS) — предупреждение, попытка проходит', async () => {
  const port = await freePort();
  const foreign = await holder(port, false, { host: '0.0.0.0' });
  try {
    if (!(await loopbackBesideWildcard(port))) {
      // Здесь wildcard-держатель занимает и loopback: это отказ, а не
      // предупреждение.
      const error = await ensurePortsFree({
        database: tempDatabase(),
        owner: 'now',
        ports: [{ id: 'web-port', port }],
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(error instanceof TaskFailure && error.diagnosis === 'resource-busy', String(error));
      return;
    }
    const warnings = await ensurePortsFree({
      database: tempDatabase(),
      owner: 'now',
      ports: [{ id: 'web-port', port }],
    });
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0]!,
      new RegExp(
        `^Порт ${port} \\(ресурс web-port\\) на всех адресах .*PID ${foreign.pid} \\(node\\).*AirPlay`,
      ),
    );
    const ctx = fixture(port);
    await runAll(ctx);
    const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.status, 'succeeded', attempts[0]!.error);
    assert.ok(
      attempts[0]!.timings?.some((s) => s.stage === `candidate-environment:port-shared:${port}`),
      JSON.stringify(attempts[0]!.timings?.map((s) => s.stage)),
    );
    assert.equal(foreign.exitCode, null, 'чужой процесс не остановлен');
  } finally {
    await stopHolder(foreign);
  }
});

test('doctor: порт ресурса занят чужим процессом — проблема с портом и PID; под арендой — не пробуется', async () => {
  const port = await freePort();
  const ctx = fixture(port);
  const database = join(ctx.state, 'resources.sqlite');
  const foreign = await holder(port);
  try {
    const report = await doctor(ctx.policy, {}, undefined, undefined, undefined, {
      resourceDatabase: database,
    });
    assert.deepEqual(
      report.ports?.map((p) => [p.id, p.port, p.status]),
      [['web-port', port, 'busy']],
    );
    assert.ok(
      report.problems.some((p) =>
        new RegExp(
          `^Порт ${port} \\(ресурс web-port\\) занят вне аренды: PID ${foreign.pid} \\(node\\).*resource-busy.*harness resume`,
        ).test(p),
      ),
      JSON.stringify(report.problems),
    );
    const pool = new ResourcePool(database);
    try {
      assert.ok(pool.tryAcquire(ctx.policy.resources, 'run', 'token', 30000));
      const leased = await doctor(ctx.policy, {}, undefined, undefined, undefined, {
        resourceDatabase: database,
      });
      assert.equal(leased.ports?.[0]?.status, 'leased');
      assert.ok(!leased.problems.some((p) => p.includes(`Порт ${port}`)));
    } finally {
      pool.release('token');
      pool.close();
    }
  } finally {
    await stopHolder(foreign);
  }
});

test('wildcard-only: gate, слушающий все адреса, падает — отказ попытки несёт предупреждение пробы; doctor — в warnings, не в problems', async () => {
  const port = await freePort();
  const foreign = await holder(port, false, { host: '0.0.0.0' });
  try {
    if (!(await loopbackBesideWildcard(port))) return; // покрыто тестом выше
    const ctx = fixture(port, '0.0.0.0');
    await runAll(ctx);
    const first = ctx.engine.read((v) => v.attempts('add-greeting'))[0]!;
    assert.equal(first.status, 'failed');
    assert.notEqual(first.failureKind, 'environment', 'провал gate — не отказ окружения');
    assert.match(
      first.error ?? '',
      new RegExp(`предупреждение пробы портов: Порт ${port} \\(ресурс web-port\\) на всех адресах`),
    );
    const report = await doctor(ctx.policy, {}, undefined, undefined, undefined, {
      resourceDatabase: join(ctx.state, 'resources.sqlite'),
    });
    assert.equal(report.ports?.[0]?.status, 'wildcard-only');
    assert.ok(!report.problems.some((p) => p.includes(`Порт ${port}`)), 'не в problems');
    assert.ok(report.warnings?.some((w) => w.startsWith(`Порт ${port} (ресурс web-port)`)));
    assert.doesNotThrow(() => doctorDataSchema.parse(report), 'договор CLI doctor');
    // explain не пробует порты.
    const quiet = await doctor(ctx.policy, {}, undefined, undefined, undefined, {
      resourceDatabase: false,
    });
    assert.equal(quiet.ports, undefined);
  } finally {
    await stopHolder(foreign);
  }
});

test('записи переживших: таблица прежней формы пересоздаётся; запись другой машины или загрузки ОС не учитывается', () => {
  const database = tempDatabase();
  const old = new DatabaseSync(database);
  old.exec(
    'CREATE TABLE survivors (pid INTEGER NOT NULL, start TEXT NOT NULL, owner TEXT NOT NULL, label TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (pid, start))',
  );
  old.prepare('INSERT INTO survivors VALUES (?,?,?,?,?)').run(1, 'x', 'o', 'l', Date.now());
  old.close();
  recordSurvivors({ database, owner: 'here' }, [{ pid: 42, start: 's' }], 'unit');
  assert.deepEqual(
    survivorRecords(database).map((r) => [r.pid, r.start, r.owner]),
    [[42, 's', 'here']],
  );
  const db = new DatabaseSync(database);
  const insert = db.prepare('INSERT INTO survivors VALUES (?,?,?,?,?,?,?)');
  insert.run(43, 's', 'other-host', osBootId() ?? '', 'o', 'l', Date.now());
  insert.run(44, 's', hostname(), 'other-boot', 'o', 'l', Date.now());
  db.close();
  assert.deepEqual(
    survivorRecords(database).map((r) => r.pid),
    [42],
    'чужая машина и прежняя загрузка не учитываются',
  );
});
