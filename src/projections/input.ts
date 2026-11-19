// Проекция вопросов исполнителя (H02) без node:* и zod: её читают status,
// explain, handoff и браузер хоста.

import { inputStateOf, type InputState, type RequestLike } from '../contracts/input-state.ts';
import type { InputRequest } from '../contracts/input.ts';

export { inputStates, inputStateOf, type InputState } from '../contracts/input-state.ts';

/** Кто ответил: оператор (человек), ведущий агент или хост от их имени. */
export type AnswerActor = InputRequest['answers'][number]['actor']['kind'];

/**
 * Сводка вопроса поручения для статуса: только ID, состояние, версия и
 * серьёзность — без текста; `answeredBy` — кто записал последний ответ (нет
 * поля — ответа нет).
 */
export interface WorkInputView {
  requestId: string;
  state: InputState;
  version: number;
  severity: number;
  answeredBy?: AnswerActor;
}

/**
 * Последний незакрытый вопрос поручения (`kind: question`) — тот, о котором
 * говорит статус; неблокирующие запросы считаются отдельно (`followUps`).
 */
export function workInputOf(
  requests: readonly (RequestLike & Partial<Pick<InputRequest, 'answers'>>)[],
): {
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
  const by = question?.answers?.at(-1)?.actor.kind;
  return {
    ...(question
      ? {
          input: {
            requestId: question.id,
            state: inputStateOf(question)!,
            version: question.version,
            severity: question.effectiveSeverity,
            ...(by ? { answeredBy: by } : {}),
          },
        }
      : {}),
    followUps,
  };
}
