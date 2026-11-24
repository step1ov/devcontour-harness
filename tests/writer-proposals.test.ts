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

test('ревью 1: новая редакция графа не стирает предложения и решения; исследование — только у той же постановки', async () => {
  const { engineOf, graphOf, ready } = await import('./engine-fixture.ts');
  const env = engineOf();
  const e = env.engine;
  ready(e, graphOf({ a: [], b: [] }));
  e.lead('c1');
  const run = e.claim('c1')!;
  const [id] = e.recordProposals(run.id, run.token, [
    {
      kind: 'split',
      title: 'A',
      goal: 'Разделить работу A',
      acceptance: [],
      reason: 'две части',
      parts: [],
    },
  ]);
  e.recordResearch(run.id, run.token, { text: 'исследование работы ' + run.workId });
  e.fail(run.id, run.token, 'split', { kind: 'needs-lead' });
  e.decideProposal(run.workId, id!, { decision: 'reject', by: 'lead', reason: 'Делать целиком' });
  // Редакция 2: соседняя работа изменена, эта — та же постановка.
  const next = graphOf({ a: [], b: [] }, '2');
  const other = next.orders.find((o) => o.id !== run.workId)!;
  other.title = 'Изменённая соседняя работа';
  ready(e, next);
  const w = e.read((v) => v.work(run.workId)!);
  assert.equal(w.proposals?.[0]?.status, 'rejected');
  assert.equal(w.proposals?.[0]?.decision?.reason, 'Делать целиком');
  assert.match(w.research?.text ?? '', /исследование/);
  // Редакция 3: изменена сама работа — исследование не наследуется.
  const third = graphOf({ a: [], b: [] }, '3');
  third.orders.find((o) => o.id === run.workId)!.goal = 'Другая цель этой работы целиком.';
  ready(e, third);
  const w3 = e.read((v) => v.work(run.workId)!);
  assert.equal(w3.research, undefined);
  assert.equal(w3.proposals?.length, 1);
});

test('ревью 1: разделение после отклонённого — засчитанная незавершённость, не новое предложение', async () => {
  const split = {
    result: {
      completed: false,
      summary: 'Предлагаю разделить',
      discoveries: [],
      triage: {
        decision: 'split',
        reason: 'Две части',
        parts: [
          { title: 'API', goal: 'Функция greet', acceptance: ['greet'] },
          { title: 'Экран', goal: 'Экран greet', acceptance: ['экран'] },
        ],
      },
    },
  };
  const ctx = hsetup({
    scenario: { writer: [split, split], reviewer: approve() },
    policy: (p: any) => (p.maxAttempts = 3),
  });
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  const first = h.engine.read((v) => v.attempts(WORK)[0]!);
  h.engine.decideProposal(WORK, first.writerSplit!, {
    decision: 'reject',
    by: 'lead',
    reason: 'Делать целиком',
  });
  h.engine.retry(WORK, undefined, 'lead');
  await h.run({ graph: ctx.graph, author: 'claude' }).catch(() => undefined);
  const second = h.engine.read((v) => v.attempts(WORK)[1]!);
  assert.equal(second.failureKind, 'unfinished', second.error);
  assert.equal(second.writerSplit, undefined);
  assert.match(second.error ?? '', /снова предложил разделить/);
  assert.equal(
    h.engine.read((v) => v.work(WORK)!.proposals?.length),
    1,
    'нового предложения нет',
  );
  h.close();
});

test('ревью 2: после правки работы ведущим новое разделение — снова предложение, а не засчитанный повтор', async () => {
  const split = {
    result: {
      completed: false,
      summary: 'Предлагаю разделить',
      discoveries: [],
      triage: {
        decision: 'split',
        reason: 'Две части',
        parts: [
          { title: 'API', goal: 'Функция greet', acceptance: ['greet'] },
          { title: 'Экран', goal: 'Экран greet', acceptance: ['экран'] },
        ],
      },
    },
  };
  const ctx = hsetup({
    scenario: { writer: [split, split], reviewer: approve() },
    policy: (p: any) => (p.maxAttempts = 3),
  });
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  const first = h.engine.read((v) => v.attempts(WORK)[0]!);
  h.engine.decideProposal(WORK, first.writerSplit!, {
    decision: 'reject',
    by: 'lead',
    reason: 'Делать целиком',
  });
  // Ведущий правит постановку: новая редакция графа с другой целью.
  const revised = structuredClone(ctx.graph);
  revised.source = { ...revised.source, revision: '2' };
  revised.orders[0] = {
    ...revised.orders[0]!,
    source: { ...revised.orders[0]!.source, revision: '2' },
    goal: 'Добавить greet(name) и экран приветствия, по частям.',
  };
  h.engine.retry(WORK, undefined, 'lead');
  await h.run({ graph: revised, author: 'claude' }).catch(() => undefined);
  const second = h.engine.read((v) => v.attempts(WORK).at(-1)!);
  assert.equal(second.failureKind, 'needs-lead', second.error);
  assert.match(second.writerSplit ?? '', /^P-/);
  assert.equal(
    h.engine.read((v) => v.work(WORK)!.proposals?.filter((p) => p.kind === 'split').length),
    2,
  );
  h.close();
});
