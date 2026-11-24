/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тест правит сырой JSON политики до разбора схемой.
 */
/**
 * 0.1.0-alpha.70, ревью 2 (H1): запись кандидата controller не идёт через
 * HEAD дерева попытки. Исполнитель, переключивший дерево на ветку
 * владельца (`git checkout <target>`) или переписавший `commondir`, получает
 * засчитанное нарушение области; ветка владельца не двигается. Обычный
 * кандидат пишется commit-tree + update-ref ветки попытки.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/environment/process.ts';
import { captureGitMeta, commitCandidate } from '../src/engine/trusted-git.ts';
import { approve, greet, runAll, setup, target } from './runner-fixture.ts';

const WORK = 'add-greeting';

for (const [name, shell] of [
  ['git checkout на ветку владельца', 'git checkout -q harness/accepted'],
  ['переписанный commondir', 'echo /tmp/elsewhere > "$(git rev-parse --git-dir)/commondir"'],
] as const)
  test(`ревью 2: ${name} — нарушение области, ветка владельца на месте`, async () => {
    const ctx = setup({
      scenario: {
        writer: [
          {
            files: { 'src/greet.js': greet },
            shell,
            result: { completed: true, summary: 'Добавлена greet', discoveries: [] },
          },
        ],
        reviewer: approve(),
      },
      policy: (p: any) => (p.maxAttempts = 1),
    });
    const before = target(ctx);
    await runAll(ctx);
    const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
    assert.equal(a.failureKind, 'scope-violation', a.error);
    assert.match(a.error ?? '', /метаданные git попытки/);
    assert.equal(target(ctx), before, 'ветка владельца не сдвинута');
  });

test('ревью 2/4: обычный кандидат — коммит на ветке попытки с родителем-базой; после записи index дерева совпадает с HEAD', async () => {
  let checked: { status: string; diff: number | null } | undefined;
  const ctx = setup({
    scenario: {
      writer: [
        {
          files: { 'src/greet.js': greet },
          result: { completed: true, summary: 'ok', discoveries: [] },
        },
      ],
      reviewer: approve(),
    },
    runner: {
      hooks: {
        implemented: ({ attempt }) => {
          const cwd = ctx.engine.read((v) => v.attempt(attempt.id)!.worktree!);
          checked = {
            status: execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }),
            diff: spawnSync('git', ['-C', cwd, 'diff', '--exit-code', 'HEAD']).status,
          };
        },
      },
    },
  });
  const base = target(ctx);
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  assert.equal(ctx.repo.git('rev-parse', `${a.candidateSha}^`), base);
  assert.equal(ctx.repo.git('rev-parse', `harness/run-${a.id}`), a.candidateSha);
  assert.deepEqual(checked, { status: '', diff: 0 }, 'git status чист, git diff --exit-code — 0');
});

test('ревью 3: index дерева — ссылка на index владельца: нарушение области, staged-состояние владельца на месте', async () => {
  const ctx = setup({
    scenario: {
      writer: [
        {
          files: { 'src/greet.js': greet },
          shell:
            'idx="$(git rev-parse --git-dir)/index"; rm -f "$idx"; ln -s "$(git rev-parse --git-common-dir)/index" "$idx"',
          result: { completed: true, summary: 'ok', discoveries: [] },
        },
      ],
      reviewer: approve(),
    },
    policy: (p: any) => (p.maxAttempts = 1),
  });
  // У владельца — подготовленная к коммиту правка.
  writeFileSync(join(ctx.repo.dir, 'staged.txt'), 'owner\n');
  ctx.repo.git('add', 'staged.txt');
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(a.failureKind, 'scope-violation', a.error);
  assert.match(a.error ?? '', /index — символическая ссылка/);
  assert.equal(ctx.repo.git('diff', '--cached', '--name-only'), 'staged.txt');
});

test('ревью 3: config.worktree (extensions.worktreeConfig) с фильтром и core.worktree — нарушение области, фильтр не запускался', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'filter-marker-')), 'ran');
  const other = mkdtempSync(join(tmpdir(), 'other-tree-'));
  writeFileSync(join(other, 'secret.txt'), 'outside\n');
  const ctx = setup({
    scenario: {
      writer: [
        {
          files: { 'src/greet.js': greet, '.gitattributes': '* filter=x\n' },
          shell: `printf '[filter "x"]\\n\\tclean = touch ${marker}; cat\\n[core]\\n\\tworktree = ${other}\\n' > "$(git rev-parse --git-dir)/config.worktree"`,
          result: { completed: true, summary: 'ok', discoveries: [] },
        },
      ],
      reviewer: approve(),
    },
    policy: (p: any) => (p.maxAttempts = 1),
  });
  ctx.repo.git('config', 'extensions.worktreeConfig', 'true');
  const before = target(ctx);
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(a.failureKind, 'scope-violation', a.error);
  assert.match(a.error ?? '', /config\.worktree/);
  assert.equal(existsSync(marker), false, 'фильтр исполнителя не запускался на хосте');
  assert.equal(target(ctx), before);
});

test('ревью 3: assume-unchanged в index дерева не прячет правку вне области', async () => {
  const ctx = setup({
    scenario: {
      writer: [
        {
          files: { 'src/greet.js': greet },
          shell: 'git update-index --assume-unchanged README.md && echo hidden >> README.md',
          result: { completed: true, summary: 'ok', discoveries: [] },
        },
      ],
      reviewer: approve(),
    },
    policy: (p: any) => (p.maxAttempts = 1),
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(a.failureKind, 'scope-violation', a.error);
  assert.match(a.error ?? '', /README\.md/);
});

test('ревью 3: commitCandidate — ветка попытки двигается только с ожидаемым прежним значением (CAS)', async () => {
  const ctx = setup({ scenario: { writer: [], reviewer: [] } });
  const base = ctx.repo.git('rev-parse', 'HEAD');
  const dir = join(mkdtempSync(join(tmpdir(), 'cas-')), 'w');
  ctx.repo.git('worktree', 'add', '-q', '-b', 'harness/run-cas', dir, base);
  const meta = await captureGitMeta(dir, 'refs/heads/harness/run-cas');
  writeFileSync(join(dir, 'new.txt'), 'n\n');
  await git(dir, 'add', '-A');
  // Ветку попытки кто-то сдвинул: запись кандидата отказывает.
  writeFileSync(join(ctx.repo.dir, 'moved.txt'), 'm\n');
  ctx.repo.git('add', 'moved.txt');
  ctx.repo.git('commit', '-qm', 'moved');
  ctx.repo.git('update-ref', 'refs/heads/harness/run-cas', ctx.repo.git('rev-parse', 'HEAD'));
  await assert.rejects(commitCandidate(meta, base, 'c'), /but expected/);
  // С ожидаемым значением — коммит с родителем-базой, HEAD не используется.
  ctx.repo.git('update-ref', 'refs/heads/harness/run-cas', base);
  const sha = await commitCandidate(meta, base, 'c');
  assert.equal(ctx.repo.git('rev-parse', `${sha}^`), base);
  assert.equal(ctx.repo.git('rev-parse', 'harness/run-cas'), sha);
  // Index дерева совпадает с записанным кандидатом.
  assert.equal(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});
