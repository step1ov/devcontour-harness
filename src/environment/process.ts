import { spawn, spawnSync, execFile, type SpawnSyncReturns } from 'node:child_process';
import { lsofName, osTool, osToolEnv } from './os-tools.ts';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { resolve, sep } from 'node:path';
import {
  assertTrustedCheckout,
  forgetWorktree,
  worktreeKey,
  gitHardening,
  rememberWorktree,
  worktreeAddPath,
} from './git-trust.ts';
import { outputRedactor, type Redactor } from './redaction.ts';
import { TaskFailure, type Activity, type RuntimeDiagnostics } from '../contracts/index.ts';
import { activityScope } from './activity.ts';
import { hostLoad, loadText } from './host-load.ts';
import { leaseScope, recordSurvivors } from './survivors.ts';

/**
 * Сдерживаемая команда завершилась, но её потомков не удалось остановить или
 * хотя бы пересчитать (`ps` не ответил под нагрузкой хоста). О коде это
 * ничего не говорит: класс — отказ окружения (`process-reap`), попытка не
 * засчитывается. Сдерживание не ослабляется: результата команды нет, и
 * вызывающий не принимает её исход — потомок, возможно, ещё работает в её
 * каталогах.
 */
export class ReapFailure extends TaskFailure {
  constructor(
    message: string,
    /** Пережившие остановку PID; пусто, если перечень так и не получен. */
    readonly survivors: number[],
    /** Почему перечень процессов не получен; нет — перечень был. */
    readonly inventory: string | undefined,
    /**
     * Исход самой команды (код, вывод), если она завершилась: провал,
     * который она назвала, — свидетельство о коде и при неостановленных
     * потомках. Принимать его успехом нельзя.
     */
    readonly result?: CommandResult,
  ) {
    super('environment', message, undefined, 'process-reap');
    this.name = 'ReapFailure';
  }
  /** Тот же отказ с дописанной причиной (например, неубранными каталогами). */
  extend(suffix: string) {
    return new ReapFailure(
      `${this.message}; ${suffix}`,
      this.survivors,
      this.inventory,
      this.result,
    );
  }
}

/**
 * Отказ остановки потомков завершившейся команды — один текст у всех, кто
 * сдерживает команды (и у хоста со своим запуском): команда, её PID и
 * выход, что не остановлено (PID или почему нет перечня), нагрузка хоста.
 */
export function reapFailure(outcome: {
  /** Что за команда: ID gate, runtime и задача. */
  label: string;
  pid: number | undefined;
  code: number | null;
  signal: NodeJS.Signals | null;
  survivors: number[];
  inventory?: string | undefined;
  redact?: (value: string) => string;
  result?: CommandResult;
}) {
  const pids = (list: number[]) =>
    list.slice(0, 10).join(', ') + (list.length > 10 ? ` и ещё ${list.length - 10}` : '');
  const what = outcome.inventory
    ? `перечень процессов не получен (${outcome.inventory})` +
      (outcome.survivors.length
        ? `; последние замеченные потомки: PID ${pids(outcome.survivors)}`
        : '')
    : `живы после остановки PID ${pids(outcome.survivors)}`;
  const exit = outcome.signal ? `сигнал ${outcome.signal}` : `код выхода ${outcome.code ?? -1}`;
  const text =
    `Не удалось завершить процессы команды «${outcome.label}» (PID ${outcome.pid ?? '?'}, ${exit}): ${what}. ` +
    `Ресурсы не освобождены: потомки команды могут ещё работать; ${loadText(hostLoad.read())}`;
  return new ReapFailure(
    outcome.redact ? outcome.redact(text) : text,
    outcome.survivors,
    outcome.inventory,
    outcome.result,
  );
}
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
    /**
     * Фильтр stderr до маски: получает сырой текст (`final` — последний
     * кусок) и возвращает то, что идёт дальше в маску и вывод. Служебные
     * строки ищутся здесь: маска по значениям окружения могла бы их исказить.
     */
    rawStderr?: (text: string, final: boolean) => string;
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
    /**
     * Что это за команда для обхода зависших попыток. Команда в контексте
     * владельца (`activityScope`) отслеживается и без этого поля — как
     * `command` с именем исполняемого файла.
     */
    activity?: Activity;
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
    // Область аренды ресурсов — в момент запуска: пережившие остановку
    // потомки записываются в её базу (`survivors.ts`).
    const lease = mark ? leaseScope.getStore() : undefined;
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
    const scope = activityScope.getStore();
    const tracked = scope?.begin(
      child.pid,
      options.activity ?? {
        kind: 'command',
        label: (file.split('/').at(-1) || file).slice(0, 300),
      },
      options.redact,
    );
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
      if (tracked) scope!.output(tracked, text);
      try {
        options.onOutput?.(stream, text);
      } catch (error) {
        outputError = error instanceof Error ? error : new Error(String(error));
        stop();
      }
    };
    let pipeBytes = 0;
    child.stdout.on('data', (d: Buffer) => {
      pipeBytes += d.length;
      lastOutputAt = new Date().toISOString();
      if (tracked) scope!.moved();
      const text = stdoutDecoder.write(d);
      options.onRawStdout?.(text);
      append('stdout', maskOut(text));
    });
    child.stderr.on('data', (d: Buffer) => {
      pipeBytes += d.length;
      lastOutputAt = new Date().toISOString();
      if (tracked) scope!.moved();
      const raw = stderrDecoder.write(d);
      append('stderr', maskErr(options.rawStderr ? options.rawStderr(raw, false) : raw));
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
            // Опрос — подсказка для остановки: его отказ не роняет хост,
            // полноту проверяет `sweep` после выхода.
            .catch(() => undefined)
            .finally(() => {
              polling = false;
            });
        }, 250)
      : undefined;
    poll?.unref();
    const dirs = typeof options.contain === 'object' ? options.contain.dirs : [];
    const cleanup = () => {
      if (tracked) scope!.end(tracked);
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
        for (const [pid, start] of await descendants(child.pid, seen).catch(
          () => new Map<number, string>(),
        ))
          seen.set(pid, start);
      const { starts, ...swept } = mark
        ? await sweep(mark, seen, dirs, Date.parse(startedAt))
        : { survivors: [] as number[], starts: new Map<number, string>() };
      if (swept.survivors.length)
        recordSurvivors(
          lease,
          swept.survivors.flatMap((pid) => {
            const start = starts.get(pid);
            return start ? [{ pid, start }] : [];
          }),
          options.activity?.label ?? file.split('/').at(-1) ?? file,
        );
      // Потомков не удалось остановить или пересчитать: исход команды
      // собирается как обычно (ожидание pipes ограничено — их может держать
      // переживший потомок) и уходит вместе с отказом, а не результатом.
      const reaped = swept.survivors.length > 0 || swept.inventory !== undefined;
      // После таймаута или отмены таймер и слушатель отмены уже сняты: держатель
      // pipe, который продолжает писать, не должен растягивать прерванную
      // команду до общего предела. Отмена во время ожидания обрывает его.
      const interrupted = timedOut || Boolean(options.signal?.aborted);
      const drainLimits = interrupted
        ? { limitMs: 3000 }
        : options.signal
          ? { signal: options.signal }
          : {};
      if (mark && !(await drainPipes(closed, () => pipeBytes, drainLimits))) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      const rest = stdoutDecoder.end();
      options.onRawStdout?.(rest);
      append('stdout', maskOut(rest, true));
      const restErr = stderrDecoder.end();
      append(
        'stderr',
        maskErr(options.rawStderr ? options.rawStderr(restErr, true) : restErr, true),
      );
      // Неостановленные потомки важнее отказа обработчика вывода: иначе
      // отказ терял бы причину `process-reap`, и дерево сочли бы свободным.
      if (outputError && !reaped) {
        reject(outputError);
        return;
      }
      const result: CommandResult = {
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
      };
      if (reaped)
        reject(
          reapFailure({
            label: options.activity?.label ?? file.split('/').at(-1) ?? file,
            pid: child.pid,
            code,
            signal,
            ...swept,
            ...(options.redact ? { redact: options.redact } : {}),
            result,
          }),
        );
      else resolve(result);
    };
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    if (options.signal?.aborted) stop();
  });
}
/**
 * Ожидание закрытия pipes сдерживаемой команды после её выхода. Pipe может
 * держать потомок, ушедший от очистки, поэтому ожидание ограничено — но
 * отсчитывается от последнего прочитанного байта, а не от выхода: хвост
 * вывода, который ещё читается под нагрузкой хоста, дочитывается целиком
 * (уничтожение pipe теряло конец итоговой строки), а молчащий держатель pipe
 * стоит команде прежние `idleMs`. Общий предел `limitMs` — на держателя,
 * который продолжает писать. Перед отказом цикл событий проходит фазу
 * ввода-вывода: после долгой блокировки таймер срабатывает раньше, чем
 * прочитаны уже готовые данные. Отмена `signal` обрывает ожидание сразу.
 * `true` — pipes закрылись сами.
 */
export async function drainPipes(
  closed: Promise<void>,
  progress: () => number,
  {
    idleMs = 3000,
    limitMs = 30_000,
    signal,
  }: { idleMs?: number; limitMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  const deadline = performance.now() + limitMs;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<boolean>((done) => {
      void closed.then(() => done(true));
      if (signal?.aborted) return done(false);
      onAbort = () => done(false);
      signal?.addEventListener('abort', onAbort, { once: true });
      let seen = progress();
      const arm = () => {
        timer = setTimeout(
          () => setImmediate(check),
          Math.max(0, Math.min(idleMs, deadline - performance.now())),
        );
      };
      const check = () => {
        // Pipes закрылись, пока проверка ждала своей фазы: новый таймер
        // держал бы вызывающего живым.
        if (settled) return;
        const now = progress();
        if (now === seen || performance.now() >= deadline) return done(false);
        seen = now;
        arm();
      };
      arm();
    });
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
function captureProcessTree(pid?: number): RuntimeDiagnostics['processTree'] {
  if (!pid || process.platform === 'win32')
    return {
      available: false,
      reason: 'Process inventory unavailable on this platform',
      processes: [],
    };
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(osTool('ps'), ['-axo', 'pid=,ppid=,pgid=,comm='], {
      encoding: 'utf8',
      env: osToolEnv(),
      timeout: 250,
      maxBuffer: 1_000_000,
    });
  } catch (error) {
    return { available: false, reason: inventoryUnavailable('ps', error), processes: [] };
  }
  if (result.error && typeof (result.error as NodeJS.ErrnoException).code === 'string')
    inventoryUnavailable('ps', result.error);
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
/**
 * Index controller для рабочих деревьев попыток (0.1.0-alpha.70, ревью 3).
 * Собственный index дерева (`<gitdir>/index`) пишут исполнитель и gates:
 * флаги `assume-unchanged`/`skip-worktree` прятали бы изменения, а ссылка
 * вместо файла направила бы запись controller в чужой index. Git хоста в
 * зарегистрированном дереве работает со своим файлом index controller
 * (`GIT_INDEX_FILE`); index дерева он не читает и не пишет.
 */
const controllerIndexes = new Map<string, string>();
export function useControllerIndex(worktree: string, file: string) {
  controllerIndexes.set(resolve(worktree), file);
}
export function releaseControllerIndex(worktree: string) {
  const root = resolve(worktree);
  const file = controllerIndexes.get(root);
  controllerIndexes.delete(root);
  return file;
}
export function controllerIndexOf(cwd: string): string | undefined {
  const at = resolve(cwd);
  for (const [root, file] of controllerIndexes)
    if (at === root || at.startsWith(root + sep)) return file;
  return undefined;
}

const gitEnv = (cwd?: string) => ({
  ...process.env,
  ...((file) => (file ? { GIT_INDEX_FILE: file } : {}))(cwd ? controllerIndexOf(cwd) : undefined),
  GIT_TERMINAL_PROMPT: '0',
  // Дублирует `--no-replace-objects` из `gitHardening` для дочерних git.
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_AUTHOR_NAME: 'devcontour-harness',
  GIT_AUTHOR_EMAIL: 'harness@localhost',
  GIT_COMMITTER_NAME: 'devcontour-harness',
  GIT_COMMITTER_EMAIL: 'harness@localhost',
});

/**
 * Вывод git целиком. `git` хранит только хвост вывода (предел `command`): для
 * содержимого файла, которое разбирают, усечение незаметно и опасно.
 */
export async function gitOutput(cwd: string, ...args: string[]) {
  return (await gitRawOutput(cwd, ...args)).trim();
}

/** Вывод git целиком и без обрезки пробелов: для `-z`-списков путей. */
export async function gitRawOutput(cwd: string, ...args: string[]) {
  let text = '';
  const result = await command(['git', ...hostGitArgs(cwd, args)], cwd, {
    env: gitEnv(cwd),
    onRawStdout: (chunk) => {
      text += chunk;
    },
  });
  if (result.code !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim()}`);
  return text;
}

/**
 * Содержимое объектов git одним `cat-file --batch`: байты, без усечения и
 * без процесса на объект. Отсутствующий объект — отказ.
 */
export async function gitBlobs(cwd: string, ids: readonly string[]) {
  const out = new Map<string, Buffer>();
  if (!ids.length) return out;
  const unique = [...new Set(ids)];
  const data = await new Promise<Buffer>((done, fail) => {
    const child = spawn('git', hostGitArgs(cwd, ['cat-file', '--batch']), {
      cwd,
      env: gitEnv(cwd),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? done(Buffer.concat(chunks)) : fail(new Error(`git cat-file: ${stderr.trim()}`)),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(unique.join('\n') + '\n');
  });
  let at = 0;
  for (const id of unique) {
    const eol = data.indexOf(10, at);
    if (eol < 0) throw new Error('git cat-file: ответ оборван');
    const [sha, type, size] = data.subarray(at, eol).toString().split(' ');
    if (type === 'missing' || size === undefined)
      throw new Error(`git cat-file: нет объекта ${id}`);
    const length = Number(size);
    out.set(sha!, data.subarray(eol + 1, eol + 1 + length));
    at = eol + 1 + length + 1;
  }
  return out;
}

/**
 * Предел вывода `git` в символах. Вывод больше предела — отказ
 * `GitOutputLimit`, а не хвост: усечённый diff, список путей или содержимое
 * файла выглядели бы полными.
 */
export const GIT_OUTPUT_LIMIT = 64_000_000;

/** Вывод `git` больше предела: результат не возвращается, команда остановлена. */
export class GitOutputLimit extends Error {
  constructor(
    readonly args: readonly string[],
    readonly limit: number,
  ) {
    super(
      `git ${args[0]}: вывод больше ${limit} символов; команда остановлена, усечённый вывод не используется`,
    );
    this.name = 'GitOutputLimit';
  }
}

/**
 * Вывод git целиком (без пробелов по краям, кроме `-z`-вывода); больше
 * `GIT_OUTPUT_LIMIT` — отказ.
 */
export async function git(cwd: string, ...args: string[]) {
  return gitWithLimit(cwd, GIT_OUTPUT_LIMIT, ...args);
}

/**
 * `git` с явным пределом вывода. Вывод собирается целиком, а не хвостом
 * `command`: превышение предела останавливает команду и даёт `GitOutputLimit`.
 */
export async function gitWithLimit(cwd: string, limit: number, ...args: string[]) {
  const added = worktreeAddPath(args);
  // Путь убираемого дерева — до удаления: потом настоящий путь уже не узнать.
  const removed =
    args[0] === 'worktree' && args[1] === 'remove'
      ? worktreeKey(resolve(cwd, args.at(-1)!))
      : undefined;
  let text = '';
  let over = false;
  const stop = new AbortController();
  const result = await command(['git', ...hostGitArgs(cwd, args)], cwd, {
    env: gitEnv(cwd),
    signal: stop.signal,
    onRawStdout: (chunk) => {
      if (over || !chunk) return;
      if (text.length + chunk.length > limit) {
        over = true;
        text = '';
        stop.abort();
      } else text += chunk;
    },
  });
  if (over) throw new GitOutputLimit(args, limit);
  if (result.code !== 0)
    throw new Error(`git ${args[0]}: ${result.stderr.trim() || result.stdout.trim()}`);
  if (added) rememberWorktree(resolve(cwd, added));
  if (removed) forgetWorktree(removed);
  // `-z`-вывод не обрезается: пробел в начале первого пути — часть пути.
  return args.includes('-z') ? text : text.trim();
}

/**
 * Вывод системной утилиты или причина, по которой его нет. Не блокирует
 * event loop. Локаль фиксирована (`osToolEnv`): вывод разбирается.
 */
function outcome(
  command: string,
  args: string[],
  timeout: number,
  partial?: number,
): Promise<{ stdout: string } | { error: string }> {
  const name = command.split('/').at(-1) ?? command;
  return new Promise((resolve) => {
    // Запуск может отказать синхронно (EPERM под sandbox и др.): отказ —
    // «перечень недоступен», а не исключение в таймере опроса.
    try {
      execFile(
        command,
        args,
        { encoding: 'utf8', env: osToolEnv(), timeout, maxBuffer: 64_000_000 },
        (error, stdout) => {
          if (!error || (partial && error.code === partial)) return resolve({ stdout });
          // Строковый код — отказ запуска (ENOENT, EACCES), а не выход утилиты.
          if (typeof error.code === 'string') inventoryUnavailable(name, error);
          resolve({
            error: error.killed
              ? `${name} не ответил за ${Math.round(timeout / 1000)} с`
              : `${name}: ${typeof error.code === 'number' ? `код выхода ${error.code}` : (error.code ?? error.message)}`,
          });
        },
      );
    } catch (error) {
      resolve({ error: inventoryUnavailable(name, error) });
    }
  });
}

/**
 * Последний отказ запуска утилиты перечня процессов (`ps`, `lsof`): перечень
 * недоступен, хост продолжает работу. Первый отказ процесса — ещё и
 * предупреждение Node (`HARNESS_PROCESS_INVENTORY`).
 */
export const inventoryStatus: {
  failures: number;
  last?: { tool: string; reason: string; at: string };
} = { failures: 0 };
function inventoryUnavailable(tool: string, error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  const reason = `${tool}: запуск не удался (${typeof code === 'string' ? code : error instanceof Error ? error.message : String(error)}); перечень процессов недоступен`;
  if (!inventoryStatus.failures++)
    try {
      process.emitWarning(reason, { code: 'HARNESS_PROCESS_INVENTORY' });
    } catch {
      /* Предупреждение — сведение. */
    }
  inventoryStatus.last = { tool, reason, at: new Date().toISOString() };
  return reason;
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
  const listed = await processInventory.tool(
    osTool('ps'),
    ['-Eww', '-ax', '-o', 'pid=,command='],
    10000,
  );
  if ('error' in listed) throw new Error(listed.error);
  return listed.stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m && m[2]!.includes(needle) && Number(m[1]) !== process.pid ? [Number(m[1])] : [];
  });
}
/**
 * Живые процессы: PID, родитель, время старта. `strict` — для остановки
 * потомков: неполученная таблица там не «процессов нет», а отказ перечня
 * (`sweep` повторяет его и сдаётся с `ReapFailure`). Опрос во время команды
 * пустую таблицу переживает.
 */
export async function processTable(
  strict = false,
): Promise<{ pid: number; ppid: number; start: string }[]> {
  const listed = await processInventory.tool(osTool('ps'), ['-axo', 'pid=,ppid=,lstart='], 10000);
  if ('error' in listed) {
    if (strict) throw new Error(listed.error);
    return [];
  }
  return listed.stdout.split('\n').flatMap((line) => {
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
async function inside(
  dirs: string[],
  since: number,
  table: { pid: number; start: string }[],
): Promise<number[]> {
  if (!dirs.length) return [];
  // lsof и /proc сообщают настоящие пути; временный каталог macOS — за symlink.
  dirs = dirs.map((d) => {
    try {
      return realpathSync(d);
    } catch {
      return d;
    }
  });
  const started = new Map(table.map((r) => [r.pid, Date.parse(r.start)]));
  // Нечитаемое время старта — не повод оставить процесс: каталоги принадлежат
  // только этой команде, и утечка её потомка хуже ошибочной остановки.
  // Отсекается только процесс, о котором точно известно, что он старше
  // команды. Процесса нет в снимке — он запущен после снимка; это и сам
  // lsof с текущим каталогом внутри, поэтому такой процесс не берётся: его
  // потомка найдёт следующий проход.
  const fresh = (pid: number) => {
    if (!started.has(pid)) return false;
    const at = started.get(pid)!;
    return !Number.isFinite(at) || at >= since - 1000;
  };
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
  // Только процессы моложе команды: обход всех процессов пользователя занимает
  // сотни миллисекунд на каждую команду. Код 1 — часть из них уже завершилась.
  const candidates = [...started.keys()].filter((pid) => pid !== process.pid && fresh(pid));
  if (!candidates.length) return [];
  // Отказ lsof — неполученный перечень, а не «в каталогах никого нет».
  const listed = await processInventory.tool(
    osTool('lsof'),
    ['-a', '-d', 'cwd', '-Fpn', '-u', String(process.getuid?.()), '-p', candidates.join(',')],
    15000,
    1,
  );
  if ('error' in listed) throw new Error(listed.error);
  const pids: number[] = [];
  let pid = 0;
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (
      line.startsWith('n') &&
      within(lsofName(line.slice(1))) &&
      pid !== process.pid &&
      fresh(pid)
    )
      pids.push(pid);
  }
  return pids;
}
/**
 * Перечень процессов для остановки потомков; объект — чтобы тест мог
 * подменить его отказ.
 */
export const processInventory = {
  marked,
  /** Запуск системной утилиты перечня (`ps`, `lsof`). */
  tool: outcome,
};
/** Сколько раз перечень может не получиться за одну остановку, прежде чем она сдаётся. */
const INVENTORY_TRIES = 3;
/**
 * Остановить всех потомков команды; вернуть тех, кто пережил попытки, и —
 * если перечень так и не получен — почему. Перечень не получен — не «живых
 * нет»: команда тогда не считается завершённой.
 */
async function sweep(
  mark: string,
  seen: Map<number, string>,
  dirs: string[],
  since: number,
): Promise<{ survivors: number[]; inventory?: string; starts: Map<number, string> }> {
  let left: number[] = [];
  let failures = 0;
  // Время старта по последней полученной таблице: по нему запись о
  // пережившем процессе отличает его от нового с тем же PID.
  let starts = new Map<number, string>();
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const rows = await processTable(true);
      const table = new Map(rows.map((r) => [r.pid, r.start]));
      starts = table;
      left = [
        ...new Set([
          ...(await processInventory.marked(mark)),
          // Замеченный опросом потомок — только если это тот же процесс, а
          // не новый, получивший освободившийся PID.
          ...[...seen].filter(([pid, start]) => table.get(pid) === start).map(([pid]) => pid),
          ...(await inside(dirs, since, rows)),
        ]),
      ];
    } catch (error) {
      // Под нагрузкой хоста `ps` не укладывается в свой предел: перечень
      // повторяется, а не объявляется отказом с первого раза. Уже известные
      // потомки останавливаются и между попытками.
      const reason = error instanceof Error ? error.message : String(error);
      if (++failures >= INVENTORY_TRIES) return { survivors: left, inventory: reason, starts };
      for (const pid of left)
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already gone. */
        }
      await new Promise((r) => setTimeout(r, 500 * failures));
      continue;
    }
    if (!left.length) return { survivors: [], starts };
    for (const pid of left)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { survivors: left, starts };
}
