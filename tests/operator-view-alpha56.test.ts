/**
 * Представление оператора, ревизия 1 (alpha.56): основание ответа на вопрос
 * (`questions[].answerBasis`), итоги окна истории (`history.totals`) и
 * наблюдаемая длительность этапа (`works[].stage.typical`). Основание ответа
 * проверяется на настоящем движке (ответ ведущего с правилом и причиной
 * записан `answerInput`), итоги и длительности — на синтетическом входе с
 * числами, посчитанными здесь вручную.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPERATOR_VIEW_TYPICAL_MIN_SAMPLES,
  digestOf,
  operatorViewSchema,
  workDetailViewSchema,
  type AttemptState,
  type InputQuestion,
} from '../src/contracts/index.ts';
import {
  attemptReviewRounds,
  collectOperatorViewInput,
  stageTypicalOf,
  type ViewSource,
} from '../src/control/operator-view.ts';
import type { WorkflowQueue } from '../src/control/workflow.ts';
import { operatorView, workDetailView } from '../src/projections/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';
import { NOW, at, attempt, baseInput, work } from './operator-view-input.ts';

const noJobs = { list: () => [], continues: () => false } as unknown as WorkflowQueue;
const sourceOf = (engine: Engine, dir: string): ViewSource => ({
  engine,
  policy: engine.policy,
  workflows: noJobs,
  stateDir: dir,
  baseDir: dir,
});
const collect = (engine: Engine, dir: string, now: number) =>
  collectOperatorViewInput(sourceOf(engine, dir), { warnings: [], baseDir: dir }, { now });

const question: InputQuestion = {
  question: 'Какую библиотеку дат взять?',
  options: [
    {
      id: 'native',
      label: 'Intl',
      consequence: null,
      forUser: 'Для пользователя ничего не меняется',
    },
    { id: 'lib', label: 'date-fns', consequence: 'ещё одна зависимость', forUser: null },
  ],
  recommended: 'native',
  severity: 8,
  rationale: 'Выбор внутри реализации',
  affects: [],
  impact: 'technical',
};

function stopped() {
  const env = engineOf(
    policyOf((p) => {
      p.inputPolicy = { threshold: 7, leadAnswers: { technical: true } };
    }),
  );
  ready(env.engine, graphOf({ w: [] }));
  const a = env.engine.claim('c1')!;
  env.engine.fail(a.id, a.token, 'вопрос', {
    kind: 'needs-input',
    input: {
      question: { question, effectiveSeverity: 8, floors: [], mode: 'request' },
      assumptions: [],
      followUps: [],
      criticalHits: [],
      callId: 'call-1',
    },
  });
  const [request] = env.engine.inputRequests({ workId: 'w' });
  return { ...env, request: request! };
}

test('view r1: ответ ведущего на технический вопрос — answerBasis с правилом, причиной и строкой', () => {
  const env = stopped();
  const before = operatorView(collect(env.engine, env.dir, env.clock.now));
  assert.equal(before.viewRevision, 8);
  assert.equal(before.questions[0]!.answerBasis, undefined, 'без ответа основания нет');

  env.engine.answerInput(
    env.request.id,
    {
      text: 'Intl',
      optionId: 'native',
      actor: { kind: 'lead' },
      reason: 'без новой зависимости, ключ sk-ant-api03-SECRETSECRETSECRETSECRET',
    },
    1,
  );
  const view = operatorView(collect(env.engine, env.dir, env.clock.now));
  operatorViewSchema.parse(view);
  const b = view.questions[0]!.answerBasis!;
  assert.equal(b.by, 'lead');
  assert.equal(b.rule, 'technical');
  assert.equal(b.impact, 'technical');
  assert.match(b.reason!, /^без новой зависимости, ключ ‹masked›/);
  assert.equal(b.line, `ответил ведущий (технический вопрос): ${b.reason}`);
  assert.ok(!JSON.stringify(view).includes('SECRETSECRET'), 'причина маскируется');
  assert.ok(Date.parse(b.at) > 0);

  const en = operatorView(collect(env.engine, env.dir, env.clock.now), { lang: 'en' });
  assert.match(
    en.questions[0]!.answerBasis!.line,
    /^answered by the lead \(technical question\): /,
  );

  // --no-titles: причины нет ни в поле, ни в строке.
  const bare = operatorView(collect(env.engine, env.dir, env.clock.now), { titles: false });
  const nb = bare.questions[0]!.answerBasis!;
  assert.equal(nb.reason, undefined);
  assert.equal(nb.line, 'ответил ведущий (технический вопрос)');

  // Детали работы показывают то же основание.
  const detail = workDetailView(collect(env.engine, env.dir, env.clock.now), 'w');
  workDetailViewSchema.parse(detail);
  assert.deepEqual(detail.questions[0]!.answerBasis, b);
  env.store.close();
});

test('view r1: ответ оператора — answerBasis без правила; вопрос закрытой работы — только в деталях', () => {
  const op = baseInput({
    works: [work('w'), work('d', { status: 'done' })],
    questions: [
      {
        requestId: 'IR-1',
        workId: 'w',
        state: 'applied-awaiting-claim',
        version: 1,
        severity: 8,
        createdAt: at(30),
        answeredBy: 'operator',
        // Правило у ответа оператора не показывается, даже если вход его несёт.
        answer: { by: 'operator', basis: 'technical', at: at(20) },
        leadMay: false,
      },
      {
        requestId: 'IR-2',
        workId: 'd',
        state: 'delivered',
        version: 1,
        severity: 5,
        createdAt: at(90),
        impact: 'technical',
        answeredBy: 'lead',
        answer: { by: 'lead', basis: 'severity', reason: 'до порога', at: at(80) },
        closed: true,
        leadMay: true,
      },
    ],
  });
  const view = operatorView(op);
  operatorViewSchema.parse(view);
  assert.deepEqual(
    view.questions.map((q) => q.requestId),
    ['IR-1'],
    'вопрос закрытой работы не в обзоре',
  );
  assert.deepEqual(view.questions[0]!.answerBasis, {
    by: 'operator',
    impact: 'user-visible',
    at: at(20),
    line: 'ответил оператор',
  });
  const detail = workDetailView(op, 'd');
  workDetailViewSchema.parse(detail);
  assert.deepEqual(detail.questions[0]!.answerBasis, {
    by: 'lead',
    rule: 'severity',
    reason: 'до порога',
    impact: 'technical',
    at: at(80),
    line: 'ответил ведущий (ниже порога серьёзности): до порога',
  });
});

test('view r1: history.totals — суммы рядов, отказы по классам, раунды ревью, расход, время', () => {
  const i = baseInput({
    works: [work('a'), work('b')],
    attempts: [
      // 120→100 мин назад и 110→90: пересекаются — 30 мин стены, 40 мин попыток.
      attempt('a', 1, {
        status: 'failed',
        failureBucket: 'environment',
        startedAt: at(120),
        finishedAt: at(100),
      }),
      attempt('b', 1, {
        status: 'failed',
        failureBucket: 'code',
        startedAt: at(110),
        finishedAt: at(90),
      }),
      // Прерванная остановкой: время считается, отказом не считается.
      attempt('a', 2, {
        status: 'failed',
        failureBucket: null,
        interrupted: true,
        startedAt: at(60),
        finishedAt: at(50),
      }),
      // До окна (24 ч): не считается нигде.
      attempt('b', 2, {
        status: 'failed',
        failureBucket: 'code',
        startedAt: at(26 * 60),
        finishedAt: at(25 * 60),
      }),
      // Истёкшая без класса — unclassified; идёт до конца окна по правилу ряда.
      attempt('b', 3, {
        status: 'expired',
        failureBucket: undefined,
        startedAt: at(40),
        finishedAt: at(35),
      }),
    ],
    gateEvents: [
      { at: at(100), passed: true, applicable: true },
      { at: at(99), passed: false, applicable: true },
      { at: at(98), passed: true, applicable: true, reused: true },
      { at: at(97), passed: true, applicable: false },
    ],
    calls: [
      { at: at(100), knownUsd: 0.25, complete: true },
      { at: at(95), knownUsd: null, complete: false },
      { at: at(25 * 60), knownUsd: 9, complete: true },
    ],
    reviewRounds: [
      { kind: 'plan', at: at(200) },
      { kind: 'plan', at: at(150) },
      { kind: 'contract', at: at(140) },
      { kind: 'code', at: at(30) },
      { kind: 'attempt', at: at(95) },
      { kind: 'plan', at: at(30 * 60) },
    ],
  });
  const view = operatorView(i);
  operatorViewSchema.parse(view);
  const t = view.history.totals!;
  const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
  assert.equal(t.attemptsStarted, 4);
  assert.equal(t.attemptsStarted, sum(view.history.attemptsStarted));
  assert.equal(t.attemptsFailed, 3);
  assert.equal(t.attemptsFailed, sum(view.history.attemptsFailed));
  assert.deepEqual(t.failuresByBucket, { code: 1, environment: 1, unclassified: 1 });
  assert.deepEqual([t.gatesPassed, t.gatesFailed, t.gatesReused], [1, 1, 1]);
  assert.deepEqual(t.reviewRounds, { plan: 2, contract: 1, code: 1, attempt: 1 });
  assert.deepEqual(t.spendUsd, { value: 0.25, bound: 'lower' });
  const min = 60_000;
  // Стена: 120→90 (30) + 60→50 (10) + 40→35 (5) = 45 мин; попытки: 20+20+10+5 = 55.
  assert.equal(t.wallMs, 45 * min);
  assert.equal(t.attemptMs, 55 * min);
  assert.equal(t.loadPeak, 2);
  assert.equal(t.loadPeak, Math.max(...view.history.load));

  // Пустое окно: нули, расход точный ноль, без классов.
  const empty = operatorView(baseInput()).history.totals!;
  assert.deepEqual(empty, {
    attemptsStarted: 0,
    attemptsFailed: 0,
    failuresByBucket: {},
    gatesPassed: 0,
    gatesFailed: 0,
    gatesReused: 0,
    reviewRounds: { plan: 0, contract: 0, code: 0, attempt: 0 },
    spendUsd: { value: 0, bound: 'exact' },
    wallMs: 0,
    attemptMs: 0,
    loadPeak: 0,
  });
  // Только неизвестные вызовы в окне — неизвестно, а не ноль.
  const unknown = operatorView(
    baseInput({ calls: [{ at: at(5), knownUsd: null, complete: false }] }),
  );
  assert.deepEqual(unknown.history.totals!.spendUsd, { value: 0, bound: 'unknown' });
});

test('view r1: идущая попытка — время до конца окна', () => {
  const view = operatorView(
    baseInput({
      works: [work('a')],
      attempts: [attempt('a', 1, { status: 'active', startedAt: at(10), finishedAt: undefined })],
    }),
  );
  assert.equal(view.history.totals!.wallMs, 10 * 60_000);
  assert.equal(view.history.totals!.attemptMs, 10 * 60_000);
});

const timed = (
  id: string,
  status: AttemptState['status'],
  steps: [stage: string, startMin: number, endMin?: number][],
  over: Partial<AttemptState> = {},
) =>
  ({
    id,
    workId: 'a',
    status,
    timings: steps.map(([stage, s, e], k) => ({
      id: `${id}-${k}`,
      stage,
      startedAt: new Date(NOW + s * 60_000).toISOString(),
      ...(e !== undefined ? { finishedAt: new Date(NOW + e * 60_000).toISOString() } : {}),
    })),
    ...over,
  }) as unknown as AttemptState;

test('view r1: stageTypicalOf — этап от первого замера до последнего; открытые, идущие и прерванные не считаются', () => {
  const out = stageTypicalOf([
    // writer 10 мин; gates — два параллельных замера 10→14 и 11→16: 6 мин.
    timed('r1', 'succeeded', [
      ['implementation', 0, 10],
      ['candidate-test:unit', 10, 14],
      ['candidate-test:lint', 11, 16],
    ]),
    timed('r2', 'failed', [['implementation', 0, 20]]),
    timed('r3', 'failed', [['implementation', 0, 30]]),
    // Незакрытый замер gates: этап gates этой попытки — не образец.
    timed('r4', 'failed', [
      ['implementation', 0, 40],
      ['candidate-test:unit', 40],
    ]),
    timed('r5', 'succeeded', [['implementation', 0, 50]]),
    // Идущая и прерванная остановкой — не образцы.
    timed('r6', 'active', [['implementation', 0, 1]]),
    timed('r7', 'failed', [['implementation', 0, 2]], { interrupted: 'shutdown' }),
    // Очистка окружения кандидата этапа не имеет.
    timed('r8', 'succeeded', [['candidate-environment:cleanup', 0, 99]]),
  ]);
  const min = 60_000;
  assert.deepEqual(out.writer, { p50Ms: 30 * min, p90Ms: 50 * min, samples: 5 });
  assert.deepEqual(out.gates, { p50Ms: 6 * min, p90Ms: 6 * min, samples: 1 });
  assert.deepEqual(Object.keys(out).sort(), ['gates', 'writer']);
});

test('view r1: stage.typical — у работы на этом этапе и только при достаточном числе образцов', () => {
  const typical = {
    writer: { p50Ms: 600_000, p90Ms: 900_000, samples: OPERATOR_VIEW_TYPICAL_MIN_SAMPLES },
    gates: { p50Ms: 60_000, p90Ms: 120_000, samples: OPERATOR_VIEW_TYPICAL_MIN_SAMPLES - 1 },
    queued: { p50Ms: 1, p90Ms: 2, samples: 100 },
  };
  const stage = (name: string) => ({
    name,
    next: [],
    spend: { calls: 0, knownUsd: 0, unknownCalls: 0, durationMs: 0 },
  });
  const view = operatorView(
    baseInput({
      works: [
        work('w', { stage: stage('writer') }),
        work('g', { stage: stage('gates') }),
        work('q', { stage: stage('queued') }),
        work('r', { stage: stage('review') }),
      ],
      stageTypical: typical,
    }),
  );
  operatorViewSchema.parse(view);
  const of = (id: string) => view.works.find((w) => w.id === id)!.stage.typical;
  assert.deepEqual(of('w'), { p50Ms: 600_000, p90Ms: 900_000, samples: 5 });
  assert.equal(of('g'), undefined, 'образцов меньше минимума');
  assert.equal(of('q'), undefined, 'очередь — не этап попытки');
  assert.equal(of('r'), undefined, 'нет образцов');
});

const evidence = (
  e: Engine,
  a: { id: string; token: string },
  phase: 'candidate' | 'integration',
  at: string,
  gate: string,
  kind: 'test' | 'review' = 'test',
) =>
  e.evidence(a.id, a.token, {
    kind,
    phase,
    sha: at,
    gate,
    passed: true,
    command: ['npm', 'run', gate],
    exitCode: 0,
    log: '',
    digest: digestOf(phase + gate + a.id),
    summary: 'ok',
    ...(kind === 'review' ? { findings: [] } : {}),
  });

test('view r1: загрузчик на настоящем движке — образцы этапа writer и раунды ревью в попытке', () => {
  const env = engineOf();
  const { engine } = env;
  ready(engine, graphOf({ a: [], b: [], c: [], d: [], e: [], f: [] }));
  for (const m of [1, 2, 3, 4, 5]) {
    const run = engine.claim('c1')!;
    const t = engine.timingStarted(run.id, run.token, 'implementation');
    // Секунды: в пределах аренды попытки и controller.
    env.clock.now += m * 1000;
    engine.timingFinished(run.id, run.token, t, 'passed');
    engine.phase(run.id, run.token, 'verifying', { baseSha: sha('c'), candidateSha: sha('a') });
    evidence(engine, run, 'candidate', sha('a'), 'unit');
    evidence(engine, run, 'candidate', sha('a'), 'independent-review', 'review');
    engine.phase(run.id, run.token, 'integrating', { integrationSha: sha('b') });
    evidence(engine, run, 'integration', sha('b'), 'unit');
    evidence(engine, run, 'integration', sha('b'), 'independent-review', 'review');
    engine.finish(run.id, run.token, sha('b'));
  }
  // Шестая работа пишет код: её этап writer получает наблюдаемую длительность.
  const live = engine.claim('c1')!;
  engine.timingStarted(live.id, live.token, 'implementation');
  env.clock.now += 1000;
  const input = collect(engine, env.dir, env.clock.now);
  // Две фазы ревью у каждой из пяти попыток.
  assert.equal(input.reviewRounds?.filter((r) => r.kind === 'attempt').length, 10);
  const view = operatorView(input);
  operatorViewSchema.parse(view);
  const running = view.works.find((w) => w.id === live.workId)!;
  assert.equal(running.stage.name, 'writer');
  assert.deepEqual(running.stage.typical, { p50Ms: 3000, p90Ms: 5000, samples: 5 });
  // Окно — 24 ч до часов движка: все попытки в нём.
  assert.equal(view.history.totals!.reviewRounds.attempt, 10);
  assert.equal(view.history.totals!.attemptsStarted, 6);
  env.store.close();
});

test('view r1: отменённая работа — вопрос с ответом ведущего остаётся в деталях, в обзоре его нет', () => {
  const env = stopped();
  env.engine.answerInput(
    env.request.id,
    { text: 'Intl', optionId: 'native', actor: { kind: 'lead' }, reason: 'без новой зависимости' },
    1,
  );
  env.engine.cancel('w', 'не нужна');
  const input = collect(env.engine, env.dir, env.clock.now);
  const view = operatorView(input);
  operatorViewSchema.parse(view);
  assert.deepEqual(view.questions, [], 'обзор — только открытые работы');
  const detail = workDetailView(input, 'w');
  workDetailViewSchema.parse(detail);
  assert.equal(detail.questions.length, 1);
  const q = detail.questions[0]!;
  assert.equal(q.state, env.engine.inputRequest(env.request.id).lifecycle);
  assert.equal(q.answerBasis?.line, 'ответил ведущий (технический вопрос): без новой зависимости');
  env.store.close();
});

const reviewEvidence = (
  round: { scope: string; round: number; protocol: 'valid' | 'invalid' | 'unsafe' } | undefined,
  minute: number,
) => ({
  kind: 'review',
  createdAt: new Date(NOW + minute * 60_000).toISOString(),
  ...(round ? { reviewRound: round } : {}),
});

test('view r1: attemptReviewRounds — раунд на (область, номер), только валидный протокол; прежняя запись — свой раунд', () => {
  const scope = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const attempts = [
    {
      evidence: [
        { kind: 'test', createdAt: new Date(NOW).toISOString() },
        // Раунд 1: невалидный вызов, затем валидный повтор — один раунд, время валидного.
        reviewEvidence({ scope, round: 1, protocol: 'invalid' }, 1),
        reviewEvidence({ scope, round: 1, protocol: 'valid' }, 2),
        // Небезопасный ответ раундом не считается.
        reviewEvidence({ scope, round: 2, protocol: 'unsafe' }, 3),
      ],
    },
    {
      evidence: [
        // Дубль той же области и номера в другой попытке — тот же раунд.
        reviewEvidence({ scope, round: 1, protocol: 'valid' }, 4),
        reviewEvidence({ scope, round: 2, protocol: 'valid' }, 5),
        // Другая область с тем же номером — свой раунд.
        reviewEvidence({ scope: other, round: 1, protocol: 'valid' }, 6),
        // Прежняя запись без протокола.
        reviewEvidence(undefined, 7),
      ],
    },
  ] as unknown as AttemptState[];
  const at = (m: number) => new Date(NOW + m * 60_000).toISOString();
  assert.deepEqual(
    attemptReviewRounds(attempts).map((r) => r.at),
    [at(2), at(5), at(6), at(7)],
  );
});

test('view r1: stageTypicalOf — p90 по ближайшему рангу не равен максимуму на 11 образцах', () => {
  const minutes = [7, 3, 11, 1, 9, 5, 2, 10, 4, 8, 6];
  const out = stageTypicalOf(
    minutes.map((m, k) => timed(`s${k}`, 'succeeded', [['implementation', 0, m]])),
  );
  // Сортировка 1..11: p50 — 6-й (ceil(5.5)), p90 — 10-й (ceil(9.9)), не 11.
  assert.deepEqual(out.writer, { p50Ms: 6 * 60_000, p90Ms: 10 * 60_000, samples: 11 });
});
