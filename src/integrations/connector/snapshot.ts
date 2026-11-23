import { ruCount } from '../../contracts/plural.ts';
import { existsSync, statSync } from 'node:fs';
import {
  API_VERSION,
  HarnessError,
  CONTEXT_LIMITS,
  contextDigest,
  canonicalContext,
  contextIssues,
  contextSnapshotSchema,
  digestOf,
  sha256,
  sourceDigest,
  workGraphDigest,
  workGraphSchema,
  type ContextSnapshot,
  type ContextSourceEntry,
  type LocalContextManifest,
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
  statementMappingDigest,
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
  type TaskContextRead,
  type TaskContextRecord,
  type TaskRead,
  type TransportIdentity,
} from './transport.ts';
import { relayCompatibility } from './compat.ts';
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
  /**
   * Semantic digest v1 той же постановки (до alpha.66): по нему сверяются
   * результаты и операции доставки прежних версий. Нет поля — снимок
   * записан до alpha.66 (тогда `semanticDigest` и есть v1).
   */
  legacyDigest?: string;
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
  /**
   * Контекст исполнения задачи из backend (`relay-context.md` пакета).
   * `included` — файл в пакете; `too-large` — не поместился в пределы, задача
   * идёт по-прежнему (задача, критерии, документы задачи). Нет поля —
   * backend контекст не объявил или он выключен в конфигурации.
   */
  taskContext?: {
    status: 'included' | 'too-large';
    records?: number;
    bytes?: number;
    digest?: string;
    reason?: string;
  };
  /** Название задачи (для состава прогона в представлении оператора). */
  title?: string;
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
  /**
   * Ревизия того же набора по правилам до alpha.66 (semantic digest v1):
   * закреплённый до обновления снимок остаётся согласованным, пока она
   * совпадает. Нет поля — снимок записан до alpha.66.
   */
  legacyRevision?: string;
  /**
   * Ревизия постановок набора (0.1.0-alpha.68): та же ревизия без
   * необязательных документов задач. Совпала у закреплённого и свежего
   * чтения — постановки (текст, критерии, зависимости, обязательные
   * документы, контекст задач, пакеты, предпосылки, базовая линия) те же, и
   * правка одних необязательных документов (ответы и решения владельца)
   * согласование не обесценивает. Нет поля — снимок записан до alpha.68.
   */
  ordersRevision?: string;
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
  /** Совместимость с Relay v1 по договору и capabilities (только relay-v1-http). */
  compatibility?: ReturnType<typeof relayCompatibility>;
}

export interface BaselineManifest {
  sha: string;
  reason: string;
  tasks: string[];
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
    // Версия договора или сборка backend не та, с которой проверен коннектор.
    if (
      error.kind === 'unsupported' &&
      (error.details.code === 'CONNECTOR_VERSION_MISMATCH' ||
        error.details.code === 'BUILD_MISMATCH')
    )
      return new HarnessError(
        'CONNECTOR_VERSION_MISMATCH',
        `${where}: версия backend не совпадает с проверенной: ${error.message}. ` +
          'Поставьте пару версий harness и backend из docs/compatibility-versions.md ' +
          '(или обновите ожидаемую сборку в конфигурации коннектора) и повторите source-check',
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

/**
 * Содержимое чтения для сверки раундов. Токен согласованности контекста
 * backend не входит: он может меняться вместе с вычисляемыми полями;
 * сравниваются записи контекста и ревизия задачи в нём.
 */
const contentOf = (read: TaskRead) =>
  digestOf({
    ...read,
    consistency: undefined,
    task: { ...read.task },
    context:
      read.context?.status === 'ok'
        ? { ...read.context, context: { ...read.context.context, consistency: undefined } }
        : read.context,
  });

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
  /** Читать контекст исполнения задачи (backend объявил capability, конфигурация не выключила). */
  context?: { targetDocuments: boolean; maxBytes: number },
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
      if (context && transport.readTaskContext) {
        let outcome;
        try {
          outcome = await transport.readTaskContext(read.task.id, context, signal);
        } catch (error) {
          throw readFailure(error, 'Контекст задачи ' + ref);
        }
        // Контекст другой редакции задачи — раунд не согласован.
        if (outcome.status === 'ok' && outcome.context.taskRevision !== read.task.revision)
          return undefined;
        read = { ...read, context: outcome };
      }
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
    `Снимок не согласован: данные менялись во время чтения (${ruCount(rounds, ['чтение', 'чтения', 'чтений'])}, предел rereads=${rereads}); граф не собирается из разных редакций`,
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

const requiredDoc = (mapping: TaskMapping, d: DocumentRecord) =>
  mapping.requiredDocuments.some((n) => documentMatches(d, n));

const docDigests = (docs: DocumentRecord[]) =>
  docs
    .map((d) => ({ id: d.id, name: d.name, digest: sha256(d.body) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

/**
 * Semantic digest задачи (v2, alpha.66) — то, к чему привязан результат:
 * заголовок, описание, определения критериев, зависимости, родитель,
 * подзадачи, **обязательные** документы (`requiredDocuments`) и mapping
 * поручения без привязок критериев (`statementMappingDigest`).
 * Необязательные документы — контекст: их правка входит в ревизию набора
 * (новое согласование для непринятых задач), но принятый результат не
 * становится результатом «прежней постановки» — обновлённый документ-ответ
 * владельца не даёт конфликта доставки. Привязки критериев — сведения
 * доставки, не постановка.
 */
export function semanticDigest(config: ConnectorConfig, mapping: TaskMapping, read: TaskRead) {
  return digestOf({
    v: 2,
    identity: taskIdentity(config.provider, config.projectId, read.task.id),
    title: read.task.title,
    description: read.task.description,
    criteria: definitions(read.task.criteria),
    dependencies: [...read.task.dependencies].sort(),
    parent: read.task.parentId,
    children: read.children.map((c) => c.id).sort(),
    documents: docDigests(read.documents.filter((d) => requiredDoc(mapping, d))),
    mapping: statementMappingDigest(config, mapping),
  });
}

/** Текст постановки `task.md` снимка: заголовок, описание и критерии (без заметки о контексте). */
export function taskStatementText(task: TaskRead['task']) {
  const criteriaText = task.criteria
    .map(
      (c) =>
        `- [${c.id}] ${c.title}` +
        (c.summary ? `\n  ${c.summary}` : '') +
        (c.description ? `\n\n  ${c.description.split('\n').join('\n  ')}` : ''),
    )
    .join('\n');
  return (
    `# ${task.key}: ${oneLine(task.title)}\n\n${task.description}\n\n## Критерии приёмки\n\n` +
    (criteriaText || '(критериев нет)') +
    '\n'
  );
}

const documentPath = (id: string) => `documents/${id.replace(/[^A-Za-z0-9_-]/g, '_')}.md`;
const pinnedText = (file: PinnedFile | undefined) =>
  file?.content?.encoding === 'utf8' ? file.content.data : undefined;

/**
 * Та же ли постановка у результата прежней версии (`revision` — digest v1,
 * посчитанный с прежними привязками критериев), что сейчас в backend. Digest
 * v1 при изменённых привязках не пересчитать, поэтому сверяются закреплённые
 * снимком байты, которые видел исполнитель: `task.md` (заголовок, описание,
 * критерии), обязательные документы целиком, зависимости и подзадачи, а также
 * поручение (роль, репозиторий, writeScope, gates). Любое расхождение или
 * отсутствие снимка — не та же постановка.
 */
export function legacyStatementSame(
  store: { snapshots(): { graph: unknown; context: unknown; manifest: unknown }[] },
  op: { revision: string; workId: string },
  read: TaskRead,
  mapping: TaskMapping,
  config: ConnectorConfig,
): boolean {
  for (const record of store.snapshots()) {
    const manifest = record.manifest as SnapshotManifest;
    const task = manifest.tasks.find(
      (t) => t.id === read.task.id && t.semanticDigest === op.revision,
    );
    if (!task) continue;
    const context = record.context as ContextSnapshot;
    const graph = record.graph as WorkGraph;
    const entry = context.sources.find((x) => x.id === contextIdOf(task.orderId));
    const order = graph.orders.find((o) => o.id === task.orderId);
    if (!entry || !order) return false;
    const file = (path: string) => pinnedText(entry.files.find((f) => f.path === path));
    const statement = file('task.md');
    const text = taskStatementText(read.task);
    if (
      statement === undefined ||
      (statement !== text && !statement.startsWith(text + '\n## Контекст из Relay'))
    )
      return false;
    for (const doc of read.documents.filter((d) => requiredDoc(mapping, d)))
      if (file(documentPath(doc.id)) !== doc.body) return false;
    const sorted = (xs: string[]) => [...xs].sort().join('\n');
    if (sorted(task.dependencies.map((d) => d.id)) !== sorted(read.task.dependencies)) return false;
    if (sorted(task.children.map((c) => c.id)) !== sorted(read.children.map((c) => c.id)))
      return false;
    return (
      order.role === mapping.role &&
      order.repositoryId === (mapping.repositoryId ?? config.repository.id) &&
      digestOf(order.writeScope) === digestOf(mapping.writeScope) &&
      digestOf(order.gates ?? null) === digestOf(mapping.gates ?? null)
    );
  }
  return false;
}

/** Digest необязательных документов задачи: входит в ревизию набора, не в постановку. */
export const optionalDocumentsDigest = (mapping: TaskMapping, read: TaskRead) =>
  digestOf(docDigests(read.documents.filter((d) => !requiredDoc(mapping, d))));

/**
 * Относится ли редакция `revision` (поручения, результата, операции доставки)
 * к текущей постановке `read`: digest v2 или прежний v1 (до alpha.66) при
 * той же конфигурации. Результаты прежних версий сверяются по v1, пока
 * постановка и mapping не менялись.
 */
export function statementMatches(
  revision: string,
  config: ConnectorConfig,
  mapping: TaskMapping,
  read: TaskRead,
) {
  return (
    revision === semanticDigest(config, mapping, read) ||
    revision === legacySemanticDigest(config, mapping, read)
  );
}

/** Semantic digest v1 (до alpha.66): с привязками критериев и всеми документами. */
export function legacySemanticDigest(
  config: ConnectorConfig,
  mapping: TaskMapping,
  read: TaskRead,
) {
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

const reasonText: Record<string, string> = {
  'task-target': 'цель задачи',
  'target-feature': 'фича цели',
  'target-scenario': 'сценарий цели',
  'target-application': 'приложение цели',
  'product-passport': 'паспорт продукта',
  'task-document': 'документ задачи',
  'target-document': 'документ цели',
};

const sectionTitle: Record<TaskContextRecord['section'], string> = {
  target: 'Цели задачи (реализации FI/SI, фичи, сценарии)',
  requirement: 'Требования целей (фичи и сценарии)',
  application: 'Приложения',
  product: 'Паспорт продукта',
  document: 'Документы',
};

/** Имя файла контекста задачи в пакете поручения. */
export const TASK_CONTEXT_FILE = 'relay-context.md';

/**
 * Markdown контекста исполнения задачи: только постановка — ключ, название,
 * аннотация, полный Markdown и основания включения (ревизия записи — только
 * в manifest: её может поднять и служебная запись backend). Вычисляемые
 * поля backend (готовность, блокеры, время, токен согласованности) не
 * переносятся: файл и его digest меняются только при правке записей.
 * Документы, уже закреплённые как документы задачи, называются ссылкой на
 * их файл, без повтора текста.
 */
export function renderTaskContext(
  key: string,
  context: TaskContextRead,
  pinnedDocs: Map<string, string>,
): string {
  const lines: string[] = [
    `# Контекст задачи ${key} из Relay`,
    '',
    'Полное описание того, что реализует задача, прочитанное одним согласованным чтением Relay при снимке. ' +
      'Это и есть постановка: читать Relay не нужно (из песочницы исполнителя он недоступен).',
    '',
  ];
  const sections: TaskContextRecord['section'][] = [
    'target',
    'requirement',
    'application',
    'product',
    'document',
  ];
  for (const section of sections) {
    const records = context.records.filter((r) => r.section === section);
    if (!records.length) continue;
    lines.push(`## ${sectionTitle[section]}`, '');
    for (const r of records) {
      const pinned = section === 'document' ? pinnedDocs.get(r.id) : undefined;
      const head = r.key && r.title ? `${r.key}: ${oneLine(r.title)}` : r.key || oneLine(r.title);
      // Тело записи — свой Markdown со своими заголовками: границы записей явные.
      lines.push('---', '', `### ${head}`, '');
      const facts = [
        r.implementation
          ? `реализация ${r.implementation.type}` +
            (r.implementation.application ? ` · приложение ${r.implementation.application}` : '') +
            (r.implementation.target ? ` · цель ${r.implementation.target}` : '')
          : r.kind,
        'включена: ' +
          r.reasons
            .map((x) => (reasonText[x.code] ?? x.code) + (x.from ? ` (${x.from})` : ''))
            .join(', '),
      ];
      lines.push(facts.join(' · '), '');
      if (pinned) {
        lines.push(`Текст — в файле ${pinned} этого контекста.`, '');
        continue;
      }
      if (section === 'product' && r.revision === 0 && !r.body.trim()) {
        lines.push('Паспорт продукта не заполнен.', '');
        continue;
      }
      if (r.summary.trim()) lines.push(`> ${oneLine(r.summary)}`, '');
      lines.push(r.body.trim() ? r.body.trim() : '(полное описание пусто)', '');
    }
  }
  return lines.join('\n');
}

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
  let contextBytes = 0;
  /** Контекст задач по идентичности: часть ревизии набора (новое согласование при правке FI/SI). */
  const contextBy: [string, string][] = [];
  /** Необязательные документы задач: ревизия набора (v2), не постановка задачи. */
  const optionalDocs: [string, string][] = [];
  const limits = config.limits;

  reads.forEach((read, index) => {
    const mapping = config.tasks[index]!;
    const task = read.task;
    const problem = (code: SnapshotProblem['code'], message: string) =>
      problems.push({ code, taskId: task.id, key: task.key, message });
    const orderId = orderIdOf(config.provider, config.projectId, task.id);
    const identityOf = taskIdentity(config.provider, config.projectId, task.id);
    const digest = semanticDigest(config, mapping, read);
    const legacy = legacySemanticDigest(config, mapping, read);
    optionalDocs.push([identityOf, optionalDocumentsDigest(mapping, read)]);

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
    const taskText = taskStatementText(task);
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
          `Обязательный документ ${needle}: найдено ${ruCount(found.length, ['связанный документ', 'связанных документа', 'связанных документов'])}`,
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
      const path = documentPath(doc.id);
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

    // Контекст исполнения задачи: целиком или явная отметка, без усечения.
    let taskContext: TaskManifest['taskContext'];
    const outcome = read.context;
    if (outcome) {
      const fallback = (reason: string) => {
        taskContext = { status: 'too-large', reason };
        contextBy.push([identityOf, 'too-large']);
        missing.push({
          id: 'x' + sha256(identityOf + ':task-context').slice(0, 20),
          reason: `Контекст задачи ${task.key} из Relay не включён: ${reason}. Исполнитель получает задачу, критерии и документы задачи, но не описание функции и сценария`,
        });
      };
      if (outcome.status === 'too-large') fallback(outcome.reason);
      else {
        const pinnedDocs = new Map(
          documents
            // Ссылка вместо текста — только на документ, закреплённый целиком.
            .filter((d) => d.included === 'full')
            .map((d) => [d.id, `documents/${d.id.replace(/[^A-Za-z0-9_-]/g, '_')}.md`]),
        );
        const text = renderTaskContext(task.key, outcome.context, pinnedDocs);
        const bytes = Buffer.byteLength(text);
        const max = config.taskContext.maxBytes;
        if (bytes > max) fallback(`${bytes} байт больше предела taskContext.maxBytes=${max}`);
        else if (contextBytes + bytes > config.taskContext.totalBytes)
          fallback(
            `контекст задач снимка больше предела taskContext.totalBytes=${config.taskContext.totalBytes}`,
          );
        else {
          const file = pin(TASK_CONTEXT_FILE, text);
          files.push(file);
          contextBytes += bytes;
          taskContext = {
            status: 'included',
            records: outcome.context.records.length,
            bytes,
            digest: file.digest,
          };
          // Документ требований, который контекст задачи заменил ссылкой на
          // закреплённый документ задачи, — часть постановки: его содержание
          // входит в ревизию набора и в ревизию постановок (alpha.68), иначе
          // правка его текста прошла бы как правка необязательного документа.
          const referenced = [...pinnedDocs]
            .filter(([, path]) => text.includes(path))
            .map(([id]) => id)
            .sort();
          contextBy.push([
            identityOf,
            referenced.length
              ? digestOf({
                  context: file.digest,
                  documents: referenced.map((id) => [
                    id,
                    sha256(read.documents.find((d) => d.id === id)?.body ?? ''),
                  ]),
                })
              : file.digest,
          ]);
        }
      }
      // Исполнителю сказано, где постановка (или что её нет): строка в task.md.
      const note =
        taskContext?.status === 'included'
          ? `\n## Контекст из Relay\n\nПолное описание функции и сценария (FI/SI), их фичи и сценарии, приложение, паспорт продукта и документы целей — в файле ${TASK_CONTEXT_FILE} этого контекста. Читать Relay не нужно.\n`
          : `\n## Контекст из Relay\n\nПолный контекст задачи не поместился в пределы и не передан; работайте по постановке и документам задачи. Если без описания функции или сценария работу не сделать, задайте вопрос.\n`;
      const index = files.findIndex((f) => f.path === 'task.md');
      if (index >= 0) files[index] = pin('task.md', taskText + note);
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
        ...(taskContext ? { taskContext } : {}),
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
      legacyDigest: legacy,
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
      ...(taskContext ? { taskContext } : {}),
      title: cut(oneLine(task.title), 200),
    });
  });

  const taskIds = reads.map((r) => r.task.id);
  const graphId = graphIdOf(config.provider, config.projectId, taskIds);
  const prereqs = [...prerequisites.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  // Ревизия набора. v2 (alpha.66): постановки задач (semantic digest v2) и
  // необязательные документы отдельно. legacyRevision — те же правила, что до
  // alpha.66: снимок, закреплённый прежней версией, остаётся согласованным.
  // `orders` — без необязательных документов (ревизия постановок, alpha.68).
  const setRevision = (v: 1 | 2 | 'orders') =>
    digestOf({
      v: 1,
      connector,
      tasks: tasks.map((t) => [t.identity, v === 1 ? t.legacyDigest : t.semanticDigest]),
      ...(v === 2
        ? { v: 2, documents: [...optionalDocs].sort(([a], [b]) => (a < b ? -1 : 1)) }
        : v === 'orders'
          ? { v: 'orders' }
          : {}),
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
      // Контекст задачи из backend: правка FI/SI, фичи, сценария, паспорта или
      // документа цели — новое согласование. Без контекста ревизия прежняя.
      ...(contextBy.length
        ? { taskContext: [...contextBy].sort(([a], [b]) => (a < b ? -1 : 1)) }
        : {}),
    });
  const revision = setRevision(2);
  const legacyRevision = setRevision(1);
  const ordersRevision = setRevision('orders');
  const joined = `${config.provider}:${config.projectId}:${taskIds.join('+')}`;
  const parsed = workGraphSchema.safeParse({
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
  // Конфигурация уже проверена: сюда доходит только то, что зависит от данных
  // задач (например, число зависимостей), и причина называется, а не теряется.
  if (!parsed.success)
    throw new HarnessError(
      'NOT_READY',
      'Поручения не собираются из задач: ' +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      parsed.error.issues.map((i) => ({
        path: ['source', ...(i.path as (string | number)[])],
        message: i.message,
      })),
    );
  const graph = parsed.data;
  // Каноническая форма (alpha.68): порядок источников не меняет снимок.
  const context: ContextSnapshot = canonicalContext({
    apiVersion: API_VERSION,
    sources: [...sources, ...(input.local ?? [])],
    missing,
  });
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
    legacyRevision,
    ordersRevision,
    readAt: new Date().toISOString(),
    rounds: input.rounds,
    limits,
    tasks,
    truncated,
    problems,
    ...(input.local?.length ? { localContext: input.local.map(localManifest) } : {}),
    ...((c) => (c ? { compatibility: c } : {}))(relayCompatibility(identity, config)),
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

/**
 * Нарушения договора источника (число файлов и справок, имя файла): запуск
 * проверяет снимок той же схемой, поэтому они видны здесь, а не после approve.
 * Число источников называет `contextLimitIssues`.
 */
function sourceSchemaIssues(context: ContextSnapshot): string[] {
  const parsed = contextSnapshotSchema.safeParse(context);
  if (parsed.success) return [];
  return parsed.error.issues
    .filter((i) => i.path[0] === 'sources' && i.path.length > 2)
    .map((i) => {
      const [, index, field, file] = i.path as [string, number, 'files' | 'references', number?];
      const source = context.sources[index]!;
      const name = file === undefined ? field : (source[field]?.[file]?.path ?? field);
      return `${source.id}/${name}: ${i.message}`;
    });
}

/** Нарушения пределов снимка контекста: число источников, размер файла, сумма и договор источника. */
export function contextLimitIssues(context: ContextSnapshot): string[] {
  const issues = [...contextIssues(context), ...sourceSchemaIssues(context)];
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
  if (!input.config.tasks.length)
    throw new HarnessError(
      'NOT_READY',
      'В конфигурации коннектора нет задач (tasks пуст): связку можно проверить source-check, а снимок и запуск — после того, как задачи добавлены в tasks[]',
    );
  const local = await localContext(input.config, input.contextDir);
  const identity = await checkIdentity(input.transport, input.config, input.signal);
  const { reads, rounds } = await readStable(
    input.transport,
    input.config.tasks.map((t) => t.ref),
    input.config.limits.rereads,
    input.signal,
    taskContextOptions(input.config, identity, input.transport),
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

/** Читать ли контекст задачи: backend объявил capability, транспорт умеет, конфигурация не выключила. */
export function taskContextOptions(
  config: ConnectorConfig,
  identity: Pick<TransportIdentity, 'provider' | 'capabilities' | 'build'>,
  transport: RelayTransport,
): { targetDocuments: boolean; maxBytes: number } | undefined {
  if (!transport.readTaskContext) return undefined;
  if (!relayCompatibility(identity, config)?.taskContextUsed) return undefined;
  return {
    targetDocuments: config.taskContext.targetDocuments,
    maxBytes: config.taskContext.maxBytes,
  };
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
