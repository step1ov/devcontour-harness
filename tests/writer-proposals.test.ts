/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тесты портят сырой JSON политики до разбора схемой.
 */
/**
 * 0.1.0-alpha.70: предложения исполнителя ведущему. Задачи-продолжения на
 * остаток вне критериев (работа принята, предложение ждёт ведущего) и
 * разбор в начале попытки «делаю / разделить / спросить»: разделение уходит
 * ведущему, попытка не засчитана. Принимает и отклоняет только ведущий.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HarnessError, implementationResultSchema } from '../src/contracts/index.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, greet, implement } from './runner-fixture.ts';

const WORK = 'add-greeting';
const followUp = {
  title: 'Локализация приветствия',
  goal: 'Вынести строку приветствия в словарь локалей',
  acceptance: ['Приветствие берётся из словаря ru/en'],
  reason: 'Локализации нет в критериях этой работы',
  evidence: 'greet покрыт test/run.js',
};

test('ответ исполнителя: негодные предложения отбрасываются, а не весь ответ', () => {
  const parsed = implementationResultSchema.parse({
    completed: true,
    summary: 's',
    discoveries: [],
    followUpTasks: [{ title: 'x' }],
    triage: { decision: 'maybe' },
  });
  assert.deepEqual(parsed.followUpTasks, []);
  assert.equal(parsed.triage, null);
});

test('задача-продолжение: работа принята, предложение записано и видно reviewer; решает ведущий один раз', async () => {
  const ctx = hsetup({
    scenario: {
      writer: [
        {
          files: { 'src/greet.js': greet },
          result: {
            completed: true,
            summary: 'Добавлена greet',
            discoveries: [],
            followUpTasks: [followUp],
            triage: { decision: 'implement', reason: 'Работа небольшая', parts: null },
          },
        },
      ],
      reviewer: { ...approve(), recordPrompt: true },
    },
  });
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  const work = h.engine.read((v) => v.work(WORK)!);
  assert.equal(work.status, 'done');
  assert.equal(work.proposals?.length, 1);
  const p = work.proposals?.[0];
  assert.ok(p);
  assert.equal(p.kind, 'follow-up');
  assert.equal(p.status, 'proposed');
  assert.match(p.id, /^P-[0-9a-f]{12}$/);
  assert.deepEqual(p.acceptance, followUp.acceptance);
  const reviewerPrompt = readFileSync(`${ctx.scenarioPath}.reviewer.1.prompt`, 'utf8');
  assert.match(reviewerPrompt, /proposed follow-up tasks/);
  assert.match(reviewerPrompt, /Локализация приветствия/);
  const decided = h.engine.decideProposal(WORK, p.id, {
    decision: 'accept',
    by: 'lead',
    reason: 'Вносим в следующий план',
  });
  assert.equal(decided.status, 'accepted');
  assert.equal(decided.decision?.by, 'lead');
  assert.throws(
    () => h.engine.decideProposal(WORK, p.id, { decision: 'reject', by: 'lead', reason: 'нет' }),
    (e: unknown) => e instanceof HarnessError && e.code === 'NOT_READY',
  );
  assert.throws(
    () =>
      h.engine.decideProposal(WORK, 'P-000000000000', {
        decision: 'reject',
        by: 'lead',
        reason: 'нет!',
      }),
    (e: unknown) => e instanceof HarnessError && e.code === 'NOT_FOUND',
  );
  h.close();
});

test('разбор в начале попытки: разделение — ведущему, попытка не засчитана; отклонённое — следующая попытка знает', async () => {
  const ctx = hsetup({
    scenario: {
      writer: [
        {
          result: {
            completed: false,
            summary: 'Предлагаю разделить',
            discoveries: [],
            triage: {
              decision: 'split',
              reason: 'Две независимые части: API и экран',
              parts: [
                {
                  title: 'API приветствия',
                  goal: 'Функция greet и её тесты',
                  acceptance: ['greet("A")'],
                },
                {
                  title: 'Экран приветствия',
                  goal: 'Экран показывает greet',
                  acceptance: ['экран'],
                },
              ],
            },
          },
        },
        { ...implement(), recordPrompt: true },
      ],
      reviewer: approve(),
    },
    policy: (p: any) => (p.maxAttempts = 3),
  });
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  const attempts = h.engine.read((v) => v.attempts(WORK));
  assert.equal(attempts.length, 1, 'автоматического повтора нет');
  const first = attempts[0]!;
  assert.equal(first.failureKind, 'needs-lead', first.error);
  assert.match(first.writerSplit ?? '', /^P-[0-9a-f]{12}$/);
  assert.equal(first.writerBlocked, undefined);
  let work = h.engine.read((v) => v.work(WORK)!);
  assert.equal(work.attempt, 0, 'попытка не засчитана');
  assert.equal(work.neutralFailures, 1);
  const split = (work.proposals ?? []).find((p) => p.id === first.writerSplit);
  assert.ok(split);
  assert.equal(split.kind, 'split');
  assert.equal(split.parts?.length, 2);
  const d = stopInputsOf(h, { maxAttempts: 3, repairBudget: 6, workId: WORK })
    .map(explainStop)
    .find((x) => x.workId === WORK)!;
  assert.equal(d.actor, 'lead');
  assert.match(JSON.stringify(d), /предложил разделить работу/);
  assert.match(JSON.stringify(d), new RegExp(split.id));
  assert.equal(d.reference, 'docs/failure-causes.md#cause-writer-split');
  const diagnosed = h
    .events(0, 500)
    .events.find((e) => e.type === 'attempt.diagnosed') as unknown as {
    payload: { cause: string; counted: boolean };
  };
  assert.deepEqual([diagnosed.payload.cause, diagnosed.payload.counted], ['writer-split', false]);

  h.engine.decideProposal(WORK, split.id, {
    decision: 'reject',
    by: 'lead',
    reason: 'Работа мала, делать целиком',
  });
  h.engine.retry(WORK, undefined, 'lead');
  await h.run({ graph: ctx.graph, author: 'claude' });
  work = h.engine.read((v) => v.work(WORK)!);
  assert.equal(work.status, 'done', work.failure);
  const writerPrompt = readFileSync(`${ctx.scenarioPath}.writer.1.prompt`, 'utf8');
  assert.match(writerPrompt, /The lead rejected the split .*Работа мала, делать целиком/);
  assert.match(writerPrompt, /Triage before coding/);
  h.close();
});
