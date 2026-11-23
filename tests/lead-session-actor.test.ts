/**
 * 0.1.0-alpha.68 (P6-17): внутри открытой сессии ведущего `retry` без `--by`
 * — отказ `INVALID_INPUT`: ведущий называет роль явно (`--by lead` или
 * `--by operator`), молчаливого умолчания нет; явный `--by operator` —
 * оператор; без сессии — прежнее умолчание (оператор). Ответ команды
 * называет, откуда актёр (`bySource`).
 * P6-33: `lead end` при готовых работах и без запуска — предупреждение
 * `READY_WORKS_NOT_RUNNING` (`readyNotRunning`), не отказ.
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

test('P6-17: retry без --by в открытой сессии ведущего — отказ с выбором роли; ничего не меняется и в журнал ведущего не пишется', () => {
  const dir = failedWork(3);
  assert.equal(harness('lead', 'begin', '--state', dir, '--ttl', '30m').status, 0);
  const r = harness('retry', '--state', dir, '--work', 'w');
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error!.code, 'INVALID_INPUT');
  assert.match(r.json.error!.message, /--by lead .*--by operator/);
  assert.deepEqual(notes(dir), ['lead.begin']);
  const lead = harness('retry', '--state', dir, '--work', 'w', '--by', 'lead');
  assert.equal(lead.status, 0, lead.stderr);
  const data = cliDataSchemas.retry.parse(lead.json.data);
  assert.deepEqual([data.by, data.bySource], ['lead', 'flag']);
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

test('P6-17: сброс без --by в сессии — отказ с выбором роли, а не молчаливый сброс; --by operator — сброс человека', () => {
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
  assert.equal(implicit.json.error!.code, 'INVALID_INPUT');
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

/** Каталог состояния с готовой согласованной работой `w`; никто не запущен. */
function readyWork() {
  const env = engineOf(policyOf());
  ready(env.engine, graphOf({ w: [] }));
  writeFileSync(
    join(env.dir, 'binding.json'),
    JSON.stringify({ policy: env.engine.policy, baseDir: env.dir }),
  );
  env.store.close();
  return env.dir;
}

test('P6-33: lead end при готовых работах и без запуска — предупреждение READY_WORKS_NOT_RUNNING, выход 0, сессия закончена', () => {
  const dir = readyWork();
  assert.equal(harness('lead', 'begin', '--state', dir, '--ttl', '30m').status, 0);
  const r = harness('lead', 'end', '--state', dir);
  assert.equal(r.status, 0, r.stderr);
  const data = cliDataSchemas['lead-end'].parse(r.json.data);
  assert.equal(data.lead.active, false);
  assert.deepEqual(
    data.readyNotRunning && {
      code: data.readyNotRunning.code,
      ready: data.readyNotRunning.ready,
      readyWorks: data.readyNotRunning.readyWorks,
    },
    { code: 'READY_WORKS_NOT_RUNNING', ready: 1, readyWorks: ['w'] },
  );
  assert.match(data.readyNotRunning!.line, /готово 1 задача и никто не запущен \(w\).*harness run/);
  assert.match(r.stderr, /^harness: READY_WORKS_NOT_RUNNING: Сессия закончена/m);
});

test('P6-33: lead end без готовых работ (очередь на паузе) — без предупреждения', () => {
  const dir = readyWork();
  assert.equal(harness('pause', '--state', dir).status, 0);
  const r = harness('lead', 'end', '--state', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(cliDataSchemas['lead-end'].parse(r.json.data).readyNotRunning, undefined);
  assert.doesNotMatch(r.stderr, /READY_WORKS_NOT_RUNNING/);
});
