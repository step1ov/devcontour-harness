import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGatesAt, type GatesAtContext } from '../src/verification/gates-at.ts';
import type { EvidenceRecord } from '../src/contracts/index.ts';
import { greet, setup } from './runner-fixture.ts';
import { write } from './git-fixture.ts';

// Второй gate зависит от unit и проходит только в окружении integration этой
// проверки: так видно и порядок предпосылок, и фазу, и идентификатор.
const extra = `
const fs = require('fs');
const ok = process.env.DEVCONTOUR_PHASE === 'integration' && process.env.DEVCONTOUR_RUN_ID === 'GA-fixture';
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,
  '<testsuite><testcase classname="extra" name="phase">' + (ok ? '' : '<failure message="phase"/>') + '</testcase></testsuite>');
`;

function fixture() {
  const ctx = setup({
    scenario: {},
    files: { 'test/extra.js': extra },
    policy: (p) => {
      const repo = (p.repositories as { gates: unknown[] }[])[0]!;
      repo.gates.push({
        id: 'extra',
        kind: 'test',
        command: [process.execPath, 'test/extra.js'],
        report: { type: 'junit', path: 'test-results/extra.xml' },
        dependsOn: ['unit'],
      });
    },
  });
  const context: GatesAtContext = {
    policy: ctx.policy,
    stateDir: ctx.state,
    repoPath: () => ctx.repo.dir,
    boundary: () => ({ hidden: [ctx.state], readable: [join(ctx.repo.dir, '.git')] }),
    resourceDatabase: join(ctx.state, 'resources.sqlite'),
  };
  return { ctx, context };
}

test('gates на SHA вне попытки: предпосылки первыми, фаза integration, evidence на этом SHA через запись хоста, дерево убрано', async () => {
  const { ctx, context } = fixture();
  write(ctx.repo.dir, { 'src/greet.js': greet });
  ctx.repo.git('add', '-A');
  ctx.repo.git('commit', '-q', '-m', 'greet');
  const sha = ctx.repo.head();
  const recorded: EvidenceRecord[] = [];
  const result = await runGatesAt(context, {
    id: 'GA-fixture',
    repositoryId: 'app',
    sha,
    gates: ['extra'],
    record: (e) => recorded.push(e),
  });
  assert.equal(result.failure, undefined, JSON.stringify(result.evidence.map((e) => e.summary)));
  assert.deepEqual(result.gates, ['unit', 'extra'], 'предпосылка исполнена первой');
  assert.deepEqual(
    recorded.map((e) => [e.gate, e.kind, e.phase, e.sha, e.passed, e.runId]),
    [
      ['unit', 'test', 'integration', sha, true, 'GA-fixture'],
      ['extra', 'test', 'integration', sha, true, 'GA-fixture'],
    ],
  );
  assert.deepEqual(result.evidence, recorded, 'возвращено ровно записанное хостом');
  assert.ok(
    !existsSync(join(ctx.state, 'gates-at', 'GA-fixture', 'worktree')),
    'рабочее дерево проверки убрано',
  );
  assert.equal(
    ctx.repo
      .git('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree ')).length,
    1,
    'в репозитории не осталось рабочих деревьев проверки',
  );
});

test('gates на SHA: первый непрошедший gate записан и останавливает проверку; отказ записи хоста — отказ проверки', async () => {
  const { ctx, context } = fixture();
  // На первом коммите greet нет: unit падает.
  const sha = ctx.repo.head();
  const recorded: EvidenceRecord[] = [];
  const result = await runGatesAt(context, {
    id: 'GA-fixture',
    repositoryId: 'app',
    sha,
    gates: ['extra'],
    record: (e) => recorded.push(e),
  });
  assert.equal(result.failure?.gate, 'unit');
  assert.deepEqual(
    recorded.map((e) => [e.gate, e.passed]),
    [['unit', false]],
    'после провала предпосылки зависимый gate не исполняется',
  );
  write(ctx.repo.dir, { 'src/greet.js': greet });
  ctx.repo.git('add', '-A');
  ctx.repo.git('commit', '-q', '-m', 'greet');
  await assert.rejects(
    runGatesAt(context, {
      id: 'GA-fenced',
      repositoryId: 'app',
      sha: ctx.repo.head(),
      gates: ['unit'],
      record: () => {
        throw new Error('fencing: проверка больше не своя');
      },
    }),
    /fencing/,
  );
  await assert.rejects(
    runGatesAt(context, {
      repositoryId: 'app',
      sha: ctx.repo.head(),
      gates: ['nope'],
      record: () => {},
    }),
    /Gate nope не объявлен/,
  );
});
