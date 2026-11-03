import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  HarnessError,
  REPORT_LIMITS,
  REPORT_VERSION,
  containsToken,
  failureBuckets,
  valueReportSchema,
  type AttemptState,
  type CallRecord,
  type WorkState,
} from '../src/contracts/index.ts';
import { knownCost } from '../src/engine/usage.ts';
import {
  assertReportBytes,
  callCostKnown,
  failureBucketNames,
  isoWeekOf,
  reportHtml,
  reportLimits,
  reportMarkdown,
  reportPath,
  reportVersion,
  valueReport,
  type ValueReportInput,
  type ValueReportOptions,
} from '../src/report/index.ts';
import * as root from '../src/index.ts';
import * as reportModule from '../src/report/index.ts';
import {
  HOME,
  SECRET,
  STATE_DIR,
  digest,
  reportFixture,
  shuffled,
  t,
  tokenOf,
} from './report-fixture.ts';

const golden = (name: string) =>
  fileURLToPath(new URL(`./fixtures/report/${name}`, import.meta.url));
const options: ValueReportOptions = {
  stateDir: STATE_DIR,
  harnessVersion: '0.0.0-test',
  label: 'demo',
};
const render = (input: ValueReportInput = reportFixture(), o: ValueReportOptions = options) => {
  const report = valueReport(input, o);
  return {
    report,
    json: JSON.stringify(report, null, 2) + '\n',
    md: reportMarkdown(report),
    html: reportHtml(report),
  };
};
/** Сверка с эталоном; `UPDATE_GOLDEN=1` перезаписывает эталон. */
const matches = (name: string, actual: string) => {
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(golden(name), actual);
  assert.equal(actual, readFileSync(golden(name), 'utf8'), name);
};
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const published = ajv.compile(
  JSON.parse(readFileSync(new URL('../schemas/value-report.schema.json', import.meta.url), 'utf8')),
);
const keep = (input: ValueReportInput, works: string[]): ValueReportInput => ({
  ...input,
  works: input.works.filter((w) => works.includes(w.id)),
  attempts: input.attempts.filter((a) => works.includes(a.workId)),
  calls: (input.calls ?? []).filter((c) => !c.runId || works.some((w) => c.runId!.includes(w))),
});

test('report: эталон JSON, Markdown и HTML синтетического состояния; JSON по строгой и опубликованной схеме', () => {
  const r = render();
  valueReportSchema.parse(r.report);
  assert.ok(published(r.report), JSON.stringify(published.errors));
  matches('report.json', r.json);
  matches('report.md', r.md);
  matches('report.html', r.html);
});

test('report: ключевые числа фикстуры — принятые, первая попытка, возвраты, окружение, D4, D6', () => {
  const { report: r } = render();
  assert.equal(r.reportVersion, 1);
  assert.equal(r.enoughData, true);
  assert.equal(r.window.asOf, t(29, 16));
  assert.deepEqual(r.speed.finished, { accepted: 5, failed: 1, cancelled: 1 });
  // env: отказ окружения не засчитан — первая попытка; gate: прерывание не засчитано, отказ gate — засчитан.
  // legacy: кроме принявшей, только отказ без класса — первая ли попытка, неизвестно.
  assert.deepEqual(r.speed.firstPass, { value: 2, n: 5, unknown: 1, bound: 'lower' });
  assert.deepEqual(r.speed.firstPassRaw, { value: 1, n: 5, unknown: 0, bound: 'exact' });
  // legacy: до приёмки только отказ без класса — неизвестно, вернули ли его.
  assert.deepEqual(r.defects.sentBack, { value: 2, n: 5, unknown: 1, bound: 'lower' });
  assert.deepEqual(r.defects.byKind, { gate: 2, review: 1, 'scope-violation': 1 });
  assert.deepEqual(r.defects.afterGreenGates.value, 1);
  assert.equal(r.defects.byGate.find((g) => g.gate === 'install')?.setup, true);
  assert.deepEqual(r.defects.planContract.blockingClosed, 1);
  assert.equal(r.defects.planContract.rejected, 1);
  assert.deepEqual(
    r.environment.buckets.filter((b) => b.count).map((b) => [b.bucket, b.count]),
    [
      ['defect', 4],
      ['environment', 1],
      ['operator', 1],
      ['unclassified', 1],
    ],
  );
  assert.equal(r.environment.interrupted, 1);
  // broken-2 отказал только в gate установки — возможно, тоже окружение.
  assert.deepEqual(r.environment.share, { value: 1, n: 6, unknown: 1, bound: 'lower' });
  assert.equal(r.environment.setupCheckFailures, 1);
  // Попытки — из записей попыток: у legacy счётчик WorkState.attempt = 0, попыток 2.
  assert.equal(r.works.rows.find((w) => w.id === 'legacy')?.attempts, 2);
  // Начало срока — wait.approvedAt первой попытки; у legacy его нет — запасной вариант.
  assert.equal(r.speed.leadTimeFallback, 1);
  // Удержание (work.held) актёра не называет — не действие человека.
  assert.equal(r.autonomy.withAction.value, 0);
  assert.equal(r.autonomy.actions.holds, 1);
  assert.equal(r.autonomy.withAction.bound, 'lower');
  assert.deepEqual(r.autonomy.withoutAction, { value: null, n: 5, unknown: 5, bound: 'unknown' });
  assert.equal(r.autonomy.actions.retries, null);
  assert.deepEqual(
    r.autonomy.pauses.map((p) => [p.reason, p.count, p.pausedMs, p.open]),
    [
      ['operator', 1, 3_600_000, 1],
      ['runtime', 1, 1_800_000, 0],
    ],
  );
  assert.deepEqual(
    r.weeks.rows.map((w) => (w.kind === 'gap' ? `gap ${w.from}..${w.to}` : w.week)),
    [
      '2026-W45',
      '2026-W44',
      'gap 2026-W43..2026-W43',
      '2026-W42',
      '2026-W41',
      '2026-W40',
      '2026-W39',
    ],
  );
  assert.ok(r.limitations.length >= 6);
  assert.ok(r.limitations.some((l) => l.id === 'actions-not-recorded'));
});

test('report: перечни и пределы модуля без zod совпадают с договором; цена известна — по правилу учёта', () => {
  assert.deepEqual([...failureBucketNames], [...failureBuckets]);
  assert.deepEqual(reportLimits, REPORT_LIMITS);
  assert.equal(reportVersion, REPORT_VERSION);
  const base = reportFixture().calls![0]!;
  const variants: CallRecord[] = [];
  for (const outcome of ['active', 'returned', 'error', 'abandoned'] as const)
    for (const costSource of ['provider-reported', 'tariff-estimate', 'unknown'] as const)
      for (const costUsd of [null, 0, 1.5])
        variants.push({ ...base, outcome, costSource, costUsd });
  for (const c of variants) assert.equal(callCostKnown(c), knownCost(c), JSON.stringify(c));
  // Корень пакета и ./report — одна реализация.
  for (const [name, value] of Object.entries(reportModule))
    assert.equal((root as Record<string, unknown>)[name], value, name);
});

test('report: детерминизм — перестановки входа, повтор и часовой пояс не меняют байты', () => {
  const first = render();
  for (const seed of [1, 7, 42, 1234]) {
    const again = render(shuffled(reportFixture(), seed));
    assert.equal(again.json, first.json, `seed ${seed}`);
    assert.equal(again.md, first.md);
    assert.equal(again.html, first.html);
  }
  const script = `
    const { reportFixture, STATE_DIR } = await import(${JSON.stringify(new URL('./report-fixture.ts', import.meta.url).href)});
    const m = await import(${JSON.stringify(new URL('../src/report/index.ts', import.meta.url).href)});
    const r = m.valueReport(reportFixture(), { stateDir: STATE_DIR, harnessVersion: '0.0.0-test', label: 'demo' });
    process.stdout.write(JSON.stringify([JSON.stringify(r), m.reportMarkdown(r), m.reportHtml(r)]));`;
  const outputs = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'].map((tz) => {
    const r = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
      { encoding: 'utf8', env: { ...process.env, TZ: tz, LANG: 'de_DE.UTF-8', NODE_OPTIONS: '' } },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });
  assert.equal(outputs[1], outputs[0]);
  assert.equal(outputs[2], outputs[0]);
  const [json, md, html] = JSON.parse(outputs[0]!) as string[];
  assert.equal(json, JSON.stringify(first.report));
  assert.equal(md, first.md);
  assert.equal(html, first.html);
});

test('report: время с другим поясом — тот же момент: тот же отчёт байт в байт', () => {
  // 2026-10-05T09:00:00.000Z → 2026-10-05T12:00:00.000+03:00
  const shift = (iso: string) => {
    const d = new Date(Date.parse(iso) + 3 * 3_600_000).toISOString();
    return d.slice(0, -1) + '+03:00';
  };
  const input = reportFixture();
  const moved: ValueReportInput = {
    ...input,
    attempts: input.attempts.map((a) => ({
      ...a,
      startedAt: shift(a.startedAt),
      ...(a.finishedAt ? { finishedAt: shift(a.finishedAt) } : {}),
      evidence: a.evidence.map((e) => ({ ...e, createdAt: shift(e.createdAt) })),
    })),
    calls: input.calls!.map((c) => ({ ...c, startedAt: shift(c.startedAt) })),
  };
  assert.equal(render(moved).json, render(input).json);
});

test('report: as-of по умолчанию — последняя метка данных; явный --as-of и --until его задают', () => {
  const input = reportFixture();
  assert.equal(valueReport(input).window.asOf, t(29, 16));
  assert.equal(
    valueReport(input, { asOf: '2026-12-01T00:00:00Z' }).window.asOf,
    '2026-12-01T00:00:00.000Z',
  );
  assert.equal(valueReport(input, { until: '2026-10-20' }).window.asOf, '2026-10-20T00:00:00.000Z');
  // Пустое состояние: момент — эпоха, а не часы.
  assert.equal(valueReport({ works: [], attempts: [] }).window.asOf, '1970-01-01T00:00:00.000Z');
});

test('report: окно — начало включительно, конец не включительно; относительное начало от as-of', () => {
  const input = reportFixture();
  const acceptedAt = t(8, 11); // приёмка gate
  const from = valueReport(input, { since: acceptedAt });
  assert.ok(from.works.rows.some((w) => w.id === 'gate'));
  const before = valueReport(input, { until: acceptedAt });
  assert.ok(!before.works.rows.some((w) => w.id === 'gate'));
  assert.ok(before.works.rows.some((w) => w.id === 'first'));
  // 7d до as-of (2026-11-03T16:00Z): только неделя W45.
  const week = valueReport(input, { since: '7d' });
  assert.equal(week.window.since, '2026-10-27T16:00:00.000Z');
  assert.deepEqual(week.works.rows.map((w) => w.id).sort(), ['broken', 'cancel', 'env']);
  assert.equal(valueReport(input, { since: '2w' }).window.since, '2026-10-20T16:00:00.000Z');
});

test('report: неверное окно — INVALID_INPUT (since ≥ until, время без пояса, мусор)', () => {
  const input = reportFixture();
  const code = (o: ValueReportOptions) => {
    try {
      valueReport(input, o);
      return 'ok';
    } catch (e) {
      assert.ok(e instanceof HarnessError);
      return e.code;
    }
  };
  assert.equal(code({ since: '2026-10-10', until: '2026-10-10' }), 'INVALID_INPUT');
  assert.equal(code({ since: '2026-10-11', until: '2026-10-10' }), 'INVALID_INPUT');
  assert.equal(code({ since: '2026-10-10T10:00:00' }), 'INVALID_INPUT');
  assert.equal(code({ until: 'yesterday' }), 'INVALID_INPUT');
  assert.equal(code({ asOf: '10/10/2026' }), 'INVALID_INPUT');
  assert.equal(code({ since: '2026-10-10T10:00:00+03:00', until: '2026-10-11' }), 'ok');
});

test('report: меньше 3 принятых — «недостаточно данных» без заголовочных чисел; ровно 3 — сводка', () => {
  const input = reportFixture();
  const two = render(keep(input, ['first', 'gate', 'broken']));
  assert.equal(two.report.enoughData, false);
  assert.equal(two.report.summary.status, 'not-enough-data');
  assert.match(two.md, /Not enough data yet: 2 tasks accepted/);
  assert.match(two.html, /Not enough data yet: 2 tasks accepted/);
  assert.ok(two.report.limitations.length >= 6, 'ограничения есть всегда');
  assert.match(two.md, /## Limits and unknowns/);
  const three = valueReport(keep(input, ['first', 'gate', 'env']), options);
  assert.equal(three.summary.status, 'ok');
  assert.equal(three.summary.status === 'ok' && three.summary.headlines.length, 5);
});

test('report: процент только при знаменателе от 20; медиана только от 5 значений', () => {
  const fixture = render();
  assert.doesNotMatch(fixture.md, /\d%/);
  assert.doesNotMatch(fixture.html.replace(/<style>[^]*<\/style>/, ''), /\d%/);
  // Три принятых: медианы нет, значения перечислены.
  const three = render(keep(reportFixture(), ['first', 'gate', 'env']));
  assert.equal(three.report.speed.leadTime.median, null);
  assert.equal(three.report.speed.leadTime.values.length, 3);
  assert.match(three.md, /no median under 5/);
  // 20 принятых с первой попытки: процент появляется.
  const input = reportFixture();
  const first = input.works.find((w) => w.id === 'first')!;
  const run = input.attempts.find((a) => a.id === 'run-first-1')!;
  const works: WorkState[] = [];
  const attempts: AttemptState[] = [];
  for (let i = 0; i < 20; i++) {
    works.push({ ...first, id: `w${i}` });
    attempts.push({ ...run, id: `r${i}`, workId: `w${i}`, token: tokenOf(`r${i}`) });
  }
  const many = render({ works, attempts });
  assert.equal(many.report.speed.firstPass.n, 20);
  assert.match(many.md, /20 tasks accepted\. 20 of them \(100%\) on the first try\./);
  assert.notEqual(many.report.speed.leadTime.median, null);
});

test('report: неизвестная цена — «≥» с числом вызовов, не ноль; полная цена — «=»; без учёта — unknown', () => {
  const { report, md, html } = render();
  const spend =
    report.summary.status === 'ok' && report.summary.headlines.find((h) => h.id === 'spend');
  assert.ok(spend);
  assert.equal(spend.measure.bound, 'lower');
  assert.equal(spend.value, '≥ $2.37');
  assert.match(spend.text, /1 call without a known price/);
  assert.match(spend.text, /2 attempts without call records/);
  assert.equal(report.cost.unknown.noPrice, 1);
  assert.deepEqual(report.cost.unknown.byRuntime, [{ runtime: 'codex', calls: 1 }]);
  assert.match(md, /≥ \$2\.37/);
  assert.match(html, /≥ \$2\.37/);

  // Обратный случай: все вызовы с ценой и полными счётчиками, все попытки с учётом — точное значение.
  const input = keep(reportFixture(), ['first', 'gate', 'env']);
  const priced: ValueReportInput = {
    ...input,
    calls: input.calls!.map((c) =>
      c.costUsd === null ? { ...c, costUsd: 0.3, costSource: 'tariff-estimate' as const } : c,
    ),
  };
  const exact = valueReport(priced, options);
  assert.equal(exact.cost.perAccepted.bound, 'exact');
  assert.match(reportMarkdown(exact), /Spend per accepted task = \$/);

  // Нет ни одного вызова с ценой, попытки без учёта — значение неизвестно, а не $0.00.
  const none = valueReport(
    {
      ...input,
      calls: [],
      attempts: input.attempts.map((a) => ({ ...a, callsRecorded: undefined })),
    },
    options,
  );
  assert.equal(none.cost.perAccepted.value, null);
  assert.equal(none.cost.perAccepted.bound, 'unknown');
  const headline =
    none.summary.status === 'ok' && none.summary.headlines.find((h) => h.id === 'spend');
  assert.ok(headline);
  assert.equal(headline.value, 'unknown');
  assert.doesNotMatch(headline.text, /\$0\.00/);
});

test('report: попытка без класса — unclassified, а не дефект; с классом gate — дефект', () => {
  const input = keep(reportFixture(), ['legacy']);
  const legacy = valueReport(input, options);
  assert.equal(legacy.defects.rejected, 0);
  assert.equal(legacy.environment.buckets.find((b) => b.bucket === 'unclassified')?.count, 1);
  assert.ok(legacy.limitations.some((l) => l.id === 'unclassified'));
  const classified = valueReport(
    {
      ...input,
      attempts: input.attempts.map((a) =>
        a.status === 'failed' ? { ...a, failureKind: 'gate' as const } : a,
      ),
    },
    options,
  );
  assert.equal(classified.defects.rejected, 1);
  assert.equal(classified.environment.buckets.find((b) => b.bucket === 'unclassified')?.count, 0);
  assert.ok(!classified.limitations.some((l) => l.id === 'unclassified'));
});

test('report: приватность — ни текста находок и ошибок, ни домашнего каталога, ни токенов; --no-titles', () => {
  const input = reportFixture();
  const r = render(input);
  for (const [name, text] of Object.entries({ json: r.json, md: r.md, html: r.html })) {
    assert.ok(!text.includes(SECRET), `${name}: текст находки или ошибки`);
    assert.ok(!text.includes(HOME), `${name}: домашний каталог`);
    assert.ok(!text.includes('/Users/'), `${name}: абсолютный путь`);
    assert.ok(!text.includes(STATE_DIR), `${name}: каталог состояния`);
    for (const a of input.attempts) {
      assert.equal(containsToken(text, a.token), false, `${name}: токен ${a.id}`);
      assert.ok(!text.includes(a.worktree!), `${name}: worktree`);
    }
  }
  // Пути evidence — относительно каталога состояния; вне его — только имя файла.
  assert.ok(r.md.includes('repos/app/artifacts/run-gate-2/candidate/unit.log'));
  assert.ok(r.md.includes('…/install.log'));
  assert.equal(reportPath(`${STATE_DIR}/../escape.log`, STATE_DIR), '…/escape.log');
  assert.equal(reportPath('~/x/y.log', STATE_DIR), '…/y.log');
  assert.equal(reportPath('C:\\Users\\alice\\z.log', STATE_DIR), '…/z.log');
  assert.equal(reportPath('artifacts/a.log', undefined), 'artifacts/a.log');

  const titled = render(input);
  assert.ok(titled.md.includes('Add the greeting'));
  assert.ok(titled.md.includes('Harness report: demo'));
  const anonymous = render(input, { ...options, noTitles: true });
  assert.equal(anonymous.report.label, null);
  for (const w of input.works) {
    assert.ok(!anonymous.json.includes(w.order.title), w.order.title);
    assert.ok(!anonymous.md.includes(w.order.title));
    assert.ok(!anonymous.html.includes(w.order.title));
  }
  assert.ok(!anonymous.md.includes('demo:'));
});

test('report: HTML самодостаточен — без скриптов и внешних ресурсов, CSP, тёмная схема, ширина телефона; разметка экранирована', () => {
  const { html, md } = render();
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<link|<img|@import|url\(/i);
  assert.match(
    html,
    /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/,
  );
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /overflow-x:auto/);
  assert.match(html, /<svg viewBox=/); // три и более активных недели — столбики
  assert.ok(html.includes('Harden &lt;input&gt; handling'));
  assert.ok(!html.includes('<input>'));
  assert.ok(md.includes('Fix \\| the \\*parser\\*'));
  for (const section of [
    'Summary',
    'Defects caught before merge',
    'Autonomy',
    'Speed',
    'Cost',
    'Environment',
    'Weekly trend',
    'Tasks',
    'Limits and unknowns',
  ]) {
    assert.ok(md.includes(`## ${section}`), section);
    assert.ok(html.includes(`<h2>${section}</h2>`), section);
  }
  // Меньше трёх активных недель — без графика.
  const short = render(keep(reportFixture(), ['first']));
  assert.doesNotMatch(short.html, /<svg/);
});

test('report: пределы — 50 строк поручений, 50 ссылок evidence, 12 недель; JSON ≤ 512 КБ, HTML ≤ 1 МБ', () => {
  const input = reportFixture();
  const template = input.attempts.find((a) => a.id === 'run-gate-2')!;
  const ok = input.attempts.find((a) => a.id === 'run-gate-3')!;
  const base = input.works.find((w) => w.id === 'gate')!;
  const works: WorkState[] = [];
  const attempts: AttemptState[] = [];
  const longGate = 'g'.repeat(80);
  for (let i = 0; i < 150; i++) {
    const id = `work-${String(i).padStart(3, '0')}`;
    works.push({ ...base, id, order: { ...base.order, id, title: 'T'.repeat(180) } });
    const day = i * 2; // 150 поручений на 300 дней: больше 12 недель
    const fail = {
      ...template,
      id: `${id}-1`,
      workId: id,
      token: tokenOf(`${id}-1`),
      startedAt: t(day, 1),
      finishedAt: t(day, 2),
      timings: Array.from({ length: 60 }, (_, k) => ({
        id: `s${k}`,
        stage: `stage-${k}-${'x'.repeat(150)}:detail`,
        startedAt: t(day, 1),
        finishedAt: t(day, 1, 5),
      })),
      evidence: template.evidence.map((e) => ({
        ...e,
        gate: `${longGate}${i}`,
        log: `${STATE_DIR}/${'d/'.repeat(200)}x.log`,
      })),
    };
    attempts.push(fail, {
      ...ok,
      id: `${id}-2`,
      workId: id,
      token: tokenOf(`${id}-2`),
      startedAt: t(day, 3),
      finishedAt: t(day, 4),
    });
  }
  const big = render({ works, attempts });
  const r = big.report;
  valueReportSchema.parse(r);
  assert.equal(r.works.rows.length, 50);
  assert.equal(r.works.total, 150);
  assert.equal(r.works.truncated, true);
  assert.equal(r.defects.items.length, 50);
  assert.equal(r.defects.itemsTotal, 150);
  assert.equal(r.defects.itemsTruncated, true);
  assert.equal(r.defects.byGate.length, 50);
  assert.equal(r.defects.byGateTruncated, true);
  assert.equal(r.speed.stages.length, 50);
  assert.equal(r.speed.stagesTruncated, true);
  assert.equal(r.weeks.rows.filter((w) => w.kind === 'week').length, 12);
  assert.ok(r.weeks.earlier && r.weeks.earlier.weeks > 0);
  assert.ok(r.limitations.some((l) => l.id === 'works-truncated'));
  assert.ok(r.limitations.some((l) => l.id === 'items-truncated'));
  assert.ok(r.limitations.some((l) => l.id === 'weeks-folded'));
  assert.match(big.md, /Showing the newest 50 of 150 tasks/);
  for (const i of r.defects.items) assert.ok((i.log ?? '').length <= 300);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= REPORT_LIMITS.jsonBytes);
  assert.ok(Buffer.byteLength(big.html) <= REPORT_LIMITS.htmlBytes);
  assert.ok(Buffer.byteLength(big.md) <= REPORT_LIMITS.htmlBytes);
});

test('report: ISO-неделя UTC с понедельника, включая границу года', () => {
  assert.equal(isoWeekOf(Date.parse('2026-10-05T00:00:00Z')), '2026-W41');
  assert.equal(isoWeekOf(Date.parse('2026-10-04T23:59:59Z')), '2026-W40');
  assert.equal(isoWeekOf(Date.parse('2024-12-30T12:00:00Z')), '2025-W01');
  assert.equal(isoWeekOf(Date.parse('2021-01-03T12:00:00Z')), '2020-W53');
  assert.equal(isoWeekOf(Date.parse('2027-01-01T00:00:00Z')), '2026-W53');
});

/* ------------------------------------------------------------------ */
/* Замечания независимого ревью                                        */
/* ------------------------------------------------------------------ */

const headline = (r: ReturnType<typeof valueReport>, id: string) =>
  r.summary.status === 'ok' ? r.summary.headlines.find((h) => h.id === id) : undefined;

test('review 1: вызовы попытки без callsRecorded — её расход нижней границей, а не пропуск; окружение и расходы согласованы', () => {
  const input = reportFixture();
  const base = valueReport(input, options);
  // run-gate-2 ($2.50) без флага полного учёта; run-env-1 получает вызов $0.70 без флага.
  const envCall = {
    ...input.calls![0]!,
    id: 'c-env-1',
    runId: 'run-env-1',
    costUsd: 0.7,
    startedAt: t(23, 10, 1),
  };
  const partial: ValueReportInput = {
    ...input,
    attempts: input.attempts.map((a) =>
      a.id === 'run-gate-2' || a.id === 'run-env-1' ? { ...a, callsRecorded: undefined } : a,
    ),
    calls: [...input.calls!, envCall],
  };
  const r = valueReport(partial, options);
  assert.equal(r.cost.rejected.usd, round(base.cost.rejected.usd + 0.7));
  assert.equal(r.cost.rejected.bound, 'lower');
  assert.equal(r.cost.attemptsPartialCalls, 2);
  assert.equal(r.cost.attemptsWithoutCalls, base.cost.attemptsWithoutCalls);
  assert.ok(r.limitations.some((l) => l.id === 'partial-calls'));
  const envBucket = r.cost.rejected.byBucket.find((b) => b.bucket === 'environment');
  assert.equal(envBucket?.usd, 0.7);
  assert.equal(r.environment.neutral.knownUsd, 0.7);
  assert.equal(r.environment.neutral.costBound, 'lower');
  const md = reportMarkdown(r);
  assert.match(md, /Spend on attempts that were not accepted: ≥ \$/);
  assert.match(md, /≥ \$0\.70 known spend/);
  // Обратный случай: все попытки с полным учётом — точная сумма без «≥».
  const full = valueReport(
    {
      ...keep(input, ['first', 'gate']),
      calls: input.calls!.filter((c) => c.runId?.startsWith('run-gate')),
    },
    options,
  );
  assert.equal(full.cost.rejected.bound, 'exact');
  assert.equal(full.cost.rejected.usd, 2.5);
});
const round = (x: number) => Math.round(x * 100) / 100;

test('review 2: возвраты — отказы без класса делают число нижней границей; только gate подготовки — верхней', () => {
  const input = reportFixture();
  const r = valueReport(input, options);
  assert.deepEqual(
    [r.defects.sentBack.value, r.defects.sentBack.unknown, r.defects.sentBack.bound],
    [2, 1, 'lower'],
  );
  assert.match(
    headline(r, 'sent-back')!.text,
    /^At least 2 of 5 .*1 task had only failures without a class/,
  );
  // Без legacy и с обычными отказами — точное число.
  const exact = valueReport(keep(input, ['first', 'gate', 'review', 'env']), options);
  assert.deepEqual([exact.defects.sentBack.value, exact.defects.sentBack.bound], [2, 'exact']);
  // gate вернул только gate установки — возможно, сеть: верхняя граница.
  const setup: ValueReportInput = {
    ...keep(input, ['first', 'gate', 'env']),
  };
  setup.attempts = setup.attempts.map((a) =>
    a.id === 'run-gate-2'
      ? { ...a, evidence: a.evidence.map((e) => (e.passed ? e : { ...e, gate: 'install' })) }
      : a,
  );
  const upper = valueReport(setup, options);
  assert.deepEqual([upper.defects.sentBack.value, upper.defects.sentBack.bound], [1, 'upper']);
  assert.equal(upper.defects.sentBackSetupOnly, 1);
  assert.match(headline(upper, 'sent-back')!.text, /^At most 1 of 3/);
});

test('review 3: удержания и отмены без актёра — не действия человека; решение recovery оператора — действие', () => {
  const input = reportFixture();
  const r = valueReport(input, options);
  assert.equal(r.autonomy.withAction.value, 0);
  assert.equal(r.autonomy.actions.holds, 1);
  assert.ok(r.limitations.some((l) => l.id === 'holds-actor'));
  const decided: ValueReportInput = {
    ...input,
    works: input.works.map((w) =>
      w.id === 'env'
        ? {
            ...w,
            recoveryHistory: [
              {
                id: 'rec-1',
                property: 'p',
                basis: digest('rec'),
                runs: [],
                openedAt: t(23, 9),
                status: 'closed' as const,
                calls: 0,
                decision: {
                  action: 'new-approach' as const,
                  reason: SECRET,
                  evidence: [],
                  source: { kind: 'operator' as const },
                  decidedAt: t(23, 9, 30),
                },
                history: [],
                version: 1,
              },
            ],
          }
        : w,
    ),
  };
  const acted = valueReport(decided, options);
  assert.equal(acted.autonomy.withAction.value, 1);
  assert.equal(acted.autonomy.actions.operatorDecisions, 1);
  assert.ok(!JSON.stringify(acted).includes(SECRET));
});

test('review 4: согласования — по событиям только для графов с событиями; иначе из графа; нет записей — неизвестно', () => {
  const input = reportFixture();
  assert.equal(valueReport(input, options).autonomy.approvals.source, 'events');
  // События есть, но не graph.approved: согласование графа берётся из состояния.
  const noApprovalEvents: ValueReportInput = {
    ...input,
    events: input.events!.filter((e) => e.type !== 'graph.approved'),
  };
  const state = valueReport(noApprovalEvents, options).autonomy.approvals;
  assert.deepEqual(state, { operator: 1, agent: 0, source: 'state' });
  // Ни событий согласования, ни графов — неизвестно, а не ноль.
  const none = valueReport({ ...noApprovalEvents, graphs: [] }, options);
  assert.equal(none.autonomy.approvals.source, 'none');
  assert.match(reportMarkdown(none), /Plan approvals: unknown \(no approval records\)/);
  assert.ok(none.limitations.some((l) => l.id === 'approvals-unknown'));
});

test('review 7: отказы окружения — «≥», если есть отказы gate подготовки; без них — точно', () => {
  const input = reportFixture();
  const r = valueReport(input, options);
  const env = headline(r, 'environment')!;
  assert.equal(env.value, '≥ 1 of 6');
  assert.match(
    env.text,
    /^At least 1 of 6 .*1 more failure in setup checks may be environment too/,
  );
  assert.doesNotMatch(env.text, /not your code/);
  const exact = valueReport(keep(input, ['first', 'gate', 'review', 'env']), options);
  assert.equal(exact.environment.share.bound, 'exact');
  assert.match(headline(exact, 'environment')!.text, /not your code/);
});

test('review 8: время пауз ограничено окном', () => {
  const input = reportFixture();
  // runtime: 10:03–10:33 дня 23; окно с 10:18 — 15 минут внутри, пауза начата до окна.
  const from = valueReport(input, { ...options, since: t(23, 10, 18) });
  const runtime = from.autonomy.pauses.find((p) => p.reason === 'runtime')!;
  assert.deepEqual([runtime.count, runtime.pausedMs], [0, 15 * 60_000]);
  // operator: открыта с 15:00 дня 29; окно до 15:30 — 30 минут, а не до asOf.
  const until = valueReport(input, { ...options, until: t(29, 15, 30) });
  const operator = until.autonomy.pauses.find((p) => p.reason === 'operator')!;
  assert.deepEqual([operator.count, operator.pausedMs, operator.open], [1, 30 * 60_000, 1]);
});

test('review 9: done без успешной попытки — не принято ни в каком окне, отмечено в покрытии', () => {
  const input = reportFixture();
  const first = input.works.find((w) => w.id === 'first')!;
  const ghost = { ...input, works: [...input.works, { ...first, id: 'ghost' }] };
  const all = valueReport(ghost, options);
  const windowed = valueReport(ghost, { ...options, since: '2026-09-01' });
  for (const r of [all, windowed]) {
    assert.equal(r.speed.finished.accepted, 5);
    assert.equal(r.coverage.doneWithoutAttempt, 1);
    assert.ok(!r.works.rows.some((w) => w.id === 'ghost'));
    assert.ok(r.limitations.some((l) => l.id === 'done-without-attempt'));
  }
});

test('review 10: предел размера проверяет само ядро и рендеры', () => {
  assert.throws(
    () =>
      assertReportBytes('x'.repeat(REPORT_LIMITS.jsonBytes + 1), REPORT_LIMITS.jsonBytes, 'JSON'),
    (e: unknown) => e instanceof HarnessError && e.code === 'INTERNAL',
  );
  assert.doesNotThrow(() => assertReportBytes('я'.repeat(10), 20, 'JSON'));
  assert.throws(() => assertReportBytes('я'.repeat(11), 20, 'JSON'), /22 байт/);
});

test('review 11: больше 5 версий движка в неделе — список отмечен усечённым', () => {
  const input = keep(reportFixture(), ['first']);
  const run = input.attempts[0]!;
  const extra = Array.from({ length: 6 }, (_, i) => ({
    ...run,
    id: `run-x-${i}`,
    token: tokenOf(`run-x-${i}`),
    status: 'failed' as const,
    failureKind: 'gate' as const,
    startedAt: t(1, 9 + i),
    finishedAt: t(1, 9 + i, 30),
    engineVersion: `9.9.${i}`,
  }));
  const many = { ...input, attempts: [...input.attempts, ...extra] };
  const r = valueReport(many, options);
  const week = r.weeks.rows.find((w) => w.kind === 'week' && w.week === '2026-W41');
  assert.ok(week && week.kind === 'week' && week.enginesTruncated, JSON.stringify(week));
  assert.match(reportMarkdown(r), /, …/);
});

/* ------------------------------------------------------------------ */
/* Ревью, раунд 2                                                      */
/* ------------------------------------------------------------------ */

test('round 2: возвраты — оба сомнения сразу дают диапазон без знака границы', () => {
  const input = reportFixture();
  const mixed: ValueReportInput = {
    ...input,
    attempts: input.attempts.map((a) =>
      a.id === 'run-gate-2'
        ? { ...a, evidence: a.evidence.map((e) => (e.passed ? e : { ...e, gate: 'install' })) }
        : a,
    ),
  };
  const r = valueReport(mixed, options);
  // review — defect, gate — только gate установки, legacy — только без класса.
  assert.deepEqual(r.defects.sentBackRange, { min: 1, max: 3 });
  assert.equal(r.defects.sentBack.bound, 'unknown');
  const h = headline(r, 'sent-back')!;
  assert.equal(h.value, '1–3 of 5');
  assert.match(h.text, /^Between 1 and 3 of 5 accepted tasks/);
  assert.match(reportMarkdown(r), /sent back at least once: 1–3 of 5/);
  // Обратно: одно сомнение — знак границы, диапазон схлопнут с одной стороны.
  const lower = valueReport(input, options);
  assert.deepEqual(lower.defects.sentBackRange, { min: 2, max: 3 });
  assert.equal(headline(lower, 'sent-back')!.value, '≥ 2 of 5');
});

test('round 2: первая попытка — отказы без класса делают её нижней границей; без них — точно', () => {
  const input = reportFixture();
  const r = valueReport(input, options);
  assert.deepEqual(r.speed.firstPass, { value: 2, n: 5, unknown: 1, bound: 'lower' });
  assert.match(
    headline(r, 'accepted')!.text,
    /At least 2 of them on the first try; for 1 more task it is unknown/,
  );
  const exact = valueReport(keep(input, ['first', 'gate', 'review', 'env']), options);
  assert.deepEqual(exact.speed.firstPass, { value: 2, n: 4, unknown: 0, bound: 'exact' });
  assert.match(
    headline(exact, 'accepted')!.text,
    /^4 tasks accepted\. 2 of them on the first try\.$/,
  );
});

test('round 2: «без действий человека» — не измеримо, а не «≥ 0 of N»; ограничение о событиях без согласований', () => {
  const input = reportFixture();
  const md = reportMarkdown(valueReport(input, options));
  assert.match(md, /needed no human action: not measurable yet/);
  assert.doesNotMatch(md, /recorded human action: ≥/);
  assert.match(md, /Pauses and approvals are counted from events/);
  const none = valueReport(
    { ...input, graphs: [], events: input.events!.filter((e) => e.type !== 'graph.approved') },
    options,
  );
  const text = none.limitations.map((l) => l.text).join('\n');
  assert.match(text, /Pauses are counted from events/);
  assert.doesNotMatch(text, /Pauses and approvals are counted/);
});
