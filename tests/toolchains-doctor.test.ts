/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
 * Тест читает JSON-ответ CLI как есть; его форму проверяет сам CLI схемой команды.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionPolicySchema, type ExecutionPolicy } from '../src/contracts/index.ts';
import { doctor } from '../src/control/doctor.ts';
import { repositoryFromProfile, resolveProfile } from '../src/profiles/resolve.ts';
import {
  assertToolchainReady,
  composeRepository,
  inspectPolicy,
  type ToolProbe,
  type ToolchainReport,
} from '../src/toolchains/index.ts';

/**
 * T02: диагностика toolchain читает манифесты и пробует версии только
 * подставной пробой — ни один процесс не запускается, файлов не появляется.
 * Исполняемые файлы окружения — пустые файлы с правом исполнения в своём
 * каталоге PATH: их находят, но не запускают.
 */
function fixture(files: Record<string, string>, tools: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-toolchains-')));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  for (const name of Object.keys(tools)) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 99\n');
    chmodSync(join(bin, name), 0o755);
  }
  const calls: string[][] = [];
  const probe: ToolProbe = (argv) => {
    calls.push(argv);
    const name = argv[0]!.split('/').at(-1)!;
    const version = tools[name];
    const ok = argv[1] === '--version' || (name === 'go' && argv[1] === 'version');
    return Promise.resolve({
      code: ok && version ? 0 : 1,
      stdout: ok && version ? `${name} version ${version}\n` : '',
      stderr: '',
      timedOut: false,
    });
  };
  const snapshot = () =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((e) => {
        const p = join(e.parentPath, e.name);
        return `${p}:${statSync(p).mtimeMs}`;
      })
      .sort();
  return { dir, repo, bin, calls, probe, snapshot, env: { PATH: bin, HOME: dir } };
}

const policyOf = (repository: Record<string, unknown>): ExecutionPolicy =>
  executionPolicySchema.parse({
    policyVersion: 1,
    repositories: [
      { id: 'app', path: 'repo', targetRef: 'refs/heads/harness/accepted', ...repository },
    ],
    roles: { developer: { writer: { runtime: 'claude' } } },
    review: {
      code: { reviewer: { runtime: 'codex' } },
      plan: { reviewer: { runtime: 'codex' } },
      contract: { reviewer: { runtime: 'codex' } },
    },
    isolation: { mode: 'none', domains: [] },
  });

async function inspect(f: ReturnType<typeof fixture>, repository: Record<string, unknown>) {
  const before = f.snapshot();
  const [report] = await inspectPolicy(policyOf(repository), f.dir, {
    probe: f.probe,
    env: f.env,
  });
  assert.deepEqual(f.snapshot(), before, 'диагностика не создаёт и не меняет файлы');
  for (const argv of f.calls)
    assert.ok(
      argv[1] === '--version' || (argv[1] === 'version' && argv.length <= 4),
      'запускаются только пробы версий: ' + argv.join(' '),
    );
  return report!;
}
const codes = (r: ToolchainReport) => r.problems.map((p) => p.code);
const find = (r: ToolchainReport, code: string) => {
  const p = r.problems.find((x) => x.code === code);
  assert.ok(p, `нет проблемы ${code}: ${JSON.stringify(r.problems)}`);
  return p;
};

const pnpmFiles = {
  'package.json': JSON.stringify({
    name: 'app',
    packageManager: 'pnpm@10.12.3',
    scripts: { check: 'node --check x.js', test: 'node --test' },
  }),
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
};

test('T02/valid: профиль pnpm-frozen даёт конкретный план — шаги, cwd, отчёт, версии; без проблем и без запуска проекта', async () => {
  const f = fixture(pnpmFiles, { pnpm: '10.12.3' });
  const { repository } = repositoryFromProfile(resolveProfile('pnpm-frozen'), {
    id: 'app',
    path: 'repo',
    targetRef: 'refs/heads/harness/accepted',
  });
  const r = await inspect(f, repository);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(
    r.plan.map((p) => [p.phase, p.id, p.cwd, p.argv.join(' '), p.report ?? '']),
    [
      ['prepare', 'install', '.', 'pnpm install --frozen-lockfile', ''],
      ['gate', 'check', '.', 'pnpm run check', ''],
      ['gate', 'unit-tests', '.', 'pnpm run test', '.reports/junit.xml'],
    ],
  );
  const pnpm = r.tools.find((t) => t.name === 'pnpm')!;
  assert.equal(pnpm.version, '10.12.3');
  assert.deepEqual(pnpm.required.map((q) => q.source).sort(), [
    'package.json#packageManager',
    'repositories.0.toolchain.tools.pnpm',
  ]);
  assert.deepEqual(r.lockfiles, [{ dir: '.', files: ['pnpm-lock.yaml'], manager: 'pnpm' }]);
  assert.deepEqual(r.reports, [{ gate: 'unit-tests', path: '.reports/junit.xml', cwd: '.' }]);
  assert.deepEqual(f.calls, [[join(f.bin, 'pnpm'), '--version']], 'одна проба на инструмент');
});

test('T02/missing-tool: отсутствующий gotestsum назван с полем команды gate', async () => {
  const f = fixture(
    { 'go.mod': 'module x\n\ngo 1.24\n', 'x.go': 'package x\n' },
    { go: 'go1.24.5' },
  );
  const { repository } = repositoryFromProfile(resolveProfile('go-gotestsum'), {
    id: 'app',
    path: 'repo',
    targetRef: 'refs/heads/harness/accepted',
  });
  const r = await inspect(f, repository);
  const p = find(r, 'TOOL_MISSING');
  assert.deepEqual(p.field, ['repositories', 0, 'gates', 1, 'command']);
  assert.match(p.message, /gotestsum не найден в PATH \(нужен 1\.12\.3\)/);
  assert.deepEqual(codes(r), ['TOOL_MISSING']);
  assert.ok(!existsSync(join(f.repo, '.reports')), 'каталог отчёта не создан');
});

test('T02/incompatible-version: packageManager, go.mod и toolchain.tools против найденных версий', async () => {
  const pm = fixture(pnpmFiles, { pnpm: '9.15.0' });
  const r1 = await inspect(pm, {
    prepare: [{ id: 'install', command: ['pnpm', 'install', '--frozen-lockfile'] }],
    gates: [
      {
        id: 'unit',
        kind: 'test',
        command: ['pnpm', 'run', 'test'],
        report: { type: 'junit', path: '.reports/junit.xml' },
      },
    ],
  });
  const p1 = find(r1, 'TOOL_VERSION');
  assert.equal(p1.path, 'package.json');
  assert.match(
    p1.message,
    /pnpm 9\.15\.0 не подходит: package.json#packageManager требует 10\.12\.3/,
  );

  const go = fixture(
    { 'go.mod': 'module x\n\ngo 1.99\n' },
    { go: 'go1.24.5', gotestsum: '1.11.0' },
  );
  const r2 = await inspect(go, {
    gates: [
      {
        id: 'acceptance',
        kind: 'test',
        command: ['gotestsum', '--junitfile', '.reports/junit.xml', '--', '-count=1', './...'],
        report: { type: 'junit', path: '.reports/junit.xml' },
      },
    ],
    toolchain: { tools: { gotestsum: '1.12.3' } },
  });
  const versions = r2.problems.filter((p) => p.code === 'TOOL_VERSION');
  assert.deepEqual(versions.map((p) => [p.field.join('.'), p.path ?? '']).sort(), [
    ['repositories.0.gates.0.command', 'go.mod'],
    ['repositories.0.toolchain.tools.gotestsum', ''],
  ]);
});

test('T02/ambiguous-lockfiles: два менеджера без выбора — отказ с полем; явный выбор снимает неоднозначность', async () => {
  const files = {
    'package.json': JSON.stringify({ name: 'app', scripts: { test: 'node --test' } }),
    'package-lock.json': '{}',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  };
  const repository = {
    prepare: [{ id: 'install', command: ['pnpm', 'install', '--frozen-lockfile'] }],
    gates: [
      {
        id: 'unit',
        kind: 'test',
        command: ['pnpm', 'run', 'test'],
        report: { type: 'junit', path: '.reports/junit.xml' },
      },
    ],
  };
  const r = await inspect(fixture(files, { pnpm: '10.12.3' }), repository);
  const p = find(r, 'LOCKFILE_AMBIGUOUS');
  assert.deepEqual(p.field, ['repositories', 0, 'toolchain', 'packageManagers', '.']);
  assert.match(p.message, /package-lock\.json, pnpm-lock\.yaml/);

  const resolved = await inspect(fixture(files, { pnpm: '10.12.3' }), {
    ...repository,
    toolchain: { packageManagers: { '.': 'pnpm' } },
  });
  assert.deepEqual(resolved.problems, []);
  assert.deepEqual(
    resolved.ambiguities[0]!.resolvedBy,
    'repositories.0.toolchain.packageManagers..',
  );
  assert.equal(resolved.lockfiles[0]!.manager, 'pnpm');
});

test('T02/unknown-script-task: неизвестный script, задача turbo и фильтр называются с файлом', async () => {
  const files = {
    'package.json': JSON.stringify({
      name: 'mono',
      packageManager: 'pnpm@10.12.3',
      scripts: { test: 'turbo run test' },
      devDependencies: { turbo: '2.11.10' },
    }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'turbo.json': JSON.stringify({ tasks: { test: {}, check: {} } }),
    'packages/a/package.json': JSON.stringify({ name: '@x/a', scripts: { test: 'node --test' } }),
  };
  const gate = (command: string[]) => ({
    id: 'unit',
    kind: 'test',
    command,
    report: { type: 'junit', path: 'packages/a/.reports/junit.xml' },
  });
  const script = await inspect(fixture(files, { pnpm: '10.12.3' }), {
    gates: [gate(['pnpm', 'run', 'test:unit'])],
  });
  const s = find(script, 'SCRIPT_UNKNOWN');
  assert.equal(s.path, 'package.json');
  assert.deepEqual(s.field, ['repositories', 0, 'gates', 0, 'command']);

  const task = await inspect(fixture(files, { pnpm: '10.12.3' }), {
    gates: [gate(['pnpm', 'exec', 'turbo', 'run', 'e2e', '--filter=@x/a', '--force'])],
  });
  assert.equal(find(task, 'TASK_UNKNOWN').path, 'turbo.json');

  const noScript = await inspect(fixture(files, { pnpm: '10.12.3' }), {
    gates: [gate(['pnpm', 'exec', 'turbo', 'run', 'check', '--filter=@x/a', '--force'])],
  });
  assert.match(
    find(noScript, 'TASK_UNKNOWN').message,
    /не объявляет script check: turbo ничего не исполнит/,
  );

  const filter = await inspect(fixture(files, { pnpm: '10.12.3' }), {
    gates: [gate(['pnpm', 'exec', 'turbo', 'run', 'test', '--filter=@x/missing', '--force'])],
  });
  assert.equal(find(filter, 'FILTER_UNKNOWN').path, 'pnpm-workspace.yaml');

  const ok = await inspect(fixture(files, { pnpm: '10.12.3' }), {
    gates: [gate(['pnpm', 'exec', 'turbo', 'run', 'test', '--filter=@x/a', '--force'])],
  });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(
    ok.tools.find((t) => t.name === 'turbo'),
    {
      name: 'turbo',
      provider: 'project',
      found: true,
      version: '2.11.10',
      required: [],
      usedBy: ['repositories.0.gates.0.command'],
    },
    'turbo проекта не запускается пробой: версия из package.json',
  );
});

test('T02/wrong-cwd: gate cwd и каталог флага инструмента вне репозитория', async () => {
  const f = fixture(
    { 'frontend/package.json': '{"scripts":{"test":"x"}}' },
    { go: 'go1.24.5', pnpm: '10.12.3' },
  );
  const r = await inspect(f, {
    prepare: [{ id: 'fe', command: ['pnpm', '--dir', 'web', 'install', '--frozen-lockfile'] }],
    gates: [
      {
        id: 'backend',
        kind: 'test',
        cwd: 'backend',
        command: ['go', 'test', '-count=1', './...'],
        report: { type: 'junit', path: '.reports/b.xml' },
      },
    ],
  });
  assert.deepEqual(
    r.problems.map((p) => [p.code, p.field.join('.'), p.path]),
    [
      ['CWD_MISSING', 'repositories.0.prepare.0.command', 'web'],
      ['CWD_MISSING', 'repositories.0.gates.0.cwd', 'backend'],
    ],
  );
});

test('T02/composition-conflict: npm и pnpm в одном каталоге, выбор против команды, слои профиля с разными версиями', async () => {
  const files = {
    'package.json': JSON.stringify({ name: 'app', scripts: { test: 'node --test' } }),
    'package-lock.json': '{}',
  };
  const mixed = await inspect(fixture(files, { npm: '11.4.2', pnpm: '10.12.3' }), {
    prepare: [{ id: 'install', command: ['npm', 'ci'] }],
    gates: [
      {
        id: 'unit',
        kind: 'test',
        command: ['pnpm', 'run', 'test'],
        report: { type: 'junit', path: '.reports/junit.xml' },
      },
    ],
  });
  assert.equal(find(mixed, 'COMPOSITION_CONFLICT').path, '.');

  const chosen = await inspect(fixture(files, { npm: '11.4.2' }), {
    prepare: [{ id: 'install', command: ['npm', 'ci'] }],
    gates: [
      {
        id: 'unit',
        kind: 'test',
        command: ['npm', 'test'],
        report: { type: 'junit', path: '.reports/junit.xml' },
      },
    ],
    toolchain: { packageManagers: { '.': 'pnpm' } },
  });
  assert.deepEqual(find(chosen, 'COMPOSITION_CONFLICT').field, [
    'repositories',
    0,
    'toolchain',
    'packageManagers',
    '.',
  ]);

  // Слои профиля с одним инструментом разных версий — отказ разрешения.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-toolchains-profile-')));
  writeFileSync(
    join(dir, 'local.json'),
    JSON.stringify({
      id: 'local',
      version: '1.0.0',
      extends: ['go-gotestsum'],
      toolchain: { tools: { gotestsum: '1.11.0' } },
    }),
  );
  assert.throws(
    () => resolveProfile('./local.json', { repository: dir }),
    /Конфликт частей профиля: toolchain\.tools\.gotestsum \(1\.12\.3 и 1\.11\.0\)/,
  );
});

test('T02/T03: незакреплённая установка, --if-present, @latest и turbo test без --force — проблемы до запуска', async () => {
  const files = {
    'package.json': JSON.stringify({
      name: 'mono',
      packageManager: 'pnpm@10.12.3',
      scripts: { test: 'x' },
      devDependencies: { turbo: '2.11.10' },
    }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'turbo.json': JSON.stringify({ tasks: { test: {} } }),
    'packages/a/package.json': JSON.stringify({ name: '@x/a', scripts: { test: 'x' } }),
    'go.mod': 'module x\n\ngo 1.24\n',
  };
  const r = await inspect(fixture(files, { pnpm: '10.12.3', go: 'go1.24.5' }), {
    prepare: [
      { id: 'a', command: ['pnpm', 'install'] },
      { id: 'b', command: ['pnpm', 'run', 'test', '--if-present'] },
      { id: 'c', command: ['pnpm', 'dlx', 'cowsay@latest'] },
    ],
    gates: [
      {
        id: 'unit',
        kind: 'test',
        command: ['pnpm', 'exec', 'turbo', 'run', 'test', '--filter=@x/a'],
        report: { type: 'junit', path: 'packages/a/.reports/junit.xml' },
      },
      {
        id: 'go',
        kind: 'test',
        command: ['go', 'test', './...'],
        report: { type: 'junit', path: '.reports/go.xml' },
      },
    ],
  });
  assert.deepEqual(
    r.problems.map((p) => [p.code, p.field.join('.')]),
    [
      ['INSTALL_UNLOCKED', 'repositories.0.prepare.0.command'],
      ['IF_PRESENT', 'repositories.0.prepare.1.command'],
      ['UNPINNED', 'repositories.0.prepare.2.command'],
      ['UNPINNED', 'repositories.0.prepare.2.command'],
      ['CACHE_REPLAY', 'repositories.0.gates.0.command'],
    ],
  );
  // Кэш тестов Go — предупреждение (прежний go-api его не отключал), не отказ.
  assert.deepEqual(
    r.warnings.map((p) => [p.code, p.field.join('.')]),
    [['CACHE_REPLAY', 'repositories.0.gates.1.command']],
  );
});

test('T02: composeRepository собирает компоненты без «типа проекта»; preflight пропускает валидную композицию', async () => {
  const f = fixture(
    {
      'frontend/package.json': JSON.stringify({
        name: 'fe',
        packageManager: 'pnpm@10.12.3',
        scripts: { test: 'node --test' },
      }),
      'frontend/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'backend/pyproject.toml': '[project]\nname = "be"\n',
      'backend/uv.lock': 'version = 1\n\n[[package]]\nname = "pytest"\nversion = "8.4.1"\n',
    },
    { pnpm: '10.12.3', uv: '0.11.28' },
  );
  const repository = composeRepository(
    { id: 'app', path: 'repo', targetRef: 'refs/heads/harness/accepted' },
    [
      {
        dir: 'frontend',
        install: 'pnpm',
        gates: [
          {
            id: 'fe',
            kind: 'test',
            command: ['pnpm', 'run', 'test'],
            report: { type: 'junit', path: '.reports/fe.xml' },
          },
        ],
      },
      {
        dir: 'backend',
        install: 'uv',
        gates: [
          {
            id: 'be',
            kind: 'test',
            command: ['uv', 'run', '--no-sync', 'pytest', '--junitxml=../.reports/be.xml'],
            report: { type: 'junit', path: '.reports/be.xml' },
          },
        ],
      },
    ],
    { uv: '0.11.28' },
  );
  assert.deepEqual(repository.prepare, [
    {
      id: 'frontend-install',
      command: ['pnpm', '--dir', 'frontend', 'install', '--frozen-lockfile'],
      timeoutMs: 600000,
    },
    {
      id: 'backend-install',
      command: ['uv', 'sync', '--locked', '--directory', 'backend'],
      timeoutMs: 600000,
    },
  ]);
  const policy = policyOf(repository);
  const reports = await assertToolchainReady(policy, f.dir, { probe: f.probe, env: f.env });
  assert.deepEqual(reports[0]!.problems, []);
  assert.deepEqual(
    reports[0]!.plan.filter((p) => p.phase === 'gate').map((p) => p.cwd),
    ['frontend', 'backend'],
  );
  // Тот же отчёт, но pytest пишет не туда, куда смотрит gate, — отказ preflight с путём поля.
  const wrong = structuredClone(policy);
  wrong.repositories[0]!.gates[1]!.command = [
    'uv',
    'run',
    '--no-sync',
    'pytest',
    '--junitxml=.reports/be.xml',
  ];
  await assert.rejects(
    assertToolchainReady(wrong, f.dir, { probe: f.probe, env: f.env }),
    (e: any) =>
      e.code === 'NOT_READY' &&
      e.issues.some(
        (i: any) =>
          i.path.join('.') === 'policy.repositories.0.gates.1.command' &&
          /REPORT_MISMATCH/.test(i.message),
      ),
  );
});

test('T02/A02: doctor требует только runtime, назначенные политикой, и сводит проблемы toolchain', async () => {
  const f = fixture(pnpmFiles, { pnpm: '10.12.3' });
  const policy = executionPolicySchema.parse({
    ...policyOf({
      gates: [
        {
          id: 'unit',
          kind: 'test',
          command: ['pnpm', 'run', 'missing'],
          report: { type: 'junit', path: '.reports/junit.xml' },
        },
      ],
    }),
    review: {
      code: { reviewer: { runtime: 'claude' }, vendor: 'same-vendor-allowed' },
      plan: { reviewer: { runtime: 'claude' }, vendor: 'same-vendor-allowed' },
      contract: { reviewer: { runtime: 'claude' }, vendor: 'same-vendor-allowed' },
    },
  });
  const asked: string[] = [];
  const adapter = (name: string) =>
    ({
      capabilities: () => {
        asked.push(name);
        return Promise.resolve({ version: '1.0.0', structuredOutput: true, cancellation: true });
      },
    }) as any;
  const report = await doctor(
    policy,
    { claude: adapter('claude'), codex: adapter('codex') },
    undefined,
    {
      baseDir: f.dir,
      inspect: (p, base) => inspectPolicy(p, base, { probe: f.probe, env: f.env }),
    },
  );
  assert.deepEqual(asked, ['claude'], 'codex политике не нужен и не запускается');
  assert.equal(report.runtimes.find((r) => r.runtime === 'codex')!.reason, 'не назначен политикой');
  assert.equal(report.problems.length, 1);
  assert.match(
    report.problems[0]!,
    /^toolchain app: SCRIPT_UNKNOWN repositories\.0\.gates\.0\.command \(package\.json\)/,
  );
  assert.equal(report.toolchains![0]!.problems[0]!.code, 'SCRIPT_UNKNOWN');
});

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
test('T02: run с проблемой preflight — exit 3 NOT_READY до состояния и runtime; doctor — exit 0 с той же проблемой', () => {
  const f = fixture(pnpmFiles, {});
  const marker = join(f.dir, 'runtime-called');
  const runtime = join(f.dir, 'runtime');
  writeFileSync(runtime, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho 1.0.0\n`);
  chmodSync(runtime, 0o755);
  writeFileSync(
    join(f.dir, 'policy.json'),
    JSON.stringify(
      policyOf({
        prepare: [{ id: 'install', command: ['pnpm', 'install', '--frozen-lockfile'] }],
        gates: [
          {
            id: 'unit',
            kind: 'test',
            command: ['pnpm', 'run', 'test:missing'],
            report: { type: 'junit', path: '.reports/junit.xml' },
          },
        ],
      }),
    ),
  );
  writeFileSync(
    join(f.dir, 'graph.json'),
    JSON.stringify({
      apiVersion: 'devcontour-harness/v1alpha1',
      id: 'g',
      source: { connector: 'files', ref: 'graph.json', revision: '1' },
      orders: [
        {
          apiVersion: 'devcontour-harness/v1alpha1',
          id: 'w',
          source: { connector: 'files', ref: 'w', revision: '1' },
          title: 'Task',
          goal: 'Change something useful',
          acceptance: ['works'],
          role: 'developer',
          repositoryId: 'app',
          writeScope: ['src'],
          gates: ['unit'],
        },
      ],
    }),
  );
  const harness = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd: f.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        PATH: f.bin + ':' + dirname(process.execPath),
        HARNESS_CLAUDE_BIN: runtime,
        HARNESS_CODEX_BIN: runtime,
      },
    });
    return { status: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const state = join(f.dir, 'state');
  const run = harness('run', '--graph', 'graph.json', '--policy', 'policy.json', '--state', state);
  assert.equal(run.status, 3, run.stderr);
  assert.equal(run.json.error.code, 'NOT_READY');
  const issues = run.json.error.issues.map((i: any) => i.path.join('.') + ' ' + i.message);
  assert.ok(
    issues.some((i: string) =>
      /^policy\.repositories\.0\.prepare\.0\.command TOOL_MISSING/.test(i),
    ),
    issues.join('\n'),
  );
  assert.ok(
    issues.some((i: string) =>
      /^policy\.repositories\.0\.gates\.0\.command SCRIPT_UNKNOWN: Script test:missing/.test(i),
    ),
  );
  assert.ok(!existsSync(state), 'preflight не создал каталог состояния');
  assert.ok(!existsSync(marker), 'runtime не вызывался');

  const doc = harness('doctor', '--policy', 'policy.json');
  assert.equal(doc.status, 0, 'doctor остаётся информационным');
  assert.ok(doc.json.data.problems.some((p: string) => /SCRIPT_UNKNOWN/.test(p)));
  assert.equal(doc.json.data.toolchains[0].configSource, join(f.dir, 'policy.json'));
  assert.ok(!existsSync(state));
});

test('T02/round2b: диапазон turbo в package.json допустим, когда lockfile закрепляет точную версию; без закрепления — UNPINNED', async () => {
  const lock = (entry: string) =>
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n${entry}\n  packages/a:\n    devDependencies:\n      turbo:\n        specifier: 2.0.0\n        version: 2.0.0\n\npackages:\n\n  turbo@2.11.10:\n    resolution: {integrity: sha512-x}\n`;
  const files = (pnpmLock: string) => ({
    'package.json': JSON.stringify({
      name: 'mono',
      packageManager: 'pnpm@10.12.3',
      devDependencies: { turbo: '^2.11.6' },
    }),
    'pnpm-lock.yaml': pnpmLock,
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'turbo.json': JSON.stringify({ tasks: { test: {} } }),
    'packages/a/package.json': JSON.stringify({ name: '@x/a', scripts: { test: 'x' } }),
  });
  const repository = {
    gates: [
      {
        id: 'unit',
        kind: 'test',
        command: ['pnpm', 'exec', 'turbo', 'run', 'test', '--filter=@x/a', '--force'],
        report: { type: 'junit', path: 'packages/a/.reports/junit.xml' },
      },
    ],
  };
  const pinned = await inspect(
    fixture(files(lock('      turbo:\n        specifier: ^2.11.6\n        version: 2.11.10\n')), {
      pnpm: '10.12.3',
    }),
    repository,
  );
  assert.deepEqual(pinned.problems, []);
  assert.equal(pinned.tools.find((t) => t.name === 'turbo')!.version, '2.11.10');

  // Закрепление другого importer (packages/a) не считается: у корня turbo не закреплён.
  const unpinned = await inspect(
    fixture(files(lock('      picocolors:\n        specifier: 1.1.1\n        version: 1.1.1\n')), {
      pnpm: '10.12.3',
    }),
    repository,
  );
  const p = find(unpinned, 'UNPINNED');
  assert.equal(p.path, 'package.json');
  assert.match(p.message, /\^2\.11\.6 .*без точной версии в lockfile/);
});

test('T02/round2b: проба версии под нагрузкой — один повтор с удвоенным пределом; итог ограничен', async () => {
  const f = fixture(pnpmFiles, { pnpm: '10.12.3' });
  const repository = {
    prepare: [{ id: 'install', command: ['pnpm', 'install', '--frozen-lockfile'] }],
    gates: [
      {
        id: 'unit',
        kind: 'test',
        command: ['pnpm', 'run', 'test'],
        report: { type: 'junit', path: '.reports/junit.xml' },
      },
    ],
  };
  const policy = policyOf(repository);
  const limits: number[] = [];
  const slowOnce: ToolProbe = (argv, options) => {
    limits.push(options.timeoutMs);
    return limits.length === 1
      ? Promise.resolve({ code: -1, stdout: '', stderr: '', timedOut: true })
      : f.probe(argv, options);
  };
  const [ok] = await inspectPolicy(policy, f.dir, {
    probe: slowOnce,
    env: f.env,
    probeTimeoutMs: 1000,
  });
  assert.deepEqual(ok!.problems, []);
  assert.deepEqual(limits, [1000, 2000]);

  const always: number[] = [];
  const [stuck] = await inspectPolicy(policy, f.dir, {
    probe: (_argv, options) => {
      always.push(options.timeoutMs);
      return Promise.resolve({ code: -1, stdout: '', stderr: '', timedOut: true });
    },
    env: f.env,
    probeTimeoutMs: 1000,
  });
  assert.deepEqual(always, [1000, 2000], 'не больше одного повтора');
  assert.ok(stuck!.problems.some((x) => x.code === 'TOOL_VERSION_UNKNOWN'));
});
