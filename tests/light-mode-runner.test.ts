/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call --
 * Тест правит сырой JSON политики до разбора схемой.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateAttemptPorts,
  attemptVariables,
  composeProjectName,
} from '../src/environment/attempt-ports.ts';
import { ResourcePool } from '../src/environment/resources.ts';
import { writeGuardSupport } from '../src/environment/write-guard.ts';
import { executionPolicySchema } from '../src/contracts/index.ts';
import { example } from './fixtures.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';

const supported = writeGuardSupport().ok;

test('порты попытки: свои у каждой попытки, аренда в базе машины, снимается при release', async () => {
  const db = join(realpathSync(mkdtempSync(join(tmpdir(), 'ports-'))), 'resources.sqlite');
  const policy = { ports: ['API_PORT', 'WEB_PORT'], portRange: { from: 31000, to: 31010 } };
  const a = await allocateAttemptPorts(policy, db, 'a');
  const b = await allocateAttemptPorts(policy, db, 'b');
  const all = [...Object.values(a.ports), ...Object.values(b.ports)];
  assert.equal(new Set(all).size, 4, 'порты двух попыток не пересекаются');
  for (const p of all) assert.ok(p >= 31000 && p <= 31010);
  const pool = new ResourcePool(db);
  assert.equal(pool.list().length, 4);
  a.release();
  assert.equal(pool.list().length, 2);
  b.release();
  assert.equal(pool.list().length, 0);
  pool.close();
  // Занятый диапазон — понятный отказ, аренды не остаются.
  await assert.rejects(
    allocateAttemptPorts({ ports: ['X'], portRange: { from: 31020, to: 31021 } }, db, 'c', {
      busy: () => Promise.resolve(true),
    }),
    /Нет свободного порта попытки для X/,
  );
});

test('переменные попытки: имя проекта compose, порты и шлюз с суффиксами', () => {
  assert.equal(composeProjectName('Att_01/x'), 'hx-att_01-x');
  const env = attemptVariables(
    'a1',
    { API_PORT: 20001, GATEWAY_PORT: 20002 },
    {
      url: 'http://127.0.0.1:${GATEWAY_PORT}/',
      env: { IMAGE_PUBLIC_BASE_URL: '/media', API_URL: '' },
    },
  );
  assert.deepEqual(env, {
    HARNESS_ATTEMPT_ID: 'a1',
    COMPOSE_PROJECT_NAME: 'hx-a1',
    API_PORT: '20001',
    GATEWAY_PORT: '20002',
    HARNESS_GATEWAY_URL: 'http://127.0.0.1:20002',
    IMAGE_PUBLIC_BASE_URL: 'http://127.0.0.1:20002/media',
    API_URL: 'http://127.0.0.1:20002',
  });
});

test('политика: шлюз ссылается только на порты попытки, пул устройств — ресурсы device', async () => {
  const { policyIssues } = await import('../src/contracts/policy.ts');
  const raw = example('policy') as Record<string, any>;
  raw.repositories[0].gateway = { url: 'http://127.0.0.1:${GW}', env: {} };
  raw.repositories[0].gates.push({
    id: 'mobile',
    kind: 'check',
    command: ['maestro', 'test', 'flows'],
    ui: {
      type: 'mobile',
      platform: 'ios',
      flows: ['flows'],
      device: { pool: ['sim1'] },
      app: { id: 'a.b' },
    },
  });
  const issues = policyIssues(executionPolicySchema.parse(raw)).map((i) => i.message);
  assert.ok(
    issues.some((m) => /\$\{GW\}/.test(m)),
    issues.join('\n'),
  );
  assert.ok(
    issues.some((m) => /sim1/.test(m)),
    issues.join('\n'),
  );
  raw.attemptEnv = { ports: ['GW'] };
  raw.resources = [{ id: 'sim1', kind: 'device', value: 'iPhone 16' }];
  assert.deepEqual(policyIssues(executionPolicySchema.parse(raw)), []);
});

/**
 * Попытка облегчённого режима целиком: исполнитель и gate под границей
 * записи; gate получает имя проекта compose, порты попытки и адрес шлюза и
 * не может писать вне своего дерева.
 */
test(
  'попытка облегчённого режима: gate видит переменные попытки, запись вне дерева закрыта',
  { skip: !supported, timeout: 120_000 },
  async (t) => {
    // Вне временного каталога пользователя: его умолчания границы открывают
    // на запись (Chrome создаёт в нём сокет профиля), а /tmp — нет.
    const outsideDir = realpathSync(mkdtempSync('/tmp/light-out-'));
    t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
    const outside = join(outsideDir, 'leak.txt');
    const gate = `
const fs = require('fs');
const e = process.env;
const problems = [];
if (!/^hx-/.test(e.COMPOSE_PROJECT_NAME || '')) problems.push('compose ' + e.COMPOSE_PROJECT_NAME);
if (!/^\\d+$/.test(e.API_PORT || '')) problems.push('port ' + e.API_PORT);
if (e.IMAGE_PUBLIC_BASE_URL !== 'http://127.0.0.1:' + e.GATEWAY_PORT + '/media') problems.push('gateway ' + e.IMAGE_PUBLIC_BASE_URL);
if (e.HARNESS_ATTEMPT_ID !== e.DEVCONTOUR_RUN_ID) problems.push('attempt ' + e.HARNESS_ATTEMPT_ID);
let leaked = false;
try { fs.writeFileSync(${JSON.stringify(outside)}, 'x'); leaked = true; } catch {}
if (leaked) problems.push('leak');
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,
  '<testsuite><testcase classname="light" name="env">' + (problems.length ? '<failure message="' + problems.join(';').replace(/[<&"]/g, '') + '"/>' : '') + '</testcase></testsuite>');
`;
    const ctx = setup({
      scenario: { writer: implement(), reviewer: approve() },
      files: { 'test/light.js': gate },
      policy: (p) => {
        p.harnessMode = 'light';
        p.isolation = { mode: 'os', domains: [] };
        p.maxAttempts = 1;
        p.attemptEnv = {
          ports: ['API_PORT', 'GATEWAY_PORT'],
          portRange: { from: 32000, to: 32999 },
        };
        const repo = (p.repositories as Record<string, any>[])[0]!;
        repo.gateway = {
          url: 'http://127.0.0.1:${GATEWAY_PORT}',
          env: { IMAGE_PUBLIC_BASE_URL: '/media' },
        };
        repo.gates[0].command = [process.execPath, 'test/light.js'];
      },
    });
    await runAll(ctx);
    const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(a.status, 'succeeded', a.error);
    assert.equal(existsSync(outside), false);
    // Аренда портов снята после попытки.
    const pool = new ResourcePool(join(ctx.state, 'resources.sqlite'));
    assert.equal(pool.list().length, 0);
    pool.close();
  },
);
