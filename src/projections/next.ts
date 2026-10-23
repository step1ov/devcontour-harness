import type { PropertyRecovery } from '../contracts/execution.ts';
import type { Actor, NextAction, WorkStatus } from './enums.ts';
import { notImplemented } from './stub.ts';

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

/** Следующий шаг по работе и кто его делает (OP-DIAG-03). */
export function nextAction(input: NextInput): NextView {
  void input;
  return notImplemented('nextAction');
}
