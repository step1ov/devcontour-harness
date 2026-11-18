import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = fileURLToPath(new URL('../', import.meta.url));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, detail: string) {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await delay(20);
  assert.ok(check(), detail);
}

for (const detached of [false, true])
  for (const mode of ['failure', 'signal'] as const)
    test(
      `Parallel check ${mode} stops a ${detached ? 'detached' : 'grouped'} descendant that ignores SIGTERM`,
      { timeout: 20_000 },
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'check-runner-'));
        let pid: number | undefined;
        const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
          stdio: 'ignore',
        });
        const scripts = join(root, 'scripts');
        await mkdir(scripts);
        for (const file of ['static-checks.mjs', 'check-processes.mjs'])
          await copyFile(join(source, 'scripts', file), join(scripts, file));
        await writeFile(
          join(root, 'package.json'),
          JSON.stringify({
            type: 'module',
            scripts: {
              lint: 'node step.mjs lint',
              typecheck: 'node step.mjs typecheck',
              'test:affected': 'node step.mjs unexpected-next-stage',
            },
          }),
        );
        await writeFile(
          join(root, 'step.mjs'),
          `
      import {spawn} from 'node:child_process';
      import {existsSync,writeFileSync} from 'node:fs';
      const name=process.argv[2];
      if(name==='typecheck') {
        spawn(process.execPath,['-e',
          "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('descendant.pid',String(process.pid));setInterval(()=>{},1000)"
        ],{stdio:'ignore',detached:${detached}});
        setInterval(()=>{},1000);
      } else if(name==='lint') {
        const timer=setInterval(()=>{
          if(existsSync('descendant.pid')) {
            clearInterval(timer);
            ${mode === 'failure' ? 'process.exit(1)' : 'setInterval(()=>{},1000)'};
          }
        },20);
      } else writeFileSync('unexpected-stage','started');
    `,
        );
        const child = spawn(
          process.execPath,
          [join(scripts, 'static-checks.mjs'), ...['lint', 'typecheck']],
          {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        child.stdout.on('data', (chunk) => (output += String(chunk)));
        child.stderr.on('data', (chunk) => (output += String(chunk)));
        const closed = new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        try {
          await until(() => existsSync(join(root, 'descendant.pid')), 'descendant started');
          pid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'));
          if (mode === 'signal') child.kill('SIGTERM');
          assert.equal(await closed, mode === 'signal' ? 143 : 1, output);
          await until(() => !alive(pid!), 'descendant terminated after the check stopped');
          assert.ok(alive(unrelated.pid!), 'an unrelated process is left running');
          assert.equal(
            existsSync(join(root, 'unexpected-stage')),
            false,
            'later stages never started',
          );
        } finally {
          unrelated.kill('SIGKILL');
          child.kill('SIGKILL');
          if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
          await rm(root, { recursive: true, force: true });
        }
      },
    );

test('Fast tier omits its named slow test but still refuses explicit skip and todo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'test-tier-refusal-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'tests'));
    await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
    for (const file of ['test.mjs', 'test-scratch.mjs'])
      await copyFile(join(source, 'scripts', file), join(root, 'scripts', file));
    await writeFile(
      join(root, 'tests', 'probe.test.ts'),
      `
      import {test} from 'node:test';
      test(SLOW_NAME,()=>{throw new Error('excluded slow test ran')});
      test('unexpected skip',{skip:true},()=>{});
      test('unfinished assertion',{todo:true},()=>{});
    `.replace('SLOW_NAME', JSON.stringify('H1 differential oracle: ')),
    );
    const env = { ...process.env };
    // This child is a new runner, not a nested test worker.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['scripts/test.mjs', '--fast'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /must not contain skipped or todo/);
    assert.doesNotMatch(result.stdout + result.stderr, /excluded slow test ran/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Check cleanup never signals a reused PID or follows its unrelated children', async () => {
  const module: string = '../scripts/check-processes.mjs';
  const { ownedProcesses, signalSameProcesses } = (await import(module)) as {
    ownedProcesses(
      this: void,
      rows: { pid: number; ppid: number; start: string; marked: boolean }[],
      seen: Map<number, string>,
    ): Map<number, string>;
    signalSameProcesses(
      this: void,
      candidates: Map<number, string>,
      current: { pid: number; ppid: number; start: string; marked: boolean }[],
      signal: string,
      kill: (pid: number, signal: string) => void,
    ): void;
  };
  const seen = new Map([
    [901, 'old'],
    [902, 'owned'],
  ]);
  const candidates = ownedProcesses(
    [
      { pid: 901, ppid: 1, start: 'reused', marked: false },
      { pid: 903, ppid: 901, start: 'unrelated-child', marked: false },
      { pid: 902, ppid: 1, start: 'owned', marked: false },
      { pid: 904, ppid: 1, start: 'tagged-orphan', marked: true },
    ],
    seen,
  );
  assert.deepEqual(
    [...candidates],
    [
      [902, 'owned'],
      [904, 'tagged-orphan'],
    ],
  );
  const killed: number[] = [];
  signalSameProcesses(
    candidates,
    [
      { pid: 902, ppid: 1, start: 'reused-after-inventory', marked: false },
      { pid: 904, ppid: 1, start: 'tagged-orphan', marked: true },
    ],
    'SIGKILL',
    (pid) => {
      killed.push(pid);
    },
  );
  assert.deepEqual(killed, [904], 'identity changed after discovery: do not signal that PID');
});

test('Darwin process snapshots do not signal same-second PID replacements with a different invocation marker', async () => {
  const module: string = '../scripts/check-processes.mjs';
  type Row = { pid: number; ppid: number; start: string; marked: boolean };
  const { parsePsInventory, ownedProcesses, signalSameProcesses } = (await import(module)) as {
    parsePsInventory(this: void, stdout: string, mark: string): Row[];
    ownedProcesses(this: void, rows: Row[], seen: Map<number, string>): Map<number, string>;
    signalSameProcesses(
      this: void,
      candidates: Map<number, string>,
      rows: Row[],
      signal: string,
      kill: (pid: number, signal: string) => void,
    ): void;
  };
  const row = (pid: number, ppid: number, marker = '') =>
    `${pid} ${ppid} Fri Oct 30 08:00:00 2026 S node fixture ${marker ? 'DEVCONTOUR_CHECK_INVOCATION=' + marker : ''}`;
  const discovered = parsePsInventory(row(901, 1, 'owned'), 'owned');
  const candidates = ownedProcesses(discovered, new Map());
  const replacement = parsePsInventory(
    [row(901, 1, 'different'), row(902, 901)].join('\n'),
    'owned',
  );
  assert.ok(discovered[0]);
  assert.ok(replacement[0]);
  assert.equal(
    discovered[0].start,
    replacement[0].start,
    'real ps format cannot distinguish these start times',
  );
  const killed: number[] = [];
  signalSameProcesses(candidates, replacement, 'SIGKILL', (pid) => {
    killed.push(pid);
  });
  assert.equal(
    killed.length,
    0,
    'fresh invocation ownership is required even when PID/start match',
  );

  const current = parsePsInventory([row(901, 1, 'owned'), row(902, 901)].join('\n'), 'owned');
  const owned = ownedProcesses(current, new Map());
  signalSameProcesses(owned, current, 'SIGTERM', (pid) => {
    killed.push(pid);
  });
  assert.deepEqual(
    killed,
    [901, 902],
    'tagged orphans and their current untagged children still terminate',
  );

  assert.ok(current[0]);
  const rememberedOrphan = new Map([[903, current[0].start]]);
  signalSameProcesses(
    rememberedOrphan,
    parsePsInventory(row(903, 1), 'owned'),
    'SIGKILL',
    (pid) => {
      killed.push(pid);
    },
  );
  assert.deepEqual(killed, [901, 902], 'history alone cannot authorize killing an unmarked orphan');
});

type InventoryRow = { pid: number; ppid: number; start: string; marked: boolean };
type CheckProcessesModule = {
  inventory(this: void, mark?: string): Promise<InventoryRow[]>;
  inventoryWithRetry(
    this: void,
    read: (mark?: string) => Promise<InventoryRow[]>,
    mark: string | undefined,
    retry: { attempts?: number; backoffMs?: number; sleep?: (ms: number) => Promise<unknown> },
  ): Promise<InventoryRow[]>;
  checkProcesses(
    this: void,
    options?: {
      inventory?: (mark?: string) => Promise<InventoryRow[]>;
      retry?: { attempts?: number; backoffMs?: number };
      warn?: (message: string) => void;
    },
  ): {
    readonly stopping: boolean;
    readonly cause: string | undefined;
    readonly skippedRounds: number;
    readonly leakCheckSkipped: boolean;
    spawn(
      command: string,
      args: string[],
      options?: object,
    ): import('node:child_process').ChildProcess | undefined;
    stop(signal?: string): Promise<void>;
    dispose(): Promise<void>;
  };
};
const checkProcessesModule = async () => {
  const module: string = '../scripts/check-processes.mjs';
  return (await import(module)) as CheckProcessesModule;
};
const unavailable = () => new Error('Cannot inventory check processes (stub)');
const exited = (child: import('node:child_process').ChildProcess) =>
  new Promise<[number | null, NodeJS.Signals | null]>((done) =>
    child.once('exit', (code, signal) => done([code, signal])),
  );

test('A process snapshot that fails a few times is retried with backoff and then succeeds', async () => {
  const { inventoryWithRetry } = await checkProcessesModule();
  const rows = [{ pid: 901, ppid: 1, start: 'x', marked: true }];
  let calls = 0;
  const sleeps: number[] = [];
  const read = () => (++calls <= 2 ? Promise.reject(unavailable()) : Promise.resolve(rows));
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  assert.equal(await inventoryWithRetry(read, 'm', { attempts: 3, backoffMs: 100, sleep }), rows);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [100, 200], 'backoff doubles between attempts');
  calls = 0;
  await assert.rejects(
    inventoryWithRetry(read, 'm', { attempts: 2, backoffMs: 1, sleep }),
    /Cannot inventory/,
    'past its attempts the last error is reported to the caller',
  );
});

test('An unavailable process inventory never stops a step: rounds are skipped with a warning', async () => {
  const { checkProcesses } = await checkProcessesModule();
  const warnings: string[] = [];
  const exitCode = process.exitCode;
  const processes = checkProcesses({
    inventory: () => Promise.reject(unavailable()),
    retry: { attempts: 2, backoffMs: 1 },
    warn: (message) => warnings.push(message),
  });
  try {
    const child = processes.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], {
      stdio: 'ignore',
    });
    assert.ok(child);
    assert.deepEqual(await exited(child), [0, null], 'the step ran to its own end');
    assert.equal(processes.stopping, false, 'no snapshot failure stopped the check');
    assert.ok(processes.skippedRounds > 1, `rounds were skipped: ${processes.skippedRounds}`);
  } finally {
    await processes.dispose();
  }
  assert.equal(processes.cause, undefined);
  assert.equal(processes.leakCheckSkipped, true, 'the final line can say no leak check ran');
  assert.equal(process.exitCode, exitCode, 'an unavailable inventory does not fail the check');
  assert.equal(
    warnings.filter((w) => /skipping this inventory round/.test(w)).length,
    1,
    `one warning per failing streak: ${warnings.join('\n')}`,
  );
  assert.ok(
    warnings.some((w) => /leaked-process cleanup skipped/.test(w)),
    'the final cleanup names what it could not do',
  );
});

test('After transient snapshot failures a leaked descendant is still found and stopped', async () => {
  const { checkProcesses, inventory } = await checkProcessesModule();
  let failures = 4;
  const warnings: string[] = [];
  const processes = checkProcesses({
    inventory: (mark) => (failures-- > 0 ? Promise.reject(unavailable()) : inventory(mark)),
    retry: { attempts: 3, backoffMs: 1 },
    warn: (message) => warnings.push(message),
  });
  let leaked: number | undefined;
  try {
    // The step leaves a detached descendant behind and exits successfully.
    const child = processes.spawn(
      process.execPath,
      [
        '-e',
        `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
         c.unref(); console.log(c.pid);`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    assert.ok(child);
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += String(chunk)));
    assert.deepEqual(await exited(child), [0, null]);
    await until(() => /^\d+\s*$/.test(out), 'the descendant pid is printed');
    leaked = Number(out.trim());
    assert.ok(alive(leaked));
    await delay(600); // background rounds recover from the failing streak
  } finally {
    await processes.dispose();
  }
  assert.ok(leaked);
  await until(() => !alive(leaked), 'the leaked descendant is stopped by the final sweep');
  assert.equal(processes.stopping, true);
  assert.equal(processes.cause, undefined);
  assert.ok(
    !warnings.some((w) => /cleanup skipped/.test(w)),
    `ps answered at the end: ${warnings.join('\n')}`,
  );
});

test('A slow but working ps during a stop: running steps get SIGTERM at once, leaks SIGTERM first, no false survivor', async () => {
  const { checkProcesses, inventory } = await checkProcessesModule();
  const root = await mkdtemp(join(tmpdir(), 'check-inventory-'));
  const exitCode = process.exitCode;
  let slow = false;
  const processes = checkProcesses({
    inventory: async (mark) => {
      if (slow) await delay(2600);
      return inventory(mark);
    },
    retry: { attempts: 1 },
    warn: () => {},
  });
  let leaked: number | undefined;
  try {
    // A healthy sibling that exits on SIGTERM.
    const sibling = processes.spawn(
      process.execPath,
      ['-e', `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)`],
      { stdio: 'ignore' },
    );
    // A finished step that left a detached descendant recording SIGTERM.
    const leaker = processes.spawn(
      process.execPath,
      [
        '-e',
        `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
          `process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(join(root, 'term'))}, ''); process.exit(0); }); setInterval(() => {}, 1000)`,
        )}], { detached: true, stdio: 'ignore' });
         c.unref(); console.log(c.pid);`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    assert.ok(sibling && leaker);
    let out = '';
    leaker.stdout?.on('data', (chunk: Buffer) => (out += String(chunk)));
    assert.deepEqual(await exited(leaker), [0, null]);
    await until(() => /^\d+\s*$/.test(out), 'the descendant pid is printed');
    leaked = Number(out.trim());
    await delay(500); // the descendant installs its SIGTERM handler
    slow = true;
    const started = Date.now();
    const stopped = processes.stop('SIGTERM');
    assert.deepEqual(await exited(sibling), [0, null], 'the sibling got SIGTERM, not SIGKILL');
    assert.ok(Date.now() - started < 2000, 'running steps are signalled before ps answers');
    await stopped;
    assert.ok(existsSync(join(root, 'term')), 'the leaked descendant got SIGTERM first');
    await until(() => !alive(leaked!), 'the leaked descendant is gone');
    assert.equal(processes.cause, undefined, 'no false "survived bounded cleanup"');
    assert.equal(process.exitCode, exitCode);
    assert.equal(processes.leakCheckSkipped, false);
  } finally {
    await processes.dispose();
    if (leaked && alive(leaked)) process.kill(leaked, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('Without ps a stop sends SIGTERM to a running step group, then SIGKILL after 5 s', async () => {
  const { checkProcesses } = await checkProcessesModule();
  const exitCode = process.exitCode;
  const warnings: string[] = [];
  const processes = checkProcesses({
    inventory: () => Promise.reject(unavailable()),
    retry: { attempts: 1 },
    warn: (message) => warnings.push(message),
  });
  const pids: number[] = [];
  try {
    // A step and its same-group child both ignore SIGTERM.
    const ignoring = `process.on('SIGTERM', () => console.log('TERM ' + process.pid)); setInterval(() => {}, 1000)`;
    const step = processes.spawn(
      process.execPath,
      [
        '-e',
        `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
          `console.log('ready ' + process.pid); ${ignoring}`,
        )}], { stdio: 'inherit' }); console.log('ready ' + process.pid); ${ignoring}`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    assert.ok(step);
    let out = '';
    step.stdout?.on('data', (chunk: Buffer) => (out += String(chunk)));
    await until(() => (out.match(/ready \d+/g) ?? []).length === 2, `both ready: ${out}`);
    pids.push(...[...out.matchAll(/ready (\d+)/g)].map((m) => Number(m[1])));
    await delay(200);
    const started = Date.now();
    const result = exited(step);
    await processes.stop('SIGTERM');
    assert.deepEqual(await result, [null, 'SIGKILL']);
    const took = Date.now() - started;
    assert.ok(took >= 4500 && took < 9000, `SIGKILL after the 5 s grace: ${took} ms`);
    assert.equal((out.match(/TERM \d+/g) ?? []).length, 2, `the whole group got SIGTERM: ${out}`);
    for (const pid of pids) await until(() => !alive(pid), `${pid} is gone`);
    assert.equal(processes.leakCheckSkipped, true);
    assert.equal(process.exitCode, exitCode);
    assert.ok(warnings.some((w) => /leaked-process cleanup skipped/.test(w)));
  } finally {
    await processes.dispose();
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});
