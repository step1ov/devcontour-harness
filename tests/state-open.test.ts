import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { doctor } from '../src/control/doctor.ts';
import { HarnessError } from '../src/contracts/index.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { engineOf, graphOf, ready } from './engine-fixture.ts';

// Снимок после закрытия всех соединений: каждая таблица целиком и байты файла.
function snapshot(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    const rows = Object.fromEntries(
      tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY 1`).all()]),
    );
    return {
      rows,
      sha: createHash('sha256').update(readFileSync(file)).digest('hex'),
    };
  } finally {
    db.close();
  }
}

function patch(file: string, fn: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(file);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function stateFile() {
  const { engine, store, dir } = engineOf();
  ready(engine, graphOf({ a: [] }));
  assert.equal(engine.lead('c1'), true);
  assert.ok(engine.claim('c1'));
  store.close();
  return { dir, file: join(dir, 'state.sqlite') };
}

const unsupported = (error: unknown) =>
  error instanceof HarnessError && error.code === 'STATE_VERSION_UNSUPPORTED';

test('S4-R1-01: несовместимое состояние отклоняется до записи — таблицы, автор и байты файла прежние', async () => {
  const { dir, file } = stateFile();
  patch(file, (db) => {
    db.prepare("UPDATE meta SET value='devcontour-harness@9.9.9-future' WHERE key='writer'").run();
    const doc = JSON.parse(
      (db.prepare('SELECT data FROM state').get() as { data: string }).data,
    ) as { controller: Record<string, unknown> };
    doc.controller = { ...doc.controller, futureField: true };
    db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(doc));
  });
  const before = snapshot(file);
  assert.throws(() => new SqliteExecutionStore(file, 'writer-now'), unsupported);
  assert.deepEqual(snapshot(file), before, 'открытие на запись изменило несовместимое состояние');
  const report = await doctor(undefined, {}, dir);
  assert.equal(report.state?.compatible, false);
  assert.deepEqual(snapshot(file), before, 'doctor изменил несовместимое состояние');
});

test('S4-R1-01: неизвестная stateVersion отклоняется без смены journal mode и без записи', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-state-open-'));
  const file = join(dir, 'state.sqlite');
  patch(file, (db) => {
    db.exec(`PRAGMA journal_mode=DELETE;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES('stateVersion','999'), ('writer','devcontour-harness@9.9.9');`);
  });
  const before = snapshot(file);
  const mode = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    } finally {
      db.close();
    }
  };
  assert.equal(mode(), 'delete');
  assert.throws(() => new SqliteExecutionStore(file, 'writer-now'), unsupported);
  assert.equal((await doctor(undefined, {}, dir)).state?.compatible, false);
  assert.equal(mode(), 'delete', 'отказ перевёл базу в WAL');
  assert.deepEqual(snapshot(file), before);
});

test('S4-R1-01: doctor совместимого состояния не переписывает автора и данные', async () => {
  const { dir, file } = stateFile();
  patch(file, (db) =>
    db.prepare("UPDATE meta SET value='devcontour-harness@0.1.0-alpha.1' WHERE key='writer'").run(),
  );
  const before = snapshot(file);
  const report = await doctor(undefined, {}, dir);
  assert.equal(report.state?.compatible, true);
  assert.deepEqual(snapshot(file), before, 'doctor стал писателем состояния');
});

test('S4-R1-01: повторный отказ транзакции над испорченным документом не оставляет BEGIN', () => {
  const { file } = stateFile();
  const store = new SqliteExecutionStore(file, 'test');
  try {
    patch(file, (db) => {
      const doc = JSON.parse(
        (db.prepare('SELECT data FROM state').get() as { data: string }).data,
      ) as Record<string, unknown>;
      db.prepare('UPDATE state SET data=? WHERE id=1').run(
        JSON.stringify({ ...doc, futureField: 1 }),
      );
    });
    for (let i = 0; i < 2; i++) {
      assert.throws(() => store.transact('heartbeat', () => undefined), unsupported);
      assert.throws(() => store.read(() => undefined), unsupported);
    }
  } finally {
    store.close();
  }
});
