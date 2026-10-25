/**
 * Проверка настоящего архива: состав по whitelist, установка без dev
 * зависимостей и скриптов в независимый каталог, запуск CLI и импорт
 * библиотеки из чужого cwd. Исходный checkout после упаковки не читается:
 * каждый процесс установленного пакета пишет журнал загруженных модулей и
 * открытых файлов, и ни один путь журнала не может вести в checkout.
 *
 * H1: проекции без node:* и одна реализация с корнем, DevContour-подобный
 * потребитель общих операций (`tests/fixtures/consumer-h1`) и маршрут
 * самостоятельного проекта из установленного bin: init → граф из facts →
 * validate → run → принятый SHA → explain → повтор init.
 *
 * H2: `planDraft` корня и `/contracts` — один объект; DevContour-подобный
 * потребитель планирования (`tests/fixtures/consumer-h2`: байты схемы плана,
 * prompt с host-инструкциями, статусы импорта плана) и маршрут планирования
 * из установленного bin: init → plan-request (без вызовов runtime и state) →
 * draft ведущего агента → plan-check → validate → review-plan.
 *
 * H3: каталог `operationCatalogSchema` корня и `/contracts` — один объект;
 * установленный bin `capabilities` = `harnessCapabilities()` установленной
 * библиотеки; `plan-request` с постановкой ~1.1 MB — явный
 * `RESPONSE_TOO_LARGE` без усечения; DevContour-подобный потребитель каталога,
 * байтовых границ и pager-ов (`tests/fixtures/consumer-h3`).
 *
 * `--archive F` проверяет уже выпущенный архив вместо свежей упаковки,
 * `--offline` ставит его без сети (из кэша npm).
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const { values: options } = parseArgs({
  options: { archive: { type: 'string' }, offline: { type: 'boolean', default: false } },
});
const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-smoke-')));
const fail = (message) => {
  console.error('smoke-package: ' + message);
  process.exit(1);
};

/** Архив: свежая упаковка checkout либо указанный выпуск (его байты не меняются). */
const archived = (file) => {
  const copy = join(scratch, basename(file));
  copyFileSync(file, copy);
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOzf', copy, 'package/package.json'], { encoding: 'utf8' }),
  );
  const files = execFileSync('tar', ['-tzf', copy], { encoding: 'utf8' })
    .split('\n')
    .filter((p) => p && !p.endsWith('/'))
    .map((p) => ({ path: p.replace(/^package\//, '') }));
  return {
    filename: basename(copy),
    version: manifest.version,
    files,
    integrity: 'sha512-' + createHash('sha512').update(readFileSync(copy)).digest('base64'),
  };
};
const [packed] = options.archive
  ? [archived(resolve(options.archive))]
  : JSON.parse(
      execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], {
        cwd: root,
        encoding: 'utf8',
      }),
    );

// Содержимое архива без путей машины автора, приватных каталогов и ключей.
const unpacked = join(scratch, 'unpacked');
mkdirSync(unpacked);
execFileSync('tar', ['-xzf', join(scratch, packed.filename), '-C', unpacked]);
const forbidden = [root, process.env.HOME, '/.private/', 'PRIVATE KEY-----'].filter(
  (s) => s && s.length > 6,
);
for (const entry of readdirSync(unpacked, { recursive: true })) {
  const file = join(unpacked, entry);
  if (!statSync(file).isFile()) continue;
  const text = readFileSync(file, 'utf8');
  const hit = forbidden.find((s) => text.includes(s));
  if (hit) fail(`архив содержит «${hit}»: ${entry}`);
}
const allowed = [
  /^package\.json$/,
  /^LICENSE$/,
  /^README\.md$/,
  /^lib\/.+\.(js|d\.ts)$/,
  /^schemas\/[a-z-]+\.schema\.json$/,
  /^docs\/[a-z-]+\.md$/,
  /^examples\/[a-z-]+\/[a-z-]+\.json$/,
  /^examples\/README\.md$/,
  /^examples\/[a-z-]+\/README\.md$/,
  /^examples\/external-connector\/connector\.mjs$/,
  /^examples\/files-only\/context\/[a-z-]+\/[a-z-]+\.md$/,
  /^examples\/[a-z-]+\/test\/[a-z-]+\.js$/,
  /^examples\/[a-z-]+\/src\/\.gitkeep$/,
  // Fixtures toolchains (T01): target-проект, политика, поручение и реализации fixture writer.
  /^examples\/toolchains\/README\.md$/,
  /^examples\/toolchains\/[a-z-]+\/(policy|task)\.json$/,
  /^examples\/toolchains\/[a-z-]+\/(repo|good|bad)\/[A-Za-z0-9_.\/-]+$/,
  // Документация интеграций и заметки выпусков (alpha.6).
  /^docs\/(integrations|release-notes)\/[a-z0-9.-]+\.md$/,
  // Рецепт Turbo Starter (S01–S06): политика, мост compose, приёмочные тесты, шаблоны env, патчи.
  /^examples\/turbo-starter\/(setup|cleanup)\.mjs$/,
  /^examples\/turbo-starter\/[a-z.-]+\.json$/,
  /^examples\/turbo-starter\/harness\/[a-z.-]+\.(mjs|yml)$/,
  /^examples\/turbo-starter\/harness\/acceptance\/[a-z-]+\.test\.mjs$/,
  /^examples\/turbo-starter\/harness\/env\/[a-z-]+\.env\.template$/,
  /^examples\/turbo-starter\/changes\/[a-z-]+\.patch$/,
  // Шаблоны controller mode.
  /^templates\/controller-mode\/([A-Za-z.-]+\.md|[a-z-]+\.json)$/,
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
  'docs/upgrade.md',
  'docs/quickstart.md',
  'examples/README.md',
  // H1: общие операции, init, explain и их схемы.
  'lib/projections/index.js',
  'lib/setup/files.js',
  'lib/init/project.js',
  'lib/explain/diagnose.js',
  'schemas/project-manifest.schema.json',
  'schemas/stop-diagnosis.schema.json',
  'docs/standalone.md',
  // H2: планирование ведущим агентом.
  'lib/planning/check.js',
  'lib/contracts/planning.js',
  'schemas/plan-draft.schema.json',
  'templates/plan-draft.json',
  // H3: каталог общих операций и границы ответа.
  'lib/catalog/index.js',
  'lib/catalog/page.js',
  'lib/contracts/catalog.js',
])
  if (!packed.files.some((f) => f.path === required)) fail('нет файла ' + required);

// ./projections годится для браузерного бандла: всё, что достижимо от
// lib/projections/index.js, лежит в lib/projections/** или в двух
// разрешённых листах contracts и не импортирует node:* (Q3, K1).
const libDir = join(unpacked, 'package', 'lib');
const projectionFiles = new Set();
const walk = (file) => {
  if (projectionFiles.has(file)) return;
  projectionFiles.add(file);
  const rel = file.slice(libDir.length + 1);
  if (
    !rel.startsWith('projections/') &&
    rel !== 'contracts/errors.js' &&
    rel !== 'contracts/repair-policy.js'
  )
    fail('./projections достигает ' + rel);
  const text = readFileSync(file, 'utf8');
  if (/['"`]node:/.test(text)) fail('./projections содержит node: в ' + rel);
  for (const [, spec] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
    if (!spec.startsWith('.')) fail(`./projections импортирует «${spec}» в ${rel}`);
    walk(resolve(file, '..', spec));
  }
};
walk(join(libDir, 'projections', 'index.js'));
if (projectionFiles.size < 2) fail('граф импортов ./projections пуст');

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
    options.offline ? '--offline' : '--prefer-offline',
    join(scratch, packed.filename),
  ],
  { cwd: consumer, stdio: 'inherit' },
);

// DevContour-подобный потребитель общих операций ставится тем же архивом
// (до журнала чтения: сам npm не относится к процессам пакета).
const consumerH1 = join(scratch, 'consumer-h1');
cpSync(join(root, 'tests', 'fixtures', 'consumer-h1'), consumerH1, {
  recursive: true,
  filter: (p) => !p.includes('node_modules'),
});
execFileSync(
  'npm',
  [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    options.offline ? '--offline' : '--prefer-offline',
    join(scratch, packed.filename),
  ],
  { cwd: consumerH1, stdio: 'inherit' },
);
// Потребитель планирования: архив и собственный zod той же версии (одна копия).
const consumerH2 = join(scratch, 'consumer-h2');
cpSync(join(root, 'tests', 'fixtures', 'consumer-h2'), consumerH2, {
  recursive: true,
  filter: (p) => !p.includes('node_modules'),
});
execFileSync(
  'npm',
  [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    options.offline ? '--offline' : '--prefer-offline',
    join(scratch, packed.filename),
  ],
  { cwd: consumerH2, stdio: 'inherit' },
);
// Потребитель каталога: архив и собственный zod той же версии (одна копия).
const consumerH3 = join(scratch, 'consumer-h3');
cpSync(join(root, 'tests', 'fixtures', 'consumer-h3'), consumerH3, {
  recursive: true,
  filter: (p) => !p.includes('node_modules'),
});
execFileSync(
  'npm',
  [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    options.offline ? '--offline' : '--prefer-offline',
    join(scratch, packed.filename),
  ],
  { cwd: consumerH3, stdio: 'inherit' },
);

// Журнал чтения: каждый node-процесс установленного пакета (CLI, библиотека,
// fixture runtime) загружает модуль, который записывает пути загруженных
// модулей и открытых файлов. Модуль лежит во временном каталоге, не в checkout.
const traceLog = join(scratch, 'reads.log');
const trace = join(scratch, 'trace.mjs');
writeFileSync(
  trace,
  `import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
const log = ${JSON.stringify(traceLog)};
const append = fs.appendFileSync.bind(fs);
const note = (p) => { try { append(log, String(p instanceof URL ? p.pathname : p) + '\\n'); } catch {} };
registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); if (r.url.startsWith('file:')) note(new URL(r.url)); return r; } });
for (const name of ['readFileSync', 'openSync', 'readdirSync', 'existsSync', 'statSync', 'readFile', 'open', 'readdir', 'cpSync', 'copyFileSync']) {
  const original = fs[name];
  fs[name] = function (p, ...rest) { if (typeof p === 'string' || p instanceof URL) note(p); return original.call(this, p, ...rest); };
}
for (const name of ['readFile', 'open', 'readdir', 'stat']) {
  const original = fs.promises[name];
  fs.promises[name] = function (p, ...rest) { if (typeof p === 'string' || p instanceof URL) note(p); return original.call(this, p, ...rest); };
}
syncBuiltinESMExports();
`,
);
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--import ' + pathToFileURL(trace).href]
  .filter(Boolean)
  .join(' ');
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
for (const name of ['validateInputs', 'validationIssues', 'crossIssues', 'graphIssues', 'policyIssues', 'contextIssues', 'reviewIssues', 'selectReviewer'])
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

// Одна реализация: каждый экспорт ./projections — тот же объект, что в корне.
const identityCheck = `
const m = await import('devcontour-harness');
const p = await import('devcontour-harness/projections');
if (m.chainRoots !== p.chainRoots) throw new Error('chainRoots: корень и ./projections — разные функции');
const differ = Object.keys(p).filter((k) => m[k] !== p[k]);
if (differ.length) throw new Error('разные объекты: ' + differ.join(', '));
for (const name of ['chainRoots', 'workProgress', 'nextAction', 'queueStop', 'explainStop', 'stopCodeOf', 'clipText', 'clipDeep'])
  if (typeof p[name] !== 'function') throw new Error('нет экспорта ./projections ' + name);
for (const name of ['inspectPath', 'checkDestination', 'listRegularFiles', 'planFileWrites', 'applyFileWrites', 'initProject', 'diagnoseState'])
  if (typeof m[name] !== 'function') throw new Error('нет экспорта ' + name);
// H2: схема draft — одна реализация в корне и /contracts.
const c = await import('devcontour-harness/contracts');
for (const name of ['planDraft', 'planDraftJsonSchema', 'planDraftTaskShape', 'planDraftSchema', 'planningFactsSchema', 'planRequestDataSchema', 'planCheckDataSchema'])
  if (m[name] === undefined || m[name] !== c[name]) throw new Error('корень и /contracts: разные ' + name);
for (const name of ['planningRequest', 'planningBasis', 'planningFactsOf', 'standaloneInstructions', 'draftIssues', 'checkGaps', 'draftToGraph', 'planCheck', 'planRequestOf'])
  if (typeof m[name] !== 'function') throw new Error('нет экспорта ' + name);
// H3: схемы каталога — одна реализация в корне и /contracts.
for (const name of ['operationCatalogSchema', 'catalogToolSchema'])
  if (m[name] === undefined || m[name] !== c[name]) throw new Error('корень и /contracts: разные ' + name);
for (const name of ['utf8Bytes', 'jsonBytes', 'checkJsonBytes', 'pageItems', 'operationCatalog', 'harnessCapabilities', 'cliInputSchema', 'isSharedOperation'])
  if (typeof m[name] !== 'function') throw new Error('нет экспорта ' + name);
console.log(Object.keys(p).length);
`;
const identity = spawnSync(process.execPath, ['--input-type=module', '-e', identityCheck], {
  cwd: consumer,
  encoding: 'utf8',
});
if (identity.status !== 0) fail('корень и ./projections: ' + identity.stderr);

// Хост на общих операциях: прежние строки OP-DIAG-01…04 и порядок отказов setup M-2.
const host = spawnSync(process.execPath, ['src/run.mjs'], { cwd: consumerH1, encoding: 'utf8' });
let hostReport;
try {
  hostReport = JSON.parse(host.stdout);
} catch {
  fail('consumer-h1: ответ не JSON: ' + host.stderr + host.stdout);
}
if (host.status !== 0 || hostReport.ok !== true || !(hostReport.total > 0))
  fail('consumer-h1: ' + JSON.stringify(hostReport.failed) + ' ' + host.stderr);
for (const name of [
  'identity: root === ./projections',
  'OP-DIAG-01 host exhausted',
  'OP-DIAG-01 host kinds',
  'OP-DIAG-04 runtime latest',
  'OP-DIAG-04 M-3 latest without message',
  'OP-DIAG-03 steps',
  'OP-DIAG-02 progress',
  'M-2 profile content-differs',
  'M-2 host checks before profile',
  'M-2 symlink before host checks',
  'OP-SETUP-04 create-only and repeat',
])
  if (!hostReport.checks.some((c) => c.name === name && c.ok))
    fail('consumer-h1: нет проверки ' + name);
// Хост планирования: байты схемы плана, prompt с host-инструкциями, статусы импорта.
const hostH2 = spawnSync(process.execPath, ['src/run.mjs'], { cwd: consumerH2, encoding: 'utf8' });
let hostH2Report;
try {
  hostH2Report = JSON.parse(hostH2.stdout);
} catch {
  fail('consumer-h2: ответ не JSON: ' + hostH2.stderr + hostH2.stdout);
}
if (hostH2.status !== 0 || hostH2Report.ok !== true || !(hostH2Report.total > 0))
  fail('consumer-h2: ' + JSON.stringify(hostH2Report.failed) + ' ' + hostH2.stderr);
for (const name of [
  'zod: one copy for host and package',
  'identity: root === ./contracts',
  'M-5 planSchema bytes (draft-7)',
  'M-5 plan input schema bytes (catalogDigest)',
  'K1 without keyOrder bytes differ',
  'OP-PLAN-01 S1 without product planner',
  'OP-PLAN-01 S12 host block before brief, brief last',
  'OP-PLAN-01 host instructions once, not in shared sections',
  'M-4 contracts whole in prompt',
  'C6 duplicate key → 400',
  'C6 unknown dependency → 404',
  'cycle → host assertDag 409',
  'AC14 host metadata roundtrip, extra keys dropped',
])
  if (!hostH2Report.checks.some((c) => c.name === name && c.ok))
    fail('consumer-h2: нет проверки ' + name);
for (const name of ['devcontour-plan-schema.json', 'devcontour-plan-input-schema.json'])
  if (
    !readFileSync(join(consumerH2, 'expected', name)).equals(
      readFileSync(join(root, 'tests', 'fixtures', 'planning', name)),
    )
  )
    fail('consumer-h2: expected/' + name + ' не байтовая копия снимка');
// Хост каталога: clip, байтовые проверки, pager-ы, каталог и /api/capabilities = legacy.
const hostH3 = spawnSync(process.execPath, ['src/run.mjs'], { cwd: consumerH3, encoding: 'utf8' });
let hostH3Report;
try {
  hostH3Report = JSON.parse(hostH3.stdout);
} catch {
  fail('consumer-h3: ответ не JSON: ' + hostH3.stderr + hostH3.stdout);
}
if (hostH3.status !== 0 || hostH3Report.ok !== true || !(hostH3Report.total > 0))
  fail('consumer-h3: ' + JSON.stringify(hostH3Report.failed) + ' ' + hostH3.stderr);
for (const name of [
  'zod: one copy for host and package',
  'identity: root === ./projections clip, catalog exports',
  'M04 short/clip = legacy',
  'M05 byte guards = legacy',
  'M05 context page = legacy',
  'M05 context page errors 400/400/409/409/413',
  'Q4 observability page = legacy',
  'Q4 observability errors 409/409/413',
  'AC19 pages reassemble without loss',
  'AC18 catalog = legacy builder',
  'AC18 snapshot tools bytes (21)',
  'AC18 catalogDigest subset = legacy',
  'AC18 /api/capabilities body = legacy (HTTP)',
  'H3-01 host and harness catalogs separate',
  'Q5 leafContent and digest',
  'outputSchema absent without output',
])
  if (!hostH3Report.checks.some((c) => c.name === name && c.ok))
    fail('consumer-h3: нет проверки ' + name);
for (const name of ['devcontour-capabilities.json', 'devcontour-builtin-profiles.json'])
  if (
    !readFileSync(join(consumerH3, 'expected', name)).equals(
      readFileSync(join(root, 'tests', 'fixtures', 'catalog', name)),
    )
  )
    fail('consumer-h3: expected/' + name + ' не байтовая копия снимка');

// H3: каталог установленного bin = harnessCapabilities() установленной библиотеки.
const capabilities = run(['capabilities']);
let capabilitiesEnvelope;
try {
  capabilitiesEnvelope = JSON.parse(capabilities.stdout);
} catch {
  fail('capabilities: ответ не JSON: ' + capabilities.stdout + capabilities.stderr);
}
const libCapabilities = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    "const m = await import('devcontour-harness'); process.stdout.write(JSON.stringify(m.harnessCapabilities()));",
  ],
  { cwd: consumer, encoding: 'utf8' },
);
const catalog = capabilitiesEnvelope.data;
if (
  capabilities.status !== 0 ||
  capabilitiesEnvelope.ok !== true ||
  libCapabilities.status !== 0 ||
  !isDeepStrictEqual(catalog, JSON.parse(libCapabilities.stdout)) ||
  catalog.name !== 'devcontour-harness' ||
  catalog.version !== packed.version ||
  catalog.maxInputBytes !== 100000 ||
  catalog.maxResultBytes !== 1048576 ||
  JSON.stringify(catalog.tools.map((t) => t.name)) !==
    JSON.stringify(['init', 'explain', 'plan-request', 'plan-check', 'capabilities'])
)
  fail(
    'capabilities: ' +
      capabilities.status +
      ' ' +
      capabilities.stdout.slice(0, 500) +
      capabilities.stderr +
      libCapabilities.stderr,
  );
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

// explain из установленного bin: только чтение, данные CLI равны библиотеке.
const explainOf = (state, policyPath, ...extra) =>
  spawnSync(bin, ['explain', '--state', state, '--policy', policyPath, ...extra], {
    cwd: scratch,
    encoding: 'utf8',
    env: {
      ...process.env,
      HARNESS_CLAUDE_BIN: join(fixtures, 'fake-claude'),
      HARNESS_CODEX_BIN: join(fixtures, 'fake-codex'),
    },
  });
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const exhausted = project('explain-gate', { 'src/greet.js': "exports.greet = () => 'Hi';\n" });
exhausted.run();
const stateDb = join(exhausted.state, 'state.sqlite');
const dbBefore = sha256(stateDb);
const explained = explainOf(exhausted.state, exhausted.policyPath);
const diagnoses = explained.status === 0 ? JSON.parse(explained.stdout).data?.diagnoses : undefined;
const gateStop = diagnoses?.find((d) => d.workId === 'add-greeting');
// maxAttempts 1: сбой gate исчерпал попытки — сброс решает человек.
if (
  gateStop?.code !== 'ATTEMPTS_EXHAUSTED' ||
  gateStop.cause !== 'gate' ||
  gateStop.actor !== 'user' ||
  gateStop.action !== 'reset-attempts' ||
  !gateStop.evidence.some((e) => e.kind === 'attempt')
)
  fail(
    'explain после GATE_FAILED: ' + explained.status + ' ' + explained.stdout + explained.stderr,
  );
const human = explainOf(exhausted.state, exhausted.policyPath, '--human');
if (
  human.status !== explained.status ||
  !human.stdout.includes('add-greeting ATTEMPTS_EXHAUSTED [gate/') ||
  human.stdout.trimStart().startsWith('{')
)
  fail('explain --human: ' + human.status + ' ' + human.stdout);
if (sha256(stateDb) !== dbBefore) fail('explain изменил state.sqlite');
const libExplain = `
const m = await import('devcontour-harness');
const { readFileSync } = await import('node:fs');
const policy = m.executionPolicySchema.parse(JSON.parse(readFileSync(${JSON.stringify(exhausted.policyPath)}, 'utf8')));
const adapters = {
  codex: m.cliAdapter('codex', { toolProfiles: policy.toolProfiles, executable: ${JSON.stringify(join(fixtures, 'fake-codex'))} }),
  claude: m.cliAdapter('claude', { toolProfiles: policy.toolProfiles, executable: ${JSON.stringify(join(fixtures, 'fake-claude'))} }),
};
const data = await m.diagnoseState({ stateDir: ${JSON.stringify(exhausted.state)}, policy, baseDir: ${JSON.stringify(exhausted.app)}, adapters });
process.stdout.write(JSON.stringify(data));
`;
const fromLib = spawnSync(process.execPath, ['--input-type=module', '-e', libExplain], {
  cwd: consumer,
  encoding: 'utf8',
});
if (
  fromLib.status !== 0 ||
  !isDeepStrictEqual(JSON.parse(fromLib.stdout), JSON.parse(explained.stdout).data)
)
  fail('данные explain CLI ≠ diagnoseState библиотеки: ' + fromLib.stderr + fromLib.stdout);
const busyStop = explainOf(busy.state, busy.policyPath);
if (
  busyStop.status !== 0 ||
  !JSON.parse(busyStop.stdout).data.diagnoses.some(
    (d) => d.code === 'CONTROLLER_BUSY' && d.actor === 'lead' && d.action === 'wait',
  )
)
  fail('explain занятой роли controller: ' + busyStop.stdout + busyStop.stderr);
const missingState = join(scratch, 'never-run-state');
const missing = explainOf(missingState, exhausted.policyPath);
if (missing.status !== 3 || JSON.parse(missing.stdout).error?.code !== 'NOT_FOUND')
  fail('explain без state: ' + missing.status + ' ' + missing.stdout);
if (existsSync(missingState)) fail('explain создал каталог state');

// Маршрут H1 из установленного bin: существующее npm-приложение в своём Git,
// init (план, запись), overlay fixture runtime, граф только из facts и
// шаблона пакета, validate, run, принятый SHA, explain, повтор init.
const h1 = join(scratch, 'npm-app');
cpSync(join(root, 'tests', 'fixtures', 'standalone', 'npm-app'), h1, { recursive: true });
// npm — не процесс пакета: без журнала чтения и вне checkout.
const npmVersion = execFileSync('npm', ['--version'], {
  cwd: scratch,
  encoding: 'utf8',
  env: { ...process.env, NODE_OPTIONS: '' },
}).trim();
const appPkg = JSON.parse(readFileSync(join(h1, 'package.json'), 'utf8'));
appPkg.packageManager = 'npm@' + npmVersion;
writeFileSync(join(h1, 'package.json'), JSON.stringify(appPkg, null, 2) + '\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: h1, env: gitEnv });
execFileSync('git', ['add', '-A'], { cwd: h1, env: gitEnv });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: h1, env: gitEnv });
const h1Head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: h1, encoding: 'utf8' }).trim();
const stateHome = join(scratch, 'state-home');
const h1Env = {
  ...process.env,
  HARNESS_STATE_HOME: stateHome,
  HARNESS_CLAUDE_BIN: join(fixtures, 'fake-claude'),
  HARNESS_CODEX_BIN: join(fixtures, 'fake-codex'),
};
const h1Run = (...args) => {
  const r = spawnSync(bin, args, { cwd: scratch, encoding: 'utf8', env: h1Env });
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  return { ...r, json };
};
const h1Plan = h1Run('init', '--repository', h1, '--plan');
if (
  h1Plan.status !== 0 ||
  h1Plan.json?.data?.mode !== 'plan' ||
  h1Plan.json.data.status !== 'new' ||
  h1Plan.json.data.conflicts !== 0 ||
  !h1Plan.json.data.toolchain.ready
)
  fail('init --plan: ' + h1Plan.status + ' ' + h1Plan.stdout + h1Plan.stderr);
if (existsSync(join(h1, '.harness'))) fail('init --plan записал .harness/');
const h1Init = h1Run('init', '--repository', h1);
const h1Data = h1Init.json?.data;
if (h1Init.status !== 0 || h1Data?.mode !== 'apply')
  fail('init: ' + h1Init.status + ' ' + h1Init.stdout + h1Init.stderr);
const createdRel = h1Data.created.map((f) => f.slice(h1.length + 1));
if (
  JSON.stringify(createdRel) !==
  JSON.stringify([
    '.harness/.gitignore',
    '.harness/README.md',
    '.harness/project.json',
    '.harness/policy.json',
  ])
)
  fail('init: порядок записи ' + JSON.stringify(createdRel));
const h1State = h1Data.manifest.paths.state;
if (!h1State.startsWith(join(stateHome, 'projects') + sep) || existsSync(h1State))
  fail('init: state вне state home или создан заранее: ' + h1State);
if (h1Data.profile.id !== 'npm-ci') fail('init: профиль ' + h1Data.profile.id);
const facts = h1Data.facts;
const changedOutside = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
  cwd: h1,
  encoding: 'utf8',
})
  .split('\n')
  .filter((l) => l && !l.startsWith('?? .harness/'));
if (changedOutside.length) fail('init изменил файлы вне .harness/: ' + changedOutside.join(', '));

// Overlay fixture runtime — адаптация для подставных CLI, как у примеров выше.
const h1Scenario = join(scratch, 'npm-app.scenario.json');
writeFileSync(
  h1Scenario,
  JSON.stringify({
    writer: {
      files: { 'src/greet.js': "exports.greet = (name) => 'Hello, ' + name + '!';\n" },
      result: { completed: true, summary: 'greet', discoveries: [] },
    },
    reviewer: { result: approve },
  }),
);
const h1PolicyPath = join(h1, '.harness', 'policy.json');
const h1Policy = JSON.parse(readFileSync(h1PolicyPath, 'utf8'));
h1Policy.isolation = { mode: 'none', domains: [] };
h1Policy.environment = { values: { FIXTURE_SCENARIO: h1Scenario } };
writeFileSync(h1PolicyPath, JSON.stringify(h1Policy, null, 2) + '\n');

// Граф: только facts init и шаблон пакета.
// Шаблон — из установленного пакета (документация, не вход init).
const graphTemplate = JSON.parse(readFileSync(join(installed, 'templates', 'graph.json'), 'utf8'));
const h1Graph = {
  ...graphTemplate,
  id: 'greeting',
  source: { connector: 'files', ref: 'greeting.json', revision: '1' },
  orders: [
    {
      ...graphTemplate.orders[0],
      id: 'add-greeting',
      source: { connector: 'files', ref: 'add-greeting', revision: '1' },
      title: 'Implement greet',
      goal: 'src/greet.js exports greet(name) returning "Hello, <name>!"',
      acceptance: ['greet("Ada") returns "Hello, Ada!"', 'The test gate passes with JUnit'],
      role: facts.roles[0].id,
      repositoryId: facts.repositoryId,
      writeScope: ['src'],
      gates: facts.gates.map((g) => g.id),
    },
  ],
};
const workDir = resolve(h1, facts.workDir);
mkdirSync(workDir, { recursive: true });
const h1GraphPath = join(workDir, 'greeting.json');
writeFileSync(h1GraphPath, JSON.stringify(h1Graph, null, 2) + '\n');
const h1Valid = h1Run('validate', '--graph', h1GraphPath, '--policy', h1PolicyPath);
if (h1Valid.status !== 0) fail('validate графа из facts: ' + h1Valid.stdout + h1Valid.stderr);
const h1Cycle = h1Run(
  'run',
  '--graph',
  h1GraphPath,
  '--policy',
  h1PolicyPath,
  '--state',
  h1State,
  '--author',
  'claude',
);
if (h1Cycle.status !== 0) fail('run маршрута H1: ' + h1Cycle.stdout + h1Cycle.stderr);
const h1Result = h1Run('result', '--state', h1State, '--work', 'add-greeting').json?.data?.result;
const h1Accepted = execFileSync('git', ['rev-parse', 'refs/heads/harness/accepted'], {
  cwd: h1,
  encoding: 'utf8',
}).trim();
if (h1Result?.outcome !== 'accepted' || h1Result.shas.result !== h1Accepted)
  fail('маршрут H1: не принят или SHA ≠ target ref: ' + JSON.stringify(h1Result));
const h1Explain = h1Run('explain', '--state', h1State, '--policy', h1PolicyPath);
if (
  h1Explain.status !== 0 ||
  !Array.isArray(h1Explain.json?.data?.diagnoses) ||
  h1Explain.json.data.diagnoses.some(
    (d) => d.workId === 'add-greeting' || d.code === 'RUNTIME_UNAVAILABLE',
  )
)
  fail('explain принятого маршрута: ' + h1Explain.stdout + h1Explain.stderr);
const h1Human = h1Run('explain', '--state', h1State, '--policy', h1PolicyPath, '--human');
if (h1Human.status !== 0 || h1Human.json !== undefined || !h1Human.stdout.trim())
  fail('explain --human маршрута: ' + h1Human.status + ' ' + h1Human.stdout);
const h1Again = h1Run('init', '--repository', h1);
if (
  h1Again.status !== 0 ||
  h1Again.json?.data?.created?.length !== 0 ||
  h1Again.json.data.status !== 'complete' ||
  h1Again.json.data.projectId !== h1Data.projectId ||
  h1Again.json.data.manifest.paths.state !== h1State
)
  fail('повтор init: ' + h1Again.stdout + h1Again.stderr);
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: h1, encoding: 'utf8' }).trim() !== h1Head)
  fail('маршрут H1 сдвинул HEAD основной ветки');

// Маршрут H2 из установленного bin: ведущий агент планирует сам. Отдельная
// копия npm-app с закоммиченной постановкой REQ-greet; plan-request и
// plan-check идут с runtime-ловушками (любой вызов пишет строку журнала) и
// не создают state; draft — из шаблона пакета и ответа plan-request.
const h2 = join(scratch, 'npm-app-h2');
cpSync(join(root, 'tests', 'fixtures', 'standalone', 'npm-app'), h2, { recursive: true });
writeFileSync(join(h2, 'package.json'), JSON.stringify(appPkg, null, 2) + '\n');
mkdirSync(join(h2, 'docs'));
writeFileSync(
  join(h2, 'docs', 'spec.md'),
  '# Greeting\n\n## REQ-greet: greet a person\n\ngreet(name) returns "Hello, <name>!".\n',
);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: h2, env: gitEnv });
execFileSync('git', ['add', '-A'], { cwd: h2, env: gitEnv });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: h2, env: gitEnv });
const trapLog = join(scratch, 'h2-runtime-trap.log');
const traps = join(scratch, 'traps');
mkdirSync(traps);
for (const name of ['claude', 'codex']) {
  writeFileSync(
    join(traps, name),
    `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(trapLog)}\nexit 97\n`,
  );
  chmodSync(join(traps, name), 0o755);
}
const trapCalls = () =>
  existsSync(trapLog) ? readFileSync(trapLog, 'utf8').split('\n').filter(Boolean).length : 0;
const h2Base = { ...process.env, HARNESS_STATE_HOME: join(scratch, 'state-home-h2') };
const h2Run = (env, ...args) => {
  const r = spawnSync(bin, args, { cwd: scratch, encoding: 'utf8', env: { ...h2Base, ...env } });
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  return { ...r, json };
};
const trapped = {
  HARNESS_CLAUDE_BIN: join(traps, 'claude'),
  HARNESS_CODEX_BIN: join(traps, 'codex'),
};
const fixtureBins = {
  HARNESS_CLAUDE_BIN: join(fixtures, 'fake-claude'),
  HARNESS_CODEX_BIN: join(fixtures, 'fake-codex'),
};
const h2Init = h2Run(trapped, 'init', '--repository', h2);
if (h2Init.status !== 0 || h2Init.json?.data?.mode !== 'apply')
  fail('H2 init: ' + h2Init.status + ' ' + h2Init.stdout + h2Init.stderr);
const h2State = h2Init.json.data.manifest.paths.state;
const h2Facts = h2Init.json.data.facts;
const h2PolicyPath = join(h2, '.harness', 'policy.json');
const h2Scenario = join(scratch, 'npm-app-h2.scenario.json');
writeFileSync(h2Scenario, JSON.stringify({ reviewer: { result: approve } }));
const h2Policy = JSON.parse(readFileSync(h2PolicyPath, 'utf8'));
h2Policy.isolation = { mode: 'none', domains: [] };
h2Policy.environment = { values: { FIXTURE_SCENARIO: h2Scenario } };
writeFileSync(h2PolicyPath, JSON.stringify(h2Policy, null, 2) + '\n');
const h2Work = resolve(h2, h2Facts.workDir);
mkdirSync(h2Work, { recursive: true });
const briefPath = join(h2Work, 'greeting.brief.md');
writeFileSync(briefPath, 'Implement greet(name) so that it returns "Hello, <name>!".\n');
const gitView = () =>
  ['status --porcelain --untracked-files=all', 'for-each-ref']
    .map((a) => execFileSync('git', a.split(' '), { cwd: h2, encoding: 'utf8' }))
    .join('\n---\n');
const h2GitBefore = gitView();

const request = h2Run(
  trapped,
  'plan-request',
  '--brief',
  briefPath,
  '--policy',
  h2PolicyPath,
  '--requirements',
  'docs/spec.md',
);
const requestData = request.json?.data;
if (
  request.status !== 0 ||
  requestData?.readOnly !== true ||
  requestData.draftSchema !== 'plan-draft' ||
  requestData.maxTasks !== 30 ||
  !/^[a-f0-9]{64}$/.test(requestData.basis ?? '') ||
  !requestData.prompt.includes(JSON.stringify(requestData.facts.roles)) ||
  !h2Facts.roles.every((r) => requestData.prompt.includes(`"role":"${r.id}"`)) ||
  !h2Facts.gates.every((g) => requestData.prompt.includes(`"id":"${g.id}"`)) ||
  !requestData.prompt.includes(`"id":"${h2Facts.repositoryId}"`) ||
  !requestData.prompt.endsWith('User brief:\n' + readFileSync(briefPath, 'utf8'))
)
  fail('plan-request: ' + request.status + ' ' + request.stdout + request.stderr);
const requestHuman = h2Run(
  trapped,
  'plan-request',
  '--brief',
  briefPath,
  '--policy',
  h2PolicyPath,
  '--requirements',
  'docs/spec.md',
  '--human',
);
if (requestHuman.status !== 0 || requestHuman.stdout !== requestData.prompt + '\n')
  fail('plan-request --human: ' + requestHuman.status + ' ' + requestHuman.stdout.slice(0, 500));
if (trapCalls() !== 0) fail('plan-request вызвал runtime: ' + readFileSync(trapLog, 'utf8'));
if (existsSync(h2State)) fail('plan-request создал state: ' + h2State);
if (gitView() !== h2GitBefore) fail('plan-request изменил репозиторий или refs');

// Draft пишет ведущий агент: шаблон пакета, факты и снимок требований из prompt.
const snapshotSection = requestData.prompt
  .split('\n\n')
  .find((s) => s.startsWith('Requirement snapshots at HEAD'));
if (!snapshotSection) fail('plan-request: нет снимка требований в prompt');
const snapshots = JSON.parse(snapshotSection.slice(snapshotSection.indexOf('): ') + 3));
const reqGreet = snapshots
  .flatMap((s) => s.requirements.map((r) => ({ ...r, source: s.source })))
  .find((r) => r.id === 'REQ-greet');
if (!reqGreet) fail('plan-request: REQ-greet нет в снимке ' + snapshotSection);
const draftTemplate = JSON.parse(
  readFileSync(join(installed, 'templates', 'plan-draft.json'), 'utf8'),
);
const testGate = h2Facts.gates.find((g) => g.kind === 'test');
const draft = {
  ...draftTemplate,
  title: 'Greeting',
  description: 'Implement greet(name) for the npm application.',
  approved: true,
  tasks: [
    {
      ...draftTemplate.tasks[0],
      key: 'add-greeting',
      title: 'Implement greet',
      description: 'src/greet.js exports greet(name) returning "Hello, <name>!"',
      role: h2Facts.roles[0].id,
      repositoryId: h2Facts.repositoryId,
      writePaths: ['src'],
      gates: h2Facts.gates.map((g) => g.id),
      acceptance: ['greet("Ada") returns "Hello, Ada!"', 'The test gate passes with JUnit'],
      requirements: [
        {
          id: reqGreet.id,
          source: reqGreet.source,
          text: reqGreet.text,
          digest: reqGreet.digest,
          gate: testGate.id,
          scenario: 'greet("Ada") returns "Hello, Ada!"',
          testId: 'greet.greets',
        },
      ],
      approved: true,
      status: 'done',
    },
  ],
};
const draftPath = join(h2Work, 'greeting.draft.json');
writeFileSync(draftPath, JSON.stringify(draft, null, 2) + '\n');
// Новый файл draft агента — единственное изменение рабочего дерева до plan-check.
const h2GitDraft = gitView();
const checked = h2Run(
  trapped,
  'plan-check',
  '--draft',
  draftPath,
  '--policy',
  h2PolicyPath,
  '--brief',
  briefPath,
  '--basis',
  requestData.basis,
);
const checkData = checked.json?.data;
const order = checkData?.graph?.orders?.[0];
if (
  checked.status !== 0 ||
  checkData.issues.length !== 0 ||
  checkData.checkPlan.length !== 0 ||
  checkData.graph.id !== 'greeting' ||
  checkData.basis !== requestData.basis ||
  !/^[a-f0-9]{64}$/.test(checkData.graphDigest ?? '') ||
  order?.id !== 'add-greeting' ||
  order.goal !== draft.tasks[0].description ||
  JSON.stringify(order.writeScope) !== '["src"]' ||
  order.requirements?.[0]?.digest !== reqGreet.digest ||
  'approved' in order ||
  'status' in order ||
  'approved' in checkData.graph
)
  fail('plan-check: ' + checked.status + ' ' + checked.stdout + checked.stderr);
const stale = h2Run(
  trapped,
  'plan-check',
  '--draft',
  draftPath,
  '--policy',
  h2PolicyPath,
  '--brief',
  briefPath,
  '--basis',
  '0'.repeat(64),
);
if (
  stale.status !== 3 ||
  stale.json?.data?.issues?.[0]?.code !== 'APPROVAL_STALE' ||
  stale.json.data.graph !== undefined
)
  fail('plan-check с устаревшим basis: ' + stale.status + ' ' + stale.stdout);
if (trapCalls() !== 0) fail('plan-check вызвал runtime: ' + readFileSync(trapLog, 'utf8'));
if (existsSync(h2State)) fail('plan-check создал state: ' + h2State);
if (existsSync(join(h2, '.reports'))) fail('plan-check запускал gates (.reports/)');
if (gitView() !== h2GitDraft) fail('plan-check изменил репозиторий или refs');

// Граф сохраняет агент; validate и review-plan относятся к тому же digest.
const h2GraphPath = join(h2Work, 'greeting.json');
writeFileSync(h2GraphPath, JSON.stringify(checkData.graph, null, 2) + '\n');
const h2Valid = h2Run(fixtureBins, 'validate', '--graph', h2GraphPath, '--policy', h2PolicyPath);
if (h2Valid.status !== 0 || h2Valid.json?.data?.graphDigest !== checkData.graphDigest)
  fail('validate графа plan-check: ' + h2Valid.stdout + h2Valid.stderr);
const reviewed = h2Run(
  fixtureBins,
  'review-plan',
  '--state',
  h2State,
  '--graph',
  h2GraphPath,
  '--policy',
  h2PolicyPath,
  '--author',
  'claude',
);
const record = reviewed.json?.data;
if (
  reviewed.status !== 0 ||
  record?.kind !== 'plan' ||
  record.subject !== 'greeting' ||
  record.approved !== true ||
  record.digest !== checkData.graphDigest
)
  fail(
    'review-plan графа plan-check: ' + reviewed.status + ' ' + reviewed.stdout + reviewed.stderr,
  );
const reviewerCalls = ['codex', 'claude'].map((r) => {
  const counter = `${h2Scenario}.${r}.reviewer.count`;
  return existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
});
if (reviewerCalls[0] !== 1 || reviewerCalls[1] !== 0 || trapCalls() !== 0)
  fail('review-plan: ожидался один вызов reviewer codex, получено ' + reviewerCalls);

// H3: на той же копии npm-app после init ответ plan-request с постановкой
// ~1.1 MB не помещается в предел транспорта — явный RESPONSE_TOO_LARGE, exit 2,
// stdout — один конверт отказа без частичных данных. Постановка вне репозитория.
const hugeLine = 'Implement greet(name) for the npm app; keep the brief verbatim.\n';
const hugeBrief = join(scratch, 'huge.brief.md');
writeFileSync(hugeBrief, hugeLine.repeat(Math.ceil(1_100_000 / hugeLine.length)));
const tooLarge = h2Run(trapped, 'plan-request', '--brief', hugeBrief, '--policy', h2PolicyPath);
if (
  tooLarge.status !== 2 ||
  tooLarge.json?.ok !== false ||
  tooLarge.json.error?.code !== 'RESPONSE_TOO_LARGE' ||
  Buffer.byteLength(tooLarge.stdout) >= 1048576 ||
  tooLarge.stdout.includes('keep the brief verbatim')
)
  fail(
    'plan-request сверх предела: ' +
      tooLarge.status +
      ' ' +
      tooLarge.stdout.slice(0, 500) +
      tooLarge.stderr,
  );
if (trapCalls() !== 0) fail('plan-request сверх предела вызвал runtime');

// Ни один процесс пакета не читал checkout: журнал есть и не ведёт в него.
if (!existsSync(traceLog)) fail('журнал чтения пуст: модуль трассировки не загружался');
const reads = readFileSync(traceLog, 'utf8').split('\n').filter(Boolean);
const leaked = [...new Set(reads.map((p) => resolve(scratch, p)))].filter(
  (p) => p === root || p.startsWith(root + sep),
);
if (leaked.length) fail('пакет читал файлы checkout: ' + leaked.slice(0, 5).join(', '));
if (!reads.some((p) => p.includes(join('node_modules', 'devcontour-harness', 'lib'))))
  fail('журнал чтения не содержит модулей установленного пакета');

console.log(
  `smoke-package: ${packed.filename} (${packed.files.length} файлов) установлен; профили, шаблоны, полный цикл и отказы gate/области/controller без каталога skills пройдены на fixture runtime (механика, не качество модели); ./projections без node: (${projectionFiles.size} модулей), одна реализация с корнем, consumer-h1 ${hostReport.total} проверок, consumer-h2 ${hostH2Report.total} проверок, consumer-h3 ${hostH3Report.total} проверок; capabilities ${catalog.tools.length} операций; маршрут H1 init → run → accepted ${h1Accepted.slice(0, 12)}, explain, повтор init без записи; маршрут H2 init → plan-request → draft → plan-check → validate → review-plan ${record.digest.slice(0, 12)} без вызовов runtime при планировании, plan-request сверх предела — RESPONSE_TOO_LARGE; ${reads.length} чтений вне checkout; sha512 ${packed.integrity}`,
);
