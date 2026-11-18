import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Область аренды ресурсов (`withResources`): база блокировок машины, владелец
 * аренды и порты, которые попытка держит. Команды внутри области записывают
 * пережившие остановку процессы (`ReapFailure.survivors`) в ту же базу, а
 * проверка портов перед фазой (`port-probe.ts`) узнаёт по этой записи
 * процесс прежней попытки, занявший порт.
 */
export interface LeaseScope {
  database: string;
  owner: string;
  ports: { id: string; port: number }[];
  /** Внутри окружения фазы (`withEnvironment`): его службы законно держат порты. */
  environment?: boolean;
}
export const leaseScope = new AsyncLocalStorage<LeaseScope>();

/** Сколько хранится запись о пережившем процессе. */
const SURVIVOR_TTL_MS = 7 * 24 * 3600 * 1000;

export interface SurvivorRecord {
  pid: number;
  /** Время старта процесса (`ps -o lstart=`): защищает от переиспользования PID. */
  start: string;
  owner: string;
  /** Команда, чьим потомком он был. */
  label: string;
  at: number;
}

function open(database: string) {
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  db.exec(
    'PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS survivors (pid INTEGER NOT NULL, start TEXT NOT NULL, owner TEXT NOT NULL, label TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (pid, start))',
  );
  return db;
}

/**
 * Записать процессы, пережившие остановку сдерживаемой команды. Только с
 * известным временем старта: по одному PID чужой процесс, получивший его
 * позже, был бы принят за переживший. Отказ записи не роняет команду — её
 * отказ (`ReapFailure`) важнее; без записи порт, занятый таким процессом,
 * станет отказом `resource-busy`, а не будет освобождён.
 */
export function recordSurvivors(
  scope: Pick<LeaseScope, 'database' | 'owner'> | undefined,
  survivors: { pid: number; start: string }[],
  label: string,
) {
  if (!scope || !survivors.length) return;
  try {
    const db = open(scope.database);
    try {
      const insert = db.prepare('INSERT OR REPLACE INTO survivors VALUES (?,?,?,?,?)');
      const now = Date.now();
      for (const s of survivors) insert.run(s.pid, s.start, scope.owner, label.slice(0, 300), now);
      db.prepare('DELETE FROM survivors WHERE at<?').run(now - SURVIVOR_TTL_MS);
    } finally {
      db.close();
    }
  } catch {
    /* запись — лучшая попытка; см. выше */
  }
}

/** Записанные пережившие процессы (без устаревших). */
export function survivorRecords(database: string): SurvivorRecord[] {
  const db = open(database);
  try {
    return db
      .prepare('SELECT * FROM survivors WHERE at>=?')
      .all(Date.now() - SURVIVOR_TTL_MS) as unknown as SurvivorRecord[];
  } finally {
    db.close();
  }
}

/** Снять записи остановленных процессов. */
export function forgetSurvivors(database: string, list: { pid: number; start: string }[]) {
  if (!list.length) return;
  const db = open(database);
  try {
    const remove = db.prepare('DELETE FROM survivors WHERE pid=? AND start=?');
    for (const s of list) remove.run(s.pid, s.start);
  } finally {
    db.close();
  }
}
