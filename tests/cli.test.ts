import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliDataSchemas, cliErrorSchema } from '../src/contracts/index.ts';
import { clone, example } from './fixtures.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** Рекурсивный снимок каталога: путь, размер, mtime. */
const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).map((e) => {
    const p = join(e.parentPath, e.name);
    const s = statSync(p);
    return `${p}:${s.size}:${s.mtimeMs}`;
  });

/**
 * Запуск CLI в пустом cwd с отдельными TMPDIR и HOME. Возвращает также, изменилось ли
 * что-нибудь в этих каталогах: команды без записи обязаны оставить их как были.
 */
const harness = (args: string[], cwd = mkdtempSync(join(tmpdir(), 'harness-cwd-'))) => {
  const tmp = mkdtempSync(join(tmpdir(), 'harness-tmp-'));
  const home = mkdtempSync(join(tmpdir(), 'harness-home-'));
  const before = [...tree(cwd), ...tree(tmp), ...tree(home)];
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', TMPDIR: tmp, HOME: home, TSX_DISABLE_CACHE: '1' },
  });
  const after = [...tree(cwd), ...tree(tmp), ...tree(home)];
  const json = JSON.parse(r.stdout) as {
    ok: boolean;
    command: string | null;
    data?: Record<string, unknown>;
    error?: { code: string; class: string; issues: { path: (string | number)[] }[] };
  };
  // Ответ всегда соответствует договору своей команды.
  if (json.ok) cliDataSchemas[json.command as keyof typeof cliDataSchemas].parse(json.data);
  else cliErrorSchema.parse(json.error);
  return { status: r.status, stderr: r.stderr, json, untouched: before.join() === after.join() };
};
const files = (graph: unknown, policy: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(graph));
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy));
  return { dir, graph: join(dir, 'graph.json'), policy: join(dir, 'policy.json') };
};

test('validate: валидный вход — exit 0, digest примера, ни одной записи в cwd, TMPDIR, HOME', () => {
  const f = files(example('graph'), example('policy'));
  const r = harness(['validate', '--graph', f.graph, '--policy', f.policy], f.dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.command, 'validate');
  assert.equal(
    r.json.data?.graphDigest,
    '03c03e691a045303bd67c36feea3a01cf177f0331ebb39cf3e8d5468a190157f',
  );
  assert.equal(r.untouched, true, 'validate ничего не пишет');
});

test('validate: неверный вход — exit 2, код и путь нарушения; stdout остаётся JSON', () => {
  const graph = clone(example('graph')) as { orders: { dependsOn?: string[] }[] };
  graph.orders[0]!.dependsOn = ['ghost'];
  const f = files(graph, example('policy'));
  const r = harness(['validate', '--graph', f.graph, '--policy', f.policy]);
  assert.equal(r.status, 2);
  assert.equal(r.json.error?.code, 'GRAPH_UNKNOWN_DEPENDENCY');
  assert.deepEqual(r.json.error?.issues[0]?.path, ['graph', 'orders', 0, 'dependsOn', 0]);
  assert.match(r.stderr, /GRAPH_UNKNOWN_DEPENDENCY/);
  assert.equal(r.untouched, true);

  const policy = clone(example('policy')) as { roles: Record<string, { writePaths?: string[] }> };
  policy.roles.developer!.writePaths = ['docs'];
  const g = files(example('graph'), policy);
  const cross = harness(['validate', '--graph', g.graph, '--policy', g.policy]);
  assert.equal(cross.status, 2, 'связь поручения с политикой проверяется и через CLI');
  assert.equal(cross.json.error?.code, 'INVALID_INPUT');
  assert.match(JSON.stringify(cross.json.error?.issues), /не пересекается/);

  const missing = harness(['validate', '--graph', join(f.dir, 'none.json'), '--policy', f.policy]);
  assert.equal(missing.status, 2);
  assert.equal(missing.json.error?.code, 'INVALID_INPUT');
  assert.equal(harness(['validate', '--bogus']).status, 2);
});

test('Неизвестная команда и читающие команды без состояния — отказ без записи', () => {
  const unknown = harness(['deploy']);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.json.error?.code, 'UNSUPPORTED_COMMAND');
  assert.equal(unknown.json.command, null);
  assert.equal(unknown.untouched, true);
  for (const command of ['status', 'events', 'pause', 'result']) {
    const read = harness([command, '--state', 'state', '--work', 'w']);
    assert.equal(read.status, 3, command);
    assert.equal(read.json.command, command);
    assert.equal(read.json.error?.code, 'NOT_FOUND');
    assert.equal(read.untouched, true, command + ' не создаёт каталог состояния');
  }
  const run = harness(['run', '--state', 'state']);
  assert.equal(run.status, 2, 'run без графа и политики — неверный вход');
  assert.equal(run.untouched, true);
});

test('--version равна версии package.json', () => {
  const r = harness(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.json.data?.harness, pkg.version);
  assert.equal(r.json.data?.apiVersion, 'devcontour-harness/v1alpha1');
});
