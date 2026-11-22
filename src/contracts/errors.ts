/**
 * Коды отказов harness. Код — договор: по нему потребитель решает, что
 * делать, а текст сообщения может меняться. Каждый код относится к одному
 * классу, и класс определяет exit code CLI.
 */
export const errorClasses = {
  /** Вход не прошёл проверку: исправить вход и повторить. */
  input: 2,
  /** Работа отклонена или заблокирована правилами: отказ по существу. */
  refused: 3,
  /** Окружение или инфраструктура не дали выполнить операцию. */
  infrastructure: 4,
} as const;
export type ErrorClass = keyof typeof errorClasses;

export const errorCodes = {
  INVALID_INPUT: 'input',
  UNSUPPORTED_COMMAND: 'input',
  UNSUPPORTED_VERSION: 'input',
  GRAPH_CYCLE: 'input',
  GRAPH_UNKNOWN_DEPENDENCY: 'input',
  GRAPH_DUPLICATE_ID: 'input',
  GATE_UNKNOWN: 'input',
  GATE_GROUP_CYCLE: 'input',
  REVIEWER_SAME_VENDOR: 'input',
  REVIEWER_MISSING: 'input',
  /** Ответ не помещается в предел транспорта даже одним элементом. */
  RESPONSE_TOO_LARGE: 'input',
  /**
   * Чтение без привязанной политики: каталога состояния (или его
   * `binding.json`) нет, а `--policy` не передан (`harness view`).
   */
  POLICY_REQUIRED: 'input',
  APPROVAL_STALE: 'refused',
  APPROVAL_REQUIRED: 'refused',
  LEASE_STALE: 'refused',
  CONTROLLER_BUSY: 'refused',
  PAUSED: 'refused',
  NOT_READY: 'refused',
  SCOPE_VIOLATION: 'refused',
  GATE_FAILED: 'refused',
  REVIEW_REJECTED: 'refused',
  BUDGET_EXHAUSTED: 'refused',
  BUDGET_UNKNOWN: 'refused',
  ATTEMPTS_EXHAUSTED: 'refused',
  /**
   * Засчитанных отказов работы подряд столько, что следующая попытка не
   * выдаётся без диагностики ведущего (`policy.recovery.requireDiagnosisAfter`,
   * `harness diagnose`): третьей слепой попытки нет.
   */
  DIAGNOSIS_REQUIRED: 'refused',
  /** Задача или её контекст не помещаются в окно контекста модели (`context-exhausted`). */
  CONTEXT_EXHAUSTED: 'refused',
  /**
   * Работу держит вопрос исполнителя без применённого ответа (`needs-input`):
   * claim, retry, repair и finish отклоняются до `applyInput`; контекст с
   * неприменённым ответом не активируется обходным согласованием.
   */
  INPUT_REQUIRED: 'refused',
  /**
   * Блокирующий вопрос исполнителя адресован человеку (`actor: user`): ответ
   * ведущего (`--actor lead`) не принимается, пока политика явно не
   * разрешила его до порога серьёзности (`inputPolicy.leadAnswers`).
   */
  OPERATOR_ANSWER_REQUIRED: 'refused',
  REVISION_CONFLICT: 'refused',
  CANCELLED: 'refused',
  NOT_FOUND: 'refused',
  /** Подготовка файлов не пишет через symlink, поверх не-файла и вне корня; путь — в issues. */
  PATH_CONFLICT: 'refused',
  STATE_VERSION_UNSUPPORTED: 'infrastructure',
  RUNTIME_UNAVAILABLE: 'infrastructure',
  /** Ответ reviewer нарушил протокол ревью, повторы reviewer исчерпаны (docs/review-protocol.md). */
  REVIEW_PROTOCOL_INVALID: 'infrastructure',
  SANDBOX_UNAVAILABLE: 'infrastructure',
  GIT_FAILED: 'infrastructure',
  /**
   * Окружение проекта не поднялось без gates и моделей: шаг lifecycle,
   * `prepare` или хранилища зависимостей упал, порт занят, команды нет
   * (`harness smoke`, preflight `lifecyclePreflight` перед `run`). Класс
   * причины и совет — в сообщении и `issues`.
   */
  LIFECYCLE_FAILED: 'infrastructure',
  /**
   * Версия договора или сборка backend коннектора задач не та, с которой
   * проверен коннектор (Relay v1 `contractVersion`, Relay-2 sha256 binary).
   */
  CONNECTOR_VERSION_MISMATCH: 'infrastructure',
  STORAGE_FAILED: 'infrastructure',
  /**
   * Представление оператора больше байтового предела (`OPERATOR_VIEW_LIMITS.bytes`)
   * при списках в своих пределах: частичный документ не выдаётся.
   */
  VIEW_TOO_LARGE: 'infrastructure',
  DELIVERY_FAILED: 'infrastructure',
  INTERNAL: 'infrastructure',
} as const satisfies Record<string, ErrorClass>;
export type ErrorCode = keyof typeof errorCodes;

export interface ErrorIssue {
  path: (string | number)[];
  message: string;
}

/** Нарушение с кодом отказа: один элемент списка проблем проверки. */
export type CodedIssue = ErrorIssue & { code: ErrorCode };

export class HarnessError extends Error {
  readonly class: ErrorClass;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly issues: ErrorIssue[] = [],
  ) {
    super(message);
    this.name = 'HarnessError';
    this.class = errorCodes[code];
  }
  toJSON() {
    return { code: this.code, class: this.class, message: this.message, issues: this.issues };
  }
}

/**
 * Exit codes CLI. 0 — успех; 1 не используется намеренно: им завершается
 * Node при необработанном исключении, и его нельзя спутать с отказом.
 */
export const exitCodes = { ok: 0, ...errorClasses } as const;
export const exitCodeOf = (error: unknown) =>
  error instanceof HarnessError ? errorClasses[error.class] : errorClasses.infrastructure;
