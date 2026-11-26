/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тесты читают сырые JSON-ответы и состояние как есть.
 */
/**
 * Двухпроходное ревью (0.1.0-alpha.70): «подозрение → опровержение».
 * `on-reject` — умолчание ревью попыток, `always` — приёмка выпуска и работы
 * с метками security/payments/auth; `off` — один проход.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  executionDigest,
  executionPolicySchema,
  mergePasses,
  needsSecondPass,
  refuteResultSchema,
  refutePromptText,
  reviewPassModeOf,
} from '../src/contracts/index.ts';
import { refuteOutputSchema } from '../src/agents/schemas.ts';
import { implement, runAll, setup } from './runner-fixture.ts';
import { finding, fixtureCalls, verdict } from './review-fixture.ts';

const WORK = 'add-greeting';

test('режим второго прохода: умолчания по видам, метки и явное поле', () => {
  assert.deepEqual(reviewPassModeOf(undefined, { kind: 'code' }), {
    mode: 'on-reject',
    source: 'default',
  });
  assert.deepEqual(reviewPassModeOf(undefined, { kind: 'release' }), {
    mode: 'always',
    source: 'default',
  });
  assert.deepEqual(reviewPassModeOf(undefined, { kind: 'code', labels: ['ui', 'payments'] }), {
    mode: 'always',
    source: 'default',
    sensitive: 'payments',
  });
  assert.equal(reviewPassModeOf('off', { kind: 'code' }).mode, 'off');
  // Строка — режим ревью кода; метка работы по-прежнему главнее.
  assert.equal(reviewPassModeOf('off', { kind: 'code', labels: ['auth'] }).mode, 'always');
  assert.equal(
    reviewPassModeOf(
      { sensitive: 'on-reject', sensitiveLabels: ['crypto'] },
      {
        kind: 'code',
        labels: ['auth'],
      },
    ).mode,
    'on-reject',
    'свой список меток заменяет умолчание',
  );
  assert.equal(reviewPassModeOf({ release: 'off' }, { kind: 'release' }).mode, 'off');
  assert.equal(needsSecondPass('on-reject', { approved: true, blocking: 0 }), false);
  assert.equal(needsSecondPass('on-reject', { approved: false, blocking: 0 }), false);
  assert.equal(needsSecondPass('on-reject', { approved: false, blocking: 2 }), true);
  assert.equal(needsSecondPass('always', { approved: true, blocking: 0 }), true);
  assert.equal(needsSecondPass('off', { approved: false, blocking: 2 }), false);
});

test('слияние проходов: опровергнутые сняты с основанием, без вердикта — подтверждена, пропущенные только в always', () => {
  const findings = [
    { severity: 'blocking' as const, message: 'A' },
    { severity: 'note' as const, message: 'N' },
    { severity: 'blocking' as const, message: 'B' },
  ];
  const refute = refuteResultSchema.parse({
    summary: 's',
    verdicts: [
      { index: 0, verdict: 'refuted', basis: 'обработано в строке 3' },
      // Вердикт заметке не снимает её.
      { index: 1, verdict: 'refuted', basis: 'не дефект' },
    ],
    missed: [{ message: 'пропущено', path: 'src/x.js', line: 2, rule: null, evidence: null }],
  });
  const onReject = mergePasses({ approved: false, findings, reopened: false }, refute, 'on-reject');
  assert.deepEqual(
    onReject.findings.map((f) => f.message),
    ['N', 'B'],
  );
  assert.deepEqual(onReject.refuted, [{ message: 'A', basis: 'обработано в строке 3' }]);
  assert.equal(onReject.confirmed, 1);
  assert.equal(onReject.missed, 0);
  assert.equal(onReject.approved, false, 'B без вердикта подтверждена');
  const all = mergePasses(
    { approved: false, findings, reopened: false },
    {
      ...refute,
      verdicts: [...refute.verdicts, { index: 2, verdict: 'refuted', basis: 'нет' + '!' }],
    },
    'always',
  );
  assert.equal(all.missed, 1);
  assert.equal(all.approved, false, 'пропущенная блокирующая находка держит отказ');
  const clear = mergePasses(
    { approved: false, findings, reopened: false },
    {
      ...refute,
      missed: [],
      verdicts: [...refute.verdicts, { index: 2, verdict: 'refuted', basis: 'нет!' }],
    },
    'on-reject',
  );
  assert.equal(clear.approved, true);
  const reopened = mergePasses(
    { approved: false, findings, reopened: true },
    {
      ...refute,
      missed: [],
      verdicts: [...refute.verdicts, { index: 2, verdict: 'refuted', basis: 'нет!' }],
    },
    'on-reject',
  );
  assert.equal(reopened.approved, false, 'прежняя открытая находка держит отказ');
  const ajv = new Ajv2020({ strict: false });
  assert.ok(ajv.validate(refuteOutputSchema, { summary: 's', verdicts: [], missed: [] }));
});

test('review.passes не входит в executionDigest: смена не делает согласование устаревшим', () => {
  const ctx = setup({ scenario: { writer: [implement()], reviewer: [verdict(true)] } });
  const raw = structuredClone(ctx.policy) as any;
  raw.review.passes = { code: 'always', release: 'off' };
  assert.equal(executionDigest(executionPolicySchema.parse(raw)), executionDigest(ctx.policy));
  raw.review.passes = 'bogus';
  assert.equal(executionPolicySchema.safeParse(raw).success, false);
});

test('on-reject: второй проход опроверг единственную блокирующую находку — попытка принята с первого раза', async () => {
  const ctx = setup({
    scenario: {
      writer: [implement()],
      reviewer: [
        verdict(false, { findings: [finding('Нет проверки пустого имени')] }),
        verdict(true),
      ],
      refuter: [
        {
          result: {
            summary: 'находка неверна',
            verdicts: [
              { index: 0, verdict: 'refuted', basis: 'greet не принимает пустое имя по критериям' },
            ],
            missed: [],
          },
        },
      ],
    } as any,
  });
  await runAll(ctx);
  const attempts = ctx.engine.read((v) => v.attempts(WORK));
  assert.equal(attempts.length, 1, attempts.map((a) => a.error).join('; '));
  assert.equal(attempts[0]!.status, 'succeeded');
  const review = attempts[0]!.evidence.find((e) => e.kind === 'review' && e.phase === 'candidate')!;
  assert.equal(review.passed, true);
  assert.equal(review.reviewPasses?.status, 'ran');
  assert.equal(review.reviewPasses?.overturned, true);
  assert.deepEqual(
    review.reviewPasses?.refuted.map((r) => r.message),
    ['Нет проверки пустого имени'],
  );
  assert.deepEqual(review.findings, [], 'опровергнутая находка не попала в историю');
  assert.match(review.summary, /второй проход: подтверждено 0 из 1, снято 1/);
  assert.equal(fixtureCalls(ctx.scenarioPath, 'codex', 'refuter'), 1);
});

test('on-reject: подтверждённая находка остаётся, отказ засчитан; одобрение второго прохода не вызывает', async () => {
  const ctx = setup({
    scenario: {
      writer: [implement()],
      reviewer: [verdict(false, { findings: [finding('Нет проверки пустого имени')] })],
    },
    policy: (p: any) => (p.maxAttempts = 1),
  });
  await runAll(ctx);
  const attempt = ctx.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(attempt.failureKind, 'review');
  const first = attempt.evidence.find((e) => e.kind === 'review')!;
  assert.equal(first.reviewPasses?.status, 'ran');
  assert.equal(first.reviewPasses?.confirmed, 1);
  assert.equal(first.reviewPasses?.overturned, false);
  assert.equal(first.findings?.length, 1);
  assert.equal(fixtureCalls(ctx.scenarioPath, 'codex', 'refuter'), 1);

  const ok = setup({ scenario: { writer: [implement()], reviewer: [verdict(true)] } });
  await runAll(ok);
  const approved = ok.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(approved.status, 'succeeded', approved.error);
  assert.equal(fixtureCalls(ok.scenarioPath, 'codex', 'refuter'), 0);
  assert.equal(approved.evidence.find((e) => e.kind === 'review')!.reviewPasses?.status, 'skipped');
});

test('off: второго прохода нет; always по метке security: второй проход нашёл пропущенное — отказ', async () => {
  const off = setup({
    scenario: {
      writer: [implement()],
      reviewer: [verdict(false, { findings: [finding('Нет проверки')] })],
    },
    policy: (p: any) => {
      p.maxAttempts = 1;
      p.review.passes = 'off';
    },
  });
  await runAll(off);
  assert.equal(fixtureCalls(off.scenarioPath, 'codex', 'refuter'), 0);
  const a = off.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(a.evidence.find((e) => e.kind === 'review')!.reviewPasses, undefined);

  const sec = setup({
    scenario: {
      writer: [implement()],
      reviewer: [verdict(true)],
      refuter: [
        {
          result: {
            summary: 'пропущено',
            verdicts: [],
            missed: [
              {
                message: 'Токен пишется в журнал',
                path: 'src/greet.js',
                line: 1,
                rule: null,
                evidence: 'console.log(token)',
              },
            ],
          },
        },
      ],
    } as any,
    policy: (p: any) => (p.maxAttempts = 1),
    graph: (g: any) => (g.orders[0].labels = ['security']),
  });
  await runAll(sec);
  const s = sec.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(s.failureKind, 'review', s.error);
  const r = s.evidence.find((e) => e.kind === 'review')!;
  assert.equal(r.reviewPasses?.mode, 'always');
  assert.equal(r.reviewPasses?.sensitive, 'security');
  assert.equal(r.reviewPasses?.missed, 1);
  assert.deepEqual(
    r.findings?.map((f) => f.message),
    ['Токен пишется в журнал'],
  );
});

test('второй проход вне схемы — действует первый проход, находки остаются', async () => {
  const ctx = setup({
    scenario: {
      writer: [implement()],
      reviewer: [verdict(false, { findings: [finding('Нет проверки')] })],
      refuter: [{ raw: JSON.stringify({ summary: 'x' }) }],
    } as any,
    policy: (p: any) => (p.maxAttempts = 1),
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(a.failureKind, 'review');
  const r = a.evidence.find((e) => e.kind === 'review')!;
  assert.equal(r.reviewPasses?.status, 'failed');
  assert.equal(r.findings?.length, 1);
  assert.match(r.summary, /второй проход не дал итога/);
});

test('ревью 1: явный отказ без блокирующих находок второй проход не снимает; без опровержения всех — тоже', () => {
  const note = [{ severity: 'note' as const, message: 'не проверить критерий 2' }];
  const empty = refuteResultSchema.parse({ summary: 's', verdicts: [], missed: [] });
  assert.equal(
    mergePasses({ approved: false, findings: note, reopened: false }, empty, 'always').approved,
    false,
  );
  assert.equal(
    mergePasses({ approved: false, findings: [], reopened: false }, empty, 'always').approved,
    false,
  );
  const two = [
    { severity: 'blocking' as const, message: 'A' },
    { severity: 'blocking' as const, message: 'B' },
  ];
  const one = refuteResultSchema.parse({
    summary: 's',
    verdicts: [{ index: 0, verdict: 'refuted', basis: 'обработано' }],
    missed: [],
  });
  assert.equal(
    mergePasses({ approved: false, findings: two, reopened: false }, one, 'on-reject').approved,
    false,
  );
  assert.equal(
    mergePasses({ approved: true, findings: [], reopened: false }, empty, 'always').approved,
    true,
  );
});

test('ревью 1: второй проход, изменивший своё дерево, не превращает одобрение первого в отказ', async () => {
  const ctx = setup({
    scenario: {
      writer: [implement()],
      reviewer: [verdict(true)],
      refuter: [
        {
          files: { 'src/greet.js': 'hacked\n' },
          result: { summary: 'x', verdicts: [], missed: [] },
        },
      ],
    } as any,
    policy: (p: any) => (p.maxAttempts = 1),
    graph: (g: any) => (g.orders[0].labels = ['auth']),
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  const r = a.evidence.find((e) => e.kind === 'review')!;
  assert.equal(r.passed, true);
  assert.equal(r.reviewPasses?.status, 'failed');
  assert.match(r.reviewPasses?.reason ?? '', /изменил своё дерево/);
});

test('ревью 3: запрос второго прохода называет дерево чистым и неподготовленным', () => {
  const text = refutePromptText(
    [{ index: 0, finding: { severity: 'blocking', message: 'A' } }],
    'on-reject',
  );
  assert.match(text, /clean checkout of the same commit/);
  assert.match(text, /no installed dependencies, build output or running services/);
  assert.match(text, /do not rely on running the project commands/);
});

test('alpha.72: в режиме always второй проход ищет все пропущенные находки, а не только опровергает', () => {
  const always = refutePromptText([], 'always');
  assert.match(always, /EVERY blocking defect the first pass did not report/);
  assert.match(always, /Search, do not only refute/);
  assert.match(always, /keep going after the first missed defect/);
  assert.doesNotMatch(refutePromptText([], 'on-reject'), /Search, do not only refute/);
});
