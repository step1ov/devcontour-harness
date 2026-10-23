/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тесты читают сырые JSON-ответы и состояние как есть.
 */
/**
 * Протокол ответа reviewer: согласованность wire-схемы CLI runtime и Zod
 * (HP04), записи alpha.5 и неизменность pins политики (HP09), атомарность
 * plan/contract technicalReview (HP03). docs/review-protocol.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  checkCodeReview,
  codeReviewHistory,
  codeReviewScope,
  digestOf,
  executionDigest,
  executionPolicySchema,
  findingId,
  policyDigest,
  reviewResultSchema,
  runResultSchema,
  type CodeReviewHistory,
  type ReviewRequestFindings,
  type RuntimeAdapter,
  type RuntimeName,
} from '../src/contracts/index.ts';
import { reviewOutputSchema } from '../src/agents/schemas.ts';
import { Harness } from '../src/control/harness.ts';
import { runResult } from '../src/engine/result.ts';
import { policyOf } from './engine-fixture.ts';
import { approve, implement, runAll, setup, target } from './runner-fixture.ts';
import { close, finding, verdict } from './review-fixture.ts';

const ajv = new Ajv2020({ strict: false, allErrors: true });
const wire = ajv.compile(reviewOutputSchema);
const WORK = 'add-greeting';

const base = () => ({
  approved: false,
  summary: 'Есть замечания',
  findings: [],
  discoveries: [],
  execution: { commands: [], noCommandsReason: 'diff' },
  previous: [] as unknown[],
});
const hex = (n: number, c = 'a') => c.repeat(n);

test('HP04: wire-схема CLI runtime и Zod согласованы по ID, статусу и основанию перехода', () => {
  const cases: [string, unknown, boolean][] = [
    ['ID 64 hex', { id: hex(64), status: 'closed', basis: 'исправлено' }, true],
    ['ID 63', { id: hex(63), status: 'closed', basis: 'исправлено' }, false],
    ['ID 65', { id: hex(65), status: 'closed', basis: 'исправлено' }, false],
    ['ID non-hex', { id: hex(64, 'g'), status: 'closed', basis: 'исправлено' }, false],
    ['ID верхний регистр', { id: hex(64, 'A'), status: 'closed', basis: 'исправлено' }, false],
    ['ID произвольный', { id: 'F-1', status: 'closed', basis: 'исправлено' }, false],
    ['пустое основание', { id: hex(64), status: 'closed', basis: '' }, false],
    ['пробельное основание', { id: hex(64), status: 'closed', basis: '  \n ' }, false],
    ['основание короче трёх знаков', { id: hex(64), status: 'closed', basis: ' ok ' }, false],
    ['длинное основание', { id: hex(64), status: 'closed', basis: 'x'.repeat(6000) }, true],
    ['недопустимый статус', { id: hex(64), status: 'fixed', basis: 'исправлено' }, false],
    ['лишнее поле', { id: hex(64), status: 'open', basis: 'остаётся', note: 1 }, false],
    ['нет basis', { id: hex(64), status: 'open' }, false],
  ];
  for (const [name, transition, valid] of cases) {
    const response = { ...base(), previous: [transition] };
    const byWire = wire(response);
    const byZod = reviewResultSchema.safeParse(response).success;
    assert.equal(byWire, valid, `${name}: wire ${JSON.stringify(wire.errors)}`);
    assert.equal(byZod, valid, `${name}: Zod`);
  }
  assert.ok(wire({ ...base(), previous: [] }) && reviewResultSchema.safeParse(base()).success);
  // Синтаксически верный, но не выданный ID проходит обе структурные схемы и
  // отвергается семантической проверкой с путём поля.
  const response = {
    ...base(),
    previous: [{ id: hex(64), status: 'closed', basis: 'исправлено' }],
  };
  assert.ok(wire(response));
  const history: CodeReviewHistory = { scope: digestOf('s'), round: 0, findings: [] };
  const verdict = checkCodeReview(response, history, {
    runId: 'r',
    phase: 'candidate',
    sha: hex(40),
  });
  assert.equal(verdict.valid, false);
  assert.deepEqual(!verdict.valid && verdict.issues.map((i) => [i.path, i.reason]), [
    ['previous[0].id', 'unknown'],
  ]);
  // Ответ вне схемы — путь Zod в виде previous[0].id.
  const bad = checkCodeReview(
    { ...base(), previous: [{ id: 'x', status: 'closed', basis: 'abc' }] },
    history,
    {
      runId: 'r',
      phase: 'candidate',
      sha: hex(40),
    },
  );
  assert.deepEqual(!bad.valid && bad.issues.map((i) => [i.path, i.reason]), [
    ['previous[0].id', 'schema'],
  ]);
});

/** Состояние alpha.5: отклонившее ревью без ID/статуса находок и без `reviewRound`. */
async function legacyState() {
  const ctx = setup({
    scenario: {
      writer: [implement(), implement()],
      reviewer: [verdict(false, { findings: [finding('Legacy: нет проверки пустого имени')] })],
    },
    policy: (p: any) => (p.maxAttempts = 3),
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
  // Убираем всё, чего не было в alpha.5: запись как её оставила прежняя версия.
  const legacy = {
    ...a,
    evidence: a.evidence.map((e) => {
      const old: Record<string, unknown> = { ...e };
      delete old.reviewRound;
      if (e.findings)
        old.findings = e.findings.map((f) => {
          const plain: Record<string, unknown> = { ...f };
          delete plain.id;
          delete plain.status;
          return plain;
        });
      return old as typeof e;
    }),
  };
  ctx.store.transact('run.context', (tx) => tx.putAttempt(legacy));
  return ctx;
}

test('HP09: открытая находка alpha.5 получает воспроизводимый ID (в новом процессе тот же) и требует явного решения до приёмки', async () => {
  const ctx = await legacyState();
  const scope = codeReviewScope(ctx.policy.repositories[0]!.id, WORK);
  const once = ctx.engine.read((v) => codeReviewHistory(v.attempts(WORK), scope));
  assert.equal(once.findings.length, 1);
  const legacy = once.findings[0]!;
  assert.equal(legacy.status, 'open');
  assert.equal(legacy.origin.legacy, true);
  assert.deepEqual(
    ctx.engine.read((v) => codeReviewHistory(v.attempts(WORK), scope)),
    once,
  );
  // Новый процесс над тем же состоянием восстанавливает тот же ID.
  const script = `
    import { SqliteExecutionStore } from './src/storage/sqlite.ts';
    import { codeReviewHistory } from './src/contracts/index.ts';
    const s = new SqliteExecutionStore(process.argv[1], 'probe', { readOnly: true });
    console.log(JSON.stringify(s.read((v) => codeReviewHistory(v.attempts('${WORK}'), process.argv[2])).findings.map((f) => f.id)));
  `;
  const out = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      script,
      join(ctx.state, 'state.sqlite'),
      scope,
    ],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(out), [legacy.id], 'ID после рестарта тот же');

  // Молчание о находке alpha.5 — ошибка протокола, а не пустая история.
  const scenario = JSON.parse(readFileSync(ctx.scenarioPath, 'utf8'));
  scenario.reviewer = [
    verdict(false, { findings: [finding('Legacy: нет проверки пустого имени')] }),
    verdict(true, { previous: [] }),
    verdict(true, { previous: [] }),
    verdict(true, { previous: [close(0, 'Проверка пустого имени добавлена')] }),
    approve(),
  ];
  (await import('node:fs')).writeFileSync(ctx.scenarioPath, JSON.stringify(scenario));
  const before = target(ctx);
  ctx.engine.retry(WORK);
  await ctx.runner.drain();
  let all = ctx.engine.read((v) => v.attempts(WORK));
  assert.equal(all[1]!.failureKind, 'review-protocol', all[1]!.error);
  assert.match(all[1]!.error!, new RegExp('missing.*' + legacy.id));
  assert.equal(target(ctx), before);
  ctx.engine.retry(WORK);
  await ctx.runner.drain();
  all = ctx.engine.read((v) => v.attempts(WORK));
  assert.equal(all.at(-1)!.status, 'succeeded', all.at(-1)!.error);
  const after = ctx.engine.read((v) => codeReviewHistory(v.attempts(WORK), scope));
  assert.deepEqual(
    after.findings.map((f) => [f.id, f.status]),
    [[legacy.id, 'closed']],
  );
});

test('HP09: принятая попытка alpha.5 читается без переписывания; политика без поля повтора сохраняет digest alpha.5', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(a.status, 'succeeded');
  const legacy = {
    ...a,
    evidence: a.evidence.map((e) => {
      const old: Record<string, unknown> = { ...e };
      delete old.reviewRound;
      return old as typeof e;
    }),
  };
  ctx.store.transact('run.context', (tx) => tx.putAttempt(legacy));
  const stored = ctx.engine.read((v) => v.attempts(WORK)[0]!);
  assert.ok(
    stored.evidence.every((e) => e.reviewRound === undefined),
    'запись не дополнена',
  );
  const result = runResultSchema.parse(runResult(stored, 'test'));
  assert.equal(result.outcome, 'accepted', 'исход не меняется задним числом');
  assert.ok(result.evidence.every((e) => e.review === undefined));
  assert.deepEqual(result.findings, []);
  // Новые попытки поручения такой записи не переоткрывают: одобрение без находок.
  const scope = codeReviewScope(ctx.policy.repositories[0]!.id, WORK);
  assert.deepEqual(ctx.engine.read((v) => codeReviewHistory(v.attempts(WORK), scope)).findings, []);

  // Digest примера политики alpha.5 (baseline c1bb638, вычислен кодом alpha.5).
  const raw = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../examples/single-task/policy.json', import.meta.url)),
      'utf8',
    ),
  );
  const parsed = executionPolicySchema.parse(raw);
  assert.equal('reviewProtocolRetries' in parsed, false, 'умолчание не подставляется');
  assert.equal(
    executionDigest(parsed),
    '283ae58f297b00c742c2ad627c4ade43748a2e64961bf1148465aa7ca18e8aa2',
  );
  assert.equal(
    policyDigest(parsed),
    'fe2c6fe7a4c099a27c1b32d2f2fd295a887abcb83ea6f8c41dd408b561e00279',
  );
  // Явное поле — новая политика: допустимы 0–2.
  for (const n of [0, 1, 2])
    assert.notEqual(
      executionDigest(executionPolicySchema.parse({ ...raw, reviewProtocolRetries: n })),
      executionDigest(parsed),
    );
  for (const n of [-1, 3, 1.5])
    assert.equal(
      executionPolicySchema.safeParse({ ...raw, reviewProtocolRetries: n }).success,
      false,
    );
});

test('HP03: plan/contract — невалидный ответ не применяет переходов; повторно найденная закрытая находка открывается', async () => {
  const outputs: unknown[] = [];
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: () =>
      Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'controlled',
        output: outputs.shift(),
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
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-review-protocol-'));
  const h = Harness.open({ policy, stateDir, baseDir: process.cwd(), adapters });
  const { technicalReview } = await import('../src/control/review.ts');
  for (const kind of ['plan', 'contract'] as const) {
    const subject = kind === 'plan' ? 'g' : 'api';
    const a = { severity: 'blocking' as const, message: `${kind}: нет критерия A` };
    const b = { severity: 'blocking' as const, message: `${kind}: нет критерия B` };
    const idA = findingId(subject, a);
    const idB = findingId(subject, b);
    const round = (c: string) =>
      technicalReview(h.engine, policy, adapters, {
        kind,
        subject,
        digest: c.repeat(64),
        author: 'claude',
        instructions: ['Review.'],
        cwd: process.cwd(),
        artifactDir: join(stateDir, kind + c),
        denied: [stateDir],
        meta: { subjectId: subject, subjectKind: 'other' },
      });
    const resp = (approved: boolean, findings: unknown[], previous: unknown[]) => ({
      approved,
      summary: 'r',
      findings,
      previous,
    });
    outputs.push(resp(false, [a, b], []));
    const r1 = await round('a');
    assert.deepEqual(
      r1.findings.map((f) => f.status),
      ['open', 'open'],
    );
    // Валидно закрывает A, но называет неизвестный ID вместо B — целиком невалиден.
    outputs.push(
      resp(
        true,
        [],
        [
          { id: idA, status: 'closed', basis: 'добавлен A' },
          { id: digestOf('чужая'), status: 'closed', basis: 'xxx' },
        ],
      ),
    );
    const r2 = await round('b');
    assert.equal(r2.approved, false, kind);
    assert.deepEqual(
      r2.findings.map((f) => [f.id, f.status]),
      [
        [idA, 'open'],
        [idB, 'open'],
      ],
      kind + ': ни одна находка не закрыта невалидным ответом',
    );
    outputs.push(
      resp(
        true,
        [],
        [
          { id: idA, status: 'closed', basis: 'добавлен A' },
          { id: idB, status: 'withdrawn', basis: 'B не относится к предмету' },
        ],
      ),
    );
    const r3 = await round('c');
    assert.equal(r3.approved, true, r3.summary);
    // Тот же дефект найден снова: закрытая находка открывается, а не теряется.
    outputs.push(resp(false, [a], []));
    const r4 = await round('d');
    assert.equal(r4.findings.find((f) => f.id === idA)?.status, 'open', kind + ': reopen');
    assert.equal(r4.findings.find((f) => f.id === idA)?.changedIn, r4.round);
  }
  h.close();
});

/** Адаптер хоста без протокола переходов: те же ответы fixture, capabilities без `reviewProtocol`. */
const legacyAdapter = (inner: RuntimeAdapter): RuntimeAdapter => ({
  runtime: inner.runtime,
  capabilities: async () => {
    const c = await inner.capabilities();
    const plain: Record<string, unknown> = { ...c };
    delete plain.reviewProtocol;
    return plain as unknown as Awaited<ReturnType<RuntimeAdapter['capabilities']>>;
  },
  invoke: (request, signal) => inner.invoke(request, signal),
});

test('C02/HP09: адаптер хоста без протокола переходов — отказ → одобрение без previous принимается как в alpha.5; закрытия не выдумываются; H2 сохраняется', async () => {
  const { hsetup } = await import('./harness-fixture.ts');
  const reject = verdict(false, { findings: [finding('Нет обработки пустого имени')] });
  const ctx = hsetup({
    scenario: {
      writer: [implement(), implement()],
      reviewer: [
        verdict(true), // ревью плана
        reject,
        // Ответ вне схемы — ошибка протокола и повтор reviewer, как у строгого адаптера.
        { raw: '{"approved": tru' },
        { ...verdict(true), recordPrompt: true },
        verdict(true),
      ],
    },
    policy: (p: any) => (p.maxAttempts = 2),
  });
  const before = target(ctx);
  const h = ctx.open(ctx.policy, legacyAdapter);
  await h.run({ graph: ctx.graph, author: 'claude' });
  const all = h.engine.read((v) => v.attempts(WORK));
  assert.equal(all.length, 2);
  assert.equal(all[0]!.failureKind, 'review', 'содержательный отказ — как прежде');
  assert.equal(all[1]!.status, 'succeeded', all[1]!.error);
  assert.notEqual(target(ctx), before);
  assert.equal(ctx.calls('claude', 'writer'), 2);
  const cand = all[1]!.evidence.filter((e) => e.kind === 'review' && e.phase === 'candidate');
  assert.deepEqual(
    cand.map((e) => [e.reviewRound?.call, e.reviewRound?.protocol, e.reviewRound?.mode]),
    [
      [1, 'invalid', 'legacy'],
      [2, 'valid', 'legacy'],
    ],
  );
  // Reviewer прежнего адаптера не получает раздела выданных ID; закрытие не выдумано.
  const prompt = readFileSync(`${ctx.scenarioPath}.reviewer.3.prompt`, 'utf8');
  assert.doesNotMatch(prompt, /Open review findings issued by the controller/);
  const scope = codeReviewScope(ctx.policy.repositories[0]!.id, WORK);
  const history = h.engine.read((v) => codeReviewHistory(v.attempts(WORK), scope));
  assert.deepEqual(
    history.findings.map((f) => [f.severity, f.status, f.transitions.length]),
    [['blocking', 'open', 0]],
  );
  h.close();

  // approved с blocking и ссылка на прежний ID — отказ, как в alpha.5 (здесь — протокольный).
  for (const response of [
    verdict(true, { findings: [finding('Новый дефект')] }),
    verdict(true, { previous: [{ id: digestOf('x'), status: 'closed', basis: 'исправлено' }] }),
  ]) {
    const neg = hsetup({
      scenario: { writer: implement(), reviewer: [verdict(true), response] },
      policy: (p: any) => (p.maxAttempts = 1),
    });
    const keep = target(neg);
    const hn = neg.open(neg.policy, legacyAdapter);
    await hn.run({ graph: neg.graph, author: 'claude' });
    const a = hn.engine.read((v) => v.attempts(WORK)[0]!);
    assert.notEqual(a.status, 'succeeded');
    assert.equal(target(neg), keep);
    hn.close();
  }
});

test('C02: cliAdapter объявляет протокол переходов; capabilities без поля — прежний адаптер', async () => {
  const { cliAdapter } = await import('../src/agents/cli-adapter.ts');
  const { bin } = await import('./runner-fixture.ts');
  const c = await cliAdapter('codex', { executable: bin('fake-codex') }).capabilities();
  assert.equal(c.reviewProtocol, 1);
});

test('C02: адаптер без модели закрывает находки по структурированному RuntimeRequest.findings, не разбирая запрос', async () => {
  const { hsetup } = await import('./harness-fixture.ts');
  const fixed = "exports.greet = (name) => 'Hello, ' + (name || 'stranger') + '!';\n";
  const ctx = hsetup({
    scenario: {
      writer: [implement(), implement({ 'src/greet.js': fixed })],
      reviewer: verdict(true),
    },
    policy: (p: any) => (p.maxAttempts = 2),
  });
  const seen: unknown[] = [];
  let reviews = 0;
  const h = ctx.open(ctx.policy, (inner) => ({
    runtime: inner.runtime,
    capabilities: () => inner.capabilities(),
    invoke: async (request, signal) => {
      const response = await inner.invoke(request, signal);
      if (request.task !== 'review-code' || response.status !== 'ok') return response;
      seen.push(request.findings);
      const open = request.findings?.open ?? [];
      const first = reviews++ === 0;
      return {
        ...response,
        output: first
          ? verdict(false, { findings: [finding('Нет имени по умолчанию')] }).result
          : verdict(true, {
              previous: open.map((f) => ({
                id: f.id,
                status: 'closed',
                basis: 'Имя по умолчанию добавлено',
              })),
            }).result,
      };
    },
  }));
  await h.run({ graph: ctx.graph, author: 'claude' });
  const all = h.engine.read((v) => v.attempts(WORK));
  assert.equal(all.at(-1)!.status, 'succeeded', all.at(-1)!.error);
  assert.equal(all.length, 2);
  const [first, second, integration] = seen as ReviewRequestFindings[];
  assert.deepEqual(first!.open, []);
  assert.equal(second!.open.length, 1);
  assert.match(second!.open[0]!.id, /^[0-9a-f]{64}$/);
  assert.equal(second!.open[0]!.severity, 'blocking');
  assert.deepEqual(integration!.open, []);
  assert.deepEqual(
    integration!.closed.map((f) => [f.id, f.status]),
    [[second!.open[0]!.id, 'closed']],
  );
  h.close();
});

test('HP06/R2-F01: logicalReview — начатые вызовы по учёту, рестарт продолжает счёт, срок и попытки; завершение закрывает', async () => {
  const { logicalReview } = await import('../src/contracts/review.ts');
  const scope = digestOf('s');
  const c = 'c'.repeat(40);
  type Attempt = Parameters<typeof logicalReview>[0][number];
  const a = (id: string, status: string, failureKind?: string, evidence: unknown[] = []): Attempt =>
    ({ id, status, failureKind, candidateSha: c, evidence }) as Attempt;
  const invalid = {
    kind: 'review',
    phase: 'candidate',
    sha: c,
    reviewRound: { scope, protocol: 'invalid' },
  };
  const valid = { ...invalid, reviewRound: { scope, protocol: 'valid' } };
  const started: Record<string, { count: number; firstStartMs?: number; spentMs: number }> = {
    A: { count: 2, firstStartMs: 1000, spentMs: 50 },
    B: { count: 1, firstStartMs: 5000, spentMs: 10 },
  };
  const of = (id: string) => started[id] ?? { count: 0, spentMs: 0 };
  // A: вызов 1 невалиден, вызов 2 прерван рестартом (истёк); B продолжает.
  const r = logicalReview(
    [a('A', 'expired', undefined, [invalid]), a('B', 'active')],
    scope,
    'candidate',
    c,
    of,
  );
  assert.deepEqual(r, { used: 3, spentMs: 60, runs: ['A', 'B'], firstStartMs: 1000 });
  // Записи без учёта вызовов (прежняя версия) — по невалидным evidence.
  assert.equal(
    logicalReview([a('X', 'active', undefined, [invalid, invalid])], scope, 'candidate', c, of)
      .used,
    2,
  );
  // Валидный вердикт и остановка review-protocol закрывают логическое ревью.
  assert.equal(
    logicalReview(
      [a('A', 'failed', 'review', [valid]), a('B', 'active')],
      scope,
      'candidate',
      c,
      of,
    ).used,
    1,
  );
  assert.equal(
    logicalReview(
      [a('A', 'failed', 'review-protocol', [invalid]), a('B', 'active')],
      scope,
      'candidate',
      c,
      of,
    ).used,
    1,
  );
  // Другой SHA — другое логическое ревью.
  assert.equal(logicalReview([a('A', 'expired')], scope, 'candidate', 'd'.repeat(40), of).used, 0);
});
