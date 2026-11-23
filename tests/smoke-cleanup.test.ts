/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тест правит сырой JSON политики до разбора схемой.
 */
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
import { cleanupDataSchema, digestOf, executionPolicySchema } from '../src/contracts/index.ts';
import { cleanupSmoke } from '../src/control/smoke-cleanup.ts';
import {
  CONTAINER_SELECTOR_KEYS,
  cleanupEnvironment,
  executionEnvironment,
  replayContainerEnv,
  withEnvironment,
} from '../src/environment/lifecycle.ts';
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
  options: {
    lifecycle?: unknown;
    id?: string;
    containerEnv?: unknown;
    containerIdentity?: unknown;
  } = {},
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
      ...(options.containerIdentity === null
        ? {}
        : { containerIdentity: options.containerIdentity ?? { docker: 'daemon-1' } }),
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
  // Демон фазы — daemon-1: `info` называет его, ресурсов с меткой нет.
  writeFileSync(fake, '#!/bin/sh\n[ "$1" = info ] && echo daemon-1\nexit 0\n');
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

const same = (id: string) => () => Promise.resolve({ id });
const run = (state: string, over: Partial<Parameters<typeof cleanupSmoke>[0]> = {}) =>
  cleanupSmoke({
    stateDir: state,
    policy,
    id: ID,
    roots: [state],
    record: () => assert.fail('событие без сверки'),
    identity: same('daemon-1'),
    docker: () => ({ containers: 0, volumes: 0, networks: 0 }),
    ...over,
  });

test('alpha.67 cleanup LS-*: остались ресурсы или демон не ответил — NOT_READY, запись не меняется', async () => {
  const state = freshState();
  const file = plant(state);
  await assert.rejects(
    run(state, { docker: () => ({ containers: 1, volumes: 1, networks: 0 }) }),
    /остались ресурсы Docker с меткой devcontour\.harness\.run=LS-/,
  );
  await assert.rejects(run(state, { docker: () => undefined }), /Docker не ответил/);
  await assert.rejects(
    run(state, { identity: () => Promise.resolve(undefined) }),
    /демон фазы не подтверждён/,
  );
  assert.equal(
    (JSON.parse(readFileSync(file, 'utf8')) as { status: string }).status,
    'cleanup-failed',
  );
});

test('alpha.67 cleanup LS-*: демон сейчас другой, чем у фазы (сменился контекст) — NOT_READY, хотя ресурсов у нового нет', async () => {
  const state = freshState();
  plant(state);
  await assert.rejects(
    run(state, { identity: same('daemon-2') }),
    /демон Docker сейчас другой, чем у фазы \(daemon-2 ≠ daemon-1\)/,
  );
});

test('alpha.67 cleanup LS-*: сверено только когда шаги вызывают docker/podman сами (или compose-bridge), демон тот же и меток нет', async () => {
  const state = freshState();
  plant(state, {
    lifecycle: {
      setup: [{ id: 'up', command: ['podman', 'compose', '-p', 'x', 'up'], timeoutMs: 1000 }],
      ready: [],
      teardown: [
        { id: 'down', command: ['podman', 'compose', '-p', 'x', 'down'], timeoutMs: 1000 },
      ],
    },
    containerIdentity: { podman: 'host|/store' },
  });
  const events: unknown[] = [];
  const asked: string[] = [];
  await run(state, {
    identity: (cli) => (asked.push(cli), Promise.resolve({ id: 'host|/store' })),
    docker: (_id, ctx) => (asked.push(ctx.bin), { containers: 0, volumes: 0, networks: 0 }),
    record: (_id, payload) => events.push(payload),
  });
  assert.deepEqual(asked, ['podman', 'podman']);
  assert.deepEqual((events[0] as { docker: string }).docker, 'absent');
});

test('alpha.67 cleanup LS-*: демон не известен — непрозрачный шаг, глобальный параметр, выбор в argv, нет CLI, нет идентичности — NOT_READY', async () => {
  const cases: [unknown, Record<string, unknown>, RegExp][] = [
    [
      {
        setup: [],
        ready: [{ id: 'r', command: ['node', 'ready.mjs'] }],
        teardown: [{ id: 'd', command: ['docker', 'compose', 'down'] }],
      },
      {},
      /шаг node — не docker\/podman и не мост compose-bridge\.mjs/,
    ],
    [
      { setup: [], ready: [], teardown: [{ id: 'd', command: ['./test'] }] },
      {},
      /шаг test — не docker/,
    ],
    [
      { setup: [], ready: [], teardown: [{ id: 'd', command: ['true'] }] },
      {},
      /шаг true — не docker/,
    ],
    [
      {
        setup: [],
        ready: [],
        teardown: [{ id: 'd', command: ['docker', '-c', 'remote', 'compose', 'down'] }],
      },
      {},
      /демон выбран в argv \(-c\)/,
    ],
    [
      {
        setup: [],
        ready: [],
        teardown: [{ id: 'd', command: ['docker', '--log-level', 'debug', 'compose', 'down'] }],
      },
      {},
      /глобальный параметр docker --log-level/,
    ],
    [
      {
        setup: [],
        ready: [],
        teardown: [{ id: 'd', command: ['docker', '--config', '/other', 'ps'] }],
      },
      {},
      /демон выбран в argv \(--config\)/,
    ],
    [
      {
        setup: [],
        ready: [],
        teardown: [
          { id: 'd', command: ['env', 'DOCKER_HOST=tcp://x', 'docker', 'compose', 'down'] },
        ],
      },
      {},
      /демон выбран в argv \(DOCKER_HOST\)/,
    ],
    [bridge, { containerIdentity: null }, /без идентичности демона/],
    [
      bridge,
      { containerIdentity: { docker: null } },
      /идентичность демона Docker на момент фазы не получена/,
    ],
    [bridge, { identityNow: 'missing' }, /docker не найден в PATH фазы/],
  ];
  for (const [lifecycle, extra, message] of cases) {
    const state = freshState();
    const { identityNow, ...rest } = extra;
    plant(state, { lifecycle, ...rest });
    await assert.rejects(
      run(
        state,
        identityNow ? { identity: () => Promise.resolve({ missing: true as const }) } : {},
      ),
      message,
    );
  }
});

test('alpha.67 cleanup LS-*: запрос идёт с окружением фазы — демон фазы задан, селекторы этого процесса сняты; повтор teardown по записи — только селекторы', async () => {
  const state = freshState();
  plant(state, {
    lifecycle: {
      setup: [],
      ready: [],
      teardown: [{ id: 'down', command: ['podman', 'compose', 'down'], timeoutMs: 1000 }],
    },
    containerEnv: { ...phaseEnv, CONTAINER_HOST: 'ssh://remote/run/podman.sock' },
    containerIdentity: { podman: 'remote' },
  });
  const before = { host: process.env.DOCKER_HOST, ctx: process.env.DOCKER_CONTEXT };
  process.env.DOCKER_HOST = 'tcp://ambient:2375';
  process.env.DOCKER_CONTEXT = 'ambient';
  const seen: NodeJS.ProcessEnv[] = [];
  try {
    await run(state, {
      identity: (_cli, env) => (seen.push(env), Promise.resolve({ id: 'remote' })),
      docker: (_id, ctx) => (seen.push(ctx.env), { containers: 0, volumes: 0, networks: 0 }),
      record: () => {},
    });
  } finally {
    for (const [k, v] of [
      ['DOCKER_HOST', before.host],
      ['DOCKER_CONTEXT', before.ctx],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  assert.equal(seen.length, 2);
  for (const env of seen) {
    assert.equal(env.CONTAINER_HOST, 'ssh://remote/run/podman.sock');
    assert.equal(env.DOCKER_HOST, undefined);
    assert.equal(env.DOCKER_CONTEXT, undefined);
    assert.equal(env.PATH, process.env.PATH);
  }
  // Повтор teardown по записи: селекторы фазы, PATH и HOME — нынешние.
  const env: NodeJS.ProcessEnv = { DOCKER_HOST: 'tcp://ambient', PATH: '/now', HOME: '/home' };
  replayContainerEnv(
    env,
    { DOCKER_HOST: null, DOCKER_CONTEXT: 'phase', PATH: '/then', HOME: '/old' },
    CONTAINER_SELECTOR_KEYS,
  );
  assert.deepEqual(env, { DOCKER_CONTEXT: 'phase', PATH: '/now', HOME: '/home' });
});

test('alpha.67 cleanup LS-*: запись без рабочего дерева — NOT_READY, не сверка', async () => {
  const state = freshState();
  const file = plant(state);
  const receipt = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete receipt.cwd;
  writeFileSync(file, JSON.stringify(receipt));
  await assert.rejects(run(state), /нет рабочего дерева/);
});

test('alpha.67 lifecycle: запись окружения хранит идентичность демона шагов и окружение демона явно', async () => {
  const dir = freshState();
  const fake = join(dir, 'docker');
  writeFileSync(fake, '#!/bin/sh\n[ "$1" = info ] && echo daemon-xyz\nexit 0\n');
  chmodSync(fake, 0o755);
  const env = mkdtempSync(join(tmpdir(), 'harness-env-'));
  const before = process.env.HARNESS_DOCKER_BIN;
  process.env.HARNESS_DOCKER_BIN = fake;
  try {
    await withEnvironment(
      {
        setup: [],
        ready: [],
        teardown: [
          { id: 'down', command: ['docker', 'compose', '-p', 'x', 'version'], timeoutMs: 5000 },
        ],
      },
      dir,
      env,
      executionEnvironment(
        [],
        { DEVCONTOUR_RUN_ID: 'r1' },
        { PATH: dir + ':' + (process.env.PATH ?? '') },
      ),
      AbortSignal.timeout(20_000),
      () => Promise.resolve(),
    );
  } finally {
    if (before === undefined) delete process.env.HARNESS_DOCKER_BIN;
    else process.env.HARNESS_DOCKER_BIN = before;
  }
  const receipt = JSON.parse(readFileSync(join(env, 'environment.json'), 'utf8')) as {
    containerIdentity: Record<string, string | null>;
    containerEnv: Record<string, string | null>;
  };
  assert.deepEqual(receipt.containerIdentity, { docker: 'daemon-xyz' });
  assert.equal(receipt.containerEnv.DOCKER_HOST, null);
  assert.ok('HOME' in receipt.containerEnv);
});

test('alpha.67 cleanup по записи: демон сейчас другой, чем у фазы, — teardown не исполняется; тот же — исполняется с конфигурацией docker фазы', async () => {
  const dir = freshState();
  const tree = join(dir, 'tree');
  mkdirSync(tree);
  const fake = join(dir, 'docker');
  const log = join(dir, 'calls');
  writeFileSync(
    fake,
    `#!/bin/sh\necho "$* DOCKER_CONFIG=$DOCKER_CONFIG" >> ${log}\n[ "$1" = info ] && echo "$DAEMON_NOW"\nexit 0\n`,
  );
  chmodSync(fake, 0o755);
  const envDir = join(dir, 'env');
  mkdirSync(envDir);
  const lifecycle = {
    setup: [],
    ready: [],
    teardown: [{ id: 'down', command: [fake, 'compose', '-p', 'x', 'down'], timeoutMs: 5000 }],
  };
  const raw = structuredClone(example('policy')) as Record<string, any>;
  raw.repositories[0].lifecycle = lifecycle;
  // Ответ fake docker о демоне — переменной процесса, которую наследует фаза.
  raw.environment = { inherit: ['DAEMON_NOW'], values: {}, secrets: {} };
  const p = executionPolicySchema.parse(raw);
  const receiptPath = join(envDir, 'environment.json');
  const write = () =>
    writeFileSync(
      receiptPath,
      JSON.stringify({
        version: 1,
        ownerPid: 999_999_999,
        cwd: tree,
        lifecycle: p.repositories[0]!.lifecycle,
        policyDigest: digestOf(p.repositories[0]!.lifecycle),
        status: 'cleanup-failed',
        runId: ID,
        devcontourEnv: { DEVCONTOUR_REPOSITORY_ID: p.repositories[0]!.id },
        containerEnv: { ...phaseEnv, HOME: '/phase-home' },
        containerIdentity: { docker: 'daemon-1' },
      }),
    );
  write();
  const before = { bin: process.env.HARNESS_DOCKER_BIN, now: process.env.DAEMON_NOW };
  process.env.HARNESS_DOCKER_BIN = fake;
  try {
    process.env.DAEMON_NOW = 'daemon-2';
    await assert.rejects(
      cleanupEnvironment(receiptPath, p, [dir]),
      /Демон docker сейчас другой, чем у фазы \(daemon-2 ≠ daemon-1\) — teardown по записи не исполнен/,
    );
    assert.doesNotMatch(readFileSync(log, 'utf8'), /compose/);
    process.env.DAEMON_NOW = 'daemon-1';
    assert.deepEqual(await cleanupEnvironment(receiptPath, p, [dir]), { status: 'cleaned' });
    assert.match(
      readFileSync(log, 'utf8'),
      /compose -p x down DOCKER_CONFIG=\/phase-home\/\.docker/,
    );
  } finally {
    for (const [k, v] of [
      ['HARNESS_DOCKER_BIN', before.bin],
      ['DAEMON_NOW', before.now],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});
