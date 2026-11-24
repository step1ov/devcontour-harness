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
import {
  probeSandboxBrowser,
  probeSandboxSignal,
  runGate,
  sandboxLimitBackend,
} from '../src/verification/gates.ts';
import {
  browserSignature,
  type SandboxLimitCapability,
  sandboxSignatureCall,
  sandboxSignatureFailure,
  sandboxSignaturePartial,
  sandboxSignaturePartialNote,
  signalSignature,
} from '../src/verification/sandbox-signatures.ts';
import type { Engine } from '../src/engine/engine.ts';
import { cliDataSchemas, executionPolicySchema } from '../src/contracts/index.ts';
import { doctor } from '../src/control/doctor.ts';
import { checkGates, gatesText } from '../src/control/gates-check.ts';
import { example } from './fixtures.ts';
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
    'bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.1: Permission denied (1100)',
    '[1:2:FATAL:mach_port_rendezvous.cc(142)] Check failed: kr == KERN_SUCCESS',
  ])
    assert.ok(browserSignature(text), text);
  // Общие строки запуска без следа песочницы: их даёт и сломанная настройка.
  for (const text of [
    'Error: Failed to launch the browser process!',
    'browserType.launch: Target page, context or browser has been closed',
    'Browser process exited with code 1',
    'Chrome crashed',
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
    /часть провала — причина окружения sandbox-browser, а не дефект решения .*попытка засчитана за остальные провалы .*вынесите проверку в браузере/,
  );
  assert.equal(sandboxSignaturePartial('sandbox-browser', 'Photo API status'), undefined);
});

const killCase = 'kill EPERM\nError: kill EPERM\n    at process.kill (node:internal)';
const machDenied =
  'bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.1: Permission denied (1100)';

test('смешанный провал: kill EPERM в выводе и «HTTP status 500» в JUnit — засчитан; лишний testcase прощается только в точной форме обёртки', () => {
  // Регрессия: настоящий провал соседа рядом с одним kill EPERM.
  assert.equal(
    sandboxSignatureFailure('sandbox-signal', killSpec, {
      total: 2,
      texts: [killCase, 'HTTP status 500'],
    }),
    undefined,
  );
  for (const other of [
    'Tests failed',
    'Photo API status',
    'Gate execution failed: 3 tests',
    'Gate execution failed\nError: boom',
    'gate execution failed',
    '',
  ])
    assert.equal(
      sandboxSignatureFailure('sandbox-signal', killSpec, { total: 2, texts: [killCase, other] }),
      undefined,
      JSON.stringify(other),
    );
  for (const wrapper of [
    'Gate execution failed',
    '\nGate execution failed',
    'Gate execution failed\nGate execution failed',
  ])
    assert.match(
      sandboxSignatureFailure('sandbox-signal', killSpec, {
        total: 2,
        texts: [killCase, wrapper],
      }) ?? '',
      /kill EPERM/,
      JSON.stringify(wrapper),
    );
});

test('иной провал у того же теста или в выводе (Error, статус HTTP, код ошибки) — засчитан; общий запуск браузера и сломанный путь — не след песочницы', () => {
  for (const text of [
    killCase + '\nError: connect ECONNREFUSED 127.0.0.1:3000',
    killCase + '\nexpected HTTP 200, got 500',
    killCase + '\nTypeError: cannot read properties of undefined',
  ])
    assert.equal(
      sandboxSignatureFailure('sandbox-signal', '', { total: 1, texts: [text] }),
      undefined,
      text,
    );
  // Без JUnit и блоков: строка ошибки рядом с признаком в выводе.
  assert.ok(sandboxSignatureFailure('sandbox-signal', 'Error: kill EPERM'));
  assert.equal(
    sandboxSignatureFailure('sandbox-signal', 'Error: kill EPERM\nError: HTTP status 500'),
    undefined,
  );
  // Браузер: след песочницы с общей строкой запуска — да; одна общая строка или
  // сломанный путь к браузеру рядом со следом — нет.
  assert.ok(
    sandboxSignatureFailure('sandbox-browser', '', {
      total: 1,
      texts: [`Error: Failed to launch the browser process!\n${machDenied}`],
    }),
  );
  for (const text of [
    'Error: Failed to launch the browser process!',
    'Chrome crashed\nBrowser process exited with code 1',
    `browserType.launch: Failed to launch chromium because executable doesn't exist at /nope\n${machDenied}`,
    `browserType.launch: executablePath: /opt/broken/chrome\n${machDenied}`,
    `Error: spawn /opt/broken/chrome ENOENT\n${machDenied}`,
  ])
    assert.equal(
      sandboxSignatureFailure('sandbox-browser', '', { total: 1, texts: [text] }),
      undefined,
      text,
    );
});

test('след и иная ошибка в одной строке: вырезается только текст следа, остаток засчитывает попытку', () => {
  for (const text of [
    'Error: HTTP status 500; cleanup: kill EPERM',
    'kill EPERM after TypeError: x is undefined',
    "[Error: kill EPERM] { errno: -1, code: 'EPERM', syscall: 'kill', cause: 'ECONNRESET' }",
    'bash: kill: (4242) - Operation not permitted; AssertionError: 1 !== 2',
  ])
    assert.equal(
      sandboxSignatureFailure('sandbox-signal', '', { total: 1, texts: [text] }),
      undefined,
      text,
    );
  // Тот же след без иной ошибки — по-прежнему след песочницы.
  for (const text of [
    'Error: kill EPERM',
    'Uncaught Error: kill EPERM',
    "[Error: kill EPERM] { errno: -1, code: 'EPERM', syscall: 'kill' }",
    'bash: kill: (4242) - Operation not permitted',
  ])
    assert.ok(sandboxSignatureFailure('sandbox-signal', '', { total: 1, texts: [text] }), text);
  for (const text of [
    `${machDenied}; Error: HTTP status 500`,
    'Foreground browser daemon unavailable (statusCode: 503)',
    'Error: Failed to launch the browser process! TimeoutError: page.goto',
  ])
    assert.equal(
      sandboxSignatureFailure('sandbox-browser', '', { total: 1, texts: [text] }),
      undefined,
      text,
    );
  for (const text of [
    `[1:2:0101/120000.000:ERROR:mach_port_rendezvous.cc(142)] ${machDenied}`,
    'Error: Foreground browser daemon unavailable',
    `Error: Failed to launch the browser process!\n${machDenied}`,
  ])
    assert.ok(sandboxSignatureFailure('sandbox-browser', '', { total: 1, texts: [text] }), text);
});

/** Подменить пробы ограничений песочницы на время `fn`. */
async function withProbes<T>(
  answer: (cause: string) => SandboxLimitCapability,
  fn: (calls: string[]) => Promise<T>,
) {
  const original = { ...sandboxLimitBackend.probes };
  const calls: string[] = [];
  sandboxLimitBackend.reset();
  for (const cause of ['sandbox-signal', 'sandbox-browser'] as const)
    sandboxLimitBackend.probes[cause] = () => {
      calls.push(cause);
      return Promise.resolve(answer(cause));
    };
  try {
    return await fn(calls);
  } finally {
    Object.assign(sandboxLimitBackend.probes, original);
    sandboxLimitBackend.reset();
  }
}

test('пробы: любой исход кешируется на процесс (и unknown, и отказ пробы), reset сбрасывает; браузера нет — проба ничего не доказала', async () => {
  await withProbes(
    (cause) =>
      cause === 'sandbox-signal'
        ? { status: 'unavailable', detail: 'EPERM' }
        : { status: 'unknown', detail: 'браузер на машине не найден' },
    async (calls) => {
      for (let i = 0; i < 3; i++) {
        assert.equal((await sandboxLimitBackend.probe('sandbox-signal')).status, 'unavailable');
        assert.equal((await sandboxLimitBackend.probe('sandbox-browser')).status, 'unknown');
        await new Promise((r) => setImmediate(r));
      }
      assert.equal(calls.filter((c) => c === 'sandbox-signal').length, 1);
      assert.equal(calls.filter((c) => c === 'sandbox-browser').length, 1);
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(sandboxLimitBackend.seen()).map(([k, v]) => [k, v.status]),
        ),
        { 'sandbox-signal': 'unavailable', 'sandbox-browser': 'unknown' },
      );
      sandboxLimitBackend.reset();
      assert.deepEqual(sandboxLimitBackend.seen(), {});
      await sandboxLimitBackend.probe('sandbox-browser');
      assert.equal(calls.filter((c) => c === 'sandbox-browser').length, 2);
    },
  );
  // Отказ самой пробы — `unknown`, тоже один на процесс.
  const original = sandboxLimitBackend.probes['sandbox-signal'];
  let thrown = 0;
  sandboxLimitBackend.reset();
  sandboxLimitBackend.probes['sandbox-signal'] = () => {
    thrown++;
    return Promise.reject(new Error('boom'));
  };
  try {
    for (let i = 0; i < 2; i++)
      assert.equal((await sandboxLimitBackend.probe('sandbox-signal')).status, 'unknown');
    assert.equal(thrown, 1);
  } finally {
    sandboxLimitBackend.probes['sandbox-signal'] = original;
    sandboxLimitBackend.reset();
  }
  assert.equal((await probeSandboxBrowser('os', () => [])).status, 'unknown');
  assert.equal((await probeSandboxSignal('none')).status, 'not-isolated');
  assert.equal((await probeSandboxBrowser('none')).status, 'not-isolated');
});

test(
  'проба браузера: без связки ключей и хранилища паролей ОС (--use-mock-keychain, --password-store=basic)',
  { skip: sandbox.ok ? false : 'песочница ОС недоступна: ' + sandbox.detail },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-fake-browser-'));
    const fake = join(dir, 'chrome');
    writeFileSync(fake, '#!/bin/sh\necho "<html>$*</html>"\n', { mode: 0o755 });
    const result = await probeSandboxBrowser('os', () => [fake]);
    assert.equal(result.status, 'available', result.detail);
    for (const flag of ['--use-mock-keychain', '--password-store=basic', '--headless=new'])
      assert.ok(result.command?.includes(flag), flag);
  },
);

test('doctor и harness gates показывают ответы проб сигнала и браузера, как пробу ps', async () => {
  const policy = executionPolicySchema.parse({
    ...structuredClone(example('policy')),
    isolation: { mode: 'os', domains: [] },
  });
  const report = await doctor(policy, {}, undefined, undefined, undefined, {
    resourceDatabase: false,
    sandboxLimits: {
      'sandbox-signal': () =>
        Promise.resolve({ status: 'unavailable', detail: 'kill(1, 0): EPERM' }),
      'sandbox-browser': () =>
        Promise.resolve({ status: 'unknown', detail: 'браузер на машине не найден' }),
    },
  });
  cliDataSchemas.doctor.parse(report);
  if (sandbox.ok) {
    assert.equal(report.sandbox.signal?.status, 'unavailable');
    assert.match(report.sandbox.signal.line, /недоступен .*GATE_SANDBOX_SIGNAL/);
    assert.equal(report.sandbox.browser?.status, 'unknown');
    assert.match(report.sandbox.browser.line, /не выяснен — браузер на машине не найден/);
    assert.ok(
      report.notes?.some((n) => n.startsWith('sandbox-signal: ')),
      JSON.stringify(report.notes),
    );
    assert.ok(!report.notes?.some((n) => n.startsWith('sandbox-browser: ')));
    assert.ok(!report.problems.some((p) => /сигнал|браузер в песочнице/.test(p)));
  } else assert.equal(report.sandbox.signal, undefined, 'без песочницы пробы нет');
  const none = await doctor(
    executionPolicySchema.parse({ ...policy, isolation: { mode: 'none', domains: [] } }),
    {},
    undefined,
    undefined,
    undefined,
    { resourceDatabase: false, sandboxLimits: {} },
  );
  assert.equal(none.sandbox.signal?.status, 'not-isolated');
  assert.equal(none.sandbox.browser?.status, 'not-isolated');
  const quiet = await doctor(policy, {}, undefined, undefined, undefined, {
    resourceDatabase: false,
  });
  assert.equal(quiet.sandbox.signal, undefined);

  // harness gates: ответы проб этого процесса — в data.sandbox и строкой таблицы.
  const r = repo({ 'README.md': 'app\n' });
  const raw = structuredClone(example('policy')) as {
    repositories: Record<string, unknown>[];
    [key: string]: unknown;
  };
  raw.repositories[0]!.path = r.dir;
  raw.repositories[0]!.gates = [
    {
      id: 'unit',
      kind: 'test',
      command: [process.execPath, '-e', 'process.exit(0)'],
      report: { type: 'junit', path: 'reports/unit.xml' },
      dependsOn: [],
    },
  ];
  raw.isolation = { mode: 'none', domains: [] };
  const gatesPolicy = executionPolicySchema.parse(raw);
  const state = mkdtempSync(join(tmpdir(), 'harness-gates-probes-'));
  const check = () =>
    checkGates({ policy: gatesPolicy, baseDir: r.dir, stateDir: state, rev: 'HEAD' });
  await withProbes(
    () => ({ status: 'unavailable', detail: 'EPERM' }),
    async () => {
      const before = await check();
      assert.equal(before.sandbox, undefined, 'проб не было — поля нет');
      await sandboxLimitBackend.probe('sandbox-signal');
      const data = await check();
      cliDataSchemas.gates.parse(data);
      assert.equal(data.sandbox?.signal?.status, 'unavailable');
      assert.equal(data.sandbox?.browser, undefined);
      assert.match(gatesText(data), /\nвозможность: сигнал процессу вне песочницы .*недоступен/);
    },
  );
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
      policy: { harnessMode: 'strict', isolation: { mode, domains: [] } },
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

test(
  'gate в песочнице ОС: проба не подтвердила ограничение — kill EPERM засчитан с пометкой; подтвердила — отказ среды',
  { skip: sandbox.ok ? false : 'песочница ОС недоступна: ' + sandbox.detail },
  async () => {
    const r = repo({ 'README.md': 'app\n' });
    for (const status of ['unknown', 'available'] as const) {
      const counted = await withProbes(
        () => ({ status, detail: 'проба теста' }),
        () => gate(killGate, 'os', { r, trustedBase: r.head() }),
      );
      assert.equal(counted.failure?.kind, 'gate', counted.evidence.summary);
      assert.equal(counted.failure?.diagnosis, undefined);
      assert.match(
        counted.evidence.summary,
        /возможная причина окружения sandbox-signal .*не подтверждена пробой harness .*попытка засчитана/,
      );
    }
    const env = await withProbes(
      () => ({ status: 'unavailable', detail: 'EPERM' }),
      () => gate(killGate, 'os', { r, trustedBase: r.head() }),
    );
    assert.equal(env.failure?.diagnosis, 'sandbox-signal', env.evidence.summary);
  },
);

test(
  'gate в песочнице ОС: вывод называет один kill EPERM, а JUnit ещё и «HTTP status 500» — засчитанный провал и при подтверждённой пробе',
  { skip: sandbox.ok ? false : 'песочница ОС недоступна: ' + sandbox.detail },
  async () => {
    const r = repo({ 'README.md': 'app\n' });
    const xml =
      '<testsuite><testcase name="outer-kill"><failure message="kill EPERM">Error: kill EPERM</failure></testcase>' +
      '<testcase name="photo-api"><failure>HTTP status 500</failure></testcase></testsuite>';
    const mixed = [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, ${JSON.stringify(xml)}); console.log(${JSON.stringify(killSpec)}); process.exit(1)`,
    ];
    const result = await withProbes(
      () => ({ status: 'unavailable', detail: 'EPERM' }),
      () => gate(mixed, 'os', { r, trustedBase: r.head() }),
    );
    assert.equal(result.failure?.kind, 'gate', result.evidence.summary);
    assert.equal(result.failure?.diagnosis, undefined);
    assert.match(result.evidence.summary, /часть провала — причина окружения sandbox-signal/);
  },
);

test(
  'gate в песочнице ОС: строка JUnit «Error: HTTP status 500; cleanup: kill EPERM» — засчитанный провал при подтверждённой пробе и вызове из базы',
  { skip: sandbox.ok ? false : 'песочница ОС недоступна: ' + sandbox.detail },
  async () => {
    const r = repo({ 'README.md': 'app\n', 'kill.test.mjs': 'process.kill(outer, "SIGTERM")\n' });
    const xml =
      '<testsuite><testcase name="photo-api"><failure message="Error: HTTP status 500; cleanup: kill EPERM">' +
      'Error: HTTP status 500; cleanup: kill EPERM</failure></testcase></testsuite>';
    const sameLine = [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, ${JSON.stringify(xml)}); console.error('Error: HTTP status 500; cleanup: kill EPERM'); process.exit(1)`,
    ];
    const result = await withProbes(
      () => ({ status: 'unavailable', detail: 'EPERM' }),
      () => gate(sameLine, 'os', { r, trustedBase: r.head() }),
    );
    assert.equal(result.failure?.kind, 'gate', result.evidence.summary);
    assert.equal(result.failure?.diagnosis, undefined);
    assert.doesNotMatch(result.evidence.summary, /^GATE_SANDBOX_SIGNAL/);
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

test('A68-r3: строка журнала Chromium другого компонента рядом со следом песочницы — иной провал (засчитан)', () => {
  const mach =
    '[1:2:0101/120000.000:FATAL:mach_port_rendezvous.cc(142)] Check failed: kr == KERN_SUCCESS. bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.1: Permission denied (1100)';
  const ssl =
    '[1:2:0101/120000.000:ERROR:ssl_client_socket_impl.cc(902)] handshake failed; returned -1, SSL error code 1, net_error -202';
  // Один след песочницы — признак класса.
  assert.ok(sandboxSignatureFailure('sandbox-browser', '', { total: 1, texts: [mach] }));
  // След плюс ошибка другого компонента Chromium — не окружение.
  assert.equal(
    sandboxSignatureFailure('sandbox-browser', '', { total: 1, texts: [mach + '\n' + ssl] }),
    undefined,
  );
});

test('A68-r3: unknown кешируется не дольше 5 минут; doctor без --probe-sandbox пробу не запускает — известный ответ или «не проверялось»', async () => {
  const now = sandboxLimitBackend.now;
  let clock = 1_000_000;
  sandboxLimitBackend.now = () => clock;
  try {
    await withProbes(
      () => ({ status: 'unknown', detail: 'браузер на машине не найден' }),
      async (calls) => {
        await sandboxLimitBackend.probe('sandbox-browser');
        clock += 4 * 60_000;
        await sandboxLimitBackend.probe('sandbox-browser');
        assert.equal(calls.length, 1, 'в пределах 5 минут — тот же ответ');
        clock += 2 * 60_000;
        await sandboxLimitBackend.probe('sandbox-browser');
        assert.equal(calls.length, 2, 'после 5 минут unknown перепроверяется');
      },
    );
    await withProbes(
      () => ({ status: 'unavailable', detail: 'EPERM' }),
      async (calls) => {
        const policy = executionPolicySchema.parse({
          ...structuredClone(example('policy')),
          isolation: { mode: 'os', domains: [] },
        });
        const report = await doctor(policy, {}, undefined, undefined, undefined, {
          resourceDatabase: false,
          sandboxLimits: 'cached',
        });
        assert.deepEqual(calls, [], 'проба не запускалась');
        if (sandbox.ok) assert.match(report.sandbox.browser!.line, /не проверялось/);
      },
    );
  } finally {
    sandboxLimitBackend.now = now;
  }
});
