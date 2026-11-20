import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  openSync,
  readSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '../contracts/index.ts';

/**
 * Копия каталога состояния перед обновлением и её возврат.
 *
 * База SQLite копируется согласованным снимком (`VACUUM INTO`), без `-wal`,
 * `-shm` и `-journal`; прочие файлы — как есть, symlink — symlink. Рабочие
 * деревья попыток (`worktrees/`, каталоги с `.git`) не копируются: это
 * checkouts Git, их восстанавливает сам harness. Список файлов с SHA-256 —
 * `manifest.json` копии; его digest — контрольная сумма копии. Возврат
 * сначала сверяет каждую сумму и только потом трогает живой каталог; живые
 * файлы не удаляются, а переносятся в `replaced` рядом с копиями.
 */

interface Entry {
  path: string;
  kind: 'file' | 'sqlite' | 'symlink';
  sha256: string;
  target?: string;
}
export interface StateCopy {
  path: string;
  digest: string;
  files: number;
}

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const skippedFile = (name: string) =>
  name.endsWith('-wal') || name.endsWith('-shm') || name.endsWith('-journal');

function walk(root: string, rel = ''): { rel: string; abs: string }[] {
  const dir = join(root, rel);
  const out: { rel: string; abs: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const r = rel ? join(rel, e.name) : e.name;
    const abs = join(root, r);
    if (e.isDirectory()) {
      if (!rel && e.name === 'worktrees') continue;
      if (existsSync(join(abs, '.git'))) continue;
      out.push(...walk(root, r));
    } else if (e.isSymbolicLink() || e.isFile()) {
      if (skippedFile(e.name)) continue;
      out.push({ rel: r, abs });
    }
  }
  return out;
}

/** База SQLite — по заголовку файла, не по имени. */
const isDatabase = (file: string) => {
  try {
    const fd = openSync(file, 'r');
    try {
      const head = Buffer.alloc(16);
      readSync(fd, head, 0, 16, 0);
      return head.toString('latin1') === 'SQLite format 3\0';
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
};

/** Служебные файлы баз (-wal, -shm, -journal) на любой глубине, кроме рабочих деревьев. */
function journals(root: string, rel = ''): string[] {
  const dir = join(root, rel);
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (!rel && e.name === 'worktrees') continue;
      if (existsSync(join(root, r, '.git'))) continue;
      out.push(...journals(root, r));
    } else if (skippedFile(e.name)) out.push(r);
  }
  return out;
}

/** Скопировать каталог состояния в `target` (каталог создаётся, должен быть новым). */
export function copyState(stateDir: string, target: string): StateCopy {
  if (existsSync(target))
    throw new HarnessError('PATH_CONFLICT', 'Каталог копии состояния уже существует: ' + target);
  mkdirSync(join(target, 'files'), { recursive: true });
  const entries: Entry[] = [];
  if (existsSync(stateDir))
    for (const f of walk(stateDir)) {
      const dest = join(target, 'files', f.rel);
      mkdirSync(dirname(dest), { recursive: true });
      const st = lstatSync(f.abs);
      if (st.isSymbolicLink()) {
        const link = readlinkSync(f.abs);
        symlinkSync(link, dest);
        entries.push({ path: f.rel, kind: 'symlink', sha256: sha(link), target: link });
      } else if (isDatabase(f.abs)) {
        const db = new DatabaseSync(f.abs, { readOnly: true });
        try {
          db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
        } finally {
          db.close();
        }
        entries.push({ path: f.rel, kind: 'sqlite', sha256: sha(readFileSync(dest)) });
      } else {
        copyFileSync(f.abs, dest);
        entries.push({ path: f.rel, kind: 'file', sha256: sha(readFileSync(dest)) });
      }
    }
  const manifest = JSON.stringify({ stateDir: resolve(stateDir), entries }, null, 2);
  writeFileSync(join(target, 'manifest.json'), manifest);
  const digest = sha(manifest);
  writeFileSync(join(target, 'digest'), digest + '\n');
  return { path: target, digest, files: entries.length };
}

/** Сверить копию: digest списка и SHA-256 каждого файла. Отказ — с первым расхождением. */
export function verifyCopy(copy: string, digest?: string): Entry[] {
  const manifestPath = join(copy, 'manifest.json');
  if (!existsSync(manifestPath))
    throw new HarnessError('NOT_FOUND', 'Копия состояния не найдена: ' + copy);
  const manifest = readFileSync(manifestPath, 'utf8');
  const expected = digest ?? readFileSync(join(copy, 'digest'), 'utf8').trim();
  if (sha(manifest) !== expected)
    throw new HarnessError(
      'STATE_VERSION_UNSUPPORTED',
      'Копия состояния повреждена: digest списка не совпал',
    );
  const { entries } = JSON.parse(manifest) as { entries: Entry[] };
  for (const e of entries) {
    const file = join(copy, 'files', e.path);
    const actual = e.kind === 'symlink' ? sha(readlinkSync(file)) : sha(readFileSync(file));
    if (actual !== e.sha256)
      throw new HarnessError(
        'STATE_VERSION_UNSUPPORTED',
        `Копия состояния повреждена: ${e.path} не совпал с контрольной суммой`,
      );
  }
  return entries;
}

/**
 * Вернуть копию в каталог состояния без полусостояния: сверка копии и всех
 * путей; файлы копии сначала собираются во временный каталог рядом с
 * каталогом состояния (сбой — живые файлы не тронуты); затем живые файлы,
 * которые копия заменяет, и служебные файлы баз на любой глубине переносятся
 * в `aside`, а собранные — переименованием на их место. Сбой посреди
 * переноса возвращает перенесённое обратно. Рабочие деревья не трогаются.
 */
export function restoreState(stateDir: string, copy: string, aside: string, digest?: string) {
  const entries = verifyCopy(copy, digest);
  const root = resolve(stateDir);
  for (const e of entries) {
    const dest = resolve(root, e.path);
    if (!dest.startsWith(root + sep))
      throw new HarnessError('PATH_CONFLICT', 'Путь копии вне каталога состояния: ' + e.path);
  }
  const staging = `${root}.restore-${randomBytes(4).toString('hex')}`;
  mkdirSync(staging, { recursive: true });
  try {
    for (const e of entries) {
      const dest = join(staging, e.path);
      mkdirSync(dirname(dest), { recursive: true });
      if (e.kind === 'symlink') symlinkSync(e.target!, dest);
      else copyFileSync(join(copy, 'files', e.path), dest);
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const moved: { from: string; to: string }[] = [];
  const move = (from: string, to: string) => {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    moved.push({ from, to });
  };
  try {
    mkdirSync(aside, { recursive: true });
    if (existsSync(root)) {
      for (const f of walk(root)) move(f.abs, join(aside, f.rel));
      for (const j of journals(root)) move(join(root, j), join(aside, j));
    }
    mkdirSync(root, { recursive: true });
    for (const e of entries) {
      const dest = join(root, e.path);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(join(staging, e.path), dest);
    }
  } catch (error) {
    // Вернуть живые файлы на место: копия не встала, данные не теряются.
    for (const e of entries) {
      const dest = join(root, e.path);
      if (!existsSync(join(staging, e.path)) && existsSync(dest)) {
        try {
          renameSync(dest, join(staging, e.path));
        } catch {
          // оставить: перенос обратно ниже не перезапишет
        }
      }
    }
    for (const m of moved.reverse())
      try {
        renameSync(m.to, m.from);
      } catch {
        // остаётся в aside — путь назван в отказе
      }
    throw new HarnessError(
      'STATE_VERSION_UNSUPPORTED',
      `Возврат копии состояния не удался (${(error as Error).message}); живые файлы возвращены на место, что не вернулось — в ${aside}`,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { files: entries.length, aside };
}

/**
 * Отпечаток содержимого состояния: строки `meta`, `state`, `local`, номер
 * последнего события и суммы прочих файлов (без аренд — их продление не
 * меняет данных). Совпал — с момента копии состояние не менялось.
 */
export function stateFingerprint(stateDir: string): string {
  const h = createHash('sha256');
  if (!existsSync(stateDir)) return h.update('absent').digest('hex');
  for (const f of walk(stateDir)) {
    h.update(f.rel + '\0');
    const st = lstatSync(f.abs);
    if (st.isSymbolicLink()) h.update('link:' + readlinkSync(f.abs));
    else if (f.rel === 'state.sqlite') {
      const db = new DatabaseSync(f.abs, { readOnly: true });
      try {
        const all = (sql: string) => JSON.stringify(db.prepare(sql).all());
        h.update(all('SELECT key, value FROM meta ORDER BY key'));
        h.update(all('SELECT data FROM state'));
        h.update(all('SELECT max(seq) AS seq FROM events'));
        h.update(
          all('SELECT namespace, owner, key, data FROM local ORDER BY namespace, owner, key'),
        );
      } finally {
        db.close();
      }
    } else h.update(readFileSync(f.abs));
    h.update('\n');
  }
  return h.digest('hex');
}

/** Удалить каталог, только если он внутри `root` (каталог обновлений) и не сам `root`. */
export function removeInside(root: string, path: string) {
  const r = resolve(root);
  const p = resolve(path);
  const rel = relative(r, p);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(r, rel) !== p)
    throw new HarnessError('PATH_CONFLICT', 'Отказ удалить путь вне каталога обновлений: ' + path);
  rmSync(p, { recursive: true, force: true });
}
