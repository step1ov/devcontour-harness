import type { PropertyRecovery } from '../contracts/execution.ts';
import { activeStatuses, type Actor, type NextAction, type WorkStatus } from './enums.ts';

export const nextSteps = [
  'accepted',
  'cancelled',
  'recovery-awaiting-lead',
  'recovery-analyzing',
  'recovery-applying',
  'recovery-retry-allowed',
  'recovery-retrying',
  'recovery-awaiting-user',
  'recovery-stopped',
  'corpus-adoption',
  'held',
  'plan-review',
  'attempt-running',
  'retry-within-budget',
  'attempts-exhausted',
  'awaiting-claim',
] as const;
export type NextStep = (typeof nextSteps)[number];
export interface NextInput {
  status: WorkStatus;
  attempt: number;
  maxAttempts: number;
  hold?: { operation: string };
  recovery?: Pick<PropertyRecovery, 'status' | 'property' | 'reason' | 'decision'>;
  waitingAdoption?: boolean;
}
export interface NextView {
  actor: Actor;
  action: NextAction;
  step: NextStep;
  property?: string;
  detail?: string;
}

const view = (
  actor: Actor,
  action: NextAction,
  step: NextStep,
  extra: { property?: string; detail?: string | undefined } = {},
): NextView => ({
  actor,
  action,
  step,
  ...(extra.property !== undefined ? { property: extra.property } : {}),
  ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
});

/**
 * Следующий шаг по работе и кто его делает (OP-DIAG-03). Порядок веток —
 * прежний: итог, эпизод восстановления, смена корпуса, удержание, план,
 * идущая попытка, сбой, ожидание выдачи. Закрытый эпизод (`closed`) идёт
 * дальше по веткам.
 */
export function nextAction(input: NextInput): NextView {
  const r = input.recovery;
  if (input.status === 'done') return view(null, 'none', 'accepted');
  if (input.status === 'cancelled') return view(null, 'none', 'cancelled');
  if (r)
    switch (r.status) {
      case 'awaiting-lead':
        return view('lead', 'recovery-decision', 'recovery-awaiting-lead', {
          property: r.property,
        });
      case 'analyzing':
        return view('lead', 'wait', 'recovery-analyzing', { property: r.property });
      case 'applying':
        return view('controller', 'wait', 'recovery-applying');
      case 'retry':
        return view('controller', 'wait', 'recovery-retry-allowed');
      case 'retrying':
        return view('controller', 'wait', 'recovery-retrying');
      case 'awaiting-user':
        return view('user', 'user-decision', 'recovery-awaiting-user', { detail: r.reason });
      case 'stopped':
        return view(r.decision?.proposal ? 'lead' : 'user', 'user-decision', 'recovery-stopped', {
          detail: r.reason,
        });
      case 'closed':
        break;
    }
  if (input.waitingAdoption) return view('controller', 'wait', 'corpus-adoption');
  if (input.hold) return view('controller', 'wait', 'held', { detail: input.hold.operation });
  if (input.status === 'draft') return view('lead', 'review-plan', 'plan-review');
  if ((activeStatuses as readonly WorkStatus[]).includes(input.status))
    return view('controller', 'wait', 'attempt-running');
  if (input.status === 'failed')
    return input.maxAttempts - input.attempt > 0
      ? view('controller', 'retry', 'retry-within-budget')
      : view('user', 'reset-attempts', 'attempts-exhausted');
  return view('controller', 'wait', 'awaiting-claim');
}
