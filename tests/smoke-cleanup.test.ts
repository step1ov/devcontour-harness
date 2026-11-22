import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupDataSchema, executionPolicySchema } from '../src/contracts/index.ts';
import { cleanupSmoke } from '../src/control/smoke-cleanup.ts';
import { approve, implement } from './runner-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { example } from './fixtures.ts';

const ID = 'LS-11111111-2222-4333-8444-555555555555';
const bridge = {
  setup: [{ id: 'up', command: ['node', '.harness/compose-bridge.mjs', 'setup'], timeoutMs: 1000 }],
  ready: [],
  teardown: [
    { id: 'down', command: ['node', '.harness/compose-bridge.mjs', 'teardown'], timeoutMs: 1000 },
  ],
};

/** Запись окружения smoke, оставшаяся `cleanup-failed`: дерева уже нет. */
function plant(state: string, options: { lifecycle?: unknown; id?: string } = {}) {
  const dir = join(state, 'gates-at', options.id ?? ID, 'artifacts', 'environment');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'environment.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      ownerPid: 999_999_999,
      cwd: join(state, 'gone', 'worktree'),
      lifecycle: options.lifecycle ?? bridge,
      policyDigest: 'x',
      status: 'cleanup-failed',
      runId: options.id ?? ID,
    }),
  );
  return file;
}
const policy = executionPolicySchema.parse(example('policy'));
const freshState = () => realpathSync(mkdtempSync(join(tmpdir(), 'harness-smoke-cleanup-')));

test('alpha.67 cleanup LS-*: дерева и ресурсов Docker с меткой нет — запись сверена в cleaned с событием; повтор — nothing-pending', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const file = plant(ctx.state);
  const fake = join(ctx.state, '..', 'fake-docker-' + process.pid);
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  const before = process.env.HARNESS_DOCKER_BIN;
  process.env.HARNESS_DOCKER_BIN = fake;
  const h = ctx.open();
  try {
    const data = cleanupDataSchema.parse(await h.cleanup(ID));
    assert.equal(data.status, 'cleaned');
    assert.deepEqual(data.status === 'cleaned' && data.reconciled, [
      {
        receipt: `gates-at/${ID}/artifacts/environment/environment.json`,
        from: 'cleanup-failed',
        worktree: 'absent',
        docker: 'absent',
      },
    ]);
    const receipt = JSON.parse(readFileSync(file, 'utf8')) as {
      status: string;
      reconciled: { from: string };
    };
    assert.equal(receipt.status, 'cleaned');
    assert.equal(receipt.reconciled.from, 'cleanup-failed');
    const events = h.events(0, 1000).events.filter((e) => e.type === 'environment.reconciled');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.runId, ID);
    assert.deepEqual(await h.cleanup(ID), { status: 'nothing-pending' });
    await assert.rejects(
      h.cleanup('LS-99999999-2222-4333-8444-555555555555'),
      (e: { code?: string }) => e.code === 'NOT_FOUND',
    );
  } finally {
    h.close();
    if (before === undefined) delete process.env.HARNESS_DOCKER_BIN;
    else process.env.HARNESS_DOCKER_BIN = before;
  }
});

test('alpha.67 cleanup LS-*: остались ресурсы Docker или Docker не ответил — NOT_READY, запись не меняется', async () => {
  const state = freshState();
  const file = plant(state);
  const record = () => assert.fail('событие без сверки');
  const left = cleanupSmoke({
    stateDir: state,
    policy,
    id: ID,
    roots: [state],
    record,
    docker: () => ({ containers: 1, volumes: 1, networks: 0 }),
  });
  await assert.rejects(left, (e: { code?: string; message: string }) => {
    assert.equal(e.code, 'NOT_READY');
    assert.match(e.message, /остались ресурсы Docker с меткой devcontour\.harness\.run=LS-/);
    return true;
  });
  await assert.rejects(
    cleanupSmoke({
      stateDir: state,
      policy,
      id: ID,
      roots: [state],
      record,
      docker: () => undefined,
    }),
    /Docker не ответил/,
  );
  assert.equal(
    (JSON.parse(readFileSync(file, 'utf8')) as { status: string }).status,
    'cleanup-failed',
  );
});

test('alpha.67 cleanup LS-*: lifecycle без Docker — сверка по отсутствию дерева (docker: not-used)', async () => {
  const state = freshState();
  plant(state, {
    lifecycle: {
      setup: [],
      ready: [],
      teardown: [{ id: 'down', command: ['true'], timeoutMs: 1000 }],
    },
  });
  const events: unknown[] = [];
  const data = await cleanupSmoke({
    stateDir: state,
    policy,
    id: ID,
    roots: [state],
    record: (_id, payload) => events.push(payload),
    docker: () => assert.fail('Docker не нужен'),
  });
  assert.equal(data.status, 'cleaned');
  assert.equal(events.length, 1);
  assert.deepEqual((events[0] as { docker: string }).docker, 'not-used');
});
