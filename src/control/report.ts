import type { ExecutionStore, RunEvent } from '../contracts/index.ts';
import type { ValueReportInput } from '../report/compute.ts';

/** Страница событий при чтении журнала для отчёта (предел `events`). */
const EVENT_PAGE = 500;

/**
 * Вход отчёта (`valueReport`) из хранилища исполнения: графы, поручения,
 * попытки, записи учёта вызовов и ревью — одним снимком `read`; журнал
 * событий — страницами по 500 вне этого снимка (транзакция чтения между
 * страницами не держится). Ничего не пишет.
 */
export function collectReportInput(store: ExecutionStore): ValueReportInput {
  const snapshot = store.read((v) => ({
    graphs: v.graphs(),
    works: v.works(),
    attempts: v.attempts(),
    calls: v.locals('usage').map((r) => r.value),
    reviews: v.locals('reviews').map((r) => r.value),
  }));
  const events: RunEvent[] = [];
  let after = 0;
  for (;;) {
    const page = store.events(after, EVENT_PAGE);
    events.push(...page);
    if (page.length < EVENT_PAGE) break;
    after = page.at(-1)!.seq;
  }
  return { ...snapshot, events };
}
