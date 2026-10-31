/**
 * `worktree-cleanup` на настоящем Git: попытки проходят через Runner, оставшееся
 * рабочее дерево восстанавливается так, как его оставляет упавший процесс.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner } from '../src/engine/runner.ts';
import { lockCleanup, savePatch } from '../src/engine/worktree-cleanup.ts';
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
const commit = (dir: string, message: string) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message], {
    cwd: dir,
  });
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
  execFileSync('git', ['add', '.gitignore'], { cwd: dir });
  commit(dir, 'ignore dependencies');
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
  assert.equal(planned.uncommitted, 2, 'README и неотслеживаемый файл');
  assert.deepEqual(planned.ignored, { count: 1, paths: ['node_modules'] }, 'игнорируемое названо');
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
  rmSync(pending);

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
  commit(nested, 'nested');
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

/* ---------------- Что нельзя потерять: дерево остаётся, отказ назван ---------------- */

async function finished() {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  await runAll(ctx);
  return { ctx, ...retain(ctx) };
}
const inTree = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
function nestedRepo(path: string) {
  mkdirSync(path, { recursive: true });
  inTree(path, 'init', '-q');
  writeFileSync(join(path, 'work.txt'), 'only here\n');
  inTree(path, 'add', '-A');
  commit(path, 'nested');
}
async function assertRefused(ctx: Ctx, dir: string, reason: string) {
  const plan = await ctx.runner.cleanupWorktrees({ dryRun: true });
  assert.equal(entryFor(plan, dir)?.reason, reason, 'dry run называет отказ');
  const done = await ctx.runner.cleanupWorktrees();
  const entry = entryFor(done, dir)!;
  assert.equal(entry.action, 'refused');
  assert.equal(entry.reason, reason);
  assert.equal(done.removed, 0);
  assert.ok(existsSync(join(dir, '.git')), 'дерево на месте');
  return entry;
}
const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
/** `git` на PATH с вмешательством в один шаг; остальное — настоящий git. */
function shimGit(step: string) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-git-shim-'));
  writeFileSync(join(dir, 'git'), `#!/bin/bash\n${step}\nexec ${JSON.stringify(realGit)} "$@"\n`, {
    mode: 0o755,
  });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  return () => {
    process.env.PATH = path;
  };
}

test('worktree-cleanup H1: вложенный репозиторий в игнорируемом каталоге — отказ, хотя правок нет', async () => {
  const { ctx, dir } = await finished();
  writeFileSync(join(dir, '.gitignore'), 'vendor/\n');
  inTree(dir, 'add', '.gitignore');
  commit(dir, 'ignore vendor');
  nestedRepo(join(dir, 'vendor', 'lib'));
  const entry = await assertRefused(ctx, dir, 'embedded-repository');
  assert.equal(entry.patch, undefined);
  assert.ok(existsSync(join(dir, 'vendor/lib/work.txt')));
});

test('worktree-cleanup H1: чистый gitlink и грязный вместе с обычной правкой — отказ', async () => {
  const { ctx, dir } = await finished();
  nestedRepo(join(dir, 'sub'));
  inTree(dir, 'add', 'sub');
  commit(dir, 'gitlink');
  await assertRefused(ctx, dir, 'embedded-repository');
  writeFileSync(join(dir, 'sub', 'work.txt'), 'uncommitted in sub\n');
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  await assertRefused(ctx, dir, 'embedded-repository');
});

test('worktree-cleanup H1: gitlink индекса без каталога .git виден по индексу', async () => {
  const { ctx, dir } = await finished();
  const sha = inTree(dir, 'rev-parse', 'HEAD');
  inTree(dir, 'update-index', '--add', '--cacheinfo', `160000,${sha},sub`);
  mkdirSync(join(dir, 'sub'));
  await assertRefused(ctx, dir, 'embedded-repository');
});

test('worktree-cleanup H1: .git файлом, голый репозиторий и репозиторий в node_modules — отказ', async () => {
  for (const make of [
    (dir: string) => {
      mkdirSync(join(dir, 'linked'));
      writeFileSync(join(dir, 'linked', '.git'), 'gitdir: /elsewhere\n');
    },
    (dir: string) => inTree(dir, 'init', '-q', '--bare', join(dir, 'mirror')),
    (dir: string) => nestedRepo(join(dir, 'node_modules', 'patched-dep')),
  ]) {
    const { ctx, dir } = await finished();
    make(dir);
    await assertRefused(ctx, dir, 'embedded-repository');
  }
});

test('worktree-cleanup H1: обход до предела и нечитаемый каталог не доказывают чистоту — отказ', async () => {
  const { ctx, dir } = await finished();
  const limit = Runner.cleanupScanLimit;
  Runner.cleanupScanLimit = 2;
  try {
    await assertRefused(ctx, dir, 'scan-limit');
  } finally {
    Runner.cleanupScanLimit = limit;
  }
  const closed = join(dir, 'closed');
  mkdirSync(closed);
  chmodSync(closed, 0);
  try {
    await assertRefused(ctx, dir, 'scan-failed');
  } finally {
    chmodSync(closed, 0o755);
  }
});

test('worktree-cleanup H2: вывод больше 2 МБ не обрезается ни в подсчёте, ни в проверке вложенного репозитория', async () => {
  const { ctx, dir } = await finished();
  const deep = join('zz', 'a'.repeat(120), 'b'.repeat(120));
  mkdirSync(join(dir, deep), { recursive: true });
  const files = 11000;
  for (let n = 0; n < files; n++) writeFileSync(join(dir, deep, `file-${n}.txt`), String(n));
  writeFileSync(join(dir, 'aaa-first.txt'), 'sorted first\n');
  const plan = await ctx.runner.cleanupWorktrees({ dryRun: true });
  assert.equal(entryFor(plan, dir)?.uncommitted, files + 1, 'число правок точное');
  // Обход дерева перехватил бы репозиторий раньше: проверка сохранения патча — сама по себе.
  const nested = join(dir, 'aaa-nested');
  nestedRepo(nested);
  const artifacts = mkdtempSync(join(tmpdir(), 'harness-artifacts-'));
  assert.deepEqual(
    await savePatch(dir, artifacts, 'uncommitted-x', inTree(dir, 'rev-parse', 'HEAD')),
    {
      refusal: 'embedded-repository',
    },
  );
  assert.deepEqual(readdirSync(artifacts), [], 'патча нет');
  rmSync(nested, { recursive: true });
  const done = await ctx.runner.cleanupWorktrees();
  const entry = entryFor(done, dir)!;
  assert.equal(entry.action, 'removed', entry.error);
  assert.match(
    readFileSync(entry.patch!, 'utf8').slice(0, 2000),
    /aaa-first/,
    'начало вывода цело',
  );
});

test('worktree-cleanup H3: .gitignore из одной звезды не прячет работу', async () => {
  const { ctx, dir } = await finished();
  writeFileSync(join(dir, '.gitignore'), '*\n');
  writeFileSync(join(dir, 'new-module.js'), 'valuable uncommitted\n');
  await assertRefused(ctx, dir, 'ignore-rules-changed');
  assert.ok(existsSync(join(dir, 'new-module.js')));
});

test('worktree-cleanup H3: изменённый, удалённый и вложенный .gitignore — отказ', async () => {
  const { ctx, dir } = await finished();
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  inTree(dir, 'add', '.gitignore');
  commit(dir, 'ignore dist');
  writeFileSync(join(dir, '.gitignore'), 'dist/\nsecret-work/\n');
  await assertRefused(ctx, dir, 'ignore-rules-changed');
  rmSync(join(dir, '.gitignore'));
  await assertRefused(ctx, dir, 'ignore-rules-changed');
  inTree(dir, 'checkout', '--', '.gitignore');
  mkdirSync(join(dir, 'newdir'));
  writeFileSync(join(dir, 'newdir', '.gitignore'), '*\n');
  writeFileSync(join(dir, 'newdir', 'work.txt'), 'hidden by its own rule\n');
  await assertRefused(ctx, dir, 'ignore-rules-changed');
});

test('worktree-cleanup H3: правило info/exclude, скрывающее путь в дереве, — отказ; правило без пути не мешает', async () => {
  const { ctx, dir } = await finished();
  const exclude = join(ctx.repo.dir, '.git', 'info', 'exclude');
  writeFileSync(exclude, '# comment\n.DS_Store\nsecret-work/\n');
  assert.equal(
    entryFor(await ctx.runner.cleanupWorktrees({ dryRun: true }), dir)?.action,
    'remove',
    'правила шаблона git без своих путей не отказывают',
  );
  mkdirSync(join(dir, 'secret-work'));
  writeFileSync(join(dir, 'secret-work', 'notes.txt'), 'hidden by exclude\n');
  await assertRefused(ctx, dir, 'ignore-rules-changed');
  assert.ok(existsSync(join(dir, 'secret-work', 'notes.txt')));
});

test('worktree-cleanup H3: .gitignore пакета внутри игнорируемого каталога не мешает; .env назван в отчёте', async () => {
  const { ctx, dir } = await finished();
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.env\n');
  inTree(dir, 'add', '.gitignore');
  commit(dir, 'ignore');
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', '.gitignore'), '*\n');
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  const plan = entryFor(await ctx.runner.cleanupWorktrees({ dryRun: true }), dir)!;
  assert.equal(plan.action, 'remove');
  assert.deepEqual(plan.ignored, { count: 2, paths: ['.env', 'node_modules'] });
  const done = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
  assert.equal(done.action, 'removed', done.error);
  assert.deepEqual(done.ignored, { count: 2, paths: ['.env', 'node_modules'] });
});

test('worktree-cleanup: assume-unchanged и skip-worktree прячут правку от статуса — отказ', async () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const { ctx, dir } = await finished();
    inTree(dir, 'update-index', flag, 'README.md');
    writeFileSync(join(dir, 'README.md'), 'hidden edit\n');
    await assertRefused(ctx, dir, 'hidden-changes');
  }
});

test('worktree-cleanup H4: --dry-run не пишет каталог состояния', async () => {
  const { ctx, dir } = await finished();
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  writeFileSync(
    join(ctx.state, 'binding.json'),
    JSON.stringify({ policy: ctx.policy, baseDir: ctx.repo.dir }),
  );
  ctx.store.close();
  const stateFile = join(ctx.state, 'state.sqlite');
  const wal = () => (existsSync(`${stateFile}-wal`) ? statSync(`${stateFile}-wal`).size : 0);
  const look = () => ({
    wal: wal(),
    sha: createHash('sha256').update(readFileSync(stateFile)).digest('hex'),
    mtime: statSync(stateFile).mtimeMs,
  });
  const before = look();
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      cli,
      'worktree-cleanup',
      '--state',
      ctx.state,
      '--dry-run',
    ],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal((JSON.parse(r.stdout) as { data: { removable: number } }).data.removable, 1);
  // Читатель WAL-базы создаёт пустые служебные -wal и -shm; записей в них нет.
  assert.deepEqual(look(), before);
});

test('worktree-cleanup H5: сохранённый патч не перезаписывается и не удаляется', async () => {
  const { ctx, dir, attempt } = await finished();
  const artifacts = artifactsOf(ctx, attempt.id);
  const first = join(artifacts, `uncommitted-${attempt.id}.patch`);
  writeFileSync(first, 'precious earlier patch\n');
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  const entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
  assert.equal(entry.action, 'removed', entry.error);
  assert.equal(entry.patch, join(artifacts, `uncommitted-${attempt.id}-2.patch`));
  assert.equal(readFileSync(first, 'utf8'), 'precious earlier patch\n');
  assert.deepEqual(
    readdirSync(artifacts).filter((name) => name.endsWith('.tmp')),
    [],
    'временных файлов нет',
  );
});

test('worktree-cleanup H5: отказ сохранения не трогает прежний патч', async () => {
  const { ctx, dir, attempt } = await finished();
  const first = join(artifactsOf(ctx, attempt.id), `uncommitted-${attempt.id}.patch`);
  writeFileSync(first, 'precious earlier patch\n');
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  const restore = shimGit('for a in "$@"; do [ "$a" = apply ] && exit 1; done');
  try {
    const entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
    assert.equal(entry.reason, 'patch-unusable');
  } finally {
    restore();
  }
  assert.equal(readFileSync(first, 'utf8'), 'precious earlier patch\n');
});

test('worktree-cleanup H5: одновременные запуски на один каталог состояния — второй отказывает', async () => {
  const { ctx, dir } = await finished();
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  const [first, second] = await Promise.allSettled([
    ctx.runner.cleanupWorktrees(),
    ctx.runner.cleanupWorktrees(),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.ok(second.status === 'rejected');
  assert.equal((second.reason as { code: string }).code, 'NOT_READY');
  assert.equal(existsSync(join(ctx.state, 'worktree-cleanup.lock')), false, 'замок снят');
  // Замок умершего процесса не держит очистку.
  const dead = spawnSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' });
  writeFileSync(join(ctx.state, 'worktree-cleanup.lock'), dead.stdout.trim());
  assert.equal((await ctx.runner.cleanupWorktrees()).failed, 0);
});

test('worktree-cleanup H5: удаление большого дерева идёт со своим пределом', async () => {
  assert.ok(Runner.cleanupRemovalMs > 120000, 'длиннее предела команды по умолчанию');
  const { ctx, dir } = await finished();
  const limit = Runner.cleanupRemovalMs;
  Runner.cleanupRemovalMs = 200;
  const restore = shimGit('for a in "$@"; do [ "$a" = remove ] && exec sleep 30; done');
  try {
    const entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
    assert.equal(entry.action, 'failed');
    assert.equal(entry.removalStarted, true);
  } finally {
    restore();
    Runner.cleanupRemovalMs = limit;
  }
  assert.ok(existsSync(dir));
});

test('worktree-cleanup H6: вершина, недостижимая из ref, — отказ: коммит не пропадёт после gc', async () => {
  const { ctx, dir } = await finished();
  inTree(dir, 'checkout', '-q', '--detach');
  writeFileSync(join(dir, 'committed.txt'), 'committed on detached head\n');
  inTree(dir, 'add', '-A');
  commit(dir, 'detached work');
  const sha = inTree(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  await assertRefused(ctx, dir, 'unreachable-head');
  inTree(ctx.repo.dir, 'cat-file', '-e', sha);
});

test('worktree-cleanup H7: настройки пользователя не меняют формат патча; патч применяется', async () => {
  const { ctx, dir } = await finished();
  const config = join(mkdtempSync(join(tmpdir(), 'harness-gitconfig-')), 'gitconfig');
  writeFileSync(
    config,
    '[color]\n\tui = always\n[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n\tcontext = 0\n',
  );
  const head = inTree(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  let patch: string;
  try {
    patch = entryFor(await ctx.runner.cleanupWorktrees(), dir)!.patch!;
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
  assert.match(readFileSync(patch, 'utf8'), /^diff --git a\/README.md b\/README.md/);
  const restored = mkdtempSync(join(tmpdir(), 'harness-restored-'));
  ctx.repo.git('worktree', 'add', '-q', '--detach', restored, head);
  execFileSync('git', ['apply', '--index', patch], { cwd: restored });
  assert.equal(readFileSync(join(restored, 'README.md'), 'utf8'), 'edited\n');
  ctx.repo.git('worktree', 'remove', '--force', restored);
});

test('worktree-cleanup H7: патч, не дающий то же дерево, — отказ, патча нет', async () => {
  // Наложение падает, либо проходит, но ничего не меняет: важен результат, а не код выхода.
  for (const answer of ['exit 1', 'exit 0']) {
    const { ctx, dir, attempt } = await finished();
    writeFileSync(join(dir, 'README.md'), 'edited\n');
    const restore = shimGit(`for a in "$@"; do [ "$a" = apply ] && ${answer}; done`);
    try {
      const entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
      assert.equal(entry.reason, 'patch-unusable', answer);
      assert.equal(entry.action, 'refused');
    } finally {
      restore();
    }
    assert.ok(existsSync(dir));
    assert.deepEqual(
      readdirSync(artifactsOf(ctx, attempt.id)).filter((n) => n.startsWith('uncommitted-')),
      [],
    );
  }
});

test('worktree-cleanup H8: каталог только для чтения — отказ до удаления, дерево цело', async () => {
  const { ctx, dir } = await finished();
  const readOnly = join(dir, 'ro');
  mkdirSync(readOnly);
  writeFileSync(join(readOnly, 'x'), 'x');
  chmodSync(readOnly, 0o555);
  try {
    await assertRefused(ctx, dir, 'read-only-path');
  } finally {
    chmodSync(readOnly, 0o755);
  }
});

test('worktree-cleanup H8: оборванное удаление — истинное состояние, указатель на патч, повтор не трогает дерево', async () => {
  const { ctx, dir, attempt } = await finished();
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  const admin = join(ctx.repo.dir, '.git', 'worktrees', attempt.id);
  const recordPath = join(artifactsOf(ctx, attempt.id), `worktree-cleanup-${attempt.id}.json`);
  const atRemoval = join(ctx.state, 'record-at-removal.json');
  const restore = shimGit(
    `for a in "$@"; do [ "$a" = remove ] && { cp ${JSON.stringify(recordPath)} ${JSON.stringify(atRemoval)}; rm -f ${JSON.stringify(join(dir, 'README.md'))}; rm -rf ${JSON.stringify(admin)}; echo "error: failed to delete" >&2; exit 1; }; done`,
  );
  let entry;
  try {
    entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
  } finally {
    restore();
  }
  assert.equal(entry.action, 'failed');
  assert.equal(entry.removalStarted, true);
  assert.equal(entry.registered, false, 'регистрации уже нет');
  assert.equal(entry.treePresent, true, 'часть дерева осталась');
  assert.ok(existsSync(entry.patch!));
  const recorded = (path: string) => {
    const { status, patch } = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    return [status, patch];
  };
  assert.deepEqual(recorded(atRemoval), ['removing', entry.patch], 'записано до удаления');
  assert.deepEqual(recorded(recordPath), ['incomplete', entry.patch]);

  const again = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
  assert.equal(again.action, 'refused', 'дерево без регистрации всё ещё названо');
  assert.equal(again.reason, 'removal-incomplete');
  assert.equal(again.patch, entry.patch);
  assert.equal(again.record, recordPath, 'запись названа: её снимают вручную');
  assert.equal(again.head, entry.head, 'патч применяется поверх этой вершины');
  assert.ok(existsSync(dir));
});

test('worktree-cleanup H8: процесс умер посреди удаления — запись держит дерево', async () => {
  const { ctx, dir, attempt } = await finished();
  writeFileSync(
    join(artifactsOf(ctx, attempt.id), `worktree-cleanup-${attempt.id}.json`),
    JSON.stringify({ status: 'removing', patch: '/saved/edits.patch', head: 'pinned-head' }),
  );
  const entry = await assertRefused(ctx, dir, 'removal-incomplete');
  assert.equal(entry.patch, '/saved/edits.patch');
  assert.equal(entry.head, 'pinned-head');
});

test('worktree-cleanup H8: дерево без регистрации и без записи — отказ', async () => {
  const { ctx, dir, attempt } = await finished();
  rmSync(join(ctx.repo.dir, '.git', 'worktrees', attempt.id), { recursive: true });
  const entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
  assert.equal(entry.reason, 'not-registered');
  assert.ok(existsSync(dir));
});

test('worktree-cleanup H9: нечитаемая запись очистки — отказ этой попытки, сводка возвращается', async () => {
  for (const file of ['cleanup-pending.json', 'environment.json']) {
    const { ctx, dir, attempt } = await finished();
    writeFileSync(join(artifactsOf(ctx, attempt.id), file), '{oops');
    const result = await ctx.runner.cleanupWorktrees();
    assert.equal(entryFor(result, dir)?.reason, 'cleanup-unreadable');
    assert.equal(result.refused, 1);
    assert.ok(existsSync(dir));
  }
});

/** Дерево попытки с отсоединённой вершиной, которую держит только сама работа. */
async function detachedWork() {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  await runAll(ctx);
  const attempt = attemptOf(ctx);
  const dir = attempt.worktree!;
  ctx.repo.git('worktree', 'add', '-q', '--detach', dir, branchOf(attempt.id));
  writeFileSync(join(dir, 'work.txt'), 'precious\n');
  inTree(dir, 'add', 'work.txt');
  commit(dir, 'detached work');
  return { ctx, dir, sha: inTree(dir, 'rev-parse', 'HEAD') };
}

test('worktree-cleanup: ref рабочего дерева не держит вершину — он исчезнет вместе с деревом', async () => {
  for (const ref of ['refs/worktree/keep', 'refs/bisect/bad', 'refs/rewritten/step']) {
    const { ctx, dir, sha } = await detachedWork();
    inTree(dir, 'update-ref', ref, sha);
    await assertRefused(ctx, dir, 'unreachable-head');
    inTree(ctx.repo.dir, 'cat-file', '-e', sha);
  }
});

test('worktree-cleanup: ref рабочего дерева основного checkout тоже не считается общим', async () => {
  const { ctx, dir, sha } = await detachedWork();
  inTree(ctx.repo.dir, 'update-ref', 'refs/bisect/bad', sha);
  await assertRefused(ctx, dir, 'unreachable-head');
});

test('worktree-cleanup: ref общего репозитория держит вершину', async () => {
  const { ctx, dir, sha } = await detachedWork();
  inTree(dir, 'update-ref', 'refs/heads/kept', sha);
  const entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
  assert.equal(entry.action, 'removed', entry.error);
  assert.equal(entry.head, sha);
  assert.equal(inTree(ctx.repo.dir, 'rev-parse', 'refs/heads/kept'), sha);
});

test('worktree-cleanup: вершина читается в самом дереве, а не из общего списка', async () => {
  const { ctx, dir } = await finished();
  inTree(dir, 'checkout', '-q', '--detach');
  const flag = join(ctx.state, 'once');
  const restore = shimGit(
    `if [[ " $* " == *" worktree list "* ]] && [ ! -e ${JSON.stringify(flag)} ]; then touch ${JSON.stringify(flag)}; "${realGit}" "$@"; cd ${JSON.stringify(dir)}; echo late > late.txt; "${realGit}" add late.txt; "${realGit}" -c user.name=t -c user.email=t@t commit -qm late; exit 0; fi`,
  );
  try {
    const entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
    assert.equal(entry.reason, 'unreachable-head', 'коммит после списка деревьев виден');
  } finally {
    restore();
  }
  assert.ok(existsSync(join(dir, 'late.txt')));
});

test('worktree-cleanup: коммит и файл, появившиеся после проверок, — отказ tree-changed', async () => {
  for (const late of [
    `echo late > late.txt; "${realGit}" add late.txt; "${realGit}" -c user.name=t -c user.email=t@t commit -qm late`,
    'echo late > late.txt',
  ]) {
    const { ctx, dir } = await finished();
    const flag = join(ctx.state, 'once');
    const restore = shimGit(
      `if [[ " $* " == *" ls-tree "* ]] && [ ! -e ${JSON.stringify(flag)} ]; then touch ${JSON.stringify(flag)}; ( cd ${JSON.stringify(dir)}; ${late} ); fi`,
    );
    try {
      const entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
      assert.equal(entry.reason, 'tree-changed', late);
      assert.equal(entry.action, 'refused');
    } finally {
      restore();
    }
    assert.ok(existsSync(join(dir, 'late.txt')));
  }
});

test('worktree-cleanup: новая правка уже изменённого файла, статус тот же, — отказ tree-changed', async () => {
  const { ctx, dir } = await finished();
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  const flag = join(ctx.state, 'once');
  const restore = shimGit(
    `if [[ " $* " == *" apply "* ]] && [ ! -e ${JSON.stringify(flag)} ]; then touch ${JSON.stringify(flag)}; echo more >> ${JSON.stringify(join(dir, 'README.md'))}; fi`,
  );
  try {
    assert.equal(entryFor(await ctx.runner.cleanupWorktrees(), dir)?.reason, 'tree-changed');
  } finally {
    restore();
  }
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /more/);
});

test('worktree-cleanup: патч строится от закреплённой вершины, даже если HEAD сдвинулся', async () => {
  const { ctx, dir } = await finished();
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  const pinned = inTree(dir, 'rev-parse', 'HEAD');
  const flag = join(ctx.state, 'once');
  const restore = shimGit(
    `if [[ " $* " == *" read-tree "* ]] && [ ! -e ${JSON.stringify(flag)} ]; then touch ${JSON.stringify(flag)}; ( cd ${JSON.stringify(dir)}; echo late > late.txt; "${realGit}" add late.txt; "${realGit}" -c user.name=t -c user.email=t@t commit -qm late ); fi`,
  );
  let entry;
  try {
    entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
  } finally {
    restore();
  }
  assert.equal(entry.reason, 'tree-changed');
  assert.equal(entry.head, pinned);
  const text = readFileSync(entry.patch!, 'utf8');
  assert.match(text, /late\.txt/, 'патч от закреплённой вершины содержит и поздний файл');
});

test('worktree-cleanup: запертое дерево отказывает сразу, записи нет; после unlock убирается', async () => {
  const { ctx, dir, attempt } = await finished();
  inTree(ctx.repo.dir, 'worktree', 'lock', dir);
  await assertRefused(ctx, dir, 'worktree-locked');
  assert.equal(
    existsSync(join(artifactsOf(ctx, attempt.id), `worktree-cleanup-${attempt.id}.json`)),
    false,
    'removal-incomplete не наступает',
  );
  inTree(ctx.repo.dir, 'worktree', 'unlock', dir);
  assert.equal(entryFor(await ctx.runner.cleanupWorktrees(), dir)?.action, 'removed');
});

test('worktree-cleanup: путь под настроенным clean-фильтром — отказ; без пути фильтр не мешает', async () => {
  const { ctx, dir } = await finished();
  ctx.repo.git('config', 'filter.drop.clean', 'cat >/dev/null');
  assert.equal(
    entryFor(await ctx.runner.cleanupWorktrees({ dryRun: true }), dir)?.action,
    'remove',
    'настройка без пути ничего не значит',
  );
  writeFileSync(join(dir, 'notes.txt'), 'plain\n');
  writeFileSync(join(dir, '.gitattributes'), 'notes.txt filter=unconfigured\n');
  assert.equal(
    entryFor(await ctx.runner.cleanupWorktrees({ dryRun: true }), dir)?.action,
    'remove',
    'атрибут без настроенного фильтра ничего не значит',
  );
  writeFileSync(join(dir, '.gitattributes'), 'secret.txt filter=drop\n');
  writeFileSync(join(dir, 'secret.txt'), 'precious\n');
  await assertRefused(ctx, dir, 'clean-filter');
  assert.equal(readFileSync(join(dir, 'secret.txt'), 'utf8'), 'precious\n');
});

test('worktree-cleanup: имя, которое нельзя передать git байт в байт, — отказ', async () => {
  const { ctx, dir } = await finished();
  writeFileSync(join(dir, 'broken-\uFFFD-name'), 'x');
  await assertRefused(ctx, dir, 'undecodable-path');
});

test('worktree-cleanup: отказ последней записи не лишает ответ истинного состояния', async () => {
  const { ctx, dir, attempt } = await finished();
  const artifacts = artifactsOf(ctx, attempt.id);
  const restore = shimGit(
    `if [[ " $* " == *" worktree remove "* ]]; then chmod 555 ${JSON.stringify(artifacts)}; fi`,
  );
  let entry;
  try {
    entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
  } finally {
    restore();
    chmodSync(artifacts, 0o755);
  }
  assert.equal(entry.action, 'failed');
  assert.equal(entry.removalStarted, true);
  assert.equal(entry.registered, false);
  assert.equal(entry.treePresent, false);
  assert.match(entry.error!, /запись не обновлена/);
});

test('worktree-cleanup: замок умершего процесса забирает ровно один из претендентов', async () => {
  const dead = spawnSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' });
  const file = join(mkdtempSync(join(tmpdir(), 'harness-lock-')), 'lock');
  for (let round = 0; round < 20; round++) {
    writeFileSync(file, dead.stdout.trim());
    const tries = await Promise.allSettled(Array.from({ length: 6 }, () => lockCleanup(file)));
    const held = tries.filter((t) => t.status === 'fulfilled');
    assert.equal(held.length, 1, `раунд ${round}`);
    await held[0]!.value();
    assert.equal(existsSync(file), false);
  }
});

test('worktree-cleanup: пустой замок, живой PID и файл захвата остаются и называют файл', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'harness-lock-')), 'lock');
  const busy = (e: unknown, path: string) => {
    const error = e as { code: string; message: string };
    return (
      error.code === 'NOT_READY' && error.message.includes(path) && /удалите/.test(error.message)
    );
  };
  for (const content of ['', String(process.pid)]) {
    writeFileSync(file, content);
    await assert.rejects(lockCleanup(file), (e) => busy(e, file));
    assert.equal(readFileSync(file, 'utf8'), content, 'замок не тронут');
  }
  writeFileSync(file, '999999');
  writeFileSync(`${file}.takeover`, '');
  await assert.rejects(lockCleanup(file), (e) => busy(e, `${file}.takeover`));
});

test('worktree-cleanup: снимается только свой замок', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'harness-lock-')), 'lock');
  const unlock = await lockCleanup(file);
  writeFileSync(file, 'another owner');
  await unlock();
  assert.equal(readFileSync(file, 'utf8'), 'another owner');
});

/** Дерево, где `build/` и `*.local` игнорируются правилами вершины. */
async function ignoringTree() {
  const found = await finished();
  writeFileSync(join(found.dir, '.gitignore'), 'build/\n*.local\n');
  inTree(found.dir, 'add', '.gitignore');
  commit(found.dir, 'ignore');
  return found;
}

test('worktree-cleanup: игнорируемый файл, добавленный в индекс через -f, — отказ; копия не теряется', async () => {
  for (const withEdit of [true, false]) {
    const { ctx, dir } = await ignoringTree();
    mkdirSync(join(dir, 'build'));
    writeFileSync(join(dir, 'build', 'only-copy.txt'), 'work in index\n');
    inTree(dir, 'add', '-f', 'build/only-copy.txt');
    if (withEdit) writeFileSync(join(dir, 'README.md'), 'edited\n');
    await assertRefused(ctx, dir, 'staged-ignored');
    assert.ok(existsSync(join(dir, 'build', 'only-copy.txt')));
  }
});

test('worktree-cleanup: добавленный через -f файл, удалённый с диска, остаётся отказом', async () => {
  const { ctx, dir } = await ignoringTree();
  writeFileSync(join(dir, 'x.local'), 'only in index\n');
  inTree(dir, 'add', '-f', 'x.local');
  rmSync(join(dir, 'x.local'));
  await assertRefused(ctx, dir, 'staged-ignored');
});

test('worktree-cleanup: игнорируемый файл, уже лежащий в вершине, не мешает', async () => {
  const { ctx, dir } = await ignoringTree();
  writeFileSync(join(dir, 'kept.local'), 'tracked\n');
  inTree(dir, 'add', '-f', 'kept.local');
  commit(dir, 'force added');
  writeFileSync(join(dir, 'kept.local'), 'edited\n');
  inTree(dir, 'add', '-f', 'kept.local');
  const entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
  assert.equal(entry.action, 'removed', entry.reason);
  assert.match(readFileSync(entry.patch!, 'utf8'), /\+edited/);
});

test('worktree-cleanup: проиндексированная версия, отличная и от вершины, и от файла, — отказ', async () => {
  // Новый файл (AM), изменённый файл (MM) и файл, удалённый с диска (AD).
  for (const after of [
    (dir: string) => writeFileSync(join(dir, 'n.txt'), 'worktree version\n'),
    (dir: string) => rmSync(join(dir, 'n.txt')),
  ]) {
    const { ctx, dir } = await finished();
    writeFileSync(join(dir, 'n.txt'), 'staged version\n');
    inTree(dir, 'add', 'n.txt');
    after(dir);
    await assertRefused(ctx, dir, 'staged-differs');
  }
  const { ctx, dir } = await finished();
  writeFileSync(join(dir, 'README.md'), 'staged version\n');
  inTree(dir, 'add', 'README.md');
  writeFileSync(join(dir, 'README.md'), 'worktree version\n');
  await assertRefused(ctx, dir, 'staged-differs');
});

test('worktree-cleanup: индекс, равный файлу дерева, и правка без индекса разрешены', async () => {
  const { ctx, dir } = await finished();
  writeFileSync(join(dir, 'n.txt'), 'staged and same\n');
  inTree(dir, 'add', 'n.txt');
  writeFileSync(join(dir, 'README.md'), 'not staged\n');
  const entry = entryFor(await ctx.runner.cleanupWorktrees(), dir)!;
  assert.equal(entry.action, 'removed', entry.reason);
  const text = readFileSync(entry.patch!, 'utf8');
  assert.match(text, /staged and same/);
  assert.match(text, /not staged/);
});

test('worktree-cleanup: файл с тем же содержимым, но новой меткой времени, — не отличие', async () => {
  const { ctx, dir } = await finished();
  const file = join(dir, 'n.txt');
  writeFileSync(file, 'same\n');
  inTree(dir, 'add', 'n.txt');
  await new Promise((r) => setTimeout(r, 1100));
  writeFileSync(file, 'same\n');
  const plan = entryFor(await ctx.runner.cleanupWorktrees({ dryRun: true }), dir)!;
  assert.equal(plan.action, 'remove', plan.reason);
});
