/**
 * 0.1.0-alpha.73: представление, status и explain над состоянием тонкого
 * режима. Режим называется `thin` (ревизия 11), у попыток — режим сессии
 * writer; остановки тонкого режима explain объясняет своими словами.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPERATOR_VIEW_REVISION,
  operatorViewSchema,
  statusDataSchema,
  workDetailViewSchema,
} from '../src/contracts/index.ts';
import { harnessView } from '../src/control/operator-view.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, implement } from './runner-fixture.ts';

const wrong = "exports.greet = (name) => 'Hi ' + name;\n";

function thinState(writer: unknown[], patch?: (p: Record<string, unknown>) => void) {
  const ctx = hsetup({
    scenario: { writer, reviewer: approve() },
    policy: (p) => {
      p.harnessMode = 'thin';
      p.maxAttempts = 3;
      patch?.(p);
    },
  });
  const policyPath = join(ctx.state, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(ctx.policy));
  return { ...ctx, policyPath, work: ctx.graph.orders[0]!.id };
}

test('view и status: режим thin, режимы сессии writer у попыток', async () => {
  const ctx = thinState([implement({ 'src/greet.js': wrong }), implement()]);
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  const status = statusDataSchema.parse(h.status(undefined, { detail: true }));
  assert.ok(JSON.stringify(status).includes(ctx.work));
  h.close();
  const view = operatorViewSchema.parse(
    harnessView({ stateDir: ctx.state, policyPath: ctx.policyPath }),
  );
  assert.equal(view.viewRevision, OPERATOR_VIEW_REVISION);
  assert.equal(OPERATOR_VIEW_REVISION, 11);
  assert.equal(view.settings.harnessMode?.mode, 'thin');
  const detail = workDetailViewSchema.parse(
    harnessView({ stateDir: ctx.state, policyPath: ctx.policyPath, workId: ctx.work }),
  );
  assert.deepEqual(
    detail.attempts.map((a) => a.writerSession),
    ['resumed', 'fresh'],
  );
});

test('explain: сбой среды проверки сдачи — ход ведущего своими словами, без повтора', async () => {
  // Gate виснет без упавшего теста — дважды (таймаут среды).
  const ctx = thinState([implement()], (p) => {
    const repos = p.repositories as { gates: { command: string[]; timeoutMs?: number }[] }[];
    repos[0]!.gates[0]!.command = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
    repos[0]!.gates[0]!.timeoutMs = 1500;
  });
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  const [a] = h.engine.read((v) => v.attempts(ctx.work));
  assert.equal(a!.leadCause, 'gate-environment', a!.error);
  const d = stopInputsOf(h, { maxAttempts: 3, repairBudget: 6, workId: ctx.work })
    .map(explainStop)
    .find((x) => x.workId === ctx.work)!;
  assert.equal(d.actor, 'lead');
  assert.equal(d.retryPlanned, false);
  assert.match(JSON.stringify(d), /дважды упала средой/);
  assert.match(JSON.stringify(d), /cause-gate-environment/);
  h.close();
});
