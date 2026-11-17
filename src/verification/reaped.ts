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
  /**
   * Провал `gate` назван только ненулевым кодом выхода: ни упавшего или
   * пропущенного теста, ни свойства, покрытия, отчёта, корпуса, ни правки
   * HEAD или отслеживаемых файлов. Только такой провал интеграции после
   * прошедшего кандидата считается перегрузкой хоста.
   */
  exitOnly = false;
  /** Тот же отказ с дописанной причиной; признак неостановленных потомков сохраняется. */
  extend(suffix: string) {
    return Object.assign(
      new ReapedGate(
        this.kind,
        `${this.message}; ${suffix}`,
        this.properties,
        this.diagnosis,
        this.contextLimit,
      ),
      { exitOnly: this.exitOnly },
    );
  }
}
/** Отказ, после которого в дереве проверки, возможно, ещё работают её потомки. */
export const reapedFailure = (error: unknown) =>
  error instanceof ReapedGate || error instanceof ReapFailure;
