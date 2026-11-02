import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import {
  gateArtifactExtensions,
  gateArtifactLimits,
  sha256,
  type GateArtifactFiles,
} from '../contracts/index.ts';
import { OversizedFile, readBoundedBytes } from '../environment/bounded-read.ts';

type Skip = GateArtifactFiles['skipped'][number];
type Limits = { -readonly [K in keyof typeof gateArtifactLimits]: number };

/** Текстовые расширения: в копии маскируются секреты окружения, как в логе gate. */
const textExtensions = new Set(['.json', '.txt', '.xml', '.log']);
const allowed = new Set<string>(gateArtifactExtensions);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Сохранить artifacts gate в `dest` и описать результат для evidence.
 *
 * Пути — относительно корня дерева `root`; каталог обходится целиком в
 * порядке имён. Ссылки не разыменовываются ни в объявленном пути, ни в его
 * компонентах, ни внутри каталога: такой путь записывается как `symlink`.
 * Копируются только обычные файлы с разрешёнными расширениями в пределах
 * `gateArtifactLimits`; всё прочее и всякий отказ чтения или записи
 * записываются в `skipped` с причиной. Функция не бросает: исход gate от
 * сохранения не зависит, а отказ сохранения остаётся в evidence.
 *
 * `dest` принадлежит harness: прежние копии того же gate удаляются, чтобы
 * они не выдали себя за результат этого запуска.
 */
export async function keepGateArtifacts(options: {
  root: string;
  paths: readonly string[];
  dest: string;
  redact: (value: string) => string;
  /** Только для тестов: меньшие пределы. */
  limits?: Partial<Limits>;
}): Promise<GateArtifactFiles> {
  const { paths, dest, redact } = options;
  const limits: Limits = { ...gateArtifactLimits, ...options.limits };
  const files: GateArtifactFiles['files'] = [];
  const skipped: Skip[] = [];
  let skippedMore = 0,
    total = 0,
    scanned = 0;
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
  let root: string;
  try {
    root = await realpath(options.root);
    // Удаляется только свой каталог копий: никогда не дерево и не его предок.
    if (resolve(dest) === root || root.startsWith(resolve(dest) + sep))
      throw new Error('каталог копий artifacts совпадает с деревом или содержит его');
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
  } catch (error) {
    for (const path of paths) skip(path, 'copy-failed', message(error));
    return result();
  }

  const copy = async (rel: string, abs: string) => {
    if (!allowed.has(extname(rel).toLowerCase())) return skip(rel, 'extension');
    if (files.length >= limits.files) return skip(rel, 'count-limit');
    let bytes: Buffer;
    try {
      // Каталог-предок мог быть подменён ссылкой после обхода: копия берётся
      // только из пути, который и сейчас разрешается внутрь дерева.
      const real = await realpath(abs);
      if (!real.startsWith(root + sep)) return skip(rel, 'outside');
      bytes = await readBoundedBytes(real, limits.fileBytes);
    } catch (error) {
      if (error instanceof OversizedFile) return skip(rel, 'file-limit');
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
    }
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
      path: redact(rel),
      sha256: sha256(bytes),
      bytes: bytes.length,
      ...(redacted ? { redacted: true as const } : {}),
    });
  };

  const visit = async (rel: string, abs: string): Promise<void> => {
    if (++scanned > limits.scan) return skip(rel, 'scan-limit');
    let info;
    try {
      info = await lstat(abs);
    } catch (error) {
      return skip(rel, 'copy-failed', message(error));
    }
    if (info.isSymbolicLink()) return skip(rel, 'symlink');
    if (info.isFile()) return copy(rel, abs);
    if (!info.isDirectory()) return skip(rel, 'not-regular');
    let names: string[];
    try {
      names = (await readdir(abs)).sort();
    } catch (error) {
      return skip(rel, 'copy-failed', message(error));
    }
    for (const name of names) await visit(`${rel}/${name}`, join(abs, name));
  };

  for (const declared of paths) {
    const rel = declared.replace(/\/+$/, '');
    const abs = resolve(root, rel);
    if (!abs.startsWith(root + sep)) {
      skip(declared, 'outside');
      continue;
    }
    // Компоненты пути проверяются по одному: ссылка на любом уровне могла бы
    // увести копирование за пределы дерева.
    const parts = rel.split('/');
    let blocked: Skip['reason'] | undefined, detail: string | undefined;
    for (let i = 1; i < parts.length && !blocked; i++) {
      try {
        const info = await lstat(join(root, ...parts.slice(0, i)));
        if (info.isSymbolicLink()) blocked = 'symlink';
        else if (!info.isDirectory()) blocked = 'missing';
      } catch (error) {
        blocked = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'copy-failed';
        detail = blocked === 'copy-failed' ? message(error) : undefined;
      }
    }
    if (!blocked)
      try {
        await lstat(abs);
      } catch (error) {
        blocked = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'copy-failed';
        detail = blocked === 'copy-failed' ? message(error) : undefined;
      }
    if (blocked) {
      skip(declared, blocked, detail);
      continue;
    }
    await visit(rel, abs);
  }
  return result();

  function result(): GateArtifactFiles {
    return { dir: dest, files, skipped, ...(skippedMore ? { skippedMore } : {}) };
  }
}
