import type { z } from 'zod';
import {
  STATE_VERSION,
  type statusDataSchema,
  type AttemptState,
  type ExecutionPolicy,
  type ExecutionView,
  type WorkState,
  type WorkflowJob,
} from '../contracts/index.ts';
import { attemptSummaryLine, attemptSummaryOf, type AttemptBudget } from '../report/compute.ts';
import { budgetOverview } from '../engine/budget.ts';
import type { Engine } from '../engine/engine.ts';
import { requestsOf } from '../engine/input-requests.ts';
import { nextRunControl } from '../explain/state.ts';
import {
  CLIP_DIAGNOSTIC,
  attemptView,
  clipText,
  queuePause,
  queueStop,
  workInputOf,
} from '../projections/index.ts';

/**
 * Что читает `statusOf`: движок над хранилищем и политика исполнения.
 * `Harness` удовлетворяет ему структурно; хост со своим `Engine` передаёт
 * `{ engine, policy }`.
 */
export interface StatusSource {
  readonly engine: Engine;
  readonly policy: ExecutionPolicy;
  /**
   * Задания графов (`Harness.workflows`): с ними сводка попыток называет
   * остаток восстановлений группы. Нет — сводка без `repairs`.
   */
  readonly workflows?: { list(): readonly WorkflowJob[] };
}

/**
 * Действующие задания графов по id: незавершённые и не устаревшие (бюджет
 * восстановлений устаревшего задания больше не расходуется).
 */
export function liveGraphJobs(workflows: StatusSource['workflows']): Map<string, WorkflowJob> {
  const jobs = new Map<string, WorkflowJob>();
  for (const j of workflows?.list() ?? [])
    if (j.kind === 'graph' && j.status !== 'completed' && j.status !== 'stale') jobs.set(j.id, j);
  return jobs;
}

/**
 * Сводка попыток поручения для `status` и `explain`: числа — `attemptSummaryOf`
 * (правила отчёта), остаток попыток — по засчитанным `work.attempt` и
 * `maxAttempts`, восстановлений — по заданию графа и `repairBudget`; `line` —
 * `attemptSummaryLine`.
 */
export function attemptSummaryView(
  work: WorkState,
  attempts: readonly AttemptState[],
  policy: Pick<ExecutionPolicy, 'maxAttempts' | 'repairBudget'>,
  job?: Pick<WorkflowJob, 'repairs'>,
) {
  const summary = attemptSummaryOf(work, attempts);
  const budget: AttemptBudget = {
    attempts: { used: work.attempt, max: policy.maxAttempts },
    ...(job ? { repairs: { used: job.repairs ?? 0, budget: policy.repairBudget } } : {}),
  };
  const left = (used: number, max: number) => Math.max(0, max - used);
  return {
    ...summary,
    attempts: { ...budget.attempts, left: left(work.attempt, policy.maxAttempts) },
    ...(budget.repairs
      ? { repairs: { ...budget.repairs, left: left(budget.repairs.used, budget.repairs.budget) } }
      : {}),
    line: attemptSummaryLine(summary, budget),
  };
}

/**
 * Состояние очереди, графов и поручений (`Harness.status`, `harness status`)
 * над движком и политикой источника. С `detail` — ещё снимок наблюдателя:
 * почему стоит выдача (`queueStop` и `queuePause`) и активные попытки
 * (`attemptView`); без него ответ прежний. Только чтение, один `read`.
 */
export function statusOf(
  source: StatusSource,
  graphId?: string,
  options: { detail?: boolean } = {},
) {
  const { engine } = source;
  // Задания — внутри того же чтения: один снимок хранилища.
  let jobs: Map<string, WorkflowJob> | undefined;
  const jobOf = (graphId: string) => (jobs ??= liveGraphJobs(source.workflows)).get(graphId);
  return engine.read((v) => ({
    stateVersion: STATE_VERSION,
    control: v.control(),
    ...(v.controller() ? { controller: v.controller() } : {}),
    graphs: v
      .graphs()
      .filter((g) => !graphId || g.id === graphId)
      .map((g) => ({
        id: g.id,
        digest: g.digest,
        source: g.graph.source,
        approved: g.approval?.digest === g.digest,
      })),
    works: v.works(graphId).map((w) => ({
      id: w.id,
      graphId: w.graphId,
      status: w.status,
      attempt: w.attempt,
      ...(w.activeRunId ? { activeRunId: w.activeRunId } : {}),
      ...((a) =>
        a?.status === 'active' && a.liveness && a.liveness.state !== 'active'
          ? { liveness: a.liveness.state }
          : {})(w.activeRunId ? v.attempt(w.activeRunId) : undefined),
      ...(w.resultSha ? { resultSha: w.resultSha } : {}),
      // Вопрос исполнителя: ID, состояние, версия и серьёзность, без текста;
      // неблокирующие запросы ведущему — числом.
      // У итоговой работы вопрос — история: статус его не показывает.
      ...((view) => ({
        ...(view.input && w.status !== 'done' && w.status !== 'cancelled'
          ? { input: view.input }
          : {}),
        ...(view.followUps ? { followUps: view.followUps } : {}),
      }))(workInputOf(requestsOf(v, w))),
      blockers: engine.blockers(w, v),
      attemptSummary: attemptSummaryView(w, v.attempts(w.id), source.policy, jobOf(w.graphId)),
    })),
    ...((budgets) => (budgets ? { budgets } : {}))(budgetOverview(engine.budgetContext(), v)),
    ...(options.detail ? { detail: statusDetail(source, v, graphId) } : {}),
  }));
}

function statusDetail(source: StatusSource, v: ExecutionView, graphId?: string) {
  const { engine, policy } = source;
  const now = engine.clock();
  const control = v.control();
  const works = v.works(graphId);
  const attempts = v.works().flatMap((w) => v.attempts(w.id));
  // Последний отказ классов паузы runtime — её подробность (как `queueStop`
  // хоста по ошибкам планировщика): порядок — по времени завершения.
  const failures = new Set(control.pauseFailures ?? []);
  const errors = attempts
    .filter((a) => a.status === 'failed' && a.failureKind && failures.has(a.failureKind))
    .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''))
    .map((a, i) => ({ seq: i + 1, ...(a.error ? { message: a.error } : {}) }));
  const stop = queueStop({
    paused: control.paused,
    ...(control.pauseReason ? { pauseReason: control.pauseReason } : {}),
    errors,
  });
  const repositoryGates = (id: string) =>
    policy.repositories.find((r) => r.id === id)?.gates.map((g) => g.id);
  // Пауза, которую снимет следующий run, глазами explain: выдача не стоит,
  // поручения ждут controller.
  const queue = nextRunControl(source, v).lifted
    ? {
        paused: true,
        ...(control.pauseReason ? { reason: control.pauseReason } : {}),
        detail: 'Паузу снимет следующий harness run',
        ...(control.pausedAt ? { since: control.pausedAt } : {}),
        ...(control.pauseOperation ? { operation: control.pauseOperation } : {}),
        liftedByRun: true as const,
        code: 'NOT_READY' as const,
        cause: 'not-ready' as const,
        actor: 'controller' as const,
        action: 'wait' as const,
      }
    : {
        ...stop,
        ...(stop.detail ? { detail: clipText(stop.detail, CLIP_DIAGNOSTIC)! } : {}),
        ...(control.paused && control.pausedAt ? { since: control.pausedAt } : {}),
        ...(control.paused && control.pauseOperation ? { operation: control.pauseOperation } : {}),
        ...(control.paused && control.pauseFailures?.length
          ? { failures: [...control.pauseFailures] }
          : {}),
        ...(queuePause(control) ?? {}),
      };
  return {
    at: new Date(now).toISOString(),
    queue,
    attempts: works
      .map((w) => (w.activeRunId ? v.attempt(w.activeRunId) : undefined))
      .filter((a) => a?.status === 'active')
      .map((a) => {
        const gates = repositoryGates(a!.repositoryId);
        return attemptView(a!, {
          now,
          leaseMs: policy.leaseMs,
          ...(gates ? { repositoryGates: gates } : {}),
        });
      }),
  };
}

/**
 * Текст `status --human`: состояние выдачи и строка на поручение — статус и
 * сводка попыток (`attemptSummaryLine`); блокировки — кодами с отступом.
 */
export function statusText(data: z.output<typeof statusDataSchema>): string {
  const c = data.control;
  const out = [
    c.paused ? `Выдача на паузе${c.pauseReason ? ` (${c.pauseReason})` : ''}.` : 'Выдача идёт.',
  ];
  if (!data.works.length) out.push('Поручений нет.');
  for (const w of data.works) {
    out.push(`${w.id} [${w.status}]${w.attemptSummary ? ': ' + w.attemptSummary.line : ''}`);
    if (w.blockers.length) out.push(`  блокировки: ${w.blockers.map((b) => b.code).join(', ')}`);
  }
  return out.join('\n') + '\n';
}
