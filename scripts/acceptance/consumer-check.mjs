#!/usr/bin/env node
/**
 * A01 — прежний потребитель с новым архивом.
 *
 *   node scripts/acceptance/consumer-check.mjs <devcontour-harness-<ver>.tgz>
 *     [--out <dir>] [--offline] [--keep] [--gate npm|node]
 *
 * 1. Копия `tests/fixtures/consumer-alpha5` во временный каталог; установка
 *    ТОЛЬКО архива (`npm install --omit=dev`), проверка: у потребителя нет
 *    devDependencies пакета.
 * 2. Внешний TypeScript (закреплённая версия) ставится в отдельный каталог и
 *    проверяет типы потребителя (прежние реализации WorkSource, ContextSource,
 *    ResultSink, ExecutionHost, ExecutionStore) против `.d.ts` архива.
 * 3. Прежнее хранилище проходит публичный `executionStoreContract`.
 * 4. Файловый сценарий (CLI + API + прежний хост) на fixture runtime; журнал
 *    загруженных модулей показывает, что Relay/память/коннекторы не
 *    загружались и не регистрировались.
 * Итог — `<out>/report.json`; exit 0 только без отказов. Контроль: тот же
 * скрипт на архиве 0.1.0-alpha.5 должен проходить так же.
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  Recorder,
  TYPESCRIPT,
  TYPES_NODE,
  fixtureRuntime,
  harnessRoot,
  installCompiler,
  installConsumer,
  processTrace,
  scratchDir,
  sha256File,
  tarballArg,
  writeReport,
} from './package-lib.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    offline: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    gate: { type: 'string', default: 'npm' },
  },
});
const tarball = tarballArg(positionals[0]);
const work = scratchDir('harness-a01-');
const out = resolve(values.out ?? scratchDir('harness-a01-out-'));
const rec = new Recorder(join(out, 'logs'));
const consumer = join(work, 'consumer');
cpSync(join(harnessRoot, 'tests', 'fixtures', 'consumer-alpha5'), consumer, {
  recursive: true,
  filter: (p) => !p.includes('node_modules'),
});

installConsumer(rec, {
  dir: consumer,
  tarball,
  offline: values.offline,
  label: 'npm install archive',
});
const pkg = JSON.parse(
  readFileSync(join(consumer, 'node_modules', 'devcontour-harness', 'package.json'), 'utf8'),
);
const installed = readdirSync(join(consumer, 'node_modules')).filter((n) => !n.startsWith('.'));
const devLeaks = Object.keys(pkg.devDependencies ?? {}).filter((d) =>
  existsSync(join(consumer, 'node_modules', d)),
);
rec.assert(!devLeaks.length, 'у потребителя devDependencies пакета: ' + devLeaks.join(', '));

const { tsc, typeRoots } = installCompiler(rec, join(work, 'compiler'), values.offline);
const typecheck = rec.run('typecheck consumer (external tsc)', process.execPath, [
  tsc,
  '-p',
  join(consumer, 'tsconfig.json'),
  '--typeRoots',
  typeRoots,
]);
rec.assert(typecheck.status === 0, 'типы потребителя: ' + typecheck.stdout.slice(0, 3000));

const contract = rec.run(
  'executionStoreContract on legacy store',
  process.execPath,
  ['--test', '--test-reporter=tap', 'src/store-contract.mjs'],
  { cwd: consumer },
);
const count = (name) => Number(contract.stdout.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1]);
rec.assert(
  contract.status === 0 && count('pass') > 0,
  'договор хранилища: ' + contract.stdout.slice(-2000),
);

const trace = processTrace(join(work, 'trace'));
const bin = fixtureRuntime(join(work, 'bin'));
const scenarioWork = join(work, 'scenario');
const scenario = rec.run(
  'file scenario (cli, api, legacy host)',
  process.execPath,
  ['src/scenario.mts'],
  {
    cwd: consumer,
    env: {
      ...process.env,
      SCENARIO_WORK: scenarioWork,
      SCENARIO_BIN: bin,
      SCENARIO_GATE: values.gate,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, trace.nodeOptions].filter(Boolean).join(' '),
    },
  },
);
let result = {};
try {
  result = JSON.parse(readFileSync(join(scenarioWork, 'scenario.json'), 'utf8'));
} catch {
  /* сценарий упал до отчёта */
}
rec.assert(scenario.status === 0, 'сценарий: ' + (result.failure ?? scenario.stderr.slice(-2000)));
for (const flow of ['cli', 'api', 'host'])
  rec.assert(result[flow]?.outcome === 'accepted', `поток ${flow} не дал принятого результата`);

// Ни Relay, ни память, ни коннекторы не загружались: прежнему потребителю они не нужны.
const pkgModules = trace
  .modules()
  .filter((u) => u.includes('/node_modules/devcontour-harness/lib/'))
  .map((u) => u.replace(/^.*\/node_modules\/devcontour-harness\//, ''));
const optIn = pkgModules.filter((m) => /^lib\/integrations\//.test(m));
rec.assert(!optIn.length, 'загружены opt-in интеграции: ' + optIn.join(', '));
const fixtureImports = readdirSync(join(consumer, 'src')).flatMap((f) =>
  [
    ...readFileSync(join(consumer, 'src', f), 'utf8').matchAll(/from '(devcontour-harness[^']*)'/g),
  ].map((m) => m[1]),
);
const spawned = trace.spawned();

const report = {
  id: 'A01',
  status: rec.failures.length ? 'FAIL' : 'PASS',
  tarball: { file: tarball, sha256: sha256File(tarball), version: pkg.version },
  node: process.version,
  compiler: { typescript: TYPESCRIPT, typesNode: TYPES_NODE, installedSeparately: true },
  consumer: {
    fixture: 'tests/fixtures/consumer-alpha5',
    nodeModules: installed,
    devDependenciesInstalled: devLeaks,
    publicImports: [...new Set(fixtureImports)].sort(),
  },
  typecheck: { exit: typecheck.status },
  storeContract: { exit: contract.status, pass: count('pass'), fail: count('fail') },
  scenario: result,
  loadedPackageModules: pkgModules.length,
  loadedOptInModules: optIn,
  spawnedPrograms: [...new Set(spawned.map((s) => s.file.split('/').pop()))].sort(),
  failures: rec.failures,
  steps: rec.steps,
};
writeReport(join(out, 'report.json'), report);
console.log(
  `A01 ${report.status}: ${pkg.version} sha256 ${report.tarball.sha256}; typecheck exit ${typecheck.status}; store contract ${report.storeContract.pass} pass; flows ${[
    'cli',
    'api',
    'host',
  ]
    .map((f) => f + '=' + (result[f]?.outcome ?? 'n/a'))
    .join(' ')}; opt-in modules loaded: ${optIn.length}; report ${join(out, 'report.json')}`,
);
if (!values.keep && !rec.failures.length) rmSync(work, { recursive: true, force: true });
else console.log('work dir kept: ' + work);
process.exit(rec.failures.length ? 1 : 0);
