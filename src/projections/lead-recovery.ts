// Восстановление ведущим после повторных отказов (`policy.recovery`,
// docs/principles.md). Чистые правила над записанным состоянием: движок
// решает по ним выдачу и сброс, explain и представление — кто ходит. Без
// node:* и zod.

import type {
  AttemptState,
  LeadDiagnosis,
  LeadDiagnosisCause,
  WorkState,
} from '../contracts/execution.ts';
import type { RecoveryPolicy } from './decisions.ts';

type AttemptFacts = Pick<
  AttemptState,
  'id' | 'workId' | 'status' | 'failureKind' | 'blocked' | 'writerBlocked' | 'interrupted'
> &
  Partial<Pick<AttemptState, 'writerSplit'>>;
type WorkFacts = Pick<
  WorkState,
  'id' | 'status' | 'attempt' | 'approvedDigest' | 'rework' | 'leadRecovery' | 'recovery'
> &
  Partial<Pick<WorkState, 'recoveryHistory'>>;

/**
 * Засчитанный отказ — о самой работе: окружение, провайдер, отказ до работы,
 * остановка controller, истёкшее владение, остановка исполнителя из-за
 * окружения и вопрос исполнителя алгоритм не проверяли. Вопрос сверх своего
 * предела движок засчитывает в попытки, но разбора он не требует: это не
 * дефект решения.
 */
export const countedFailure = (a: AttemptFacts) =>
  a.status === 'failed' &&
  !a.blocked &&
  !a.writerBlocked &&
  !a.writerSplit &&
  !a.interrupted &&
  a.failureKind !== undefined &&
  a.failureKind !== 'environment' &&
  a.failureKind !== 'provider-auth' &&
  a.failureKind !== 'needs-input';

/** Предел попыток, к которому относятся диагностики и сбросы (`rework.budgets`). */
export const epochOf = (w: Pick<WorkState, 'rework'>) => w.rework?.budgets ?? 0;

/** Технический разбор: ведущий сам даёт новый предел по нему. */
export const technicalCause = (d: Pick<LeadDiagnosis, 'cause' | 'hypothesis'>) =>
  d.cause === 'coverage' || d.cause === 'approach' || (d.cause === 'other' && !!d.hypothesis);

/** Гипотезы сравниваются без регистра, пунктуации по краям и лишних пробелов. */
export const normalizedHypothesis = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/^[\s.,;:!?«»"'()-]+|[\s.,;:!?«»"'()-]+$/g, '');

/** Попытки работы после её последней приёмки (текущая редакция), по порядку. */
function sinceAccepted(work: WorkFacts, attempts: readonly AttemptFacts[]) {
  const own = attempts.filter((a) => a.workId === work.id && a.status !== 'active');
  const last = own.findLastIndex((a) => a.status === 'succeeded');
  return own.slice(last + 1);
}

/** Засчитанные отказы текущей редакции — по порядку. */
export const countedFailures = (work: WorkFacts, attempts: readonly AttemptFacts[]) =>
  sinceAccepted(work, attempts).filter(countedFailure);

/** Последний засчитанный отказ текущей редакции. */
export const lastCountedFailure = (work: WorkFacts, attempts: readonly AttemptFacts[]) =>
  countedFailures(work, attempts).at(-1)?.id;

/**
 * Засчитанные отказы без решения по ним: после последнего сброса попыток,
 * их не разобрала диагностика ведущего, не покрыл сброс (ведущего или
 * человека) и не разобрал эпизод восстановления свойства с решением.
 *
 * Отказы до последнего сброса решены этим сбросом, даже без записи о нём
 * (сброс человеком прежней сборки или при правиле `user`): засчитанных
 * отказов текущего предела не больше счётчика попыток (`work.attempt` —
 * засчитанный отказ его не возвращает), поэтому в расчёт идут только
 * последние `attempt` из них. Разбор и сброс решают все отказы, ждавшие
 * решения в их момент, а записывают не больше 20 последних: покрытым
 * считается всё до последнего записанного ими отказа включительно, и
 * больше 20 отказов не заставляют разбирать их снова.
 */
export function pendingFailures(work: WorkFacts, attempts: readonly AttemptFacts[]): string[] {
  const counted = countedFailures(work, attempts);
  const current = work.attempt > 0 ? counted.slice(-work.attempt) : [];
  const decided = new Set<string>([
    ...(work.leadRecovery?.diagnoses ?? []).flatMap((d) => d.failures),
    ...(work.leadRecovery?.resets ?? []).flatMap((r) => r.failures),
  ]);
  const through = counted.findLastIndex((a) => decided.has(a.id));
  const settled = new Set(counted.slice(0, through + 1).map((a) => a.id));
  const episodes = new Set<string>(
    [...(work.recoveryHistory ?? []), ...(work.recovery ? [work.recovery] : [])]
      .filter((r) => r.decision)
      .flatMap((r) => r.runs),
  );
  return current.filter((a) => !settled.has(a.id) && !episodes.has(a.id)).map((a) => a.id);
}

export const latestDiagnosis = (work: WorkFacts) => work.leadRecovery?.diagnoses.at(-1);

/** Разбор свежий: разбирает последний засчитанный отказ текущей редакции. */
export function freshDiagnosis(
  work: WorkFacts,
  attempts: readonly AttemptFacts[],
): LeadDiagnosis | undefined {
  const d = latestDiagnosis(work);
  const last = lastCountedFailure(work, attempts);
  return d && last && d.epoch === epochOf(work) && d.failures.includes(last) ? d : undefined;
}

/** Сбросы ведущего текущего предела попыток. */
export const leadResetsUsed = (work: WorkFacts) =>
  (work.leadRecovery?.resets ?? []).filter((r) => r.by === 'lead' && r.epoch === epochOf(work))
    .length;

/** Последний сброс ведущего текущего предела (для строки «ведущий дал ещё N попыток»). */
export const latestLeadReset = (work: WorkFacts) => {
  const r = work.leadRecovery?.resets.at(-1);
  return r && r.by === 'lead' && r.epoch === epochOf(work) ? r : undefined;
};

/** Почему ведущий держит выдачу работы (`policy.recovery`). */
export type LeadHold =
  | { kind: 'diagnosis-required'; failures: string[] }
  | { kind: 'replan'; diagnosis: LeadDiagnosis }
  | { kind: 'contradiction'; diagnosis: LeadDiagnosis };

/**
 * Удержание выдачи правилом восстановления. Эпизод восстановления свойства
 * ведёт работу сам (его разбор и есть диагностика). Разбор `split` держит
 * работу до перепланирования (согласована другая постановка), `contradiction`
 * — до решения человека (сброс оператора или новая постановка). Засчитанных
 * отказов без решения `diagnoseAfter` и больше, а попытки ещё есть —
 * следующей попытки нет без разбора; на исчерпании действует правило сброса.
 */
export function leadHold(
  work: WorkFacts,
  attempts: readonly AttemptFacts[],
  policy: RecoveryPolicy,
  maxAttempts: number,
): LeadHold | undefined {
  if (!policy.enabled) return undefined;
  if (work.status === 'done' || work.status === 'cancelled') return undefined;
  if (work.recovery && work.recovery.status !== 'closed') return undefined;
  const fresh = freshDiagnosis(work, attempts);
  if (fresh && !fresh.resolved && fresh.approvedDigest === work.approvedDigest) {
    if (fresh.cause === 'split') return { kind: 'replan', diagnosis: fresh };
    if (fresh.cause === 'contradiction') return { kind: 'contradiction', diagnosis: fresh };
  }
  const pending = pendingFailures(work, attempts);
  if (pending.length >= policy.diagnoseAfter && work.attempt < maxAttempts)
    return { kind: 'diagnosis-required', failures: pending };
  return undefined;
}

/** Ход по исчерпанным попыткам: ведущий разбирает или сбрасывает сам, иначе — человек. */
export type ExhaustedStep =
  | { actor: 'lead'; step: 'diagnose'; failures: string[] }
  | { actor: 'lead'; step: 'reset'; diagnosis: LeadDiagnosis; index: number; cap: number }
  | { actor: 'lead'; step: 'replan'; diagnosis: LeadDiagnosis }
  | {
      actor: 'user';
      why: 'mode' | 'cap' | 'cause' | 'repeated' | 'nothing' | 'budget';
      diagnosis?: LeadDiagnosis;
    };

/**
 * Кто ходит по исчерпанным попыткам. Ведущий — только при правиле `lead`, с
 * оставшимися сбросами и без исчерпанного бюджета расходов: нет свежего
 * разбора последнего отказа — разобрать; есть технический (покрытие,
 * подход, другое с гипотезой), ещё не использованный для сброса — дать новый
 * предел; `split` — перепланировать. Иначе — человек, как прежде.
 */
export function exhaustedStep(
  work: WorkFacts,
  attempts: readonly AttemptFacts[],
  policy: RecoveryPolicy,
  budgetHeld = false,
): ExhaustedStep {
  if (!policy.enabled) return { actor: 'user', why: 'mode' };
  if (budgetHeld) return { actor: 'user', why: 'budget' };
  const used = leadResetsUsed(work);
  if (used >= policy.leadResets) return { actor: 'user', why: 'cap' };
  const fresh = freshDiagnosis(work, attempts);
  if (!fresh) {
    const pending = pendingFailures(work, attempts);
    return pending.length
      ? { actor: 'lead', step: 'diagnose', failures: pending }
      : { actor: 'user', why: 'nothing' };
  }
  if ((work.leadRecovery?.resets ?? []).some((r) => r.diagnosis === fresh.id))
    return { actor: 'user', why: 'repeated', diagnosis: fresh };
  if (fresh.cause === 'split' && fresh.approvedDigest === work.approvedDigest)
    return { actor: 'lead', step: 'replan', diagnosis: fresh };
  // Разделение согласовано (другая постановка после разбора `split`): это
  // технический ход ведущего, и новый предел попыток по этому разбору даёт
  // он сам — в пределе `leadResets`, как по любому техническому разбору.
  const replanned = fresh.cause === 'split' && fresh.approvedDigest !== work.approvedDigest;
  if (!technicalCause(fresh) && !replanned)
    return { actor: 'user', why: 'cause', diagnosis: fresh };
  return {
    actor: 'lead',
    step: 'reset',
    diagnosis: fresh,
    index: used + 1,
    cap: policy.leadResets,
  };
}

/**
 * Ход восстановления ведущим одной записью для следующего шага (`nextAction`)
 * и корней цепочки (`chainRoots`): удержание выдачи и ход по исчерпанным
 * попыткам. Правило `user` — `undefined` (прежние шаги).
 */
export interface LeadRecoveryStep {
  hold?: LeadHold['kind'];
  exhausted?: { actor: 'lead'; step: 'diagnose' | 'reset' | 'replan' } | { actor: 'user' };
}

export function leadRecoveryStep(
  work: WorkFacts,
  attempts: readonly AttemptFacts[],
  policy: RecoveryPolicy,
  maxAttempts: number,
  budgetHeld = false,
): LeadRecoveryStep | undefined {
  if (!policy.enabled) return undefined;
  const hold = leadHold(work, attempts, policy, maxAttempts);
  const step = exhaustedStep(work, attempts, policy, budgetHeld);
  return {
    ...(hold ? { hold: hold.kind } : {}),
    exhausted: step.actor === 'lead' ? { actor: 'lead', step: step.step } : { actor: 'user' },
  };
}

/** Причина разбора простыми словами. */
export const causeText: Record<LeadDiagnosisCause, { ru: string; en: string }> = {
  coverage: { ru: 'слабое покрытие — добавить случаи', en: 'weak coverage — add cases' },
  approach: { ru: 'неверный подход — новая гипотеза', en: 'wrong approach — a new hypothesis' },
  split: { ru: 'задача велика — разделить', en: 'the task is too big — split it' },
  contradiction: {
    ru: 'противоречивое обещание — решение человека',
    en: 'contradictory promise — a human decision',
  },
  environment: { ru: 'окружение', en: 'the environment' },
  other: { ru: 'другое', en: 'other' },
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** «ведущий дал ещё N попыток (сброс K из M): причина …; гипотеза …». */
export function leadResetLine(work: WorkFacts): { ru: string; en: string } | undefined {
  const r = latestLeadReset(work);
  if (!r) return undefined;
  const d = work.leadRecovery?.diagnoses.find((x) => x.id === r.diagnosis);
  const cause = d ? causeText[d.cause] : undefined;
  const hyp = d?.hypothesis ? clip(d.hypothesis, 200) : undefined;
  return {
    ru: `ведущий дал ещё ${r.granted} ${r.granted % 10 === 1 && r.granted % 100 !== 11 ? 'попытку' : r.granted % 10 >= 2 && r.granted % 10 <= 4 && (r.granted % 100 < 12 || r.granted % 100 > 14) ? 'попытки' : 'попыток'} (сброс ${r.index ?? '?'} из ${r.cap ?? '?'})${cause ? `: причина — ${cause.ru}` : ''}${hyp ? `; гипотеза — ${hyp}` : ''}`,
    en: `the lead granted ${r.granted} more attempt${r.granted === 1 ? '' : 's'} (reset ${r.index ?? '?'} of ${r.cap ?? '?'})${cause ? `: cause — ${cause.en}` : ''}${hyp ? `; hypothesis — ${hyp}` : ''}`,
  };
}
