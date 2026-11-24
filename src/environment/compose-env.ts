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
import { composeProjectName } from './attempt-ports.ts';

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
  /** Что не удалось записать (например, из gate под границей записи). */
  warnings?: string[];
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
      // Маска — по полному тексту, затем обрезка (ревью alpha.70).
      logs[r.Service] = redact(l.stdout + l.stderr).slice(-8000);
    }
    result.readiness = {
      services: rows.map((r) => ({
        service: r.Service ?? '?',
        state: r.State ?? '?',
        ...(r.Health ? { health: r.Health } : {}),
        ...(r.ExitCode !== undefined ? { exitCode: r.ExitCode } : {}),
      })),
      logs,
      error: redact(up.stderr || up.stdout).slice(-4000),
    };
  }
  const file = options.env.HARNESS_ATTEMPT_ENV_FILE;
  if (file) {
    result.envFile = file;
    // Запись — шагом lifecycle (вне границы записи). Под границей (из gate)
    // каталог артефактов закрыт: стек поднят, а порты не записаны — это
    // предупреждение с советом, а не исключение (ревью alpha.70).
    const warn = (what: string, error: unknown) =>
      (result.warnings ??= []).push(
        `${what} не записан (${error instanceof Error ? error.message : String(error)}): env-up — для шагов lifecycle попытки, не для gates`.slice(
          0,
          500,
        ),
      );
    await mergeEnvFile(file, env).catch((e: unknown) => warn('файл окружения попытки', e));
    const repositoryId = options.env.DEVCONTOUR_REPOSITORY_ID;
    const record = composeServicesFile(repositoryId);
    await writeFile(
      join(dirname(file), record),
      JSON.stringify(
        {
          owner: COMPOSE_OWNER,
          project,
          attemptId: options.env.HARNESS_ATTEMPT_ID ?? null,
          repositoryId: repositoryId ?? null,
          services,
        },
        null,
        2,
      ),
    ).catch((e: unknown) => warn(record, e));
    if (result.readiness)
      await writeFile(
        join(dirname(file), COMPOSE_READINESS_FILE),
        JSON.stringify(result.readiness, null, 2),
      ).catch((e: unknown) => warn(COMPOSE_READINESS_FILE, e));
  }
  return result;
}

export const COMPOSE_SERVICES_FILE = 'compose-services.json';
/** Метка записи `env-up` — признак владения для `env-sweep`. */
export const COMPOSE_OWNER = 'harness-env-up';
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
export interface OwnedComposeProject {
  project: string;
  attemptId: string;
  repositoryId: string;
  /** Файл записи `env-up` в каталоге артефактов попытки (controller). */
  file: string;
}

/** Имя записи `env-up` репозитория попытки (своя у каждого репозитория). */
export const composeServicesFile = (repositoryId: string | undefined) =>
  repositoryId
    ? `compose-services.${repositoryId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`
    : COMPOSE_SERVICES_FILE;

/**
 * Записи `env-up` (ревью 2): только из каталогов артефактов ИЗВЕСТНЫХ
 * попыток состояния (`artifactsOf(попытка)` — каталог controller, не
 * рабочее дерево) и только записи, чей проект — тот, что harness выводит
 * из попытки и репозитория (`composeProjectName`). Запись неизвестной
 * попытки не читается вовсе; подложенная в дерево — тоже.
 */
export async function ownedComposeProjects(
  attempts: readonly { id: string; dir: string }[],
  repositories: readonly string[],
): Promise<OwnedComposeProject[]> {
  const out: OwnedComposeProject[] = [];
  for (const a of attempts)
    for (const repositoryId of repositories) {
      const file = join(a.dir, composeServicesFile(repositoryId));
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      const project = composeProjectName(a.id, repositoryId);
      if (
        data.owner === COMPOSE_OWNER &&
        data.attemptId === a.id &&
        data.repositoryId === repositoryId &&
        data.project === project
      )
        out.push({ project, attemptId: a.id, repositoryId, file });
    }
  return out;
}

/**
 * Уборка (ревью alpha.70): снимаются только проекты, которые поднял
 * `env-up` попыток ЭТОГО каталога состояния (записи `ownedComposeProjects`),
 * и только когда попытка не идёт — живость перепроверяется прямо перед
 * каждым снятием. Проекты без записи (другие установки, `gates --sha`,
 * чужие `hx-*`) не трогаются. Без `confirm` — только список (dry run).
 */
export async function composeSweep(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  owned: readonly OwnedComposeProject[];
  /** Попытка идёт (свежее чтение состояния). */
  alive: (attemptId: string) => boolean;
  confirm?: boolean;
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
      dryRun: !options.confirm,
      stale: [] as string[],
      removed: [] as string[],
      kept: [] as string[],
      ignored: 0,
      error: ls.stderr.slice(-2000),
    };
  const present = new Set(ls.stdout.split('\n').map((l) => l.trim()));
  const owned = new Map<string, string>();
  for (const o of options.owned) if (present.has(o.project)) owned.set(o.project, o.attemptId);
  const hx = [...present].filter((p) => /^hx-[a-z0-9_-]+$/.test(p));
  const stale = [...owned]
    .filter(([, a]) => !options.alive(a))
    .map(([p]) => p)
    .sort();
  const removed: string[] = [];
  if (options.confirm)
    for (const p of stale) {
      // Живость — ещё раз прямо перед снятием: попытка могла начаться.
      if (options.alive(owned.get(p)!)) continue;
      const r = await docker(['compose', '-p', p, 'down', '-v', '--remove-orphans', '-t', '2'], {
        env: options.env,
        cwd: options.cwd,
        timeoutMs: 120_000,
      });
      if (r.code === 0) removed.push(p);
    }
  return {
    ok: true,
    dryRun: !options.confirm,
    stale,
    removed,
    kept: [...owned.keys()].filter((p) => !stale.includes(p)).sort(),
    ignored: hx.filter((p) => !owned.has(p)).length,
  };
}
