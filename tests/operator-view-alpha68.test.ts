/**
 * Представление оператора, ревизия 8 (0.1.0-alpha.68): решения `decisions[]`
 * из записей хранилища и журнала, обязательность разбора на пути работы
 * (`track.steps[].required`), причина переоткрытия принятой работы
 * (`works[].reopened`) и итог ревью по попыткам (`works[].attemptReviews`).
 * Только показ: кто решает, не меняется.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, operatorViewSchema, type RunEvent } from '../src/contracts/index.ts';
import {
  collectOperatorViewInput,
  decisionsInputOf,
  harnessView,
} from '../src/control/operator-view.ts';
import type { Engine } from '../src/engine/engine.ts';
import { recoveryPolicyOf } from '../src/projections/decisions.ts';
import {
  OPERATOR_VIEW_LIMITS,
  operatorView,
  type OperatorDecisionInput,
} from '../src/projections/index.ts';
import {
  engineOf,
  graphOf,
  planReview,
  policyOf,
  ready,
  sha,
  trustNone,
} from './engine-fixture.ts';
import { NOW, at, baseInput } from './operator-view-input.ts';
import { viewState } from './view-fixture.ts';

const DAY = 86_400_000;

function reviewEvidence(
  e: Engine,
  run: { id: string; token: string },
  phase: 'candidate' | 'integration',
  at: string,
  passed: boolean,
  findings: { severity: string; message: string }[] = [],
) {
  e.evidence(run.id, run.token, {
    kind: 'review',
    phase,
    sha: at,
    gate: 'independent-review',
    passed,
    command: ['codex'],
    exitCode: 0,
    log: '',
    digest: digestOf('r' + phase + at + String(passed)),
    summary: passed ? 'ok' : 'rejected',
    findings,
  });
}

function gateEvidence(
  e: Engine,
  run: { id: string; token: string },
  phase: 'candidate' | 'integration',
  at: string,
) {
  e.evidence(run.id, run.token, {
    kind: 'test',
    phase,
    sha: at,
    gate: 'unit',
    passed: true,
    command: ['npm', 'test'],
    exitCode: 0,
    log: '',
    digest: digestOf('g' + phase + at),
    summary: 'ok',
  });
}

/**
 * Работа `w`: попытка 1 отклонена ревью (1 blocking, 1 note), ведущий
 * разобрал отказ по желанию (до `diagnoseAfter`), попытка 2 принята;
 * затем новая редакция плана переоткрыла `w` и добавила `y`, которую
 * человек отменил.
 */
function pilot() {
  const env = engineOf(
    policyOf((p) => {
      p.maxAttempts = 3;
      p.recovery = { mode: 'lead', diagnoseAfter: 2, leadResets: 1 };
    }),
  );
  const { engine, clock } = env;
  const tick = () => (clock.now += 5_000);
  ready(engine, graphOf({ w: [] }));
  tick();
  const first = engine.claim('c1')!;
  engine.phase(first.id, first.token, 'verifying', { candidateSha: sha('a') });
  gateEvidence(engine, first, 'candidate', sha('a'));
  reviewEvidence(engine, first, 'candidate', sha('a'), false, [
    { severity: 'blocking', message: 'нет случая пустого ввода' },
    { severity: 'note', message: 'имя переменной' },
  ]);
  engine.fail(first.id, first.token, 'review rejected', { kind: 'review' });
  tick();
  engine.diagnose('w', { cause: 'coverage', hypothesis: 'Добавить случай пустого ввода' });
  engine.retry('w', undefined, 'lead');
  tick();
  const second = engine.claim('c1')!;
  engine.phase(second.id, second.token, 'verifying', { candidateSha: sha('b') });
  gateEvidence(engine, second, 'candidate', sha('b'));
  reviewEvidence(engine, second, 'candidate', sha('b'), true);
  engine.phase(second.id, second.token, 'integrating', { integrationSha: sha('c') });
  gateEvidence(engine, second, 'integration', sha('c'));
  reviewEvidence(engine, second, 'integration', sha('c'), true);
  engine.finish(second.id, second.token, sha('c'));
  tick();
  const g = graphOf({ w: [], y: [] }, '2');
  g.orders[0] = { ...g.orders[0]!, goal: 'Доработать после приёмки.' };
  const { graph: state } = engine.register(g, trustNone);
  engine.recordReview(planReview(engine, state, engine.reviews('plan', state.id).length + 1));
  engine.approve(state.id, 'agent');
  tick();
  engine.cancel('y', 'не нужна', 'operator');
  return env;
}

function viewOf(env: ReturnType<typeof engineOf>, lang: 'ru' | 'en' = 'ru', withStore = true) {
  const { engine, dir, store } = env;
  const source = {
    engine,
    policy: engine.policy,
    workflows: { list: () => [], continues: () => false } as never,
    stateDir: dir,
    baseDir: dir,
    ...(withStore ? { store } : {}),
  };
  return operatorViewSchema.parse(
    operatorView(
      collectOperatorViewInput(
        source,
        { raw: engine.policy, warnings: [], baseDir: dir },
        { now: engine.clock(), lang },
      ),
      { lang, windowMs: 7 * DAY },
    ),
  );
}

test('a68: decisions[] — разбор по желанию, переоткрытие ведущим, отмена человеком; новые сверху', () => {
  const env = pilot();
  const view = viewOf(env);
  assert.equal(view.viewRevision, 8);
  const d = view.decisions!;
  assert.deepEqual(
    d.map((x) => [x.kind, x.by, x.workId]),
    [
      ['cancel', 'operator', 'y'],
      ['reopen', 'lead', 'w'],
      ['diagnosis', 'lead', 'w'],
    ],
  );
  const diagnosis = d.find((x) => x.kind === 'diagnosis')!;
  assert.equal(diagnosis.subject, 'D1');
  assert.equal(diagnosis.title, 'разбор D1: слабое покрытие (по желанию)');
  assert.equal(diagnosis.reason, 'Добавить случай пустого ввода');
  assert.equal(diagnosis.temporary, false);
  const reopen = d.find((x) => x.kind === 'reopen')!;
  assert.equal(reopen.title, 'работа переоткрыта: доработка 1 после приёмки');
  assert.equal(reopen.reason, 'принятый результат ccccccc не включён; свой предел попыток');
  assert.equal(new Set(d.map((x) => x.id)).size, d.length, 'ID решений различны');
  assert.match(diagnosis.id, /^diagnosis:[0-9a-f]{16}$/);
  // Повторное чтение — те же ID и тот же токен.
  const again = viewOf(env);
  assert.deepEqual(
    again.decisions!.map((x) => x.id),
    d.map((x) => x.id),
  );
  assert.equal(again.source.token, view.source.token);
  // Без хранилища (журнала) — только решения из состояния.
  assert.deepEqual(
    viewOf(env, 'ru', false).decisions!.map((x) => x.kind),
    ['diagnosis'],
  );
  const en = viewOf(env, 'en').decisions!;
  assert.equal(
    en.find((x) => x.kind === 'diagnosis')!.title,
    'diagnosis D1: weak coverage (optional)',
  );
});

test('a68: works[].reopened — причина переоткрытия; attemptReviews — итог ревью по попыткам', () => {
  const env = pilot();
  const view = viewOf(env);
  const w = view.works.find((x) => x.id === 'w')!;
  assert.deepEqual(w.reopened, {
    at: w.reopened!.at,
    by: 'lead',
    revision: 1,
    budget: 'fresh',
    acceptedSha: sha('c'),
    spent: 2,
    reason: 'переоткрыта ведущим: доработка после приёмки (принятый результат ccccccc не включён)',
  });
  assert.equal(
    viewOf(env, 'en').works.find((x) => x.id === 'w')!.reopened!.reason,
    'reopened by the lead: rework after acceptance (accepted result ccccccc not included)',
  );
  assert.deepEqual(
    w.attemptReviews!.map((r) => [r.attempt, r.phase, r.verdict, r.findings, r.notes, r.earlier]),
    [
      [1, 'candidate', 'rejected', 1, 1, true],
      [2, 'candidate', 'approved', 0, 0, true],
      [2, 'integration', 'approved', 0, 0, true],
    ],
  );
  const y = view.works.find((x) => x.id === 'y')!;
  assert.equal(y.reopened, undefined);
  assert.equal(y.attemptReviews, undefined);
  // Путь работы: разбор D1 после одного отказа — по желанию.
  const done = w.track!.steps.filter((s) => s.kind === 'diagnosis' && s.state === 'decision');
  assert.deepEqual(
    done.map((s) => s.required),
    [false],
  );
});

test('a68: решения из фактов — актёры, скрытый свободный текст, неизвестный актёр не выдумывается', () => {
  const facts: OperatorDecisionInput[] = [
    {
      kind: 'answer',
      at: at(10),
      workId: 'w',
      requestId: 'IR-1',
      revision: 1,
      by: 'lead',
      basis: 'technical',
      answerKind: 'clarification',
      reason: 'Секрет sk-test в логе не нужен: берём фикстуру',
    },
    {
      kind: 'answer',
      at: at(11),
      workId: 'w',
      requestId: 'IR-2',
      revision: 1,
      by: 'host',
      answerKind: 'requirement-change',
    },
    { kind: 'cancel', at: at(12), workId: 'x', seq: 5, by: 'graph' },
    { kind: 'cancel', at: at(13), workId: 'x2', seq: 6, by: 'graph', approvedBy: 'operator' },
    {
      kind: 'reapproval',
      at: at(14),
      graphId: 'g1',
      seq: 7,
      by: 'codex',
      round: 5,
      reason: 'вернули предел попыток',
    },
    { kind: 'reapproval', at: at(15), graphId: 'g1', seq: 8, by: 'Owner', round: 6 },
    {
      kind: 'reset',
      at: at(16),
      workId: 'w',
      by: 'lead',
      granted: 3,
      spent: 3,
      index: 1,
      cap: 2,
      diagnosis: 'D2',
    },
    { kind: 'reset', at: at(17), workId: 'w', by: 'operator', granted: 3, spent: 3 },
    {
      kind: 'finding',
      at: at(18),
      scope: 'code',
      subject: 'w',
      workId: 'w',
      findingId: 'f'.repeat(64),
      decision: 'accepted-limitation',
      by: 'lead',
      round: 2,
      reason: 'известное ограничение браузера',
    },
    {
      kind: 'finding',
      at: at(19),
      scope: 'plan',
      subject: 'g1',
      findingId: 'e'.repeat(64),
      decision: 'continue',
      by: 'operator',
      round: 3,
      reason: 'ещё раунд',
    },
    {
      kind: 'rework-abandoned',
      at: at(20),
      workId: 'w',
      seq: 9,
      revision: 2,
      acceptedSha: sha('d'),
      by: 'operator',
    },
  ];
  const view = operatorViewSchema.parse(operatorView(baseInput({ decisions: facts })));
  const rows = view.decisions!;
  assert.deepEqual(
    rows.map((r) => [r.kind, r.by]),
    [
      ['technical-answer', 'lead'],
      ['answer', 'operator'],
      // cancel x — `graph` без согласования: актёр неизвестен, решения нет.
      ['cancel', 'operator'],
      ['reapproval', 'lead'],
      ['reapproval', 'operator'],
      ['reset', 'lead'],
      ['reset', 'operator'],
      ['accepted-limitation', 'lead'],
      ['review-continue', 'operator'],
      ['rework-abandoned', 'operator'],
    ],
  );
  const tech = rows[0]!;
  assert.equal(tech.requestId, 'IR-1');
  assert.match(tech.reason!, /берём фикстуру/);
  assert.equal(rows[1]!.title, 'человек ответил на вопрос исполнителя (изменение требований)');
  assert.equal(rows[5]!.title, 'ещё попытки от ведущего: +3 (сброс 1 из 2)');
  assert.equal(rows[7]!.findingId, 'f'.repeat(64));
  // --no-titles: свободного текста нет, обязательная причина — фиксированной фразой.
  const bare = operatorViewSchema.parse(
    operatorView(baseInput({ decisions: facts }), { titles: false }),
  ).decisions!;
  assert.equal(bare[0]!.reason, 'технический вопрос: ответ ведущего по правилу политики');
  assert.equal(bare.find((r) => r.kind === 'accepted-limitation')!.reason, undefined);
  assert.equal(bare.find((r) => r.kind === 'reapproval')!.reason, undefined);
  // Нет входа — поля нет (производитель решения не сообщает); пустой вход — пустой список.
  assert.equal(operatorView(baseInput()).decisions, undefined);
  assert.deepEqual(operatorView(baseInput({ decisions: [] })).decisions, []);
});

test('a68: решения — предел списка, усечение и место под размер документа', () => {
  const many: OperatorDecisionInput[] = Array.from({ length: 70 }, (_, k) => ({
    kind: 'diagnosis',
    at: new Date(NOW - k * 60_000).toISOString(),
    workId: 'w',
    diagnosis: `D${k + 1}`,
    cause: 'approach',
    failures: 2,
    required: true,
    hypothesis: 'гипотеза '.repeat(60),
  }));
  const view = operatorViewSchema.parse(operatorView(baseInput({ decisions: many })));
  assert.equal(view.decisions!.length, OPERATOR_VIEW_LIMITS.decisions);
  assert.equal(view.truncated!.decisions, 70 - OPERATOR_VIEW_LIMITS.decisions);
  assert.equal(view.decisions![0]!.subject, 'D1', 'новые сверху');
  assert.ok(view.decisions!.every((d) => (d.reason?.length ?? 0) <= 400));
  // Сверх байтового предела решения уходят до хвостов списков.
  const without = JSON.stringify(operatorView(baseInput())).length;
  const fitted = operatorView(baseInput({ decisions: many }), { maxBytes: without + 2000 });
  assert.equal(fitted.decisions, undefined);
  assert.equal(fitted.truncated!.decisions, 70);
  assert.ok(fitted.health.warnings.some((w) => w.code === 'VIEW_SIZE_REDUCED'));
});

test('a68: журнал — согласование после переоткрытия и отмены графом, повторное согласование', () => {
  const ev = (seq: number, type: string, payload: unknown, workId?: string): RunEvent =>
    ({
      apiVersion: 'devcontour-harness/v1alpha1',
      seq,
      at: new Date(NOW - (100 - seq) * 60_000).toISOString(),
      graphId: 'g',
      ...(workId ? { workId } : {}),
      type,
      payload,
    }) as RunEvent;
  const events = [
    ev(1, 'work.reopened', { revision: 1, budget: 'fresh', acceptedSha: sha('a'), spent: 1 }, 'w'),
    ev(2, 'work.cancelled', { by: 'graph', hadAttempt: false }, 'x'),
    ev(3, 'graph.approved', { digest: 'd'.repeat(64), actor: 'agent' }),
    ev(4, 'work.cancelled', { by: 'graph', hadAttempt: false }, 'z'),
    ev(5, 'graph.approved', {
      digest: 'd'.repeat(64),
      actor: 'agent',
      reapproval: {
        by: 'lead',
        reason: 'тот же граф после правки политики',
        round: 7,
        previousPolicyDigest: 'a'.repeat(64),
        policyDigest: 'b'.repeat(64),
      },
    }),
    ev(6, 'work.cancelled', { by: 'graph', hadAttempt: false }, 'late'),
  ];
  const facts = decisionsInputOf(
    [],
    [],
    [],
    events,
    recoveryPolicyOf({ recovery: { mode: 'lead', diagnoseAfter: 2, leadResets: 2 } }),
  );
  const view = operatorViewSchema.parse(operatorView(baseInput({ decisions: facts })));
  assert.deepEqual(
    view.decisions!.map((d) => [d.kind, d.by, d.workId ?? d.subject]),
    [
      ['reapproval', 'lead', 'g'],
      ['cancel', 'lead', 'z'],
      ['cancel', 'lead', 'x'],
      ['reopen', 'lead', 'w'],
    ],
    'отмена `late` ещё не согласована — актёр неизвестен',
  );
});

test('a68: harnessView над каталогом состояния выдаёт decisions[] (журнал читается выборкой)', () => {
  const s = viewState();
  const view = harnessView({ stateDir: s.state, policyPath: s.policyPath, now: NOW }) as {
    viewRevision: number;
    decisions?: unknown[];
  };
  assert.equal(view.viewRevision, 8);
  assert.ok(Array.isArray(view.decisions));
});

test('a68: решения — поднятый бюджет (человек, причина из повторного согласования) и дополнение разбора', () => {
  const ev = (seq: number, type: string, payload: unknown): RunEvent =>
    ({
      apiVersion: 'devcontour-harness/v1alpha1',
      seq,
      at: new Date(NOW - (100 - seq) * 60_000).toISOString(),
      ...(type === 'graph.approved' ? { graphId: 'g' } : {}),
      type,
      payload,
    }) as RunEvent;
  const events = [
    ev(1, 'budget.raised', {
      by: 'process',
      generation: 4,
      changes: [
        { field: 'maxAttempts', before: 3, after: 4 },
        { field: 'reviewRounds', before: 6, after: 8 },
      ],
    }),
    ev(2, 'graph.approved', {
      digest: 'd'.repeat(64),
      actor: 'agent',
      reapproval: {
        by: 'codex',
        reason: 'владелец дал ещё раунд ревью плана',
        round: 7,
        previousPolicyDigest: 'a'.repeat(64),
        policyDigest: 'b'.repeat(64),
      },
    }),
  ];
  const work = {
    id: 'w',
    leadRecovery: {
      seq: 1,
      resets: [],
      diagnoses: [
        {
          id: 'D1',
          cause: 'environment',
          evidence: [],
          failures: ['r1'],
          by: 'lead',
          at: at(-50),
          epoch: 0,
          addenda: [{ at: at(-40), text: 'ошибка очистки маскирует исходный отказ', evidence: [] }],
        },
      ],
    },
  } as unknown as Parameters<typeof decisionsInputOf>[0][number];
  const facts = decisionsInputOf(
    [work],
    [],
    [],
    events,
    recoveryPolicyOf({ recovery: { mode: 'lead', diagnoseAfter: 2, leadResets: 2 } }),
  );
  const view = operatorViewSchema.parse(operatorView(baseInput({ decisions: facts })));
  const budget = view.decisions!.find((d) => d.kind === 'budget')!;
  assert.equal(budget.by, 'operator', 'бюджет поднимает человек');
  assert.match(budget.title!, /бюджет поднят: maxAttempts 3 → 4, reviewRounds 6 → 8/);
  assert.equal(budget.reason, 'владелец дал ещё раунд ревью плана');
  const addendum = view.decisions!.find((d) => d.kind === 'diagnosis-addendum')!;
  assert.deepEqual([addendum.by, addendum.workId, addendum.subject], ['lead', 'w', 'D1']);
  assert.match(addendum.title!, /дополнение 1 к разбору D1/);
});
