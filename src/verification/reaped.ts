import { TaskFailure } from '../contracts/index.ts';
import { ReapFailure } from '../environment/process.ts';

/**
 * Отказ gate, чьи потомки не остановлены или не пересчитаны: дерево, где он
 * исполнялся, больше не используется — ни повтора gate на нём, ни следующих
 * проверок. Класс — `environment`/`process-reap` или `gate`, если команда
 * сама назвала провал.
 */
export class ReapedGate extends TaskFailure {
  override name = 'ReapedGate';
  /** Тот же отказ с дописанной причиной; признак неостановленных потомков сохраняется. */
  extend(suffix: string) {
    return new ReapedGate(
      this.kind,
      `${this.message}; ${suffix}`,
      this.properties,
      this.diagnosis,
      this.contextLimit,
    );
  }
}
/** Отказ, после которого в дереве проверки, возможно, ещё работают её потомки. */
export const reapedFailure = (error: unknown) =>
  error instanceof ReapedGate || error instanceof ReapFailure;
