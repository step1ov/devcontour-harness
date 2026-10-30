import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  API_VERSION,
  HarnessError,
  type Author,
  type ContextSnapshot,
  type ExecutionPolicy,
  type WorkGraph,
} from '../../contracts/index.ts';
import type { Harness } from '../../control/harness.ts';
import type { RunnerHooks } from '../../engine/runner.ts';
import { redactor, type Redactor } from '../../environment/redaction.ts';
import { withinPaths } from '../../validate.ts';
import {
  connectorIdOf,
  loadConfig,
  orderIdOf,
  resolveFrom,
  storeFileOf,
  type LoadedConfig,
} from './config.ts';
import { RelaySink, type ReconcileDecision } from './delivery.ts';
import { HistoryRecorder } from './history.ts';
import { createTransportFor } from './registry.ts';
import {
  assertEligible,
  checkIdentity,
  contextLimitIssues,
  localContext,
  matchCriterion,
  readStable,
  semanticDigest,
  type BaselineManifest,
  type SnapshotManifest,
} from './snapshot.ts';
import { RelayWorkSource } from './source.ts';
import { redactingTransport, settingsSecrets } from './redact.ts';
import { ConnectorStore } from './store.ts';
import type { RelayTransport } from './transport.ts';

/**
 * Пользовательский путь коннектора — общий для CLI и библиотеки:
 * `check` → `snapshot` → (review-plan/approve) → `run` → `status` →
 * `deliver`/`reconcile`. Ни одна операция не требует писать TypeScript.
 */

export const OWNERSHIP_NOTE =
  'Один владелец доставки гарантирован только для процессов с общим каталогом состояния коннектора (lease с fencing в его SQLite). Независимые установки с разными каталогами состояния вне гарантии: они могут доставить одну операцию дважды.';

export interface OpenOptions {
  /** Каталог состояния harness (`--state`); используется, если в конфигурации нет `stateDir`. */
  stateDir: string;
  /** Готовый транспорт (тесты, библиотека); без него — адаптер по provider. */
  transport?: RelayTransport;
  /** Значения, которые маскируются в итогах для получателя. */
  secrets?: string[];
  /** Точка отказа записи состояния коннектора (тесты). */
  onStoreWrite?: (what: string) => void;
  owner?: string;
}

export async function openConnector(source: string | LoadedConfig, options: OpenOptions) {
  const loaded = typeof source === 'string' ? loadConfig(source) : source;
  const transport = options.transport ?? (await createTransportFor(loaded));
  return new Connector(loaded, transport, options);
}

export class Connector {
  readonly id: string;
  readonly stateDir: string;
  readonly storeFile: string;
  private storeInstance?: ConnectorStore;
  private readonly redact: Redactor;

  /** Транспорт с замаскированными ошибками (известные секреты не выходят в диагностику). */
  readonly transport: RelayTransport;

  constructor(
    readonly loaded: LoadedConfig,
    transport: RelayTransport,
    readonly options: OpenOptions,
  ) {
    const config = loaded.config;
    this.id = connectorIdOf(config.provider, config.projectId);
    this.stateDir = config.stateDir
      ? resolveFrom(loaded.baseDir, config.stateDir)
      : resolve(options.stateDir);
    this.storeFile = storeFileOf(this.stateDir, config.provider, config.projectId);
    this.redact = redactor([...(options.secrets ?? []), ...settingsSecrets(config.relay)]);
    this.transport = redactingTransport(transport, this.redact);
  }

  get config() {
    return this.loaded.config;
  }

  /** Каталог пакетов `tasks[].context`: `contextDir` конфигурации, иначе `work/context` рядом с ней. */
  get contextDir() {
    return resolveFrom(this.loaded.baseDir, this.config.contextDir ?? 'work/context');
  }

  /** Состояние коннектора (создаётся при первой записи). */
  get store(): ConnectorStore {
    this.storeInstance ??= new ConnectorStore(
      this.storeFile,
      { provider: this.config.provider, projectId: this.config.projectId },
      this.options.onStoreWrite ? { onWrite: this.options.onStoreWrite } : {},
    );
    return this.storeInstance;
  }

  /** Только чтение: без создания файла; нет состояния — `undefined`. */
  private readStore(): ConnectorStore | undefined {
    if (this.storeInstance) return this.storeInstance;
    if (!existsSync(this.storeFile)) return undefined;
    return new ConnectorStore(
      this.storeFile,
      { provider: this.config.provider, projectId: this.config.projectId },
      { readOnly: true },
    );
  }

  get source() {
    return new RelayWorkSource({
      config: this.config,
      transport: this.transport,
      store: this.store,
      contextDir: this.contextDir,
    });
  }

  get history() {
    return new HistoryRecorder({
      config: this.config,
      transport: this.transport,
      store: this.store,
      connectorId: this.id,
      redact: this.redact,
    });
  }

  get sink() {
    return new RelaySink({
      config: this.config,
      transport: this.transport,
      store: this.store,
      connectorId: this.id,
      history: this.history,
      redact: this.redact,
      ...(this.options.owner ? { owner: this.options.owner } : {}),
    });
  }

  /** Хуки runner для `HarnessOptions.hooks`: история до исполнения попытки. */
  hooks(): RunnerHooks {
    return this.history.hooks();
  }

  close() {
    this.storeInstance?.close();
    this.storeInstance = undefined;
  }

  /**
   * `baseline` — решение человека, поэтому файл конфигурации не должен быть
   * доступен писателю поручения: он вне репозиториев политики или в их
   * `protectedPaths` (runner отказывает попытке, которая их меняет).
   */
  baselineIssue(policy: ExecutionPolicy, baseDir: string): string | undefined {
    const file = this.loaded.file;
    if (!this.config.baseline || !file) return undefined;
    const real = realpathSync(file);
    for (const repo of policy.repositories) {
      const root = resolveFrom(baseDir, repo.path);
      if (!existsSync(root)) continue;
      const path = relative(realpathSync(root), real);
      if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) continue;
      if (!withinPaths(path, repo.protectedPaths))
        return `Конфигурация коннектора с baseline лежит в репозитории ${repo.id} вне protectedPaths (${path}): писатель поручения мог бы выдать себе baseline; перенесите файл или защитите путь в политике`;
    }
    return undefined;
  }

  assertBaselineProtected(policy: ExecutionPolicy, baseDir: string) {
    const issue = this.baselineIssue(policy, baseDir);
    if (issue) throw new HarnessError('NOT_READY', issue);
  }

  /* ---------------------------------------------------------------- */
  /* source-check                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Подключение, идентичность, capabilities, совпадение проекта и mapping —
   * только чтением: без мутаций backend, без записи истории и без создания
   * состояния коннектора.
   */
  async check(policy?: ExecutionPolicy, baseDir?: string) {
    const config = this.config;
    const problems: string[] = [];
    const unprotected = policy && baseDir && this.baselineIssue(policy, baseDir);
    if (unprotected) problems.push(unprotected);
    let identity;
    try {
      identity = await checkIdentity(this.transport, config);
    } catch (error) {
      const message = this.redact(error instanceof Error ? error.message : String(error));
      return this.checkReport(undefined, false, [message], []);
    }
    const mapping: { ref: string; key?: string; problems: string[] }[] = [];
    try {
      const local = await localContext(config, this.contextDir);
      if (local.length)
        problems.push(
          ...contextLimitIssues({ apiVersion: API_VERSION, sources: local, missing: [] }),
        );
    } catch (error) {
      problems.push(this.redact(error instanceof Error ? error.message : String(error)));
    }
    try {
      const { reads } = await readStable(
        this.transport,
        config.tasks.map((t) => t.ref),
        config.limits.rereads,
      );
      reads.forEach((read, i) => {
        const m = config.tasks[i]!;
        const issues: string[] = [];
        m.criteria.forEach((c, k) => {
          const n = matchCriterion(read.task.criteria, c).length;
          if (n !== 1) issues.push(`criteria[${k}] (${c.id ?? c.title}): совпадений ${n}`);
        });
        for (const d of m.requiredDocuments)
          if (read.documents.filter((x) => x.id === d || x.key === d || x.name === d).length !== 1)
            issues.push(`requiredDocuments: ${d} не найден однозначно`);
        const unmapped = read.task.criteria.filter(
          (c) => !m.criteria.some((x) => matchCriterion([c], x).length === 1),
        );
        if (unmapped.length)
          issues.push(
            'ручные критерии (без mapping, блокируют done): ' +
              unmapped.map((c) => c.title).join(', '),
          );
        if (policy) {
          const repoId = m.repositoryId ?? config.repository.id;
          const repo = policy.repositories.find((r) => r.id === repoId);
          if (!repo) issues.push(`репозиторий ${repoId} не объявлен в политике`);
          else
            for (const c of m.criteria)
              if (!repo.gates.some((g) => g.id === c.gate))
                issues.push(`gate ${c.gate} критерия ${c.id ?? c.title} не объявлен в политике`);
          if (!policy.roles[m.role]) issues.push(`роль ${m.role} не объявлена в политике`);
        }
        mapping.push({ ref: m.ref, key: read.task.key, problems: issues });
        problems.push(
          ...issues.filter((x) => !x.startsWith('ручные')).map((x) => `${read.task.key}: ${x}`),
        );
      });
    } catch (error) {
      problems.push(this.redact(error instanceof Error ? error.message : String(error)));
    }
    return this.checkReport(identity, true, problems, mapping);
  }

  private checkReport(
    identity: Awaited<ReturnType<typeof checkIdentity>> | undefined,
    projectMatches: boolean,
    problems: string[],
    mapping: { ref: string; key?: string; problems: string[] }[],
  ) {
    const caps = identity?.capabilities ?? [];
    return {
      provider: this.config.provider,
      projectId: this.config.projectId,
      connector: this.id,
      connected: Boolean(identity),
      projectMatches: Boolean(identity) && projectMatches,
      ...(identity ? { identity: { capabilities: caps, build: identity.build } } : {}),
      history: {
        enabled: this.config.history.enabled,
        capability: caps.some((c) => /history/.test(c)),
      },
      mapping,
      ownership: { stateDir: this.stateDir, store: this.storeFile, note: OWNERSHIP_NOTE },
      problems,
    };
  }

  /* ---------------------------------------------------------------- */
  /* source-snapshot                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Прочитать и предпросмотреть снимок; записать graph/context/manifest для
   * `review-plan`/`approve`. Снимок закрепляется в состоянии коннектора по
   * semantic digest: повтор неизменной постановки ничего не меняет, а возврат
   * к прежней редакции снова закрепляет её запись (`created: false`).
   */
  async snapshot(outDir?: string) {
    const snapshot = await this.source.snapshot();
    const { created } = this.store.putSnapshot({
      revision: snapshot.revision,
      graphId: snapshot.graph.id,
      graph: snapshot.graph,
      context: snapshot.context,
      manifest: snapshot.manifest,
    });
    const dir = resolve(
      outDir ?? join(this.stateDir, 'connectors', 'snapshots', snapshot.graph.id),
    );
    mkdirSync(dir, { recursive: true });
    const files = {
      graph: join(dir, 'graph.json'),
      context: join(dir, 'context.json'),
      manifest: join(dir, 'manifest.json'),
    };
    writeFileSync(files.graph, JSON.stringify(snapshot.graph, null, 2) + '\n');
    writeFileSync(files.context, JSON.stringify(snapshot.context, null, 2) + '\n');
    writeFileSync(files.manifest, JSON.stringify(snapshot.manifest, null, 2) + '\n');
    return {
      connector: this.id,
      graphId: snapshot.graph.id,
      graphDigest: snapshot.manifest.graphDigest,
      contextDigest: snapshot.manifest.contextDigest,
      ...(snapshot.manifest.localContext ? { localContext: snapshot.manifest.localContext } : {}),
      revision: snapshot.revision,
      created,
      eligible: snapshot.problems.length === 0,
      problems: snapshot.problems.map((p) => `${p.key}: ${p.code}: ${p.message}`),
      truncated: snapshot.manifest.truncated,
      ...(snapshot.manifest.baseline ? { baseline: snapshot.manifest.baseline } : {}),
      tasks: snapshot.manifest.tasks.map((t) => ({
        identity: t.identity,
        key: t.key,
        orderId: t.orderId,
        semanticDigest: t.semanticDigest,
        casRevision: t.casRevision,
        column: t.column,
      })),
      files,
      snapshot,
    };
  }

  /* ---------------------------------------------------------------- */
  /* run --source                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Перед запуском — свежее чтение: semantic digest обязан совпасть с
   * закреплённым снимком (тем, что прошёл ревью/согласование), eligibility —
   * выполняться. Иначе отказ до любого вызова runtime. Исполняется ровно
   * закреплённый граф и контекст (те же байты, что видел reviewer плана).
   */
  async prepareRun(h: Harness): Promise<{
    graph: WorkGraph;
    context: ContextSnapshot;
    baseline?: BaselineManifest;
  }> {
    this.assertBaselineProtected(h.policy, h.options.baseDir);
    const fresh = await this.source.snapshot();
    const stored = this.store.latestSnapshot(fresh.graph.id);
    if (!stored)
      throw new HarnessError(
        'APPROVAL_REQUIRED',
        'Снимок задач не закреплён: выполните source-snapshot, review-plan и approve',
      );
    if (stored.revision !== fresh.revision)
      throw new HarnessError(
        'APPROVAL_STALE',
        `Постановка изменилась после закреплённого снимка (${stored.revision.slice(0, 12)} → ${fresh.revision.slice(0, 12)}): нужен новый source-snapshot, review-plan и approve`,
      );
    const registered = h.engine.read((v) => v.graph(fresh.graph.id));
    if (
      registered?.approval &&
      registered.graph.source.revision !== fresh.revision &&
      h.policy.approvalMode === 'operator'
    )
      throw new HarnessError(
        'APPROVAL_STALE',
        'Согласован другой снимок задач; повторите review-plan и approve для текущего',
      );
    // Колонка, в которую задачу перевела наша же подтверждённая доставка этой
    // постановки, — не новая постановка и не повод отказать повтору (он
    // продолжит прежнюю работу без нового run и записей).
    const own = (p: (typeof fresh.problems)[number]) => {
      if (p.code !== 'TASK_DONE' && p.code !== 'COLUMN_NOT_ELIGIBLE') return false;
      const digest = fresh.manifest.tasks.find((t) => t.id === p.taskId)?.semanticDigest;
      return this.store
        .operations({ taskId: p.taskId })
        .some((o) => o.status === 'delivered' && o.revision === digest);
    };
    assertEligible({ ...fresh, problems: fresh.problems.filter((p) => !own(p)) });
    const { baseline } = stored.manifest as SnapshotManifest;
    return {
      graph: stored.graph as WorkGraph,
      context: stored.context as ContextSnapshot,
      ...(baseline ? { baseline } : {}),
    };
  }

  async run(h: Harness, options: { author?: Author; once?: boolean } = {}) {
    const { graph, context, baseline } = await this.prepareRun(h);
    const data = await h.run({
      graph,
      context,
      author: options.author ?? 'external',
      source: this.source,
      sink: this.sink,
      ...(options.once ? { once: true } : {}),
    });
    return { ...data, ...(baseline ? { baseline } : {}) };
  }

  /* ---------------------------------------------------------------- */
  /* source-status / deliver / reconcile                               */
  /* ---------------------------------------------------------------- */

  private workIds() {
    return this.config.tasks.map((t) => t.ref);
  }

  /**
   * Локальное состояние (принято, доставлено, конфликт, неизвестный исход) и
   * независимое чтение получателя. Ошибка чтения получателя показывается, а не
   * заменяется пустым состоянием.
   */
  async status(h?: Harness) {
    const store = this.readStore();
    try {
      const snapshot = store?.latestSnapshotAny();
      const manifest = snapshot?.manifest as SnapshotManifest | undefined;
      const tasks = [];
      for (const [index, mapping] of this.config.tasks.entries()) {
        const fromManifest = manifest?.tasks.find((t) => t.ref === mapping.ref);
        const taskId = fromManifest?.id ?? mapping.ref;
        const workId = orderIdOf(this.config.provider, this.config.projectId, taskId);
        const work = h?.engine.read((v) => v.work(workId));
        let deliveries: { status: string; key: string; operation?: string }[] = [];
        if (h && work)
          try {
            deliveries = h.result(workId).delivery.map((d) => ({
              status: d.status,
              key: d.key,
              ...(d.operation ? { operation: d.operation } : {}),
            }));
          } catch {
            deliveries = [];
          }
        const operations = (store?.operations({ workId }) ?? []).map((o) => ({
          key: o.key,
          runId: o.runId,
          outcome: o.outcome,
          status: o.status,
          ...(o.reason ? { reason: o.reason } : {}),
          ...(o.currentRevision ? { currentRevision: o.currentRevision } : {}),
          steps: o.steps.map((s) => ({ n: s.n, kind: s.kind, status: s.status, marker: s.marker })),
          lease: ((l) =>
            l && l.expiresAt > Date.now()
              ? { owner: l.owner, expiresAt: new Date(l.expiresAt).toISOString() }
              : undefined)(store?.lease(o.key)),
        }));
        let remote: Record<string, unknown>;
        try {
          const read = await this.transport.readTask(taskId);
          const comments = await this.transport.listComments(taskId);
          remote = {
            reachable: true,
            column: read.task.column,
            casRevision: read.task.revision,
            semanticDigest: semanticDigest(this.config, mapping, read),
            matchesSnapshot: fromManifest
              ? semanticDigest(this.config, mapping, read) === fromManifest.semanticDigest
              : false,
            criteria: read.task.criteria.map((c) => ({
              id: c.id,
              title: c.title,
              completed: c.completed,
            })),
            markers: Object.fromEntries(
              operations.map((o) => [
                o.key,
                comments.filter((c) => c.body.includes(`op=${o.key}:`)).length,
              ]),
            ),
          };
        } catch (error) {
          remote = {
            reachable: false,
            error: this.redact(error instanceof Error ? error.message : String(error)),
          };
        }
        tasks.push({
          index,
          ref: mapping.ref,
          ...(fromManifest ? { key: fromManifest.key, identity: fromManifest.identity } : {}),
          workId,
          local: work
            ? {
                status: work.status,
                attempt: work.attempt,
                ...(work.resultSha ? { resultSha: work.resultSha } : {}),
              }
            : { status: 'unknown' },
          deliveries,
          operations,
          remote,
        });
      }
      return {
        connector: this.id,
        provider: this.config.provider,
        projectId: this.config.projectId,
        ...(manifest
          ? {
              snapshot: {
                revision: manifest.revision,
                graphId: manifest.graphId,
                ...(manifest.baseline ? { baseline: manifest.baseline } : {}),
              },
            }
          : {}),
        ownership: { stateDir: this.stateDir, store: this.storeFile, note: OWNERSHIP_NOTE },
        tasks,
      };
    } finally {
      if (store && store !== this.storeInstance) store.close();
    }
  }

  /** Доставить результаты (повтор — с тем же ключом, без writer/reviewer и Git). */
  async deliver(h: Harness, workId?: string) {
    const ids = workId
      ? [workId]
      : this.config.tasks
          .map((t) => {
            const snapshot = this.store.latestSnapshotAny();
            const manifest = snapshot?.manifest as SnapshotManifest | undefined;
            const id = manifest?.tasks.find((x) => x.ref === t.ref)?.id ?? t.ref;
            return orderIdOf(this.config.provider, this.config.projectId, id);
          })
          .filter((id) => h.engine.read((v) => v.attempts(id).some((a) => a.status !== 'active')));
    const sink = this.sink;
    const out = [];
    for (const id of ids) {
      const envelope = await h.deliver(id, sink);
      out.push({ workId: id, delivery: envelope.delivery, outcome: envelope.result.outcome });
    }
    return { connector: this.id, deliveries: out };
  }

  /** Разбор неизвестного исхода/конфликта и, если факты позволяют, продолжение доставки. */
  async reconcile(h: Harness, operation: string, decision?: ReconcileDecision) {
    const op = this.store.operation(operation);
    if (!op) throw new HarnessError('NOT_FOUND', 'Операция доставки не найдена: ' + operation);
    const report = await this.sink.reconcile(operation, decision);
    let delivery;
    if (report.resolved) {
      const envelope = await h.deliver(op.workId, this.sink);
      delivery = envelope.delivery;
    }
    const after = this.store.operation(operation)!;
    return {
      operation,
      workId: op.workId,
      before: report.before,
      after: after.status,
      resolved: report.resolved,
      facts: report.facts,
      ...(delivery ? { delivery } : {}),
    };
  }

  /** Расшифровка решения CLI `--decision resend|recheck|adopt:<id>`. */
  static decision(text: string | undefined): ReconcileDecision | undefined {
    if (!text) return undefined;
    if (text === 'resend' || text === 'recheck') return { kind: text };
    if (text.startsWith('adopt:') && text.length > 6) return { kind: 'adopt', id: text.slice(6) };
    throw new HarnessError('INVALID_INPUT', '--decision: ожидается resend, recheck или adopt:<id>');
  }
}
