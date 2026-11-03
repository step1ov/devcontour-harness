/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Фикстура правит сырой JSON политики и графа; ответ CLI читается как есть.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cliDataSchemas } from '../src/contracts/index.ts';
import { attemptView } from '../src/projections/index.ts';
import { approve, implement } from './runner-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { graphOf, ready } from './engine-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('status --detail: стадия удержанного gate, длительность, владение и счёт gates; без флага — прежний ответ', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-hold-'));
  const hold = join(dir, 'release');
  const slow = `
const fs = require('fs');
const start = Date.now();
while (!fs.existsSync(${JSON.stringify(hold)}) && Date.now() - start < 120000)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,
  '<testsuite><testcase classname="slow" name="slow"></testcase></testsuite>');
`;
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    files: { 'test/slow.js': slow },
    policy: (p) => {
      const gates = (p as any).repositories[0].gates as any[];
      gates.push({
        ...structuredClone(gates[0]),
        id: 'slow',
        command: [process.execPath, 'test/slow.js'],
      });
    },
    graph: (g) => ((g as any).orders[0].gates = ['unit', 'slow']),
  });
  // Привязка состояния для CLI (как после `harness run --policy`).
  writeFileSync(
    join(ctx.state, 'binding.json'),
    JSON.stringify({ policy: ctx.policy, baseDir: ctx.repo.dir }),
  );
  const h = ctx.open();
  const running = h.run({ graph: ctx.graph, author: 'claude' });
  try {
    const stageNow = () => h.status(undefined, { detail: true }).detail!.attempts[0]?.stage?.name;
    const giveUp = Date.now() + 120_000;
    while (stageNow() !== 'candidate-test:slow' && Date.now() < giveUp)
      await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 60));

    const status = h.status(undefined, { detail: true });
    assert.ok(cliDataSchemas.status.safeParse(status).success, 'ответ в договоре status');
    const detail = status.detail!;
    assert.deepEqual(detail.queue, { paused: false });
    assert.equal(detail.attempts.length, 1);
    const view = detail.attempts[0]!;
    const a = h.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(view.runId, a.id);
    assert.equal(view.workId, 'add-greeting');
    assert.equal(view.phase, 'verifying');
    assert.equal(view.stage?.name, 'candidate-test:slow');
    assert.equal(view.stage?.family, 'candidate-test');
    assert.ok(view.stage.elapsedMs >= 50, JSON.stringify(view.stage));
    assert.ok(view.elapsedMs >= view.stage.elapsedMs);
    assert.deepEqual(view.gates, {
      phase: 'candidate',
      required: 2,
      passed: 1,
      failed: 0,
      remaining: 1,
    });
    assert.equal(view.lease.owner, a.owner);
    assert.equal(view.lease.leaseMs, ctx.policy.leaseMs);
    assert.equal(view.lease.stale, false);
    assert.ok(view.lease.sinceHeartbeatMs < ctx.policy.leaseMs);
    assert.ok(!JSON.stringify(status).includes(a.token), 'токен не в ответе');

    // Тот же снимок через CLI; без --detail поля detail нет.
    const run = async (args: string[]) =>
      JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            ['--import', import.meta.resolve('tsx'), cli, ...args],
            { env: { ...process.env, NODE_OPTIONS: '' } },
          )
        ).stdout,
      ) as { ok: boolean; data: any };
    const viaCli = await run(['status', '--state', ctx.state, '--detail']);
    assert.equal(viaCli.ok, true);
    assert.equal(viaCli.data.detail.attempts[0].stage.name, 'candidate-test:slow');
    const plain = await run(['status', '--state', ctx.state]);
    assert.equal(plain.ok, true);
    assert.equal('detail' in plain.data, false);
    assert.equal('detail' in h.status(), false);
  } finally {
    writeFileSync(hold, '');
    await running;
  }
  assert.equal(
    h.engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  assert.deepEqual(h.status(undefined, { detail: true }).detail!.attempts, []);
  h.close();
});

test('status --detail: остановка выдачи — причина, классы отказа, сообщение и действие тем же рассуждением, что explain', () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  // Очередь ещё не запускали: пауза без причины, её снимает run, а не отказ.
  assert.deepEqual(h.status(undefined, { detail: true }).detail!.queue, {
    paused: true,
    detail: 'Очередь ещё не запускали: её снимает harness run',
    code: 'PAUSED',
    cause: 'not-ready',
    actor: 'user',
    action: 'resume-queue',
  });
  h.engine.resume();
  assert.deepEqual(h.status(undefined, { detail: true }).detail!.queue, { paused: false });
  h.engine.pause('operator');
  let detail = h.status(undefined, { detail: true }).detail!;
  assert.deepEqual(
    { ...detail.queue, since: undefined },
    {
      paused: true,
      reason: 'operator',
      since: undefined,
      code: 'PAUSED',
      cause: 'operator-pause',
      actor: 'user',
      action: 'resume-queue',
    },
  );
  assert.ok(detail.queue.since);
  h.engine.resume();
  // Отказ, который повторится на любой работе, ставит паузу runtime с классом.
  ready(h.engine, graphOf({ a: [] }));
  const a = h.engine.claim('c1')!;
  h.engine.fail(a.id, a.token, 'Error: доступ провайдера отозван', { kind: 'provider-auth' });
  detail = h.status(undefined, { detail: true }).detail!;
  assert.deepEqual(
    { ...detail.queue, since: undefined },
    {
      paused: true,
      reason: 'runtime',
      since: undefined,
      detail: 'доступ провайдера отозван',
      failures: ['provider-auth'],
      code: 'RUNTIME_UNAVAILABLE',
      cause: 'provider-auth',
      actor: 'user',
      action: 'fix-access',
    },
  );
  assert.deepEqual(detail.attempts, [], 'проваленная попытка не активна');
  assert.ok(cliDataSchemas.status.safeParse(h.status(undefined, { detail: true })).success);
  h.close();
});

test('attemptView: стадия — последний незакрытый замер; владение истекло — stale; gates по последней записи', () => {
  const view = attemptView(
    {
      id: 'r1',
      workId: 'w',
      attempt: 1,
      status: 'active',
      phase: 'integrating',
      owner: 'c1',
      runtime: 'claude',
      startedAt: '2026-01-01T00:00:00.000Z',
      leaseUntil: Date.parse('2026-01-01T00:00:30.000Z'),
      timings: [
        {
          id: 't1',
          stage: 'implementation',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:10.000Z',
          outcome: 'passed',
        },
        { id: 't2', stage: 'integration-wait', startedAt: '2026-01-01T00:00:11.000Z' },
        { id: 't3', stage: 'integration-test:unit', startedAt: '2026-01-01T00:00:12.000Z' },
      ],
      evidence: [
        { kind: 'test', phase: 'candidate', gate: 'unit', passed: true },
        { kind: 'test', phase: 'integration', gate: 'lint', passed: false },
        { kind: 'test', phase: 'integration', gate: 'lint', passed: true },
        { kind: 'test', phase: 'integration', gate: 'e2e', passed: false },
        { kind: 'test', phase: 'integration', gate: 'unit', passed: true, consumer: 'other' },
        { kind: 'review', phase: 'candidate', gate: 'independent-review', passed: true },
      ],
      requiredGates: ['unit', 'lint', 'e2e'],
    },
    { now: Date.parse('2026-01-01T00:00:40.000Z'), leaseMs: 30_000 },
  );
  assert.deepEqual(view.stage, {
    name: 'integration-test:unit',
    family: 'integration-test',
    startedAt: '2026-01-01T00:00:12.000Z',
    elapsedMs: 28_000,
  });
  assert.equal(view.elapsedMs, 40_000);
  assert.deepEqual(view.lease, {
    owner: 'c1',
    leaseUntil: Date.parse('2026-01-01T00:00:30.000Z'),
    leaseMs: 30_000,
    sinceHeartbeatMs: 40_000,
    stale: true,
  });
  assert.deepEqual(view.gates, {
    phase: 'integration',
    required: 3,
    passed: 1,
    failed: 1,
    remaining: 1,
  });
});
