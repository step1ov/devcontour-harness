/**
 * F01/S06: известный коннектору секрет не выходит ни в одну диагностику —
 * отчёт source-check, status, ошибки снимка, причины шагов и операций,
 * lastError доставки, отказ истории, сохранённые SQLite и вывод CLI.
 * Canary — искусственные тестовые строки, не учётные данные. Каждый
 * отрицательный вывод сначала подтверждён контролем без маскирования.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../src/contracts/index.ts';
import { policySecrets } from '../src/integrations/connector/redact.ts';
import { TransportError } from '../src/integrations/connector/transport.ts';
import {
  fakeSuiteBackend,
  scenario,
  suitePolicy,
  type FaultRule,
} from '../src/integrations/connector/testing.ts';

const CANARY = 'CANARY_CONNECTOR_SECRET_5521';

/** Все формы canary (как у redactor: исходная, JSON-экранированная, URL). */
const forms = (secret: string) => [
  secret,
  JSON.stringify(secret).slice(1, -1),
  encodeURIComponent(secret),
];

/** Все байты файлов каталога (рекурсивно), включая SQLite и WAL. */
function dump(dir: string): string {
  if (!existsSync(dir)) return '';
  let out = '';
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (statSync(path).isFile()) out += readFileSync(path).toString('latin1') + '\n';
  }
  return out;
}

const leaks = (text: string, secret = CANARY) => forms(secret).some((f) => text.includes(f));

test('F01/S06: canary из ошибки получателя маскируется в check, status, снимке, шагах, операциях, lastError, истории и SQLite', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const fail = (op: FaultRule['op'], nth?: number): FaultRule => ({
      op,
      ...(nth ? { nth } : {}),
      action: 'fail-before-send',
      message: `backend said: token=${CANARY}`,
    });
    // Контроль: без регистрации секрета canary виден — проверка достижима.
    const control = await s.open({ faults: [fail('identity')] });
    assert.ok(
      leaks(JSON.stringify(await control.connector.check())),
      'контроль: canary виден без маскирования',
    );
    control.close();

    const o = await s.open({ secrets: [CANARY], faults: [fail('identity')] });
    const report = await o.connector.check();
    assert.equal(report.connected, false);
    assert.ok(!leaks(JSON.stringify(report)), 'source-check');
    assert.match(report.problems.join('\n'), /\[REDACTED\]/);
    o.close();

    const snap = await s.open({ secrets: [CANARY], faults: [fail('readTask', 2)] });
    await assert.rejects(snap.connector.snapshot(join(s.root, 'snap')), (e: unknown) => {
      assert.ok(e instanceof HarnessError);
      assert.ok(!leaks(e.message + JSON.stringify(e.issues)), 'ошибка снимка');
      return true;
    });
    snap.close();

    // Доставка: отказ получателя с canary → failed; причины шага/операции и lastError маскированы.
    const run = await s.runOnly({ secrets: [CANARY], faults: [fail('addComment', 1)] });
    const envelope = await run.h.deliver(s.workId, run.connector.sink);
    const state = envelope.delivery.at(-1)!;
    assert.equal(state.status, 'failed');
    assert.ok(state.lastError && !leaks(state.lastError), 'lastError');
    const op = run.connector.store.operations({ workId: s.workId })[0]!;
    assert.ok(!leaks(JSON.stringify(op)), 'операция и шаги');

    // status: ошибка чтения получателя.
    const status = await s.open({ secrets: [CANARY], faults: [fail('readTask')] });
    const view = await status.connector.status(status.h);
    assert.equal((view.tasks[0]!.remote as { reachable: boolean }).reachable, false);
    assert.ok(!leaks(JSON.stringify(view)), 'source-status');
    status.close();

    // История: отказ записи intent с canary — причина отказа попытки маскирована.
    const h = await scenario(fakeSuiteBackend());
    try {
      const hh = await h.open({ secrets: [CANARY], faults: [fail('startSession')] });
      await hh.connector.snapshot(join(h.root, 'snap'));
      await hh.connector.run(hh.h, { author: 'claude' });
      const attempt = hh.h.engine.read((v) => v.attempts()[0]!);
      assert.match(attempt.error ?? '', /История работы не записана/);
      assert.ok(!leaks(JSON.stringify(attempt)), 'отказ истории в попытке');
      hh.close();
      assert.ok(!leaks(dump(h.state)), 'SQLite и артефакты (история)');
    } finally {
      await h.cleanup();
    }
    run.close();
    assert.ok(!leaks(dump(s.state)), 'SQLite состояния harness и коннектора');
  } finally {
    await s.cleanup();
  }
});

test('F01/policy: секреты всех уровней политики (environment, репозиторий, tool profile) собираются для маскирования', () => {
  const policy = {
    environment: { secrets: { A: 'ENV_A' } },
    repositories: [{ environment: { secrets: { B: 'ENV_B' } } }],
    toolProfiles: { p: { environment: { secrets: { C: 'ENV_C' } } } },
  };
  assert.deepEqual(
    policySecrets(policy, { ENV_A: 'a-secret', ENV_B: 'b-secret', ENV_C: 'c-secret' }).sort(),
    ['a-secret', 'b-secret', 'c-secret'],
  );
  void TransportError;
});

test('F01/cli: canary из HTTP-ответа Relay v1 не выходит в stdout/stderr source-check/source-snapshot и в состояние', async () => {
  const canaryRepo = CANARY + '_REPO';
  const server = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: 'INTERNAL', message: `storage failed for ${CANARY} and ${canaryRepo}` },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-connector-secret-')));
  try {
    const source = join(dir, 'connector.json');
    writeFileSync(
      source,
      JSON.stringify({
        version: 1,
        provider: 'relay-v1-http',
        projectId: 'proj1',
        actor: 'harness',
        relay: { endpoint: `http://127.0.0.1:${port}`, timeoutMs: 5000 },
        repository: { id: 'app' },
        tasks: [{ ref: 'PRODUCT-1', writeScope: ['src'] }],
      }),
    );
    const policy = suitePolicy(dir, {
      environment: { secrets: { RELAY_TOKEN: 'F01_CANARY_ENV' } },
    });
    (policy.repositories[0] as { environment?: unknown }).environment = {
      inherit: [],
      values: {},
      secrets: { REPO_TOKEN: 'F01_CANARY_REPO' },
    };
    writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy));
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    // Асинхронный дочерний процесс: сервер в этом же процессе должен отвечать.
    const run = (args: string[], env: Record<string, string>) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', import.meta.resolve('tsx'), cli, ...args],
          {
            cwd: dir,
            env: { ...process.env, NODE_OPTIONS: '', ...env },
          },
        );
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('CLI: нет итога за 60 с'));
        }, 60_000);
        child.on('close', () => {
          clearTimeout(timer);
          resolve(out);
        });
      });
    const check = [
      'source-check',
      '--source',
      source,
      '--policy',
      join(dir, 'policy.json'),
      '--state',
      join(dir, 'state'),
    ];
    // Контроль: секрет не задан в окружении controller — маскировать нечего, canary виден.
    const control = await run(check, {});
    assert.ok(
      leaks(control) && leaks(control, canaryRepo),
      'контроль: canary виден: ' + control.slice(0, 400),
    );
    const env = { F01_CANARY_ENV: CANARY, F01_CANARY_REPO: canaryRepo };
    const masked = await run(check, env);
    assert.match(masked, /\[REDACTED\]/);
    assert.ok(
      !leaks(masked) && !leaks(masked, canaryRepo),
      'source-check: ' + masked.slice(0, 400),
    );
    const snapshot = await run(
      [
        'source-snapshot',
        '--source',
        source,
        '--policy',
        join(dir, 'policy.json'),
        '--state',
        join(dir, 'state'),
        '--out',
        join(dir, 'out'),
      ],
      env,
    );
    assert.ok(
      !leaks(snapshot) && !leaks(snapshot, canaryRepo),
      'source-snapshot: ' + snapshot.slice(0, 400),
    );
    assert.ok(
      !leaks(dump(join(dir, 'state'))) && !leaks(dump(join(dir, 'state')), canaryRepo),
      'состояние',
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
