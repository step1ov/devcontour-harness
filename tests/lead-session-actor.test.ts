/**
 * 0.1.0-alpha.68 (P6-17): команда с актёром без флага внутри открытой сессии
 * ведущего — ведущего. `retry` без `--by` исполняется как `--by lead` (те же
 * права и отказы: сброс ведущего — по разбору и в пределе), журнал пишет
 * ведущего; явный `--by operator` остаётся оператором; без сессии — прежнее
 * умолчание (оператор). Ответ команды называет, откуда актёр (`bySource`).
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliDataSchemas } from '../src/contracts/index.ts';
import { engineOf, graphOf, policyOf, ready } from './engine-fixture.ts';

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
      data?: Record<string, unknown>;
      error?: { code: string; message: string };
    },
  };
};

/** Каталог состояния с упавшей работой `w` (один засчитанный отказ). */
function failedWork(maxAttempts: number) {
  const policy = policyOf((p) => {
    p.maxAttempts = maxAttempts;
    p.recovery = { mode: 'lead', diagnoseAfter: 5, leadResets: 1 };
  });
  const env = engineOf(policy);
  ready(env.engine, graphOf({ w: [] }));
  const a = env.engine.claim('c1')!;
  assert.ok(a, 'попытка выдана');
  env.engine.fail(a.id, a.token, 'gate fail', { kind: 'gate' });
  writeFileSync(
    join(env.dir, 'binding.json'),
    JSON.stringify({ policy: env.engine.policy, baseDir: env.dir }),
  );
  env.store.close();
  return env.dir;
}

const notes = (dir: string) => {
  const r = harness('view', '--state', dir);
  assert.equal(r.status, 0, r.stderr);
  const data = r.json.data as { view?: { lead?: { notes: { action: string }[] } } };
  return (data.view ?? (data as { lead?: { notes: { action: string }[] } })).lead?.notes.map(
    (n) => n.action,
  );
};

test('P6-17: retry без --by в открытой сессии ведущего — ведущего (bySource: lead-session), журнал пишет ведущего', () => {
  const dir = failedWork(3);
  assert.equal(harness('lead', 'begin', '--state', dir, '--ttl', '30m').status, 0);
  const r = harness('retry', '--state', dir, '--work', 'w');
  assert.equal(r.status, 0, r.stderr);
  const data = cliDataSchemas.retry.parse(r.json.data);
  assert.equal(data.by, 'lead');
  assert.equal(data.bySource, 'lead-session');
  assert.deepEqual(notes(dir), ['lead.retry', 'lead.begin']);
});

test('P6-17: явный --by operator в сессии — оператор; без сессии — прежнее умолчание (оператор)', () => {
  const dir = failedWork(3);
  const plain = harness('retry', '--state', dir, '--work', 'w');
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual([plain.json.data!.by, plain.json.data!.bySource], ['operator', 'default']);
  const other = failedWork(3);
  assert.equal(harness('lead', 'begin', '--state', other, '--ttl', '30m').status, 0);
  const operator = harness('retry', '--state', other, '--work', 'w', '--by', 'operator');
  assert.equal(operator.status, 0, operator.stderr);
  assert.deepEqual([operator.json.data!.by, operator.json.data!.bySource], ['operator', 'flag']);
  assert.deepEqual(notes(other), ['lead.begin'], 'команда оператора ведущему не пишется');
  // Закончил сессию — снова умолчание оператора.
  assert.equal(harness('lead', 'end', '--state', other).status, 0);
  // Повтор уже готовой работы ничего не меняет, но актёра называет.
  const after = harness('retry', '--state', other, '--work', 'w');
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.json.data!.bySource, 'default');
});

test('P6-17: сброс без --by в сессии — сброс ведущего: тот же отказ, что у --by lead, а не молчаливый сброс оператора', () => {
  // Попытки исчерпаны (maxAttempts 1), разбора нет: ведущему сброс не дан.
  const explicit = failedWork(1);
  assert.equal(harness('lead', 'begin', '--state', explicit, '--ttl', '30m').status, 0);
  const byLead = harness(
    'retry',
    '--state',
    explicit,
    '--work',
    'w',
    '--reset',
    '--reason',
    'ещё раз',
    '--by',
    'lead',
  );
  assert.equal(byLead.json.ok, false);
  const dir = failedWork(1);
  assert.equal(harness('lead', 'begin', '--state', dir, '--ttl', '30m').status, 0);
  const implicit = harness(
    'retry',
    '--state',
    dir,
    '--work',
    'w',
    '--reset',
    '--reason',
    'ещё раз',
  );
  assert.equal(implicit.json.ok, false);
  assert.equal(implicit.status, byLead.status);
  assert.equal(implicit.json.error!.code, byLead.json.error!.code);
  assert.match(
    implicit.json.error!.message,
    /--by не задан: в открытой сессии ведущего команда исполняется как --by lead; решение человека — явно --by operator/,
  );
  // Решение человека явно — сброс оператора, как прежде.
  const human = harness(
    'retry',
    '--state',
    dir,
    '--work',
    'w',
    '--reset',
    '--reason',
    'ещё раз',
    '--by',
    'operator',
  );
  assert.equal(human.status, 0, human.stderr);
  assert.equal((human.json.data!.reset as { performed: boolean }).performed, true);
});
