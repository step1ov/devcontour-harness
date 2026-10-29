import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { HarnessError, sha256, type JointBudgetCheckpoint } from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { jointBudgetAttempts } from '../src/verification/joint.ts';
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
