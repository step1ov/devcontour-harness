import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_STALL_SWEEP,
  executionPolicySchema,
  repairPolicy,
  stallSweepOf,
  type StallSweepPolicy,
} from '../src/contracts/index.ts';
import { ActivityScope, activityScope } from '../src/environment/activity.ts';
import { command } from '../src/environment/process.ts';
import {
  StallSweep,
  parseCpuTime,
  parseProcessTable,
  treeOf,
  type LivenessChange,
  type ProcessRow,
} from '../src/engine/stall-sweep.ts';
import { attemptView, explainStop } from '../src/projections/index.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';
import { example } from './fixtures.ts';

const policy: StallSweepPolicy = {
  intervalMs: 1000,
  quietMs: 100,
  stalledMs: 300,
  action: 'report',
};

/** Обход с ручными часами и таблицей процессов. */
function harness(p: StallSweepPolicy = policy) {
  let now = 1_000_000;
  const clock = () => now;
  const scope = new ActivityScope(clock);
  let rows: ProcessRow[] | null = [];
  const changes: LivenessChange[] = [];
  const sweep = new StallSweep({
    policy: p,
    clock,
    sample: () => Promise.resolve(rows),
    subjects: () => [{ id: 'R1', scope }],
    changed: (c) => changes.push(c),
  });
  return {
    scope,
    sweep,
    changes,
    advance: (ms: number) => (now += ms),
    setRows: (r: ProcessRow[] | null) => (rows = r),
    states: () => changes.map((c) => c.state),
  };
}

test('Время ps: форматы macOS и Linux, дни; таблица и дерево процессов', () => {
  assert.equal(parseCpuTime('0:00.01'), 10);
  assert.equal(parseCpuTime('1:02.50'), 62_500);
  assert.equal(parseCpuTime('00:00:07'), 7000);
  assert.equal(parseCpuTime('2-01:00:00'), (2 * 24 + 1) * 3_600_000);
  assert.equal(parseCpuTime('garbage'), undefined);
  const rows = parseProcessTable(
    '  10     1   0:01.00 /bin/sh -c sleep 100\n  11    10   0:00.00 sleep 100\n  12     1   0:00.00 other\nbad line\n',
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(
    treeOf(rows, 10).map((r) => r.pid),
    [10, 11],
  );
  assert.equal(rows[0]!.command, '/bin/sh -c sleep 100');
});

test('Политика: без поля — умолчания и прежний digest; quiet < stalled обязателен', () => {
  const raw = structuredClone(example('policy'));
  const parsed = executionPolicySchema.parse(raw);
  assert.equal(parsed.stallSweep, undefined, 'умолчание не подставляется в политику');
  assert.deepEqual(stallSweepOf(parsed), DEFAULT_STALL_SWEEP);
  assert.equal(DEFAULT_STALL_SWEEP.action, 'report');
  assert.ok(DEFAULT_STALL_SWEEP.quietMs < DEFAULT_STALL_SWEEP.stalledMs);
  const set = executionPolicySchema.parse({ ...raw, stallSweep: { action: 'stop' } });
  assert.deepEqual(set.stallSweep, { ...DEFAULT_STALL_SWEEP, action: 'stop' });
  assert.equal(
    executionPolicySchema.safeParse({ ...raw, stallSweep: { quietMs: 500, stalledMs: 500 } })
      .success,
    false,
  );
  assert.equal(repairPolicy.stalled.action, 'retry');
  assert.equal(
    repairPolicy.stalled.blocksQueue,
    undefined,
    'зависание одной попытки очередь не держит',
  );
});

test('Обход: active → quiet → stalled со снимком, движение возвращает active', async () => {
  const h = harness();
  const t = h.scope.begin(10, { kind: 'gate', label: 'unit' }, (s) => s.replace('SECRET', '***'));
  h.scope.output(t, 'starting\n');
  h.setRows([
    { pid: 10, parentPid: 1, cpuMs: 50, command: 'node run.js --token SECRET' },
    { pid: 11, parentPid: 10, cpuMs: 0, command: 'sleep 100' },
    { pid: 99, parentPid: 1, cpuMs: 5, command: 'unrelated' },
  ]);
  await h.sweep.tick();
  assert.deepEqual(h.states(), [], 'свежая команда — active, перехода нет');
  h.advance(150);
  await h.sweep.tick();
  h.advance(200);
  await h.sweep.tick();
  assert.deepEqual(h.states(), ['quiet', 'stalled']);
  const stalled = h.changes[1]!;
  assert.equal(stalled.previous, 'quiet');
  assert.equal(stalled.idleMs, 350);
  assert.deepEqual(stalled.activity, { kind: 'gate', label: 'unit' });
  assert.deepEqual(
    stalled.snapshot!.processes.map((p) => p.pid),
    [10, 11],
    'только дерево исполняющейся команды',
  );
  assert.equal(stalled.snapshot!.processes[0]!.command, 'node run.js --token ***');
  assert.equal(stalled.snapshot!.tail, 'starting\n');
  h.advance(1000);
  await h.sweep.tick();
  assert.equal(h.changes.length, 2, 'stalled держится без повторных событий');
  h.scope.output(t, 'progress\n');
  await h.sweep.tick();
  assert.deepEqual(h.states(), ['quiet', 'stalled', 'active']);
});

test('Обход: расход процессора деревом — движение, простой event loop — нет', async () => {
  const h = harness();
  h.scope.begin(10, { kind: 'step', label: 'build' });
  const rows = (cpuMs: number) => [
    { pid: 10, parentPid: 1, cpuMs: 0, command: 'sh' },
    { pid: 11, parentPid: 10, cpuMs, command: 'cc' },
  ];
  h.setRows(rows(0));
  await h.sweep.tick();
  // 50 мс процессора за 250 мс — 20 %: работает без вывода.
  h.advance(250);
  h.setRows(rows(50));
  await h.sweep.tick();
  assert.deepEqual(h.states(), [], 'считающий процесс не quiet');
  // Дальше — доли процента: простой.
  for (let i = 1; i <= 4; i++) {
    h.advance(100);
    h.setRows(rows(50 + i * 0.1));
    await h.sweep.tick();
  }
  assert.deepEqual(h.states(), ['quiet', 'stalled']);
});

test('Обход: ps недоступен — оценка по выводу, снимок помечен; stop — без переходов после stalled', async () => {
  const h = harness({ ...policy, action: 'stop' });
  const t = h.scope.begin(10, { kind: 'agent', label: 'claude implement' });
  h.setRows(null);
  h.advance(400);
  await h.sweep.tick();
  assert.deepEqual(h.states(), ['stalled']);
  assert.equal(h.changes[0]!.snapshot!.processesUnavailable, true);
  // Остановка завершает команду — это не движение для обхода.
  h.scope.end(t);
  await h.sweep.tick();
  assert.deepEqual(h.states(), ['stalled']);
});

test('Обход: без исполняющихся команд попытка active; сбой получателя не останавливает обход', async () => {
  let now = 0;
  const scope = new ActivityScope(() => now);
  const other = new ActivityScope(() => now);
  const seen: string[] = [];
  const sweep = new StallSweep({
    policy,
    clock: () => now,
    sample: () => Promise.resolve([]),
    subjects: () => [
      { id: 'A', scope },
      { id: 'B', scope: other },
    ],
    changed: (c) => {
      seen.push(c.subject.id + ':' + c.state);
      throw new Error('получатель упал');
    },
  });
  other.begin(5, { kind: 'command', label: 'git' });
  now = 1000;
  await sweep.tick();
  assert.deepEqual(seen, ['B:stalled']);
});

test('command в контексте владельца регистрирует процесс, вывод и завершение', async () => {
  const scope = new ActivityScope();
  const seen: number[] = [];
  const result = await activityScope.run(scope, async () => {
    const pending = command([process.execPath, '-e', 'console.log("hi")'], process.cwd(), {
      activity: { kind: 'gate', label: 'unit' },
    });
    seen.push(scope.running.size);
    assert.deepEqual(scope.current()?.activity, { kind: 'gate', label: 'unit' });
    return pending;
  });
  assert.equal(result.code, 0);
  assert.deepEqual(seen, [1]);
  assert.equal(scope.running.size, 0, 'завершившаяся команда снята');
});

test('Проекции: attemptView и explain показывают зависание работающей попытки', () => {
  const view = attemptView(
    {
      id: 'R1',
      workId: 'w',
      attempt: 1,
      status: 'active',
      phase: 'verifying',
      owner: 'c',
      runtime: 'claude',
      startedAt: '2026-11-04T00:00:00.000Z',
      leaseUntil: Date.parse('2026-11-04T00:30:00.000Z'),
      evidence: [],
      liveness: {
        state: 'stalled',
        at: '2026-11-04T00:20:00.000Z',
        lastMovementAt: '2026-11-04T00:10:00.000Z',
        activity: { kind: 'gate', label: 'unit' },
        action: 'report',
      },
    },
    { now: Date.parse('2026-11-04T00:25:00.000Z'), leaseMs: 30000 },
  );
  assert.deepEqual(view.liveness, {
    state: 'stalled',
    since: '2026-11-04T00:20:00.000Z',
    lastMovementAt: '2026-11-04T00:10:00.000Z',
    idleMs: 15 * 60_000,
    activity: { kind: 'gate', label: 'unit' },
    action: 'report',
  });
  const input = (liveness: Record<string, unknown>) =>
    ({
      kind: 'work',
      work: { id: 'w', status: 'verifying', attempt: 1, liveness },
      maxAttempts: 3,
      repair: { sameFailureRepairs: 0, groupRepairsUsed: 0, groupRepairBudget: 6 },
      control: { paused: false },
    }) as Parameters<typeof explainStop>[0];
  const reported = explainStop(
    input({
      state: 'stalled',
      lastMovementAt: '2026-11-04T00:10:00.000Z',
      activity: 'gate unit',
      action: 'report',
    }),
  );
  assert.equal(reported.cause, 'stalled');
  assert.equal(reported.actor, 'user');
  assert.equal(reported.action, 'fix-environment');
  assert.match(reported.message, /gate unit/);
  const stopping = explainStop(
    input({ state: 'stalled', lastMovementAt: '2026-11-04T00:10:00.000Z', action: 'stop' }),
  );
  assert.equal(stopping.actor, 'controller');
  assert.equal(stopping.cause, 'stalled');
  const quiet = explainStop(input({ state: 'quiet', lastMovementAt: '2026-11-04T00:10:00.000Z' }));
  assert.equal(quiet.action, 'wait');
  assert.match(quiet.message, /без движения/);
});

// Пороги — с запасом на загруженную машину: запуск процесса runtime под
// нагрузкой сам по себе молчит до секунды.
const sweepPolicy = (action: 'stop' | 'report') => (p: Record<string, unknown>) => {
  p.stallSweep = { intervalMs: 50, quietMs: 1000, stalledMs: 2500, action };
  p.maxAttempts = 1;
};

test('Runner: молчащий исполнитель остановлен исходом stalled со снимком, а не timeout', async () => {
  const ctx = setup({
    scenario: { writer: { sleepMs: 30000, ...implement() }, reviewer: approve() },
    policy: sweepPolicy('stop'),
  });
  const started = Date.now();
  await runAll(ctx);
  assert.ok(Date.now() - started < 25000, 'остановлен до конца сна исполнителя');
  const [first] = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(first!.failureKind, 'stalled', first!.error);
  assert.match(first!.error!, /agent claude implement.*Повтор или правка среды/);
  assert.equal(first!.liveness?.state, 'stalled');
  assert.equal(first!.liveness?.action, 'stop');
  const events = ctx.store
    .events(0, 500)
    .filter((e) => e.type === 'attempt.liveness')
    .map((e) => (e as { payload: Record<string, unknown> }).payload);
  assert.equal(events.at(-1)!.state, 'stalled');
  assert.deepEqual(events.at(-1)!.activity, { kind: 'agent', label: 'claude implement' });
  assert.equal(events.filter((e) => e.state === 'stalled').length, 1);
  const snapshot = events.at(-1)!.snapshot as {
    processes: { command: string }[];
    artifact: string;
  };
  assert.ok(
    snapshot.processes.some((p) => /fake-claude/.test(p.command)),
    JSON.stringify(snapshot),
  );
  for (let i = 0; i < 50 && !existsSync(snapshot.artifact); i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    (JSON.parse(readFileSync(snapshot.artifact, 'utf8')) as { action: string }).action,
    'stop',
  );
});

test('Runner: report только сообщает — попытка доходит до конца, движение возвращает active', async () => {
  const ctx = setup({
    scenario: { writer: { sleepMs: 4000, ...implement() }, reviewer: approve() },
    policy: sweepPolicy('report'),
  });
  await runAll(ctx);
  const [first] = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(first!.status, 'succeeded', first!.error);
  const states = ctx.store
    .events(0, 500)
    .filter((e) => e.type === 'attempt.liveness')
    .map((e) => (e as { payload: { state: string; action?: string } }).payload);
  const stalled = states.findIndex((s) => s.state === 'stalled');
  assert.ok(stalled > 0, JSON.stringify(states));
  assert.equal(states[stalled]!.action, 'report');
  assert.equal(states[stalled + 1]?.state, 'active', 'движение после сна вернуло active');
});
