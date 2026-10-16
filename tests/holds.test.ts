import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HarnessError,
  executionPolicySchema,
  type ErrorCode,
  type ExecutionPolicy,
} from '../src/contracts/index.ts';
import { WorkflowQueue } from '../src/control/workflow.ts';
import { fencedRefMove, moveBase } from '../src/control/base-move.ts';
import { engineOf, graphOf, policyOf, ready } from './engine-fixture.ts';
import { repo } from './git-fixture.ts';

const refused = (code: ErrorCode, message?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  if (message) assert.match(e.message, message);
  return true;
};

test('Удержание операции: выдачи нет; другая операция — конфликт; снимает только своя; передача без окна выдачи', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [], b: [] }));
  engine.hold(['a', 'b'], 'op-1', 'контракт меняется');
  assert.deepEqual(
    engine.hold(['a'], 'op-1', 'контракт меняется'),
    ['a'],
    'повтор ничего не меняет',
  );
  assert.equal(engine.claim('c1'), undefined);
  assert.ok(
    engine
      .read((v) => engine.blockers(v.work('a')!, v))
      .some((b) => b.code === 'NOT_READY' && /op-1/.test(b.message)),
  );
  assert.throws(() => engine.hold(['a'], 'op-2', 'другое'), refused('NOT_READY', /a \(op-1\)/));
  assert.deepEqual(engine.releaseHold('op-2'), [], 'чужое удержание не снимается');
  assert.deepEqual(engine.transferHold('op-1', 'op-3', 'продолжение'), ['a', 'b']);
  assert.equal(engine.claim('c1'), undefined, 'после передачи окна выдачи нет');
  assert.deepEqual(engine.releaseHold('op-3', ['b']), ['b']);
  assert.equal(engine.claim('c1')?.workId, 'b', 'снято только с названного');
  assert.equal(
    engine.read((v) => v.work('a')!.hold?.operation),
    'op-3',
  );
  assert.deepEqual(
    engine.activeAttempts().map((a) => a.workId),
    ['b'],
    'операция видит, кого ждать',
  );
});

test('Удержание под владением операции: утративший владение ничего не пишет', () => {
  const { engine, store, clock } = engineOf();
  const graph = ready(engine, graphOf({ a: [] }));
  const queue = new WorkflowQueue(store, engine.policy, () => clock.now);
  const job = queue.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
  const owned = queue.claim(job.key)!;
  engine.hold(['a'], 'op-1', 'контракт меняется', (view) => queue.guard(owned, view));
  clock.now += engine.policy.leaseMs + 1;
  assert.throws(
    () => engine.releaseHold('op-1', undefined, (view) => queue.guard(owned, view)),
    refused('LEASE_STALE'),
  );
  assert.equal(
    engine.read((v) => v.work('a')!.hold?.operation),
    'op-1',
    'удержание осталось',
  );
  assert.throws(
    () => engine.hold(['a'], 'op-1', 'ещё раз', (view) => queue.guard(owned, view)),
    refused('LEASE_STALE'),
  );
  assert.equal(
    engine.read((v) => v.work('a')!.hold?.reason),
    'контракт меняется',
  );
});

/** Репозиторий с target ref и рабочей линией впереди него. */
function based() {
  const r = repo({ 'a.txt': '1\n' });
  const policy: ExecutionPolicy = executionPolicySchema.parse({
    ...policyOf(),
    repositories: [{ ...policyOf().repositories[0]!, id: 'app', path: r.dir }],
  });
  const ref = policy.repositories[0]!.targetRef;
  r.git('update-ref', ref, 'HEAD');
  const state = mkdtempSync(join(tmpdir(), 'harness-base-'));
  writeFileSync(join(r.dir, 'b.txt'), '2\n');
  r.git('add', '-A');
  r.git('commit', '-qm', 'work');
  return { r, policy, ref, state, tip: () => r.git('rev-parse', ref) };
}

test('Перенос базы: fast-forward и слияние двух линий; CAS не теряет чужой сдвиг', async () => {
  const b = based();
  const before = b.tip();
  const moved = await moveBase({ policy: b.policy, baseDir: b.r.dir, stateDir: b.state });
  assert.equal(moved.updated[0]?.kind, 'fast-forward');
  assert.equal(b.tip(), b.r.head());
  assert.notEqual(before, b.tip());
  // Обе линии несут работу: слияние.
  b.r.git('checkout', '-q', '-b', 'side', before);
  writeFileSync(join(b.r.dir, 'c.txt'), '3\n');
  b.r.git('add', '-A');
  b.r.git('commit', '-qm', 'side');
  const merged = await moveBase({ policy: b.policy, baseDir: b.r.dir, stateDir: b.state });
  assert.equal(merged.updated[0]?.kind, 'merge');
  b.r.git('merge-base', '--is-ancestor', b.r.head(), b.tip());
  // Ref сдвинули между чтением и переносом: CAS отклоняет, чужой коммит цел.
  writeFileSync(join(b.r.dir, 'd.txt'), '4\n');
  b.r.git('add', '-A');
  b.r.git('commit', '-qm', 'next');
  const foreign = b.tip();
  await assert.rejects(
    moveBase({
      policy: b.policy,
      baseDir: b.r.dir,
      stateDir: b.state,
      move: (repoPath, target, to, from) => {
        b.r.git('commit', '--allow-empty', '-qm', 'foreign');
        b.r.git('update-ref', target, b.r.head(), foreign);
        execFileSync('git', ['update-ref', target, to, from], { cwd: repoPath, stdio: 'pipe' });
      },
    }),
  );
  assert.equal(b.tip(), b.r.head(), 'чужой сдвиг сохранён');
});

test('Перенос базы под владением операции: после утраты владения ref не сдвигается', async () => {
  const b = based();
  const { store } = engineOf(b.policy);
  const before = b.tip();
  let owned = true;
  const move = fencedRefMove(store, () => {
    if (!owned) throw new HarnessError('LEASE_STALE', 'Владение операцией утрачено');
  });
  owned = false;
  await assert.rejects(
    moveBase({ policy: b.policy, baseDir: b.r.dir, stateDir: b.state, move }),
    refused('LEASE_STALE'),
  );
  assert.equal(b.tip(), before, 'база не сдвинута после отмены');
  owned = true;
  await moveBase({ policy: b.policy, baseDir: b.r.dir, stateDir: b.state, move });
  assert.equal(b.tip(), b.r.head());
});

test('Сдвиг ref внутри транзакции не исполняет hooks репозитория', async () => {
  const b = based();
  const { store } = engineOf(b.policy);
  const marker = join(b.state, 'hook-ran');
  const hook = join(b.r.dir, '.git', 'hooks', 'reference-transaction');
  writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nsleep 5\n`);
  chmodSync(hook, 0o755);
  const started = Date.now();
  await moveBase({
    policy: b.policy,
    baseDir: b.r.dir,
    stateDir: b.state,
    move: fencedRefMove(store, () => {}),
  });
  assert.equal(b.tip(), b.r.head());
  assert.equal(existsSync(marker), false, 'hook внутри транзакции не запускался');
  assert.ok(Date.now() - started < 4000);
});

test('Зависший git update-ref внутри транзакции останавливается своим пределом', async () => {
  const b = based();
  const { store } = engineOf(b.policy);
  const shim = mkdtempSync(join(tmpdir(), 'harness-git-shim-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  writeFileSync(
    join(shim, 'git'),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = update-ref ] && exec sleep 60; done\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(join(shim, 'git'), 0o755);
  assert.ok(fencedRefMove.timeoutMs > 0 && fencedRefMove.timeoutMs <= 60000);
  const before = b.tip();
  const path = process.env.PATH;
  const started = Date.now();
  try {
    process.env.PATH = `${shim}:${path}`;
    await assert.rejects(
      moveBase({
        policy: b.policy,
        baseDir: b.r.dir,
        stateDir: b.state,
        move: fencedRefMove(store, () => {}, 1500),
      }),
    );
  } finally {
    process.env.PATH = path;
  }
  assert.ok(Date.now() - started < 30000, 'не ждал зависший Git целиком');
  assert.equal(b.tip(), before, 'база не сдвинута');
  await moveBase({
    policy: b.policy,
    baseDir: b.r.dir,
    stateDir: b.state,
    move: fencedRefMove(store, () => {}),
  });
  assert.equal(b.tip(), b.r.head(), 'после устранения причины перенос проходит');
});
