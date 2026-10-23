/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return --
 * Тесты правят сырой JSON политики до разбора схемой и читают review.json как есть.
 */
/**
 * Жизненный цикл находок ревью кода и ошибки протокола через обычный движок
 * (docs/review-protocol.md). Writer и reviewer — fixture executables CLI
 * (`tests/fixtures/bin`), настоящие Git, gate и JUnit. ID находок reviewer
 * берёт только из своего запроса (`$open:N`), тест их не вычисляет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  codeFindingId,
  codeReviewHistory,
  codeReviewScope,
  digestOf,
  runResultSchema,
  type AttemptState,
} from '../src/contracts/index.ts';
import { runResult } from '../src/engine/result.ts';
import { hsetup } from './harness-fixture.ts';
import { greet, implement, runAll, setup, target } from './runner-fixture.ts';
import { close, finding, fixtureCalls, recordedPrompt, verdict } from './review-fixture.ts';

const WORK = 'add-greeting';
const fixedGreet =
  "exports.greet = (name) => {\n  if (!name) throw new Error('empty name');\n  return 'Hello, ' + name + '!';\n};\n";
const defect = finding('Нет обработки пустого имени: greet("") возвращает "Hello, !"');

/** Evidence фиксируется в .private/pilot-fixes/evidence/<ID>/, если задан каталог. */
function dump(id: string, name: string, data: unknown) {
  const dir = process.env.HP_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, name + '.json'), JSON.stringify(data, null, 2));
}

type Ctx = ReturnType<typeof setup>;
const attempts = (ctx: Ctx) => ctx.engine.read((v) => v.attempts(WORK));
const history = (ctx: Ctx) =>
  ctx.engine.read((v) =>
    codeReviewHistory(v.attempts(WORK), codeReviewScope(ctx.policy.repositories[0]!.id, WORK)),
  );
const work = (ctx: Ctx) => ctx.engine.read((v) => v.work(WORK)!);
const writerCalls = (ctx: Ctx) => fixtureCalls(ctx.scenarioPath, 'claude', 'writer');
const reviewerCalls = (ctx: Ctx) => fixtureCalls(ctx.scenarioPath, 'codex', 'reviewer');
const retries = (n: number | undefined) => (p: any) => {
  p.maxAttempts = 2;
  if (n !== undefined) p.reviewProtocolRetries = n;
};

test('HP01: отклонение → исправление → закрытие того же ID → integration → accepted; ровно 2 writer-вызова', async () => {
  const ctx = hsetup({
    scenario: {
      writer: [implement(), implement({ 'src/greet.js': fixedGreet })],
      reviewer: [
        // Ревью плана (обычный путь Harness.run, считается отдельно).
        verdict(true),
        // Кандидат 1: содержательный отказ с blocking-находкой.
        { ...verdict(false, { findings: [defect] }), recordPrompt: true },
        // Кандидат 2: выданный ID закрыт с основанием.
        { ...verdict(true, { previous: [close(0)] }), recordPrompt: true },
        // Integration: открытых нет, закрытая — история.
        { ...verdict(true), recordPrompt: true },
      ],
    },
    policy: retries(undefined),
  });
  const before = target(ctx);
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  const all = h.engine.read((v) => v.attempts(WORK));
  const last = all.at(-1)!;
  assert.equal(last.status, 'succeeded', last.error);
  assert.equal(all.length, 2, 'две попытки writer, третьей нет');
  assert.equal(ctx.calls('claude', 'writer'), 2, 'ровно 2 writer-вызова');
  assert.equal(ctx.calls('codex', 'reviewer') - 1, 3, '3 вызова ревью кода (+1 ревью плана)');
  // Один стабильный ID и полный ряд open → closed.
  const h1 = h.engine.read((v) =>
    codeReviewHistory(v.attempts(WORK), codeReviewScope(ctx.policy.repositories[0]!.id, WORK)),
  );
  assert.equal(h1.findings.length, 1);
  const f = h1.findings[0]!;
  assert.equal(f.status, 'closed');
  assert.deepEqual(
    f.transitions.map((t) => [t.from, t.to, t.phase, t.runId]),
    [['open', 'closed', 'candidate', last.id]],
  );
  assert.equal(f.origin.runId, all[0]!.id);
  // Reviewer второго кандидата получил именно этот ID в запросе.
  assert.ok(recordedPrompt(ctx.scenarioPath, 'reviewer', 2).includes(f.id));
  assert.ok(
    !recordedPrompt(ctx.scenarioPath, 'reviewer', 1).includes(f.id),
    'ID выдан после отказа',
  );
  // Integration видит закрытую находку как историю, а не как открытую.
  assert.match(
    recordedPrompt(ctx.scenarioPath, 'reviewer', 3),
    /Closed or withdrawn review findings/,
  );
  // Своё валидное evidence ревью у каждой фазы второй попытки.
  for (const phase of ['candidate', 'integration'] as const) {
    const e = last.evidence.filter((x) => x.kind === 'review' && x.phase === phase);
    assert.equal(e.length, 1, phase);
    assert.equal(e[0]!.passed, true);
    assert.equal(e[0]!.reviewRound?.protocol, 'valid');
  }
  assert.deepEqual(
    last.evidence.find((x) => x.phase === 'candidate' && x.kind === 'review')!.reviewRound!
      .expected,
    [f.id],
  );
  // Target содержит исправленный diff.
  const sha = target(ctx);
  assert.notEqual(sha, before);
  assert.equal(ctx.repo.git('show', `${sha}:src/greet.js`), fixedGreet.trimEnd());
  const result = h.result(WORK);
  assert.equal(result.result.outcome, 'accepted');
  dump('HP01', 'result', result);
  dump('HP01', 'history', h1);
  dump(
    'HP01',
    'attempts',
    all.map((a) => ({ ...a, token: '[fencing token omitted]' })),
  );
  h.close();
});

test('HP10: отказ кандидата 1 → writer исправил → неверный ID → повтор reviewer закрыл выданный ID → integration → accepted: 2 writer, 4 вызова ревью кода', async () => {
  const wrong = {
    id: digestOf('не выданный controller ID'),
    status: 'closed',
    basis: 'исправлено',
  };
  const ctx = hsetup({
    scenario: {
      writer: [implement(), implement({ 'src/greet.js': fixedGreet })],
      reviewer: [
        verdict(true), // ревью плана
        verdict(false, { findings: [defect] }),
        verdict(true, { previous: [wrong] }),
        { ...verdict(true, { previous: [close(0)] }), recordPrompt: true },
        verdict(true),
      ],
    },
    policy: retries(undefined),
  });
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  const all = h.engine.read((v) => v.attempts(WORK));
  assert.equal(all.at(-1)!.status, 'succeeded', all.at(-1)!.error);
  assert.equal(ctx.calls('claude', 'writer'), 2);
  assert.equal(ctx.calls('codex', 'reviewer') - 1, 4, '1 + 2 + 1 вызова ревью кода');
  const second = all[1]!;
  const cand = second.evidence.filter((e) => e.kind === 'review' && e.phase === 'candidate');
  assert.deepEqual(
    cand.map((e) => [e.reviewRound?.call, e.reviewRound?.protocol, e.passed]),
    [
      [1, 'invalid', false],
      [2, 'valid', true],
    ],
  );
  assert.ok(
    cand[0]!.reviewRound!.issues!.some(
      (i) => i.path === 'previous[0].id' && i.reason === 'unknown',
    ),
  );
  assert.notEqual(cand[0]!.log, cand[1]!.log, 'вызовы — разные артефакты');
  assert.match(
    recordedPrompt(ctx.scenarioPath, 'reviewer', 3),
    /Protocol error: .*previous\[0\]\.id/s,
  );
  // Ошибка протокола и закрытое замечание видны отдельно в результате.
  const result = h.result(WORK).result;
  assert.equal(result.outcome, 'accepted');
  const refs = result.evidence.filter((e) => e.kind === 'review');
  // Принятый результат несёт решающие записи; ошибка протокола видна
  // причинами у валидного вердикта повтора (вызов 2), закрытие — переходом.
  assert.equal(refs.length, 2, 'по одной решающей записи ревью на фазу');
  const decisive = refs.find((e) => e.phase === 'candidate')!;
  assert.equal(decisive.review?.call, 2);
  assert.equal(decisive.review?.protocol, 'valid');
  assert.ok(
    decisive.review?.issues?.some((i) => i.path === 'previous[0].id' && i.reason === 'unknown'),
  );
  assert.deepEqual(
    decisive.review?.transitions?.map((t) => [t.from, t.to]),
    [['open', 'closed']],
  );
  assert.ok(
    second.evidence.some((e) => e.reviewRound?.protocol === 'invalid'),
    'невалидный вызов остаётся в evidence попытки',
  );
  dump('HP10', 'result', result);
  h.close();

  // Негативный вариант: оба ответа второго кандидата неверны — остановка с
  // протокольным кодом, без третьего writer и без продвижения target.
  const neg = hsetup({
    scenario: {
      writer: [implement(), implement({ 'src/greet.js': fixedGreet })],
      reviewer: [
        verdict(true),
        verdict(false, { findings: [defect] }),
        verdict(true, { previous: [wrong] }),
        verdict(true, { previous: [wrong] }),
        verdict(true),
      ],
    },
    policy: retries(undefined),
  });
  const before = target(neg);
  const h2 = neg.open();
  await h2.run({ graph: neg.graph, author: 'claude' });
  const w = h2.engine.read((v) => v.work(WORK)!);
  assert.equal(w.status, 'failed');
  assert.equal(w.failureKind, 'review-protocol');
  assert.equal(neg.calls('claude', 'writer'), 2, 'третьего writer нет');
  assert.equal(neg.calls('codex', 'reviewer') - 1, 3);
  assert.equal(target(neg), before, 'target не двигается');
  const r = h2.result(WORK).result;
  assert.equal(r.outcome === 'accepted' ? '' : r.stopReason.code, 'REVIEW_PROTOCOL_INVALID');
  dump('HP10', 'negative-result', r);
  h2.close();
});

/** Попытка 1 — содержательный отказ с blocking-находкой; попытка 2 — проверяемый ответ. */
async function secondCandidate(
  candidate2: unknown[],
  options: {
    retries?: number;
    first?: unknown;
    integration?: unknown;
    writer2?: Record<string, string>;
  } = {},
) {
  const ctx = setup({
    scenario: {
      writer: [implement(), implement(options.writer2 ?? { 'src/greet.js': fixedGreet })],
      reviewer: [
        options.first ?? verdict(false, { findings: [defect] }),
        ...candidate2,
        options.integration ?? verdict(true, { previous: [] }),
      ],
    },
    policy: retries(options.retries),
  });
  await runAll(ctx);
  assert.equal(work(ctx).failureKind, 'review', 'попытка 1 — содержательный отказ');
  const opened = history(ctx);
  ctx.engine.retry(WORK);
  const before = target(ctx);
  await ctx.runner.drain();
  return { ctx, opened, before };
}

test('HP02: неверные переходы не обходят ревью — точный путь/причина, ничего не закрыто, target неизменен', async () => {
  const foreign = codeFindingId(
    codeReviewScope('app', 'other-work'),
    { runId: 'r', phase: 'candidate', sha: 'a'.repeat(40), round: 1 },
    0,
    defect,
  );
  const unknown = digestOf('неизвестная находка');
  const cases: [string, unknown, string, string][] = [
    ['previous пуст', verdict(true, { previous: [] }), 'previous', 'missing'],
    [
      'previous отсутствует',
      { result: { ...verdict(true).result, previous: undefined } },
      'previous',
      'missing',
    ],
    [
      'неизвестный SHA-256',
      verdict(true, { previous: [{ id: unknown, status: 'closed', basis: 'исправлено' }] }),
      'previous[0].id',
      'unknown',
    ],
    [
      'ID другого поручения',
      verdict(true, { previous: [{ id: foreign, status: 'closed', basis: 'исправлено' }] }),
      'previous[0].id',
      'unknown',
    ],
    [
      'повторный ID с противоречием',
      verdict(true, { previous: [close(0), { ...close(0), status: 'open' }] }),
      'previous[1].id',
      'duplicate',
    ],
    [
      'произвольная строка',
      verdict(true, { previous: [{ id: 'F-1', status: 'closed', basis: 'исправлено' }] }),
      'previous[0].id',
      'schema',
    ],
    [
      'пустое основание',
      verdict(true, { previous: [{ ...close(0), basis: '   ' }] }),
      'previous[0].basis',
      'schema',
    ],
    [
      'недопустимый статус',
      verdict(true, { previous: [{ ...close(0), status: 'fixed' }] }),
      'previous[0].status',
      'schema',
    ],
    [
      'approved при открытой blocking',
      verdict(true, { previous: [{ ...close(0), status: 'open' }] }),
      'approved',
      'approved-with-blocking',
    ],
    [
      'approved с новой blocking',
      verdict(true, { previous: [close(0)], findings: [finding('Новый дефект')] }),
      'approved',
      'approved-with-blocking',
    ],
  ];
  const observed: unknown[] = [];
  for (const [name, response, path, reason] of cases) {
    const { ctx, opened, before } = await secondCandidate([response], { retries: 0 });
    const a = attempts(ctx)[1]!;
    assert.equal(a.status, 'failed', name);
    assert.equal(a.failureKind, 'review-protocol', name);
    const e = a.evidence.filter((x) => x.kind === 'review');
    assert.equal(e.length, 1, name + ': повтор отключён — один вызов');
    assert.equal(e[0]!.passed, false, name);
    const issue = e[0]!.reviewRound!.issues!.find((i) => i.reason === reason);
    assert.ok(issue, `${name}: причина ${reason}: ${JSON.stringify(e[0]!.reviewRound!.issues)}`);
    assert.equal(issue.path, path, name);
    assert.match(a.error!, new RegExp('REVIEW_PROTOCOL_INVALID.*' + reason), name);
    assert.deepEqual(
      history(ctx).findings.map((f) => [f.id, f.status]),
      opened.findings.map((f) => [f.id, f.status]),
      name + ': ни одна находка не закрыта и не заведена',
    );
    assert.equal(opened.findings[0]!.status, 'open');
    assert.equal(target(ctx), before, name + ': target неизменен');
    assert.equal(writerCalls(ctx), 2, name + ': writer не вызывается ради JSON');
    observed.push({ name, issues: e[0]!.reviewRound!.issues, error: a.error });
  }
  dump('HP02', 'matrix', observed);

  // Каждый разрешённый повтор возвращает тот же дефект: поздний валидный ответ
  // не маскирует отказ, вызовов ровно 1 + повторы.
  const same = verdict(true, { previous: [] });
  for (const n of [1, 2]) {
    const { ctx, before } = await secondCandidate(Array(n + 1).fill(same), { retries: n });
    const a = attempts(ctx)[1]!;
    assert.equal(a.failureKind, 'review-protocol');
    assert.equal(reviewerCalls(ctx), 1 + n + 1);
    assert.equal(target(ctx), before);
  }
});

test('HP02: контроли — closed/withdrawn с основанием принимаются; open note с явным переходом допускает approved', async () => {
  for (const status of ['closed', 'withdrawn'] as const) {
    const { ctx, before } = await secondCandidate(
      [
        verdict(true, {
          previous: [{ ...close(0), status, basis: 'Основание: проверено на SHA' }],
        }),
      ],
      { retries: 0 },
    );
    const a = attempts(ctx)[1]!;
    assert.equal(a.status, 'succeeded', status + ': ' + a.error);
    assert.notEqual(target(ctx), before);
    assert.equal(history(ctx).findings[0]!.status, status);
  }
  const note = finding('Имя переменной можно уточнить', 'note');
  const { ctx } = await secondCandidate(
    [
      verdict(true, {
        previous: [
          close(0),
          { id: '$open:1', status: 'open', basis: 'Заметка остаётся, не блокирует' },
        ],
      }),
    ],
    {
      retries: 0,
      first: verdict(false, { findings: [defect, note] }),
      // Integration называет оставшуюся открытой заметку явно.
      integration: verdict(true, {
        previous: [{ id: '$open:0', status: 'open', basis: 'Заметка остаётся' }],
      }),
    },
  );
  const a = attempts(ctx)[1]!;
  assert.equal(a.status, 'succeeded', a.error);
  const f = history(ctx).findings;
  assert.deepEqual(
    f.map((x) => [x.severity, x.status]),
    [
      ['blocking', 'closed'],
      ['note', 'open'],
    ],
  );
});

test('HP03: закрытие на candidate не одобряет integration — повторно найденный дефект блокирует (новая находка и явный reopen)', async () => {
  for (const variant of ['new', 'reopen'] as const) {
    const integration =
      variant === 'new'
        ? verdict(false, { findings: [defect] }) // тот же текст — новый ID, без dedup
        : verdict(false, {
            previous: [
              {
                id: '$closed:0',
                status: 'open',
                basis: 'В интеграционном дереве дефект снова есть',
              },
            ],
          });
    const { ctx, before } = await secondCandidate([verdict(true, { previous: [close(0)] })], {
      integration,
    });
    const a = attempts(ctx)[1]!;
    assert.equal(a.status, 'failed', variant);
    assert.equal(a.failureKind, 'review', variant);
    assert.equal(target(ctx), before, variant + ': target неизменен');
    const f = history(ctx).findings;
    if (variant === 'new') {
      assert.equal(f.length, 2);
      assert.deepEqual(
        f.map((x) => x.status),
        ['closed', 'open'],
      );
      assert.notEqual(f[0]!.id, f[1]!.id, 'тот же текст — новый ID, не потерян');
      assert.equal(f[1]!.origin.phase, 'integration');
    } else {
      assert.equal(f.length, 1);
      assert.deepEqual(
        f[0]!.transitions.map((t) => [t.from, t.to, t.phase]),
        [
          ['open', 'closed', 'candidate'],
          ['closed', 'open', 'integration'],
        ],
      );
    }
    dump('HP03', 'integration-' + variant, f);
  }
});

test('HP03: частично валидный ответ (одна находка закрыта верно, другая — нарушение) не закрывает ни одной', async () => {
  const other = finding('Нет теста на пустое имя');
  const { ctx, opened, before } = await secondCandidate(
    [
      verdict(false, {
        previous: [close(0), { id: digestOf('чужая'), status: 'closed', basis: 'исправлено' }],
      }),
    ],
    { retries: 0, first: verdict(false, { findings: [defect, other] }) },
  );
  const a = attempts(ctx)[1]!;
  assert.equal(a.failureKind, 'review-protocol');
  assert.equal(opened.findings.length, 2);
  assert.deepEqual(
    history(ctx).findings.map((f) => [f.id, f.status]),
    opened.findings.map((f) => [f.id, 'open']),
    'валидная часть ответа не применена',
  );
  assert.equal(target(ctx), before);
});

test('HP03: попытка, утратившая владение, не сохраняет переходы (fencing)', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: verdict(false, { findings: [defect] }) },
    policy: retries(undefined),
  });
  await runAll(ctx);
  const opened = history(ctx);
  const first = attempts(ctx)[0]!;
  const id = opened.findings[0]!.id;
  const evidence = {
    kind: 'review' as const,
    phase: 'candidate' as const,
    sha: first.candidateSha!,
    gate: 'independent-review',
    passed: true,
    command: ['codex', 'review-code'],
    exitCode: 0,
    log: '/dev/null',
    digest: digestOf('x'),
    summary: 'stale',
    findings: [],
    reviewRound: {
      version: 1 as const,
      scope: opened.scope,
      round: 2,
      call: 1,
      calls: 2,
      protocol: 'valid' as const,
      expected: [id],
      transitions: [{ id, from: 'open' as const, to: 'closed' as const, basis: 'исправлено' }],
    },
  };
  // Завершённая попытка со своим (бывшим) токеном и попытка с чужим токеном.
  assert.throws(() => ctx.engine.evidence(first.id, first.token, evidence));
  ctx.engine.retry(WORK);
  const claimed = ctx.engine.claim('runner-1')!;
  assert.throws(
    () => ctx.engine.evidence(claimed.id, 'x'.repeat(32), evidence),
    /LEASE|владени|token/i,
  );
  assert.equal(history(ctx).findings[0]!.status, 'open', 'переход не сохранён');
});

test('HP03: смена постановки переносит открытую находку; молчание нового ревью — ошибка протокола; одобрение прежней редакции не принимает новую', async () => {
  const ctx = setup({
    scenario: {
      writer: [implement(), implement({ 'src/greet.js': fixedGreet })],
      reviewer: [
        verdict(false, { findings: [defect] }),
        verdict(true, { previous: [] }),
        verdict(true, {
          previous: [{ id: '$open:0', status: 'withdrawn', basis: 'Требование снято редакцией 2' }],
        }),
        verdict(true),
      ],
    },
    policy: (p: any) => {
      retries(0)(p);
      p.maxAttempts = 3;
    },
  });
  await runAll(ctx);
  const opened = history(ctx);
  const spec1 = work(ctx).approvedDigest;
  // Редакция 2: изменённые критерии, новое согласование.
  const g = structuredClone(ctx.graph) as any;
  g.source.revision = '2';
  g.orders[0].source.revision = '2';
  g.orders[0].acceptance = [...g.orders[0].acceptance, 'Пустое имя не проверяется (снято)'];
  ctx.graph = g;
  await runAll(ctx);
  const spec2 = work(ctx).approvedDigest;
  assert.notEqual(spec2, spec1, 'новая редакция согласована');
  // Новая редакция — новая попытка (регистрация могла уже выдать её).
  if (attempts(ctx).length === 1) {
    ctx.engine.retry(WORK);
    await ctx.runner.drain();
  }
  const all = attempts(ctx);
  const silent = all.find((a) => a.failureKind === 'review-protocol');
  assert.ok(
    silent,
    'перенесённая находка без состояния — ошибка протокола: ' + all.map((a) => a.error).join(' | '),
  );
  assert.equal(
    history(ctx).findings[0]!.id,
    opened.findings[0]!.id,
    'ID не меняется от новой редакции',
  );
  assert.equal(history(ctx).findings[0]!.status, 'open');
  // Прежнее одобрение не принимает новую редакцию: приёмка — только новой попыткой.
  assert.ok(!all.some((a) => a.status === 'succeeded'));
  ctx.engine.retry(WORK);
  await ctx.runner.drain();
  const last = attempts(ctx).at(-1)!;
  assert.equal(last.status, 'succeeded', last.error);
  const f = history(ctx).findings[0]!;
  assert.equal(f.status, 'withdrawn');
  assert.equal(f.transitions[0]!.runId, last.id);
});

test('HP05: на candidate и на integration повторяется reviewer, а не writer; тот же SHA, diff, контекст и открытые находки', async () => {
  for (const phase of ['candidate', 'integration'] as const) {
    const malformed = { raw: '{"approved": tru', recordPrompt: true };
    const reviewer =
      phase === 'candidate'
        ? [malformed, { ...verdict(true), recordPrompt: true }, verdict(true)]
        : [verdict(true), malformed, { ...verdict(true), recordPrompt: true }];
    const ctx = setup({ scenario: { writer: implement(), reviewer }, policy: retries(undefined) });
    await runAll(ctx);
    const all = attempts(ctx);
    assert.equal(all.length, 1, phase + ': номер попытки не растёт');
    assert.equal(all[0]!.status, 'succeeded', all[0]!.error);
    assert.equal(writerCalls(ctx), 1, phase + ': writer один');
    const e = all[0]!.evidence.filter((x) => x.kind === 'review' && x.phase === phase);
    assert.deepEqual(
      e.map((x) => [x.reviewRound?.call, x.reviewRound?.protocol, x.passed]),
      [
        [1, 'invalid', false],
        [2, 'valid', true],
      ],
    );
    assert.equal(e[0]!.sha, e[1]!.sha);
    assert.deepEqual(e[0]!.reviewRound!.expected, e[1]!.reviewRound!.expected);
    assert.equal(e[0]!.reviewRound!.issues![0]!.reason, 'schema');
    // Различимые неизменяемые артефакты; digest — байты своего вызова.
    assert.notEqual(e[0]!.log, e[1]!.log);
    const { sha256 } = await import('../src/contracts/index.ts');
    for (const x of e)
      assert.equal(sha256(JSON.stringify(JSON.parse(readFileSync(x.log, 'utf8')))), x.digest);
    // Запрос повтора — тот же запрос плюс только диагностика протокола.
    const i0 = phase === 'candidate' ? 0 : 1;
    const p1 = recordedPrompt(ctx.scenarioPath, 'reviewer', i0);
    const p2 = recordedPrompt(ctx.scenarioPath, 'reviewer', i0 + 1);
    const cut = (p: string) => p.split('---ARGS---')[0]!.replace(/\n\nProtocol error:[^\n]*/, '');
    assert.equal(cut(p2), cut(p1), phase + ': SHA, diff, контекст и находки те же');
    assert.match(p2, /Protocol error: .*call 2 of 2/);
    // Gates не подменены: PASS только штатных gates.
    assert.ok(all[0]!.evidence.some((x) => x.kind === 'test' && x.phase === phase && x.passed));
  }
});

test('HP05: валидный отказ во втором ответе — обычный путь исправления writer, не ещё один протокольный повтор', async () => {
  const ctx = setup({
    scenario: {
      writer: [implement(), implement({ 'src/greet.js': fixedGreet })],
      reviewer: [{ raw: 'not json' }, verdict(false, { findings: [defect] })],
    },
    policy: retries(2),
  });
  await runAll(ctx);
  const a = attempts(ctx)[0]!;
  assert.equal(a.failureKind, 'review', 'содержательный отказ');
  assert.equal(reviewerCalls(ctx), 2, 'третьего протокольного вызова нет');
  assert.equal(history(ctx).findings[0]!.status, 'open');
});

test('HP06: повторы конечны — настройка 0/1/2 и по умолчанию; после исчерпания нет writer и accepted', async () => {
  for (const n of [0, 1, 2, undefined]) {
    const ctx = setup({
      scenario: { writer: implement(), reviewer: { raw: '{broken' } },
      policy: retries(n),
    });
    const before = target(ctx);
    await runAll(ctx);
    const a = attempts(ctx)[0]!;
    const calls = 1 + (n ?? 1);
    assert.equal(a.failureKind, 'review-protocol', String(n));
    assert.equal(reviewerCalls(ctx), calls, `${n}: вызовов reviewer 1 + повторы`);
    assert.equal(writerCalls(ctx), 1);
    assert.equal(target(ctx), before);
    // Учёт каждого вызова (measuredInvoke): записи usage по стадии ревью.
    const usage = ctx.engine
      .read((v) => v.locals('usage', ctx.policy.repositories[0]!.id))
      .map((x) => x.value as any)
      .filter((c) => c.runId === a.id && c.stage === 'candidate-review');
    assert.equal(usage.length, calls, `${n}: каждый вызов учтён`);
    // Ответ не JSON: runtime вернул отказ чтения — вызов учтён завершённым, с usage и временем.
    assert.ok(
      usage.every(
        (c) => c.outcome !== 'active' && typeof c.durationMs === 'number' && c.finishedAt,
      ),
      JSON.stringify(usage.map((c) => c.outcome)),
    );
    assert.ok(
      usage.every((c) => c.usage.inputTokens === 10),
      'usage каждого вызова записан',
    );
    // Отказ протокола не открывает и не обнуляет эпизод по свойству.
    assert.equal(work(ctx).recovery, undefined);
    const result = runResult(a, 'test');
    assert.equal(runResultSchema.parse(result).outcome, 'rejected');
    assert.equal(
      result.outcome !== 'accepted' && result.stopReason.code,
      'REVIEW_PROTOCOL_INVALID',
    );
    if (n === undefined) dump('HP06', 'default-result', result);
  }
});

test('HP06: бюджет исчерпан до повтора и неизвестная стоимость — остановка бюджета, без повтора и writer', async () => {
  // Известная стоимость первого вызова reviewer превышает предел поручения.
  const spent = setup({
    writer: 'codex',
    reviewer: 'claude',
    scenario: { writer: implement(), reviewer: { raw: '{broken', costUsd: 5 } },
    policy: (p: any) => {
      retries(undefined)(p);
      p.budgets = { work: { usd: 1 }, onUnknown: 'continue' };
    },
  });
  await runAll(spent);
  let a = attempts(spent)[0]!;
  assert.equal(a.failureKind, 'budget', a.error);
  assert.equal(fixtureCalls(spent.scenarioPath, 'claude', 'reviewer'), 1, 'повтор не начат');
  // Неизвестная стоимость вызова reviewer при onUnknown: stop.
  const unknown = setup({
    scenario: { writer: implement(), reviewer: { raw: '{broken' } },
    policy: (p: any) => {
      retries(undefined)(p);
      p.budgets = { work: { usd: 100 }, onUnknown: 'stop' };
    },
  });
  await runAll(unknown);
  a = attempts(unknown)[0]!;
  assert.equal(a.failureKind, 'budget', a.error);
  assert.equal(reviewerCalls(unknown), 1, 'неизвестная стоимость не даёт бесплатного повтора');
  assert.equal(writerCalls(unknown), 1);
});

test('HP06: timeout и отмена во время повтора — свой класс отказа, не ошибка протокола', async () => {
  const slow = setup({
    scenario: {
      writer: implement(),
      reviewer: [{ raw: '{broken' }, { ...verdict(true), sleepMs: 20000 }],
    },
    policy: (p: any) => {
      retries(undefined)(p);
      p.runTimeoutMs = 8000;
    },
  });
  await runAll(slow);
  let a = attempts(slow)[0]!;
  assert.equal(a.failureKind, 'timeout', a.error);
  assert.equal(reviewerCalls(slow), 2);

  const cancel = setup({
    scenario: {
      writer: implement(),
      reviewer: [{ raw: '{broken' }, { ...verdict(true), sleepMs: 20000 }],
    },
    policy: retries(undefined),
  });
  const running = runAll(cancel);
  const started = Date.now();
  while (reviewerCalls(cancel) < 2 && Date.now() - started < 60000)
    await new Promise((r) => setTimeout(r, 100));
  await cancel.runner.stop();
  await running.catch(() => undefined);
  a = attempts(cancel)[0]!;
  assert.notEqual(a.failureKind, 'review-protocol', a.error);
  assert.notEqual(a.status, 'succeeded');
  assert.equal(reviewerCalls(cancel), 2);
});

test('HP06/HP09: протокольный отказ нейтрален для эпизода свойства; кандидат переиспользуется повтором человека без writer', async () => {
  const ctx = setup({
    scenario: {
      writer: implement(),
      reviewer: [{ raw: '{x' }, { raw: '{x' }, verdict(true), verdict(true)],
    },
    policy: retries(undefined),
  });
  await runAll(ctx);
  assert.equal(work(ctx).failureKind, 'review-protocol');
  const { repairPolicy } = await import('../src/contracts/index.ts');
  assert.equal(repairPolicy['review-protocol'].action, 'stop');
  ctx.engine.retry(WORK);
  await ctx.runner.drain();
  const all = attempts(ctx);
  const last: AttemptState = all.at(-1)!;
  assert.equal(last.status, 'succeeded', last.error);
  assert.equal(last.reusedFrom?.candidateSha, all[0]!.candidateSha, 'кандидат взят без writer');
  assert.equal(writerCalls(ctx), 1);
  assert.equal(greet.length > 0, true);
});
