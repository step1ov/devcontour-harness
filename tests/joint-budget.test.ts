import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { HarnessError, sha256, type JointBudgetCheckpoint } from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { jointBudgetAttempts, jointBudgetWindow } from '../src/verification/joint.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';

const works = ['a', 'b'];
const exhausted = (error: unknown) =>
  error instanceof HarnessError && error.code === 'ATTEMPTS_EXHAUSTED';
const invalid = (error: unknown) => error instanceof HarnessError && error.code === 'INVALID_INPUT';

function setup() {
  const policy = policyOf((p) => {
    p.maxAttempts = 3;
    p.workspaceGates = [
      {
        id: 'combo',
        kind: 'test',
        repositoryId: 'app',
        command: ['node', 'combo.js'],
        report: { type: 'junit', path: 'junit.xml' },
      },
    ];
  });
  const ctx = engineOf(policy);
  ready(ctx.engine, graphOf({ a: [], b: [] }));
  ctx.store.transact('task.done', (tx) => {
    for (const id of works) tx.putWork({ ...tx.work(id)!, status: 'done', resultSha: sha('a') });
  });
  return { ...ctx, policy };
}

function fail(engine: Engine) {
  const v = engine.jointStart({ workIds: [...works].reverse() });
  engine.jointFail(v.id, v.token, 'assertion failed');
  return v;
}

function pass(engine: Engine) {
  const v = engine.jointStart({ workIds: works });
  engine.jointManifest(v.id, v.token, { app: { sha: sha('a'), tree: sha('b') } });
  engine.jointEvidence(v.id, v.token, {
    gate: 'combo',
    command: ['node', 'combo.js'],
    passed: true,
    exitCode: 0,
    log: 'combo.log',
    digest: sha256('pass'),
    summary: 'pass',
    artifacts: [],
    durationMs: 1,
  });
  engine.jointFinish(v.id, v.token);
  return v;
}

/** Имитация доверенного продуктового принятия: фиксируется только terminal история. */
function accepted(engine: Engine, verificationId: string): JointBudgetCheckpoint {
  return Object.freeze({
    verificationId,
    settledVerificationIds: Object.freeze(
      engine.read((v) =>
        v
          .verifications()
          .filter((x) => x.status !== 'active')
          .map((x) => x.id),
      ),
    ),
  });
}

test('Accepted third verification closes its cycle; siblings, changed digests, clock and restart share the next budget', () => {
  const { engine, store, clock, dir, policy } = setup();
  let checkpoints: readonly JointBudgetCheckpoint[] = [];
  engine.host.basis.jointBudgetCheckpoints = () => checkpoints;
  fail(engine);
  fail(engine);
  const proof = pass(engine);
  assert.throws(
    () => engine.jointStart({ workIds: works }),
    exhausted,
    'PASS без acceptance не закрывает бюджет',
  );
  checkpoints = [accepted(engine, proof.id)];
  fail(engine);
  // Иная политика/постановка проверки и откат часов не создают новый бюджет.
  engine.host.basis.jointPolicyDigest = () => sha256('changed policy/model');
  engine.host.basis.jointSpecDigest = () => sha256('changed spec');
  clock.now -= 1000;
  fail(engine);
  assert.equal(
    engine.read(
      (v) =>
        jointBudgetAttempts(
          { ...v, verifications: () => v.verifications().reverse() },
          works,
          checkpoints,
        ).length,
    ),
    2,
  );
  store.close();
  const reopened = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  const host = standaloneHost(reopened, policy);
  host.basis.jointBudgetCheckpoints = () => checkpoints;
  const restarted = new Engine({ host, policy, now: () => clock.now });
  fail(restarted);
  assert.throws(() => restarted.jointStart({ workIds: works }), exhausted);
  // Даже повторный возврат старой принятой границы не возвращает попытки.
  host.basis.jointBudgetCheckpoints = () => [checkpoints[0]!];
  assert.throws(() => restarted.jointStart({ workIds: [...works].reverse() }), exhausted);
  reopened.close();
});

test('An active sibling existing at acceptance is outside the frozen terminal watermark', () => {
  const { engine, store } = setup();
  const proof = pass(engine);
  const sibling = engine.jointStart({ workIds: works });
  const checkpoint = accepted(engine, proof.id);
  assert.deepEqual(checkpoint.settledVerificationIds, [proof.id]);
  engine.host.basis.jointBudgetCheckpoints = () => [checkpoint];
  engine.jointFail(sibling.id, sibling.token, 'later failure');
  fail(engine);
  fail(engine);
  assert.throws(() => engine.jointStart({ workIds: works }), exhausted);
  store.close();
});

test('Invalid accepted checkpoints fail closed and hook exceptions roll back expired verification cleanup', () => {
  const { engine, store, clock, policy } = setup();
  const proof = pass(engine);
  const failed = fail(engine);
  const active = engine.jointStart({ workIds: works });
  const foreign = {
    ...engine.read((v) => v.verification(proof.id)!),
    id: 'foreign',
    workIds: ['b'],
  };
  store.transact('workspace.verified', (tx) => tx.putVerification(foreign));
  const checkpoint = (verificationId: string, settledVerificationIds: string[]) => ({
    verificationId,
    settledVerificationIds,
  });
  const valid = checkpoint(proof.id, [proof.id]);
  const variants: JointBudgetCheckpoint[][] = [
    [checkpoint(proof.id, [])],
    [checkpoint(proof.id, [proof.id, proof.id])],
    [checkpoint(proof.id, [failed.id])],
    [checkpoint(failed.id, [failed.id])],
    [checkpoint('missing', ['missing'])],
    [checkpoint(foreign.id, [foreign.id])],
    [checkpoint(proof.id, [proof.id, foreign.id])],
    [checkpoint(proof.id, [proof.id, active.id])],
    [checkpoint(proof.id, [proof.id, 'missing'])],
    [valid, valid],
  ];
  for (const checkpoints of variants)
    assert.throws(() => engine.read((v) => jointBudgetAttempts(v, works, checkpoints)), invalid);
  clock.now += policy.leaseMs + 1;
  const before = engine.read((v) => v.verifications());
  engine.host.basis.jointBudgetCheckpoints = () => {
    throw new Error('host acceptance lookup failed');
  };
  assert.throws(() => engine.jointStart({ workIds: works }), /host acceptance lookup failed/);
  assert.deepEqual(
    engine.read((v) => v.verifications()),
    before,
    'закрытие expired lease и начало откатились',
  );
  engine.host.basis.jointBudgetCheckpoints = () => [checkpoint(proof.id, [])];
  assert.throws(() => engine.jointStart({ workIds: works }), invalid);
  assert.deepEqual(
    engine.read((v) => v.verifications()),
    before,
  );
  store.close();
});

function interrupt(engine: Engine) {
  const v = engine.jointStart({ workIds: works });
  engine.jointFail(v.id, v.token, 'Совместная проверка отменена', { interrupted: true });
  return v;
}

function gateFailed(engine: Engine, options: { interrupted?: boolean } = {}) {
  const v = engine.jointStart({ workIds: works });
  engine.jointManifest(v.id, v.token, { app: { sha: sha('a'), tree: sha('b') } });
  engine.jointEvidence(v.id, v.token, {
    gate: 'combo',
    command: ['node', 'combo.js'],
    passed: false,
    exitCode: 1,
    log: 'combo.log',
    digest: sha256('fail'),
    summary: '1 tests, 1 failures, 0 skipped',
    artifacts: [],
    durationMs: 1,
  });
  engine.jointFail(v.id, v.token, 'Gate combo: exit=null; timeout=false', options);
  return v;
}

const verification = (engine: Engine, id: string) =>
  engine.read((v) => v.verification(id)!) as { status: string; interrupted?: true };

test('Interrupted verifications without gate evidence do not spend the joint budget; a gate result or a real failure does', () => {
  const { engine, store } = setup();
  const first = interrupt(engine);
  assert.equal(verification(engine, first.id).interrupted, true);
  fail(engine);
  interrupt(engine);
  // Отказ с результатом gate тратит предел, даже если владелец назвал его прерыванием.
  const late = gateFailed(engine, { interrupted: true });
  assert.equal(
    verification(engine, late.id).interrupted,
    undefined,
    'evidence есть — не прерывание',
  );
  assert.equal(
    engine.read((v) => jointBudgetAttempts(v, works, []).length),
    2,
  );
  // Запись хоста с прерыванием и evidence всё равно тратит предел.
  const hostWritten = { ...verification(engine, late.id), interrupted: true } as never;
  store.transact('workspace.failed', (tx) => tx.putVerification(hostWritten));
  assert.equal(
    engine.read((v) => jointBudgetAttempts(v, works, []).length),
    2,
  );
  const third = fail(engine);
  assert.equal(verification(engine, third.id).interrupted, undefined);
  assert.throws(
    () => engine.jointStart({ workIds: works }),
    (e: unknown) =>
      exhausted(e) &&
      /3 из 3/.test((e as Error).message) &&
      /прерванные остановкой/.test((e as Error).message),
  );
  store.close();
});

test('An expired verification is closed as interrupted only without gate evidence', () => {
  const { engine, store, clock, policy } = setup();
  const withEvidence = engine.jointStart({ workIds: works });
  engine.jointManifest(withEvidence.id, withEvidence.token, {
    app: { sha: sha('a'), tree: sha('b') },
  });
  engine.jointEvidence(withEvidence.id, withEvidence.token, {
    gate: 'combo',
    command: ['node', 'combo.js'],
    passed: false,
    exitCode: 1,
    log: 'combo.log',
    digest: sha256('fail'),
    summary: 'fail',
    artifacts: [],
  });
  clock.now += policy.leaseMs + 1;
  const bare = engine.jointStart({ workIds: works });
  assert.equal(verification(engine, withEvidence.id).status, 'failed');
  assert.equal(verification(engine, withEvidence.id).interrupted, undefined);
  clock.now += policy.leaseMs + 1;
  engine.jointStart({ workIds: works });
  assert.equal(verification(engine, bare.id).status, 'failed');
  assert.equal(verification(engine, bare.id).interrupted, true, 'истёк до gates — прерывание');
  const ids = engine.read((v) => jointBudgetAttempts(v, works, []).map((x) => x.id));
  assert.ok(ids.includes(withEvidence.id) && !ids.includes(bare.id));
  store.close();
});

test('Repeated interruptions have their own limit; an explicit reset with a reason reopens the budget and survives restart', () => {
  const { engine, store, clock, dir, policy } = setup();
  interrupt(engine);
  interrupt(engine);
  assert.throws(
    () => engine.jointBudgetReset(works, { reason: 'stuck', actor: 'operator' }),
    (e: unknown) => e instanceof HarnessError && e.code === 'NOT_READY',
    'сброс до исчерпания не нужен',
  );
  interrupt(engine);
  assert.throws(
    () => engine.jointStart({ workIds: works }),
    (e: unknown) => exhausted(e) && /прерваны до результата gates 3/.test((e as Error).message),
  );
  assert.throws(() => engine.jointBudgetReset(works, { reason: '  ' }), invalid);
  const reset = engine.jointBudgetReset([...works].reverse(), {
    reason: 'host restarted; lease loss fixed',
    actor: 'operator',
  });
  assert.equal(reset.settledVerificationIds.length, 3);
  assert.deepEqual(reset.workIds, works);
  const event = store.events(0, 500).find((e) => e.type === 'joint.budget-reset') as
    { payload: Record<string, unknown> } | undefined;
  assert.deepEqual(event?.payload, {
    resetId: reset.id,
    workIds: works,
    by: 'operator',
    settled: 3,
    reasonLength: reset.reason.length,
  });
  const live = engine.jointStart({ workIds: works });
  assert.throws(
    () => engine.jointBudgetReset(works, { reason: 'again' }),
    (e: unknown) => e instanceof HarnessError && e.code === 'NOT_READY',
    'живая проверка набора',
  );
  engine.jointFail(live.id, live.token, 'assertion failed');
  fail(engine);
  fail(engine);
  assert.throws(() => engine.jointStart({ workIds: works }), exhausted, 'новый предел — снова 3');
  store.close();
  // Запись сброса — в состоянии: после перезапуска граница та же.
  const reopened = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  const restarted = new Engine({
    host: standaloneHost(reopened, policy),
    policy,
    now: () => clock.now,
  });
  assert.equal(
    restarted.read((v) => jointBudgetWindow(v, works, []).length),
    3,
    'прерывания до сброса вне окна; в нём — три отказа после сброса',
  );
  reopened.close();
});

test('A reset discounts only verifications without gate evidence; a limit spent by gate results alone is refused', () => {
  const { engine, store } = setup();
  gateFailed(engine);
  gateFailed(engine);
  interrupt(engine);
  interrupt(engine);
  interrupt(engine);
  const reset = engine.jointBudgetReset(works, { reason: 'lease loss fixed', actor: 'operator' });
  assert.equal(reset.settledVerificationIds.length, 3, 'только прерванные');
  // Два отказа gates остаются в пределе: после сброса — одна проверка.
  fail(engine);
  assert.throws(() => engine.jointStart({ workIds: works }), exhausted);
  store.close();

  const gates = setup();
  gateFailed(gates.engine);
  gateFailed(gates.engine);
  gateFailed(gates.engine);
  assert.throws(
    () => gates.engine.jointBudgetReset(works, { reason: 'try again', actor: 'operator' }),
    (e: unknown) => exhausted(e) && /результатом gates: 3 из 3/.test((e as Error).message),
  );
  assert.equal(
    gates.engine.read((v) => v.locals('joint-budget-resets').length),
    0,
  );
  gates.store.close();

  // Отказы до gates прежних версий (без отметки, без evidence) сброс снимает.
  const legacy = setup();
  fail(legacy.engine);
  fail(legacy.engine);
  fail(legacy.engine);
  assert.equal(
    legacy.engine.jointBudgetReset(works, { reason: 'old aborted runs' }).settledVerificationIds
      .length,
    3,
  );
  assert.ok(legacy.engine.jointStart({ workIds: works }));
  legacy.store.close();
});

test('A reset closes an expired, still active verification of the set before judging the budget', () => {
  const { engine, store, clock, policy } = setup();
  interrupt(engine);
  interrupt(engine);
  const stale = engine.jointStart({ workIds: works });
  clock.now += policy.leaseMs + 1;
  const reset = engine.jointBudgetReset(works, { reason: 'host crashed', actor: 'operator' });
  assert.ok(reset.settledVerificationIds.includes(stale.id));
  assert.equal(verification(engine, stale.id).status, 'failed');
  assert.equal(verification(engine, stale.id).interrupted, true);
  store.close();
});

test('A reset that would settle nothing or leave the set exhausted is refused and not recorded', () => {
  /** Успешная проверка без evidence и без принятия (область gates пуста). */
  const bare = (ctx: ReturnType<typeof setup>) => {
    const v = pass(ctx.engine);
    const stored = ctx.engine.read((x) => x.verification(v.id)!);
    ctx.store.transact('workspace.verified', (tx) =>
      tx.putVerification({ ...stored, evidence: [] }),
    );
  };
  const refusedReset = (ctx: ReturnType<typeof setup>, settled: number, remaining: number) => {
    assert.throws(
      () => ctx.engine.jointBudgetReset(works, { reason: 'retry the set', actor: 'operator' }),
      (e: unknown) =>
        exhausted(e) &&
        (e as Error).message.includes(`без результата gates (${settled})`) &&
        (e as Error).message.includes(`(${remaining}, в том числе успешные без принятия)`),
    );
    assert.equal(
      ctx.engine.read((v) => v.locals('joint-budget-resets').length),
      0,
    );
  };

  const nothing = setup();
  bare(nothing);
  bare(nothing);
  bare(nothing);
  assert.throws(() => nothing.engine.jointStart({ workIds: works }), exhausted);
  refusedReset(nothing, 0, 3);
  nothing.store.close();

  // Три успешные без принятия и отказ прежней версии без evidence: после
  // сброса этого отказа набор всё равно исчерпан.
  const still = setup();
  bare(still);
  const template = still.engine.read((x) => x.verifications()[0]!);
  still.store.transact('workspace.failed', (tx) => {
    tx.putVerification({ ...template, id: 'bare-2' });
    tx.putVerification({ ...template, id: 'bare-3' });
    tx.putVerification({
      ...template,
      id: 'legacy-failed',
      status: 'failed',
      error: 'Совместная проверка отменена',
      manifest: undefined,
      manifestDigest: undefined,
    } as never);
  });
  refusedReset(still, 1, 3);
  still.store.close();
});
