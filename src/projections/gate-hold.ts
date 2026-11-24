// Удержание gate отказом окружения без повтора (0.1.0-alpha.66,
// `WorkState.environmentHold`): gate зовёт `ps` из базы, а в песочнице ОС
// проверок список процессов недоступен; с 0.1.0-alpha.68 — и сигнал процессу
// вне песочницы (`sandbox-signal`), и браузер в ней (`sandbox-browser`). Чистые правила над записанным
// состоянием: движок по ним не выдаёт, explain и представление называют
// ход ведущего. Без node:* и zod.

import type { NoRetryEnvironmentCause, WorkState } from '../contracts/execution.ts';

export type EnvironmentGateHold = NonNullable<WorkState['environmentHold']> & { workId: string };

/**
 * Действующие удержания: работа с удержанием не принята и не отменена,
 * определение gate в политике то же (`currentDigest` — `gateDigest` gate
 * репозитория; gate убран — удержания нет) и среда та же, что сделала отказ
 * отказом среды: режим изоляции проверок прежний (`os`), а у отказа списка
 * процессов — проба `ps` этого процесса не ответила `available`. Удержание
 * `gate-definition` (gate не назвал причину провала) от среды не зависит:
 * его снимают только новое определение gate и повтор ведущего.
 */
export function environmentGateHolds(
  works: readonly Pick<WorkState, 'id' | 'status' | 'environmentHold'>[],
  currentDigest: (repositoryId: string, gate: string) => string | undefined,
  environment: { isolation: 'os' | 'none'; processList?: string } = { isolation: 'os' },
): EnvironmentGateHold[] {
  return works.flatMap((w) => {
    const h = w.environmentHold;
    if (!h || w.status === 'done' || w.status === 'cancelled') return [];
    // Gate без названной причины удержан своим определением, а не песочницей.
    if (holdCause(h) !== 'gate-definition' && (h.isolation ?? 'os') !== environment.isolation)
      return [];
    if (environment.processList === 'available' && holdCause(h) === 'sandbox-process-list')
      return [];
    return currentDigest(h.repositoryId, h.gate) === h.digest ? [{ ...h, workId: w.id }] : [];
  });
}

/** Причина удержания: у записей до 0.1.0-alpha.68 — список процессов. */
export const holdCause = (h: { cause?: NoRetryEnvironmentCause }): NoRetryEnvironmentCause =>
  h.cause ?? 'sandbox-process-list';

const HELD_BECAUSE: Record<NoRetryEnvironmentCause, { ru: string; en: string }> = {
  'sandbox-process-list': {
    ru: 'зовёт ps, а в песочнице проверок список процессов недоступен',
    en: 'it runs ps, and the check sandbox has no process list',
  },
  'sandbox-signal': {
    ru: 'шлёт сигнал (kill) процессу вне песочницы проверок, а песочница это запрещает',
    en: 'it signals (kill) a process outside the check sandbox, which the sandbox forbids',
  },
  'sandbox-browser': {
    ru: 'запускает браузер, а в песочнице проверок он не стартует',
    en: 'it launches a browser, which does not start in the check sandbox',
  },
  'gate-definition': {
    ru: 'упал, не назвав причины (ни упавших тестов, ни строки ошибки), — это правка команды gate, а не кода задачи',
    en: 'it failed without naming a cause (no failed tests, no error line) — the gate command needs fixing, not the task code',
  },
};

/**
 * Удержание определением gate (0.1.0-alpha.69): gate упал, не назвав причины.
 * Представление отличает такие удержания от удержаний песочницей по этому
 * признаку (`EnvironmentGateHold.cause === 'gate-definition'`).
 */
export const isGateDefinitionHold = (h: { cause?: NoRetryEnvironmentCause }) =>
  holdCause(h) === 'gate-definition';

/** Удержания определением gate среди действующих (`environmentGateHolds`). */
export const gateDefinitionHolds = <T extends { cause?: NoRetryEnvironmentCause }>(
  holds: readonly T[],
): T[] => holds.filter(isGateDefinitionHold);

/** Удержания, которые касаются работы: тот же репозиторий и gate из её обязательных. */
export const gateHoldsFor = (
  holds: readonly EnvironmentGateHold[],
  repositoryId: string,
  gates: readonly string[],
) => holds.filter((h) => h.repositoryId === repositoryId && gates.includes(h.gate));

/**
 * Строка удержания для людей. `route` — маршрут повтора удержавшей работы
 * (`retryRoute`): повтор ведущего снимает удержание всегда, а когда предел
 * удержавшей работы исчерпан, сам её повтор — следующий ход по исчерпанию
 * (человек или разбор ведущего), и строка называет его командой.
 */
export function gateHoldLine(
  h: Pick<EnvironmentGateHold, 'gate' | 'workId' | 'cause'>,
  workId?: string,
  route?: RetryRoute,
): { ru: string; en: string } {
  const own = workId === h.workId;
  const lift = `harness retry --work ${h.workId} --by lead`;
  const because = HELD_BECAUSE[holdCause(h)];
  const head = {
    ru: `gate ${h.gate} удержан: ${because.ru}${own ? '' : ` (отказ работы ${h.workId})`}`,
    en: `gate ${h.gate} is held: ${because.en}${own ? '' : ` (failure of ${h.workId})`}`,
  };
  if (!route?.limit && isGateDefinitionHold(h))
    return {
      ru: `${head.ru}; ход ведущего — поменять команду gate, чтобы при провале она печатала упавшие тесты и строку ошибки, и повторить ${h.workId} (${lift})`,
      en: `${head.en}; the lead changes the gate command so a failure prints the failed tests and the error line, and retries ${h.workId} (${lift})`,
    };
  if (!route?.limit)
    return {
      ru: `${head.ru}; ход ведущего — поменять gate или команду либо исправить тест и повторить ${h.workId} (${lift})`,
      en: `${head.en}; the lead changes the gate or command, or fixes the test and retries ${h.workId} (${lift})`,
    };
  const who =
    route.actor === 'user'
      ? { ru: 'решение человека', en: 'the user decides' }
      : { ru: 'ход ведущего', en: 'the lead acts' };
  return {
    ru: `${head.ru}; ход ведущего — поменять gate или команду либо исправить тест и снять удержание (${lift}); у ${h.workId} ${route.limit.ru}: повтор ${h.workId} — ${who.ru} (${route.command})`,
    en: `${head.en}; the lead changes the gate or command, or fixes the test and lifts the hold (${lift}); ${h.workId}: ${route.limit.en}, so retrying ${h.workId} — ${who.en} (${route.command})`,
  };
}

/**
 * Ход по исчерпанным попыткам в форме входа explain (`leadRecovery.exhausted`):
 * ведущий (разбор, новый предел по разбору, перепланирование) или человек.
 */
export type RetryStep =
  | { actor: 'lead'; step: 'diagnose' | 'reset' | 'replan'; diagnosis?: string }
  | { actor: 'user'; why?: string };

/** Кто и какой командой повторяет работу (`retry`), и почему не ведущий простым повтором. */
export interface RetryRoute {
  actor: 'lead' | 'user';
  /** Ход: простой повтор ведущего, разбор, новый предел ведущим, перепланирование или сброс человеком. */
  step: 'retry' | 'diagnose' | 'reset' | 'replan' | 'user-reset';
  command: string;
  /** Исчерпанный предел, из-за которого простой повтор ведущего отклоняется. */
  limit?: { ru: string; en: string };
}

/**
 * Маршрут повтора работы — то же правило, что у отказа `retry --by lead`
 * в движке (`retryIn`): пока ни попытки, ни предел незасчитанных отказов
 * (`MAX_NEUTRAL_FAILURES`) не исчерпаны, повторяет ведущий
 * (`harness retry --work <id> --by lead`); исчерпаны — ход по исчерпанию
 * (`exhaustedStep`): разбор или новый предел ведущим либо сброс человеком.
 * Отказ без повтора (`sandbox-process-list` и др.) — одиночный прогон, а не цикл, но предел
 * незасчитанных отказов он тратит: исправление ведущего, которое снова
 * падает, заканчивается у человека исчерпанным бюджетом.
 */
export function retryRoute(
  work: { id: string; attempt: number; neutralFailures?: number },
  limits: { maxAttempts: number; maxNeutral: number },
  step: RetryStep,
): RetryRoute {
  const attempts = work.attempt >= limits.maxAttempts;
  const neutral = (work.neutralFailures ?? 0) >= limits.maxNeutral;
  if (!attempts && !neutral)
    return { actor: 'lead', step: 'retry', command: `harness retry --work ${work.id} --by lead` };
  const limit = attempts
    ? {
        ru: `исчерпаны попытки (${work.attempt} из ${limits.maxAttempts})`,
        en: `attempts are spent (${work.attempt} of ${limits.maxAttempts})`,
      }
    : {
        ru: `исчерпан предел незасчитанных отказов (${work.neutralFailures ?? 0} из ${limits.maxNeutral})`,
        en: `the limit of uncounted failures is spent (${work.neutralFailures ?? 0} of ${limits.maxNeutral})`,
      };
  if (step.actor === 'lead')
    return {
      actor: 'lead',
      step: step.step,
      limit,
      command:
        step.step === 'reset'
          ? `harness retry --work ${work.id} --reset --by lead --diagnosis ${step.diagnosis}`
          : step.step === 'replan'
            ? `новая редакция графа с разделением по разбору ${step.diagnosis} и ревью плана`
            : `harness diagnose --work ${work.id} --cause … --hypothesis "…"`,
    };
  return {
    actor: 'user',
    step: 'user-reset',
    limit,
    command: `harness retry --work ${work.id} --reset --reason "…"`,
  };
}
