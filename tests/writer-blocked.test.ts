/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тесты портят сырой JSON политики до разбора схемой.
 */
/**
 * Без слепых повторов: остановка исполнителя из-за окружения — ход
 * ведущего (`needs-lead`, причина `writer-environment`), попытка не
 * засчитана; итог исполнителя виден в lastFailure и explain; тот же упавший
 * testcase дважды — к ведущему; правило «сначала код» в запросе исполнителя.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AttemptState, ExecutionView, WorkState } from '../src/contracts/index.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { attemptSummaryOf } from '../src/report/compute.ts';
import { repairDecision, repeatedTestcase } from '../src/engine/repair.ts';
import { environmentBlockOf } from '../src/engine/writer-block.ts';
import { ENVIRONMENT_BLOCK_WRITER_TEXT } from '../src/engine/prompt.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, implement } from './runner-fixture.ts';

test('WB01: признаки окружения в итоге исполнителя; обычная незавершённость — нет', () => {
  for (const s of [
    'Среда запрещает открыть сервер на 127.0.0.1 (listen EPERM)',
    'Генератор недоступен: getaddrinfo ENOTFOUND registry.npmjs.org',
    'Нет доступа к сети, обязательный генератор не скачать',
    'agent-browser cannot start: Operation not permitted',
    'The sandbox blocks the mandated browser check',
    'Не удалось прочитать описание задачи из трекера',
    'Unable to start the dev server for browser checks',
  ])
    assert.ok(environmentBlockOf(s), s);
  for (const s of [
    'Успел половину',
    'форма и тесты ещё не реализованы',
    'Ran out of time',
    'Tests fail: Cannot read properties of undefined (reading "id")',
  ])
    assert.equal(environmentBlockOf(s), undefined, s);
});

test('WB02: исполнитель остановился из-за окружения — ведущему, без повтора, попытка не засчитана, итог виден', async () => {
  const summary = 'Обязательная проверка в браузере недоступна: listen EPERM на 127.0.0.1';
  const ctx = hsetup({
    scenario: {
      writer: [{ result: { completed: false, summary, discoveries: [] } }, { ...implement() }],
      reviewer: approve(),
    },
    policy: (p: any) => (p.maxAttempts = 3),
  });
  const h = ctx.open();
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  const attempts = h.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts.length, 1, 'автоматического повтора нет');
  const [first] = attempts;
  assert.equal(first!.failureKind, 'needs-lead', first!.error);
  assert.equal(first!.writerBlocked, true);
  assert.equal(first!.writerSummary, summary);
  const work = h.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.equal(work.attempt, 0, 'попытка не засчитана');
  assert.equal(work.neutralFailures, 1, 'тратится нейтральный предел');
  assert.notEqual(data.workflow?.status, 'completed');
  assert.match(data.workflow?.error ?? '', /окружение закрыло обязательный шаг/);
  // Причина простыми словами — с итогом исполнителя, корзина среды.
  const last = attemptSummaryOf(work, attempts).lastFailure!;
  assert.equal(last.bucket, 'environment');
  assert.match(
    last.plain,
    /окружение закрыло исполнителю обязательный шаг: «Обязательная проверка/,
  );
  // explain: ход ведущего, итог исполнителя в пояснении, повтора нет.
  const d = stopInputsOf(h, { maxAttempts: 3, repairBudget: 6, workId: 'add-greeting' })
    .map(explainStop)
    .find((x) => x.workId === 'add-greeting')!;
  assert.equal(d.actor, 'lead');
  assert.equal(d.retryPlanned, false);
  assert.match(JSON.stringify(d), /listen EPERM/);
  // Событие диагноза: причина writer-environment, не засчитано.
  const diagnosed = h
    .events(0, 500)
    .events.find((e) => e.type === 'attempt.diagnosed') as unknown as {
    payload: { cause: string; counted: boolean };
  };
  assert.deepEqual(
    [diagnosed.payload.cause, diagnosed.payload.counted],
    ['writer-environment', false],
  );
  h.close();
});

test('WB03: обычная незавершённость — повтор черновиком, итог исполнителя в lastFailure', async () => {
  const ctx = hsetup({
    scenario: {
      writer: [
        {
          files: { 'src/greet.js': '// half\n' },
          result: { completed: false, summary: 'Успел половину', discoveries: [] },
        },
        { ...implement() },
      ],
      reviewer: approve(),
    },
  });
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  const attempts = h.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.failureKind, 'unfinished');
  assert.equal(attempts[0]!.writerBlocked, undefined);
  const work = h.engine.read((v) => v.work('add-greeting')!);
  const last = attemptSummaryOf(work, attempts.slice(0, 1)).lastFailure!;
  assert.equal(last.plain, 'не доделано — исполнитель не доделал работу: «Успел половину»');
  h.close();
});

/** Минимальное представление для решения о повторе: попытки одного поручения. */
const viewOf = (work: WorkState, attempts: Partial<AttemptState>[]) =>
  ({
    attempts: () => attempts as AttemptState[],
    work: () => work,
  }) as unknown as ExecutionView;
const gateFail = (id: string, failed: string[]): Partial<AttemptState> => ({
  id,
  status: 'failed',
  failureKind: 'gate',
  failureFingerprint: id,
  episodeBasis: 'b',
  evidence: [
    {
      kind: 'test',
      passed: false,
      tests: failed.map((t) => ({ id: t, status: 'failed' as const })),
    } as unknown as AttemptState['evidence'][number],
  ],
});

test('WB04: тот же упавший testcase дважды подряд — к ведущему, а не последняя попытка', () => {
  const work = {
    id: 'w',
    status: 'failed',
    attempt: 2,
    failureKind: 'gate',
    failureFingerprint: 'a2',
    failure: 'gate test failed',
  } as unknown as WorkState;
  const same = viewOf(work, [
    gateFail('a1', ['t.not-found', 't.home']),
    gateFail('a2', ['t.not-found']),
  ]);
  assert.deepEqual(repeatedTestcase(same, work), {
    testcases: ['t.not-found'],
    runs: ['a1', 'a2'],
  });
  const decision = repairDecision(same, [work], {
    budgetLeft: 6,
    maxAttempts: 3,
    blocking: () => undefined,
  })!;
  assert.equal(decision.action, 'stop');
  assert.match(decision.reason, /тот же testcase упал второй раз подряд \(t\.not-found/);
  // Нейтральный отказ между ними счёт не рвёт; другой testcase — обычный повтор.
  const neutral: Partial<AttemptState> = {
    id: 'n',
    status: 'failed',
    failureKind: 'environment',
    episodeBasis: 'b',
    evidence: [],
  };
  assert.ok(
    repeatedTestcase(
      viewOf(work, [gateFail('a1', ['t.x']), neutral, gateFail('a2', ['t.x'])]),
      work,
    ),
  );
  const other = viewOf(work, [gateFail('a1', ['t.home']), gateFail('a2', ['t.not-found'])]);
  assert.equal(repeatedTestcase(other, work), undefined);
  assert.equal(
    repairDecision(other, [work], { budgetLeft: 6, maxAttempts: 3, blocking: () => undefined })!
      .action,
    'retry',
  );
});

test('WB05: запрос исполнителя — «сначала код, потом вопрос» при закрытом окружением шаге', () => {
  assert.match(ENVIRONMENT_BLOCK_WRITER_TEXT, /Implement the work order first/);
  assert.match(ENVIRONMENT_BLOCK_WRITER_TEXT, /impact "technical"/);
  assert.match(
    ENVIRONMENT_BLOCK_WRITER_TEXT,
    /Never return completed=false for an environment reason/,
  );
});
