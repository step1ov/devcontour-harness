import type { ContextSnapshot, ContractDocument, ExecutionPolicy } from '../contracts/index.ts';
import type { PlanningFacts } from '../contracts/planning.ts';
import { notImplemented } from './stub.ts';

/** Факты планирования из политики самостоятельного проекта. */
export function planningFactsOf(
  policy: ExecutionPolicy,
  options: { baseDir: string; context?: ContextSnapshot; contracts?: readonly ContractDocument[] },
): PlanningFacts {
  void policy;
  void options;
  return notImplemented('planningFactsOf');
}
