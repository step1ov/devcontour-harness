import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../src/control/doctor.ts';
import { doctorDataSchema } from '../src/contracts/cli.ts';
import {
  LEAD_UNSANDBOXED_FLAGS,
  leadSandboxCheck,
  type LeadSandboxProbe,
} from '../src/environment/lead-sandbox.ts';

/** Пробы среды внутри seatbelt Codex: всё отказывает, как в живой песочнице. */
const sandboxed = (calls: string[] = []): Partial<LeadSandboxProbe> => ({
  platform: 'darwin',
  env: { CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' },
  pid: 4242,
  run: (command, args) => {
    calls.push([command, ...args].join(' '));
    return command === 'ps'
      ? { status: null, stderr: '', errorCode: 'EPERM' }
      : { status: 71, stderr: 'sandbox-exec: sandbox_apply: Operation not permitted\n' };
  },
  gitDir: (repo) => join(repo, '.git'),
  writable: () => false,
});

const clean: Partial<LeadSandboxProbe> = {
  platform: 'darwin',
  env: {},
  pid: 4242,
  run: () => ({ status: 0, stderr: '' }),
  gitDir: (repo) => join(repo, '.git'),
  writable: () => true,
};

test('leadSandboxCheck: отказы проб внутри песочницы дают inside, признаки и флаги Codex', () => {
  const calls: string[] = [];
  const r = leadSandboxCheck({
    repositories: ['/work/app', '/work/app'],
    stateDir: '/work/state',
    probe: sandboxed(calls),
  });
  assert.equal(r.inside, true);
  assert.deepEqual(r.signals, [
    'nested-sandbox',
    'ps-denied',
    'git-readonly:/work/app/.git',
    'state-readonly',
    'codex-env',
  ]);
  assert.equal(r.flags, LEAD_UNSANDBOXED_FLAGS);
  assert.equal(
    r.narrowFlags,
    'codex exec -s workspace-write --add-dir /work/app/.git --add-dir /work/state -c sandbox_workspace_write.network_access=true',
  );
  assert.match(r.advice, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(r.advice, /run, smoke, gates, review-plan/);
  assert.match(r.adviceEn, /cannot/);
  assert.ok(calls.includes('/usr/bin/sandbox-exec -p (version 1)(allow default) /usr/bin/true'));
  assert.ok(calls.includes('ps -o pid= -p 4242'));
});

test('leadSandboxCheck: все пробы прошли — inside false, без совета', () => {
  const r = leadSandboxCheck({
    repositories: ['/work/app'],
    stateDir: '/work/state',
    probe: clean,
  });
  assert.equal(r.inside, false);
  assert.deepEqual(r.signals, []);
  assert.equal(r.advice, '');
});

test('leadSandboxCheck: переменные Codex без отказов проб — только подсказка', () => {
  const r = leadSandboxCheck({ probe: { ...clean, env: { CODEX_SANDBOX: 'seatbelt' } } });
  assert.equal(r.inside, false);
  assert.deepEqual(r.signals, ['codex-env']);
});

test('leadSandboxCheck: нет sandbox-exec и ps (ENOENT) — пробы пропускаются', () => {
  const r = leadSandboxCheck({
    probe: { ...clean, run: () => ({ status: null, stderr: '', errorCode: 'ENOENT' }) },
  });
  assert.equal(r.inside, false);
  assert.deepEqual(r.signals, []);
});

test('leadSandboxCheck: настоящая проба записи оставляет каталог пустым', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lead-sandbox-'));
  try {
    // Без `writable` — действует проба по умолчанию (создание и удаление файла).
    const { writable: _writable, ...rest } = clean;
    void _writable;
    const r = leadSandboxCheck({ stateDir: dir, probe: rest });
    assert.ok(!r.signals.includes('state-readonly'));
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: ведущий внутри песочницы — строка проблемы с флагами и поле по схеме', async () => {
  const inside = await doctor(undefined, {}, '/work/state', undefined, undefined, {
    resourceDatabase: false,
    leadSandbox: sandboxed(),
  });
  assert.equal(inside.leadSandbox?.inside, true);
  const line = inside.problems.find((p) => p.startsWith('lead-sandbox: '));
  assert.ok(line, 'нет строки lead-sandbox в problems');
  assert.match(line, /codex exec --dangerously-bypass-approvals-and-sandbox/);
  assert.match(line, /--add-dir \/work\/state/);
  doctorDataSchema.parse(inside);

  const outside = await doctor(undefined, {}, undefined, undefined, undefined, {
    resourceDatabase: false,
    leadSandbox: clean,
  });
  assert.equal(outside.leadSandbox?.inside, false);
  assert.ok(!outside.problems.some((p) => p.startsWith('lead-sandbox')));

  const skipped = await doctor(undefined, {}, undefined, undefined, undefined, {
    resourceDatabase: false,
  });
  assert.equal(skipped.leadSandbox, undefined);
});
