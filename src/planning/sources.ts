// Ведущий не добавляет требований без источника (0.1.0-alpha.70).
//
// Каждый критерий приёмки, который написал ведущий, называет источник
// (`WorkOrder.criteriaSources`): постановку, ответ владельца, находку ревью
// или закреплённый документ. Ревью плана получает список критериев без
// источника и помечает те, что не следуют из постановки, блокирующей
// находкой `unsourced-criterion`. Критерии самого источника (задачи хоста)
// не переписываются: поручение без поля — критерии постановки как есть.

import type { WorkGraph, WorkOrder } from '../contracts/index.ts';

/** Критерии поручения без названного источника (номера в `acceptance`). */
export function unsourcedCriteria(order: Pick<WorkOrder, 'acceptance' | 'criteriaSources'>) {
  const sourced = new Set((order.criteriaSources ?? []).map((c) => c.criterion));
  return order.acceptance.flatMap((text, i) => (sourced.has(i) ? [] : [{ criterion: i, text }]));
}

/** Строка запроса ревью плана: правило источников и критерии без источника. */
export function unsourcedCriteriaNote(graph: Pick<WorkGraph, 'orders'>): string {
  const declared = graph.orders.filter((o) => o.criteriaSources?.length);
  const missing = declared
    .map((o) => ({ order: o.id, criteria: unsourcedCriteria(o) }))
    .filter((m) => m.criteria.length);
  return [
    'Requirement sources: the lead adds no requirement without a source. Orders that cite sources list them in criteriaSources (criterion index → brief, owner-answer, review-finding or context). For every acceptance criterion that has no source and does not follow from the order goal, the pinned context or the brief, report a blocking finding with rule "unsourced-criterion" and the criterion text; a criterion that only restates the goal needs no source.',
    missing.length
      ? 'Criteria without a cited source in orders that cite sources: ' + JSON.stringify(missing)
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
