#!/usr/bin/env node
/**
 * Изолированный настоящий сервер Relay v1 (REST `/api/v1`) для R01/W01/D02.
 *
 * Сборка: клон upstream-репозитория на закреплённом commit в отдельный каталог
 * (никогда не в upstream checkout), `pnpm install --frozen-lockfile`,
 * `build:server`, `build:cli`. Пути задаются env/флагами, по умолчанию —
 * относительно корня harness:
 *   DC_RELAY_V1_BUILD  (--build)   каталог сборки   [.private/integration-upgrade/tools/relay-v1-build]
 *   DC_RELAY_V1_SOURCE (--source)  git-источник      [.private/integration-planning-20261022/upstream/relay]
 *   DC_RELAY_V1_COMMIT (--commit)  commit            [d692b5b]
 *
 * Запуск: временный каталог вне Git, `relay-cli --local --config <tmp>/.relay/config.json init`,
 * `node apps/server/dist/main.js --config ... --port 0 --format json` с
 * RELAY_HOME=<tmp>/home и без унаследованных RELAY_*. `~/.relay` не используется.
 *
 * CLI:
 *   node scripts/acceptance/relay-v1-server.mjs prepare   # собрать, если нет
 *   node scripts/acceptance/relay-v1-server.mjs smoke     # поднять, проверить, остановить
 *   node scripts/acceptance/relay-v1-server.mjs info      # версия/commit сборки (JSON)
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RELAY_V1_COMMIT = 'd692b5b';
export const RELAY_V1_PNPM = 'pnpm@11.18.0';

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

export function relayV1Paths(overrides = {}) {
  return {
    buildDir: resolve(
      ROOT,
      overrides.buildDir ??
        flag('build') ??
        process.env.DC_RELAY_V1_BUILD ??
        '.private/integration-upgrade/tools/relay-v1-build',
    ),
    source: resolve(
      ROOT,
      overrides.source ??
        flag('source') ??
        process.env.DC_RELAY_V1_SOURCE ??
        '.private/integration-planning-20261022/upstream/relay',
    ),
    commit: overrides.commit ?? flag('commit') ?? process.env.DC_RELAY_V1_COMMIT ?? RELAY_V1_COMMIT,
  };
}

/** Окружение дочерних процессов Relay: без унаследованных RELAY_*. */
function relayEnv(home) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('RELAY_')) env[k] = v;
  env.RELAY_HOME = home;
  return env;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: opts.stdio ?? 'pipe', ...opts });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} → exit ${r.status}\n${(r.stderr ?? '').slice(-4000)}${(r.stdout ?? '').slice(-2000)}`,
    );
  }
  return r.stdout ?? '';
}

function serverMain(buildDir) {
  return join(buildDir, 'apps/server/dist/main.js');
}
function cliMain(buildDir) {
  return join(buildDir, 'apps/cli/dist/cli/main.js');
}

export function isBuilt(paths = relayV1Paths()) {
  return existsSync(serverMain(paths.buildDir)) && existsSync(cliMain(paths.buildDir));
}

/** Собирает Relay v1, если сборки нет. Возвращает сведения о сборке. */
export function prepareBuild(paths = relayV1Paths(), log = (s) => process.stderr.write(`${s}\n`)) {
  const started = Date.now();
  if (!isBuilt(paths)) {
    if (!existsSync(join(paths.buildDir, '.git'))) {
      log(`[relay-v1] clone ${paths.source} → ${paths.buildDir}`);
      mkdirSync(dirname(paths.buildDir), { recursive: true });
      run('git', ['clone', '--quiet', paths.source, paths.buildDir]);
    }
    run('git', ['-C', paths.buildDir, 'checkout', '--quiet', '--detach', paths.commit]);
    const env = relayEnv(join(paths.buildDir, '.relay-home-unused'));
    log(`[relay-v1] ${RELAY_V1_PNPM} install --frozen-lockfile`);
    run('npx', ['-y', RELAY_V1_PNPM, 'install', '--frozen-lockfile'], {
      cwd: paths.buildDir,
      env,
      stdio: 'inherit',
    });
    log('[relay-v1] build:server');
    run('npx', ['-y', RELAY_V1_PNPM, 'run', 'build:server'], {
      cwd: paths.buildDir,
      env,
      stdio: 'inherit',
    });
    log('[relay-v1] build:cli');
    run('npx', ['-y', RELAY_V1_PNPM, 'run', 'build:cli'], {
      cwd: paths.buildDir,
      env,
      stdio: 'inherit',
    });
    if (!isBuilt(paths))
      throw new Error('relay-v1 build finished but dist entrypoints are missing');
  }
  return { ...buildInfo(paths), seconds: Math.round((Date.now() - started) / 1000) };
}

export function buildInfo(paths = relayV1Paths()) {
  const head = run('git', ['-C', paths.buildDir, 'rev-parse', 'HEAD']).trim();
  const version = run(process.execPath, [serverMain(paths.buildDir), '--version'], {
    env: relayEnv(join(tmpdir(), 'relay-v1-version-home')),
  }).trim();
  const pkg = JSON.parse(readFileSync(join(paths.buildDir, 'apps/server/package.json'), 'utf8'));
  return {
    commit: head,
    version,
    packageVersion: pkg.version,
    packageName: pkg.name,
    node: process.version,
  };
}

/**
 * Поднимает изолированный сервер с новым проектом. Возвращает url, projectId,
 * REST-хелперы для fixtures и `stop()` (обязательно вызвать в finally).
 */
export async function startRelayServer(options = {}) {
  const paths = relayV1Paths(options);
  if (!isBuilt(paths)) {
    throw new Error(
      `BLOCKED: Relay v1 build missing at ${paths.buildDir}; run \`node scripts/acceptance/relay-v1-server.mjs prepare\``,
    );
  }
  const tmp = mkdtempSync(join(tmpdir(), 'relay-v1-'));
  const home = join(tmp, 'home');
  const project = join(tmp, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const config = join(project, '.relay', 'config.json');
  const env = relayEnv(home);
  let child;
  const stop = async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(t);
    }
    if (!options.keep) rmSync(tmp, { recursive: true, force: true });
  };
  try {
    run(process.execPath, [cliMain(paths.buildDir), '--local', '--config', config, 'init'], {
      cwd: project,
      env,
    });
    child = spawn(
      process.execPath,
      [
        serverMain(paths.buildDir),
        '--config',
        config,
        '--port',
        '0',
        '--actor',
        'relay-fixture',
        '--format',
        'json',
      ],
      { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-8000)));
    const url = await new Promise((res, rej) => {
      let buf = '';
      const timer = setTimeout(
        () => rej(new Error(`relay-v1 server did not start in 30s: ${stderr}`)),
        30_000,
      );
      child.stdout.on('data', (d) => {
        buf += d;
        for (const line of buf.split('\n')) {
          try {
            const j = JSON.parse(line);
            if (j?.ok && typeof j.data?.url === 'string') {
              clearTimeout(timer);
              res(j.data.url);
              return;
            }
          } catch {
            /* не та строка */
          }
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        rej(new Error(`relay-v1 server exited ${code}: ${stderr}`));
      });
    });
    const ctx = await rest(url, 'GET', '/api/v1/context');
    if (
      !String(ctx.storagePath ?? '').startsWith(tmp) &&
      !String(ctx.storagePath ?? '').includes(tmp.replace(/^\/private/, ''))
    ) {
      throw new Error(`relay-v1 storage outside temp dir: ${ctx.storagePath}`);
    }
    const projectId = ctx.projectId;
    const fixtures = fixtureClient(url, projectId);
    return {
      url,
      projectId,
      tmp,
      config,
      buildDir: paths.buildDir,
      context: ctx,
      stop,
      ...fixtures,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** Независимый REST-клиент (не адаптер) для fixtures и read-back. */
export async function rest(url, method, path, body) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(
      `${method} ${path} → ${res.status} ${json.error?.code}: ${json.error?.message}`,
    );
    err.code = json.error?.code;
    err.status = res.status;
    err.details = json.error?.details;
    throw err;
  }
  return json.data;
}

const rid = (p) => `${p}-${randomBytes(6).toString('hex')}`;

export function fixtureClient(url, projectId) {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}`;
  const get = (p) => rest(url, 'GET', `${base}${p}`);
  const post = (p, b) => rest(url, 'POST', `${base}${p}`, { requestId: rid('fx'), ...b });
  return {
    get,
    post,
    async createTask({
      title,
      description = '',
      column = 'ready',
      criteria = [],
      parentId,
      dependencies = [],
    }) {
      const saved = await post('/board-tasks', {
        board: 'product',
        title,
        description,
        column,
        acceptanceCriteria: criteria.map((c) =>
          typeof c === 'string'
            ? { title: c, summary: '', description: '' }
            : { summary: '', description: '', ...c },
        ),
        dependencies,
        ...(parentId ? { parentId } : {}),
        includeTask: true,
      });
      return saved.task;
    },
    async createDocument({ name, body, taskId }) {
      return post('/entities', {
        data: {
          kind: 'document',
          name,
          summary: '',
          body,
          documentKind: 'specification',
          relations: [
            { target: { kind: 'task', id: taskId }, type: 'references', description: 'fixture' },
          ],
        },
      });
    },
    task: (ref) => get(`/board-tasks/${encodeURIComponent(ref)}`),
    criteria: (ref) => get(`/board-tasks/${encodeURIComponent(ref)}/criteria?limit=100`),
    comments: (ref) => get(`/board-tasks/${encodeURIComponent(ref)}/comments?limit=100`),
    async completeCriterion(ref, criterionId, completed = true) {
      const t = await get(`/board-tasks/${encodeURIComponent(ref)}`);
      return post(`/board-tasks/${encodeURIComponent(ref)}/criteria`, {
        action: 'complete',
        criterionId,
        completed,
        ifRevision: t.revision,
      });
    },
    async moveTask(ref, column) {
      const t = await get(`/board-tasks/${encodeURIComponent(ref)}`);
      return post(`/board-tasks/${encodeURIComponent(ref)}/move`, {
        column,
        ifRevision: t.revision,
      });
    },
    async updateCriterion(ref, criterionId, title) {
      const t = await get(`/board-tasks/${encodeURIComponent(ref)}`);
      return post(`/board-tasks/${encodeURIComponent(ref)}/criteria`, {
        action: 'update',
        criterionId,
        title,
        ifRevision: t.revision,
      });
    },
    async addDependency(ref, dependsOn) {
      const t = await get(`/board-tasks/${encodeURIComponent(ref)}`);
      return post(`/board-tasks/${encodeURIComponent(ref)}/links`, {
        target: dependsOn,
        relation: 'depends-on',
        ifRevision: t.revision,
      });
    },
    async updateDocument(id, body) {
      const d = await get(`/entities/get?ref=${encodeURIComponent(id)}&kind=document`);
      return post('/entities/update', {
        ref: id,
        ifRevision: d.revision,
        changes: { kind: 'document', body },
      });
    },
    comment: (ref, body, actor = 'relay-admin') =>
      post(`/board-tasks/${encodeURIComponent(ref)}/comments`, {
        title: 'Operator note',
        description: body,
        actor,
        actorRole: 'operator',
      }),
    async takeover(sessionRef, reason = 'operator takeover') {
      const d = await get(`/work-history/sessions/${encodeURIComponent(sessionRef)}`);
      return post('/work-history/sessions/takeover', {
        ref: sessionRef,
        ifRevision: d.session.revision,
        reason,
        client: 'relay-admin',
      });
    },
    async updateTask(ref, patch) {
      const t = await get(`/board-tasks/${encodeURIComponent(ref)}`);
      return post(`/board-tasks/${encodeURIComponent(ref)}/update`, {
        ifRevision: t.revision,
        ...patch,
      });
    },
    async sessionCount() {
      const page = await get('/work-history/sessions?limit=1');
      return page.total;
    },
    /** Счётчики всей истории проекта (sessions/runs/checkpoints/openIntents). */
    async historyTotals() {
      const page = await get('/work-history/sessions?limit=1');
      return page.projectTotals;
    },
    sessions: (q = '') => get(`/work-history/sessions?limit=100${q}`),
    session: (ref) => get(`/work-history/sessions/${encodeURIComponent(ref)}`),
    history: (ref) =>
      get(
        `/work-history/sessions/${encodeURIComponent(ref)}/history?order=asc&limit=100&includeChildren=true`,
      ),
  };
}

/**
 * Управляемый HTTP proxy к настоящему серверу для D02/D03: запрос, для
 * которого `shouldDrop(method, path)` истинно, доходит до сервера, сервер
 * фиксирует мутацию и отвечает, а proxy обрывает соединение клиента, не
 * передав ответ («записано, но ответ не дошёл»). Сама запись не подменяется.
 * `shouldDrop` может вернуть `'hang'`: ответ не отдаётся, соединение висит.
 * Предикат вызывается на каждый запрос — тест может менять правило на ходу.
 */
export async function startDroppingProxy(targetUrl, shouldDrop) {
  const { createServer, request } = await import('node:http');
  const target = new URL(targetUrl);
  const dropped = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const drop = shouldDrop(req.method, req.url);
      const up = request(
        {
          host: target.hostname,
          port: target.port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: target.host },
        },
        (upRes) => {
          const out = [];
          upRes.on('data', (c) => out.push(c));
          upRes.on('end', () => {
            if (drop) {
              dropped.push({
                method: req.method,
                path: req.url,
                status: upRes.statusCode,
                response: Buffer.concat(out).toString('utf8'),
                mode: drop === 'hang' ? 'hang' : 'destroy',
              });
              /* 'hang' — держать соединение без ответа (клиент ждёт до таймаута/гибели процесса). */
              if (drop !== 'hang') req.socket.destroy();
              return;
            }
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            res.end(Buffer.concat(out));
          });
        },
      );
      up.on('error', () => req.socket.destroy());
      up.end(body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    dropped,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

async function main() {
  const cmd = process.argv[2] ?? 'smoke';
  const paths = relayV1Paths();
  if (cmd === 'prepare') {
    const info = prepareBuild(paths);
    process.stdout.write(`${JSON.stringify(info)}\n`);
    return;
  }
  if (cmd === 'info') {
    process.stdout.write(`${JSON.stringify(buildInfo(paths))}\n`);
    return;
  }
  if (cmd === 'smoke') {
    const srv = await startRelayServer();
    try {
      const health = await rest(srv.url, 'GET', '/api/v1/health');
      const out = {
        url: srv.url,
        projectId: srv.projectId,
        health,
        capabilities: srv.context.capabilities,
        ...buildInfo(paths),
      };
      const evidence = flag('evidence');
      if (evidence) {
        mkdirSync(dirname(resolve(evidence)), { recursive: true });
        writeFileSync(resolve(evidence), `${JSON.stringify(out, null, 2)}\n`);
      }
      process.stdout.write(`${JSON.stringify(out)}\n`);
    } finally {
      await srv.stop();
    }
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${e.stack ?? e}\n`);
    process.exit(1);
  });
}
