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
import { replayContainerEnv } from '../src/environment/lifecycle.ts';
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
const phaseEnv = {
  DOCKER_HOST: null,
  DOCKER_CONTEXT: null,
  DOCKER_CONFIG: null,
  DOCKER_CERT_PATH: null,
  DOCKER_TLS_VERIFY: null,
  CONTAINER_HOST: null,
  CONTAINER_CONNECTION: null,
  PATH: process.env.PATH ?? null,
  HOME: process.env.HOME ?? null,
};
function plant(
  state: string,
  options: { lifecycle?: unknown; id?: string; containerEnv?: unknown } = {},
) {
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
      ...(options.containerEnv === null ? {} : { containerEnv: options.containerEnv ?? phaseEnv }),
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
  const beforePodman = process.env.HARNESS_PODMAN_BIN;
  process.env.HARNESS_DOCKER_BIN = fake;
  // Podman на машине теста нет: сверка не зависит от того, установлен ли он.
  process.env.HARNESS_PODMAN_BIN = fake + '-podman-missing';
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
    if (beforePodman === undefined) delete process.env.HARNESS_PODMAN_BIN;
    else process.env.HARNESS_PODMAN_BIN = beforePodman;
  }
});

test('alpha.67 cleanup LS-*: остались ресурсы Docker или Docker не ответил — NOT_READY, запись не меняется', async () => {
  const state = freshState();
  const file = plant(state);
  const record = () => assert.fail('событие без сверки');
  await assert.rejects(
    cleanupSmoke({
      stateDir: state,
      policy,
      id: ID,
      roots: [state],
      record,
      docker: () => ({ containers: 1, volumes: 1, networks: 0 }),
    }),
    /остались ресурсы Docker с меткой devcontour\.harness\.run=LS-/,
  );
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

test('alpha.67 cleanup LS-*: шаги только из команд без контейнеров — сверка без запроса (docker: not-used)', async () => {
  const state = freshState();
  plant(state, {
    lifecycle: {
      setup: [{ id: 'up', command: ['mkdir', '-p', 'x'], timeoutMs: 1000 }],
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
    docker: () => assert.fail('контейнеры не нужны'),
  });
  assert.equal(data.status, 'cleaned');
  assert.deepEqual((events[0] as { docker: string }).docker, 'not-used');
});

const bridgeOnNode = {
  setup: [{ id: 'up', command: ['node', '.harness/environment.mjs', 'up'], timeoutMs: 1000 }],
  ready: [],
  teardown: [
    { id: 'down', command: ['node', '.harness/environment.mjs', 'down'], timeoutMs: 1000 },
  ],
};

test('alpha.67 cleanup LS-*: мост на node — спрашиваются docker и podman по метке; остались — NOT_READY; CLI нет — NOT_READY', async () => {
  const state = freshState();
  const file = plant(state, { lifecycle: bridgeOnNode });
  const asked: string[] = [];
  await assert.rejects(
    cleanupSmoke({
      stateDir: state,
      policy,
      id: ID,
      roots: [state],
      record: () => assert.fail('событие без сверки'),
      docker: (_id, ctx) => (
        asked.push(ctx.bin),
        ctx.bin === 'podman'
          ? { containers: 1, volumes: 0, networks: 0 }
          : { containers: 0, volumes: 0, networks: 0 }
      ),
    }),
    /остались ресурсы Podman/,
  );
  assert.deepEqual(asked, ['docker', 'podman']);
  // Ни одного CLI в PATH фазы, а мост может их вызывать — не сверяется.
  await assert.rejects(
    cleanupSmoke({
      stateDir: state,
      policy,
      id: ID,
      roots: [state],
      record: () => assert.fail('событие без сверки'),
      docker: () => 'missing',
    }),
    /не найден в PATH фазы/,
  );
  // Один CLI есть и пуст, второго нет — сверено.
  const events: unknown[] = [];
  await cleanupSmoke({
    stateDir: state,
    policy,
    id: ID,
    roots: [state],
    record: (_id, payload) => events.push(payload),
    docker: (_id, ctx) =>
      ctx.bin === 'podman' ? 'missing' : { containers: 0, volumes: 0, networks: 0 },
  });
  assert.deepEqual((events[0] as { docker: string }).docker, 'absent');
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { status: string }).status, 'cleaned');
});

test('alpha.67 cleanup LS-*: демон выбран в argv, шаг завёрнут или запись без containerEnv — демон не известен, NOT_READY', async () => {
  for (const [lifecycle, containerEnv, message] of [
    [
      {
        setup: [],
        ready: [],
        teardown: [
          {
            id: 'd',
            command: ['docker', '--context', 'remote', 'compose', 'down'],
            timeoutMs: 1000,
          },
        ],
      },
      undefined,
      /демон выбран в argv \(--context\)/,
    ],
    [
      {
        setup: [],
        ready: [],
        teardown: [
          {
            id: 'd',
            command: ['env', 'DOCKER_HOST=tcp://x', 'docker', 'compose', 'down'],
            timeoutMs: 1000,
          },
        ],
      },
      undefined,
      /завёрнут в env/,
    ],
    [
      {
        setup: [],
        ready: [],
        teardown: [{ id: 'd', command: ['sh', '-c', 'podman compose down'], timeoutMs: 1000 }],
      },
      undefined,
      /строка оболочки sh -c/,
    ],
    [bridgeOnNode, null, /без containerEnv/],
  ] as const) {
    const state = freshState();
    plant(state, { lifecycle, containerEnv });
    await assert.rejects(
      cleanupSmoke({
        stateDir: state,
        policy,
        id: ID,
        roots: [state],
        record: () => assert.fail('событие без сверки'),
        docker: () => ({ containers: 0, volumes: 0, networks: 0 }),
      }),
      message,
    );
  }
});

test('alpha.67 cleanup LS-*: запрос идёт с окружением фазы — демон фазы задан, селекторы этого процесса сняты', async () => {
  const state = freshState();
  plant(state, {
    lifecycle: {
      setup: [{ id: 'up', command: ['podman', 'compose', 'up'], timeoutMs: 1000 }],
      ready: [],
      teardown: [{ id: 'down', command: ['podman', 'compose', 'down'], timeoutMs: 1000 }],
    },
    containerEnv: { ...phaseEnv, CONTAINER_HOST: 'ssh://remote/run/podman.sock' },
  });
  const before = { host: process.env.DOCKER_HOST, ctx: process.env.DOCKER_CONTEXT };
  process.env.DOCKER_HOST = 'tcp://ambient:2375';
  process.env.DOCKER_CONTEXT = 'ambient';
  const seen: NodeJS.ProcessEnv[] = [];
  try {
    await cleanupSmoke({
      stateDir: state,
      policy,
      id: ID,
      roots: [state],
      record: () => {},
      docker: (_id, ctx) => (seen.push(ctx.env), { containers: 0, volumes: 0, networks: 0 }),
    });
  } finally {
    for (const [k, v] of [
      ['DOCKER_HOST', before.host],
      ['DOCKER_CONTEXT', before.ctx],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.CONTAINER_HOST, 'ssh://remote/run/podman.sock');
  assert.equal(seen[0]!.DOCKER_HOST, undefined);
  assert.equal(seen[0]!.DOCKER_CONTEXT, undefined);
  assert.equal(seen[0]!.PATH, process.env.PATH);
  // Повтор teardown по записи (дерево на месте) — те же правила.
  const env: NodeJS.ProcessEnv = { DOCKER_HOST: 'tcp://ambient', PATH: '/x' };
  replayContainerEnv(env, { DOCKER_HOST: null, DOCKER_CONTEXT: 'phase', PATH: '/bin' });
  assert.deepEqual(env, { DOCKER_CONTEXT: 'phase', PATH: '/bin' });
});

test('alpha.67 cleanup LS-*: запись без рабочего дерева — NOT_READY, не сверка', async () => {
  const state = freshState();
  const file = plant(state);
  const receipt = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete receipt.cwd;
  writeFileSync(file, JSON.stringify(receipt));
  await assert.rejects(
    cleanupSmoke({
      stateDir: state,
      policy,
      id: ID,
      roots: [state],
      record: () => assert.fail('событие без сверки'),
      docker: () => ({ containers: 0, volumes: 0, networks: 0 }),
    }),
    /нет рабочего дерева/,
  );
});
