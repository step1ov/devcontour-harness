import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  API_VERSION,
  HarnessError,
  STATE_VERSION,
  SUPPORTED_STATE_VERSIONS,
  WORKSPACE_OWNER,
  executionDocumentSchema,
  localSchemas,
  runEventSchema,
  type ExecutionDocument,
  type ExecutionStore,
  type ExecutionTransaction,
  type ExecutionView,
  type LocalNamespace,
  type LocalValue,
  type NotPromise,
  type RunEvent,
  type RunEventDraft,
  type TransactionKind,
} from '../contracts/index.ts';
import { DocumentView, emptyDocument } from './document.ts';

/** Сколько событий одной транзакции допускается (договор курсора адаптеров). */
const MAX_EVENTS_PER_TRANSACTION = 1024;

interface Frame {
  doc: ExecutionDocument;
  drafts: RunEventDraft[];
  depth: number;
}

/**
 * Standalone ExecutionStore: нейтральный документ, события и локальные
 * записи в одной SQLite. Транзакция — `BEGIN IMMEDIATE` (вложенная —
 * SAVEPOINT); документ читается один раз на внешнюю транзакцию, вложенные
 * работают с ним же и при отказе восстанавливают его снимок и свой буфер
 * событий. Документ проверяется схемой при каждой фиксации: состояние вне
 * договора не записывается.
 *
 * Версия: в `meta` записаны версия формата и версия писателя. Неизвестная
 * версия формата отклоняется при открытии, до любой записи.
 */
export class SqliteExecutionStore implements ExecutionStore {
  readonly stateVersion = STATE_VERSION;
  private db: DatabaseSync;
  private frame?: Frame;
  private savepoint = 0;

  constructor(
    readonly file: string,
    readonly writer: string,
  ) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=20000; PRAGMA synchronous=FULL;');
    try {
      const meta = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
        .get();
      if (meta) {
        const row = this.db.prepare("SELECT value FROM meta WHERE key='stateVersion'").get() as
          { value: string } | undefined;
        const version = Number(row?.value);
        if (!(SUPPORTED_STATE_VERSIONS as readonly number[]).includes(version))
          throw new HarnessError(
            'STATE_VERSION_UNSUPPORTED',
            `Формат состояния ${row?.value ?? 'неизвестен'} не поддерживается этой версией (${SUPPORTED_STATE_VERSIONS.join(', ')})`,
          );
      } else if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length)
        throw new HarnessError(
          'STATE_VERSION_UNSUPPORTED',
          'Файл содержит чужую базу, а не состояние harness',
        );
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local (namespace TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(namespace, owner, key));`);
      this.db
        .prepare("INSERT OR IGNORE INTO meta VALUES('stateVersion', ?)")
        .run(String(STATE_VERSION));
      this.db.prepare("INSERT OR REPLACE INTO meta VALUES('writer', ?)").run(writer);
      this.db
        .prepare('INSERT OR IGNORE INTO state VALUES(1, ?)')
        .run(JSON.stringify(emptyDocument()));
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  private load(): ExecutionDocument {
    const row = this.db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string };
    return executionDocumentSchema.parse(JSON.parse(row.data));
  }

  read<T>(fn: (view: ExecutionView) => NotPromise<T>): T {
    if (this.frame) return fn(this.view(this.frame));
    this.db.exec('BEGIN');
    try {
      const value = fn(this.view({ doc: this.load(), drafts: [], depth: 0 }));
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  transact<T>(kind: TransactionKind, fn: (tx: ExecutionTransaction) => NotPromise<T>): T {
    const outer = this.frame;
    const point = 'harness_' + ++this.savepoint;
    this.db.exec(outer ? `SAVEPOINT ${point}` : 'BEGIN IMMEDIATE');
    const frame: Frame = outer ?? { doc: this.load(), drafts: [], depth: 0 };
    const saved = outer ? structuredClone(frame.doc) : undefined;
    const drafts = frame.drafts.length;
    frame.depth++;
    this.frame = frame;
    try {
      const value = fn(this.view(frame));
      if (value && typeof (value as { then?: unknown }).then === 'function')
        throw new Error('ExecutionStore.transact: внутри транзакции нельзя ждать внешней работы');
      if (outer) {
        this.db.exec(`RELEASE ${point}`);
      } else {
        if (frame.drafts.length > MAX_EVENTS_PER_TRANSACTION)
          throw new Error('Слишком много событий в одной транзакции');
        frame.doc.sequence++;
        const doc = executionDocumentSchema.parse(frame.doc);
        this.db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(doc));
        if (kind !== 'heartbeat') this.writeEvents(frame.drafts);
        this.db.exec('COMMIT');
      }
      return value;
    } catch (error) {
      if (outer) {
        this.db.exec(`ROLLBACK TO ${point}; RELEASE ${point}`);
        for (const key of Object.keys(frame.doc))
          delete (frame.doc as Record<string, unknown>)[key];
        Object.assign(frame.doc, saved);
        frame.drafts.length = drafts;
      } else this.db.exec('ROLLBACK');
      throw error;
    } finally {
      frame.depth--;
      this.frame = outer;
    }
  }

  private writeEvents(drafts: RunEventDraft[]) {
    const insert = this.db.prepare('INSERT INTO events(data) VALUES(?)');
    const at = new Date().toISOString();
    for (const draft of drafts) {
      const result = insert.run('{}');
      const seq = Number(result.lastInsertRowid);
      const event = runEventSchema.parse({ apiVersion: API_VERSION, seq, at, ...draft });
      this.db.prepare('UPDATE events SET data=? WHERE seq=?').run(JSON.stringify(event), seq);
    }
  }

  events(after = 0, limit = 500): RunEvent[] {
    const rows = this.db
      .prepare('SELECT data FROM events WHERE seq>? ORDER BY seq LIMIT ?')
      .all(after, Math.min(Math.max(limit, 1), 500)) as { data: string }[];
    return rows.map((r) => runEventSchema.parse(JSON.parse(r.data)) as RunEvent);
  }

  close() {
    this.db.close();
  }

  private view(frame: Frame): ExecutionTransaction {
    const doc = new DocumentView(frame.doc);
    const db = this.db;
    const inTx = () => this.frame === frame;
    return {
      control: () => doc.control(),
      controller: () => doc.controller(),
      graph: (id) => doc.graph(id),
      graphs: () => doc.graphs(),
      work: (id) => doc.work(id),
      works: (graphId) => doc.works(graphId),
      attempt: (id) => doc.attempt(id),
      attempts: (workId) => doc.attempts(workId),
      verification: (id) => doc.verification(id),
      verifications: () => doc.verifications(),
      local<N extends LocalNamespace>(namespace: N, owner: string, key: string) {
        const row = db
          .prepare('SELECT data FROM local WHERE namespace=? AND owner=? AND key=?')
          .get(namespace, owner, key) as { data: string } | undefined;
        return row
          ? (localSchemas[namespace].parse(JSON.parse(row.data)) as LocalValue<N>)
          : undefined;
      },
      locals<N extends LocalNamespace>(namespace: N, owner?: string) {
        const rows = (
          owner === undefined
            ? db
                .prepare('SELECT owner,key,data FROM local WHERE namespace=? ORDER BY owner,key')
                .all(namespace)
            : db
                .prepare(
                  'SELECT owner,key,data FROM local WHERE namespace=? AND owner=? ORDER BY key',
                )
                .all(namespace, owner)
        ) as { owner: string; key: string; data: string }[];
        return rows.map((r) => ({
          owner: r.owner,
          key: r.key,
          value: localSchemas[namespace].parse(JSON.parse(r.data)) as LocalValue<N>,
        }));
      },
      putGraph: (g) => doc.putGraph(g),
      putWork: (w) => doc.putWork(w),
      putAttempt: (a) => doc.putAttempt(a),
      putVerification: (v) => doc.putVerification(v),
      setControl: (c) => doc.setControl(c),
      setController: (l) => doc.setController(l),
      putLocal<N extends LocalNamespace>(
        namespace: N,
        owner: string,
        key: string,
        value: LocalValue<N>,
      ) {
        if (!inTx()) throw new Error('Локальная запись вне транзакции');
        const parsed = localSchemas[namespace].parse(value);
        db.prepare('INSERT OR REPLACE INTO local VALUES(?,?,?,?)').run(
          namespace,
          owner || WORKSPACE_OWNER,
          key,
          JSON.stringify(parsed),
        );
      },
      emit(event) {
        if (!inTx()) throw new Error('Событие вне транзакции');
        frame.drafts.push(event);
      },
    };
  }
}
