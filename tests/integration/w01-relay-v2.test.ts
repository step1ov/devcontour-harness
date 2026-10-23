/**
 * W01/relay-v2: сквозной пользовательский путь на копии Turbo Starter через
 * публичный CLI (source-check → source-snapshot → review-plan → approve →
 * run --source → source-status → source-deliver → независимое чтение), с
 * восстановлением доставки и конфликтом постановки — `scripts/acceptance/w01.mjs`.
 * Нет сборки Relay или источника Starter — отказ BLOCKED, не пропуск.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence =
  process.env.STARTER_EVIDENCE_DIR ?? join(root, '.private/integration-upgrade/evidence');
const logs = process.env.STARTER_LOGS_DIR ?? join(root, '.private/integration-upgrade/logs');

test(
  'W01/relay-v2: задача Relay → принятый результат Starter → подтверждённая доставка',
  { timeout: 3_600_000 },
  () => {
    const r = spawnSync(
      process.execPath,
      [
        join(root, 'scripts/acceptance/w01.mjs'),
        'relay-v2',
        '--evidence',
        evidence,
        '--logs',
        logs,
        ...(process.env.STARTER_SOURCE ? ['--source', process.env.STARTER_SOURCE] : []),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (r.status === 3) assert.fail('BLOCKED: ' + r.stderr.slice(-2000));
    const summary = JSON.parse(
      readFileSync(join(evidence, 'W01', 'relay-v2', 'summary.json'), 'utf8'),
    ) as { status: string; error?: string; checks: { ok: boolean }[] };
    assert.equal(summary.status, 'PASS', summary.error);
    assert.ok(summary.checks.length > 10 && summary.checks.every((c) => c.ok));
    assert.equal(r.status, 0, r.stderr.slice(-4000));
  },
);
