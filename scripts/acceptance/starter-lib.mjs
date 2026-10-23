/**
 * Общие помощники сценариев starter-*.mjs: вызов CLI harness с fixture
 * runtime, трассировка управляющих команд, инвентарь Docker, evidence,
 * поиск canary в артефактах. Только встроенные модули Node.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, relative } from 'node:path';
import { ROOT } from './starter-fixture.mjs';

export const CLI = join(ROOT, 'src', 'cli.ts');
export const FAKE = {
  claude: join(ROOT, 'tests', 'fixtures', 'bin', 'fake-claude'),
  codex: join(ROOT, 'tests', 'fixtures', 'bin', 'fake-codex'),
};
const TSX = import.meta.resolve('tsx');
/**
 * Команда CLI harness: HARNESS_CLI_BIN — установленный `harness` (lib/cli.js
 * пакета из архива), иначе исходники через tsx (разработка).
 */
export const cliArgv = (args) =>
  process.env.HARNESS_CLI_BIN
    ? [process.env.HARNESS_CLI_BIN, ...args]
    : ['--import', TSX, CLI, ...args];

/** Отказ внешней предпосылки: сценарий завершается с кодом 3 и статусом BLOCKED. */
export class Blocked extends Error {
  name = 'Blocked';
}
export const EXIT = { pass: 0, fail: 1, blocked: 3 };

/** Каталоги evidence/logs сценария и запись файлов в них. */
export function recorder(evidenceDir, logsDir) {
  // STARTER_RUN_LABEL (например, final) — отдельный подкаталог прогона.
  if (process.env.STARTER_RUN_LABEL) {
    evidenceDir = join(evidenceDir, process.env.STARTER_RUN_LABEL);
    logsDir = join(logsDir, process.env.STARTER_RUN_LABEL);
  }
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  const checks = [];
  return {
    evidenceDir,
    logsDir,
    checks,
    json(name, data) {
      const path = join(evidenceDir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
      return path;
    },
    text(name, text, where = 'evidence') {
      const path = join(where === 'logs' ? logsDir : evidenceDir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return path;
    },
    copy(from, name) {
      const path = join(evidenceDir, name);
      mkdirSync(dirname(path), { recursive: true });
      copyFileSync(from, path);
      return path;
    },
    log(line) {
      const text = `[${new Date().toISOString()}] ${line}\n`;
      process.stderr.write(text);
      appendFileSync(join(logsDir, 'run.log'), text);
    },
    /** Проверка сценария: записывается всегда; провал — исключение с ID. */
    check(id, ok, detail) {
      checks.push({ id, ok: Boolean(ok), detail });
      if (!ok)
        throw new Error(
          `${id}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 2000)}`,
        );
    },
  };
}

/** Реальный путь исполняемого файла из PATH, кроме каталога `except`. */
export function which(name, except, path = process.env.PATH) {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir || dir === except) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      /* нет в каталоге */
    }
  }
  return undefined;
}

/**
 * Трассировка: обёртки `git`/`pnpm`/`harness`/`docker`, которые дописывают
 * argv и cwd в `trace` и исполняют настоящий файл (первый в `path`). Каталог обёрток ставится
 * первым в PATH процесса harness: видны и команды controller, и команды
 * шагов/gates, наследующих PATH.
 */
export function traceShims(dir, trace, names, path = process.env.PATH) {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const real = which(name, dir, path);
    const script = real
      ? `#!/bin/bash\n{ printf '%s\\t%s' "${name}" "$PWD"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> '${trace}'\nexec '${real}' "$@"\n`
      : `#!/bin/bash\n{ printf '%s\\t%s' "${name}" "$PWD"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> '${trace}'\necho "${name}: вызов запрещён сценарием" >&2\nexit 127\n`;
    writeFileSync(join(dir, name), script);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}
/** Разобрать файл трассировки: [{ tool, cwd, argv }]. */
export function readTrace(trace) {
  if (!existsSync(trace)) return [];
  return readFileSync(trace, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tool, cwd, ...argv] = line.split('\t');
      return { tool, cwd, argv };
    });
}

/**
 * Вызов CLI harness (`node --import tsx src/cli.ts`) с fixture runtime.
 * Возвращает код, stderr и разобранный JSON-ответ; вывод сохраняется в logs.
 */
export function harness(rec, label, args, { cwd, env = {} } = {}) {
  rec.log(`harness ${args.join(' ')}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, cliArgv(args), {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      HARNESS_CLAUDE_BIN: FAKE.claude,
      HARNESS_CODEX_BIN: FAKE.codex,
      ...env,
    },
  });
  rec.text(`cli/${label}.stdout.json`, r.stdout ?? '', 'logs');
  rec.text(`cli/${label}.stderr.txt`, r.stderr ?? '', 'logs');
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  rec.log(`  → exit ${r.status} in ${Math.round((Date.now() - started) / 1000)}s`);
  return { status: r.status, stderr: r.stderr, json, ms: Date.now() - started };
}

/**
 * Тот же вызов CLI асинхронно: цикл событий сценария продолжает читать каналы
 * собственных дочерних процессов (сервер Relay, прокси), пока идёт команда.
 */
export async function harnessAsync(rec, label, args, { cwd, env = {} } = {}) {
  rec.log(`harness ${args.join(' ')}`);
  const started = Date.now();
  const child = spawn(process.execPath, cliArgv(args), {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      HARNESS_CLAUDE_BIN: FAKE.claude,
      HARNESS_CODEX_BIN: FAKE.codex,
      ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const status = await new Promise((r) => child.on('close', (code) => r(code)));
  rec.text(`cli/${label}.stdout.json`, stdout, 'logs');
  rec.text(`cli/${label}.stderr.txt`, stderr, 'logs');
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  rec.log(`  → exit ${status} in ${Math.round((Date.now() - started) / 1000)}s`);
  return { status, stderr, json, ms: Date.now() - started };
}

/** Тот же CLI фоном (для прерывания процесса); возвращает ChildProcess. */
export function harnessSpawn(rec, label, args, { cwd, env = {} } = {}) {
  rec.log(`harness& ${args.join(' ')}`);
  const child = spawn(process.execPath, cliArgv(args), {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      HARNESS_CLAUDE_BIN: FAKE.claude,
      HARNESS_CODEX_BIN: FAKE.codex,
      ...env,
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  child.on('exit', () => {
    rec.text(`cli/${label}.stdout.json`, out, 'logs');
    rec.text(`cli/${label}.stderr.txt`, err, 'logs');
  });
  return child;
}

/** Docker доступен (CLI и daemon); иначе — BLOCKED. */
export function requireDocker() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 20000,
  });
  if (r.status !== 0)
    throw new Blocked('Docker недоступен: ' + (r.stderr || r.error?.message || '').trim());
  const compose = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
  if (compose.status !== 0) throw new Blocked('docker compose недоступен');
  return { server: r.stdout.trim(), compose: compose.stdout.trim() };
}
export const docker = (args, options = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
    .toString()
    .trim();
/** Все контейнеры, тома и сети Docker с метками: снимок «до/после». */
export function dockerInventory() {
  const lines = (args) => docker(args).split('\n').filter(Boolean);
  const containers = lines(['ps', '-a', '--no-trunc', '--format', '{{json .}}']).map((l) => {
    const c = JSON.parse(l);
    return { id: c.ID, names: c.Names, state: c.State, labels: c.Labels };
  });
  const volumes = lines(['volume', 'ls', '--format', '{{json .}}']).map((l) => {
    const v = JSON.parse(l);
    return { name: v.Name, labels: v.Labels };
  });
  const networks = lines(['network', 'ls', '--no-trunc', '--format', '{{json .}}']).map((l) => {
    const n = JSON.parse(l);
    return { id: n.ID, name: n.Name, labels: n.Labels };
  });
  return { context: docker(['context', 'show']), containers, volumes, networks };
}
/**
 * Чужие ресурсы «до» сохранились «после» (машина общая: другие процессы могут
 * создавать свои ресурсы — это не нарушение); контекст Docker не изменён.
 */
export function foreignPreserved(before, after) {
  const missing = Object.fromEntries(
    ['containers', 'volumes', 'networks'].map((k) => [
      k,
      before[k].filter((x) => !after[k].includes(x)),
    ]),
  );
  return {
    ok: before.context === after.context && Object.values(missing).every((m) => m.length === 0),
    missing,
    context: { before: before.context, after: after.context },
  };
}
/** Ресурсы инвентаря, не принадлежащие ни одному harness-проекту `hx-*`. */
export function foreign(inventory) {
  const owned = (labels = '') => labels.includes('devcontour.harness.run=');
  return {
    context: inventory.context,
    containers: inventory.containers
      .filter((c) => !owned(c.labels))
      .map((c) => c.id)
      .sort(),
    volumes: inventory.volumes
      .filter((v) => !owned(v.labels))
      .map((v) => v.name)
      .sort(),
    networks: inventory.networks
      .filter((n) => !owned(n.labels))
      .map((n) => n.id)
      .sort(),
  };
}

/** Файлы каталога рекурсивно (без node_modules и .git). */
export function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
/** Вхождения строк `needles` (байтами) в файлах `roots`: { needle: [files] }. */
export function grepFiles(roots, needles) {
  const hits = Object.fromEntries(Object.keys(needles).map((k) => [k, []]));
  const scanned = [];
  for (const root of roots)
    for (const file of walk(root)) {
      const bytes = readFileSync(file);
      scanned.push(file);
      for (const [name, value] of Object.entries(needles))
        if (bytes.includes(Buffer.from(value))) hits[name].push(relative(root, file) || file);
    }
  return { hits, scanned: scanned.length };
}

/** Ждать условия с конечным сроком (барьер сценария, не случайная задержка). */
export async function waitFor(what, predicate, timeoutMs = 120000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Не дождались: ${what} (${timeoutMs} мс)`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Разбор JUnit (node --test-reporter=junit): testcases с исходом. */
export function junitCases(xml) {
  const cases = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const attrs = Object.fromEntries(
      [...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
    );
    const body = m[3] ?? '';
    cases.push({
      name: attrs.name,
      outcome: /<failure\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed',
    });
  }
  return cases;
}

/** Завершить сценарий: итог в evidence, код выхода PASS/FAIL/BLOCKED. */
export function finish(rec, id, error, extra = {}) {
  const status = !error ? 'PASS' : error instanceof Blocked ? 'BLOCKED' : 'FAIL';
  rec.json('summary.json', {
    id,
    status,
    ...(error ? { error: String(error.stack ?? error) } : {}),
    checks: rec.checks,
    ...extra,
  });
  rec.log(`${id}: ${status}${error ? ' — ' + error.message : ''}`);
  process.exitCode =
    status === 'PASS' ? EXIT.pass : status === 'BLOCKED' ? EXIT.blocked : EXIT.fail;
  return status;
}
