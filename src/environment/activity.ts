import { AsyncLocalStorage } from 'node:async_hooks';
import type { Activity } from '../contracts/index.ts';

/** Исполняющаяся команда владельца: процесс, что это и хвост её вывода. */
export interface TrackedCommand {
  readonly pid: number | undefined;
  readonly activity: Activity;
  readonly startedAt: number;
  outputBytes: number;
  /** Хвост вывода после маски: в снимок зависания он идёт как есть. */
  tail: string;
  /** Маска команды: ею закрываются строки команд процессов в снимке. */
  readonly redact?: (text: string) => string;
}

const TAIL = 4000;

/**
 * Движение работы одного владельца (попытки). Команды попытки регистрируются
 * здесь сами (`command` находит владельца через `activityScope`), так что
 * вызовам агента, gates и шагам среды не нужно передавать его явно. Движение —
 * начало и конец команды, её вывод и то, что владелец отмечает сам (`moved`:
 * граница стадии, заметный расход процессора).
 */
export class ActivityScope {
  readonly running = new Set<TrackedCommand>();
  lastMovementAt: number;
  constructor(readonly clock: () => number = Date.now) {
    this.lastMovementAt = clock();
  }
  moved(at = this.clock()) {
    this.lastMovementAt = Math.max(this.lastMovementAt, at);
  }
  begin(pid: number | undefined, activity: Activity, redact?: (text: string) => string) {
    const tracked: TrackedCommand = {
      pid,
      activity,
      startedAt: this.clock(),
      outputBytes: 0,
      tail: '',
      ...(redact ? { redact } : {}),
    };
    this.running.add(tracked);
    this.moved();
    return tracked;
  }
  output(tracked: TrackedCommand, text: string) {
    if (!text) return;
    tracked.outputBytes += Buffer.byteLength(text);
    tracked.tail = (tracked.tail + text).slice(-TAIL);
    this.moved();
  }
  end(tracked: TrackedCommand) {
    if (this.running.delete(tracked)) this.moved();
  }
  /** Последняя начатая из исполняющихся команд: её называет живость. */
  current(): TrackedCommand | undefined {
    let last: TrackedCommand | undefined;
    for (const t of this.running) if (!last || t.startedAt >= last.startedAt) last = t;
    return last;
  }
}

/** Владелец команд текущего асинхронного контекста; нет — команды не отслеживаются. */
export const activityScope = new AsyncLocalStorage<ActivityScope>();
