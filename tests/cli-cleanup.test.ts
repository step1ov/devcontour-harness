/**
 * CLI `cleanup --state --run`: тонкая обёртка над `Harness.cleanup` в
 * отдельном процессе. Попытка — настоящая (fixture runtime через коннектор
 * с подделкой backend), незавершённая очистка — сохранённая запись
 * `cleanup-pending.json`, как её оставляет прерванный teardown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliCommands, cliDataSchemas, cliErrorSchema } from '../src/contracts/index.ts';
import { fakeSuiteBackend, scenario } from '../src/integrations/connector/testing.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('cleanup: CLI доводит незавершённую очистку попытки, повтор — nothing-pending; неизвестная попытка — NOT_FOUND', async () => {
  assert.ok('cleanup' in cliCommands && 'cleanup' in cliDataSchemas);
  const s = await scenario(fakeSuiteBackend());
  try {
    const { opened } = await s.snapshotAndRun();
    const runId = opened.h.engine.read((v) => v.attempts(s.workId)[0]!.id);
    opened.close();
    // Каталог состояния, инициализированный как у CLI (binding).
    writeFileSync(
      join(s.state, 'binding.json'),
      JSON.stringify({ policy: s.policy, baseDir: s.repo }, null, 2),
    );
    const artifacts = join(s.state, 'artifacts', runId);
    mkdirSync(artifacts, { recursive: true });
    const pending = join(artifacts, 'cleanup-pending.json');
    writeFileSync(
      pending,
      JSON.stringify({ reason: 'teardown failed', worktrees: [], snapshots: [] }),
    );
    const harness = (...args: string[]) => {
      const r = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), cli, ...args],
        {
          cwd: s.root,
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: '' },
          timeout: 60_000,
        },
      );
      const json = JSON.parse(r.stdout) as {
        ok: boolean;
        data?: unknown;
        error?: { code: string };
      };
      if (json.ok) cliDataSchemas.cleanup.parse(json.data);
      else cliErrorSchema.parse(json.error);
      return { status: r.status, json, stderr: r.stderr };
    };
    const first = harness('cleanup', '--state', s.state, '--run', runId);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.json.data, { status: 'cleaned', receipts: [] });
    assert.equal(existsSync(pending), false, 'запись незавершённой очистки снята');
    const again = harness('cleanup', '--state', s.state, '--run', runId);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(again.json.data, { status: 'nothing-pending' });
    const unknown = harness('cleanup', '--state', s.state, '--run', 'no-such-run');
    assert.equal(unknown.status, 3);
    assert.equal(unknown.json.error?.code, 'NOT_FOUND');
    const noState = harness('cleanup', '--state', join(s.root, 'missing'), '--run', runId);
    assert.equal(noState.json.error?.code, 'NOT_FOUND');
    assert.equal(existsSync(join(s.root, 'missing')), false, 'состояние не создаётся');
  } finally {
    await s.cleanup();
  }
});
