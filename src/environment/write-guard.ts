import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { readBoundedHandle } from './bounded-read.ts';
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
 * Свой домашний каталог CLI исполнителя (alpha.69, решение владельца
 * 2026-11-24): настройки, хуки, AGENTS.md/CLAUDE.md и конфигурация MCP
 * пользователя — общие с ведущим, reviewer и владельцем — исполнителю на
 * запись не открыты. Вызов получает свой каталог (`CODEX_HOME`,
 * `CLAUDE_CONFIG_DIR`) под каталогом временных файлов controller и в нём —
 * КОПИЮ файла входа (`auth.json` codex, `.credentials.json` claude, если вход
 * хранится файлом). Копия делается только с обычного файла (lstat, без
 * ссылок, с пределом, JSON-объект), создаётся заново (0600, исключительное
 * создание) и удаляется после вызова; обратно ничего не переносится.
 * Настоящий путь входа в границу записи не входит. Путь входа есть, но это
 * не обычный файл (подложенная ссылка, каталог) — отказ вызова (`refused`).
 * Если исполнитель обновит токен в копии, Codex может однажды попросить
 * `codex login`; с ключом API у исполнителей этого не бывает. На macOS вход
 * claude по подписке лежит в Keychain: нужен `CLAUDE_CODE_OAUTH_TOKEN`
 * (`claude setup-token`) или `ANTHROPIC_API_KEY` (`missing` называет это).
 */
export async function writerRuntimeHome(
  runtime: 'codex' | 'claude',
  dir: string,
  env: Record<string, string>,
  home = homedir(),
): Promise<{ env: Record<string, string>; missing?: string; refused?: string }> {
  const { mkdir, writeFile, lstat } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const real =
    runtime === 'codex'
      ? join(env.CODEX_HOME ?? join(home, '.codex'), 'auth.json')
      : join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), '.credentials.json');
  const copy = join(dir, runtime === 'codex' ? 'auth.json' : '.credentials.json');
  let exists = false;
  try {
    exists = !!(await lstat(real));
  } catch {
    exists = false;
  }
  const source = exists ? await readAuthFile(real) : undefined;
  if (exists && !source)
    return {
      env: {},
      refused: `файл входа ${real} — не обычный файл JSON (ссылка, каталог или повреждён): копия исполнителю не делается; восстановите вход (${runtime === 'codex' ? 'codex login' : 'claude login'})`,
    };
  if (source) await writeFile(copy, source.text, { mode: 0o600, flag: 'wx' });
  if (runtime === 'codex')
    return {
      env: { CODEX_HOME: dir },
      ...(source || env.OPENAI_API_KEY || env.CODEX_API_KEY
        ? {}
        : { missing: `нет ${real}: выполните codex login` }),
    };
  // Без файла настроек claude спрашивает начальную настройку: отвечено.
  await writeFile(join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
  return {
    env: { CLAUDE_CONFIG_DIR: dir },
    ...(source || env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY
      ? {}
      : {
          missing:
            'вход claude по подписке хранится в Keychain и в свой каталог исполнителя не переносится: выполните claude setup-token и передайте CLAUDE_CODE_OAUTH_TOKEN исполнителю (environment.inherit), или задайте ANTHROPIC_API_KEY',
        }),
  };
}

/** Предел файла входа (байты, прочитанные с дескриптора). */
export const AUTH_LIMIT = 1024 * 1024;

/** Прочитать файл входа: только обычный файл, без ссылок, с пределом; JSON-объект. */
async function readAuthFile(path: string): Promise<{ text: string } | undefined> {
  const { lstat, open } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  try {
    if (!(await lstat(path)).isFile()) return undefined;
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      // Предел — по прочитанным байтам на том же дескрипторе (без ссылок):
      // файл, выросший после проверки размера, — отказ.
      const text = await readBoundedHandle(handle, AUTH_LIMIT);
      const json = JSON.parse(text) as unknown;
      return json && typeof json === 'object' && !Array.isArray(json) ? { text } : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
