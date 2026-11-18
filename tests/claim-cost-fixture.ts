/**
 * Длинная история для замера цены выдачи: доска с готовыми, но удержанными
 * поручениями (выдавать нечего) и `history` прежних попыток с записью вызова
 * у каждой. Представление считает, сколько попыток и записей вызовов оно
 * отдало движку: цена `claim` — в единицах работы хранилища, без часов.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_OWNER,
  callRecordSchema,
  type AttemptState,
  type CallRecord,
  type ExecutionStore,
  type ExecutionView,
} from '../src/contracts/index.ts';
import { digestOf } from '../src/contracts/digest.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { graphOf, policyOf, ready, sha } from './engine-fixture.ts';

export interface Counters {
  /** Попытки, отданные `attempts()`/`activeAttempts()`/`attempt()`. */
  attempts: number;
  /** Записи вызовов, отданные `locals('usage')`/`local('usage')`. */
  usage: number;
}

/** Представление, считающее отданные попытки и записи вызовов. */
function counted<V extends ExecutionView>(view: V, n: Counters): V {
  return new Proxy(view, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        const out = fn.apply(target, args);
        if (key === 'attempts' || key === 'activeAttempts') n.attempts += (out as unknown[]).length;
        else if (key === 'attempt' && out) n.attempts++;
        else if (key === 'locals' && args[0] === 'usage') n.usage += (out as unknown[]).length;
        else if (key === 'local' && args[0] === 'usage' && out) n.usage++;
        return out;
      };
    },
  });
}

/** Завершённый вызов реализации стоимостью $0.01 (сообщено провайдером). */
export function callOf(i: number | string, patch: Record<string, unknown> = {}): CallRecord {
  return callRecordSchema.parse({
    id: `call-${i}`,
    stage: 'implementation',
    runtime: 'codex',
    model: null,
    runtimeVersion: null,
    startedAt: '2025-12-31T00:00:00.000Z',
    finishedAt: '2025-12-31T00:01:00.000Z',
    outcome: 'returned',
    promptBytes: 0,
    promptDigest: digestOf('p' + i),
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedUsd: 0.01,
      complete: true,
      source: 'fixture',
    },
    costUsd: 0.01,
    costSource: 'provider-reported',
    ...patch,
  });
}

export function historyBoard(
  history: number,
  opts: {
    works?: number;
    legacy?: boolean;
    uncovered?: number;
    budgets?: Record<string, unknown> | null;
  } = {},
) {
  const works = opts.works ?? 8;
  const policy = policyOf((p) => {
    p.concurrency = 2;
    if (opts.budgets === null) return;
    p.budgets = opts.budgets ?? {
      work: { usd: 1000 },
      group: { usd: 1000 },
      total: { usd: 100_000, timeMs: 1e12 },
      onUnknown: 'stop',
    };
  });
  const dir = mkdtempSync(join(tmpdir(), 'harness-claim-cost-'));
  const sqlite = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  const n: Counters = { attempts: 0, usage: 0 };
  const store: ExecutionStore = {
    stateVersion: sqlite.stateVersion,
    read: (fn) => sqlite.read((v) => fn(counted(v, n))),
    transact: (kind, fn) => sqlite.transact(kind, (tx) => fn(counted(tx, n))),
    events: (...a) => sqlite.events(...a),
    close: () => sqlite.close(),
  };
  let seq = 0;
  const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') };
  const engine = new Engine({
    host: standaloneHost(store, policy),
    policy,
    now: () => clock.now,
    id: () => `id-${String(++seq).padStart(6, '0')}`,
  });
  const deps: Record<string, string[]> = {};
  for (let i = 0; i < works; i++) deps['w' + i] = [];
  ready(engine, graphOf(deps));
  // Один настоящий провал — образец прежней попытки.
  const first = engine.claim('c1')!;
  engine.fail(first.id, first.token, 'timeout', { kind: 'timeout' });
  engine.retry(first.workId);
  const sample = engine.read((v) => v.attempt(first.id)!);
  const ids = Object.keys(deps);
  sqlite.transact('task.retry', (tx) => {
    for (let i = 0; i < history; i++) {
      const workId = ids[i % ids.length]!;
      const attempt: AttemptState = {
        ...structuredClone(sample),
        id: `old-${i}`,
        workId,
        token: `token-old-${String(i).padStart(8, '0')}`,
      };
      tx.putAttempt(attempt);
      // Попытки до учёта вызовов: без отметки, с кандидатом и без записи.
      if (i < (opts.uncovered ?? 0)) {
        const legacy: Partial<AttemptState> = { ...attempt, candidateSha: sha('c') };
        delete legacy.callsRecorded;
        tx.putAttempt(legacy as AttemptState);
        continue;
      }
      const record = callOf(i, {
        runId: attempt.id,
        // Прежняя запись: поручение — только по попытке.
        ...(opts.legacy ? {} : { workId, groupId: 'g' }),
      });
      tx.putLocal('usage', WORKSPACE_OWNER, record.id, record);
    }
  });
  // Выдавать нечего: все поручения готовы, но удержаны операцией.
  engine.hold(ids, 'bench', 'замер выдачи');
  const reset = () => {
    n.attempts = 0;
    n.usage = 0;
  };
  return { engine, store: sqlite, counters: n, reset, ids, clock };
}
