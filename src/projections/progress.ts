import type { WorkStatus } from './enums.ts';

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

/**
 * Почему работа сейчас не выдаётся (OP-DIAG-02): общие ветви. Продуктовые
 * причины хоста приходят в `hostReasons` и влияют только на `eligible`;
 * их место в итоговом перечне определяет хост.
 */
export function workProgress(input: ProgressInput): ProgressView {
  const { work, statusOf, maxAttempts } = input;
  const dependencies = work.dependsOn.filter((id) => statusOf(id) !== 'done');
  const reasons: ProgressReason[] = [];
  if (work.status === 'draft') reasons.push('plan-review-required');
  if (work.status === 'failed')
    reasons.push(work.attempt >= maxAttempts ? 'attempts-exhausted' : 'failure-requires-diagnosis');
  if (work.status === 'ready') {
    if (dependencies.length) reasons.push('dependencies-incomplete');
    if (work.attempt >= maxAttempts) reasons.push('attempts-exhausted');
    if (input.paused) reasons.push('queue-paused');
    if (input.activeRuns >= input.concurrency) reasons.push('workers-busy');
  }
  return {
    dependencies,
    reasons,
    eligible: work.status === 'ready' && !reasons.length && !(input.hostReasons ?? []).length,
  };
}
