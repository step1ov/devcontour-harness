// Удержание gate отказом окружения без повтора (0.1.0-alpha.66,
// `WorkState.environmentHold`): gate зовёт `ps` из базы, а в песочнице ОС
// проверок список процессов недоступен. Чистые правила над записанным
// состоянием: движок по ним не выдаёт, explain и представление называют
// ход ведущего. Без node:* и zod.

import type { WorkState } from '../contracts/execution.ts';

export type EnvironmentGateHold = NonNullable<WorkState['environmentHold']> & { workId: string };

/**
 * Действующие удержания: работа с удержанием не принята и не отменена, а
 * определение gate в политике то же (`currentDigest` — `gateDigest` gate
 * репозитория; gate убран — удержания нет).
 */
export function environmentGateHolds(
  works: readonly Pick<WorkState, 'id' | 'status' | 'environmentHold'>[],
  currentDigest: (repositoryId: string, gate: string) => string | undefined,
): EnvironmentGateHold[] {
  return works.flatMap((w) => {
    const h = w.environmentHold;
    if (!h || w.status === 'done' || w.status === 'cancelled') return [];
    return currentDigest(h.repositoryId, h.gate) === h.digest ? [{ ...h, workId: w.id }] : [];
  });
}

/** Удержания, которые касаются работы: тот же репозиторий и gate из её обязательных. */
export const gateHoldsFor = (
  holds: readonly EnvironmentGateHold[],
  repositoryId: string,
  gates: readonly string[],
) => holds.filter((h) => h.repositoryId === repositoryId && gates.includes(h.gate));

/** Строка удержания для людей. */
export function gateHoldLine(h: EnvironmentGateHold, workId?: string): { ru: string; en: string } {
  const own = workId === h.workId;
  return {
    ru: `gate ${h.gate} удержан: зовёт ps, а в песочнице проверок список процессов недоступен${own ? '' : ` (отказ работы ${h.workId})`}; ход ведущего — поменять gate или команду либо исправить тест и повторить ${h.workId} (harness retry --work ${h.workId} --by lead)`,
    en: `gate ${h.gate} is held: it runs ps, and the check sandbox has no process list${own ? '' : ` (failure of ${h.workId})`}; the lead changes the gate or command, or fixes the test and retries ${h.workId} (harness retry --work ${h.workId} --by lead)`,
  };
}
