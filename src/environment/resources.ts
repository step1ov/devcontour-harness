import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { digestOf, type ExecutionPolicy } from '../contracts/index.ts';
import { CleanupFailure, processAlive } from './lifecycle.ts';

type Resource = ExecutionPolicy['resources'][number];
const digest = digestOf;

export const resourceKey = (r: Resource) =>
  digest({
    kind: r.kind,
    value:
      r.kind === 'port'
        ? String(Number(r.value))
        : r.kind === 'device'
          ? r.value.toLowerCase()
          : r.value,
  });
/**
 * База блокировок ресурсов машины. Общая с DevContour (`~/.devcontour-local/
 * resources.sqlite`): устройство или порт исключительны для всех контуров
 * одной машины, а не для одного каталога состояния.
 */
export const defaultResourceDatabase = () =>
  join(homedir(), '.devcontour-local', 'resources.sqlite');
type LeaseRow = {
  key: string;
  resource: string;
  owner: string;
  token: string;
  pid: number;
  expires: number;
};
export class ResourcePool {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, resource TEXT NOT NULL, owner TEXT NOT NULL, token TEXT NOT NULL, pid INTEGER NOT NULL, expires INTEGER NOT NULL)',
    );
  }
  list() {
    return this.db.prepare('SELECT * FROM leases').all() as LeaseRow[];
  }
  tryAcquire(resources: Resource[], owner: string, token: string, ttl: number) {
    const unique = [...new Map(resources.map((r) => [resourceKey(r), r])).entries()];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Never steal on TTL alone: the old process or its detached driver can still use a device.
      if (unique.some(([key]) => this.db.prepare('SELECT key FROM leases WHERE key=?').get(key))) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const insert = this.db.prepare('INSERT INTO leases VALUES (?,?,?,?,?,?)');
      for (const [key, resource] of unique)
        insert.run(key, JSON.stringify(resource), owner, token, process.pid, Date.now() + ttl);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  heartbeat(token: string, count: number, ttl: number) {
    const updated = this.db
      .prepare('UPDATE leases SET expires=? WHERE token=? AND expires>?')
      .run(Date.now() + ttl, token, Date.now());
    if (Number(updated.changes) !== count) throw new Error('Утрачена аренда тестовых ресурсов');
  }
  release(token: string) {
    this.db.prepare('DELETE FROM leases WHERE token=?').run(token);
  }
  clearAbandoned(key: string, token: string) {
    const lease = this.db
      .prepare('SELECT * FROM leases WHERE key=? AND token=?')
      .get(key, token) as LeaseRow | undefined;
    if (!lease) throw new Error('Аренда изменилась; перечитайте resources');
    if (processAlive(lease.pid)) throw new Error('Владелец ресурса ещё работает');
    this.db.prepare('DELETE FROM leases WHERE key=? AND token=?').run(key, token);
  }
  /**
   * Digest манифеста seed зависимостей (`verification/dependency-store.ts`).
   * Лежит здесь, а не рядом с seed: подмена seed вместе с его манифестом не
   * совпадёт с записью, а песочнице база на запись закрыта.
   */
  seedPin(root: string, key: string) {
    this.seedPins();
    const row = this.db
      .prepare('SELECT digest FROM seed_pins WHERE root=? AND key=?')
      .get(root, key) as { digest: string } | undefined;
    return row?.digest;
  }
  setSeedPin(root: string, key: string, digest: string | undefined) {
    this.seedPins();
    if (digest === undefined)
      this.db.prepare('DELETE FROM seed_pins WHERE root=? AND key=?').run(root, key);
    else this.db.prepare('INSERT OR REPLACE INTO seed_pins VALUES (?,?,?)').run(root, key, digest);
  }
  // Таблица создаётся при первом обращении: база установок без хранилища не меняется.
  private seedPins() {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS seed_pins (root TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (root, key))',
    );
  }
  close() {
    this.db.close();
  }
}
export async function withResources<T>(
  config: Pick<ExecutionPolicy, 'resources' | 'leaseMs'> & { resourceDatabase: string },
  ids: string[],
  owner: string,
  signal: AbortSignal,
  work: (signal: AbortSignal, resources: Resource[]) => Promise<T>,
): Promise<T> {
  for (const id of ids)
    if (!config.resources.some((r) => r.id === id)) throw new Error('Неизвестный ресурс: ' + id);
  const resources = config.resources.filter((r) => ids.includes(r.id));
  if (!resources.length) return work(signal, []);
  const pool = new ResourcePool(config.resourceDatabase),
    token = randomUUID();
  const controller = new AbortController(),
    combined = AbortSignal.any([signal, controller.signal]);
  let heartbeat: NodeJS.Timeout | undefined,
    acquired = false,
    preserve = false;
  try {
    while (!acquired) {
      combined.throwIfAborted();
      acquired = pool.tryAcquire(resources, owner, token, config.leaseMs);
      if (!acquired) await delay(150, undefined, { signal: combined });
    }
    const count = new Set(resources.map(resourceKey)).size;
    heartbeat = setInterval(
      () => {
        try {
          pool.heartbeat(token, count, config.leaseMs);
        } catch (error) {
          controller.abort(error);
        }
      },
      Math.max(1000, config.leaseMs / 3),
    );
    const result = await work(combined, resources);
    combined.throwIfAborted();
    pool.heartbeat(token, count, config.leaseMs);
    return result;
  } catch (error) {
    preserve = error instanceof CleanupFailure;
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (acquired && !preserve) pool.release(token);
    pool.close();
  }
}
