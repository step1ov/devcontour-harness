import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executionPolicySchema,
  gateTimeoutMs,
  policyDigest,
  type EvidenceRecord,
  type GatePolicy,
} from '../src/contracts/index.ts';
import { example } from './fixtures.ts';
import { failureFingerprint } from '../src/contracts/failure.ts';
import { redactor } from '../src/environment/redaction.ts';
import { isolationSupport, watchSandboxLog } from '../src/environment/isolation.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { previousAttempts } from '../src/engine/prompt.ts';
import { engineOf, graphOf, ready } from './engine-fixture.ts';
import {
  GateTimeout,
  hostLoad,
  junitSummary,
  prepareReportPath,
  runGate,
  sandboxBlockedHosts,
} from '../src/verification/gates.ts';
import { requirementProof } from '../src/verification/proof.ts';
import { junit, nodeGate, repo, write } from './git-fixture.ts';

const policy = { isolation: { mode: 'none' as const, domains: [] } };

async function gate(
  dir: string,
  sha: string,
  g: Partial<GatePolicy> & { command: string[] },
  secret?: string,
  isolationMode: 'none' | 'os' = 'none',
  gateTimeoutFloorMs?: number,
) {
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  const full = {
    id: 'unit',
    kind: 'test',
    timeoutMs: 20000,
    report: { type: 'junit', path: 'test-results/junit.xml' },
    ...g,
  } as GatePolicy;
  const artifactDir = mkdtempSync(join(tmpdir(), 'harness-art-'));
  let failure: TaskFailure | undefined;
  try {
    await runGate({
      policy: {
        isolation: { ...policy.isolation, mode: isolationMode },
        ...(gateTimeoutFloorMs ? { gateTimeoutFloorMs } : {}),
      },
      record: (e) => {
        recorded.push(e);
        return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
      },
      cwd: dir,
      sha,
      phase: 'candidate',
      gate: full,
      artifactDir,
      signal: new AbortController().signal,
      execution: {
        env: { ...process.env, SECRET: secret ?? '' },
        redact: redactor(secret ? [secret] : []),
      },
      boundary: { hidden: [], readable: [] },
    });
  } catch (error) {
    if (!(error instanceof TaskFailure)) throw error;
    failure = error;
  }
  assert.equal(recorded.length, 1, 'evidence записывается при любом исходе');
  return { evidence: recorded[0]!, failure, artifactDir };
}

test('Failed JUnit survives exit 1 with an incidental npmrc warning and retains redaction', async () => {
  const r = repo();
  const secret = 'synthetic-report-secret-7318';
  const { evidence, failure, artifactDir } = await gate(
    r.dir,
    r.head(),
    {
      command: nodeGate(
        `${junit(`<testcase name="fails-${secret}"><failure message="expected 0 ${secret}"/></testcase>`)};console.error("WARN Issue while reading '/synthetic/home/.npmrc': EPERM");process.exit(1)`,
      ),
    },
    secret,
  );
  assert.equal(failure?.kind, 'gate');
  assert.equal(evidence.exitCode, 1);
  assert.equal(evidence.passed, false);
  assert.match(evidence.summary, /упали.*fails-.*expected 0/);
  assert.deepEqual(
    evidence.tests?.map((t) => t.status),
    ['failed'],
  );
  const xml = readFileSync(join(artifactDir, 'unit.xml'), 'utf8');
  assert.equal(junitSummary(xml).failures, 1);
  assert.match(xml, /expected 0/);
  assert.ok(!xml.includes(secret));
  assert.ok(!JSON.stringify(evidence).includes(secret));
});

const sandbox = isolationSupport();
test(
  'OS report retention distinguishes a kernel-observed macOS denial from a nuisance warning',
  { skip: sandbox.ok ? false : 'песочница ОС недоступна: ' + sandbox.detail },
  async () => {
    const r = repo();
    if (process.platform === 'darwin') {
      // Classification requires a tagged kernel record, not EPERM in stderr.
      // Node's denied mkdir does not always emit that record on macOS; use the
      // system utility, as the ancestor-read regression uses /usr/bin/stat.
      const { evidence, failure, artifactDir } = await gate(
        r.dir,
        r.head(),
        {
          command: nodeGate(
            `${junit('<testcase name="blocked"><error message="sandbox denied write"/></testcase>')};const result=require('child_process').spawnSync('/bin/mkdir',['.idea'],{stdio:'inherit'});process.exit(result.status??1)`,
          ),
        },
        undefined,
        'os',
      );
      assert.equal(failure?.kind, 'environment', evidence.summary);
      assert.equal(failure.diagnosis, 'sandbox-filesystem');
      assert.match(
        failure.message,
        /песочница проверки отказала в доступе: \.idea — обязательный запрет записи/,
      );
      assert.equal(evidence.passed, false);
      assert.equal(evidence.exitCode, 1);
      assert.equal(junitSummary(readFileSync(join(artifactDir, 'unit.xml'), 'utf8')).failures, 1);
    } else {
      // The runtime explicitly has no kernel observer on other platforms;
      // they cannot promise this evidence-backed environment classification.
      assert.equal(await watchSandboxLog('unsupportedplatform'), undefined);
    }

    // A nuisance warning and assertion failure under the same OS policy
    // cannot obtain environment classification by printing a closed path.
    const nuisance = await gate(
      r.dir,
      r.head(),
      {
        command: nodeGate(
          `${junit('<testcase name="assertion"><failure message="expected 0"/></testcase>')};console.error("WARN EPERM: open '/synthetic/home/.npmrc'; assertion expected 0");process.exit(1)`,
        ),
      },
      undefined,
      'os',
    );
    assert.equal(nuisance.failure?.kind, 'gate', nuisance.evidence.summary);
    assert.equal(nuisance.evidence.exitCode, 1);
    assert.match(nuisance.evidence.summary, /упали assertion: expected 0/);
    assert.equal(
      junitSummary(readFileSync(join(nuisance.artifactDir, 'unit.xml'), 'utf8')).failures,
      1,
    );
  },
);

test('Nonzero exit does not retain a malformed or escaped JUnit report', async () => {
  const r = repo();
  const outside = mkdtempSync(join(tmpdir(), 'harness-report-outside-'));
  const path = join(outside, 'secret.xml');
  writeFileSync(path, '<testsuite><testcase name="outside"/></testsuite>');
  for (const script of [
    `require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase')`,
    `require('fs').symlinkSync(${JSON.stringify(path)}, process.env.DEVCONTOUR_REPORT_PATH)`,
  ]) {
    const { evidence, failure, artifactDir } = await gate(r.dir, r.head(), {
      command: nodeGate(`${script};console.error('assertion failed');process.exit(1)`),
    });
    assert.equal(failure?.kind, 'gate');
    assert.match(evidence.summary, /assertion failed/);
    assert.equal(existsSync(join(artifactDir, 'unit.xml')), false);
    assert.equal(evidence.tests, undefined);
  }
});

test('T06: test gate принимается только по свежему непустому JUnit без отказов', async () => {
  const r = repo();
  const sha = r.head();
  const ok = await gate(r.dir, sha, {
    command: nodeGate(junit('<testcase classname="g" name="greets"/>')),
  });
  assert.equal(ok.failure, undefined);
  assert.equal(ok.evidence.passed, true);
  assert.deepEqual(ok.evidence.tests, [{ id: 'g.greets', status: 'passed' }]);

  const variants: [string, string[], RegExp][] = [
    ['exit != 0', nodeGate(`${junit('<testcase name="a"/>')};process.exit(3)`), /Код выхода 3/],
    [
      'нет отчёта, слово PASS в stdout',
      nodeGate(`console.log('PASS: all tests passed')`),
      /ENOENT|no such file/,
    ],
    ['пустой отчёт', nodeGate(junit('')), /не содержит выполненных testcases/],
    [
      'повреждённый XML',
      nodeGate(
        `require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase')`,
      ),
      /Некорректный JUnit/,
    ],
    [
      'failure',
      nodeGate(junit('<testcase name="a"><failure message="boom"/></testcase>')),
      /1 failures.*a: boom/,
    ],
    [
      'error',
      nodeGate(junit('<testcase name="a"><error message="crash"/></testcase>')),
      /1 failures/,
    ],
    ['skipped', nodeGate(junit('<testcase name="a"><skipped/></testcase>')), /1 skipped/],
  ];
  for (const [name, command, reason] of variants) {
    const { evidence, failure } = await gate(r.dir, sha, { command });
    assert.ok(failure, name);
    assert.equal(failure.kind, 'gate', name);
    assert.equal(evidence.passed, false, name);
    assert.match(evidence.summary, reason, name);
  }
  // Старый отчёт предыдущего прогона не засчитывается: путь очищается до запуска.
  write(r.dir, { 'test-results/junit.xml': '<testsuite><testcase name="old"/></testsuite>' });
  const stale = await gate(r.dir, sha, { command: nodeGate('0') });
  assert.equal(stale.evidence.passed, false, 'старый отчёт не подтверждает');
});

test('T07: gate, изменивший HEAD или отслеживаемый файл, не проходит', async () => {
  const r = repo({ 'src/a.js': 'a\n' });
  const sha = r.head();
  const tracked = await gate(r.dir, sha, {
    command: nodeGate(
      `require('fs').writeFileSync('src/a.js','changed');${junit('<testcase name="a"/>')}`,
    ),
  });
  assert.match(tracked.evidence.summary, /изменил отслеживаемые файлы/);
  r.git('checkout', '--', 'src/a.js');
  const head = await gate(r.dir, sha, {
    command: nodeGate(
      `const c=require('child_process');c.execFileSync('git',['-c','user.name=x','-c','user.email=x@x','commit','-q','--allow-empty','-m','x']);${junit('<testcase name="a"/>')}`,
    ),
  });
  assert.match(head.evidence.summary, /изменил HEAD/);
  assert.equal(head.evidence.passed, false);
});

test('gateTimeoutFloorMs поднимает короткий объявленный предел gate; отказ по пределу называет действующий и объявленный', async () => {
  const r = repo({ 'src/a.js': 'a\n' });
  const sha = r.head();
  // Команда дольше объявленного предела, но короче нижней границы политики.
  const slow = {
    kind: 'check' as const,
    report: undefined,
    timeoutMs: 300,
    command: [process.execPath, '-e', 'setTimeout(() => {}, 1500)'],
  };
  const read = hostLoad.read;
  hostLoad.read = () => ({ load1: 3.04, cpus: 4 });
  let bare;
  try {
    bare = await gate(r.dir, sha, slow);
  } finally {
    hostLoad.read = read;
  }
  assert.equal(bare.evidence.passed, false, 'без нижней границы — отказ по объявленному пределу');
  assert.match(
    bare.failure?.message ?? '',
    /превысила timeout: предел 0\.3 с, нагрузка хоста 3 на 4 ядер$/,
  );
  // Таймаут самого gate — класс `gate`, нагрузка ниже порога повтора.
  assert.ok(bare.failure instanceof GateTimeout);
  assert.equal(bare.failure.kind, 'gate');
  assert.equal(bare.failure.overloaded, false);
  const floored = await gate(r.dir, sha, slow, undefined, 'none', 3000);
  assert.equal(floored.evidence.passed, true, floored.evidence.summary);
  // Нижняя граница ниже времени команды: предел назван вместе с объявленным.
  const short = await gate(
    r.dir,
    sha,
    { ...slow, command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'] },
    undefined,
    'none',
    1000,
  );
  assert.equal(short.evidence.passed, false);
  assert.match(
    short.failure?.message ?? '',
    /предел 1 с \(объявлен 0\.3 с, поднят gateTimeoutFloorMs\)/,
  );
});

test('gateTimeoutFloorMs: необязательное поле 1000–600000 без умолчания в политике', () => {
  const raw = example('policy');
  const parsed = executionPolicySchema.parse(raw);
  assert.equal('gateTimeoutFloorMs' in parsed, false, 'умолчание не подставляется');
  for (const bad of [999, 600001, 1500.5])
    assert.equal(
      executionPolicySchema.safeParse({ ...raw, gateTimeoutFloorMs: bad }).success,
      false,
    );
  const withFloor = executionPolicySchema.parse({ ...raw, gateTimeoutFloorMs: 30000 });
  assert.equal(withFloor.gateTimeoutFloorMs, 30000);
  assert.notEqual(policyDigest(withFloor), policyDigest(parsed), 'поле входит в digest политики');
  assert.equal(
    withFloor.repositories[0]!.gates[0]!.timeoutMs,
    parsed.repositories[0]!.gates[0]!.timeoutMs,
  );
  assert.equal(gateTimeoutMs({ timeoutMs: 10000 }, withFloor), 30000);
  assert.equal(gateTimeoutMs({ timeoutMs: 120000 }, withFloor), 120000);
  assert.equal(gateTimeoutMs({ timeoutMs: 10000 }, parsed), 10000);
});

test('Секрет окружения маскируется в выводе, сводке и логе gate', async () => {
  const r = repo();
  const secret = 'sk-test-0123456789abcdef';
  const { evidence } = await gate(
    r.dir,
    r.head(),
    { command: nodeGate(`console.error('token=' + process.env.SECRET); process.exit(1)`) },
    secret,
  );
  assert.ok(!evidence.summary.includes(secret));
  assert.match(evidence.summary, /\[REDACTED\]/);
  const log = (await import('node:fs')).readFileSync(evidence.log, 'utf8');
  assert.ok(!log.includes(secret), 'лог на диске замаскирован');
  writeFileSync(join(r.dir, 'unused'), '');
});

test('Отчёт за пределами worktree и cwd вне worktree отклоняются до записи', async () => {
  const r = repo();
  await assert.rejects(
    () =>
      gate(r.dir, r.head(), {
        command: nodeGate('0'),
        report: { type: 'junit', path: '../outside.xml' },
      }),
    /Report выходит из worktree/,
  );
});

// Перенесено из потребителя (DevContour runner.test, proof.test): правила
// чтения отчёта, границы пути отчёта, распознавания отказа сети и причины
// провала gate — правила harness, и проверяются здесь напрямую.

test('JUnit: пустой, повреждённый и с DOCTYPE отчёт отклоняется; пропуск — не прохождение', () => {
  assert.throws(() => junitSummary('<testsuite tests="999"/>'), /testcases/);
  assert.throws(() => junitSummary('not xml'));
  assert.throws(() => junitSummary('<!DOCTYPE xml><testsuite/>'));
  assert.throws(() => junitSummary('<testsuite'), /Некорректный JUnit/);
  const summary = junitSummary(
    '<testsuites><testsuite><testcase name="a"/><testcase name="b"><skipped/></testcase><testcase name="c"><failure/></testcase></testsuite></testsuites>',
  );
  assert.deepEqual(summary, {
    tests: 3,
    failures: 1,
    skipped: 1,
    failed: ['c'],
    // Без сообщения о провале остаётся одно имя testcase.
    failedDetails: ['c'],
    cases: [
      { id: 'a', status: 'passed' },
      { id: 'b', status: 'skipped' },
      { id: 'c', status: 'failed' },
    ],
    truncated: false,
  });
});

test('Манифест JUnit называет каждый testcase с classname и исходом', () => {
  const summary = junitSummary(`<?xml version="1.0"?>
<testsuite tests="3" failures="1" skipped="1">
  <testcase classname="cart.total" name="applies discount"/>
  <testcase classname="cart.total" name="rejects negative"><failure message="boom"/></testcase>
  <testcase classname="cart.total" name="pending"><skipped/></testcase>
</testsuite>`);
  assert.deepEqual(summary.cases, [
    { id: 'cart.total.applies discount', status: 'passed' },
    { id: 'cart.total.rejects negative', status: 'failed' },
    { id: 'cart.total.pending', status: 'skipped' },
  ]);
  assert.equal(summary.truncated, false);
});

test('Манифест на пределе 2000 testcases полон; за пределом обрезан и не подтверждает отсутствующий тест', () => {
  const report = (count: number) =>
    '<testsuite>' +
    Array.from({ length: count }, (_, i) => `<testcase name="case-${i}"/>`).join('') +
    '</testsuite>';
  const full = junitSummary(report(2000));
  assert.equal(full.cases.length, 2000);
  assert.equal(full.truncated, false);
  const over = junitSummary(report(2001));
  assert.equal(over.cases.length, 2000);
  assert.equal(over.truncated, true);
  assert.equal(over.tests, 2001, 'счётчик считает все выполненные testcases');
  const sha = 'a'.repeat(40);
  const proof = requirementProof(
    { id: 'REQ-1', gate: 'unit', testId: 'case-2000' },
    [
      {
        kind: 'test',
        gate: 'unit',
        phase: 'integration',
        sha,
        passed: true,
        tests: over.cases,
        testsTruncated: true,
      },
    ],
    sha,
  );
  assert.equal(proof.level, 'none');
  assert.match(proof.reason, /обрезан/);
});

test('Путь отчёта через symlink отвергается до любой записи снаружи', async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-report-'));
  try {
    const worktree = join(root, 'worktree'),
      outside = join(root, 'outside');
    mkdirSync(worktree);
    mkdirSync(outside);
    symlinkSync(outside, join(worktree, '.reports'));
    await assert.rejects(
      () => prepareReportPath(worktree, '.reports/new/report.xml', 'Report выходит из worktree'),
      /Report выходит из worktree/,
    );
    assert.equal(existsSync(join(outside, 'new')), false, 'снаружи ничего не создано');
    await assert.rejects(
      () => prepareReportPath(worktree, '../escape.xml', 'Report выходит из worktree'),
      /Report выходит/,
    );
    const path = await prepareReportPath(worktree, 'reports/unit/report.xml', 'x');
    assert.ok(existsSync(join(worktree, 'reports', 'unit')));
    assert.ok(path.endsWith(join('reports', 'unit', 'report.xml')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Отказ сети песочницы узнаётся по выводу и называет домен; упоминание URL и локальный сервис — нет', () => {
  const pnpm =
    'candidate/install: Код выхода 1: ERR_PNPM_FETCH_403  GET https://registry.npmjs.org/@types/node/-/node-24.3.0.tgz: Forbidden - 403 | No authorization header was set for the request.';
  assert.deepEqual(sandboxBlockedHosts(pnpm, []), ['registry.npmjs.org']);
  assert.deepEqual(sandboxBlockedHosts(pnpm, ['npmjs.org']), [], 'поддомен разрешённого открыт');
  assert.deepEqual(
    sandboxBlockedHosts('connect EPERM 104.16.0.1:443 https://api.example.test/v1', []),
    ['api.example.test'],
  );
  assert.deepEqual(
    sandboxBlockedHosts('expected link https://example.com/docs to be rendered', []),
    [],
  );
  assert.deepEqual(sandboxBlockedHosts('GET http://127.0.0.1:4000/x 403 Forbidden', []), []);
});

const reportScript = (xml: string, exit: number, extra = '') =>
  `require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,${JSON.stringify(xml)});${extra}process.exit(${exit})`;

test('Провал gate несёт свою причину: разные ошибки — разные отпечатки, в том числе из отчёта и из любого потока', async () => {
  const r = repo();
  const failing = (name: string) =>
    `<testsuite><testcase classname="total" name="ok"/><testcase classname="total" name="${name}"><failure message="${name} broke"/></testcase></testsuite>`;
  const scenarios: [string, (m: string) => string[]][] = [
    ['stderr и код 1', (m) => ['sh', '-c', `echo ${m} >&2; exit 1`]],
    ['отчёт и код 1 без вывода', (m) => nodeGate(reportScript(failing(m), 1))],
    [
      'ошибка в stdout, предупреждение в stderr',
      (m) =>
        nodeGate(
          `console.log('error: ${m}');console.error('Warning: experimental runtime feature');process.exit(1)`,
        ),
    ],
    [
      'длинный stdout и предупреждения stderr не вытесняют ошибку',
      (m) =>
        nodeGate(
          `for(let i=0;i<4;i++)console.log('progress '+'o'.repeat(300));for(let i=0;i<3;i++)console.error('warning '+'w'.repeat(300));console.error('error: ${m}');process.exit(1)`,
        ),
    ],
  ];
  for (const [label, command] of scenarios) {
    const prints: string[] = [];
    for (const marker of ['EXPECTED_TOTAL_WRONG', 'MISSING_REQUIRED_FIELD']) {
      const { evidence, failure } = await gate(r.dir, r.head(), { command: command(marker) });
      assert.ok(failure, label);
      assert.match(failure.message, new RegExp(marker), `${label}: причина в отказе`);
      assert.match(evidence.summary, new RegExp(marker), `${label}: причина в evidence`);
      assert.match(evidence.summary, /Код выхода 1/, `${label}: код выхода остаётся провалом`);
      prints.push(failureFingerprint(failure.kind, failure.message));
    }
    assert.notEqual(prints[0], prints[1], `${label}: разные причины — разные отпечатки`);
  }
});

test('Повреждённый отчёт не затирает ошибку команды; секрет снят, объём ограничен', async () => {
  const r = repo();
  const secret = 'gate-secret-value-5821';
  const { evidence, failure } = await gate(
    r.dir,
    r.head(),
    {
      command: nodeGate(
        `require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase');` +
          `console.log('x'.repeat(5000));console.log('stdout-cause: schema mismatch');console.error('fatal: token '+process.env.SECRET+' rejected');process.exit(2)`,
      ),
    },
    secret,
  );
  assert.match(evidence.summary, /Код выхода 2/, 'исходный код выхода сохранён');
  assert.match(evidence.summary, /fatal: token .* rejected/, 'ошибка команды не затёрта отчётом');
  assert.match(evidence.summary, /stdout-cause: schema mismatch/, 'stdout входит в причину');
  assert.doesNotMatch(evidence.summary, /Некорректный JUnit/);
  assert.ok(!evidence.summary.includes(secret) && !failure!.message.includes(secret));
  assert.ok(evidence.summary.length < 1000, `объём ограничен: ${evidence.summary.length}`);
});

test('Текст провала из отчёта проходит тот же redact: сообщение на границе обрезки и имя testcase', async () => {
  const r = repo();
  const secret = 'gate-secret-value-7310-abcdefgh';
  const { evidence, failure } = await gate(
    r.dir,
    r.head(),
    {
      command: nodeGate(
        `const t=process.env.SECRET;require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase classname="auth" name="LEAKS_TOKEN"><failure message="'+'p'.repeat(184)+t+'"/></testcase><testcase name="case-'+t+'"><failure message="named"/></testcase></testsuite>');process.exit(1)`,
      ),
    },
    secret,
  );
  assert.match(evidence.summary, /LEAKS_TOKEN/, 'причина из отчёта дошла');
  assert.ok(evidence.tests?.length, 'манифест упавшей проверки записан');
  const stored = JSON.stringify(evidence) + failure!.message + readFileSync(evidence.log, 'utf8');
  for (const piece of [secret, secret.slice(0, 12)])
    assert.ok(!stored.includes(piece), `нигде нет «${piece}»`);
});

test('Compiler diagnostic survives aggregate and warning tails into the next writer history', async () => {
  const r = repo();
  const primary =
    'src/widget.ts(33,23): error TS2742: A portable return type annotation is necessary.';
  for (const stream of ['log', 'error']) {
    const { evidence, failure } = await gate(r.dir, r.head(), {
      command: nodeGate(
        `console.${stream}(${JSON.stringify(primary)});` +
          `for(let i=0;i<8;i++)console.${stream}("Summary: 1 fails, 8 passes");` +
          `console.${stream}("WARN Issue while reading '/synthetic/home/.npmrc': EPERM");process.exit(1)`,
      ),
    });
    assert.equal(failure?.kind, 'gate');
    assert.equal(evidence.exitCode, 1);
    assert.equal(evidence.passed, false);
    assert.match(evidence.summary, /src\/widget.ts\(33,23\): error TS2742/);
    assert.match(failure.message, /error TS2742/);
    assert.match(evidence.summary, /npmrc/);
    const { engine } = engineOf();
    ready(engine, graphOf({ a: [] }), 'writer');
    const attempt = engine.claim('writer')!;
    const history = previousAttempts(
      [
        {
          ...attempt,
          id: 'previous',
          error: failure.message,
          evidence: [{ ...evidence, id: 'e', runId: 'previous', createdAt: attempt.startedAt }],
        },
      ],
      'next',
    );
    const previous = history[0];
    assert.ok(previous);
    assert.ok(previous.error);
    assert.match(previous.error, /TS2742/);
    const previousEvidence = previous.evidence[0];
    assert.ok(previousEvidence);
    assert.match(previousEvidence.summary, /src\/widget.ts\(33,23\): error TS2742/);
  }
});

test('Without a compiler diagnostic the existing last-four-lines fallback remains', async () => {
  const r = repo();
  const { evidence } = await gate(r.dir, r.head(), {
    command: nodeGate(
      `console.log('earliest');for(let i=1;i<=5;i++)console.log('tail-'+i);process.exit(2)`,
    ),
  });
  assert.equal(evidence.summary, 'Код выхода 2: tail-2 | tail-3 | tail-4 | tail-5');
});

test('Compiler cause precedes the unchanged tail per stream, bounded and redacted', async () => {
  const r = repo();
  const secret = 'synthetic-compiler-secret-5193';
  const { evidence, failure } = await gate(
    r.dir,
    r.head(),
    {
      command: nodeGate(
        `for(const stream of ['log','error'])for(let i=1;i<=8;i++)console[stream]('src/widget.c:'+i+':2: error: '+'x'.repeat(90)+process.env.SECRET+'z'.repeat(500));process.exit(3)`,
      ),
    },
    secret,
  );
  assert.equal(failure?.kind, 'gate');
  assert.equal(evidence.exitCode, 3);
  assert.match(evidence.summary, /widget.c:1:2: error:/);
  assert.doesNotMatch(evidence.summary, /widget.c:[2-4]:2/);
  assert.match(evidence.summary, /widget.c:8:2: error:/);
  assert.ok(evidence.summary.length <= 'Код выхода 3: '.length + (141 + 3 + 291) * 2 + 3);
  for (const value of [evidence.summary, failure.message, readFileSync(evidence.log, 'utf8')]) {
    assert.ok(!value.includes(secret));
    assert.ok(!value.includes(secret.slice(0, 10)), 'no secret prefix at clipping boundary');
  }
});

const diagnosticOf = async (lines: string[]) => {
  const r = repo();
  const { evidence } = await gate(r.dir, r.head(), {
    command: nodeGate(`console.log(${JSON.stringify(lines.join('\n'))});process.exit(1)`),
  });
  return evidence.summary;
};
const noise = ['Found 1 error.', 'Failed', 'WARN one', 'WARN two'];
const ending = noise.join(' | ');

test('Compiler cause is found in pretty, colored and package manager output', async () => {
  const pretty = 'src/a.ts:3:7 - error TS2322: Type string';
  for (const [first, expected] of [
    [pretty, pretty],
    [
      '\u001b[96msrc/a.ts\u001b[0m:\u001b[93m3\u001b[0m:\u001b[93m7\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType string',
      pretty,
    ],
    ['\u001b[01m\u001b[Ksrc/a.c:3:7:\u001b[m\u001b[K error: nope', 'src/a.c:3:7: error: nope'],
    [`packages/a typecheck: ${pretty}`, `packages/a typecheck: ${pretty}`],
    [`web:typecheck: ${pretty}`, `web:typecheck: ${pretty}`],
    ['app/(shop)/page.tsx(3,7): error TS1: x\r', 'app/(shop)/page.tsx(3,7): error TS1: x'],
    ['src/a.c:3: fatal error: missing.h', 'src/a.c:3: fatal error: missing.h'],
  ] as const) {
    assert.equal(
      await diagnosticOf([first, 'filler', 'filler', ...noise]),
      `Код выхода 1: ${expected} | ${ending}`,
    );
  }
});

test('A compiler line already in the tail is not repeated', async () => {
  const line = 'src/a.ts(1,1): error TS1: same';
  assert.equal(
    await diagnosticOf(['build', line, 'Failed']),
    `Код выхода 1: build | ${line} | Failed`,
  );
});

test('A compiler line cut out of the tail by its limit is still reported', async () => {
  const line = `src/i.ts(3,14): error TS2322: Type '{ ${'first: string; '.repeat(16)}}'`;
  const summary = await diagnosticOf([line, 'x'.repeat(130), 'y'.repeat(130)]);
  assert.ok(summary.startsWith('Код выхода 1: src/i.ts(3,14): error TS2322'), summary);
});

test('A secret split by color codes does not survive clipping in the compiler cause', async () => {
  const r = repo();
  const secret = 'synthetic-secret-abcdefghijklmnopqrstuv';
  const split = secret.slice(0, 5) + '\u001b[0m' + secret.slice(5);
  const line = 'src/a.ts(1,1): error TS1: ' + 'p'.repeat(100) + split;
  const { evidence, failure } = await gate(
    r.dir,
    r.head(),
    {
      command: nodeGate(
        `console.log(${JSON.stringify([line, 'a', 'b', 'c', 'd', 'e'].join('\n'))});process.exit(1)`,
      ),
    },
    secret,
  );
  assert.match(evidence.summary, /error TS1/);
  for (const value of [evidence.summary, failure?.message ?? ''])
    assert.ok(!value.includes(secret.slice(0, 12)), value);
});

test('Non-compiler lines leave the tail as it was', async () => {
  for (const line of [
    '12:34:56 ERROR: request failed',
    'localhost:5432: error: connection refused',
    'x'.repeat(500) + ' src/x.ts(1,2): error TS1: too far',
  ])
    assert.equal(await diagnosticOf([line, 'a', 'b', ...noise]), `Код выхода 1: ${ending}`);
});

test('A quoted compiler line cannot hide different failures from the fingerprint', async () => {
  const quoted = 'src/x.ts(1,2): error TS1234: expected';
  const run = (name: string) =>
    diagnosticOf([quoted, 'a', 'b', 'c', 'd', `FAIL t > ${name}`]).then((summary) =>
      failureFingerprint('gate', summary),
    );
  assert.notEqual(await run('login'), await run('cart'));
});

test('A long spaced line stays cheap to scan', async () => {
  const started = performance.now();
  const summary = await diagnosticOf(['a:1' + ' '.repeat(1_500_000) + 'b']);
  assert.ok(performance.now() - started < 5000);
  assert.ok(summary.length < 400);
});

/** Подменяет чтение нагрузки хоста последовательностью значений на время `fn`. */
async function withLoads<T>(loads: number[], fn: () => Promise<T>) {
  const read = hostLoad.read;
  const queue = [...loads];
  hostLoad.read = () => ({ load1: queue.length > 1 ? queue.shift()! : queue[0]!, cpus: 8 });
  try {
    return await fn();
  } finally {
    hostLoad.read = read;
  }
}
const hang = 'setTimeout(() => {}, 30000)';

test('Таймаут gate: нагрузка — меньшая из снятых до запуска и в момент таймаута; gate, перегрузивший хост сам, повтора не получает', async () => {
  const r = repo({ 'src/a.js': 'a\n' });
  const slow = {
    kind: 'check' as const,
    report: undefined,
    timeoutMs: 300,
    command: nodeGate(hang),
  };
  // До запуска хост свободен, к таймауту загружен (сам gate): повтора нет.
  const self = await withLoads([1, 800], () => gate(r.dir, r.head(), slow));
  assert.ok(self.failure instanceof GateTimeout);
  assert.equal(self.failure.overloaded, false);
  assert.match(self.failure.message, /нагрузка хоста 1 на 8 ядер$/);
  // Загружен до запуска и разгрузился к таймауту — тоже меньшая.
  const eased = await withLoads([800, 8], () => gate(r.dir, r.head(), slow));
  assert.ok(eased.failure instanceof GateTimeout);
  assert.equal(eased.failure.overloaded, false);
  // Загружен и до, и в момент таймаута — повтор оправдан.
  const busy = await withLoads([800, 400], () => gate(r.dir, r.head(), slow));
  assert.ok(busy.failure instanceof GateTimeout);
  assert.equal(busy.failure.overloaded, true);
  assert.match(busy.failure.message, /нагрузка хоста 400 на 8 ядер$/);
});

test('Таймаут gate после записанного провала JUnit — не GateTimeout: найденный провал не повторяется и назван', async () => {
  const r = repo({ 'src/a.js': 'a\n' });
  const { failure, evidence } = await withLoads([800], () =>
    gate(r.dir, r.head(), {
      timeoutMs: 1000,
      command: nodeGate(
        `${junit('<testcase classname="c" name="breaks"><failure message="expected 1"/></testcase>')};${hang}`,
      ),
    }),
  );
  assert.ok(failure instanceof TaskFailure);
  assert.equal(failure instanceof GateTimeout, false, 'провал до таймаута повтора не получает');
  assert.equal(failure.kind, 'gate');
  assert.match(failure.message, /превысила timeout.*; до таймаута упали .*breaks/);
  assert.equal(evidence.passed, false);
  // Зелёный частичный отчёт повтору не мешает.
  const green = await withLoads([800], () =>
    gate(r.dir, r.head(), {
      timeoutMs: 1000,
      command: nodeGate(`${junit('<testcase classname="c" name="ok"/>')};${hang}`),
    }),
  );
  assert.ok(green.failure instanceof GateTimeout);
  assert.equal(green.failure.overloaded, true);
});

test('Таймаут генеративного gate с контрпримером свойства под высокой нагрузкой — не GateTimeout: контрпример не повторяется', async () => {
  const r = repo({ 'src/a.js': 'a\n' });
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  const run = (report: object) =>
    withLoads([800], async () => {
      try {
        await runGate({
          policy: { isolation: { ...policy.isolation, mode: 'none' } },
          record: (e) => {
            recorded.push(e);
            return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
          },
          cwd: r.dir,
          sha: r.head(),
          phase: 'candidate',
          gate: {
            id: 'prop',
            kind: 'check',
            timeoutMs: 1000,
            property: {},
            command: nodeGate(
              `require('fs').writeFileSync(process.env.DEVCONTOUR_PROPERTY_REPORT, ${JSON.stringify(JSON.stringify(report))});${hang}`,
            ),
          },
          artifactDir: mkdtempSync(join(tmpdir(), 'harness-art-')),
          signal: new AbortController().signal,
          execution: { env: process.env, redact: redactor([]) },
          boundary: { hidden: [], readable: [] },
          property: { runId: 'run-1', contracts: {}, artifacts: [] },
        });
      } catch (error) {
        return error;
      }
      return undefined;
    });
  const counterexample = await run({
    version: 1,
    properties: [{ testId: 'p', status: 'failed', cases: 2 }],
  });
  assert.ok(counterexample instanceof TaskFailure, String(counterexample));
  assert.equal(counterexample instanceof GateTimeout, false, 'контрпример не повторяется');
  assert.deepEqual(counterexample.properties?.unbound, ['p']);
  // Без контрпримера тот же таймаут под нагрузкой повтор получает.
  const clean = await run({
    version: 1,
    properties: [{ testId: 'p', status: 'passed', cases: 2 }],
  });
  assert.ok(clean instanceof GateTimeout, String(clean));
  assert.equal(clean.overloaded, true);
});
