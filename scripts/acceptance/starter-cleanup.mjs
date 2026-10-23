#!/usr/bin/env node
/**
 * Довести очистку попытки в НОВОМ процессе по сохранённому состоянию:
 * `Harness.cleanup(runId)` (Runner.finishCleanup) с политикой и baseDir из
 * `<state>/binding.json`, записанного CLI. Запуск (нужен loader tsx):
 *
 *   node --import tsx scripts/acceptance/starter-cleanup.mjs --state <dir> --run <runId>
 *
 * Печатает JSON { ok, data | error }; код 0 — очистка выполнена/не нужна.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { executionPolicySchema } from '../../src/contracts/index.ts';
import { Harness } from '../../src/control/harness.ts';

const { values } = parseArgs({ options: { state: { type: 'string' }, run: { type: 'string' } } });
if (!values.state || !values.run) {
  console.error('usage: starter-cleanup.mjs --state <dir> --run <runId>');
  process.exit(2);
}
const stateDir = resolve(values.state);
const binding = JSON.parse(readFileSync(join(stateDir, 'binding.json'), 'utf8'));
const h = Harness.open({
  stateDir,
  policy: executionPolicySchema.parse(binding.policy),
  baseDir: binding.baseDir,
});
try {
  const data = await h.cleanup(values.run);
  const attempt = h.engine.read((v) => v.attempt(values.run));
  console.log(
    JSON.stringify({
      ok: true,
      pid: process.pid,
      data,
      attempt: { status: attempt?.status, error: attempt?.error },
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      pid: process.pid,
      error: { code: error?.code, message: error instanceof Error ? error.message : String(error) },
    }),
  );
  process.exitCode = 1;
} finally {
  h.close();
}
