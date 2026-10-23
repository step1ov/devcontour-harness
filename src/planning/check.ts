import type { z } from 'zod';
import type { ContextSnapshot, ContractDocument, ExecutionPolicy } from '../contracts/index.ts';
import type { planCheckDataSchema, planRequestDataSchema } from '../contracts/planning.ts';
import { notImplemented } from './stub.ts';

export type PlanRequestData = z.infer<typeof planRequestDataSchema>;
export type PlanCheckData = z.infer<typeof planCheckDataSchema>;
export interface PlanInputs {
  policy: ExecutionPolicy;
  baseDir: string;
  context?: ContextSnapshot;
  contracts?: ContractDocument[];
}

/** `harness plan-request`: prompt, basis и факты; ничего не пишет. */
export function planRequestOf(
  input: PlanInputs & {
    brief: string;
    requirementSources?: { repositoryId: string; source: string }[];
  },
): PlanRequestData {
  void input;
  return notImplemented('planRequestOf');
}
/** `harness plan-check`: issues и план подготовки проверок либо граф. */
export function planCheck(
  input: PlanInputs & { draft: unknown; graphId: string; brief?: string; basis?: string },
): PlanCheckData {
  void input;
  return notImplemented('planCheck');
}
