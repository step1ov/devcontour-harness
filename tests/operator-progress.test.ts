/**
 * H12 и H15: вопрос исполнителя к человеку отвечает человек (ведущий —
 * только с разрешения политики), кто ответил — видно в status, explain,
 * пакете передачи и отчёте; `status` называет этап поручения простыми
 * словами (этап и время в нём, что дальше, что нужно от оператора, расход).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HarnessError,
  cliDataSchemas,
  type CallRecord,
  type InputOutcome,
  type InputQuestion,
} from '../src/contracts/index.ts';
import { digestOf } from '../src/contracts/digest.ts';
import { statusOf, statusSettled, statusText } from '../src/control/status.ts';
import { durationText, stageLine, stageOfStep, workStageOf } from '../src/control/stage.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { handoffPack } from '../src/handoff/pack.ts';
import { handoffMarkdown } from '../src/handoff/markdown.ts';
import { collectReportInput } from '../src/control/report.ts';
import { valueReport, reportHtml, reportMarkdown } from '../src/report/index.ts';
import { engineOf, graphOf, planReview, policyOf, ready, trustNone } from './engine-fixture.ts';

const question = (severity: number): InputQuestion => ({
  question: 'Какой формат приветствия?',
  options: [
    { id: 'hello', label: 'Hello, <name>!', consequence: null },
    { id: 'hi', label: 'Hi <name>', consequence: null },
  ],
  recommended: 'hello',
  severity,
  rationale: 'Текст виден пользователю',
  affects: [],
});

const outcome = (severity: number): InputOutcome => ({
  question: {
    question: question(severity),
    effectiveSeverity: severity,
    floors: [],
    mode: 'request',
  },
  assumptions: [],
  followUps: [],
  criticalHits: [],
  callId: 'call-1',
});

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    return e.code;
  }
};

/** Заданий графов нет: диагноз explain без восстановлений группы. */
const noJobs = { list: () => [], continues: () => false };

/** Граф w; попытка остановилась блокирующим вопросом серьёзности `severity`. */
function stopped(severity = 8, patch: (p: Record<string, unknown>) => void = () => {}) {
  const env = engineOf(policyOf(patch));
  ready(env.engine, graphOf({ w: [] }));
  const attempt = env.engine.claim('c1')!;
  env.engine.fail(attempt.id, attempt.token, 'вопрос', {
    kind: 'needs-input',
    input: outcome(severity),
  });
  const [request] = env.engine.inputRequests({ workId: 'w' });
  return { ...env, attempt, request: request! };
}

test('H12: ответ ведущего на блокирующий вопрос без разрешения политики — OPERATOR_ANSWER_REQUIRED без записи', () => {
  const env = stopped();
  const id = env.request.id;
  assert.equal(env.request.blocking, true);
  let error = new HarnessError('INTERNAL', 'не брошено');
  try {
    env.engine.answerInput(id, { text: 'Hello', actor: { kind: 'lead' } }, 1);
  } catch (e) {
    error = e as HarnessError;
  }
  assert.equal(error.code, 'OPERATOR_ANSWER_REQUIRED');
  assert.equal(error.class, 'refused');
  assert.match(error.message, /input-answer --actor operator/);
  assert.match(error.message, /inputPolicy\.leadAnswers/);
  const after = env.engine.inputRequest(id);
  assert.equal(after.version, 1, 'запрос не изменён');
  assert.deepEqual(after.answers, []);
  assert.equal(after.lifecycle, 'pending');
  // Хост от имени человека и сам человек отвечают как прежде.
  const ok = env.engine.answerInput(id, { text: 'Hello', actor: { kind: 'operator' } }, 1);
  assert.equal(ok.request.answers[0]!.actor.kind, 'operator');
  const host = env.engine.answerInput(id, { text: 'Hi', actor: { kind: 'host' } }, 2);
  assert.equal(host.changed, true);
});

test('H12: leadAnswers разрешает ведущему ответ только до порога серьёзности; порог не закрепляется в попытке', () => {
  const below = stopped(
    8,
    (p) => (p.inputPolicy = { threshold: 7, leadAnswers: { maxSeverity: 7 } }),
  );
  assert.equal(
    code(() =>
      below.engine.answerInput(below.request.id, { text: 'Hello', actor: { kind: 'lead' } }, 1),
    ),
    'OPERATOR_ANSWER_REQUIRED',
  );
  const within = stopped(
    8,
    (p) => (p.inputPolicy = { threshold: 7, leadAnswers: { maxSeverity: 8 } }),
  );
  const answered = within.engine.answerInput(
    within.request.id,
    { text: 'Hello', actor: { kind: 'lead' } },
    1,
  );
  assert.equal(answered.request.answers[0]!.actor.kind, 'lead');
  // Разрешение — правило приёма ответа, а не исполнения: в попытку и в
  // основание вопроса оно не пишется (прежние версии читают записи).
  const attempt = within.engine.read((v) => v.attempt(within.attempt.id))!;
  assert.deepEqual(attempt.inputPolicy, { threshold: 7, criticalPaths: [] });
  assert.deepEqual(within.request.originBasis.inputPolicy, { threshold: 7, criticalPaths: [] });
});

test('H12: повтор прежнего ответа ведущего после отзыва разрешения — отказ, а не подтверждение', () => {
  const allowed = stopped(
    8,
    (p) => (p.inputPolicy = { threshold: 7, leadAnswers: { maxSeverity: 10 } }),
  );
  allowed.engine.answerInput(allowed.request.id, { text: 'Hello', actor: { kind: 'lead' } }, 1);
  allowed.store.close();
  // Тот же каталог состояния, политика без разрешения.
  const revoked = engineOf(
    policyOf((p) => (p.inputPolicy = { threshold: 7 })),
    allowed.dir,
  );
  assert.equal(
    code(() =>
      revoked.engine.answerInput(allowed.request.id, { text: 'Hello', actor: { kind: 'lead' } }, 2),
    ),
    'OPERATOR_ANSWER_REQUIRED',
  );
  revoked.store.close();
});

test('H12: неблокирующий запрос ведущему (follow-up) ведущий отвечает без разрешения', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  const attempt = env.engine.claim('c1')!;
  env.engine.recordAssumptions(attempt.id, attempt.token, {
    assumptions: [],
    followUps: [{ question: question(3), effectiveSeverity: 10, floors: ['declared'] }],
    criticalHits: [],
    callId: null,
  });
  const follow = env.engine.inputRequests({ workId: 'w' }).find((r) => r.kind === 'follow-up')!;
  assert.equal(follow.blocking, false);
  const r = env.engine.answerInput(follow.id, { text: 'оставить', actor: { kind: 'lead' } }, 1);
  assert.equal(r.request.answers[0]!.actor.kind, 'lead');
});

test('H12: кто ответил — в status, status --human, explain, пакете передачи и отчёте', () => {
  const env = stopped();
  const { engine } = env;
  const policy = engine.policy;
  const source = { engine, policy, workflows: noJobs };
  // До ответа: explain передаёт вопрос, варианты и рекомендацию и адресует человеку.
  const before = statusOf(source);
  assert.equal(before.works[0]!.input?.answeredBy, undefined);
  assert.match(statusText(cliDataSchemas.status.parse(before)), /ждёт ответа человека/);
  const diagnose = () =>
    stopInputsOf(source, { maxAttempts: policy.maxAttempts, repairBudget: policy.repairBudget })
      .filter((i) => i.kind === 'work')
      .map(explainStop)[0]!;
  const waiting = diagnose();
  assert.deepEqual([waiting.actor, waiting.action], ['user', 'answer-input']);
  assert.match(waiting.message, /рекомендация исполнителя: hello/);
  assert.match(waiting.message, /--actor operator/);

  engine.answerInput(env.request.id, { text: 'Hello', actor: { kind: 'operator' } }, 1);
  const after = cliDataSchemas.status.parse(statusOf(source));
  assert.equal(after.works[0]!.input?.answeredBy, 'operator');
  assert.match(
    statusText(after),
    /вопрос IR-[a-f0-9]+ \[answered-not-applied, серьёзность 8\]: ответил оператор/,
  );
  assert.match(diagnose().message, /\(ответил: оператор\) записан, но не применён/);

  const pack = handoffPack(source);
  assert.equal(pack.inputs?.[0]?.answer?.by, 'operator');
  assert.match(handoffMarkdown(pack), /\(ответил: оператор\)/);

  const report = valueReport(collectReportInput(env.store), {
    stateDir: env.dir,
    harnessVersion: 'test',
    asOf: '2026-01-02T00:00:00.000Z',
  });
  assert.deepEqual(report.inputs?.answeredBy, { operator: 1, lead: 0, host: 0, leadTechnical: 0 });
  assert.match(
    reportMarkdown(report),
    /Executor questions that stopped an attempt: 1 \(answered by the operator 1, by the lead agent 0\)/,
  );
});

/* ------------------------------------------------------------------ */
/* H15: этап поручения                                                  */
/* ------------------------------------------------------------------ */

test('H15: имя замера → этап; интеграция по фазе', () => {
  assert.equal(stageOfStep('implementation'), 'writer');
  assert.equal(stageOfStep('implementation-reuse'), 'writer');
  assert.equal(stageOfStep('writer-dependencies'), 'prepare');
  assert.equal(stageOfStep('candidate-test:lint'), 'gates');
  // Окружение кандидата охватывает всю фазу: setup/ready — до исполнителя,
  // cleanup — после ревью (этап по статусу поручения).
  assert.equal(stageOfStep('candidate-environment:setup'), 'prepare');
  assert.equal(stageOfStep('candidate-environment:ready'), 'prepare');
  assert.equal(stageOfStep('candidate-environment:port-shared:3000'), 'prepare');
  assert.equal(stageOfStep('candidate-environment:cleanup'), undefined);
  assert.equal(stageOfStep('dependency-store'), 'prepare');
  // Шаги prepare — своя стадия (0.1.0-alpha.59); на integration — интеграция.
  assert.equal(stageOfStep('prepare'), 'prepare');
  assert.equal(stageOfStep('integration-prepare'), 'integration');
  assert.equal(stageOfStep('integration-prepare:api'), 'integration');
  assert.equal(stageOfStep('generate:api'), 'gates');
  assert.equal(stageOfStep('candidate-review'), 'review');
  assert.equal(stageOfStep('integration-test:unit'), 'integration');
  assert.equal(stageOfStep('integration-review'), 'integration');
  assert.equal(durationText(252_000, 'ru'), '4 мин 12 с');
  assert.equal(durationText(252_000, 'en'), '4m 12s');
  assert.equal(durationText(3_780_000, 'ru'), '1 ч 3 мин');
  assert.equal(durationText(9_400, 'en'), '9s');
});

const call = (id: string, patch: Partial<CallRecord> = {}): CallRecord => ({
  id,
  stage: 'implementation',
  runtime: 'claude',
  model: null,
  runtimeVersion: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  outcome: 'returned',
  durationMs: 60_000,
  promptBytes: 1,
  promptDigest: digestOf(id),
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedUsd: 0.25,
    complete: true,
    source: 'fixture',
  },
  costUsd: 0.25,
  costSource: 'provider-reported',
  ...patch,
});

test('H15: идущая попытка — этап по открытому замеру, время в нём, что дальше, расход; строка ru и en', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  const attempt = env.engine.claim('c1')!;
  env.engine.timingStarted(attempt.id, attempt.token, 'implementation');
  // Владение продлевается heartbeat, пока идут 4 мин 12 с.
  for (let i = 0; i < 12; i++) {
    env.clock.now += 21_000;
    env.engine.heartbeat(attempt.id, attempt.token);
  }
  env.store.transact('run.context', (tx) => {
    tx.putLocal('usage', 'app', 'k1', call('k1', { runId: attempt.id, workId: 'w' }));
    tx.putLocal(
      'usage',
      'app',
      'k2',
      call('k2', { runId: attempt.id, workId: 'w', costUsd: null, costSource: 'unknown' }),
    );
    // Вызов о группе (ревью плана) — расход группы, не собственный.
    tx.putLocal('usage', 'app', 'k3', call('k3', { workIds: ['w'], stage: 'plan-review' }));
  });
  const data = cliDataSchemas.status.parse(
    statusOf({ engine: env.engine, policy: env.engine.policy, workflows: noJobs }),
  );
  const stage = data.works[0]!.stage!;
  assert.equal(stage.name, 'writer');
  assert.equal(stage.step, 'implementation');
  assert.equal(stage.elapsedMs, 252_000);
  assert.deepEqual(stage.next, ['gates', 'review', 'integration']);
  assert.deepEqual(stage.spend, { calls: 2, knownUsd: 0.25, unknownCalls: 1, durationMs: 120_000 });
  assert.deepEqual(stage.needs?.actor, 'controller');
  assert.equal(
    stage.line,
    'w: исполнитель пишет код (implementation) — 4 мин 12 с; дальше: проверки, ревью, интеграция; от вас: ничего; потрачено: ≥$0.25, вызовов 2 (без стоимости 1), время моделей 2 мин',
  );
  assert.equal(
    stage.lineEn,
    'w: writer coding (implementation) — 4m 12s; next: gates, review, integration; from you: nothing; spent: ≥$0.25, 2 calls (1 without cost), model time 2m',
  );
  assert.ok(statusText(data).includes(`  сейчас: ${stage.line.slice(3)}\n`));
  // Следующая стадия — проверки: этап и время сменились.
  env.engine.timingFinished(
    attempt.id,
    attempt.token,
    env.engine.read((v) => v.attempt(attempt.id))!.timings![0]!.id,
    'passed',
  );
  env.engine.timingStarted(attempt.id, attempt.token, 'candidate-test:lint');
  env.clock.now += 30_000;
  const gates = statusOf({ engine: env.engine, policy: env.engine.policy }).works[0]!.stage;
  assert.deepEqual(
    [gates.name, gates.step, gates.elapsedMs, gates.next],
    ['gates', 'candidate-test:lint', 30_000, ['review', 'integration']],
  );
  // Без заданий графов и без вопроса — что нужно, неизвестно (не «ничего»).
  assert.equal(gates.needs, undefined);
  assert.match(gates.line, /от вас: неизвестно \(см\. explain\)/);
});

test('H15: остановка вопросом — этап input, время ожидания, от вас — ответить; итог без времени', () => {
  const env = stopped();
  env.clock.now += 7_200_000;
  const source = { engine: env.engine, policy: env.engine.policy, workflows: noJobs };
  const stage = statusOf(source).works[0]!.stage;
  assert.equal(stage.name, 'input');
  assert.equal(stage.elapsedMs, 7_200_000);
  assert.deepEqual(stage.next, ['writer', 'gates', 'review', 'integration']);
  assert.deepEqual(stage.needs, { actor: 'user', action: 'answer-input' });
  assert.match(
    stage.line,
    /^w: ждёт ответа на вопрос исполнителя — 2 ч; .*от вас: ответить на вопрос исполнителя;/,
  );
  assert.match(stage.lineEn, /from you: answer the executor question;/);
  // Хост без заданий графов: открытый вопрос всё равно адресован человеку.
  assert.deepEqual(
    statusOf({ engine: env.engine, policy: env.engine.policy }).works[0]!.stage.needs,
    {
      actor: 'user',
      action: 'answer-input',
    },
  );
});

test('H15: workStageOf — ждёт выдачи, не выдаётся, принято, отменено', () => {
  const base = {
    attempts: [],
    records: [],
    now: Date.parse('2026-01-01T00:00:00.000Z'),
  };
  const work = (status: string) => ({ id: 'w', status }) as never;
  const queued = workStageOf({ ...base, work: work('ready'), blocked: false });
  assert.deepEqual([queued.name, queued.since, queued.next.length], ['queued', undefined, 4]);
  assert.equal(workStageOf({ ...base, work: work('ready'), blocked: true }).name, 'blocked');
  assert.equal(workStageOf({ ...base, work: work('draft'), blocked: false }).name, 'blocked');
  const done = workStageOf({
    ...base,
    work: work('done'),
    blocked: false,
    needs: { actor: null, action: 'none' },
  });
  assert.deepEqual([done.name, done.elapsedMs, done.next], ['done', undefined, []]);
  assert.equal(
    done.line,
    'w: принято; дальше: —; от вас: ничего; потрачено: $0.00, вызовов 0, время моделей 0 с',
  );
  assert.equal(
    stageLine('w', { ...done, needs: { actor: 'lead', action: 'diagnose-failure' } }, 'ru'),
    'w: принято; дальше: —; от вас: ничего — ход ведущего (разобрать отказ); потрачено: $0.00, вызовов 0, время моделей 0 с',
  );
  assert.equal(workStageOf({ ...base, work: work('cancelled'), blocked: false }).name, 'cancelled');
});

test('H15: statusSettled — идущая попытка не успокоилась; живой controller сдвинет поручение без решения человека', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  const now = env.clock.now;
  const source = { engine: env.engine, policy: env.engine.policy, workflows: noJobs };
  // Controller c1 жив (ready), поручение ждёт выдачи — сдвинется.
  const queued = cliDataSchemas.status.parse(statusOf(source));
  assert.equal(statusSettled(queued, now), false);
  // Без живого controller ждущее выдачи само не сдвинется.
  assert.equal(statusSettled(queued, queued.controller!.leaseUntil + 1), true);
  const attempt = env.engine.claim('c1')!;
  const active = cliDataSchemas.status.parse(statusOf(source));
  assert.equal(statusSettled(active, active.controller!.leaseUntil + 1), false, 'идёт попытка');
  env.engine.fail(attempt.id, attempt.token, 'вопрос', { kind: 'needs-input', input: outcome(8) });
  // Ждёт человека: живой controller его не сдвинет.
  const asking = cliDataSchemas.status.parse(statusOf(source));
  assert.equal(statusSettled(asking, now), true);
});

test('H15: statusSettled — попытка умершего владельца без живого controller сама не продолжится', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  const attempt = env.engine.claim('c1')!;
  const source = { engine: env.engine, policy: env.engine.policy, workflows: noJobs };
  const leases = cliDataSchemas.status.parse(statusOf(source));
  env.clock.now = Math.max(attempt.leaseUntil, leases.controller!.leaseUntil) + 1;
  const withDetail = cliDataSchemas.status.parse(statusOf(source, undefined, { detail: true }));
  assert.equal(withDetail.detail?.attempts[0]?.lease.stale, true);
  assert.equal(statusSettled(withDetail, env.clock.now), true);
  // Без detail свежесть владения неизвестна: активная попытка считается идущей.
  const plain = cliDataSchemas.status.parse(statusOf(source));
  assert.equal(statusSettled(plain, env.clock.now), false);
});

test('H15: открытый замер против статуса — интеграция по статусу, cleanup окружения — по статусу', () => {
  const now = Date.parse('2026-01-01T00:10:00.000Z');
  const active = (stage: string) =>
    ({
      id: 'r1',
      status: 'active',
      startedAt: '2026-01-01T00:00:00.000Z',
      timings: [{ id: 't1', stage, startedAt: '2026-01-01T00:09:00.000Z' }],
    }) as never;
  const work = (status: string) => ({ id: 'w', status, activeRunId: 'r1' }) as never;
  const base = { attempts: [], records: [], blocked: false, now };
  const of = (status: string, stage: string) =>
    workStageOf({ ...base, work: work(status), active: active(stage) });
  // Статус integrating важнее имени замера (окружение без префикса фазы).
  assert.deepEqual(
    [of('integrating', 'dependency-store').name, of('integrating', 'dependency-store').next],
    ['integration', []],
  );
  const cleanup = of('reviewing', 'candidate-environment:cleanup');
  assert.deepEqual(
    [cleanup.name, cleanup.step, cleanup.next],
    ['review', 'candidate-environment:cleanup', ['integration']],
  );
  const setup = of('running', 'candidate-environment:setup');
  assert.deepEqual(
    [setup.name, setup.next],
    ['prepare', ['writer', 'gates', 'review', 'integration']],
  );
  assert.equal(setup.elapsedMs, 60_000);
});

test('H15: расход — прежняя запись вызова без workId засчитывается по попытке; чужое поручение — нет', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [], x: [] }));
  const attempt = env.engine.claim('c1')!;
  env.store.transact('run.context', (tx) => {
    // Запись прежней версии: поручения нет, есть попытка.
    tx.putLocal('usage', 'app', 'old', call('old', { runId: attempt.id }));
    tx.putLocal(
      'usage',
      'app',
      'other',
      call('other', { workId: attempt.workId === 'w' ? 'x' : 'w' }),
    );
  });
  const works = statusOf({ engine: env.engine, policy: env.engine.policy }).works;
  const own = works.find((w) => w.id === attempt.workId)!;
  const other = works.find((w) => w.id !== attempt.workId)!;
  assert.deepEqual([own.stage.spend.calls, own.stage.spend.knownUsd], [1, 0.25]);
  assert.deepEqual([other.stage.spend.calls, other.stage.spend.knownUsd], [1, 0.25]);
  // Отбор графа не теряет расход своих поручений.
  const one = statusOf({ engine: env.engine, policy: env.engine.policy }, 'g').works;
  assert.equal(one.find((w) => w.id === attempt.workId)!.stage.spend.calls, 1);
});

test('H15: statusSettled — живое задание графа (восстановление группы) — ещё движение', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  const data = cliDataSchemas.status.parse(
    statusOf({ engine: env.engine, policy: env.engine.policy, workflows: noJobs }),
  );
  const later = data.controller!.leaseUntil + 1;
  assert.equal(statusSettled(data, later), true);
  assert.equal(statusSettled(data, later, { liveJobs: 1 }), false);
});

test('H12: отчёт считает ответивших по последнему ответу — оператор, ведущий, хост; строка и в html', () => {
  const env = engineOf(
    policyOf((p) => (p.inputPolicy = { threshold: 7, leadAnswers: { maxSeverity: 10 } })),
  );
  ready(env.engine, graphOf({ a: [], b: [], c: [] }));
  for (const actor of ['operator', 'lead', 'host'] as const) {
    const attempt = env.engine.claim('c1')!;
    env.engine.fail(attempt.id, attempt.token, 'вопрос', {
      kind: 'needs-input',
      input: outcome(8),
    });
    const [request] = env.engine.inputRequests({ workId: attempt.workId });
    env.engine.answerInput(request!.id, { text: 'Hello', actor: { kind: actor } }, 1);
  }
  const report = valueReport(collectReportInput(env.store), {
    stateDir: env.dir,
    harnessVersion: 'test',
    asOf: '2026-01-02T00:00:00.000Z',
  });
  assert.deepEqual(report.inputs?.answeredBy, { operator: 1, lead: 1, host: 1, leadTechnical: 0 });
  const line =
    'Executor questions that stopped an attempt: 3 (answered by the operator 1, by the lead agent 1, by the host 1)';
  assert.ok(reportMarkdown(report).includes(line));
  assert.ok(reportHtml(report).includes(line));
});

test('H12: порог разрешения — по действующей серьёзности (поднятой минимумом), а не по самооценке', () => {
  const raised = (cap: number) => {
    const env = engineOf(
      policyOf((p) => (p.inputPolicy = { threshold: 7, leadAnswers: { maxSeverity: cap } })),
    );
    ready(env.engine, graphOf({ w: [] }));
    const attempt = env.engine.claim('c1')!;
    env.engine.fail(attempt.id, attempt.token, 'вопрос', {
      kind: 'needs-input',
      input: {
        ...outcome(3),
        question: {
          question: { ...question(3), affects: ['api'] },
          effectiveSeverity: 10,
          floors: ['declared'],
          mode: 'request',
        },
      },
    });
    const [request] = env.engine.inputRequests({ workId: 'w' });
    assert.deepEqual([request!.question.severity, request!.effectiveSeverity], [3, 10]);
    return code(() =>
      env.engine.answerInput(request!.id, { text: 'Hello', actor: { kind: 'lead' } }, 1),
    );
  };
  assert.equal(raised(9), 'OPERATOR_ANSWER_REQUIRED');
  assert.equal(raised(10), 'ok');
});

test('H12: отчёт и статус называют актёра последнего ответа, а не первого', () => {
  const env = stopped(
    8,
    (p) => (p.inputPolicy = { threshold: 7, leadAnswers: { maxSeverity: 10 } }),
  );
  env.engine.answerInput(env.request.id, { text: 'Hello', actor: { kind: 'operator' } }, 1);
  env.engine.answerInput(env.request.id, { text: 'Hi', actor: { kind: 'lead' } }, 2);
  const report = valueReport(collectReportInput(env.store), {
    stateDir: env.dir,
    harnessVersion: 'test',
    asOf: '2026-01-02T00:00:00.000Z',
  });
  assert.deepEqual(report.inputs?.answeredBy, { operator: 0, lead: 1, host: 0, leadTechnical: 0 });
  assert.equal(
    statusOf({ engine: env.engine, policy: env.engine.policy }).works[0]!.input?.answeredBy,
    'lead',
  );
});

test('H15: отменённое без ждущих — needs none, как у доски explain (не диагноз выбранной работы)', () => {
  // Согласование оператора устарело для новой политики: выбранная работа x
  // получила бы review-plan, доска её не называет.
  const env = engineOf(policyOf((p) => (p.approvalMode = 'operator')));
  const { graph } = env.engine.register(graphOf({ w: [], x: [] }), trustNone);
  env.engine.recordReview(planReview(env.engine, graph, 1));
  env.engine.approve(graph.id, 'operator');
  env.engine.cancel('x', 'не нужно', 'operator');
  env.store.close();
  const next = engineOf(
    policyOf((p) => {
      p.approvalMode = 'operator';
      p.maxAttempts = 5;
    }),
    env.dir,
  );
  const source = { engine: next.engine, policy: next.engine.policy, workflows: noJobs };
  const limits = { maxAttempts: 5, repairBudget: next.engine.policy.repairBudget };
  const selectedX = stopInputsOf(source, { ...limits, workId: 'x' }).map(explainStop);
  assert.deepEqual(
    selectedX.map((d) => [d.actor, d.action]),
    [['lead', 'review-plan']],
    'выбранная отменённая получила бы шаг',
  );
  const board = stopInputsOf(source, limits);
  assert.ok(!board.some((i) => i.kind === 'work' && i.work.id === 'x'), 'доска её не называет');
  for (const g of [undefined, 'g']) {
    const works = statusOf(source, g).works;
    const x = works.find((w) => w.id === 'x')!;
    assert.deepEqual([x.stage.name, x.stage.needs], ['cancelled', { actor: null, action: 'none' }]);
    assert.deepEqual(works.find((w) => w.id === 'w')!.stage.needs, {
      actor: 'lead',
      action: 'review-plan',
    });
  }
  next.store.close();
});

test('H15: расход — прежняя запись только с ID предмета и вызов о группе по правилу recordWorkOf', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  env.store.transact('run.context', (tx) => {
    tx.putLocal('usage', 'app', 's1', call('s1', { subjectId: 'w' }));
    // Вид предмета назван иначе — не расход поручения, даже при совпадении ID.
    tx.putLocal('usage', 'app', 's2', call('s2', { subjectId: 'w', subjectKind: 'group' }));
    // Прежний вызов о группе: группа без поручения и попытки.
    tx.putLocal('usage', 'app', 's3', call('s3', { subjectId: 'w', groupId: 'grp' }));
    // Попытка неизвестна — по ID предмета.
    tx.putLocal('usage', 'app', 's4', call('s4', { runId: 'gone', subjectId: 'w' }));
  });
  const w = statusOf({ engine: env.engine, policy: env.engine.policy }).works[0]!;
  assert.equal(w.stage.spend.calls, 2);
});

test('H15: шаги prepare идут — «подготовка зависимостей (prepare)» с временем, а не «исполнитель пишет код»', () => {
  const now = Date.parse('2026-01-01T00:05:00.000Z');
  const active = {
    id: 'r1',
    status: 'active',
    startedAt: '2026-01-01T00:00:00.000Z',
    timings: [
      {
        id: 't1',
        stage: 'dependency-store',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        outcome: 'passed',
        unused: true,
      },
      { id: 't2', stage: 'prepare', startedAt: '2026-01-01T00:00:01.000Z' },
    ],
  } as never;
  const stage = workStageOf({
    work: { id: 'w', status: 'running', activeRunId: 'r1' } as never,
    attempts: [active],
    active,
    blocked: false,
    records: [],
    now,
  });
  assert.equal(stage.name, 'prepare');
  assert.equal(stage.step, 'prepare');
  assert.match(stage.line, /^w: подготовка зависимостей \(prepare\) — 4 мин 59 с/);
  assert.doesNotMatch(stage.line, /исполнитель пишет код/);
});
