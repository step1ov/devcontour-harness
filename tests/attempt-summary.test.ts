/**
 * Сводка попыток в `status` и `explain` (`attemptSummaryOf`,
 * `attemptSummaryView`): те же числа, что строка поручения отчёта, на одном
 * состоянии. Состояние: отказы gate и ревью (defect), таймаут, прерывание
 * штатной остановкой и принятая попытка; соседнее поручение без попыток.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { cliDataSchemas, type AttemptState } from '../src/contracts/index.ts';
import { EXPLAIN_ATTEMPT_ROWS, diagnoseState, explainText } from '../src/explain/diagnose.ts';
import {
  attemptSummaryLine,
  attemptSummaryOf,
  attemptSummaryView,
  statusText,
  valueReport,
} from '../src/index.ts';
import { graphOf, ready } from './engine-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { reportFixture } from './report-fixture.ts';
import { bin } from './runner-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (args: string[]) =>
  spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });

test('attemptSummaryOf: на данных отчёта — те же числа, что строки поручений отчёта', () => {
  const input = reportFixture();
  const report = valueReport(input);
  assert.ok(report.works.rows.length > 3);
  for (const row of report.works.rows) {
    const work = input.works.find((w) => w.id === row.id)!;
    const s = attemptSummaryOf(
      work,
      input.attempts.filter((a) => a.workId === row.id),
    );
    assert.equal(s.total, row.attempts, row.id);
    assert.deepEqual(s.failures, row.rejections, row.id);
    assert.equal(s.accepted, row.outcome === 'accepted' ? 1 : 0, row.id);
    assert.equal(s.timeouts, row.rejections.find((r) => r.key === 'time-limit')?.count ?? 0);
  }
  // Прерывание штатной остановкой (`gate` фикстуры) — не отказ, а своё число.
  const gate = attemptSummaryOf(
    input.works.find((w) => w.id === 'gate')!,
    input.attempts.filter((a) => a.workId === 'gate'),
  );
  assert.equal(gate.interrupted, 1);
  assert.equal(
    gate.failed,
    gate.failures.reduce((n, f) => n + f.count, 0),
  );
});

test('attemptSummaryLine: факты без оценки времени; остаток не меньше нуля', () => {
  const line = attemptSummaryLine(
    {
      total: 4,
      active: 1,
      failed: 2,
      failures: [
        { key: 'defect', count: 1 },
        { key: 'time-limit', count: 1 },
      ],
      timeouts: 1,
      interrupted: 1,
      accepted: 0,
    },
    { attempts: { used: 4, max: 3 }, repairs: { used: 2, budget: 6 } },
  );
  assert.equal(
    line,
    'попыток 4 (идёт 1); отказов 2 (defect 1, time-limit 1); по времени 1; прервано остановкой 1; принято 0; осталось попыток 0 из 3, восстановлений группы 4 из 6',
  );
  assert.doesNotMatch(line, /мин|час|ETA|осталось времени/i);
});

test('attemptSummaryLine: на пределе незасчитанных отказов — не «осталось попыток»', () => {
  const summary = {
    total: 3,
    active: 0,
    failed: 3,
    failures: [{ key: 'environment' as const, count: 3 }],
    timeouts: 0,
    interrupted: 0,
    accepted: 0,
  };
  const line = attemptSummaryLine(summary, {
    attempts: { used: 0, max: 3 },
    neutral: { used: 3, max: 3 },
  });
  assert.equal(
    line,
    'попыток 3; отказов 3 (environment 3); по времени 0; прервано остановкой 0; принято 0; исчерпан предел незасчитанных отказов 3 из 3: повтор — только со сбросом',
  );
  assert.doesNotMatch(line, /осталось попыток/);
  assert.match(
    attemptSummaryLine(summary, { attempts: { used: 0, max: 3 }, neutral: { used: 2, max: 3 } }),
    /осталось попыток 3 из 3$/,
  );
});

/** Поручение `w`: gate, таймаут, прерывание, ревью, затем принятая попытка; `x` без попыток. */
function board() {
  const ctx = hsetup({
    scenario: {},
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 6),
  });
  writeFileSync(
    join(ctx.state, 'binding.json'),
    JSON.stringify({ policy: ctx.policy, baseDir: ctx.repo.dir }),
  );
  const h = ctx.open();
  const g = ready(h.engine, graphOf({ w: [], x: ['w'] }));
  h.workflows.start({ kind: 'graph', id: g.id, authorRuntime: 'claude' });
  const claim = () => {
    const run = h.engine.claim('c1')!;
    assert.equal(run.workId, 'w');
    return run;
  };
  let run = claim();
  h.engine.fail(run.id, run.token, 'unit failed', { kind: 'gate' });
  h.engine.retry('w');
  run = claim();
  h.engine.fail(run.id, run.token, 'time limit', { kind: 'timeout' });
  h.engine.retry('w');
  run = claim();
  assert.equal(
    h.engine.fail(run.id, run.token, 'остановка', { kind: 'environment', interrupted: true })
      .interrupted,
    true,
  );
  run = claim();
  h.engine.fail(run.id, run.token, 'review rejected', { kind: 'review' });
  h.engine.retry('w');
  // Отказ окружения не засчитан (попытка возвращена, neutralFailures + 1);
  // он ставит выдачу на паузу runtime — снимаем её.
  run = claim();
  h.engine.fail(run.id, run.token, 'sandbox died', { kind: 'environment' });
  h.engine.resume();
  h.engine.retry('w');
  // Зависание засчитано, класс — окружение (не время).
  run = claim();
  h.engine.fail(run.id, run.token, 'stalled', { kind: 'stalled' });
  h.engine.resume();
  h.engine.retry('w');
  run = claim();
  // Принятая попытка записью хранилища (приёмка — `engine.finish` после gates и ревью).
  h.store.transact('run.phase', (tx) => {
    const a = tx.attempt(run.id)!;
    tx.putAttempt({
      ...a,
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
    } satisfies AttemptState);
    const { activeRunId: _r, ...work } = tx.work('w')!;
    void _r;
    tx.putWork({ ...work, status: 'done' });
  });
  return { ctx, h };
}

test('status и explain: строка сводки на поручение совпадает с отчётом на том же состоянии', async () => {
  const { ctx, h } = board();
  let open = true;
  try {
    const status = cliDataSchemas.status.parse(h.status());
    const w = status.works.find((x) => x.id === 'w')!.attemptSummary!;
    assert.deepEqual(
      {
        total: w.total,
        active: w.active,
        failed: w.failed,
        failures: w.failures,
        timeouts: w.timeouts,
        interrupted: w.interrupted,
        accepted: w.accepted,
      },
      {
        total: 7,
        active: 0,
        failed: 5,
        failures: [
          { key: 'defect', count: 2 },
          { key: 'environment', count: 2 },
          { key: 'time-limit', count: 1 },
        ],
        timeouts: 1,
        interrupted: 1,
        accepted: 1,
      },
    );
    // Засчитаны gate, таймаут, ревью, зависание и принятая; прерывание и окружение — нет.
    assert.deepEqual(w.attempts, { used: 5, max: 6, left: 1 });
    assert.deepEqual(w.neutral, { used: 1, max: 3 });
    assert.deepEqual(w.repairs, {
      used: 0,
      budget: ctx.policy.repairBudget,
      left: ctx.policy.repairBudget,
    });
    assert.equal(
      w.line,
      `попыток 7; отказов 5 (defect 2, environment 2, time-limit 1); по времени 1; прервано остановкой 1; принято 1; осталось попыток 1 из 6, восстановлений группы ${ctx.policy.repairBudget} из ${ctx.policy.repairBudget}`,
    );
    // Предел незасчитанных отказов — только у незавершённой работы; у
    // принятой и отменённой строка называет итог (остаток попыток).
    const stored = h.engine.read((v) => ({ work: v.work('w')!, attempts: v.attempts('w') }));
    const viewAs = (status: 'ready' | 'done' | 'cancelled') =>
      attemptSummaryView(
        { ...stored.work, status, neutralFailures: 3 },
        stored.attempts,
        ctx.policy,
      );
    assert.match(viewAs('ready').line, /исчерпан предел незасчитанных отказов 3 из 3/);
    for (const final of ['done', 'cancelled'] as const) {
      const view = viewAs(final);
      assert.doesNotMatch(view.line, /незасчитанных/, final);
      assert.match(view.line, /осталось попыток 1 из 6$/, final);
      assert.deepEqual(view.neutral, { used: 3, max: 3 }, final);
    }
    const x = status.works.find((y) => y.id === 'x')!.attemptSummary!;
    assert.equal(x.total, 0);
    assert.match(x.line, /^попыток 0; отказов 0; по времени 0; прервано остановкой 0; принято 0;/);

    // Отчёт на том же состоянии: те же попытки и отказы по корзинам.
    const row = h.report().works.rows.find((r) => r.id === 'w')!;
    assert.equal(row.attempts, w.total);
    assert.deepEqual(row.rejections, w.failures);
    assert.equal(row.outcome, 'accepted');

    // explain: та же сводка; --work — только одно поручение.
    const adapters = {
      claude: cliAdapter('claude', { executable: bin('fake-claude'), toolProfiles: {} }),
      codex: cliAdapter('codex', { executable: bin('fake-codex'), toolProfiles: {} }),
    };
    const opts = { stateDir: ctx.state, policy: ctx.policy, baseDir: ctx.repo.dir, adapters };
    h.close();
    open = false;
    const all = cliDataSchemas.explain.parse(await diagnoseState(opts));
    assert.deepEqual(
      all.attempts?.map((r) => r.workId),
      ['w', 'x'],
    );
    const { workId: _id, ...fromExplain } = all.attempts[0]!;
    void _id;
    assert.deepEqual(fromExplain, w);
    const one = await diagnoseState({ ...opts, workId: 'x' });
    assert.deepEqual(
      one.attempts?.map((r) => r.workId),
      ['x'],
    );
    assert.ok(explainText(all).includes(`Попытки:\n  w: ${w.line}\n  x: ${x.line}\n`));

    // CLI: status JSON несёт сводку, --human — строку на поручение.
    const json = harness(['status', '--state', ctx.state]);
    assert.equal(json.status, 0, json.stderr);
    const envelope = JSON.parse(json.stdout) as { data: typeof status };
    assert.deepEqual(envelope.data.works.find((y) => y.id === 'w')!.attemptSummary, w);
    const human = harness(['status', '--state', ctx.state, '--human']);
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.stdout, statusText(envelope.data));
    assert.ok(human.stdout.includes(`w [done]: ${w.line}\n`));
    assert.ok(human.stdout.includes(`x [ready]: ${x.line}\n`));
  } finally {
    if (open) h.close();
  }
});

test('explain: строк сводки не больше EXPLAIN_ATTEMPT_ROWS, остальные — attemptsTruncated', async () => {
  const ctx = hsetup({ scenario: {} });
  const h = ctx.open();
  ready(
    h.engine,
    graphOf(
      Object.fromEntries(Array.from({ length: EXPLAIN_ATTEMPT_ROWS + 2 }, (_, i) => [`w${i}`, []])),
    ),
  );
  h.close();
  const data = await diagnoseState({
    stateDir: ctx.state,
    policy: ctx.policy,
    baseDir: ctx.repo.dir,
    adapters: {
      claude: cliAdapter('claude', { executable: bin('fake-claude'), toolProfiles: {} }),
      codex: cliAdapter('codex', { executable: bin('fake-codex'), toolProfiles: {} }),
    },
  });
  assert.ok(cliDataSchemas.explain.safeParse(data).success);
  assert.equal(data.attempts?.length, EXPLAIN_ATTEMPT_ROWS);
  assert.equal(data.attemptsTruncated, 2);
  assert.match(explainText(data), /… и ещё поручений: 2\n$/);
});
