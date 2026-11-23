// Конец сессии ведущего при готовых работах (alpha.68, P6-33): готовые
// согласованные работы ждут, никто не запущен, а ведущий заканчивает сессию
// без `harness run` — работа стоит до его следующей сессии. Не блокировка:
// `lead end` выполняется и выходит с 0, но печатает предупреждение
// `READY_WORKS_NOT_RUNNING` и кладёт его в ответ (`readyNotRunning`). Готовые
// работы — та же проверка, что у строки очереди `status` (`runner.ready`,
// подсказка «запустите harness run» alpha.67).

import { ruCount } from '../contracts/plural.ts';
import { statusOf, type StatusSource } from './status.ts';

export const READY_WORKS_NOT_RUNNING = 'READY_WORKS_NOT_RUNNING';
/** Сколько готовых работ называется в ответе. */
const NAMED = 50;

export interface ReadyNotRunning {
  code: typeof READY_WORKS_NOT_RUNNING;
  ready: number;
  readyWorks: string[];
  line: string;
  lineEn: string;
}

/** Предупреждение конца сессии по строке очереди `status`; нечего сказать — undefined. */
export function readyNotRunning(source: StatusSource): ReadyNotRunning | undefined {
  const runner = statusOf(source).runner;
  if (runner?.state !== 'not-running' || !runner.ready) return undefined;
  const works = (runner.readyWorks ?? []).slice(0, NAMED);
  const shown = works.slice(0, 5);
  const more = runner.ready - shown.length;
  const ids = shown.join(', ') + (more > 0 ? ` и ещё ${more}` : '');
  const idsEn = shown.join(', ') + (more > 0 ? ` and ${more} more` : '');
  return {
    code: READY_WORKS_NOT_RUNNING,
    ready: runner.ready,
    readyWorks: works,
    line: `Сессия закончена, а готово ${ruCount(runner.ready, ['задача', 'задачи', 'задач'])} и никто не запущен (${ids}): работу сдвинет только новый запуск — harness run.`,
    lineEn: `The session ended while ${runner.ready} ${runner.ready === 1 ? 'task is' : 'tasks are'} ready and nothing is running (${idsEn}): only a new run moves the work — harness run.`,
  };
}
