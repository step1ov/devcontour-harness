/**
 * alpha.60: `status --human`, `explain` и представление оператора говорят
 * правду о том, кто сейчас действует. Ревью плана в живом run — ход harness,
 * а не ведущего (F-G); очередь без запущенного процесса — «стоит», а не
 * «идёт» (F-X); идущая последняя попытка — не «нужен ваш сброс» (F-V, F-AG);
 * ответ у идущей попытки — передан (F-AG); ожидание зависимости — не разбор
 * ведущего и без чужого времени (F-Z); порядок блокировок разных людей и
 * человеческое предупреждение о `--policy` (F-AJ); одна формулировка расхода
 * и граница не `exact`, пока попытка идёт (F-N); класс отказа и засчитанность
 * попытки фактами (P13).
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPERATOR_VIEW_REVISION,
  cliDataSchemas,
  operatorViewSchema,
  type AttemptState,
} from '../src/contracts/index.ts';
import { carriedInput, statusOf, statusText } from '../src/control/status.ts';
import { spendText } from '../src/control/stage.ts';
import { collectOperatorViewInput, viewPolicy } from '../src/control/operator-view.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { boundedUsd, carrierLine, operatorView } from '../src/projections/operator-view.ts';
import { attemptCounted } from '../src/report/compute.ts';
import { CURRENT_PROCESS } from '../src/environment/live-calls.ts';
import { endActive, startActive } from '../src/engine/usage.ts';
import { attemptLine } from '../src/contracts/attempt-line.ts';
import { unknownUsage } from '../src/agents/usage.ts';
import { engineOf, graphOf, policyOf, ready, trustNone } from './engine-fixture.ts';
import { baseInput, work } from './operator-view-input.ts';
import type { Engine } from '../src/engine/engine.ts';

const noJobs = { list: () => [], continues: () => false };
const sourceOf = (engine: Engine) => ({ engine, policy: engine.policy, workflows: noJobs });
const status = (engine: Engine) => cliDataSchemas.status.parse(statusOf(sourceOf(engine)));
const viewOf = (env: ReturnType<typeof engineOf>) =>
  operatorView(
    collectOperatorViewInput(
      {
        engine: env.engine,
        policy: env.engine.policy,
        workflows: noJobs as never,
        stateDir: env.dir,
        baseDir: env.dir,
      },
      { warnings: [], baseDir: env.dir },
    ),
  );

/** Открытый вызов ревью плана графа в этом (живом) процессе. */
function livePlanReview(env: ReturnType<typeof engineOf>, graphId: string) {
  const call = env.engine.beginCall(
    {
      id: `call-plan-${graphId}`,
      stage: 'plan-review',
      subjectId: graphId,
      runtime: 'codex',
      model: null,
      runtimeVersion: null,
      startedAt: new Date(env.clock.now).toISOString(),
      outcome: 'active',
      process: { ...CURRENT_PROCESS },
      promptBytes: 1,
      promptDigest: 'd'.repeat(64),
      usage: unknownUsage(),
      costUsd: null,
      costSource: 'unknown',
    } as never,
    { stage: 'plan-review', subjectId: graphId },
  );
  startActive(call.id);
  return call;
}

test('F-G: ревью плана в живом run — этап plan-review, действует harness, не ведущий', () => {
  const env = engineOf();
  const { graph } = env.engine.register(graphOf({ a: [] }), trustNone);
  const call = livePlanReview(env, graph.id);
  try {
    const data = status(env.engine);
    const a = data.works[0]!;
    assert.equal(a.stage!.name, 'plan-review');
    assert.deepEqual(a.stage!.needs, { actor: 'controller', action: 'review-plan' });
    assert.match(
      a.stage!.line,
      /^a: идёт ревью плана — .*от вас: ничего — harness сам \(идёт ревью плана\)/,
    );
    const approval = a.blockers.find((b) => b.code === 'APPROVAL_REQUIRED')!;
    assert.equal(approval.actor, 'controller');
    assert.match(approval.plain!, /идёт ревью плана/);
    assert.equal(data.runner?.state, 'running');
    assert.deepEqual(
      data.runner?.planReviews?.map((r) => r.graphId),
      [graph.id],
    );
    const human = statusText(data);
    assert.match(
      human.split('\n')[0]!,
      /^Идёт ревью плана g — выдача начнётся после согласования; от вас ничего не нужно\.$/,
    );
    assert.doesNotMatch(human.split('\n')[0]!, /harness run/);
    assert.doesNotMatch(human, /ход ведущего \(согласовать план\)/);
    assert.doesNotMatch(human, /Выдача на паузе/);
    // explain: тот же ход harness.
    const d = explainStop(
      stopInputsOf(sourceOf(env.engine), { maxAttempts: 3, repairBudget: 2 }).find(
        (i) => i.kind === 'work',
      )!,
    );
    assert.deepEqual([d.actor, d.action], ['controller', 'review-plan']);
  } finally {
    endActive(call.id);
  }
  // Вызов закончился (процесс его больше не ведёт) — снова ход ведущего.
  const after = status(env.engine).works[0]!;
  assert.notEqual(after.stage!.name, 'plan-review');
});

test('F-G: ревью плана не прячет ход людей — исчерпание и отказ остаются впереди', () => {
  const env = engineOf(policyOf((p) => (p.maxAttempts = 1)));
  ready(env.engine, graphOf({ a: [], b: [] }));
  const a = env.engine.claim('c1')!;
  env.engine.fail(a.id, a.token, 'gate unit failed', { kind: 'gate' });
  // Новое ревью плана того же графа (review-plan, input-resolve, run).
  const call = livePlanReview(env, 'g');
  try {
    const data = status(env.engine);
    const wa = data.works.find((w) => w.id === 'a')!;
    assert.deepEqual(wa.stage!.needs, { actor: 'user', action: 'reset-attempts' });
    assert.equal(wa.stage!.name, 'stopped');
    assert.equal(wa.blockers.find((b) => b.code === 'ATTEMPTS_EXHAUSTED')!.actor, 'user');
    const d = explainStop(
      stopInputsOf(sourceOf(env.engine), { maxAttempts: 1, repairBudget: 2, workId: 'a' }).find(
        (i) => i.kind === 'work',
      )!,
    );
    assert.deepEqual([d.actor, d.action], ['user', 'reset-attempts']);
    assert.equal(data.runner?.state, 'running');
    assert.match(data.runner.line, /^Идёт ревью плана g — .*ещё нужно от вас \(см\. работы\)\.$/);
    assert.doesNotMatch(data.runner.line, /ничего не нужно/);
  } finally {
    endActive(call.id);
  }
});

test('F-X: никто не запущен — очередь стоит, перезапуск делает ведущий; в представлении runner', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [] }));
  env.engine.release('c1');
  const data = status(env.engine);
  assert.equal(data.control.paused, false);
  assert.equal(data.runner?.state, 'not-running');
  assert.equal(data.runner?.restartBy, 'lead');
  const human = statusText(data);
  assert.match(human.split('\n')[0]!, /^Очередь стоит — никто не запущен: .*harness run/);
  assert.doesNotMatch(human, /Выдача идёт/);
  const view = viewOf(env);
  assert.ok(operatorViewSchema.safeParse(view).success);
  assert.equal(view.viewRevision, OPERATOR_VIEW_REVISION);
  assert.equal(OPERATOR_VIEW_REVISION, 10);
  assert.equal(view.progress.queue.paused, false);
  assert.equal(view.progress.queue.runner, 'not-running');
  assert.equal(view.progress.queue.restartBy, 'lead');
  assert.match(view.progress.queue.line!, /^Очередь стоит — никто не запущен/);
  // Controller запущен — очередь идёт.
  env.engine.lead('c2');
  assert.equal(status(env.engine).runner?.state, 'running');
});

test('F-V/F-AG: идёт последняя попытка — не «нужен ваш сброс», строка попыток согласована', () => {
  const env = engineOf(policyOf((p) => (p.maxAttempts = 2)));
  ready(env.engine, graphOf({ a: [] }));
  const first = env.engine.claim('c1')!;
  env.engine.fail(first.id, first.token, 'gate unit failed', { kind: 'gate' });
  env.engine.retry('a');
  const second = env.engine.claim('c1')!;
  assert.ok(second);
  const data = status(env.engine);
  const a = data.works[0]!;
  const exhausted = a.blockers.find((b) => b.code === 'ATTEMPTS_EXHAUSTED')!;
  assert.equal(exhausted.actor, 'controller');
  assert.match(exhausted.plain!, /^идёт последняя попытка \(2 из 2\)/);
  assert.match(a.attemptSummary!.line, /идёт последняя засчитанная попытка \(2 из 2\)$/);
  assert.doesNotMatch(a.attemptSummary!.line, /осталось попыток 0/);
  const human = statusText(data);
  assert.doesNotMatch(human, /нужен ваш сброс/);
  assert.match(human, /от вас: ничего/);
  // Попытка закончилась отказом — теперь сброс действительно за человеком.
  env.engine.fail(second.id, second.token, 'gate unit failed', { kind: 'gate' });
  const stopped = status(env.engine).works[0]!;
  const after = stopped.blockers.find((b) => b.code === 'ATTEMPTS_EXHAUSTED')!;
  assert.equal(after.actor, 'user');
  assert.match(after.plain!, /нужен ваш сброс/);
  assert.match(stopped.attemptSummary!.line, /осталось попыток 0 из 2$/);
});

test('F-AG: применённый ответ у идущей попытки — delivered; у закончившейся — его получит следующая', () => {
  const attempt = (status: AttemptState['status']) =>
    ({ id: 'r3', attempt: 3, status, input: { requestId: 'Q1' } }) as unknown as AttemptState;
  const input = { requestId: 'Q1', state: 'applied-awaiting-claim' };
  assert.deepEqual(carriedInput(input, [attempt('active')]), {
    requestId: 'Q1',
    state: 'delivered',
    carrier: { attempt: 3, running: true },
  });
  assert.deepEqual(carriedInput(input, [attempt('failed')]), {
    ...input,
    carrier: { attempt: 3, running: false },
  });
  assert.equal(carriedInput(input, []), input);
  // Ответ передан закончившейся попытке (потом упал gate): не «получит следующая».
  const delivered = carriedInput({ requestId: 'Q1', state: 'delivered' }, [attempt('failed')]);
  assert.deepEqual(delivered?.carrier, { attempt: 3, running: false });
  assert.equal(carrierLine(delivered.carrier, 'ru', 'delivered'), 'ответ передан попытке 3');
  assert.match(
    carrierLine({ attempt: 3, running: false }, 'ru', 'applied-awaiting-claim')!,
    /получит следующая попытка$/,
  );
  // Последняя попытка выдана без ответа: где ответ, по ней не сказать.
  const without = {
    id: 'r4',
    attempt: 4,
    status: 'active',
  } as unknown as AttemptState;
  assert.equal(carriedInput(input, [attempt('failed'), without]), input);
  // Представление: строка вопроса называет, где ответ.
  const view = operatorView(
    baseInput({
      works: [
        work('w', {
          input: {
            requestId: 'Q1',
            state: 'delivered',
            severity: 5,
            carrier: { attempt: 3, running: true },
          },
        }),
      ],
    }),
  );
  assert.ok(operatorViewSchema.safeParse(view).success);
  assert.deepEqual(view.works[0]!.question, {
    requestId: 'Q1',
    state: 'delivered',
    severity: 5,
    line: 'ответ у идущей попытки 3 — ждать нечего',
  });
});

test('F-Z: ожидание зависимости — не разбор ведущего; кто действует — по самой зависимости', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [], b: ['a'] }));
  const a = env.engine.claim('c1')!;
  env.engine.fail(a.id, a.token, 'непонятный отказ', { kind: 'unknown' });
  const inputs = stopInputsOf(sourceOf(env.engine), { maxAttempts: 3, repairBudget: 2 });
  const b = explainStop(inputs.find((i) => i.kind === 'work' && i.work.id === 'b')!);
  assert.deepEqual([b.code, b.actor, b.action], ['NOT_READY', null, 'wait']);
  assert.match(b.message, /Ждёт a: сама эта работа ничего не требует/);
  // В представлении: эскалации только по самой зависимости (без времени run у b).
  const view = viewOf(env);
  assert.deepEqual(
    view.escalations.map((e) => e.workId),
    ['a'],
  );
});

test('F-AJ: блокировки разных людей — по порядку: сначала ведущий (согласование), затем вы', () => {
  const data = status(engineOf().engine);
  const human = statusText({
    ...data,
    works: [
      {
        id: 'w',
        graphId: 'g',
        status: 'failed',
        attempt: 3,
        blockers: [
          {
            code: 'ATTEMPTS_EXHAUSTED',
            message: 'Исчерпано 3 из 3 попыток',
            plain: 'попытки исчерпаны (3 из 3) — нужен ваш сброс попыток',
            plainEn: 'x',
            actor: 'user',
            step: 2,
          },
          {
            code: 'APPROVAL_STALE',
            message: 'Политика изменилась',
            plain: 'политика изменилась после согласования — нужно согласовать план заново',
            plainEn: 'x',
            actor: 'lead',
            step: 1,
          },
        ],
      },
    ],
  });
  assert.match(
    human,
    /не выдаётся: сначала ведущий: политика изменилась после согласования — нужно согласовать план заново; затем вы: попытки исчерпаны \(3 из 3\)/,
  );
  // Предупреждение о --policy — фразой для человека, без кода и «представление построено».
  const dir = mkdtempSync(join(tmpdir(), 'harness-a60-policy-'));
  writeFileSync(join(dir, 'binding.json'), JSON.stringify({ policy: policyOf(), baseDir: dir }));
  writeFileSync(join(dir, 'other.json'), JSON.stringify(policyOf((p) => (p.maxAttempts = 5))));
  const w = viewPolicy(dir, join(dir, 'other.json')).warnings[0]!;
  assert.equal(w.code, 'POLICY_DIGEST_MISMATCH');
  assert.match(
    w.message,
    /^Файл политики, переданный панели, отличается от политики, с которой работает harness/,
  );
  assert.doesNotMatch(w.message, /представление построено/);
  assert.ok(w.message.length <= 200);
});

test('F-N: одна формулировка расхода; неизвестная стоимость и идущая попытка — не exact', () => {
  assert.equal(spendText({ calls: 0, knownUsd: 0, unknownCalls: 0 }, 'ru'), '$0.00, вызовов 0');
  assert.equal(
    spendText({ calls: 0, knownUsd: 0, unknownCalls: 0 }, 'ru', true),
    'неизвестно, вызовов 0',
  );
  assert.equal(
    spendText({ calls: 1, knownUsd: 0, unknownCalls: 1 }, 'ru'),
    'неизвестно, вызовов 1 (без стоимости 1)',
  );
  assert.equal(
    spendText({ calls: 2, knownUsd: 0.5, unknownCalls: 1 }, 'en'),
    '≥$0.50, 2 calls (1 without cost)',
  );
  assert.deepEqual(boundedUsd({ knownUsd: 0, knownCalls: 0, unknownCalls: 0, running: true }), {
    value: 0,
    bound: 'unknown',
  });
  assert.deepEqual(boundedUsd({ knownUsd: 0.5, knownCalls: 1, unknownCalls: 0, running: true }), {
    value: 0.5,
    bound: 'lower',
  });
  // Идущая попытка runtime по подписке без записанных вызовов: в статусе и в представлении — «неизвестно».
  const env = engineOf();
  ready(env.engine, graphOf({ a: [] }));
  env.engine.claim('c1');
  const a = status(env.engine).works[0]!;
  assert.match(a.stage!.line, /потрачено: неизвестно, вызовов 0/);
  const view = viewOf(env);
  assert.deepEqual(view.works[0]!.spend.usd, { value: 0, bound: 'unknown' });
});

test('P13: класс отказа и засчитанность попытки — фактами в attempts.lastFailure', () => {
  const a = (over: Partial<AttemptState>) =>
    ({ id: 'x', status: 'failed', ...over }) as unknown as AttemptState;
  assert.equal(attemptCounted(a({ failureKind: 'gate' }), [], 3), true);
  assert.equal(attemptCounted(a({ failureKind: 'environment' }), [], 3), false);
  assert.equal(attemptCounted(a({ failureKind: 'needs-lead', writerBlocked: true }), [], 3), false);
  assert.equal(attemptCounted(a({ failureKind: 'gate', blocked: true }), [], 3), false);
  const q = a({ failureKind: 'needs-input' });
  assert.equal(attemptCounted(q, [q], 3), false);
  const earlier = [1, 2, 3].map((n) => a({ id: `q${n}`, failureKind: 'needs-input' }));
  assert.equal(attemptCounted(q, [...earlier, q], 3), true, 'сверх предела остановок вопросом');
  // Через загрузчик: отказ окружения не засчитан.
  const env = engineOf();
  ready(env.engine, graphOf({ a: [] }));
  const run = env.engine.claim('c1')!;
  env.engine.fail(run.id, run.token, 'порт занят', { kind: 'environment', blocked: true });
  const view = viewOf(env);
  assert.ok(operatorViewSchema.safeParse(view).success);
  const last = view.works[0]!.attempts.lastFailure!;
  assert.deepEqual([last.kind, last.counted], ['environment', false]);
  env.engine.resume();
  env.engine.retry('a', { reason: 'порт освобождён' });
  const next = env.engine.claim('c1')!;
  env.engine.fail(next.id, next.token, 'gate unit failed', { kind: 'gate' });
  const gate = viewOf(env).works[0]!.attempts.lastFailure!;
  assert.deepEqual([gate.kind, gate.counted], ['gate', true]);
});

test('attemptLine: «осталось 0» не стоит рядом с идущей попыткой на пределе', () => {
  const facts = {
    total: 4,
    active: 1,
    failed: 2,
    failures: [{ key: 'gate', count: 2 }],
    timeouts: 0,
    interrupted: 0,
    accepted: 0,
    attempts: { used: 3, max: 3 },
  };
  assert.equal(
    attemptLine(facts, 'ru'),
    'запусков 4 (идёт 1), из них засчитано попыток 3; отказов 2 (gate 2); по времени 0; прервано остановкой 0; принято 0; идёт последняя засчитанная попытка (3 из 3)',
  );
  assert.match(attemptLine(facts, 'en'), /the last counted attempt is running \(3 of 3\)$/);
  assert.match(attemptLine({ ...facts, active: 0 }, 'ru'), /осталось попыток 0 из 3$/);
});
