// Сервисы попытки в docker compose (0.1.0-alpha.70, docs/light-mode.md
// «Сервисы попытки»). Помощник для шагов lifecycle и gates облегчённого
// режима: `harness env-up` поднимает стек под именем проекта попытки
// (`COMPOSE_PROJECT_NAME`, его задаёт harness) с `up -d --wait`, читает
// динамические порты (`127.0.0.1::<порт>` в compose) и дописывает их в файл
// окружения попытки (`HARNESS_ATTEMPT_ENV_FILE`, раздел `services`), чтобы
// gates той же попытки их прочли; при отказе готовности — `compose ps -a`
// и хвосты журналов нездоровых сервисов (замаскированные) в отчёт и stderr.
// `harness env-down` — `down -v --remove-orphans -t 2`. `harness env-sweep`
// убирает проекты `hx-*` попыток, которых нет среди идущих.

import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Запуск docker; тест подменяет. */
export interface DockerRun {
  (
    args: string[],
    options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const dockerRun: DockerRun = (args, options) =>
  new Promise((resolve) => {
    execFile(
      'docker',
      args,
      {
        env: options.env,
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? (error ? error.message : '')),
        }),
    );
  });

export interface ComposeServicePorts {
  /** Опубликованные порты: порт контейнера → адрес хоста. */
  ports: Record<string, { host: string; port: number }>;
  state?: string;
  health?: string;
}

export interface ComposeUpResult {
  project: string;
  ok: boolean;
  services: Record<string, ComposeServicePorts>;
  /** Переменные портов: `HX_<СЕРВИС>_<ПОРТ>=<порт хоста>`. */
  env: Record<string, string>;
  envFile?: string;
  /** Диагностика готовности при отказе (`compose ps -a`, хвосты журналов). */
  readiness?: {
    services: { service: string; state: string; health?: string; exitCode?: number }[];
    logs: Record<string, string>;
    error: string;
  };
}

const LOG_TAIL = 50;

/** Имя переменной порта сервиса: `HX_DB_5432`. */
export const servicePortEnv = (service: string, target: string | number) =>
  `HX_${service.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${target}`;

interface PsRow {
  Service?: string;
  State?: string;
  Health?: string;
  ExitCode?: number;
  Publishers?: { URL?: string; TargetPort?: number; PublishedPort?: number; Protocol?: string }[];
}

/** `docker compose ps --format json`: JSON-массив или по объекту в строке. */
export function parsePs(stdout: string): PsRow[] {
  const text = stdout.trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text) as PsRow[];
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PsRow);
}

function servicesOf(rows: PsRow[]): Record<string, ComposeServicePorts> {
  const out: Record<string, ComposeServicePorts> = {};
  for (const r of rows) {
    if (!r.Service) continue;
    const s = (out[r.Service] ??= { ports: {} });
    if (r.State) s.state = r.State;
    if (r.Health) s.health = r.Health;
    for (const p of r.Publishers ?? [])
      if (p.PublishedPort && p.TargetPort)
        s.ports[String(p.TargetPort)] = {
          host: !p.URL || p.URL === '0.0.0.0' || p.URL === '::' ? '127.0.0.1' : p.URL,
          port: p.PublishedPort,
        };
  }
  return out;
}

export interface ComposeOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  files?: string[];
  waitTimeoutS?: number;
  services?: string[];
  redact?: (s: string) => string;
  docker?: DockerRun;
}

const projectOf = (env: NodeJS.ProcessEnv) => {
  const project = env.COMPOSE_PROJECT_NAME;
  if (!project)
    throw new Error(
      'COMPOSE_PROJECT_NAME не задан: env-up/env-down запускаются из шагов попытки облегчённого режима (имя проекта задаёт harness)',
    );
  return project;
};

const fileArgs = (files: string[] | undefined) => (files ?? []).flatMap((f) => ['-f', f]);

/** Поднять стек попытки и записать порты в файл окружения попытки. */
export async function composeUp(options: ComposeOptions): Promise<ComposeUpResult> {
  const docker = options.docker ?? dockerRun;
  const project = projectOf(options.env);
  const redact = options.redact ?? ((s: string) => s);
  const base = ['compose', '-p', project, ...fileArgs(options.files)];
  const wait = options.waitTimeoutS ?? 120;
  const run = (args: string[], timeoutMs = (wait + 60) * 1000) =>
    docker([...base, ...args], { env: options.env, cwd: options.cwd, timeoutMs });
  // Остатки упавшей прежней попытки с тем же именем — до подъёма.
  await run(['down', '-v', '--remove-orphans', '-t', '2'], 60_000);
  const up = await run([
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    String(wait),
    ...(options.services ?? []),
  ]);
  const ps = await run(['ps', '-a', '--format', 'json'], 30_000);
  const rows = ps.code === 0 ? parsePs(ps.stdout) : [];
  const services = servicesOf(rows);
  const env: Record<string, string> = {};
  for (const [service, s] of Object.entries(services))
    for (const [target, p] of Object.entries(s.ports))
      env[servicePortEnv(service, target)] = String(p.port);
  const result: ComposeUpResult = { project, ok: up.code === 0, services, env };
  if (up.code !== 0) {
    const bad = rows.filter((r) => r.State !== 'running' || (r.Health && r.Health !== 'healthy'));
    const logs: Record<string, string> = {};
    for (const r of bad.slice(0, 10)) {
      if (!r.Service) continue;
      const l = await run(['logs', '--no-color', '--tail', String(LOG_TAIL), r.Service], 30_000);
      logs[r.Service] = redact((l.stdout + l.stderr).slice(-8000));
    }
    result.readiness = {
      services: rows.map((r) => ({
        service: r.Service ?? '?',
        state: r.State ?? '?',
        ...(r.Health ? { health: r.Health } : {}),
        ...(r.ExitCode !== undefined ? { exitCode: r.ExitCode } : {}),
      })),
      logs,
      error: redact((up.stderr || up.stdout).slice(-4000)),
    };
  }
  const file = options.env.HARNESS_ATTEMPT_ENV_FILE;
  if (file) {
    result.envFile = file;
    await mergeEnvFile(file, env);
    await writeFile(
      join(dirname(file), COMPOSE_SERVICES_FILE),
      JSON.stringify({ project, services }, null, 2),
    ).catch(() => undefined);
    if (result.readiness)
      await writeFile(
        join(dirname(file), COMPOSE_READINESS_FILE),
        JSON.stringify(result.readiness, null, 2),
      ).catch(() => undefined);
  }
  return result;
}

export const COMPOSE_SERVICES_FILE = 'compose-services.json';
export const COMPOSE_READINESS_FILE = 'compose-readiness.json';
/** Переменные портов сервисов в файле окружения попытки. */
export const SERVICE_PORT_ENV = /^HX_[A-Z0-9_]+$/;

/**
 * Дописать переменные портов в файл окружения попытки (плоский объект
 * переменных, атомарной заменой): gates той же попытки получают их в
 * окружении (`Runner.environmentOf`).
 */
async function mergeEnvFile(file: string, env: Record<string, string>) {
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      current = parsed as Record<string, unknown>;
  } catch {
    current = {};
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...current, ...env }, null, 2) + '\n');
  await rename(tmp, file);
}

/** Переменные портов сервисов из файла окружения попытки (нет файла — пусто). */
export function servicePortsFromFile(text: string | undefined): Record<string, string> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (e): e is [string, string] =>
          SERVICE_PORT_ENV.test(e[0]) && typeof e[1] === 'string' && /^\d{1,5}$/.test(e[1]),
      ),
    );
  } catch {
    return {};
  }
}

/** Убрать стек попытки: тома, сироты, короткий срок остановки. */
export async function composeDown(options: ComposeOptions) {
  const docker = options.docker ?? dockerRun;
  const project = projectOf(options.env);
  const r = await docker(
    [
      'compose',
      '-p',
      project,
      ...fileArgs(options.files),
      'down',
      '-v',
      '--remove-orphans',
      '-t',
      '2',
    ],
    { env: options.env, cwd: options.cwd, timeoutMs: 120_000 },
  );
  return { project, ok: r.code === 0, ...(r.code ? { error: r.stderr.slice(-2000) } : {}) };
}

/**
 * Уборка по метке: проекты compose `hx-*`, которых нет среди `keep`
 * (имена проектов идущих попыток), снимаются `down -v --remove-orphans`.
 * `dryRun` — только список.
 */
export async function composeSweep(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  keep: ReadonlySet<string>;
  dryRun?: boolean;
  docker?: DockerRun;
}) {
  const docker = options.docker ?? dockerRun;
  const ls = await docker(
    [
      'ps',
      '-a',
      '--filter',
      'label=com.docker.compose.project',
      '--format',
      '{{.Label "com.docker.compose.project"}}',
    ],
    { env: options.env, cwd: options.cwd, timeoutMs: 60_000 },
  );
  if (ls.code !== 0)
    return {
      ok: false,
      removed: [] as string[],
      kept: [] as string[],
      error: ls.stderr.slice(-2000),
    };
  const projects = [...new Set(ls.stdout.split('\n').map((l) => l.trim()))].filter((p) =>
    /^hx-[a-z0-9_-]+$/.test(p),
  );
  const stale = projects.filter((p) => !options.keep.has(p)).sort();
  const removed: string[] = [];
  if (!options.dryRun)
    for (const p of stale) {
      const r = await docker(['compose', '-p', p, 'down', '-v', '--remove-orphans', '-t', '2'], {
        env: options.env,
        cwd: options.cwd,
        timeoutMs: 120_000,
      });
      if (r.code === 0) removed.push(p);
    }
  return {
    ok: true,
    stale,
    removed,
    kept: projects.filter((p) => options.keep.has(p)).sort(),
  };
}
