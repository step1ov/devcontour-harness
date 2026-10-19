import type { RuntimeName } from './primitives.ts';
import type { RuntimeBinding } from './policy.ts';
import type { WorkGraph, Prerequisite, SourceRef } from './work.ts';
import type { ContextSnapshot } from './context.ts';
import type { ContractDocument } from './checks.ts';
import type { RunResult } from './result.ts';
import type { RunEvent, RunEventDraft, TransactionKind } from './events.ts';
import type {
  AttemptState,
  CallRecord,
  EvidenceRecord,
  ControlState,
  ControllerLease,
  GraphState,
  JointVerificationState,
  LocalNamespace,
  LocalValue,
  Usage,
  WorkState,
} from './execution.ts';

/* ------------------------------------------------------------------ */
/* ExecutionStore                                                      */
/* ------------------------------------------------------------------ */

/** Чтение состояния исполнения из одного согласованного снимка. */
export interface ExecutionView {
  control(): ControlState;
  controller(): ControllerLease | undefined;
  graph(id: string): GraphState | undefined;
  graphs(): GraphState[];
  work(id: string): WorkState | undefined;
  works(graphId?: string): WorkState[];
  attempt(id: string): AttemptState | undefined;
  attempts(workId?: string): AttemptState[];
  verification(id: string): JointVerificationState | undefined;
  verifications(): JointVerificationState[];
  /**
   * Локальные записи исполнения, адресуемые `(namespace, owner, key)`.
   * Пространства и схемы — `localSchemas`; `owner` — репозиторий, за которым
   * закреплена запись, или `WORKSPACE_OWNER`. Адаптер хранит их в той же
   * базе, что и состояние владельца, и проверяет схему при чтении и записи.
   */
  local<N extends LocalNamespace>(
    namespace: N,
    owner: string,
    key: string,
  ): LocalValue<N> | undefined;
  /** Все записи пространства у владельца; без `owner` — у всех владельцев. */
  locals<N extends LocalNamespace>(
    namespace: N,
    owner?: string,
  ): { owner: string; key: string; value: LocalValue<N> }[];
}

/**
 * Запись внутри транзакции. Все изменения транзакции фиксируются вместе или
 * не фиксируются вовсе; события, записанные `emit`, получают номера только
 * при фиксации.
 */
export interface ExecutionTransaction extends ExecutionView {
  putGraph(graph: GraphState): void;
  putWork(work: WorkState): void;
  putAttempt(attempt: AttemptState): void;
  putVerification(verification: JointVerificationState): void;
  setControl(control: ControlState): void;
  setController(lease: ControllerLease | undefined): void;
  putLocal<N extends LocalNamespace>(
    namespace: N,
    owner: string,
    key: string,
    value: LocalValue<N>,
  ): void;
  emit(event: RunEventDraft): void;
}

/** Результат транзакции не может быть Promise: внутри нельзя ждать внешней работы. */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * Транзакционный порт состояния исполнения.
 *
 * Договор, который проверяет общий набор тестов обоих адаптеров:
 * - `transact` сериализуем: два процесса над одной базой не видят частичных
 *   записей друг друга, вторая транзакция видит результат первой;
 * - исключение внутри `fn` откатывает все изменения и события;
 * - `fn` синхронна; адаптер отклоняет возврат Promise;
 * - вложенный `transact` выполняется в той же транзакции и видит её
 *   несохранённые изменения; исключение во вложенном откатывает только его
 *   изменения и события; изменения вложенного и внешнего сохраняются оба;
 * - события транзакции — только явно записанные `emit`; возвращаемое `fn`
 *   значение в журнал не попадает (в нём бывают токены владения);
 * - событие фиксируется вместе с транзакцией, даже если она не изменила
 *   записей модели (только `emit` или только локальная запись и `emit`);
 * - `kind === 'heartbeat'` продлевает только сроки владения и не создаёт события;
 * - внутри `fn` допустим один синхронный внешний эффект — CAS продвижения
 *   target ref (`git update-ref <ref> <new> <old>`) при приёмке: он
 *   выполняется до фиксации, и его отказ откатывает транзакцию. Падение
 *   процесса между update-ref и фиксацией разбирает recovery по
 *   сохранённому integration SHA.
 *
 * Правила переходов (claim, finish, fencing, приёмка) реализует движок
 * поверх этого порта; адаптер не принимает решений и не меняет их.
 */
export interface ExecutionStore {
  readonly stateVersion: number;
  transact<T>(kind: TransactionKind, fn: (tx: ExecutionTransaction) => NotPromise<T>): T;
  read<T>(fn: (view: ExecutionView) => NotPromise<T>): T;
  /** События строго после `after`, по возрастанию `seq`. */
  events(after?: number, limit?: number): RunEvent[];
  close(): void;
}

/* ------------------------------------------------------------------ */
/* RuntimeAdapter                                                      */
/* ------------------------------------------------------------------ */

export type RuntimeTask = 'implement' | 'review-code' | 'review-plan' | 'review-contract' | 'plan';

export interface SandboxSpec {
  mode: 'os' | 'none';
  /** Каталоги, доступные на запись; всё остальное — только чтение или закрыто. */
  writable: string[];
  /** Пути, закрытые и на чтение: состояние controller, учётные данные, чужие checkout. */
  denied: string[];
  /** Что внутри закрытого снова открыто на чтение (свой worktree внутри каталога состояния). */
  readable?: string[];
  network: { domains: string[] };
}

export interface RuntimeRequest {
  /** Идентификатор вызова для учёта и диагностики. */
  callId: string;
  task: RuntimeTask;
  /**
   * Предмет вызова исполнения: поручение, попытка и фаза. Адаптер хоста
   * может найти по нему свои сведения о задаче; в запросе модели их нет.
   */
  subject?: { workId: string; attemptId: string; phase: string };
  binding: RuntimeBinding;
  cwd: string;
  prompt: string;
  /** JSON Schema структурированного ответа; ответ вне схемы — отказ, не самооценка. */
  outputSchema?: Record<string, unknown>;
  /**
   * Сессия всегда новая для reviewer и planner. `continue` разрешён только
   * writer той же попытки; reviewer не получает ID сессии writer.
   */
  session: { kind: 'fresh' } | { kind: 'continue'; id: string };
  sandbox: SandboxSpec;
  timeoutMs: number;
  env: Record<string, string>;
  /** Каталог служебных файлов вызова (схема ответа, журнал); вне worktree. */
  artifactDir?: string;
  /** Значения, которые маскируются в тексте ответа, журнале и диагностике. */
  secrets?: string[];
  /**
   * Сервер проверок reviewer с пределами controller (только ревью кода).
   * Адаптер подключает его к CLI как MCP-сервер; переменные окружения
   * передаются серверу по имени, значения на диск не пишутся.
   */
  probe?: ProbeServer;
}

/** Команда запуска сервера проверок reviewer и его пределы. */
export interface ProbeServer {
  command: string;
  args: string[];
  /** Имена переменных окружения, которые CLI передаёт серверу. */
  env: string[];
  commandTimeoutMs: number;
}

export interface RuntimeResponse {
  status: 'ok' | 'failed' | 'timeout' | 'cancelled' | 'unavailable';
  /**
   * Сырой структурированный ответ — вход парсера. Движок разбирает его
   * `implementationResultSchema`/`reviewResultSchema`; невалидный ответ —
   * отказ, а не самооценка.
   */
  output?: unknown;
  /** Модель, о которой сообщил runtime (по ней выбирается тариф); `null` — не сообщил. */
  model: string | null;
  /** Версия CLI runtime (`<runtime> --version`); `null` — неизвестна. */
  runtimeVersion: string | null;
  /** Текст ответа после маскирования секретов. */
  text: string;
  sessionId?: string;
  usage: Usage;
  /** Безопасная диагностика: код выхода, причина, путь сохранённого журнала. */
  diagnostics: { exitCode: number | null; reason?: string; log?: string };
  /** Что reviewer выполнил по событиям runtime (только для ревью). */
  inspection?: NonNullable<EvidenceRecord['inspection']>;
}

export interface RuntimeCapabilities {
  runtime: RuntimeName;
  version?: string;
  structuredOutput: boolean;
  sandbox: ('os' | 'none')[];
  cancellation: boolean;
  usage: boolean;
  /** Это управляемая подделка (fixture), а не живая модель. */
  fixture: boolean;
}

export interface RuntimeAdapter {
  readonly runtime: RuntimeName;
  capabilities(): Promise<RuntimeCapabilities>;
  /** Отмена через `signal` завершает все процессы вызова, включая дочерние. */
  invoke(request: RuntimeRequest, signal: AbortSignal): Promise<RuntimeResponse>;
}

/* ------------------------------------------------------------------ */
/* Connectors                                                          */
/* ------------------------------------------------------------------ */

/**
 * Источник поручений. Повторное чтение той же редакции возвращает тот же
 * граф и не создаёт нового запуска: запуск идемпотентен по (connector, ref,
 * revision, digest).
 */
export interface WorkSource {
  readonly id: string;
  fetch(ref: string): Promise<{ graph: WorkGraph; source: SourceRef }>;
  /** Текущая редакция записи в источнике — для обнаружения конфликта при доставке. */
  revision(ref: string): Promise<string | undefined>;
  /**
   * Доверяет ли источник receipt внешней предпосылки. По умолчанию — нет;
   * доверие не отменяет проверку доступности result SHA в target ref.
   */
  trusts(prerequisite: Prerequisite): Promise<boolean>;
}

/** Источник закрепляемого контекста; не требует хранилища задач. */
export interface ContextSource {
  readonly id: string;
  snapshot(ids: string[], at: { repositoryId: string; sha?: string }): Promise<ContextSnapshot>;
}

export type DeliveryOutcome =
  { status: 'delivered'; receipt?: string } | { status: 'conflict'; currentRevision: string };

/**
 * Получатель результата. Доставка идемпотентна по `key`: повтор с тем же
 * ключом не создаёт второй записи. Получатель не может менять политику,
 * выдавать lease, ослаблять gates или ставить технический PASS — у порта
 * нет таких операций.
 */
export interface ResultSink {
  readonly id: string;
  deliver(input: { key: string; result: RunResult }): Promise<DeliveryOutcome>;
}

/* ------------------------------------------------------------------ */
/* ExecutionHost                                                       */
/* ------------------------------------------------------------------ */

/**
 * Основания согласования и попыток. Формулы digest — договор хоста:
 * DevContour вычисляет их по сохранённым формулам (они включают поля
 * продукта и записаны в принятой истории), standalone — `digestOf` от
 * нейтральных структур. Движок сравнивает строки и никогда не вычисляет
 * основание хоста сам: иначе прежние согласования стали бы недействительны.
 */
export interface BasisProvider {
  /** Digest постановки, который обязано совпасть с согласованным. */
  orderDigest(work: WorkState, view: ExecutionView): string;
  /** Digest области проверок (gates, потребители). */
  scopeDigest(work: WorkState, view: ExecutionView): string;
  /** Digest политики для попытки этого поручения. */
  policyDigest(work: WorkState, view: ExecutionView): string;
  /**
   * Версия проверок попытки по формуле хоста; без неё — формула harness
   * (`effectiveChecks`). Хост с принятой историей держит свою формулу: ею
   * подписаны его записи и receipts.
   */
  checksDigest?(work: WorkState, policyDigest: string, view: ExecutionView): string;
  /**
   * Digest политики совместной проверки по формуле хоста; без неё — формула
   * harness. Хост с принятыми проверками держит свою: ею подписаны его записи.
   */
  jointPolicyDigest?(view: ExecutionView): string;
  /**
   * Основание совместной проверки набора по формуле хоста (у DevContour — снимок
   * ChangeSet: доски и задачи). `verificationId` — проверка, основание которой
   * сверяется; при начале проверки её ещё нет.
   */
  jointSpecDigest?(workIds: string[], view: ExecutionView, verificationId?: string): string;
  /**
   * Основание эпизода разбора по свойству (постановка и контракты поручения)
   * по формуле хоста; без неё — формула harness (`episodeBasis`). Хост с
   * прежними эпизодами держит свою: ею подписаны их основания.
   */
  episodeBasis?(work: WorkState, view: ExecutionView): string;
  /**
   * Нормативное основание корпуса договора проверки по формуле хоста; без неё —
   * формула harness (`suiteBasis`). Хост с прежними корпусами держит свою: ею
   * записано основание его корпусов и ID их случаев.
   */
  suiteBasis?(contract: ContractDocument): string;
}

/** Причина, по которой хост не разрешает действие; `null` — разрешено. */
export type HostRefusal = {
  code: 'NOT_READY' | 'APPROVAL_STALE' | 'PAUSED';
  message: string;
} | null;

/**
 * Дополнительные условия хоста поверх правил движка. Вызываются синхронно
 * внутри той же транзакции, что и решение движка, и могут только запретить:
 * снять отказ движка, выдать lease или поставить PASS хост не может.
 *
 * DevContour проверяет здесь продуктовые условия на закреплённой версии:
 * актуальность продуктового согласования, видимость в активной ревизии доски,
 * назначение участнику, барьер активной поставки/совместной проверки, размер
 * receipt. Standalone-хост ничего не добавляет.
 */
export interface HostGuards {
  /** Можно ли выдать claim этому поручению сейчас. */
  claimable(work: WorkState, view: ExecutionView): HostRefusal;
  /** Глобальный барьер выдачи: активная поставка, операция хоста. */
  claimBarrier(view: ExecutionView): HostRefusal;
  /** Остаются ли входы попытки действительными: при claim и в каждой fenced-операции. */
  current(work: WorkState, attempt: AttemptState | undefined, view: ExecutionView): HostRefusal;
  /** Последняя проверка перед приёмкой, в транзакции приёмки, до CAS. */
  beforeAccept(work: WorkState, attempt: AttemptState, view: ExecutionView): HostRefusal;
  /**
   * Работы хоста, идущие под действующей политикой (поставка, preview):
   * применение новой политики их дожидается так же, как попыток движка.
   */
  busy?(view: ExecutionView): string[];
  /**
   * Продуктовые условия совместной проверки (у DevContour — ChangeSet не
   * принят, закреплённая проверка продуктового релиза): в каждой её записи,
   * кроме продления срока, на состоянии после записи (закреплённый manifest,
   * итог), в той же транзакции; отказ откатывает запись.
   */
  joint?(verification: JointVerificationState, view: ExecutionView, kind: string): HostRefusal;
}

/**
 * Области бюджетов. `work` — поручение; `group` — группировка хоста (у
 * DevContour — доска со всеми её ревизиями; standalone — граф); `total` —
 * вся установка. Атрибуция вызова закрепляется в `CallRecord` при вызове;
 * этот порт даёт её для нового вызова и один раз — для прежних записей.
 */
export interface BudgetScopes {
  /** Группа поручения сейчас; `undefined` — поручение вне группы. */
  groupOf(workId: string, view: ExecutionView): string | undefined;
  /** Все поручения группы, включая прежние редакции её состава. */
  members(groupId: string, view: ExecutionView): string[];
  /**
   * Атрибуция записи без закреплённых `workId`/`groupId`/`workIds`
   * (записи прежних версий): вычисляется по текущему графу один раз и
   * записывается; повторно не пересчитывается.
   */
  legacy(
    record: CallRecord,
    view: ExecutionView,
  ): Pick<CallRecord, 'workId' | 'groupId' | 'workIds'>;
}

/**
 * Согласование контрактов хостом. Хост, который сам ведёт согласование
 * контрактов (у DevContour — утверждённая редакция контракта с её историей
 * ревью), подтверждает, что редакция этого digest согласована: `null` —
 * согласована, иначе причина. Без порта согласованием служит одобренный
 * последний раунд технического ревью этого digest (`reviews`) при текущем
 * назначении reviewer. Записи ревью из сведений хоста не выдумываются.
 */
export interface ContractApprovals {
  approved(ref: { id: string; digest: string }, view: ExecutionView): HostRefusal;
}

/** Хост, внутри которого работает движок: хранилище, основания, условия и области бюджетов. */
export interface ExecutionHost {
  store: ExecutionStore;
  basis: BasisProvider;
  guards: HostGuards;
  budgets: BudgetScopes;
  /** Согласование контрактов хоста; нет — по раундам технического ревью. */
  contracts?: ContractApprovals;
  /** Версия потребителя (например, DevContour); записывается в попытку рядом с версией движка. */
  consumerVersion?: string;
}
