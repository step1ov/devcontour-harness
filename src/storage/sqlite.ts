import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  API_VERSION,
  HarnessError,
  STATE_VERSION,
  SUPPORTED_STATE_VERSIONS,
  WORKSPACE_OWNER,
  executionDocumentSchema,
  localSchemas,
  readRunEvent,
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

/**
 * Строгая схема: поле, которого эта версия не знает (например, записанное
 * более новой версией), — отказ до любой записи и выдачи, а не молчаливая
 * потеря при перезаписи документа.
 */
function parseDocument(data: string): ExecutionDocument {
  const parsed = executionDocumentSchema.safeParse(JSON.parse(data));
  if (!parsed.success)
    throw new HarnessError(
      'STATE_VERSION_UNSUPPORTED',
      'Состояние не соответствует формату этой версии пакета (возможно, его записала более новая версия): обновите пакет или восстановите согласованную копию',
      parsed.error.issues.slice(0, 20).map((i) => ({
        path: i.path.filter((k): k is string | number => typeof k !== 'symbol'),
        message: i.message,
      })),
    );
  return parsed.data;
}

/**
 * Открытие только для чтения. Обычное — с блокировками SQLite и чтением
 * `-wal`: читатель видит новые фиксации, но WAL-база без `-wal`/`-shm`
 * получает их пустыми служебными файлами (данных в них нет). Неизменяемое
 * (`immutable`) не создаёт файлов и не берёт блокировок — годится только
 * для однократного чтения с проверкой после него (`readOnce`): долгоживущий
 * дескриптор так не увидел бы новых фиксаций, а начавший работу писатель
 * мог бы дать рваное чтение.
 */
function openReadOnly(file: string, immutable = false) {
  if (!immutable) return new DatabaseSync(file, { readOnly: true });
  const url = pathToFileURL(file);
  url.searchParams.set('mode', 'ro');
  url.searchParams.set('immutable', '1');
  return new DatabaseSync(url, { readOnly: true });
}

/** Отпечаток файлов базы: размер и время основного файла, наличие журналов. */
function fileMark(file: string) {
  const main = statSync(file, { throwIfNoEntry: false });
  return JSON.stringify([
    main?.size ?? null,
    main?.mtimeMs ?? null,
    existsSync(file + '-wal'),
    existsSync(file + '-journal'),
  ]);
}

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
  private db!: DatabaseSync;
  private frame?: Frame;
  private savepoint = 0;

  constructor(
    readonly file: string,
    readonly writer: string,
    readonly options: {
      readOnly?: boolean;
      /**
       * Только с `readOnly`: неизменяемое открытие без файлов и блокировок —
       * для однократного чтения через `SqliteExecutionStore.readOnce`.
       */
      immutable?: boolean;
    } = {},
  ) {
    // Существующее состояние сначала проверяется целиком через отдельное
    // соединение только для чтения: версия формата и документ строгой схемой.
    // Несовместимый вход отклоняется до DDL, записи автора и смены journal
    // mode — файл остаётся байт в байт прежним.
    const existing = file !== ':memory:' && existsSync(file) && statSync(file).size > 0;
    const immutable = Boolean(options.readOnly && options.immutable);
    if (existing) SqliteExecutionStore.preflight(file, immutable);
    else if (options.readOnly)
      throw new HarnessError('STATE_VERSION_UNSUPPORTED', 'Состояние не найдено');
    if (options.readOnly) {
      // Диагностическое открытие: ни автор, ни PRAGMA, ни схема не меняются.
      this.db = openReadOnly(file, immutable);
      this.db.exec('PRAGMA busy_timeout=20000;');
      return;
    }
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=20000; PRAGMA synchronous=FULL;');
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

  /**
   * Однократное чтение без единого файла в каталоге состояния (`report`).
   * Если журнала (`-wal`, `-journal`) нет, база открывается неизменяемой;
   * после чтения проверяется, что журнал не появился, а размер и время
   * основного файла прежние. Иначе (писатель начал работу или журнал уже
   * был) чтение повторяется обычным открытием только для чтения — с его
   * служебными `-wal`/`-shm`, но согласованное.
   */
  static readOnce<T>(file: string, writer: string, fn: (store: SqliteExecutionStore) => T): T {
    const once = (immutable: boolean) => {
      const store = new SqliteExecutionStore(file, writer, { readOnly: true, immutable });
      try {
        return fn(store);
      } finally {
        store.close();
      }
    };
    const before = fileMark(file);
    if (!existsSync(file + '-wal') && !existsSync(file + '-journal')) {
      const result = once(true);
      if (fileMark(file) === before) return result;
    }
    return once(false);
  }

  /** Проверка существующего файла без единой записи; отказ — HarnessError. */
  private static preflight(file: string, immutable = false) {
    const db = openReadOnly(file, immutable);
    try {
      db.exec('PRAGMA busy_timeout=20000;');
      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
            name: string;
          }[]
        ).map((t) => t.name),
      );
      if (!tables.has('meta')) {
        if (tables.size)
          throw new HarnessError(
            'STATE_VERSION_UNSUPPORTED',
            'Файл содержит чужую базу, а не состояние harness',
          );
        return;
      }
      const row = db.prepare("SELECT value FROM meta WHERE key='stateVersion'").get() as
        { value: string } | undefined;
      const version = Number(row?.value);
      if (!(SUPPORTED_STATE_VERSIONS as readonly number[]).includes(version))
        throw new HarnessError(
          'STATE_VERSION_UNSUPPORTED',
          `Формат состояния ${row?.value ?? 'неизвестен'} не поддерживается этой версией (${SUPPORTED_STATE_VERSIONS.join(', ')})`,
        );
      if (tables.has('state')) {
        const state = db.prepare('SELECT data FROM state WHERE id=1').get() as
          { data: string } | undefined;
        if (state) parseDocument(state.data);
      }
    } finally {
      db.close();
    }
  }

  private load(): ExecutionDocument {
    const row = this.db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string };
    return parseDocument(row.data);
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
    if (this.options.readOnly)
      throw new HarnessError('STATE_VERSION_UNSUPPORTED', 'Состояние открыто только для чтения');
    const outer = this.frame;
    const point = 'harness_' + ++this.savepoint;
    this.db.exec(outer ? `SAVEPOINT ${point}` : 'BEGIN IMMEDIATE');
    let loaded: ExecutionDocument | undefined;
    try {
      if (!outer) loaded = this.load();
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const frame: Frame = outer ?? { doc: loaded!, drafts: [], depth: 0 };
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
    return rows.map((r) => readRunEvent(JSON.parse(r.data)));
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
