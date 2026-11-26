// `harness run --detach --log <файл>` (alpha.72, ревью drive 2 H1): запуск
// `harness run` отдельным процессом в своей группе и сессии (setsid через
// `detached`), stdin закрыт, stdout и stderr — в файл журнала; команда
// сразу возвращает pid. Один способ для любой оболочки: ни `set -m` (zsh
// отказывает), ни `setsid` (нет в macOS), ни `nohup` не нужны. Запись о
// запуске (`<state>/run-detach.json`: вызов, аргументы, каталог, журнал) —
// для `lead drive`: он перезапускает тот же run сам, когда работы готовы, а
// ждать некого.

import { spawn } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface DetachedRun {
  /** Вызов harness: исполняемый файл и аргументы до команды. */
  invocation: string[];
  /** Аргументы команды `run` (без `--detach` и `--log`). */
  args: string[];
  cwd: string;
  log: string;
  pid: number;
  at: string;
}

const recordFile = (stateDir: string) => join(resolve(stateDir), 'run-detach.json');

/**
 * Вызов этого CLI для дочернего процесса и команд сводки: `HARNESS_BIN`
 * (один путь), иначе сам файл CLI, если он исполняемый и node запущен без
 * своих флагов, иначе `node [execArgv] <файл>` (например, `--import tsx`).
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

/** Запустить `harness run` отдельным процессом; вернуть запись о запуске. */
export function detachRun(input: {
  stateDir: string;
  args: string[];
  log: string;
  cwd?: string;
  invocation?: string[];
}): DetachedRun {
  const invocation = input.invocation ?? harnessInvocation();
  const log = resolve(input.log);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'a', 0o600);
  let pid: number | undefined;
  try {
    const child = spawn(invocation[0]!, [...invocation.slice(1), 'run', ...input.args], {
      cwd: input.cwd ?? process.cwd(),
      env: process.env,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.on('error', () => {});
    child.unref();
    pid = child.pid;
  } finally {
    closeSync(fd);
  }
  if (!pid) throw new Error('harness run не запустился: ' + invocation[0]);
  const record: DetachedRun = {
    invocation,
    args: input.args,
    cwd: input.cwd ?? process.cwd(),
    log,
    pid,
    at: new Date().toISOString(),
  };
  mkdirSync(resolve(input.stateDir), { recursive: true });
  writeFileSync(recordFile(input.stateDir), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

/** Последний запуск `run --detach` этого каталога состояния; нет или испорчен — undefined. */
export function lastDetachedRun(stateDir: string): DetachedRun | undefined {
  const file = recordFile(stateDir);
  if (!existsSync(file)) return undefined;
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as DetachedRun;
    return Array.isArray(r.invocation) && Array.isArray(r.args) && typeof r.log === 'string'
      ? r
      : undefined;
  } catch {
    return undefined;
  }
}
