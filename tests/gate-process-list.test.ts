import './temp-scope.ts';
/**
 * Gate, которому нужен список процессов (`ps`), в песочнице ОС проверок.
 *
 * На macOS ядро не запускает setuid-программы (`/bin/ps`) из песочницы, и
 * gate падал `spawn EPERM` провалом кода, хотя на хосте те же тесты проходят.
 * Здесь: настоящая песочница воспроизводит отказ, gate называет его отказом
 * среды `sandbox-process-list` (`GATE_SANDBOX_PROCESS_LIST`) с советом,
 * признак не прячет настоящий провал соседнего теста и не принимается без
 * подтверждения собственной пробой harness; `doctor` и `smoke` называют
 * возможность до попыток.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cliDataSchemas,
  executionPolicySchema,
  type EvidenceRecord,
  type GatePolicy,
} from '../src/contracts/index.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { isolationSupport } from '../src/environment/isolation.ts';
import { redactor } from '../src/environment/redaction.ts';
import { doctor } from '../src/control/doctor.ts';
import { gatesText } from '../src/control/gates-check.ts';
import { processListCallers, smokeLifecycle, smokeText } from '../src/control/lifecycle-smoke.ts';
import { probeProcessList, processListBackend, runGate } from '../src/verification/gates.ts';
import {
  GATE_SANDBOX_PROCESS_LIST,
  processListFailure,
  processListLine,
  processListSignature,
  type ProcessListCapability,
} from '../src/verification/process-list.ts';
import { example } from './fixtures.ts';
import { repo } from './git-fixture.ts';

const sandbox = isolationSupport();
const macSandbox = !sandbox.ok
  ? 'песочница ОС недоступна: ' + sandbox.detail
  : process.platform !== 'darwin'
    ? 'setuid-отказ ps — свойство ядра macOS'
    : false;

const unavailable: ProcessListCapability = {
  status: 'unavailable',
  command: ['/bin/ps', '-o', 'pid=', '-p', '1'],
  detail: 'код 126: env: /bin/ps: Operation not permitted',
};

/** Подменить пробу harness на время теста. */
async function withProbe<T>(capability: ProcessListCapability, body: () => Promise<T>) {
  const original = processListBackend.probe;
  processListBackend.probe = () => Promise.resolve(capability);
  try {
    return await body();
  } finally {
    processListBackend.probe = original;
  }
}

/**
 * Gate-скрипт: запускает `/bin/ps` (`execFileSync` — «spawnSync /bin/ps
 * EPERM», `spawn` — голое «spawn EPERM», как в реальном отказе) и пишет JUnit с
 * исходом; `extra` — дополнительный упавший testcase без признака.
 */
function psGate(how: 'execFileSync' | 'spawn', extra = false) {
  const script = `
const fs = require('fs');
const cp = require('child_process');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
let error;
try {
  ${
    how === 'execFileSync'
      ? `cp.execFileSync('/bin/ps', ['-A', '-E', '-ww', '-o', 'pid=,lstart=,command='], { stdio: 'pipe' });`
      : `const child = cp.spawn('/bin/ps', ['-A', '-E', '-ww', '-o', 'pid=,lstart=,command=']); child.on('error', () => {});`
  }
} catch (e) { error = e; }
const cases = [error
  ? '<testcase name="lists worktree processes"><failure message="' + esc(error.message) + '">' + esc(error.stack) + '</failure></testcase>'
  : '<testcase name="lists worktree processes"/>'];
${extra ? `cases.push('<testcase name="adds numbers"><failure message="expected 3, got 4">AssertionError</failure></testcase>');` : ''}
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite>' + cases.join('') + '</testsuite>');
if (error) console.error(error.message);
process.exit(error || ${extra} ? 1 : 0);
`;
  return [process.execPath, '-e', script];
}

async function gate(
  command: string[],
  mode: 'none' | 'os',
  at?: { r: ReturnType<typeof repo>; trustedBase?: string },
) {
  const r = at?.r ?? repo();
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  const full = {
    id: 'root-tests',
    kind: 'test',
    timeoutMs: 30000,
    report: { type: 'junit', path: 'test-results/junit.xml' },
    command,
  } as GatePolicy;
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
      gate: full,
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

test('признак отказа списка процессов: названная программа, голый spawn EPERM, чужой EPERM — нет', () => {
  for (const line of [
    'Error: spawnSync /bin/ps EPERM',
    'Error: spawn /bin/ps EPERM',
    '/bin/sh: /bin/ps: Operation not permitted',
    'env: /bin/ps: Operation not permitted',
    "sandbox-exec: execvp() of '/bin/ps' failed: Operation not permitted",
    'pgrep: Cannot get process list',
  ])
    assert.equal(processListSignature(`noise\n${line}\n`)?.named, true, line);
  assert.deepEqual(processListSignature('x\nError: spawn EPERM\n'), {
    line: 'Error: spawn EPERM',
    named: false,
  });
  for (const line of [
    "WARN EPERM: open '/home/u/.npmrc'",
    'Error: spawn /usr/bin/git EPERM',
    "rm: cannot remove 'x': Operation not permitted",
    'apps/ps: Operation not permitted',
  ])
    assert.equal(processListSignature(line), undefined, line);
});

test('признак при JUnit: каждый упавший testcase с признаком; настоящий провал соседа или неполный список — не среда', () => {
  const ps = 'spawnSync /bin/ps EPERM';
  assert.equal(processListFailure('', { total: 2, texts: [ps, 'spawn EPERM'] })?.named, true);
  assert.equal(processListFailure(ps, { total: 2, texts: [ps, 'expected 3, got 4'] }), undefined);
  assert.equal(processListFailure(ps, { total: 3, texts: [ps, ps] }), undefined);
  // Без упавших testcases решает вывод.
  assert.equal(processListFailure(`x\n${ps}`)?.named, true);
});

test('признак без JUnit: голый spawn EPERM рядом с провалами утверждений и лишние упавшие тесты — провал gate', () => {
  const tap = [
    'TAP version 13',
    'not ok 1 - adds numbers',
    '  error: AssertionError [ERR_ASSERTION]: 3 !== 4',
    'not ok 2 - subtracts',
    '  error: expected 1 to equal 2',
    'warn: child_process spawn EPERM (ignored)',
    '# fail 2',
  ].join('\n');
  assert.equal(processListFailure(tap), undefined, 'голый признак без JUnit — не среда');
  const named = 'Error: spawnSync /bin/ps EPERM';
  assert.equal(
    processListFailure(tap.replace('warn: child_process spawn EPERM (ignored)', named)),
    undefined,
  );
  // Названный признак, но упавших тестов больше, чем строк признака.
  assert.equal(
    processListFailure(
      ['not ok 1 - lists', '  ' + named, 'not ok 2 - other', '# fail 2'].join('\n'),
    ),
    undefined,
  );
  // Единственный упавший тест — тот, что звал ps.
  assert.equal(
    processListFailure(['not ok 1 - lists', '  ' + named, '# fail 1'].join('\n'))?.named,
    true,
  );
  assert.equal(processListFailure(`x\n${named}`)?.named, true);
  assert.equal(processListFailure('x\nError: spawn EPERM'), undefined);
});

test(
  'вызов ps добавлен кандидатом — засчитанный провал gate исполнителю; изменение вызова не добавило — отказ среды',
  { skip: sandbox.ok ? false : 'песочница ОС недоступна: ' + sandbox.detail },
  async () => {
    const forged = [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="t"><failure message="spawn /bin/ps EPERM"/></testcase></testsuite>'); console.error('Error: spawn /bin/ps EPERM'); process.exit(1)`,
    ];
    const r = repo({ 'README.md': 'app\n', 'src/app.ts': 'export const x = 1;\n' });
    const base = r.head();
    r.git('checkout', '-q', '-b', 'candidate');
    writeFileSync(join(r.dir, 'ps.test.mjs'), "execFileSync('/bin/ps', ['-A'])\n");
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'candidate calls ps');
    const added = await withProbe(unavailable, () => gate(forged, 'os', { r, trustedBase: base }));
    assert.equal(added.failure?.kind, 'gate', added.evidence.summary);
    assert.equal(added.failure?.diagnosis, undefined);
    assert.match(
      added.evidence.summary,
      /тест вызывает ps, в песочнице проверок это запрещено; уберите вызов/,
    );
    assert.match(added.evidence.summary, /ps\.test\.mjs/);
    assert.doesNotMatch(added.evidence.summary, /этого не снимет/);
    // Тот же вызов уже в базе: отказ среды, ход ведущего.
    const inBase = await withProbe(unavailable, () =>
      gate(forged, 'os', { r, trustedBase: r.head() }),
    );
    assert.equal(inBase.failure?.diagnosis, 'sandbox-process-list', inBase.evidence.summary);
    r.git('checkout', '-q', 'main');
    writeFileSync(join(r.dir, 'base-ps.mjs'), "execFileSync('/bin/ps', ['-A'])\n");
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'base calls ps');
    const base2 = r.head();
    r.git('checkout', '-q', '-b', 'candidate2');
    writeFileSync(join(r.dir, 'more-ps.mjs'), "execFileSync('/bin/ps', ['-x'])\n");
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'more');
    // Вызов есть и в базе, но изменение добавило свой — провал исполнителю
    // с его файлом, без чужого файла базы.
    const both = await withProbe(unavailable, () => gate(forged, 'os', { r, trustedBase: base2 }));
    assert.equal(both.failure?.kind, 'gate', both.evidence.summary);
    assert.match(both.evidence.summary, /more-ps\.mjs/);
    assert.doesNotMatch(both.evidence.summary, /base-ps\.mjs/);
  },
);

test(
  'проба harness: ps в песочнице проверок недоступен на macOS (setuid), на хосте — доступен',
  { skip: macSandbox },
  async () => {
    const probed = await probeProcessList('os');
    assert.equal(probed.status, 'unavailable', probed.detail);
    assert.match(probed.detail, /Operation not permitted/);
    assert.deepEqual(await probeProcessList('none'), {
      status: 'not-isolated',
      detail: 'isolation.mode: none',
    });
    assert.match(processListLine(probed), new RegExp(GATE_SANDBOX_PROCESS_LIST));
  },
);

test(
  'gate с /bin/ps: на хосте проходит, в песочнице ОС — отказ среды sandbox-process-list с советом, а не провал кода',
  { skip: macSandbox },
  async () => {
    const host = await gate(psGate('execFileSync'), 'none');
    assert.equal(host.failure, undefined, host.evidence.summary);
    assert.equal(host.evidence.passed, true);

    for (const how of ['execFileSync', 'spawn'] as const) {
      const { evidence, failure } = await gate(psGate(how), 'os');
      assert.equal(evidence.passed, false);
      assert.equal(failure?.kind, 'environment', evidence.summary);
      assert.equal(failure.diagnosis, 'sandbox-process-list');
      assert.match(
        evidence.summary,
        new RegExp(`^${GATE_SANDBOX_PROCESS_LIST}: gate запускает ps`),
      );
      assert.match(evidence.summary, /setuid/);
      assert.match(evidence.summary, /process\.kill\(pid, 0\)/);
      assert.match(evidence.summary, how === 'spawn' ? /spawn EPERM/ : /spawnSync \/bin\/ps EPERM/);
    }
  },
);

test(
  'gate с /bin/ps и настоящим провалом соседнего теста — провал gate: признак не прячет дефект',
  { skip: macSandbox },
  async () => {
    const { evidence, failure } = await gate(psGate('execFileSync', true), 'os');
    assert.equal(failure?.kind, 'gate', evidence.summary);
    assert.match(evidence.summary, /adds numbers: expected 3, got 4/);
  },
);

test(
  'напечатанный признак без подтверждения пробой harness — провал gate',
  { skip: sandbox.ok ? false : 'песочница ОС недоступна: ' + sandbox.detail },
  async () => {
    const forged = [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="t"><failure message="spawn EPERM"/></testcase></testsuite>'); console.error('Error: spawn /bin/ps EPERM'); process.exit(1)`,
    ];
    const available = await withProbe({ status: 'available', detail: 'ps отработал' }, () =>
      gate(forged, 'os'),
    );
    assert.equal(available.failure?.kind, 'gate', available.evidence.summary);
    // Та же проверка при подтверждённой недоступности — отказ среды.
    const confirmed = await withProbe(unavailable, () => gate(forged, 'os'));
    assert.equal(confirmed.failure?.diagnosis, 'sandbox-process-list');
    // Без песочницы ОС признак ничего не значит: ps запускался на хосте.
    const none = await withProbe(unavailable, () => gate(forged, 'none'));
    assert.equal(none.failure?.kind, 'gate');
  },
);

test('harness gates --human: причина среды названа рядом с провалом', () => {
  const text = gatesText({
    id: 'G',
    repositoryId: 'app',
    sha: 'a'.repeat(40),
    passed: false,
    failFast: false,
    durationMs: 1000,
    gates: [
      {
        gate: 'root-tests',
        status: 'failed',
        exitCode: 1,
        summary: `${GATE_SANDBOX_PROCESS_LIST}: gate запускает ps`,
        environment: 'sandbox-process-list',
      },
    ],
    logs: '/x',
  });
  assert.match(text, /root-tests\s+failed\s+1\s+\[среда: sandbox-process-list\] GATE_SANDBOX/);
});

test('doctor: список процессов в песочнице проверок — поле sandbox.processList и строка в notes', async () => {
  const policy = executionPolicySchema.parse({
    ...structuredClone(example('policy')),
    isolation: { mode: 'os', domains: [] },
  });
  const report = await doctor(policy, {}, undefined, undefined, undefined, {
    resourceDatabase: false,
    processList: () => Promise.resolve(unavailable),
  });
  if (!sandbox.ok) {
    assert.equal(report.sandbox.processList, undefined, 'без песочницы пробы нет');
    return;
  }
  assert.equal(report.sandbox.processList?.status, 'unavailable');
  assert.match(report.sandbox.processList.line, /недоступен/);
  assert.ok(
    report.notes?.some((n) => n.startsWith('sandbox-process-list: ') && n.includes('spawn EPERM')),
    JSON.stringify(report.notes),
  );
  assert.ok(!report.problems.some((p) => /список процессов/.test(p)), 'не проблема среды');
  cliDataSchemas.doctor.parse(report);
  // Без песочницы ОС проба не нужна; без опции — не исполняется.
  const none = await doctor(
    executionPolicySchema.parse({ ...policy, isolation: { mode: 'none', domains: [] } }),
    {},
    undefined,
    undefined,
    undefined,
    { resourceDatabase: false, processList: () => Promise.reject(new Error('не вызывать')) },
  );
  assert.equal(none.sandbox.processList?.status, 'not-isolated');
  const quiet = await doctor(policy, {}, undefined, undefined, undefined, {
    resourceDatabase: false,
  });
  assert.equal(quiet.sandbox.processList, undefined);
});

test(
  'smoke: недоступный список процессов и файлы, которые зовут ps, — предупреждение до попыток',
  { skip: sandbox.ok ? false : 'песочница ОС недоступна: ' + sandbox.detail },
  async () => {
    const r = repo({
      'README.md': 'calls /bin/ps in docs only\n',
      'scripts/worktrees/system.mjs':
        "execFile('/bin/ps', ['-A', '-E', '-ww', '-o', 'pid=,lstart=,command='])\n",
      'scripts/kill.sh': 'pgrep -f node\n',
      'src/app.ts': 'export const x = 1;\n',
    });
    assert.deepEqual((await processListCallers(r.dir, r.head())).sort(), [
      'scripts/kill.sh',
      'scripts/worktrees/system.mjs',
    ]);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-smoke-')));
    const raw = structuredClone(example('policy')) as Record<string, unknown> & {
      repositories: Record<string, unknown>[];
    };
    raw.repositories[0]!.path = r.dir;
    raw.isolation = { mode: 'os', domains: [] };
    const policy = executionPolicySchema.parse(raw);
    r.git('update-ref', policy.repositories[0]!.targetRef, 'HEAD');
    const data = await smokeLifecycle({
      policy,
      baseDir: root,
      stateDir: join(root, 'state'),
      rev: 'HEAD',
      resourceDatabase: join(root, 'resources.sqlite'),
      processList: () => Promise.resolve(unavailable),
    });
    assert.equal(data.processList?.status, 'unavailable');
    assert.deepEqual(data.processList.callers?.sort(), [
      'scripts/kill.sh',
      'scripts/worktrees/system.mjs',
    ]);
    assert.ok(
      data.warnings?.some(
        (w) => w.startsWith('sandbox-process-list: ') && w.includes('scripts/worktrees/system.mjs'),
      ),
      JSON.stringify(data.warnings),
    );
    cliDataSchemas.smoke.parse(data);
    assert.match(
      smokeText(data),
      /предупреждение: sandbox-process-list: .*GATE_SANDBOX_PROCESS_LIST/,
    );
    // Доступный список процессов — строка возможности, без предупреждения и поиска файлов.
    const ok = await smokeLifecycle({
      policy,
      baseDir: root,
      stateDir: join(root, 'state'),
      rev: 'HEAD',
      resourceDatabase: join(root, 'resources.sqlite'),
      processList: () => Promise.resolve({ status: 'available', detail: 'ps отработал' }),
    });
    assert.equal(ok.processList?.callers, undefined);
    assert.ok(!ok.warnings?.some((w) => w.startsWith('sandbox-process-list')));
    assert.match(
      smokeText(ok),
      /возможность: список процессов \(ps\) в песочнице проверок: доступен/,
    );
  },
);

test(
  'harness gates на коммите: gate с /bin/ps в песочнице ОС — failed с environment: sandbox-process-list',
  { skip: macSandbox },
  async () => {
    const { checkGates } = await import('../src/control/gates-check.ts');
    const r = repo({ 'README.md': 'app\n' });
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-gates-ps-')));
    const raw = structuredClone(example('policy')) as Record<string, unknown> & {
      repositories: Record<string, unknown>[];
    };
    raw.repositories[0]!.path = r.dir;
    raw.repositories[0]!.gates = [
      {
        id: 'root-tests',
        kind: 'test',
        command: psGate('execFileSync'),
        report: { type: 'junit', path: 'reports/root.xml' },
      },
    ];
    raw.isolation = { mode: 'os', domains: [] };
    const data = await checkGates({
      policy: executionPolicySchema.parse(raw),
      baseDir: root,
      stateDir: join(root, 'state'),
      rev: 'HEAD',
      resourceDatabase: join(root, 'resources.sqlite'),
    });
    cliDataSchemas.gates.parse(data);
    assert.equal(data.passed, false);
    const g = data.gates.find((x) => x.gate === 'root-tests')!;
    assert.equal(g.status, 'failed');
    assert.equal(g.environment, 'sandbox-process-list', g.summary);
    assert.match(g.summary ?? '', new RegExp(GATE_SANDBOX_PROCESS_LIST));
  },
);

test('отказ sandbox-process-list: без автоматического повтора и без паузы выдачи — ход ведущего, попытка не засчитана', async () => {
  const { engineOf, graphOf, policyOf, ready } = await import('./engine-fixture.ts');
  const { repairDecision } = await import('../src/engine/repair.ts');
  const { explainStop } = await import('../src/projections/stop.ts');
  const { engine } = engineOf(policyOf((p) => ((p as { maxAttempts: number }).maxAttempts = 3)));
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  engine.phase(a.id, a.token, 'verifying', { candidateSha: 'c'.repeat(40) });
  engine.fail(a.id, a.token, `candidate/root-tests: ${GATE_SANDBOX_PROCESS_LIST}: spawn EPERM`, {
    kind: 'environment',
    cause: 'sandbox-process-list',
  });
  const work = engine.read((v) => v.work('a')!);
  const [attempt] = engine.read((v) => v.attempts('a'));
  assert.equal(attempt!.environmentCause, 'sandbox-process-list');
  assert.equal(work.attempt, 0, 'попытка не засчитана');
  assert.equal(engine.read((v) => v.control()).paused, false, 'выдача не стоит');
  const decision = engine.read((v) => repairDecision(v, [work], { budgetLeft: 6, maxAttempts: 3 }));
  assert.equal(decision?.action, 'stop', 'повтор дал бы тот же отказ');
  assert.match(decision?.reason ?? '', /поменять gate или команду/);
  assert.match(decision?.reason ?? '', /не засчитана/);
  // explain: ход ведущего по правилу environment-gate-command, повтора не будет.
  const d = explainStop({
    kind: 'work',
    work: {
      id: 'a',
      status: 'failed',
      attempt: 0,
      failureKind: 'environment',
      environmentCause: 'sandbox-process-list',
    },
    maxAttempts: 3,
    repair: { sameFailureRepairs: 0, groupRepairsUsed: 0, groupRepairBudget: 6 },
    control: { paused: false },
  });
  assert.deepEqual([d.code, d.actor, d.action], ['RUNTIME_UNAVAILABLE', 'lead', 'fix-environment']);
  assert.equal(d.retryPlanned, false);
  assert.match(d.message, /ps/);
  // Обычный отказ окружения по-прежнему получает один повтор.
  const { engine: other } = engineOf();
  ready(other, graphOf({ b: [] }));
  const b = other.claim('c1')!;
  other.fail(b.id, b.token, 'connection reset by peer', { kind: 'environment' });
  const plain = other.read((v) =>
    repairDecision(v, [v.work('b')!], { budgetLeft: 6, maxAttempts: 3 }),
  );
  assert.equal(plain?.action, 'retry');
});
