import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_VERSION,
  executionPolicySchema,
  workGraphSchema,
  type ExecutionPolicy,
  type ReviewRecord,
  type WorkGraph,
} from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { clone, example } from './fixtures.ts';

export const sha = (c: string) => c.repeat(40);

/** Граф из поручений с зависимостями: `orders({a: [], b: ['a']})`. */
export function graphOf(deps: Record<string, string[]>, revision = '1', id = 'g'): WorkGraph {
  const base = example('graph') as { orders: Record<string, unknown>[] };
  return workGraphSchema.parse({
    ...base,
    id,
    source: { connector: 'files', ref: id, revision },
    orders: Object.entries(deps).map(([oid, dependsOn]) => ({
      ...base.orders[0],
      id: oid,
      source: { connector: 'files', ref: oid, revision },
      dependsOn,
    })),
  });
}

export function policyOf(patch: (p: Record<string, unknown>) => void = () => {}): ExecutionPolicy {
  const p = clone(example('policy'));
  patch(p);
  return executionPolicySchema.parse(p);
}

export interface Clock {
  now: number;
}

/** Движок над временным файлом SQLite с управляемыми часами. */
export function engineOf(
  policy = policyOf(),
  dir = mkdtempSync(join(tmpdir(), 'harness-engine-')),
) {
  const clock: Clock = { now: Date.parse('2026-01-01T00:00:00.000Z') };
  const store = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  let n = 0;
  const engine = new Engine({
    host: standaloneHost(store, policy),
    policy,
    now: () => clock.now,
    id: () => `id-${String(++n).padStart(6, '0')}-${dir.slice(-6)}`,
  });
  return { engine, store, clock, dir };
}

export const review = (
  graph: { id: string; digest: string },
  round: number,
  approved = true,
): ReviewRecord => ({
  id: `RV-${graph.id}-${round}`,
  kind: 'plan',
  subject: graph.id,
  digest: graph.digest,
  round,
  at: '2026-01-01T00:00:00.000Z',
  approved,
  summary: approved ? 'план годен' : 'план отклонён',
  authorRuntime: 'claude',
  reviewerRuntime: 'codex',
  sameVendor: false,
  findings: [],
  artifact: 'reviews/' + round + '.json',
});

/** Раунд ревью плана при текущем назначении reviewer движка (автор claude). */
export const planReview = (
  e: Engine | { engine: Engine },
  graph: { id: string; digest: string },
  round: number,
  approved = true,
): ReviewRecord => {
  const engine = e instanceof Engine ? e : e.engine;
  const binding = engine.reviewerBinding('plan', 'claude');
  return { ...review(graph, round, approved), ...(binding ? { reviewerBinding: binding } : {}) };
};

export const trustNone = { trusted: () => false, reachable: () => true };

/** Зарегистрировать, провести ревью, согласовать и запустить очередь. */
export function ready(e: Engine, graph: WorkGraph, owner = 'c1') {
  const { graph: state } = e.register(graph, trustNone);
  e.recordReview(planReview(e, state, e.reviews('plan', state.id).length + 1));
  e.approve(state.id, 'agent');
  e.lead(owner);
  e.resume();
  return state;
}

export const apiVersion = API_VERSION;
