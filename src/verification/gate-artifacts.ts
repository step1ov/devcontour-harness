import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import {
  gateArtifactExtensions,
  gateArtifactLimits,
  sha256,
  type GateArtifactFiles,
} from '../contracts/index.ts';
import type { Redactor } from '../environment/redaction.ts';

type Skip = GateArtifactFiles['skipped'][number];
type Limits = { -readonly [K in keyof typeof gateArtifactLimits]: number };

/** Текстовые расширения: в копии маскируются секреты окружения, как в логе gate. */
const textExtensions = new Set(['.json', '.txt', '.xml', '.log']);
const allowed = new Set<string>(gateArtifactExtensions);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const inside = (path: string, root: string) => path.startsWith(root + sep);

/** Реальный путь, даже если хвоста ещё нет: ближайший существующий предок разрешается. */
async function realTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await realTarget(parent), basename(absolute));
  }
}

/**
 * Секрет в байтах не текстового файла. Изображение не переписывается (маска
 * испортила бы его), поэтому такой файл не копируется. Формы секрета — те же,
 * что маскирует redactor (`secrets`); у redactor без них — его же проверка
 * по байтам, прочитанным как UTF-8 и как latin1.
 */
function binaryHasSecret(bytes: Buffer, redact: Redactor): boolean {
  if (redact.secrets)
    return redact.secrets.some(
      (secret) =>
        secret.length > 0 &&
        (bytes.includes(Buffer.from(secret, 'utf8')) ||
          bytes.includes(Buffer.from(secret, 'utf16le'))),
    );
  for (const encoding of ['utf8', 'latin1'] as const) {
    const text = bytes.toString(encoding);
    if (redact(text) !== text) return true;
  }
  return false;
}

/** Объявленные пути без повторов и без путей внутри уже объявленного каталога. */
function declaredRoots(paths: readonly string[]) {
  const unique = [...new Set(paths.map((p) => p.replace(/\/+$/, '')))];
  return unique.filter((p) => !unique.some((other) => other !== p && p.startsWith(other + '/')));
}

/**
 * Сохранить artifacts gate в `dest` и описать результат для evidence.
 *
 * Пути — относительно корня дерева `root`; каталог обходится в порядке имён
 * в пределах `scan` записей. Ссылки не разыменовываются ни в объявленном
 * пути, ни в его компонентах, ни внутри каталога: такой путь записывается как
 * `symlink`. Копируются только обычные файлы с одной жёсткой ссылкой и с
 * разрешёнными расширениями в пределах `gateArtifactLimits`; файл,
 * разрешающийся вне дерева или подменённый между обходом и чтением, не
 * копируется. Всё прочее и всякий отказ чтения или записи записываются в
 * `skipped` с причиной. Функция не бросает: исход gate от сохранения не
 * зависит, а отказ сохранения остаётся в evidence.
 *
 * `dest` принадлежит harness: прежние копии того же gate удаляются, чтобы
 * они не выдали себя за результат этого запуска. Каталог, совпадающий с
 * деревом, содержащий его или лежащий внутри него, отклоняется до удаления.
 */
export async function keepGateArtifacts(options: {
  root: string;
  paths: readonly string[];
  dest: string;
  redact: Redactor;
  signal?: AbortSignal;
  /** Только для тестов: меньшие пределы. */
  limits?: Partial<Limits>;
  /** Только для тестов: вызывается перед посещением каждого пути. */
  beforeVisit?: (rel: string) => Promise<void> | void;
}): Promise<GateArtifactFiles> {
  const { redact, signal } = options;
  const paths = declaredRoots(options.paths);
  const limits: Limits = { ...gateArtifactLimits, ...options.limits };
  const files: GateArtifactFiles['files'] = [];
  const skipped: Skip[] = [];
  let skippedMore = 0,
    total = 0,
    scanned = 0,
    stopped = false;
  const skip = (path: string, reason: Skip['reason'], detail?: string) => {
    if (skipped.length >= limits.skipped) {
      skippedMore++;
      return;
    }
    skipped.push({
      path: redact(path).slice(0, 1000) || '.',
      reason,
      ...(detail ? { detail: redact(detail).slice(0, 500) } : {}),
    });
  };
  let root: string, dest: string;
  try {
    root = await realpath(options.root);
    // Удаляется только свой каталог копий: никогда не дерево, не его предок и
    // не каталог внутри него. Сравниваются реальные пути (/var и /private/var).
    dest = await realTarget(options.dest);
    if (dest === root || inside(root, dest) || inside(dest, root))
      throw new Error('каталог копий artifacts пересекается с деревом проверки');
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
  } catch (error) {
    for (const path of paths) skip(path, 'copy-failed', message(error));
    return { dir: options.dest, files, skipped, ...(skippedMore ? { skippedMore } : {}) };
  }

  const read = async (rel: string, abs: string, seen: { dev: number; ino: number }) => {
    // Каталог-предок мог быть подменён ссылкой после обхода: копия берётся
    // только из пути, который и сейчас разрешается внутрь дерева.
    const real = await realpath(abs);
    if (!inside(real, root)) return 'outside' as const;
    const handle = await open(
      real,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return 'not-regular' as const;
      // Жёсткая ссылка на файл вне дерева неотличима от своего файла по пути.
      if (stat.nlink > 1) return 'hardlink' as const;
      if (stat.dev !== seen.dev || stat.ino !== seen.ino) return 'outside' as const;
      if (stat.size > limits.fileBytes) return 'file-limit' as const;
      const buffer = Buffer.allocUnsafe(Math.min(stat.size, limits.fileBytes) + 1);
      let size = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > limits.fileBytes) return 'file-limit' as const;
        // Файл вырос после stat: копия была бы не тем, что описано.
        if (size === buffer.length) throw new Error('файл изменился при чтении');
      }
      // Прочитано то же, что найдено обходом: путь и теперь ведёт к этому файлу.
      const after = await lstat(abs);
      if (after.dev !== stat.dev || after.ino !== stat.ino) return 'outside' as const;
      return Buffer.from(buffer.subarray(0, size));
    } finally {
      await handle.close();
    }
  };

  const copy = async (rel: string, abs: string, seen: { dev: number; ino: number }) => {
    if (!allowed.has(extname(rel).toLowerCase())) return skip(rel, 'extension');
    // Имя копии на диске равно пути в evidence: путь с секретом не сохраняется.
    if (redact(rel) !== rel) return skip(rel, 'secret');
    if (files.length >= limits.files) return skip(rel, 'count-limit');
    let bytes: Buffer;
    try {
      const result = await read(rel, abs, seen);
      if (!Buffer.isBuffer(result)) return skip(rel, result);
      bytes = result;
    } catch (error) {
      return skip(rel, 'copy-failed', message(error));
    }
    let redacted = false;
    if (textExtensions.has(extname(rel).toLowerCase())) {
      const text = bytes.toString('utf8');
      const masked = redact(text);
      if (masked !== text) {
        bytes = Buffer.from(masked);
        redacted = true;
      }
    } else if (binaryHasSecret(bytes, redact)) return skip(rel, 'secret');
    if (bytes.length > limits.fileBytes) return skip(rel, 'file-limit');
    if (total + bytes.length > limits.totalBytes) return skip(rel, 'total-limit');
    try {
      const target = join(dest, ...rel.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx' });
    } catch (error) {
      return skip(rel, 'copy-failed', message(error));
    }
    total += bytes.length;
    files.push({
      path: rel,
      sha256: sha256(bytes),
      bytes: bytes.length,
      ...(redacted ? { redacted: true as const } : {}),
    });
  };

  const visit = async (rel: string, abs: string): Promise<void> => {
    if (signal?.aborted) return skip(rel, 'copy-failed', 'проверка отменена');
    await options.beforeVisit?.(rel);
    let info;
    try {
      info = await lstat(abs);
    } catch (error) {
      return skip(rel, 'copy-failed', message(error));
    }
    if (info.isSymbolicLink()) return skip(rel, 'symlink');
    if (info.isFile()) return copy(rel, abs, info);
    if (!info.isDirectory()) return skip(rel, 'not-regular');
    // Записи читаются только до предела обхода: огромный каталог не
    // перечисляется целиком. Прочитанное посещается в порядке имён.
    const names: string[] = [];
    try {
      const handle = await opendir(abs);
      try {
        for await (const entry of handle) {
          if (scanned >= limits.scan) {
            stopped = true;
            skip(rel, 'scan-limit', `обход остановлен после ${limits.scan} записей`);
            break;
          }
          scanned++;
          names.push(entry.name);
        }
      } finally {
        // Прерванный for await уже закрыл каталог; повторное закрытие — не ошибка.
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      return skip(rel, 'copy-failed', message(error));
    }
    for (const name of names.sort()) await visit(`${rel}/${name}`, join(abs, name));
  };

  for (const rel of paths) {
    if (stopped) {
      skip(rel, 'scan-limit', `обход остановлен после ${limits.scan} записей`);
      continue;
    }
    const abs = resolve(root, rel);
    if (!inside(abs, root)) {
      skip(rel, 'outside');
      continue;
    }
    // Компоненты пути проверяются по одному: ссылка на любом уровне могла бы
    // увести копирование за пределы дерева.
    const parts = rel.split('/');
    let blocked: Skip['reason'] | undefined, detail: string | undefined;
    for (let i = 1; i <= parts.length && !blocked; i++) {
      try {
        const info = await lstat(join(root, ...parts.slice(0, i)));
        if (info.isSymbolicLink()) blocked = 'symlink';
        else if (i < parts.length && !info.isDirectory()) blocked = 'missing';
      } catch (error) {
        blocked = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'copy-failed';
        detail = blocked === 'copy-failed' ? message(error) : undefined;
      }
    }
    if (blocked) {
      skip(rel, blocked, detail);
      continue;
    }
    await visit(rel, abs);
  }
  return { dir: dest, files, skipped, ...(skippedMore ? { skippedMore } : {}) };
}
