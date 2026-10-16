import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { HarnessError, digestOf, type AttemptState } from '../src/contracts/index.ts';
import { review, trustNone } from './engine-fixture.ts';
import { greet, setup, target } from './runner-fixture.ts';
import { write } from './git-fixture.ts';

/**
 * Попытка, доведённая до приёмки вручную на настоящем Git: кандидат —
 * коммит поверх базы, интеграция — merge в принятую ветку, evidence обеих
 * фаз. `complete: false` — без ревью интеграции (неполные evidence).
 */
async function integrated(complete = true) {
  let offset = 0;
  const ctx = setup({ scenario: {}, now: () => Date.now() + offset });
  await ctx.runner.init();
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(review(graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  ctx.engine.lead('runner-1');
  const a: AttemptState = ctx.engine.claim('runner-1')!;
  const ref = ctx.policy.repositories[0]!.targetRef;
  const base = target(ctx);
  ctx.repo.git('checkout', '-q', '-b', 'candidate', base);
  write(ctx.repo.dir, { 'src/greet.js': greet });
  ctx.repo.git('add', '-A');
  ctx.repo.git('commit', '-qm', 'candidate');
  const candidate = ctx.repo.head();
  ctx.repo.git('checkout', '-q', '--detach', base);
  ctx.repo.git('merge', '--no-ff', '-q', '-m', 'integration', candidate);
  const integration = ctx.repo.head();
  ctx.repo.git('checkout', '-q', 'main');
  ctx.engine.phase(a.id, a.token, 'verifying', { baseSha: base, candidateSha: candidate });
  const ev = (kind: 'test' | 'review', phase: 'candidate' | 'integration', sha: string) =>
    ctx.engine.evidence(a.id, a.token, {
      kind,
      phase,
      sha,
      gate: kind === 'test' ? 'unit' : 'independent-review',
      passed: true,
      command: [],
      exitCode: 0,
      log: '',
      digest: digestOf(kind + phase),
      summary: 'ok',
    });
  ev('test', 'candidate', candidate);
  ev('review', 'candidate', candidate);
  ctx.engine.phase(a.id, a.token, 'integrating', { integrationSha: integration });
  ev('test', 'integration', integration);
  if (complete) ev('review', 'integration', integration);
  const publish = () =>
    execFileSync('git', ['update-ref', ref, integration, base], {
      cwd: ctx.repo.dir,
      stdio: 'pipe',
    });
  return { ctx, a, base, integration, publish, expire: () => (offset += 60_000) };
}

const accepted = (ctx: ReturnType<typeof setup>) =>
  ctx.store.events().filter((e) => e.type === 'work.accepted').length;

test('T12: падение после update-ref до фиксации — recovery принимает сохранённый integration SHA один раз', async () => {
  const { ctx, a, integration, publish, expire } = await integrated();
  // Процесс «падает» после CAS: транзакция приёмки не зафиксирована, ref уже продвинут.
  assert.throws(() =>
    ctx.engine.finish(a.id, a.token, integration, () => {
      publish();
      throw new Error('crash after update-ref');
    }),
  );
  assert.equal(target(ctx), integration, 'ref продвинут');
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'integrating',
    'приёмка не записана',
  );
  await ctx.runner.recover();
  assert.equal(accepted(ctx), 0, 'пока lease владельца действует, recovery не трогает попытку');
  expire();
  await ctx.runner.recover();
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'done');
  assert.equal(work.resultSha, integration);
  assert.equal(accepted(ctx), 1);
  await ctx.runner.recover();
  assert.equal(accepted(ctx), 1, 'повторный recovery не дублирует принятие');
  assert.throws(
    () => ctx.engine.heartbeat(a.id, a.token),
    (e: unknown) => e instanceof HarnessError && e.code === 'LEASE_STALE',
    'прежний владелец не продолжает',
  );
});

test('T13: падение до CAS — recovery не выдумывает PASS; старый владелец не завершает', async () => {
  const { ctx, a, base, integration, expire } = await integrated();
  assert.throws(() =>
    ctx.engine.finish(a.id, a.token, integration, () => {
      throw new Error('crash before update-ref');
    }),
  );
  assert.equal(target(ctx), base);
  expire();
  await ctx.runner.recover();
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed', 'интеграция не в target ref: попытка истекает');
  assert.equal(work.failureKind, 'environment');
  assert.equal(accepted(ctx), 0);
  assert.throws(
    () => ctx.engine.finish(a.id, a.token, integration),
    (e: unknown) => e instanceof HarnessError && e.code === 'LEASE_STALE',
  );
  assert.equal(target(ctx), base);
});

test('T13: integration SHA в target ref, но evidence неполные — принятия нет, отказ записан', async () => {
  const { ctx, a, integration, publish, expire } = await integrated(false);
  publish();
  expire();
  await ctx.runner.recover();
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.notEqual(work.status, 'done', 'нет ложного accepted');
  assert.equal(work.status, 'failed');
  assert.equal(accepted(ctx), 0);
  const rejected = ctx.store.events().find((e) => e.type === 'attempt.recovered');
  assert.ok(rejected && rejected.type === 'attempt.recovered' && !rejected.payload.accepted);
  assert.match(String(rejected.payload.reason), /независимого ревью: integration/);
  void a;
  void integration;
});
