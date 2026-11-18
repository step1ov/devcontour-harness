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
import { diagnoseState, explainText } from '../src/explain/diagnose.ts';
import { attemptSummaryLine, attemptSummaryOf, statusText, valueReport } from '../src/index.ts';
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
    const used = h.engine.read((v) => v.work('w')!.attempt);
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
        total: 5,
        active: 0,
        failed: 3,
        failures: [
          { key: 'defect', count: 2 },
          { key: 'time-limit', count: 1 },
        ],
        timeouts: 1,
        interrupted: 1,
        accepted: 1,
      },
    );
    assert.deepEqual(w.attempts, { used, max: 6, left: 6 - used });
    assert.deepEqual(w.repairs, {
      used: 0,
      budget: ctx.policy.repairBudget,
      left: ctx.policy.repairBudget,
    });
    assert.match(
      w.line,
      /^попыток 5; отказов 3 \(defect 2, time-limit 1\); по времени 1; прервано остановкой 1; принято 1; /,
    );
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
