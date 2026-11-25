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
 * База ссылок на документы (ревью alpha.70): `<репозиторий>/blob/master/`.
 * Теги выпусков в репозитории ставятся не всегда, поэтому ссылка на тег
 * версии вела бы в 404; документ на master может быть новее установленной
 * версии (якоря справочника стабильны). Нет репозитория — `undefined`.
 */
export function harnessDocsBase(
  repository: string | undefined = HARNESS_REPOSITORY_URL,
): string | undefined {
  return repository ? `${repository}/blob/master/` : undefined;
}
