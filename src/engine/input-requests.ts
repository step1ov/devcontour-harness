import {
  blocksWork,
  type ExecutionView,
  type InputRequest,
  type WorkState,
} from '../contracts/index.ts';

/**
 * Чтение запросов исполнителя (`input-requests`). Запрос хранится у
 * владельца — репозитория поручения; поиск по поручению идёт у его
 * владельца, без владельца — по всем.
 */
export function requestsOf(
  view: ExecutionView,
  work?: Pick<WorkState, 'id' | 'order'>,
): InputRequest[] {
  return view
    .locals('input-requests', work?.order.repositoryId)
    .map((r) => r.value)
    .filter((r) => !work || r.workId === work.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Вопрос, держащий поручение: блокирующий запрос в `pending` или
 * `answered`. Это канонический блокер claim, retry (в том числе со сбросом),
 * repair и finish: `WorkState.hold` для него не занимается, и снятие чужого
 * удержания ожидания ответа не обходит.
 */
export function blockingRequest(
  view: ExecutionView,
  work: Pick<WorkState, 'id' | 'order'>,
): InputRequest | undefined {
  return requestsOf(view, work).find(blocksWork);
}

/** Запрос по ID у любого владельца. */
export function requestById(
  view: ExecutionView,
  id: string,
): { owner: string; request: InputRequest } | undefined {
  const found = view.locals('input-requests').find((r) => r.key === id);
  return found ? { owner: found.owner, request: found.value } : undefined;
}
