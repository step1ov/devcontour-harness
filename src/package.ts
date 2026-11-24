import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  repository?: string | { url?: string };
};

/** Версия пакета читается из его собственного package.json, а не из cwd. */
export const HARNESS_VERSION: string = pkg.version;

/**
 * Адрес репозитория harness для ссылок на документы (0.1.0-alpha.70): из
 * `repository` package.json, `https://…` без `git+` и `.git`; нет — `undefined`.
 */
export const HARNESS_REPOSITORY_URL: string | undefined = (() => {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!raw) return undefined;
  const url = raw.replace(/^git\+/, '').replace(/\.git$/, '');
  return /^https:\/\/[^\s]+$/.test(url) ? url : undefined;
})();

/**
 * База ссылок на документы этой версии: `<репозиторий>/blob/v<версия>/`;
 * версии нет — ветка `master`. Нет репозитория — `undefined`.
 */
export function harnessDocsBase(
  version: string | undefined = HARNESS_VERSION,
  repository: string | undefined = HARNESS_REPOSITORY_URL,
): string | undefined {
  if (!repository) return undefined;
  const ref = version && /^\d+\.\d+\.\d+/.test(version) ? `v${version}` : 'master';
  return `${repository}/blob/${ref}/`;
}
