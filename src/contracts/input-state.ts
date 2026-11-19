// Состояние вопроса исполнителя по записи запроса — без node:*, zod и
// движка. Общий лист договоров: его импортируют и проекции, и отчёт (оба
// годятся для браузерного бандла), чтобы правило было одно.

import type { InputPolicy, InputQuestion, InputRequest } from './input.ts';

/**
 * Влияние вопроса: `user-visible` — выбор меняет то, что увидит или получит
 * пользователь продукта (поведение, тексты, данные, сроки, доступ);
 * `technical` — выбор внутри реализации, результат для пользователя тот же.
 * Нет поля — `user-visible` (консервативно: вопрос адресован человеку).
 */
export const inputImpacts = ['user-visible', 'technical'] as const;
export type InputImpact = (typeof inputImpacts)[number];

/** Действующее влияние вопроса: нет поля или `null` — `user-visible`. */
export const impactOf = (q: Pick<InputQuestion, 'impact'>): InputImpact =>
  q.impact === 'technical' ? 'technical' : 'user-visible';

/** Блокирующий вопрос (`kind: question`, `blocking`) адресован человеку. */
const blockingQuestion = (r: Pick<InputRequest, 'kind' | 'blocking'>) =>
  r.kind === 'question' && r.blocking;

/**
 * По какому правилу ведущий может ответить на запрос: `non-blocking` —
 * неблокирующий запрос (всегда); `technical` — при `leadAnswers.technical`
 * только технический вопрос без минимумов (и не выше `maxSeverity`, если он
 * задан; нужна причина), остальные — человеку; `severity` — без `technical`,
 * правило alpha.54: действующая серьёзность не выше `maxSeverity`; `null` —
 * только человек.
 */
export function leadAnswerBasis(
  r: Pick<InputRequest, 'kind' | 'blocking' | 'effectiveSeverity' | 'floors'> & {
    question: Pick<InputQuestion, 'impact'>;
  },
  policy: Pick<InputPolicy, 'leadAnswers'>,
): 'non-blocking' | LeadAnswerBasis | null {
  if (!blockingQuestion(r)) return 'non-blocking';
  const lead = policy.leadAnswers;
  if (!lead) return null;
  const withinMax = lead.maxSeverity === undefined || r.effectiveSeverity <= lead.maxSeverity;
  if (lead.technical === true)
    return impactOf(r.question) === 'technical' && r.floors.length === 0 && withinMax
      ? 'technical'
      : null;
  return lead.maxSeverity !== undefined && withinMax ? 'severity' : null;
}

/** Правило, по которому ведущий ответил на блокирующий вопрос. */
export const leadAnswerBases = ['severity', 'technical'] as const;
export type LeadAnswerBasis = (typeof leadAnswerBases)[number];

/**
 * Правило ответов на вопросы исполнителя простыми словами (`doctor`,
 * `init --plan`): кто отвечает на блокирующие вопросы при этой политике.
 */
export function leadAnswersRule(policy: Pick<InputPolicy, 'leadAnswers'>): {
  ru: string;
  en: string;
} {
  const lead = policy.leadAnswers;
  const technical = lead?.technical === true;
  const max = lead?.maxSeverity;
  if (!technical && max === undefined)
    return {
      ru: 'На вопросы исполнителя, которые останавливают работу, отвечает человек; ведущий их только передаёт.',
      en: 'A person answers executor questions that stop the work; the lead only relays them.',
    };
  if (technical)
    return {
      ru:
        'Технические вопросы (результат для пользователя не меняется) ведущий решает сам и записывает причину' +
        (max !== undefined ? `, если их серьёзность не выше ${max} из 10` : '') +
        '. Вопросы, которые меняют результат для пользователя, и вопросы о критических областях — человеку.',
      en:
        'The lead decides technical questions (the result for the user stays the same) and records why' +
        (max !== undefined ? `, when their severity is at most ${max} of 10` : '') +
        '. Questions that change the result for the user, and questions about critical areas, go to a person.',
    };
  return {
    ru: `Ведущий может ответить на любой вопрос серьёзности до ${max} из 10. Остальные — человеку.`,
    en: `The lead may answer any question of severity up to ${max} of 10. The rest go to a person.`,
  };
}

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
