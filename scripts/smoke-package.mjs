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
];
const unexpected = packed.files.map((f) => f.path).filter((p) => !allowed.some((r) => r.test(p)));
if (unexpected.length) fail('файлы вне whitelist: ' + unexpected.join(', '));
for (const required of [
  'lib/index.js',
  'lib/cli.js',
  'lib/contracts/index.js',
  'schemas/work-graph.schema.json',
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
// Полный цикл из установленного архива: пример в собственном Git, ревью плана,
// кандидат, интеграция, приёмка, результат. Runtime — fixture executables
// (подставные CLI, не живые модели), скопированные во временный каталог.
const fixtures = join(scratch, 'bin');
mkdirSync(fixtures);
for (const name of ['fake-claude', 'fake-codex']) {
  copyFileSync(join(root, 'tests', 'fixtures', 'bin', name), join(fixtures, name));
  chmodSync(join(fixtures, name), 0o755);
}
const app = join(scratch, 'greeting');
cpSync(join(installed, 'examples', 'single-task'), app, { recursive: true });
const scenario = join(scratch, 'scenario.json');
writeFileSync(
  scenario,
  JSON.stringify({
    writer: {
      files: { 'src/greet.js': "exports.greet = (n) => 'Hello, ' + n + '!';\n" },
      result: { completed: true, summary: 'greet', discoveries: [] },
    },
    reviewer: {
      result: {
        approved: true,
        summary: 'ok',
        findings: [],
        discoveries: [],
        execution: { commands: [], noCommandsReason: 'diff' },
        previous: [],
      },
    },
  }),
);
const policyPath = join(app, 'policy.json');
const appPolicy = JSON.parse(readFileSync(policyPath, 'utf8'));
appPolicy.isolation = { mode: 'none', domains: [] };
appPolicy.environment = { values: { FIXTURE_SCENARIO: scenario } };
writeFileSync(policyPath, JSON.stringify(appPolicy));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 's',
  GIT_AUTHOR_EMAIL: 's@s',
  GIT_COMMITTER_NAME: 's',
  GIT_COMMITTER_EMAIL: 's@s',
};
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: app, env: gitEnv });
execFileSync('git', ['add', '-A'], { cwd: app, env: gitEnv });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: app, env: gitEnv });
const state = join(scratch, 'state');
const cycle = spawnSync(
  bin,
  ['run', '--graph', join(app, 'graph.json'), '--policy', policyPath, '--state', state],
  {
    cwd: scratch,
    encoding: 'utf8',
    env: {
      ...process.env,
      HARNESS_CLAUDE_BIN: join(fixtures, 'fake-claude'),
      HARNESS_CODEX_BIN: join(fixtures, 'fake-codex'),
    },
  },
);
if (cycle.status !== 0) fail('run примера: ' + cycle.stderr + cycle.stdout);
const outcome = spawnSync(bin, ['result', '--state', state, '--work', 'add-greeting'], {
  cwd: scratch,
  encoding: 'utf8',
});
const envelope = JSON.parse(outcome.stdout);
const accepted = execFileSync('git', ['rev-parse', 'refs/heads/harness/accepted'], {
  cwd: app,
  encoding: 'utf8',
}).trim();
if (envelope.data?.result?.outcome !== 'accepted' || envelope.data.result.shas.result !== accepted)
  fail('результат примера не принят или SHA не совпадает с target ref: ' + outcome.stdout);
console.log(
  `smoke-package: ${packed.filename} (${packed.files.length} файлов) установлен, полный цикл пройден на fixture runtime (механика, не качество модели); sha512 ${packed.integrity}`,
);
