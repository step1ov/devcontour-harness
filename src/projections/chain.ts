import {
  activeStatuses,
  type Actor,
  type FailureKind,
  type NextAction,
  type WorkStatus,
} from './enums.ts';

export interface ChainWork {
  id: string;
  status: WorkStatus;
  dependsOn: readonly string[];
  attempt: number;
  activeRunId?: string;
  hold?: { operation: string; reason: string };
  budgetBlock?: { reason: string };
  failureKind?: FailureKind;
}
export const chainRootCodes = [
  'failed',
  'failed-exhausted',
  'draft',
  'cancelled',
  'held',
  'budget-blocked',
  'attempts-exhausted',
] as const;
export type ChainRootCode = (typeof chainRootCodes)[number];
export interface ChainRoot {
  workId: string;
  code: ChainRootCode;
  waiting: number;
  actor: Actor;
  action: NextAction;
  detail?: string;
  failureKind?: FailureKind;
}

/**
 * Корневые причины, из-за которых ждут готовые работы (OP-DIAG-01).
 * Корень — незавершённая предшественница, которая сама не выполняется:
 * упала, не утверждена, удержана, отменена или упёрлась в бюджет. Каждый
 * ждущий считается у корня один раз, даже если доходит до него по ромбу.
 * Порядок результата — порядок первого обнаружения корня.
 */
export function chainRoots(works: ChainWork[], maxAttempts = 3): ChainRoot[] {
  const byId = new Map(works.map((w) => [w.id, w]));
  const active: readonly WorkStatus[] = activeStatuses;
  const open = (w: ChainWork) => w.dependsOn.filter((d) => byId.get(d)?.status !== 'done');
  const waiting = works.filter((w) => w.status === 'ready' && open(w).length > 0);
  const roots = new Map<string, Set<string>>();
  for (const w of waiting) {
    const seen = new Set<string>();
    const walk = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const t = byId.get(id);
      if (!t || t.status === 'done') return;
      const deps = open(t);
      if (deps.length && t.status === 'ready') return deps.forEach(walk);
      if (active.includes(t.status) || t.activeRunId) return;
      if (t.status === 'ready' && !t.hold && !t.budgetBlock && t.attempt < maxAttempts) return;
      roots.set(id, (roots.get(id) ?? new Set()).add(w.id));
    };
    w.dependsOn.forEach(walk);
  }
  return [...roots].map(([id, dependents]) => {
    const t = byId.get(id)!;
    const exhausted = t.attempt >= maxAttempts;
    const root = (
      code: ChainRootCode,
      actor: Actor,
      action: NextAction,
      detail?: string,
    ): ChainRoot => ({
      workId: id,
      code,
      waiting: dependents.size,
      actor,
      action,
      ...(detail !== undefined ? { detail } : {}),
      ...((code === 'failed' || code === 'failed-exhausted') && t.failureKind
        ? { failureKind: t.failureKind }
        : {}),
    });
    if (t.status === 'failed')
      return exhausted
        ? root('failed-exhausted', 'user', 'reset-attempts')
        : root('failed', 'controller', 'retry');
    if (t.status === 'draft') return root('draft', 'lead', 'review-plan');
    if (t.status === 'cancelled') return root('cancelled', 'lead', 'replan-dependents');
    if (t.hold) return root('held', 'controller', 'wait', t.hold.reason);
    if (t.budgetBlock && !exhausted)
      return root('budget-blocked', 'user', 'raise-budget', t.budgetBlock.reason);
    return root('attempts-exhausted', 'user', 'reset-attempts');
  });
}
