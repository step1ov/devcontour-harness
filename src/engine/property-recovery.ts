import { randomUUID } from 'node:crypto';
import type { AttemptState, FailureKind, PropertyRecovery, WorkState } from '../contracts/index.ts';
import { episodeBasis } from '../verification/checks.ts';

/**
 * Ограниченное восстановление по повторяющемуся свойству.
 *
 * Бюджет попыток уходил на одно и то же свойство: каждая попытка чинила
 * контрпример прошлого ревью, следующее ревью находило новый вход того же
 * класса, и только исчерпание бюджета останавливало цикл. Здесь два
 * последовательных содержательных отказа одного поручения по одному
 * объявленному свойству в одном эпизоде запрещают третью автоматическую
 * выдачу до разбора. Это не отмена: ведущий получает ограниченный разбор и
 * одно из разрешённых действий.
 *
 * Правила последовательности:
 * - считаются отдельные завершённые попытки: несколько находок и обе фазы
 *   одной попытки — один отказ;
 * - отказ провайдера или окружения не увеличивает и не обнуляет счёт;
 * - эпизод завершает проверенное прохождение свойства (его gate прошёл и
 *   ревью не связало отказ с ним) либо согласованное изменение основания —
 *   постановки или контрактов. Новый текст находки, seed, повтор, рестарт и
 *   добавление случая в корпус эпизод не завершают.
 *
 * Свойство отказа берётся только из объявленных property ID: свободная
 * строка reviewer нового ID не создаёт и счётчик не выбирает.
 */
export const RECOVERY_THRESHOLD = 2;

/** Поручение с незавершённым разбором автоматическая выдача пропускает. */
export const blocksClaim = (w: Pick<WorkState, 'recovery'>) =>
  !!w.recovery && !['retry', 'closed'].includes(w.recovery.status);

/** Отказы, ничего не говорящие о свойстве: не увеличивают и не обнуляют счёт. */
const neutral: FailureKind[] = [
  'provider-auth',
  'environment',
  'timeout',
  'stale-base',
  'merge',
  'cancelled',
  'unknown',
  // Ошибка формата ответа reviewer о свойстве ничего не говорит.
  'review-protocol',
  'empty-result',
  // Незавершённая работа свойство не проверяла.
  'unfinished',
  'scope-violation',
];
const substantive = (a: AttemptState) => a.failureKind === 'gate' || a.failureKind === 'review';
export const isNeutral = (a: AttemptState) =>
  a.blocked || a.status === 'expired' || (a.failureKind && neutral.includes(a.failureKind));

/** Свойство прошло проверку в попытке: его gate зелёный, отказа по нему нет. */
function verifiedPass(a: AttemptState, property: string) {
  if (a.properties?.includes(property)) return false;
  return a.evidence.some(
    (e) =>
      e.kind === 'test' &&
      // Gate завершился штатно: обрыв, таймаут или ошибка уборки дают
      // exitCode -1 и не являются проверкой свойства.
      e.exitCode >= 0 &&
      e.property?.level === 'manifest' &&
      !e.property.coverage?.length &&
      e.property.report?.properties.some((p) => p.testId === property && p.status === 'passed'),
  );
}

/**
 * Последовательные содержательные отказы по свойству в текущем эпизоде,
 * от последней попытки к первой.
 */
export function propertyStreak(
  work: WorkState,
  attempts: AttemptState[],
  property: string,
  basis = episodeBasis(work),
) {
  const runs: string[] = [];
  const own = attempts.filter((a) => a.workId === work.id && a.status !== 'active');
  for (let i = own.length - 1; i >= 0; i--) {
    const a = own[i]!;
    if (a.episodeBasis !== basis) break;
    if (a.status === 'succeeded') break;
    // Инфраструктурный отказ нейтрален и проверяется раньше прохождения:
    // отчёт, сохранённый как отрицательная диагностика, не доказывает, что
    // свойство проверено.
    if (isNeutral(a)) continue;
    if (verifiedPass(a, property)) break;
    if (substantive(a) && a.properties?.includes(property)) runs.push(a.id);
  }
  return { basis, runs };
}

function close(work: WorkState, at: string, reason: string) {
  const r = work.recovery!;
  r.status = 'closed';
  r.reason = reason;
  r.history.push({ at, event: 'closed', detail: reason });
  work.recoveryHistory = [...(work.recoveryHistory ?? []), structuredClone(r)].slice(-20);
  work.recovery = undefined;
}

/**
 * Обновить эпизод после записи отказа попытки — в той же транзакции.
 * `work` изменяется на месте; возвращается изменённый эпизод или undefined.
 */
export function afterFailure(
  work: WorkState,
  attempts: AttemptState[],
  failed: AttemptState,
  at: string,
  /** Основание эпизода по формуле хоста; без неё — формула harness. */
  basis = episodeBasis(work),
): PropertyRecovery | undefined {
  const current = work.recovery;
  // Разрешённый повтор завершился: повторный провал по тому же свойству
  // останавливает цикл; инфраструктурный отказ возвращает право на повтор.
  if (current && current.status === 'retrying' && current.retryRun === failed.id) {
    if (isNeutral(failed)) {
      current.status = 'retry';
      current.retryRun = undefined;
      current.history.push({ at, event: 'retry-returned', detail: failed.failureKind });
    } else if (failed.properties?.includes(current.property)) {
      current.status = 'stopped';
      current.reason = `Повторный отказ по свойству ${current.property} после разрешённого повтора: автоматических действий больше нет. Решение — за ведущим или человеком.`;
      current.history.push({ at, event: 'stopped', detail: failed.id });
    } else if (verifiedPass(failed, current.property)) {
      current.version++;
      const closed = structuredClone(current);
      close(work, at, 'свойство прошло проверку');
      return { ...closed, status: 'closed' };
    }
    current.version++;
    return current;
  }
  if (current && current.status !== 'closed') {
    if (current.basis !== basis) close(work, at, 'основание поручения изменилось');
    else return undefined;
  }
  for (const property of failed.properties ?? []) {
    const streak = propertyStreak(work, attempts, property, basis);
    if (streak.runs.length < RECOVERY_THRESHOLD) continue;
    // Тот же эпизод уже разбирался: повторная регистрация бюджета не даёт.
    const previous = work.recoveryHistory?.find(
      (r) =>
        r.property === property && r.basis === streak.basis && r.runs.includes(streak.runs.at(-1)!),
    );
    if (previous) continue;
    work.recovery = {
      id: 'RC-' + randomUUID(),
      property,
      basis: streak.basis,
      runs: streak.runs.slice(0, RECOVERY_THRESHOLD).reverse(),
      openedAt: at,
      status: 'awaiting-lead',
      calls: 0,
      history: [
        {
          at,
          event: 'opened',
          detail: `${streak.runs.length} содержательных отказа по свойству ${property} подряд`,
        },
      ],
      version: 1,
    };
    return work.recovery;
  }
  return undefined;
}

/**
 * Согласованное изменение основания — постановки или контрактов — завершает
 * эпизод. Проверяется при согласовании и перед выдачей: иначе блокировка
 * старого эпизода не давала дойти до попытки, где её снял бы отказ.
 */
export function closeIfBasisChanged(work: WorkState, at: string, basis = episodeBasis(work)) {
  if (work.recovery && work.approvedDigest && work.recovery.basis !== basis) {
    close(work, at, 'согласовано новое основание поручения');
    return true;
  }
  return false;
}

/** Попытка принята: эпизод по её свойствам завершён. */
export function afterSuccess(work: WorkState, at: string) {
  if (work.recovery && work.recovery.status !== 'closed') close(work, at, 'поручение принято');
}
