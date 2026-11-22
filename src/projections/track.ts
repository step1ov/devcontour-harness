// Путь работы целиком (`view.works[].track`, ревизия 6): пройденные
// попытки по шагам (код → проверки → ревью → интеграция), решения ведущего
// и человека между ними и плановый остаток — попытки, точки разбора
// ведущего по `recovery.diagnoseAfter`, запасные раунды сбросов ведущего по
// `recovery.leadResets` и «принято». Чистая проекция без node:* и zod.

import type { AttemptState, FailureKind, WorkState } from '../contracts/execution.ts';
import {
  trackStepKinds,
  trackStepStates,
  type RecoveryPolicy,
} from '../contracts/decision-rules.ts';
import {
  countedFailure,
  exhaustedStep,
  leadHold,
  leadResetsUsed,
  pendingFailures,
} from './lead-recovery.ts';

export { trackStepKinds, trackStepStates };
export type TrackStepKind = (typeof trackStepKinds)[number];
export type TrackStepState = (typeof trackStepStates)[number];

export interface TrackStep {
  kind: TrackStepKind;
  /** Номер попытки (`AttemptState.attempt`; плановые — следующие по порядку). */
  attempt?: number;
  state: TrackStepState;
  label: string;
  at?: string;
  /** Коротко простыми словами: почему отказ, что решено. */
  reason?: string;
  /** Шаг доработки после приёмки (номер доработки, P3-1). */
  rework?: number;
}

/** Предел шагов пути: сверх него отбрасываются самые ранние. */
export const TRACK_STEP_LIMIT = 120;

type Lang = 'ru' | 'en';
type Bi = { ru: string; en: string };

const phaseSteps = ['code', 'checks', 'review', 'integration'] as const;
const phaseLabel: Record<(typeof phaseSteps)[number], Bi> = {
  code: { ru: 'код', en: 'code' },
  checks: { ru: 'проверки', en: 'checks' },
  review: { ru: 'ревью', en: 'review' },
  integration: { ru: 'интеграция', en: 'integration' },
};

/** Где остановилась попытка по классу отказа; без класса — по фазе. */
const failedAt: Partial<Record<FailureKind, number>> = {
  'empty-result': 0,
  unfinished: 0,
  'context-exhausted': 0,
  gate: 1,
  review: 2,
  'review-protocol': 2,
  'needs-lead': 2,
  'scope-violation': 3,
  merge: 3,
  'stale-base': 3,
};
const phaseIndex: Record<string, number> = {
  running: 0,
  verifying: 1,
  reviewing: 2,
  integrating: 3,
};

const failureText: Partial<Record<FailureKind, Bi>> = {
  gate: { ru: 'проверки не прошли', en: 'checks failed' },
  review: { ru: 'ревью отклонило', en: 'review rejected' },
  'review-protocol': { ru: 'ответ ревью не по протоколу', en: 'review protocol broken' },
  'empty-result': { ru: 'изменений нет', en: 'no changes' },
  unfinished: { ru: 'исполнитель не доделал', en: 'the writer did not finish' },
  'context-exhausted': { ru: 'не хватило окна контекста', en: 'context window ran out' },
  'scope-violation': { ru: 'вне области задачи', en: 'outside the task scope' },
  merge: { ru: 'слияние не сошлось', en: 'merge failed' },
  'stale-base': { ru: 'база отстала', en: 'stale base' },
  environment: { ru: 'окружение', en: 'environment' },
  'provider-auth': { ru: 'провайдер модели', en: 'model provider' },
  timeout: { ru: 'время вышло', en: 'timed out' },
  stalled: { ru: 'зависла', en: 'stalled' },
  'needs-input': { ru: 'вопрос исполнителя', en: 'writer question' },
  'needs-lead': { ru: 'нужно решение ведущего', en: 'needs the lead' },
  budget: { ru: 'бюджет', en: 'budget' },
  cancelled: { ru: 'отменено', en: 'cancelled' },
};

const causeShort: Record<string, Bi> = {
  coverage: { ru: 'слабое покрытие', en: 'weak coverage' },
  approach: { ru: 'неверный подход', en: 'wrong approach' },
  split: { ru: 'разделить задачу', en: 'split the task' },
  contradiction: { ru: 'противоречие', en: 'contradiction' },
  environment: { ru: 'окружение', en: 'environment' },
  other: { ru: 'другое', en: 'other' },
};

const L = {
  diagnosis: { ru: 'разбор ведущего', en: 'lead diagnosis' },
  replan: { ru: 'перепланирование', en: 're-plan' },
  reset: { ru: 'ещё попытки от ведущего', en: 'more attempts from the lead' },
  userReset: { ru: 'сброс попыток человеком', en: 'attempts reset by a human' },
  user: { ru: 'решение человека', en: 'human decision' },
  question: { ru: 'вопрос исполнителя', en: 'writer question' },
  accepted: { ru: 'принято', en: 'accepted' },
  acceptedEarlier: { ru: 'принято (прежняя редакция)', en: 'accepted (earlier revision)' },
  abandoned: {
    ru: 'доработка оставлена — принятая редакция',
    en: 'rework abandoned — the accepted revision',
  },
} satisfies Record<string, Bi>;

export interface TrackOptions {
  maxAttempts: number;
  recovery: RecoveryPolicy;
  lang: Lang;
  /** Работу держит вопрос исполнителя без применённого ответа. */
  question?: boolean;
  /** Бюджет расходов держит работу. */
  budgetHeld?: boolean;
}

/** Путь работы: история, текущая точка и плановый остаток. */
export function workTrack(
  work: WorkState,
  attempts: readonly AttemptState[],
  o: TrackOptions,
): { steps: TrackStep[]; truncated: number } {
  const t = (b: Bi) => b[o.lang];
  const own = attempts.filter((a) => a.workId === work.id);
  // Доработку отменила alpha.65 вместе с работой: представление показывает
  // работу принятой (`restoredFrom: cancelled-rework`), путь — так же.
  const restored = work.status === 'cancelled' && !!work.rework && !work.rework.abandoned;
  const settled = work.status === 'done' || restored;
  const reworkFrom = work.rework?.accepted.runId
    ? own.findIndex((a) => a.id === work.rework!.accepted.runId)
    : -1;
  const reworkOf = (i: number) =>
    work.rework && reworkFrom >= 0 && i > reworkFrom ? work.rework.revision : undefined;
  type Item = { at: string; order: number; steps: TrackStep[] };
  const items: Item[] = [];
  const lastSucceeded = own.findLastIndex((a) => a.status === 'succeeded');
  own.forEach((a, i) => {
    const rework = reworkOf(i);
    const mark = (s: TrackStep): TrackStep => (rework ? { ...s, rework } : s);
    const steps: TrackStep[] = [];
    const reached =
      a.status === 'succeeded'
        ? 4
        : a.status === 'active'
          ? (phaseIndex[a.phase] ?? 0)
          : a.failureKind && failedAt[a.failureKind] !== undefined
            ? failedAt[a.failureKind]!
            : (phaseIndex[a.phase] ?? 0);
    const counted = countedFailure(a);
    const why = a.failureKind ? failureText[a.failureKind] : undefined;
    phaseSteps.forEach((kind, k) => {
      const base = { kind, attempt: a.attempt, label: t(phaseLabel[kind]) };
      if (k < reached) steps.push(mark({ ...base, state: 'passed' }));
      else if (k === reached && a.status === 'active')
        steps.push(mark({ ...base, state: 'current' }));
      else if (k === reached && (a.status === 'failed' || a.status === 'expired'))
        steps.push(
          mark({
            ...base,
            state: 'failed',
            ...(a.finishedAt ? { at: a.finishedAt } : {}),
            reason:
              (why ? t(why) : t({ ru: 'отказ', en: 'failed' })) +
              (counted ? '' : t({ ru: ' (не засчитана)', en: ' (not counted)' })),
          }),
        );
      else if (a.status !== 'succeeded') steps.push(mark({ ...base, state: 'skipped' }));
    });
    if (a.status === 'succeeded')
      steps.push(
        mark({
          kind: 'accepted',
          attempt: a.attempt,
          state: 'passed',
          label: t(i === lastSucceeded && settled ? L.accepted : L.acceptedEarlier),
          ...(a.finishedAt ? { at: a.finishedAt } : {}),
        }),
      );
    items.push({ at: a.startedAt, order: 0, steps });
  });
  for (const d of work.leadRecovery?.diagnoses ?? [])
    items.push({
      at: d.at,
      order: 1,
      steps: [
        {
          kind: 'diagnosis',
          state: 'decision',
          label: t(d.cause === 'split' ? L.replan : L.diagnosis),
          at: d.at,
          reason: `${d.id}: ${t(causeShort[d.cause] ?? causeShort.other!)}`,
        },
      ],
    });
  for (const r of work.leadRecovery?.resets ?? [])
    items.push({
      at: r.at,
      order: 2,
      steps: [
        {
          kind: 'reset',
          state: 'decision',
          label: t(r.by === 'lead' ? L.reset : L.userReset),
          at: r.at,
          reason:
            r.by === 'lead'
              ? t({
                  ru: `+${r.granted} (сброс ${r.index ?? '?'} из ${r.cap ?? '?'}, ${r.diagnosis ?? '—'})`,
                  en: `+${r.granted} (reset ${r.index ?? '?'} of ${r.cap ?? '?'}, ${r.diagnosis ?? '—'})`,
                })
              : `+${r.granted}`,
        },
      ],
    });
  // Отказ от доработки (`work.rework-abandoned`) или доработка, отменённая
  // alpha.65: работа снова на принятой редакции — последний шаг пути.
  if (work.rework && (work.rework.abandoned || restored)) {
    const at =
      work.rework.abandoned?.at ??
      own.findLast((a) => a.finishedAt)?.finishedAt ??
      work.rework.reopenedAt;
    items.push({
      at,
      order: 3,
      steps: [
        {
          kind: 'accepted',
          state: 'passed',
          label: t(L.abandoned),
          at,
          rework: work.rework.revision,
        },
      ],
    });
  }
  items.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.order - y.order));
  const steps = items.flatMap((x) => x.steps);

  if (!settled) {
    const closed = work.status === 'cancelled';
    const planned: TrackStep[] = [];
    const plan = (s: Omit<TrackStep, 'state'>) =>
      planned.push({ ...s, state: closed ? 'skipped' : 'planned' });
    const rework = work.rework && own.length - 1 > reworkFrom ? work.rework.revision : undefined;
    const r = o.recovery;
    const hold = closed ? undefined : leadHold(work, own, r, o.maxAttempts);
    const exhausted = work.attempt >= o.maxAttempts && !work.activeRunId;
    let pending = pendingFailures(work, own).length;
    // Исчерпание, которое решает человек, запасных раундов ведущего не имеет;
    // ждущий сброс ведущего — уже первый из них.
    let spareFrom = leadResetsUsed(work) + 1;
    // Текущая точка, когда попытки не идут.
    if (!closed && o.question)
      planned.push({ kind: 'question', state: 'waiting', label: t(L.question) });
    if (hold?.kind === 'diagnosis-required') {
      planned.push({ kind: 'diagnosis', state: 'waiting', label: t(L.diagnosis) });
      pending = 0;
    } else if (hold?.kind === 'replan')
      planned.push({ kind: 'diagnosis', state: 'waiting', label: t(L.replan) });
    else if (hold?.kind === 'contradiction')
      planned.push({ kind: 'user-decision', state: 'waiting', label: t(L.user) });
    else if (exhausted && !closed) {
      const step = exhaustedStep(work, own, r, o.budgetHeld);
      if (step.actor === 'user') spareFrom = Infinity;
      else if (step.step === 'reset') spareFrom++;
      planned.push(
        step.actor === 'lead'
          ? step.step === 'reset'
            ? {
                kind: 'reset',
                state: 'waiting',
                label: t(L.reset),
                reason: t({
                  ru: `сброс ${step.index} из ${step.cap}`,
                  en: `reset ${step.index} of ${step.cap}`,
                }),
              }
            : {
                kind: 'diagnosis',
                state: 'waiting',
                label: t(step.step === 'replan' ? L.replan : L.diagnosis),
              }
          : { kind: 'user-decision', state: 'waiting', label: t(L.user) },
      );
    }
    // Плановые попытки: остаток предела; разбор — там, где отказов без
    // разбора станет `diagnoseAfter` (если каждая следующая не удастся).
    if (work.activeRunId) pending++;
    let next = Math.max(0, ...own.map((a) => a.attempt)) + 1;
    const left = Math.max(0, o.maxAttempts - work.attempt);
    const attemptRow = () => {
      for (const kind of phaseSteps)
        plan({
          kind,
          attempt: next,
          label: t(phaseLabel[kind]),
          ...(rework ? { rework } : {}),
        });
      next++;
    };
    for (let k = 0; k < left; k++) {
      if (r.enabled && pending >= r.diagnoseAfter && r.diagnoseAfter < o.maxAttempts) {
        plan({ kind: 'diagnosis', label: t(L.diagnosis) });
        pending = 0;
      }
      attemptRow();
      pending++;
    }
    // Запасные раунды сбросов ведущего: разбор и новый предел.
    if (r.enabled) {
      for (let k = spareFrom; k <= r.leadResets; k++) {
        if (planned.at(-1)?.kind !== 'diagnosis')
          plan({ kind: 'diagnosis', label: t(L.diagnosis) });
        plan({
          kind: 'reset',
          label: t(L.reset),
          reason: t({ ru: `сброс ${k} из ${r.leadResets}`, en: `reset ${k} of ${r.leadResets}` }),
        });
      }
    }
    plan({ kind: 'accepted', label: t(L.accepted), ...(rework ? { rework } : {}) });
    steps.push(...planned);
  }
  const truncated = Math.max(0, steps.length - TRACK_STEP_LIMIT);
  return { steps: truncated ? steps.slice(truncated) : steps, truncated };
}
