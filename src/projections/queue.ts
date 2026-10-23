import type { PauseReason } from './enums.ts';
import { notImplemented } from './stub.ts';

export interface QueueStopInput {
  paused: boolean;
  pauseReason?: PauseReason;
  errors: readonly { seq: number; message?: string }[];
}
export interface QueueStopView {
  paused: boolean;
  reason?: PauseReason;
  detail?: string;
}

/** Причина остановки очереди (OP-DIAG-04). */
export function queueStop(input: QueueStopInput): QueueStopView {
  void input;
  return notImplemented('queueStop');
}
