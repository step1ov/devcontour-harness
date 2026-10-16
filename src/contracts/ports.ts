import type { RuntimeName } from './primitives.ts';
import type { RuntimeBinding } from './policy.ts';
import type { WorkGraph, Prerequisite, SourceRef } from './work.ts';
import type { ContextSnapshot } from './context.ts';
import type { RunResult } from './result.ts';
import type { RunEvent, RunEventDraft, TransactionKind } from './events.ts';
import type {
  AttemptState,
  ControlState,
  ControllerLease,
  GraphState,
  WorkState,
} from './state.ts';

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
  /**
   * Локальные записи исполнения: idempotency-ключи, учёт вызовов, receipts
   * доставки, решения ограниченного восстановления. Пространство имён
   * задаёт движок; адаптер хранит их рядом с состоянием, в той же базе.
   */
  local<T>(namespace: string, key: string): T | undefined;
  locals<T>(namespace: string): Record<string, T>;
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
  setControl(control: ControlState): void;
  setController(lease: ControllerLease | undefined): void;
  putLocal(namespace: string, key: string, value: unknown): void;
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
 * - вложенный `transact` выполняется в той же транзакции (savepoint);
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
  network: { domains: string[] };
}

export interface RuntimeUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reportedUsd: number | null;
  complete: boolean;
  source: 'codex-turn-events' | 'claude-result' | 'fixture' | 'unavailable';
}

export interface RuntimeRequest {
  /** Идентификатор вызова для учёта и диагностики. */
  callId: string;
  task: RuntimeTask;
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
}

export interface RuntimeResponse {
  status: 'ok' | 'failed' | 'timeout' | 'cancelled' | 'unavailable';
  /** Разобранный структурированный ответ; `undefined`, если его нет или он невалиден. */
  output?: unknown;
  /** Текст ответа после маскирования секретов. */
  text: string;
  sessionId?: string;
  usage: RuntimeUsage;
  /** Безопасная диагностика: код выхода, причина, путь сохранённого журнала. */
  diagnostics: { exitCode: number | null; reason?: string; log?: string };
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
}

/** Хост, внутри которого работает движок: хранилище, основания и условия. */
export interface ExecutionHost {
  store: ExecutionStore;
  basis: BasisProvider;
  guards: HostGuards;
  /** Версия потребителя (например, DevContour); записывается в попытку рядом с версией движка. */
  consumerVersion?: string;
}
