import './temp-scope.ts';
/**
 * Чей отказ `ps` в песочнице проверок: решает изменение кандидата, а не
 * «есть ли в базе где-нибудь вызов». Добавленные строки `база..кандидат`
 * вызывают список процессов — засчитанный провал исполнителю с его файлами;
 * изменение вызова не добавило (вызов в базе, в зависимости или в
 * неотслеживаемом файле) — отказ среды и удержание gate. Строка `'ps'` в
 * массиве или другом литерале вызовом не считается.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceRecord } from '../src/contracts/index.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { isolationSupport } from '../src/environment/isolation.ts';
import { redactor } from '../src/environment/redaction.ts';
import {
  processListAdded,
  processListBackend,
  processListCallers,
  runGate,
} from '../src/verification/gates.ts';
import { processListCall } from '../src/verification/process-list.ts';
import { repo } from './git-fixture.ts';

const sandbox = isolationSupport();

test('шаблоны вызова ps: вызовы exec/spawn/execFile/execa и shell, а не слово ps в литерале', () => {
  for (const line of [
    "execFileSync('/bin/ps', ['-A'])",
    "cp.execFile('ps', ['-ax'])",
    "child_process.exec('ps -ax')",
    "await execa('ps', ['-ax'])",
    'await $`ps -ax`',
    "spawn('/usr/bin/top', ['-l1'])",
    "const PS = '/bin/ps';",
    'pgrep -f node',
    '  "test": "ps -ax && node --test"',
    'x=$(ps -o pid=)',
  ])
    assert.equal(processListCall(line), true, line);
  for (const line of [
    "const modes = ['ps', 'dev'];",
    "myexec('ps')",
    'foo | grep ps',
    'top of the list',
    "const ps = require('./ps');",
    "it('ps lists', () => {})",
  ])
    assert.equal(processListCall(line), false, line);
});

/** База со своим скриптом на ps; кандидат — ветка `candidate` от неё. */
function baseWithScript() {
  const r = repo({
    'README.md': 'app\n',
    'scripts/kill.sh': 'pgrep -f node\n',
    'src/app.ts': 'export const x = 1;\n',
  });
  const base = r.head();
  r.git('checkout', '-q', '-b', 'candidate');
  return { r, base };
}

test('сценарий A: в базе ps в постороннем скрипте, исполнитель добавил тест с ps — файлы исполнителя', async () => {
  const { r, base } = baseWithScript();
  writeFileSync(join(r.dir, 'lists.test.mjs'), "execFileSync('/bin/ps', ['-ax']);\n");
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'test calls ps');
  assert.deepEqual(await processListAdded(r.dir, base, r.head()), ['lists.test.mjs']);
  // Вызов в базе был и раньше — старый вопрос «есть ли в базе» отвечал «среда».
  assert.deepEqual(await processListCallers(r.dir, base), ['scripts/kill.sh']);
});

test('сценарий B: изменение добавило только литерал ps, вызов — в зависимости и неотслеживаемом файле — не исполнителю', async () => {
  const { r, base } = baseWithScript();
  writeFileSync(join(r.dir, 'src/modes.ts'), "export const modes = ['ps', 'dev'];\n");
  mkdirSync(join(r.dir, 'node_modules/dep'), { recursive: true });
  writeFileSync(join(r.dir, 'node_modules/dep/index.js'), "execFile('ps', ['-ax']);\n");
  r.git('add', 'src/modes.ts');
  r.git('add', '-f', 'node_modules/dep/index.js');
  r.git('commit', '-q', '-m', 'modes and vendored dep');
  writeFileSync(join(r.dir, 'local.mjs'), "execFileSync('/bin/ps', ['-ax']);\n");
  assert.deepEqual(await processListAdded(r.dir, base, r.head()), []);
});

async function gate(r: ReturnType<typeof repo>, trustedBase: string) {
  const forged = [
    process.execPath,
    '-e',
    `require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="t"><failure message="spawnSync /bin/ps EPERM"/></testcase></testsuite>'); console.error('Error: spawnSync /bin/ps EPERM'); process.exit(1)`,
  ];
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  const original = processListBackend.probe;
  processListBackend.probe = () =>
    Promise.resolve({ status: 'unavailable', detail: 'env: /bin/ps: Operation not permitted' });
  try {
    await runGate({
      policy: { harnessMode: 'strict', isolation: { mode: 'os', domains: [] } },
      record: (e) => {
        recorded.push(e);
        return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
      },
      cwd: r.dir,
      sha: r.head(),
      phase: 'candidate',
      gate: {
        id: 'root-tests',
        kind: 'test',
        timeoutMs: 30000,
        report: { type: 'junit', path: 'test-results/junit.xml' },
        command: forged,
      },
      artifactDir: mkdtempSync(join(tmpdir(), 'harness-art-')),
      signal: new AbortController().signal,
      execution: { env: { ...process.env }, redact: redactor([]) },
      boundary: { hidden: [], readable: [] },
      trustedBase,
    });
  } catch (error) {
    if (!(error instanceof TaskFailure)) throw error;
    return { failure: error, summary: recorded[0]!.summary };
  } finally {
    processListBackend.probe = original;
  }
  assert.fail('gate должен упасть');
}

test(
  'gate: сценарий A — засчитанный провал исполнителю с советом и его файлом; сценарий B — отказ среды',
  { skip: sandbox.ok ? false : 'песочница ОС недоступна: ' + sandbox.detail },
  async () => {
    const a = baseWithScript();
    writeFileSync(join(a.r.dir, 'lists.test.mjs'), "execFileSync('/bin/ps', ['-ax']);\n");
    a.r.git('add', '-A');
    a.r.git('commit', '-q', '-m', 'test calls ps');
    const writer = await gate(a.r, a.base);
    assert.equal(writer.failure.kind, 'gate', writer.summary);
    assert.equal(writer.failure.diagnosis, undefined);
    assert.match(writer.summary, /уберите вызов/);
    assert.match(writer.summary, /process\.kill\(pid, 0\)/);
    assert.match(writer.summary, /lists\.test\.mjs/);
    assert.doesNotMatch(writer.summary, /kill\.sh/);

    const b = baseWithScript();
    writeFileSync(join(b.r.dir, 'src/modes.ts'), "export const modes = ['ps', 'dev'];\n");
    b.r.git('add', '-A');
    b.r.git('commit', '-q', '-m', 'modes');
    const env = await gate(b.r, b.base);
    assert.equal(env.failure.kind, 'environment', env.summary);
    assert.equal(env.failure.diagnosis, 'sandbox-process-list');
  },
);
