import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Вызовы npm для `harness update`: единственная сеть harness — через npm,
 * поэтому действуют registry, proxy, сертификаты и ключи из настроек npm
 * (`.npmrc` проекта и пользователя, переменные npm_config_*). Подсказки npm
 * об обновлении, fund и audit выключены: никакой телеметрии и лишних запросов.
 */
export interface NpmResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface NpmOptions {
  /** Каталог вызова: его `.npmrc` действует. */
  cwd: string;
  /** Реестр вместо настроенного (`updates.json` → `registry`). */
  registry?: string;
  /** Исполняемый npm (`HARNESS_NPM_BIN`, иначе npm из PATH). */
  bin?: string;
  timeoutMs?: number;
}

export const npmBin = () => process.env.HARNESS_NPM_BIN || 'npm';

const quietEnv = {
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_progress: 'false',
};

export function runTool(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = 10 * 60_000,
  env: NodeJS.ProcessEnv = {},
): Promise<NpmResult> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env, ...quietEnv, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      done({ code: 127, stdout: '', stderr: (error as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ code: 127, stdout, stderr: stderr + error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}

export function npm(args: string[], o: NpmOptions): Promise<NpmResult> {
  return runTool(
    o.bin ?? npmBin(),
    [...args, ...(o.registry ? ['--registry', o.registry] : [])],
    o.cwd,
    o.timeoutMs ?? 120_000,
  );
}

/**
 * Запрос проверки к реестру: свой пустой кэш (иначе npm без сети молча
 * отвечает из кэша, и «проверка» показала бы старое) и короткие повторы —
 * офлайн ответ приходит за секунды, а не за минуты.
 */
async function ask(args: string[], o: NpmOptions): Promise<NpmResult> {
  const cache = mkdtempSync(join(tmpdir(), 'harness-update-cache-'));
  try {
    return await npm(
      [
        ...args,
        '--cache',
        cache,
        '--fetch-retries=1',
        '--fetch-retry-mintimeout=1000',
        '--fetch-retry-maxtimeout=3000',
        '--fetch-timeout=30000',
      ],
      o,
    );
  } finally {
    // Только свой временный каталог, созданный выше mkdtemp.
    if (cache.startsWith(join(tmpdir(), 'harness-update-cache-')))
      rmSync(cache, { recursive: true, force: true });
  }
}

/** Короткая причина отказа npm для человека: первая строка `npm error`. */
export function npmReason(r: NpmResult): string {
  const lines = (r.stderr + '\n' + r.stdout).split('\n').map((l) => l.trim());
  const line =
    lines.find((l) => /^npm (error|ERR!) code /.test(l)) ??
    lines.find((l) => /^npm (error|ERR!)/.test(l)) ??
    lines.find(Boolean) ??
    `npm завершился с кодом ${r.code}`;
  return line.replace(/^npm (error|ERR!)\s*/, '').slice(0, 300);
}

const notFound = (r: NpmResult) =>
  /\bE404\b|404 Not Found|is not in this registry/.test(r.stderr + r.stdout);

/**
 * Причина отказа запроса о версии пакета простыми словами. Реестр не знает
 * пакет (E404) — «ещё не опубликован в npm»; пакет есть, версии нет
 * (ETARGET) — «версия ещё не опубликована». Иные отказы — прежняя строка
 * npm (`npmReason`). Экспортируется для тестов.
 */
export function registryReason(r: NpmResult, name: string, version: string): string {
  const text = r.stderr + '\n' + r.stdout;
  // Пакет есть, версии нет: `npm pack` — ETARGET, `npm view` — E404 «No match
  // found for version».
  if (/\bETARGET\b|No matching version found|No match found for version/.test(text))
    return `версия ${version} пакета ${name} ещё не опубликована в npm (в реестре её нет)`;
  if (notFound(r))
    return `пакет ${name} ещё не опубликован в npm: реестр не знает ни его, ни версию ${version} (ответ 404)`;
  return npmReason(r);
}

export class RegistryUnavailable extends Error {}

const json = (r: NpmResult): unknown => {
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch {
    throw new RegistryUnavailable('npm вернул не JSON: ' + npmReason(r));
  }
};

/** Версии и dist-tags пакета; пакета или канала нет в реестре — undefined. */
export async function packageVersions(
  name: string,
  channel: string,
  o: NpmOptions,
): Promise<{ tags: Record<string, string>; versions: string[] } | undefined> {
  // `<имя>@<канал>`: без версии npm view берёт тег latest, которого у канала может не быть.
  const r = await ask(['view', `${name}@${channel}`, 'dist-tags', 'versions', '--json'], o);
  if (r.code !== 0) {
    if (notFound(r)) return undefined;
    throw new RegistryUnavailable(npmReason(r));
  }
  if (!r.stdout.trim()) return undefined;
  const data = json(r) as { 'dist-tags'?: Record<string, string>; versions?: string[] | string };
  const versions = Array.isArray(data.versions)
    ? data.versions
    : typeof data.versions === 'string'
      ? [data.versions]
      : [];
  return { tags: data['dist-tags'] ?? {}, versions };
}

/** Peer-зависимости версии пакета. */
export async function peerDependencies(
  name: string,
  version: string,
  o: NpmOptions,
): Promise<Record<string, string>> {
  const r = await ask(['view', `${name}@${version}`, 'peerDependencies', '--json'], o);
  if (r.code !== 0) throw new RegistryUnavailable(registryReason(r, name, version));
  if (!r.stdout.trim()) return {};
  const data = json(r);
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, string>)
    : {};
}

/**
 * Tarball версии: скачивает и проверяет (integrity) npm (`npm pack`) во
 * временный каталог; возвращаются байты, каталог удаляется.
 */
export async function fetchTarball(name: string, version: string, o: NpmOptions): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-update-pack-'));
  try {
    const r = await ask(['pack', `${name}@${version}`, '--pack-destination', dir, '--json'], {
      ...o,
      timeoutMs: o.timeoutMs ?? 300_000,
    });
    if (r.code !== 0) throw new RegistryUnavailable(registryReason(r, name, version));
    const file = readdirSync(dir).find((f) => f.endsWith('.tgz'));
    if (!file) throw new RegistryUnavailable('npm pack не оставил архив');
    return readFileSync(join(dir, file));
  } finally {
    // Только свой временный каталог, созданный выше mkdtemp.
    if (dir.startsWith(join(tmpdir(), 'harness-update-pack-')))
      rmSync(dir, { recursive: true, force: true });
  }
}
