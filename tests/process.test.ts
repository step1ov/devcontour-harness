/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- тест правит сырой JSON политики. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { command } from '../src/environment/process.ts';
import { composeRedactors, outputRedactor, redactor } from '../src/environment/redaction.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Процесс остановлен: опрос с запасом на доставку сигнала и уборку зомби. */
async function gone(pid: number, ms = 5000) {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test('T30: потоковая маска закрывает секрет на любой границе куска, включая перекрытия и кодирование', () => {
  const secret = 'private/token',
    text = 'prefix private/token private%2Ftoken suffix';
  for (let at = 0; at <= text.length; at++) {
    const mask = outputRedactor(composeRedactors(redactor([secret]), redactor(['suffix'])));
    const result = mask(text.slice(0, at)) + mask(text.slice(at)) + mask('', true);
    assert.equal(result, 'prefix [REDACTED] [REDACTED] [REDACTED]');
  }
  const custom = outputRedactor((s) => s.replaceAll('secret', '[REDACTED]'));
  assert.equal(custom('sec'), '');
  assert.equal(custom('ret'), '');
  assert.equal(custom('', true), '[REDACTED]');
  const overlap = outputRedactor(redactor(['abcd', 'cdef']));
  assert.equal(overlap('abcdefgh') + overlap('', true), '[REDACTED]efgh');
});

test('T30: зависший процесс отдаёт вывод до таймаута; диагностика хранит хвосты, сигнал и дерево процессов', async () => {
  let live = '',
    finished = false;
  const result = await command(
    [
      process.execPath,
      '-e',
      `process.stderr.write('stage: loading\\n'); process.stdout.write('тест: started\\n'); setInterval(()=>{},1000);`,
    ],
    process.cwd(),
    {
      timeoutMs: 3000,
      onOutput: (_stream, text) => {
        assert.equal(finished, false);
        live += text;
      },
    },
  );
  finished = true;
  assert.match(live, /stage: loading/);
  assert.match(result.diagnostics.stderrTail, /stage: loading/);
  assert.match(result.diagnostics.stdoutTail, /тест: started/);
  assert.ok(result.diagnostics.lastOutputAt);
  assert.equal(result.diagnostics.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.ok(result.diagnostics.signal);
  assert.ok(result.diagnostics.processTree);
});

test('T30: таймаут и отмена останавливают всех потомков запуска, включая отсоединившегося', async () => {
  const spawner = (detached: boolean) => `
    const { spawn } = require('child_process');
    const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: ${detached} });
    if (${detached}) c.unref();
    console.log('PID=' + c.pid);
    setInterval(()=>{},1000);`;
  for (const detached of [false, true]) {
    const timed = await command([process.execPath, '-e', spawner(detached)], process.cwd(), {
      timeoutMs: 1500,
      contain: true,
    });
    assert.equal(timed.timedOut, true);
    const pid = Number(/PID=(\d+)/.exec(timed.stdout)?.[1]);
    assert.ok(pid > 0, timed.stdout);
    assert.ok(await gone(pid), `потомок (detached=${detached}) остановлен по таймауту`);

    const controller = new AbortController();
    let child = 0;
    await command([process.execPath, '-e', spawner(detached)], process.cwd(), {
      signal: controller.signal,
      contain: true,
      onOutput: (_s, text) => {
        const seen = /PID=(\d+)/.exec(text);
        if (seen) {
          child = Number(seen[1]);
          setTimeout(() => controller.abort(), 200);
        }
      },
    }).catch(() => undefined);
    assert.ok(child > 0, 'отменённый запуск сообщил потомка');
    assert.ok(await gone(child), `потомок (detached=${detached}) остановлен отменой`);
  }
});

test('T30: зависший writer с потомком — отказ по времени; потомок остановлен; секрет из потокового лога нигде не сохранён', async () => {
  const canary = 'canary-t30-9b2e-secret';
  process.env.HARNESS_T30_SECRET = canary;
  try {
    for (const spawnHanging of [true, 'detached'] as const) {
      const ctx = setup({
        scenario: {
          writer: {
            ...implement(),
            earlyStderr: 'loading ' + canary + ' and waiting for provider',
            spawnHanging,
            sleepMs: 60_000,
          },
          reviewer: approve(),
        },
        policy: (p: any) => {
          p.environment.secrets = { RUN_TOKEN: 'HARNESS_T30_SECRET' };
          // Запас на запуск fixture под нагрузкой: потомок должен появиться до предела.
          p.runTimeoutMs = 10_000;
          p.maxAttempts = 1;
        },
      });
      await runAll(ctx);
      const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
      assert.equal(a.status, 'failed');
      assert.equal(a.failureKind, 'timeout', a.error);
      const pid = Number(readFileSync(`${ctx.scenarioPath}.writer.0.child.pid`, 'utf8'));
      assert.ok(await gone(pid), `потомок writer (${spawnHanging}) остановлен`);
      ctx.store.close();
      const stored = files(ctx.state);
      const logs = stored.filter((f) => f.endsWith('runtime.log'));
      assert.ok(logs.length, 'потоковый лог вызова сохранён');
      assert.ok(
        logs.some((f) => readFileSync(f, 'utf8').includes('loading [REDACTED]')),
        'вывод сохранён замаскированным',
      );
      // Ни лог, ни артефакты, ни база (события, учёт вызовов, попытки) не держат значения.
      for (const file of stored)
        assert.ok(!readFileSync(file).includes(canary), 'секрет в ' + file);
    }
  } finally {
    delete process.env.HARNESS_T30_SECRET;
  }
});
