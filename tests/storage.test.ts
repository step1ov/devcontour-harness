import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  API_VERSION,
  HarnessError,
  eventsDataSchema,
  readRunEvent,
  readRunEventSchema,
  runEventSchema,
  type ExecutionStore,
} from '../src/contracts/index.ts';
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

test('Поле состояния, которого версия не знает, — отказ до записи и выдачи; транзакция не остаётся открытой', () => {
  const dir = temp();
  const file = join(dir, 'state.sqlite');
  new SqliteExecutionStore(file, 'test').close();
  const db = new DatabaseSync(file);
  const doc = JSON.parse(
    (db.prepare('SELECT data FROM state').get() as { data: string }).data,
  ) as Record<string, unknown>;
  // Роль controller более новой версии с полем, которого эта версия не знает.
  doc.controller = { owner: 'c1', leaseUntil: 1, engineVersion: 'x', futureField: true };
  db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(doc));
  const before = (db.prepare('SELECT data FROM state').get() as { data: string }).data;
  db.close();
  const unsupported = (e: unknown) =>
    e instanceof HarnessError &&
    e.code === 'STATE_VERSION_UNSUPPORTED' &&
    e.issues.some((i) => i.path.includes('controller'));
  // Отказ — уже при открытии, до записи автора и схемы; повторное открытие —
  // тот же отказ. Отказ транзакции над документом, испорченным после
  // открытия, и отсутствие зависшего BEGIN — в state-open.test.ts.
  assert.throws(() => new SqliteExecutionStore(file, 'test'), unsupported);
  assert.throws(() => new SqliteExecutionStore(file, 'test'), unsupported);
  const after = new DatabaseSync(file);
  assert.equal((after.prepare('SELECT data FROM state').get() as { data: string }).data, before);
  after.close();
});

test('Событие неизвестного типа (записанное более новой версией) читается непрозрачным, список не обрывается', () => {
  const dir = temp();
  const file = join(dir, 'state.sqlite');
  const store = new SqliteExecutionStore(file, 'test');
  store.transact('run.phase', (tx) =>
    tx.emit({ type: 'attempt.phase', runId: 'r1', payload: { phase: 'running' } }),
  );
  const db = new DatabaseSync(file);
  const future = {
    apiVersion: API_VERSION,
    seq: 2,
    at: '2026-11-03T00:00:00.000Z',
    workId: 'w1',
    runId: 'r1',
    attempt: 1,
    type: 'attempt.future-kind',
    payload: { anything: 'x', nested: { deep: true } },
  };
  db.prepare('INSERT INTO events(seq, data) VALUES(2, ?)').run(JSON.stringify(future));
  db.close();
  store.transact('run.phase', (tx) =>
    tx.emit({ type: 'attempt.phase', runId: 'r1', payload: { phase: 'verifying' } }),
  );

  const events = store.events();
  assert.deepEqual(
    events.map((e) => [e.seq, e.type]),
    [
      [1, 'attempt.phase'],
      [2, 'unknown'],
      [3, 'attempt.phase'],
    ],
  );
  // Документированная форма: конверт, `type: 'unknown'`, исходный тип; нагрузки нет.
  assert.deepEqual(events[1], {
    apiVersion: API_VERSION,
    seq: 2,
    at: '2026-11-03T00:00:00.000Z',
    workId: 'w1',
    runId: 'r1',
    attempt: 1,
    type: 'unknown',
    original: 'attempt.future-kind',
  });
  assert.ok(readRunEventSchema.safeParse(events[1]).success, 'форма из схемы чтения');
  assert.equal(runEventSchema.safeParse(events[1]).success, false, 'писатель её не принимает');
  // Тот же список отдаёт и CLI-данные `events`.
  assert.ok(eventsDataSchema.safeParse({ events, next: 3 }).success);
  // Курсор идёт через неизвестное событие.
  assert.deepEqual(
    store.events(1).map((e) => e.seq),
    [2, 3],
  );
  // Записать событие типа `unknown` нельзя: писатель строгий.
  assert.throws(() =>
    store.transact('run.phase', (tx) =>
      tx.emit({ type: 'unknown', original: 'x', payload: {} } as never),
    ),
  );
  assert.equal(store.events().length, 3);
  store.close();

  // Известный тип с нарушенной нагрузкой — по-прежнему отказ, а не подмена.
  const broken = new DatabaseSync(file);
  broken
    .prepare('INSERT INTO events(data) VALUES(?)')
    .run(JSON.stringify({ ...future, seq: 4, type: 'attempt.phase', payload: { phase: 'nope' } }));
  broken.close();
  const reread = new SqliteExecutionStore(file, 'test', { readOnly: true });
  assert.throws(() => reread.events());
  reread.close();
});

test('readRunEvent: неизвестный тип с нарушенным конвертом — отказ', () => {
  assert.throws(() => readRunEvent({ type: 'future.kind', seq: 0, at: 'x' }));
  assert.equal(
    readRunEvent({
      apiVersion: API_VERSION,
      seq: 1,
      at: '2026-11-03T00:00:00.000Z',
      type: 'x'.repeat(300),
      payload: 1,
    }).type,
    'unknown',
  );
});

/**
 * Хранилище, искажающее локальные записи: проверка, что договор
 * `executionStoreContract` ловит такие адаптеры, а не только исправные.
 */
function distorted(
  inner: SqliteExecutionStore,
  distort: {
    locals?: (rows: { owner: string; key: string; value: unknown }[], owner?: string) => unknown;
    putLocal?: (put: () => void, exists: boolean, namespace: string) => void;
  },
): ExecutionStore {
  const wrap = <V extends object>(view: V): V =>
    new Proxy(view, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop === 'locals' && distort.locals) {
          const locals = value as (ns: string, owner?: string) => never[];
          return (ns: string, owner?: string) =>
            distort.locals!(locals.call(target, ns, owner), owner);
        }
        if (prop === 'putLocal' && distort.putLocal) {
          const put = value as (ns: string, owner: string, key: string, v: unknown) => void;
          const local = (
            target as unknown as { local: (n: string, o: string, k: string) => unknown }
          ).local;
          return (ns: string, owner: string, key: string, v: unknown) =>
            distort.putLocal!(
              () => put.call(target, ns, owner, key, v),
              local.call(target, ns, owner, key) !== undefined,
              ns,
            );
        }
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
  return {
    stateVersion: inner.stateVersion,
    transact: (kind, fn) => inner.transact(kind, (tx) => fn(wrap(tx))),
    read: (fn) => inner.read((v) => fn(wrap(v))),
    events: (after, limit) => inner.events(after, limit),
    close: () => inner.close(),
  };
}

function contractCases(open: (dir: string) => ExecutionStore) {
  const cases = new Map<string, () => void | Promise<void>>();
  executionStoreContract('broken', (title, fn) => cases.set(title, fn), open, temp);
  const find = (part: string) => {
    const found = [...cases].find(([title]) => title.includes(part));
    assert.ok(found, 'в договоре нет случая: ' + part);
    return found[1];
  };
  return find;
}

test('Договор хранилища ловит адаптер, который в списке без владельца теряет owner', async () => {
  const find = contractCases((dir) =>
    distorted(new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test'), {
      locals: (rows, owner) =>
        owner === undefined ? rows.map((r) => ({ ...r, owner: '' })) : rows,
    }),
  );
  const run = find('список без владельца');
  await assert.rejects(async () => run());
});

test('Договор хранилища ловит адаптер, который не перезаписывает запрос новой версией', async () => {
  const find = contractCases((dir) =>
    distorted(new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test'), {
      putLocal: (put, exists, ns) => {
        if (ns === 'input-requests' && exists) return;
        put();
      },
    }),
  );
  const run = find('ровно таким, каким записан');
  await assert.rejects(async () => run());
});
