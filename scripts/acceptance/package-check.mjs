#!/usr/bin/env node
/**
 * C01 — один архив потребляется через npm и pnpm.
 *
 *   node scripts/acceptance/package-check.mjs <devcontour-harness-<ver>.tgz>
 *     [--out <dir>] [--offline] [--keep] [--managers npm,pnpm]
 *
 * 1. SHA-256/sha512 и список файлов архива (`<out>/files.txt`).
 * 2. Состав: нет `.private`, `.git`, upstream checkout, node_modules, похожих на
 *    секреты строк и машинных путей; каждая цель `exports` (types/default) и
 *    `bin` есть в архиве; schemas/profiles/examples/docs на месте.
 * 3. Те же байты ставятся в два чистых каталога: `npm install --omit=dev` и
 *    `pnpm add --prod`. В каждом: `harness --help`, `--version`, `doctor`
 *    (fixture runtime), import каждого публичного входа из `exports`
 *    (список берётся из package.json архива), проверка типов маленького TS
 *    потребителя внешним TypeScript (ставится отдельно, не devDependencies пакета).
 * Итог — `<out>/report.json`; exit 0 только без отказов.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  Recorder,
  TYPESCRIPT,
  TYPES_NODE,
  archiveFiles,
  fixtureRuntime,
  installCompiler,
  installConsumer,
  pnpmCommand,
  scratchDir,
  sha256File,
  sha512Integrity,
  shippedRefProblems,
  tarballArg,
  writeReport,
} from './package-lib.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    offline: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    managers: { type: 'string', default: 'npm,pnpm' },
  },
});
const tarball = tarballArg(positionals[0]);
const work = scratchDir('harness-c01-');
const out = resolve(values.out ?? scratchDir('harness-c01-out-'));
const rec = new Recorder(join(out, 'logs'));
const sha256 = sha256File(tarball);
const integrity = sha512Integrity(tarball);

// 1. Список файлов архива.
const files = archiveFiles(rec, tarball).sort();
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'files.txt'), files.join('\n') + '\n');
writeFileSync(join(out, 'sha256.txt'), `${sha256}  ${tarball.split('/').pop()}\n`);

// 2. Состав и содержимое.
const unpacked = join(work, 'unpacked');
mkdirSync(unpacked);
rec.must('tar extract', 'tar', ['-xzf', tarball, '-C', unpacked]);
const pkgDir = join(unpacked, 'package');
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const has = (p) => files.includes(p.replace(/^\.\//, ''));
const badPaths = files.filter((f) =>
  /(^|\/)(\.private|\.git|node_modules|upstream|\.idea|\.env)(\/|$)|\.tgz$|\.sqlite$|(^|\/)(relay|relay-2|turbo-starter|devcontour)\/(package\.json|\.git)/.test(
    f,
  ),
);
rec.assert(!badPaths.length, 'запрещённые пути в архиве: ' + badPaths.join(', '));
const secretPatterns = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai key', /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/],
  ['slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['bearer literal', /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/],
];
const machinePatterns = [
  ['/Users/', /\/Users\/[A-Za-z0-9._-]+\//],
  ['/home/', /\/home\/[A-Za-z0-9._-]+\//],
  ['PhpstormProjects', /PhpstormProjects/],
  ['/private/var/folders', /\/private\/var\/folders\//],
  ['C:\\Users', /[A-Z]:\\Users\\/],
];
const contentHits = [];
for (const f of files) {
  const text = readFileSync(join(pkgDir, f)).toString('utf8');
  for (const [name, re] of [...secretPatterns, ...machinePatterns])
    if (re.test(text))
      contentHits.push({ file: f, pattern: name, match: text.match(re)[0].slice(0, 80) });
}
rec.assert(!contentHits.length, 'секреты/пути машины: ' + JSON.stringify(contentHits.slice(0, 20)));

// F05: поставляемый текст ссылается только на поставляемые пути (package-lib).
const { unshippedRefs, brokenLinks } = shippedRefProblems(pkgDir, files);
rec.assert(
  !unshippedRefs.length,
  'ссылки на непоставляемые пути: ' + unshippedRefs.slice(0, 40).join(' | '),
);
rec.assert(
  !brokenLinks.length,
  'ссылки Markdown вне архива: ' + brokenLinks.slice(0, 40).join(' | '),
);

// Цели exports и bin.
const entries = [];
const missingTargets = [];
for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  const targets = typeof target === 'string' ? [target] : Object.values(target);
  for (const t of targets) {
    if (t.includes('*')) {
      const dir = t.slice(0, t.indexOf('*')).replace(/^\.\//, '');
      if (!files.some((f) => f.startsWith(dir))) missingTargets.push(`${key} → ${t}`);
    } else if (!has(t)) missingTargets.push(`${key} → ${t}`);
  }
  if (!key.includes('*') && key !== './package.json') entries.push(key);
}
for (const [name, target] of Object.entries(
  typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {}),
))
  if (!has(target)) missingTargets.push(`bin ${name} → ${target}`);
rec.assert(!missingTargets.length, 'цели exports/bin отсутствуют: ' + missingTargets.join(', '));
const binFile = join(pkgDir, Object.values(manifest.bin ?? {})[0] ?? 'lib/cli.js');
rec.assert(
  existsSync(binFile) && readFileSync(binFile, 'utf8').startsWith('#!/usr/bin/env node'),
  'bin без shebang node',
);
const groups = {
  schemas: files.filter((f) => /^schemas\/.+\.schema\.json$/.test(f)).length,
  profiles: files.filter((f) => /^profiles\/.+\.json$/.test(f)).length,
  examples: files.filter((f) => f.startsWith('examples/')).length,
  docs: files.filter((f) => /^docs\/.+\.md$/.test(f)).length,
  templates: files.filter((f) => f.startsWith('templates/')).length,
  skills: files.filter((f) => f.startsWith('skills/')).length,
};
for (const [g, n] of Object.entries(groups)) rec.assert(n > 0, 'нет файлов ' + g);
for (const required of [
  'README.md',
  'LICENSE',
  'docs/upgrade.md',
  'docs/compatibility.md',
  'examples/files-only/graph.json',
  'examples/single-task/policy.json',
])
  rec.assert(has(required), 'нет файла ' + required);
// Новые opt-in входы не должны тянуться корнем/contracts (граница пакета).
const rootSources = ['lib/index.js', 'lib/contracts/index.js'].map((f) =>
  existsSync(join(pkgDir, f)) ? readFileSync(join(pkgDir, f), 'utf8') : '',
);
rec.assert(
  !rootSources.some((s) => /from ['"]\.\/integrations\/|from ['"]\.\.\/integrations\//.test(s)),
  'корень/contracts реэкспортирует integrations',
);

// 3. Установка тех же байтов через npm и pnpm.
const { tsc, typeRoots } = installCompiler(rec, join(work, 'compiler'), values.offline);
const fixtures = fixtureRuntime(join(work, 'fixture-bin'));
const importCheck = `
const entries = ${JSON.stringify(entries)};
const out = {};
for (const e of entries) {
  const spec = e === '.' ? 'devcontour-harness' : 'devcontour-harness/' + e.slice(2);
  const m = await import(spec);
  const names = Object.keys(m);
  if (!names.length) throw new Error('пустой вход ' + spec);
  out[spec] = names.length;
}
const root = await import('devcontour-harness');
const c = await import('devcontour-harness/contracts');
if (root.API_VERSION !== c.API_VERSION) throw new Error('API_VERSION');
const t = await import('devcontour-harness/testing');
if (typeof t.executionStoreContract !== 'function') throw new Error('testing');
const { createRequire } = await import('node:module');
const req = createRequire(import.meta.url);
const pkg = req('devcontour-harness/package.json');
const schema = req.resolve('devcontour-harness/schemas/work-graph.schema.json');
out.version = pkg.version;
out.schema = Boolean(schema);
out.builtinProfiles = root.builtinProfiles().length;
console.log(JSON.stringify(out));
`;
const tsSpecs = entries.map((e) =>
  e === '.' ? 'devcontour-harness' : 'devcontour-harness/' + e.slice(2),
);
const tsConsumer =
  tsSpecs.map((s, i) => `import * as e${i} from '${s}';`).join('\n') +
  `
import type { ResultSink, WorkSource, ExecutionHost, DeliveryOutcome } from 'devcontour-harness';
import { executionStoreContract } from 'devcontour-harness/testing';
export const loaded: object[] = [${tsSpecs.map((_, i) => 'e' + i).join(', ')}];
export const contract: typeof executionStoreContract = executionStoreContract;
export const sink: ResultSink = {
  id: 'c01',
  deliver: async (): Promise<DeliveryOutcome> => ({ status: 'delivered' }),
};
export type Ports = [WorkSource, ExecutionHost];
`;
const perManager = {};
for (const manager of values.managers.split(',')) {
  const dir = join(work, manager + '-consumer');
  const install = installConsumer(rec, {
    dir,
    tarball,
    manager,
    offline: values.offline,
    label: `${manager} install archive`,
  });
  const installedPkg = join(dir, 'node_modules', 'devcontour-harness', 'package.json');
  const r = { install: install.status };
  if (!existsSync(installedPkg)) {
    rec.fail(manager + ': пакет не установлен');
    perManager[manager] = r;
    continue;
  }
  // Установлены те же байты: версия и (npm) integrity в lock.
  r.version = JSON.parse(readFileSync(installedPkg, 'utf8')).version;
  rec.assert(r.version === manifest.version, `${manager}: версия ${r.version}`);
  if (manager === 'npm') {
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
    r.lockIntegrity = lock.packages?.['node_modules/devcontour-harness']?.integrity;
    rec.assert(r.lockIntegrity === integrity, 'npm: integrity lock ≠ sha512 архива');
  }
  const devLeaks = Object.keys(manifest.devDependencies ?? {}).filter(
    (d) =>
      existsSync(join(dir, 'node_modules', d)) ||
      existsSync(join(dir, 'node_modules', '.pnpm', 'node_modules', d)),
  );
  r.devDependenciesInstalled = devLeaks;
  rec.assert(
    !devLeaks.length,
    `${manager}: установлены devDependencies пакета: ${devLeaks.join(', ')}`,
  );
  const bin = join(dir, 'node_modules', '.bin', 'harness');
  const env = {
    ...process.env,
    HARNESS_CLAUDE_BIN: join(fixtures, 'fake-claude'),
    HARNESS_CODEX_BIN: join(fixtures, 'fake-codex'),
  };
  const help = rec.run(`${manager}: harness --help`, bin, ['--help'], { cwd: dir, env });
  r.help = help.status;
  rec.assert(help.status === 0 && /harness/.test(help.stderr + help.stdout), `${manager}: --help`);
  const version = rec.run(`${manager}: harness --version`, bin, ['--version'], { cwd: dir, env });
  r.cliVersion = (() => {
    try {
      return JSON.parse(version.stdout).data.harness;
    } catch {
      return undefined;
    }
  })();
  rec.assert(r.cliVersion === manifest.version, `${manager}: --version ${r.cliVersion}`);
  const doctor = rec.run(`${manager}: harness doctor`, bin, ['doctor'], { cwd: dir, env });
  try {
    const parsed = JSON.parse(doctor.stdout);
    r.doctor = { exit: doctor.status, ok: parsed.ok, problems: parsed.data?.problems ?? [] };
    rec.assert(parsed.ok === true, `${manager}: doctor envelope ok=false`);
  } catch {
    rec.fail(
      `${manager}: doctor не JSON: ${doctor.stdout.slice(0, 300)} ${doctor.stderr.slice(0, 300)}`,
    );
  }
  const imported = rec.run(
    `${manager}: import every export`,
    process.execPath,
    ['--input-type=module', '-e', importCheck],
    {
      cwd: dir,
    },
  );
  rec.assert(imported.status === 0, `${manager}: import: ${imported.stderr.slice(-1500)}`);
  try {
    r.imports = JSON.parse(imported.stdout.trim().split('\n').pop());
  } catch {
    /* отказ уже записан */
  }
  writeFileSync(join(dir, 'check.mts'), tsConsumer);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        lib: ['ES2023'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ['node'],
        typeRoots: [typeRoots],
      },
      files: ['check.mts'],
    }),
  );
  const types = rec.run(
    `${manager}: typecheck consumer (external tsc)`,
    process.execPath,
    [tsc, '-p', 'tsconfig.json'],
    {
      cwd: dir,
    },
  );
  r.typecheck = types.status;
  rec.assert(types.status === 0, `${manager}: типы: ${types.stdout.slice(0, 3000)}`);
  perManager[manager] = r;
}

const report = {
  id: 'C01',
  status: rec.failures.length ? 'FAIL' : 'PASS',
  tarball: { file: tarball, sha256, integrity, version: manifest.version, files: files.length },
  tools: {
    node: process.version,
    npm: rec.run('npm --version', 'npm', ['--version']).stdout.trim(),
    pnpm: (() => {
      const [cmd, ...args] = pnpmCommand();
      return rec.run('pnpm --version', cmd, [...args, '--version']).stdout.trim();
    })(),
    typescript: TYPESCRIPT,
    typesNode: TYPES_NODE,
  },
  manifest: {
    exports: Object.keys(manifest.exports ?? {}),
    bin: manifest.bin,
    files: manifest.files,
    dependencies: manifest.dependencies,
  },
  entries,
  groups,
  badPaths,
  contentHits,
  unshippedRefs,
  brokenLinks,
  missingTargets,
  managers: perManager,
  failures: rec.failures,
  steps: rec.steps,
};
writeReport(join(out, 'report.json'), report);
console.log(
  `C01 ${report.status}: ${manifest.version} sha256 ${sha256} (${files.length} files); entries ${entries.join(' ')}; ${Object.entries(
    perManager,
  )
    .map(
      ([m, r]) =>
        `${m}: install=${r.install} help=${r.help} typecheck=${r.typecheck} imports=${r.imports ? Object.keys(r.imports).length : 0}`,
    )
    .join('; ')}; report ${join(out, 'report.json')}`,
);
if (!values.keep && !rec.failures.length) rmSync(work, { recursive: true, force: true });
else console.log('work dir kept: ' + work);
process.exit(rec.failures.length ? 1 : 0);
