import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lifecycleSchema, TaskFailure, type EvidenceRecord } from '../src/contracts/index.ts';
import {
  classifyFailure,
  environmentCauseOf,
  failureOrigin,
  withSuffix,
} from '../src/engine/classify.ts';
import {
  CleanupFailure,
  executionEnvironment,
  withEnvironment,
} from '../src/environment/lifecycle.ts';
import { redactor } from '../src/environment/redaction.ts';
import { checkCleanup, runGate } from '../src/verification/gates.ts';
import { repo } from './git-fixture.ts';

// Ресурсы попытки не освобождены — отказ окружения, если он не заслоняет
// отказ самой работы: тогда класс и причина — её.

/** Класс и причина отказа так, как их пишет runner. */
const judged = (error: Error) => {
  const kind = classifyFailure(error, error.message);
  return { kind, cause: environmentCauseOf(error, error.message, kind) };
};

async function teardownFails(action: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'harness-cleanup-class-'));
  try {
    await withEnvironment(
      lifecycleSchema.parse({
        teardown: [{ id: 'stop', command: [process.execPath, '-e', 'process.exit(3)'] }],
      }),
      root,
      join(root, 'env'),
      executionEnvironment([], {}),
      new AbortController().signal,
      action,
    );
  } catch (error) {
    return error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return undefined;
}

test('CleanupFailure сохраняет класс и причину исходного отказа работы', async () => {
  const gate = await teardownFails(() =>
    Promise.reject(new TaskFailure('gate', 'candidate/unit: Код выхода 1')),
  );
  assert.ok(gate instanceof CleanupFailure, String(gate));
  assert.match(gate.message, /^candidate\/unit: Код выхода 1; Очистка окружения не завершена/);
  assert.deepEqual(judged(gate), { kind: 'gate', cause: 'none' });
  assert.ok(failureOrigin(gate) instanceof TaskFailure);

  const network = await teardownFails(() =>
    Promise.reject(
      new TaskFailure('environment', 'песочница закрыла сеть', undefined, 'sandbox-network'),
    ),
  );
  assert.ok(network instanceof CleanupFailure);
  assert.deepEqual(judged(network), { kind: 'environment', cause: 'sandbox-network' });

  // Исходный отказ без класса судится по своему тексту, как без очистки.
  const plain = await teardownFails(() => Promise.reject(new Error('connect ECONNREFUSED')));
  assert.ok(plain instanceof CleanupFailure);
  assert.deepEqual(judged(plain), { kind: 'environment', cause: 'transport' });

  // Дописанная причина (`withSuffix`) не теряет ни очистки, ни исходного отказа.
  const suffixed = withSuffix(gate, 'рабочие деревья сохранены');
  assert.ok(suffixed instanceof CleanupFailure);
  assert.match(suffixed.message, /; рабочие деревья сохранены$/);
  assert.deepEqual(judged(suffixed), { kind: 'gate', cause: 'none' });
  assert.deepEqual(judged(gate.extend('ещё')), { kind: 'gate', cause: 'none' });
});

test('Только неудавшаяся очистка (работа прошла) — отказ окружения cleanup, а не unknown', async () => {
  const error = await teardownFails(() => Promise.resolve());
  assert.ok(error instanceof CleanupFailure, String(error));
  assert.match(error.message, /^Очистка окружения не завершена/);
  assert.deepEqual(judged(error), { kind: 'environment', cause: 'cleanup' });
});

/** Gate, у которого уборка временного каталога проверки отказывает. */
async function gateWithStuckScratch(script: string) {
  const r = repo({ 'src/a.js': 'a\n' });
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  const artifactDir = mkdtempSync(join(tmpdir(), 'harness-art-'));
  const remove = checkCleanup.remove;
  // Каталог убирается по-настоящему, отказ только сообщается.
  checkCleanup.remove = async (dir) => {
    await remove(dir);
    if (dir.includes('dc-gate-')) throw new Error(`EACCES: permission denied, rmdir '${dir}'`);
  };
  try {
    const error = await runGate({
      policy: { isolation: { mode: 'none', domains: [] } },
      record: (e) => {
        recorded.push(e);
        return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
      },
      cwd: r.dir,
      sha: r.head(),
      phase: 'candidate',
      gate: {
        id: 'unit',
        kind: 'check',
        timeoutMs: 20000,
        command: [process.execPath, '-e', script],
      } as never,
      artifactDir,
      signal: new AbortController().signal,
      execution: { env: process.env, redact: redactor([]) },
      boundary: { hidden: [], readable: [] },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.equal(recorded.length, 1);
    return { error, evidence: recorded[0]! };
  } finally {
    checkCleanup.remove = remove;
    rmSync(artifactDir, { recursive: true, force: true });
  }
}

test('Gate прошёл, но его временные каталоги не убраны: не пройден, отказ environment/cleanup', async () => {
  const { error, evidence } = await gateWithStuckScratch('');
  assert.equal(evidence.passed, false, 'зелёный исход без уборки не принимается');
  assert.equal(evidence.exitCode, 0);
  assert.ok(error instanceof TaskFailure, String(error));
  assert.equal(error.kind, 'environment');
  assert.equal(error.diagnosis, 'cleanup');
  assert.match(
    error.message,
    /^candidate\/unit: Команда завершилась успешно, но временные каталоги проверки не убраны: EACCES/,
  );
});

test('Gate упал и его временные каталоги не убраны: класс gate, провал назван, уборка дописана', async () => {
  const { error, evidence } = await gateWithStuckScratch('process.exit(1)');
  assert.equal(evidence.passed, false);
  assert.equal(evidence.exitCode, 1);
  assert.ok(error instanceof TaskFailure, String(error));
  assert.equal(error.kind, 'gate');
  assert.match(
    error.message,
    /^candidate\/unit: Код выхода 1.*; временные каталоги проверки не убраны: EACCES/s,
  );
});
