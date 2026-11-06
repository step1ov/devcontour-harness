// Проекция вопросов исполнителя (H02) без node:* и zod: её читают status,
// explain, handoff и браузер хоста.

import type { InputRequest } from '../contracts/input.ts';

/**
 * Где вопрос: ждёт ответа (`awaiting-answer`), ответ записан, но не применён
 * (`answered-not-applied`), применён и ждёт выдачи попытки или её первого
 * вызова (`applied-awaiting-claim`), передан исполнителю началом вызова
 * (`delivered`). Закрытые запросы состояния не имеют.
 */
export const inputStates = [
  'awaiting-answer',
  'answered-not-applied',
  'applied-awaiting-claim',
  'delivered',
] as const;
export type InputState = (typeof inputStates)[number];

type RequestLike = Pick<
  InputRequest,
  'id' | 'kind' | 'lifecycle' | 'delivered' | 'version' | 'effectiveSeverity' | 'createdAt'
>;

export function inputStateOf(
  r: Pick<RequestLike, 'lifecycle' | 'delivered'>,
): InputState | undefined {
  switch (r.lifecycle) {
    case 'pending':
      return 'awaiting-answer';
    case 'answered':
      return 'answered-not-applied';
    case 'applied':
      return r.delivered ? 'delivered' : 'applied-awaiting-claim';
    default:
      return undefined;
  }
}

/** Сводка вопроса поручения для статуса: только ID, состояние, версия и серьёзность — без текста. */
export interface WorkInputView {
  requestId: string;
  state: InputState;
  version: number;
  severity: number;
}

/**
 * Последний незакрытый вопрос поручения (`kind: question`) — тот, о котором
 * говорит статус; неблокирующие запросы считаются отдельно (`followUps`).
 */
export function workInputOf(requests: readonly RequestLike[]): {
  input?: WorkInputView;
  followUps: number;
} {
  const question = requests
    .filter((r) => r.kind === 'question' && inputStateOf(r))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  const followUps = requests.filter(
    (r) => r.kind === 'follow-up' && r.lifecycle === 'pending',
  ).length;
  return {
    ...(question
      ? {
          input: {
            requestId: question.id,
            state: inputStateOf(question)!,
            version: question.version,
            severity: question.effectiveSeverity,
          },
        }
      : {}),
    followUps,
  };
}
