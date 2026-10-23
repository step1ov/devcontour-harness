/* eslint-disable @typescript-eslint/require-await -- заглушка L0; снимается рабочим пакетом */
import type { ExecutionPolicy, RuntimeName } from '../contracts/index.ts';
import type { RuntimeAdapter } from '../contracts/ports.ts';
import type { StopDiagnosis } from '../projections/stop.ts';
import { notImplemented } from '../projections/stub.ts';

export interface DiagnoseOptions {
  stateDir: string;
  policy: ExecutionPolicy;
  baseDir: string;
  workId?: string;
  adapters?: Partial<Record<RuntimeName, RuntimeAdapter>>;
}
/** `harness explain`: диагнозы runtime, controller и поручений; только чтение. */
export async function diagnoseState(
  options: DiagnoseOptions,
): Promise<{ diagnoses: StopDiagnosis[] }> {
  void options;
  return notImplemented('diagnoseState');
}
export function explainText(data: { diagnoses: StopDiagnosis[] }): string {
  void data;
  return notImplemented('explainText');
}
