import {
  INPUT_AUTONOMOUS,
  INPUT_LIMITS,
  INPUT_SEVERITY_MAX,
  criticalAreas,
  implementationResultSchema,
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
  // Потолок самооценки — по шкале изменение требований, договора или
  // безопасности: это объявленная критичность и без названной области (так
  // и у нераспознанной области ответа вне схемы).
  if (item.affects.length || item.severity >= INPUT_SEVERITY_MAX) floors.push('declared');
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
    // Автономный режим: заданный всё же вопрос — тоже решение исполнителя
    // (рекомендованный им вариант или «не выбрано»): reviewer его видит.
    const asked: RecordedAssumption[] = free
      ? [
          {
            question: request.question,
            chosen:
              request.options.find((o) => o.id === request.recommended)?.label ?? 'не выбрано',
            rationale: request.rationale,
            severity: request.severity,
            affects: request.affects,
            effectiveSeverity: question.effectiveSeverity,
            floors: question.floors,
          },
        ]
      : [];
    return {
      decision: { kind: 'declined', question },
      assumptions: [...assumptions, ...asked].slice(0, INPUT_LIMITS.assumptions),
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

/** Пределы вопроса и допущений, названные writer: ответ сверх них — вне схемы. */
const INPUT_LIMITS_TEXT = `Limits: question up to ${INPUT_LIMITS.question} characters; up to ${INPUT_LIMITS.options} options, each id matching [A-Za-z0-9_-]{1,40} (no spaces), label up to 300 characters, consequence up to 1000 characters or null; recommended is one of the option ids or null; rationale up to ${INPUT_LIMITS.rationale} characters; severity an integer 1-10; affects only from the listed areas; up to ${INPUT_LIMITS.assumptions} assumptions, each chosen up to 300 characters.`;

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
      INPUT_LIMITS_TEXT,
    ].join(' ');
  return [
    `Decision policy: input threshold ${policy.threshold} (pinned for this attempt).`,
    scale,
    critical,
    `If a fork has severity below ${policy.threshold}, decide it yourself, continue, and record it in \`assumptions\` (question, chosen, rationale, severity, affects).`,
    `If a fork has severity ${policy.threshold} or higher, do not guess: stop, leave your partial edits in the worktree uncommitted, and return completed=false with \`inputRequest\` (question, up to 6 options each with its consequence, recommended option id or null, severity, rationale, affects). Asking below the threshold is a protocol violation and the attempt counts as unfinished.`,
    'Otherwise return `inputRequest`: null. completed=true together with an inputRequest is invalid.',
    INPUT_LIMITS_TEXT,
  ].join(' ');
}

/* ------------------------------------------------------------------ */
/* Вопрос вне схемы                                                    */
/* ------------------------------------------------------------------ */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : v === undefined || v === null
        ? ''
        : JSON.stringify(v);

/**
 * Ответ writer вне схемы, в котором есть вопрос: привести вопрос и
 * допущения к схеме (усечь текст до пределов, исправить ID вариантов, взять
 * первые шесть вариантов, ограничить серьёзность; неразборчивая серьёзность —
 * потолок), чтобы вопрос не потерялся, а исправленное было видно в запросе.
 * Схема договора остаётся строгой: результат проходит её целиком. Ответа без
 * вопроса функция не исправляет — `undefined`, отказ остаётся отказом.
 */
export function normalizeImplementation(
  raw: unknown,
): { output: ImplementationResult; issues: string[] } | undefined {
  if (!isRecord(raw) || !isRecord(raw.inputRequest)) return undefined;
  const issues: string[] = [];
  const clip = (value: unknown, max: number, what: string) => {
    const s = text(value);
    if (s.length > max) issues.push(`${what}: ${s.length} знаков, усечено до ${max}`);
    return s.slice(0, max);
  };
  const severity = (value: unknown, what: string) => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
    if (Number.isNaN(n)) {
      issues.push(`${what}: серьёзность не число — потолок ${INPUT_SEVERITY_MAX}`);
      return INPUT_SEVERITY_MAX;
    }
    const clamped = Math.min(INPUT_SEVERITY_MAX, Math.max(1, n));
    if (clamped !== value) issues.push(`${what}: серьёзность ${String(value)} → ${clamped}`);
    return clamped;
  };
  // Область — без регистра и с распространёнными синонимами. Названная, но
  // не распознанная область не снимает минимум: серьёзность — потолок.
  const areaAliases: Record<string, (typeof criticalAreas)[number]> = {
    contract: 'contract',
    contracts: 'contract',
    acceptance: 'acceptance',
    'acceptance-criteria': 'acceptance',
    'acceptance criteria': 'acceptance',
    product: 'product',
    api: 'api',
    'public-api': 'api',
    'public api': 'api',
    migration: 'migration',
    migrations: 'migration',
    'data-migration': 'migration',
    'data migration': 'migration',
    'schema-migration': 'migration',
  };
  const areas = (value: unknown, what: string) => {
    const list = Array.isArray(value) ? value : [];
    const known = list
      .map((a) => areaAliases[text(a).trim().toLowerCase()])
      .filter((a): a is (typeof criticalAreas)[number] => a !== undefined);
    const unknown = list.length - known.length;
    if (unknown) issues.push(`${what}: ${unknown} нераспознанных областей`);
    return { areas: [...new Set(known)], unmapped: unknown > 0 && !known.length };
  };
  /** Серьёзность с минимумом области: названная нераспознанная область — потолок. */
  const rated = (value: unknown, what: string, affects: ReturnType<typeof areas>) => {
    if (!affects.unmapped) return severity(value, what);
    issues.push(`${what}: область названа, но не распознана — серьёзность ${INPUT_SEVERITY_MAX}`);
    return INPUT_SEVERITY_MAX;
  };
  const q = raw.inputRequest;
  const rawOptions = Array.isArray(q.options) ? q.options.filter(isRecord) : [];
  if (rawOptions.length > INPUT_LIMITS.options)
    issues.push(`варианты: ${rawOptions.length}, оставлены первые ${INPUT_LIMITS.options}`);
  const ids = new Map<string, string>();
  const options = rawOptions.slice(0, INPUT_LIMITS.options).map((o, i) => {
    let id = text(o.id)
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    if (!id || [...ids.values()].includes(id)) id = `option-${i + 1}`;
    // Исходный ID в запись не попадает: только номер и длина.
    if (id !== text(o.id))
      issues.push(`вариант ${i + 1}: ID вне схемы (${text(o.id).length} знаков) → ${id}`);
    ids.set(text(o.id), id);
    const label = clip(o.label, 300, `вариант ${id}`) || id;
    const consequence =
      o.consequence === null || o.consequence === undefined
        ? null
        : clip(o.consequence, 1000, `последствие ${id}`);
    return { id, label, consequence };
  });
  const recommended =
    typeof q.recommended === 'string' && ids.has(q.recommended) ? ids.get(q.recommended)! : null;
  if (q.recommended !== null && q.recommended !== undefined && recommended === null)
    issues.push('рекомендуемый вариант не из вариантов — снят');
  const questionAreas = areas(q.affects, 'вопрос');
  const question = {
    question: clip(q.question, INPUT_LIMITS.question, 'вопрос') || 'Вопрос без текста',
    options,
    recommended,
    severity: rated(q.severity, 'вопрос', questionAreas),
    rationale: clip(q.rationale, INPUT_LIMITS.rationale, 'основание'),
    affects: questionAreas.areas,
  };
  const rawAssumptions = Array.isArray(raw.assumptions) ? raw.assumptions.filter(isRecord) : [];
  if (rawAssumptions.length > INPUT_LIMITS.assumptions)
    issues.push(
      `допущения: ${rawAssumptions.length}, оставлены первые ${INPUT_LIMITS.assumptions}`,
    );
  const assumptions = rawAssumptions.slice(0, INPUT_LIMITS.assumptions).map((a, i) => {
    const affects = areas(a.affects, `допущение ${i + 1}`);
    return {
      question: clip(a.question, INPUT_LIMITS.question, `допущение ${i + 1}`) || 'Без текста',
      chosen: clip(a.chosen, 300, `выбор допущения ${i + 1}`) || 'не назван',
      rationale: clip(a.rationale, INPUT_LIMITS.rationale, `основание допущения ${i + 1}`),
      severity: rated(a.severity, `допущение ${i + 1}`, affects),
      affects: affects.areas,
    };
  });
  if (raw.completed !== false)
    issues.push('completed: true вместе с вопросом — работа считается незавершённой');
  const parsed = implementationResultSchema.safeParse({
    completed: false,
    summary: text(raw.summary),
    discoveries: Array.isArray(raw.discoveries) ? raw.discoveries : [],
    inputRequest: question,
    assumptions,
  });
  if (!parsed.success) {
    // Находки вне схемы — не повод терять вопрос.
    const retry = implementationResultSchema.safeParse({
      completed: false,
      summary: text(raw.summary),
      discoveries: [],
      inputRequest: question,
      assumptions,
    });
    if (!retry.success) return undefined;
    issues.push('находки вне схемы отброшены');
    return { output: retry.data, issues: issues.slice(0, 10).map((s) => s.slice(0, 300)) };
  }
  return {
    output: parsed.data,
    issues: (issues.length ? issues : ['ответ вне схемы']).slice(0, 10).map((s) => s.slice(0, 300)),
  };
}
