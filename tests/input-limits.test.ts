/* eslint-disable @typescript-eslint/no-explicit-any --
 * Подставной адаптер отдаёт только нужные тесту поля capabilities.
 */
/**
 * Пределы недоверенного входа: размер файла ответа runtime, число элементов в
 * ответах моделей, инструментов и Relay. Лишнее — обычный отказ попытки с
 * понятной причиной; записанное прежними версиями читается как раньше.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_RESULT_LIMIT, cliAdapter } from '../src/agents/cli-adapter.ts';
import { probeSpec, assertProbeSpec, type ProbeSpec } from '../src/agents/review-probe.ts';
import { reviewOutputSchema } from '../src/agents/schemas.ts';
import {
  REVIEW_ITEMS_LIMIT,
  TaskFailure,
  checkCodeReview,
  digestOf,
  evidenceRecordSchema,
  implementationResultSchema,
  reviewRecordSchema,
  reviewResultSchema,
  storedReviewResultSchema,
  type ProtocolIssue,
  type RuntimeAdapter,
  type RuntimeName,
  type RuntimeRequest,
} from '../src/contracts/index.ts';
import { Harness } from '../src/control/harness.ts';
import { OversizedFile, readBounded } from '../src/environment/bounded-read.ts';
import { TransportError } from '../src/integrations/connector/transport.ts';
import { createTransport as relayV1 } from '../src/integrations/relay-v1/index.ts';
import { createTransport as relayV2 } from '../src/integrations/relay-v2/index.ts';
import { itemsSchema, taskSchema } from '../src/integrations/relay-v2/protocol.ts';
import { policyOf } from './engine-fixture.ts';
import { knap, propertySetup } from './property-fixture.ts';
import { finding, fixtureCalls, verdict } from './review-fixture.ts';
import { approve, greet, implement, runAll, setup } from './runner-fixture.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'harness-limits-'));
const history = { scope: 's', round: 0, findings: [] };
const origin = { runId: 'r', phase: 'candidate' as const, sha: 'a'.repeat(40) };
const response = (over: Record<string, unknown>) => ({
  approved: false,
  summary: 'r',
  findings: [],
  ...over,
});
const findings = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ severity: 'note', message: 'm' + i }));
const transitions = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: digestOf(i),
    status: 'closed',
    basis: 'исправлено',
  }));

test('ответ reviewer: предел принимается, лишний элемент — одна ошибка схемы с путём поля', () => {
  assert.ok(reviewResultSchema.safeParse(response({ findings: findings(500) })).success);
  assert.ok(reviewResultSchema.safeParse(response({ previous: transitions(500) })).success);
  for (const [field, items] of [
    ['findings', findings(501)],
    ['previous', transitions(501)],
  ] as const) {
    const verdict = checkCodeReview(response({ [field]: items }), history, origin);
    assert.equal(verdict.valid, false);
    assert.deepEqual(verdict.valid ? [] : verdict.issues.map((i) => [i.path, i.reason]), [
      [field, 'schema'],
    ]);
  }
});

test('ответ reviewer: миллион негодных элементов не даёт ошибок на элемент', () => {
  const crafted = response({ findings: Array.from({ length: 1_000_000 }, () => ({})) });
  const parsed = reviewResultSchema.safeParse(crafted);
  assert.equal(parsed.error?.issues.length, 1);
  assert.equal(parsed.error?.issues[0]?.code, 'too_big');
});

test('ответ исполнителя: discoveries сверх предела — отказ схемы с причиной', () => {
  const parsed = implementationResultSchema.safeParse({
    completed: true,
    summary: 's',
    discoveries: Array.from({ length: 666_000 }, () => ({})),
  });
  assert.equal(parsed.error?.issues.length, 1);
  assert.equal(parsed.error?.issues[0]?.code, 'too_big');
});

test('wire-схема объявляет те же пределы: ответ, допустимый для runtime, не отбрасывается позже', () => {
  const { findings: wire, previous } = reviewOutputSchema.properties;
  assert.equal(wire.maxItems, REVIEW_ITEMS_LIMIT);
  assert.equal(previous.maxItems, REVIEW_ITEMS_LIMIT);
});

test('записанное прежними версиями читается: длинные списки вне границы приёма', () => {
  const long = findings(2000);
  // review.json прежней версии: ответ reviewer и поля записи controller.
  const saved = response({ findings: long, previous: transitions(2000), issues: [], probes: [] });
  const read = storedReviewResultSchema.safeParse(JSON.parse(JSON.stringify(saved)));
  assert.ok(read.success);
  assert.equal(read.data.findings.length, 2000);
  assert.equal(read.data.previous.length, 2000);

  const issued = long.map((f) => ({
    ...f,
    id: digestOf(f.message),
    severity: 'blocking' as const,
    status: 'open' as const,
    openedIn: 1,
    changedIn: 1,
  }));
  assert.ok(
    reviewRecordSchema.safeParse({
      id: 'RV-plan-g-1',
      kind: 'plan',
      subject: 'g',
      digest: digestOf('g'),
      round: 1,
      at: '2026-01-01T00:00:00.000Z',
      approved: false,
      summary: 's',
      authorRuntime: 'claude',
      reviewerRuntime: 'codex',
      sameVendor: false,
      findings: issued,
      artifact: 'a',
    }).success,
  );
  assert.ok(
    evidenceRecordSchema.safeParse({
      id: 'E1',
      runId: 'r',
      kind: 'review',
      phase: 'candidate',
      sha: 'a'.repeat(40),
      gate: 'independent-review',
      passed: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      command: ['codex', 'review-code'],
      exitCode: 1,
      log: 'review.json',
      digest: digestOf('e'),
      summary: 's',
      findings: long.map((f) => ({ severity: f.severity, message: f.message })),
    }).success,
  );
});

test('подтверждение воспроизведений читает review.json прежней версии с длинным списком', async () => {
  const rejecting = verdict(false, {
    findings: [
      {
        ...finding('Падает на пустом входе'),
        reproduction: {
          property: 'knapsack-optimal',
          input: '{"items":[],"cap":0}',
          expected: null,
          actual: null,
          command: null,
          executed: false,
          run: null,
        },
      },
    ],
  });
  const ctx = propertySetup({
    writer: [implement({ 'src/knap.mjs': knap.correct })],
    reviewer: [rejecting],
  });
  await ctx.runner.init();
  await runAll(ctx);
  const attempt = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  const review = attempt.evidence.find((e) => e.kind === 'review' && !e.passed);
  assert.ok(review, attempt.error);
  const saved = JSON.parse(readFileSync(review.log, 'utf8')) as { findings: unknown[] };
  saved.findings.push(...findings(REVIEW_ITEMS_LIMIT));
  writeFileSync(review.log, JSON.stringify(saved));
  const submitted: unknown[] = [];
  const runner = ctx.runner as unknown as {
    submitCase: (input: unknown) => Promise<unknown>;
    confirmReproductions: (attempt: unknown) => Promise<void>;
  };
  runner.submitCase = (input) => {
    submitted.push(input);
    return Promise.resolve({});
  };
  await runner.confirmReproductions(attempt);
  assert.equal(submitted.length, 1, 'пример из длинного файла дошёл до подтверждения');
});

test('readBounded: предел принимается, лишний байт, symlink и FIFO — нет', async () => {
  const dir = scratch();
  const file = join(dir, 'a');
  writeFileSync(file, 'é'.repeat(8));
  assert.equal(await readBounded(file, 16), 'é'.repeat(8));
  await assert.rejects(readBounded(file, 15), (e: unknown) => e instanceof OversizedFile);
  const link = join(dir, 'link');
  symlinkSync(file, link);
  await assert.rejects(readBounded(link, 100), { code: 'ELOOP' });
  const fifo = join(dir, 'fifo');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(readBounded(fifo, 100), /не обычный файл/);
});

test('readBounded: огромный разреженный файл отклоняется без чтения', async () => {
  const file = join(scratch(), 'sparse');
  writeFileSync(file, '');
  truncateSync(file, 64 * 1024 ** 3);
  const started = performance.now();
  await assert.rejects(readBounded(file, 1024), (e: unknown) => e instanceof OversizedFile);
  assert.ok(performance.now() - started < 1000);
});

/** Подставной codex: кладёт в файл ответа заданные байты, как CLI после вызова модели. */
function fakeCodex(dir: string) {
  const bin = join(dir, 'codex-file');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('fake 0.0.1'); process.exit(0); }
fs.copyFileSync(process.env.PAYLOAD, a[a.indexOf('--output-last-message') + 1]);
`,
    { mode: 0o755 },
  );
  return bin;
}
const request = (dir: string, env: Record<string, string>, secrets: string[] = []) =>
  ({
    callId: 'c1',
    task: 'implement',
    binding: { runtime: 'codex' },
    cwd: dir,
    prompt: 'p',
    session: { kind: 'fresh' },
    sandbox: { mode: 'none', writable: [dir], denied: [], network: { domains: [] } },
    timeoutMs: 20_000,
    env: { PATH: process.env.PATH ?? '', ...env },
    artifactDir: join(dir, 'call'),
    secrets,
  }) as unknown as RuntimeRequest;
const invoke = (dir: string, payload: string, secrets: string[] = []) =>
  cliAdapter('codex', { executable: fakeCodex(dir) }).invoke(
    request(dir, { PAYLOAD: payload }, secrets),
    new AbortController().signal,
  );

test('файл ответа codex: предел читается, больше предела — отказ без незамаскированной копии', async () => {
  const dir = scratch();
  const payload = join(dir, 'payload');
  const at = '{"a":1}';
  writeFileSync(payload, at + ' '.repeat(CODEX_RESULT_LIMIT - at.length));
  const ok = await invoke(dir, payload);
  assert.equal(ok.status, 'ok', ok.diagnostics.reason);
  assert.deepEqual(ok.output, { a: 1 });

  writeFileSync(payload, 'token-secret-1 ' + ' '.repeat(CODEX_RESULT_LIMIT));
  const over = await invoke(dir, payload, ['token-secret-1']);
  assert.equal(over.status, 'failed');
  assert.equal(over.diagnostics.exitCode, 0);
  assert.match(
    over.diagnostics.reason!,
    new RegExp(`^структурированный ответ не прочитан: .*${CODEX_RESULT_LIMIT} байт`),
  );
  assert.equal(existsSync(join(dir, 'call', 'result.json')), false);
});

test('файл ответа codex: подложенный symlink не читается и не переписывается', async () => {
  const dir = scratch();
  const bin = join(dir, 'codex-link');
  const victim = join(dir, 'victim');
  writeFileSync(victim, '{"a":"исходный"}');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('fake 0.0.1'); process.exit(0); }
fs.symlinkSync(process.env.VICTIM, a[a.indexOf('--output-last-message') + 1]);
`,
    { mode: 0o755 },
  );
  const result = await cliAdapter('codex', { executable: bin }).invoke(
    request(dir, { VICTIM: victim }, ['исходный']),
    new AbortController().signal,
  );
  assert.equal(result.status, 'failed');
  assert.match(result.diagnostics.reason!, /ELOOP/);
  assert.equal(readFileSync(victim, 'utf8'), '{"a":"исходный"}');
});

/** Прогон в отдельном процессе с малой кучей: нарушение предела — аварийное завершение. */
function underHeap(heapMb: number, source: string, args: string[]) {
  const dir = scratch();
  const script = join(dir, 'run.mts');
  writeFileSync(script, source);
  return spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${heapMb}`,
      '--disable-warning=ExperimentalWarning',
      '--import',
      import.meta.resolve('tsx'),
      script,
      ...args,
    ],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '' } },
  );
}
const src = (path: string) => new URL(`../src/${path}`, import.meta.url).href;
const HEAP_MB = 256;
const crafted = (bytes: number) => {
  // Самый дешёвый элемент: каждые три байта — объект и две ошибки схемы.
  const head = '{"approved":false,"summary":"s","findings":[';
  const count = Math.floor((bytes - head.length - 3) / 3);
  return head + '{},'.repeat(count) + '{}]}';
};

test(`куча и время ограничены: файл на пределе не выходит за ${HEAP_MB} МБ, файл больше предела не читается`, () => {
  const dir = scratch();
  const atLimit = join(dir, 'at-limit.json');
  const huge = join(dir, 'huge.json');
  writeFileSync(atLimit, crafted(CODEX_RESULT_LIMIT));
  writeFileSync(huge, crafted(32 * 1024 * 1024));
  assert.ok(statSync(atLimit).size <= CODEX_RESULT_LIMIT);
  const run = underHeap(
    HEAP_MB,
    `
import { cliAdapter } from ${JSON.stringify(src('agents/cli-adapter.ts'))};
import { checkCodeReview } from ${JSON.stringify(src('contracts/index.ts'))};
const [bin, payload, cwd] = process.argv.slice(2);
const response = await cliAdapter('codex', { executable: bin }).invoke({
  callId: 'c', task: 'implement', binding: { runtime: 'codex' }, cwd, prompt: 'p',
  session: { kind: 'fresh' },
  sandbox: { mode: 'none', writable: [cwd], denied: [], network: { domains: [] } },
  timeoutMs: 30000, env: { PATH: process.env.PATH, PAYLOAD: payload }, artifactDir: cwd + '/call',
}, new AbortController().signal);
const verdict = response.status === 'ok'
  ? checkCodeReview(response.output, { scope: 's', round: 0, findings: [] }, { runId: 'r', phase: 'candidate', sha: 'a'.repeat(40) })
  : undefined;
console.log(JSON.stringify({ status: response.status, reason: response.diagnostics.reason, issues: verdict?.valid === false ? verdict.issues : null }));
`,
    [fakeCodex(dir), atLimit, dir],
  );
  assert.equal(run.status, 0, run.stderr.slice(-500));
  const at = JSON.parse(run.stdout) as { status: string; issues: ProtocolIssue[] };
  assert.equal(at.status, 'ok');
  assert.deepEqual(
    at.issues.map((i) => [i.path, i.reason]),
    [['findings', 'schema']],
  );

  const over = underHeap(
    64,
    `
import { cliAdapter } from ${JSON.stringify(src('agents/cli-adapter.ts'))};
const [bin, payload, cwd] = process.argv.slice(2);
const started = performance.now();
const response = await cliAdapter('codex', { executable: bin }).invoke({
  callId: 'c', task: 'implement', binding: { runtime: 'codex' }, cwd, prompt: 'p',
  session: { kind: 'fresh' },
  sandbox: { mode: 'none', writable: [cwd], denied: [], network: { domains: [] } },
  timeoutMs: 30000, env: { PATH: process.env.PATH, PAYLOAD: payload }, artifactDir: cwd + '/call-huge',
}, new AbortController().signal);
console.log(JSON.stringify({ status: response.status, reason: response.diagnostics.reason, ms: performance.now() - started }));
`,
    [fakeCodex(dir), huge, dir],
  );
  assert.equal(over.status, 0, over.stderr.slice(-500));
  const big = JSON.parse(over.stdout) as { status: string; reason: string; ms: number };
  assert.equal(big.status, 'failed');
  assert.match(big.reason, /не прочитан/);
  assert.ok(big.ms < 10_000, String(big.ms));
});

test('без предела та же нагрузка выходит за кучу: снятие защиты роняет процесс', () => {
  const dir = scratch();
  const payload = join(dir, 'at-limit.json');
  writeFileSync(payload, crafted(CODEX_RESULT_LIMIT));
  const run = (schema: string) =>
    underHeap(
      HEAP_MB,
      `
import { readFileSync } from 'node:fs';
import { ${schema} as schema } from ${JSON.stringify(src('contracts/index.ts'))};
const parsed = schema.safeParse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
console.log(parsed.error?.issues.length);
`,
      [payload],
    );
  const guarded = run('reviewResultSchema');
  assert.equal(guarded.status, 0, guarded.stderr.slice(-500));
  assert.equal(guarded.stdout.trim(), '1');
  // Схема чтения записанных файлов — та же форма без предела.
  const unguarded = run('storedReviewResultSchema');
  assert.notEqual(unguarded.status, 0, 'без предела разбор не укладывается в кучу');
  assert.match(unguarded.stderr, /heap out of memory/i);
});

test('отказы движка: ревью сверх предела — review-protocol с причиной, без новых вызовов сверх разрешённых', async () => {
  const cases: [string, unknown, RegExp][] = [
    ['элементы', verdict(false, { findings: findings(501) }), /REVIEW_PROTOCOL_INVALID.*findings/],
    [
      'файл',
      { raw: ' '.repeat(CODEX_RESULT_LIMIT + 1) },
      /REVIEW_PROTOCOL_INVALID.*не прочитан.*байт/,
    ],
    // Самый дорогой файл в пределе: сырой ответ вне схемы ещё и сохраняется в review.json.
    ['файл на пределе', { raw: crafted(CODEX_RESULT_LIMIT) }, /REVIEW_PROTOCOL_INVALID.*findings/],
  ];
  for (const [name, reviewer, reason] of cases) {
    const ctx = setup({ scenario: { writer: implement(), reviewer } });
    await runAll(ctx);
    const work = ctx.engine.read((v) => v.work('add-greeting')!);
    assert.equal(work.status, 'failed', name);
    assert.equal(work.failureKind, 'review-protocol', name);
    assert.match(work.failure!, reason, name);
    assert.equal(fixtureCalls(ctx.scenarioPath, 'codex', 'reviewer'), 2, name);
  }
});

test('ответ claude длиннее хвоста stdout — ошибка протокола, а не разбор обрезанного', async () => {
  const ctx = setup({
    writer: 'codex',
    reviewer: 'claude',
    scenario: { writer: implement(), reviewer: { raw: 'x'.repeat(2_100_000) } },
  });
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.failureKind, 'review-protocol', work.failure);
  assert.match(work.failure!, /не прочитан/);
});

test('отказы движка: файл ответа исполнителя больше предела — отказ попытки без повтора', async () => {
  const ctx = setup({
    writer: 'codex',
    reviewer: 'claude',
    scenario: {
      writer: { ...implement(), raw: ' '.repeat(CODEX_RESULT_LIMIT + 1) },
      reviewer: approve(),
    },
  });
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'unknown');
  assert.match(work.failure!, new RegExp(`не прочитан.*${CODEX_RESULT_LIMIT} байт`));
  assert.equal(fixtureCalls(ctx.scenarioPath, 'codex', 'writer'), 1);
});

test('история сверх предела раунда — остановка до вызова reviewer, а не отказ записи', async () => {
  const open = Array.from({ length: REVIEW_ITEMS_LIMIT }, (_, n) => ({
    id: `$open:${n}`,
    status: 'open',
    basis: 'всё ещё не исправлено',
  }));
  const ctx = setup({
    scenario: {
      writer: [1, 2, 3].map((n) => implement({ 'src/greet.js': `${greet}// ${n}\n` })),
      reviewer: [
        verdict(false, { findings: findings(REVIEW_ITEMS_LIMIT), summary: 'первый раунд' }),
        verdict(false, { findings: findings(1), previous: open, summary: 'второй раунд' }),
      ],
    },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 3),
  });
  await runAll(ctx);
  for (let retry = 0; retry < 2; retry++) {
    ctx.engine.retry('add-greeting');
    await ctx.runner.drain();
  }
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.failureKind, 'review-protocol', work.failure);
  assert.match(work.failure!, /открытых находок 501, предел раунда ревью 500/);
  assert.equal(fixtureCalls(ctx.scenarioPath, 'codex', 'reviewer'), 2);
});

test('ревью плана: ответ сверх предела — неодобренный раунд с причиной и путём поля', async () => {
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: () =>
      Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'controlled',
        output: response({ findings: findings(501) }),
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 0,
          complete: true,
          source: 'claude-result',
        },
        diagnostics: { exitCode: 0 },
      }),
  });
  const adapters = { codex: adapter('codex'), claude: adapter('claude') };
  const policy = policyOf();
  const stateDir = scratch();
  const h = Harness.open({ policy, stateDir, baseDir: process.cwd(), adapters });
  const { technicalReview } = await import('../src/control/review.ts');
  const record = await technicalReview(h.engine, policy, adapters, {
    kind: 'plan',
    subject: 'g',
    digest: 'a'.repeat(64),
    author: 'claude',
    instructions: ['Review.'],
    cwd: process.cwd(),
    artifactDir: join(stateDir, 'plan'),
    denied: [stateDir],
    meta: { subjectId: 'g', subjectKind: 'other' },
  });
  assert.equal(record.approved, false);
  assert.deepEqual(record.findings, []);
  assert.match(record.summary, /вне схемы: findings: .*500/);
});

const probe = (over: Partial<ProbeSpec> = {}): ProbeSpec => ({
  cwd: '/w',
  controller: [],
  readable: [],
  isolation: { mode: 'none', domains: [] },
  commandTimeoutMs: 1000,
  budgetMs: 1000,
  deadline: 1,
  env: [],
  secrets: [],
  settingsDir: '/s',
  log: '/l',
  ...over,
});

test('спецификация проверок: предел принимается, сверх него — отказ среды до запуска сервера', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => 'V' + i);
  const gate = {
    id: 'unit',
    kind: 'test' as const,
    command: names(10_001),
    timeoutMs: 1000,
  };
  assert.doesNotThrow(() => assertProbeSpec(probe({ env: names(10_000) })));
  for (const over of [
    { controller: names(10_001) },
    { readable: names(10_001) },
    { checkouts: names(10_001) },
    { isolation: { mode: 'none' as const, domains: names(10_001) } },
    { env: names(10_001) },
    { secrets: names(10_001) },
    { gates: [gate] },
    { gates: Array.from({ length: 10_001 }, () => ({ ...gate, command: ['x'] })) },
  ]) {
    assert.equal(probeSpec.safeParse(probe(over)).error?.issues.length, 1);
    assert.throws(
      () => assertProbeSpec(probe(over)),
      (e: unknown) => e instanceof TaskFailure && e.kind === 'environment',
    );
  }
});

test('Relay v1: массив сверх предела — отказ протокола, предел принимается', async () => {
  const P = 'Proj1234';
  let count = 0;
  const names = () => Array.from({ length: count }, (_, i) => 'c' + i);
  const server = createServer((req, res) => {
    const data = req.url?.startsWith('/api/v1/health')
      ? { status: 'ok', stage: 'ready', contractVersion: 1 }
      : req.url?.includes('/comments')
        ? { items: names().map((id) => ({ id })), nextCursor: null, snapshot: 1 }
        : { projectId: P, capabilities: names(), project: 'x' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const transport = relayV1({
    endpoint: `http://127.0.0.1:${port}`,
    projectId: P,
    actor: 'a',
    timeoutMs: 5000,
  });
  const refused = (field: RegExp) => (e: unknown) => {
    assert.ok(e instanceof TransportError, String(e));
    assert.equal(e.kind, 'protocol');
    assert.match(e.message, field);
    return true;
  };
  try {
    count = 10_000;
    assert.equal((await transport.identity()).capabilities.length, 10_000);
    count = 10_001;
    await assert.rejects(transport.identity(), refused(/capabilities/));
    await assert.rejects(transport.listComments('PRODUCT-1'), refused(/at items: Too big/));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Relay-2: массив сверх предела — отказ протокола, предел принимается', async () => {
  const dir = scratch();
  const binary = join(dir, 'relay');
  const project = '11111111-2222-3333-4444-555555555555';
  writeFileSync(
    binary,
    `#!${process.execPath}
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ok = (data) => process.stdout.write(JSON.stringify({ ok: true, data }) + '\\n', () => process.exit(0));
if (process.argv.some((a) => a.includes('00000000-0000'))) { process.stderr.write(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'x' } }) + '\\n'); process.exit(3); }
else if (pos[0] === 'storage') ok({ projectId: ${JSON.stringify(project)}, databasePath: 'db', generation: 1 });
else if (pos[0] === 'doctor') ok({ projectId: ${JSON.stringify(project)}, generation: 1, valid: true, issues: [] });
else if (pos[0] === 'project') ok({ id: ${JSON.stringify(project)}, kind: 'project', key: 'P', revision: 1, data: { name: 'x' } });
else if (pos[0] === 'task') ok({ id: 't', kind: 'task', key: 'K', revision: 1, data: { title: 't', description: null, column: 'inbox', parentId: null,
  dependencies: Array.from({ length: 10001 }, (_, i) => 'd' + i), acceptanceCriteria: [] } });
else process.exit(9);
`,
    { mode: 0o755 },
  );
  const transport = relayV2(
    {
      binary,
      config: join(dir, 'relay.config.json'),
      projectId: project,
      actor: 'a',
      env: { RELAY_HOME: dir },
    },
    { cwd: dir, killGraceMs: 200 },
  );
  await assert.rejects(transport.readTask('K'), (e: unknown) => {
    assert.ok(e instanceof TransportError, String(e));
    assert.equal(e.kind, 'protocol');
    assert.match(e.message, /dependencies/);
    return true;
  });
  assert.ok(itemsSchema.safeParse({ items: new Array(10_000).fill(0) }).success);
  assert.equal(
    itemsSchema.safeParse({ items: new Array(10_001).fill(0) }).error?.issues[0]?.code,
    'too_big',
  );
  assert.ok(
    taskSchema.safeParse({
      id: 't',
      kind: 'task',
      key: 'K',
      revision: 1,
      data: {
        title: 't',
        description: null,
        column: 'inbox',
        parentId: null,
        dependencies: new Array(10_000).fill('d'),
        acceptanceCriteria: [],
      },
    }).success,
  );
});

test('файл результата случая больше предела — inconclusive, а не разбор без границы', async () => {
  // Проверяемый код сам дописывает файл результата поверх ответа проверки.
  const planted = `import { writeFileSync } from 'node:fs';
process.on('exit', () => {
  if (process.env.HARNESS_CASE_RESULT)
    writeFileSync(process.env.HARNESS_CASE_RESULT, 'x'.repeat(2 * 1024 * 1024));
});
`;
  const ctx = propertySetup({
    writer: [implement({ 'src/knap.mjs': planted + knap.firstThree })],
  });
  await ctx.runner.init();
  await runAll(ctx);
  const result = await ctx.runner.submitCase({
    workId: 'add-greeting',
    property: 'knapsack-optimal',
    input: JSON.stringify({
      items: [
        { w: 1, v: 1 },
        { w: 1, v: 1 },
        { w: 1, v: 1 },
        { w: 1, v: 9 },
      ],
      cap: 4,
    }),
    key: 'case-oversized-result',
  });
  assert.equal(result.decision.outcome, 'inconclusive');
  assert.match(result.decision.reason, /больше предела/);
});
