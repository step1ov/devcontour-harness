// Прогресс поручения глазами оператора (`status`, `works[].stage`): текущий
// этап с временем в нём, оставшиеся этапы, что нужно от оператора и расход
// вызовов поручения — числами и одной строкой (русской и английской).
// Чистые функции сохранённых записей и часов: этап выводится из статуса
// поручения и последнего открытого замера попытки (`attempt.stage`).

import type { AttemptState, CallRecord, WorkState } from '../contracts/index.ts';
import { pipelineStages, workStages } from '../contracts/cli.ts';
import { usageTotals } from '../engine/usage.ts';
import type { Actor, NextAction } from '../projections/index.ts';

export { workStages, pipelineStages };
export type WorkStage = (typeof workStages)[number];
export type PipelineStage = (typeof pipelineStages)[number];

/** Что нужно и от кого: `actor` и `action` — как у диагноза `explain`. */
export interface StageNeeds {
  actor: Actor;
  action: NextAction;
}

export interface WorkStageView {
  name: WorkStage;
  /** Открытый замер попытки (`attempt.stage`), например `candidate-test:lint`. */
  step?: string;
  /**
   * Начало этапа: открытого замера, иначе попытки; у остановленного и ждущего
   * вопроса — конец последней попытки; у ждущего выдачи и итога — нет.
   */
  since?: string;
  elapsedMs?: number;
  next: PipelineStage[];
  /** Нет поля — неизвестно (хост без заданий графов и без вопроса). */
  needs?: StageNeeds;
  /**
   * Собственные вызовы поручения (его попытки и вызовы о нём, без ревью
   * плана группы): число, известная стоимость, вызовы без цены, время.
   */
  spend: { calls: number; knownUsd: number; unknownCalls: number; durationMs: number };
  line: string;
  lineEn: string;
}

const ms = (iso: string) => Date.parse(iso);

/** Этап попытки по имени замера; фаза интеграции важнее имени. */
export function stageOfStep(step: string): PipelineStage | 'prepare' {
  const family = step.split(':')[0]!;
  if (family.startsWith('integration')) return 'integration';
  if (family === 'candidate-review') return 'review';
  if (family === 'implementation' || family === 'implementation-reuse') return 'writer';
  if (family === 'dependency-store' || family === 'writer-dependencies') return 'prepare';
  // candidate-test, candidate-recheck, candidate-consumer, candidate-environment, generate.
  return 'gates';
}

const byStatus: Partial<Record<WorkState['status'], PipelineStage>> = {
  running: 'writer',
  verifying: 'gates',
  reviewing: 'review',
  integrating: 'integration',
};

const nextAfter = (stage: WorkStage): PipelineStage[] => {
  const i = pipelineStages.indexOf(stage as PipelineStage);
  if (i >= 0) return pipelineStages.slice(i + 1);
  return stage === 'done' || stage === 'cancelled' ? [] : [...pipelineStages];
};

/** Открытый замер попытки: последний начатый и не закрытый (как `attemptView`). */
function openStep(a: AttemptState | undefined) {
  const open = (a?.timings ?? []).filter((t) => !t.finishedAt);
  return open.reduce<(typeof open)[number] | undefined>(
    (x, t) => (!x || ms(t.startedAt) >= ms(x.startedAt) ? t : x),
    undefined,
  );
}

export interface WorkStageInput {
  work: WorkState;
  /** Попытки поручения в порядке хранилища. */
  attempts: readonly AttemptState[];
  /** Активная попытка поручения (`work.activeRunId`). */
  active?: AttemptState;
  /** Состояние открытого вопроса исполнителя (`works[].input.state`). */
  inputState?: string;
  blocked: boolean;
  /** Собственные записи вызовов поручения. */
  records: readonly CallRecord[];
  needs?: StageNeeds;
  now: number;
}

/** Этап поручения, время в нём, оставшиеся этапы, расход и строки. */
export function workStageOf(input: WorkStageInput): WorkStageView {
  const { work, active, now } = input;
  const live = active?.status === 'active' ? active : undefined;
  const step = live ? openStep(live) : undefined;
  let name: WorkStage;
  if (live)
    name =
      work.status === 'integrating'
        ? 'integration'
        : step
          ? stageOfStep(step.stage)
          : (byStatus[work.status] ?? 'writer');
  else if (work.status === 'done') name = 'done';
  else if (work.status === 'cancelled') name = 'cancelled';
  else if (
    input.inputState === 'awaiting-answer' ||
    input.inputState === 'answered-not-applied' ||
    input.inputState === 'carry-stale'
  )
    name = 'input';
  else if (work.status === 'failed') name = 'stopped';
  else if (work.status === 'draft' || input.blocked) name = 'blocked';
  else name = 'queued';
  const last = input.attempts.filter((a) => a.status !== 'active' && a.finishedAt).at(-1);
  const since = live
    ? (step?.startedAt ?? live.startedAt)
    : // Ожидание остановленного и ждущего вопроса считается от конца попытки;
      // у итога и у ждущего выдачи времени этапа нет.
      name === 'stopped' || name === 'input'
      ? last?.finishedAt
      : undefined;
  const totals = usageTotals([...input.records], false, now);
  const spend = {
    calls: totals.calls,
    knownUsd: Math.round(totals.knownCostUsd * 10000) / 10000,
    unknownCalls: totals.unknownCalls,
    durationMs: Math.round(totals.durationMs),
  };
  const view = {
    name,
    ...(step ? { step: step.stage } : {}),
    ...(since ? { since, elapsedMs: Math.max(0, now - ms(since)) } : {}),
    next: nextAfter(name),
    ...(input.needs ? { needs: input.needs } : {}),
    spend,
  };
  return {
    ...view,
    line: stageLine(work.id, view, 'ru'),
    lineEn: stageLine(work.id, view, 'en'),
  };
}

const stageText: Record<WorkStage, { ru: string; en: string }> = {
  queued: { ru: 'ждёт выдачи', en: 'queued' },
  blocked: { ru: 'не выдаётся (см. блокировки)', en: 'blocked (see blockers)' },
  prepare: { ru: 'подготовка зависимостей', en: 'preparing dependencies' },
  writer: { ru: 'исполнитель пишет код', en: 'writer coding' },
  gates: { ru: 'проверки (gates)', en: 'gates' },
  review: { ru: 'независимое ревью', en: 'independent review' },
  integration: { ru: 'интеграция с целевой веткой', en: 'integration' },
  input: { ru: 'ждёт ответа на вопрос исполнителя', en: 'waiting on an executor question' },
  stopped: { ru: 'остановлено', en: 'stopped' },
  done: { ru: 'принято', en: 'accepted' },
  cancelled: { ru: 'отменено', en: 'cancelled' },
};

const pipelineText: Record<PipelineStage, { ru: string; en: string }> = {
  writer: { ru: 'код', en: 'coding' },
  gates: { ru: 'проверки', en: 'gates' },
  review: { ru: 'ревью', en: 'review' },
  integration: { ru: 'интеграция', en: 'integration' },
};

const actionText: Record<NextAction, { ru: string; en: string }> = {
  none: { ru: 'ничего', en: 'nothing' },
  wait: { ru: 'ждать', en: 'wait' },
  'review-plan': { ru: 'согласовать план', en: 'approve the plan' },
  retry: { ru: 'повтор', en: 'retry' },
  'diagnose-failure': { ru: 'разобрать отказ', en: 'diagnose the failure' },
  'reset-attempts': { ru: 'сбросить попытки', en: 'reset the attempts' },
  'raise-budget': { ru: 'поднять бюджет', en: 'raise the budget' },
  'replan-dependents': { ru: 'перепланировать зависимые', en: 'replan the dependents' },
  'recovery-decision': { ru: 'решить восстановление', en: 'decide the recovery' },
  'user-decision': { ru: 'принять решение', en: 'make a decision' },
  'resume-queue': { ru: 'возобновить выдачу', en: 'resume the queue' },
  'fix-environment': { ru: 'исправить окружение', en: 'fix the environment' },
  'fix-access': { ru: 'восстановить доступ', en: 'fix access' },
  'answer-input': { ru: 'ответить на вопрос исполнителя', en: 'answer the executor question' },
  'apply-input': { ru: 'применить ответ', en: 'apply the answer' },
};

/** Длительность словами: «4 мин 12 с» / «4m 12s». */
export function durationText(msValue: number, lang: 'ru' | 'en') {
  const s = Math.floor(msValue / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const u = lang === 'ru' ? { h: ' ч', m: ' мин', s: ' с' } : { h: 'h', m: 'm', s: 's' };
  if (h) return `${h}${u.h}${m ? ` ${m}${u.m}` : ''}`;
  if (m) return `${m}${u.m}${sec ? ` ${sec}${u.s}` : ''}`;
  return `${sec}${u.s}`;
}

function needsText(needs: StageNeeds | undefined, lang: 'ru' | 'en') {
  if (!needs) return lang === 'ru' ? 'неизвестно (см. explain)' : 'unknown (see explain)';
  const act = actionText[needs.action][lang];
  if (needs.actor === 'user') return act;
  if (needs.actor === 'lead')
    return lang === 'ru' ? `ничего — ход ведущего (${act})` : `nothing — the lead acts (${act})`;
  if (needs.actor === 'controller' && needs.action !== 'none' && needs.action !== 'wait')
    return lang === 'ru' ? `ничего — harness сам (${act})` : `nothing — harness acts (${act})`;
  return lang === 'ru' ? 'ничего' : 'nothing';
}

/** Строка этапа: «a: исполнитель пишет код — 4 мин 12 с; дальше: …; от вас: …; потрачено: …». */
export function stageLine(
  id: string,
  s: Omit<WorkStageView, 'line' | 'lineEn'>,
  lang: 'ru' | 'en',
): string {
  const ru = lang === 'ru';
  const head =
    stageText[s.name][lang] +
    (s.step ? ` (${s.step})` : '') +
    (s.elapsedMs !== undefined ? ` — ${durationText(s.elapsedMs, lang)}` : '');
  const next = s.next.length ? s.next.map((x) => pipelineText[x][lang]).join(', ') : '—';
  const usd = `${s.spend.unknownCalls ? '≥' : ''}$${s.spend.knownUsd.toFixed(2)}`;
  const spend = ru
    ? `${usd}, вызовов ${s.spend.calls}${s.spend.unknownCalls ? ` (без цены ${s.spend.unknownCalls})` : ''}, время моделей ${durationText(s.spend.durationMs, lang)}`
    : `${usd}, ${s.spend.calls} calls${s.spend.unknownCalls ? ` (${s.spend.unknownCalls} unpriced)` : ''}, model time ${durationText(s.spend.durationMs, lang)}`;
  const line = ru
    ? `${id}: ${head}; дальше: ${next}; от вас: ${needsText(s.needs, lang)}; потрачено: ${spend}`
    : `${id}: ${head}; next: ${next}; from you: ${needsText(s.needs, lang)}; spent: ${spend}`;
  return line.length > 1000 ? line.slice(0, 999) + '…' : line;
}
