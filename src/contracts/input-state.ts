// Состояние вопроса исполнителя по записи запроса — без node:*, zod и
// движка. Общий лист договоров: его импортируют и проекции, и отчёт (оба
// годятся для браузерного бандла), чтобы правило было одно.

import type { InputRequest } from './input.ts';

/**
 * Где вопрос: ждёт ответа (`awaiting-answer`), ответ записан, но не применён
 * (`answered-not-applied`), применён и ждёт выдачи попытки или её первого
 * вызова (`applied-awaiting-claim`), передан исполнителю началом вызова
 * (`delivered`); перенесённый ответ заменённого вопроса устарел до выдачи
 * (`carry-stale`: перенести снова или снять). Закрытые запросы иначе
 * состояния не имеют.
 */
export const inputStates = [
  'awaiting-answer',
  'answered-not-applied',
  'applied-awaiting-claim',
  'delivered',
  'carry-stale',
] as const;
export type InputState = (typeof inputStates)[number];

export type RequestLike = Pick<
  InputRequest,
  'id' | 'kind' | 'lifecycle' | 'delivered' | 'version' | 'effectiveSeverity' | 'createdAt'
> &
  Partial<Pick<InputRequest, 'stale' | 'target'>>;

export function inputStateOf(
  r: Pick<RequestLike, 'lifecycle' | 'delivered' | 'stale' | 'target'>,
): InputState | undefined {
  switch (r.lifecycle) {
    case 'pending':
      return 'awaiting-answer';
    case 'answered':
      return 'answered-not-applied';
    case 'applied':
      return r.delivered ? 'delivered' : 'applied-awaiting-claim';
    case 'superseded':
      return r.stale && !r.target ? 'carry-stale' : undefined;
    default:
      return undefined;
  }
}
