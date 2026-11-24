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

test('ревью 2: обычный кандидат — коммит на ветке попытки с родителем-базой, HEAD не трогается', async () => {
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
  });
  const base = target(ctx);
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  assert.equal(ctx.repo.git('rev-parse', `${a.candidateSha}^`), base);
  assert.equal(ctx.repo.git('rev-parse', `harness/run-${a.id}`), a.candidateSha);
});
