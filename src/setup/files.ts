import type { Stats } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HarnessError, type ErrorIssue } from '../contracts/errors.ts';
import type { fileConflicts } from '../contracts/project.ts';

/**
 * Безопасная подготовка файлов: план → create-only применение. Ничего
 * существующего не перезаписывается, через symlink и вне корня не пишется.
 */

export type FileConflict = (typeof fileConflicts)[number];
export interface FileIntent {
  /** Абсолютный путь. */
  path: string;
  content: string;
  /** По умолчанию `preserve`. */
  onExisting?: 'preserve' | 'require-identical';
}
export interface FileWriteInput {
  files: FileIntent[];
  root?: string;
}
export interface FilePlanEntry {
  path: string;
  action: 'create' | 'preserve' | 'conflict';
  conflict?: FileConflict;
  /** Путь, вызвавший конфликт (symlink-предок, предок-файл). */
  conflictPath?: string;
}
export interface FilePlan {
  entries: FilePlanEntry[];
  conflicts: number;
  root?: string;
}

interface Found {
  conflict: FileConflict;
  path: string;
  conflictPath?: string;
}

const errnoOf = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Текст отказа по договору (h1-spec §1.1). */
function conflictMessage(found: Found): string {
  const at = found.conflictPath ?? found.path;
  switch (found.conflict) {
    case 'symlink':
      return `Setup не пишет через symlink: ${at}`;
    case 'ancestor-not-directory':
      return `Родитель не является каталогом: ${at}`;
    case 'outside-root':
      return `Путь вне корня проекта: ${found.path}`;
    case 'not-regular-file':
      return `Назначение не является обычным файлом: ${found.path}`;
    case 'content-differs':
      return `Файл уже существует с другим содержимым: ${found.path}`;
  }
}

const issueOf = (found: Found): ErrorIssue => ({
  path: [found.conflictPath ?? found.path],
  message: found.conflict,
});

function refuse(found: Found[]): never {
  const [first] = found;
  if (!first) throw new HarnessError('INTERNAL', 'Отказ без конфликтов');
  throw new HarnessError('PATH_CONFLICT', conflictMessage(first), found.map(issueOf));
}

/** `lstat`; отсутствующий путь — undefined, прочие ошибки — как есть. */
export async function inspectPath(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** Как `inspectPath`, но потомок файла (`ENOTDIR`) тоже отсутствует: отказ называет сам предок. */
async function inspectInWalk(path: string, follow = false): Promise<Stats | undefined> {
  try {
    return await (follow ? stat(path) : lstat(path));
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

const isWithin = (base: string, path: string) => {
  const rel = relative(base, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Корень, внутри которого лежит путь: сравнение по `resolve(root)` и по `realpath(root)`. */
async function baseOf(path: string, root: string): Promise<string | undefined> {
  const resolved = resolve(root);
  if (isWithin(resolved, path)) return resolved;
  let real: string;
  try {
    real = await realpath(resolved);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return undefined;
    throw error;
  }
  return isWithin(real, path) ? real : undefined;
}

/** Ближайший к пути конфликт назначения или undefined. */
async function destinationConflict(path: string, root?: string): Promise<Found | undefined> {
  const target = resolve(path);
  let base: string | undefined;
  if (root !== undefined) {
    base = await baseOf(target, root);
    if (base === undefined) return { conflict: 'outside-root', path: target };
  }
  let cursor = target;
  while (cursor !== base) {
    const info = await inspectInWalk(cursor);
    if (info?.isSymbolicLink()) return { conflict: 'symlink', path: target, conflictPath: cursor };
    if (info && cursor !== target && !info.isDirectory())
      return { conflict: 'ancestor-not-directory', path: target, conflictPath: cursor };
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (base !== undefined) {
    // Сам корень доверен (может быть symlink'ом), но обязан быть каталогом —
    // и тогда, когда назначение совпадает с корнем.
    const info = await inspectInWalk(base, true);
    if (info && !info.isDirectory())
      return { conflict: 'ancestor-not-directory', path: target, conflictPath: base };
  }
  return undefined;
}

/** Отказ PATH_CONFLICT, если путь или предок — symlink, предок не каталог или путь вне root. */
export async function checkDestination(path: string, options?: { root?: string }): Promise<void> {
  const found = await destinationConflict(path, options?.root);
  if (found) refuse([found]);
}

/** Относительные пути обычных файлов каталога (рекурсивно). */
export async function listRegularFiles(dir: string): Promise<string[]> {
  const walk = async (current: string, prefix: string): Promise<string[]> => {
    const result: string[] = [];
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = join(prefix, entry.name);
      if (entry.isDirectory()) result.push(...(await walk(join(current, entry.name), name)));
      else if (entry.isFile()) result.push(name);
      else
        throw new HarnessError('INVALID_INPUT', `Неподдерживаемый файл шаблона: ${name}`, [
          { path: [name], message: 'not-regular-file' },
        ]);
    }
    return result;
  };
  return walk(dir, '');
}

/** Абсолютность и уникальность путей — до обхода ФС. */
function validateIntents(files: FileIntent[]): void {
  const issues: ErrorIssue[] = [];
  const messages: string[] = [];
  const seen = new Set<string>();
  files.forEach((file, index) => {
    if (!isAbsolute(file.path)) {
      issues.push({ path: ['files', index, 'path'], message: 'not-absolute' });
      messages.push(`Путь файла должен быть абсолютным: ${file.path}`);
      return;
    }
    const key = resolve(file.path);
    if (seen.has(key)) {
      issues.push({ path: ['files', index, 'path'], message: 'duplicate' });
      messages.push(`Путь файла повторяется: ${file.path}`);
    }
    seen.add(key);
  });
  const [first] = messages;
  if (first !== undefined) throw new HarnessError('INVALID_INPUT', first, issues);
}

/** Существующее назначение: обычный файл (байты сверяются для `require-identical`) или конфликт. */
async function existingConflict(
  file: FileIntent,
  info: Stats,
  path: string,
): Promise<Found | undefined> {
  if (info.isSymbolicLink()) return { conflict: 'symlink', path, conflictPath: path };
  if (!info.isFile()) return { conflict: 'not-regular-file', path };
  if (
    file.onExisting === 'require-identical' &&
    !Buffer.from(file.content).equals(await readFile(path))
  )
    return { conflict: 'content-differs', path };
  return undefined;
}

/** План записей; конфликты не бросаются — агент видит их все сразу. */
export async function planFileWrites(input: FileWriteInput): Promise<FilePlan> {
  validateIntents(input.files);
  const entries: FilePlanEntry[] = [];
  for (const file of input.files) {
    const target = resolve(file.path);
    let found = await destinationConflict(target, input.root);
    let action: FilePlanEntry['action'] = 'create';
    if (!found) {
      const info = await inspectPath(target);
      if (info) {
        found = await existingConflict(file, info, target);
        action = 'preserve';
      }
    }
    if (found) {
      const entry: FilePlanEntry = {
        path: file.path,
        action: 'conflict',
        conflict: found.conflict,
      };
      if (found.conflictPath !== undefined) entry.conflictPath = found.conflictPath;
      entries.push(entry);
    } else entries.push({ path: file.path, action });
  }
  const plan: FilePlan = {
    entries,
    conflicts: entries.filter((e) => e.action === 'conflict').length,
  };
  if (input.root !== undefined) plan.root = input.root;
  return plan;
}

/** Применение плана: только создание, в порядке `files`. */
export async function applyFileWrites(
  plan: FilePlan,
  files: FileIntent[],
): Promise<{ created: string[]; preserved: string[] }> {
  validateIntents(files);
  const planned = new Set(plan.entries.map((e) => resolve(e.path)));
  const missing = files.findIndex((f) => !planned.has(resolve(f.path)));
  if (missing !== -1 || planned.size !== plan.entries.length || files.length !== planned.size) {
    throw new HarnessError('INVALID_INPUT', 'Состав файлов не соответствует плану', [
      { path: missing === -1 ? ['files'] : ['files', missing, 'path'], message: 'not-in-plan' },
    ]);
  }
  const conflicted = plan.entries.filter((e) => e.action === 'conflict');
  if (conflicted.length > 0 || plan.conflicts > 0) {
    if (conflicted.length === 0)
      throw new HarnessError('PATH_CONFLICT', `План содержит конфликты: ${plan.conflicts}`);
    refuse(
      conflicted.map((e) => {
        const found: Found = { conflict: e.conflict ?? 'not-regular-file', path: e.path };
        if (e.conflictPath !== undefined) found.conflictPath = e.conflictPath;
        return found;
      }),
    );
  }

  const created: string[] = [];
  const preserved: string[] = [];
  for (const file of files) {
    const target = resolve(file.path);
    // Повторная проверка непосредственно перед записью: назначение могло измениться после плана.
    const found = await destinationConflict(target, plan.root);
    if (found) refuse([found]);
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, file.content, { flag: 'wx' });
      created.push(file.path);
    } catch (error) {
      if (errnoOf(error) !== 'EEXIST') throw error;
      const info = await inspectPath(target);
      const existing = info && (await existingConflict(file, info, target));
      if (existing) refuse([existing]);
      preserved.push(file.path);
    }
  }
  return { created, preserved };
}
