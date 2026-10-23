/**
 * A01: реализации портов в форме публичных типов devcontour-harness
 * 0.1.0-alpha.5 — так, как их написал бы прежний потребитель. Здесь нет ни
 * одного поля или метода, добавленного после alpha.5: получатель знает только
 * `delivered`/`conflict`, хост — только обязательные части `ExecutionHost`,
 * хранилище — только четыре метода `ExecutionStore`. Импорт только из корня
 * пакета: Relay, память и toolchains не подключаются.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  API_VERSION,
  HarnessError,
  SqliteExecutionStore,
  digestOf,
  executionDigest,
  sha256,
  sourceDigest,
  workGraphSchema,
  type ContextSnapshot,
  type ContextSource,
  type DeliveryOutcome,
  type ExecutionHost,
  type ExecutionPolicy,
  type ExecutionStore,
  type ExecutionTransaction,
  type ExecutionView,
  type NotPromise,
  type Prerequisite,
  type ResultSink,
  type RunEvent,
  type RunResult,
  type SourceRef,
  type TransactionKind,
  type WorkGraph,
  type WorkSource,
} from 'devcontour-harness';

/** Источник поручений: файл графа; редакция — `source.revision`. */
export class LegacyFileWorkSource implements WorkSource {
  readonly id = 'files';
  fetch(ref: string): Promise<{ graph: WorkGraph; source: SourceRef }> {
    const graph = workGraphSchema.parse(JSON.parse(readFileSync(ref, 'utf8')));
    return Promise.resolve({ graph, source: graph.source });
  }
  revision(ref: string): Promise<string | undefined> {
    if (!existsSync(ref)) return Promise.resolve(undefined);
    const parsed = workGraphSchema.safeParse(JSON.parse(readFileSync(ref, 'utf8')));
    return Promise.resolve(parsed.success ? parsed.data.source.revision : undefined);
  }
  trusts(prerequisite: Prerequisite): Promise<boolean> {
    void prerequisite;
    return Promise.resolve(false);
  }
}

/** Контекст: подкаталог `<dir>/<id>`, все файлы вкладываются содержимым. */
export class LegacyDirContextSource implements ContextSource {
  readonly id = 'legacy-dir';
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  snapshot(ids: string[], at?: { repositoryId: string; sha?: string }): Promise<ContextSnapshot> {
    void at;
    const base = realpathSync(this.dir);
    const sources = [...new Set(ids)].map((id) => {
      const root = resolve(base, id);
      if (!existsSync(root) || !lstatSync(root).isDirectory())
        throw new HarnessError('NOT_READY', 'нет контекста ' + id);
      const files = readdirSync(root, { recursive: true })
        .map(String)
        .sort()
        .map((name) => join(root, name))
        .filter((path) => lstatSync(path).isFile())
        .map((path) => {
          const bytes = readFileSync(path);
          return {
            path: relative(root, path).split(sep).join('/'),
            digest: sha256(bytes),
            bytes: bytes.length,
            content: { encoding: 'utf8' as const, data: bytes.toString('utf8') },
          };
        });
      const entry = { id, kind: 'files', version: '1', required: true, files, references: [] };
      return { ...entry, digest: sourceDigest(entry) };
    });
    return Promise.resolve({ apiVersion: API_VERSION, sources, missing: [] });
  }
}

/**
 * Получатель-каталог в форме alpha.5: `delivered` или `conflict`, никакого
 * `uncertain`. Повтор с тем же ключом не пишет вторую запись.
 */
export class LegacyFileSink implements ResultSink {
  readonly id = 'legacy-file';
  readonly dir: string;
  readonly current: (result: RunResult) => Promise<string | undefined>;
  writes = 0;
  constructor(dir: string, current: (result: RunResult) => Promise<string | undefined>) {
    this.dir = dir;
    this.current = current;
  }
  async deliver(input: { key: string; result: RunResult }): Promise<DeliveryOutcome> {
    const revision = await this.current(input.result);
    if (revision !== undefined && revision !== input.result.source.revision)
      return { status: 'conflict', currentRevision: revision };
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, input.result.workOrderId + '.json');
    const prior = existsSync(file)
      ? (JSON.parse(await readFile(file, 'utf8')) as { key: string })
      : undefined;
    if (prior?.key === input.key) return { status: 'delivered', receipt: file };
    await writeFile(file + '.tmp', JSON.stringify({ key: input.key, result: input.result }));
    await rename(file + '.tmp', file);
    this.writes++;
    return { status: 'delivered', receipt: file };
  }
}

/**
 * Хранилище хоста alpha.5: только `stateVersion`, `transact`, `read`,
 * `events`, `close` — поверх SQLite пакета (делегирование, не наследование:
 * движок видит ровно интерфейс порта).
 */
export class LegacyStore implements ExecutionStore {
  readonly inner: SqliteExecutionStore;
  readonly stateVersion: number;
  transactions = 0;
  constructor(file: string, owner: string) {
    this.inner = new SqliteExecutionStore(file, owner);
    this.stateVersion = this.inner.stateVersion;
  }
  transact<T>(kind: TransactionKind, fn: (tx: ExecutionTransaction) => NotPromise<T>): T {
    this.transactions++;
    return this.inner.transact(kind, fn);
  }
  read<T>(fn: (view: ExecutionView) => NotPromise<T>): T {
    return this.inner.read(fn);
  }
  events(after?: number, limit?: number): RunEvent[] {
    return this.inner.events(after, limit);
  }
  close(): void {
    this.inner.close();
  }
}

/**
 * Хост alpha.5: обязательные `store`, `basis` (три digest), `guards` (четыре
 * условия), `budgets` и версия потребителя. Необязательных портов нет.
 */
export function legacyHost(store: ExecutionStore, policy: ExecutionPolicy): ExecutionHost {
  const policyDigest = executionDigest(policy);
  return {
    store,
    consumerVersion: 'consumer-alpha5@0.0.0',
    basis: {
      orderDigest: (work) => digestOf(work.order),
      scopeDigest: (work) =>
        digestOf({ gates: work.order.gates ?? null, consumers: work.order.consumers ?? null }),
      policyDigest: () => policyDigest,
    },
    guards: {
      claimable: () => null,
      claimBarrier: () => null,
      current: () => null,
      beforeAccept: () => null,
    },
    budgets: {
      groupOf: (workId, view) => view.work(workId)?.graphId,
      members: (groupId, view) => view.works(groupId).map((w) => w.id),
      legacy: () => ({}),
    },
  };
}
