/**
 * Нейтральный транспорт внешнего хранилища задач (Relay v1 HTTP, Relay-2 CLI).
 *
 * Это граница между ядром коннектора (снимок, mapping, доставка, история) и
 * конкретным backend. Транспорт ничего не решает: он читает и выполняет одну
 * мутацию за вызов, без автоматических повторов, и классифицирует отказ так,
 * чтобы ядро могло отличить подтверждённый отказ от неизвестного исхода.
 *
 * Идентификаторы записей — постоянные ID backend (не ключи вида PRODUCT-3:
 * ключ меняется при переносе между досками). Ревизии — числа CAS backend; это
 * не Git SHA и не semantic digest постановки.
 */

export type ProviderId = 'relay-v1-http' | 'relay-v2-cli';

export type TaskColumn = 'inbox' | 'ready' | 'in-progress' | 'review' | 'done' | 'cancelled';

/** Сведения о backend, по которым проверяется совместимость (не по имени binary/версии 0.0.0). */
export interface TransportIdentity {
  provider: ProviderId;
  /** Постоянный ID проекта backend; сверяется с настроенным до любой мутации. */
  projectId: string;
  /** Capabilities, объявленные backend (v1 — `GET /context`), или выведенные пробами (v2). */
  capabilities: string[];
  /** Наблюдаемая идентичность сборки: версия сервера/commit/sha256 binary — что доступно. */
  build: Record<string, string>;
}

export interface CriterionRecord {
  id: string;
  title: string;
  summary: string;
  description: string;
  completed: boolean;
}

export interface TaskRecord {
  id: string;
  key: string;
  title: string;
  description: string;
  column: TaskColumn;
  /** CAS-ревизия задачи backend. */
  revision: number;
  parentId: string | null;
  /** Постоянные ID задач, от которых зависит эта. */
  dependencies: string[];
  criteria: CriterionRecord[];
}

/** Краткая запись связанной задачи (зависимость или подзадача) для eligibility. */
export interface TaskSummary {
  id: string;
  key: string;
  title: string;
  column: TaskColumn;
  revision: number;
  /** Транзитивно завершена по правилам backend (done + критерии + дети + зависимости). */
  finished: boolean;
}

export interface DocumentRecord {
  id: string;
  key: string;
  name: string;
  body: string;
  revision: number;
}

export interface CommentRecord {
  id: string;
  title: string;
  body: string;
  actor: string;
  createdAt: string;
}

/**
 * Полное чтение одной задачи со связанными записями. `consistency` — то, чем
 * backend позволяет доказать, что все страницы относятся к одной редакции
 * (v2 — generation хранилища до и после; v1 — ревизии/версии страниц). Ядро
 * сравнивает два последовательных чтения и не строит граф из разных редакций.
 */
export interface TaskRead {
  task: TaskRecord;
  children: TaskSummary[];
  dependencies: TaskSummary[];
  documents: DocumentRecord[];
  consistency: { before: string; after: string };
  /**
   * Контекст исполнения задачи, если его читал снимок (capability backend и
   * `taskContext.mode: auto`). Транспорт в `readTask` его не заполняет.
   */
  context?: TaskContextOutcome;
}

/**
 * Запись контекста исполнения задачи (Relay `relay-task-context-v1`): цель
 * FI/SI, её фича или сценарий, приложение, паспорт продукта или документ — с
 * полным Markdown, ключом, ревизией и основаниями включения. Вычисляемые поля
 * backend (готовность, блокеры, время) сюда не переносятся: они меняются без
 * правки записи и не являются постановкой.
 */
export interface TaskContextRecord {
  section: 'target' | 'requirement' | 'application' | 'product' | 'document';
  kind: string;
  id: string;
  key: string;
  title: string;
  revision: number;
  summary: string;
  /** Полный Markdown записи (`description`, у документа — `body`). */
  body: string;
  /** Реализация FI/SI: тип, приложение и цель (ключи). */
  implementation?: { type: string; application?: string; target?: string };
  /** Основания: код и ключ записи, через которую включена (`null` — паспорт). */
  reasons: { code: string; from: string | null }[];
}

/** Контекст исполнения задачи одним согласованным чтением. */
export interface TaskContextRead {
  /** Версия формы ответа backend (`contractVersion`). */
  contractVersion: number;
  /** Токен согласованности ответа backend (меняется при любом изменении, в том числе вычисляемом). */
  consistency: string;
  /** Ревизия задачи в этом ответе: сверяется с полным чтением задачи. */
  taskRevision: number;
  records: TaskContextRecord[];
}

/** Итог чтения контекста: прочитан целиком или не помещается в пределы (без усечения). */
/**
 * `inconsistent` (alpha.69): контекст менялся во время чтения при всех
 * повторах транспорта — раунд снимка не согласован и перечитывается.
 */
export type TaskContextOutcome =
  | { status: 'ok'; context: TaskContextRead }
  | { status: 'too-large'; reason: string }
  | { status: 'inconsistent'; reason: string };

/**
 * Открытый вопрос владельцу, записанный в backend документом по соглашению
 * Relay (`Вопрос: …`, тип `proposal`, состояние `draft`). Только чтение.
 */
export interface SourceQuestionRecord {
  id: string;
  key: string;
  title: string;
  revision: number;
  /** Полный Markdown документа (разделы вопроса, вариантов, рекомендации, временного ответа). */
  body: string;
  /** Ключи записей, к которым прикреплён вопрос (ID, если ключ неизвестен). */
  targets: string[];
  updatedAt?: string;
}

export interface SessionRecord {
  id: string;
  key: string;
  status: 'pending' | 'open' | 'paused' | 'completed' | 'cancelled';
  revision: number;
  currentRunId: string | null;
  parentSessionId: string | null;
  title: string;
  description: string;
  result: string;
}

export interface CheckpointRecord {
  id: string;
  key: string;
  sessionId: string;
  runId: string;
  kind: 'intent' | 'progress' | 'result' | 'cancel';
  intentId: string | null;
  title: string;
  body: string;
}

/** Результат мутации истории: новая ревизия сессии и созданные записи. */
export interface HistoryMutation {
  session: SessionRecord;
  runId?: string;
  checkpoint?: CheckpointRecord;
  childSession?: SessionRecord;
}

export interface CheckpointInput {
  title: string;
  body: string;
  summary?: string;
  checks?: string;
  /** Ссылки на записи backend (ключи/ID задач). */
  references?: string[];
  acceptedSessionIds?: string[];
}

/**
 * Класс отказа транспорта:
 * - `conflict` — CAS/состояние: мутация точно не применена (REVISION_CONFLICT,
 *   WORK_RUN_NOT_CURRENT, history CONFLICT);
 * - `refused` — доменный отказ backend, мутация не применена (done guards,
 *   валидация);
 * - `not-found` — запись или проект отсутствует (это не «пустой список»);
 * - `unavailable` — запрос точно не дошёл до backend (нет binary, connection
 *   refused до отправки);
 * - `protocol` — ответ не соответствует договору (невалидный JSON/envelope,
 *   слишком большой вывод); для мутации исход неизвестен, если запрос мог
 *   дойти;
 * - `uncertain` — мутация могла примениться: таймаут/обрыв после отправки,
 *   отмена после старта процесса. Повтор без read-back запрещён;
 * - `unsupported` — нужной операции/capability у backend нет.
 */
export type TransportErrorKind =
  'conflict' | 'refused' | 'not-found' | 'unavailable' | 'protocol' | 'uncertain' | 'unsupported';

export class TransportError extends Error {
  override name = 'TransportError';
  constructor(
    readonly kind: TransportErrorKind,
    /** Операция транспорта (`task.move`, `history.checkpoint`…). */
    readonly operation: string,
    /** Безопасная причина без секретов и без полного вывода backend. */
    message: string,
    readonly details: {
      provider: ProviderId;
      projectId?: string;
      /** Стабильный код backend (`REVISION_CONFLICT`…), если он есть. */
      code?: string;
      /** Текущая ревизия при конфликте, если backend её сообщил. */
      actualRevision?: number;
      /** Была ли это мутация (для `protocol`/`uncertain` — исход неизвестен). */
      mutation?: boolean;
    },
  ) {
    super(message);
  }
}

/**
 * Транспорт одного настроенного проекта. Все вызовы адресуют ровно этот
 * проект (v1 — project-scoped routes, v2 — явные `--config`/`--project`);
 * cwd процесса на выбор проекта не влияет. Мутации выполняются один раз:
 * повторы, read-back и восстановление — решение ядра коннектора.
 */
export interface RelayTransport {
  readonly provider: ProviderId;
  /** Проверка подключения и совместимости без мутаций и без записи истории. */
  identity(signal?: AbortSignal): Promise<TransportIdentity>;

  readTask(ref: string, signal?: AbortSignal): Promise<TaskRead>;
  /**
   * Контекст исполнения задачи (необязательный метод): вызывается, только
   * если backend объявил capability контекста. Превышение пределов —
   * `too-large`, а не усечённый ответ; прочие отказы — исключение.
   */
  readTaskContext?(
    ref: string,
    options: { targetDocuments: boolean; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<TaskContextOutcome>;
  /** Открытые вопросы владельцу (необязательный метод, только чтение). */
  listOpenQuestions?(
    options: { limit: number },
    signal?: AbortSignal,
  ): Promise<{ questions: SourceQuestionRecord[]; total: number }>;
  listComments(ref: string, signal?: AbortSignal): Promise<CommentRecord[]>;

  addComment(
    ref: string,
    input: { title: string; body: string },
    signal?: AbortSignal,
  ): Promise<{ commentId: string }>;
  setCriterion(
    ref: string,
    input: { criterionId: string; completed: boolean; ifRevision: number },
    signal?: AbortSignal,
  ): Promise<{ revision: number }>;
  move(
    ref: string,
    input: { column: TaskColumn; ifRevision: number },
    signal?: AbortSignal,
  ): Promise<{ revision: number }>;

  /* История работы. Ревизия — всегда ревизия сессии; runId — fencing. */
  startSession(
    input: { title: string; description: string; client: string; sourceSessionId?: string },
    signal?: AbortSignal,
  ): Promise<HistoryMutation>;
  getSession(ref: string, signal?: AbortSignal): Promise<SessionRecord>;
  /** Сессии, у которых title/description содержит marker: read-back после неизвестного исхода. */
  findSessions(marker: string, signal?: AbortSignal): Promise<SessionRecord[]>;
  /** Чекпоинты сессии в хронологическом порядке. */
  checkpoints(sessionRef: string, signal?: AbortSignal): Promise<CheckpointRecord[]>;
  openIntent(
    sessionRef: string,
    input: CheckpointInput & { runId: string; ifRevision: number },
    signal?: AbortSignal,
  ): Promise<HistoryMutation>;
  checkpoint(
    intentRef: string,
    kind: 'progress' | 'result' | 'cancel',
    input: CheckpointInput & { runId: string; ifRevision: number },
    signal?: AbortSignal,
  ): Promise<HistoryMutation>;
  fork(
    intentRef: string,
    input: { runId: string; ifRevision: number; title: string; description: string },
    signal?: AbortSignal,
  ): Promise<HistoryMutation>;
  attach(
    sessionRef: string,
    input: { ifRevision: number; client: string; sourceSessionId?: string },
    signal?: AbortSignal,
  ): Promise<HistoryMutation>;
  takeover(
    sessionRef: string,
    input: { ifRevision: number; reason: string; client: string },
    signal?: AbortSignal,
  ): Promise<HistoryMutation>;
  finishSession(
    sessionRef: string,
    outcome: 'complete' | 'cancel',
    input: { runId?: string; ifRevision: number; result: string },
    signal?: AbortSignal,
  ): Promise<HistoryMutation>;
}
