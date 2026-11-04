import { STATE_VERSION, type ExecutionPolicy, type ExecutionView } from '../contracts/index.ts';
import { budgetOverview } from '../engine/budget.ts';
import type { Engine } from '../engine/engine.ts';
import { nextRunControl } from '../explain/state.ts';
import {
  CLIP_DIAGNOSTIC,
  attemptView,
  clipText,
  queuePause,
  queueStop,
} from '../projections/index.ts';

/**
 * Что читает `statusOf`: движок над хранилищем и политика исполнения.
 * `Harness` удовлетворяет ему структурно; хост со своим `Engine` передаёт
 * `{ engine, policy }`.
 */
export interface StatusSource {
  readonly engine: Engine;
  readonly policy: ExecutionPolicy;
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
      blockers: engine.blockers(w, v),
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
