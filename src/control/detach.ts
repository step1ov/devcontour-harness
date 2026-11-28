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
  fchmodSync,
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
import { HarnessError, WORKSPACE_OWNER, exitCodes } from '../contracts/index.ts';
import { sampleProcesses } from '../engine/stall-sweep.ts';
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
  /**
   * Команда уже закончилась за время ожидания: код 0 — успешно; у
   * `review-release` и код `exitCodes.refused` (3) — законченное ревью «не
   * одобрено» (ревью alpha.77 M2), а не отказ запуска.
   */
  exitCode?: number;
  /** Последние строки журнала законченного ревью выпуска (ревью «не одобрено»). */
  logTail?: string;
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

/**
 * Ревью выпуска этого процесса поставило метку: метка с pid дочернего
 * процесса или его потомка (обёртка `HARNESS_BIN` — скрипт оболочки — может
 * запустить ревью другим pid), поставленная после запуска. Метка другого
 * одновременного ревью не подтверждает запуск (ревью alpha.77 M2).
 */
async function reviewStarted(stateDir: string, pid: number, since: number): Promise<boolean> {
  const live = activeReleaseReviews(stateDir).filter(
    (m) => Date.parse(m.startedAt) >= since - 1000,
  );
  if (live.some((m) => m.pid === pid)) return true;
  if (!live.length) return false;
  const rows = (await sampleProcesses()) ?? [];
  const parent = new Map(rows.map((r) => [r.pid, r.parentPid]));
  return live.some((m) => {
    for (let p = parent.get(m.pid), hops = 0; p && hops < 64; p = parent.get(p), hops++)
      if (p === pid) return true;
    return false;
  });
}

/** Журнал команды `--detach`: дописывается, ссылкой быть не может, права 0600 (ревью alpha.77 L1). */
function openLog(log: string): number {
  let fd: number;
  try {
    fd = openSync(
      log,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw new HarnessError(
      'INVALID_INPUT',
      `--log: журнал не открыт (${(error as Error).message}); ссылка вместо файла журнала не принимается`,
      [{ path: ['--log'], message: log }],
    );
  }
  try {
    fchmodSync(fd, 0o600);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
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
  // Второе ревью выпуска рядом с идущим не запускается (ревью alpha.77 M2).
  const running = command === 'review-release' ? activeReleaseReview(input.stateDir) : undefined;
  if (running)
    throw new HarnessError(
      'NOT_READY',
      `harness review-release --detach: ревью выпуска уже идёт (pid ${running.pid}, с ${running.startedAt}); дождитесь его конца — lead drive ждёт его сам`,
      [{ path: ['--state'], message: input.stateDir }],
    );
  const since = Date.now();
  const log = resolve(input.log);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openLog(log);
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
        : await reviewStarted(input.stateDir, child.pid, since))
    ) {
      confirmed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, input.pollMs ?? 200));
  }
  child.unref();
  const done = state.exited;
  // Быстрое законченное ревью «не одобрено» (повтор прежнего раунда), чью
  // метку опрос не застал, — результат, а не отказ запуска (ревью alpha.77 M2).
  const finished =
    !!done &&
    (done.code === 0 || (command === 'review-release' && done.code === exitCodes.refused));
  if (done && !finished)
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
    ...(done ? { exitCode: done.code! } : {}),
    ...(done && done.code !== 0 ? { logTail: logTail(log, 40) } : {}),
  };
  mkdirSync(resolve(input.stateDir), { recursive: true });
  writeFileSync(recordFile(input.stateDir, command), JSON.stringify(record, null, 2), {
    mode: 0o600,
  });
  return record;
}

/** Последний запуск `run --detach` (или `review-release --detach`) каталога состояния; нет или испорчен — undefined. */
export function lastDetachedRun(
  stateDir: string,
  command: DetachedCommand = 'run',
): DetachedRun | undefined {
  const file = recordFile(stateDir, command);
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

/** Все действующие метки ревью выпуска; недействующие убираются при чтении. */
export function activeReleaseReviews(
  stateDir: string,
  now = Date.now(),
): { pid: number; startedAt: string }[] {
  const dir = reviewMarkers(stateDir);
  if (!existsSync(dir)) return [];
  const found: { pid: number; startedAt: string }[] = [];
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
      if (live) found.push({ pid: r.pid as number, startedAt: r.startedAt as string });
    } catch {
      live = false;
    }
    if (!live) rmSync(file, { force: true });
  }
  return found;
}

export function activeReleaseReview(
  stateDir: string,
  now = Date.now(),
): { pid: number; startedAt: string } | undefined {
  return activeReleaseReviews(stateDir, now)[0];
}
