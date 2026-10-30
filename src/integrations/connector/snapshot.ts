import { existsSync, statSync } from 'node:fs';
import {
  API_VERSION,
  HarnessError,
  CONTEXT_LIMITS,
  contextDigest,
  contextIssues,
  digestOf,
  sha256,
  sourceDigest,
  workGraphDigest,
  workGraphSchema,
  type ContextSnapshot,
  type ContextSourceEntry,
  type PinnedFile,
  type Prerequisite,
  type WorkGraph,
  type WorkOrder,
} from '../../contracts/index.ts';
import {
  baselineRecord,
  connectorIdOf,
  contextIdOf,
  graphIdOf,
  mappingDigest,
  orderIdOf,
  taskIdentity,
  type ConnectorConfig,
  type TaskMapping,
} from './config.ts';
import type { ReceiptRecord } from './store.ts';
import {
  TransportError,
  type CriterionRecord,
  type DocumentRecord,
  type RelayTransport,
  type TaskRead,
  type TransportIdentity,
} from './transport.ts';
import { FileContextSource } from '../../connectors/files.ts';

/**
 * Снимок задач backend: чтение без смешения редакций, semantic digest,
 * WorkGraph, ContextSnapshot и manifest.
 *
 * Semantic digest — то, к чему привязано согласование (`SourceRef.revision`):
 * текст требований, определения критериев (без отметок выполнения),
 * зависимости, подзадачи, значимые документы и digest mapping. Колонка, свой
 * in-progress, комментарии, история и отметки критериев в него не входят:
 * они не меняют постановку. CAS-ревизии, токены согласованности чтения и
 * идентичность сборки backend хранятся только в manifest — не в поле Git SHA
 * и не в графе.
 */

export interface SnapshotProblem {
  code:
    | 'TASK_DONE'
    | 'TASK_CANCELLED'
    | 'COLUMN_NOT_ELIGIBLE'
    | 'DEPENDENCY_UNFINISHED'
    | 'DEPENDENCY_UNPROVEN'
    | 'LIMIT_EXCEEDED'
    | 'DOCUMENT_MISSING'
    | 'MAPPING_INVALID';
  taskId: string;
  key: string;
  message: string;
}

export interface DocumentManifest {
  id: string;
  key: string;
  name: string;
  revision: number;
  bytes: number;
  required: boolean;
  included: 'full' | 'truncated' | 'omitted';
  includedBytes: number;
  reason?: string;
}

export interface TaskManifest {
  ref: string;
  id: string;
  key: string;
  identity: string;
  orderId: string;
  semanticDigest: string;
  /** CAS-ревизия backend на момент чтения (не Git SHA). */
  casRevision: number;
  column: string;
  consistency: { before: string; after: string };
  criteria: { id: string; title: string; mapped: boolean; completed: boolean }[];
  dependencies: {
    id: string;
    key: string;
    column: string;
    finished: boolean;
    inGraph: boolean;
    /** Основание внешней зависимости: `receipt` доказан, `baseline` принят человеком. */
    proof?: 'receipt' | 'baseline';
  }[];
  children: { id: string; key: string; column: string; finished: boolean }[];
  documents: DocumentManifest[];
}

export interface SnapshotManifest {
  version: 1;
  provider: string;
  projectId: string;
  connector: string;
  build: Record<string, string>;
  capabilities: string[];
  graphId: string;
  graphDigest: string;
  contextDigest: string;
  /** Semantic digest набора задач — `graph.source.revision`. */
  revision: string;
  readAt: string;
  rounds: number;
  limits: ConnectorConfig['limits'];
  tasks: TaskManifest[];
  truncated: string[];
  problems: SnapshotProblem[];
  /** Закреплённые локальные пакеты `tasks[].context`; без них поля нет. */
  localContext?: LocalContextManifest[];
  /** Зависимости, принятые человеком по базовой линии; без них поля нет. */
  baseline?: BaselineManifest;
}

export interface BaselineManifest {
  sha: string;
  reason: string;
  tasks: string[];
}

export interface LocalContextManifest {
  id: string;
  digest: string;
  files: number;
  references: number;
  bytes: number;
}

export interface BuiltSnapshot {
  graph: WorkGraph;
  context: ContextSnapshot;
  manifest: SnapshotManifest;
  revision: string;
  problems: SnapshotProblem[];
}

/** Безопасная причина отказа транспорта при чтении: сеть/CLI — не пустой список. */
export function readFailure(error: unknown, what: string): HarnessError {
  if (error instanceof HarnessError) return error;
  if (error instanceof TransportError) {
    const where = `${what} (${error.operation}, ${error.details.provider}${error.details.projectId ? '/' + error.details.projectId : ''})`;
    if (error.kind === 'not-found' || error.kind === 'refused')
      return new HarnessError(
        'NOT_READY',
        `${where}: запись недоступна (${error.kind}): ${error.message}`,
      );
    if (error.kind === 'unsupported')
      return new HarnessError(
        'NOT_READY',
        `${where}: операция не поддерживается: ${error.message}`,
      );
    return new HarnessError(
      'DELIVERY_FAILED',
      `${where}: источник недоступен (${error.kind}): ${error.message}`,
    );
  }
  return new HarnessError(
    'DELIVERY_FAILED',
    `${what}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Проверка подключения: provider и projectId backend обязаны совпасть с настроенными. */
export async function checkIdentity(
  transport: RelayTransport,
  config: ConnectorConfig,
  signal?: AbortSignal,
): Promise<TransportIdentity> {
  if (transport.provider !== config.provider)
    throw new HarnessError(
      'INVALID_INPUT',
      `Транспорт ${transport.provider} не соответствует provider ${config.provider}`,
    );
  let identity: TransportIdentity;
  try {
    identity = await transport.identity(signal);
  } catch (error) {
    throw readFailure(error, 'identity');
  }
  if (identity.provider !== config.provider || identity.projectId !== config.projectId)
    throw new HarnessError(
      'NOT_READY',
      `Проект backend (${identity.provider}/${identity.projectId}) не совпадает с настроенным (${config.provider}/${config.projectId}); мутации запрещены`,
    );
  return identity;
}

const contentOf = (read: TaskRead) =>
  digestOf({ ...read, consistency: undefined, task: { ...read.task } });

/**
 * Полное согласованное чтение набора задач. Раунд — чтение всех задач; у
 * каждой `consistency.before === after`. Снимок принимается, когда два
 * последовательных раунда совпали токенами и содержимым: между ними ничего
 * не менялось, и граф не собирается из разных редакций. Изменения —
 * ограниченный повтор (`rereads`), затем явный отказ. Ошибка чтения —
 * отказ, а не пустой результат.
 */
export async function readStable(
  transport: RelayTransport,
  refs: string[],
  rereads: number,
  signal?: AbortSignal,
): Promise<{ reads: TaskRead[]; rounds: number }> {
  const round = async () => {
    const out: TaskRead[] = [];
    for (const ref of refs) {
      let read: TaskRead;
      try {
        read = await transport.readTask(ref, signal);
      } catch (error) {
        throw readFailure(error, 'Задача ' + ref);
      }
      if (read.consistency.before !== read.consistency.after) return undefined;
      out.push(read);
    }
    return out;
  };
  let previous: TaskRead[] | undefined;
  let rounds = 0;
  for (let i = 0; i <= rereads; i++) {
    rounds++;
    const current = await round();
    if (!current) {
      previous = undefined;
      continue;
    }
    if (
      previous &&
      previous.every(
        (p, k) =>
          p.consistency.after === current[k]!.consistency.before &&
          p.consistency.after === current[k]!.consistency.after &&
          contentOf(p) === contentOf(current[k]!),
      )
    )
      return { reads: current, rounds };
    previous = current;
  }
  throw new HarnessError(
    'NOT_READY',
    `Снимок не согласован: данные менялись во время чтения (${rounds} чтений, предел rereads=${rereads}); граф не собирается из разных редакций`,
  );
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max).trim());

/** Определения критериев без отметок выполнения. */
const definitions = (criteria: CriterionRecord[]) =>
  criteria.map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.summary,
    description: c.description,
  }));

const documentMatches = (doc: DocumentRecord, needle: string) =>
  doc.id === needle || doc.key === needle || doc.name === needle;

export const matchCriterion = (criteria: CriterionRecord[], m: TaskMapping['criteria'][number]) =>
  criteria.filter((c) => (m.id !== undefined ? c.id === m.id : c.title === m.title));

/** Semantic digest задачи: смысл постановки без операционных полей. */
export function semanticDigest(config: ConnectorConfig, mapping: TaskMapping, read: TaskRead) {
  return digestOf({
    v: 1,
    identity: taskIdentity(config.provider, config.projectId, read.task.id),
    title: read.task.title,
    description: read.task.description,
    criteria: definitions(read.task.criteria),
    dependencies: [...read.task.dependencies].sort(),
    parent: read.task.parentId,
    children: read.children.map((c) => c.id).sort(),
    documents: read.documents
      .map((d) => ({ id: d.id, name: d.name, digest: sha256(d.body) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    mapping: mappingDigest(config, mapping),
  });
}

const utf8Prefix = (text: string, bytes: number) => {
  const buf = Buffer.from(text, 'utf8').subarray(0, bytes);
  // Обрезка на границе символа: неполная последовательность UTF-8 отбрасывается.
  return new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/�$/, '');
};

const pin = (path: string, text: string): PinnedFile => ({
  path,
  digest: sha256(text),
  bytes: Buffer.byteLength(text),
  content: { encoding: 'utf8', data: text },
});

/** Прочитанная задача и её доверенные предпосылки → граф, контекст и manifest. */
export function buildSnapshot(input: {
  config: ConnectorConfig;
  identity: TransportIdentity;
  reads: TaskRead[];
  rounds: number;
  /** Доверенный receipt этого коннектора для задачи-зависимости вне графа. */
  receiptOf: (orderId: string) => ReceiptRecord | undefined;
  /** Закреплённые локальные пакеты `tasks[].context` (localContext). */
  local?: ContextSourceEntry[];
}): BuiltSnapshot {
  const { config, identity, reads } = input;
  const connector = connectorIdOf(config.provider, config.projectId);
  const problems: SnapshotProblem[] = [];
  const graphTasks = new Set(reads.map((r) => r.task.id));
  const orders: WorkOrder[] = [];
  const sources: ContextSnapshot['sources'] = [];
  const missing: ContextSnapshot['missing'] = [];
  const prerequisites = new Map<string, Prerequisite>();
  const accepted = new Set<string>();
  const tasks: TaskManifest[] = [];
  /** Какие локальные пакеты у какой задачи (по порядку): часть ревизии набора. */
  const packsByTask: [string, string[]][] = [];
  const truncated: string[] = [];
  let totalBytes = 0;
  const limits = config.limits;

  reads.forEach((read, index) => {
    const mapping = config.tasks[index]!;
    const task = read.task;
    const problem = (code: SnapshotProblem['code'], message: string) =>
      problems.push({ code, taskId: task.id, key: task.key, message });
    const orderId = orderIdOf(config.provider, config.projectId, task.id);
    const identityOf = taskIdentity(config.provider, config.projectId, task.id);
    const digest = semanticDigest(config, mapping, read);

    // Eligibility — явная политика, отдельно от semantic digest.
    if (task.column === 'done') problem('TASK_DONE', 'Задача уже в done');
    else if (task.column === 'cancelled') problem('TASK_CANCELLED', 'Задача отменена');
    else if (!config.eligibility.columns.includes(task.column))
      problem(
        'COLUMN_NOT_ELIGIBLE',
        `Колонка ${task.column} не допускает запуск (eligibility.columns: ${config.eligibility.columns.join(', ')})`,
      );

    // Сопоставление критериев: каждое правило — ровно один критерий.
    const mapped = new Set<string>();
    mapping.criteria.forEach((m, k) => {
      const found = matchCriterion(task.criteria, m);
      if (found.length !== 1)
        problem(
          'MAPPING_INVALID',
          `criteria[${k}] (${m.id ?? m.title}) сопоставляется с ${found.length} критериями; нужен ровно один`,
        );
      else mapped.add(found[0]!.id);
    });

    // Зависимости: внутри графа — dependsOn; вне — с доверенным receipt или,
    // если receipt нет, по явной записи базовой линии.
    const dependsOn: string[] = [];
    const deps: TaskManifest['dependencies'] = [];
    for (const dep of read.dependencies) {
      const inGraph = graphTasks.has(dep.id);
      const entry: TaskManifest['dependencies'][number] = {
        id: dep.id,
        key: dep.key,
        column: dep.column,
        finished: dep.finished,
        inGraph,
      };
      deps.push(entry);
      const depOrder = orderIdOf(config.provider, config.projectId, dep.id);
      if (inGraph) {
        dependsOn.push(depOrder);
        continue;
      }
      if (!dep.finished) {
        problem('DEPENDENCY_UNFINISHED', `Зависимость ${dep.key} не завершена`);
        continue;
      }
      const receipt = input.receiptOf(depOrder);
      if (!receipt) {
        const repositoryId = mapping.repositoryId ?? config.repository.id;
        const prior = prerequisites.get(depOrder);
        if (!config.baseline?.tasks.includes(dep.key)) {
          problem(
            'DEPENDENCY_UNPROVEN',
            `Зависимость ${dep.key} в done, но проверяемого receipt этого коннектора нет: статус done не доказывает результат. Если она закрыта до внедрения harness, человек может принять её явно: добавьте ${dep.key} в baseline.tasks конфигурации коннектора (baseline: sha, tasks, reason; docs/connectors.md)`,
          );
        } else if (prior && prior.repositoryId !== repositoryId) {
          problem(
            'DEPENDENCY_UNPROVEN',
            `Зависимость ${dep.key} в baseline, но её требуют задачи разных репозиториев (${prior.repositoryId}, ${repositoryId}); baseline — один коммит`,
          );
        } else {
          dependsOn.push(depOrder);
          entry.proof = 'baseline';
          accepted.add(dep.key);
          prerequisites.set(depOrder, {
            id: depOrder,
            repositoryId,
            resultSha: config.baseline.sha,
            receipt: {
              kind: 'trusted',
              issuer: connector,
              digest: digestOf(baselineRecord(config, dep.key, depOrder, repositoryId)),
            },
          });
        }
        continue;
      }
      entry.proof = 'receipt';
      dependsOn.push(depOrder);
      prerequisites.set(depOrder, {
        id: depOrder,
        repositoryId: receipt.repositoryId,
        resultSha: receipt.resultSha,
        receipt: { kind: 'trusted', issuer: connector, digest: digestOf(receipt) },
      });
    }

    // Обязательное содержимое: текст постановки и критерии.
    const criteriaText = task.criteria
      .map(
        (c) =>
          `- [${c.id}] ${c.title}` +
          (c.summary ? `\n  ${c.summary}` : '') +
          (c.description ? `\n\n  ${c.description.split('\n').join('\n  ')}` : ''),
      )
      .join('\n');
    const taskText =
      `# ${task.key}: ${oneLine(task.title)}\n\n${task.description}\n\n## Критерии приёмки\n\n` +
      (criteriaText || '(критериев нет)') +
      '\n';
    const files: PinnedFile[] = [];
    if (Buffer.byteLength(taskText) > limits.taskBytes)
      problem(
        'LIMIT_EXCEEDED',
        `Текст постановки ${Buffer.byteLength(taskText)} байт больше предела taskBytes=${limits.taskBytes}; обязательное содержимое не усекается`,
      );
    else files.push(pin('task.md', taskText));
    if (task.criteria.length > 30)
      problem('LIMIT_EXCEEDED', `Критериев ${task.criteria.length}, предел 30`);

    // Документы: обязательные — целиком или отказ; дополнительные — в пределах, с явной отметкой.
    const required = new Set<string>();
    for (const needle of mapping.requiredDocuments) {
      const found = read.documents.filter((d) => documentMatches(d, needle));
      if (found.length !== 1)
        problem(
          'DOCUMENT_MISSING',
          `Обязательный документ ${needle}: найдено ${found.length} связанных документов`,
        );
      else required.add(found[0]!.id);
    }
    const docs = [...read.documents].sort((a, b) =>
      required.has(a.id) === required.has(b.id)
        ? a.id < b.id
          ? -1
          : 1
        : required.has(a.id)
          ? -1
          : 1,
    );
    const documents: DocumentManifest[] = [];
    let count = 0;
    for (const doc of docs) {
      const isRequired = required.has(doc.id);
      const bytes = Buffer.byteLength(doc.body);
      const base = {
        id: doc.id,
        key: doc.key,
        name: doc.name,
        revision: doc.revision,
        bytes,
        required: isRequired,
      };
      const path = `documents/${doc.id.replace(/[^A-Za-z0-9_-]/g, '_')}.md`;
      if (isRequired) {
        if (bytes > limits.documentBytes || totalBytes + bytes > limits.totalBytes) {
          problem(
            'LIMIT_EXCEEDED',
            `Обязательный документ ${doc.key || doc.name} (${bytes} байт) превышает предел (documentBytes=${limits.documentBytes}, totalBytes=${limits.totalBytes})`,
          );
          documents.push({ ...base, included: 'omitted', includedBytes: 0, reason: 'limit' });
          continue;
        }
        files.push(pin(path, doc.body));
        totalBytes += bytes;
        count++;
        documents.push({ ...base, included: 'full', includedBytes: bytes });
        continue;
      }
      if (count >= limits.documents) {
        documents.push({
          ...base,
          included: 'omitted',
          includedBytes: 0,
          reason: `documents=${limits.documents}`,
        });
        missing.push({
          id: 'd' + sha256(identityOf + doc.id).slice(0, 20),
          reason: `Дополнительный документ ${doc.key || doc.name} не включён: предел documents=${limits.documents}`,
        });
        continue;
      }
      let text = doc.body;
      let included: DocumentManifest['included'] = 'full';
      if (bytes > limits.documentBytes) {
        const header = `[devcontour-harness: документ усечён до ${limits.documentBytes} из ${bytes} байт по пределу documentBytes]\n\n`;
        text = header + utf8Prefix(doc.body, limits.documentBytes);
        included = 'truncated';
        truncated.push(`${task.key}/${doc.name || doc.key}`);
      }
      const size = Buffer.byteLength(text);
      if (totalBytes + size > limits.totalBytes) {
        documents.push({
          ...base,
          included: 'omitted',
          includedBytes: 0,
          reason: `totalBytes=${limits.totalBytes}`,
        });
        missing.push({
          id: 'd' + sha256(identityOf + doc.id).slice(0, 20),
          reason: `Дополнительный документ ${doc.key || doc.name} не включён: предел totalBytes=${limits.totalBytes}`,
        });
        continue;
      }
      files.push(pin(path, text));
      totalBytes += size;
      count++;
      documents.push({ ...base, included, includedBytes: size });
    }

    // Provenance без операционных полей (CAS-ревизии — только в manifest).
    const provenance = JSON.stringify(
      {
        provider: config.provider,
        projectId: config.projectId,
        taskId: task.id,
        key: task.key,
        semanticDigest: digest,
        documents: documents.map((d) => ({
          id: d.id,
          key: d.key,
          name: d.name,
          bytes: d.bytes,
          included: d.included,
          required: d.required,
        })),
      },
      null,
      2,
    );
    const entry = {
      id: contextIdOf(orderId),
      kind: 'relay-task',
      version: '1',
      required: true,
      files,
      references: [pin('references/provenance.json', provenance)],
    };
    sources.push({ ...entry, digest: sourceDigest(entry) });

    // Поручение: точный текст, без молчаливого усечения.
    const title = cut(oneLine(`${task.key}: ${task.title}`), 180);
    const description = task.description.trim();
    const goal =
      description.length >= 10 && description.length <= 12000
        ? description
        : description.length > 12000
          ? `Полная постановка задачи ${task.key} — в закреплённом контексте ${entry.id}/task.md (${Buffer.byteLength(description)} байт).`
          : `Выполнить задачу ${task.key}: ${oneLine(task.title) || 'без заголовка'}.` +
            (description ? ' ' + oneLine(description) : '');
    const acceptance = task.criteria.length
      ? task.criteria.slice(0, 30).map((c) => {
          const text = cut(oneLine(c.title + (c.summary ? ' — ' + c.summary : '')), 1500);
          return text.length >= 3 ? text : `Критерий ${c.id}: ${text}`.trim();
        })
      : ['Постановка задачи выполнена; обязательные gates проходят'];
    orders.push({
      apiVersion: API_VERSION,
      id: orderId,
      source: { connector, ref: identityOf, revision: digest },
      title: title.length >= 3 ? title : `${task.key}: task`,
      goal,
      acceptance,
      role: mapping.role,
      repositoryId: mapping.repositoryId ?? config.repository.id,
      relatedRepositories: [],
      writeScope: mapping.writeScope,
      dependsOn,
      ...(mapping.gates ? { gates: mapping.gates } : {}),
      requirements: [],
      contracts: [],
      context: [entry.id, ...(mapping.context ?? [])],
    });
    packsByTask.push([identityOf, mapping.context ?? []]);

    tasks.push({
      ref: mapping.ref,
      id: task.id,
      key: task.key,
      identity: identityOf,
      orderId,
      semanticDigest: digest,
      casRevision: task.revision,
      column: task.column,
      consistency: read.consistency,
      criteria: task.criteria.map((c) => ({
        id: c.id,
        title: c.title,
        mapped: mapped.has(c.id),
        completed: c.completed,
      })),
      dependencies: deps,
      children: read.children.map((c) => ({
        id: c.id,
        key: c.key,
        column: c.column,
        finished: c.finished,
      })),
      documents,
    });
  });

  const taskIds = reads.map((r) => r.task.id);
  const graphId = graphIdOf(config.provider, config.projectId, taskIds);
  const prereqs = [...prerequisites.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const revision = digestOf({
    v: 1,
    connector,
    tasks: tasks.map((t) => [t.identity, t.semanticDigest]),
    prerequisites: prereqs,
    // Любая правка базовой линии — новое согласование; без неё ревизия прежняя.
    ...(config.baseline ? { baseline: digestOf(config.baseline) } : {}),
    // Без локальных пакетов ревизия та же, что до их появления. С ними —
    // содержимое пакетов и их распределение по задачам: перенос пакета между
    // задачами или смена порядка — тоже новое согласование.
    ...(input.local?.length || packsByTask.some(([, ids]) => ids.length)
      ? {
          context: (input.local ?? []).map((s) => [s.id, s.digest]),
          contextBy: [...packsByTask].sort(([a], [b]) => (a < b ? -1 : 1)),
        }
      : {}),
  });
  const joined = `${config.provider}:${config.projectId}:${taskIds.join('+')}`;
  const graph = workGraphSchema.parse({
    apiVersion: API_VERSION,
    id: graphId,
    source: {
      connector,
      ref: joined.length <= 300 ? joined : `${config.provider}:${config.projectId}:${graphId}`,
      revision,
    },
    orders,
    prerequisites: prereqs,
  });
  const context: ContextSnapshot = {
    apiVersion: API_VERSION,
    sources: [...sources, ...(input.local ?? [])],
    missing,
  };
  // Пределы снимка контекста проверяются здесь, а не только при запуске:
  // source-snapshot и source-check называют их как отказ eligibility.
  for (const issue of contextLimitIssues(context))
    problems.push({ code: 'LIMIT_EXCEEDED', taskId: '', key: 'context', message: issue });
  const manifest: SnapshotManifest = {
    version: 1,
    provider: config.provider,
    projectId: config.projectId,
    connector,
    build: identity.build,
    capabilities: identity.capabilities,
    graphId,
    graphDigest: workGraphDigest(graph),
    contextDigest: contextDigest(context),
    revision,
    readAt: new Date().toISOString(),
    rounds: input.rounds,
    limits,
    tasks,
    truncated,
    problems,
    ...(input.local?.length ? { localContext: input.local.map(localManifest) } : {}),
    ...(accepted.size
      ? {
          baseline: {
            sha: config.baseline!.sha,
            reason: config.baseline!.reason,
            tasks: [...accepted].sort(),
          },
        }
      : {}),
  };
  return { graph, context, manifest, revision, problems };
}

const CONTEXT_SOURCES_MAX = 30;

/** Нарушения пределов снимка контекста: число источников, размер файла и сумма. */
export function contextLimitIssues(context: ContextSnapshot): string[] {
  const issues = contextIssues(context);
  if (context.sources.length > CONTEXT_SOURCES_MAX)
    issues.push(
      `Источников контекста ${context.sources.length} при пределе ${CONTEXT_SOURCES_MAX} (задачи и локальные пакеты)`,
    );
  return issues.map((i) =>
    /больше предела/.test(i)
      ? `${i} (fileBytes=${CONTEXT_LIMITS.fileBytes}, totalBytes=${CONTEXT_LIMITS.totalBytes})`
      : i,
  );
}

const localManifest = (s: ContextSourceEntry): LocalContextManifest => ({
  id: s.id,
  digest: s.digest,
  files: s.files.length,
  references: s.references.length,
  bytes: [...s.files, ...s.references].reduce((n, f) => n + f.bytes, 0),
});

/**
 * Локальные пакеты `tasks[].context` из `contextDir`: те же правила, что у
 * файлового контекста графа (каталог `<contextDir>/<id>`, `references/` —
 * справки). Нет каталога или пакета — NOT_READY до чтения backend.
 */
export async function localContext(
  config: ConnectorConfig,
  contextDir: string | undefined,
): Promise<ContextSourceEntry[]> {
  const ids = [...new Set(config.tasks.flatMap((t) => t.context ?? []))].sort();
  if (!ids.length) return [];
  if (!contextDir)
    throw new HarnessError(
      'INVALID_INPUT',
      'source: tasks[].context требует каталог пакетов (contextDir)',
    );
  if (!existsSync(contextDir) || !statSync(contextDir).isDirectory())
    throw new HarnessError(
      'NOT_READY',
      `Каталог пакетов контекста ${contextDir} не найден (tasks[].context: ${ids.join(', ')})`,
    );
  return (await new FileContextSource(contextDir).snapshot(ids)).sources;
}

/** Прочитать, собрать и проверить идентичность: общий путь `source-snapshot` и `run --source`. */
export async function takeSnapshot(input: {
  config: ConnectorConfig;
  transport: RelayTransport;
  receiptOf: (orderId: string) => ReceiptRecord | undefined;
  /** Абсолютный каталог пакетов `tasks[].context`. */
  contextDir?: string;
  signal?: AbortSignal;
}): Promise<BuiltSnapshot> {
  const local = await localContext(input.config, input.contextDir);
  const identity = await checkIdentity(input.transport, input.config, input.signal);
  const { reads, rounds } = await readStable(
    input.transport,
    input.config.tasks.map((t) => t.ref),
    input.config.limits.rereads,
    input.signal,
  );
  return buildSnapshot({
    config: input.config,
    identity,
    reads,
    rounds,
    receiptOf: input.receiptOf,
    ...(local.length ? { local } : {}),
  });
}

/** Отказ по eligibility/limits: причина и предел в сообщении, без запуска. */
export function assertEligible(snapshot: BuiltSnapshot) {
  if (!snapshot.problems.length) return;
  throw new HarnessError(
    'NOT_READY',
    'Задача не допускается к запуску: ' +
      snapshot.problems.map((p) => `${p.key}: ${p.code}: ${p.message}`).join('; '),
    snapshot.problems.map((p) => ({ path: ['source', p.key, p.code], message: p.message })),
  );
}
