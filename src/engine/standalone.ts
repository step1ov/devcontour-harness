import {
  digestOf,
  type ExecutionHost,
  type ExecutionPolicy,
  type ExecutionStore,
} from '../contracts/index.ts';

/**
 * Хост самостоятельного harness: основания — digest нейтральных структур,
 * дополнительных условий нет, группа бюджета — граф.
 */
export function standaloneHost(store: ExecutionStore, policy: ExecutionPolicy): ExecutionHost {
  const policyDigest = digestOf(policy);
  return {
    store,
    basis: {
      orderDigest: (work) => digestOf(work.order),
      scopeDigest: (work) =>
        digestOf({ gates: work.order.gates ?? null, consumers: work.order.consumers ?? null }),
      policyDigest: () => policyDigest,
    },
    guards: {
      claimable: () => null,
      claimBarrier: () => null,
      current: () => null,
      beforeAccept: () => null,
    },
    budgets: {
      groupOf: (workId, view) => view.work(workId)?.graphId,
      members: (groupId, view) => view.works(groupId).map((w) => w.id),
      // Прежняя запись без атрибуции — по попытке или предмету по текущему
      // составу; у вызова о графе — все его поручения.
      legacy: (record, view) => {
        const workId =
          (record.runId ? view.attempt(record.runId)?.workId : undefined) ??
          (record.subjectId && view.work(record.subjectId) ? record.subjectId : undefined);
        if (workId) {
          const groupId = view.work(workId)?.graphId;
          return { workId, ...(groupId ? { groupId } : {}) };
        }
        const graphId = record.groupId ?? record.subjectId;
        if (!graphId || !view.graph(graphId)) return {};
        return { groupId: graphId, workIds: view.works(graphId).map((w) => w.id) };
      },
    },
  };
}
