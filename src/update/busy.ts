import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processStartedAt } from '../environment/live-calls.ts';
import { updatesDir } from './check.ts';

/**
 * Идёт ли обновление пакетов этого каталога состояния — чтение замков и
 * записи «идёт» без загрузки установщика: им пользуются CLI (список команд
 * чтения) и библиотека (`Harness` передаёт это движку, и записи библиотеки
 * отказывают так же, как команды CLI).
 */

export function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export interface LockBody {
  pid?: number;
  startedAt?: number;
  at?: string;
}
/** Держатель замка жив: тот же pid и тот же момент старта процесса. */
export const holds = (held: LockBody | undefined) =>
  held?.pid !== undefined &&
  alive(held.pid) &&
  (held.startedAt === undefined || processStartedAt(held.pid) === held.startedAt);

/** Запись «обновление или откат идёт» прерванного обновления ждёт возврата. */
export const restorePending = (stateDir: string) =>
  readJsonFile(join(updatesDir(stateDir), 'in-progress.json')) !== undefined;

/**
 * Идёт или прервано обновление этого каталога состояния: живой держатель
 * замка или запись «идёт». Команды, которые пишут состояние или запускают
 * проверки без роли controller (`gates`, `smoke`, `review-code`, ревью плана),
 * в это время отказывают.
 */
export function updateInProgress(stateDir: string, prefix?: string): string | undefined {
  const held = readJsonFile<LockBody>(join(updatesDir(stateDir), 'lock'));
  if (holds(held)) return `идёт harness update (процесс ${held!.pid})`;
  // Общий каталог установки обновляет другой каталог состояния: пакеты меняются.
  const pre = prefix ? readJsonFile<LockBody>(join(prefix, '.harness-update.lock')) : undefined;
  if (holds(pre)) return `идёт harness update пакетов в ${prefix} (процесс ${pre!.pid})`;
  if (restorePending(stateDir))
    return 'прерванное обновление ждёт возврата: harness update --check';
  return undefined;
}

/**
 * Замок обновления остался от процесса, которого больше нет (или pid достался
 * другому процессу), и незавершённого возврата нет: обновление умерло до
 * изменений (например, во время `--wait`). Его пауза устарела.
 */
export function deadUpdateLock(stateDir: string): { pid: number } | undefined {
  const held = readJsonFile<LockBody>(join(updatesDir(stateDir), 'lock'));
  if (held?.pid === undefined || holds(held) || restorePending(stateDir)) return undefined;
  return { pid: held.pid };
}
