import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clone, example } from './fixtures.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (args: string[], cwd = tmpdir()) => {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return {
    status: r.status,
    stderr: r.stderr,
    json: JSON.parse(r.stdout) as {
      ok: boolean;
      command: string | null;
      data?: Record<string, unknown>;
      error?: { code: string; class: string; issues: { path: string[] }[] };
    },
  };
};
const files = (graph: unknown, policy: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(graph));
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy));
  return { dir, graph: join(dir, 'graph.json'), policy: join(dir, 'policy.json') };
};

test('validate: валидный вход — exit 0 и JSON с digests; из чужого cwd', () => {
  const f = files(example('graph'), example('policy'));
  const r = harness(['validate', '--graph', f.graph, '--policy', f.policy], f.dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.command, 'validate');
  assert.match(String(r.json.data?.graphDigest), /^[a-f0-9]{64}$/);
});

test('validate: неверный вход — exit 2, код и путь нарушения; stdout остаётся JSON', () => {
  const graph = clone(example('graph')) as { orders: { dependsOn?: string[] }[] };
  graph.orders[0]!.dependsOn = ['ghost'];
  const f = files(graph, example('policy'));
  const r = harness(['validate', '--graph', f.graph, '--policy', f.policy]);
  assert.equal(r.status, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error?.code, 'GRAPH_UNKNOWN_DEPENDENCY');
  assert.deepEqual(r.json.error?.issues[0]?.path, ['graph', 'orders', 0, 'dependsOn', 0]);
  assert.match(r.stderr, /GRAPH_UNKNOWN_DEPENDENCY/);

  const missing = harness(['validate', '--graph', join(f.dir, 'none.json'), '--policy', f.policy]);
  assert.equal(missing.status, 2);
  assert.equal(missing.json.error?.code, 'INVALID_INPUT');
  const flag = harness(['validate', '--bogus']);
  assert.equal(flag.status, 2);
});

test('Неизвестная и не реализованная команды — отказ входа, без побочных эффектов', () => {
  const unknown = harness(['deploy']);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.json.error?.code, 'UNSUPPORTED_COMMAND');
  assert.equal(unknown.json.command, null);
  const later = harness(['run']);
  assert.equal(later.status, 2);
  assert.equal(later.json.command, 'run');
  assert.equal(later.json.error?.code, 'UNSUPPORTED_COMMAND');
});

test('--version сообщает версию пакета и API', () => {
  const r = harness(['--version']);
  assert.equal(r.status, 0);
  assert.match(String(r.json.data?.harness), /^0\.1\.0-alpha\.\d+$/);
  assert.equal(r.json.data?.apiVersion, 'devcontour-harness/v1alpha1');
});
