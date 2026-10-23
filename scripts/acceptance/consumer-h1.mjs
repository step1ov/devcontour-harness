#!/usr/bin/env node
/**
 * H1-05 — DevContour-подобный потребитель общих операций на архиве.
 *
 *   node scripts/acceptance/consumer-h1.mjs <devcontour-harness-<ver>.tgz>
 *     [--out <dir>] [--offline] [--keep]
 *
 * 1. Копия `tests/fixtures/consumer-h1` во временный каталог; установка
 *    ТОЛЬКО архива; у потребителя нет devDependencies пакета; исходники
 *    потребителя импортируют только `devcontour-harness` и
 *    `devcontour-harness/projections`.
 * 2. `node src/run.mjs`: ответы хоста равны прежним строкам и формам
 *    (OP-DIAG-01…04, OP-SETUP-03/04 с порядком отказов M-2), корень и
 *    `./projections` отдают одни и те же функции.
 * 3. Импорт одного `devcontour-harness/projections` не разрешает ни одного
 *    `node:` модуля и не выходит за `lib/projections/**`,
 *    `lib/contracts/errors.js`, `lib/contracts/repair-policy.js`.
 * 4. Внешний TypeScript (закреплённая версия, отдельный каталог) проверяет
 *    `src/types-check.mts` против `.d.ts` архива.
 * Итог — `<out>/report.json`; exit 0 только без отказов.
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  Recorder,
  TYPESCRIPT,
  TYPES_NODE,
  harnessRoot,
  installCompiler,
  installConsumer,
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
  },
});
const tarball = tarballArg(positionals[0]);
const work = scratchDir('harness-consumer-h1-');
const out = resolve(values.out ?? scratchDir('harness-consumer-h1-out-'));
const rec = new Recorder(join(out, 'logs'));
const consumer = join(work, 'consumer');
cpSync(join(harnessRoot, 'tests', 'fixtures', 'consumer-h1'), consumer, {
  recursive: true,
  filter: (p) => !p.includes('node_modules'),
});

installConsumer(rec, {
  dir: consumer,
  tarball,
  offline: values.offline,
  label: 'npm install archive',
});
const installed = join(consumer, 'node_modules', 'devcontour-harness');
const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
const devLeaks = Object.keys(pkg.devDependencies ?? {}).filter((d) =>
  existsSync(join(consumer, 'node_modules', d)),
);
rec.assert(!devLeaks.length, 'у потребителя devDependencies пакета: ' + devLeaks.join(', '));

// Импорты потребителя: из пакета — только корень и ./projections.
const imports = readdirSync(join(consumer, 'src')).flatMap((f) =>
  [
    ...readFileSync(join(consumer, 'src', f), 'utf8').matchAll(
      /(?:from|import)\s*\(?\s*'([^']+)'/g,
    ),
  ].map((m) => m[1]),
);
const external = [...new Set(imports.filter((s) => !s.startsWith('.') && !s.startsWith('node:')))];
const foreign = external.filter(
  (s) => s !== 'devcontour-harness' && s !== 'devcontour-harness/projections',
);
rec.assert(!foreign.length, 'посторонние импорты потребителя: ' + foreign.join(', '));
rec.assert(
  external.includes('devcontour-harness') && external.includes('devcontour-harness/projections'),
  'потребитель должен импортировать корень и ./projections: ' + external.join(', '),
);

// Хост на общих операциях: прежние строки и формы.
const host = rec.run('host mapping (node src/run.mjs)', process.execPath, ['src/run.mjs'], {
  cwd: consumer,
});
let hostReport = {};
try {
  hostReport = JSON.parse(host.stdout);
} catch {
  /* отчёт не JSON — отказ ниже */
}
rec.assert(
  host.status === 0 && hostReport.ok === true && hostReport.total > 0,
  'хост: ' + JSON.stringify(hostReport.failed ?? host.stderr.slice(-2000)),
);

// ./projections без node:* — как в браузерном бандле. Хук разрешения
// регистрируется до импорта и записывает каждый разрешённый URL.
const resolvedLog = join(work, 'projections-resolved.log');
const hook = join(work, 'resolve-hook.mjs');
writeFileSync(
  hook,
  `import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); appendFileSync(${JSON.stringify(resolvedLog)}, r.url + '\\n'); return r; } });
`,
);
const browser = rec.run(
  'import devcontour-harness/projections only',
  process.execPath,
  [
    '--import',
    pathToFileURL(hook).href,
    '--input-type=module',
    '-e',
    "const p = await import('devcontour-harness/projections'); if (typeof p.chainRoots !== 'function') throw new Error('chainRoots');",
  ],
  { cwd: consumer },
);
const resolved = existsSync(resolvedLog)
  ? [...new Set(readFileSync(resolvedLog, 'utf8').split('\n').filter(Boolean))]
  : [];
const lib = pathToFileURL(join(installed, 'lib')).href + '/';
const allowed = (u) =>
  u.startsWith(lib + 'projections/') ||
  u === lib + 'contracts/errors.js' ||
  u === lib + 'contracts/repair-policy.js';
const builtins = resolved.filter((u) => u.startsWith('node:'));
const outside = resolved.filter((u) => !u.startsWith('node:') && !allowed(u));
rec.assert(browser.status === 0, 'импорт ./projections: ' + browser.stderr.slice(-2000));
rec.assert(resolved.length > 0, 'журнал разрешения ./projections пуст');
rec.assert(!builtins.length, './projections разрешает node:*: ' + builtins.join(', '));
rec.assert(!outside.length, './projections выходит за допустимые файлы: ' + outside.join(', '));

const { tsc, typeRoots } = installCompiler(rec, join(work, 'compiler'), values.offline);
const typecheck = rec.run('typecheck consumer-h1 (external tsc)', process.execPath, [
  tsc,
  '-p',
  join(consumer, 'tsconfig.json'),
  '--typeRoots',
  typeRoots,
]);
rec.assert(typecheck.status === 0, 'типы потребителя: ' + typecheck.stdout.slice(0, 3000));

const report = {
  id: 'consumer-h1',
  criterion: 'H1-05',
  status: rec.failures.length ? 'FAIL' : 'PASS',
  tarball: { file: tarball, sha256: sha256File(tarball), version: pkg.version },
  node: process.version,
  compiler: { typescript: TYPESCRIPT, typesNode: TYPES_NODE, installedSeparately: true },
  consumer: {
    fixture: 'tests/fixtures/consumer-h1',
    publicImports: external.sort(),
    devDependenciesInstalled: devLeaks,
  },
  host: { exit: host.status, total: hostReport.total, failed: hostReport.failed },
  projectionsOnly: {
    exit: browser.status,
    resolved: resolved.map((u) => (u.startsWith(lib) ? 'lib/' + u.slice(lib.length) : u)),
    builtins,
    outside,
  },
  typecheck: { exit: typecheck.status },
  failures: rec.failures,
  steps: rec.steps,
};
writeReport(join(out, 'report.json'), report);
console.log(
  `consumer-h1 ${report.status}: ${pkg.version} sha256 ${report.tarball.sha256}; host ${hostReport.total ?? 0} checks, failed ${hostReport.failed?.length ?? 'n/a'}; ./projections modules ${resolved.length}, node: ${builtins.length}; typecheck exit ${typecheck.status}; report ${join(out, 'report.json')}`,
);
if (!values.keep && !rec.failures.length) rmSync(work, { recursive: true, force: true });
else console.log('work dir kept: ' + work);
process.exit(rec.failures.length ? 1 : 0);
