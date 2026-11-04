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

const options: ValueReportOptions = {
  stateDir: STATE_DIR,
  harnessVersion: '0.0.0-test',
  label: 'demo',
};
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const published = ajv.compile(
  JSON.parse(readFileSync(new URL('../schemas/value-report.schema.json', import.meta.url), 'utf8')),
);

/** События фикстуры и добавленные, по времени; seq — заново в том же порядке. */
function withEvents(extra: [string, Record<string, unknown>][]): ValueReportInput {
  const input = reportFixture();
  const all = [
    ...input.events!.map((e) => [e.at, { ...e }] as const),
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

test('report events: история целиком под записью — «без действий человека» точно; ручные и автоматические раздельно', () => {
  const r = report(withEvents(covered()));
  const rec = r.autonomy.actions.recorded!;
  assert.equal(rec.from, t(-20));
  assert.equal(rec.bound, 'exact');
  assert.deepEqual(rec.retries, { operator: 1, recovery: 1, host: 0 });
  assert.deepEqual(rec.resets, { operator: 1, recovery: 0, host: 0 });
  assert.deepEqual(rec.cancellations, { operator: 1, host: 0, graph: 1 });
  assert.equal(rec.cancelledWithoutAttempt, 1);
  assert.deepEqual(rec.baseMoves, { operator: 0, controller: 1, host: 0 });
  assert.equal(r.autonomy.actions.retries, 2);
  assert.equal(r.autonomy.actions.resets, 1);
  assert.equal(r.autonomy.actions.baseMoves, 1);
  // Принято 5: ручной повтор только у `gate`; повтор восстановлением — не действие человека.
  assert.deepEqual(r.autonomy.withAction, { value: 1, n: 5, unknown: 0, bound: 'exact' });
  assert.deepEqual(r.autonomy.withoutAction, { value: 4, n: 5, unknown: 0, bound: 'exact' });
  assert.deepEqual(r.environment.causes, {
    rows: [{ cause: 'transport', count: 1, counted: 0 }],
    diagnosed: 1,
    undiagnosed: 0,
    bound: 'exact',
  });
  const limits = ids(r);
  for (const gone of ['actions-not-recorded', 'environment-cause', 'actions-from'])
    assert.ok(!limits.includes(gone), gone);
  assert.ok(limits.includes('base-moves'));
  const md = reportMarkdown(r);
  assert.match(md, /needed no human action: 4 of 5\./);
  assert.match(md, /operator retries 1 \(resets 1\)/);
  assert.match(md, /recovery retries 1, controller base moves 1/);
  assert.match(md, /Environment sub-causes: network to the provider 1\./);
  assert.doesNotMatch(md, /Not recorded yet/);
  // Детерминизм с новыми событиями: перестановка входа не меняет байты.
  const input = withEvents(covered());
  assert.equal(
    JSON.stringify(valueReport(shuffled(input, 7), options)),
    JSON.stringify(valueReport(input, options)),
  );
});

test('report events: повтор хоста без актёра — поручение неизвестно, «без действий» — нижняя граница', () => {
  const r = report(withEvents([...covered(), [t(22, 9, 30), retried('review', 'host')]]));
  assert.deepEqual(r.autonomy.withAction, { value: 1, n: 5, unknown: 1, bound: 'lower' });
  assert.deepEqual(r.autonomy.withoutAction, { value: 3, n: 5, unknown: 1, bound: 'lower' });
  assert.equal(r.autonomy.actions.recorded!.retries.host, 1);
  assert.equal(r.autonomy.actions.recorded!.bound, 'exact', 'запись покрывает окно');
  assert.ok(ids(r).includes('actions-from'));
  assert.match(reportMarkdown(r), /needed no human action: ≥ 3 of 5/);
});

test('report events: смешанная история — до первой записи «≥»; окно после неё — точно', () => {
  // Запись начинается в середине истории (t(9, 0)): поручения first, gate и
  // legacy начаты раньше — их действия неизвестны.
  const mixed = withEvents([[t(9, 0), { type: 'base.moved', payload: { by: 'operator' } }]]);
  const all = report(mixed);
  assert.equal(all.autonomy.actions.recorded!.bound, 'lower');
  assert.deepEqual(all.autonomy.withoutAction, { value: 2, n: 5, unknown: 3, bound: 'lower' });
  assert.deepEqual(all.autonomy.withAction, { value: 0, n: 5, unknown: 3, bound: 'lower' });
  assert.ok(ids(all).includes('actions-from'));
  assert.match(reportMarkdown(all), /operator retries ≥ 0 \(resets ≥ 0\)/);
  assert.match(reportMarkdown(all), /operator base moves ≥ 1/);
  // Окно после начала записи: и действия, и поручения в нём под записью.
  const late = report(mixed, { ...options, since: t(9, 0) });
  assert.equal(late.autonomy.actions.recorded!.bound, 'exact');
  assert.deepEqual(late.autonomy.withoutAction, { value: 2, n: 2, unknown: 0, bound: 'exact' });
  assert.equal(late.autonomy.actions.baseMoves, 1);
  assert.ok(!ids(late).includes('actions-from'));
  // Окно до начала записи: событий в нём нет, но запись в журнале есть — нули, «≥».
  const early = report(mixed, { ...options, until: t(9, 0) });
  assert.equal(early.autonomy.actions.recorded!.bound, 'lower');
  assert.equal(early.autonomy.actions.retries, 0);
  assert.equal(early.autonomy.withoutAction.bound, 'lower');
  assert.equal(early.autonomy.withoutAction.value, 0);
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
    /Environment sub-causes \(1 earlier failures without a recorded sub-cause\): none in the window\./,
  );
});
