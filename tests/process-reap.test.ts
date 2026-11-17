import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceRecord } from '../src/contracts/index.ts';
import { TaskFailure } from '../src/contracts/index.ts';
import { classifyFailure, environmentCauseOf } from '../src/engine/classify.ts';
import { repairDecision } from '../src/engine/repair.ts';
import { hostLoad } from '../src/environment/host-load.ts';
import { ReapFailure, command, processInventory } from '../src/environment/process.ts';
import { redactor } from '../src/environment/redaction.ts';
import { runGate } from '../src/verification/gates.ts';
import { repo } from './git-fixture.ts';
import { approve, implement, runAll, setup, target } from './runner-fixture.ts';

// F53: потомков сдерживаемой команды не удалось остановить или пересчитать
// (`ps` не ответил под нагрузкой хоста). Это отказ среды, а не кода: класс
// `environment` с причиной `process-reap`, и у gate, и у вызова runtime.
// Сдерживание прежнее: проверка не пройдена, и повтора на том же дереве нет.

const marked = processInventory.marked;
const read = hostLoad.read;
/** На время `fn` перечень процессов отказывает, пока `failing()` истинно. */
async function inventoryDown<T>(failing: () => boolean, fn: () => Promise<T>) {
  processInventory.marked = (mark) =>
    failing() ? Promise.reject(new Error('ps не ответил за 10 с')) : marked(mark);
  hostLoad.read = () => ({ load1: 587, cpus: 8 });
  try {
    return await fn();
  } finally {
    processInventory.marked = marked;
    hostLoad.read = read;
  }
}
const quick = [process.execPath, '-e', ''];

test('F53: перечень процессов не получен — ReapFailure класса environment; текст называет команду, выход и нагрузку, а не «-1»', async () => {
  const error = await inventoryDown(
    () => true,
    () =>
      command(quick, process.cwd(), {
        contain: true,
        activity: { kind: 'agent', label: 'claude implement' },
        timeoutMs: 30000,
      }).then(
        () => undefined,
        (e: unknown) => e,
      ),
  );
  assert.ok(error instanceof ReapFailure, String(error));
  assert.ok(error instanceof TaskFailure);
  assert.equal(error.kind, 'environment');
  assert.equal(error.diagnosis, 'process-reap');
  assert.deepEqual(error.survivors, []);
  assert.equal(error.inventory, 'ps не ответил за 10 с');
  assert.match(
    error.message,
    /^Не удалось завершить процессы команды «claude implement» \(PID \d+, код выхода 0\): перечень процессов не получен \(ps не ответил за 10 с\)\. Ресурсы не освобождены: потомки команды могут ещё работать; нагрузка хоста 587 на 8 ядер$/,
  );
  assert.doesNotMatch(error.message, /-1/);
  // Путь runner для отказа вызова runtime (реализация): класс и причина —
  // из самого отказа, не из текста.
  assert.equal(classifyFailure(error, error.message), 'environment');
  assert.equal(environmentCauseOf(error, error.message, 'environment'), 'process-reap');
});

test('F53: разовый отказ перечня под нагрузкой повторяется — команда завершается штатно', async () => {
  let failures = 1;
  const result = await inventoryDown(
    () => failures-- > 0,
    () => command(quick, process.cwd(), { contain: true, timeoutMs: 30000 }),
  );
  assert.equal(result.code, 0);
  assert.equal(failures, -1, 'перечень запрошен снова после отказа');
});

test('F53: потомок, переживший остановку, назван PID; класс environment', async () => {
  // PID, которого нет: сигнал ему не доходит, а перечень называет его снова.
  const ghost = 0x3ffffff0;
  processInventory.marked = () => Promise.resolve([ghost]);
  let error: unknown;
  try {
    await command(quick, process.cwd(), { contain: true, timeoutMs: 30000 });
  } catch (e) {
    error = e;
  } finally {
    processInventory.marked = marked;
  }
  assert.ok(error instanceof ReapFailure, String(error));
  assert.deepEqual(error.survivors, [ghost]);
  assert.equal(error.inventory, undefined);
  assert.equal(error.kind, 'environment');
  assert.match(
    error.message,
    new RegExp(`живы после остановки PID ${ghost}\\. Ресурсы не освобождены`),
  );
});

test('F53: gate, чьи процессы не пересчитаны, не пройден; отказ — environment/process-reap и называет gate', async () => {
  const r = repo({ 'src/a.js': 'a\n' });
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  const artifactDir = mkdtempSync(join(tmpdir(), 'harness-art-'));
  try {
    const error = await inventoryDown(
      () => true,
      () =>
        runGate({
          policy: { isolation: { mode: 'none', domains: [] } },
          record: (e) => {
            recorded.push(e);
            return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
          },
          cwd: r.dir,
          sha: r.head(),
          phase: 'candidate',
          gate: { id: 'typecheck', kind: 'check', timeoutMs: 20000, command: quick } as never,
          artifactDir,
          signal: new AbortController().signal,
          execution: { env: process.env, redact: redactor([]) },
          boundary: { hidden: [], readable: [] },
        }).then(
          () => undefined,
          (e: unknown) => e,
        ),
    );
    assert.equal(recorded.length, 1);
    assert.equal(
      recorded[0]!.passed,
      false,
      'команда с кодом 0 без остановленных потомков не проходит',
    );
    assert.ok(error instanceof TaskFailure, String(error));
    assert.equal(error.kind, 'environment');
    assert.equal(error.diagnosis, 'process-reap');
    assert.match(
      error.message,
      /^candidate\/typecheck: Не удалось завершить процессы команды «typecheck» \(PID \d+, код выхода 0\): перечень процессов не получен/,
    );
    assert.match(error.message, /нагрузка хоста 587 на 8 ядер$/);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test('F53: gate интеграции, чьи процессы не пересчитаны, не повторяется на том же дереве и не интегрируется; попытка не засчитана, восстановление её повторяет', async () => {
  const flags = mkdtempSync(join(tmpdir(), 'harness-reap-'));
  const flag = join(flags, 'reap-fails');
  // Gate интеграции первой попытки отмечает себя; пока метка есть, перечень
  // процессов отказывает (три раза — столько повторяет остановка).
  const gate = `
const fs = require('fs');
const once = ${JSON.stringify(join(flags, 'once'))};
if (process.env.DEVCONTOUR_PHASE === 'integration' && !fs.existsSync(once)) {
  fs.writeFileSync(once, '1');
  fs.writeFileSync(${JSON.stringify(flag)}, '1');
}
require('./run.js');
`;
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    files: { 'test/gate.js': gate },
    policy: (p) => {
      const raw = p as { repositories: { gates: { command: string[] }[] }[] };
      raw.repositories[0]!.gates[0]!.command = [process.execPath, 'test/gate.js'];
    },
  });
  const before = target(ctx);
  let refused = 0;
  try {
    await inventoryDown(
      () => {
        if (!existsSync(flag)) return false;
        if (++refused >= 3) rmSync(flag);
        return true;
      },
      () => runAll(ctx),
    );
    const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
    const first = attempts[0]!;
    assert.equal(first.status, 'failed');
    assert.equal(first.failureKind, 'environment', first.error);
    assert.match(first.error ?? '', /^integration\/unit: Не удалось завершить процессы команды/);
    const integration = first.evidence.filter(
      (e) => e.phase === 'integration' && e.kind === 'test',
    );
    assert.equal(integration.length, 1, 'повтора на том же дереве нет');
    assert.equal(integration[0]!.passed, false);
    assert.ok(!first.evidence.some((e) => e.recheck), 'ни одной записи повтора');
    const diagnosed = ctx.store
      .events()
      .flatMap((e) => (e.type === 'attempt.diagnosed' && e.runId === first.id ? [e.payload] : []));
    assert.deepEqual(diagnosed, [
      { failureKind: 'environment', cause: 'process-reap', counted: false },
    ]);
    assert.equal(attempts.length, 1);
    assert.equal(target(ctx), before, 'target не сдвинулся');
    // Восстановление хоста — повтор по правилу отказов окружения, а не
    // остановка «класс отказа не определён».
    const decided = ctx.engine.read((v) =>
      repairDecision(v, [v.work('add-greeting')!], { budgetLeft: 5, maxAttempts: 3 }),
    );
    assert.equal(decided?.action, 'retry', JSON.stringify(decided));
    assert.equal(decided.action === 'retry' && decided.kind, 'environment');
  } finally {
    rmSync(flags, { recursive: true, force: true });
  }
});
