import type { Actor, FailureKind, NextAction, WorkStatus } from './enums.ts';
import { notImplemented } from './stub.ts';

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

/** Корневые причины, из-за которых ждут готовые работы (OP-DIAG-01). */
export function chainRoots(works: ChainWork[], maxAttempts = 3): ChainRoot[] {
  void works;
  void maxAttempts;
  return notImplemented('chainRoots');
}
