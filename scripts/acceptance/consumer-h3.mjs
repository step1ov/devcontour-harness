#!/usr/bin/env node
/**
 * H3 — DevContour-подобный потребитель каталога операций, байтовых границ,
 * pager-ов и профиля с текстом листа на архиве.
 *
 *   node scripts/acceptance/consumer-h3.mjs <devcontour-harness-<ver>.tgz>
 *     [--out <dir>] [--offline] [--keep]
 *
 * 1. Копия `tests/fixtures/consumer-h3` во временный каталог; установка
 *    ТОЛЬКО архива и собственной зависимости потребителя `zod` (той же
 *    версии, что у пакета: одна копия); у потребителя нет devDependencies
 *    пакета; исходники импортируют только `devcontour-harness`,
 *    `devcontour-harness/contracts`, `devcontour-harness/projections`, `zod`
 *    и `node:*`; legacy-оракул `devcontour-legacy.mjs` не импортирует пакет.
 * 2. `expected/*.json` — байтовые копии снимков DevContour из
 *    `tests/fixtures/catalog` (SHA-256 сверяется).
 * 3. `node src/run.mjs`: clip, байтовые проверки и оба pager-а хоста равны
 *    legacy; 21 запись каталога снимка побайтово, digest подмножества и тело
 *    HTTP `/api/capabilities` равны legacy; каталоги хоста и harness раздельны;
 *    leafContent и digest профилей; при этом ни одного дочернего процесса
 *    сверх проб голого импорта пакета.
 * 4. Внешний TypeScript (закреплённая версия, отдельный каталог) проверяет
 *    `src/types-check.mts` против `.d.ts` архива.
 * Итог — `<out>/report.json`; exit 0 только без отказов.
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  Recorder,
  TYPESCRIPT,
  TYPES_NODE,
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
  },
});
const tarball = tarballArg(positionals[0]);
const work = scratchDir('harness-consumer-h3-');
const out = resolve(values.out ?? scratchDir('harness-consumer-h3-out-'));
const rec = new Recorder(join(out, 'logs'));
const consumer = join(work, 'consumer');
cpSync(join(harnessRoot, 'tests', 'fixtures', 'consumer-h3'), consumer, {
  recursive: true,
  filter: (p) => !p.includes('node_modules'),
});

// Снимки схемы — байтовые копии фикстур harness.
const snapshots = ['devcontour-capabilities.json', 'devcontour-builtin-profiles.json'].map(
  (name) => ({
    name,
    sha256: sha256File(join(consumer, 'expected', name)),
    source: sha256File(join(harnessRoot, 'tests', 'fixtures', 'catalog', name)),
  }),
);
for (const s of snapshots)
  rec.assert(s.sha256 === s.source, `expected/${s.name} не байтовая копия tests/fixtures/catalog`);

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
// zod потребителя и пакета — одна копия (иначе схемы хоста и общие поля из разных экземпляров).
const hostZod = JSON.parse(
  readFileSync(join(consumer, 'node_modules', 'zod', 'package.json'), 'utf8'),
).version;
const nestedZod = existsSync(join(installed, 'node_modules', 'zod'));
rec.assert(
  hostZod === pkg.dependencies.zod && !nestedZod,
  `zod: у потребителя ${hostZod}, у пакета ${pkg.dependencies.zod}, вложенная копия ${nestedZod}`,
);

// Импорты потребителя: только корень, ./contracts, ./projections, zod и node:*
// (`plan_import'` в строке — не импорт: перед ключевым словом не часть имени).
const importsOf = (f) =>
  [
    ...readFileSync(join(consumer, 'src', f), 'utf8').matchAll(
      /(?<![\w$.])(?:from|import)\s*\(?\s*'([^']+)'/g,
    ),
  ].map((m) => m[1]);
const imports = readdirSync(join(consumer, 'src')).flatMap(importsOf);
const external = [...new Set(imports.filter((s) => !s.startsWith('.') && !s.startsWith('node:')))];
const allowedImports = [
  'devcontour-harness',
  'devcontour-harness/contracts',
  'devcontour-harness/projections',
  'zod',
];
const foreign = external.filter((s) => !allowedImports.includes(s));
rec.assert(!foreign.length, 'посторонние импорты потребителя: ' + foreign.join(', '));
rec.assert(
  allowedImports.every((s) => external.includes(s)),
  'потребитель должен импортировать корень, ./contracts, ./projections и zod: ' +
    external.join(', '),
);
// Legacy-оракул — только zod и node:*: сравнение не опирается на пакет.
const oracleImports = importsOf('devcontour-legacy.mjs');
rec.assert(
  oracleImports.every((s) => s === 'zod' || s.startsWith('node:')),
  'devcontour-legacy.mjs импортирует ' + oracleImports.join(', '),
);

// Хост на общих операциях планирования; журнал дочерних процессов пуст.
const trace = processTrace(join(work, 'trace'));
const host = rec.run('host catalog (node src/run.mjs)', process.execPath, ['src/run.mjs'], {
  cwd: consumer,
  env: {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, trace.nodeOptions].filter(Boolean).join(' '),
  },
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
const required = [
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
];
const missing = required.filter(
  (name) => !(hostReport.checks ?? []).some((c) => c.name === name && c.ok),
);
rec.assert(!missing.length, 'хост: нет проверок ' + missing.join(', '));
const modules = trace.modules();
const spawned = trace.spawned();
// Пробы идентичности процесса при загрузке корня (ps, sysctl) — не операции
// каталога: хост не запускает ничего сверх того, что даёт голый импорт пакета.
const baseline = processTrace(join(work, 'trace-import'));
rec.run(
  'bare import devcontour-harness',
  process.execPath,
  ['--input-type=module', '-e', "await import('devcontour-harness');"],
  {
    cwd: consumer,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, baseline.nodeOptions].filter(Boolean).join(' '),
    },
  },
);
const call = (c) =>
  JSON.stringify([c.fn, c.file, c.args.map((a) => a.replace(String(c.pid), '<pid>'))]);
const onImport = new Set(baseline.spawned().map(call));
const extra = spawned.filter((c) => !onImport.has(call(c)));
rec.assert(
  modules.some((u) => u.includes('/node_modules/devcontour-harness/lib/')),
  'журнал модулей не содержит установленного пакета',
);
rec.assert(!extra.length, 'хост каталога запускал процессы: ' + JSON.stringify(extra));

const { tsc, typeRoots } = installCompiler(rec, join(work, 'compiler'), values.offline);
const typecheck = rec.run('typecheck consumer-h3 (external tsc)', process.execPath, [
  tsc,
  '-p',
  join(consumer, 'tsconfig.json'),
  '--typeRoots',
  typeRoots,
]);
rec.assert(typecheck.status === 0, 'типы потребителя: ' + typecheck.stdout.slice(0, 3000));

const report = {
  id: 'consumer-h3',
  criterion: 'H3-01, H3-02, AC18, AC19, Q5 (host mapping)',
  status: rec.failures.length ? 'FAIL' : 'PASS',
  tarball: { file: tarball, sha256: sha256File(tarball), version: pkg.version },
  node: process.version,
  compiler: { typescript: TYPESCRIPT, typesNode: TYPES_NODE, installedSeparately: true },
  consumer: {
    fixture: 'tests/fixtures/consumer-h3',
    publicImports: external.sort(),
    devDependenciesInstalled: devLeaks,
    zod: { host: hostZod, package: pkg.dependencies.zod, nested: nestedZod },
  },
  snapshots,
  host: {
    exit: host.status,
    total: hostReport.total,
    failed: hostReport.failed,
    spawned: spawned.map(call),
    spawnedOnImport: [...onImport],
    spawnedBeyondImport: extra.length,
  },
  typecheck: { exit: typecheck.status },
  failures: rec.failures,
  steps: rec.steps,
};
writeReport(join(out, 'report.json'), report);
console.log(
  `consumer-h3 ${report.status}: ${pkg.version} sha256 ${report.tarball.sha256}; host ${hostReport.total ?? 0} checks, failed ${hostReport.failed?.length ?? 'n/a'}, beyond import ${extra.length}; typecheck exit ${typecheck.status}; report ${join(out, 'report.json')}`,
);
if (!values.keep && !rec.failures.length) rmSync(work, { recursive: true, force: true });
else console.log('work dir kept: ' + work);
process.exit(rec.failures.length ? 1 : 0);
