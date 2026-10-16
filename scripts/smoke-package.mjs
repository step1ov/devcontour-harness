/**
 * Проверка настоящего архива: состав по whitelist, установка без dev
 * зависимостей и скриптов в независимый каталог, запуск CLI и импорт
 * библиотеки из чужого cwd. Исходный checkout после упаковки не читается.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
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

const lib = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    "const m = await import('devcontour-harness'); const c = await import('devcontour-harness/contracts'); if (m.API_VERSION !== c.API_VERSION || typeof m.graphIssues !== 'function') process.exit(3); console.log(m.HARNESS_VERSION);",
  ],
  { cwd: consumer, encoding: 'utf8' },
);
if (lib.status !== 0 || lib.stdout.trim() !== packed.version)
  fail('импорт библиотеки: ' + lib.stderr);
console.log(
  `smoke-package: ${packed.filename} (${packed.files.length} файлов) установлен и работает; sha512 ${packed.integrity}`,
);
