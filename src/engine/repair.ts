import type { ExecutionView, FailureKind, WorkState } from '../contracts/index.ts';
import { repairPolicy } from './failure.ts';

export type RepairDecision =
  | {
      action: 'retry';
      workId: string;
      kind: FailureKind;
      fingerprint: string;
      /** Класс держит выдачу: починив его, нужно снять его блокировку. */
      blocksQueue: boolean;
      reason: string;
    }
  | { action: 'stop'; workId?: string; kind?: FailureKind; reason: string };

/**
 * Что делать с упавшим поручением группы.
 *
 * Решение принимается только по записанному состоянию: класс отказа,
 * сохранённый в момент падения, число одинаковых отпечатков среди прошлых
 * попыток, бюджет попыток поручения и бюджет восстановлений группы. Ни одного
 * обращения к сети, git или runtime — поэтому вся таблица решений проверяется
 * тестами, а перезапуск процесса ничего не меняет: те же данные дают тот же
 * ответ.
 *
 * Повтор здесь — обычный повтор в пределах бюджета попыток поручения. Сброс
 * бюджета остаётся действием человека: он означает «причина устранена
 * снаружи», и утверждать это за человека контур не вправе.
 */
export function repairDecision(
  view: ExecutionView,
  works: WorkState[],
  options: { budgetLeft: number; maxAttempts: number },
): RepairDecision | undefined {
  // Поручение с эпизодом по свойству восстанавливается своим разбором, а не
  // обычным повтором: третья слепая попытка как раз и запрещена.
  const broken = works.filter(
    (w) => ['failed', 'cancelled'].includes(w.status) && (w.status === 'cancelled' || !w.recovery),
  );
  if (!broken.length) return undefined;

  // Отмена человеком не восстанавливается — ни первой, ни после других.
  // Проверяется раньше выбора поручения: иначе отменённое ждало бы своей
  // очереди за чинимыми и цикл успел бы потратить на них бюджет.
  const cancelled = broken.find((w) => w.status === 'cancelled');
  if (cancelled)
    return {
      action: 'stop',
      workId: cancelled.id,
      kind: 'cancelled',
      reason: `${cancelled.id}: ${repairPolicy.cancelled.explain}`,
    };

  const work = broken[0]!;
  const kind: FailureKind = work.failureKind ?? 'unknown';
  const rule = repairPolicy[kind];
  const detail = work.failure ? ` Отказ: ${work.failure.slice(0, 300)}` : '';

  if (rule.action === 'stop')
    return {
      action: 'stop',
      workId: work.id,
      kind,
      reason: `${work.id}: ${rule.explain}${detail}`,
    };

  if (options.budgetLeft <= 0)
    return {
      action: 'stop',
      workId: work.id,
      kind,
      reason: `${work.id}: исчерпан бюджет автоматических восстановлений группы. Продолжение требует решения человека.${detail}`,
    };

  // Сброс бюджета попыток означает «причина устранена снаружи». Цикл такого
  // знания не имеет, поэтому на потолке попыток он останавливается, а не
  // обнуляет счётчик за человека.
  if (work.attempt >= options.maxAttempts)
    return {
      action: 'stop',
      workId: work.id,
      kind,
      reason: `${work.id}: исчерпан бюджет попыток поручения. Устраните причину и повторите со сбросом, указав его.${detail}`,
    };

  const fingerprint = work.failureFingerprint;
  const identical = fingerprint
    ? view.attempts(work.id).filter((a) => a.failureFingerprint === fingerprint).length
    : 0;
  if (!fingerprint || identical > rule.repeats)
    return {
      action: 'stop',
      workId: work.id,
      kind,
      reason: fingerprint
        ? `${work.id}: одна и та же причина ${identical} раз подряд, новой гипотезы нет. ${rule.explain}${detail}`
        : `${work.id}: отказ записан без отпечатка, повторы считать нечем.${detail}`,
    };

  return {
    action: 'retry',
    workId: work.id,
    kind,
    fingerprint,
    blocksQueue: rule.blocksQueue ?? false,
    reason: `${work.id}: ${kind}, повтор ${identical} из ${rule.repeats}.${detail}`,
  };
}
