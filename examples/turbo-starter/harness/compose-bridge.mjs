#!/usr/bin/env node
/**
 * compose-bridge — Docker Compose-окружение для УЖЕ СУЩЕСТВУЮЩЕГО рабочего
 * дерева, созданного harness (никаких `worktree:create`/`up` проекта и его
 * реестров). Вызывается шагами lifecycle политики harness:
 *
 *   setup     порты, env-файлы по шаблонам, снимок модели compose, `create`
 *   ready     `up -d --wait` с конечным сроком; диагностика при отказе
 *   teardown  удаление только своих ресурсов (метки run + project), без prune
 *   exec      команда с env-файлами окружения (для gates)
 *   status    receipt и живые ресурсы (JSON)
 *
 * Состояние — в каталоге окружения фазы, который даёт harness
 * (`DEVCONTOUR_ENVIRONMENT_DIR`/`HARNESS_ENVIRONMENT_DIR`, вне worktree):
 *   bridge/receipt.json   владелец, проект, порты, ресурсы, результат очистки
 *   bridge/env/*.env      env-файлы (0600; удаляются при teardown)
 *   bridge/compose.json   модель compose без подстановки значений
 *   bridge/labels.json    метки владения для сервисов, томов и сетей
 *   bridge/diagnostics/   ps/logs при отказе (секреты замаскированы)
 *
 * Имя проекта: `hx-<runId 12>-<phase>-<repository>`. Метки:
 * devcontour.harness.run/phase/repository/project. Docker context не меняется,
 * `docker prune` не используется; удаляется только то, что несёт обе метки
 * (run и project) этой попытки.
 *
 * Параметры:
 *   --compose <file>      файл compose относительно cwd [.harness/compose.acceptance.yml]
 *   --port <VAR>          выделить свободный порт 127.0.0.1 в переменную (повторяемый)
 *   --env <tpl>[:<name>]  отрисовать шаблон в bridge/env/<name> (повторяемый)
 *                         [.harness/env/compose.env.template:compose.env]
 *   --compose-env <name>  env-файл, передаваемый compose [compose.env]
 *   --secret <VAR>        маскировать значение переменной (повторяемый); имена
 *                         с SECRET|PASSWORD|TOKEN|KEY маскируются всегда
 *   --timeout-ms <n>      срок ready [120000]
 *
 * Только для тестов: HX_BRIDGE_FAULTS=<файл JSON>
 *   { "<phase>|*": { "setup": "after-create", "ready": "unhealthy", "teardown": "fail" } }
 * Отсутствующий файл — нет сбоев.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const DOCKER = process.env.HX_BRIDGE_DOCKER || 'docker';
const LABEL = 'devcontour.harness';
const SECRET_NAME = /SECRET|PASSWORD|TOKEN|KEY/i;

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {
    compose: '.harness/compose.acceptance.yml',
    ports: [],
    env: [],
    composeEnv: 'compose.env',
    secrets: [],
    timeoutMs: 120000,
    exec: [],
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${a} требует значения`);
      return value;
    };
    if (a === '--') {
      options.exec = rest.slice(i + 1);
      break;
    } else if (a === '--compose') options.compose = next();
    else if (a === '--port') options.ports.push(next());
    else if (a === '--env') options.env.push(next());
    else if (a === '--compose-env') options.composeEnv = next();
    else if (a === '--secret') options.secrets.push(next());
    else if (a === '--timeout-ms') options.timeoutMs = Number(next());
    else throw new Error('Неизвестный параметр: ' + a);
  }
  if (!options.env.length) options.env.push('.harness/env/compose.env.template:compose.env');
  return { command, options };
}

/** Контекст попытки из окружения harness. */
function context() {
  const env = process.env;
  const dir = env.HARNESS_ENVIRONMENT_DIR || env.DEVCONTOUR_ENVIRONMENT_DIR;
  const runId = env.HARNESS_RUN_ID || env.DEVCONTOUR_RUN_ID;
  const phase = env.HARNESS_PHASE || env.DEVCONTOUR_PHASE;
  const repositoryId = env.HARNESS_REPOSITORY_ID || env.DEVCONTOUR_REPOSITORY_ID || 'repo';
  if (!dir || !isAbsolute(dir))
    throw new Error(
      'Нет каталога окружения: DEVCONTOUR_ENVIRONMENT_DIR (шаг вне lifecycle harness?)',
    );
  if (!runId || !phase) throw new Error('Нет DEVCONTOUR_RUN_ID/DEVCONTOUR_PHASE');
  const cwd = resolve(process.cwd());
  const state = join(dir, 'bridge');
  // Env-файлы и состояние — только вне рабочего дерева: они не попадают в diff,
  // пакет или доставку.
  if (state === cwd || state.startsWith(cwd + sep))
    throw new Error('Каталог окружения внутри рабочего дерева');
  const slug = (s, n) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, n) || 'x';
  const project = `hx-${slug(runId, 12)}-${slug(phase, 12)}-${slug(repositoryId, 12)}`;
  const labels = {
    [`${LABEL}.run`]: runId,
    [`${LABEL}.phase`]: phase,
    [`${LABEL}.repository`]: repositoryId,
    [`${LABEL}.project`]: project,
  };
  return { dir, state, runId, phase, repositoryId, project, labels, cwd };
}

function faults(phase) {
  const file = process.env.HX_BRIDGE_FAULTS;
  if (!file || !existsSync(file)) return {};
  const all = JSON.parse(readFileSync(file, 'utf8'));
  return { ...(all['*'] ?? {}), ...(all[phase] ?? {}) };
}

/** Маска значений секретов: явные --secret и переменные с «секретными» именами. */
function masker(secretNames, extra = {}) {
  const values = new Set();
  const add = (name, value) => {
    if (value && value.length >= 4 && (secretNames.includes(name) || SECRET_NAME.test(name)))
      values.add(value);
  };
  for (const [k, v] of Object.entries(process.env)) add(k, v);
  for (const [k, v] of Object.entries(extra)) add(k, v);
  const sorted = [...values].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text ?? '');
    for (const v of sorted) out = out.split(v).join('[REDACTED]');
    return out;
  };
}

function receiptPath(ctx) {
  return join(ctx.state, 'receipt.json');
}
function readReceipt(ctx) {
  const path = receiptPath(ctx);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}
function writeReceipt(ctx, receipt) {
  mkdirSync(ctx.state, { recursive: true });
  writeFileSync(receiptPath(ctx), JSON.stringify(receipt, null, 2) + '\n');
}
function event(receipt, stage, outcome, detail) {
  receipt.events.push({
    at: new Date().toISOString(),
    stage,
    outcome,
    ...(detail ? { detail } : {}),
  });
}

function docker(args, { mask = (s) => s, allowFail = false, timeoutMs = 300000 } = {}) {
  const r = spawnSync(DOCKER, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const result = {
    code: r.status ?? -1,
    stdout: mask(r.stdout ?? ''),
    stderr: mask((r.stderr ?? '') + (r.error ? String(r.error.message) : '')),
  };
  if (result.code !== 0 && !allowFail)
    throw new Error(
      `docker ${args.slice(0, 4).join(' ')}…: exit ${result.code}: ${result.stderr.trim().slice(-2000)}`,
    );
  return result;
}

/** Реестр выданных портов bridge (вне worktree): защищает от гонки «выделил — ещё не занял». */
function portRegistry() {
  const dir = process.env.HX_BRIDGE_PORTS || join(tmpdir(), 'devcontour-compose-bridge', 'ports');
  mkdirSync(dir, { recursive: true });
  return dir;
}
async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}
async function allocate(ctx, count) {
  const registry = portRegistry();
  const ports = [];
  for (let tries = 0; ports.length < count; tries++) {
    if (tries > 200) throw new Error('Не удалось выделить свободный порт');
    const port = await freePort();
    try {
      writeFileSync(join(registry, String(port)), ctx.project + '\n', { flag: 'wx' });
      ports.push(port);
    } catch {
      /* порт выдан другой попытке — следующий */
    }
  }
  return ports;
}
function releasePorts(ctx, ports) {
  const registry = portRegistry();
  for (const port of ports) {
    const file = join(registry, String(port));
    if (existsSync(file) && readFileSync(file, 'utf8').trim() === ctx.project) rmSync(file);
  }
}

function render(template, values, from) {
  const missing = new Set();
  const text = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (values[name] === undefined) {
      missing.add(name);
      return '';
    }
    return values[name];
  });
  if (missing.size)
    throw new Error(`Шаблон ${from}: не заданы переменные ${[...missing].join(', ')}`);
  return text;
}
function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
function envFiles(ctx) {
  const dir = join(ctx.state, 'env');
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.env'))
      .sort()
      .map((f) => [f, parseEnv(readFileSync(join(dir, f), 'utf8'))]),
  );
}

/** Аргументы compose: проект, снимок модели, метки, необязательный env-файл. */
function composeArgs(ctx, receipt, extra = []) {
  const env = join(ctx.state, 'env', receipt.composeEnv);
  return [
    'compose',
    '--project-name',
    ctx.project,
    ...(existsSync(env) ? ['--env-file', env] : []),
    '-f',
    join(ctx.state, 'compose.json'),
    '-f',
    join(ctx.state, 'labels.json'),
    ...extra.flatMap((f) => ['-f', f]),
  ];
}

/** Модель compose без подстановки: проверка владения и метки для всех объектов. */
function snapshotModel(ctx, compose) {
  const model = JSON.parse(
    docker([
      'compose',
      '--project-name',
      ctx.project,
      '-f',
      compose,
      'config',
      '--no-interpolate',
      '--format',
      'json',
    ]).stdout,
  );
  const problems = [];
  for (const [name, service] of Object.entries(model.services ?? {})) {
    if (service.container_name) problems.push(`${name}: container_name`);
    if (service.network_mode === 'host') problems.push(`${name}: network_mode host`);
    if (service.privileged) problems.push(`${name}: privileged`);
    for (const volume of service.volumes ?? [])
      if (volume.type === 'bind') problems.push(`${name}: bind mount ${volume.source}`);
  }
  for (const [name, volume] of Object.entries(model.volumes ?? {}))
    if (volume.external) problems.push(`volume ${name}: external`);
  for (const [name, network] of Object.entries(model.networks ?? {}))
    if (network.external) problems.push(`network ${name}: external`);
  if (problems.length)
    throw new Error('Модель compose не изолируема по проекту: ' + problems.join('; '));
  delete model.name;
  writeFileSync(join(ctx.state, 'compose.json'), JSON.stringify(model, null, 2));
  const labels = {
    services: Object.fromEntries(
      Object.keys(model.services ?? {}).map((s) => [s, { labels: ctx.labels }]),
    ),
    volumes: Object.fromEntries(
      Object.keys(model.volumes ?? {}).map((v) => [v, { labels: ctx.labels }]),
    ),
    networks: Object.fromEntries(
      [...new Set(['default', ...Object.keys(model.networks ?? {})])].map((n) => [
        n,
        { labels: ctx.labels },
      ]),
    ),
  };
  writeFileSync(join(ctx.state, 'labels.json'), JSON.stringify(labels, null, 2));
  return model;
}

/** Ресурсы Docker с метками этой попытки и проекта. */
function owned(ctx) {
  const filters = [
    '--filter',
    `label=${LABEL}.run=${ctx.runId}`,
    '--filter',
    `label=${LABEL}.project=${ctx.project}`,
  ];
  const list = (args) =>
    docker(args)
      .stdout.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    containers: list([
      'ps',
      '-a',
      '--no-trunc',
      '--format',
      '{{.ID}} {{.Names}} {{.State}}',
      ...filters,
    ]),
    volumes: list(['volume', 'ls', '--format', '{{.Name}}', ...filters]),
    networks: list(['network', 'ls', '--no-trunc', '--format', '{{.ID}} {{.Name}}', ...filters]),
  };
}

function diagnostics(ctx, receipt, stage, mask) {
  const dir = join(ctx.state, 'diagnostics');
  mkdirSync(dir, { recursive: true });
  const ps = docker([...composeArgs(ctx, receipt), 'ps', '-a', '--format', 'json'], {
    mask,
    allowFail: true,
  });
  const logs = docker([...composeArgs(ctx, receipt), 'logs', '--no-color', '--tail', '200'], {
    mask,
    allowFail: true,
  });
  writeFileSync(join(dir, `${stage}-ps.json`), ps.stdout + ps.stderr);
  writeFileSync(join(dir, `${stage}-logs.txt`), logs.stdout + logs.stderr);
  return [`diagnostics/${stage}-ps.json`, `diagnostics/${stage}-logs.txt`];
}

async function setup(ctx, options) {
  const compose = resolve(ctx.cwd, options.compose);
  if (!compose.startsWith(ctx.cwd + sep)) throw new Error('compose вне рабочего дерева');
  const fault = faults(ctx.phase);
  // Намерение — до создания любого ресурса: очистка знает проект и метки,
  // даже если setup оборвётся на середине.
  const receipt = {
    version: 1,
    tool: 'compose-bridge/v1',
    status: 'setup',
    owner: {
      runId: ctx.runId,
      phase: ctx.phase,
      repositoryId: ctx.repositoryId,
      pid: process.pid,
      host: hostname(),
    },
    project: ctx.project,
    labels: ctx.labels,
    compose: relative(ctx.cwd, compose),
    composeEnv: options.composeEnv,
    worktree: ctx.cwd,
    ports: {},
    envFiles: [],
    resources: { containers: [], volumes: [], networks: [] },
    events: [],
  };
  writeReceipt(ctx, receipt);
  const allocated = await allocate(ctx, options.ports.length);
  options.ports.forEach((name, i) => (receipt.ports[name] = allocated[i]));
  event(receipt, 'ports', 'allocated', receipt.ports);
  writeReceipt(ctx, receipt);
  const values = {
    ...process.env,
    ...Object.fromEntries(Object.entries(receipt.ports).map(([k, v]) => [k, String(v)])),
    HX_PROJECT: ctx.project,
    HX_RUN_ID: ctx.runId,
    HX_PHASE: ctx.phase,
  };
  mkdirSync(join(ctx.state, 'env'), { recursive: true, mode: 0o700 });
  for (const spec of options.env) {
    const [
      template,
      name = template
        .split('/')
        .pop()
        .replace(/\.template$/, ''),
    ] = spec.split(':');
    const path = resolve(ctx.cwd, template);
    if (!path.startsWith(ctx.cwd + sep)) throw new Error('Шаблон вне рабочего дерева: ' + template);
    const text = render(readFileSync(path, 'utf8'), values, template);
    const file = join(ctx.state, 'env', name);
    writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, 0o600);
    // В receipt — только имена переменных, не значения.
    receipt.envFiles.push({ name, template, keys: Object.keys(parseEnv(text)) });
  }
  event(
    receipt,
    'env',
    'rendered',
    receipt.envFiles.map((f) => f.name),
  );
  writeReceipt(ctx, receipt);
  const mask = masker(options.secrets, Object.assign({}, ...Object.values(envFiles(ctx))));
  snapshotModel(ctx, compose);
  docker(
    [...composeArgs(ctx, receipt, faultOverrides(ctx, fault)), 'create', '--pull', 'missing'],
    {
      mask,
    },
  );
  receipt.resources = owned(ctx);
  event(receipt, 'create', 'created', receipt.resources);
  receipt.status = 'created';
  writeReceipt(ctx, receipt);
  if (fault.setup === 'after-create') {
    event(receipt, 'setup', 'failed', 'fault: after-create');
    receipt.status = 'setup-failed';
    writeReceipt(ctx, receipt);
    throw new Error('setup: сбой после создания ресурсов (fault after-create)');
  }
  console.log(`compose-bridge setup: ${ctx.project} ports=${JSON.stringify(receipt.ports)}`);
}

/**
 * Тестовый сбой ready: healthcheck, который никогда не проходит. Применяется и
 * при create, и при up, чтобы контейнер с первого запуска имел этот healthcheck.
 */
function faultOverrides(ctx, fault) {
  if (fault.ready !== 'unhealthy') return [];
  const model = JSON.parse(readFileSync(join(ctx.state, 'compose.json'), 'utf8'));
  const file = join(ctx.state, 'fault.override.json');
  const healthcheck = {
    test: ['CMD-SHELL', 'exit 1'],
    interval: '1s',
    timeout: '1s',
    retries: 1000,
  };
  writeFileSync(
    file,
    JSON.stringify({
      services: Object.fromEntries(Object.keys(model.services).map((s) => [s, { healthcheck }])),
    }),
  );
  return [file];
}

async function ready(ctx, options) {
  const receipt = readReceipt(ctx);
  if (!receipt) throw new Error('ready без setup: нет receipt');
  const fault = faults(ctx.phase);
  const mask = masker(options.secrets, Object.assign({}, ...Object.values(envFiles(ctx))));
  const extra = faultOverrides(ctx, fault);
  const seconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
  const started = Date.now();
  const up = docker(
    [...composeArgs(ctx, receipt, extra), 'up', '-d', '--wait', '--wait-timeout', String(seconds)],
    { mask, allowFail: true, timeoutMs: options.timeoutMs + 60000 },
  );
  receipt.resources = owned(ctx);
  if (up.code !== 0) {
    const files = diagnostics(ctx, receipt, 'ready', mask);
    event(receipt, 'ready', 'failed', {
      afterMs: Date.now() - started,
      timeoutMs: options.timeoutMs,
      error: up.stderr.trim().slice(-2000),
      diagnostics: files,
    });
    receipt.status = 'ready-failed';
    writeReceipt(ctx, receipt);
    throw new Error(
      `ready: окружение не стало здоровым за ${seconds} с: ${up.stderr.trim().slice(-500)}`,
    );
  }
  event(receipt, 'ready', 'healthy', { afterMs: Date.now() - started });
  receipt.status = 'ready';
  writeReceipt(ctx, receipt);
  console.log(`compose-bridge ready: ${ctx.project}`);
}

async function teardown(ctx, options) {
  const receipt = readReceipt(ctx);
  if (!receipt) {
    console.log('compose-bridge teardown: receipt нет — ресурсов не создавалось');
    return;
  }
  const fault = faults(ctx.phase);
  const mask = masker(options.secrets, Object.assign({}, ...Object.values(envFiles(ctx))));
  // Env-файлы — временные: удаляются при любом исходе очистки (для повтора
  // очистки они не нужны: удаление идёт по меткам).
  rmSync(join(ctx.state, 'env'), { recursive: true, force: true });
  if (fault.teardown === 'fail') {
    receipt.resources = owned(ctx);
    event(receipt, 'teardown', 'failed', 'fault: teardown fail');
    receipt.status = 'cleanup-failed';
    writeReceipt(ctx, receipt);
    throw new Error('teardown: сбой очистки (fault teardown fail); ресурсы сохранены');
  }
  const before = owned(ctx);
  // Сначала штатный down по снимку модели, затем удаление по меткам того, что осталось.
  if (existsSync(join(ctx.state, 'compose.json')))
    docker(
      [...composeArgs(ctx, receipt), 'down', '--volumes', '--remove-orphans', '--timeout', '5'],
      {
        mask,
        allowFail: true,
      },
    );
  const left = owned(ctx);
  const ids = (rows) => rows.map((r) => r.split(' ')[0]);
  if (left.containers.length)
    docker(['rm', '-f', '-v', ...ids(left.containers)], { mask, allowFail: true });
  if (left.volumes.length)
    docker(['volume', 'rm', '-f', ...left.volumes], { mask, allowFail: true });
  if (left.networks.length)
    docker(['network', 'rm', ...ids(left.networks)], { mask, allowFail: true });
  const after = owned(ctx);
  releasePorts(ctx, Object.values(receipt.ports ?? {}));
  const remaining = after.containers.length + after.volumes.length + after.networks.length;
  receipt.cleanup = {
    at: new Date().toISOString(),
    removed: before,
    remaining: after,
    result: remaining ? 'incomplete' : 'cleaned',
  };
  event(receipt, 'teardown', remaining ? 'failed' : 'cleaned', { remaining: after });
  receipt.status = remaining ? 'cleanup-failed' : 'cleaned';
  writeReceipt(ctx, receipt);
  if (remaining) throw new Error('teardown: остались ресурсы ' + JSON.stringify(after));
  console.log(`compose-bridge teardown: ${ctx.project} cleaned`);
}

function exec(ctx, options) {
  if (!options.exec.length) throw new Error('exec: нет команды после --');
  const receipt = readReceipt(ctx);
  if (!receipt || receipt.status !== 'ready') throw new Error('exec: окружение не готово');
  const loaded = Object.assign({}, ...Object.values(envFiles(ctx)));
  const r = spawnSync(options.exec[0], options.exec.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...loaded,
      HX_PROJECT: ctx.project,
      HX_ENV_DIR: join(ctx.state, 'env'),
    },
  });
  if (r.error) throw r.error;
  process.exitCode = r.status ?? 1;
}

function status(ctx) {
  console.log(JSON.stringify({ receipt: readReceipt(ctx) ?? null, live: owned(ctx) }, null, 2));
}

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  const ctx = context();
  const commands = { setup, ready, teardown, exec, status };
  if (!commands[command]) throw new Error('Команда: setup | ready | teardown | exec | status');
  await commands[command](ctx, options);
}

main().catch((error) => {
  const mask = masker([]);
  console.error('compose-bridge: ' + mask(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
