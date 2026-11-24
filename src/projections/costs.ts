// Расход по работам, попыткам, ролям и моделям (0.1.0-alpha.70,
// представление ревизии 10, `costs`). Чистая функция над записями учёта
// вызовов: где цена неизвестна, сумма — нижняя граница (`bound: lower`).
// Выпуск — вызовы после последнего `release done` (нет его — все).

import type { CallRecord } from '../contracts/execution.ts';

export type CostRole = 'writer' | 'reviewer' | 'planner' | 'lead' | 'other';

export interface CostAmount {
  usd: number;
  /** `exact` — цена известна у каждого вызова; `lower` — есть вызовы без цены. */
  bound: 'exact' | 'lower';
  calls: number;
  /** Вызовов без цены (`bound: lower`, когда больше нуля). */
  unpricedCalls: number;
}

export type AttemptCost = { runId: string; attempt?: number } & CostAmount;
export type WorkCost = {
  workId: string;
  attempts: AttemptCost[];
  /** Попыток сверх предела списка `attempts`. */
  attemptsTruncated: number;
} & CostAmount;

export interface CostBreakdown {
  total: CostAmount;
  /**
   * Вызовы текущего выпуска: после последнего `release done` (`since`,
   * `sinceRelease: true`); выпуска ещё не было — все вызовы
   * (`sinceRelease: false`, `since` нет).
   */
  release: CostAmount & { since?: string; sinceRelease: boolean };
  byRole: ({ role: CostRole } & CostAmount)[];
  byModel: ({ runtime: string; vendor: string; model: string } & CostAmount)[];
  /** Моделей сверх предела `byModel`. */
  byModelTruncated: number;
  byWork: WorkCost[];
  /** Работ сверх предела `byWork`. */
  byWorkTruncated: number;
}

/** Роль вызова по стадии учёта. */
export function costRoleOf(stage: string): CostRole {
  if (stage === 'implementation') return 'writer';
  if (/review/.test(stage) && !/^(plan|contract)-review|^review-(plan|contract)/.test(stage))
    return 'reviewer';
  if (/plan|contract/.test(stage)) return 'planner';
  if (/diagnos|lead/.test(stage)) return 'lead';
  return 'other';
}

const vendorOf = (runtime: string) =>
  runtime === 'claude' ? 'anthropic' : runtime === 'codex' ? 'openai' : runtime;

const empty = (): CostAmount => ({ usd: 0, bound: 'exact', calls: 0, unpricedCalls: 0 });
const add = (a: CostAmount, r: Pick<CallRecord, 'costUsd'>) => {
  a.calls += 1;
  if (r.costUsd === null) {
    a.bound = 'lower';
    a.unpricedCalls += 1;
  } else a.usd += r.costUsd;
};
const round = <T extends CostAmount>(a: T): T => ({ ...a, usd: Math.round(a.usd * 1e6) / 1e6 });

export function costBreakdown(
  records: readonly CallRecord[],
  options: {
    attemptOf?: (runId: string) => number | undefined;
    releaseSince?: string;
    limits?: { works?: number; models?: number; attempts?: number };
  } = {},
): CostBreakdown {
  const total = empty();
  const release = empty();
  const roles = new Map<CostRole, CostAmount>();
  const models = new Map<string, { runtime: string; model: string } & CostAmount>();
  const works = new Map<string, CostAmount & { attempts: Map<string, CostAmount> }>();
  // Начало попытки — по её самому раннему вызову (порядок попыток).
  const firstAt = new Map<string, string>();
  for (const r of records) {
    add(total, r);
    if (!options.releaseSince || r.startedAt > options.releaseSince) add(release, r);
    const role = costRoleOf(r.stage);
    add(roles.get(role) ?? roles.set(role, empty()).get(role)!, r);
    const model = r.model ?? r.price?.model ?? 'unknown';
    const key = `${r.runtime}\u0000${model}`;
    add(models.get(key) ?? models.set(key, { runtime: r.runtime, model, ...empty() }).get(key)!, r);
    const workId = r.workId ?? (r.subjectKind === 'work' ? r.subjectId : undefined);
    if (workId) {
      const w =
        works.get(workId) ?? works.set(workId, { ...empty(), attempts: new Map() }).get(workId)!;
      add(w, r);
      if (r.runId) {
        add(w.attempts.get(r.runId) ?? w.attempts.set(r.runId, empty()).get(r.runId)!, r);
        const at = firstAt.get(r.runId);
        if (!at || r.startedAt < at) firstAt.set(r.runId, r.startedAt);
      }
    }
  }
  const byUsd = (a: CostAmount, b: CostAmount) => b.usd - a.usd || b.calls - a.calls;
  const modelLimit = options.limits?.models ?? 50;
  const workLimit = options.limits?.works ?? 200;
  const attemptLimit = options.limits?.attempts ?? 20;
  const models_ = [...models.values()]
    .map((m) => round({ ...m, vendor: vendorOf(m.runtime) }))
    .sort(byUsd);
  const works_ = [...works]
    .map(([workId, w]) => workCostOf(workId, w, options.attemptOf, attemptLimit, firstAt))
    .sort(byUsd);
  return {
    total: round(total),
    release: {
      ...round(release),
      sinceRelease: !!options.releaseSince,
      ...(options.releaseSince ? { since: options.releaseSince } : {}),
    },
    byRole: [...roles].map(([role, a]) => round({ role, ...a })).sort(byUsd),
    byModel: models_.slice(0, modelLimit),
    byModelTruncated: Math.max(0, models_.length - modelLimit),
    byWork: works_.slice(0, workLimit),
    byWorkTruncated: Math.max(0, works_.length - workLimit),
  };
}

function workCostOf(
  workId: string,
  w: CostAmount & { attempts: Map<string, CostAmount> },
  attemptOf: ((runId: string) => number | undefined) | undefined,
  limit: number,
  firstAt: ReadonlyMap<string, string>,
): WorkCost {
  // По времени (номер попытки, затем начало, затем ID): «последние» — последние
  // по времени, а не по порядку записей учёта (ревью alpha.70).
  const order = (runId: string) =>
    [attemptOf?.(runId) ?? Number.MAX_SAFE_INTEGER, firstAt.get(runId) ?? '', runId] as const;
  const sorted = [...w.attempts].sort(([a], [b]) => {
    const x = order(a);
    const y = order(b);
    return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2].localeCompare(y[2]);
  });
  const attempts = sorted.map(([runId, a]) =>
    round({
      runId,
      ...((n) => (n !== undefined ? { attempt: n } : {}))(attemptOf?.(runId)),
      ...a,
    }),
  );
  return round({
    workId,
    usd: w.usd,
    bound: w.bound,
    calls: w.calls,
    unpricedCalls: w.unpricedCalls,
    // Последние попытки — самые нужные: сверх предела отброшены ранние.
    attempts: attempts.slice(Math.max(0, attempts.length - limit)),
    attemptsTruncated: Math.max(0, attempts.length - limit),
  });
}
