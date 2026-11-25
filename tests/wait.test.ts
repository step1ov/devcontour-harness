import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestOf } from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { WAIT_EXIT_CODES, waitFor } from '../src/control/wait.ts';
import { waitDataSchema } from '../src/contracts/cli.ts';
import { engineOf, graphOf, ready, sha } from './engine-fixture.ts';

function accept(e: Engine, id: string, token: string) {
  e.phase(id, token, 'verifying', { candidateSha: sha('c') });
  for (const phase of ['candidate', 'integration'] as const) {
    const at = phase === 'candidate' ? sha('c') : sha('d');
    if (phase === 'integration') e.phase(id, token, 'integrating', { integrationSha: at });
    for (const kind of ['test', 'review'] as const)
      e.evidence(id, token, {
        kind,
        phase,
        sha: at,
        gate: kind === 'test' ? 'unit' : 'independent-review',
        passed: true,
        command: ['x'],
        exitCode: 0,
        log: '',
        digest: digestOf(kind + phase),
        summary: 'ok',
        ...(kind === 'review' ? { findings: [] } : {}),
      });
  }
  e.finish(id, token, sha('d'));
}

const later = (ms: number, fn: () => void) =>
  new Promise<void>((done) =>
    setTimeout(() => {
      fn();
      done();
    }, ms),
  );

test('wait: событие после начала — принятие работы; итог со строкой состояния; код 0', async () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [], b: [] }));
  const a = env.engine.claim('c1')!;
  const waiting = waitFor({
    stateDir: env.dir,
    policy: env.engine.policy,
    baseDir: env.dir,
    timeoutMs: 20_000,
    pollMs: 50,
  });
  await later(200, () => accept(env.engine, a.id, a.token));
  const data = await waiting;
  assert.equal(data.kind, 'accepted');
  assert.equal(data.workId, a.workId);
  assert.equal(data.event?.type, 'work.accepted');
  assert.match(data.status, /принято 1\/2/);
  assert.equal(WAIT_EXIT_CODES[data.kind], 0);
  waitDataSchema.parse(data);
  env.store.close();
});

test('wait: отказ попытки — failed со следующим шагом из explain; --until question пропускает accepted', async () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [], b: [] }));
  const a = env.engine.claim('c1')!;
  const b = env.engine.claim('c1')!;
  const waiting = waitFor({
    stateDir: env.dir,
    policy: env.engine.policy,
    baseDir: env.dir,
    until: ['failed'],
    timeoutMs: 20_000,
    pollMs: 50,
  });
  await later(150, () => accept(env.engine, a.id, a.token));
  await later(150, () => env.engine.fail(b.id, b.token, 'gate unit упал', { kind: 'gate' }));
  const data = await waiting;
  assert.equal(data.kind, 'failed', 'принятие пропущено: ждали только failed');
  assert.equal(data.workId, b.workId);
  assert.ok(data.next?.action, 'следующий шаг из explain');
  assert.equal(WAIT_EXIT_CODES[data.kind], 13);
  env.store.close();
});

test('wait: ничего не происходит — timeout с кодом 15; очередь без controller и попыток — stopped сразу', async () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [] }));
  env.engine.claim('c1');
  const started = Date.now();
  const data = await waitFor({
    stateDir: env.dir,
    policy: env.engine.policy,
    baseDir: env.dir,
    timeoutMs: 400,
    pollMs: 50,
  });
  assert.equal(data.kind, 'timeout');
  assert.ok(Date.now() - started >= 400);
  assert.equal(WAIT_EXIT_CODES[data.kind], 15);
  // Без активных попыток и роли controller ждать нечего.
  const idle = engineOf();
  ready(idle.engine, graphOf({ a: [] }));
  const stopped = await waitFor({
    stateDir: idle.dir,
    policy: idle.engine.policy,
    baseDir: idle.dir,
    timeoutMs: 20_000,
    pollMs: 50,
  });
  assert.equal(stopped.kind, 'stopped');
  assert.ok(stopped.waitedMs < 5000);
  env.store.close();
  idle.store.close();
});
