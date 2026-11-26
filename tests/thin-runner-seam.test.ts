/* eslint-disable @typescript-eslint/no-unsafe-member-access --
 * Тест правит сырой JSON политики до разбора схемой.
 */
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
import { thinFlow } from '../src/thin/flow.ts';
import type { ThinHandover, ThinKit } from '../src/thin/kit.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';

const thin = (p: Record<string, unknown>) => {
  p.harnessMode = 'thin';
  p.maxAttempts = 1;
};

test('thin: попытка — в поток сдачи после общей подготовки, с возможностями прогона', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() }, policy: thin });
  const original = thinFlow.handover;
  const seen: { kit?: ThinKit; input?: ThinHandover } = {};
  thinFlow.handover = (kit, input) => {
    seen.kit = kit;
    seen.input = input;
    return original(kit, input);
  };
  try {
    await runAll(ctx);
  } finally {
    thinFlow.handover = original;
  }
  const kit = seen.kit!;
  for (const name of [
    'call',
    'gate',
    'review',
    'environment',
    'dependencyStore',
    'prepareSteps',
    'timed',
    'consumers',
    'requirements',
    'notes',
    'history',
    'adapter',
    'checkout',
    'promote',
  ] as const)
    assert.equal(typeof kit[name], 'function', name);
  assert.equal(kit.policy.harnessMode, 'thin');
  const input = seen.input!;
  assert.equal(input.base, ctx.repo.git('rev-parse', ctx.policy.repositories[0]!.targetRef));
  assert.equal(input.work.id, ctx.graph.orders[0]!.id);
  // Заглушка S5: явный отказ ведущему, исполнитель не вызывался, дерева попытки нет.
  const [attempt] = ctx.engine.read((v) => v.attempts(input.work.id));
  assert.equal(attempt!.failureKind, 'needs-lead');
  assert.match(attempt!.error ?? '', /тонкого режима .* не реализован/);
  assert.equal(attempt!.worktree, undefined);
  assert.equal(attempt!.partial, undefined, 'черновик не снимается');
  assert.equal(existsSync(`${ctx.scenarioPath}.claude.writer.count`), false);
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
