import { TaskFailure, type FailureKind } from './failure.ts';

/** Отказ окружения до начала работы: попытка не засчитывается. */
export class BlockedError extends Error {
  override name = 'BlockedError';
}

/**
 * Отказ провайдера, а не работы: он повторится на любой следующей выдаче.
 * Список узкий намеренно — временные ошибки сети сюда не входят.
 */
export const providerRefusal = (message: string) =>
  /credit balance|insufficient credit|not logged in|please run \/login|invalid api key|authentication_error|insufficient_quota|unauthorized|oauth token|token expired|401|session limit|usage limit|rate limit|rate_limit|limit reached|too many requests|429|overloaded/i.test(
    message,
  );

/** Класс отказа для случаев, где он не поставлен в точке обнаружения. */
export function classifyFailure(error: unknown, message: string): FailureKind {
  if (error instanceof TaskFailure) return error.kind;
  if (providerRefusal(message)) return 'provider-auth';
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
