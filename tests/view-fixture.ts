/**
 * Каталог состояния для представления оператора: записи фикстуры отчёта
 * (`reportFixture`) и политика примера single-task во временном каталоге.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_OWNER, type RunEventDraft } from '../src/contracts/index.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { example } from './fixtures.ts';
import { reportFixture } from './report-fixture.ts';

export function viewState(
  edit: (policy: Record<string, unknown>) => void = () => {},
  mutate: (input: ReturnType<typeof reportFixture>) => void = () => {},
) {
  const parent = mkdtempSync(join(tmpdir(), 'harness-view-'));
  const state = join(parent, 'state');
  mkdirSync(state);
  const policy = example('policy');
  edit(policy);
  const policyPath = join(parent, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(policy, null, 2));
  const input = reportFixture();
  mutate(input);
  const store = new SqliteExecutionStore(join(state, 'state.sqlite'), 'test');
  try {
    store.transact('graph.registered', (tx) => {
      for (const g of input.graphs ?? []) tx.putGraph(g);
      for (const w of input.works) tx.putWork(w);
      for (const a of input.attempts) tx.putAttempt(a);
      for (const c of input.calls ?? [])
        tx.putLocal('usage', c.repositoryId ?? WORKSPACE_OWNER, c.id, c);
      for (const r of input.reviews ?? []) tx.putLocal('reviews', WORKSPACE_OWNER, r.id, r);
      for (const e of input.events ?? [])
        if (e.type !== 'unknown') {
          const draft: Record<string, unknown> = { ...e };
          for (const key of ['apiVersion', 'seq', 'at']) delete draft[key];
          tx.emit(draft as RunEventDraft);
        }
    });
  } finally {
    store.close();
  }
  return { parent, state, policyPath, input };
}
