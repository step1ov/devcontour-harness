import './temp-scope.ts';
/**
 * Отказы песочницы ОС проверок без повтора, кроме `ps` (0.1.0-alpha.68):
 * сигнал процессу вне песочницы (`sandbox-signal`, `kill EPERM`) и браузер,
 * который в ней не стартует (`sandbox-browser`). Семантика — та же, что у
 * `sandbox-process-list`: попытка не засчитана, повтора нет, gate удержан
 * (`ENVIRONMENT_GATE_HELD`) до смены gate или повтора ведущего; вызов,
 * добавленный изменением задачи, — обычный засчитанный провал. Обычные
 * провалы тестов рядом с признаком остаются провалами.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOf, type EvidenceRecord } from '../src/contracts/index.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { isolationSupport } from '../src/environment/isolation.ts';
import { redactor } from '../src/environment/redaction.ts';
import { runGate } from '../src/verification/gates.ts';
import {
  browserSignature,
  sandboxSignatureCall,
  sandboxSignatureFailure,
  sandboxSignaturePartial,
  sandboxSignaturePartialNote,
  signalSignature,
} from '../src/verification/sandbox-signatures.ts';
import type { Engine } from '../src/engine/engine.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { environmentGateHolds, gateHoldLine } from '../src/projections/gate-hold.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';
import { repo } from './git-fixture.ts';

const sandbox = isolationSupport();

/** Блок `node --test` (spec) из пилота: тест шлёт сигнал внешней обёртке. */
const killSpec = [
  'ℹ tests 256',
  'ℹ pass 255',
  'ℹ fail 1',
  '',
  '✖ failing tests:',
  '',
  'test at .harness/acceptance/endpoints.test.mjs:129:61',
  '✖ outer wrapper outer-kill (241.88ms)',
  '  Error: kill EPERM',
  '      at process.kill (node:internal/process/per_thread:277:13)',
  '    errno: -1,',
  "    code: 'EPERM',",
  "    syscall: 'kill'",
  '  }',
  '',
  'Trusted handoff refused or gate failed (details withheld)',
].join('\n');

test('признаки: kill EPERM и отказ браузера узнаются, чужие EPERM и обычные ошибки — нет', () => {
  for (const text of [
    'Error: kill EPERM',
    'bash: kill: (4242) - Operation not permitted',
    'kill: kill 4242 failed: operation not permitted',
    "  errno: -1,\n  code: 'EPERM',\n  syscall: 'kill'",
  ])
    assert.ok(signalSignature(text), text);
  for (const text of [
    "WARN EPERM: open '/home/u/.npmrc'",
    'Error: spawn /bin/ps EPERM',
    'Error: kill ESRCH',
    "  code: 'ESRCH',\n  syscall: 'kill'",
    'child.kill() returned false',
  ])
    assert.equal(signalSignature(text), undefined, text);
  for (const text of [
    'Isolated agent-browser smoke failed: Foreground browser daemon unavailable',
    'Error: Failed to launch the browser process!',
    'browserType.launch: Target page, context or browser has been closed',
    'bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.1: Permission denied (1100)',
  ])
    assert.ok(browserSignature(text), text);
  for (const text of [
    'Photo API status',
    'browser-sync started on port 3000',
    'expected page title to equal "Home"',
    'browserType.launch: executablePath: expected string, got number',
  ])
    assert.equal(browserSignature(text), undefined, text);
});

test('классификация: kill EPERM у единственного упавшего теста и общий провал обёртки — среда; провал соседа — нет', () => {
  // JUnit обёртки: сам тест и её общий провал без причины.
  const junit = {
    total: 2,
    texts: [
      'kill EPERM\nError: kill EPERM\n    at process.kill (node:internal)',
      '\nGate execution failed',
    ],
  };
  assert.match(sandboxSignatureFailure('sandbox-signal', killSpec, junit) ?? '', /kill EPERM/);
  // Тот же отчёт без вывода, называющего упавшие тесты: общий провал не доказан.
  assert.equal(sandboxSignatureFailure('sandbox-signal', 'details withheld', junit), undefined);
  // Сосед упал утверждением — провал gate.
  assert.equal(
    sandboxSignatureFailure('sandbox-signal', killSpec, {
      total: 2,
      texts: [junit.texts[0]!, 'AssertionError [ERR_ASSERTION]: 3 !== 4'],
    }),
    undefined,
  );
  // Без JUnit: spec-вывод с одним упавшим тестом.
  assert.match(sandboxSignatureFailure('sandbox-signal', killSpec) ?? '', /kill EPERM/);
  // Spec: признак у одного из двух упавших — провал gate.
  const two = killSpec
    .replace('ℹ fail 1', 'ℹ fail 2')
    .replace('\nTrusted', '\n✖ adds numbers (1ms)\n  AssertionError: 3 !== 4\n\nTrusted');
  assert.equal(sandboxSignatureFailure('sandbox-signal', two), undefined);
});

test('классификация браузера: признак у каждого упавшего — среда; рядом провалы API без признака — провал с пометкой', () => {
  const daemon = 'Isolated agent-browser smoke failed: Foreground browser daemon unavailable';
  assert.ok(sandboxSignatureFailure('sandbox-browser', '', { total: 1, texts: [daemon] }));
  const mixed = {
    total: 4,
    texts: ['Photo API status', 'Photo API status', daemon, 'Gate execution failed'],
  };
  assert.equal(sandboxSignatureFailure('sandbox-browser', '', mixed), undefined);
  const line = sandboxSignaturePartial('sandbox-browser', '', mixed);
  assert.match(line ?? '', /browser daemon unavailable/);
  assert.match(
    sandboxSignaturePartialNote('sandbox-browser', line!),
    /признак отказа среды sandbox-browser .*провал засчитан; .*вынесите проверку в браузере/,
  );
  assert.equal(sandboxSignaturePartial('sandbox-browser', 'Photo API status'), undefined);
});

test('вызов, добавленный изменением: process.kill, shell kill, запуск браузера', () => {
  for (const line of ['process.kill(wrapperPid, "SIGKILL");', 'kill -9 "$PID"', 'x && kill $pid'])
    assert.ok(sandboxSignatureCall('sandbox-signal', line), line);
  for (const line of ['const kill = true;', 'child.kill();', '// we never kill here'])
    assert.equal(sandboxSignatureCall('sandbox-signal', line), false, line);
  for (const line of [
    "import { chromium } from 'playwright';",
    'await chromium.launch({ headless: true });',
    'npx agent-browser open http://127.0.0.1:3000',
  ])
    assert.ok(sandboxSignatureCall('sandbox-browser', line), line);
  assert.equal(sandboxSignatureCall('sandbox-browser', 'const browser = detect();'), false);
});

async function gate(
  command: string[],
  mode: 'none' | 'os',
  at?: { r: ReturnType<typeof repo>; trustedBase?: string },
) {
  const r = at?.r ?? repo();
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  let failure: TaskFailure | undefined;
  try {
    await runGate({
      policy: { isolation: { mode, domains: [] } },
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
        command,
      },
      artifactDir: mkdtempSync(join(tmpdir(), 'harness-art-')),
      signal: new AbortController().signal,
      execution: { env: { ...process.env }, redact: redactor([]) },
      boundary: { hidden: [], readable: [] },
      ...(at?.trustedBase ? { trustedBase: at.trustedBase } : {}),
    });
  } catch (error) {
    if (!(error instanceof TaskFailure)) throw error;
    failure = error;
  }
  assert.equal(recorded.length, 1);
  return { evidence: recorded[0]!, failure };
}

/** Gate, чей отчёт называет `kill EPERM` у единственного testcase. */
const killGate = [
  process.execPath,
  '-e',
  `require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="outer-kill"><failure message="kill EPERM">Error: kill EPERM</failure></testcase></testsuite>'); console.error('Error: kill EPERM'); process.exit(1)`,
];

test(
  'gate в песочнице ОС: kill EPERM из базы — отказ среды sandbox-signal; вызов добавлен кандидатом — засчитанный провал',
  { skip: sandbox.ok ? false : 'песочница ОС недоступна: ' + sandbox.detail },
  async () => {
    const r = repo({ 'README.md': 'app\n', 'kill.test.mjs': 'process.kill(outer, "SIGTERM")\n' });
    const env = await gate(killGate, 'os', { r, trustedBase: r.head() });
    assert.equal(env.failure?.kind, 'environment', env.evidence.summary);
    assert.equal(env.failure?.diagnosis, 'sandbox-signal');
    assert.match(env.evidence.summary, /^GATE_SANDBOX_SIGNAL: /);
    assert.match(env.evidence.summary, /Что сделать: тест не должен посылать сигналы/);
    const base = r.head();
    r.git('checkout', '-q', '-b', 'candidate');
    writeFileSync(join(r.dir, 'more.test.mjs'), 'process.kill(wrapperPid, "SIGKILL")\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'candidate kills');
    const added = await gate(killGate, 'os', { r, trustedBase: base });
    assert.equal(added.failure?.kind, 'gate', added.evidence.summary);
    assert.equal(added.failure?.diagnosis, undefined);
    assert.match(added.evidence.summary, /уберите вызов/);
    assert.match(added.evidence.summary, /more\.test\.mjs/);
    // Без песочницы ОС тот же вывод — обычный провал: EPERM не от песочницы.
    const host = await gate(killGate, 'none', { r, trustedBase: r.head() });
    assert.equal(host.failure?.kind, 'gate');
    assert.equal(host.failure?.diagnosis, undefined);
  },
);

/** Попытка с отказом без повтора `cause` на gate `unit`. */
function failOn(e: Engine, cause: 'sandbox-signal' | 'sandbox-browser', code: string) {
  const a = e.claim('c1');
  assert.ok(a, 'попытка выдана');
  e.phase(a.id, a.token, 'verifying', { candidateSha: sha('c') });
  e.evidence(a.id, a.token, {
    kind: 'test',
    phase: 'candidate',
    sha: sha('c'),
    gate: 'unit',
    passed: false,
    command: ['npm', 'test'],
    exitCode: 1,
    log: '',
    digest: digestOf(cause),
    summary: `${code}: отказ песочницы`,
  });
  e.fail(a.id, a.token, `candidate/unit: ${code}`, { kind: 'environment', cause });
  return a;
}

for (const [cause, code, words] of [
  ['sandbox-signal', 'GATE_SANDBOX_SIGNAL', /сигнал/],
  ['sandbox-browser', 'GATE_SANDBOX_BROWSER', /браузер/],
] as const)
  test(`${cause}: попытка не засчитана, повтора нет, gate удержан до повтора ведущего; ps-проба удержание не снимает`, () => {
    const policy = policyOf((p) => {
      p.concurrency = 1;
    });
    const env = engineOf(policy);
    const e = env.engine;
    ready(e, graphOf({ a: [], b: [] }));
    const a = failOn(e, cause, code);
    const w = e.read((v) => v.work(a.workId)!);
    const [attempt] = e.read((v) => v.attempts(a.workId));
    assert.equal(attempt!.environmentCause, cause);
    assert.equal(w.attempt, 0, 'попытка не засчитана');
    assert.equal(w.environmentHold?.cause, cause);
    assert.equal(w.environmentHold?.gate, 'unit');
    assert.equal(e.read((v) => v.control()).paused, false, 'без общей паузы');
    const other = a.workId === 'a' ? 'b' : 'a';
    assert.equal(e.claim('c1'), undefined, 'вторая работа с тем же gate не выдана');
    const blockers = e.read((v) => e.blockers(v.work(other)!, v));
    const held = blockers.find((b) => b.code === 'ENVIRONMENT_GATE_HELD');
    assert.ok(held, JSON.stringify(blockers));
    assert.match(held.message, words);
    assert.doesNotMatch(held.message, /зовёт ps/);
    // Проба ps ответила `available` — удержание по другой причине остаётся.
    const holds = environmentGateHolds([w], () => w.environmentHold!.digest, {
      isolation: 'os',
      processList: 'available',
    });
    assert.equal(holds.length, 1);
    assert.match(gateHoldLine(holds[0]!, other).ru, words);
    // explain остановленной работы: ход ведущего, технический.
    const d = stopInputsOf(
      { engine: e, policy, workflows: { list: () => [], continues: () => false } },
      { maxAttempts: policy.maxAttempts, repairBudget: policy.repairBudget, workId: a.workId },
    )
      .filter((i) => i.kind === 'work')
      .map(explainStop)[0]!;
    assert.deepEqual(
      [d.code, d.actor, d.action],
      ['RUNTIME_UNAVAILABLE', 'lead', 'fix-environment'],
    );
    assert.equal(d.retryPlanned, false);
    assert.match(d.message, words);
    // Повтор оператора не снимает, повтор ведущего снимает.
    e.retry(a.workId, undefined, 'operator');
    assert.equal(e.claim('c1'), undefined);
    const r = e.retry(a.workId, undefined, 'lead');
    assert.equal(r.work.environmentHold, undefined);
    assert.ok(e.claim('c1'), 'после повтора ведущего попытка выдана');
  });
