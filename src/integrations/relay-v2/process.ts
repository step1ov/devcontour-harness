import { spawn } from 'node:child_process';

/**
 * Один вызов Relay-2 CLI: argv-массив без shell, ограниченные вывод и время,
 * завершение всей группы процессов при таймауте, отмене или переполнении.
 * Результат возвращается только после `close`: дочерний процесс к этому
 * моменту завершён и собран (нет зомби), pipes закрыты.
 */
export interface CliRun {
  /** Процесс так и не стартовал (нет binary, нет прав): запрос не ушёл. */
  spawnError?: NodeJS.ErrnoException;
  /** Процесс стартовал (запрос мог дойти до backend). */
  started: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Суммарный вывод превысил лимит; процесс остановлен. */
  oversized: boolean;
  durationMs: number;
  pid?: number;
}

export interface CliRunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Пауза между SIGTERM и SIGKILL группе. */
  killGraceMs: number;
  signal?: AbortSignal;
}

export function runCli(file: string, args: string[], options: CliRunOptions): Promise<CliRun> {
  const startedAt = Date.now();
  if (options.signal?.aborted)
    return Promise.resolve({
      started: false,
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: true,
      oversized: false,
      durationMs: 0,
    });
  return new Promise((resolve) => {
    const posix = process.platform !== 'win32';
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      // Своя группа: сигнал `-pid` достаёт и потомков binary.
      detached: posix,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let aborted = false;
    let oversized = false;
    let stopping = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid && posix) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* Группа уже завершилась. */
      }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), options.killGraceMs);
    };
    const take = (chunks: Buffer[]) => (d: Buffer) => {
      if (oversized) return;
      bytes += d.length;
      if (bytes > options.maxOutputBytes) {
        oversized = true;
        stop();
        return;
      }
      chunks.push(d);
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));

    const onAbort = () => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

    let done = false;
    child.once('error', (e: NodeJS.ErrnoException) => {
      // `error` без pid — процесс не стартовал (ENOENT/EACCES): запрос не ушёл.
      if (child.pid) return;
      spawnError = e;
      finish(null, null);
    });
    child.once('close', (code, sig) => finish(code, sig));
    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      // Лидер группы вышел; оставшиеся потомки (если были) получают SIGKILL
      // сразу, а не по таймеру.
      if (stopping || code !== 0) signalGroup('SIGKILL');
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ...(spawnError ? { spawnError } : {}),
        started: Boolean(child.pid) && !spawnError,
        code,
        signal: sig,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        aborted,
        oversized,
        durationMs: Date.now() - startedAt,
        ...(child.pid ? { pid: child.pid } : {}),
      });
    };
  });
}
