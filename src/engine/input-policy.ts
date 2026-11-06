import {
  INPUT_AUTONOMOUS,
  INPUT_SEVERITY_MAX,
  criticalAreas,
  type Assumption,
  type ImplementationResult,
  type InputFloor,
  type InputPolicy,
  type InputQuestion,
  type RatedInput,
  type RecordedAssumption,
} from '../contracts/index.ts';

/**
 * Решение controller по ответу writer и закреплённой в попытке политике
 * вопросов (`AttemptState.inputPolicy`). Чистая функция: тот же ответ, та же
 * политика и те же изменённые пути дают тот же исход.
 *
 * Действующая серьёзность — самооценка модели, поднятая до потолка (10)
 * минимумами, которые модель понизить не может: вопрос или допущение
 * называет критическую область (`declared`) или попытка изменила
 * критический путь политики (`critical-path`).
 */

/** Оценка вопроса или допущения controller. */
export interface InputRating {
  effectiveSeverity: number;
  floors: InputFloor[];
}

/** Вопрос, которым кончилась попытка, с оценкой. */
export type RatedQuestion = RatedInput;

export type InputDecision =
  /** Остановка `needs-input`: вопрос writer или допущение не ниже порога. */
  | { kind: 'stop'; question: RatedQuestion; fromAssumption: boolean }
  /** Вопрос ниже порога: нарушение запроса, попытка — `unfinished`, вопрос записан отклонённым. */
  | { kind: 'declined'; question: RatedQuestion }
  /** `completed: false` без вопроса. */
  | { kind: 'unfinished' }
  /** `completed: true`, допущения ниже порога (или автономный режим). */
  | { kind: 'continue' };

export interface InputEvaluation {
  decision: InputDecision;
  /** Допущения попытки с оценкой (все, включая превращённое в вопрос). */
  assumptions: RecordedAssumption[];
  /** Автономный режим: неблокирующие запросы ведущему по критическим развилкам. */
  followUps: RatedQuestion[];
  /** Изменённые критические пути (не больше 20). */
  criticalHits: string[];
}

const within = (path: string, prefixes: readonly string[]) =>
  prefixes.some((p) => p === '.' || path === p || path.startsWith(p.endsWith('/') ? p : p + '/'));

/** Порог выше потолка серьёзности — автономный режим: остановок нет. */
export const autonomous = (policy: InputPolicy) => policy.threshold >= INPUT_AUTONOMOUS;

/** Останавливает ли действующая серьёзность попытку при этой политике. */
export const stops = (policy: InputPolicy, effectiveSeverity: number) =>
  !autonomous(policy) && effectiveSeverity >= policy.threshold;

function rate(item: { severity: number; affects: readonly string[] }, hits: string[]): InputRating {
  const floors: InputFloor[] = [];
  if (item.affects.length) floors.push('declared');
  if (hits.length) floors.push('critical-path');
  return {
    effectiveSeverity: floors.length ? INPUT_SEVERITY_MAX : item.severity,
    floors,
  };
}

/** Допущение как вопрос: выбранный исполнителем вариант — единственный и рекомендуемый. */
export function assumptionQuestion(a: Assumption): InputQuestion {
  return {
    question: a.question,
    options: [{ id: 'chosen', label: a.chosen, consequence: null }],
    recommended: 'chosen',
    severity: a.severity,
    rationale: a.rationale,
    affects: a.affects,
  };
}

export function evaluateInput(
  output: Pick<ImplementationResult, 'completed' | 'inputRequest' | 'assumptions'>,
  policy: InputPolicy,
  changedPaths: readonly string[],
): InputEvaluation {
  const criticalHits = policy.criticalPaths.length
    ? changedPaths.filter((p) => within(p, policy.criticalPaths)).slice(0, 20)
    : [];
  const assumptions: RecordedAssumption[] = (output.assumptions ?? []).map((a) => ({
    ...a,
    ...rate(a, criticalHits),
  }));
  const free = autonomous(policy);
  // Автономный режим: критическая развилка — запрос ведущему, без остановки.
  const followUps: RatedQuestion[] = free
    ? assumptions
        .filter((a) => a.floors.length)
        .map((a) => ({
          question: assumptionQuestion(a),
          effectiveSeverity: a.effectiveSeverity,
          floors: a.floors,
        }))
    : [];
  const request = output.inputRequest ?? undefined;
  if (!output.completed) {
    if (!request) return { decision: { kind: 'unfinished' }, assumptions, followUps, criticalHits };
    const question: RatedQuestion = { question: request, ...rate(request, criticalHits) };
    if (stops(policy, question.effectiveSeverity))
      return {
        decision: { kind: 'stop', question, fromAssumption: false },
        assumptions,
        followUps,
        criticalHits,
      };
    return {
      decision: { kind: 'declined', question },
      assumptions,
      followUps: free && question.floors.length ? [...followUps, question] : followUps,
      criticalHits,
    };
  }
  // Готово, но решённая самим исполнителем развилка не ниже порога: это
  // вопрос, а не допущение. Берётся самая серьёзная; изменения остаются
  // черновиком, кандидата нет.
  const blocking = assumptions
    .filter((a) => stops(policy, a.effectiveSeverity))
    .sort((a, b) => b.effectiveSeverity - a.effectiveSeverity || b.severity - a.severity)[0];
  if (blocking)
    return {
      decision: {
        kind: 'stop',
        question: {
          question: assumptionQuestion(blocking),
          effectiveSeverity: blocking.effectiveSeverity,
          floors: blocking.floors,
        },
        fromAssumption: true,
      },
      assumptions,
      followUps,
      criticalHits,
    };
  return { decision: { kind: 'continue' }, assumptions, followUps, criticalHits };
}

/** Раздел запроса writer: порог, шкала, критические области и пути, как задать вопрос. */
export function inputPolicyText(policy: InputPolicy) {
  const areas = criticalAreas.join('|');
  const paths = policy.criticalPaths.length
    ? ` Changing any of these paths also makes every fork of this attempt critical: ${JSON.stringify(policy.criticalPaths)}.`
    : '';
  const scale =
    'Rate each fork you meet with a severity from 1 to 10: 1 — cosmetic, reversible, local to this change; 4 — a behaviour choice inside the write scope; 7 — behaviour or an interface other work or users rely on; 10 — changes requirements, acceptance criteria, a contract, the data model or security, or affects every task.';
  const critical = `A fork that would change an approved contract, acceptance criteria, a product decision, a public API or a data migration is critical: name the area in \`affects\` (${areas}); the controller then treats it as severity 10 whatever number you give.${paths}`;
  if (autonomous(policy))
    return [
      `Decision policy: autonomous (input threshold ${policy.threshold}). You never stop to ask. Decide every fork yourself, keep working, and record each decision in \`assumptions\` (question, chosen, rationale, severity, affects); return \`inputRequest\`: null.`,
      scale,
      critical +
        ' Critical decisions are sent to the lead as follow-up requests; they never change an approved contract, acceptance or product decision — choose the option that keeps them intact.',
    ].join(' ');
  return [
    `Decision policy: input threshold ${policy.threshold} (pinned for this attempt).`,
    scale,
    critical,
    `If a fork has severity below ${policy.threshold}, decide it yourself, continue, and record it in \`assumptions\` (question, chosen, rationale, severity, affects).`,
    `If a fork has severity ${policy.threshold} or higher, do not guess: stop, leave your partial edits in the worktree uncommitted, and return completed=false with \`inputRequest\` (question, up to 6 options each with its consequence, recommended option id or null, severity, rationale, affects). Asking below the threshold is a protocol violation and the attempt counts as unfinished.`,
    'Otherwise return `inputRequest`: null. completed=true together with an inputRequest is invalid.',
  ].join(' ');
}
