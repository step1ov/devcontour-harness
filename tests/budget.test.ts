import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HarnessError,
  WORKSPACE_OWNER,
  executionPolicySchema,
  policyIssues,
  type CallRecord,
  type ExecutionPolicy,
  type ExecutionView,
  type RuntimeAdapter,
  type RuntimeRequest,
  type RuntimeResponse,
  type Usage,
} from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { budgetOverview, budgetStatus, workBudgets } from '../src/engine/budget.ts';
import { measuredInvoke } from '../src/engine/measured.ts';
import {
  callDurationMs,
  callRecords,
  liveCall,
  ownerGone,
  priceUsage,
  usageTotals,
  type Price,
} from '../src/engine/usage.ts';
import { BOOT_ID, processStartedAt } from '../src/environment/live-calls.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { graphOf, policyOf, ready } from './engine-fixture.ts';

const price: Price = {
  runtime: 'claude',
  model: 'cheap',
  effectiveAt: '2026-01-01T00:00:00.000Z',
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
};
const usage = (complete = true, reportedUsd: number | null = null): Usage => ({
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reportedUsd,
  complete,
  source: 'claude-result',
});
type Budgets = ExecutionPolicy['budgets'];

/**
 * Движок с бюджетами над SQLite. Группы — через порт `BudgetScopes` хоста:
 * `move` переносит поручение в другую группу (у DevContour — на другую доску).
 */
function contour(budgets: Budgets, patch: (p: Record<string, unknown>) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-budget-'));
  const store = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  const moved = new Map<string, string>();
  const make = (next: Budgets) => {
    const policy = policyOf((p) => {
      p.prices = [price];
      if (next) p.budgets = next;
      patch(p);
    });
    const base = standaloneHost(store, policy);
    const groupOf = (workId: string, view: ExecutionView) =>
      moved.get(workId) ?? view.work(workId)?.graphId;
    return new Engine({
      policy,
      host: {
        ...base,
        budgets: {
          groupOf,
          members: (groupId, view) =>
            view
              .works()
              .filter((w) => groupOf(w.id, view) === groupId)
              .map((w) => w.id),
          legacy: (record, view) => base.budgets.legacy(record, view),
        },
      },
    });
  };
  const engine = make(budgets);
  return {
    engine,
    store,
    move: (workId: string, groupId: string) => moved.set(workId, groupId),
    /** Тот же файл состояния под новой политикой (перезапуск процесса); граф согласуется заново; `null` — без бюджетов. */
    reopen: (next: Budgets | null = budgets) => {
      const e = make(next ?? undefined);
      for (const g of e.read((v) => v.graphs())) if (g.approval) e.approve(g.id, 'agent');
      e.lead('c1');
      return e;
    },
    close: () => store.close(),
  };
}

/** Настоящий ответ runtime: usage и модель. */
const response = (u: Usage, model: string | null, status: RuntimeResponse['status'] = 'ok') =>
  ({
    status,
    model,
    runtimeVersion: 'v',
    text: '',
    usage: u,
    diagnostics: { exitCode: status === 'ok' ? 0 : 1 },
  }) satisfies RuntimeResponse;
const adapter = (
  run: (r: RuntimeRequest) => Promise<RuntimeResponse> | RuntimeResponse,
  runtime: 'claude' | 'codex' = 'claude',
): RuntimeAdapter => ({
  runtime,
  capabilities: () =>
    Promise.resolve({
      runtime,
      structuredOutput: true,
      sandbox: ['none'],
      cancellation: true,
      usage: true,
      fixture: true,
    }),
  invoke: async (r) => {
    await Promise.resolve();
    return run(r);
  },
});
let calls = 0;
const request = (model = 'cheap'): RuntimeRequest => ({
  callId: `call-${++calls}`,
  task: 'implement',
  binding: { runtime: 'claude', model },
  cwd: tmpdir(),
  prompt: 'p',
  session: { kind: 'fresh' },
  sandbox: { mode: 'none', writable: [], denied: [], network: { domains: [] } },
  timeoutMs: 60_000,
  env: {},
});
/** Вызов, сообщающий usage и модель: оценка по тарифу $3 за вызов. */
const spend = (
  e: Engine,
  runId: string | undefined,
  outcome: 'ok' | 'error' | 'throw' = 'ok',
  u = usage(),
  model: string | null = 'cheap',
  stage = 'implementation',
  subjectId?: string,
) =>
  measuredInvoke(
    e,
    adapter(() => {
      if (outcome === 'throw') throw new Error('provider failed');
      return response(u, model, outcome === 'ok' ? 'ok' : 'failed');
    }),
    request(),
    new AbortController().signal,
    {
      repositoryId: 'app',
      ...(runId ? { runId } : {}),
      ...(subjectId ? { subjectId } : {}),
      stage,
    },
  );
const records = (e: Engine) => e.read((v) => callRecords(v));
const save = (e: Engine, r: CallRecord) =>
  e.host.store.transact('usage.recorded', (tx) =>
    tx.putLocal('usage', r.repositoryId ?? WORKSPACE_OWNER, r.id, r),
  );
const status = (e: Engine, scope: Parameters<typeof budgetStatus>[2]) =>
  e.read((v) => budgetStatus(e.budgetContext(), v, scope));
const base: CallRecord = {
  id: 'x',
  repositoryId: 'app',
  stage: 'planning',
  runtime: 'claude',
  model: 'cheap',
  runtimeVersion: null,
  startedAt: new Date().toISOString(),
  outcome: 'active',
  promptBytes: 1,
  promptDigest: 'd'.repeat(64),
  usage: usage(false),
  costUsd: null,
  costSource: 'unknown',
};

test('B01: бюджеты необязательны; предел требует usd или timeMs; неизвестная стоимость по умолчанию останавливает; тарифы однозначны', () => {
  assert.equal(policyOf().budgets, undefined);
  assert.throws(() => policyOf((p) => (p.budgets = { work: {} })));
  assert.throws(() => policyOf((p) => (p.budgets = { work: { usd: -1 } })));
  assert.equal(policyOf((p) => (p.budgets = { work: { usd: 1 } })).budgets?.onUnknown, 'stop');
  const duplicate = executionPolicySchema.parse({
    ...policyOf(),
    prices: [price, { ...price, effectiveAt: '2026-01-01T00:00:00Z', input: 9 }],
  });
  assert.match(
    policyIssues(duplicate)
      .map((i) => i.message)
      .join('\n'),
    /Повтор тарифа claude\/cheap/,
  );
});

test('B02/B04: сообщённое и оценённое раздельны; частичные счётчики не оцениваются; тариф — по модели, о которой сообщил runtime', async () => {
  assert.deepEqual(priceUsage(usage(false), price), { costUsd: null, costSource: 'unknown' });
  assert.deepEqual(priceUsage(usage(true), price), { costUsd: 3, costSource: 'tariff-estimate' });
  const f = contour(undefined);
  try {
    ready(f.engine, graphOf({ a: [] }));
    const run = f.engine.claim('c1')!;
    await spend(f.engine, run.id);
    await spend(f.engine, run.id, 'ok', usage(true, 0.5));
    // Runtime сообщил другую модель: тариф запрошенной к ней не относится.
    await spend(f.engine, run.id, 'ok', usage(), 'expensive');
    const all = records(f.engine);
    const other = all.find((r) => r.model === 'expensive')!;
    assert.equal(other.costSource, 'unknown');
    assert.equal(other.price, undefined);
    assert.ok(
      all.every((r) => r.workId === 'a' && r.groupId === 'g'),
      'атрибуция при вызове',
    );
    const totals = usageTotals(all);
    assert.equal(totals.reportedUsd, 0.5);
    assert.equal(totals.estimatedUsd, 3);
    assert.equal(totals.knownCostUsd, 3.5);
    assert.equal(totals.unknownCalls, 1);
  } finally {
    f.close();
  }
});

test('B03: вызов умершего процесса закрывается как abandoned и учитывается; живой остаётся идущим', async () => {
  const f = contour({ total: { usd: 100 }, onUnknown: 'stop' });
  // Живой владелец — настоящий другой процесс с известным моментом старта.
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  await new Promise((done) => setTimeout(done, 200));
  try {
    ready(f.engine, graphOf({ a: [] }));
    const run = f.engine.claim('c1')!;
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const call = {
      ...base,
      runId: run.id,
      stage: 'implementation',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    save(f.engine, { ...call, id: 'crashed', process: { id: 'old-process', pid: dead } });
    save(f.engine, {
      ...call,
      id: 'live',
      process: { id: 'other-live', pid: owner.pid!, startedAt: processStartedAt(owner.pid!)! },
    });
    assert.deepEqual(f.engine.abandonCalls(), ['crashed']);
    const all = records(f.engine);
    assert.equal(all.find((r) => r.id === 'crashed')!.outcome, 'abandoned');
    assert.equal(all.find((r) => r.id === 'live')!.outcome, 'active');
    const totals = usageTotals(all);
    assert.equal(totals.abandonedCalls, 1);
    assert.equal(totals.unfinishedCalls, 1);
    assert.equal(totals.unknownCalls, 2);
    assert.equal(totals.complete, false);
    // Без сравнимых монотонных часов время не берётся по системным часам.
    assert.equal(totals.unknownDurationCalls, 2);
    assert.equal(all.find((r) => r.id === 'crashed')!.durationUnknown, true);
    const s = status(f.engine, { kind: 'total' })!;
    assert.equal(s.state, 'undetermined');
    assert.match(s.reason!, /у 1 вызовов неизвестна стоимость/);
  } finally {
    owner.kill();
    f.close();
  }
});

test('B05/T25: исчерпанный бюджет поручения останавливает выдачу и вызовы; retry --reset и перезапуск не сбрасывают; поднять предел может только политика', async () => {
  const budgets = { work: { usd: 5 }, onUnknown: 'stop' as const };
  const f = contour(budgets);
  try {
    ready(f.engine, graphOf({ a: [] }));
    const first = f.engine.claim('c1')!;
    // Ошибочный вызов входит в расход со своей оценкой.
    await spend(f.engine, first.id, 'error');
    await spend(f.engine, first.id);
    assert.equal(status(f.engine, { kind: 'work', id: 'a' })?.state, 'exceeded');
    // Вызов сверх бюджета не начинается: адаптер не вызван, записи нет.
    let invoked = false;
    const before = records(f.engine).length;
    const refused = await measuredInvoke(
      f.engine,
      adapter(() => {
        invoked = true;
        return response(usage(), 'cheap');
      }),
      request(),
      new AbortController().signal,
      { repositoryId: 'app', runId: first.id, stage: 'candidate-review' },
    ).catch((e: unknown) => e);
    assert.ok(refused instanceof TaskFailure);
    assert.equal(refused.kind, 'budget');
    assert.match(
      refused.message,
      /Бюджет work a исчерпан: предел \$5; израсходовано: сообщено \$0\.0000, оценено \$6\.0000/,
    );
    assert.equal(invoked, false);
    assert.equal(records(f.engine).length, before);
    f.engine.fail(first.id, first.token, 'failed', { kind: 'budget' });
    // Сброс попыток не сбрасывает деньги.
    f.engine.retry('a', { reason: 'ещё раз' });
    assert.equal(f.engine.claim('c1'), undefined);
    const blocked = f.engine.read((v) => v.work('a')!);
    assert.match(blocked.budgetBlock!.reason, /исчерпан/);
    const blockers = f.engine.read((v) => f.engine.blockers(v.work('a')!, v));
    assert.ok(blockers.some((b) => b.code === 'BUDGET_EXHAUSTED' && /исчерпан/.test(b.message)));
    assert.equal(
      f.store.events().filter((e) => e.type === 'budget.blocked').length,
      1,
      'событие — при смене причины, не на каждом такте',
    );
    assert.equal(f.engine.claim('c1'), undefined);
    assert.equal(f.store.events().filter((e) => e.type === 'budget.blocked').length, 1);
    // Перезапуск процесса — тот же расход из сохранённых записей.
    const restarted = f.reopen();
    assert.equal(restarted.claim('c1'), undefined);
    // Поднять предел можно только политикой.
    const raised = f.reopen({ ...budgets, work: { usd: 50 } });
    assert.equal(raised.claim('c1')?.workId, 'a');
    assert.equal(
      raised.read((v) => v.work('a')!.budgetBlock),
      undefined,
    );
  } finally {
    f.close();
  }
});

test('B05: неизвестная стоимость делает денежный бюджет неопределённым: stop по умолчанию, continue — по нижней границе; бюджет времени считает интервалы вызовов', async () => {
  const f = contour({ work: { usd: 100 }, onUnknown: 'stop' });
  try {
    ready(f.engine, graphOf({ a: [] }));
    const run = f.engine.claim('c1')!;
    await assert.rejects(spend(f.engine, run.id, 'throw', usage(false)), /provider failed/);
    await assert.rejects(
      spend(f.engine, run.id),
      (e: unknown) => e instanceof TaskFailure && /не определён/.test(e.message),
    );
    const lenient = f.reopen({ work: { usd: 100 }, onUnknown: 'continue' });
    await spend(lenient, run.id);
    const overview = lenient.read((v) => budgetOverview(lenient.budgetContext(), v))!;
    const own = overview.budgets.find((x) => x.scope.kind === 'work' && x.scope.id === 'a')!;
    assert.equal(own.state, 'undetermined');
    assert.equal(own.remainingUsd, null);
    assert.equal(own.estimatedUsd, 3);
    assert.equal(own.errorCalls, 1);
    // Бюджет времени: сумма интервалов вызовов, включая ошибочные.
    await measuredInvoke(
      lenient,
      adapter(async () => {
        await new Promise((done) => setTimeout(done, 30));
        return response(usage(true, 0), 'cheap', 'failed');
      }),
      request(),
      new AbortController().signal,
      { repositoryId: 'app', runId: run.id, stage: 'implementation' },
    );
    const timed = f.reopen({ work: { timeMs: 25 }, onUnknown: 'stop' });
    await assert.rejects(spend(timed, run.id), /Бюджет времени work a исчерпан/);
  } finally {
    f.close();
  }
});

test('Выключенные бюджеты снимают удержание; без сообщённой модели нет тарифа; сообщённая стоимость известна; сдвиг часов — не нулевое время', async () => {
  const budgets = { work: { usd: 5 }, onUnknown: 'stop' as const };
  const f = contour(budgets);
  try {
    ready(f.engine, graphOf({ a: [] }));
    const run = f.engine.claim('c1')!;
    await spend(f.engine, run.id);
    await spend(f.engine, run.id);
    f.engine.fail(run.id, run.token, 'failed', { kind: 'budget' });
    f.engine.retry('a', { reason: 'ещё раз' });
    assert.equal(f.engine.claim('c1'), undefined);
    const off = f.reopen(null);
    const next = off.claim('c1')!;
    assert.equal(next.workId, 'a');
    assert.equal(
      off.read((v) => v.work('a')!.budgetBlock),
      undefined,
    );
    // Runtime не сообщил модель: запрошенная модель тариф не подтверждает.
    await spend(off, next.id, 'ok', usage(), null);
    // Сообщённая стоимость известна и при ошибке и неполных счётчиках.
    await spend(off, next.id, 'error', usage(false, 0));
    const all = records(off);
    const unpriced = all.find((r) => r.usage.complete && r.costSource !== 'tariff-estimate')!;
    assert.equal(unpriced.costSource, 'unknown');
    assert.equal(unpriced.price, undefined);
    const reported = all.find((r) => r.usage.reportedUsd === 0)!;
    assert.equal(reported.costSource, 'provider-reported');
    assert.equal(reported.outcome, 'error');
    assert.equal(usageTotals([reported]).unknownCalls, 0);
    assert.equal(usageTotals([{ ...reported, outcome: 'abandoned' }]).unknownCalls, 0);
    // Время — по монотонным часам; без них противоречивые метки не дают ноль.
    assert.ok(all.every((r) => typeof r.durationMs === 'number'));
    const skewed: CallRecord = {
      ...reported,
      startedAt: '2026-01-01T00:01:00.000Z',
      finishedAt: '2026-01-01T00:00:00.000Z',
    };
    delete skewed.durationMs;
    assert.equal(callDurationMs(skewed), null);
    assert.equal(usageTotals([skewed]).unknownDurationCalls, 1);
  } finally {
    f.close();
  }
});

test('T25: попытки без учёта вызовов, вызовы о группе, перенос между группами и параллельные вызовы учитываются', async () => {
  const f = contour({ work: { usd: 5 }, group: { usd: 5 }, onUnknown: 'stop' });
  try {
    ready(f.engine, graphOf({ a: [] }));
    const run = f.engine.claim('c1')!;
    // Попытка до учёта (без отметки) с кандидатом и без записей вызовов: стоимость неизвестна.
    f.store.transact('run.phase', (tx) => {
      const a = tx.attempt(run.id)!;
      const { callsRecorded: _, ...rest } = a;
      void _;
      tx.putAttempt({ ...rest, candidateSha: 'c'.repeat(40) });
    });
    const legacy = status(f.engine, { kind: 'work', id: 'a' })!;
    assert.equal(legacy.state, 'undetermined');
    assert.match(legacy.reason!, /у 1 попыток вызовы не записаны/);
    const lenient = f.reopen({ work: { usd: 5 }, group: { usd: 5 }, onUnknown: 'continue' });
    // Идущий вызов не останавливает параллельный вызов той же области.
    let inner: unknown;
    await measuredInvoke(
      lenient,
      adapter(async () => {
        inner = await spend(lenient, run.id).catch((e: unknown) => e);
        return response(usage(), 'cheap');
      }),
      request(),
      new AbortController().signal,
      { repositoryId: 'app', runId: run.id, stage: 'implementation' },
    );
    assert.ok(!(inner instanceof Error), String(inner));
    // Вызов о группе (ревью плана) учитывается в бюджете каждого её поручения
    // и не начинается, когда бюджет поручения исчерпан.
    assert.ok(records(lenient).every((r) => r.workId === 'a' && r.groupId === 'g'));
    await assert.rejects(
      spend(lenient, undefined, 'ok', usage(), 'cheap', 'plan-review', 'g'),
      (e: unknown) => e instanceof TaskFailure && e.kind === 'budget',
    );
    // Перенос поручения в другую группу не уводит его из-под исчерпанной группы g.
    f.move('a', 'moved');
    const moved = lenient.read((v) => workBudgets(lenient.budgetContext(), v, 'a'));
    assert.ok(moved.some((x) => x.scope.kind === 'group' && x.scope.id === 'g'));
    assert.equal(status(lenient, { kind: 'group', id: 'moved' })!.spent.estimatedUsd, 0);
    assert.equal(status(lenient, { kind: 'group', id: 'g' })!.state, 'exceeded');
  } finally {
    f.close();
  }
});

test('T26: recovery не перезаписывает вызов, завершившийся после сканирования', () => {
  const f = contour(undefined);
  try {
    const record: CallRecord = { ...base, id: 'legacy', runId: 'R-gone', stage: 'implementation' };
    save(f.engine, record);
    // Между сканированием и транзакцией восстановления вызов завершился.
    const transact = f.store.transact.bind(f.store);
    let raced = false;
    f.store.transact = (kind, fn) => {
      if (!raced && kind === 'usage.recorded') {
        raced = true;
        transact('usage.recorded', (tx) =>
          tx.putLocal('usage', 'app', record.id, {
            ...record,
            outcome: 'returned',
            costUsd: 7,
            costSource: 'provider-reported',
          }),
        );
      }
      return transact(kind, fn);
    };
    assert.deepEqual(f.engine.abandonCalls(), []);
    f.store.transact = transact;
    const stored = records(f.engine).find((r) => r.id === record.id)!;
    assert.equal(stored.outcome, 'returned');
    assert.equal(stored.costUsd, 7);
  } finally {
    f.close();
  }
});

test('T26: оценка прерванного вызова неизвестна; вызов мёртвого или устаревшего владельца неизвестен до recovery; живое время не уменьшается при откате часов', async () => {
  const f = contour({ total: { usd: 100, timeMs: 3_600_000 }, onUnknown: 'stop' });
  try {
    const abandoned: CallRecord = {
      ...base,
      outcome: 'abandoned',
      usage: usage(),
      costUsd: 3,
      costSource: 'tariff-estimate',
    };
    // Оценка прерванного вызова — нижняя граница, а не стоимость.
    assert.equal(usageTotals([abandoned]).unknownCalls, 1);
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    save(f.engine, {
      ...abandoned,
      id: 'dead',
      outcome: 'active',
      process: { id: 'gone', pid: dead },
    });
    // Без восстановления: вызов умершего процесса уже неизвестен.
    const s = status(f.engine, { kind: 'total' })!;
    assert.equal(s.state, 'undetermined');
    assert.equal(s.spent.liveCalls, 0);
    // Живой pid, но вызов старше двух пределов времени: pid мог смениться.
    save(f.engine, {
      ...abandoned,
      id: 'dead',
      outcome: 'returned',
      costSource: 'provider-reported',
    });
    save(f.engine, {
      ...abandoned,
      id: 'stale',
      outcome: 'active',
      startedAt: new Date(Date.now() - 3 * f.engine.policy.runTimeoutMs).toISOString(),
      process: { id: 'other', pid: process.pid },
    });
    assert.equal(status(f.engine, { kind: 'total' })!.spent.liveCalls, 0);
  } finally {
    f.close();
  }
  const g = contour({ total: { timeMs: 3_600_000 }, onUnknown: 'stop' });
  const realNow = Date.now;
  try {
    let measured: number | null = null;
    await measuredInvoke(
      g.engine,
      adapter(async () => {
        await new Promise((done) => setTimeout(done, 30));
        Date.now = () => realNow() - 60_000;
        const active = records(g.engine).find((x) => x.outcome === 'active')!;
        measured = callDurationMs(active, Date.now());
        Date.now = realNow;
        return response(usage(), 'cheap');
      }),
      request(),
      new AbortController().signal,
      { stage: 'planning' },
    );
    assert.ok(measured !== null && measured >= 25, String(measured));
  } finally {
    Date.now = realNow;
    g.close();
  }
});

test('T25: история до учёта остаётся неизвестной после новых вызовов той же попытки; вызов о группе остаётся за её поручениями после переноса', async () => {
  const f = contour({ work: { usd: 5 }, group: { usd: 5 }, onUnknown: 'stop' });
  try {
    ready(f.engine, graphOf({ a: [] }));
    const run = f.engine.claim('c1')!;
    // Попытка до учёта: без кандидата, но с замером реализации.
    f.store.transact('run.phase', (tx) => {
      const { callsRecorded: _, ...rest } = tx.attempt(run.id)!;
      void _;
      tx.putAttempt({
        ...rest,
        timings: [
          { id: 't1', stage: 'implementation', startedAt: rest.startedAt, outcome: 'failed' },
        ],
      });
    });
    const lenient = f.reopen({ work: { usd: 5 }, group: { usd: 5 }, onUnknown: 'continue' });
    // Новый вызов той же попытки (восстановление) пробел не закрывает.
    await spend(lenient, run.id, 'ok', usage(true, 0), 'cheap', 'property-recovery');
    assert.equal(status(lenient, { kind: 'work', id: 'a' })!.spent.uncoveredRuns, 1);
    // Вызов о группе закрепляет её открытые поручения.
    await spend(lenient, undefined, 'ok', usage(true, 6), 'cheap', 'plan-review', 'g');
    const groupCall = records(lenient).find((r) => r.stage === 'plan-review')!;
    assert.deepEqual(groupCall.workIds, ['a']);
    assert.equal(groupCall.groupId, 'g');
    f.move('a', 'moved');
    const own = status(lenient, { kind: 'work', id: 'a' })!;
    assert.equal(own.spent.reportedUsd, 6);
    assert.equal(own.state, 'exceeded');
    assert.ok(
      lenient
        .read((v) => workBudgets(lenient.budgetContext(), v, 'a'))
        .some((x) => x.scope.kind === 'group' && x.scope.id === 'g'),
    );
    // Вызов о группе — за поручениями, открытыми в ней на момент вызова:
    // поручение, пришедшее в группу позже, его расход не получает.
    lenient.register(graphOf({ c: [] }, '1', 'h'), { trusted: () => false, reachable: () => true });
    f.move('c', 'g');
    assert.equal(status(lenient, { kind: 'work', id: 'c' })!.spent.reportedUsd, 0);
    assert.equal(status(lenient, { kind: 'group', id: 'g' })!.spent.reportedUsd, 6);
  } finally {
    f.close();
  }
});

test('Пробел истории — по отметке попытки, а не по времени; длинная история считается; отказанный вызов пробела не оставляет', () => {
  const f = contour({ work: { usd: 5 }, onUnknown: 'stop' });
  try {
    ready(f.engine, graphOf({ a: [] }));
    const run = f.engine.claim('c1')!;
    // Выданная учётом попытка с замером реализации без записи — вызова не
    // было (отказ бюджета до вызова): пробела нет.
    f.store.transact('run.phase', (tx) => {
      const a = tx.attempt(run.id)!;
      tx.putAttempt({
        ...a,
        timings: [{ id: 't1', stage: 'implementation', startedAt: a.startedAt, outcome: 'failed' }],
      });
    });
    const early: CallRecord = {
      ...base,
      id: 'early',
      startedAt: '2020-01-01T00:00:00.000Z',
      finishedAt: '2020-01-01T00:00:01.000Z',
      outcome: 'returned',
      usage: usage(true, 0),
      costUsd: 0,
      costSource: 'provider-reported',
    };
    // Длинная история: расчёт не зависит от предела аргументов.
    const many = Array.from({ length: 150_000 }, (_, i) => ({ ...early, id: `e${i}` }));
    assert.equal(
      f.engine.read((v) =>
        budgetStatus(f.engine.budgetContext(), v, { kind: 'work', id: 'a' }, many),
      )!.spent.uncoveredRuns,
      0,
    );
    // Попытка до учёта: более ранний посторонний вызов пробел не закрывает.
    f.store.transact('run.phase', (tx) => {
      const { callsRecorded: _, ...rest } = tx.attempt(run.id)!;
      void _;
      tx.putAttempt(rest);
    });
    assert.equal(
      f.engine.read((v) =>
        budgetStatus(f.engine.budgetContext(), v, { kind: 'work', id: 'a' }, [early]),
      )!.spent.uncoveredRuns,
      1,
    );
  } finally {
    f.close();
  }
});

test('T26: повторно выданный pid — не живой владелец; чужое идущее время без сравнимых часов неизвестно; прежние вызовы о группе остаются за её поручениями', async () => {
  const f = contour({ work: { usd: 5 }, group: { usd: 5 }, onUnknown: 'stop' });
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  await new Promise((done) => setTimeout(done, 200));
  try {
    const at = Date.now();
    const max = 2 * f.engine.policy.runTimeoutMs;
    const started = processStartedAt(owner.pid!)!;
    // Наш pid у чужой записи и чужой pid с другим моментом старта — не живые.
    assert.equal(
      liveCall({ ...base, process: { id: 'old', pid: process.pid, startedAt: started } }, at, max),
      false,
    );
    const reused = {
      ...base,
      process: { id: 'old', pid: owner.pid!, startedAt: started - 60_000 },
    };
    assert.equal(liveCall(reused, at, max), false);
    assert.equal(ownerGone(reused), true);
    // Живой pid без момента старта: владельца подтвердить нельзя — не живой.
    assert.equal(liveCall({ ...base, process: { id: 'old', pid: owner.pid! } }, at, max), false);
    assert.equal(ownerGone({ ...base, process: { id: 'old', pid: owner.pid! } }), false);
    const real = { ...base, process: { id: 'old', pid: owner.pid!, startedAt: started } };
    assert.equal(liveCall(real, at, max), true);
    assert.equal(ownerGone(real), false);
    // Без сравнимых монотонных часов время чужого идущего вызова неизвестно.
    assert.equal(
      callDurationMs(
        { ...base, elapsedMs: 300, startedAt: new Date(at + 60_000).toISOString() },
        at,
      ),
      null,
    );
    // Прежняя запись о группе без закреплённых поручений закрепляется до изменения состава.
    ready(f.engine, graphOf({ a: [] }));
    save(f.engine, {
      ...base,
      id: 'legacy-group',
      subjectId: 'g',
      outcome: 'returned',
      usage: usage(true, 6),
      costUsd: 6,
      costSource: 'provider-reported',
    });
    assert.equal(f.engine.pinLegacyCalls(), 1);
    f.move('a', 'moved');
    const own = status(f.engine, { kind: 'work', id: 'a' })!;
    assert.equal(own.spent.reportedUsd, 6);
    assert.equal(own.state, 'exceeded');
  } finally {
    owner.kill();
    f.close();
  }
});

test('T26: прежние вызовы поручения закрепляются до переноса, не затирая завершившийся тем временем; момент старта на секунду иной — другой процесс; чужое идущее время — по монотонным часам ОС', async () => {
  const f = contour({ group: { usd: 1 }, onUnknown: 'stop' });
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  await new Promise((done) => setTimeout(done, 200));
  try {
    ready(f.engine, graphOf({ a: [] }));
    const run = f.engine.claim('c1')!;
    const legacy: CallRecord = {
      ...base,
      id: 'legacy-work',
      runId: run.id,
      stage: 'implementation',
      finishedAt: new Date().toISOString(),
      outcome: 'returned',
      usage: usage(true, 1),
      costUsd: 1,
      costSource: 'provider-reported',
    };
    save(f.engine, legacy);
    save(f.engine, {
      ...legacy,
      id: 'racing',
      outcome: 'active',
      costUsd: null,
      costSource: 'unknown',
    });
    // Между чтением и транзакцией закрепления другой процесс завершил вызов.
    const transact = f.store.transact.bind(f.store);
    let raced = false;
    f.store.transact = (kind, fn) => {
      if (!raced && kind === 'usage.recorded') {
        raced = true;
        transact('usage.recorded', (tx) =>
          tx.putLocal('usage', 'app', 'racing', {
            ...legacy,
            id: 'racing',
            costUsd: 7,
            usage: usage(true, 7),
          }),
        );
      }
      return transact(kind, fn);
    };
    assert.equal(f.engine.pinLegacyCalls(), 2);
    f.store.transact = transact;
    const all = records(f.engine);
    const racing = all.find((r) => r.id === 'racing')!;
    assert.equal(racing.costUsd, 7);
    assert.equal(racing.outcome, 'returned');
    const pinned = all.find((r) => r.id === 'legacy-work')!;
    assert.equal(pinned.workId, 'a');
    assert.equal(pinned.groupId, 'g');
    // Перенос поручения не уводит его расход из группы g.
    f.move('a', 'moved');
    assert.equal(status(f.engine, { kind: 'group', id: 'g' })!.state, 'exceeded');
    assert.equal(status(f.engine, { kind: 'group', id: 'moved' })!.spent.reportedUsd, 0);
    // Момент старта, отличающийся на секунду, — другой процесс.
    const started = processStartedAt(owner.pid!)!;
    const active = {
      ...legacy,
      outcome: 'active' as const,
      costUsd: null,
      costSource: 'unknown' as const,
    };
    const shifted = {
      ...active,
      process: { id: 'old', pid: owner.pid!, startedAt: started - 1000 },
    };
    assert.equal(liveCall(shifted, Date.now(), 2 * f.engine.policy.runTimeoutMs), false);
    assert.equal(ownerGone(shifted), true);
    // Чужой идущий вызов: время по монотонным часам ОС, а не по системным.
    const { finishedAt: _, ...unfinished } = active;
    void _;
    const future: CallRecord = {
      ...unfinished,
      startedHr: (process.hrtime.bigint() - 300_000_000n).toString(),
      ...(BOOT_ID ? { bootId: BOOT_ID } : {}),
      startedAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const measured = callDurationMs(future);
    if (BOOT_ID) assert.ok(measured !== null && measured >= 300, String(measured));
    else assert.equal(measured, null);
    // Часы другой загрузки ОС несравнимы.
    assert.equal(callDurationMs({ ...future, bootId: 'other-boot' }), null);
  } finally {
    owner.kill();
    f.close();
  }
});

test('T26: вызов о группе с группой, но без поручений, дополняется до переноса; прерванный вызов сохраняет монотонное время', () => {
  const f = contour({ work: { usd: 5 }, onUnknown: 'stop' });
  try {
    ready(f.engine, graphOf({ a: [] }));
    const groupCall: CallRecord = {
      ...base,
      id: 'group-call',
      subjectId: 'g',
      groupId: 'g',
      stage: 'plan-review',
      finishedAt: new Date().toISOString(),
      outcome: 'returned',
      usage: usage(true, 6),
      costUsd: 6,
      costSource: 'provider-reported',
    };
    save(f.engine, groupCall);
    // Прерванный вызов: процесс умер, системные часы откатились.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    save(f.engine, {
      ...base,
      id: 'crashed',
      startedAt: new Date(Date.now() + 60_000).toISOString(),
      startedHr: (process.hrtime.bigint() - 353_000_000n).toString(),
      ...(BOOT_ID ? { bootId: BOOT_ID } : {}),
      process: { id: 'gone', pid: dead },
    });
    assert.deepEqual(f.engine.abandonCalls(), ['crashed']);
    const crashed = records(f.engine).find((r) => r.id === 'crashed')!;
    if (BOOT_ID) {
      assert.ok(crashed.durationMs! >= 350, String(crashed.durationMs));
      assert.equal(callDurationMs(crashed), crashed.durationMs);
    } else {
      assert.equal(crashed.durationMs, undefined);
      assert.equal(callDurationMs(crashed), null);
    }
    f.engine.pinLegacyCalls();
    assert.deepEqual(records(f.engine).find((r) => r.id === 'group-call')!.workIds, ['a']);
    f.move('a', 'moved');
    const own = status(f.engine, { kind: 'work', id: 'a' })!;
    assert.equal(own.spent.reportedUsd, 6);
    assert.equal(own.state, 'exceeded');
  } finally {
    f.close();
  }
});

test('T26: неизвестное время идущего вызова учитывает сохранённую нижнюю границу; прерванный без замера сохраняет неизвестное время', () => {
  const f = contour({ total: { timeMs: 10_000 }, onUnknown: 'continue' });
  try {
    save(f.engine, {
      ...base,
      id: 'foreign',
      // Метки системных часов противоречат замеру: часы откатились.
      startedAt: new Date(Date.now() - 50).toISOString(),
      elapsedMs: 15_002,
      process: { id: 'other', pid: spawnSync(process.execPath, ['-e', '']).pid },
    });
    // Время неизвестно, но сохранённый монотонный замер уже исчерпал предел:
    // `continue` не разрешает трату по нулю.
    const s = status(f.engine, { kind: 'total' })!;
    assert.equal(s.spent.unknownDurationCalls, 1);
    assert.ok(s.spent.durationMs >= 15_002, String(s.spent.durationMs));
    assert.equal(s.state, 'exceeded');
    // Процесс умер: время прерванного вызова остаётся неизвестным.
    assert.deepEqual(f.engine.abandonCalls(), ['foreign']);
    const closed = records(f.engine).find((r) => r.id === 'foreign')!;
    assert.equal(closed.durationUnknown, true);
    assert.equal(callDurationMs(closed), null);
    assert.equal(status(f.engine, { kind: 'total' })!.state, 'exceeded');
  } finally {
    f.close();
  }
});

test('B-F15: вызов, отказанный бюджетом до адаптера, не оставляет пробела истории; поднятый предел возобновляет работу', async () => {
  const f = contour({ total: { usd: 3 }, onUnknown: 'stop' });
  try {
    ready(f.engine, graphOf({ a: [] }));
    const run = f.engine.claim('c1')!;
    // Другой вызов исчерпывает общий бюджет после выдачи попытки.
    await spend(f.engine, undefined, 'ok', usage(), 'cheap', 'planning');
    // Реализация под замером отказана бюджетом до адаптера.
    let invoked = false;
    const timing = f.engine.timingStarted(run.id, run.token, 'implementation');
    await assert.rejects(
      measuredInvoke(
        f.engine,
        adapter(() => {
          invoked = true;
          return response(usage(), 'cheap');
        }),
        request(),
        new AbortController().signal,
        { repositoryId: 'app', runId: run.id, stage: 'implementation' },
      ),
      (e: unknown) => e instanceof TaskFailure && e.kind === 'budget',
    );
    f.engine.timingFinished(run.id, run.token, timing, 'failed');
    assert.equal(invoked, false);
    assert.ok(f.engine.read((v) => v.attempt(run.id)!.timings?.length));
    const raised = f.reopen({ total: { usd: 100 }, onUnknown: 'stop' });
    const s = status(raised, { kind: 'total' })!;
    assert.equal(s.spent.uncoveredRuns, 0);
    assert.equal(s.state, 'within');
  } finally {
    f.close();
  }
});

test('Тарифы закрепляются на старте вызова; правка цен во время вызова оценку не меняет', async () => {
  const f = contour(undefined, (p) => {
    p.prices = [{ ...price, runtime: 'codex', model: 'fixture-model' }];
  });
  try {
    const live = f.engine.policy.prices[0]!;
    await measuredInvoke(
      f.engine,
      adapter(() => {
        live.input = 50;
        return response(
          { ...usage(), outputTokens: 0, source: 'codex-turn-events' },
          'fixture-model',
        );
      }, 'codex'),
      { ...request(), binding: { runtime: 'codex', model: 'fixture-model' } },
      new AbortController().signal,
      { repositoryId: 'app', stage: 'implementation' },
    );
    const record = records(f.engine)[0]!;
    assert.equal(record.costUsd, 1);
    assert.equal(record.price!.input, 1);
    assert.equal(record.costSource, 'tariff-estimate');
  } finally {
    f.close();
  }
});

test('Ревью плана при исчерпанном бюджете — отказ BUDGET_EXHAUSTED до вызова reviewer', async () => {
  // Публичный путь Harness.review: тот же учёт, что и у вызовов попыток.
  const { hsetup } = await import('./harness-fixture.ts');
  const { approve, implement } = await import('./runner-fixture.ts');
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) =>
      ((p as { budgets: unknown }).budgets = { total: { timeMs: 1 }, onUnknown: 'stop' }),
  });
  const h = ctx.open();
  try {
    await h.review({ kind: 'plan', graph: ctx.graph, author: 'claude' });
    const graph2 = { ...ctx.graph, source: { ...ctx.graph.source, revision: '2' } };
    await assert.rejects(
      h.review({ kind: 'plan', graph: graph2, author: 'claude' }),
      (e: unknown) => e instanceof HarnessError && e.code === 'BUDGET_EXHAUSTED',
    );
    assert.equal(ctx.calls('codex', 'reviewer'), 1, 'второй вызов reviewer не начинался');
    const status = h.status();
    assert.equal(status.budgets?.budgets[0]?.state, 'exceeded');
  } finally {
    h.close();
  }
});

test('T25: расход writer исчерпывает бюджет поручения — ревью кода не начинается, попытка отказана классом budget, выдача удержана с причиной', async () => {
  const { hsetup } = await import('./harness-fixture.ts');
  const { approve, implement, target } = await import('./runner-fixture.ts');
  const ctx = hsetup({
    scenario: { writer: { ...implement(), costUsd: 5 }, reviewer: approve() },
    policy: (p) =>
      ((p as { budgets: unknown }).budgets = { work: { usd: 3 }, onUnknown: 'continue' }),
  });
  const h = ctx.open();
  try {
    const before = target(ctx);
    const data = await h.run({ graph: ctx.graph, author: 'claude' });
    const a = h.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(a.status, 'failed');
    assert.equal(a.failureKind, 'budget', a.error);
    assert.match(a.error!, /Бюджет work add-greeting исчерпан: предел \$3/);
    assert.equal(ctx.calls('claude', 'writer'), 1);
    assert.equal(ctx.calls('codex', 'reviewer'), 1, 'только ревью плана; ревью кода не начиналось');
    assert.equal(target(ctx), before);
    assert.equal(
      h.engine.read((v) => v.attempts().length),
      1,
      'повтора нет: бюджет — остановка',
    );
    // Причина видна в статусе; расход — из сохранённых записей вызовов.
    h.engine.retry('add-greeting', { reason: 'ещё раз' });
    await h.run({ graph: ctx.graph, author: 'claude' });
    assert.equal(ctx.calls('claude', 'writer'), 1, 'сброс попыток не сбрасывает расход');
    const status = h.status();
    assert.ok(
      status.works[0]!.blockers.some((b) => b.code === 'BUDGET_EXHAUSTED'),
      JSON.stringify(status.works[0]!.blockers),
    );
    const own = status.budgets!.budgets.find((b) => b.scope.kind === 'work')!;
    assert.equal(own.state, 'exceeded');
    assert.equal(own.reportedUsd, 5);
    void data;
  } finally {
    h.close();
  }
});
