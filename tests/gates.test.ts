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
import type { EvidenceRecord, GatePolicy } from '../src/contracts/index.ts';
import { failureFingerprint } from '../src/contracts/failure.ts';
import { redactor } from '../src/environment/redaction.ts';
import { isolationSupport } from '../src/environment/isolation.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import {
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
      policy: { isolation: { ...policy.isolation, mode: isolationMode } },
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
  'A genuine sandbox denial remains environment while its valid failing report is retained',
  { skip: sandbox.ok ? false : 'песочница ОС недоступна: ' + sandbox.detail },
  async () => {
    const r = repo();
    const { evidence, failure, artifactDir } = await gate(
      r.dir,
      r.head(),
      {
        command: nodeGate(
          `${junit('<testcase name="blocked"><error message="sandbox denied write"/></testcase>')};try{require('fs').mkdirSync('.idea')}catch(e){console.error(e.message);process.exit(1)}`,
        ),
      },
      undefined,
      'os',
    );
    assert.equal(failure?.kind, 'environment', evidence.summary);
    assert.equal(evidence.passed, false);
    assert.equal(evidence.exitCode, 1);
    assert.equal(junitSummary(readFileSync(join(artifactDir, 'unit.xml'), 'utf8')).failures, 1);
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
