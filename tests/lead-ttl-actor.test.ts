/**
 * 0.1.0-alpha.66 ревью L2 и L4.
 * L2: `--ttl` у `lead-begin` и `preview-start` (и `preview-start --idle`) —
 * длительность с единицей `s`, `m`, `h`; голое число — `INVALID_INPUT`, текст
 * называет суффиксы.
 * L4: журнал ведущего пишет команду и продлевает аренду, только если команда —
 * ведущего (явный `--by lead`/`--actor lead`, `diagnose`, а без явного актёра —
 * при активной сессии); команда оператора не пишется и аренду не продлевает.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HarnessError,
  LEAD_LIMITS,
  WORKSPACE_OWNER,
  cliCommands,
  cliDataSchemas,
} from '../src/contracts/index.ts';
import { parseDurationFlag } from '../src/control/duration.ts';
import {
  leadBegin,
  leadCommandActor,
  leadCommandEntry,
  leadTtlMs,
  recordLeadCommand,
} from '../src/control/lead.ts';
import { engineOf, graphOf, ready } from './engine-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (...args: string[]) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', cli, ...args],
    { encoding: 'utf8' },
  );
  return {
    status: r.status,
    stderr: r.stderr,
    json: JSON.parse(r.stdout) as {
      ok: boolean;
      data?: never;
      error?: { code: string; message: string };
    },
  };
};

/** Каталог состояния с привязкой, который CLI откроет. */
function stateDir() {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  writeFileSync(
    join(env.dir, 'binding.json'),
    JSON.stringify({ policy: env.engine.policy, baseDir: env.dir }),
  );
  return env;
}

const suffixes = /90s, 30m, 2h/;
const invalid = (fn: () => unknown, re: RegExp) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HarnessError);
    assert.equal(e.code, 'INVALID_INPUT');
    assert.match(e.message, re);
    return true;
  });

test('L2: длительность с единицей s, m, h; голое число и дробь — отказ с названными суффиксами', () => {
  const day = { minMs: 1000, maxMs: 86_400_000 };
  assert.equal(parseDurationFlag('ttl', '90s', day), 90_000);
  assert.equal(parseDurationFlag('ttl', '30m', day), 1_800_000);
  assert.equal(parseDurationFlag('ttl', '2h', day), 7_200_000);
  assert.equal(parseDurationFlag('ttl', '24h', day), 86_400_000);
  invalid(() => parseDurationFlag('ttl', '600', day), /голое число не принимается/);
  invalid(() => parseDurationFlag('ttl', '600', day), suffixes);
  invalid(() => parseDurationFlag('ttl', '1.5h', day), suffixes);
  invalid(() => parseDurationFlag('ttl', '25h', day), /от 1s до 24h/);
  invalid(() => parseDurationFlag('ttl', '0s', day), /от 1s до 24h/);
  invalid(() => parseDurationFlag('ttl', '10d', day), suffixes);
  // `--idle 0` — «не по простою»: у нуля единица не нужна.
  assert.equal(parseDurationFlag('idle', '0', { ...day, zero: true }), 0);
  assert.equal(parseDurationFlag('idle', '0s', { ...day, zero: true }), 0);
  invalid(() => parseDurationFlag('idle', '30', { ...day, zero: true }), /0 — выключить/);
  invalid(() => parseDurationFlag('ttl', '0', day), suffixes);
});

test('L2: lead-begin --ttl — та же единица; без флага 30m; голое число — отказ', () => {
  assert.equal(leadTtlMs(undefined), LEAD_LIMITS.ttlDefaultMs);
  assert.equal(leadTtlMs('45m'), 45 * 60_000);
  assert.equal(leadTtlMs('90s'), 90_000);
  assert.equal(leadTtlMs('12h'), LEAD_LIMITS.ttlMaxMs);
  invalid(() => leadTtlMs('45'), /голое число не принимается/);
  invalid(() => leadTtlMs('30s'), /от 1m до 12h/);
  invalid(() => leadTtlMs('13h'), /от 1m до 12h/);
  // Договор: оба флага — `duration`, описание называет суффиксы.
  for (const [command, flag] of [
    ['lead-begin', '--ttl'],
    ['preview-start', '--ttl'],
    ['preview-start', '--idle'],
  ] as const) {
    const arg = (
      cliCommands[command].args as readonly { name: string; value: string; description: string }[]
    ).find((a) => a.name === flag)!;
    assert.equal(arg.value, 'duration', `${command} ${flag}`);
    assert.match(arg.description, suffixes, `${command} ${flag}`);
  }
});

test('L2: CLI — lead begin и preview-start отклоняют голое число, суффикс принимают', () => {
  const env = stateDir();
  env.store.close();
  const bare = harness('lead', 'begin', '--state', env.dir, '--ttl', '45');
  assert.equal(bare.status, 2, bare.stderr);
  assert.equal(bare.json.error?.code, 'INVALID_INPUT');
  assert.match(bare.json.error.message, suffixes);
  const ok = harness('lead', 'begin', '--state', env.dir, '--ttl', '45m');
  assert.equal(ok.status, 0, ok.stderr);
  const data = cliDataSchemas['lead-begin'].parse(ok.json.data);
  assert.equal(Date.parse(data.lead.until!) - Date.parse(data.lead.since!), 45 * 60_000);

  for (const flag of ['--ttl', '--idle']) {
    const p = harness('preview-start', '--state', env.dir, flag, '600');
    assert.equal(p.status, 2, p.stderr);
    assert.equal(p.json.error?.code, 'INVALID_INPUT');
    assert.match(p.json.error.message, new RegExp(`^${flag}: `));
    assert.match(p.json.error.message, suffixes);
  }
  // С единицей разбор проходит: отказ — уже о превью (их в политике нет), не о флаге.
  const suffixed = harness('preview-start', '--state', env.dir, '--ttl', '10m', '--idle', '0');
  assert.notEqual(suffixed.json.error?.code, 'INVALID_INPUT', JSON.stringify(suffixed.json));
  // Справка показывает тип `duration`.
  const help = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', cli, 'preview-start', '--help'],
    { encoding: 'utf8' },
  );
  assert.match(help.stdout, /--ttl <duration>/);
});

test('L4: кто подал команду — явный флаг решает, diagnose — ведущего, иначе сессия', () => {
  assert.equal(leadCommandActor('retry', { by: 'lead' }), 'lead');
  assert.equal(leadCommandActor('input-answer', { actor: 'lead' }), 'lead');
  assert.equal(leadCommandActor('input-answer', { actor: 'operator' }), 'operator');
  assert.equal(leadCommandActor('reapprove', { by: 'Антон' }), 'operator');
  assert.equal(leadCommandActor('diagnose', {}), 'lead');
  assert.equal(leadCommandActor('pause', {}), undefined);
  // alpha.68 (ревью r2): ответ без --actor и его применение — оператора и в
  // сессии ведущего: переданный ответ владельца не пишется решением ведущего.
  assert.equal(leadCommandActor('input-answer', {}), 'operator');
  // input-resolve — как в alpha.67: решает сессия.
  assert.equal(leadCommandActor('input-resolve', {}), undefined);
  assert.equal(
    leadCommandEntry('input-answer', { actor: 'operator', request: 'R1' }, {}),
    undefined,
  );
});

test('L4: команда оператора при активной сессии не продлевает аренду и не пишется ведущему; --by lead — пишется и продлевает', () => {
  const env = stateDir();
  const log = () => env.engine.read((v) => v.local('lead', WORKSPACE_OWNER, 'log'))!;
  leadBegin(env.engine, { ttlMs: 10 * 60_000 });
  const until0 = log().session!.until;
  env.clock.now += 5 * 60_000;

  // Оператор: `reapprove --by Антон` (строка была бы «ведущий пересогласовал…»).
  const reapprove = leadCommandEntry('reapprove', { by: 'Антон' }, {});
  assert.equal(reapprove, undefined);
  // Даже если строка есть, явный оператор не пишется.
  const entry = leadCommandEntry('pause', {}, {})!;
  assert.equal(recordLeadCommand(env.engine, entry, 'operator'), false);
  assert.equal(log().session!.until, until0, 'аренда не продлена');
  assert.deepEqual(
    log().entries.map((e) => e.action),
    ['lead.begin'],
  );

  // Ведущий явно: `retry --by lead` — запись и продление.
  const retry = leadCommandEntry('retry', { by: 'lead', work: 'w' }, {})!;
  assert.equal(
    recordLeadCommand(env.engine, retry, leadCommandActor('retry', { by: 'lead' })),
    true,
  );
  assert.equal(Date.parse(log().session!.until), env.clock.now + 10 * 60_000, 'аренда продлена');
  assert.deepEqual(
    log().entries.map((e) => e.action),
    ['lead.begin', 'lead.retry'],
  );

  // Без явного актёра при активной сессии — ведущего.
  assert.equal(recordLeadCommand(env.engine, entry, undefined), true);
  assert.equal(log().entries.at(-1)!.action, 'lead.pause');

  // Сессия истекла: без явного актёра — не ведущего, аренда не воскресает.
  env.clock.now += 11 * 60_000;
  const until1 = log().session!.until;
  assert.equal(recordLeadCommand(env.engine, entry, undefined), false);
  assert.equal(log().session!.until, until1);
  assert.equal(log().entries.length, 3);
  // `--by lead` без сессии — записан ведущему, аренду истёкшей сессии не продлевает.
  assert.equal(recordLeadCommand(env.engine, retry, 'lead'), true);
  assert.equal(log().session!.until, until1);
  assert.equal(log().entries.length, 4);
  env.store.close();
});

test('L4: без сессии и без явного актёра запись lead состояния не создаётся', () => {
  const env = stateDir();
  const entry = leadCommandEntry('resume', {}, {})!;
  assert.equal(recordLeadCommand(env.engine, entry, undefined), false);
  assert.equal(
    env.engine.read((v) => v.local('lead', WORKSPACE_OWNER, 'log')),
    undefined,
  );
  env.store.close();
});

test('L4: CLI — pause/resume пишутся ведущему только при активной сессии', () => {
  const env = stateDir();
  env.store.close();
  const read = () => {
    const r = harness('view', '--state', env.dir);
    assert.equal(r.status, 0, r.stderr);
    const data = r.json.data as unknown as { view?: { lead?: { notes: { action: string }[] } } };
    return (data.view ?? (data as { lead?: { notes: { action: string }[] } })).lead?.notes.map(
      (n) => n.action,
    );
  };
  assert.equal(harness('pause', '--state', env.dir).status, 0);
  assert.equal(read(), undefined, 'без сессии пауза оператора в журнал ведущего не попала');
  assert.equal(harness('lead', 'begin', '--state', env.dir, '--ttl', '30m').status, 0);
  assert.equal(harness('resume', '--state', env.dir).status, 0);
  assert.deepEqual(read(), ['lead.resume', 'lead.begin']);
});

test('L4: CLI — retry --by operator при активной сессии не пишется ведущему и аренду не продлевает; --by lead — пишется и продлевает', () => {
  const env = stateDir();
  env.store.close();
  const lead = () => {
    const r = harness('view', '--state', env.dir);
    assert.equal(r.status, 0, r.stderr);
    const data = r.json.data as unknown as {
      view?: { lead?: { until?: string; notes: { action: string }[] } };
    };
    return (data.view ?? (data as { lead?: { until?: string; notes: { action: string }[] } }))
      .lead!;
  };
  assert.equal(harness('lead', 'begin', '--state', env.dir, '--ttl', '30m').status, 0);
  const until0 = lead().until;
  const operator = harness('retry', '--state', env.dir, '--work', 'w', '--by', 'operator');
  assert.equal(operator.status, 0, operator.stderr);
  const afterOperator = lead();
  assert.equal(afterOperator.until, until0, 'команда оператора аренду не продлила');
  assert.deepEqual(
    afterOperator.notes.map((n) => n.action),
    ['lead.begin'],
  );
  const byLead = harness('retry', '--state', env.dir, '--work', 'w', '--by', 'lead');
  assert.equal(byLead.status, 0, byLead.stderr);
  const afterLead = lead();
  assert.ok(Date.parse(afterLead.until!) > Date.parse(until0!), 'команда ведущего продлила аренду');
  assert.deepEqual(
    afterLead.notes.map((n) => n.action),
    ['lead.retry', 'lead.begin'],
  );
  const bad = harness('retry', '--state', env.dir, '--work', 'w', '--by', 'someone');
  assert.equal(bad.status, 2);
  assert.match(bad.json.error!.message, /lead или operator/);
});
