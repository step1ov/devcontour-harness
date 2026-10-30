/**
 * `worktree-cleanup` на настоящем Git: попытки проходят через Runner, оставшееся
 * рабочее дерево восстанавливается так, как его оставляет упавший процесс.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trustNone, planReview } from './engine-fixture.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';

type Ctx = ReturnType<typeof setup>;
const attemptOf = (ctx: Ctx) => ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
const branchOf = (id: string) => `harness/run-${id}`;
/** Дерево попытки, как после упавшего процесса: на ветке попытки. */
function retain(ctx: Ctx) {
  const attempt = attemptOf(ctx);
  ctx.repo.git('worktree', 'add', '-q', attempt.worktree!, branchOf(attempt.id));
  return { attempt, dir: attempt.worktree! };
}
const artifactsOf = (ctx: Ctx, id: string) => join(ctx.state, 'artifacts', id);
const entryFor = (result: Awaited<ReturnType<Ctx['runner']['cleanupWorktrees']>>, path: string) =>
  result.worktrees.find((w) => w.path === path);

test('worktree-cleanup: dry run ничего не меняет; удаление оставляет ветку и сохраняет неподтверждённые правки патчем', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  await runAll(ctx);
  const { attempt, dir } = retain(ctx);
  const integration = dir + '-integration';
  ctx.repo.git('worktree', 'add', '-q', '--detach', integration, branchOf(attempt.id));
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'ignored\n');
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  writeFileSync(join(dir, 'untracked.bin'), Buffer.from([0, 1, 2, 255, 0]));
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
  const artifacts = readdirSync(artifactsOf(ctx, attempt.id)).sort();

  const plan = await ctx.runner.cleanupWorktrees({ dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.removable, 2);
  assert.equal(plan.removed, 0);
  assert.ok(plan.reclaimedKb > 0, 'размер показан');
  const planned = entryFor(plan, dir)!;
  assert.equal(planned.action, 'remove');
  assert.equal(planned.uncommitted, 3, '.gitignore, README и неотслеживаемый файл');
  assert.equal(planned.head, head);
  assert.equal(planned.patch, undefined);
  assert.ok(existsSync(dir) && existsSync(integration), 'деревья на месте');
  assert.deepEqual(
    readdirSync(artifactsOf(ctx, attempt.id)).sort(),
    artifacts,
    'запись не сделана',
  );
  assert.equal(
    execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-only']).toString(),
    '',
    'индекс дерева не изменён',
  );

  const done = await ctx.runner.cleanupWorktrees();
  assert.equal(done.removed, 2);
  assert.equal(done.failed, 0);
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(integration), false);
  const branch = ctx.repo.git('rev-parse', `refs/heads/${branchOf(attempt.id)}`);
  assert.equal(branch, head, 'ветка попытки осталась');
  assert.doesNotMatch(ctx.repo.git('worktree', 'list'), new RegExp(attempt.id), 'нет регистрации');

  const entry = entryFor(done, dir)!;
  const patch = entry.patch!;
  assert.equal(patch, join(artifactsOf(ctx, attempt.id), `uncommitted-${attempt.id}.patch`));
  assert.ok(existsSync(join(artifactsOf(ctx, attempt.id), `worktree-cleanup-${attempt.id}.json`)));
  assert.equal(entryFor(done, integration)!.patch, undefined, 'чистому дереву патч не нужен');
  assert.doesNotMatch(readFileSync(patch, 'utf8'), /dep\.js/, 'игнорируемые не входят');

  // Патч восстанавливает правки поверх той же вершины.
  const restored = mkdtempSync(join(tmpdir(), 'harness-restored-'));
  ctx.repo.git('worktree', 'add', '-q', '--detach', restored, head);
  execFileSync('git', ['-C', restored, 'apply', '--index', patch]);
  assert.equal(readFileSync(join(restored, 'README.md'), 'utf8'), 'edited\n');
  assert.deepEqual([...readFileSync(join(restored, 'untracked.bin'))], [0, 1, 2, 255, 0]);
  ctx.repo.git('worktree', 'remove', '--force', restored);

  const again = await ctx.runner.cleanupWorktrees();
  assert.deepEqual(
    [again.removed, again.refused, again.worktrees.length],
    [0, 0, 0],
    'идемпотентно',
  );
});

test('worktree-cleanup: идущая попытка отказывается, а закончившаяся рядом убирается', async () => {
  const hold = join(mkdtempSync(join(tmpdir(), 'harness-hold-')), 'release');
  const ctx = setup({
    scenario: { writer: { ...implement(), holdUntil: hold }, reviewer: approve() },
  });
  const running = runAll(ctx);
  const started = `${ctx.scenarioPath}.writer.0.started`;
  while (!existsSync(started)) await new Promise((r) => setTimeout(r, 20));
  const attempt = attemptOf(ctx);
  const result = await ctx.runner.cleanupWorktrees();
  const entry = entryFor(result, attempt.worktree!)!;
  assert.equal(entry.action, 'refused');
  assert.equal(entry.reason, 'active');
  assert.ok(existsSync(attempt.worktree!), 'дерево идущей попытки на месте');
  writeFileSync(hold, '');
  await running;
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
    'работа дошла до конца',
  );
});

test('worktree-cleanup: последняя попытка незакрытой работы восстановима; после закрытия убирается', async () => {
  const never = join(mkdtempSync(join(tmpdir(), 'harness-hold-')), 'never');
  const ctx = setup({
    scenario: { writer: { ...implement(), holdUntil: never }, reviewer: approve() },
  });
  await ctx.runner.init();
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(planReview(ctx.engine, graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  await ctx.runner.tick();
  while (!existsSync(`${ctx.scenarioPath}.writer.0.started`))
    await new Promise((r) => setTimeout(r, 20));
  // Штатная остановка: работа снова в очереди, следующая попытка продолжит её.
  await ctx.runner.stop();
  const first = attemptOf(ctx);
  assert.notEqual(first.status, 'active');
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'ready',
  );
  ctx.repo.git('worktree', 'add', '-q', '--detach', first.worktree!, first.baseSha!);
  const refused = await ctx.runner.cleanupWorktrees();
  assert.equal(entryFor(refused, first.worktree!)?.reason, 'recoverable');
  assert.ok(existsSync(first.worktree!));

  ctx.engine.cancel('add-greeting');
  const done = await ctx.runner.cleanupWorktrees();
  assert.equal(entryFor(done, first.worktree!)?.action, 'removed', 'работа закрыта');
  assert.equal(existsSync(first.worktree!), false);
});

test('worktree-cleanup: незавершённая очистка, чужое дерево, подменённый .git и вложенный репозиторий не удаляются', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  await runAll(ctx);
  const { attempt, dir } = retain(ctx);
  const artifacts = artifactsOf(ctx, attempt.id);
  const pending = join(artifacts, 'cleanup-pending.json');

  writeFileSync(
    pending,
    JSON.stringify({ reason: 'cleanup-failed', worktrees: [], snapshots: [] }),
  );
  assert.equal(
    entryFor(await ctx.runner.cleanupWorktrees(), dir)?.reason,
    'cleanup-pending',
    'дерево — вход cleanup --run',
  );
  writeFileSync(pending, JSON.stringify({ reason: 'remove-failed', worktrees: [], snapshots: [] }));
  const receipt = join(artifacts, 'environment.json');
  writeFileSync(receipt, JSON.stringify({ status: 'active', cwd: dir }));
  assert.equal(entryFor(await ctx.runner.cleanupWorktrees(), dir)?.reason, 'cleanup-pending');
  writeFileSync(receipt, JSON.stringify({ status: 'done', cwd: dir }));

  const foreign = join(dir, '..', 'not-an-attempt');
  ctx.repo.git('worktree', 'add', '-q', '--detach', foreign, 'HEAD');

  const gitFile = join(dir, '.git');
  const original = readFileSync(gitFile, 'utf8');
  mkdirSync(join(dir, 'evil'));
  writeFileSync(gitFile, `gitdir: ${join(dir, 'evil')}\n`);
  const tampered = await ctx.runner.cleanupWorktrees();
  assert.equal(entryFor(tampered, dir)?.reason, 'untrusted');
  assert.equal(entryFor(tampered, foreign)?.reason, 'unknown-attempt');
  assert.ok(existsSync(dir) && existsSync(foreign));
  writeFileSync(gitFile, original);

  const nested = join(dir, 'vendor-copy');
  mkdirSync(nested);
  execFileSync('git', ['init', '-q'], { cwd: nested });
  writeFileSync(join(nested, 'work.txt'), 'only here\n');
  execFileSync('git', ['add', '-A'], { cwd: nested });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'nested'], {
    cwd: nested,
  });
  const embedded = await ctx.runner.cleanupWorktrees();
  assert.equal(entryFor(embedded, dir)?.reason, 'embedded-repository');
  assert.ok(existsSync(join(nested, 'work.txt')), 'содержимое вложенного репозитория на месте');
  assert.deepEqual(
    readdirSync(artifacts).filter((name) => name.startsWith('uncommitted-')),
    [],
    'неполный патч не остаётся',
  );
  ctx.repo.git('worktree', 'remove', '--force', foreign);
});
