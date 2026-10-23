/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
 * Тест читает JSON-файлы bridge (receipt, labels) как есть.
 */
/**
 * compose-bridge примера Turbo Starter без Docker: вместо `docker` — fixture
 * CLI, который записывает argv и отвечает по своему состоянию. Проверяются
 * свойства безопасности моста (S03/S04/S06), которые не зависят от демона:
 * имя проекта на попытку/фазу, метки владельца, receipt до создания ресурсов,
 * env-файлы вне worktree и без значений в receipt, удаление только по меткам
 * run+project, отсутствие prune/context. Настоящий Docker —
 * tests/integration/starter-acceptance.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDir = fileURLToPath(new URL('../examples/turbo-starter/harness/', import.meta.url));

/** Fixture `docker`: модель compose, ресурсы по меткам, журнал вызовов. */
const fakeDocker = `#!/usr/bin/env node
const fs = require('fs');
const state = process.env.FAKE_DOCKER_STATE;
const s = JSON.parse(fs.readFileSync(state, 'utf8'));
const args = process.argv.slice(2);
s.calls.push(args);
const save = () => fs.writeFileSync(state, JSON.stringify(s));
const filters = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--filter') filters.push(args[i + 1].replace(/^label=/, ''));
const match = (r) => filters.every((f) => r.labels.includes(f));
const project = args.includes('--project-name') ? args[args.indexOf('--project-name') + 1] : undefined;
if (args[0] === 'compose' && args.includes('config')) {
  process.stdout.write(JSON.stringify(s.model));
} else if (args[0] === 'compose' && args.includes('create')) {
  const labels = JSON.parse(fs.readFileSync(args[args.lastIndexOf('-f') + 1], 'utf8')).services.postgres.labels;
  const l = Object.entries(labels).map(([k, v]) => k + '=' + v);
  s.resources.push({ kind: 'container', id: 'c-' + project, labels: l });
  s.resources.push({ kind: 'volume', id: project + '_data', labels: l });
  s.resources.push({ kind: 'network', id: 'n-' + project, labels: l });
} else if (args[0] === 'compose' && args.includes('down')) {
  if (s.downRemoves) s.resources = s.resources.filter((r) => !r.labels.includes('devcontour.harness.project=' + project));
} else if (args[0] === 'ps') {
  process.stdout.write(s.resources.filter((r) => r.kind === 'container' && match(r)).map((r) => r.id + ' name running').join('\\n'));
} else if (args[0] === 'volume' && args[1] === 'ls') {
  process.stdout.write(s.resources.filter((r) => r.kind === 'volume' && match(r)).map((r) => r.id).join('\\n'));
} else if (args[0] === 'network' && args[1] === 'ls') {
  process.stdout.write(s.resources.filter((r) => r.kind === 'network' && match(r)).map((r) => r.id + ' name').join('\\n'));
} else if (args[0] === 'rm' || (args[0] === 'volume' && args[1] === 'rm') || (args[0] === 'network' && args[1] === 'rm')) {
  const ids = args.filter((a) => !a.startsWith('-') && a !== 'rm' && a !== 'volume' && a !== 'network');
  s.resources = s.resources.filter((r) => !ids.includes(r.id));
}
save();
`;

const model = {
  name: 'should-be-dropped',
  services: {
    postgres: {
      image: 'postgres:16-alpine',
      volumes: [{ type: 'volume', source: 'postgres_data', target: '/var/lib/postgresql/data' }],
    },
  },
  volumes: { postgres_data: {} },
};

function setup(options: { model?: unknown; foreign?: unknown[]; downRemoves?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'starter-bridge-')));
  const wt = join(root, 'worktree');
  mkdirSync(wt);
  cpSync(harnessDir, join(wt, '.harness'), { recursive: true });
  const bin = join(root, 'docker');
  writeFileSync(bin, fakeDocker);
  chmodSync(bin, 0o755);
  const state = join(root, 'docker.json');
  writeFileSync(
    state,
    JSON.stringify({
      calls: [],
      model: options.model ?? model,
      downRemoves: options.downRemoves ?? true,
      // Чужой ресурс: метка того же проекта, но другой попытки, и совсем чужой.
      resources: options.foreign ?? [
        { kind: 'container', id: 'foreign-1', labels: ['com.docker.compose.project=other'] },
        { kind: 'volume', id: 'foreign-vol', labels: [] },
      ],
    }),
  );
  const envDir = join(root, 'artifacts', 'run-1', 'candidate', 'environment');
  mkdirSync(envDir, { recursive: true });
  const base = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    HX_BRIDGE_DOCKER: bin,
    HX_BRIDGE_PORTS: join(root, 'ports'),
    FAKE_DOCKER_STATE: state,
    DEVCONTOUR_ENVIRONMENT_DIR: envDir,
    DEVCONTOUR_RUN_ID: 'a8a37b17-97c0-484a-a0e0-2ea60dbc9482',
    DEVCONTOUR_PHASE: 'candidate',
    DEVCONTOUR_REPOSITORY_ID: 'starter',
    HX_DB_USER: 'harness',
    HX_DB_NAME: 'acceptance',
    HX_DB_PASSWORD: 'canary-secret-bridge-unit',
  };
  const bridge = (args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, [join(wt, '.harness', 'compose-bridge.mjs'), ...args], {
      cwd: wt,
      encoding: 'utf8',
      env: { ...base, ...env },
    });
  const docker = () =>
    JSON.parse(readFileSync(state, 'utf8')) as { calls: string[][]; resources: any[] };
  const receipt = () => JSON.parse(readFileSync(join(envDir, 'bridge', 'receipt.json'), 'utf8'));
  return { root, wt, envDir, bridge, docker, receipt };
}
const SETUP = ['setup', '--port', 'POSTGRES_PORT', '--secret', 'HX_DB_PASSWORD'];

test('S03/compose-bridge: проект и метки владельца на попытку/фазу/репозиторий', () => {
  const b = setup();
  const r = b.bridge(SETUP);
  assert.equal(r.status, 0, r.stderr);
  const receipt = b.receipt();
  assert.equal(receipt.project, 'hx-a8a37b1797c0-candidate-starter');
  assert.deepEqual(receipt.labels, {
    'devcontour.harness.run': 'a8a37b17-97c0-484a-a0e0-2ea60dbc9482',
    'devcontour.harness.phase': 'candidate',
    'devcontour.harness.repository': 'starter',
    'devcontour.harness.project': 'hx-a8a37b1797c0-candidate-starter',
  });
  const labels = JSON.parse(readFileSync(join(b.envDir, 'bridge', 'labels.json'), 'utf8'));
  for (const kind of ['services', 'volumes', 'networks'])
    for (const entry of Object.values<{ labels: unknown }>(labels[kind]))
      assert.deepEqual(entry.labels, receipt.labels, kind);
  assert.ok(labels.networks.default, 'сеть по умолчанию тоже помечена');
  const snapshot = JSON.parse(readFileSync(join(b.envDir, 'bridge', 'compose.json'), 'utf8'));
  assert.equal(snapshot.name, undefined, 'имя проекта задаёт только bridge');
  assert.ok(Number(receipt.ports.POSTGRES_PORT) > 0);
  // Другая фаза — другой проект.
  const other = setup();
  assert.equal(other.bridge(SETUP, { DEVCONTOUR_PHASE: 'integration' }).status, 0);
  assert.equal(other.receipt().project, 'hx-a8a37b1797c0-integration-starter');
});

test('S06/compose-bridge: env-файлы вне worktree (0600), в receipt только имена, teardown их удаляет', () => {
  const b = setup();
  assert.equal(b.bridge(SETUP).status, 0);
  const file = join(b.envDir, 'bridge', 'env', 'compose.env');
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, 'utf8'), /POSTGRES_PASSWORD=canary-secret-bridge-unit/);
  const receiptText = readFileSync(join(b.envDir, 'bridge', 'receipt.json'), 'utf8');
  assert.ok(!receiptText.includes('canary-secret-bridge-unit'), 'значение секрета в receipt');
  assert.deepEqual(b.receipt().envFiles[0].keys, [
    'POSTGRES_PORT',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'POSTGRES_DB',
  ]);
  assert.ok(!existsSync(join(b.wt, '.env')) && !existsSync(join(b.wt, 'compose.env')));
  assert.equal(b.bridge(['teardown']).status, 0);
  assert.ok(!existsSync(join(b.envDir, 'bridge', 'env')), 'env-файлы удалены');
  // Каталог окружения внутри worktree — отказ.
  const inside = setup();
  const r = inside.bridge(SETUP, { DEVCONTOUR_ENVIRONMENT_DIR: join(inside.wt, 'env') });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /внутри рабочего дерева/);
  // Незаданная переменная шаблона — отказ с её именем, без значений секретов.
  const missing = setup().bridge(SETUP, { HX_DB_USER: undefined });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /не заданы переменные HX_DB_USER/);
  assert.ok(!missing.stderr.includes('canary-secret-bridge-unit'));
});

test('S04/compose-bridge: receipt пишется до создания ресурсов; setup после create падает, teardown убирает', () => {
  const b = setup();
  const faults = join(b.root, 'faults.json');
  writeFileSync(faults, JSON.stringify({ '*': { setup: 'after-create' } }));
  const r = b.bridge(SETUP, { HX_BRIDGE_FAULTS: faults });
  assert.notEqual(r.status, 0);
  const receipt = b.receipt();
  assert.equal(receipt.status, 'setup-failed');
  assert.deepEqual(
    receipt.events.map((e: { stage: string }) => e.stage),
    ['ports', 'env', 'create', 'setup'],
  );
  assert.equal(receipt.resources.containers.length, 1, 'ресурс создан до сбоя');
  const t = b.bridge(['teardown']);
  assert.equal(t.status, 0, t.stderr);
  assert.equal(b.receipt().status, 'cleaned');
  assert.deepEqual(
    b.docker().resources.map((x) => x.id),
    ['foreign-1', 'foreign-vol'],
    'чужие ресурсы на месте',
  );
});

test('S04/compose-bridge: teardown удаляет только ресурсы с метками run и project; без prune и context', () => {
  // Ресурс с меткой того же run, но другого project (другая фаза), и того же project без run.
  const b = setup({
    downRemoves: false,
    foreign: [
      {
        kind: 'container',
        id: 'same-run-other-phase',
        labels: [
          'devcontour.harness.run=a8a37b17-97c0-484a-a0e0-2ea60dbc9482',
          'devcontour.harness.project=hx-a8a37b1797c0-integration-starter',
        ],
      },
      {
        kind: 'container',
        id: 'same-project-no-run',
        labels: ['devcontour.harness.project=hx-a8a37b1797c0-candidate-starter'],
      },
    ],
  });
  assert.equal(b.bridge(SETUP).status, 0);
  const t = b.bridge(['teardown']);
  assert.equal(t.status, 0, t.stderr);
  assert.deepEqual(
    b
      .docker()
      .resources.map((x) => x.id)
      .sort(),
    ['same-project-no-run', 'same-run-other-phase'],
  );
  const calls = b.docker().calls;
  assert.ok(!calls.some((c) => c.includes('prune') || c.includes('system')), 'prune');
  assert.ok(!calls.some((c) => c[0] === 'context'), 'docker context');
  // Повтор очистки безопасен.
  assert.equal(b.bridge(['teardown']).status, 0);
  // Сбой teardown: ресурсы остаются, receipt cleanup-failed, env-файлы удалены.
  const f = setup();
  assert.equal(f.bridge(SETUP).status, 0);
  const faults = join(f.root, 'faults.json');
  writeFileSync(faults, JSON.stringify({ candidate: { teardown: 'fail' } }));
  assert.notEqual(f.bridge(['teardown'], { HX_BRIDGE_FAULTS: faults }).status, 0);
  assert.equal(f.receipt().status, 'cleanup-failed');
  assert.equal(f.docker().resources.length, 5);
  assert.ok(!existsSync(join(f.envDir, 'bridge', 'env')));
  assert.equal(f.bridge(['teardown']).status, 0, 'повтор без сбоя очищает');
  assert.equal(f.docker().resources.length, 2);
});

test('S03/compose-bridge: модель compose без изоляции по проекту отклоняется до создания', () => {
  for (const service of [
    { image: 'x', container_name: 'fixed' },
    { image: 'x', volumes: [{ type: 'bind', source: '/etc', target: '/x' }] },
    { image: 'x', network_mode: 'host' },
  ]) {
    const b = setup({ model: { services: { postgres: service } } });
    const r = b.bridge(SETUP);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /не изолируема/);
    assert.ok(!b.docker().calls.some((c) => c.includes('create')));
  }
});
