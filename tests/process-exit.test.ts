import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { command } from '../src/environment/process.ts';

const moduleUrl = new URL('../src/environment/process.ts', import.meta.url).href;
test('A completed contained command leaves no pipe timeout holding its caller alive', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { command } from ${JSON.stringify(moduleUrl)};
    const result = await command([process.execPath, '-e', 'process.stdout.write("done")'], process.cwd(), {contain:true});
    const resolved = performance.now();
    process.once('beforeExit', () => console.log(JSON.stringify({
      idleMs:performance.now()-resolved, code:result.code, stdout:result.stdout,
    })));
  `,
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim()) as { idleMs: number; code: number; stdout: string };
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'done');
  assert.ok(out.idleMs < 2500, `natural exit waited ${out.idleMs}ms after command completion`);
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
for (const outcome of ['success', 'cancel', 'timeout'] as const)
  test(
    `Contained ${outcome} still closes inherited pipes and removes detached descendants`,
    { timeout: 15000 },
    async () => {
      const controller = new AbortController();
      let pid = 0;
      let output = '';
      try {
        const result = await command(
          [
            process.execPath,
            '-e',
            `
        const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
          {detached:true,stdio:['ignore','inherit','inherit']});
        child.unref();
        console.log('DESCENDANT='+child.pid);
        ${outcome === 'success' ? '' : 'setInterval(()=>{},1000);'}
      `,
          ],
          process.cwd(),
          {
            contain: true,
            timeoutMs: outcome === 'timeout' ? 1000 : 10000,
            signal: controller.signal,
            onRawStdout: (chunk) => {
              output += chunk;
              const match = /DESCENDANT=(\d+)/.exec(output);
              if (match) {
                pid = Number(match[1]);
                if (outcome === 'cancel') controller.abort();
              }
            },
          },
        );
        assert.ok(pid > 0, 'descendant was started');
        assert.equal(result.code === 0, outcome === 'success');
        assert.equal(result.timedOut, outcome === 'timeout');
        assert.equal(result.diagnostics.aborted, outcome === 'cancel');
        const deadline = Date.now() + 3000;
        while (alive(pid) && Date.now() < deadline) await delay(20);
        assert.equal(alive(pid), false, 'detached descendant no longer holds inherited pipes');
      } finally {
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      }
    },
  );
