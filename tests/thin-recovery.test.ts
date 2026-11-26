/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return --
 * Тест правит сырой JSON политики до разбора схемой.
 */
/**
 * 0.1.0-alpha.73: тонкий режим и вмешательства — разбор ведущего даёт новую
 * сессию со сводкой, сброс начинает работу заново от цели; уборка деревьев
 * не трогает дерево работы между сдачами; два сбоя среды разных gates в
 * одной сдаче; сессия codex записана и при отказе; приёмка после падения
 * между update-ref и записью убирает дерево работы.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import type { RuntimeName } from '../src/contracts/index.ts';
import { Runner } from '../src/engine/runner.ts';
import { thinFlow } from '../src/thin/flow.ts';
import type { ThinKit } from '../src/thin/kit.ts';
import { approve, bin, implement, runAll, setup } from './runner-fixture.ts';

const wrong = "exports.greet = (name) => 'Hi ' + name;\n";
const rec = <T extends object>(step: T) => ({ ...step, recordPrompt: true });

function thin(
  writer: unknown,
  options: {
    policy?: (p: Record<string, any>) => void;
    runtime?: RuntimeName;
    now?: () => number;
    gates?: string[];
  } = {},
) {
  const ctx = setup({
    writer: options.runtime ?? 'claude',
    ...(options.runtime === 'codex' ? { reviewer: 'claude' as const } : {}),
    scenario: { writer, reviewer: approve() },
    policy: (p) => {
      p.harnessMode = 'thin';
      p.maxAttempts = 3;
      options.policy?.(p);
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.gates
      ? { graph: (g: Record<string, any>) => (g.orders[0].gates = options.gates) }
      : {}),
    runner: {
      adapters: {
        claude: cliAdapter('claude', { executable: bin('fake-claude'), sessionContinue: true }),
        codex: cliAdapter('codex', { executable: bin('fake-codex'), sessionContinue: true }),
      },
    },
  });
  const work = ctx.graph.orders[0]!.id;
  const attempts = () => ctx.engine.read((v) => v.attempts(work));
  const prompt = (i: number) => readFileSync(`${ctx.scenarioPath}.writer.${i}.prompt`, 'utf8');
  const again = async () => {
    ctx.engine.resume();
    await ctx.runner.drain();
  };
  return { ...ctx, work, attempts, prompt, again };
}

test('разбор ведущего после отказа — новая сессия со сводкой и заметками разбора', async () => {
  const ctx = thin([rec(implement({ 'src/greet.js': wrong })), rec(implement())]);
  await runAll(ctx);
  const [first] = ctx.attempts();
  assert.equal(first!.failureKind, 'gate');
  ctx.engine.diagnose(ctx.work, {
    cause: 'approach',
    hypothesis: 'нужна другая строка приветствия',
  });
  ctx.engine.retry(ctx.work, undefined, 'lead');
  await ctx.again();
  const [, second] = ctx.attempts();
  assert.equal(second!.status, 'succeeded', second!.error);
  assert.equal(second!.writerSession?.mode, 'fresh');
  assert.match(second!.writerSession?.reason ?? '', /разбор ведущего/);
  assert.notEqual(second!.writerSession?.id, first!.writerSession?.id);
  assert.match(ctx.prompt(1), /Handover summary/);
  assert.match(ctx.prompt(1), /нужна другая строка приветствия/, 'разбор в заметках');
});

test('сброс ведущим — дерево, ветка и сессия работы заново от цели', async () => {
  const ctx = thin([
    rec(implement({ 'src/greet.js': wrong, 'src/extra.js': '//x\n' })),
    rec(implement()),
  ]);
  await runAll(ctx);
  const [first] = ctx.attempts();
  assert.equal(first!.failureKind, 'gate');
  ctx.engine.retry(ctx.work, { reason: 'начать заново' });
  await ctx.again();
  const [, second] = ctx.attempts();
  assert.equal(second!.status, 'succeeded', second!.error);
  assert.equal(second!.writerSession?.mode, 'fresh');
  assert.match(second!.writerSession?.reason ?? '', /сброс/);
  // Правки прошлой сдачи не дошли до цели: дерево начато заново.
  assert.throws(() => ctx.repo.git('show', `${second!.integrationSha}:src/extra.js`));
});

test('уборка деревьев между сдачами не трогает дерево работы и его коммиты', async () => {
  const ctx = thin([rec(implement({ 'src/greet.js': wrong })), rec(implement())], {
    policy: (p) => (p.maxAttempts = 1),
  });
  await runAll(ctx);
  const [first] = ctx.attempts();
  assert.equal(first!.failureKind, 'gate');
  const swept = await ctx.runner.cleanupWorktrees();
  assert.equal(existsSync(first!.worktree!), true, 'дерево работы осталось');
  const entry = swept.worktrees.find((e) => e.path.endsWith(`work-${ctx.work}`));
  assert.equal(entry?.action, 'refused');
  assert.equal(await ctx.runner.finishCleanup(first!.id).then((r) => r.status !== undefined), true);
  assert.equal(existsSync(first!.worktree!), true, 'cleanup --run его тоже не убирает');
  assert.equal(
    ctx.repo.git('rev-parse', `refs/heads/harness/work-${ctx.work}`),
    first!.candidateSha,
    'коммиты сдачи целы',
  );
});

test('два gate со сбоем среды в одной сдаче — по повтору на каждый', async () => {
  const hang = `
const fs = require('fs');
const mark = process.env.HANG_MARK + '.' + process.argv[2];
if (!fs.existsSync(mark)) { fs.writeFileSync(mark, ''); setInterval(() => {}, 1000); }
else require('./run.js');
`;
  const ctx = thin(rec(implement()), {
    gates: ['unit', 'second'],
    policy: (p) => {
      const unit = p.repositories[0].gates[0];
      p.repositories[0].gates = ['unit', 'second'].map((id) => ({
        ...unit,
        id,
        command: [process.execPath, 'test/hang.js', id],
        timeoutMs: 1500,
      }));
      p.environment.values.HANG_MARK = p.environment.values.FIXTURE_SCENARIO + '.hang';
    },
  });
  ctx.repo.git('rev-parse', 'HEAD');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(ctx.repo.dir, 'test/hang.js'), hang);
  ctx.repo.git('add', '-A');
  ctx.repo.git('commit', '-qm', 'hang');
  ctx.repo.git('update-ref', ctx.policy.repositories[0]!.targetRef, 'HEAD');
  await runAll(ctx);
  const [a] = ctx.attempts();
  assert.equal(a!.status, 'succeeded', a!.error);
  for (const gate of ['unit', 'second'])
    assert.deepEqual(
      a!.evidence.filter((e) => e.kind === 'test' && e.gate === gate).map((e) => e.passed),
      [false, true],
      gate,
    );
});

test('codex: сессия записана и при отказе вызова — следующая сдача её продолжает', async () => {
  const ctx = thin([{ exit: 1 }, rec(implement())], { runtime: 'codex' });
  await runAll(ctx);
  const [first] = ctx.attempts();
  assert.notEqual(first!.status, 'succeeded');
  assert.ok(first!.writerSession?.id, 'сессия записана при отказе');
  ctx.engine.retry(ctx.work, undefined, 'lead');
  await ctx.again();
  const [, second] = ctx.attempts();
  assert.equal(second!.status, 'succeeded', second!.error);
  assert.equal(second!.writerSession?.mode, 'resumed');
  assert.equal(second!.writerSession?.id, first!.writerSession?.id);
});

test('падение между update-ref и приёмкой: recovery принимает и убирает дерево работы', async () => {
  const clock = { now: Date.now() };
  const ctx = thin(rec(implement()), { now: () => clock.now });
  const original = thinFlow.handover;
  let moved!: () => void;
  const published = new Promise<void>((r) => (moved = r));
  thinFlow.handover = (kit, input) => {
    const promote: ThinKit['promote'] = async (_a, _w, repo, sha, base) => {
      ctx.repo.git('update-ref', repo.targetRef, sha, base);
      moved();
      await new Promise(() => {}); // процесс «упал» до записи приёмки
    };
    return original({ ...kit, promote }, input);
  };
  try {
    void runAll(ctx);
    await published;
  } finally {
    thinFlow.handover = original;
  }
  const [a] = ctx.attempts();
  clock.now += ctx.policy.leaseMs * 10;
  ctx.runner.release();
  const restarted = new Runner({ ...ctx.runner.options, owner: 'runner-2' });
  await restarted.recover();
  const [after] = ctx.attempts();
  assert.equal(after!.status, 'succeeded', after!.error);
  assert.equal(existsSync(a!.worktree!), false, 'дерево работы убрано');
  assert.equal(existsSync(join(dirname(a!.worktree!), '..', 'sessions', ctx.work)), false);
});

test('цель дважды сдвинулась мимо замка — незасчитанный повтор следующей сдачей без writer', async () => {
  const ctx = thin(rec(implement()));
  const original = thinFlow.handover;
  let races = 2;
  thinFlow.handover = (kit, input) => {
    const promote: ThinKit['promote'] = async (attempt, work, repo, sha, base) => {
      if (races-- > 0)
        ctx.repo.git(
          'update-ref',
          repo.targetRef,
          ctx.repo.git('commit-tree', `${base}^{tree}`, '-p', base, '-m', 'race'),
        );
      return kit.promote(attempt, work, repo, sha, base);
    };
    return original({ ...kit, promote }, input);
  };
  try {
    await runAll(ctx);
    const [first] = ctx.attempts();
    assert.equal(first!.failureKind, 'stale-base', first!.error);
    assert.equal(
      ctx.engine.read((v) => v.work(ctx.work)!.attempt),
      0,
      'не засчитано',
    );
    ctx.engine.retry(ctx.work, undefined, 'lead');
    await ctx.again();
  } finally {
    thinFlow.handover = original;
  }
  const [first, second] = ctx.attempts();
  assert.equal(second!.status, 'succeeded', second!.error);
  assert.equal(second!.candidateSha, first!.candidateSha, 'тот же кандидат');
  assert.equal(
    Number(readFileSync(`${ctx.scenarioPath}.claude.writer.count`, 'utf8')),
    1,
    'writer не вызывался второй раз',
  );
});
