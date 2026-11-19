// Проекция вопросов исполнителя (H02) без node:* и zod: её читают status,
// explain, handoff и браузер хоста.

import {
  inputStateOf,
  leadAnswerBasis,
  type InputState,
  type LeadAnswerBasis,
  type RequestLike,
} from '../contracts/input-state.ts';
import type { InputPolicy, InputRequest } from '../contracts/input.ts';

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
  /** Вопрос помечен исполнителем техническим (`impact: technical`); нет поля — меняет результат для пользователя. */
  impact?: 'technical';
  /** Последний ответ ведущего принят по правилу политики (`technical` — решено ведущим как технический вопрос). */
  answerBasis?: LeadAnswerBasis;
  /** Вопрос ждёт ответа, и действующая политика разрешает ведущему ответить (по какому правилу). */
  leadMay?: LeadAnswerBasis;
}

/**
 * Последний незакрытый вопрос поручения (`kind: question`) — тот, о котором
 * говорит статус; неблокирующие запросы считаются отдельно (`followUps`).
 */
export function workInputOf(
  requests: readonly (RequestLike &
    Partial<Pick<InputRequest, 'answers' | 'blocking' | 'floors' | 'question'>>)[],
  /** Действующая политика вопросов: по ней `leadMay`; нет — поле не вычисляется. */
  policy?: Pick<InputPolicy, 'leadAnswers'>,
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
  const last = question?.answers?.at(-1);
  const by = last?.actor.kind;
  const state = question ? inputStateOf(question) : undefined;
  const leadMay =
    question && policy && state === 'awaiting-answer' && question.question && question.floors
      ? leadAnswerBasis(
          {
            kind: question.kind,
            blocking: question.blocking ?? true,
            effectiveSeverity: question.effectiveSeverity,
            floors: question.floors,
            question: question.question,
          },
          policy,
        )
      : undefined;
  return {
    ...(question
      ? {
          input: {
            requestId: question.id,
            state: inputStateOf(question)!,
            version: question.version,
            severity: question.effectiveSeverity,
            ...(by ? { answeredBy: by } : {}),
            ...(question.question?.impact === 'technical' ? { impact: 'technical' as const } : {}),
            ...(last?.basis ? { answerBasis: last.basis } : {}),
            ...(leadMay === 'technical' || leadMay === 'severity' ? { leadMay } : {}),
          },
        }
      : {}),
    followUps,
  };
}
