import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGatesAt, type GatesAtContext } from '../src/verification/gates-at.ts';
import { explicitPrerequisites, gatePrerequisites } from '../src/verification/gate-scope.ts';
import type { EvidenceRecord } from '../src/contracts/index.ts';
import { greet, setup } from './runner-fixture.ts';
import { write } from './git-fixture.ts';
import { WIRED, withPreparationStub } from './preparation-fixture.ts';

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

test('gates на SHA вне попытки: сверка подготовки вызывается в дереве проверки; её отказ — ошибка команды, дерево убрано', async () => {
  const { ctx, context } = fixture();
  await withPreparationStub(1, async (calls) => {
    await assert.rejects(
      runGatesAt(context, {
        id: 'GA-prepared',
        repositoryId: 'app',
        sha: ctx.repo.head(),
        gates: ['unit'],
        record: () => {},
      }),
      new RegExp(WIRED),
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.checked, 'проверена после подготовки');
    assert.equal(calls[0]!.execution?.env?.DEVCONTOUR_RUN_ID, 'GA-prepared', 'окружение проверки');
  });
  assert.ok(!existsSync(join(ctx.state, 'gates-at', 'GA-prepared', 'worktree')));
});

test('gates на SHA: прерывание сигналом или пределом проверки — failures называет прерванный и следующие gates (проверка не выглядит прошедшей), interrupted и skipped отличают отмену', async () => {
  const hanging = (runTimeoutMs?: number) => {
    const ctx = setup({
      scenario: {},
      files: { 'test/hang.js': 'setTimeout(() => {}, 60000);\n', 'test/extra.js': extra },
      policy: (p) => {
        const repo = (p.repositories as { gates: Record<string, unknown>[] }[])[0]!;
        repo.gates[0]!.command = [process.execPath, 'test/hang.js'];
        repo.gates.push({
          id: 'extra',
          kind: 'test',
          command: [process.execPath, 'test/extra.js'],
          report: { type: 'junit', path: 'test-results/extra.xml' },
          dependsOn: ['unit'],
        });
        if (runTimeoutMs) p.runTimeoutMs = runTimeoutMs;
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
  };
  const expectInterrupted = (result: Awaited<ReturnType<typeof runGatesAt>>, reason: RegExp) => {
    assert.ok(result.failures.length > 0, 'прерванная проверка не прошла');
    assert.deepEqual(
      result.failures.map((f) => f.gate),
      ['unit', 'extra'],
    );
    assert.match(result.failures[0]!.message, reason);
    assert.match(result.failures[1]!.message, /не исполнен: проверка прервана/);
    assert.equal(result.failure?.gate, 'unit');
    assert.equal(result.interrupted?.gate, 'unit');
    assert.match(result.interrupted.reason, reason);
    assert.deepEqual(result.skipped, ['extra']);
  };

  const signalled = hanging();
  const abort = new AbortController();
  setTimeout(() => abort.abort(new Error('отмена хостом')), 1500);
  expectInterrupted(
    await runGatesAt(signalled.context, {
      repositoryId: 'app',
      sha: signalled.ctx.repo.head(),
      gates: ['extra'],
      record: () => {},
      signal: abort.signal,
    }),
    /отмена хостом/,
  );

  const timed = hanging(3000);
  expectInterrupted(
    await runGatesAt(timed.context, {
      repositoryId: 'app',
      sha: timed.ctx.repo.head(),
      gates: ['extra'],
      record: () => {},
    }),
    /исчерпан предел проверки runTimeoutMs \(3 с\)/,
  );
});

// P10-6: прогон вне попытки (полный прогон выпуска, `harness gates`) в
// облегчённом и тонком режимах даёт gates тот же файл окружения, что и
// попытка: тестовые помощники продукта читают HARNESS_ATTEMPT_ENV_FILE.
const envFileGate = `
const fs = require('fs');
const e = process.env;
const problems = [];
try {
  const file = JSON.parse(fs.readFileSync(e.HARNESS_ATTEMPT_ENV_FILE, 'utf8'));
  if (file.API_PORT !== e.API_PORT || !/^\\d+$/.test(file.API_PORT || '')) problems.push('port ' + file.API_PORT);
  if (file.COMPOSE_PROJECT_NAME !== e.COMPOSE_PROJECT_NAME) problems.push('compose');
  if (file.HARNESS_ATTEMPT_ID !== e.DEVCONTOUR_RUN_ID) problems.push('id');
  if ((fs.statSync(e.HARNESS_ATTEMPT_ENV_FILE).mode & 0o077) !== 0) problems.push('mode');
} catch (x) { problems.push('env-file ' + x.message); }
fs.writeFileSync(e.DEVCONTOUR_REPORT_PATH,
  '<testsuite><testcase classname="env" name="file">' + (problems.length ? '<failure message="' + problems.join(';').replace(/[<&"]/g, '') + '"/>' : '') + '</testcase></testsuite>');
`;

for (const mode of ['light', 'thin'] as const)
  test(`gates на SHA в режиме ${mode}: файл окружения прогона с портами и именем compose, только владельцу`, async () => {
    const ctx = setup({
      scenario: {},
      files: { 'test/env-file.js': envFileGate },
      policy: (p) => {
        p.harnessMode = mode;
        p.attemptEnv = { ports: ['API_PORT'], portRange: { from: 33000, to: 33999 } };
        const repo = (p.repositories as { gates: unknown[] }[])[0]!;
        repo.gates.push({
          id: 'env-file',
          kind: 'test',
          command: [process.execPath, 'test/env-file.js'],
          report: { type: 'junit', path: 'test-results/env-file.xml' },
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
    const result = await runGatesAt(context, {
      id: 'GA-env',
      repositoryId: 'app',
      sha: ctx.repo.head(),
      gates: ['env-file'],
      record: () => {},
    });
    const gate = result.evidence.find((e) => e.gate === 'env-file');
    assert.equal(gate?.passed, true, gate?.summary ?? JSON.stringify(result.failures));
  });

// P12-6: тестовый помощник продукта внутри gate поднял `docker compose` под
// именем проекта прогона, и после полного прогона выпуска стек остался.
// Подставной docker в PATH: `compose up` помечает проект поднятым, `ps -a -q`
// с фильтром по метке проекта отвечает его контейнером, `down` снимает.
const composeGate = `
const fs = require('fs');
const { execFileSync } = require('child_process');
execFileSync('docker', ['compose', 'up', '-d'], { stdio: 'ignore' });
fs.writeFileSync(process.env.FAKE_DOCKER_DIR + '/gate-project', process.env.COMPOSE_PROJECT_NAME);
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,
  '<testsuite><testcase classname="svc" name="up"><failure message="red"/></testcase></testsuite>');
process.exit(1);
`;
const fakeDocker = `#!/bin/sh
d="$FAKE_DOCKER_DIR"
echo "$*" >> "$d/calls"
if [ "$1" = compose ] && [ "$2" = up ]; then touch "$d/up-$COMPOSE_PROJECT_NAME"; exit 0; fi
if [ "$1" = ps ]; then
  for f in "$d"/up-*; do
    [ -e "$f" ] || continue
    p="\${f##*/up-}"
    case "$*" in *"label=com.docker.compose.project=$p"*) echo "c0ffee-$p";; esac
  done
  exit 0
fi
if [ "$1" = compose ] && [ "$2" = -p ] && [ "$4" = down ]; then rm -f "$d/up-$3"; exit 0; fi
exit 0
`;

test('P12-6: gates на SHA (light): стек compose, поднятый gate под именем проекта прогона, снят и после провала; чужой проект не тронут', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'harness-fake-docker-'));
  writeFileSync(join(dir, 'docker'), fakeDocker, { mode: 0o755 });
  chmodSync(join(dir, 'docker'), 0o755);
  // Чужой поднятый проект: его снимать нельзя.
  writeFileSync(join(dir, 'up-hx-other-0000'), '');
  const ctx = setup({
    scenario: {},
    files: { 'test/compose.js': composeGate },
    policy: (p) => {
      p.harnessMode = 'light';
      p.environment = { values: { FAKE_DOCKER_DIR: dir } };
      const repo = (p.repositories as { gates: unknown[] }[])[0]!;
      repo.gates.push({
        id: 'compose',
        kind: 'test',
        command: [process.execPath, 'test/compose.js'],
        report: { type: 'junit', path: 'test-results/compose.xml' },
      });
    },
  });
  const context: GatesAtContext = {
    policy: ctx.policy,
    stateDir: ctx.state,
    repoPath: () => ctx.repo.dir,
    boundary: () => ({ hidden: [ctx.state], readable: [join(ctx.repo.dir, '.git')] }),
    resourceDatabase: join(ctx.state, 'resources.sqlite'),
    environment: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  };
  const result = await runGatesAt(context, {
    id: 'GA-compose',
    repositoryId: 'app',
    sha: ctx.repo.head(),
    gates: ['compose'],
    record: () => {},
  });
  assert.equal(result.failure?.gate, 'compose', JSON.stringify(result.failures));
  const project = readFileSync(join(dir, 'gate-project'), 'utf8');
  assert.match(project, /^hx-/);
  const calls = readFileSync(join(dir, 'calls'), 'utf8');
  assert.ok(calls.includes(`compose -p ${project} down -v --remove-orphans`), calls);
  assert.ok(!existsSync(join(dir, `up-${project}`)), 'стек прогона снят');
  assert.ok(existsSync(join(dir, 'up-hx-other-0000')), 'чужой проект не тронут');
  assert.ok(!calls.includes('hx-other-0000 down'), calls);
  assert.ok(result.warnings?.some((w) => w.includes(`снят стек docker compose ${project}`)));
});
