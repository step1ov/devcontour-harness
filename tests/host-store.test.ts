/**
 * Импорт пакетов из store хоста (alpha.64) без pnpm: store хоста собирается
 * вручную в формате pnpm 10 (JSON-индекс) и pnpm 11 (`index.db`, записи
 * msgpackr с объявлениями записей). Проверяется сверка копии, перенос записи
 * индекса и разбор записей.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeIndexRecord, importHostStore } from '../src/verification/host-store.ts';

const sha512 = (b: Buffer | string) => createHash('sha512').update(b).digest();
const integrityOf = (name: string) => 'sha512-' + sha512('tarball:' + name).toString('base64');

/** msgpack с записями msgpackr: каждый объект — объявление `0xd4 0x72 <id>` и значения. */
function encode(value: unknown): Buffer {
  let next = 0x40;
  const out: Buffer[] = [];
  const str = (s: string) => {
    const b = Buffer.from(s, 'utf8');
    out.push(b.length < 32 ? Buffer.from([0xa0 | b.length]) : Buffer.from([0xd9, b.length]), b);
  };
  const write = (v: unknown): void => {
    if (v === null) out.push(Buffer.from([0xc0]));
    else if (v === false) out.push(Buffer.from([0xc2]));
    else if (v === true) out.push(Buffer.from([0xc3]));
    else if (typeof v === 'number') {
      const b = Buffer.alloc(9);
      b[0] = 0xcb;
      b.writeDoubleBE(v, 1);
      out.push(b);
    } else if (typeof v === 'string') str(v);
    else if (Array.isArray(v)) {
      out.push(Buffer.from([0x90 | v.length]));
      v.forEach(write);
    } else {
      const keys = Object.keys(v as object);
      out.push(Buffer.from([0xd4, 0x72, next++]));
      write(keys);
      for (const k of keys) write((v as Record<string, unknown>)[k]);
    }
  };
  write(value);
  return Buffer.concat(out);
}

interface File {
  rel: string;
  body: string;
  mode?: number;
  /** Записать в индекс другой размер (хэш верный). */
  size?: number;
  /** Не класть файл в store хоста. */
  missing?: boolean;
}

/** Store хоста формата `layout` с пакетами; `sideEffects` — запись с результатами сборки. */
function hostStore(
  layout: 'v10' | 'v11',
  packages: { name: string; files: File[]; sideEffects?: boolean; rawFiles?: Buffer }[],
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-host-store-')));
  const host = join(root, 'store', layout);
  mkdirSync(join(host, 'files'), { recursive: true });
  let db: DatabaseSync | undefined;
  if (layout === 'v11') {
    db = new DatabaseSync(join(host, 'index.db'));
    db.exec('CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID');
    db.exec(
      'CREATE TABLE package_index_alias (key TEXT PRIMARY KEY, target TEXT NOT NULL) WITHOUT ROWID',
    );
  }
  for (const pkg of packages) {
    const files: Record<string, Record<string, unknown>> = {};
    for (const f of pkg.files) {
      const digest = sha512(f.body).toString('hex');
      const mode = f.mode ?? 0o644;
      const path = join(
        host,
        'files',
        digest.slice(0, 2),
        digest.slice(2) + (mode & 0o111 ? '-exec' : ''),
      );
      if (!f.missing) {
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, f.body, { mode });
      }
      const size = f.size ?? Buffer.byteLength(f.body);
      files[f.rel] =
        layout === 'v11'
          ? { checkedAt: 1, digest, mode, size }
          : { checkedAt: 1, integrity: 'sha512-' + sha512(f.body).toString('base64'), mode, size };
    }
    const entry: Record<string, unknown> = {
      name: pkg.name,
      version: '1.0.0',
      requiresBuild: Boolean(pkg.sideEffects),
      files,
      ...(pkg.sideEffects
        ? {
            sideEffects: {
              'darwin;arm64;node24': { added: { 'build.node': files[pkg.files[0]!.rel] } },
            },
          }
        : {}),
    };
    const integrity = integrityOf(pkg.name);
    if (db)
      db.prepare('INSERT INTO package_index (key, data) VALUES (?, ?)').run(
        `${integrity}\t${pkg.name}@1.0.0`,
        pkg.rawFiles ?? encode(entry),
      );
    else {
      const hex = Buffer.from(integrity.slice(7), 'base64').toString('hex');
      mkdirSync(join(host, 'index', hex.slice(0, 2)), { recursive: true });
      writeFileSync(
        join(host, 'index', hex.slice(0, 2), `${hex.slice(2, 64)}-${pkg.name}@1.0.0.json`),
        JSON.stringify(entry),
      );
    }
  }
  db?.close();
  const entries = packages
    .map((p) => `  ${p.name}@1.0.0:\n    resolution: {integrity: ${integrityOf(p.name)}}`)
    .join('\n');
  const build = join(root, 'build');
  return {
    root,
    host,
    lock: 'packages:\n' + entries + '\n',
    store: join(build, 'store'),
    scratch: join(build, 'scratch'),
    run(lock = 'packages:\n' + entries + '\n') {
      return importHostStore({
        host,
        store: join(build, 'store'),
        lock,
        scratch: join(build, 'scratch'),
        signal: new AbortController().signal,
      });
    },
  };
}

const content = (store: string, layout: string, body: string, exec = false) => {
  const d = sha512(body).toString('hex');
  return join(store, layout, 'files', d.slice(0, 2), d.slice(2) + (exec ? '-exec' : ''));
};

for (const layout of ['v10', 'v11'] as const)
  test(`host store ${layout}: исполняемый файл — с -exec и 0755; размер не тот при верном хэше и один плохой файл из нескольких — пакет не импортируется`, async (t) => {
    const h = hostStore(layout, [
      {
        name: 'good',
        files: [
          { rel: 'index.js', body: 'good' },
          { rel: 'bin/cli', body: '#!/bin/sh\necho good\n', mode: 0o755 },
        ],
      },
      { name: 'sized', files: [{ rel: 'index.js', body: 'sized', size: 999 }] },
      {
        name: 'partly',
        files: [
          { rel: 'a.js', body: 'partly-a' },
          { rel: 'b.js', body: 'partly-b', missing: true },
          { rel: 'c.js', body: 'partly-c' },
        ],
      },
    ]);
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    const r = await h.run();
    assert.equal(r.packages, 3);
    assert.equal(r.host, 1, JSON.stringify(r));
    assert.equal(r.rejected?.length, 2, JSON.stringify(r.rejected));
    assert.ok(r.rejected.some((m) => /^sized@1\.0\.0: размер/.test(m)));
    assert.ok(r.rejected.some((m) => /^partly@1\.0\.0: нет файла/.test(m)));
    const exec = content(h.store, layout, '#!/bin/sh\necho good\n', true);
    assert.equal(statSync(exec).mode & 0o777, 0o755);
    assert.equal(statSync(content(h.store, layout, 'good')).mode & 0o777, 0o644);
    // Запись индекса — только у импортированного пакета.
    if (layout === 'v11') {
      const db = new DatabaseSync(join(h.store, 'v11', 'index.db'));
      const keys = (db.prepare('SELECT key FROM package_index').all() as { key: string }[]).map(
        (k) => k.key.split('\t')[1],
      );
      db.close();
      assert.deepEqual(keys, ['good@1.0.0']);
    } else {
      const names = readdirSync(join(h.store, 'v10', 'index'), { recursive: true })
        .map(String)
        .filter((n) => n.endsWith('.json'));
      assert.equal(names.length, 1);
      assert.match(names[0]!, /-good@1\.0\.0\.json$/);
    }
    assert.equal(existsSync(h.scratch), false, 'копия индекса убрана');
  });

test('host store v10: запись с sideEffects переносится без них; v11 — такая запись не импортируется', async (t) => {
  const pkgs = [
    { name: 'built', files: [{ rel: 'index.js', body: 'built' }], sideEffects: true },
    { name: 'plain', files: [{ rel: 'index.js', body: 'plain' }] },
  ];
  const v10 = hostStore('v10', pkgs);
  const v11 = hostStore('v11', pkgs);
  t.after(() => {
    rmSync(v10.root, { recursive: true, force: true });
    rmSync(v11.root, { recursive: true, force: true });
  });
  const r10 = await v10.run();
  assert.equal(r10.host, 2);
  const index = readdirSync(join(v10.store, 'v10', 'index'), { recursive: true })
    .map(String)
    .find((n) => n.endsWith('-built@1.0.0.json'))!;
  const entry = JSON.parse(readFileSync(join(v10.store, 'v10', 'index', index), 'utf8')) as {
    files: Record<string, unknown>;
  };
  assert.equal('sideEffects' in entry, false, 'результаты сборки хоста не в seed');
  assert.ok(entry.files['index.js']);

  const r11 = await v11.run();
  assert.equal(r11.host, 1);
  assert.equal(r11.sideEffects, 1);
  const db = new DatabaseSync(join(v11.store, 'v11', 'index.db'));
  const keys = (db.prepare('SELECT key FROM package_index').all() as { key: string }[]).map(
    (k) => k.key.split('\t')[1],
  );
  db.close();
  assert.deepEqual(keys, ['plain@1.0.0']);
});

test('host store v11: ключ __proto__ — обычный файл, а не смена прототипа; пустой набор файлов не импортируется', async (t) => {
  const value = decodeIndexRecord(encode({ ['__proto__']: 1 })) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(value), null);
  assert.deepEqual(Object.keys(value), ['__proto__']);
  assert.equal(value['__proto__'], 1);

  // Файл с именем __proto__, которого нет на хосте: пакет не импортируется
  // (на be86d07 прототип менялся, и пакет импортировался без единого файла).
  const proto = encode({
    files: {
      ['__proto__']: { checkedAt: 1, digest: sha512('gone').toString('hex'), mode: 0o644, size: 4 },
    },
  });
  const h = hostStore('v11', [
    { name: 'proto', files: [], rawFiles: proto },
    { name: 'empty', files: [], rawFiles: encode({ files: {} }) },
  ]);
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const r = await h.run();
  assert.equal(r.host, 0, JSON.stringify(r));
  assert.ok(
    r.rejected?.some((m) => /^proto@1\.0\.0: нет файла/.test(m)),
    JSON.stringify(r),
  );
});

test('decodeIndexRecord: обрезанная запись, неизвестное расширение, ссылка на необъявленную запись, лишние байты — исключение', () => {
  const good = encode({ files: {} });
  assert.throws(() => decodeIndexRecord(good.subarray(0, good.length - 1)), /обрезана/);
  assert.throws(() => decodeIndexRecord(Buffer.from([0xd4, 0x01, 0x00])), /расширение msgpack 1/);
  assert.throws(() => decodeIndexRecord(Buffer.from([0x41])), /необъявленную запись 65/);
  assert.throws(
    () => decodeIndexRecord(Buffer.concat([good, Buffer.from([0xc0])])),
    /лишние байты/,
  );
  assert.throws(() => decodeIndexRecord(Buffer.from([0xc1])), /байт msgpack 0xc1/);
});

test('host store v11: индекс без таблицы package_index — исключение, копия индекса и созданная база не остаются', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-host-store-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = join(root, 'v11');
  mkdirSync(host);
  const db = new DatabaseSync(join(host, 'index.db'));
  db.exec('CREATE TABLE other (x)');
  db.close();
  const scratch = join(root, 'scratch');
  const store = join(root, 'store');
  await assert.rejects(
    importHostStore({
      host,
      store,
      lock: `x@1.0.0:\n  resolution: {integrity: ${integrityOf('x')}}\n`,
      scratch,
      signal: new AbortController().signal,
    }),
    /нет таблицы package_index/,
  );
  assert.equal(existsSync(scratch), false, 'копия индекса хоста убрана');
  assert.equal(existsSync(join(store, 'v11', 'index.db')), false);
});
