import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  API_VERSION,
  HarnessError,
  sha256,
  sourceDigest,
  workGraphSchema,
  type ContextSnapshot,
  type ContextSource,
  type DeliveryOutcome,
  type Prerequisite,
  type ResultSink,
  type RunResult,
  type WorkGraph,
  type WorkSource,
} from '../contracts/index.ts';

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new HarnessError('INVALID_INPUT', `${path}: ${(error as Error).message}`);
  }
};

/**
 * Источник поручений из файла `WorkGraph`. Редакция — `source.revision`
 * графа; повторное чтение той же редакции даёт тот же граф. Внешним
 * receipts файловый источник не доверяет.
 */
export class FileWorkSource implements WorkSource {
  readonly id = 'files';
  fetch(path: string) {
    const parsed = workGraphSchema.safeParse(readJson(path));
    if (!parsed.success)
      throw new HarnessError(
        'INVALID_INPUT',
        'graph: вход не прошёл проверку схемы',
        parsed.error.issues.map((i) => ({
          path: ['graph', ...(i.path as (string | number)[])],
          message: i.message,
        })),
      );
    return Promise.resolve({ graph: parsed.data, source: parsed.data.source });
  }
  revision(path: string) {
    if (!existsSync(path)) return Promise.resolve(undefined);
    const graph = workGraphSchema.safeParse(readJson(path));
    return Promise.resolve(graph.success ? graph.data.source.revision : undefined);
  }
  trusts(prerequisite: Prerequisite) {
    void prerequisite;
    return Promise.resolve(false);
  }
}

/** Файлы источника контекста: обычные файлы внутри каталога, без symlink, по порядку пути. */
function filesOf(root: string) {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink())
        throw new HarnessError(
          'INVALID_INPUT',
          'Контекст не читается через symlink: ' + relative(root, path),
        );
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  walk(root);
  return out;
}

/**
 * Контекст из каталога: источник `<id>` — каталог `<dir>/<id>`, его файлы
 * вкладываются содержимым и закрепляются SHA-256. Каталог `references/`
 * внутри источника — справки: закреплены, но не вкладываются в запрос.
 * Отсутствующий каталог обязательного источника — отказ, а не пустой
 * контекст.
 */
export class FileContextSource implements ContextSource {
  readonly id = 'files';
  constructor(readonly dir: string) {}
  snapshot(ids: string[]): Promise<ContextSnapshot> {
    const base = realpathSync(this.dir);
    const sources = [...new Set(ids)].map((id) => {
      const root = resolve(base, id);
      if (root.startsWith(base + sep) && existsSync(root) && lstatSync(root).isSymbolicLink())
        throw new HarnessError('INVALID_INPUT', `Контекст не читается через symlink: ${id}`);
      if (!root.startsWith(base + sep) || !existsSync(root) || !lstatSync(root).isDirectory())
        throw new HarnessError('NOT_READY', `Источник контекста ${id} не найден в ${this.dir}`);
      const pin = (path: string) => {
        const bytes = readFileSync(path);
        const text = bytes.toString('utf8');
        const utf8 = Buffer.from(text, 'utf8').equals(bytes);
        return {
          path: relative(root, path).split(sep).join('/'),
          digest: sha256(bytes),
          bytes: bytes.length,
          content: utf8
            ? { encoding: 'utf8' as const, data: text }
            : { encoding: 'base64' as const, data: bytes.toString('base64') },
        };
      };
      const all = filesOf(root).map(pin);
      const entry = {
        id,
        kind: 'files',
        version: '1',
        required: true,
        files: all.filter((f) => !f.path.startsWith('references/')),
        references: all.filter((f) => f.path.startsWith('references/')),
      };
      return { ...entry, digest: sourceDigest(entry) };
    });
    return Promise.resolve({ apiVersion: API_VERSION, sources, missing: [] });
  }
}

/**
 * Получатель результата — каталог: `<dir>/<workId>.json`. Доставка
 * идемпотентна по ключу: тот же ключ — та же запись, без второй. Если
 * источник уже в другой редакции, чем та, к которой относится результат,
 * результат не закрывает её: `conflict`.
 */
export class FileResultSink implements ResultSink {
  readonly id = 'files';
  constructor(
    readonly dir: string,
    readonly currentRevision: (result: RunResult) => Promise<string | undefined>,
  ) {}
  async deliver({ key, result }: { key: string; result: RunResult }): Promise<DeliveryOutcome> {
    const current = await this.currentRevision(result);
    if (current !== undefined && current !== result.source.revision)
      return { status: 'conflict', currentRevision: current };
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${result.workOrderId}.json`);
    const existing = existsSync(file)
      ? (JSON.parse(await readFile(file, 'utf8')) as { key?: string })
      : undefined;
    if (existing?.key === key) return { status: 'delivered', receipt: file };
    const temp = file + '.' + process.pid + '.tmp';
    await writeFile(temp, JSON.stringify({ key, result }, null, 2) + '\n');
    await rename(temp, file);
    return { status: 'delivered', receipt: file };
  }
}

export type { WorkGraph };
