import type { ErrorCode } from '../contracts/errors.ts';
import type { Actor, FailureKind, NextAction, PauseReason, WorkStatus } from './enums.ts';
import { notImplemented } from './stub.ts';

/**
 * Код остановки по классу отказа. Это та же таблица, которой RunResult
 * называет stopReason: сетевой класс приходит из сохранённого failureKind
 * (его ставит classifyFailure в точке отказа), текст здесь не разбирается.
 */
export function stopCodeOf(kind: FailureKind | undefined): ErrorCode {
  switch (kind) {
    case 'gate':
    case 'empty-result':
      return 'GATE_FAILED';
    case 'review':
      return 'REVIEW_REJECTED';
    case 'review-protocol':
      return 'REVIEW_PROTOCOL_INVALID';
    case 'scope-violation':
      return 'SCOPE_VIOLATION';
    case 'budget':
      return 'BUDGET_EXHAUSTED';
    case 'cancelled':
      return 'CANCELLED';
    case 'provider-auth':
    case 'environment':
    case 'timeout':
      return 'RUNTIME_UNAVAILABLE';
    case 'stale-base':
    case 'merge':
      return 'GIT_FAILED';
    default:
      return 'INTERNAL';
  }
}

export const stopCauses = [
  'provider-auth',
  'environment',
  'timeout',
  'stale-base',
  'empty-result',
  'scope-violation',
  'gate',
  'review',
  'review-protocol',
  'merge',
  'cancelled',
  'budget',
  'unknown',
  'runtime-missing',
  'controller-busy',
  'operator-pause',
  'approval-required',
  'not-ready',
] as const;
export type StopCause = (typeof stopCauses)[number];
export const stopPhases = [
  'preflight',
  'claim',
  'implementation',
  'gates',
  'review',
  'integration',
  'delivery',
] as const;
export type StopPhase = (typeof stopPhases)[number];
export interface EvidenceLink {
  kind: 'attempt' | 'evidence' | 'event' | 'doctor';
  id: string;
  sha?: string;
}
export type StopInput =
  | {
      kind: 'work';
      work: {
        id: string;
        status: WorkStatus;
        attempt: number;
        failureKind?: FailureKind;
        failure?: string;
        hold?: { operation: string; reason: string };
        budgetBlock?: { reason: string };
      };
      maxAttempts: number;
      repair: { sameFailureRepairs: number; groupRepairsUsed: number; groupRepairBudget: number };
      control: { paused: boolean; pauseReason?: PauseReason; pauseFailures?: FailureKind[] };
      phase?: StopPhase;
      runId?: string;
      evidence?: EvidenceLink[];
    }
  | { kind: 'error'; error: { code: ErrorCode; message: string } }
  | { kind: 'runtime'; runtime: { runtime: string; available: boolean; reason?: string } };
export interface StopDiagnosis {
  code: ErrorCode;
  cause: StopCause;
  phase: StopPhase;
  actor: Actor;
  action: NextAction;
  retryPlanned: boolean;
  message: string;
  evidence: EvidenceLink[];
  workId?: string;
  runId?: string;
}

/** Объяснение остановки (OP-DIAG-05): только чтение, ничего не планирует. */
export function explainStop(input: StopInput): StopDiagnosis {
  void input;
  return notImplemented('explainStop');
}
