/**
 * D53: аренда попыток — строка, а не поле документа. Продление меняет одну
 * строку; документ, версия данных и журнал не меняются. Каждый случай
 * называет поломку, которую ловит.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HarnessError, WORKSPACE_OWNER, executionDocumentSchema } from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { engineOf, graphOf, policyOf, ready, trustNone } from './engine-fixture.ts';

const refused = (code: string) => (e: unknown) => e instanceof HarnessError && e.code === code;

/** Прямое чтение базы: документ, версия данных, строки аренды. */
function raw(dir: string) {
  const db = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true });
  try {
    const data = (db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string }).data;
    const version = db.prepare("SELECT value FROM meta WHERE key='dataVersion'").get() as
      { value: string } | undefined;
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leases'")
      .get();
    const rows = table
      ? (db.prepare('SELECT kind, id, token, owner, engine, until FROM leases').all() as {
          kind: string;
          id: string;
          token: string;
          until: number;
        }[])
      : [];
    return {
      data,
      doc: JSON.parse(data) as Record<string, unknown>,
      version: version?.value,
      rows,
    };
  } finally {
    db.close();
  }
}

/** Схема документа прежней версии: та же строгая, но без метки D53. */
const previousSchema = executionDocumentSchema.omit({ leaseRows: true });

test('D53: heartbeat продлевает строку — документ, версия данных и журнал прежние', () => {
  // Ловит F46: продление, переписывающее документ целиком (или поднимающее
  // версию данных и сбрасывающее кэши), — то, что задерживало основной поток.
  const { engine, clock, dir, store } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  const before = raw(dir);
  const events = store.events().length;
  assert.equal(before.rows.length, 1, 'выдача создала строку аренды');
  clock.now += 10_000;
  engine.heartbeat(a.id, a.token);
  clock.now += 10_000;
  engine.heartbeat(a.id, a.token);
  const after = raw(dir);
  assert.equal(after.data, before.data, 'документ не переписан');
  assert.equal(after.version, before.version, 'версия данных не изменилась');
  assert.equal(store.events().length, events, 'событий нет');
  assert.equal(after.rows[0]!.until, clock.now + 30_000, 'срок строки продлён');
  assert.equal(
    engine.read((v) => v.attempt(a.id)?.leaseUntil),
    clock.now + 30_000,
    'чтение попытки видит срок строки',
  );
});

test('D53: истёкшая аренда не продлевается даже прежним token; adopt берёт её штатно', () => {
  // Ловит: продление после срока — ограждение держалось бы на «никто ещё не
  // истёк», и уборка или adopt по истёкшему сроку гонялись бы с оживлением.
  const { engine, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  clock.now = a.leaseUntil;
  assert.throws(() => engine.heartbeat(a.id, a.token), refused('LEASE_STALE'));
  clock.now += 1;
  assert.throws(() => engine.heartbeat(a.id, a.token), refused('LEASE_STALE'));
  const adopted = engine.adopt(a.id, 'c2');
  assert.throws(() => engine.heartbeat(a.id, a.token), refused('LEASE_STALE'), 'прежний token');
  engine.heartbeat(adopted.id, adopted.token);
});

test('D53: истечение видит срок строки, а не устаревший срок документа', () => {
  // Ловит: такт очереди, истекающий по сроку документа (его продление больше
  // не пишет), истёк бы живую попытку — потеря работы F46.
  const { engine, clock, dir } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  clock.now += 20_000;
  engine.heartbeat(a.id, a.token);
  const documentTerm = (raw(dir).doc.attempts as { leaseUntil: number }[])[0]!.leaseUntil;
  assert.equal(documentTerm, a.leaseUntil, 'срок в документе не продлевался');
  clock.now = a.leaseUntil + 5_000;
  assert.deepEqual(engine.expire(), [], 'попытка жива по строке');
  clock.now += 30_000;
  assert.deepEqual(engine.expire(), [a.id], 'по истечении строки — истекает');
  assert.equal(raw(dir).rows.length, 0, 'истечение удалило строку той же транзакцией');
});

test('D53: продление проверяет guards полностью при смене версии данных и раз в срок аренды', () => {
  // Ловит две поломки: проверка, пропущенная после изменения данных (отказ
  // хоста или смена политики не прервали бы идущий gate до следующей фазы),
  // и полная проверка на каждом продлении (документ читался бы снова).
  const dir = mkdtempSync(join(tmpdir(), 'harness-lease-'));
  const policy = policyOf();
  const store = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  const base = standaloneHost(store, policy);
  let calls = 0;
  const host = {
    ...base,
    guards: {
      ...base.guards,
      current: (...args: Parameters<typeof base.guards.current>) => {
        calls++;
        const view = args[2];
        return view.local('joint-budget-resets', WORKSPACE_OWNER, 'stop')
          ? { code: 'PAUSED' as const, message: 'хост отозвал работу' }
          : null;
      },
    },
  };
  const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') };
  let n = 0;
  const engine = new Engine({
    host,
    policy,
    now: () => clock.now,
    id: () => `id-${String(++n).padStart(6, '0')}`,
  });
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  calls = 0;
  engine.heartbeat(a.id, a.token);
  assert.equal(calls, 1, 'первое продление проверяет полностью');
  clock.now += 10_000;
  engine.heartbeat(a.id, a.token);
  clock.now += 10_000;
  engine.heartbeat(a.id, a.token);
  assert.equal(calls, 1, 'без изменений данных — только строка');
  clock.now += 10_000;
  engine.heartbeat(a.id, a.token);
  assert.equal(calls, 2, 'через срок аренды — полная проверка снова');
  store.transact('workspace.budget-reset', (tx) =>
    tx.putLocal('joint-budget-resets', WORKSPACE_OWNER, 'stop', {
      id: 'stop',
      at: '2026-01-01T00:00:00.000Z',
      workIds: ['a'],
      reason: 'stop',
      actor: 'operator',
      settledVerificationIds: ['jv-1'],
    }),
  );
  clock.now += 1_000;
  assert.throws(() => engine.heartbeat(a.id, a.token), refused('PAUSED'));
  assert.equal(calls, 3, 'смена версии данных — полная проверка');
  store.close();
});

test('D53: открытие переносит сроки активных попыток в строки одной транзакцией с меткой', () => {
  // Ловит: миграцию без метки или вне транзакции метки — процесс прежней
  // версии продлил бы срок в документе между шагами или не увидел бы, что
  // срок теперь в строке.
  const { engine, store, dir } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  store.close();
  // Состояние прежней версии: срок в документе, метки и строк нет.
  const db = new DatabaseSync(join(dir, 'state.sqlite'));
  const doc = JSON.parse(
    (db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string }).data,
  ) as Record<string, unknown> & { attempts: { leaseUntil: number }[] };
  delete doc.leaseRows;
  doc.attempts[0]!.leaseUntil = a.leaseUntil + 7;
  db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(doc));
  db.exec('DROP TABLE leases');
  db.close();
  assert.ok(previousSchema.safeParse(raw(dir).doc).success, 'исходный документ — прежней версии');
  new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test').close();
  const migrated = raw(dir);
  assert.equal(migrated.doc.leaseRows, true, 'метка поставлена');
  assert.deepEqual(
    migrated.rows.map((r) => [r.kind, r.id, r.token, r.until]),
    [['attempt', a.id, a.token, a.leaseUntil + 7]],
  );
  assert.equal(
    previousSchema.safeParse(migrated.doc).success,
    false,
    'прежняя версия (строгая схема без метки) отказывает до записи',
  );
});

test('D53: ошибка миграции откатывает и строки, и метку', () => {
  // Ловит: метку без строк (или строки без метки) после сбоя миграции —
  // активная попытка осталась бы без аренды или с двумя источниками срока.
  const { engine, store, dir } = engineOf();
  ready(engine, graphOf({ a: [] }));
  engine.claim('c1');
  store.close();
  const db = new DatabaseSync(join(dir, 'state.sqlite'));
  const doc = JSON.parse(
    (db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string }).data,
  ) as Record<string, unknown>;
  delete doc.leaseRows;
  db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(doc));
  db.exec('DROP TABLE leases');
  // Отказ после записи строк и документа, внутри той же транзакции: на
  // последнем шаге миграции (версия данных).
  db.exec(
    "CREATE TRIGGER fail_migration AFTER INSERT ON meta WHEN NEW.key='dataVersion' BEGIN SELECT RAISE(ABORT, 'сбой миграции'); END",
  );
  db.close();
  const before = raw(dir).data;
  assert.throws(() => new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test'), /сбой миграции/);
  const after = raw(dir);
  assert.equal(after.data, before, 'документ без метки — как был');
  assert.deepEqual(after.rows, [], 'строк нет: их запись откачена вместе с документом');
});

test('D53: попытка, отвязанная от поручения записью данных, не продлевается строкой', () => {
  // Ловит: продление строкой без полной проверки после изменения данных —
  // попытка, которую запись хоста отвязала от поручения (activeRunId снят,
  // попытка ещё активна и её строка цела), продлевалась бы. Новая редакция
  // графа при активных попытках отказывает (REVISION_CONFLICT), поэтому
  // отвязку делает прямая запись хоста.
  const { engine, clock, store } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  engine.heartbeat(a.id, a.token);
  assert.throws(
    () => engine.register(graphOf({ a: [] }, '2'), trustNone),
    refused('REVISION_CONFLICT'),
  );
  store.transact('run.phase', (tx) => tx.putWork({ ...tx.work('a')!, activeRunId: undefined }));
  assert.equal(
    store.read((v) => v.attemptLease!(a.id)?.token),
    a.token,
    'строка попытки цела',
  );
  clock.now += 1_000;
  assert.throws(() => engine.heartbeat(a.id, a.token), refused('LEASE_STALE'));
});

test('D53: шаг вниз копирует срок строки в документ и снимает метку и строки', () => {
  // Ловит: откат без шага вниз (прежняя версия отказывала бы навсегда) и
  // шаг вниз, теряющий продлённый срок (живая попытка истекла бы сразу).
  const { engine, store, dir, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  clock.now += 20_000;
  engine.heartbeat(a.id, a.token);
  const term = clock.now + 30_000;
  assert.equal(store.stepDownLeases(), 1);
  const down = raw(dir);
  assert.equal(down.doc.leaseRows, undefined);
  assert.deepEqual(down.rows, []);
  assert.equal((down.doc.attempts as { leaseUntil: number }[])[0]!.leaseUntil, term);
  assert.ok(previousSchema.safeParse(down.doc).success, 'прежняя версия читает документ');
  store.close();
  // Новая версия, открытая снова, переносит срок обратно в строку.
  new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test').close();
  assert.deepEqual(
    raw(dir).rows.map((r) => r.until),
    [term],
  );
});
