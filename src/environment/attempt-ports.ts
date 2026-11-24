import { randomInt, randomUUID } from 'node:crypto';
import {
  DEFAULT_PORT_RANGE,
  type AttemptEnvPolicy,
  type GatewayPolicy,
} from '../contracts/index.ts';
import { processAlive } from './lifecycle.ts';
import { portBusy } from './port-probe.ts';
import { ResourcePool, resourceKey } from './resources.ts';

/**
 * Порты попытки облегчённого режима (alpha.69). Каждое имя из
 * `attemptEnv.ports` получает свободный порт: проба занятости — та же, что
 * у ресурсов-портов (`portBusy`: 127.0.0.1, ::1, 0.0.0.0, ::), аренда — в
 * базе ресурсов машины (общей с DevContour), чтобы параллельные попытки и
 * контуры не взяли один порт. Аренда умершего процесса снимается при
 * следующем выделении; живая — никогда.
 */
export interface AttemptPorts {
  ports: Record<string, number>;
  release(): void;
}

const leaseOf = (port: number) => ({
  id: 'attempt-port',
  kind: 'port' as const,
  value: String(port),
});

export async function allocateAttemptPorts(
  policy: AttemptEnvPolicy | undefined,
  database: string,
  owner: string,
  options: { ttlMs?: number; busy?: (port: number) => Promise<boolean> } = {},
): Promise<AttemptPorts> {
  const names = policy?.ports ?? [];
  if (!names.length) return { ports: {}, release: () => undefined };
  const range = policy?.portRange ?? DEFAULT_PORT_RANGE;
  const span = range.to - range.from + 1;
  const busy = options.busy ?? portBusy;
  const pool = new ResourcePool(database);
  const token = randomUUID();
  const ports: Record<string, number> = {};
  const taken = new Set<number>();
  try {
    // Аренды умерших процессов на портах диапазона снимаются: их держатель
    // уже ничего не слушает.
    for (const row of pool.list())
      if (!processAlive(row.pid))
        try {
          const resource = JSON.parse(row.resource) as { kind?: string; value?: string };
          const port = Number(resource.value);
          if (resource.kind === 'port' && port >= range.from && port <= range.to)
            pool.clearAbandoned(row.key, row.token);
        } catch {
          /* чужая или уже снятая аренда */
        }
    const start = randomInt(span);
    let offset = 0;
    for (const name of names) {
      let found: number | undefined;
      for (; offset < span && found === undefined; offset++) {
        const port = range.from + ((start + offset) % span);
        if (taken.has(port) || (await busy(port))) continue;
        if (!pool.tryAcquire([leaseOf(port)], owner, token, options.ttlMs ?? 86_400_000)) continue;
        found = port;
      }
      if (found === undefined)
        throw new Error(
          `Нет свободного порта попытки для ${name} в диапазоне ${range.from}–${range.to}: освободите порты или расширьте attemptEnv.portRange`,
        );
      ports[name] = found;
      taken.add(found);
    }
  } catch (error) {
    pool.release(token);
    pool.close();
    throw error;
  }
  pool.close();
  return {
    ports,
    release() {
      const p = new ResourcePool(database);
      try {
        p.release(token);
      } finally {
        p.close();
      }
    },
  };
}

/** Ключ аренды порта попытки (для тестов и уборки). */
export const attemptPortKey = (port: number) => resourceKey(leaseOf(port));

/** Имя проекта compose попытки: `hx-<id>`, только [a-z0-9_-], не длиннее 60. */
export function composeProjectName(attemptId: string) {
  const slug = attemptId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ('hx-' + (slug || 'attempt')).slice(0, 60);
}

/** Подставить порты попытки в шаблон `${NAME}`; неизвестное имя — ошибка. */
export function expandPorts(template: string, ports: Record<string, number>) {
  return template.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
    if (!(name in ports))
      throw new Error(
        `Шлюз ссылается на \${${name}}, а такого порта попытки нет (attemptEnv.ports)`,
      );
    return String(ports[name]);
  });
}

/**
 * Переменные окружения попытки облегчённого режима: `HARNESS_ATTEMPT_ID`,
 * `COMPOSE_PROJECT_NAME`, порты и шлюз (`HARNESS_GATEWAY_URL` и переменные
 * приложения с адресом шлюза).
 */
export function attemptVariables(
  attemptId: string,
  ports: Record<string, number>,
  gateway: GatewayPolicy | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    HARNESS_ATTEMPT_ID: attemptId,
    COMPOSE_PROJECT_NAME: composeProjectName(attemptId),
    ...Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, String(v)])),
  };
  if (gateway) {
    const url = expandPorts(gateway.url, ports).replace(/\/+$/, '');
    env.HARNESS_GATEWAY_URL = url;
    for (const [name, suffix] of Object.entries(gateway.env)) env[name] = url + suffix;
  }
  return env;
}
