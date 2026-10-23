import type { PauseReason } from './enums.ts';

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

/**
 * Причина остановки очереди (OP-DIAG-04). Пауза без причины — прежние записи
 * паузы рантайма, она означает runtime. Пауза оператора и прочие причины не
 * называют сбой. Для runtime берётся ошибка с наибольшим `seq`; если у неё нет
 * сообщения, `detail` нет: более старая ошибка за причину не выдаётся.
 */
export function queueStop(input: QueueStopInput): QueueStopView {
  if (!input.paused) return { paused: false };
  const reason: PauseReason = input.pauseReason ?? 'runtime';
  if (reason !== 'runtime') return { paused: true, reason };
  const latest = input.errors.reduce<QueueStopInput['errors'][number] | undefined>(
    (a, e) => (!a || e.seq > a.seq ? e : a),
    undefined,
  );
  const message = latest?.message;
  return message
    ? { paused: true, reason, detail: message.replace(/^(Error|TaskFailure):\s*/, '') }
    : { paused: true, reason };
}
