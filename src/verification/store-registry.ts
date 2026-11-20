/**
 * Хосты реестра сборки seed хранилища зависимостей. Отдельный модуль без
 * зависимостей: им пользуются и сборка (`dependency-store.ts`), и советы
 * `doctor`/`init`/`lean` (`store-advice.ts`).
 */
/** Реестр pnpm и npm по умолчанию. */
export const DEFAULT_REGISTRY_HOST = 'registry.npmjs.org';
/** Предел хостов сборки seed: lockfile пишет принятая история, но не без меры. */
const MAX_SEED_HOSTS = 20;
const REGISTRY_KEY = /^(?:npm|pnpm)_config_(?:@[^:]+:)?registry$/i;
const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|\[?::1\]?)$/i;

const hostOf = (url: string) => {
  try {
    return new URL(url.trim().replace(/^['"]|['"]$/g, '')).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Хосты, к которым сборке seed нужна сеть: реестр из окружения процесса сборки
 * (`npm_config_registry`, `pnpm_config_registry`, их `@scope:registry`), иначе
 * registry.npmjs.org, и хосты `tarball:` lockfile (git- и tarball-зависимости).
 * Loopback песочница проверок и так оставляет открытым: его в списке нет.
 */
export function seedRegistryHosts(env: NodeJS.ProcessEnv, lock = '') {
  const configured = Object.entries(env)
    .filter(([key, value]) => REGISTRY_KEY.test(key) && value)
    .map(([key, value]) => ({ scoped: key.includes('@'), host: hostOf(value!) }));
  const hosts = configured.flatMap((c) => (c.host ? [c.host] : []));
  // Реестр по умолчанию задан — пакеты без области идут к нему, а не к npmjs.
  if (!configured.some((c) => !c.scoped && c.host)) hosts.unshift(DEFAULT_REGISTRY_HOST);
  for (const match of lock.matchAll(/\btarball:\s*['"]?(https?:\/\/[^\s'",}]+)/g)) {
    const host = hostOf(match[1]!);
    if (host) hosts.push(host);
  }
  return [...new Set(hosts)].filter((h) => !LOOPBACK.test(h)).slice(0, MAX_SEED_HOSTS);
}
