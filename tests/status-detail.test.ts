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
import { cliDataSchemas, type ControlState } from '../src/contracts/index.ts';
import type { Harness } from '../src/control/harness.ts';
import { attemptView } from '../src/projections/index.ts';
import { diagnoseState } from '../src/explain/diagnose.ts';
import { approve, bin, implement } from './runner-fixture.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
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
    assert.ok(view.lease.sinceHeartbeatMs! < ctx.policy.leaseMs);
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

/** Поля паузы control: остальное (политика, ожидания) не трогается. */
const pauseWith = (h: Harness, pause: Partial<ControlState>) =>
  h.store.transact('scheduler.paused', (tx) =>
    tx.setControl({
      ...tx.control(),
      paused: false,
      pauseReason: undefined,
      pausedAt: undefined,
      pauseOperation: undefined,
      pauseFailures: undefined,
      ...pause,
    }),
  );

test('status --detail: остановка выдачи совпадает с explain для каждой причины паузы', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  writeFileSync(
    join(ctx.state, 'binding.json'),
    JSON.stringify({ policy: ctx.policy, baseDir: ctx.repo.dir }),
  );
  const h = ctx.open();
  ready(h.engine, graphOf({ a: [] }));
  h.engine.release('c1');
  const at = '2026-11-03T00:00:00.000Z';
  const cases: [string, Partial<ControlState>, Record<string, unknown>][] = [
    ['не запускали', { paused: true }, { liftedByRun: true, action: 'wait' }],
    ['shutdown', { paused: true, pauseReason: 'shutdown', pausedAt: at }, { liftedByRun: true }],
    [
      'operator',
      { paused: true, pauseReason: 'operator', pausedAt: at },
      { action: 'resume-queue' },
    ],
    [
      'reconfigure',
      { paused: true, pauseReason: 'reconfigure', pausedAt: at, pauseOperation: 'op-1' },
      { action: 'wait', operation: 'op-1' },
    ],
    ['base-check', { paused: true, pauseReason: 'base-check', pausedAt: at }, { action: 'wait' }],
    [
      'runtime environment',
      { paused: true, pauseReason: 'runtime', pausedAt: at, pauseFailures: ['environment'] },
      { action: 'fix-environment', failures: ['environment'] },
    ],
    [
      'runtime provider-auth',
      { paused: true, pauseReason: 'runtime', pausedAt: at, pauseFailures: ['provider-auth'] },
      { action: 'fix-access', failures: ['provider-auth'] },
    ],
    ['без паузы', { paused: false }, {}],
  ];
  for (const [name, pause, expected] of cases) {
    pauseWith(h, pause);
    const status = h.status(undefined, { detail: true });
    assert.ok(cliDataSchemas.status.safeParse(status).success, name);
    const queue = status.detail!.queue;
    assert.equal(queue.paused, pause.paused, name);
    for (const [k, v] of Object.entries(expected))
      assert.deepEqual((queue as Record<string, unknown>)[k], v, `${name}: ${k}`);
    // explain по той же базе: диагноз готового поручения на claim.
    const { diagnoses } = await diagnoseState({
      stateDir: ctx.state,
      policy: ctx.policy,
      baseDir: ctx.repo.dir,
      workId: 'a',
      adapters: {
        claude: cliAdapter('claude', { executable: bin('fake-claude') }),
        codex: cliAdapter('codex', { executable: bin('fake-codex') }),
      },
    });
    const work = diagnoses.find((d) => d.workId === 'a')!;
    if (pause.paused)
      assert.deepEqual(
        { code: queue.code, cause: queue.cause, actor: queue.actor, action: queue.action },
        { code: work.code, cause: work.cause, actor: work.actor, action: work.action },
        name,
      );
    else assert.equal(queue.action, undefined, name);
  }
  h.close();
});

test('status --detail: пауза отказа runtime — классы и сообщение последнего отказа этих классов', () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  ready(h.engine, graphOf({ a: [] }));
  const a = h.engine.claim('c1')!;
  h.engine.fail(a.id, a.token, 'Error: доступ провайдера отозван', { kind: 'provider-auth' });
  const detail = h.status(undefined, { detail: true }).detail!;
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
  h.close();
});

test('attemptView: стадия — последний незакрытый замер; владение истекло — stale; gates — обязательные на текущем SHA', () => {
  const cand = 'a'.repeat(40);
  const integ = 'b'.repeat(40);
  const old = 'c'.repeat(40);
  const base = {
    id: 'r1',
    workId: 'w',
    attempt: 1,
    status: 'active',
    phase: 'integrating' as const,
    owner: 'c1',
    runtime: 'claude',
    startedAt: '2026-01-01T00:00:00.000Z',
    leaseUntil: Date.parse('2026-01-01T00:00:30.000Z'),
    candidateSha: cand,
    integrationSha: integ,
    timings: [
      {
        id: 't1',
        stage: 'implementation',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:10.000Z',
        outcome: 'passed' as const,
      },
      { id: 't2', stage: 'integration-wait', startedAt: '2026-01-01T00:00:11.000Z' },
      { id: 't3', stage: 'integration-test:unit', startedAt: '2026-01-01T00:00:12.000Z' },
    ],
    evidence: [
      { kind: 'test' as const, phase: 'candidate' as const, sha: cand, gate: 'unit', passed: true },
      {
        kind: 'test' as const,
        phase: 'integration' as const,
        sha: integ,
        gate: 'lint',
        passed: false,
      },
      {
        kind: 'test' as const,
        phase: 'integration' as const,
        sha: integ,
        gate: 'lint',
        passed: true,
      },
      {
        kind: 'test' as const,
        phase: 'integration' as const,
        sha: integ,
        gate: 'e2e',
        passed: false,
      },
      // Не считаются: проверка потребителя, gate вне обязательных, другой SHA, ревью.
      {
        kind: 'test' as const,
        phase: 'integration' as const,
        sha: integ,
        gate: 'unit',
        passed: true,
        consumer: 'other',
      },
      {
        kind: 'test' as const,
        phase: 'integration' as const,
        sha: integ,
        gate: 'extra',
        passed: true,
      },
      {
        kind: 'test' as const,
        phase: 'integration' as const,
        sha: old,
        gate: 'unit',
        passed: false,
      },
      {
        kind: 'review' as const,
        phase: 'integration' as const,
        sha: integ,
        gate: 'independent-review',
        passed: true,
      },
    ],
    requiredGates: ['unit', 'lint', 'e2e', 'lint'],
  };
  const now = Date.parse('2026-01-01T00:00:40.000Z');
  const view = attemptView(base, { now, leaseMs: 30_000 });
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
  assert.equal(view.gates.passed + view.gates.failed + view.gates.remaining, view.gates.required);

  // Равное начало двух незакрытых замеров — текущей считается позже записанная.
  const tie = attemptView(
    {
      ...base,
      timings: [
        { id: 'x', stage: 'candidate-environment:prepare', startedAt: '2026-01-01T00:00:05.000Z' },
        { id: 'y', stage: 'dependency-store', startedAt: '2026-01-01T00:00:05.000Z' },
      ],
    },
    { now, leaseMs: 30_000 },
  );
  assert.equal(tie.stage?.name, 'dependency-store');

  // Срок 0 (владение отозвано) — heartbeat не выводится.
  const revoked = attemptView({ ...base, leaseUntil: 0 }, { now, leaseMs: 30_000 });
  assert.deepEqual(revoked.lease, { owner: 'c1', leaseUntil: 0, leaseMs: 30_000, stale: true });

  // Кандидата ещё нет: записей фазы нет, все обязательные впереди; без
  // requiredGates — gates репозитория.
  const early = attemptView(
    { ...base, phase: 'running', candidateSha: undefined, requiredGates: undefined, timings: [] },
    { now, leaseMs: 30_000, repositoryGates: ['unit', 'lint'] },
  );
  assert.equal(early.stage, undefined);
  assert.deepEqual(early.gates, {
    phase: 'candidate',
    required: 2,
    passed: 0,
    failed: 0,
    remaining: 2,
  });
});
