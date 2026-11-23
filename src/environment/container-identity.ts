// Какой демон контейнеров использовал lifecycle (alpha.67): по argv шагов —
// какие CLI шаги вызывают сами, и идентичность их демона на момент фазы.
// Сверка записи smoke (`harness cleanup LS-…`) отмечает очистку, только если
// шаги вызывают docker/podman сами (или известный мост `compose-bridge.mjs`),
// демон тот же, что у фазы (записанная идентичность совпала с полученной
// сейчас по записанному окружению), и ресурсов с меткой прогона не осталось.
// Всё остальное — не известно, и сверка отказывает (закрыто по построению).

import { execFile } from 'node:child_process';

export type ContainerCli = 'docker' | 'podman';

/** Известный мост compose примера: вызывает docker сам, контекст не меняет. */
const BRIDGE = /(^|[/\\])compose-bridge\.mjs$/;
const DOCKER = new Set(['docker', 'docker-compose']);
const PODMAN = new Set(['podman', 'podman-compose']);
/** Выбор демона в argv (а не окружением фазы). */
const ENDPOINT =
  /^(-c|--context|--host|-H|--config|--url|--connection|--remote|-r|--identity|--tls\w*)(=|$)|^(DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|CONTAINER_HOST|CONTAINER_CONNECTION)=/;

/**
 * CLI контейнеров, которые вызывают шаги lifecycle, или причина, по которой
 * это не известно: шаг — не docker/podman и не мост; у docker/podman есть
 * глобальный параметр до подкоманды (`-c`, `--config`, `--context`…) или
 * выбор демона в argv.
 */
export function containerUse(lifecycle: unknown): { clis: ContainerCli[] } | { unknown: string } {
  const l =
    lifecycle && typeof lifecycle === 'object' ? (lifecycle as Record<string, unknown>) : undefined;
  const clis = new Set<ContainerCli>();
  let steps = 0;
  for (const key of ['setup', 'ready', 'teardown']) {
    const list = l?.[key];
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      const raw = (s as { command?: unknown } | null)?.command;
      if (!Array.isArray(raw)) return { unknown: 'шаг без команды' };
      const cmd = raw.filter((c): c is string => typeof c === 'string');
      steps++;
      const head = (cmd[0] ?? '')
        .split(/[/\\]/)
        .at(-1)!
        .toLowerCase()
        .replace(/\.exe$/, '');
      const endpoint = cmd.find((a) => ENDPOINT.test(a));
      if (endpoint) return { unknown: `демон выбран в argv (${endpoint.split('=')[0]})` };
      if (DOCKER.has(head) || PODMAN.has(head)) {
        // Глобальные параметры — до подкоманды: любой из них может сменить демон.
        if (cmd[1]?.startsWith('-'))
          return { unknown: `глобальный параметр ${head} ${cmd[1].split('=')[0]}` };
        clis.add(DOCKER.has(head) ? 'docker' : 'podman');
        continue;
      }
      if (head === 'node' && cmd.slice(1).some((a) => BRIDGE.test(a))) {
        clis.add('docker');
        continue;
      }
      return { unknown: `шаг ${head || '?'} — не docker/podman и не мост compose-bridge.mjs` };
    }
  }
  if (!steps) return { unknown: 'шагов lifecycle нет' };
  return { clis: [...clis] };
}

/** Аргументы запроса идентичности демона. */
const IDENTITY_ARGS: Record<ContainerCli, string[]> = {
  docker: ['info', '--format', '{{.ID}}'],
  podman: ['info', '--format', '{{.Host.Hostname}}|{{.Store.GraphRoot}}'],
};

/** Идентичность демона: `id`; `missing` — CLI нет; `undefined` — демон не ответил. */
export type DaemonIdentity = { id: string } | { missing: true } | undefined;

/**
 * Идентичность демона CLI в окружении `env` (ID демона docker; у podman —
 * хост и хранилище). `missing` — CLI нет; `undefined` — демон не ответил.
 */
export function containerIdentity(
  cli: ContainerCli,
  env: NodeJS.ProcessEnv,
  bin: string = containerBin(cli),
): Promise<DaemonIdentity> {
  return new Promise((done) => {
    execFile(
      bin,
      IDENTITY_ARGS[cli],
      { encoding: 'utf8', timeout: 15_000, env },
      (error, stdout) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT')
          return done({ missing: true });
        if (error) return done(undefined);
        const id = stdout.trim();
        done(id ? { id } : undefined);
      },
    );
  });
}

/** CLI контейнеров (подмена — `HARNESS_DOCKER_BIN`/`HARNESS_PODMAN_BIN`, тесты). */
export const containerBin = (cli: ContainerCli) =>
  (cli === 'docker' ? process.env.HARNESS_DOCKER_BIN : process.env.HARNESS_PODMAN_BIN) || cli;
