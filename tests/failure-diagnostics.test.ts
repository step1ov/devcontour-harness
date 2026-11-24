import './temp-scope.ts';
/**
 * Безопасная диагностика провалов (0.1.0-alpha.68): провал gate несёт
 * выжимку (`failureSummary`: упавшие тесты, строка ошибки, хвост вывода с
 * маской; `withheld`, когда обёртка gate ничего не назвала), её видят
 * evidence, `harness gates` и подсказка следующей попытки. Упавший шаг
 * окружения (ready, setup, teardown) называет код или сигнал, предел и хвост
 * вывода с маской в тексте отказа, receipt и smoke — класс отказа и отпечаток
 * от хвоста не зависят.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  failureFingerprint,
  sha256,
  type AttemptState,
  type EvidenceRecord,
  type GatePolicy,
} from '../src/contracts/index.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { classifyFailure, environmentCauseOf } from '../src/engine/classify.ts';
import { gateFeedback } from '../src/engine/gate-feedback.ts';
import { executionEnvironment, runSteps, withEnvironment } from '../src/environment/lifecycle.ts';
import { redactor } from '../src/environment/redaction.ts';
import { gatesText } from '../src/control/gates-check.ts';
import { classifyLifecycleFailure, smokeText } from '../src/control/lifecycle-smoke.ts';
import { runGate } from '../src/verification/gates.ts';
import {
  commandReports,
  failureSummary,
  reportNoFollowAny,
  reportReadHooks,
  WITHHELD_NOTE,
} from '../src/verification/failure-summary.ts';
import { executionPolicySchema } from '../src/contracts/index.ts';
import { example } from './fixtures.ts';
import { repo } from './git-fixture.ts';

const SECRET = 'synthetic-diag-secret-4471';
const redact = redactor([SECRET]);
const withheld = 'Trusted handoff refused or gate failed (details withheld)';

test('выжимка: скрытый вывод — withheld; spec-вывод рядом с общим провалом обёртки — имена из вывода', () => {
  const hidden = failureSummary({ stdout: withheld, stderr: '', redact });
  assert.equal(hidden.withheld, true);
  assert.equal(hidden.tests, undefined);
  assert.equal(hidden.tail, withheld);
  const spec = [
    'ℹ fail 1',
    '✖ failing tests:',
    '✖ outer wrapper outer-kill (241.88ms)',
    '  Error: kill EPERM',
    withheld,
  ].join('\n');
  const wrapped = failureSummary({
    junit: [{ testcase: 'wrapper-execution', message: '', body: 'Gate execution failed' }],
    stdout: spec,
    stderr: '',
    redact,
  });
  assert.equal(wrapped.source, 'output');
  assert.deepEqual(wrapped.tests, ['outer wrapper outer-kill']);
  assert.equal(wrapped.assertion, 'Error: kill EPERM');
  assert.equal(wrapped.withheld, undefined);
  // Свои провалы отчёта без «ошибки» в тексте — тоже имена тестов.
  const own = failureSummary({
    junit: [
      { testcase: 'photo-storage-01', message: 'Photo API status', body: '' },
      { testcase: 'wrapper-execution', message: '', body: 'Gate execution failed' },
    ],
    stdout: '',
    stderr: '',
    redact,
  });
  assert.deepEqual(own.tests, ['photo-storage-01']);
  assert.equal(own.source, 'junit');
  // Строки стадий обёртки с причиной — не скрытый вывод.
  const stages = failureSummary({
    stdout: ['Photo fixture stage: tests', 'Photo fixture failure: cleanup-timeout', withheld].join(
      '\n',
    ),
    stderr: '',
    redact,
  });
  assert.equal(stages.withheld, undefined);
  assert.match(stages.assertion ?? '', /cleanup-timeout/);
  // Обычный хвост без ошибки из многих строк — не скрытый вывод.
  const plain = failureSummary({
    stdout: ['a', 'b', 'c', 'd'].join('\n'),
    stderr: '',
    redact,
  });
  assert.equal(plain.withheld, undefined);
  // Секрет в хвосте и в строке ошибки маскируется.
  const masked = failureSummary({ stdout: '', stderr: `Error: token ${SECRET} rejected`, redact });
  assert.doesNotMatch(JSON.stringify(masked), new RegExp(SECRET));
});

async function gate(
  r: ReturnType<typeof repo>,
  command: string[],
  report?: string,
  silentOnBase?: (id: string) => boolean,
) {
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  let failure: TaskFailure | undefined;
  try {
    await runGate({
      policy: { isolation: { mode: 'none', domains: [] } },
      record: (e) => {
        recorded.push(e);
        return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
      },
      cwd: r.dir,
      sha: r.head(),
      phase: 'candidate',
      gate: {
        id: 'ui-e2e',
        kind: 'test',
        timeoutMs: 30000,
        ...(report ? { report: { type: 'junit', path: report } } : {}),
        command,
      } as GatePolicy,
      artifactDir: mkdtempSync(join(tmpdir(), 'harness-art-')),
      signal: new AbortController().signal,
      execution: { env: { ...process.env, DIAG_SECRET: SECRET }, redact },
      boundary: { hidden: [], readable: [] },
      ...(silentOnBase ? { silentOnBase } : {}),
    });
  } catch (error) {
    if (!(error instanceof TaskFailure)) throw error;
    failure = error;
  }
  assert.equal(recorded.length, 1);
  return { evidence: recorded[0]!, failure };
}

/** Обёртка, которая скрывает вывод; `write` — внутренний JUnit по пути из argv. */
const hidingGate = (write: boolean) => [
  process.execPath,
  '-e',
  `const fs = require('fs');
const dest = process.argv.find((a) => a.startsWith('--test-reporter-destination=')).split('=')[1];
${
  write
    ? `fs.mkdirSync(require('path').dirname(dest), { recursive: true });
fs.writeFileSync(dest, '<testsuite><testcase name="admin sees photo"><failure message="expected 201, got 400 (' + process.env.DIAG_SECRET + ')">AssertionError: 400 !== 201</failure></testcase></testsuite>');`
    : ''
}
console.log(${JSON.stringify(withheld)});
process.exit(1);`,
  '--',
  '--test-reporter-destination=.artifacts/junit/ui-e2e.xml',
];

test('gate со скрытым выводом: имена из JUnit, который команда записала сама; без него — withheld и пометка в тексте', async () => {
  const r = repo();
  const named = await gate(r, hidingGate(true));
  assert.equal(named.failure?.kind, 'gate');
  assert.equal(named.evidence.failureSummary?.source, 'command-report');
  assert.deepEqual(named.evidence.failureSummary?.tests, ['admin sees photo']);
  assert.match(named.evidence.failureSummary?.assertion ?? '', /expected 201, got 400/);
  assert.match(named.evidence.summary, /^Код выхода 1: упали admin sees photo: /);
  assert.doesNotMatch(JSON.stringify(named.evidence), new RegExp(SECRET), 'секрет замаскирован');
  const r2 = repo();
  // Ревью alpha.69: молчаливый провал засчитан исполнителю, пока тот же
  // gate не падает так же на базе.
  const counted = await gate(r2, hidingGate(false));
  assert.equal(counted.failure?.kind, 'gate');
  assert.match(
    counted.evidence.summary,
    /GATE_SILENT_FAILURE: проверка упала, ничего не напечатав/,
  );
  // Так же молчит и база — определение gate: отказ без повтора `gate-definition`.
  const hidden = await gate(r2, hidingGate(false), undefined, (id) => id === 'ui-e2e');
  assert.equal(hidden.failure?.kind, 'environment', 'база падает так же — не провал кода задачи');
  assert.equal(hidden.failure?.diagnosis, 'gate-definition');
  assert.equal(hidden.evidence.failureSummary?.withheld, true);
  assert.ok(hidden.evidence.summary.includes(WITHHELD_NOTE), hidden.evidence.summary);
  assert.match(hidden.evidence.summary, /^GATE_DEFINITION_NO_CAUSE: /);
  // `harness gates --human`: строка причины под gate.
  const text = gatesText({
    id: 'g',
    repositoryId: 'app',
    sha: r2.head(),
    passed: false,
    failFast: false,
    durationMs: 1000,
    gates: [
      {
        gate: 'ui-e2e',
        status: 'failed',
        exitCode: 1,
        summary: hidden.evidence.summary,
        failureSummary: hidden.evidence.failureSummary,
      },
    ],
    logs: '/logs',
  });
  assert.match(text, /\n\s+причина: gate не назвал причину провала/);
});

test('отчёт команды: ссылка на любом компоненте пути (наружу и внутрь дерева) и сам отчёт-ссылка отклонены; размер — по открытому файлу', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-reports-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'harness-outside-')));
  const xml = '<testsuite><testcase name="t"><failure>x</failure></testcase></testsuite>';
  writeFileSync(join(outside, 'junit.xml'), xml);
  const since = Date.now() - 10_000;
  const read = (arg: string) =>
    commandReports(['node', `--test-reporter-destination=${arg}`], root, root, since);
  // Родитель-ссылка наружу: лексически путь внутри дерева, по настоящему — нет.
  symlinkSync(outside, join(root, '.artifacts'));
  assert.deepEqual(await read('.artifacts/junit.xml'), []);
  // Сам отчёт — ссылка (внутрь или наружу).
  mkdirSync(join(root, 'out'));
  symlinkSync(join(outside, 'junit.xml'), join(root, 'out', 'link.xml'));
  assert.deepEqual(await read('out/link.xml'), []);
  writeFileSync(join(root, 'out', 'real.xml'), xml);
  symlinkSync(join(root, 'out', 'real.xml'), join(root, 'out', 'inner-link.xml'));
  assert.deepEqual(await read('out/inner-link.xml'), []);
  // Родитель-ссылка внутрь дерева тоже отклонена; обычный файл — читается.
  symlinkSync(join(root, 'out'), join(root, 'alias'));
  assert.deepEqual(await read('alias/real.xml'), []);
  assert.deepEqual(await read('out/real.xml'), [{ path: join('out', 'real.xml'), xml }]);
  // Больше предела — не читается; каталог с именем отчёта — тоже.
  writeFileSync(join(root, 'out', 'big.xml'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
  assert.deepEqual(await read('out/big.xml'), []);
  mkdirSync(join(root, 'out', 'dir.xml'));
  assert.deepEqual(await read('out/dir.xml'), []);
});

test('отчёт команды: жёсткая ссылка (второе имя файла) отклонена, в том числе на файл вне дерева', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-reports-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'harness-outside-')));
  const xml = '<testsuite><testcase name="t"><failure>x</failure></testcase></testsuite>';
  writeFileSync(join(outside, 'secret.xml'), xml);
  mkdirSync(join(root, 'out'));
  linkSync(join(outside, 'secret.xml'), join(root, 'out', 'junit.xml'));
  writeFileSync(join(root, 'out', 'own.xml'), xml);
  linkSync(join(root, 'out', 'own.xml'), join(root, 'out', 'twin.xml'));
  const since = Date.now() - 10_000;
  for (const name of ['junit.xml', 'twin.xml', 'own.xml'])
    assert.deepEqual(
      await commandReports(['node', `--test-reporter-destination=out/${name}`], root, root, since),
      [],
      name,
    );
});

test('отчёт команды: родитель подменён ссылкой наружу между шагами чтения — файл вне дерева не прочитан', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-reports-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'harness-outside-')));
  const inner = '<testsuite><testcase name="inner"><failure>x</failure></testcase></testsuite>';
  const secret = '<testsuite><testcase name="secret"><failure>x</failure></testcase></testsuite>';
  writeFileSync(join(outside, 'junit.xml'), secret);
  mkdirSync(join(root, 'reports'));
  writeFileSync(join(root, 'reports', 'junit.xml'), inner);
  const since = Date.now() - 10_000;
  const read = () =>
    commandReports(['node', '--test-reporter-destination=reports/junit.xml'], root, root, since);
  const swap = () => {
    renameSync(join(root, 'reports'), join(root, 'reports.real'));
    symlinkSync(outside, join(root, 'reports'));
  };
  const restore = () => {
    renameSync(join(root, 'reports'), join(root, 'reports.link'));
    renameSync(join(root, 'reports.real'), join(root, 'reports'));
  };
  try {
    // Подмена после открытия каталога, до открытия отчёта (и держится до сверки).
    reportReadHooks.step = (stage) => {
      if (stage === 'directory') swap();
    };
    const swapped = await read();
    assert.ok(!JSON.stringify(swapped).includes('secret'), JSON.stringify(swapped));
    // Linux обходит от дескриптора каталога: прочитан файл внутри дерева.
    if (process.platform === 'linux')
      assert.deepEqual(swapped, [{ path: join('reports', 'junit.xml'), xml: inner }]);
    else assert.deepEqual(swapped, []);
    restore();
    // Подмена только на время открытия отчёта, снята до сверки.
    let phase = 0;
    reportReadHooks.step = (stage) => {
      if (stage === 'directory' && phase === 0) {
        swap();
        phase = 1;
      } else if (stage === 'file' && phase === 1) {
        restore();
        phase = 2;
      }
    };
    const restored = await read();
    assert.ok(!JSON.stringify(restored).includes('secret'), JSON.stringify(restored));
    if (process.platform !== 'linux') assert.deepEqual(restored, []);
    // С `O_NOFOLLOW_ANY` (macOS) открытие отчёта отказало раньше шага `file`:
    // подмена ещё держится — снимается здесь.
    if (phase === 1) restore();
  } finally {
    reportReadHooks.step = undefined;
  }
  // Без подмены отчёт читается.
  assert.deepEqual(await read(), [{ path: join('reports', 'junit.xml'), xml: inner }]);
});

test('отчёт gate с общим провалом обёртки: текст называет упавшие тесты по выводу; подсказка исполнителю — выжимку', async () => {
  const r = repo();
  const script = `const fs = require('fs');
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/junit.xml', '<testsuite><testcase name="wrapper-execution"><failure>Gate execution failed</failure></testcase></testsuite>');
console.log(['ℹ fail 1', '✖ failing tests:', '✖ tea detail shows locale (3ms)', "  AssertionError [ERR_ASSERTION]: undefined !== 'ru'", ${JSON.stringify(withheld)}].join('\\n'));
process.exit(1);`;
  const { evidence } = await gate(r, [process.execPath, '-e', script], 'out/junit.xml');
  assert.equal(evidence.failureSummary?.source, 'output');
  assert.deepEqual(evidence.failureSummary?.tests, ['tea detail shows locale']);
  assert.match(
    evidence.summary,
    /упали wrapper-execution: Gate execution failed; по выводу: tea detail shows locale/,
  );
  const attempt = {
    id: 'run-1',
    evidence: [{ ...evidence, id: 'e1', runId: 'run-1', createdAt: new Date().toISOString() }],
  } as unknown as AttemptState;
  const feedback = await gateFeedback(attempt, redact);
  assert.ok(feedback, 'подсказка есть');
  const summary = feedback.cases.find((c) => c.source === 'failure-summary');
  assert.ok(summary, JSON.stringify(feedback.cases));
  assert.match(summary.text, /Failing tests \(from the gate output\): tea detail shows locale/);
  assert.match(summary.text, /First error line: AssertionError/);
  // Скрытый вывод: подсказка говорит, что gate не назвал причину.
  const hidden = await gate(repo(), hidingGate(false));
  const fb = await gateFeedback(
    {
      id: 'run-2',
      evidence: [{ ...hidden.evidence, id: 'e2', runId: 'run-2', createdAt: '' }],
    } as unknown as AttemptState,
    redact,
  );
  assert.match(fb?.text ?? '', /The gate printed no failure cause/);
  assert.equal(sha256(readFileSync(hidden.evidence.log, 'utf8')), hidden.evidence.digest);
});

const env = () =>
  executionEnvironment(
    [{ inherit: [], values: {}, secrets: { TOKEN: 'DIAG_SRC' } }],
    {},
    {
      ...process.env,
      DIAG_SRC: SECRET,
    },
  );
const step = (id: string, script: string, timeoutMs = 20000) => ({
  id,
  command: [process.execPath, '-e', script],
  timeoutMs,
});

test('упавший шаг ready: код, хвост вывода с маской в тексте отказа; класс и отпечаток от хвоста не зависят', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-steps-'));
  const fail = (tail: string) =>
    runSteps(
      [
        step(
          'photo-ready',
          `console.error('stage=bindings: 127.0.0.1 port unreachable, waited until timeout (token ' + process.env.TOKEN + ') ${tail}'); process.exit(7)`,
        ),
      ],
      dir,
      join(dir, 'ready'),
      env(),
      new AbortController().signal,
    ).then(
      () => assert.fail('шаг должен упасть'),
      (e: unknown) => e as Error,
    );
  const a = await fail('first');
  const b = await fail('second');
  assert.match(
    a.message,
    /^Шаг photo-ready: exit=7; timeout=false; стадия ready ⟦вывод: .*stage=bindings/,
  );
  assert.doesNotMatch(a.message, new RegExp(SECRET));
  assert.equal(
    classifyFailure(a, a.message),
    'unknown',
    '«timeout» в выводе шага — не предел времени',
  );
  assert.equal(environmentCauseOf(a, a.message, 'environment'), 'other');
  assert.equal(failureFingerprint('unknown', a.message), failureFingerprint('unknown', b.message));
});

test('receipt окружения: упавший ready и teardown, исчерпавший предел, — шаг, предел, сигнал и хвост', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-env-'));
  const cwd = mkdtempSync(join(tmpdir(), 'harness-cwd-'));
  const lifecycle = {
    setup: [],
    ready: [
      step(
        'photo-ready',
        `console.log('postgres ok'); console.error('minio: 403 for token ' + process.env.TOKEN); process.exit(2)`,
      ),
    ],
    teardown: [
      step('photo-down', `console.log('stopping worker'); setTimeout(() => {}, 60000)`, 1500),
    ],
  };
  const failure = await withEnvironment(
    lifecycle,
    cwd,
    dir,
    env(),
    new AbortController().signal,
    () => Promise.resolve('never'),
  ).then(
    () => assert.fail('фаза должна упасть'),
    (e: unknown) => e as Error,
  );
  assert.match(failure.message, /Шаг photo-ready: exit=2/);
  assert.match(
    failure.message,
    /Шаг photo-down: exit=-?\d+; timeout=true; signal=SIG\w+; стадия teardown ⟦вывод: stopping worker⟧/,
  );
  const receipt = JSON.parse(readFileSync(join(dir, 'environment.json'), 'utf8')) as {
    status: string;
    failure: { stage: string; step: string; exitCode: number; timedOut: boolean; tail: string };
    cleanupFailure: { step: string; timedOut: boolean; signal?: string; tail: string }[];
  };
  assert.equal(receipt.status, 'cleanup-failed');
  assert.deepEqual(
    { stage: receipt.failure.stage, step: receipt.failure.step, code: receipt.failure.exitCode },
    { stage: 'ready', step: 'photo-ready', code: 2 },
  );
  assert.equal(receipt.failure.timedOut, false);
  assert.match(receipt.failure.tail, /postgres ok\nminio: 403 for token \[REDACTED\]|minio: 403/);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(SECRET));
  assert.equal(receipt.cleanupFailure[0]!.step, 'photo-down');
  assert.equal(receipt.cleanupFailure[0]!.timedOut, true);
  assert.match(receipt.cleanupFailure[0]!.tail, /stopping worker/);
});

test('smoke: отказ ready несёт хвост шага, таблица --human печатает его под шагом', () => {
  const policy = executionPolicySchema.parse(example('policy'));
  const outcome = {
    stage: 'ready',
    id: 'photo-ready',
    durationMs: 1200,
    ok: false,
    exitCode: 1,
    timedOut: false,
    aborted: false,
    signal: 'SIGTERM',
    tail: 'stage=bindings\nport 127.0.0.1:54001 unreachable',
  };
  const f = classifyLifecycleFailure(new Error('Шаг photo-ready: exit=1; timeout=false'), outcome, {
    policy,
    timedOut: false,
  });
  assert.equal(f.class, 'crash');
  assert.equal(f.tail, outcome.tail);
  const text = smokeText({
    id: 'LS-1',
    repositoryId: 'app',
    sha: 'a'.repeat(40),
    passed: false,
    durationMs: 1200,
    steps: [
      {
        stage: 'ready',
        id: 'photo-ready',
        status: 'failed',
        durationMs: 1200,
        exitCode: 1,
        signal: 'SIGTERM',
        tail: outcome.tail,
      },
    ],
    failure: f,
    logs: '/logs',
  });
  assert.match(
    text,
    /ready\/photo-ready\s+failed\s+1\s+1 с \(SIGTERM\)\n\s+\| stage=bindings\n\s+\| port 127/,
  );
});

test('A68-r3: macOS открывает компоненты отчёта с O_NOFOLLOW_ANY — ссылка в любом родителе отклоняется ядром', () => {
  if (process.platform === 'darwin') assert.equal(reportNoFollowAny(), true);
  else assert.equal(reportNoFollowAny(), false);
});
