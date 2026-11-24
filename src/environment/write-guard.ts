import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_WRITE_GUARD_CACHES,
  type ExecutionPolicy,
  type WriteGuardPolicy,
} from '../contracts/index.ts';

/**
 * Граница записи облегчённого режима (alpha.69, docs/light-mode.md).
 *
 * Одна граница вместо песочницы строгого режима: процесс (исполнитель или
 * gate) и все его потомки пишут только в разрешённые каталоги — своё рабочее
 * дерево попытки, свой временный каталог, кеши инструментов. Всё остальное
 * открыто: чтение, сеть, сокет Docker, браузер, порты, список процессов и
 * сигналы.
 *
 * - macOS: Seatbelt (`sandbox-exec`) с профилем «разрешено всё, кроме
 *   записи вне путей». `ps` — setuid, а песочница запрещает exec setuid:
 *   он исполняется без песочницы (`with no-sandbox`), он ничего не пишет.
 * - Linux: bubblewrap — корень только на чтение, разрешённые пути на запись,
 *   `/dev` и `/proc` как у хоста; сеть, PID и IPC общие с хостом.
 * Механизма нет — отказ окружения до запуска с советом (установить
 * bubblewrap или снять границу `writeGuard.off` — решение владельца).
 */

/** Записываемая цель профиля: каталог целиком или файлы с префиксом пути. */
export type GuardEntry = { subpath: string } | { prefix: string };

const realOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    // Ещё не созданный путь: реальный родитель + имя (на macOS /var → /private/var).
    const parent = resolve(path, '..');
    if (parent === path) return path;
    return join(realOr(parent), path.slice(parent.length + 1));
  }
};

let darwinDirs: Record<string, string> | undefined;
function darwinDir(name: 'DARWIN_USER_CACHE_DIR' | 'DARWIN_USER_TEMP_DIR') {
  if (process.platform !== 'darwin') return undefined;
  darwinDirs ??= {};
  if (!(name in darwinDirs))
    try {
      darwinDirs[name] = execFileSync('/usr/bin/getconf', [name], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
    } catch {
      darwinDirs[name] = '';
    }
  return darwinDirs[name] || undefined;
}

/** Раскрыть путь границы: `~/…` от HOME, `$DARWIN_*` — каталог macOS. */
export function expandGuardPath(path: string, home = homedir()): string | undefined {
  if (path === '$DARWIN_USER_CACHE_DIR' || path === '$DARWIN_USER_TEMP_DIR')
    return darwinDir(path.slice(1) as 'DARWIN_USER_CACHE_DIR');
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/** Кеши инструментов границы записи политики: умолчания, `add` или `replace`. */
export function guardCaches(
  guard: WriteGuardPolicy | undefined,
  home = homedir(),
): { path: string; source: string }[] {
  const listed = guard?.replace
    ? guard.replace.map((p) => ({ path: p, source: 'policy' }))
    : [
        ...DEFAULT_WRITE_GUARD_CACHES.map((c) => ({ path: c.path, source: c.id })),
        ...(guard?.add ?? []).map((p) => ({ path: p, source: 'policy' })),
      ];
  return listed.flatMap((c) => {
    const path = expandGuardPath(c.path, home);
    return path ? [{ path: realOr(path), source: c.source }] : [];
  });
}

const sbString = (value: string) => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const sbRegex = (value: string) =>
  '#"^' + value.replace(/[.*+?^${}()|[\]\\/"]/g, (c) => (c === '"' ? '\\"' : '\\' + c)) + '"';

/** Профиль Seatbelt: разрешено всё, запись — только в `entries`, `/dev` и setuid `ps` без песочницы. */
export function seatbeltProfile(entries: GuardEntry[]) {
  const allowed = [
    '(subpath "/dev")',
    ...entries.map((e) =>
      'subpath' in e ? `(subpath ${sbString(e.subpath)})` : `(regex ${sbRegex(e.prefix)})`,
    ),
  ];
  return [
    '(version 1)',
    '(allow default)',
    '(allow process-exec (literal "/bin/ps") (with no-sandbox))',
    `(deny file-write* (require-not (require-any ${allowed.join(' ')})))`,
  ].join('\n');
}

/**
 * Механизм границы — только из системных путей (alpha.69, ревью): не из PATH,
 * где каталог, открытый исполнителю на запись, мог бы подложить свой `bwrap`.
 */
export const TRUSTED_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const TRUSTED_BWRAP = ['/usr/bin/bwrap', '/bin/bwrap'] as const;
const trustedBwrap = () => TRUSTED_BWRAP.find((p) => existsSync(p));

export class WriteGuardUnavailable extends Error {}
/** Проба механизма; тест подменяет её, чтобы проверить отказ среды. */
export const writeGuardProbe = {
  support: (platform: NodeJS.Platform) => writeGuardSupport(platform),
};

/** Механизм границы записи на этой машине, или почему его нет. */
export function writeGuardSupport(
  platform = process.platform,
): { ok: true; mechanism: string } | { ok: false; detail: string } {
  if (platform === 'darwin')
    return existsSync(TRUSTED_SANDBOX_EXEC)
      ? { ok: true, mechanism: 'seatbelt' }
      : { ok: false, detail: `нет ${TRUSTED_SANDBOX_EXEC}` };
  if (platform === 'linux')
    return trustedBwrap()
      ? { ok: true, mechanism: 'bubblewrap' }
      : { ok: false, detail: `нет bubblewrap (${TRUSTED_BWRAP.join(' или ')})` };
  return { ok: false, detail: `платформа ${platform} не поддерживается` };
}

/**
 * Команда под границей записи. `entries` — записываемые пути (настоящие
 * пути; несуществующие допустимы). Механизма нет — `WriteGuardUnavailable`.
 */
export function guardedArgv(
  argv: string[],
  entries: GuardEntry[],
  platform = process.platform,
): string[] {
  // Настоящие пути: Seatbelt сравнивает их (на macOS /var → /private/var).
  entries = entries.map((e) =>
    'subpath' in e ? { subpath: realOr(e.subpath) } : { prefix: realOr(e.prefix) },
  );
  const support = writeGuardProbe.support(platform);
  if (!support.ok)
    throw new WriteGuardUnavailable(
      `Граница записи облегчённого режима недоступна: ${support.detail}. Установите механизм (на Linux — bubblewrap) или снимите границу writeGuard.off: true (решение владельца)`,
    );
  if (platform === 'darwin') return [TRUSTED_SANDBOX_EXEC, '-p', seatbeltProfile(entries), ...argv];
  // Каталог, которого ещё нет, bubblewrap пропускает (`--bind-try`), а под
  // корнем «только чтение» его не создать: controller создаёт каталоги
  // кешей заранее.
  for (const e of entries)
    if ('subpath' in e)
      try {
        mkdirSync(e.subpath, { recursive: true });
      } catch {
        /* нет прав — каталог останется закрытым */
      }
  const binds = entries.flatMap((e) => {
    const p = 'subpath' in e ? e.subpath : e.prefix;
    return ['--bind-try', p, p];
  });
  // /proc — привязкой хоста, а не новым procfs: `--proc` требует своего
  // пространства PID, а PID остаются общими с хостом (ps, kill).
  return [
    trustedBwrap()!,
    '--ro-bind',
    '/',
    '/',
    '--dev-bind',
    '/dev',
    '/dev',
    '--ro-bind',
    '/proc',
    '/proc',
    ...binds,
    '--',
    ...argv,
  ];
}

/** Записываемые пути gate или исполнителя: свои каталоги + кеши политики. */
export function guardEntries(
  policy: Pick<ExecutionPolicy, 'writeGuard'>,
  own: string[],
  extra: GuardEntry[] = [],
): GuardEntry[] {
  return [
    ...own.map((p) => ({ subpath: realOr(p) })),
    ...guardCaches(policy.writeGuard).map((c) => ({ subpath: c.path })),
    ...extra,
  ];
}

/**
 * Свой домашний каталог CLI исполнителя (alpha.69, ревью): настройки,
 * хуки, AGENTS.md/CLAUDE.md и конфигурация MCP пользователя — общие с
 * ведущим, reviewer и владельцем — исполнителю на запись не открыты. Вызов
 * получает свой каталог (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`) под каталогом
 * временных файлов controller.
 *
 * Вход — через посредника: настоящий файл входа исполнителю не открыт ни на
 * запись, ни путём в границе записи (подменённый ссылкой путь иначе
 * расширил бы границу следующего вызова). До вызова controller под
 * блокировкой читает настоящий файл (обычный файл, без ссылок, с пределом)
 * и кладёт копию в домашний каталог вызова. После вызова изменённая копия
 * переносится в настоящий файл, только если она — обычный файл, JSON того же
 * вида и той же учётной записи, с токенами и новее (`last_refresh` /
 * `expiresAt`) и настоящего файла, и прочитанного до вызова; запись —
 * атомарно рядом с настоящим файлом под той же блокировкой. Иначе копия
 * отбрасывается с заметкой. На macOS вход claude по подписке лежит в
 * Keychain: нужен `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) или
 * `ANTHROPIC_API_KEY` в окружении исполнителя (`missing` называет это).
 */
export async function writerRuntimeHome(
  runtime: 'codex' | 'claude',
  dir: string,
  env: Record<string, string>,
  home = homedir(),
): Promise<{
  env: Record<string, string>;
  missing?: string;
  /** Перенести обновлённый вход в настоящий файл; заметка, если копия отброшена. */
  writeBack: () => Promise<string | undefined>;
}> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const real =
    runtime === 'codex'
      ? join(env.CODEX_HOME ?? join(home, '.codex'), 'auth.json')
      : join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), '.credentials.json');
  const copy = join(dir, runtime === 'codex' ? 'auth.json' : '.credentials.json');
  const before = await withAuthLock(real, () => readAuthFile(real));
  if (before) await writeFile(copy, before.text, { mode: 0o600, flag: 'wx' });
  const writeBack = async (): Promise<string | undefined> => {
    if (!before) return undefined;
    const after = await readAuthFile(copy);
    if (!after) return 'вход исполнителя не перенесён: копия заменена не обычным файлом';
    if (after.text === before.text) return undefined;
    const fresh = authUpdate(runtime, before.json, after.json);
    if (!fresh)
      return 'вход исполнителя не перенесён: копия не того вида, другой учётной записи или не новее';
    return withAuthLock(real, async () => {
      const now = await readAuthFile(real);
      if (!now) return 'вход исполнителя не перенесён: настоящий файл входа — не обычный файл';
      // Настоящий файл обновил другой вызов: остаётся более новый.
      if (now.text !== before.text && !authUpdate(runtime, now.json, after.json)) return undefined;
      await replaceRegularFile(real, after.text);
      return undefined;
    });
  };
  if (runtime === 'codex')
    return {
      env: { CODEX_HOME: dir },
      writeBack,
      ...(before || env.OPENAI_API_KEY || env.CODEX_API_KEY
        ? {}
        : { missing: `нет ${real}: выполните codex login` }),
    };
  // Без файла настроек claude спрашивает начальную настройку: отвечено.
  await writeFile(join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
  return {
    env: { CLAUDE_CONFIG_DIR: dir },
    writeBack,
    ...(before || env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY
      ? {}
      : {
          missing:
            'вход claude по подписке хранится в Keychain и в свой каталог исполнителя не переносится: выполните claude setup-token и передайте CLAUDE_CODE_OAUTH_TOKEN исполнителю (environment.inherit), или задайте ANTHROPIC_API_KEY',
        }),
  };
}

const AUTH_LIMIT = 1024 * 1024;

/** Прочитать файл входа: только обычный файл, без ссылок, с пределом; JSON-объект. */
async function readAuthFile(
  path: string,
): Promise<{ text: string; json: Record<string, unknown> } | undefined> {
  const { lstat, open } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  try {
    if (!(await lstat(path)).isFile()) return undefined;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > AUTH_LIMIT) return undefined;
      const text = (await handle.readFile()).toString('utf8');
      const json = JSON.parse(text) as unknown;
      return json && typeof json === 'object' && !Array.isArray(json)
        ? { text, json: json as Record<string, unknown> }
        : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * Обновление входа `next` против `prev`: тот же вид и та же учётная
 * запись, токены есть, и `next` новее. Codex: `tokens.{account_id,
 * refresh_token}`, `last_refresh`; claude: `claudeAiOauth.{refreshToken,
 * expiresAt}`.
 */
export function authUpdate(
  runtime: 'codex' | 'claude',
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  if (runtime === 'codex') {
    const a = obj(prev.tokens),
      b = obj(next.tokens);
    if (!b || typeof b.refresh_token !== 'string' || typeof b.access_token !== 'string')
      return false;
    if (a?.account_id !== undefined && a.account_id !== b.account_id) return false;
    const t0 = Date.parse(typeof prev.last_refresh === 'string' ? prev.last_refresh : ''),
      t1 = Date.parse(typeof next.last_refresh === 'string' ? next.last_refresh : '');
    return Number.isFinite(t1) && (!Number.isFinite(t0) || t1 > t0);
  }
  const a = obj(prev.claudeAiOauth),
    b = obj(next.claudeAiOauth);
  if (!b || typeof b.refreshToken !== 'string' || typeof b.accessToken !== 'string') return false;
  if (a?.subscriptionType !== undefined && a.subscriptionType !== b.subscriptionType) return false;
  return (
    typeof b.expiresAt === 'number' &&
    (typeof a?.expiresAt !== 'number' || b.expiresAt > a.expiresAt)
  );
}

/** Заменить обычный файл атомарно: временный файл рядом (без ссылок) и переименование. */
async function replaceRegularFile(path: string, text: string) {
  const { lstat, open, rename, rm } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  if (!(await lstat(path)).isFile()) throw new Error('не обычный файл');
  const tmp = `${path}.hx-${process.pid}-${Date.now()}`;
  const handle = await open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Блокировка файла входа рядом с ним (`<файл>.hx-lock`, O_EXCL; давняя — снимается). */
async function withAuthLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const { open, rm, stat } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const lock = `${path}.hx-lock`;
  let handle;
  for (let i = 0; i < 100 && !handle; i++) {
    try {
      handle = await open(
        lock,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fn();
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return fn();
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 60_000) await rm(lock, { force: true });
      } catch {
        /* снята другим */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!handle) return fn();
  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(lock, { force: true }).catch(() => undefined);
  }
}
