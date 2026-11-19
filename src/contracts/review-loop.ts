// Счёт раундов находок плана и контракта и эскалация — без node:*, zod и
// движка: общий лист договоров для ревью, `status`/`explain` и отчёта
// (браузерный бандл), чтобы правило было одно (docs/review-protocol.md, §8).

/**
 * Раундов подряд, после которых открытая находка плана или контракта —
 * решение оператора, а не следующий оплаченный раунд.
 */
export const REVIEW_ESCALATION_ROUNDS = 3;

/** Поля находки, по которым считаются раунды. */
export interface RoundedFinding {
  status: string;
  openedIn: number;
  rounds?: number | undefined;
  disposition?: { decision: string; rounds: number } | undefined;
}

/**
 * Раундов, в которых находка оставалась открытой. У записи прежней версии
 * (без `rounds`) — от раунда появления до последнего раунда предмета.
 */
export function openRounds(f: RoundedFinding, lastRound: number): number {
  if (f.status !== 'open') return 0;
  return f.rounds ?? Math.max(1, lastRound - f.openedIn + 1);
}

/**
 * Раундов после последнего решения `continue` оператора: с ним счёт до
 * эскалации начинается заново, общий счёт `rounds` сохраняется.
 */
export function roundsSinceDecision(f: RoundedFinding, lastRound: number): number {
  const since = f.disposition?.decision === 'continue' ? f.disposition.rounds : 0;
  return openRounds(f, lastRound) - since;
}

/**
 * Открытые блокирующие находки, которые ждут решения оператора перед
 * следующим раундом. Заметка одобрению не мешает и круга раундов не создаёт.
 */
export function escalatedFindings<F extends RoundedFinding & { severity: string }>(
  findings: readonly F[],
  lastRound: number,
): F[] {
  return findings.filter(
    (f) =>
      f.status === 'open' &&
      f.severity === 'blocking' &&
      roundsSinceDecision(f, lastRound) >= REVIEW_ESCALATION_ROUNDS,
  );
}

/** Открытые находки последнего раунда: блокирующие и заметки, принятые ограничения. */
export function findingCounts(findings: readonly { status: string; severity: string }[]) {
  let blocking = 0;
  let notes = 0;
  let accepted = 0;
  for (const f of findings) {
    if (f.status === 'accepted-limitation') accepted += 1;
    else if (f.status === 'open') {
      if (f.severity === 'blocking') blocking += 1;
      else notes += 1;
    }
  }
  return { blocking, notes, accepted };
}

/**
 * Итог раунда словами: «одобрено, открытых заметок 2» / «approved, 2 open
 * notes». Одобрение с открытыми заметками допустимо, но названо явно.
 */
export function reviewVerdictText(
  approved: boolean,
  counts: { blocking: number; notes: number; accepted: number },
  language: 'ru' | 'en',
): string {
  const parts: string[] = [];
  if (language === 'ru') {
    parts.push(approved ? 'одобрено' : 'не одобрено');
    if (counts.blocking) parts.push(`открытых блокирующих ${counts.blocking}`);
    if (counts.notes || approved) parts.push(`открытых заметок ${counts.notes}`);
    if (counts.accepted) parts.push(`принятых ограничений ${counts.accepted}`);
  } else {
    const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
    parts.push(approved ? 'approved' : 'not approved');
    if (counts.blocking) parts.push(n(counts.blocking, 'open blocking finding'));
    if (counts.notes || approved) parts.push(n(counts.notes, 'open note'));
    if (counts.accepted) parts.push(n(counts.accepted, 'accepted limitation'));
  }
  return parts.join(', ');
}

/**
 * Вопрос оператору об эскалированных находках: варианты и как записать
 * ответ. Рекомендации нет: решение по сути — за человеком.
 */
export function escalationQuestion(
  kind: 'plan' | 'contract',
  subject: string,
  findings: readonly { id: string; rounds: number }[],
) {
  const ids = findings.map((f) => f.id).join(',');
  const command = kind === 'plan' ? 'review-plan' : 'review-contract';
  return {
    question: `Ревью ${kind === 'plan' ? 'плана' : 'контракта'} ${subject}: ${findings.length === 1 ? 'находка открыта' : 'находки открыты'} ${REVIEW_ESCALATION_ROUNDS}+ раундов подряд — reviewer поднимает ${findings.length === 1 ? 'её' : 'их'} снова. Следующий оплаченный раунд не запускается до решения.`,
    options: [
      {
        id: 'accept-limitation',
        label: 'Принять как известное ограничение (с основанием)',
        consequence:
          'Следующий раунд видит решение; reviewer не поднимает находку без новых доказательств',
      },
      {
        id: 'continue',
        label: `Исправить предмет и разрешить ещё ${REVIEW_ESCALATION_ROUNDS} раунда по находке`,
        consequence: `Каждый раунд оплачивается; через ${REVIEW_ESCALATION_ROUNDS} раунда без закрытия — снова решение`,
      },
      {
        id: 'stop',
        label: 'Остановить работу над предметом',
        consequence: 'Ничего не запускается; предмет остаётся неодобренным',
      },
    ],
    recommended: null,
    answer: `${command} … --actor operator --reason "<основание>" и --accept-limitation ${ids} или --continue-review ${ids}`,
  };
}
