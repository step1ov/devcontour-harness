import { spawn, spawnSync, execFile } from 'node:child_process';
import { osTool } from './os-tools.ts';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';
import {
  assertTrustedCheckout,
  forgetWorktree,
  worktreeKey,
  gitHardening,
  rememberWorktree,
  worktreeAddPath,
} from './git-trust.ts';
import { outputRedactor, type Redactor } from './redaction.ts';
import type { RuntimeDiagnostics } from '../contracts/index.ts';
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  diagnostics: RuntimeDiagnostics;
}
export async function command(
  argv: string[],
  cwd: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    input?: string;
    env?: NodeJS.ProcessEnv;
    redact?: Redactor;
    onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
    /**
     * Немаскированный stdout — только в памяти вызывающего, для разбора
     * структуры (события runtime): маска по всему потоку портила бы и
     * служебные строки JSON. Сохранять его нельзя.
     */
    onRawStdout?: (text: string) => void;
    /** Процесс запущен (событие `spawn`): до него команда не исполнялась. */
    onSpawn?: () => void;
    /**
     * Владеть всеми потомками, включая сменивших группу или сессию: после
     * завершения они останавливаются, и результат не возвращается, пока
     * хотя бы один жив. Сигнал группе не достаёт отсоединившегося потомка.
     *
     * Потомок узнаётся по любому из трёх признаков: метка окружения (её
     * наследуют все, кто не очистил окружение), замеченное опросом родство с
     * командой и текущий каталог внутри `dirs` — каталогов, которые принадлежат
     * только этой команде (worktree, scratch). Ни один признак сам по себе не
     * полон: окружение можно очистить, опрос можно опередить, каталог сменить.
     */
    contain?: boolean | { dirs: string[] };
  } = {},
): Promise<CommandResult> {
  const [file, ...args] = argv;
  if (!file) throw new Error('Пустая команда');
  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    let lastOutputAt: string | null = null;
    let processTree: RuntimeDiagnostics['processTree'];
    // Метку окружения наследуют все потомки, в том числе отсоединившиеся:
    // по ней их находят после завершения.
    const mark = options.contain ? randomUUID() : undefined;
    const child = spawn(file, args, {
      cwd,
      env: mark
        ? {
            ...(options.env ?? process.env),
            DEVCONTOUR_PROCESS_MARK: mark,
            HARNESS_PROCESS_MARK: mark,
          }
        : (options.env ?? process.env),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (options.onSpawn) child.once('spawn', options.onSpawn);
    let stdout = '',
      stderr = '',
      timedOut = false,
      killTimer: NodeJS.Timeout | undefined;
    const stdoutDecoder = new StringDecoder('utf8'),
      stderrDecoder = new StringDecoder('utf8');
    const maskOut = outputRedactor(options.redact),
      maskErr = outputRedactor(options.redact);
    let outputError: Error | undefined;
    const append = (stream: 'stdout' | 'stderr', text: string) => {
      if (!text) return;
      if (stream === 'stdout') stdout = (stdout + text).slice(-2_000_000);
      else stderr = (stderr + text).slice(-2_000_000);
      try {
        options.onOutput?.(stream, text);
      } catch (error) {
        outputError = error instanceof Error ? error : new Error(String(error));
        stop();
      }
    };
    child.stdout.on('data', (d: Buffer) => {
      lastOutputAt = new Date().toISOString();
      const text = stdoutDecoder.write(d);
      options.onRawStdout?.(text);
      append('stdout', maskOut(text));
    });
    child.stderr.on('data', (d: Buffer) => {
      lastOutputAt = new Date().toISOString();
      append('stderr', maskErr(stderrDecoder.write(d)));
    });
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Process already exited. */
      }
    };
    const stop = () => {
      processTree ??= captureProcessTree(child.pid);
      signalGroup('SIGTERM');
      if (killTimer) return;
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 1000);
      killTimer.unref();
    };
    const abort = () => stop();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? 120000);
    // Опрос дерева: потомок, успевший отсоединиться и сменить окружение,
    // остаётся узнаваемым по PID и времени старта, пока он жив.
    const seen = new Map<number, string>();
    // Опрос не блокирует event loop: синхронный ps каждые 200 мс под
    // нагрузкой задерживал обработку выхода команды, и срабатывал таймаут.
    let polling = false;
    const poll = mark
      ? setInterval(() => {
          if (polling || !child.pid) return;
          polling = true;
          void descendants(child.pid, seen)
            .then((found) => {
              for (const [pid, start] of found) seen.set(pid, start);
            })
            .finally(() => {
              polling = false;
            });
        }, 250)
      : undefined;
    poll?.unref();
    const dirs = typeof options.contain === 'object' ? options.contain.dirs : [];
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (poll) clearInterval(poll);
      options.signal?.removeEventListener('abort', abort);
    };
    child.once('error', (e) => {
      cleanup();
      reject(e);
    });
    // Сдерживаемая команда завершается по exit, а не по close: потомок,
    // унаследовавший stdout, держит pipe открытым, и close не наступает, пока
    // он жив, — а очистка ждала именно close. После очистки pipes закрываются;
    // если нет, их ожидание ограничено.
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    if (mark)
      child.once('exit', (code, signal) => {
        void finish(code, signal).catch(reject);
      });
    else
      child.once('close', (code, signal) => {
        void finish(code, signal).catch(reject);
      });
    const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== 0 || options.signal?.aborted || timedOut) signalGroup('SIGKILL');
      // Таймер снимается сразу по выходу: иначе он срабатывал во время
      // очистки и помечал завершившуюся команду как истёкшую.
      cleanup();
      if (child.pid && mark)
        for (const [pid, start] of await descendants(child.pid, seen)) seen.set(pid, start);
      const survivors = mark ? await sweep(mark, seen, dirs, Date.parse(startedAt)) : [];
      if (survivors.length) {
        reject(
          new Error(
            `Не удалось завершить процессы проверки: ${survivors.join(', ')}. Ресурсы не освобождены`,
          ),
        );
        return;
      }
      if (mark) {
        const bounded = await Promise.race([
          closed.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
        ]);
        if (!bounded) {
          child.stdout.destroy();
          child.stderr.destroy();
        }
      }
      const rest = stdoutDecoder.end();
      options.onRawStdout?.(rest);
      append('stdout', maskOut(rest, true));
      append('stderr', maskErr(stderrDecoder.end(), true));
      if (outputError) {
        reject(outputError);
        return;
      }
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        diagnostics: {
          startedAt,
          finishedAt: new Date().toISOString(),
          lastOutputAt,
          exitCode: code,
          signal,
          timedOut,
          aborted: Boolean(options.signal?.aborted),
          stdoutTail: stdout.slice(-4000),
          stderrTail: stderr.slice(-4000),
          processTree,
        },
      });
    };
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    if (options.signal?.aborted) stop();
  });
}
function captureProcessTree(pid?: number): RuntimeDiagnostics['processTree'] {
  if (!pid || process.platform === 'win32')
    return {
      available: false,
      reason: 'Process inventory unavailable on this platform',
      processes: [],
    };
  const result = spawnSync(osTool('ps'), ['-axo', 'pid=,ppid=,pgid=,comm='], {
    encoding: 'utf8',
    timeout: 250,
    maxBuffer: 1_000_000,
  });
  if (result.status !== 0)
    return { available: false, reason: 'OS denied or timed out process inventory', processes: [] };
  const rows = result.stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m
      ? [
          {
            pid: Number(m[1]),
            parentPid: Number(m[2]),
            groupPid: Number(m[3]),
            name: m[4]!.split('/').at(-1)!,
          },
        ]
      : [];
  });
  const ids = new Set([pid]);
  for (let size = -1; size !== ids.size;) {
    size = ids.size;
    for (const row of rows) if (ids.has(row.parentPid) || row.groupPid === pid) ids.add(row.pid);
  }
  return { available: true, processes: rows.filter((r) => ids.has(r.pid)).slice(0, 100) };
}
/**
 * Аргументы git хоста над `cwd`: репозиторий сверен (`assertTrustedCheckout`),
 * исполняемые настройки сняты. Один путь для всех вызовов git хоста.
 */
export function hostGitArgs(cwd: string, args: string[]) {
  assertTrustedCheckout(cwd);
  return [...gitHardening, ...args];
}
export async function git(cwd: string, ...args: string[]) {
  const added = worktreeAddPath(args);
  // Путь убираемого дерева — до удаления: потом настоящий путь уже не узнать.
  const removed =
    args[0] === 'worktree' && args[1] === 'remove'
      ? worktreeKey(resolve(cwd, args.at(-1)!))
      : undefined;
  const result = await command(['git', ...hostGitArgs(cwd, args)], cwd, {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'devcontour-harness',
      GIT_AUTHOR_EMAIL: 'harness@localhost',
      GIT_COMMITTER_NAME: 'devcontour-harness',
      GIT_COMMITTER_EMAIL: 'harness@localhost',
    },
  });
  if (result.code !== 0)
    throw new Error(`git ${args[0]}: ${result.stderr.trim() || result.stdout.trim()}`);
  if (added) rememberWorktree(resolve(cwd, added));
  if (removed) forgetWorktree(removed);
  return result.stdout.trim();
}

/** Вывод команды или null, если она не выполнилась. Не блокирует event loop. */
function output(command: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', timeout, maxBuffer: 64_000_000 }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}
/** Процессы пользователя, в окружении которых есть метка. */
async function marked(mark: string): Promise<number[]> {
  const needle = `DEVCONTOUR_PROCESS_MARK=${mark}`;
  if (process.platform === 'linux') {
    return readdirSync('/proc').flatMap((entry) => {
      if (!/^\d+$/.test(entry)) return [];
      try {
        return readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(needle)
          ? [Number(entry)]
          : [];
      } catch {
        return [];
      }
    });
  }
  // macOS: -E добавляет окружение к команде для процессов своего пользователя.
  const stdout = await output(osTool('ps'), ['-Eww', '-ax', '-o', 'pid=,command='], 10000);
  if (stdout === null) throw new Error('Не удалось перечислить процессы проверки');
  return stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m && m[2]!.includes(needle) && Number(m[1]) !== process.pid ? [Number(m[1])] : [];
  });
}
/** Живые процессы: PID, родитель, время старта. */
async function processTable(): Promise<{ pid: number; ppid: number; start: string }[]> {
  const stdout = await output(osTool('ps'), ['-axo', 'pid=,ppid=,lstart='], 10000);
  if (stdout === null) return [];
  return stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), start: m[3]!.trim() }] : [];
  });
}
/** Потомки процесса и уже замеченных потомков, с временем старта. */
async function descendants(root: number, known: Map<number, string>) {
  const table = await processTable();
  const found = new Map<number, string>();
  const parents = new Set([root, ...known.keys()]);
  for (let size = -1; size !== found.size;) {
    size = found.size;
    for (const row of table)
      if (parents.has(row.ppid) && row.pid !== process.pid && !found.has(row.pid)) {
        found.set(row.pid, row.start);
        parents.add(row.pid);
      }
  }
  return found;
}
/**
 * Процессы, запущенные после старта команды, чей текущий каталог внутри
 * одного из её каталогов. Время старта отсекает процессы пользователя —
 * например, терминал, открытый в worktree раньше.
 */
async function inside(dirs: string[], since: number): Promise<number[]> {
  if (!dirs.length) return [];
  // lsof и /proc сообщают настоящие пути; временный каталог macOS — за symlink.
  dirs = dirs.map((d) => {
    try {
      return realpathSync(d);
    } catch {
      return d;
    }
  });
  const started = new Map((await processTable()).map((r) => [r.pid, Date.parse(r.start)]));
  const fresh = (pid: number) => (started.get(pid) ?? 0) >= since - 1000;
  const within = (path: string) => dirs.some((d) => path === d || path.startsWith(d + '/'));
  if (process.platform === 'linux')
    return readdirSync('/proc').flatMap((entry) => {
      if (!/^\d+$/.test(entry)) return [];
      try {
        return within(readlinkSync(`/proc/${entry}/cwd`)) && fresh(Number(entry))
          ? [Number(entry)]
          : [];
      } catch {
        return [];
      }
    });
  const stdout = await output(
    osTool('lsof'),
    ['-a', '-d', 'cwd', '-Fpn', '-u', String(process.getuid?.())],
    15000,
  );
  const pids: number[] = [];
  let pid = 0;
  for (const line of (stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && within(line.slice(1)) && pid !== process.pid && fresh(pid))
      pids.push(pid);
  }
  return pids;
}
/** Остановить всех потомков команды; вернуть тех, кто пережил попытки. */
async function sweep(
  mark: string,
  seen: Map<number, string>,
  dirs: string[],
  since: number,
): Promise<number[]> {
  let left: number[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const table = new Map((await processTable()).map((r) => [r.pid, r.start]));
      left = [
        ...new Set([
          ...(await marked(mark)),
          // Замеченный опросом потомок — только если это тот же процесс, а
          // не новый, получивший освободившийся PID.
          ...[...seen].filter(([pid, start]) => table.get(pid) === start).map(([pid]) => pid),
          ...(await inside(dirs, since)),
        ]),
      ];
    } catch {
      return [-1];
    }
    if (!left.length) return [];
    for (const pid of left)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
    await new Promise((r) => setTimeout(r, 100));
  }
  return left;
}
