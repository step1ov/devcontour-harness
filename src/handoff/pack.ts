import {
  HANDOFF_LIMITS,
  HANDOFF_VERSION,
  handoffPackSchema,
  type HandoffPack,
} from '../contracts/handoff.ts';
import { HarnessError } from '../contracts/errors.ts';
import type { AttemptState, WorkState, WorkStatus } from '../contracts/execution.ts';
import type { Harness } from '../control/harness.ts';
import { stopInputsOf } from '../explain/state.ts';
import { clipText } from '../projections/clip.ts';
import { activeStatuses } from '../projections/enums.ts';
import { nextAction } from '../projections/next.ts';
import { explainStop, stopCodeOf, type StopDiagnosis } from '../projections/stop.ts';

export interface HandoffOptions {
  /** Только этот граф; нет — вся доска. */
  graphId?: string;
  /** Намерения агента: единственный текст пакета не из хранилища. */
  intentions?: readonly string[];
}

const clip = (s: string | undefined) => clipText(s, HANDOFF_LIMITS.text);
/** Поле объекта только при заданном значении (exactOptionalPropertyTypes). */
const opt = <K extends string, T>(key: K, value: T | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, T>>;

const isActive = (s: WorkStatus) => (activeStatuses as readonly WorkStatus[]).includes(s);
/** Порядок открытых поручений в пакете: идущие, упавшие, план, остальные. */
const rank = (s: WorkStatus) =>
  isActive(s) ? 0 : s === 'failed' ? 1 : s === 'draft' ? 2 : s === 'ready' ? 3 : 4;
/** Решение: действует человек или ведущий, и действие — не ожидание. */
const isDecision = (d: StopDiagnosis) =>
  (d.actor === 'user' || d.actor === 'lead') && d.action !== 'wait';
/** Порядок остановок: решения человека, затем ведущего, затем ожидания. */
const actorRank = (d: StopDiagnosis) => (!isDecision(d) ? 2 : d.actor === 'user' ? 0 : 1);

/**
 * Пакет передачи контекста ведущего агента из хранилища (`harness handoff`).
 * Только чтение: собирается из тех же проекций, что `status --detail`
 * (очередь, активные попытки, блокировки, бюджеты) и `explain` (остановки,
 * решения, ожидаемое действие; без проб runtime), плюс `nextAction` по
 * каждому открытому поручению и последние провалы попыток. Размер ограничен
 * `HANDOFF_LIMITS`. Агент добавляет только `intentions`.
 */
export function handoffPack(h: Harness, options: HandoffOptions = {}): HandoffPack {
  const { graphId } = options;
  const intentions = (options.intentions ?? []).map((s) => s.trim()).filter(Boolean);
  if (intentions.length > HANDOFF_LIMITS.intentions)
    throw new HarnessError(
      'INVALID_INPUT',
      `Намерений ${intentions.length}, предел ${HANDOFF_LIMITS.intentions}`,
      [{ path: ['intentions'], message: `${intentions.length} > ${HANDOFF_LIMITS.intentions}` }],
    );
  const status = h.status(graphId, { detail: true });
  if (graphId !== undefined && !status.graphs.length)
    throw new HarnessError('NOT_FOUND', 'Граф не найден: ' + graphId);
  const detail = status.detail!;
  const { maxAttempts, repairBudget } = h.policy;
  const now = h.engine.clock();
  const blockersOf = new Map(status.works.map((w) => [w.id, w.blockers]));

  const read = h.engine.read((v) => {
    const works = v.works(graphId);
    const attempts = works.flatMap((w) => v.attempts(w.id));
    return { works, attempts };
  });
  const byId = new Map<string, WorkState>(read.works.map((w) => [w.id, w]));
  const title = (id: string) => clip(byId.get(id)?.order.title ?? id)!;

  // Сводка по статусам — в порядке перечня статусов.
  const counts = new Map<WorkStatus, number>();
  for (const w of read.works) counts.set(w.status, (counts.get(w.status) ?? 0) + 1);
  const open = read.works
    .filter((w) => w.status !== 'done' && w.status !== 'cancelled')
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rank(a.w.status) - rank(b.w.status) || a.i - b.i)
    .map(({ w }) => w);

  // Остановки и решения — диагнозы explain по сохранённому состоянию.
  const inGraph = (d: StopDiagnosis) => graphId === undefined || !d.workId || byId.has(d.workId);
  const diagnoses = stopInputsOf(h, { maxAttempts, repairBudget })
    .map(explainStop)
    .filter((d) => d.action !== 'none' && inGraph(d))
    .map((d, i) => ({ d, i }))
    .sort((a, b) => actorRank(a.d) - actorRank(b.d) || a.i - b.i)
    .map(({ d }) => ({ ...d, message: clip(d.message)! }));
  const stops = diagnoses.slice(0, HANDOFF_LIMITS.stops);
  // Диагноз поручения: explain знает, продолжит ли движок работу сам.
  const diagnosisOf = new Map<string, StopDiagnosis>();
  for (const d of diagnoses)
    if (d.workId && !diagnosisOf.has(d.workId)) diagnosisOf.set(d.workId, d);

  const works = open.slice(0, HANDOFF_LIMITS.works).map((w) => {
    const view = nextAction({
      status: w.status,
      attempt: w.attempt,
      maxAttempts,
      ...opt('hold', w.hold),
      ...opt('recovery', w.recovery),
    });
    // Кто и что — по диагнозу explain, когда он есть; стадия — по nextAction.
    const d = diagnosisOf.get(w.id);
    const next = d
      ? { actor: d.actor, action: d.action, step: view.step, detail: d.message }
      : { ...view, ...opt('detail', clip(view.detail)) };
    return {
      id: w.id,
      graphId: w.graphId,
      title: title(w.id),
      status: w.status,
      attempt: w.attempt,
      ...opt('failureKind', w.failureKind),
      ...opt('failure', clip(w.failure)),
      ...(w.hold ? { hold: { operation: w.hold.operation, reason: clip(w.hold.reason)! } } : {}),
      ...(w.recovery
        ? {
            recovery: {
              status: w.recovery.status,
              property: w.recovery.property,
              ...opt('reason', clip(w.recovery.reason)),
              ...opt('proposal', clip(w.recovery.decision?.proposal)),
            },
          }
        : {}),
      blockers: (blockersOf.get(w.id) ?? [])
        .slice(0, HANDOFF_LIMITS.blockers)
        .map((b) => ({ code: b.code, message: clip(b.message)! })),
      next,
    };
  });

  // Провалы попыток — новые первыми.
  const time = (a: AttemptState) => a.finishedAt ?? a.startedAt;
  const failed = read.attempts
    .filter((a) => a.status === 'failed' || a.status === 'expired')
    .sort((a, b) => time(b).localeCompare(time(a)) || b.attempt - a.attempt);
  const failures = failed.slice(0, HANDOFF_LIMITS.failures).map((a) => ({
    runId: a.id,
    workId: a.workId,
    attempt: a.attempt,
    status: a.status as 'failed' | 'expired',
    phase: a.phase,
    ...opt('finishedAt', a.finishedAt),
    ...opt('failureKind', a.failureKind),
    code: stopCodeOf(a.failureKind),
    ...opt('error', clip(a.error)),
  }));

  // Незавершённые записи: попытка не закрыта, но владение истекло или
  // поручение уже ведёт другую попытку.
  const unfinishedAll = read.attempts
    .filter((a) => a.status === 'active')
    .map((a) => ({
      a,
      stale: a.leaseUntil <= now,
      current: byId.get(a.workId)?.activeRunId === a.id,
    }))
    .filter((x) => x.stale || !x.current);
  const unfinished = unfinishedAll
    .slice(0, HANDOFF_LIMITS.unfinished)
    .map(({ a, stale, current }) => ({
      runId: a.id,
      workId: a.workId,
      attempt: a.attempt,
      phase: a.phase,
      startedAt: a.startedAt,
      stale,
      current,
      ...opt('interrupted', a.interrupted),
    }));

  const active = detail.attempts.map((a) => ({
    workId: a.workId,
    title: title(a.workId),
    runId: a.runId,
    attempt: a.attempt,
    phase: a.phase,
    runtime: a.runtime,
    elapsedMs: a.elapsedMs,
    ...(a.stage ? { stage: { name: a.stage.name, elapsedMs: a.stage.elapsedMs } } : {}),
    ...opt('sinceHeartbeatMs', a.lease.sinceHeartbeatMs),
    stale: a.lease.stale,
    gates: a.gates,
  }));

  const q = detail.queue;
  const queue = {
    paused: q.paused,
    ...opt('reason', q.reason),
    ...opt('detail', clip(q.detail)),
    ...opt('since', q.since),
    ...('liftedByRun' in q ? { liftedByRun: q.liftedByRun } : {}),
    ...opt('code', q.code),
    ...(q.actor !== undefined ? { actor: q.actor } : {}),
    ...opt('action', q.action),
  };

  const budgets = status.budgets
    ? {
        onUnknown: status.budgets.onUnknown,
        entries: status.budgets.budgets.map((b) => ({
          scope: b.scope.kind,
          ...opt('id', b.scope.id),
          state: b.state,
          ...opt('limitUsd', b.limit.usd),
          ...opt('limitMs', b.limit.timeMs),
          spentUsd: b.reportedUsd + b.estimatedUsd,
          durationMs: b.durationMs,
          unknownCalls: b.unknownCalls,
          remainingUsd: b.remainingUsd,
          remainingMs: b.remainingMs,
          ...opt('reason', clip(b.reason)),
        })),
      }
    : undefined;

  const graphIds = new Set(status.graphs.map((g) => g.id));
  const repairs = h.workflows
    .list()
    .filter((j) => j.kind === 'graph' && graphIds.has(j.id) && j.status !== 'completed')
    .map((j) => ({ graphId: j.id, status: j.status, used: j.repairs ?? 0, budget: repairBudget }));

  const controller = status.controller
    ? {
        owner: status.controller.owner,
        until: new Date(status.controller.leaseUntil).toISOString(),
        live: status.controller.leaseUntil > now,
      }
    : undefined;

  return handoffPackSchema.parse({
    handoffVersion: HANDOFF_VERSION,
    at: new Date(now).toISOString(),
    ...opt('graphId', graphId),
    limits: { maxAttempts, repairBudget },
    summary: {
      works: read.works.length,
      open: open.length,
      done: counts.get('done') ?? 0,
      cancelled: counts.get('cancelled') ?? 0,
      byStatus: [...counts].map(([s, c]) => ({ status: s, count: c })),
    },
    queue,
    ...opt('controller', controller),
    active,
    unfinished,
    works,
    stops,
    failures,
    ...opt('budgets', budgets),
    repairs,
    next: boardNext(diagnoses, active.length, works, read.works.length, Boolean(controller?.live)),
    intentions: intentions.map((s) => clipText(s, HANDOFF_LIMITS.intentionChars)!),
    truncated: {
      works: open.length - works.length,
      stops: diagnoses.length - stops.length,
      failures: failed.length - failures.length,
      unfinished: unfinishedAll.length - unfinished.length,
    },
  });
}

/**
 * Следующий шаг доски: первое решение человека или ведущего (`explain`);
 * иначе идущая попытка — ждать controller; иначе первый открытый шаг
 * поручения; иначе ничего.
 */
function boardNext(
  diagnoses: StopDiagnosis[],
  active: number,
  works: HandoffPack['works'],
  total: number,
  controllerLive: boolean,
): HandoffPack['next'] {
  const decision = diagnoses.find(isDecision);
  if (decision)
    return {
      actor: decision.actor,
      action: decision.action,
      code: decision.code,
      ...opt('workId', decision.workId),
      detail: clip(decision.message)!,
    };
  if (active)
    return {
      actor: 'controller',
      action: 'wait',
      step: 'attempt-running',
      detail: 'Идёт попытка; controller продолжит очередь',
    };
  const first = works.find((w) => w.next.action !== 'none');
  if (first)
    return {
      ...first.next,
      workId: first.id,
      ...(first.next.step === 'awaiting-claim' && !controllerLive
        ? { detail: 'Очередь ждёт controller: работу продолжит harness run' }
        : {}),
    };
  return {
    actor: null,
    action: 'none',
    detail: total ? 'Вся работа завершена' : 'Работы нет',
  };
}
