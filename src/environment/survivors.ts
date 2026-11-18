import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { osBootId } from './os-tools.ts';

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
  /** Машина и загрузка ОС записи: PID и время старта сравнимы только в них. */
  host: string;
  boot: string;
}

/** Машина и загрузка ОС этого процесса (база может лежать в общем HOME). */
const here = () => ({ host: hostname(), boot: osBootId() ?? '' });

function open(database: string, busyMs = 5000) {
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  db.exec(
    `PRAGMA busy_timeout=${busyMs}; CREATE TABLE IF NOT EXISTS survivors (pid INTEGER NOT NULL, start TEXT NOT NULL, host TEXT NOT NULL, boot TEXT NOT NULL, owner TEXT NOT NULL, label TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (pid, start, host, boot))`,
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
    // Запись — на пути завершения команды: занятая база не задерживает его
    // дольше короткого ожидания.
    const db = open(scope.database, 250);
    try {
      const insert = db.prepare(
        'INSERT OR REPLACE INTO survivors (pid, start, host, boot, owner, label, at) VALUES (?,?,?,?,?,?,?)',
      );
      const now = Date.now();
      const { host, boot } = here();
      for (const s of survivors)
        insert.run(s.pid, s.start, host, boot, scope.owner, label.slice(0, 300), now);
      db.prepare('DELETE FROM survivors WHERE at<?').run(now - SURVIVOR_TTL_MS);
    } finally {
      db.close();
    }
  } catch {
    /* запись — лучшая попытка; см. выше */
  }
}

/**
 * Записанные пережившие процессы этой машины и этой загрузки ОС (без
 * устаревших). Владелец записи (`<каталог состояния>:<попытка>`) не
 * фильтруется: аренда порта общая для всех контуров машины, и процесс,
 * переживший остановку в любом из них, занимает порт вне аренды.
 */
export function survivorRecords(database: string): SurvivorRecord[] {
  const db = open(database);
  const { host, boot } = here();
  try {
    return db
      .prepare('SELECT * FROM survivors WHERE at>=? AND host=? AND boot=?')
      .all(Date.now() - SURVIVOR_TTL_MS, host, boot) as unknown as SurvivorRecord[];
  } finally {
    db.close();
  }
}

/** Снять записи остановленных процессов. */
export function forgetSurvivors(database: string, list: { pid: number; start: string }[]) {
  if (!list.length) return;
  const db = open(database);
  try {
    const { host, boot } = here();
    const remove = db.prepare(
      'DELETE FROM survivors WHERE pid=? AND start=? AND host=? AND boot=?',
    );
    for (const s of list) remove.run(s.pid, s.start, host, boot);
  } finally {
    db.close();
  }
}
