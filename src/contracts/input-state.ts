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
 * неблокирующий запрос (всегда); `technical` — технический вопрос без
 * минимумов при `leadAnswers.technical` (нужна причина); `severity` —
 * действующая серьёзность не выше `leadAnswers.maxSeverity`; `null` — только
 * человек. Технический путь проверяется первым: ответ ведущего на
 * технический вопрос всегда записан с причиной и так и показан.
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
  if (lead.technical === true && impactOf(r.question) === 'technical' && r.floors.length === 0)
    return 'technical';
  if (lead.maxSeverity !== undefined && r.effectiveSeverity <= lead.maxSeverity) return 'severity';
  return null;
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
  const parts = { ru: [] as string[], en: [] as string[] };
  if (technical) {
    parts.ru.push(
      'технические вопросы (результат для пользователя не меняется) ведущий решает сам и записывает причину',
    );
    parts.en.push(
      'the lead decides technical questions (the result for the user stays the same) and records why',
    );
  }
  if (max !== undefined) {
    parts.ru.push(`ведущий может ответить на любой вопрос серьёзности до ${max} из 10`);
    parts.en.push(`the lead may answer any question of severity up to ${max} of 10`);
  }
  const ru = parts.ru.join('; ');
  const en = parts.en.join('; ');
  return {
    ru:
      ru.charAt(0).toUpperCase() +
      ru.slice(1) +
      (technical
        ? '. Вопросы, которые меняют результат для пользователя, и вопросы о критических областях — человеку.'
        : '. Остальные — человеку.'),
    en:
      en.charAt(0).toUpperCase() +
      en.slice(1) +
      (technical
        ? '. Questions that change the result for the user, and questions about critical areas, go to a person.'
        : '. The rest go to a person.'),
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
