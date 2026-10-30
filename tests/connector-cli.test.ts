/**
 * CLI коннектора: команды зарегистрированы в help/schema; недоступный
 * backend — явная диагностика, а не пустой список; читающие команды не
 * создают состояния. Транспорт — настоящий адаптер relay-v1-http против
 * закрытого порта loopback (без сети и без Relay).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cliCommands,
  cliDataSchemas,
  cliErrorSchema,
  contextSnapshotSchema,
} from '../src/contracts/index.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface Envelope {
  ok: boolean;
  command: string | null;
  data?: Record<string, unknown>;
  error?: { code: string };
}

const harness = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 60_000,
  });
  const json = r.stdout ? (JSON.parse(r.stdout) as Envelope) : undefined;
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

test('source: writeScope с "." рядом с другими путями — ошибка конфигурации с путём поля, а не внутренний отказ', () => {
  const f = fixture();
  try {
    const config = JSON.parse(readFileSync(f.source, 'utf8')) as {
      tasks: { writeScope: string[] }[];
    };
    config.tasks[0]!.writeScope = ['.', 'src'];
    writeFileSync(f.source, JSON.stringify(config));
    const r = harness(['source-check', '--source', f.source, '--state', f.state], f.dir);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.json?.error?.code, 'INVALID_INPUT');
    assert.match(r.stderr, /source\.tasks\.0\.writeScope: Весь репозиторий/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

/** Сервер Relay v1 на loopback: одна задача без подзадач и документов. */
async function relayServer(projectId: string) {
  const page = (items: unknown[]) => ({
    items,
    total: items.length,
    nextOffset: null,
    version: 'v1',
  });
  const task = {
    id: 'Task0001',
    key: 'PRODUCT-1',
    title: 'Add greeting',
    description: 'Add greet(name) to src/greet.js',
    column: 'ready',
    revision: 3,
    parentId: null,
    dependencies: [],
  };
  const base = `/api/v1/projects/${projectId}`;
  const reply = (path: string): unknown => {
    if (path === '/api/v1/health') return { status: 'ok', contractVersion: 1 };
    if (path === `${base}/context`) return { projectId, capabilities: [] };
    if (path === `${base}/board-tasks/${task.id}`) return task;
    if (path === `${base}/board-tasks/${task.id}/criteria`) return page([]);
    if (path === `${base}/board-tasks` || path === `${base}/entities`) return page([]);
    return undefined;
  };
  const server = createServer((req, res) => {
    const data = reply(new URL(req.url ?? '/', 'http://x').pathname);
    res.writeHead(data === undefined ? 404 : 200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        data === undefined
          ? { ok: false, error: { code: 'NOT_FOUND', message: 'нет маршрута' } }
          : { ok: true, data },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** CLI без блокировки цикла событий: сервер Relay работает в этом же процессе. */
const harnessAsync = (args: string[], cwd: string) =>
  new Promise<{ status: number | null; stderr: string; json: Envelope }>((done, fail) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd,
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', fail);
    child.on('close', (status) =>
      done({ status, stderr, json: JSON.parse(stdout || 'null') as Envelope }),
    );
  });

test('tasks[].context через CLI: source-snapshot с пакетом controller-mode отвечает по договору и называет пакет', async () => {
  const projectId = 'proj1';
  const relay = await relayServer(projectId);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-connector-cli-')));
  try {
    const pack = join(dir, 'work', 'context', 'controller-mode');
    mkdirSync(join(pack, 'references'), { recursive: true });
    writeFileSync(join(pack, 'AGENTS.controller.md'), '# Controller mode\n');
    writeFileSync(join(pack, 'references', 'AGENTS.md'), '# Product rules\n');
    writeFileSync(
      join(dir, 'connector.json'),
      JSON.stringify({
        version: 1,
        provider: 'relay-v1-http',
        projectId,
        actor: 'harness',
        relay: { endpoint: relay.url, timeoutMs: 2000 },
        repository: { id: 'app' },
        tasks: [{ ref: 'Task0001', writeScope: ['src'], context: ['controller-mode'] }],
      }),
    );
    const args = ['--source', 'connector.json', '--state', 'state'];
    const check = await harnessAsync(['source-check', ...args], dir);
    assert.equal(check.status, 0, check.stderr);

    const snap = await harnessAsync(['source-snapshot', ...args, '--out', 'snapshot'], dir);
    assert.equal(snap.status, 0, snap.stderr);
    assert.equal(snap.json.ok, true, snap.stderr);
    const data = cliDataSchemas['source-snapshot'].parse(snap.json.data);
    assert.deepEqual(
      data.localContext?.map((p) => [p.id, p.files, p.references]),
      [['controller-mode', 1, 1]],
    );
    const manifest = JSON.parse(readFileSync(data.files.manifest, 'utf8')) as {
      localContext: unknown;
    };
    assert.deepEqual(manifest.localContext, data.localContext, 'CLI и manifest называют одно');
    const context = JSON.parse(readFileSync(data.files.context, 'utf8')) as unknown;
    assert.ok(contextSnapshotSchema.safeParse(context).success, 'context.json — по договору');

    const again = await harnessAsync(['source-snapshot', ...args, '--out', 'snapshot'], dir);
    assert.equal(again.status, 0, again.stderr);
    const repeat = cliDataSchemas['source-snapshot'].parse(again.json.data);
    assert.equal(repeat.created, false, 'повтор той же редакции не создаёт снимок');
    assert.equal(repeat.revision, data.revision);
  } finally {
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
