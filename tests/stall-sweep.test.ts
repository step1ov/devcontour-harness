/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тесты читают нагрузку событий и правят сырой JSON политики.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_STALL_SWEEP,
  executionDigest,
  executionPolicySchema,
  repairPolicy,
  stallSweepOf,
  type StallSweepPolicy,
  HarnessError,
} from '../src/contracts/index.ts';
import { ActivityScope, activityScope } from '../src/environment/activity.ts';
import { command } from '../src/environment/process.ts';
import {
  MAX_CHANGE_RETRIES,
  StallSweep,
  UNMASKED_COMMAND,
  sharedSample,
  parseCpuTime,
  parseProcessTable,
  treeOf,
  type LivenessChange,
  type ProcessRow,
} from '../src/engine/stall-sweep.ts';
import { attemptView, explainStop } from '../src/projections/index.ts';
import { runGatesAt } from '../src/verification/gates-at.ts';
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
    changed: (c) => {
      changes.push(c);
    },
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
    '  10     1   0:01.00 /bin/sh -c sleep 100\n  11    10   0:00.00 sleep 100\n  12     1   0:00.00 other\n  13    11   0:00.00\n  14    13   0:00.02 cc -c x.c\nbad line\n',
  );
  assert.equal(rows.length, 5);
  assert.equal(rows[3]!.command, '', 'строка без команды не отброшена');
  assert.deepEqual(
    treeOf(rows, 10).map((r) => r.pid),
    [10, 11, 13, 14],
    'поддерево под процессом без команды не потеряно',
  );
  assert.equal(rows[0]!.command, '/bin/sh -c sleep 100');
});

test('Политика: без поля — умолчания и прежний digest; пороги согласованы; надзор вне digest исполнения', () => {
  const raw = structuredClone(example('policy'));
  const parsed = executionPolicySchema.parse(raw);
  assert.equal(parsed.stallSweep, undefined, 'умолчание не подставляется в политику');
  assert.deepEqual(stallSweepOf(parsed), DEFAULT_STALL_SWEEP);
  assert.equal(DEFAULT_STALL_SWEEP.action, 'report');
  assert.ok(DEFAULT_STALL_SWEEP.quietMs < DEFAULT_STALL_SWEEP.stalledMs);
  const set = executionPolicySchema.parse({ ...raw, stallSweep: { action: 'stop' } });
  assert.deepEqual(set.stallSweep, { ...DEFAULT_STALL_SWEEP, action: 'stop' });
  assert.equal(
    executionDigest(set),
    executionDigest(parsed),
    'пороги обхода не меняют основания попыток и reuse',
  );
  const rejects = (stallSweep: Record<string, unknown>) =>
    assert.equal(executionPolicySchema.safeParse({ ...raw, stallSweep }).success, false);
  rejects({ quietMs: 500_000, stalledMs: 500_000 });
  rejects({ intervalMs: 50, quietMs: 1000, stalledMs: 2000 });
  rejects({ intervalMs: 5000, quietMs: 2000, stalledMs: 9000 });
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

test('Обход: сборка из коротких потомков на 100 % процессора не зависает, хотя сумма дерева падает', async () => {
  const h = harness({ intervalMs: 30_000, quietMs: 180_000, stalledMs: 600_000, action: 'stop' });
  h.scope.begin(10, { kind: 'gate', label: 'build' });
  // Потомок 100 считает 60 с, дальше — компиляции по 20 с, каждая на 100 %:
  // сумма дерева после ухода первого потомка меньше прежней.
  let child = 100,
    childCpu = 0;
  for (let t = 0; t <= 900_000; t += 30_000) {
    if (t <= 60_000) childCpu = t;
    else {
      child = 101 + Math.floor((t - 60_000) / 20_000);
      childCpu = ((t - 60_000) % 20_000) + 10_000;
    }
    h.setRows([
      { pid: 10, parentPid: 1, cpuMs: 100, command: 'make -s' },
      { pid: child, parentPid: 10, cpuMs: Math.min(childCpu, 20_000), command: 'cc' },
    ]);
    await h.sweep.tick();
    h.advance(30_000);
  }
  assert.deepEqual(h.states(), []);
});

test('Обход: тот же состав дерева без расхода — простой, даже когда сумма дерева ниже прежней', async () => {
  const h = harness();
  h.scope.begin(10, { kind: 'step', label: 'build' });
  h.setRows([
    { pid: 10, parentPid: 1, cpuMs: 0, command: 'sh' },
    { pid: 11, parentPid: 10, cpuMs: 5000, command: 'cc' },
  ]);
  await h.sweep.tick();
  // Потомок ушёл, новый стоит: смена состава движением не считается.
  h.advance(100);
  h.setRows([
    { pid: 10, parentPid: 1, cpuMs: 0, command: 'sh' },
    { pid: 12, parentPid: 10, cpuMs: 0, command: 'sleep 999' },
  ]);
  await h.sweep.tick();
  for (let i = 0; i < 4; i++) {
    h.advance(100);
    await h.sweep.tick();
  }
  assert.deepEqual(h.states(), ['quiet', 'stalled']);
});

test('Обход: перерыв обходов (сон машины, занятый event loop) — не простой работы', async () => {
  const h = harness({ ...policy, action: 'stop' });
  h.scope.begin(10, { kind: 'agent', label: 'claude implement' });
  h.setRows([{ pid: 10, parentPid: 1, cpuMs: 0, command: 'claude' }]);
  await h.sweep.tick();
  // Часы прыгнули на час: решения нет, отсчёт заново.
  h.advance(3_600_000);
  await h.sweep.tick();
  assert.deepEqual(h.states(), []);
  h.advance(200);
  await h.sweep.tick();
  assert.deepEqual(h.states(), ['quiet'], 'дальше — обычный отсчёт от перерыва');
});

test('Обход: без данных ps — не выше quiet, без остановки; причина названа', async () => {
  const h = harness({ ...policy, action: 'stop' });
  h.scope.begin(10, { kind: 'agent', label: 'claude implement' });
  h.setRows(null);
  h.advance(400);
  await h.sweep.tick();
  h.advance(10_000 / 20);
  await h.sweep.tick();
  assert.deepEqual(h.states(), ['quiet']);
  assert.equal(h.changes[0]!.cpuUnavailable, true);
  // Процесс есть, но время ps не сообщает (BusyBox): то же.
  const b = harness({ ...policy, action: 'stop' });
  b.scope.begin(10, { kind: 'gate', label: 'unit' });
  b.setRows([{ pid: 10, parentPid: 1, command: 'node' }]);
  b.advance(400);
  await b.sweep.tick();
  assert.deepEqual(b.states(), ['quiet']);
});

test('Обход: stop — после stalled попытка больше не оценивается', async () => {
  const h = harness({ ...policy, action: 'stop' });
  const t = h.scope.begin(10, { kind: 'agent', label: 'claude implement' });
  h.setRows([{ pid: 10, parentPid: 1, cpuMs: 0, command: 'claude' }]);
  await h.sweep.tick();
  h.advance(400);
  await h.sweep.tick();
  assert.deepEqual(h.states(), ['stalled']);
  // Остановка завершает команду — это не движение для обхода.
  h.scope.end(t);
  await h.sweep.tick();
  assert.deepEqual(h.states(), ['stalled']);
});

test('Обход: незаписанный переход повторяется следующим обходом; утраченный — больше не оценивается', async () => {
  let now = 0;
  const clock = () => now;
  const scope = new ActivityScope(clock);
  scope.begin(10, { kind: 'gate', label: 'unit' });
  const outcomes: ('retry' | 'dropped' | 'recorded' | 'throw')[] = ['throw', 'retry', 'recorded'];
  const seen: string[] = [];
  const sweep = new StallSweep({
    policy,
    clock,
    sample: () => Promise.resolve([{ pid: 10, parentPid: 1, cpuMs: 0, command: 'node' }]),
    subjects: () => [{ id: 'A', scope }],
    changed: (c) => {
      seen.push(c.state);
      const next = outcomes.shift() ?? 'recorded';
      if (next === 'throw') throw new Error('хранилище недоступно');
      return next;
    },
  });
  await sweep.tick();
  now = 150;
  await sweep.tick();
  await sweep.tick();
  await sweep.tick();
  assert.deepEqual(seen, ['quiet', 'quiet', 'quiet'], 'пока не записан — повтор');
  await sweep.tick();
  assert.equal(seen.length, 3, 'записанный не повторяется');

  const lost = new ActivityScope(clock);
  lost.begin(11, { kind: 'gate', label: 'unit' });
  const dropped: string[] = [];
  const other = new StallSweep({
    policy,
    clock,
    sample: () => Promise.resolve([{ pid: 11, parentPid: 1, cpuMs: 0, command: 'node' }]),
    subjects: () => [{ id: 'B', scope: lost }],
    changed: (c) => {
      dropped.push(c.state);
      return 'dropped';
    },
  });
  await other.tick();
  now = 1000;
  await other.tick();
  now = 1500;
  await other.tick();
  assert.deepEqual(dropped, ['stalled']);
});

test('Обход: попытка без команды (ждёт hook, ресурс, интеграцию) — от последнего движения, не выше quiet', async () => {
  let now = 0;
  const clock = () => now;
  const waiting = new ActivityScope(clock);
  const seen: LivenessChange[] = [];
  const sweep = new StallSweep({
    policy: { ...policy, action: 'stop' },
    clock,
    sample: () => Promise.resolve([]),
    subjects: () => [{ id: 'W', scope: waiting }],
    changed: (c) => {
      seen.push(c);
    },
  });
  now = 200;
  await sweep.tick();
  assert.equal(seen.length, 0, 'меньше stalledMs — active');
  now = 400;
  await sweep.tick();
  now = 900;
  await sweep.tick();
  assert.deepEqual(
    seen.map((c) => c.state),
    ['quiet'],
  );
  assert.equal(seen[0]!.activity, undefined);
  assert.equal(seen[0]!.snapshot, undefined);
});

test('Обход: строка команды без маски в снимок не попадает', async () => {
  const h = harness();
  h.scope.begin(10, { kind: 'command', label: 'git' });
  h.setRows([{ pid: 10, parentPid: 1, cpuMs: 0, command: 'git -c token=abc fetch' }]);
  await h.sweep.tick();
  h.advance(400);
  await h.sweep.tick();
  const stalled = h.changes.find((c) => c.state === 'stalled')!;
  assert.equal(stalled.snapshot!.processes[0]!.command, UNMASKED_COMMAND);
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
// нагрузкой сам по себе молчит до секунды. Интервал — минимум политики.
const sweepPolicy =
  (action: 'stop' | 'report', extra?: (p: Record<string, any>) => void) =>
  (p: Record<string, any>) => {
    p.stallSweep = { intervalMs: 1000, quietMs: 1000, stalledMs: 3000, action };
    p.maxAttempts = 1;
    extra?.(p);
  };
type Payload = Record<string, any>;
const livenessEvents = (ctx: ReturnType<typeof setup>): Payload[] =>
  ctx.store
    .events(0, 500)
    .filter((e) => e.type === 'attempt.liveness')
    .map((e) => ({ ...(e as { payload: Payload }).payload, at: e.at }));
const firstAttempt = (ctx: ReturnType<typeof setup>) =>
  ctx.engine.read((v) => v.attempts('add-greeting'))[0]!;
/** Gate кандидата: сначала `script`, затем обычный тест-раннер; на integration — сразу он. */
const candidateGate = (script: string) =>
  `if (process.env.DEVCONTOUR_PHASE !== 'candidate') require('./run.js'); else {\n${script}\n}\n`;
const waitFor = async (path: string) => {
  for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 20));
};

test('Runner: молчащий исполнитель остановлен исходом stalled со снимком, а не timeout', async () => {
  const ctx = setup({
    scenario: { writer: { sleepMs: 30000, ...implement() }, reviewer: approve() },
    policy: sweepPolicy('stop'),
  });
  const started = Date.now();
  await runAll(ctx);
  assert.ok(Date.now() - started < 25000, 'остановлен до конца сна исполнителя');
  const first = firstAttempt(ctx);
  assert.equal(first.failureKind, 'stalled', first.error);
  assert.match(first.error!, /agent claude implement.*Повтор или правка среды/);
  assert.equal(first.liveness?.state, 'stalled');
  assert.equal(first.liveness?.action, 'stop');
  const events = livenessEvents(ctx);
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
  assert.ok(existsSync(snapshot.artifact), 'файл снимка записан до события');
  assert.equal(
    (JSON.parse(readFileSync(snapshot.artifact, 'utf8')) as { action: string }).action,
    'stop',
  );
});

test('Runner: зависший шаг среды остановлен исходом stalled с названием шага; отказ записи перехода повторяется', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: sweepPolicy('stop', (p) => {
      p.repositories[0].prepare = [
        { id: 'warmup', command: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'] },
      ];
    }),
  });
  // Первая запись перехода отказывает (хранилище занято): переход не теряется.
  const write = ctx.engine.liveness.bind(ctx.engine);
  let failures = 1;
  ctx.engine.liveness = (...args) => {
    if (failures-- > 0) throw new Error('database is locked');
    write(...args);
  };
  await runAll(ctx);
  const first = firstAttempt(ctx);
  assert.equal(first.failureKind, 'stalled', first.error);
  assert.match(first.error!, /step warmup/);
  assert.deepEqual(
    livenessEvents(ctx).map((e) => String(e.state)),
    ['quiet', 'stalled'],
    'отказавший переход записан следующим обходом',
  );
  assert.deepEqual(livenessEvents(ctx).at(-1)!.activity, { kind: 'step', label: 'warmup' });
});

test('Runner: секрет окружения gate в argv потомка не попадает ни в событие, ни в снимок', async () => {
  const secret = 'stall-secret-' + Math.random().toString(36).slice(2);
  process.env.STALL_TEST_SECRET_SRC = secret;
  try {
    const ctx = setup({
      scenario: { writer: implement(), reviewer: approve() },
      files: {
        'test/secret.js': candidateGate(
          "require('child_process').spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', process.env.API_TOKEN], { stdio: 'ignore' });",
        ),
      },
      policy: sweepPolicy('stop', (p) => {
        p.environment.secrets = { API_TOKEN: 'STALL_TEST_SECRET_SRC' };
        p.repositories[0].gates[0].command = [process.execPath, 'test/secret.js'];
      }),
    });
    await runAll(ctx);
    const first = firstAttempt(ctx);
    assert.equal(first.failureKind, 'stalled', first.error);
    const stalled = livenessEvents(ctx).at(-1)!;
    assert.equal(stalled.activity.kind, 'gate');
    const processes = stalled.snapshot.processes as { command: string }[];
    assert.ok(
      processes.some((p) => p.command.includes('setTimeout')),
      'потомок в снимке: ' + JSON.stringify(processes),
    );
    assert.ok(!JSON.stringify(stalled).includes(secret), 'секрет в событии');
    await waitFor(stalled.snapshot.artifact as string);
    assert.ok(
      !readFileSync(stalled.snapshot.artifact as string, 'utf8').includes(secret),
      'секрет в снимке',
    );
  } finally {
    delete process.env.STALL_TEST_SECRET_SRC;
  }
});

test('Runner: молчащий gate, считающий в коротких потомках, не зависает', async () => {
  const burn = (ms: number) =>
    `require('child_process').execFileSync(process.execPath, ['-e', 'const e = Date.now() + ${ms}; while (Date.now() < e) {}'], { stdio: 'ignore' });`;
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    files: {
      'test/churn.js': candidateGate(
        [burn(2500), ...Array.from({ length: 5 }, () => burn(1000)), "require('./run.js');"].join(
          '\n',
        ),
      ),
    },
    policy: sweepPolicy('stop', (p) => {
      p.repositories[0].gates[0].command = [process.execPath, 'test/churn.js'];
    }),
  });
  await runAll(ctx);
  const first = firstAttempt(ctx);
  assert.equal(first.status, 'succeeded', first.error);
  assert.deepEqual(
    livenessEvents(ctx).filter((e) => e.state === 'stalled'),
    [],
  );
});

test('Runner: report только сообщает — попытка доходит до конца, вывод возвращает active до конца команды', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    files: {
      'test/late.js': candidateGate(
        "setTimeout(() => { console.log('progress'); setTimeout(() => require('./run.js'), 3000); }, 5000);",
      ),
    },
    policy: sweepPolicy('report', (p) => {
      p.repositories[0].gates[0].command = [process.execPath, 'test/late.js'];
    }),
  });
  await runAll(ctx);
  const first = firstAttempt(ctx);
  assert.equal(first.status, 'succeeded', first.error);
  const states = livenessEvents(ctx);
  const stalled = states.findIndex((s) => s.state === 'stalled' && s.activity?.kind === 'gate');
  assert.ok(stalled >= 0, JSON.stringify(states));
  assert.equal(states[stalled]!.action, 'report');
  const active = states[stalled + 1]!;
  assert.equal(active.state, 'active', JSON.stringify(states));
  assert.equal(active.activity.kind, 'gate', 'gate ещё исполняется: active дал вывод');
  const finished = ctx.store
    .events(0, 500)
    .find(
      (e) =>
        e.type === 'attempt.stage' &&
        (e as { payload: Payload }).payload.phase === 'finished' &&
        String((e as { payload: Payload }).payload.stage).startsWith('candidate-test'),
    )!;
  assert.ok(active.at < finished.at, `${active.at} < ${finished.at}`);
});

test('runGatesAt: зависший gate вне попытки остановлен своим обходом, причина — зависание', async () => {
  const ctx = setup({
    scenario: {},
    files: { 'test/hang.js': 'setTimeout(() => {}, 30000);\n' },
    policy: sweepPolicy('stop', (p) => {
      p.repositories[0].gates[0].command = [process.execPath, 'test/hang.js'];
    }),
  });
  const started = Date.now();
  const result = await runGatesAt(
    {
      policy: ctx.policy,
      stateDir: ctx.state,
      repoPath: () => ctx.repo.dir,
      boundary: () => ({ hidden: [ctx.state], readable: [join(ctx.repo.dir, '.git')] }),
      resourceDatabase: join(ctx.state, 'resources.sqlite'),
    },
    { repositoryId: 'app', sha: ctx.repo.head(), gates: ['unit'], record: () => undefined },
  );
  assert.ok(Date.now() - started < 25000, 'до конца сна gate');
  assert.match(result.failure?.message ?? '', /Зависание: gate unit/);
});

test('Обход: цикл ожидания (процессы рождаются, процессор не растёт) — зависание', async () => {
  const h = harness({ ...policy, action: 'stop' });
  h.scope.begin(10, { kind: 'gate', label: 'wait-db' });
  // `until nc -z db 5432; do sleep 1; done`: каждый обход — новый sleep.
  for (let i = 0; i < 6; i++) {
    h.setRows([
      { pid: 10, parentPid: 1, cpuMs: 3, command: 'sh -c until …' },
      { pid: 100 + i, parentPid: 10, cpuMs: 0, command: 'sleep 1' },
    ]);
    await h.sweep.tick();
    h.advance(100);
  }
  assert.deepEqual(h.states(), ['quiet', 'stalled']);
});

test('Обход: перерыв считается от конца прошлого обхода — медленный ps не сбрасывает отсчёт', async () => {
  let now = 0;
  const scope = new ActivityScope(() => now);
  scope.begin(10, { kind: 'gate', label: 'unit' });
  const seen: string[] = [];
  const sweep = new StallSweep({
    policy: { intervalMs: 1000, quietMs: 2000, stalledMs: 9000, action: 'report' },
    clock: () => now,
    // ps отвечает 2,5 интервала: от начала до начала — больше трёх интервалов.
    sample: () => {
      now += 2500;
      return Promise.resolve([{ pid: 10, parentPid: 1, cpuMs: 0, command: 'node' }]);
    },
    subjects: () => [{ id: 'A', scope }],
    changed: (c) => {
      seen.push(c.state);
    },
  });
  await sweep.tick();
  now += 1000;
  await sweep.tick();
  assert.deepEqual(seen, ['quiet'], 'второй обход решает, а не сбрасывает отсчёт');
});

test('Обход: перерывы подряд сбрасывают отсчёт не больше двух раз', async () => {
  const h = harness({ ...policy, action: 'stop' });
  h.scope.begin(10, { kind: 'gate', label: 'unit' });
  h.setRows([{ pid: 10, parentPid: 1, cpuMs: 0, command: 'node' }]);
  await h.sweep.tick();
  for (let i = 0; i < 3; i++) {
    h.advance(5000);
    await h.sweep.tick();
  }
  assert.deepEqual(h.states(), ['stalled'], 'третий опоздавший обход решает');
});

test('Обход: устойчивый отказ записи — ограниченные повторы одного эпизода', async () => {
  let now = 0;
  const scope = new ActivityScope(() => now);
  scope.begin(10, { kind: 'gate', label: 'unit' });
  const episodes: number[] = [];
  const sweep = new StallSweep({
    policy,
    clock: () => now,
    sample: () => Promise.resolve([{ pid: 10, parentPid: 1, cpuMs: 0, command: 'node' }]),
    subjects: () => [{ id: 'A', scope }],
    changed: (c) => {
      episodes.push(c.episode);
      return 'retry';
    },
  });
  await sweep.tick();
  now = 400;
  for (let i = 0; i < MAX_CHANGE_RETRIES + 5; i++) await sweep.tick();
  assert.equal(episodes.length, MAX_CHANGE_RETRIES + 1, 'первая запись и повторы');
  assert.deepEqual(new Set(episodes), new Set([1]), 'повторы — тот же эпизод');
});

test('Обход: эпизоды зависания нумеруются заново после выхода из stalled', async () => {
  const h = harness();
  const t = h.scope.begin(10, { kind: 'gate', label: 'unit' });
  h.setRows([{ pid: 10, parentPid: 1, cpuMs: 0, command: 'node' }]);
  await h.sweep.tick();
  h.advance(400);
  await h.sweep.tick();
  h.scope.output(t, 'x');
  await h.sweep.tick();
  h.advance(400);
  await h.sweep.tick();
  assert.deepEqual(
    h.changes.map((c) => `${c.state}:${c.episode}`),
    ['stalled:1', 'active:1', 'stalled:2'],
  );
});

test('Таблица процессов общая для одновременных обходов в пределах окна', () => {
  const a = sharedSample(60_000);
  const b = sharedSample(60_000);
  assert.equal(a, b, 'второй обход берёт тот же снимок');
  assert.notEqual(sharedSample(0), a, 'устаревший снимок обновляется');
});

test('Runner: gate с циклом ожидания (sleep в цикле) остановлен исходом stalled', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: sweepPolicy('stop', (p) => {
      p.repositories[0].gates[0].command = ['/bin/sh', '-c', 'until false; do sleep 1; done'];
      p.repositories[0].gates[0].timeoutMs = 30000;
    }),
  });
  const started = Date.now();
  await runAll(ctx);
  assert.ok(Date.now() - started < 25000, 'до предела gate');
  const first = firstAttempt(ctx);
  assert.equal(first.failureKind, 'stalled', first.error);
  assert.match(first.error!, /gate unit/);
});

test('Runner: отказ записи stalled — один снимок на эпизод, повторы ограничены', async () => {
  const ctx = setup({
    scenario: { writer: { sleepMs: 12000, ...implement() }, reviewer: approve() },
    policy: sweepPolicy('report'),
  });
  const write = ctx.engine.liveness.bind(ctx.engine);
  let refused = 0;
  ctx.engine.liveness = (id, token, record, payload) => {
    if (payload.state === 'stalled') {
      refused++;
      throw new Error('disk I/O error');
    }
    write(id, token, record, payload);
  };
  await runAll(ctx);
  const first = firstAttempt(ctx);
  assert.equal(first.status, 'succeeded', first.error);
  assert.equal(refused, MAX_CHANGE_RETRIES + 1, 'первая запись и ограниченные повторы');
  const dir = join(ctx.state, 'artifacts', first.id);
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.startsWith('stall-')),
    ['stall-1.json'],
  );
});

test('Runner: stop останавливает зависшую попытку и при отказе движка записать переход', async () => {
  const ctx = setup({
    scenario: { writer: { sleepMs: 30000, ...implement() }, reviewer: approve() },
    policy: sweepPolicy('stop'),
  });
  const write = ctx.engine.liveness.bind(ctx.engine);
  ctx.engine.liveness = (id, token, record, payload) => {
    if (payload.state === 'stalled') throw new HarnessError('LEASE_STALE', 'устаревшая');
    write(id, token, record, payload);
  };
  const started = Date.now();
  await runAll(ctx);
  assert.ok(Date.now() - started < 25000);
  assert.equal(firstAttempt(ctx).failureKind, 'stalled', firstAttempt(ctx).error);
});

test('runGatesAt: report — зависание видно в результате и хосту, проверка доходит до конца', async () => {
  const ctx = setup({
    scenario: {},
    files: {
      'test/late.js': "setTimeout(() => require('./run.js'), 5000);\n",
      'src/greet.js': "exports.greet = (name) => 'Hello, ' + name + '!';\n",
    },
    policy: sweepPolicy('report', (p) => {
      p.repositories[0].gates[0].command = [process.execPath, 'test/late.js'];
    }),
  });
  const reported: string[] = [];
  const result = await runGatesAt(
    {
      policy: ctx.policy,
      stateDir: ctx.state,
      repoPath: () => ctx.repo.dir,
      boundary: () => ({ hidden: [ctx.state], readable: [join(ctx.repo.dir, '.git')] }),
      resourceDatabase: join(ctx.state, 'resources.sqlite'),
    },
    {
      repositoryId: 'app',
      sha: ctx.repo.head(),
      gates: ['unit'],
      record: () => undefined,
      onLiveness: (r) => reported.push(r.state),
    },
  );
  assert.equal(result.failure, undefined, JSON.stringify(result.failures));
  const stalled = result.liveness?.find((r) => r.state === 'stalled');
  assert.equal(stalled?.action, 'report', JSON.stringify(result.liveness));
  assert.deepEqual(stalled?.activity, { kind: 'gate', label: 'unit' });
  assert.ok(reported.includes('stalled'), 'хост получил переход');
});
