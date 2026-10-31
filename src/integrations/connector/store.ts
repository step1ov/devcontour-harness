import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessError } from '../../contracts/index.ts';
import type { ProviderId } from './transport.ts';

/**
 * Служебная запись коннектора — отдельная SQLite
 * `<stateDir>/connectors/<provider>-<hash(projectId)>.sqlite`. Это не
 * состояние исполнения (оно остаётся в `state.sqlite` harness): здесь только
 * минимальные данные восстановления — снимки (manifest и digest), операции
 * доставки (intent, шаги, receipt), владение доставкой (lease) и связи с
 * историей backend.
 *
 * Каждая запись — отдельная транзакция `BEGIN IMMEDIATE` без сети и `await`
 * внутри. Записи операции, начиная с владения, проверяют lease в той же
 * транзакции: процесс, потерявший владение, ничего не записывает.
 */

const SCHEMA_VERSION = '1';

export type StepStatus = 'planned' | 'sending' | 'done' | 'skipped' | 'conflict' | 'uncertain';

/** Шаг доставки или истории: внешний вызов с маркером и его подтверждённый итог. */
export interface StepRecord {
  n: number;
  kind:
    | 'comment'
    | 'historical-comment'
    | 'criterion'
    | 'move'
    | 'history'
    | 'session.start'
    | 'session.intent'
    | 'session.fork'
    | 'session.attach'
    | 'session.checkpoint'
    | 'session.finish';
  status: StepStatus;
  marker: string;
  /** Параметры шага, закреплённые при планировании (критерий, колонка, выход истории). */
  input: Record<string, unknown>;
  /** Подтверждённый итог (ID комментария, новая ревизия, ID сессии). */
  result?: Record<string, unknown>;
  reason?: string;
  /** Сколько раз шаг отправлялся (вне `planned`); не повод для повтора. */
  sends: number;
  updatedAt: string;
}

export type OperationStatus =
  'intent' | 'in-progress' | 'delivered' | 'conflict' | 'uncertain' | 'failed';

export interface OperationRecord {
  key: string;
  provider: ProviderId;
  projectId: string;
  workId: string;
  runId: string;
  taskId: string;
  resultDigest: string;
  /** Редакция (semantic digest) постановки, к которой относится результат. */
  revision: string;
  outcome: string;
  status: OperationStatus;
  steps: StepRecord[];
  /** Шаги спланированы (после предварительной сверки, до первой мутации). */
  planned: boolean;
  reason?: string;
  /** Текущая редакция источника при конфликте. */
  currentRevision?: string;
  receipt?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LeaseRecord {
  key: string;
  token: string;
  owner: string;
  expiresAt: number;
  fence: number;
}

export interface SnapshotRecord {
  revision: string;
  graphId: string;
  graph: unknown;
  context: unknown;
  manifest: unknown;
  createdAt: string;
}

/** Доверенный receipt доставки принятого результата: основание предпосылки зависимой задачи. */
export interface ReceiptRecord {
  issuer: string;
  orderId: string;
  taskId: string;
  repositoryId: string;
  resultSha: string;
  workId: string;
  runId: string;
  operation: string;
}

export class LeaseLost extends HarnessError {
  constructor(key: string) {
    super('LEASE_STALE', 'Владение доставкой утрачено: ' + key.slice(0, 16));
  }
}

const now = () => new Date().toISOString();

export class ConnectorStore {
  private readonly db: DatabaseSync;

  /**
   * `onWrite` — точка отказа для тестов: вызывается перед каждой записью с её
   * названием и может бросить исключение (запись не выполняется).
   */
  constructor(
    readonly file: string,
    readonly identity: { provider: ProviderId; projectId: string },
    readonly options: { readOnly?: boolean; onWrite?: (what: string) => void } = {},
  ) {
    if (options.readOnly) {
      if (!existsSync(file)) throw new HarnessError('NOT_FOUND', 'Состояние коннектора не найдено');
      this.db = new DatabaseSync(file, { readOnly: true });
      this.db.exec('PRAGMA busy_timeout=20000;');
      this.checkIdentity();
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=20000; PRAGMA synchronous=FULL;');
    this.tx(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS snapshots (revision TEXT PRIMARY KEY, graph_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, work_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, token TEXT NOT NULL, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, fence INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (operation TEXT PRIMARY KEY, order_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);`);
      const ins = this.db.prepare('INSERT OR IGNORE INTO meta VALUES(?, ?)');
      ins.run('schema', SCHEMA_VERSION);
      ins.run('provider', identity.provider);
      ins.run('projectId', identity.projectId);
    });
    this.checkIdentity();
  }

  private checkIdentity() {
    const get = (k: string) =>
      (
        this.db.prepare('SELECT value FROM meta WHERE key=?').get(k) as
          { value: string } | undefined
      )?.value;
    if (get('schema') !== SCHEMA_VERSION)
      throw new HarnessError(
        'STATE_VERSION_UNSUPPORTED',
        'Состояние коннектора другой версии: ' + String(get('schema')),
      );
    if (get('provider') !== this.identity.provider || get('projectId') !== this.identity.projectId)
      throw new HarnessError(
        'INVALID_INPUT',
        'Состояние коннектора принадлежит другому provider/проекту: ' + this.file,
      );
  }

  close() {
    this.db.close();
  }

  /** Синхронная транзакция записи; внутри нет сети, процессов и `await`. */
  private tx<T>(fn: () => T, what?: string): T {
    if (what) this.options.onWrite?.(what);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Снимки                                                            */
  /* ---------------------------------------------------------------- */

  putSnapshot(record: Omit<SnapshotRecord, 'createdAt'>) {
    return this.tx(() => {
      const prior = this.snapshot(record.revision);
      // Повтор той же редакции не меняет записанный снимок (и время его создания).
      // Возврат к прежней редакции снова делает её последней: иначе снимок,
      // совпавший со свежим чтением, не закрепить ничем, кроме новой правки.
      if (prior) {
        this.db
          .prepare(
            `UPDATE snapshots SET rowid=(SELECT max(rowid) + 1 FROM snapshots)
             WHERE revision=? AND rowid<(SELECT max(rowid) FROM snapshots)`,
          )
          .run(record.revision);
        return { record: prior, created: false };
      }
      const full = { ...record, createdAt: now() };
      this.db
        .prepare('INSERT INTO snapshots VALUES(?, ?, ?, ?)')
        .run(record.revision, record.graphId, JSON.stringify(full), full.createdAt);
      return { record: full, created: true };
    }, 'snapshot');
  }

  snapshot(revision: string): SnapshotRecord | undefined {
    const row = this.db.prepare('SELECT data FROM snapshots WHERE revision=?').get(revision) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as SnapshotRecord) : undefined;
  }

  /** Последний закреплённый снимок графа: порядок записи, а не время создания редакции. */
  latestSnapshot(graphId: string): SnapshotRecord | undefined {
    const row = this.db
      .prepare('SELECT data FROM snapshots WHERE graph_id=? ORDER BY rowid DESC LIMIT 1')
      .get(graphId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as SnapshotRecord) : undefined;
  }

  /** Последний закреплённый снимок любого графа этого коннектора. */
  latestSnapshotAny(): SnapshotRecord | undefined {
    const row = this.db.prepare('SELECT data FROM snapshots ORDER BY rowid DESC LIMIT 1').get() as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as SnapshotRecord) : undefined;
  }

  /* ---------------------------------------------------------------- */
  /* Владение доставкой                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Взять владение операцией. Действующий lease другого владельца — отказ
   * (`undefined` с текущим держателем); истёкший — перехват с новым токеном
   * и увеличенным fence. Intent операции при этом не теряется: он в
   * отдельной записи.
   */
  acquire(key: string, owner: string, ms: number): { lease?: LeaseRecord; holder?: LeaseRecord } {
    return this.tx(() => {
      const prior = this.lease(key);
      const at = Date.now();
      if (prior && prior.expiresAt > at) return { holder: prior };
      const lease: LeaseRecord = {
        key,
        token: randomUUID(),
        owner,
        expiresAt: at + ms,
        fence: (prior?.fence ?? 0) + 1,
      };
      this.db
        .prepare('INSERT OR REPLACE INTO leases VALUES(?, ?, ?, ?, ?)')
        .run(key, lease.token, owner, lease.expiresAt, lease.fence);
      return { lease };
    }, 'lease');
  }

  lease(key: string): LeaseRecord | undefined {
    const row = this.db.prepare('SELECT * FROM leases WHERE key=?').get(key) as
      { key: string; token: string; owner: string; expires_at: number; fence: number } | undefined;
    return row
      ? {
          key: row.key,
          token: row.token,
          owner: row.owner,
          expiresAt: row.expires_at,
          fence: row.fence,
        }
      : undefined;
  }

  private assertLease(key: string, token: string) {
    const lease = this.lease(key);
    if (!lease || lease.token !== token || lease.expiresAt <= Date.now()) throw new LeaseLost(key);
  }

  /** Продлить владение; утраченное — `LeaseLost`. */
  renew(key: string, token: string, ms: number) {
    this.tx(() => {
      this.assertLease(key, token);
      this.db
        .prepare('UPDATE leases SET expires_at=? WHERE key=? AND token=?')
        .run(Date.now() + ms, key, token);
    }, 'lease.renew');
  }

  release(key: string, token: string) {
    try {
      this.tx(() => {
        this.db.prepare('UPDATE leases SET expires_at=0 WHERE key=? AND token=?').run(key, token);
      });
    } catch {
      /* Невозможность освободить — lease истечёт сам. */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Операции доставки                                                 */
  /* ---------------------------------------------------------------- */

  operation(key: string): OperationRecord | undefined {
    const row = this.db.prepare('SELECT data FROM operations WHERE key=?').get(key) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as OperationRecord) : undefined;
  }

  operations(filter: { workId?: string; taskId?: string } = {}): OperationRecord[] {
    const rows = this.db
      .prepare(
        'SELECT data FROM operations WHERE (:w IS NULL OR work_id=:w) AND (:t IS NULL OR task_id=:t) ORDER BY rowid',
      )
      .all({ w: filter.workId ?? null, t: filter.taskId ?? null }) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as OperationRecord);
  }

  /** Записать intent до любого внешнего вызова; повтор существующего не меняет его. */
  putIntent(
    record: Omit<OperationRecord, 'createdAt' | 'updatedAt' | 'status' | 'steps' | 'planned'>,
    token: string,
  ): OperationRecord {
    return this.tx(() => {
      this.assertLease(record.key, token);
      const prior = this.operation(record.key);
      if (prior) return prior;
      const full: OperationRecord = {
        ...record,
        status: 'intent',
        steps: [],
        planned: false,
        createdAt: now(),
        updatedAt: now(),
      };
      this.writeOp(full);
      return full;
    }, 'intent');
  }

  /** Изменить операцию под владением `token` (fencing в той же транзакции). */
  updateOp(
    key: string,
    token: string,
    mutate: (op: OperationRecord) => OperationRecord,
    what = 'operation',
  ): OperationRecord {
    return this.tx(() => {
      this.assertLease(key, token);
      const prior = this.operation(key);
      if (!prior) throw new HarnessError('NOT_FOUND', 'Операция доставки не найдена');
      const next = { ...mutate(structuredClone(prior)), updatedAt: now() };
      this.writeOp(next);
      return next;
    }, what);
  }

  private writeOp(op: OperationRecord) {
    this.db
      .prepare('INSERT OR REPLACE INTO operations VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(op.key, op.workId, op.runId, op.taskId, op.status, JSON.stringify(op), op.updatedAt);
  }

  /* ---------------------------------------------------------------- */
  /* Доверенные receipts                                               */
  /* ---------------------------------------------------------------- */

  putReceipt(receipt: ReceiptRecord, token: string) {
    this.tx(() => {
      this.assertLease(receipt.operation, token);
      this.db
        .prepare('INSERT OR REPLACE INTO receipts VALUES(?, ?, ?)')
        .run(receipt.operation, receipt.orderId, JSON.stringify(receipt));
    }, 'receipt');
  }

  receipts(orderId?: string): ReceiptRecord[] {
    const rows = this.db
      .prepare('SELECT data FROM receipts WHERE (:o IS NULL OR order_id=:o) ORDER BY rowid')
      .all({ o: orderId ?? null }) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as ReceiptRecord);
  }

  /* ---------------------------------------------------------------- */
  /* История                                                           */
  /* ---------------------------------------------------------------- */

  history<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM history WHERE key=?').get(key) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  histories<T>(prefix: string): { key: string; value: T }[] {
    const rows = this.db
      .prepare('SELECT key, data FROM history WHERE substr(key, 1, length(:p)) = :p ORDER BY rowid')
      .all({ p: prefix }) as { key: string; data: string }[];
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.data) as T }));
  }

  /** Записать связь истории; `mutate` получает прежнее значение. */
  putHistory<T>(key: string, mutate: (prior: T | undefined) => T): T {
    return this.tx(() => {
      const next = mutate(this.history<T>(key));
      this.db
        .prepare('INSERT OR REPLACE INTO history VALUES(?, ?, ?)')
        .run(key, JSON.stringify(next), now());
      return next;
    }, 'history');
  }
}
