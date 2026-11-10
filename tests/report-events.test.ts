/**
 * Отчёт по событиям вмешательств и причин отказа (`work.retried`,
 * `work.cancelled`, `base.moved`, `attempt.diagnosed`): автоматические и
 * ручные повторы, отмены, сдвиги базы, подпричины окружения. История до
 * этих событий остаётся «≥»/неизвестной; покрытие определяется по окну.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readRunEventSchema, valueReportSchema, type RunEvent } from '../src/contracts/index.ts';
import {
  reportMarkdown,
  valueReport,
  type ValueReportInput,
  type ValueReportOptions,
} from '../src/report/index.ts';
import { STATE_DIR, reportFixture, shuffled, t } from './report-fixture.ts';
import { engineOf, graphOf, policyOf, ready } from './engine-fixture.ts';

const options: ValueReportOptions = {
  stateDir: STATE_DIR,
  harnessVersion: '0.0.0-test',
  label: 'demo',
};
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const published = ajv.compile(
  JSON.parse(readFileSync(new URL('../schemas/value-report.schema.json', import.meta.url), 'utf8')),
);

/**
 * События фикстуры и добавленные, по времени; seq — заново в том же порядке.
 * `drop` убирает события фикстуры этих типов.
 */
function withEvents(
  extra: [string, Record<string, unknown>][],
  drop: string[] = [],
): ValueReportInput {
  const input = reportFixture();
  const all = [
    ...input.events!.filter((e) => !drop.includes(e.type)).map((e) => [e.at, { ...e }] as const),
    ...extra.map(([at, rest]) => [at, { ...rest, at }] as const),
  ].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
  const events = all.map(([, e], i) =>
    readRunEventSchema.parse({
      ...e,
      apiVersion: 'devcontour-harness/v1alpha1',
      seq: i + 1,
    }),
  ) as RunEvent[];
  return { ...input, events };
}
const report = (input: ValueReportInput, o: ValueReportOptions = options) => {
  const r = valueReport(input, o);
  valueReportSchema.parse(r);
  assert.ok(published(JSON.parse(JSON.stringify(r))), JSON.stringify(published.errors));
  return r;
};
const ids = (r: ReturnType<typeof valueReport>) => r.limitations.map((l) => l.id);

const retried = (workId: string, by: string, reset = false) => ({
  type: 'work.retried',
  graphId: 'demo',
  workId,
  payload: { by, reset, ...(reset ? { spent: 2, reasonLength: 5 } : {}) },
});

/** Запись вмешательств идёт с начала истории: каждое поручение начато после неё. */
const covered = (): [string, Record<string, unknown>][] => [
  [t(-20), { type: 'base.moved', payload: { by: 'controller' } }],
  [t(7, 9, 30), retried('gate', 'operator', true)],
  [t(23, 10, 30), retried('env', 'recovery')],
  // Каждая новая попытка после отказа — с записанным повтором: пробела записи нет.
  [t(7, 11), retried('gate', 'recovery')],
  [t(21, 8), retried('review', 'recovery')],
  [t(-10), retried('legacy', 'recovery')],
  [t(25), retried('broken', 'recovery')],
  [
    t(2),
    {
      type: 'work.cancelled',
      graphId: 'demo',
      workId: 'never',
      payload: { by: 'operator', hadAttempt: false },
    },
  ],
  [
    t(29, 14, 20),
    {
      type: 'work.cancelled',
      graphId: 'demo',
      workId: 'cancel',
      runId: 'run-cancel-1',
      attempt: 1,
      payload: { by: 'graph', hadAttempt: true },
    },
  ],
  [
    t(23, 10, 2),
    {
      type: 'attempt.diagnosed',
      graphId: 'demo',
      workId: 'env',
      runId: 'run-env-1',
      attempt: 1,
      payload: { failureKind: 'environment', cause: 'transport', counted: false },
    },
  ],
];

test('report events: история целиком под записью — ручные и автоматические раздельно; удержание — неизвестно', () => {
  const r = report(withEvents(covered()));
  const rec = r.autonomy.actions.recorded!;
  assert.equal(rec.from, t(-20));
  assert.equal(rec.bound, 'exact');
  assert.equal(rec.gaps, 0);
  assert.deepEqual(rec.retries, { operator: 1, recovery: 5, host: 0 });
  assert.deepEqual(rec.resets, { operator: 1, recovery: 0, host: 0 });
  assert.deepEqual(rec.cancellations, { operator: 1, host: 0, graph: 1 });
  assert.equal(rec.cancelledWithoutAttempt, 1);
  assert.deepEqual(rec.baseMoves, { operator: 0, controller: 1, host: 0 });
  assert.equal(rec.baseMovesBound, 'lower');
  assert.equal(r.autonomy.actions.retries, 6);
  assert.equal(r.autonomy.actions.resets, 1);
  assert.equal(r.autonomy.actions.baseMoves, null, 'сдвиги базы — только нижняя граница');
  // Принято 5: ручной повтор только у `gate`; `review` удерживалось (актёр не
  // назван) — неизвестно; повтор восстановлением — не действие человека.
  assert.deepEqual(r.autonomy.withAction, { value: 1, n: 5, unknown: 1, bound: 'lower' });
  assert.deepEqual(r.autonomy.withoutAction, { value: 3, n: 5, unknown: 1, bound: 'lower' });
  assert.deepEqual(r.environment.causes, {
    rows: [{ cause: 'transport', count: 1, counted: 0 }],
    diagnosed: 1,
    undiagnosed: 0,
    bound: 'exact',
  });
  const limits = ids(r);
  for (const gone of ['actions-not-recorded', 'environment-cause', 'actions-from', 'recording-gap'])
    assert.ok(!limits.includes(gone), gone);
  for (const present of ['base-moves', 'rollback-gap', 'actions-unknown'])
    assert.ok(limits.includes(present), present);
  const md = reportMarkdown(r);
  assert.match(md, /needed no human action: ≥ 3 of 5\./);
  assert.match(md, /operator retries 1 \(resets 1\)/);
  assert.match(md, /recovery retries 5, controller base moves ≥ 1/);
  assert.match(md, /holds 1 \(held tasks count as unknown\)/);
  assert.match(md, /Environment sub-causes: network to the provider 1\./);
  assert.doesNotMatch(md, /Not recorded yet/);
  // `sandbox-policy` — и несобранная политика, и защищённые пути, изменённые
  // до работы (установка, подготовка фазы).
  const policy = structuredClone(r);
  policy.environment.causes!.rows = [{ cause: 'sandbox-policy', count: 1, counted: 0 }];
  assert.match(
    reportMarkdown(policy),
    /Environment sub-causes: sandbox policy not built, or protected paths changed before work 1\./,
  );
  // Без удержания то же окно точно: 4 of 5.
  const unheld = report(withEvents(covered(), ['work.held']));
  assert.deepEqual(unheld.autonomy.withoutAction, { value: 4, n: 5, unknown: 0, bound: 'exact' });
  assert.deepEqual(unheld.autonomy.withAction, { value: 1, n: 5, unknown: 0, bound: 'exact' });
  assert.ok(!ids(unheld).includes('actions-unknown'));
  assert.match(reportMarkdown(unheld), /needed no human action: 4 of 5\./);
  // Детерминизм с новыми событиями: перестановка входа не меняет байты.
  const input = withEvents(covered());
  assert.equal(
    JSON.stringify(valueReport(shuffled(input, 7), options)),
    JSON.stringify(valueReport(input, options)),
  );
});

test('report events: повтор хоста без актёра — поручение неизвестно, «без действий» — нижняя граница', () => {
  const r = report(
    withEvents([...covered(), [t(0, 9, 45), retried('first', 'host')]], ['work.held']),
  );
  assert.deepEqual(r.autonomy.withAction, { value: 1, n: 5, unknown: 1, bound: 'lower' });
  assert.deepEqual(r.autonomy.withoutAction, { value: 3, n: 5, unknown: 1, bound: 'lower' });
  assert.equal(r.autonomy.actions.recorded!.retries.host, 1);
  assert.equal(r.autonomy.actions.recorded!.bound, 'exact', 'запись покрывает окно');
  assert.ok(ids(r).includes('actions-unknown'));
  assert.ok(!ids(r).includes('actions-from'));
  assert.match(reportMarkdown(r), /needed no human action: ≥ 3 of 5/);
});

test('report events: смешанная история — до первой записи «≥»; окно после неё — точно', () => {
  // Запись начинается в середине истории (t(9, 0)): поручения first, gate и
  // legacy начаты раньше — их действия неизвестны. Повторы после неё записаны.
  const mixed = withEvents(
    [
      [t(9, 0), { type: 'base.moved', payload: { by: 'operator' } }],
      [t(21, 8), retried('review', 'recovery')],
      [t(23, 10, 30), retried('env', 'recovery')],
      [t(25), retried('broken', 'recovery')],
    ],
    ['work.held'],
  );
  const all = report(mixed);
  assert.equal(all.autonomy.actions.recorded!.bound, 'lower');
  assert.equal(all.autonomy.actions.retries, null, 'сумма при нижней границе не показывается');
  assert.deepEqual(all.autonomy.withoutAction, { value: 2, n: 5, unknown: 3, bound: 'lower' });
  assert.deepEqual(all.autonomy.withAction, { value: 0, n: 5, unknown: 3, bound: 'lower' });
  assert.ok(ids(all).includes('actions-from'));
  assert.ok(ids(all).includes('actions-unknown'));
  assert.match(reportMarkdown(all), /operator retries ≥ 0 \(resets ≥ 0\)/);
  assert.match(reportMarkdown(all), /operator base moves ≥ 1/);
  // Окно после начала записи: и действия, и поручения в нём под записью.
  const late = report(mixed, { ...options, since: t(9, 0) });
  assert.equal(late.autonomy.actions.recorded!.bound, 'exact');
  assert.deepEqual(late.autonomy.withoutAction, { value: 2, n: 2, unknown: 0, bound: 'exact' });
  assert.equal(late.autonomy.actions.retries, 3);
  assert.equal(late.autonomy.actions.recorded!.baseMoves.operator, 1);
  assert.ok(!ids(late).includes('actions-from'));
  // Окно до начала записи: событий в нём нет, но запись в журнале есть — «≥».
  const early = report(mixed, { ...options, until: t(9, 0) });
  assert.equal(early.autonomy.actions.recorded!.bound, 'lower');
  assert.equal(early.autonomy.actions.retries, null);
  assert.equal(early.autonomy.actions.recorded!.retries.operator, 0);
  assert.equal(early.autonomy.withoutAction.bound, 'lower');
  assert.equal(early.autonomy.withoutAction.value, 0);
});

/** Конец первой и выдача второй попытки `env`: порядок попыток в журнале. */
const envAttemptEvents = (): [string, Record<string, unknown>][] => [
  [
    t(23, 10, 2),
    {
      type: 'attempt.failed',
      graphId: 'demo',
      workId: 'env',
      runId: 'run-env-1',
      attempt: 1,
      payload: { failureKind: 'environment', message: 'x', blocked: true },
    },
  ],
  [
    t(23, 11),
    {
      type: 'attempt.claimed',
      graphId: 'demo',
      workId: 'env',
      runId: 'run-env-2',
      attempt: 2,
      payload: {
        owner: 'c1',
        runtime: 'claude',
        reviewer: 'codex',
        policyDigest: 'b'.repeat(64),
        engineVersion: '0.0.0-test',
      },
    },
  ],
];

test('report events: пробел записи — новая попытка без записанного повтора; новая редакция графа его объясняет', () => {
  // Запись идёт с t(9, 0), но повтор `env` (между t(23,10,2) и t(23,11)) не
  // записан: между ними работала версия без событий (откат и повторное обновление).
  const gap = withEvents(
    [
      [t(9, 0), { type: 'base.moved', payload: { by: 'operator' } }],
      [t(21, 8), retried('review', 'recovery')],
      [t(25), retried('broken', 'recovery')],
      ...envAttemptEvents(),
    ],
    ['work.held'],
  );
  const late = report(gap, { ...options, since: t(9, 0) });
  assert.equal(late.autonomy.actions.recorded!.gaps, 1);
  assert.equal(late.autonomy.actions.recorded!.bound, 'lower');
  assert.deepEqual(late.autonomy.withoutAction, { value: 1, n: 2, unknown: 1, bound: 'lower' });
  assert.ok(ids(late).includes('recording-gap'));
  // Новая редакция графа между попытками снова открывает поручение без повтора.
  const revised = withEvents(
    [
      [t(9, 0), { type: 'base.moved', payload: { by: 'operator' } }],
      [t(21, 8), retried('review', 'recovery')],
      [t(25), retried('broken', 'recovery')],
      ...envAttemptEvents(),
      [
        t(23, 10, 30),
        {
          type: 'graph.registered',
          graphId: 'demo',
          payload: {
            digest: 'a'.repeat(64),
            orders: 8,
            source: { connector: 'files', ref: 'demo', revision: '2' },
          },
        },
      ],
    ],
    ['work.held'],
  );
  const ok = report(revised, { ...options, since: t(9, 0) });
  assert.equal(ok.autonomy.actions.recorded!.gaps, 0);
  assert.equal(ok.autonomy.actions.recorded!.bound, 'exact');
});

test('report events: без новых событий — прежняя форма: не записано, неизвестно', () => {
  const r = report(reportFixture());
  assert.equal(r.autonomy.actions.recorded, null);
  assert.equal(r.autonomy.actions.retries, null);
  assert.equal(r.environment.causes, null);
  assert.equal(r.autonomy.withoutAction.bound, 'unknown');
  assert.ok(ids(r).includes('actions-not-recorded'));
  assert.ok(ids(r).includes('environment-cause'));
  assert.match(reportMarkdown(r), /Environment sub-causes: not recorded yet\./);
});

test('report events: подпричины — отказ окружения без события до записи; bound lower', () => {
  // Причина есть только у отказа не окружения: отказ окружения записан раньше.
  const r = report(
    withEvents([
      [
        t(7, 10, 25),
        {
          type: 'attempt.diagnosed',
          graphId: 'demo',
          workId: 'gate',
          runId: 'run-gate-2',
          attempt: 2,
          payload: { failureKind: 'gate', cause: 'none', counted: true },
        },
      ],
    ]),
  );
  assert.deepEqual(r.environment.causes, {
    rows: [],
    diagnosed: 0,
    undiagnosed: 1,
    bound: 'lower',
  });
  assert.ok(ids(r).includes('environment-cause-from'));
  assert.ok(!ids(r).includes('environment-cause'));
  assert.match(
    reportMarkdown(r),
    /Environment sub-causes \(1 earlier failure without a recorded sub-cause\): none in the window\./,
  );
});

test('report events: пробел записи — по порядку журнала, а не по часам: часы движка смещены', () => {
  // Часы движка (2026-01-01) на месяцы позади часов записи событий: сравнение
  // времени попытки с временем события не годится, порядок seq — годится.
  const run = (gap: boolean) => {
    const { engine, store } = engineOf(
      policyOf((p) => ((p as { maxAttempts: number }).maxAttempts = 5)),
    );
    ready(engine, graphOf({ a: [] }));
    const first = engine.claim('c1')!;
    engine.fail(first.id, first.token, 'unit failed', { kind: 'gate' });
    if (gap)
      // Повтор прежней версией (после отката): состояние без события.
      store.transact('task.retry', (tx) => {
        const w = tx.work('a')!;
        tx.putWork({ ...w, status: 'ready', failure: undefined, failureKind: undefined });
      });
    else engine.retry('a', undefined, 'recovery');
    engine.claim('c1')!;
    const input: ValueReportInput = engine.read((v) => ({
      works: v.works('g'),
      attempts: v.attempts('a'),
      events: store.events(0, 1000),
    }));
    return report(input);
  };
  assert.equal(run(false).autonomy.actions.recorded!.gaps, 0);
  const gap = run(true).autonomy.actions.recorded!;
  assert.equal(gap.gaps, 1);
  assert.equal(gap.bound, 'lower');
});

test('report events: остановка вопросом, вернувшая попытку, не засчитана — продолжение принято с первой попытки', () => {
  // `first` принято с первой попытки; перед ней — остановка вопросом с тем же
  // номером попытки (ответ применён, работа продолжена).
  const withQuestion = (diagnosed?: boolean): ValueReportInput => {
    const base = withEvents(
      diagnosed === undefined
        ? []
        : [
            [
              t(0, 9, 40),
              {
                type: 'attempt.diagnosed',
                graphId: 'demo',
                workId: 'first',
                runId: 'run-first-q',
                attempt: 1,
                payload: { failureKind: 'needs-input', cause: 'none', counted: diagnosed },
              },
            ],
          ],
    );
    const accepted = base.attempts.find((a) => a.id === 'run-first-1')!;
    const question = {
      ...accepted,
      id: 'run-first-q',
      status: 'failed' as const,
      phase: 'failed' as const,
      failureKind: 'needs-input' as const,
      startedAt: t(0, 9, 20),
      finishedAt: t(0, 9, 40),
      evidence: [],
    };
    return { ...base, attempts: [...base.attempts, question] };
  };
  const firstRow = (r: ReturnType<typeof valueReport>) =>
    r.works.rows.find((w) => w.id === 'first')!;
  const before = report(withEvents([]));
  // Попытку вернул движок (`counted: false`): первая попытка, как без вопроса.
  const given = report(withQuestion(false));
  assert.deepEqual(given.speed.firstPass, before.speed.firstPass);
  assert.equal(firstRow(given).attempts, 2);
  assert.equal(firstRow(given).counted, 1);
  // Сверх предела остановок вопросом движок засчитал её — не первая попытка.
  const capped = report(withQuestion(true));
  assert.equal(capped.speed.firstPass.value, before.speed.firstPass.value! - 1);
  assert.equal(firstRow(capped).counted, 2);
  // Без события (версия до возврата попытки) остановка засчитана, как тогда.
  const legacy = report(withQuestion());
  assert.equal(legacy.speed.firstPass.value, before.speed.firstPass.value! - 1);
  assert.equal(firstRow(legacy).counted, 2);
});

test('report events: явные сбросы бюджета совместных проверок считаются по актёру', () => {
  const reset = (by: string) => ({
    type: 'joint.budget-reset',
    payload: { resetId: 'R-' + by, workIds: ['gate', 'env'], by, settled: 3, reasonLength: 9 },
  });
  const r = report(
    withEvents([
      ...covered(),
      [t(8), reset('operator')],
      [t(9), reset('host')],
      [t(10), reset('operator')],
    ]),
  );
  assert.deepEqual(r.autonomy.actions.recorded!.jointResets, { operator: 2, host: 1 });
  assert.match(reportMarkdown(r), /Joint verification budget resets: operator 2, host 1/);
  assert.deepEqual(report(withEvents(covered())).autonomy.actions.recorded!.jointResets, {
    operator: 0,
    host: 0,
  });
});
