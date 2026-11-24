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
}

export interface CostBreakdown {
  total: CostAmount;
  /** Вызовы текущего выпуска (после последнего `release done`). */
  release: CostAmount & { since?: string };
  byRole: ({ role: CostRole } & CostAmount)[];
  byModel: ({ runtime: string; vendor: string; model: string } & CostAmount)[];
  byWork: ({
    workId: string;
    attempts: ({ runId: string; attempt?: number } & CostAmount)[];
  } & CostAmount)[];
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

const empty = (): CostAmount => ({ usd: 0, bound: 'exact', calls: 0 });
const add = (a: CostAmount, r: Pick<CallRecord, 'costUsd'>) => {
  a.calls += 1;
  if (r.costUsd === null) a.bound = 'lower';
  else a.usd += r.costUsd;
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
      if (r.runId)
        add(w.attempts.get(r.runId) ?? w.attempts.set(r.runId, empty()).get(r.runId)!, r);
    }
  }
  const byUsd = (a: CostAmount, b: CostAmount) => b.usd - a.usd || b.calls - a.calls;
  return {
    total: round(total),
    release: {
      ...round(release),
      ...(options.releaseSince ? { since: options.releaseSince } : {}),
    },
    byRole: [...roles].map(([role, a]) => round({ role, ...a })).sort(byUsd),
    byModel: [...models.values()]
      .map((m) => round({ ...m, vendor: vendorOf(m.runtime) }))
      .sort(byUsd)
      .slice(0, options.limits?.models ?? 50),
    byWork: [...works]
      .map(([workId, w]) =>
        round({
          workId,
          usd: w.usd,
          bound: w.bound,
          calls: w.calls,
          attempts: [...w.attempts]
            .map(([runId, a]) =>
              round({
                runId,
                ...((n) => (n !== undefined ? { attempt: n } : {}))(options.attemptOf?.(runId)),
                ...a,
              }),
            )
            .slice(0, options.limits?.attempts ?? 20),
        }),
      )
      .sort(byUsd)
      .slice(0, options.limits?.works ?? 200),
  };
}
