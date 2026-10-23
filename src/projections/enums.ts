// Общие перечни проекций. Модуль без node:* — его импортирует браузер.

export type { FailureKind, PauseReason, WorkStatus } from '../contracts/execution.ts';

/** Кто действует: ведущий агент, человек, штатный исполнитель; null — никто. */
export const actors = ['controller', 'lead', 'user'] as const;
export type Actor = (typeof actors)[number] | null;

export const nextActions = [
  'none',
  'wait',
  'review-plan',
  'retry',
  'diagnose-failure',
  'reset-attempts',
  'raise-budget',
  'replan-dependents',
  'recovery-decision',
  'user-decision',
  'resume-queue',
  'fix-environment',
  'fix-access',
] as const;
export type NextAction = (typeof nextActions)[number];

export const activeStatuses = ['running', 'verifying', 'reviewing', 'integrating'] as const;
