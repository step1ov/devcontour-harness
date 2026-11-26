import {
  BlockedError,
  HarnessError,
  TaskFailure,
  type EnvironmentCause,
  type ErrorCode,
  type FailureKind,
  withoutStepOutput,
} from '../contracts/index.ts';

import { CleanupFailure } from '../environment/lifecycle.ts';
import { ReapFailure } from '../environment/process.ts';
import { ToolchainPinError } from '../environment/toolchain-pin.ts';
import { ReapedGate } from '../verification/reaped.ts';

export { BlockedError };

/**
 * Отказ, по которому судится попытка: у незавершённой очистки окружения —
 * исходный отказ работы (`CleanupFailure.original`, через все вложенные
 * очистки), иначе сам отказ.
 */
export function failureOrigin(error: unknown): unknown {
  let origin = error;
  while (origin instanceof CleanupFailure && origin.original) origin = origin.original;
  return origin;
}

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

/**
 * Реестр образов или пакетов оборвал загрузку (alpha.71, C1; ревью C
 * MEDIUM-3): в одной строке (или звене вывода шага, `|`) — контекст загрузки
 * (`docker pull`, `Pulling`, `/v2/`, `registry`, `manifest`,
 * `ERR_PNPM_FETCH`, `npm ERR! network`) и обрыв (`EOF`, таймаут TLS или
 * ввода-вывода, сброс соединения, `toomanyrequests`, `request canceled`).
 * Классом отказа это не становится само: решает runner — только до кода
 * исполнителя или на шаге загрузки (`registryPullStep`).
 */
export const registryPullFailure = (full: string) =>
  full
    .split(/\n| \| /)
    .some(
      (line) =>
        /docker pull|\bPulling\b|\/v2\/|registry|manifest|ERR_PNPM_FETCH|npm ERR! network/i.test(
          line,
        ) &&
        /\bEOF\b|i\/o timeout|TLS handshake timeout|connection reset by peer|context deadline exceeded|toomanyrequests|request canceled|\bETIMEDOUT\b|\bECONNRESET\b|pull access denied/i.test(
          line,
        ),
    );

/** Упавший шаг — шаг загрузки (`Шаг …pull…:`, `docker pull`, `compose pull`). */
export const registryPullStep = (full: string) =>
  /^Шаг [^:\n]*pull[^:\n]*:/im.test(full) || /\b(?:docker|compose) pull\b/i.test(full);

/** Класс отказа для случаев, где он не поставлен в точке обнаружения. */
/** Отказ движка с кодом, который сам называет класс отказа попытки. */
const byCode: Partial<Record<ErrorCode, FailureKind>> = {
  GATE_FAILED: 'gate',
  REVIEW_REJECTED: 'review',
  REVIEW_PROTOCOL_INVALID: 'review-protocol',
  SCOPE_VIOLATION: 'scope-violation',
  BUDGET_EXHAUSTED: 'budget',
};

export function classifyFailure(error: unknown, full: string): FailureKind {
  // Хвост вывода шага окружения — пояснение, а не признак класса.
  const message = withoutStepOutput(full);
  // Незавершённая очистка не меняет класс отказа работы; без него это отказ
  // окружения — ресурсы попытки не освобождены.
  if (error instanceof CleanupFailure)
    return error.original ? classifyFailure(error.original, full) : 'environment';
  if (error instanceof TaskFailure) return error.kind;
  // Приёмка отказала по правилу (нет доказательства, ревью, область): класс —
  // это правило, а не «неизвестно».
  if (error instanceof HarnessError && byCode[error.code]) return byCode[error.code]!;
  if (providerRefusal(message)) return 'provider-auth';
  if (transportFailure(message)) return 'environment';
  // Поле `timeout=false` в сообщении шага («Шаг X: exit=1; timeout=false»)
  // говорит как раз, что предела не было: оно не признак превышения времени.
  if (
    /исчерпан лимит времени|истёк|истек|тайм-?аут|timeout|превысил/i.test(
      message.replace(/\btimeout=false\b/gi, ''),
    )
  )
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
  full: string,
  kind: FailureKind,
): EnvironmentCause {
  const message = withoutStepOutput(full);
  if (kind === 'stalled') return 'stalled';
  if (kind === 'provider-auth') return providerLimit(message) ? 'provider-limit' : 'provider-auth';
  // Остановка исполнителя из-за окружения — класс `needs-lead`, причина своя.
  if (
    kind === 'needs-lead' &&
    error instanceof TaskFailure &&
    (error.diagnosis === 'writer-environment' ||
      error.diagnosis === 'writer-split' ||
      error.diagnosis === 'gate-environment' ||
      error.diagnosis === 'merge-conflict')
  )
    return error.diagnosis;
  if (kind !== 'environment') return 'none';
  if (error instanceof CleanupFailure)
    return error.original ? environmentCauseOf(error.original, full, kind) : 'cleanup';
  if (error instanceof TaskFailure && error.diagnosis) return error.diagnosis;
  if (
    transportFailure(message) ||
    /econnreset|epipe|socket hang up|connection reset|stream closed|channel closed|fetch failed|network error/i.test(
      message,
    )
  )
    return 'transport';
  // Закреплённый node не разрешился — причина своя, а не общий отказ до работы.
  if (error instanceof ToolchainPinError) return 'toolchain';
  if (error instanceof BlockedError) return 'preflight';
  return 'other';
}

/**
 * Отказ с дописанной причиной (например, неудавшейся очисткой): класс,
 * свойства и причина окружения `TaskFailure` сохраняются; прочий отказ —
 * `Error` с исходным в `cause`.
 */
export function withSuffix(failure: Error, suffix: string): Error {
  // Признак незавершённой очистки и неостановленных потомков сохраняется:
  // по нему решаются сохранение деревьев и запрет повтора на дереве.
  if (
    failure instanceof CleanupFailure ||
    failure instanceof ReapedGate ||
    failure instanceof ReapFailure
  )
    return failure.extend(suffix);
  return failure instanceof TaskFailure
    ? new TaskFailure(
        failure.kind,
        `${failure.message}; ${suffix}`,
        failure.properties,
        failure.diagnosis,
        failure.contextLimit,
        failure.input,
        failure.writerSummary,
      )
    : new Error(`${failure.message}; ${suffix}`, { cause: failure });
}
