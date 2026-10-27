import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGatesAt, type GatesAtContext } from '../src/verification/gates-at.ts';
import { explicitPrerequisites, gatePrerequisites } from '../src/verification/gate-scope.ts';
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

test('gates на SHA: провал предпосылки записан, зависимый gate не исполняется и назван; отказ записи хоста — отказ проверки', async () => {
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
    result.failures.map((f) => f.gate),
    ['unit', 'extra'],
  );
  assert.match(result.failures[1]!.message, /не прошла предпосылка unit/);
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

test('gates на SHA в режиме порядка массива: исполняются более ранние check gates (установка), не ранние тесты; все провалы — сразу', async () => {
  // Профиль без dependsOn: install первым, тесты опираются на его результат.
  const node = (script: string) => [process.execPath, '-e', script];
  const testGate = (id: string, ok: string) => ({
    id,
    kind: 'test',
    command: node(
      `const fs=require('fs');const ok=${ok};fs.mkdirSync('.reports',{recursive:true});fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="${id}">'+(ok?'':'<failure message="no"/>')+'</testcase></testsuite>');process.exit(ok?0:1)`,
    ),
    report: { type: 'junit', path: `.reports/${id}.xml` },
  });
  const ctx = setup({
    scenario: {},
    policy: (p) => {
      const repo = (p.repositories as { gates: unknown[] }[])[0]!;
      repo.gates = [
        {
          id: 'install',
          kind: 'check',
          command: node(
            "require('fs').mkdirSync('.deps',{recursive:true});require('fs').writeFileSync('.deps/ok','1')",
          ),
        },
        {
          id: 'lint',
          kind: 'check',
          command: node('process.exit(1)'),
        },
        testGate('early', 'false'),
        testGate('needs-install', "fs.existsSync('.deps/ok')"),
        testGate('broken', 'false'),
        testGate('also-needs-install', "fs.existsSync('.deps/ok')"),
      ];
    },
  });
  const context: GatesAtContext = {
    policy: ctx.policy,
    stateDir: ctx.state,
    repoPath: () => ctx.repo.dir,
    boundary: () => ({ hidden: [ctx.state], readable: [join(ctx.repo.dir, '.git')] }),
    resourceDatabase: join(ctx.state, 'resources.sqlite'),
  };
  assert.deepEqual(gatePrerequisites(ctx.policy.repositories[0]!.gates, 'broken'), [
    'install',
    'lint',
  ]);
  const sha = ctx.repo.head();
  const recorded: EvidenceRecord[] = [];
  const result = await runGatesAt(context, {
    id: 'GA-array',
    repositoryId: 'app',
    sha,
    gates: ['needs-install', 'broken', 'also-needs-install'],
    record: (e) => recorded.push(e),
  });
  assert.deepEqual(result.gates, [
    'install',
    'lint',
    'needs-install',
    'broken',
    'also-needs-install',
  ]);
  assert.deepEqual(
    recorded.map((e) => [e.gate, e.passed, e.sha]),
    [
      ['install', true, sha],
      ['lint', false, sha],
      ['needs-install', true, sha],
      ['broken', false, sha],
      ['also-needs-install', true, sha],
    ],
    'ранний тест не исполнен; провалы неявной предпосылки lint и broken не скрывают исход остальных',
  );
  assert.deepEqual(
    result.failures.map((f) => f.gate),
    ['lint', 'broken'],
  );
});

test('предпосылки gate: явный dependsOn (и пустой) — граф, без поля — ранние check gates; цепочки и петли через неявное ребро', () => {
  const g = (id: string, kind: 'check' | 'test', dependsOn?: string[]) => ({
    id,
    kind,
    ...(dependsOn ? { dependsOn } : {}),
  });
  // dependsOn на более поздний gate и неявное ребро к нему же: не зацикливается.
  assert.deepEqual(
    gatePrerequisites([g('A', 'check', ['B']), g('B', 'check'), g('T', 'test')], 'T'),
    ['A', 'B'],
  );
  // Пустой dependsOn — режим графа: предпосылок нет.
  assert.deepEqual(gatePrerequisites([g('install', 'check'), g('T', 'test', [])], 'T'), []);
  // Трёхуровневая цепочка dependsOn.
  assert.deepEqual(
    gatePrerequisites(
      [g('a', 'check', []), g('b', 'check', ['a']), g('c', 'check', ['b']), g('d', 'test', ['c'])],
      'd',
    ),
    ['a', 'b', 'c'],
  );
  // Двухуровневая цепочка dependsOn.
  assert.deepEqual(
    gatePrerequisites([g('a', 'check', []), g('b', 'check', ['a']), g('c', 'test', ['b'])], 'c'),
    ['a', 'b'],
  );
  assert.deepEqual(
    explicitPrerequisites(
      [g('a', 'check', []), g('b', 'check', ['a']), g('c', 'test', ['b'])],
      'c',
    ),
    ['a', 'b'],
  );
  assert.deepEqual(
    explicitPrerequisites(
      [g('setup', 'check'), g('early', 'test'), g('x', 'check'), g('t', 'test', ['x'])],
      't',
    ),
    ['x'],
    'неявные ранние check gates — не явные предпосылки',
  );
  // Смешанная: явная предпосылка без поля dependsOn тянет свои ранние check gates.
  assert.deepEqual(
    gatePrerequisites(
      [g('setup', 'check'), g('early', 'test'), g('x', 'check'), g('t', 'test', ['x'])],
      't',
    ),
    ['setup', 'x'],
  );
});
