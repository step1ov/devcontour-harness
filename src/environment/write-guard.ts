import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
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
  // Файл с префиксом bubblewrap привязывает только существующим путём
  // (каталоги-родители не открываются: ревью alpha.70).
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

const gitOut = (cwd: string, args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

/**
 * Метаданные git рабочего дерева попытки (0.1.0-alpha.70, P8-1; ревью 1).
 * Gate или исполнитель с `git add`, `git commit`, `git checkout -- .`
 * пишет не только в файлы дерева. Открыт на запись только каталог git
 * связанного (detached) дерева попытки — `<common>/worktrees/<имя>`: index,
 * `index.lock`, HEAD, журналы. Общий каталог репозитория закрыт целиком:
 * ни `objects` (паки владельца не перепаковать и не удалить), ни ссылки
 * веток, ни stash владельца. Новые объекты процесс пишет в своё хранилище
 * попытки (`<gitdir>/hx-objects`, `GIT_OBJECT_DIRECTORY`), общее — только
 * чтение (`GIT_ALTERNATE_OBJECT_DIRECTORIES`); автосборка мусора выключена
 * (`gc.auto=0`, `maintenance.auto=false`). После процесса controller
 * переносит его объекты в общее хранилище с проверкой
 * (`importGuardObjects`: `pack-objects | unpack-objects`). `git stash`
 * под границей отказывает (ссылка stash общая) — docs/light-mode.md.
 * Не связанное дерево (сам checkout) — ничего сверх него.
 */
export interface GitWorktreeGuard {
  entries: GuardEntry[];
  env: Record<string, string>;
  /** Своё хранилище объектов процесса и общее хранилище репозитория. */
  objects: { own: string; shared: string };
}

export function gitWorktreeGuard(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): GitWorktreeGuard | undefined {
  let gitDir: string;
  let common: string;
  try {
    gitDir = realOr(gitOut(cwd, ['rev-parse', '--absolute-git-dir']));
    const raw = gitOut(cwd, ['rev-parse', '--git-common-dir']);
    common = realOr(resolve(cwd, raw));
  } catch {
    return undefined;
  }
  if (gitDir === common) return undefined;
  const own = join(gitDir, 'hx-objects');
  const shared = join(common, 'objects');
  mkdirSync(join(own, 'pack'), { recursive: true });
  mkdirSync(join(own, 'info'), { recursive: true });
  // Пары конфигурации git через окружение — к уже заданным процессу.
  const count = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  return {
    entries: [{ subpath: gitDir }],
    env: {
      GIT_OBJECT_DIRECTORY: own,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: shared,
      GIT_CONFIG_COUNT: String(count + 2),
      [`GIT_CONFIG_KEY_${count}`]: 'gc.auto',
      [`GIT_CONFIG_VALUE_${count}`]: '0',
      [`GIT_CONFIG_KEY_${count + 1}`]: 'maintenance.auto',
      [`GIT_CONFIG_VALUE_${count + 1}`]: 'false',
    },
    objects: { own, shared },
  };
}

/**
 * Перенести объекты процесса из его хранилища в общее (controller, вне
 * границы): список объектов своего хранилища, `pack-objects` из него и
 * `unpack-objects` в общее — git проверяет каждый объект по его хешу,
 * подложенный файл с чужим именем не проходит. Своё хранилище затем
 * очищается. Ошибка переноса — исключение вызывающему.
 */
export function importGuardObjects(cwd: string, guard: GitWorktreeGuard) {
  const ownEnv = {
    ...process.env,
    GIT_OBJECT_DIRECTORY: guard.objects.own,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
  };
  const ids = execFileSync(
    'git',
    ['-C', cwd, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)'],
    { env: ownEnv, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\n')
    .filter((l) => /^[0-9a-f]{40,64}$/.test(l));
  if (ids.length) {
    const pack = execFileSync('git', ['-C', cwd, 'pack-objects', '--stdout', '-q'], {
      env: ownEnv,
      input: ids.join('\n') + '\n',
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 1024,
    });
    const sharedEnv = { ...process.env };
    delete sharedEnv.GIT_OBJECT_DIRECTORY;
    delete sharedEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    execFileSync('git', ['-C', cwd, 'unpack-objects', '-q'], {
      env: sharedEnv,
      input: pack,
      timeout: 120_000,
    });
  }
  // Своё хранилище — только каталог, созданный `gitWorktreeGuard` под gitdir попытки.
  rmSync(guard.objects.own, { recursive: true, force: true });
  mkdirSync(join(guard.objects.own, 'pack'), { recursive: true });
  return ids.length;
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
