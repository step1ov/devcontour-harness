import {
  BlockedError,
  HarnessError,
  TaskFailure,
  type EnvironmentCause,
  type ErrorCode,
  type FailureKind,
} from '../contracts/index.ts';

export { BlockedError };

/**
 * Отказ провайдера, а не работы: он повторится на любой следующей выдаче.
 * Список узкий намеренно — временные ошибки сети сюда не входят.
 */
export const providerRefusal = (message: string) =>
  /credit balance|insufficient credit|not logged in|please run \/login|invalid api key|authentication_error|insufficient_quota|unauthorized|oauth token|token expired|401|session limit|usage limit|rate limit|rate_limit|limit reached|too many requests|429|overloaded/i.test(
    message,
  );

/**
 * Транспортный отказ до провайдера: TLS/DNS/соединение. Код распознаётся
 * отдельным словом, а не внутри идентификатора; голые «TLS», «DNS», «network»
 * сюда не входят. Проверяется до общего timeout: `connect ETIMEDOUT` — сеть,
 * а не исчерпанный срок попытки.
 */
const transportFailure = (message: string) =>
  /\b(?:eproto|econnrefused|enotfound|eai_again|etimedout|ehostunreach|enetunreach)\b|\btls handshake (?:failed|timeout)\b/i.test(
    message,
  );

/** Класс отказа для случаев, где он не поставлен в точке обнаружения. */
/** Отказ движка с кодом, который сам называет класс отказа попытки. */
const byCode: Partial<Record<ErrorCode, FailureKind>> = {
  GATE_FAILED: 'gate',
  REVIEW_REJECTED: 'review',
  REVIEW_PROTOCOL_INVALID: 'review-protocol',
  SCOPE_VIOLATION: 'scope-violation',
  BUDGET_EXHAUSTED: 'budget',
};

export function classifyFailure(error: unknown, message: string): FailureKind {
  if (error instanceof TaskFailure) return error.kind;
  // Приёмка отказала по правилу (нет доказательства, ревью, область): класс —
  // это правило, а не «неизвестно».
  if (error instanceof HarnessError && byCode[error.code]) return byCode[error.code]!;
  if (providerRefusal(message)) return 'provider-auth';
  if (transportFailure(message)) return 'environment';
  if (/исчерпан лимит времени|истёк|истек|тайм-?аут|timeout|превысил/i.test(message))
    return 'timeout';
  if (
    error instanceof BlockedError ||
    /отменен|прерван|abort|econnreset|epipe|socket hang up|connection reset|stream closed|channel closed|fetch failed|network error/i.test(
      message,
    )
  )
    return 'environment';
  return 'unknown';
}

/** Предел или баланс провайдера, а не учётные данные (часть `providerRefusal`). */
const providerLimit = (message: string) =>
  /credit balance|insufficient credit|insufficient_quota|session limit|usage limit|rate limit|rate_limit|limit reached|too many requests|\b429\b|overloaded/i.test(
    message,
  );

/**
 * Причина отказа окружения (`attempt.diagnosed`): названная в точке
 * обнаружения (`TaskFailure.diagnosis`), иначе — по тем же признакам, что
 * класс отказа. Отказ не окружения — `none`; движок приводит причину к
 * классу сам, поэтому здесь достаточно лучшей догадки.
 */
export function environmentCauseOf(
  error: unknown,
  message: string,
  kind: FailureKind,
): EnvironmentCause {
  if (kind === 'stalled') return 'stalled';
  if (kind === 'provider-auth') return providerLimit(message) ? 'provider-limit' : 'provider-auth';
  if (kind !== 'environment') return 'none';
  if (error instanceof TaskFailure && error.diagnosis) return error.diagnosis;
  if (
    transportFailure(message) ||
    /econnreset|epipe|socket hang up|connection reset|stream closed|channel closed|fetch failed|network error/i.test(
      message,
    )
  )
    return 'transport';
  if (error instanceof BlockedError) return 'preflight';
  return 'other';
}
