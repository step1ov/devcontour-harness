/**
 * Удержание gate после отказа `sandbox-process-list` на вызове `ps` из базы
 * (0.1.0-alpha.66): работы репозитория с этим gate не выдаются
 * (`ENVIRONMENT_GATE_HELD`, ход ведущего) — без решения человека и без общей
 * паузы. Снимается сменой определения gate или повтором ведущего.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, gateDigest } from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import {
  environmentGateHolds,
  gateDefinitionHolds,
  isGateDefinitionHold,
} from '../src/projections/gate-hold.ts';
import { resourcesOf } from '../src/projections/view-resources.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';

/** Попытка `ps`-gate: evidence gate `unit` с кодом и отказ без повтора. */
function failOnPs(e: Engine) {
  const a = e.claim('c1');
  assert.ok(a, 'попытка выдана');
  e.phase(a.id, a.token, 'verifying', { candidateSha: sha('c') });
  e.evidence(a.id, a.token, {
    kind: 'test',
    phase: 'candidate',
    sha: sha('c'),
    gate: 'unit',
    passed: false,
    command: ['npm', 'test'],
    exitCode: 1,
    log: '',
    digest: digestOf('ps'),
    summary: 'GATE_SANDBOX_PROCESS_LIST: gate запускает ps (список процессов)',
  });
  e.fail(a.id, a.token, 'candidate/unit: GATE_SANDBOX_PROCESS_LIST', {
    kind: 'environment',
    cause: 'sandbox-process-list',
  });
  return a;
}

function setup() {
  const policy = policyOf((p) => {
    p.concurrency = 1;
  });
  const env = engineOf(policy);
  ready(env.engine, graphOf({ a: [], b: [] }));
  return { ...env, policy };
}

const explainOf = (env: ReturnType<typeof setup>, workId: string) => {
  const d = stopInputsOf(
    {
      engine: env.engine,
      policy: env.policy,
      workflows: { list: () => [], continues: () => false },
    },
    { maxAttempts: env.policy.maxAttempts, repairBudget: env.policy.repairBudget, workId },
  )
    .filter((i) => i.kind === 'work')
    .map(explainStop)[0]!;
  return { code: d.code, actor: d.actor, action: d.action, message: d.message };
};

test('hold: отказ ps из базы держит gate — другие работы с ним не выдаются, explain — ведущий, fix-environment', () => {
  const env = setup();
  const e = env.engine;
  const a = failOnPs(e);
  const w = e.read((v) => v.work(a.workId)!);
  assert.deepEqual(
    {
      gate: w.environmentHold?.gate,
      runId: w.environmentHold?.runId,
      repo: w.environmentHold?.repositoryId,
    },
    { gate: 'unit', runId: a.id, repo: 'app' },
  );
  assert.equal(e.read((v) => v.control()).paused, false, 'без общей паузы');
  const other = a.workId === 'a' ? 'b' : 'a';
  assert.equal(e.claim('c1'), undefined, 'вторая работа с тем же gate не выдана');
  const blockers = e.read((v) => e.blockers(v.work(other)!, v));
  assert.ok(
    blockers.some((b) => b.code === 'ENVIRONMENT_GATE_HELD'),
    JSON.stringify(blockers),
  );
  const x = explainOf(env, other);
  assert.deepEqual(
    { code: x.code, actor: x.actor, action: x.action },
    { code: 'ENVIRONMENT_GATE_HELD', actor: 'lead', action: 'fix-environment' },
  );
  assert.match(x.message, /gate unit удержан/);
  // Повтор оператора удержание не снимает: тот же gate откажет снова.
  e.retry(a.workId, undefined, 'operator');
  assert.equal(e.claim('c1'), undefined);
  // Ведущий исправил тест и повторил остановленную работу — выдача идёт.
  const r = e.retry(a.workId, undefined, 'lead');
  assert.equal(r.work.environmentHold, undefined);
  const next = e.claim('c1');
  assert.ok(next, 'после повтора ведущего попытка выдана');
});

test('hold: снимается сменой определения gate; принятая или отменённая работа не держит', () => {
  const policy = policyOf();
  const gate = policy.repositories[0]!.gates[0]!;
  const hold = {
    repositoryId: 'app',
    gate: 'unit',
    digest: gateDigest(gate),
    runId: 'r1',
    at: '2026-01-01T00:00:00.000Z',
  };
  const current = (digest: string) => () => digest;
  const work = { id: 'a', status: 'failed' as const, environmentHold: hold };
  assert.equal(environmentGateHolds([work], current(gateDigest(gate))).length, 1);
  const changed = gateDigest({ ...gate, command: [...gate.command, '--no-ps'] });
  assert.equal(environmentGateHolds([work], current(changed)).length, 0, 'другое определение gate');
  assert.equal(environmentGateHolds([work], () => undefined).length, 0, 'gate убран');
  for (const status of ['done', 'cancelled'] as const)
    assert.equal(
      environmentGateHolds([{ ...work, status }], current(hold.digest)).length,
      0,
      status,
    );
});

test('hold: представление «Что задействовано» — удержанный gate и строка первой в сводке', () => {
  const view = resourcesOf(
    {
      mode: 'live',
      sandbox: 'os',
      domains: 0,
      roles: [],
      toolchain: { tools: [], packageManagers: [] },
      dependencyStores: [],
      lifecycles: [],
      environments: [],
      gates: [{ repositoryId: 'app', count: 1 }],
      workspaceGates: 0,
      heldGates: [{ repositoryId: 'app', gate: 'unit', workId: 'a' }],
    },
    { lang: 'ru', mask: (s) => s, now: Date.parse('2026-01-01T00:00:00.000Z') },
  );
  assert.deepEqual(view.gates.held, [{ repositoryId: 'app', gate: 'unit', workId: 'a' }]);
  assert.match(view.gates.heldLine!, /^Удержано: app\/unit \(работа a\)/);
  assert.equal(view.lines[0], view.gates.heldLine);
});

/** Попытка, где gate `unit` упал, не назвав причины (`gate-definition`, 0.1.0-alpha.69). */
function failWithoutCause(e: Engine) {
  const a = e.claim('c1');
  assert.ok(a, 'попытка выдана');
  e.phase(a.id, a.token, 'verifying', { candidateSha: sha('c') });
  e.evidence(a.id, a.token, {
    kind: 'test',
    phase: 'candidate',
    sha: sha('c'),
    gate: 'unit',
    passed: false,
    command: ['npm', 'test'],
    exitCode: 1,
    log: '',
    digest: digestOf('withheld'),
    summary: 'GATE_DEFINITION_NO_CAUSE: gate не назвал причину провала',
    failureSummary: { withheld: true },
  });
  e.fail(a.id, a.token, 'candidate/unit: GATE_DEFINITION_NO_CAUSE', {
    kind: 'environment',
    cause: 'gate-definition',
  });
  return a;
}

test('hold gate-definition: gate без причины провала — попытка не засчитана, gate удержан для ведущего', () => {
  const env = setup();
  const e = env.engine;
  const a = failWithoutCause(e);
  const w = e.read((v) => v.work(a.workId)!);
  assert.equal(w.attempt, 0, 'попытка исполнителю не засчитана');
  assert.equal(w.neutralFailures, 1, 'тратит предел незасчитанных отказов');
  assert.equal(w.environmentHold?.cause, 'gate-definition');
  assert.equal(w.environmentHold?.isolation, undefined, 'удержание не зависит от песочницы');
  const attempt = e.read((v) => v.attempts(a.workId)[0]!);
  assert.equal(attempt.environmentCause, 'gate-definition');
  // Своя работа: ход ведущего — поменять команду gate.
  const own = explainOf(env, a.workId);
  assert.deepEqual(
    { actor: own.actor, action: own.action },
    { actor: 'lead', action: 'fix-environment' },
  );
  assert.match(own.message, /не назвав причины/);
  // Другая работа с тем же gate ждёт ведущего.
  const other = a.workId === 'a' ? 'b' : 'a';
  assert.equal(e.claim('c1'), undefined, 'вторая работа с тем же gate не выдана');
  const x = explainOf(env, other);
  assert.deepEqual(
    { code: x.code, actor: x.actor, action: x.action },
    { code: 'ENVIRONMENT_GATE_HELD', actor: 'lead', action: 'fix-environment' },
  );
  assert.match(x.message, /gate unit удержан: упал, не назвав причины/);
  assert.match(x.message, /harness retry --work \S+ --by lead/);
  // Представление отличает удержание определением gate.
  const holds = e.read((v) => e.environmentGateHolds(v));
  assert.deepEqual(
    gateDefinitionHolds(holds).map((h) => [h.gate, h.workId, isGateDefinitionHold(h)]),
    [['unit', a.workId, true]],
  );
  // Повтор ведущего снимает удержание — как у отказов окружения.
  const r = e.retry(a.workId, undefined, 'lead');
  assert.equal(r.work.environmentHold, undefined);
  assert.ok(e.claim('c1'), 'после повтора ведущего попытка выдана');
});

test('hold gate-definition: снимает новое определение gate, а не смена изоляции', () => {
  const policy = policyOf();
  const gate = policy.repositories[0]!.gates[0]!;
  const hold = {
    repositoryId: 'app',
    gate: 'unit',
    digest: gateDigest(gate),
    runId: 'r1',
    at: '2026-01-01T00:00:00.000Z',
    cause: 'gate-definition' as const,
  };
  const work = { id: 'a', status: 'failed' as const, environmentHold: hold };
  const same = () => hold.digest;
  assert.equal(environmentGateHolds([work], same, { isolation: 'none' }).length, 1);
  assert.equal(environmentGateHolds([work], same, { isolation: 'os' }).length, 1);
  const changed = gateDigest({ ...gate, command: [...gate.command, '--reporter=spec'] });
  assert.equal(environmentGateHolds([work], () => changed).length, 0, 'новое определение gate');
});
