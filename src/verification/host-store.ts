/**
 * Импорт пакетов в seed из store менеджера на хосте (alpha.64).
 *
 * Seed по-прежнему собирает `pnpm fetch` над принятым lockfile, но перед ним
 * сборочный store получает пакеты этого lockfile, которые уже есть на машине:
 * проект, установленный оператором, не качает весь граф заново.
 *
 * Граница доверия:
 *
 * - Store хоста только читается: файлы содержимого клонируются (`clonefile` на
 *   APFS, иначе обычная копия) в сборочный каталог seed, индекс pnpm 11
 *   (`index.db`) сначала копируется и открывается копия. Gates и seed store
 *   хоста не видят и в него не пишут.
 * - Берутся только пакеты с integrity из принятого lockfile — того же, по
 *   которому собирается seed; кандидат на выбор не влияет.
 * - Каждый скопированный файл сверяется по байтам копии: sha512 и размер равны
 *   записи индекса, а имя файла в store и есть этот хэш. Пакет с недостающим
 *   или несовпавшим файлом не импортируется (его докачает `pnpm fetch`).
 * - Соответствие «integrity tarball → файлы» берётся из индекса хоста: ему
 *   доверено ровно столько, сколько собственной установке оператора из этого
 *   store. Store внутри каталога seeds, рабочих деревьев или состояния не
 *   используется: его мог писать код кандидата.
 *
 * Формат store: `v10` (pnpm 10: JSON-индекс `index/<2>/<62>-<имя>.json`) и
 * `v11` (pnpm 11: `index.db`, записи msgpack). Другой формат или нечитаемый
 * индекс — импорта нет, сборка качает всё, как прежде.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Файлы пакета из индекса store: путь в пакете → хэш содержимого и права. */
interface IndexedFile {
  digest: string;
  mode: number;
  size: number;
}

export interface HostImport {
  /** Пакетов lockfile с integrity. */
  packages: number;
  /** Импортировано из store хоста. */
  host: number;
  /** Уже было в сборочном store (основа — прежний seed). */
  present: number;
  /** Скопировано файлов содержимого. */
  files: number;
  /** Пакеты, найденные на хосте, но отвергнутые сверкой: первые причины. */
  rejected?: string[];
  /** Записи хоста с результатами сборки (`sideEffects`) pnpm 11: не импортированы. */
  sideEffects?: number;
}

const FILE_CONCURRENCY = 16;
const MAX_REJECTED = 5;

/** Integrity пакетов lockfile (`resolution: {integrity: sha512-…}`), без повторов. */
export function lockIntegrities(lock: string) {
  const out = new Set<string>();
  for (const m of lock.matchAll(/\bintegrity:\s*['"]?(sha512-[A-Za-z0-9+/]+={0,2})/g))
    out.add(m[1]!);
  return [...out];
}

const hexOf = (integrity: string) =>
  Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');

/** Путь файла содержимого в store: `files/<2>/<остаток>`, исполняемый — с `-exec`. */
const contentPath = (f: IndexedFile) =>
  join('files', f.digest.slice(0, 2), f.digest.slice(2) + (f.mode & 0o111 ? '-exec' : ''));

/** Путь `inner` внутри `outer` (или равен ему). */
export const inside = (inner: string, outer: string) => {
  const rel = relative(resolve(outer), resolve(inner));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
};

/**
 * Записи msgpack индекса pnpm 11. pnpm кодирует их msgpackr с записями
 * (`useRecords`): расширение `0xd4 0x72 <id>` объявляет набор ключей и сразу
 * значения, байты `0x40…0x7f` ссылаются на объявленный набор. Всё прочее —
 * обычный msgpack. Неизвестный байт — исключение: индекс не понят, импорта нет.
 */
export function decodeIndexRecord(buf: Uint8Array): unknown {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const records = new Map<number, unknown[]>();
  const need = (n: number) => {
    if (p + n > b.length) throw new Error('запись индекса обрезана');
  };
  const str = (n: number) => {
    need(n);
    const s = b.toString('utf8', p, p + n);
    p += n;
    return s;
  };
  const bytes = (n: number) => {
    need(n);
    const v = b.subarray(p, p + n);
    p += n;
    return v;
  };
  const num = <T>(n: number, read: (at: number) => T) => {
    need(n);
    const v = read(p);
    p += n;
    return v;
  };
  const map = (n: number) => {
    const o = new Map<unknown, unknown>();
    for (let i = 0; i < n; i++) {
      const k = read();
      o.set(k, read());
    }
    return Object.fromEntries(o) as Record<string, unknown>;
  };
  const array = (n: number) => Array.from({ length: n }, () => read());
  // Без прототипа и через defineProperty: ключ `__proto__` — обычный ключ, а не смена прототипа.
  const record = (keys: unknown[]) => {
    const o = Object.create(null) as Record<string, unknown>;
    for (const k of keys)
      Object.defineProperty(o, String(k), {
        value: read(),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return o;
  };
  const read = (): unknown => {
    need(1);
    const t = b[p++]!;
    if (t <= 0x3f) return t;
    if (t <= 0x7f) {
      const keys = records.get(t);
      if (!keys) throw new Error(`ссылка на необъявленную запись ${t}`);
      return record(keys);
    }
    if (t <= 0x8f) return map(t & 0x0f);
    if (t <= 0x9f) return array(t & 0x0f);
    if (t <= 0xbf) return str(t & 0x1f);
    if (t >= 0xe0) return t - 0x100;
    switch (t) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return bytes(num(1, (at) => b.readUInt8(at)));
      case 0xc5:
        return bytes(num(2, (at) => b.readUInt16BE(at)));
      case 0xc6:
        return bytes(num(4, (at) => b.readUInt32BE(at)));
      case 0xca:
        return num(4, (at) => b.readFloatBE(at));
      case 0xcb:
        return num(8, (at) => b.readDoubleBE(at));
      case 0xcc:
        return num(1, (at) => b.readUInt8(at));
      case 0xcd:
        return num(2, (at) => b.readUInt16BE(at));
      case 0xce:
        return num(4, (at) => b.readUInt32BE(at));
      case 0xcf:
        return num(8, (at) => Number(b.readBigUInt64BE(at)));
      case 0xd0:
        return num(1, (at) => b.readInt8(at));
      case 0xd1:
        return num(2, (at) => b.readInt16BE(at));
      case 0xd2:
        return num(4, (at) => b.readInt32BE(at));
      case 0xd3:
        return num(8, (at) => Number(b.readBigInt64BE(at)));
      case 0xd9:
        return str(num(1, (at) => b.readUInt8(at)));
      case 0xda:
        return str(num(2, (at) => b.readUInt16BE(at)));
      case 0xdb:
        return str(num(4, (at) => b.readUInt32BE(at)));
      case 0xdc:
        return array(num(2, (at) => b.readUInt16BE(at)));
      case 0xdd:
        return array(num(4, (at) => b.readUInt32BE(at)));
      case 0xde:
        return map(num(2, (at) => b.readUInt16BE(at)));
      case 0xdf:
        return map(num(4, (at) => b.readUInt32BE(at)));
      case 0xd4: {
        const ext = num(1, (at) => b.readUInt8(at));
        if (ext !== 0x72) throw new Error(`расширение msgpack ${ext}`);
        const id = num(1, (at) => b.readUInt8(at));
        const keys = read();
        if (!Array.isArray(keys) || id < 0x40 || id > 0x7f)
          throw new Error('объявление записи не понято');
        records.set(id, keys);
        return record(keys);
      }
      default:
        throw new Error(`байт msgpack 0x${t.toString(16)}`);
    }
  };
  const value = read();
  if (p !== b.length) throw new Error('лишние байты в записи индекса');
  return value;
}

/** Файлы пакета из записи индекса; запись не того вида — `undefined`. */
function filesOf(entry: unknown, digestOf: (f: Record<string, unknown>) => string | undefined) {
  const files = (entry as { files?: unknown } | null)?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return undefined;
  const out: IndexedFile[] = [];
  for (const raw of Object.values(files as Record<string, unknown>)) {
    const f = raw as Record<string, unknown>;
    const digest = digestOf(f);
    if (
      !digest ||
      !/^[0-9a-f]{128}$/.test(digest) ||
      typeof f.mode !== 'number' ||
      typeof f.size !== 'number'
    )
      return undefined;
    out.push({ digest, mode: f.mode, size: f.size });
  }
  // Пакет без единого файла не импортируется: такая запись не похожа на настоящую.
  return out.length ? out : undefined;
}

/**
 * Запись хоста хранит `sideEffects` — результаты сборочных скриптов, которые
 * выполнял хост (esbuild, prisma…). Seed скриптов не исполняет (`--ignore-scripts`),
 * и их файлов в нём нет: такие записи в seed не переносятся.
 */
const hasSideEffects = (entry: unknown) => {
  const side = (entry as { sideEffects?: unknown } | null)?.sideEffects;
  return (
    side !== undefined && side !== null && !(typeof side === 'object' && !Object.keys(side).length)
  );
};

const digestV11 = (f: Record<string, unknown>) =>
  typeof f.digest === 'string' ? f.digest : undefined;
const digestV10 = (f: Record<string, unknown>) =>
  typeof f.integrity === 'string' && f.integrity.startsWith('sha512-')
    ? hexOf(f.integrity)
    : undefined;

/** Пакет на хосте: файлы и запись индекса, которую нужно перенести. */
interface HostPackage {
  name: string;
  files: IndexedFile[];
  commit(): Promise<void> | void;
}

/** Параллельно с пределом; первый отказ останавливает раздачу. */
async function within<T>(items: T[], limit: number, action: (item: T) => Promise<void>) {
  let next = 0;
  let failed: Error | undefined;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && failed === undefined) {
        const item = items[next++]!;
        try {
          await action(item);
        } catch (error) {
          failed ??= error instanceof Error ? error : new Error(String(error));
        }
      }
    }),
  );
  if (failed !== undefined) throw failed;
}

class Rejected extends Error {}

/**
 * Копировать файлы пакета в `target` со сверкой байтов копии. Уже лежащий
 * в `target` файл не копируется: он пришёл с основой (сверен манифестом) или
 * этим же импортом. Возвращает число скопированных файлов.
 */
async function copyFiles(host: string, target: string, pkg: HostPackage, signal: AbortSignal) {
  let copied = 0;
  await within(pkg.files, 4, async (f) => {
    signal.throwIfAborted();
    const rel = contentPath(f);
    const dest = join(target, rel);
    if (await lstat(dest).catch(() => undefined)) return;
    await mkdir(dirname(dest), { recursive: true });
    const staged = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await copyFile(join(host, rel), staged, constants.COPYFILE_FICLONE);
    } catch {
      throw new Rejected(`${pkg.name}: нет файла ${rel}`);
    }
    try {
      const st = await lstat(staged);
      if (!st.isFile() || st.size !== f.size) throw new Rejected(`${pkg.name}: размер ${rel}`);
      const digest = createHash('sha512')
        .update(await readFile(staged))
        .digest('hex');
      if (digest !== f.digest) throw new Rejected(`${pkg.name}: содержимое ${rel}`);
      await chmod(staged, f.mode & 0o111 ? 0o755 : 0o644);
      await rename(staged, dest);
      copied++;
    } finally {
      await rm(staged, { force: true });
    }
  });
  return copied;
}

/** Индекс store хоста: пакеты по integrity и перенос записи в сборочный store. */
interface HostIndex {
  find(integrity: string): Promise<HostPackage[]>;
  /** Пакет уже в сборочном store (основа). */
  present(integrity: string): Promise<boolean>;
  close(): void;
}

function indexV10(host: string, target: string): HostIndex {
  const dirOf = (integrity: string) => {
    const hex = hexOf(integrity);
    return { dir: join('index', hex.slice(0, 2)), prefix: hex.slice(2, 64) + '-' };
  };
  const entries = async (root: string, integrity: string) => {
    const { dir, prefix } = dirOf(integrity);
    const names = await readdir(join(root, dir)).catch(() => [] as string[]);
    return names
      .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
      .map((n) => join(dir, n));
  };
  return {
    async find(integrity) {
      const out: HostPackage[] = [];
      for (const rel of await entries(host, integrity)) {
        const raw = await readFile(join(host, rel)).catch(() => undefined);
        if (!raw) continue;
        let files: IndexedFile[] | undefined;
        let text: string | undefined;
        try {
          const entry = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          files = filesOf(entry, digestV10);
          // В seed — запись без результатов сборки хоста: их файлы не импортируются.
          if (files && hasSideEffects(entry)) {
            delete entry.sideEffects;
            text = JSON.stringify(entry);
          }
        } catch {
          files = undefined;
        }
        if (!files) continue;
        const body = text ?? raw;
        out.push({
          name: basename(rel, '.json').slice(63),
          files,
          async commit() {
            await mkdir(dirname(join(target, rel)), { recursive: true });
            const staged = join(target, rel) + '.tmp';
            await rm(staged, { force: true });
            await writeFile(staged, body, { mode: 0o644 });
            await rename(staged, join(target, rel));
          },
        });
      }
      return out;
    },
    async present(integrity) {
      return (await entries(target, integrity)).length > 0;
    },
    close() {},
  };
}

async function indexV11(
  host: string,
  target: string,
  scratch: string,
  skipped: { count: number },
): Promise<HostIndex> {
  // Индекс хоста не открывается на месте: SQLite пишет рядом `-shm` даже при чтении.
  await mkdir(scratch, { recursive: true });
  const copy = join(scratch, 'index.db');
  await copyFile(join(host, 'index.db'), copy);
  await copyFile(join(host, 'index.db-wal'), copy + '-wal').catch(() => undefined);
  const source = new DatabaseSync(copy);
  let dest: DatabaseSync | undefined;
  const destPath = join(target, 'index.db');
  const created = !(await lstat(destPath).catch(() => undefined));
  try {
    const tables = source
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('package_index', 'package_index_alias')",
      )
      .all() as { name: string; sql: string }[];
    if (!tables.some((t) => t.name === 'package_index'))
      throw new Error('в index.db нет таблицы package_index');
    await mkdir(target, { recursive: true });
    dest = new DatabaseSync(destPath);
    const have = new Set(
      (
        dest.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((t) => t.name),
    );
    for (const t of tables) if (!have.has(t.name)) dest.exec(t.sql);
  } catch (error) {
    source.close();
    dest?.close();
    // База, созданная этим вызовом, без записей не остаётся в сборочном store.
    if (created) await rm(destPath, { force: true });
    throw error;
  }
  const db = dest;
  // Ключ записи — `<integrity>\t<имя>@<версия>`: диапазон по integrity.
  const range = (integrity: string) => [integrity + '\t', integrity + '\n'] as const;
  const select = source.prepare('SELECT key, data FROM package_index WHERE key >= ? AND key < ?');
  const exists = db.prepare('SELECT 1 FROM package_index WHERE key >= ? AND key < ? LIMIT 1');
  const insert = db.prepare('INSERT OR IGNORE INTO package_index (key, data) VALUES (?, ?)');
  const aliases = tablesHaveAlias(source) && tablesHaveAlias(db);
  const aliasOf = aliases
    ? source.prepare('SELECT key, target FROM package_index_alias WHERE target = ?')
    : undefined;
  const aliasInsert = aliases
    ? db.prepare('INSERT OR IGNORE INTO package_index_alias (key, target) VALUES (?, ?)')
    : undefined;
  return {
    find(integrity) {
      const rows = select.all(...range(integrity)) as { key: string; data: Uint8Array }[];
      const out: HostPackage[] = [];
      for (const row of rows) {
        let files: IndexedFile[] | undefined;
        try {
          const entry = decodeIndexRecord(row.data);
          // Запись msgpack с результатами сборки хоста не перекодируется: пакет
          // докачает pnpm fetch, как без хоста.
          if (hasSideEffects(entry)) {
            skipped.count++;
            continue;
          }
          files = filesOf(entry, digestV11);
        } catch {
          files = undefined;
        }
        if (!files) continue;
        out.push({
          name: row.key.slice(row.key.indexOf('\t') + 1),
          files,
          commit() {
            insert.run(row.key, row.data);
            for (const a of (aliasOf?.all(row.key) ?? []) as { key: string; target: string }[])
              aliasInsert?.run(a.key, a.target);
          },
        });
      }
      return Promise.resolve(out);
    },
    present(integrity) {
      return Promise.resolve(exists.get(...range(integrity)) !== undefined);
    },
    close() {
      source.close();
      db.close();
    },
  };
}

const tablesHaveAlias = (db: DatabaseSync) =>
  db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'package_index_alias'")
    .get() !== undefined;

/**
 * Импортировать пакеты lockfile из store хоста `host` (каталог формата, вида
 * `…/v11`) в сборочный store `store` (корень: каталог формата внутри него
 * получает то же имя). `scratch` — свободный каталог сборки для копии индекса.
 * Неподдерживаемый формат или непонятый индекс — исключение с причиной.
 */
export async function importHostStore(input: {
  host: string;
  store: string;
  lock: string;
  scratch: string;
  signal: AbortSignal;
}): Promise<HostImport> {
  const layout = basename(input.host);
  const target = join(input.store, layout);
  const integrities = lockIntegrities(input.lock);
  const result: HostImport = { packages: integrities.length, host: 0, present: 0, files: 0 };
  if (!integrities.length) return result;
  if (layout !== 'v11' && layout !== 'v10')
    throw new Error(`формат store ${layout} не поддерживается импортом`);
  const rejected: string[] = [];
  const skipped = { count: 0 };
  let index: HostIndex | undefined;
  try {
    index =
      layout === 'v11'
        ? await indexV11(input.host, target, input.scratch, skipped)
        : indexV10(input.host, target);
    const opened = index;
    await within(integrities, FILE_CONCURRENCY, async (integrity) => {
      input.signal.throwIfAborted();
      if (await opened.present(integrity)) {
        result.present++;
        return;
      }
      const found = await opened.find(integrity);
      let imported = false;
      for (const pkg of found) {
        try {
          // Не `+= await`: левая часть читалась бы до ожидания, и параллельные копии терялись.
          const copied = await copyFiles(input.host, target, pkg, input.signal);
          await pkg.commit();
          result.files += copied;
          imported = true;
        } catch (error) {
          if (!(error instanceof Rejected)) throw error;
          if (rejected.length < MAX_REJECTED) rejected.push(error.message);
        }
      }
      if (imported) result.host++;
    });
  } finally {
    index?.close();
    await rm(input.scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  if (rejected.length) result.rejected = rejected;
  if (skipped.count) result.sideEffects = skipped.count;
  return result;
}
