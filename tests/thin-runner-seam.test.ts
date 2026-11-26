/**
 * 0.1.0-alpha.73: шов прогона тонкого режима. После общей подготовки
 * попытка уходит в поток сдачи `src/thin/` с привязанными возможностями
 * прогона (ThinKit); путь облегчённого режима (дерево попытки, кандидат,
 * черновик) не исполняется.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { TaskFailure } from '../src/contracts/index.ts';
import { thinFlow } from '../src/thin/flow.ts';
import type { ThinHandover, ThinKit } from '../src/thin/kit.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';

const thin = (p: Record<string, unknown>) => {
  p.harnessMode = 'thin';
  p.maxAttempts = 1;
};

test('thin: попытка — в поток сдачи с привязанными возможностями прогона; promote — CAS с stale-base', async () => {
  const implemented: string[] = [];
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: thin,
    runner: { hooks: { implemented: (e) => void implemented.push(e.sha) } },
  });
  const original = thinFlow.handover;
  const seen: { kit?: ThinKit; input?: ThinHandover; stale?: unknown; history?: number } = {};
  thinFlow.handover = (kit, input) => {
    seen.kit = kit;
    seen.input = input;
    // Привязанный метод прогона работает вне объекта Runner.
    seen.history = kit.history(input.attempt).length;
    // Первый CAS: цель сдвинута после проверки — promote отказывает stale-base.
    let moved = false;
    const promote: ThinKit['promote'] = async (attempt, work, repo, sha, base) => {
      if (!moved) {
        moved = true;
        ctx.repo.git(
          'update-ref',
          repo.targetRef,
          ctx.repo.git('commit-tree', `${base}^{tree}`, '-p', base, '-m', 'race'),
        );
        try {
          await kit.promote(attempt, work, repo, sha, base);
        } catch (error) {
          seen.stale = error;
          throw error;
        }
        return;
      }
      return kit.promote(attempt, work, repo, sha, base);
    };
    return original({ ...kit, promote }, input);
  };
  try {
    await runAll(ctx);
  } finally {
    thinFlow.handover = original;
  }
  const kit = seen.kit!;
  for (const name of Object.keys(kit) as (keyof ThinKit)[])
    if (name !== 'engine' && name !== 'policy') assert.equal(typeof kit[name], 'function', name);
  assert.equal(kit.policy.harnessMode, 'thin');
  assert.equal(seen.history, 1);
  const input = seen.input!;
  assert.equal(input.work.id, ctx.graph.orders[0]!.id);
  assert.ok(
    seen.stale instanceof TaskFailure && seen.stale.kind === 'stale-base',
    String(seen.stale),
  );
  // Проверка заново на новой цели — принято; черновика нет, дерево работы убрано.
  const [attempt] = ctx.engine.read((v) => v.attempts(input.work.id));
  assert.equal(attempt!.status, 'succeeded', attempt!.error);
  assert.equal(attempt!.partial, undefined, 'черновик не снимается');
  assert.deepEqual(implemented, [attempt!.candidateSha], 'хук хоста implemented');
  assert.equal(existsSync(attempt!.worktree!), false);
  assert.equal(ctx.repo.git('rev-parse', `${attempt!.integrationSha}^1^{commit}`).length, 40);
});

test('light: прежний путь — шов не задействован', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => delete p.harnessMode,
  });
  const original = thinFlow.handover;
  let called = false;
  thinFlow.handover = (kit, input) => {
    called = true;
    return original(kit, input);
  };
  try {
    await runAll(ctx);
  } finally {
    thinFlow.handover = original;
  }
  assert.equal(called, false);
  assert.equal(
    ctx.engine.read((v) => v.work(ctx.graph.orders[0]!.id)!.status),
    'done',
  );
});
