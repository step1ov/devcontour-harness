import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_STALL_SWEEP,
  HarnessError,
  OPERATOR_VIEW_VERSION,
  operatorViewSchema,
  workDetailViewSchema,
} from '../src/contracts/index.ts';
import { Harness } from '../src/control/harness.ts';
import {
  collectOperatorViewInput,
  defaultedPaths,
  harnessView,
  viewPolicy,
} from '../src/control/operator-view.ts';
import { collectReportInput } from '../src/control/report.ts';
import { valueReport } from '../src/report/index.ts';
import { maskText, operatorView, sha256Hex, workDetailView } from '../src/projections/index.ts';
import { NOW, at, attempt, baseInput, policy, review, work } from './operator-view-input.ts';
import { viewState } from './view-fixture.ts';

const DAY = 86_400_000;

test('view: пустой вход — корректный документ по схеме, настройки из политики', () => {
  const view = operatorView(baseInput());
  operatorViewSchema.parse(view);
  assert.equal(view.viewVersion, OPERATOR_VIEW_VERSION);
  assert.equal(view.viewRevision, 9);
  assert.equal(view.generatedAt, new Date(NOW).toISOString());
  assert.deepEqual(view.works, []);
  assert.equal(view.progress.total, 0);
  assert.equal(view.history.load.length, 96);
  assert.equal(view.history.bucketMs, 15 * 60_000);
  assert.equal(view.health.budgeting, 'off');
  assert.deepEqual(view.health.spentTotalUsd, { value: 0, bound: 'exact' });
  assert.deepEqual(view.settings.roles, [{ role: 'developer', writer: { runtime: 'claude' } }]);
  assert.deepEqual(
    view.settings.reviews.map((r) => [r.kind, r.scope]),
    [
      ['code', 'global'],
      ['plan', 'global'],
      ['contract', 'global'],
    ],
  );
  assert.equal(view.settings.thresholds.reviewRoundCap, 6);
  assert.equal(view.settings.thresholds.reviewEscalationRounds, 3);
  assert.equal(view.settings.lean.state, 'unknown');
  assert.match(view.source.token, /^[a-f0-9]{64}$/);
});

test('view: правила ревью по областям и умолчания политики', () => {
  const p = policy((raw) => {
    const repos = raw.repositories as Record<string, unknown>[];
    repos[0]!.review = { reviewer: { runtime: 'codex', model: 'm-repo' } };
    repos[0]!.roles = {
      developer: { writer: { runtime: 'codex' }, review: { reviewer: { runtime: 'claude' } } },
    };
    (raw.roles as Record<string, Record<string, unknown>>).developer!.review = {
      reviewer: { runtime: 'codex', effort: 'high' },
      alternates: [{ runtime: 'claude' }],
      vendor: 'same-vendor-allowed',
    };
    raw.budgets = { total: { usd: 40 }, work: { usd: 8 } };
    raw.inputPolicy = { threshold: 6, criticalPaths: ['db/'], leadAnswers: { maxSeverity: 4 } };
  });
  const view = operatorView(
    baseInput({
      policy: p,
      effective: {
        inputPolicy: p.inputPolicy!,
        stall: { ...DEFAULT_STALL_SWEEP },
        reviewRoundCap: 6,
      },
      manifestLayers: ['lean'],
      defaulted: ['timeouts.stall', 'thresholds.repairBudget'],
    }),
  );
  operatorViewSchema.parse(view);
  assert.deepEqual(
    view.settings.reviews.map((r) => [r.kind, r.scope, r.repositoryId ?? '', r.role ?? '']),
    [
      ['code', 'global', '', ''],
      ['plan', 'global', '', ''],
      ['contract', 'global', '', ''],
      ['code', 'repository', 'app', ''],
      ['code', 'role', '', 'developer'],
      ['code', 'role', 'app', 'developer'],
    ],
  );
  assert.deepEqual(view.settings.roles[1], {
    role: 'developer',
    writer: { runtime: 'codex' },
    repositoryId: 'app',
  });
  assert.equal(view.settings.thresholds.inputSeverity, 6);
  assert.equal(view.settings.thresholds.leadAnswersMaxSeverity, 4);
  assert.equal(view.settings.thresholds.criticalPaths, 1);
  assert.deepEqual(view.settings.budgets, [
    { scope: 'work', usd: 8 },
    { scope: 'total', usd: 40 },
  ]);
  assert.equal(view.settings.budgetOnUnknown, 'stop');
  assert.equal(view.settings.lean.state, 'on');
  assert.deepEqual(view.settings.defaulted, ['thresholds.repairBudget', 'timeouts.stall']);
  assert.equal(view.history.budgetUsd, 40);
  // Пути умолчаний: поля, которых нет в файле политики.
  assert.deepEqual(defaultedPaths(policy(), { repositories: [] }), [
    'approvalMode',
    'concurrency',
    'mode',
    'thresholds.inputSeverity',
    'thresholds.maxAttempts',
    'thresholds.repairBudget',
    'timeouts.leaseMs',
    'timeouts.runTimeoutMs',
    'timeouts.stall',
  ]);
});

test('view: числа работ, прогресса и расходов равны status и report на том же состоянии', () => {
  const s = viewState();
  const vp = viewPolicy(s.state, s.policyPath);
  const h = Harness.open({
    stateDir: s.state,
    policy: vp.policy,
    baseDir: vp.baseDir,
    adapters: {},
    readOnly: true,
    readOnlyState: true,
  });
  try {
    const status = h.status(undefined, { detail: true });
    const report = valueReport(collectReportInput(h.store), {});
    const view = operatorView(collectOperatorViewInput(h, vp, { now: NOW }), { windowMs: 7 * DAY });
    operatorViewSchema.parse(view);
    assert.equal(view.works.length, status.works.length);
    for (const [k, sw] of status.works.entries()) {
      const w = view.works[k]!;
      assert.equal(w.id, sw.id);
      assert.equal(w.status, sw.status);
      assert.equal(w.stage.name, sw.stage.name, sw.id);
      assert.deepEqual(w.stage.next, sw.stage.next);
      assert.equal(w.stage.since, sw.stage.since);
      assert.deepEqual(
        [
          w.attempts.used,
          w.attempts.max,
          w.attempts.left,
          w.attempts.failed,
          w.attempts.interrupted,
        ],
        [
          sw.attemptSummary.attempts.used,
          sw.attemptSummary.attempts.max,
          sw.attemptSummary.attempts.left,
          sw.attemptSummary.failed,
          sw.attemptSummary.interrupted,
        ],
        sw.id,
      );
      assert.deepEqual(w.attempts.neutral, sw.attemptSummary.neutral);
      assert.equal(w.spend.calls, sw.stage.spend.calls);
      assert.equal(w.spend.durationMs, sw.stage.spend.durationMs);
      assert.equal(w.spend.usd.value, sw.stage.spend.knownUsd);
      // Неизвестная цена никогда не показывается точным нулём.
      if (sw.stage.spend.unknownCalls) assert.notEqual(w.spend.usd.bound, 'exact', sw.id);
      assert.deepEqual(
        w.blockers.map((b) => b.code),
        sw.blockers.map((b) => b.code),
      );
    }
    assert.equal(view.progress.total, status.works.length);
    const byStage: Record<string, number> = {};
    for (const w of status.works) byStage[w.stage.name] = (byStage[w.stage.name] ?? 0) + 1;
    assert.deepEqual(view.progress.byStage, byStage);
    assert.equal(view.progress.done, status.works.filter((w) => w.stage.name === 'done').length);
    // Отчёт по всем данным: известные расходы и граница.
    assert.equal(view.health.spentTotalUsd.value, report.cost.knownUsd);
    assert.equal(view.health.spentTotalUsd.bound, 'lower');
    assert.ok(report.cost.unknown.total > 0 || report.cost.attemptsWithoutCalls > 0);
    // Ревью плана и контракта — те же сводки, что у status.
    for (const sr of status.reviews ?? []) {
      const r = view.reviews.find((x) => x.kind === sr.kind && x.subject === sr.subject)!;
      assert.deepEqual(
        [r.approved, r.rounds, r.open, r.accepted],
        [sr.approved, sr.rounds, sr.open, sr.accepted],
      );
      assert.equal(r.spend.calls, sr.spend.calls);
    }
    // Попытки истории: начатые в окне — как в хранилище.
    const from = Date.parse(view.history.from);
    const started = h.engine.read((v) =>
      v.attempts().filter((a) => Date.parse(a.startedAt) >= from && Date.parse(a.startedAt) <= NOW),
    ).length;
    assert.equal(
      view.history.attemptsStarted.reduce((a, b) => a + b, 0),
      started,
    );
    // Детали работы — та же запись работы и строки попыток новые сверху.
    const detail = workDetailView(collectOperatorViewInput(h, vp, { now: NOW }), 'gate');
    workDetailViewSchema.parse(detail);
    assert.deepEqual(
      detail.work,
      view.works.find((w) => w.id === 'gate'),
    );
    assert.deepEqual(
      detail.attempts.map((a) => a.attempt),
      [3, 2, 1],
    );
    assert.equal(detail.attempts[2]!.interrupted, true);
    assert.equal(detail.attempts[1]!.failureBucket, 'defect');
  } finally {
    h.close();
  }
});

test('view: побайтовый детерминизм при фиксированных часах', () => {
  const s = viewState();
  const a = harnessView({ stateDir: s.state, policyPath: s.policyPath, now: NOW });
  const b = harnessView({ stateDir: s.state, policyPath: s.policyPath, now: NOW });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // Ключи отсортированы на любой глубине.
  const sorted = (v: unknown): boolean =>
    Array.isArray(v)
      ? v.every(sorted)
      : v && typeof v === 'object'
        ? Object.keys(v).join() === Object.keys(v).sort().join() && Object.values(v).every(sorted)
        : true;
  assert.ok(sorted(a));
});

test('view: ряды gates — пропущенные вне рядов, перенесённые отдельно, перепроверки и провалы', () => {
  const view = operatorView(
    baseInput({
      gateEvents: [
        { at: at(10), passed: true, applicable: true },
        { at: at(10), passed: false, applicable: true },
        { at: at(10), passed: true, applicable: true, recheck: true },
        { at: at(10), passed: false, applicable: false },
        { at: at(10), passed: true, applicable: true, reused: true },
        { at: at(10), passed: false, applicable: true, reused: true },
        { at: new Date(NOW - 2 * DAY).toISOString(), passed: true, applicable: true },
      ],
    }),
  );
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  assert.equal(sum(view.history.gatesPassed), 2);
  assert.equal(sum(view.history.gatesFailed), 2);
  assert.equal(sum(view.history.gatesReused), 1);
  assert.equal(view.history.gatesPassed.at(-1), 2);
});

test('view: история попыток — нагрузка, начатые и упавшие без прерываний остановкой', () => {
  const view = operatorView(
    baseInput({
      attempts: [
        attempt('a', 1, {
          startedAt: at(50),
          finishedAt: at(20),
          status: 'failed',
          failureBucket: 'defect',
        }),
        attempt('b', 1, {
          startedAt: at(40),
          finishedAt: at(25),
          status: 'failed',
          interrupted: true,
        }),
        attempt('c', 1, { startedAt: at(35), finishedAt: undefined, status: 'active' }),
        attempt('d', 1, {
          startedAt: at(30),
          finishedAt: at(29),
          status: 'expired',
          failureBucket: 'environment',
        }),
      ],
    }),
    { bucketMs: 60 * 60_000 },
  );
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  assert.equal(view.history.load.length, 24);
  assert.equal(view.history.load.at(-1), 4);
  assert.equal(sum(view.history.attemptsStarted), 4);
  assert.equal(sum(view.history.attemptsFailed), 2);
  assert.equal(view.health.environmentFailures, 1);
});

test('view: расходы — брошенный вызов, неполный usage, попытка без записей: никогда не точный ноль', () => {
  const only = (
    calls: { at: string; knownUsd: number | null; complete: boolean }[],
    uncovered = false,
  ) =>
    operatorView(
      baseInput({
        calls,
        attempts: uncovered ? [attempt('a', 1, { callsRecorded: false, finishedAt: at(5) })] : [],
      }),
    );
  // Брошенный вызов без цены: известной суммы нет.
  const abandoned = only([{ at: at(10), knownUsd: null, complete: false }]);
  assert.deepEqual(abandoned.health.spentTotalUsd, { value: 0, bound: 'unknown' });
  assert.equal(abandoned.history.spendBound, 'lower');
  // Неполный usage при известной цене — нижняя граница.
  const partial = only([{ at: at(10), knownUsd: 1.25, complete: false }]);
  assert.deepEqual(partial.health.spentTotalUsd, { value: 1.25, bound: 'lower' });
  assert.equal(partial.history.spendBound, 'lower');
  // Попытка без записей вызовов.
  const uncovered = only([], true);
  assert.deepEqual(uncovered.health.spentTotalUsd, { value: 0, bound: 'unknown' });
  assert.equal(uncovered.history.spendBound, 'lower');
  // Полный учёт — точно.
  const exact = only([{ at: at(10), knownUsd: 2, complete: true }]);
  assert.deepEqual(exact.health.spentTotalUsd, { value: 2, bound: 'exact' });
  assert.equal(exact.history.spendBound, 'exact');
  // Большие расходы до окна — в открывающем остатке.
  const before = only([
    { at: new Date(NOW - 3 * DAY).toISOString(), knownUsd: 30, complete: true },
    { at: at(10), knownUsd: 2, complete: true },
  ]);
  assert.deepEqual(before.history.spendOpeningUsd, { value: 30, bound: 'exact' });
  assert.equal(
    before.history.spendUsd.reduce((a, b) => a + b, 0),
    2,
  );
  assert.deepEqual(before.health.spentTotalUsd, { value: 32, bound: 'exact' });
  // Работа: вызовы без цены — не точная сумма.
  const w = operatorView(
    baseInput({
      works: [
        work('a', {
          stage: {
            ...work('a').stage,
            spend: { calls: 2, knownUsd: 0, unknownCalls: 2, durationMs: 0 },
          },
        }),
      ],
    }),
  );
  assert.deepEqual(w.works[0]!.spend.usd, { value: 0, bound: 'unknown' });
});

test('view: превышен бюджет работы при общем в пределах — строка exceeded видна', () => {
  const row = (kind: 'work' | 'total', state: 'within' | 'exceeded', id?: string) => ({
    scope: { kind, ...(id ? { id } : {}) },
    state,
    limit: { usd: kind === 'total' ? 40 : 1 },
    reportedUsd: 2,
    estimatedUsd: 0,
    unknownCalls: 0,
    uncoveredRuns: 0,
    durationMs: 1000,
  });
  const view = operatorView(
    baseInput({
      budgets: [row('total', 'within'), row('work', 'within', 'a'), row('work', 'exceeded', 'b')],
    }),
  );
  assert.equal(view.health.budgeting, 'on');
  assert.deepEqual(
    view.health.budgets.map((b) => [b.scope, b.id ?? '', b.state]),
    [
      ['total', '', 'within'],
      ['work', 'b', 'exceeded'],
      ['work', 'a', 'within'],
    ],
  );
  assert.deepEqual(view.health.budgets[1]!.spentUsd, { value: 2, bound: 'exact' });
});

test('view: эскалации — остановки человеку и ведущему, эскалация ревью; controller — нет', () => {
  const view = operatorView(
    baseInput({
      stops: [
        {
          workId: 'a',
          code: 'ATTEMPTS_EXHAUSTED',
          actor: 'user',
          action: 'reset-attempts',
          since: at(5),
        },
        { workId: 'b', code: 'GATE_FAILED', actor: 'lead', action: 'diagnose-failure' },
        { workId: 'c', code: 'NOT_READY', actor: 'controller', action: 'wait' },
        { code: 'PAUSED', actor: 'user', action: 'resume-queue', since: at(3) },
      ],
      reviews: [review('g1', { escalation: { round: 4, findings: ['f1'] } })],
    }),
  );
  assert.deepEqual(
    view.escalations.map((e) => [e.workId ?? e.subject, e.code, e.actor, e.action]),
    [
      ['a', 'ATTEMPTS_EXHAUSTED', 'operator', 'reset-attempts'],
      ['b', 'GATE_FAILED', 'lead', 'diagnose-failure'],
      [undefined, 'PAUSED', 'operator', 'resume-queue'],
      ['g1', 'REVIEW_ESCALATION', 'operator', 'user-decision'],
    ],
  );
  // Остановка без времени и в хранилище — момент запроса (since обязателен в версии 1).
  assert.equal(view.escalations[1]!.since, new Date(NOW).toISOString());
  assert.deepEqual(view.reviews[0]!.escalation, {
    requestId: 'plan:g1:4',
    findings: ['f1'],
    answered: false,
  });
});

test('view: дрейф — сдвинутые, переписанные и непрочитанные; совпавшие только считаются', () => {
  const sha = (c: string) => c.repeat(40);
  const accepted = (id: string, target: Record<string, unknown>) =>
    work(id, {
      status: 'done',
      resultSha: sha('a'),
      stage: { ...work(id).stage, name: 'done', next: [] },
      target: { repositoryId: 'app', ref: 'refs/heads/main', acceptedSha: sha('a'), ...target },
    });
  const view = operatorView(
    baseInput({
      works: [
        accepted('same', { head: sha('a'), commitsSinceAccepted: 0, filesSinceAccepted: 0 }),
        accepted('moved', { head: sha('b'), commitsSinceAccepted: 2, filesSinceAccepted: 3 }),
        accepted('rewritten', {
          head: sha('c'),
          commitsSinceAccepted: 1,
          filesSinceAccepted: 1,
          diverged: true,
        }),
        accepted('unknown', { unavailable: 'git не найден' }),
      ],
    }),
  );
  assert.deepEqual(
    view.drift.map((d) => d.workId),
    ['moved', 'rewritten', 'unknown'],
  );
  assert.deepEqual(view.health.drift, { checked: 4, drifted: 2, unavailable: 1 });
  assert.ok(view.health.warnings.some((w) => w.code === 'DRIFT_UNAVAILABLE'));
  assert.deepEqual(view.works[0]!.target, {
    repositoryId: 'app',
    ref: 'refs/heads/main',
    acceptedSha: sha('a'),
    // Вход без сверки удалённой ветки (хост прежней версии) — «неизвестно», не «отправлено».
    remote: {
      state: 'unknown',
      reason: 'удалённая ветка не проверялась',
      line: 'неизвестно (удалённая ветка не проверялась)',
    },
  });
});

test('view: поля alpha.55 по наличию — lastFailure, blockers plain/actor, verification, impact', () => {
  const w = work('a', {
    status: 'running',
    stage: {
      ...work('a').stage,
      name: 'gates',
      step: 'candidate-test:unit',
      since: at(5),
      next: ['review', 'integration'],
      needs: { actor: 'controller', action: 'wait' },
    },
    attemptSummary: {
      ...work('a').attemptSummary,
      failed: 1,
      lastFailure: {
        runId: 'a-run-1',
        bucket: 'environment',
        plain: 'окружение — порт 3000 занят',
        plainEn: 'environment — port 3000 is busy',
        at: at(30),
      },
    },
    active: { runtime: 'claude', model: 'm' },
    blockers: [
      {
        code: 'NOT_READY',
        plain: 'ждёт зависимости b',
        plainEn: 'waiting for dependency b',
        actor: 'controller',
      },
      { code: 'ATTEMPTS_EXHAUSTED', plain: 'попытки исчерпаны', actor: 'user' },
      { code: 'PAUSED' },
    ],
    verification: {
      runId: 'a-run-2',
      rows: [
        {
          gate: 'lint',
          kind: 'gate',
          phase: 'candidate',
          result: 'passed',
          how: 'executed-by-harness',
          at: at(4),
        },
        {
          gate: 'unit',
          kind: 'gate',
          phase: 'integration',
          result: 'reused',
          how: 'reused-evidence',
        },
        { gate: 'e2e', kind: 'gate', phase: 'candidate', result: 'not-applicable', how: 'not-run' },
        { gate: 'smoke', kind: 'gate', phase: 'candidate', result: 'skipped', how: 'not-run' },
        {
          gate: 'independent-review',
          kind: 'review',
          phase: 'candidate',
          result: 'passed',
          how: 'read-by-reviewer',
          reviewer: { runtime: 'codex', vendor: 'openai' },
        },
      ],
    },
  });
  const input = baseInput({
    works: [w],
    attempts: [
      attempt('a', 1, { status: 'failed', failureBucket: 'environment' }),
      attempt('a', 2, { status: 'active', finishedAt: undefined, startedAt: at(10) }),
    ],
    questions: [
      {
        requestId: 'q1',
        workId: 'a',
        state: 'awaiting-answer',
        version: 1,
        severity: 6,
        createdAt: at(8),
        text: 'Which library?',
        plain: 'Nothing changes for the user.',
        impact: 'technical',
        leadMay: true,
      },
      {
        requestId: 'q2',
        workId: 'a',
        state: 'delivered',
        version: 2,
        severity: 8,
        createdAt: at(9),
        leadMay: false,
        answeredBy: 'operator',
      },
    ],
  });
  const ru = operatorView(input);
  operatorViewSchema.parse(ru);
  const v = ru.works[0]!;
  assert.deepEqual(v.attempts.lastFailure, {
    attempt: 1,
    bucket: 'environment',
    plain: 'окружение — порт 3000 занят',
    at: at(30),
  });
  assert.deepEqual(v.blockers, [
    { code: 'NOT_READY', plain: 'ждёт зависимости b', actor: 'controller' },
    { code: 'ATTEMPTS_EXHAUSTED', plain: 'попытки исчерпаны', actor: 'operator' },
    // Без полей alpha.55 — кто действует по диагнозу этапа.
    { code: 'PAUSED', actor: 'controller' },
  ]);
  assert.equal(v.liveness, 'active');
  assert.deepEqual([v.runtime, v.model], ['claude', 'm']);
  assert.equal(v.attempts.line, 'попыток 0');
  const en = operatorView(input, { lang: 'en' });
  assert.equal(en.works[0]!.attempts.lastFailure!.plain, 'environment — port 3000 is busy');
  assert.equal(en.works[0]!.blockers[0]!.plain, 'waiting for dependency b');
  assert.equal(en.works[0]!.attempts.line, 'attempts 0');
  assert.deepEqual(
    ru.questions.map((q) => [q.requestId, q.answerableBy, q.impact]),
    [
      ['q1', 'operator-or-lead', 'technical'],
      ['q2', 'operator', 'user-visible'],
    ],
  );
  const detail = workDetailView(input, 'a');
  workDetailViewSchema.parse(detail);
  assert.deepEqual(
    detail.verification!.map((r) => [r.gate, r.phase, r.result, r.how, r.by ?? '', r.attempt]),
    [
      ['lint', 'candidate', 'passed', 'executed', 'harness', 2],
      ['unit', 'integration', 'reused', 'reused', '', 2],
      ['e2e', 'candidate', 'skipped', 'not-checked', '', 2],
      ['smoke', 'candidate', 'not-run', 'not-checked', '', 2],
      ['independent-review', 'candidate', 'passed', 'read', 'codex', 2],
    ],
  );
  assert.deepEqual(
    detail.questions.map((q) => q.requestId),
    ['q1', 'q2'],
  );
  // Без поля verification — нет и строк (не «проверено»).
  const bare = workDetailView(baseInput({ works: [work('b')] }), 'b');
  assert.equal(bare.verification, undefined);
  assert.throws(
    () => workDetailView(input, 'missing'),
    (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
  );
});

test('view: --no-titles убирает заголовки, текст вопросов и находок и queue.detail', () => {
  const input = baseInput({
    works: [work('a', { title: 'Secret plan for X' })],
    questions: [
      {
        requestId: 'q',
        workId: 'a',
        state: 'awaiting-answer',
        version: 1,
        severity: 8,
        createdAt: at(1),
        text: 'Q?',
        leadMay: false,
      },
    ],
    reviews: [
      review('g1', {
        findings: [{ id: 'f', severity: 'note', status: 'open', message: 'finding text' }],
      }),
    ],
    queue: { paused: true, reason: 'runtime', detail: 'provider failed' },
  });
  const titled = operatorView(input);
  assert.equal(titled.works[0]!.title, 'Secret plan for X');
  assert.equal(titled.progress.queue.detail, 'provider failed');
  const bare = operatorView(input, { titles: false });
  const text = JSON.stringify(bare);
  for (const s of ['Secret plan', 'Q?', 'finding text', 'provider failed'])
    assert.ok(!text.includes(s), s);
  operatorViewSchema.parse(bare);
});

test('view: окно и интервал — пределы; 7 дней по 1 ч — 168 значений', () => {
  const v = operatorView(baseInput(), { windowMs: 7 * DAY, bucketMs: 3_600_000 });
  assert.equal(v.history.load.length, 168);
  assert.equal(Date.parse(v.history.to) - Date.parse(v.history.from), 7 * DAY);
  for (const o of [
    { windowMs: 8 * DAY },
    { bucketMs: 1000 },
    { windowMs: 7 * DAY, bucketMs: 60_000 },
  ])
    assert.throws(
      () => operatorView(baseInput(), o),
      (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
    );
});

test('view: SHA-256 проекции совпадает с node:crypto', () => {
  for (const s of [
    '',
    'abc',
    'é‹masked›😀',
    'x'.repeat(1000),
    readFileSync(new URL(import.meta.url), 'utf8'),
  ])
    assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'));
});

test('view loader: прежний вызов без workId — по предмету, как status; неполный usage — не exact', () => {
  const s = viewState(
    () => {},
    (input) => {
      const c = input.calls!.find((x) => x.id === 'c-cancel-1') ?? input.calls![0]!;
      const legacy = { ...c, id: 'c-legacy', subjectId: 'gate', subjectKind: 'work' as const };
      delete (legacy as { runId?: string }).runId;
      delete (legacy as { workId?: string }).workId;
      legacy.usage = { ...legacy.usage, complete: false };
      legacy.costUsd = 0.5;
      (input.calls as (typeof legacy)[]).push(legacy);
    },
  );
  const view = harnessView({ stateDir: s.state, policyPath: s.policyPath, now: NOW });
  type Works = { works: { id: string; spend: { calls: number; usd: { bound: string } } }[] };
  // У `gate` остальные вызовы известны и полны: граница — только от прежнего вызова.
  const gate = (view as Works).works.find((w) => w.id === 'gate')!;
  assert.equal(gate.spend.calls, 3);
  assert.equal(gate.spend.usd.bound, 'lower');
  const plain = viewState();
  const before = harnessView({ stateDir: plain.state, policyPath: plain.policyPath, now: NOW });
  assert.equal((before as Works).works.find((w) => w.id === 'gate')!.spend.usd.bound, 'exact');
});

test('view loader: одни часы на всё чтение — вызов без конца не меняет байты между чтениями', () => {
  const s = viewState(
    () => {},
    (input) => {
      // Вызов без конца: его время считается до часов чтения.
      const c = input.calls![0]!;
      delete c.finishedAt;
    },
  );
  const a = JSON.stringify(harnessView({ stateDir: s.state, policyPath: s.policyPath, now: NOW }));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
  const b = JSON.stringify(harnessView({ stateDir: s.state, policyPath: s.policyPath, now: NOW }));
  assert.equal(a, b);
});

test('view: окно, не кратное интервалу, — INVALID_INPUT, а не окно длиннее запрошенного', () => {
  assert.throws(
    () => operatorView(baseInput(), { windowMs: 7 * DAY, bucketMs: 5 * DAY }),
    (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
  );
});

test('view loader: ревью без предела сводки status, все находки эскалации, неполный учёт ревью', () => {
  const s = viewState(
    () => {},
    (input) => {
      const base = input.reviews![0]!;
      const reviews = input.reviews as (typeof base)[];
      // 51 предмет плана: предмет графа работ — самый старый.
      for (let k = 0; k < 51; k++)
        reviews.push({
          ...base,
          id: `extra-${k}`,
          subject: `extra-${k}`,
          at: '2026-11-01T00:00:00.000Z',
        });
      const finding = base.findings[0]!;
      // 60 открытых блокирующих находок, открытых 4 раунда: все ждут решения.
      reviews.push({
        ...base,
        id: 'esc',
        subject: 'esc',
        round: 4,
        at: '2026-11-02T00:00:00.000Z',
        approved: false,
        findings: Array.from({ length: 60 }, (_, k) => ({
          ...finding,
          id: k.toString(16).padStart(64, '0'),
          severity: 'blocking' as const,
          status: 'open' as const,
          openedIn: 1,
          changedIn: 4,
          rounds: 4,
        })),
      });
      const call = input.calls![0]!;
      (input.calls as (typeof call)[]).push({
        ...call,
        id: 'c-plan-review',
        stage: 'plan-review',
        subjectId: 'esc',
        costUsd: 0.123456,
        usage: { ...call.usage, complete: false },
      });
      delete (input.calls as (typeof call)[]).at(-1)!.runId;
    },
  );
  const view = harnessView({ stateDir: s.state, policyPath: s.policyPath, now: NOW }) as ReturnType<
    typeof operatorView
  >;
  operatorViewSchema.parse(view);
  const esc = view.reviews.find((r) => r.subject === 'esc')!;
  assert.deepEqual(esc.spend.usd, { value: 0.123456, bound: 'lower' });
  assert.equal(esc.escalation!.findings.length, 50);
  assert.equal(view.reviews.length, 50);
  // 2 прежних + 51 + esc = 54 предмета; находки: 10 сверх предела у самих
  // находок и 10 у эскалации.
  assert.equal(view.truncated!.reviews, 4);
  assert.equal(view.truncated!.findings, 20);
  // Детали работы графа `demo` видят его ревью плана, хотя в обзоре предметов больше предела.
  const detail = harnessView({
    stateDir: s.state,
    policyPath: s.policyPath,
    now: NOW,
    workId: 'gate',
  });
  assert.ok(
    (detail as ReturnType<typeof workDetailView>).reviews.some((r) => r.subject === 'demo'),
  );
});

test('view: модели попыток и активной попытки маскируются; кавычки и Markdown не открывают секрет', () => {
  const KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const input = baseInput({
    works: [
      work('a', {
        active: { runtime: 'claude', model: `m ${KEY}` },
        title: 'Fix `/opt/private/k.pem` path',
      }),
    ],
    attempts: [attempt('a', 1, { model: `/opt/private/${KEY}` })],
  });
  const text = JSON.stringify([operatorView(input), workDetailView(input, 'a')]);
  assert.ok(!text.includes('sk-ant') && !text.includes('/opt/private'), text);
  for (const t of [
    `password='hunter2pass'`,
    `{"password":"hunter2pass"}`,
    'api_key: "hunter2pass"',
  ])
    assert.ok(!maskText(t, 200)!.includes('hunter2pass'), t);
});
