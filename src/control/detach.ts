// `harness run --detach --log <файл>` (alpha.72): запуск `harness run`
// отдельным процессом в своей группе и сессии (`detached`), stdin закрыт,
// stdout и stderr — в файл журнала. Команда ждёт (не дольше `waitMs`), пока
// run не поставит метку запуска или не займёт роль controller, — тогда
// возвращает pid; если процесс успел выйти с ошибкой, — отказ с кодом выхода
// и хвостом журнала. Один способ для любой оболочки: ни `set -m` (zsh
// отказывает), ни `setsid` (нет в macOS), ни `nohup` не нужны. Запись о
// запуске (`<state>/run-detach.json`) — для сводки `lead drive`: путь и
// хвост журнала последнего run, когда очередь стоит.
//
// `harness review-release --detach --log <файл>` (alpha.77, P12-4) — так же:
// ревью выпуска переживает сессию ведущего (драйвер убивает группу её
// процессов); запуск подтверждает метка идущего ревью (`markReleaseReview`)
// дочернего процесса, и `lead drive` ждёт ревью по ней же.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { HarnessError, WORKSPACE_OWNER } from '../contracts/index.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';

export interface DetachedRun {
  /** Вызов harness: исполняемый файл и аргументы до команды. */
  invocation: string[];
  /** Аргументы команды `run` (без `--detach` и `--log`). */
  args: string[];
  cwd: string;
  log: string;
  pid: number;
  at: string;
  /** Run подтвердил запуск (метка или роль controller); false — срок ожидания вышел. */
  confirmed: boolean;
  /** Run уже закончился успешно (код 0) за время ожидания. */
  exitCode?: number;
}

/** Команды, которые запускаются отдельным процессом. */
export type DetachedCommand = 'run' | 'review-release';

const recordFile = (stateDir: string, command: DetachedCommand = 'run') =>
  join(resolve(stateDir), `${command}-detach.json`);

/**
 * Вызов этого CLI для дочернего процесса и обёртки `H`: `HARNESS_BIN` —
 * путь одного исполняемого файла harness; иначе сам файл CLI, если он
 * исполняемый и node запущен без своих флагов; иначе `node [execArgv] <файл>`
 * (например, `--import tsx`).
 */
export function harnessInvocation(
  options: {
    env?: NodeJS.ProcessEnv;
    script?: string | undefined;
    execPath?: string;
    execArgv?: string[];
  } = {},
): string[] {
  const env = options.env ?? process.env;
  if (env.HARNESS_BIN) return [env.HARNESS_BIN];
  const script = options.script ?? process.argv[1];
  const execPath = options.execPath ?? process.execPath;
  const execArgv = options.execArgv ?? process.execArgv;
  if (!script) return ['harness'];
  if (!execArgv.length)
    try {
      accessSync(script, fsConstants.X_OK);
      return [script];
    } catch {
      /* не исполняемый — через node */
    }
  return [execPath, ...execArgv, script];
}

/** Последние `lines` строк файла (читается не больше 64 КиБ с конца). */
export function logTail(path: string, lines: number): string {
  try {
    const size = statSync(path).size;
    const length = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return buf.toString('utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Run этого процесса подтвердил запуск: метка запуска с его pid или живая роль controller. */
function started(stateDir: string, pid: number): boolean {
  const file = join(resolve(stateDir), 'state.sqlite');
  if (!existsSync(file)) return false;
  let store: SqliteExecutionStore;
  try {
    store = new SqliteExecutionStore(file, 'harness-detach', { readOnly: true });
  } catch {
    return false;
  }
  try {
    return store.read((view) => {
      const marker = view.local('run-start', WORKSPACE_OWNER, 'marker');
      const lease = view.controller()?.leaseUntil ?? 0;
      return marker?.pid === pid || lease > Date.now();
    });
  } catch {
    return false;
  } finally {
    store.close();
  }
}

/** Ревью выпуска этого процесса поставило метку (или живую метку после `since`). */
function reviewStarted(stateDir: string, pid: number, since: number): boolean {
  if (
    existsSync(reviewMarkers(stateDir)) &&
    readdirSync(reviewMarkers(stateDir)).some((n) => n.startsWith(`${pid}-`))
  )
    return true;
  // Обёртка (HARNESS_BIN — скрипт оболочки) может запустить ревью другим pid.
  const live = activeReleaseReview(stateDir);
  return !!live && Date.parse(live.startedAt) >= since - 1000;
}

/**
 * Запустить `harness run` (или `review-release`, `command`) отдельным
 * процессом и дождаться подтверждения запуска (не дольше `waitMs`, по
 * умолчанию 30 с). Процесс вышел с ошибкой — отказ `NOT_READY` с кодом
 * выхода и последними 40 строками журнала.
 */
export async function detachRun(input: {
  stateDir: string;
  args: string[];
  log: string;
  command?: DetachedCommand;
  cwd?: string;
  invocation?: string[];
  waitMs?: number;
  pollMs?: number;
}): Promise<DetachedRun> {
  const command = input.command ?? 'run';
  const invocation = input.invocation ?? harnessInvocation();
  const since = Date.now();
  const log = resolve(input.log);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'a', 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(invocation[0]!, [...invocation.slice(1), command, ...input.args], {
      cwd: input.cwd ?? process.cwd(),
      env: process.env,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  // Объект, а не переменная: TypeScript не сужает поле, записанное из обработчика.
  const state: { exited?: { code: number | null; error?: string } } = {};
  child.on('error', (error) => (state.exited = { code: null, error: error.message }));
  child.on('exit', (code) => (state.exited ??= { code }));
  const deadline = Date.now() + (input.waitMs ?? 30_000);
  let confirmed = false;
  while (!state.exited && Date.now() < deadline) {
    if (
      child.pid &&
      (command === 'run'
        ? started(input.stateDir, child.pid)
        : reviewStarted(input.stateDir, child.pid, since))
    ) {
      confirmed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, input.pollMs ?? 200));
  }
  child.unref();
  const done = state.exited;
  if (done && done.code !== 0)
    throw new HarnessError(
      'NOT_READY',
      `harness ${command} --detach: ${command} вышел ${done.error ? `с ошибкой запуска (${done.error})` : `с кодом ${done.code ?? 'сигнал'}`}; журнал ${log}, последние строки:\n${logTail(log, 40)}`,
      [{ path: ['--log'], message: log }],
    );
  const record: DetachedRun = {
    invocation,
    args: input.args,
    cwd: input.cwd ?? process.cwd(),
    log,
    pid: child.pid!,
    at: new Date().toISOString(),
    confirmed,
    ...(done ? { exitCode: 0 } : {}),
  };
  mkdirSync(resolve(input.stateDir), { recursive: true });
  writeFileSync(recordFile(input.stateDir, command), JSON.stringify(record, null, 2), {
    mode: 0o600,
  });
  return record;
}

/** Последний запуск `run --detach` этого каталога состояния; нет или испорчен — undefined. */
export function lastDetachedRun(stateDir: string): DetachedRun | undefined {
  const file = recordFile(stateDir);
  if (!existsSync(file)) return undefined;
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as DetachedRun;
    return typeof r.log === 'string' ? r : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Идущее ревью выпуска (P10-8): каждый `review-release` ставит свою метку
 * `<state>/review-release-active/<pid>-<uuid>.json` и обновляет её время каждые
 * 30 с, пока работает, чтобы `lead drive` не будил ведущего на «выпуск готов»,
 * пока ревью (прогон gates и reviewer, до десятков минут) не закончилось.
 * Метка не действует, если процесса нет или она не обновлялась дольше
 * REVIEW_MARKER_STALE_MS (процесс убит без finally, pid занят другим); такие
 * метки убираются при чтении.
 */
const reviewMarkers = (stateDir: string) => join(resolve(stateDir), 'review-release-active');
export const REVIEW_MARKER_BEAT_MS = 30_000;
export const REVIEW_MARKER_STALE_MS = 3 * 60_000;

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function markReleaseReview(stateDir: string, now = new Date()): () => void {
  const dir = reviewMarkers(stateDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: now.toISOString() }), {
    mode: 0o600,
  });
  const beat = setInterval(() => {
    try {
      const t = new Date();
      utimesSync(file, t, t);
    } catch {
      // метку убрали — обновлять нечего
    }
  }, REVIEW_MARKER_BEAT_MS);
  beat.unref();
  return () => {
    clearInterval(beat);
    rmSync(file, { force: true });
  };
}

export function activeReleaseReview(
  stateDir: string,
  now = Date.now(),
): { pid: number; startedAt: string } | undefined {
  const dir = reviewMarkers(stateDir);
  if (!existsSync(dir)) return undefined;
  let found: { pid: number; startedAt: string } | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    let live = false;
    try {
      const r = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; startedAt?: unknown };
      live =
        typeof r.pid === 'number' &&
        typeof r.startedAt === 'string' &&
        now - statSync(file).mtimeMs <= REVIEW_MARKER_STALE_MS &&
        processAlive(r.pid);
      if (live) found ??= { pid: r.pid as number, startedAt: r.startedAt as string };
    } catch {
      live = false;
    }
    if (!live) rmSync(file, { force: true });
  }
  return found;
}
