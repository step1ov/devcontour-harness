/**
 * CLI коннектора: команды зарегистрированы в help/schema; недоступный
 * backend — явная диагностика, а не пустой список; читающие команды не
 * создают состояния. Транспорт — настоящий адаптер relay-v1-http против
 * закрытого порта loopback (без сети и без Relay).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliCommands, cliDataSchemas, cliErrorSchema } from '../src/contracts/index.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const harness = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 60_000,
  });
  const json = r.stdout
    ? (JSON.parse(r.stdout) as {
        ok: boolean;
        command: string | null;
        data?: Record<string, unknown>;
        error?: { code: string };
      })
    : undefined;
  if (json?.ok) cliDataSchemas[json.command as keyof typeof cliDataSchemas].parse(json.data);
  else if (json) cliErrorSchema.parse(json.error);
  return { status: r.status, stderr: r.stderr, json };
};

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-connector-cli-')));
  const source = join(dir, 'connector.json');
  writeFileSync(
    source,
    JSON.stringify({
      version: 1,
      provider: 'relay-v1-http',
      projectId: 'proj1',
      actor: 'harness',
      relay: { endpoint: 'http://127.0.0.1:9', timeoutMs: 2000 },
      repository: { id: 'app' },
      tasks: [{ ref: 'PRODUCT-1', writeScope: ['src'] }],
    }),
  );
  return { dir, source, state: join(dir, 'state') };
}

test('W01/cli: команды коннектора есть в договоре CLI и help', () => {
  for (const name of [
    'source-check',
    'source-snapshot',
    'source-status',
    'source-deliver',
    'source-reconcile',
  ])
    assert.ok(name in cliCommands && name in cliDataSchemas, name);
  assert.ok(cliCommands.run.args.some((a) => a.name === '--source'));
  const f = fixture();
  try {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    for (const name of [
      'source-check',
      'source-snapshot',
      'source-status',
      'source-deliver',
      'source-reconcile',
    ])
      assert.match(r.stderr, new RegExp(name));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('W04/cli: недоступный backend — явный отказ source-check/source-snapshot, без пустого снимка и без состояния', () => {
  const f = fixture();
  try {
    const check = harness(['source-check', '--source', f.source, '--state', f.state], f.dir);
    assert.equal(check.status, 3, check.stderr);
    assert.equal(check.json?.ok, true);
    assert.equal(check.json?.data?.connected, false);
    assert.ok((check.json?.data?.problems as string[]).length > 0);
    assert.match(
      String((check.json?.data?.ownership as { note: string }).note),
      /разными каталогами состояния/,
    );
    assert.equal(existsSync(f.state), false, 'source-check не создаёт состояние');

    const out = join(f.dir, 'out');
    const snap = harness(
      ['source-snapshot', '--source', f.source, '--state', f.state, '--out', out],
      f.dir,
    );
    assert.notEqual(snap.status, 0);
    assert.equal(snap.json?.ok, false);
    assert.ok(
      ['DELIVERY_FAILED', 'NOT_READY'].includes(snap.json.error!.code),
      snap.json.error!.code,
    );
    assert.equal(existsSync(out) && readdirSync(out).length > 0, false, 'нет файлов снимка');

    const status = harness(['source-status', '--source', f.source, '--state', f.state], f.dir);
    assert.equal(status.json?.ok, false);
    assert.equal(status.json?.error?.code, 'NOT_FOUND');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
