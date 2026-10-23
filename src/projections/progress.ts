import type { WorkStatus } from './enums.ts';
import { notImplemented } from './stub.ts';

export const progressReasons = [
  'plan-review-required',
  'attempts-exhausted',
  'failure-requires-diagnosis',
  'dependencies-incomplete',
  'queue-paused',
  'workers-busy',
] as const;
export type ProgressReason = (typeof progressReasons)[number];
export interface ProgressInput {
  work: { status: WorkStatus; attempt: number; dependsOn: readonly string[] };
  statusOf: (id: string) => WorkStatus | undefined;
  maxAttempts: number;
  paused: boolean;
  activeRuns: number;
  concurrency: number;
  hostReasons?: readonly string[];
}
export interface ProgressView {
  dependencies: string[];
  reasons: ProgressReason[];
  eligible: boolean;
}

/** Почему работа сейчас не выдаётся (OP-DIAG-02). */
export function workProgress(input: ProgressInput): ProgressView {
  void input;
  return notImplemented('workProgress');
}
