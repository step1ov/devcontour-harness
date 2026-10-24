import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cliCommands,
  cliDataSchemas,
  diagnosisActions,
  diagnosisActors,
  diagnosisCauses,
  diagnosisPhases,
  failureKinds,
  pauseReasons,
  repairPolicy,
  workStatuses,
} from '../src/contracts/index.ts';
import { repairPolicy as directRepairPolicy } from '../src/contracts/repair-policy.ts';
import * as projections from '../src/projections/index.ts';
import * as root from '../src/index.ts';
import { activeStatuses } from '../src/projections/enums.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (args: string[]) => {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    cwd: mkdtempSync(join(tmpdir(), 'harness-cwd-')),
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    json: JSON.parse(r.stdout) as { ok: boolean; error?: { code: string } },
  };
};

test('H1-05: init и explain объявлены в договоре CLI со своими схемами и признаком записи', () => {
  assert.equal(cliCommands.init.writes, true);
  assert.equal(cliCommands.explain.writes, false);
  assert.ok(cliDataSchemas.init);
  assert.ok(cliDataSchemas.explain);
  assert.deepEqual(cliCommands.init.refusals, ['PATH_CONFLICT', 'CONTROLLER_BUSY', 'NOT_READY']);
  assert.deepEqual(cliCommands.explain.refusals, ['NOT_FOUND']);
});

test('H1-05: --human и новые флаги принимают только свои команды; прежние отвечают INVALID_INPUT, exit 2', () => {
  for (const args of [
    ['status', '--state', '/nonexistent', '--human'],
    ['validate', '--graph', 'g.json', '--policy', 'p.json', '--plan'],
    ['run', '--writer', 'claude'],
  ]) {
    const r = harness(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error?.code, 'INVALID_INPUT');
  }
});

test('H1-05: литералы диагностики в договоре и в проекциях совпадают; перечни статусов и классов — те же', () => {
  assert.deepEqual([...diagnosisActors], [...projections.actors]);
  assert.deepEqual([...diagnosisActions], [...projections.nextActions]);
  assert.deepEqual([...diagnosisCauses], [...projections.stopCauses]);
  assert.deepEqual([...diagnosisPhases], [...projections.stopPhases]);
  // Причины остановки начинаются с классов отказа — в том же порядке.
  assert.deepEqual(projections.stopCauses.slice(0, failureKinds.length), [...failureKinds]);
  for (const s of activeStatuses) assert.ok((workStatuses as readonly string[]).includes(s), s);
  assert.ok(pauseReasons.length > 0);
});

test('H1-05: корень и ./projections экспортируют одни и те же функции; repairPolicy — одна таблица', () => {
  for (const name of [
    'chainRoots',
    'workProgress',
    'nextAction',
    'queueStop',
    'explainStop',
    'stopCodeOf',
    'clipText',
    'clipDeep',
  ] as const)
    assert.equal(root[name], projections[name], name);
  assert.equal(repairPolicy, directRepairPolicy);
});

test('H1-03: stopCodeOf — прежняя таблица stopReason (environment → RUNTIME_UNAVAILABLE)', () => {
  assert.equal(projections.stopCodeOf('environment'), 'RUNTIME_UNAVAILABLE');
  assert.equal(projections.stopCodeOf('provider-auth'), 'RUNTIME_UNAVAILABLE');
  assert.equal(projections.stopCodeOf('gate'), 'GATE_FAILED');
  assert.equal(projections.stopCodeOf('unknown'), 'INTERNAL');
  assert.equal(projections.stopCodeOf(undefined), 'INTERNAL');
});

test('H1-05: прежние команды отвечают тем же конвертом — одна строка JSON, те же ключи и exit', () => {
  const cases: [string[], number, string[]][] = [
    [['version'], 0, ['apiVersion', 'command', 'ok', 'data']],
    [['profile', '--profile', 'npm-ci'], 0, ['apiVersion', 'command', 'ok', 'data']],
    [
      ['status', '--state', '/nonexistent-harness-state'],
      3,
      ['apiVersion', 'command', 'ok', 'error'],
    ],
    [['no-such-command'], 2, ['apiVersion', 'command', 'ok', 'error']],
  ];
  for (const [args, status, keys] of cases) {
    const r = harness(args);
    assert.equal(r.status, status, args.join(' '));
    assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'ровно одна строка');
    assert.deepEqual(Object.keys(r.json), keys, args.join(' '));
  }
});

test('H1-05 (H1-F013): version отклоняет новые флаги других команд; без них — прежний ответ', () => {
  for (const args of [
    ['version', '--human'],
    ['version', '--plan'],
    ['version', '--writer', 'claude'],
    ['--version', '--human'],
  ]) {
    const r = harness(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.json.error?.code, 'INVALID_INPUT', args.join(' '));
  }
  const plain = harness(['version']);
  assert.equal(plain.status, 0);
  assert.equal(plain.json.ok, true);
});
