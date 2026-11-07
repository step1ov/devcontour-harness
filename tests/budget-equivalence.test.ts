/**
 * Бюджеты для многих работ одного чтения (`workBudgetsOf`,
 * `Engine.budgetBlocksOf`, `budgetBlockers`, `budgetBlockOf`) против
 * замороженных бюджетов 7d33826 (`budget-oracle.ts`) на сгенерированных
 * досках с записями вызовов: превышенные и неопределённые пределы
 * (деньги и время), записи без работы, о группе и о наборе работ, идущие
 * вызовы, попытки без учёта вызовов, свои группы хоста (с прежними членами),
 * onUnknown stop/continue/не задан. Время зафиксировано: ответ на один момент.
 * Там же — `stopInputsOf` против замороженного диагноза. Модели не вызываются.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WORKSPACE_OWNER,
  callRecordSchema,
  type CallRecord,
  type ExecutionPolicy,
  type ExecutionView,
} from '../src/contracts/index.ts';
import { digestOf } from '../src/contracts/digest.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { workBudgetsOf } from '../src/engine/budget.ts';
import { callRecords } from '../src/engine/usage.ts';
import { stopInputsOf, type StopSource } from '../src/explain/state.ts';
import type { StopInput } from '../src/projections/stop.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import * as oracle from './budget-oracle.ts';
import { graphOf, planReview, policyOf, sha } from './engine-fixture.ts';
import { mulberry32 } from './stop-inputs-fixture.ts';
import { referenceStopInputsOf } from './stop-inputs-oracle.ts';

const FIXED = Date.parse('2026-06-01T00:00:00.000Z');
const frozen = <T>(fn: () => T): T => {
  const realNow = Date.now;
  Date.now = () => FIXED;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
};

const limitOf = (rnd: () => number) => {
  const r = rnd();
  if (r < 0.25) return undefined;
  if (r < 0.5) return { usd: (1 + Math.round(rnd() * 600)) / 100 };
  if (r < 0.75) return { timeMs: 1 + Math.round(rnd() * 120_000) };
  return { usd: (1 + Math.round(rnd() * 600)) / 100, timeMs: 1 + Math.round(rnd() * 120_000) };
};

function boardWithRecords(seed: number) {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const budgets: Record<string, unknown> = {};
  for (const k of ['work', 'group', 'total']) {
    const limit = limitOf(rnd);
    if (limit) budgets[k] = limit;
  }
  const onUnknown = pick(['stop', 'continue', undefined] as const);
  if (onUnknown) budgets.onUnknown = onUnknown;
  const policy: ExecutionPolicy = structuredClone(
    policyOf((p) => {
      p.maxAttempts = 3;
      p.repairBudget = 3;
      p.budgets = budgets;
    }),
  );
  // onUnknown не задан: в обход умолчания схемы.
  if (!onUnknown && policy.budgets) delete (policy.budgets as { onUnknown?: string }).onUnknown;
  const dir = mkdtempSync(join(tmpdir(), 'harness-budget-eq-'));
  const store = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  const base = standaloneHost(store, policy);
  // Свои группы хоста: часть работ без группы, две именованные и граф;
  // в членах — и прежние члены (не обратное groupOf).
  const groupOf = new Map<string, string | undefined>();
  const formerMembers = new Map<string, string[]>();
  const host = {
    ...base,
    budgets: {
      ...base.budgets,
      groupOf: (id: string, view: ExecutionView) => (view.work(id) ? groupOf.get(id) : undefined),
      members: (group: string, view: ExecutionView) => [
        ...view
          .works()
          .filter((w) => groupOf.get(w.id) === group)
          .map((w) => w.id),
        ...(formerMembers.get(group) ?? []),
      ],
    },
  };
  let n = 0;
  const engine = new Engine({
    host,
    policy,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    id: () => `id-${String(++n).padStart(6, '0')}`,
  });
  const size = 6 + Math.floor(rnd() * 14);
  const deps: Record<string, string[]> = {};
  for (let i = 0; i < size; i++)
    deps['w' + i] = i && rnd() < 0.3 ? ['w' + Math.floor(rnd() * i)] : [];
  const { graph } = engine.register(graphOf(deps), {
    trusted: () => true,
    reachable: () => true,
  });
  engine.recordReview(planReview(engine, graph, 1));
  engine.approve(graph.id, 'agent');
  const ids = Object.keys(deps);
  const groups = ['G1', 'G2', graph.id];
  for (const id of ids) groupOf.set(id, rnd() < 0.25 ? undefined : pick(groups));
  if (rnd() < 0.5) formerMembers.set('G1', [pick(ids)]);
  engine.lead('c1');
  engine.resume();
  for (let k = 0; k < size; k++) {
    const a = engine.claim('c1');
    if (!a) break;
    engine.fail(a.id, a.token, 'timeout', { kind: 'timeout' });
    if (rnd() < 0.5) {
      try {
        engine.retry(a.workId);
      } catch {
        // Повтор не разрешён — работа остаётся упавшей.
      }
    }
  }
  engine.release('c1');
  // Попытки до учёта вызовов: с кандидатом или только с замером реализации.
  store.transact('task.retry', (tx) => {
    for (const a of tx.attempts())
      if (a.status !== 'active' && rnd() < 0.3) {
        const legacy: Partial<typeof a> = { ...a };
        delete legacy.callsRecorded;
        if (rnd() < 0.5) legacy.candidateSha = sha('c');
        else
          legacy.timings = [
            { id: 't1', stage: 'implementation-run', startedAt: '2026-01-01T00:00:00.000Z' },
          ] as typeof a.timings;
        tx.putAttempt(legacy as typeof a);
      }
  });
  const attempts = engine.read((v) => v.attempts());
  // Записи вызовов всех форм.
  const records: CallRecord[] = [];
  const count = Math.floor(rnd() * 30);
  for (let i = 0; i < count; i++) {
    const outcome = pick(['active', 'returned', 'error', 'abandoned'] as const);
    const cost = rnd() < 0.3 ? null : Math.round(rnd() * 300) / 100;
    const startedAt = new Date(FIXED - Math.floor(rnd() * 200_000)).toISOString();
    const r: Record<string, unknown> = {
      id: `call-${seed}-${i}`,
      stage: pick(['implementation', 'review', 'plan-review', 'implementation']),
      runtime: 'codex',
      model: null,
      runtimeVersion: null,
      startedAt,
      outcome,
      promptBytes: 0,
      promptDigest: digestOf('p' + i),
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedUsd: null,
        complete: rnd() < 0.7,
        source: 'fixture',
      },
      costUsd: cost,
      costSource: cost === null ? 'unknown' : pick(['provider-reported', 'tariff-estimate']),
    };
    if (outcome !== 'active' && rnd() < 0.6)
      r[outcome === 'abandoned' ? 'abandonedAt' : 'finishedAt'] = new Date(
        Date.parse(startedAt) + Math.floor(rnd() * 60_000),
      ).toISOString();
    if (rnd() < 0.3) r.durationMs = Math.floor(rnd() * 60_000);
    else if (rnd() < 0.1) r.durationUnknown = true;
    if (rnd() < 0.2) r.elapsedMs = Math.floor(rnd() * 30_000);
    if (outcome === 'active' && rnd() < 0.5) r.process = { id: 'p-x', pid: 999_999, startedAt: 1 };
    if (attempts.length && rnd() < 0.4) r.runId = pick(attempts).id;
    if (rnd() < 0.4) r.workId = pick(ids);
    if (rnd() < 0.3) r.groupId = pick(groups);
    if (rnd() < 0.15) r.workIds = ids.filter(() => rnd() < 0.4);
    if (rnd() < 0.4) r.subjectId = pick([...ids, ...groups, 'contract-x']);
    if (rnd() < 0.4) r.subjectKind = pick(['work', 'group', 'other']);
    records.push(callRecordSchema.parse(r));
  }
  store.transact('task.retry', (tx) => {
    for (const r of records) tx.putLocal('usage', WORKSPACE_OWNER, r.id, r);
  });
  return { engine, policy, ids, graph };
}

/** Без поля `preflight`, которого прежний диагноз не знал. */
const withoutPreflight = (inputs: StopInput[]) =>
  inputs.map((i) => {
    if (i.kind !== 'work' || !i.work.preflight) return i;
    const work = { ...i.work };
    delete work.preflight;
    return { ...i, work };
  });

test('бюджеты многих работ = замороженные бюджеты 7d33826 по каждой работе (с записями вызовов)', () => {
  let compared = 0;
  let blocked = 0;
  const kinds = new Set<string>();
  const states = new Set<string>();
  for (let seed = 1; seed <= 60; seed++) {
    const b = boardWithRecords(seed);
    frozen(() =>
      b.engine.read((v) => {
        const c = b.engine.budgetContext();
        const records = callRecords(v);
        const probe = [...b.ids, 'nope'];
        const all = b.engine.budgetBlocksOf(undefined, v);
        assert.deepEqual([...all.keys()], b.ids, `seed ${seed}: все работы`);
        const set = b.engine.budgetBlocksOf(probe, v);
        const blockers = b.engine.budgetBlockers(v);
        const forward = workBudgetsOf(c, v, records, FIXED);
        // Обратный порядок вопросов: кэш общего не зависит от порядка работ.
        const backward = workBudgetsOf(c, v, records, FIXED);
        const reversed = new Map([...probe].reverse().map((id) => [id, backward(id)] as const));
        for (const id of probe) {
          const expected = oracle.workBudgets(c, v, id, callRecords(v), FIXED);
          assert.deepEqual(forward(id), expected, `seed ${seed}: ${id} статусы`);
          assert.deepEqual(
            reversed.get(id),
            expected,
            `seed ${seed}: ${id} статусы, обратный порядок`,
          );
          const reason = b.policy.budgets ? oracle.blockingBudget(c, expected)?.reason : undefined;
          assert.equal(set.get(id), reason, `seed ${seed}: ${id} budgetBlocksOf`);
          assert.equal(blockers(id), reason, `seed ${seed}: ${id} budgetBlockers`);
          assert.equal(b.engine.budgetBlockOf(id, v), reason, `seed ${seed}: ${id} budgetBlockOf`);
          if (id !== 'nope') assert.equal(all.get(id), reason);
          for (const s of expected) states.add(`${s.scope.kind}:${s.state}`);
          if (reason) blocked++;
          compared++;
        }
        for (const r of records) {
          if (!r.workId && !r.workIds && !r.runId) kinds.add('no-work');
          if (r.workIds) kinds.add('workIds');
          if (r.outcome === 'active') kinds.add('active');
        }
      }),
    );
    // Диагноз той же доски — как замороженный.
    const source: StopSource = {
      engine: b.engine,
      policy: b.policy,
      workflows: {
        list: () =>
          [{ kind: 'graph', id: b.graph.id, repairs: 0 }] as unknown as ReturnType<
            StopSource['workflows']['list']
          >,
        continues: () => true,
      },
    };
    const opts = { maxAttempts: 3, repairBudget: 3 };
    frozen(() =>
      assert.deepEqual(
        withoutPreflight(stopInputsOf(source, opts)),
        referenceStopInputsOf(source, opts),
        `seed ${seed}: доска`,
      ),
    );
  }
  assert.ok(compared > 500, `сравнено ${compared}`);
  assert.ok(blocked > 50, `блоков ${blocked}`);
  assert.deepEqual([...kinds].sort(), ['active', 'no-work', 'workIds']);
  for (const s of ['work:exceeded', 'work:undetermined', 'group:exceeded', 'total:exceeded'])
    assert.ok(states.has(s), `нет состояния ${s}: ${[...states].join(', ')}`);
});
