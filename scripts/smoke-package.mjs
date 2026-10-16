/**
 * Проверка настоящего архива: состав по whitelist, установка без dev
 * зависимостей и скриптов в независимый каталог, запуск CLI и импорт
 * библиотеки из чужого cwd. Исходный checkout после упаковки не читается.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-smoke-')));
const fail = (message) => {
  console.error('smoke-package: ' + message);
  process.exit(1);
};

const [packed] = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], {
    cwd: root,
    encoding: 'utf8',
  }),
);
const allowed = [
  /^package\.json$/,
  /^LICENSE$/,
  /^README\.md$/,
  /^lib\/.+\.(js|d\.ts)$/,
  /^schemas\/[a-z-]+\.schema\.json$/,
  /^docs\/[a-z-]+\.md$/,
  /^examples\/[a-z-]+\/[a-z-]+\.json$/,
  /^examples\/[a-z-]+\/README\.md$/,
  /^examples\/[a-z-]+\/test\/[a-z-]+\.js$/,
  /^examples\/[a-z-]+\/src\/\.gitkeep$/,
  /^profiles\/[a-z0-9-]+\.json$/,
  /^skills\/[a-z-]+\/SKILL\.md$/,
  /^templates\/(AGENTS\.md|[a-z-]+\.json)$/,
];
const unexpected = packed.files.map((f) => f.path).filter((p) => !allowed.some((r) => r.test(p)));
if (unexpected.length) fail('файлы вне whitelist: ' + unexpected.join(', '));
for (const required of [
  'lib/index.js',
  'lib/cli.js',
  'lib/contracts/index.js',
  'schemas/work-graph.schema.json',
  'schemas/stack-profile.schema.json',
  'profiles/node-checks.json',
  'skills/harness/SKILL.md',
  'templates/policy.json',
  'templates/graph.json',
])
  if (!packed.files.some((f) => f.path === required)) fail('нет файла ' + required);

const consumer = join(scratch, 'consumer');
execFileSync('mkdir', [consumer]);
writeFileSync(
  join(consumer, 'package.json'),
  JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
);
execFileSync(
  'npm',
  [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefer-offline',
    join(scratch, packed.filename),
  ],
  { cwd: consumer, stdio: 'inherit' },
);
const installed = join(consumer, 'node_modules', 'devcontour-harness');
const bin = join(consumer, 'node_modules', '.bin', 'harness');
const run = (args) => spawnSync(bin, args, { cwd: scratch, encoding: 'utf8' });

const version = run(['--version']);
if (version.status !== 0) fail('--version: ' + version.stderr);
const reported = JSON.parse(version.stdout).data.harness;
if (reported !== packed.version) fail(`версия ${reported} ≠ ${packed.version}`);

const ok = run([
  'validate',
  '--graph',
  join(installed, 'examples/single-task/graph.json'),
  '--policy',
  join(installed, 'examples/single-task/policy.json'),
]);
if (ok.status !== 0 || !JSON.parse(ok.stdout).ok) fail('validate примера: ' + ok.stderr);
const refused = run([
  'validate',
  '--graph',
  join(installed, 'examples/single-task/graph.json'),
  '--policy',
  join(installed, 'examples/single-task/graph.json'),
]);
if (refused.status !== 2)
  fail('неверная политика должна давать exit 2, получено ' + refused.status);

// Публичный API из установленного архива: экспорты проверки и отрицательный сценарий.
const libCheck = `
const m = await import('devcontour-harness');
const c = await import('devcontour-harness/contracts');
if (m.API_VERSION !== c.API_VERSION) throw new Error('API_VERSION');
for (const name of ['validateInputs', 'crossIssues', 'graphIssues', 'policyIssues', 'contextIssues', 'reviewIssues', 'selectReviewer'])
  if (typeof m[name] !== 'function') throw new Error('нет экспорта ' + name);
const { readFileSync } = await import('node:fs');
const dir = './node_modules/devcontour-harness/examples/single-task/';
const graph = JSON.parse(readFileSync(dir + 'graph.json', 'utf8'));
const policy = JSON.parse(readFileSync(dir + 'policy.json', 'utf8'));
if (m.validateInputs({ graph, policy }).orders !== 1) throw new Error('validateInputs примера');
policy.roles.developer.writePaths = ['docs'];
let code;
try { m.validateInputs({ graph, policy }); } catch (e) { code = e.code; }
if (code !== 'INVALID_INPUT') throw new Error('crossIssues через публичный API: ' + code);
console.log(m.HARNESS_VERSION);
`;
const lib = spawnSync(process.execPath, ['--input-type=module', '-e', libCheck], {
  cwd: consumer,
  encoding: 'utf8',
});
if (lib.status !== 0 || lib.stdout.trim() !== packed.version)
  fail('импорт библиотеки: ' + lib.stderr);
// Профили, skills и шаблоны из установленного архива: встроенный профиль
// разрешается из пакета с digest байтов своего файла, шаблоны проходят validate.
const profileCheck = `
const m = await import('devcontour-harness');
const { createHash } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const ids = m.builtinProfiles();
if (ids.length < 9 || !ids.includes('node-checks')) throw new Error('встроенные профили: ' + ids);
const dir = './node_modules/devcontour-harness/profiles/';
for (const id of ids) {
  const p = m.resolveProfile(id);
  if (!p.gates.some((g) => g.kind === 'test' && g.report)) throw new Error('нет test gate: ' + id);
  if (id === 'go-api' && p.digest !== createHash('sha256').update(readFileSync(dir + id + '.json')).digest('hex'))
    throw new Error('digest встроенного профиля');
}
const { repository } = m.repositoryFromProfile(m.resolveProfile('node-checks'), { id: 'app', path: '.', targetRef: 'refs/heads/harness/accepted' });
if (!repository.gates.some((g) => g.id === 'unit-tests')) throw new Error('repositoryFromProfile');
console.log(ids.length);
`;
const profiles = spawnSync(process.execPath, ['--input-type=module', '-e', profileCheck], {
  cwd: consumer,
  encoding: 'utf8',
});
if (profiles.status !== 0) fail('профили из архива: ' + profiles.stderr);
const shown = run(['profile', '--profile', 'react-native']);
if (shown.status !== 0 || JSON.parse(shown.stdout).data.pin.id !== 'react-native')
  fail('harness profile: ' + shown.stderr + shown.stdout);
const template = run([
  'validate',
  '--graph',
  join(installed, 'templates/graph.json'),
  '--policy',
  join(installed, 'templates/policy.json'),
]);
if (template.status !== 0) fail('validate шаблонов: ' + template.stdout);
for (const file of ['skills/harness/SKILL.md', 'templates/AGENTS.md'])
  if (!readFileSync(join(installed, file), 'utf8').includes('harness')) fail('пустой ' + file);

// Skills только объясняют: без каталога skills те же gates, область записи
// и fencing controller. Каталог удаляется из установленной копии пакета —
// путь проверяется: только внутри временного каталога smoke.
const skills = join(installed, 'skills');
if (
  !skills.startsWith(scratch + '/') ||
  !skills.endsWith('/node_modules/devcontour-harness/skills')
)
  fail('неожиданный путь skills: ' + skills);
rmSync(skills, { recursive: true });

// Циклы из установленного архива: пример в собственном Git, ревью плана,
// кандидат, интеграция, приёмка или отказ, результат. Runtime — fixture
// executables (подставные CLI, не живые модели), скопированные во временный каталог.
const fixtures = join(scratch, 'bin');
mkdirSync(fixtures);
for (const name of ['fake-claude', 'fake-codex']) {
  copyFileSync(join(root, 'tests', 'fixtures', 'bin', name), join(fixtures, name));
  chmodSync(join(fixtures, name), 0o755);
}
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 's',
  GIT_AUTHOR_EMAIL: 's@s',
  GIT_COMMITTER_NAME: 's',
  GIT_COMMITTER_EMAIL: 's@s',
};
const approve = {
  approved: true,
  summary: 'ok',
  findings: [],
  discoveries: [],
  execution: { commands: [], noCommandsReason: 'diff' },
  previous: [],
};
function project(name, files) {
  const app = join(scratch, name);
  cpSync(join(installed, 'examples', 'single-task'), app, { recursive: true });
  const scenario = join(scratch, name + '.scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      writer: { files, result: { completed: true, summary: 'change', discoveries: [] } },
      reviewer: { result: approve },
    }),
  );
  const policyPath = join(app, 'policy.json');
  const appPolicy = JSON.parse(readFileSync(policyPath, 'utf8'));
  appPolicy.isolation = { mode: 'none', domains: [] };
  appPolicy.environment = { values: { FIXTURE_SCENARIO: scenario } };
  appPolicy.maxAttempts = 1;
  writeFileSync(policyPath, JSON.stringify(appPolicy));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: app, env: gitEnv });
  execFileSync('git', ['add', '-A'], { cwd: app, env: gitEnv });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: app, env: gitEnv });
  const state = join(scratch, name + '-state');
  const harness = (...args) =>
    spawnSync(bin, args, {
      cwd: scratch,
      encoding: 'utf8',
      env: {
        ...process.env,
        HARNESS_CLAUDE_BIN: join(fixtures, 'fake-claude'),
        HARNESS_CODEX_BIN: join(fixtures, 'fake-codex'),
      },
    });
  return {
    app,
    state,
    policyPath,
    run: () =>
      harness('run', '--graph', join(app, 'graph.json'), '--policy', policyPath, '--state', state),
    result: () => JSON.parse(harness('result', '--state', state, '--work', 'add-greeting').stdout),
  };
}

const good = project('greeting', {
  'src/greet.js': "exports.greet = (n) => 'Hello, ' + n + '!';\n",
});
const cycle = good.run();
if (cycle.status !== 0) fail('run примера: ' + cycle.stderr + cycle.stdout);
const envelope = good.result();
const accepted = execFileSync('git', ['rev-parse', 'refs/heads/harness/accepted'], {
  cwd: good.app,
  encoding: 'utf8',
}).trim();
if (envelope.data?.result?.outcome !== 'accepted' || envelope.data.result.shas.result !== accepted)
  fail(
    'результат примера не принят или SHA не совпадает с target ref: ' + JSON.stringify(envelope),
  );

const refusal = (name, files, code) => {
  const p = project(name, files);
  const before = execFileSync('git', ['rev-parse', 'refs/heads/main'], {
    cwd: p.app,
    encoding: 'utf8',
  });
  p.run();
  const result = p.result().data?.result;
  if (result?.outcome !== 'rejected' || result.stopReason?.code !== code)
    fail(`${name}: ожидался отказ ${code}, получено ${JSON.stringify(result)}`);
  const target = spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/harness/accepted'], {
    cwd: p.app,
    encoding: 'utf8',
  }).stdout;
  if (target && target !== before) fail(name + ': target ref продвинут при отказе');
};
// Gate: тест падает на неверной реализации.
refusal('wrong-greeting', { 'src/greet.js': "exports.greet = () => 'Hi';\n" }, 'GATE_FAILED');
// Область записи: файл вне writeScope поручения.
refusal(
  'out-of-scope',
  { 'src/greet.js': "exports.greet = (n) => 'Hello, ' + n + '!';\n", 'outside.txt': 'x\n' },
  'SCOPE_VIOLATION',
);
// Fencing controller: действующая чужая роль — явный отказ, без выдачи.
const busy = project('busy', { 'src/greet.js': "exports.greet = (n) => 'Hello, ' + n + '!';\n" });
mkdirSync(busy.state);
const holdLease = `
const m = await import('devcontour-harness');
const { readFileSync } = await import('node:fs');
const policy = m.executionPolicySchema.parse(JSON.parse(readFileSync(${JSON.stringify(busy.policyPath)}, 'utf8')));
const store = new m.SqliteExecutionStore(${JSON.stringify(join(busy.state, 'state.sqlite'))}, 'other');
const engine = new m.Engine({ host: m.standaloneHost(store, policy), policy });
if (!engine.lead('occupied-controller')) throw new Error('lead');
store.close();
`;
const held = spawnSync(process.execPath, ['--input-type=module', '-e', holdLease], {
  cwd: consumer,
  encoding: 'utf8',
});
if (held.status !== 0) fail('захват роли controller: ' + held.stderr);
const blocked = busy.run();
if (blocked.status !== 3 || JSON.parse(blocked.stdout).error?.code !== 'CONTROLLER_BUSY')
  fail('занятая роль controller: ' + blocked.status + ' ' + blocked.stdout);

console.log(
  `smoke-package: ${packed.filename} (${packed.files.length} файлов) установлен; профили, шаблоны, полный цикл и отказы gate/области/controller без каталога skills пройдены на fixture runtime (механика, не качество модели); sha512 ${packed.integrity}`,
);
