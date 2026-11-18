/**
 * CLI `gates --sha --gate`: gates на коммите вне попытки поверх `runGatesAt`
 * в отдельном процессе — исходы по gates, exit 0/3, `--fail-fast`, отказ на
 * неизвестном gate; ни базы состояния, ни попыток.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { cliCommands, cliDataSchemas, cliErrorSchema } from '../src/contracts/index.ts';

type GatesData = z.infer<typeof cliDataSchemas.gates>;
import { example } from './fixtures.ts';
import { repo } from './git-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** Gate пишет JUnit с исходом по файлу `ok-<id>` в дереве и отмечает запуск в `ran/`. */
const gateScript = (id: string, marks: string) => [
  process.execPath,
  '-e',
  `const fs=require('fs');fs.mkdirSync(${JSON.stringify(marks)},{recursive:true});` +
    `fs.writeFileSync(${JSON.stringify(join(marks, id))},'');` +
    `const ok=fs.existsSync('ok-${id}');` +
    `fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="${id}">'+(ok?'':'<failure message="no"/>')+'</testcase></testsuite>');` +
    `process.exit(ok?0:1)`,
];

function fixture() {
  const r = repo({ 'README.md': 'app\n', 'ok-unit': '', 'ok-lint': '' });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-gates-cli-')));
  const marks = join(root, 'ran');
  const state = join(root, 'state');
  const policy = structuredClone(example('policy')) as {
    repositories: Record<string, unknown>[];
    [key: string]: unknown;
  };
  policy.repositories[0]!.path = r.dir;
  policy.repositories[0]!.gates = ['lint', 'unit', 'e2e'].map((id) => ({
    id,
    kind: 'test',
    command: gateScript(id, marks),
    report: { type: 'junit', path: `reports/${id}.xml` },
    ...(id === 'e2e' ? { dependsOn: ['unit'] } : { dependsOn: [] }),
  }));
  policy.isolation = { mode: 'none', domains: [] };
  policy.runTimeoutMs = 60000;
  const policyPath = join(root, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(policy, null, 2));
  const harness = (...args: string[]) => {
    const run = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), cli, ...args],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
        timeout: 120_000,
      },
    );
    // `--human` печатает таблицу вместо конверта.
    if (args.includes('--human'))
      return { status: run.status, stdout: run.stdout, stderr: run.stderr };
    const json = JSON.parse(run.stdout) as { ok: boolean; data?: unknown; error?: unknown };
    const data = json.ok ? cliDataSchemas.gates.parse(json.data) : undefined;
    const error = json.ok ? undefined : cliErrorSchema.parse(json.error);
    return { status: run.status, ok: json.ok, data, error, stdout: run.stdout, stderr: run.stderr };
  };
  const ran = () => (existsSync(marks) ? readdirSync(marks).sort() : []);
  return { r, root, state, policyPath, harness, ran, marks };
}

test('gates: проходящий и непрошедший gate на коммите — исходы по gates, exit 0/3, попыток нет', () => {
  assert.ok('gates' in cliCommands && 'gates' in cliDataSchemas);
  const { r, state, policyPath, harness, ran } = fixture();
  const head = r.head();

  const pass = harness(
    'gates',
    '--state',
    state,
    '--policy',
    policyPath,
    '--sha',
    'HEAD',
    '--gate',
    'unit',
  );
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(pass.data!.sha, head, 'HEAD разрешён в SHA');
  assert.equal(pass.data!.passed, true);
  assert.equal(pass.data!.repositoryId, 'app');
  assert.deepEqual(
    pass.data!.gates.map((g: GatesData['gates'][number]) => [g.gate, g.status]),
    [['unit', 'passed']],
  );
  assert.equal(pass.data!.gates[0]!.exitCode, 0);
  assert.match(pass.stderr, /harness gates: unit passed/);

  // e2e падает (нет ok-e2e), предпосылка unit идёт первой; все gates по умолчанию.
  const fail = harness('gates', '--state', state, '--policy', policyPath, '--sha', head);
  assert.equal(fail.status, 3, fail.stderr);
  assert.equal(fail.ok, true, 'провал gate — данные проверки, не ошибка');
  assert.equal(fail.data!.passed, false);
  assert.deepEqual(
    fail.data!.gates.map((g: GatesData['gates'][number]) => [g.gate, g.status]),
    [
      ['lint', 'passed'],
      ['unit', 'passed'],
      ['e2e', 'failed'],
    ],
  );
  assert.notEqual(fail.data!.gates[2]!.exitCode, 0);
  assert.ok(existsSync(fail.data!.gates[2]!.log!), 'лог gate сохранён');
  assert.deepEqual(ran(), ['e2e', 'lint', 'unit']);

  // Ни базы состояния, ни попыток, ни привязки: только логи проверок.
  assert.deepEqual(readdirSync(state), ['gates-at']);
  assert.equal(
    r
      .git('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree ')).length,
    1,
  );
  assert.equal(r.git('status', '--porcelain'), '', 'checkout репозитория не тронут');

  // Таблица для человека — тот же exit.
  const human = harness(
    'gates',
    '--state',
    state,
    '--policy',
    policyPath,
    '--sha',
    head,
    '--human',
  );
  assert.equal(human.status, 3);
  assert.match(human.stdout, /^app @ [0-9a-f]{12} — FAIL/);
  assert.match(human.stdout, /\ne2e +failed +1/);
});

test('gates --fail-fast: после первого провала следующие gates не исполняются и названы skipped', () => {
  const { r, state, policyPath, harness, ran } = fixture();
  // lint падает первым: без ok-lint.
  r.git('rm', '-q', 'ok-lint');
  r.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'no lint');
  const sha = r.head();

  const fast = harness(
    'gates',
    '--state',
    state,
    '--policy',
    policyPath,
    '--sha',
    sha,
    '--fail-fast',
  );
  assert.equal(fast.status, 3, fast.stderr);
  assert.equal(fast.data!.failFast, true);
  assert.deepEqual(
    fast.data!.gates.map((g: GatesData['gates'][number]) => [g.gate, g.status]),
    [
      ['lint', 'failed'],
      ['unit', 'skipped'],
      ['e2e', 'skipped'],
    ],
  );
  assert.deepEqual(ran(), ['lint'], 'после провала gates не запускались');

  // Без флага провал не останавливает проверку (диагностика всех исходов).
  const all = harness('gates', '--state', state, '--policy', policyPath, '--sha', sha);
  assert.deepEqual(
    all.data!.gates.map((g: GatesData['gates'][number]) => [g.gate, g.status]),
    [
      ['lint', 'failed'],
      ['unit', 'passed'],
      ['e2e', 'failed'],
    ],
  );
});

test('gates: неизвестный gate, неизвестный коммит и пустой --gate — ясный отказ до исполнения', () => {
  const { state, policyPath, harness, ran } = fixture();
  const unknown = harness(
    'gates',
    '--state',
    state,
    '--policy',
    policyPath,
    '--sha',
    'HEAD',
    '--gate',
    'unit,nope',
  );
  assert.equal(unknown.status, 2);
  assert.equal(unknown.error?.code, 'GATE_UNKNOWN');
  assert.match(unknown.error.message, /Проверка вне профиля app: nope/);
  const commit = harness(
    'gates',
    '--state',
    state,
    '--policy',
    policyPath,
    '--sha',
    'f'.repeat(40),
  );
  assert.equal(commit.error?.code, 'NOT_FOUND');
  assert.match(commit.error.message, /Коммит f+ не найден в app/);
  const empty = harness(
    'gates',
    '--state',
    state,
    '--policy',
    policyPath,
    '--sha',
    'HEAD',
    '--gate',
    ',',
  );
  assert.equal(empty.error?.code, 'INVALID_INPUT');
  const noSha = harness('gates', '--state', state, '--policy', policyPath);
  assert.equal(noSha.error?.code, 'INVALID_INPUT');
  assert.match(noSha.error.message, /gates требует --sha/);
  // Флаги команды не принимаются другими командами.
  const other = harness('status', '--state', state, '--fail-fast');
  assert.equal(other.error?.code, 'INVALID_INPUT');
  assert.deepEqual(ran(), [], 'ни один gate не исполнен');
  assert.equal(existsSync(state), false, 'отказ ничего не создал');
});
