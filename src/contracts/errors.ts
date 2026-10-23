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
  STORAGE_FAILED: 'infrastructure',
  DELIVERY_FAILED: 'infrastructure',
  INTERNAL: 'infrastructure',
} as const satisfies Record<string, ErrorClass>;
export type ErrorCode = keyof typeof errorCodes;

export interface ErrorIssue {
  path: (string | number)[];
  message: string;
}

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
