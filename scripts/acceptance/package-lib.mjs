/**
 * Общие шаги проверок архива (A01, A02, C01, C02): временные каталоги,
 * журналируемый запуск команд, hash архива, чистая установка и трассировка
 * процессов/модулей. Пути машины в код не зашиты: архив, каталоги и
 * репозитории приходят аргументами или из окружения.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Корень репозитория harness, в котором лежит этот скрипт. */
export const harnessRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));

/** Закреплённые версии внешнего компилятора для проверки типов потребителя (не devDependencies пакета). */
export const TYPESCRIPT = process.env.CONSUMER_TYPESCRIPT ?? 'typescript@6.0.3';
export const TYPES_NODE = process.env.CONSUMER_TYPES_NODE ?? '@types/node@24.13.5';

export function scratchDir(prefix) {
  return realpathSync(mkdtempSync(join(process.env.WORK_ROOT ?? tmpdir(), prefix)));
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
export function sha512Integrity(file) {
  return 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64');
}

/** Архив из аргумента: существует, назван по договору npm pack. */
export function tarballArg(arg) {
  if (!arg || !existsSync(arg)) {
    console.error('укажите путь к архиву devcontour-harness-<version>.tgz');
    process.exit(2);
  }
  const file = realpathSync(resolve(arg));
  if (!/^devcontour-harness-\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?\.tgz$/.test(basename(file))) {
    console.error('архив должен называться devcontour-harness-<version>.tgz: ' + file);
    process.exit(2);
  }
  return file;
}

/**
 * Журнал проверки: каждая команда пишется с argv, cwd, кодом выхода,
 * длительностью и выводом в `<logs>/commands.log`; итог — `steps`.
 */
export class Recorder {
  constructor(logs) {
    this.logs = logs;
    mkdirSync(logs, { recursive: true });
    this.file = join(logs, 'commands.log');
    writeFileSync(this.file, '');
    this.steps = [];
    this.failures = [];
  }
  run(label, command, args, options = {}) {
    const started = Date.now();
    const r = spawnSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      ...options,
      env: options.env ?? process.env,
    });
    const ms = Date.now() - started;
    const status = r.status ?? (r.error ? -1 : null);
    appendFileSync(
      this.file,
      `\n### ${label}\n$ ${[command, ...args].join(' ')}\n# cwd: ${options.cwd ?? process.cwd()}\n# exit: ${status} signal: ${r.signal ?? ''} (${ms} ms)\n` +
        (r.error ? '# error: ' + r.error.message + '\n' : '') +
        (r.stdout ?? '') +
        (r.stderr ? '\n--- stderr ---\n' + r.stderr : ''),
    );
    this.steps.push({ label, argv: [command, ...args], cwd: options.cwd, exit: status, ms });
    return { status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
  /** Шаг, который обязан пройти: отказ записывается в failures. */
  must(label, command, args, options = {}) {
    const r = this.run(label, command, args, options);
    if (r.status !== 0) this.fail(`${label}: exit ${r.status} ${tail(r.stderr || r.stdout)}`);
    return r;
  }
  assert(ok, message) {
    if (!ok) this.fail(message);
    return Boolean(ok);
  }
  fail(message) {
    this.failures.push(message);
    appendFileSync(this.file, '\n!!! FAIL: ' + message + '\n');
    console.error('FAIL: ' + message);
  }
}

export const tail = (text, n = 1500) => (text.length > n ? '…' + text.slice(-n) : text);

/**
 * Чистый потребитель: только этот архив и его production-зависимости.
 * `manager` — npm или pnpm; байты архива копируются, исходный файл не меняется.
 */
export function installConsumer(rec, { dir, tarball, manager = 'npm', offline = false, label }) {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'package.json')))
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2),
    );
  const copy = join(dir, basename(tarball));
  copyFileSync(tarball, copy);
  const args =
    manager === 'pnpm'
      ? [
          'add',
          './' + basename(tarball),
          '--prod',
          '--config.confirmModulesPurge=false',
          ...(offline ? ['--offline'] : ['--prefer-offline']),
        ]
      : [
          'install',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          offline ? '--offline' : '--prefer-offline',
          './' + basename(tarball),
        ];
  const cmd = manager === 'pnpm' ? pnpmCommand() : ['npm'];
  return rec.must(label ?? `${manager} install`, cmd[0], [...cmd.slice(1), ...args], { cwd: dir });
}

/** pnpm из PATH, иначе через npx закреплённой версии (`PNPM_VERSION`, по умолчанию 10.12.3). */
export function pnpmCommand() {
  const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return ['pnpm'];
  return ['npx', '--yes', 'pnpm@' + (process.env.PNPM_VERSION ?? '10.12.3')];
}

/** Внешний компилятор в отдельном каталоге: у потребителя остаются только зависимости архива. */
export function installCompiler(rec, dir, offline = false) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tsc', private: true }));
  rec.must(
    'install typescript',
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      offline ? '--offline' : '--prefer-offline',
      TYPESCRIPT,
      TYPES_NODE,
    ],
    { cwd: dir },
  );
  return {
    tsc: join(dir, 'node_modules', 'typescript', 'bin', 'tsc'),
    typeRoots: join(dir, 'node_modules', '@types'),
  };
}

/**
 * Трассировка процессов: модуль `--require` оборачивает spawn/execFile/exec
 * (и sync-варианты) каждого node-процесса и пишет argv в журнал; модуль
 * `--import` пишет URL загруженных модулей. Наследуется дочерними node через
 * NODE_OPTIONS. Возвращает env-добавку и функции чтения журналов.
 */
export function processTrace(dir) {
  mkdirSync(dir, { recursive: true });
  const spawnLog = join(dir, 'spawned.jsonl');
  const moduleLog = join(dir, 'modules.log');
  const hook = join(dir, 'spawn-hook.cjs');
  const loader = join(dir, 'module-hook.mjs');
  writeFileSync(
    hook,
    `const cp = require('node:child_process');
const fs = require('node:fs');
const log = ${JSON.stringify(spawnLog)};
const note = (fn, file, args) => { try { fs.appendFileSync(log, JSON.stringify({ pid: process.pid, fn, file: String(file), args: Array.isArray(args) ? args.map(String) : [] }) + '\\n'); } catch {} };
for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[fn];
  cp[fn] = function (file, args, ...rest) { note(fn, file, args); return original.call(this, file, args, ...rest); };
}
for (const fn of ['exec', 'execSync']) {
  const original = cp[fn];
  cp[fn] = function (command, ...rest) { note(fn, command, []); return original.call(this, command, ...rest); };
}
require('node:module').syncBuiltinESMExports();
`,
  );
  writeFileSync(
    loader,
    `import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); try { appendFileSync(${JSON.stringify(moduleLog)}, r.url + '\\n'); } catch {} return r; } });
`,
  );
  return {
    nodeOptions: `--require ${hook} --import ${pathToFileURL(loader).href}`,
    spawned: () =>
      existsSync(spawnLog)
        ? readFileSync(spawnLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    modules: () =>
      existsSync(moduleLog)
        ? [...new Set(readFileSync(moduleLog, 'utf8').split('\n').filter(Boolean))]
        : [],
  };
}

/** Имя программы из argv процесса (basename, без пути). */
export const programOf = (entry) => basename(entry.file.split(/\s+/)[0] ?? '');

export function writeReport(file, report) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
}

/** Список файлов архива (без префикса package/). */
export function archiveFiles(rec, tarball) {
  return rec
    .must('tar list', 'tar', ['-tzf', tarball])
    .stdout.split('\n')
    .filter((p) => p && !p.endsWith('/'))
    .map((p) => p.replace(/^package\//, ''));
}

/** Каталог fake-claude/fake-codex из репозитория (fixture runtime); копируется во временный bin. */
export function fixtureRuntime(target, source = process.env.FIXTURE_BIN) {
  const from = source ?? join(harnessRoot, 'tests', 'fixtures', 'bin');
  mkdirSync(target, { recursive: true });
  for (const name of ['fake-claude', 'fake-codex'])
    copyFileSync(join(from, name), join(target, name));
  return target;
}

// F05: поставляемый текст ссылается только на поставляемые пути. Инструменты
// проверки из checkout репозитория (scripts/acceptance, tests, tsx, .private)
// допустимы только внутри явно помеченной области
// `<!-- repo-only -->` … `<!-- /repo-only -->`; относительные ссылки Markdown
// вне неё должны вести в файл архива.
const repoOnly = [
  /\bscripts\/acceptance\//,
  /\bscripts\/(smoke-package|install-check|build-schemas|test|clean)\.(mjs|ts)\b/,
  /\btests\/(fixtures|integration)\//,
  /\btests\/[a-z0-9-]+\.test\.ts\b/,
  /--import[ =]tsx\b/,
  /\.private\//,
];
const stripRegions = (text) =>
  text.replace(/<!--\s*repo-only\s*-->[\s\S]*?<!--\s*\/repo-only\s*-->/g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
export function shippedRefProblems(root, files) {
  const unshippedRefs = [];
  const brokenLinks = [];
  for (const f of files.filter(
    (x) =>
      /\.(md|json|mjs|js|yml|yaml|template)$/.test(x) &&
      !x.startsWith('lib/') &&
      x !== 'package.json',
  )) {
    const raw = readFileSync(join(root, f), 'utf8');
    const text = f.endsWith('.md') ? stripRegions(raw) : raw;
    text.split('\n').forEach((line, i) => {
      for (const re of repoOnly)
        if (re.test(line)) unshippedRefs.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
    if (f.endsWith('.md'))
      for (const m of text.matchAll(/\]\((?!https?:|mailto:|#)([^)\s#]+)(#[^)]*)?\)/g)) {
        const target = join(f, '..', m[1]).replace(/\\/g, '/');
        const norm = target
          .split('/')
          .reduce((acc, part) => {
            if (part === '..') acc.pop();
            else if (part !== '.' && part) acc.push(part);
            return acc;
          }, [])
          .join('/');
        if (!files.includes(norm) && !files.some((x) => x.startsWith(norm + '/')))
          brokenLinks.push(`${f}: ${m[1]}`);
      }
  }
  return { unshippedRefs, brokenLinks };
}
