import type { PlanningFacts } from '../contracts/planning.ts';
import { notImplemented } from './stub.ts';

export interface PlanningInput {
  brief: string;
  facts: PlanningFacts;
  hostInstructions?: string[];
  /** По умолчанию 15. */
  recommendedTasks?: number;
}
export interface PlanningRequest {
  prompt: string;
  readOnly: true;
  recommendedTasks: number;
  maxTasks: 30;
  basis: string;
}

/** Read-only запрос планирования (OP-PLAN-01): чистая функция, модель не вызывает. */
export function planningRequest(input: PlanningInput): PlanningRequest {
  void input;
  return notImplemented('planningRequest');
}
/** digest постановки и фактов: draft по другому basis устарел. */
export function planningBasis(brief: string, facts: PlanningFacts): string {
  void brief;
  void facts;
  return notImplemented('planningBasis');
}
