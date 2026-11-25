/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument --
 * Фикстура правит сырой JSON политики.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HarnessError, type AttemptState, type WorkState } from '../src/contracts/index.ts';
import { leadHold, repeatedDefect } from '../src/projections/lead-recovery.ts';
import { approve, implement, setup } from './runner-fixture.ts';
import { planReview, trustNone } from './engine-fixture.ts';

const work = { id: 'w', status: 'failed', attempt: 2 } as WorkState;
const failed = (id: string, patch: Partial<AttemptState>) =>
  ({ id, workId: 'w', status: 'failed', failureKind: 'gate', ...patch }) as AttemptState;
const review = (ids: string[]) => ({
  failureKind: 'review' as const,
  failureFingerprint: Math.random().toString(16),
  evidence: [
    {
      kind: 'review',
      phase: 'candidate',
      passed: false,
      findings: ids.map((id) => ({
        severity: 'blocking',
        message: 'm',
        path: null,
        line: null,
        id,
      })),
    },
  ] as any,
});

test('repeatedDefect: тот же отпечаток или та же блокирующая находка в двух засчитанных отказах подряд; окружение серию не рвёт', () => {
  assert.deepEqual(
    repeatedDefect(work, [
      failed('a1', { failureFingerprint: 'f1' }),
      failed('a2', { failureFingerprint: 'f1' }),
    ]),
    { runs: ['a1', 'a2'], by: 'fingerprint' },
  );
  assert.equal(
    repeatedDefect(work, [
      failed('a1', { failureFingerprint: 'f1' }),
      failed('a2', { failureFingerprint: 'f2' }),
    ]),
    undefined,
  );
  // Отказ окружения между ними не засчитан и серию не обрывает.
  assert.deepEqual(
    repeatedDefect(work, [
      failed('a1', { failureFingerprint: 'f1' }),
      failed('e1', { failureKind: 'environment', failureFingerprint: 'env' }),
      failed('a2', { failureFingerprint: 'f1' }),
    ])?.runs,
    ['a1', 'a2'],
  );
  // Принятая попытка между ними — другая редакция.
  assert.equal(
    repeatedDefect(work, [
      failed('a1', { failureFingerprint: 'f1' }),
      { ...failed('ok', {}), status: 'succeeded' },
      failed('a2', { failureFingerprint: 'f1' }),
    ]),
    undefined,
  );
  assert.deepEqual(
    repeatedDefect(work, [failed('r1', review(['F1', 'F2'])), failed('r2', review(['F3', 'F2']))]),
    { runs: ['r1', 'r2'], by: 'finding', finding: 'F2' },
  );
  assert.equal(
    repeatedDefect(work, [failed('r1', review(['F1'])), failed('r2', review(['F3']))]),
    undefined,
  );
  // Разбор при любом diagnoseAfter: повтор держит выдачу до разбора ведущего.
  const policy = { enabled: true, mode: 'lead', diagnoseAfter: 5, leadResets: 1 } as any;
  const same = [
    failed('a1', { failureFingerprint: 'f1' }),
    failed('a2', { failureFingerprint: 'f1' }),
  ];
  assert.deepEqual(leadHold(work, same, policy, 6), {
    kind: 'diagnosis-required',
    failures: ['a1', 'a2'],
  });
  const different = [
    failed('a1', { failureFingerprint: 'f1' }),
    failed('a2', { failureFingerprint: 'f2' }),
  ];
  assert.equal(leadHold(work, different, policy, 6), undefined);
});

test('runner: тот же провал gate дважды подряд — разбор с гипотезой обязателен, следующая попытка с чистого дерева', async () => {
  const bad = implement({ 'src/greet.js': "exports.greet = () => 'nope';\n" });
  const ctx = setup({
    scenario: {
      writer: [bad, bad, { ...implement(), recordPrompt: true }],
      reviewer: approve(),
    },
    policy: (p: any) => {
      p.harnessMode = 'light';
      p.maxAttempts = 4;
      p.recovery = { mode: 'lead', diagnoseAfter: 3, leadResets: 1 };
    },
  });
  await ctx.runner.init();
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(planReview(ctx.engine, graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  const attempts = () => ctx.engine.read((v) => v.attempts('add-greeting'));
  for (let i = 0; i < 2; i++) {
    await ctx.runner.drain();
    if (attempts().length === i + 1 && i === 0) {
      ctx.engine.retry('add-greeting', undefined, 'recovery');
      ctx.engine.resume();
    }
  }
  await ctx.runner.drain();
  assert.equal(attempts().length, 2);
  const [a1, a2] = attempts();
  assert.equal(a1!.failureFingerprint, a2!.failureFingerprint, 'тот же провал');
  // Выдача держится до разбора, хотя diagnoseAfter = 3.
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(ctx.engine.read((v) => ctx.engine.leadHoldOf(work, v))?.kind, 'diagnosis-required');
  assert.throws(
    () => ctx.engine.retry('add-greeting', undefined, 'lead'),
    (e: unknown) => e instanceof HarnessError && e.code === 'DIAGNOSIS_REQUIRED',
  );
  // Разбор без гипотезы не принимается: третья попытка была бы той же слепой.
  assert.throws(
    () => ctx.engine.diagnose('add-greeting', { cause: 'other' }),
    (e: unknown) => e instanceof HarnessError && /--hypothesis обязательна/.test(e.message),
  );
  ctx.engine.diagnose('add-greeting', {
    cause: 'other',
    hypothesis: 'greet должна собирать строку из имени, а не возвращать константу',
  });
  ctx.engine.retry('add-greeting', undefined, 'lead');
  ctx.engine.resume();
  await ctx.runner.drain();
  const third = attempts()[2]!;
  assert.equal(third.status, 'succeeded', third.error);
  assert.equal(third.continuedFrom, undefined, 'чистое дерево, не продолжение патча');
  const prompt = readFileSync(`${ctx.scenarioPath}.writer.2.prompt`, 'utf8');
  assert.match(prompt, /Fresh start: attempts .* failed on the same defect/);
  // Вторая попытка (после разных отказов — одного) продолжала черновик первой.
  assert.ok(a2!.continuedFrom, 'обычное продолжение до повтора');
  ctx.store.close();
});
