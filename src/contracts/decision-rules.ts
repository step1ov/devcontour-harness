// Кто принимает решения (docs/principles.md). Лист договоров без node:* и
// zod (только типы): его читают движок, explain, doctor, status и браузерная проекция
// представления оператора, чтобы правило и его тексты были одни.

import type { diagnosisActions, diagnosisActors } from './diagnosis.ts';

type Actor = (typeof diagnosisActors)[number];
type NextAction = (typeof diagnosisActions)[number];

/* ------------------------------------------------------------------ */
/* Действующее правило восстановления                                  */
/* ------------------------------------------------------------------ */

/** Действующее правило восстановления (`ExecutionPolicy.recovery`). */
export interface RecoveryPolicy {
  /** `lead` — разбор и сбросы ведущего в пределах бюджета; `user` — прежнее поведение. */
  mode: 'lead' | 'user';
  /** Шлюз диагностики и сбросы ведущего действуют (`mode: lead`). */
  enabled: boolean;
  diagnoseAfter: number;
  leadResets: number;
  /**
   * Откуда правило: `policy` — поле `recovery`; `derived` — выведено из
   * `inputPolicy.leadAnswers.technical: true`; `default` — поля нет, ведущий
   * технические вопросы не решает.
   */
  source: 'policy' | 'derived' | 'default';
}

export const DEFAULT_RECOVERY = { diagnoseAfter: 2, leadResets: 2 } as const;

/** Поля политики, из которых выводится правило (структурно — без zod). */
export interface RecoveryPolicyFields {
  recovery?: { mode: 'lead' | 'user'; diagnoseAfter: number; leadResets: number } | undefined;
  inputPolicy?: { leadAnswers?: { technical?: boolean } | undefined } | undefined;
  /** Режим harness: в облегчённом (нет поля) технические вопросы по умолчанию у ведущего. */
  harnessMode?: 'light' | 'strict' | undefined;
}

/**
 * Решает ли ведущий технические вопросы исполнителя: явное
 * `inputPolicy.leadAnswers.technical`; без правила ответов — да в облегчённом
 * режиме (alpha.72, `inputPolicyOf`), нет в строгом. Правило ответов без
 * `technical` (только `maxSeverity`) — нет.
 */
export const leadTechnicalOf = (policy: RecoveryPolicyFields): boolean => {
  const lead = policy.inputPolicy?.leadAnswers;
  return lead === undefined ? policy.harnessMode !== 'strict' : lead.technical === true;
};

/**
 * Действующее правило: явное поле `recovery` всегда главнее; без него —
 * `lead`, когда технические вопросы исполнителя решает ведущий
 * (`inputPolicy.leadAnswers.technical`), иначе `user` (прежнее поведение:
 * исчерпание попыток — решение человека, шлюза диагностики нет).
 */
export function recoveryPolicyOf(policy: RecoveryPolicyFields): RecoveryPolicy {
  if (policy.recovery)
    return {
      mode: policy.recovery.mode,
      enabled: policy.recovery.mode === 'lead',
      diagnoseAfter: policy.recovery.diagnoseAfter,
      leadResets: policy.recovery.leadResets,
      source: 'policy',
    };
  const lead = policy.inputPolicy?.leadAnswers?.technical === true;
  return {
    mode: lead ? 'lead' : 'user',
    enabled: lead,
    ...DEFAULT_RECOVERY,
    source: lead ? 'derived' : 'default',
  };
}

/* ------------------------------------------------------------------ */
/* Настройки решений: тексты для панели, doctor и status               */
/* ------------------------------------------------------------------ */

export interface Bilingual {
  ru: string;
  en: string;
}

export const decisionSettingKeys = [
  'maxAttempts',
  'recovery.mode',
  'recovery.diagnoseAfter',
  'recovery.leadResets',
  'inputPolicy.leadAnswers.technical',
] as const;
export type DecisionSettingKey = (typeof decisionSettingKeys)[number];

/** Что делает настройка — одно простое предложение (панель «Настройки», doctor). */
export const decisionSettingExplain: Record<DecisionSettingKey, Bilingual> = {
  maxAttempts: {
    ru: 'Сколько засчитанных попыток получает задача до решения, что делать дальше.',
    en: 'How many counted attempts a task gets before someone decides what to do next.',
  },
  'recovery.mode': {
    ru: 'Кто решает после повторных отказов: lead — ведущий разбирает причину и сам даёт ещё попытки в пределах бюджета; user — исчерпание попыток решаете вы.',
    en: 'Who decides after repeated failures: lead — the lead diagnoses the cause and grants more attempts within a budget; user — you decide when the attempts run out.',
  },
  'recovery.diagnoseAfter': {
    ru: 'После скольких засчитанных отказов ведущий обязан разобрать причину до следующей попытки; не меньше предела попыток — разбор только при исчерпании.',
    en: 'After how many counted failures the lead must diagnose the cause before the next attempt; at or above the attempt limit — only when the attempts run out.',
  },
  'recovery.leadResets': {
    ru: 'Сколько раз ведущий может сам дать задаче новый предел попыток по свежему разбору; дальше решаете вы, 0 — сбрасываете только вы.',
    en: 'How many times the lead may grant a task a new attempt limit after a fresh diagnosis; after that you decide, 0 means only you reset.',
  },
  'inputPolicy.leadAnswers.technical': {
    ru: 'Отвечает ли ведущий сам на технические вопросы исполнителя; вопросы о продукте всегда идут к вам.',
    en: 'Whether the lead answers the writer technical questions itself; product questions always go to you.',
  },
};

export interface DecisionSetting {
  key: DecisionSettingKey;
  value: number | boolean | string;
  source: 'policy' | 'derived' | 'default';
  explain: Bilingual;
}

/** Действующий итог правила одной фразой (панель, doctor, status). */
export function decisionSummary(r: RecoveryPolicy, maxAttempts: number): Bilingual {
  if (!r.enabled)
    return {
      ru: `после ${maxAttempts} ${ruFailures(maxAttempts)} — решаете вы; разбора ведущего перед попыткой нет`,
      en: `after ${maxAttempts} failure${maxAttempts === 1 ? '' : 's'} you decide; no lead diagnosis before an attempt`,
    };
  const gate =
    r.diagnoseAfter < maxAttempts
      ? {
          ru: `после ${r.diagnoseAfter} ${ruFailures(r.diagnoseAfter)} — разбор ведущего`,
          en: `after ${r.diagnoseAfter} failure${r.diagnoseAfter === 1 ? '' : 's'} the lead diagnoses`,
        }
      : {
          ru: `разбор ведущего — когда исчерпаны ${maxAttempts} ${ruAttempts(maxAttempts)}`,
          en: `the lead diagnoses when the ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'} run out`,
        };
  const resets = r.leadResets
    ? {
        ru: `ведущий может дать ещё попытки ${r.leadResets} ${ruTimes(r.leadResets)}`,
        en: `the lead may grant more attempts ${r.leadResets} time${r.leadResets === 1 ? '' : 's'}`,
      }
    : { ru: 'ещё попытки даёте только вы', en: 'only you grant more attempts' };
  return { ru: `${gate.ru}; ${resets.ru}; дальше — вы`, en: `${gate.en}; ${resets.en}; then you` };
}

const ruForm = (n: number, [one, few, many]: [string, string, string]) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
// «после N отказа/отказов» — родительный падеж.
const ruFailures = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'отказа' : 'отказов');
const ruAttempts = (n: number) => ruForm(n, ['попытка', 'попытки', 'попыток']);
const ruTimes = (n: number) => ruForm(n, ['раз', 'раза', 'раз']);

/**
 * Настройки решений с источником и объяснением. `defaulted` — пути полей
 * политики, взятые из умолчаний (`maxAttempts`, `recovery.diagnoseAfter`,
 * `recovery.leadResets`).
 */
export function decisionSettings(
  policy: RecoveryPolicyFields & { maxAttempts: number },
  defaulted: readonly string[] = [],
): { items: DecisionSetting[]; summary: Bilingual } {
  const r = recoveryPolicyOf(policy);
  const recoverySource = (field: string): DecisionSetting['source'] =>
    r.source === 'policy'
      ? defaulted.includes(field)
        ? 'default'
        : 'policy'
      : r.source === 'derived'
        ? 'derived'
        : 'default';
  const explicit = policy.inputPolicy?.leadAnswers?.technical;
  const technical = leadTechnicalOf(policy);
  const items: DecisionSetting[] = [
    {
      key: 'maxAttempts',
      value: policy.maxAttempts,
      source: defaulted.includes('maxAttempts') ? 'default' : 'policy',
      explain: decisionSettingExplain.maxAttempts,
    },
    {
      key: 'recovery.mode',
      value: r.mode,
      source: r.source,
      explain: decisionSettingExplain['recovery.mode'],
    },
    {
      key: 'recovery.diagnoseAfter',
      value: r.diagnoseAfter,
      source: recoverySource('recovery.diagnoseAfter'),
      explain: decisionSettingExplain['recovery.diagnoseAfter'],
    },
    {
      key: 'recovery.leadResets',
      value: r.leadResets,
      source: recoverySource('recovery.leadResets'),
      explain: decisionSettingExplain['recovery.leadResets'],
    },
    {
      key: 'inputPolicy.leadAnswers.technical',
      value: technical,
      source: explicit === undefined ? 'default' : 'policy',
      explain: decisionSettingExplain['inputPolicy.leadAnswers.technical'],
    },
  ];
  return { items, summary: decisionSummary(r, policy.maxAttempts) };
}

/**
 * Необычное сочетание: восстановление ведущим при том, что технические
 * вопросы исполнителя решает человек. Допустимо, но doctor говорит об этом.
 */
export function decisionWarning(policy: RecoveryPolicyFields): Bilingual | undefined {
  const r = recoveryPolicyOf(policy);
  if (r.mode === 'lead' && !leadTechnicalOf(policy))
    return {
      ru: 'recovery.mode: lead, а технические вопросы исполнителя решает человек (inputPolicy.leadAnswers.technical не true): отказы разбирает ведущий, а вопросы — вы. Допустимо; обычно оба решения технические и оба у ведущего (init --lead-technical-answers).',
      en: 'recovery.mode is lead while the writer technical questions go to a human (inputPolicy.leadAnswers.technical is not true): the lead handles failures, you handle questions. Allowed; usually both are technical and both go to the lead (init --lead-technical-answers).',
    };
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Таблица решений                                                     */
/* ------------------------------------------------------------------ */

/**
 * Вид решения: `technical` — техническое восстановление, его принимает
 * ведущий сам в пределах бюджета; остальные — человек: `product` (что
 * увидит пользователь), `contradiction` (противоречивое обещание), `budget`
 * (бюджет попыток, сбросов или расходов исчерпан, правило выключено) и
 * `escalation` (явная эскалация).
 */
export type DecisionKind = 'technical' | 'product' | 'contradiction' | 'budget' | 'escalation';

export interface DecisionRule {
  /** Код остановки explain. */
  code: string;
  actor: Actor;
  action: NextAction;
  kind: DecisionKind;
}

/**
 * Кто принимает решения: одна таблица для explain и для документа
 * (docs/principles.md, раздел «Кто принимает решения», таблица правил).
 * Контрактный тест сверяет её с документом и с ответами explain: перевод
 * технического решения к человеку без правки принципа его роняет.
 */
export const decisionRules = {
  /** Засчитанных отказов подряд — `diagnoseAfter`: разбор до следующей попытки. */
  'diagnosis-required': {
    code: 'DIAGNOSIS_REQUIRED',
    actor: 'lead',
    action: 'diagnose',
    kind: 'technical',
  },
  /** Попытки исчерпаны, сбросы ведущего остались, свежего разбора нет. */
  'exhausted-diagnose': {
    code: 'ATTEMPTS_EXHAUSTED',
    actor: 'lead',
    action: 'diagnose',
    kind: 'technical',
  },
  /**
   * Попытки исчерпаны, есть свежий технический разбор, сбросы остались.
   * С alpha.71 (P8-4(b), решение владельца) технический и разбор
   * `environment` с доказательством исправления — и по пределу
   * незасчитанных отказов окружения.
   */
  'exhausted-lead-reset': {
    code: 'ATTEMPTS_EXHAUSTED',
    actor: 'lead',
    action: 'reset-attempts',
    kind: 'technical',
  },
  /** Разбор: задача велика — перепланировать и согласовать разделение. */
  'diagnosis-split': {
    code: 'NOT_READY',
    actor: 'lead',
    action: 'review-plan',
    kind: 'technical',
  },
  /**
   * Отказ окружения, который повтор не снимет (gate зовёт ps в песочнице ОС,
   * 0.1.0-alpha.66; gate упал, не назвав причины, — `gate-definition`,
   * 0.1.0-alpha.69): ведущий меняет gate или команду; попытка не засчитана.
   */
  'environment-gate-command': {
    code: 'RUNTIME_UNAVAILABLE',
    actor: 'lead',
    action: 'fix-environment',
    kind: 'technical',
  },
  /**
   * Gate удержан отказом без повтора (ps из базы в песочнице, 0.1.0-alpha.66;
   * провал без названной причины — `gate-definition`, 0.1.0-alpha.69):
   * работы с этим gate не выдаются, ведущий меняет gate или исправляет тест
   * и повторяет остановленную работу (`retry --by lead`).
   */
  'environment-gate-held': {
    code: 'ENVIRONMENT_GATE_HELD',
    actor: 'lead',
    action: 'fix-environment',
    kind: 'technical',
  },
  /** Технический вопрос исполнителя, политика разрешает ведущему. */
  'input-technical': {
    code: 'INPUT_REQUIRED',
    actor: 'lead',
    action: 'answer-input',
    kind: 'technical',
  },
  /** Разбор: противоречивое обещание — решение человека. */
  'diagnosis-contradiction': {
    code: 'NOT_READY',
    actor: 'user',
    action: 'user-decision',
    kind: 'contradiction',
  },
  /** Вопрос исполнителя о продукте (или политика не разрешает ведущему). */
  'input-user': {
    code: 'INPUT_REQUIRED',
    actor: 'user',
    action: 'answer-input',
    kind: 'product',
  },
  /** Исчерпание: правило `user`, сбросы ведущего потрачены, разбор не технический или повторён. */
  'exhausted-user': {
    code: 'ATTEMPTS_EXHAUSTED',
    actor: 'user',
    action: 'reset-attempts',
    kind: 'budget',
  },
  /** Бюджет расходов или времени исчерпан. */
  'budget-exhausted': {
    code: 'BUDGET_EXHAUSTED',
    actor: 'user',
    action: 'raise-budget',
    kind: 'budget',
  },
} as const satisfies Record<string, DecisionRule>;
export type DecisionRuleKey = keyof typeof decisionRules;

/** Ход правила для explain: код, актёр и действие из таблицы. */
export const ruleOutcome = (key: DecisionRuleKey) => {
  const r = decisionRules[key];
  return { code: r.code, actor: r.actor, action: r.action } as const;
};

/** Блок настроек решений для панели, doctor и status (`decisionSettingsSchema`). */
export function decisionSettingsView(
  policy: RecoveryPolicyFields & { maxAttempts: number },
  defaulted: readonly string[] = [],
): { items: DecisionSetting[]; summary: Bilingual; warning?: Bilingual } {
  const warning = decisionWarning(policy);
  return { ...decisionSettings(policy, defaulted), ...(warning ? { warning } : {}) };
}

/** Виды и состояния шагов пути работы (`view.works[].track`, ревизия 6). */
export const trackStepKinds = [
  'code',
  'checks',
  'review',
  'integration',
  'question',
  'diagnosis',
  'reset',
  'user-decision',
  'accepted',
] as const;
/** Кто решает на шаге пути (`track.steps[].actor`, 0.1.0-alpha.66). */
export const trackStepActors = ['lead', 'user', 'harness'] as const;
export const trackStepStates = [
  'planned',
  'current',
  'passed',
  'failed',
  'waiting',
  'skipped',
  'decision',
] as const;
