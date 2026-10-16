import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '../src/contracts/index.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { executionStoreContract } from '../src/testing/index.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'harness-store-'));
executionStoreContract(
  'standalone SQLite',
  test,
  (dir) => new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test'),
  temp,
);

test('Неизвестная версия формата и чужая база отклоняются при открытии, без записи', () => {
  const dir = temp();
  const file = join(dir, 'state.sqlite');
  new SqliteExecutionStore(file, 'test').close();
  const db = new DatabaseSync(file);
  db.prepare("UPDATE meta SET value='99' WHERE key='stateVersion'").run();
  const before = (db.prepare('SELECT data FROM state').get() as { data: string }).data;
  db.close();
  assert.throws(
    () => new SqliteExecutionStore(file, 'test'),
    (e: unknown) => e instanceof HarnessError && e.code === 'STATE_VERSION_UNSUPPORTED',
  );
  const after = new DatabaseSync(file);
  assert.equal((after.prepare('SELECT data FROM state').get() as { data: string }).data, before);
  assert.equal(
    (after.prepare("SELECT value FROM meta WHERE key='writer'").get() as { value: string }).value,
    'test',
  );
  after.close();

  const foreign = join(dir, 'foreign.sqlite');
  const other = new DatabaseSync(foreign);
  other.exec('CREATE TABLE state (id INTEGER, data TEXT)');
  other.close();
  assert.throws(
    () => new SqliteExecutionStore(foreign, 'test'),
    (e: unknown) => e instanceof HarnessError && e.code === 'STATE_VERSION_UNSUPPORTED',
  );
  writeFileSync(join(dir, 'garbage.sqlite'), 'not a database');
  assert.throws(() => new SqliteExecutionStore(join(dir, 'garbage.sqlite'), 'test'));
});
