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

/** Адрес реестра для сравнения: схема, хост, порт и путь с завершающим `/`. */
export function registryUrl(url: string): string | undefined {
  try {
    const u = new URL(url.trim().replace(/^['"]|['"]$/g, ''));
    if (!u.hostname) return undefined;
    const path = u.pathname.endsWith('/') ? u.pathname : u.pathname + '/';
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return undefined;
  }
}

/**
 * Реестры, с которых сборка seed может брать пакеты: заданные окружением
 * (`npm_config_registry`, `pnpm_config_registry`, их `@scope:registry`) и
 * registry.npmjs.org, пока реестр по умолчанию задан не под обоими префиксами:
 * pnpm 10 читает `npm_config_*`, pnpm 11 — `pnpm_config_*`, и под другим
 * префиксом заданный реестр та версия не видит.
 */
export function seedRegistries(env: NodeJS.ProcessEnv): { key: string; url: string }[] {
  const out: { key: string; url: string }[] = [];
  const prefixes = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!REGISTRY_KEY.test(key) || !value) continue;
    const url = registryUrl(value);
    if (!url) continue;
    const name = key.replace(/^(?:npm|pnpm)_config_/i, '');
    if (name.toLowerCase() === 'registry')
      prefixes.add(key.slice(0, key.indexOf('_')).toLowerCase());
    out.push({ key: name.toLowerCase() === 'registry' ? 'registry' : name, url });
  }
  if (!(prefixes.has('npm') && prefixes.has('pnpm')))
    out.unshift({ key: 'registry', url: `https://${DEFAULT_REGISTRY_HOST}/` });
  return out;
}

/**
 * Хосты, к которым сборке seed нужна сеть: реестры `seedRegistries` и хосты
 * `tarball:` lockfile (git- и tarball-зависимости). Loopback песочница
 * проверок и так оставляет открытым: его в списке нет.
 */
export function seedRegistryHosts(env: NodeJS.ProcessEnv, lock = '') {
  const hosts = seedRegistries(env).flatMap((r) => {
    const host = hostOf(r.url);
    return host ? [host] : [];
  });
  for (const match of lock.matchAll(/\btarball:\s*['"]?(https?:\/\/[^\s'",}]+)/g)) {
    const host = hostOf(match[1]!);
    if (host) hosts.push(host);
  }
  return [...new Set(hosts)].filter((h) => !LOOPBACK.test(h)).slice(0, MAX_SEED_HOSTS);
}
