import type { Harness } from '../control/harness.ts';
import type { StopInput } from '../projections/stop.ts';
import { notImplemented } from '../projections/stub.ts';

export interface StopInputOptions {
  maxAttempts: number;
  repairBudget: number;
  workId?: string;
}
/** Входы explainStop из сохранённого состояния; ничего не пишет. */
export function stopInputsOf(h: Harness, options: StopInputOptions): StopInput[] {
  void h;
  void options;
  return notImplemented('stopInputsOf');
}
