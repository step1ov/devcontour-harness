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
    for (const file of ['test.mjs'])
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
      current: Map<number, string>,
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
    new Map([
      [902, 'reused-after-inventory'],
      [904, 'tagged-orphan'],
    ]),
    'SIGKILL',
    (pid) => {
      killed.push(pid);
    },
  );
  assert.deepEqual(killed, [904], 'identity changed after discovery: do not signal that PID');
});
