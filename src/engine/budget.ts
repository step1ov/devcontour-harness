import type {
  BudgetScopes,
  CallRecord,
  ExecutionPolicy,
  ExecutionView,
  WorkState,
} from '../contracts/index.ts';
import { TaskFailure } from './failure.ts';
import { callRecords, liveCall, usageTotals } from './usage.ts';

/**
 * Бюджеты расходов и времени вызовов моделей.
 *
 * Расход считается по сохранённым записям вызовов, а не по счётчикам попыток:
 * `retry --reset`, возврат попытки после отказа окружения, переход этапа
 * очереди и перезапуск процесса его не уменьшают. Ошибочные, идущие и
 * прерванные вызовы входят в расход. Неизвестная стоимость делает денежный
 * бюджет неопределённым; что тогда делать, задаёт `budgets.onUnknown`.
 *
 * Учёт локален: записи вызовов не переносятся между клонами, поэтому бюджет
 * считает вызовы этой установки.
 */
export type BudgetScope = { kind: 'work' | 'group' | 'total'; id?: string };

/** Правила и области бюджетов: политика и группы хоста. */
export interface BudgetContext {
  policy: ExecutionPolicy;
  scopes: BudgetScopes;
}

const closed = (w: WorkState | undefined) => !!w && ['done', 'cancelled'].includes(w.status);

/** Группа, о которой вызов: идентификатор, у которого хост знает поручения. */
const isGroup = (c: BudgetContext, view: ExecutionView, id: string) =>
  c.scopes.members(id, view).length > 0;

/**
 * Предмет вызова — поручение: по попытке либо по ID предмета, если вид
 * предмета не назван иначе. Вызов о группе или контракте с ID, совпавшим с
 * поручением, этим поручением не становится.
 */
function subjectWork(
  view: ExecutionView,
  meta: {
    runId?: string;
    subjectId?: string;
    subjectKind?: CallRecord['subjectKind'];
    groupId?: string;
    workId?: string;
  },
) {
  const byRun = meta.runId ? view.attempt(meta.runId)?.workId : undefined;
  if (byRun) return byRun;
  if (meta.subjectKind && meta.subjectKind !== 'work') return undefined;
  if (legacyGroupCall(meta)) return undefined;
  return meta.subjectId && view.work(meta.subjectId) ? meta.subjectId : undefined;
}

/**
 * Прежняя запись вызова о группе: вида предмета нет, но при вызове закреплена
 * группа без поручения и без попытки. Вызов о поручении закреплял его
 * `workId`, поэтому совпадение ID предмета с поручением такую запись не
 * делает расходом одного поручения — она остаётся расходом группы.
 */
export function legacyGroupCall(r: {
  runId?: string;
  subjectKind?: CallRecord['subjectKind'];
  groupId?: string;
  workId?: string;
}) {
  return !r.subjectKind && !r.runId && !!r.groupId && !r.workId;
}

/** Поручение записи: закреплённое при вызове, у прежних записей — по попытке. */
const recordWork = (view: ExecutionView, r: CallRecord) => r.workId ?? subjectWork(view, r);

/** Группа записи: закреплённая при вызове, у прежних записей — по текущему составу. */
function recordGroup(c: BudgetContext, view: ExecutionView, r: CallRecord) {
  if (r.groupId) return r.groupId;
  if (r.subjectId && (!r.subjectKind || r.subjectKind === 'group') && isGroup(c, view, r.subjectId))
    return r.subjectId;
  const work = recordWork(view, r);
  return work ? c.scopes.groupOf(work, view) : undefined;
}

/**
 * Группы поручения: текущая и те, в которых оно тратило. Поручение,
 * перенесённое из исчерпанной группы, остаётся под её ограничением.
 */
function workGroups(c: BudgetContext, view: ExecutionView, records: CallRecord[], workId: string) {
  const groups = new Set<string>();
  const current = c.scopes.groupOf(workId, view);
  if (current) groups.add(current);
  for (const r of records)
    if ((r.workId === workId || r.workIds?.includes(workId)) && r.groupId) groups.add(r.groupId);
  return groups;
}

/**
 * Записи вызовов области. Поручению принадлежат его попытки, вызовы о нём и
 * вызовы о его группе целиком (ревью плана): правила долевой атрибуции нет,
 * и вызов о группе не должен считаться нулевым для поручения. Группе — вызовы,
 * закреплённые за ней при вызове: перенос поручения в другую группу расход не
 * переносит.
 */
export function scopeRecords(
  c: BudgetContext,
  view: ExecutionView,
  records: CallRecord[],
  scope: BudgetScope,
) {
  if (scope.kind === 'total') return records;
  if (scope.kind === 'group') return records.filter((r) => recordGroup(c, view, r) === scope.id);
  const groups = workGroups(c, view, records, scope.id!);
  return records.filter((r) => {
    if (r.workIds) return r.workIds.includes(scope.id!);
    const work = recordWork(view, r);
    return work === scope.id || (!work && groups.has(recordGroup(c, view, r) ?? ''));
  });
}

/**
 * Попытки области, вызовы которых не записаны: выданы до учёта вызовов (без
 * отметки `callsRecorded`), модель в них вызывалась (есть кандидат или замер
 * реализации), а записи реализации нет. Их стоимость и время неизвестны и не
 * выдумываются; посторонние и более поздние вызовы пробел не закрывают, а у
 * отмеченной попытки отсутствие записи значит, что вызова не было.
 */
function uncoveredRuns(
  c: BudgetContext,
  view: ExecutionView,
  records: CallRecord[],
  scope: BudgetScope,
) {
  const implemented = new Set(
    records.filter((r) => r.stage === 'implementation' && r.runId).map((r) => r.runId),
  );
  const works =
    scope.kind === 'total'
      ? undefined
      : scope.kind === 'work'
        ? new Set([scope.id!])
        : new Set(c.scopes.members(scope.id!, view));
  return view
    .attempts()
    .filter(
      (a) =>
        !a.callsRecorded &&
        (!works || works.has(a.workId)) &&
        !implemented.has(a.id) &&
        (a.candidateSha || a.timings?.some((t) => t.stage.startsWith('implementation'))),
    ).length;
}

export type BudgetStatus = {
  scope: BudgetScope;
  limit: { usd?: number; timeMs?: number };
  spent: ReturnType<typeof usageTotals> & { uncoveredRuns: number; liveCalls: number };
  state: 'within' | 'exceeded' | 'undetermined';
  reason?: string;
};

export function budgetStatus(
  c: BudgetContext,
  view: ExecutionView,
  scope: BudgetScope,
  records?: CallRecord[],
  at = Date.now(),
): BudgetStatus | undefined {
  const limit = c.policy.budgets?.[scope.kind];
  if (!limit) return undefined;
  const all = records ?? callRecords(view);
  const own = scopeRecords(c, view, all, scope);
  const spent = {
    ...usageTotals(own, false, at),
    uncoveredRuns: uncoveredRuns(c, view, all, scope),
    // Исключение из неизвестных — только для вызовов с подтверждённо живым
    // владельцем: вызов умершего процесса неизвестен сразу, не дожидаясь
    // восстановления.
    liveCalls: own.filter((r) => liveCall(r, at, 2 * c.policy.runTimeoutMs)).length,
  };
  const name = scope.kind === 'total' ? 'total' : `${scope.kind} ${scope.id}`;
  const usd = spent.reportedUsd + spent.estimatedUsd;
  const detail =
    `израсходовано: сообщено $${spent.reportedUsd.toFixed(4)}, оценено $${spent.estimatedUsd.toFixed(4)}, ` +
    `неизвестных вызовов ${spent.unknownCalls}, время ${Math.round(spent.durationMs / 1000)} с` +
    (spent.uncoveredRuns ? `, попыток без учёта вызовов ${spent.uncoveredRuns}` : '');
  if (limit.usd !== undefined && usd >= limit.usd)
    return {
      scope,
      limit,
      spent,
      state: 'exceeded',
      reason: `Бюджет ${name} исчерпан: предел $${limit.usd}; ${detail}`,
    };
  if (limit.timeMs !== undefined && spent.durationMs >= limit.timeMs)
    return {
      scope,
      limit,
      spent,
      state: 'exceeded',
      reason: `Бюджет времени ${name} исчерпан: предел ${Math.round(limit.timeMs / 1000)} с; ${detail}`,
    };
  // Идущий вызов живого процесса начат в пределах бюджета и не прерывается:
  // его стоимость станет известна по окончании, а неопределённым бюджет
  // делают остальные вызовы без стоимости. Иначе любой идущий вызов
  // останавливал бы параллельную работу той же области. Перерасход поэтому
  // ограничен вызовами, идущими одновременно.
  const settledUnknown = spent.unknownCalls - spent.liveCalls;
  const unknown = [
    ...(limit.usd !== undefined && settledUnknown
      ? [`у ${settledUnknown} вызовов неизвестна стоимость`]
      : []),
    ...(limit.timeMs !== undefined && spent.unknownDurationCalls
      ? [`у ${spent.unknownDurationCalls} вызовов неизвестно время`]
      : []),
    ...(spent.uncoveredRuns ? [`у ${spent.uncoveredRuns} попыток вызовы не записаны`] : []),
  ];
  if (unknown.length)
    return {
      scope,
      limit,
      spent,
      state: 'undetermined',
      reason: `Бюджет ${name} не определён: ${unknown.join(', ')}; ${detail}`,
    };
  return { scope, limit, spent, state: 'within' };
}

/** Бюджеты, относящиеся к поручению: его собственный, его групп и общий. */
export function workBudgets(
  c: BudgetContext,
  view: ExecutionView,
  workId: string,
  records = callRecords(view),
  at = Date.now(),
) {
  return [
    budgetStatus(c, view, { kind: 'work', id: workId }, records, at),
    ...[...workGroups(c, view, records, workId)].map((id) =>
      budgetStatus(c, view, { kind: 'group', id }, records, at),
    ),
    budgetStatus(c, view, { kind: 'total' }, records, at),
  ].filter((b): b is BudgetStatus => !!b);
}

/** Сведения о вызове: попытка, предмет (поручение, группа, документ), стадия. */
export interface CallMeta {
  repositoryId?: string;
  runId?: string;
  subjectId?: string;
  /** Вид предмета: явный вид важнее совпадения ID с поручением. */
  subjectKind?: CallRecord['subjectKind'];
  stage: string;
  /**
   * Состав группы из входа вызова (ревью плана до регистрации графа): группа и
   * её поручения закрепляются за расходом на момент вызова, а не по составу,
   * который хранилище узнает позже.
   */
  group?: { id: string; workIds: string[] };
}

/** Группа вызова и её поручения: из входа вызова и по составу, известному хосту. */
function callGroup(
  c: BudgetContext,
  view: ExecutionView,
  meta: Pick<CallMeta, 'subjectId' | 'subjectKind' | 'group'>,
) {
  const id =
    meta.group?.id ??
    (meta.subjectId &&
    (!meta.subjectKind || meta.subjectKind === 'group') &&
    isGroup(c, view, meta.subjectId)
      ? meta.subjectId
      : undefined);
  if (!id) return undefined;
  const members = [...new Set([...(meta.group?.workIds ?? []), ...c.scopes.members(id, view)])];
  return { id, members };
}

/**
 * Бюджеты вызова модели: по его попытке или поручению — бюджеты поручения; о
 * группе — бюджеты группы и каждого её открытого поручения, за которыми вызов
 * будет учтён; о прочем (контракт) — общий.
 */
export function callBudgets(
  c: BudgetContext,
  view: ExecutionView,
  meta: Pick<CallMeta, 'runId' | 'subjectId' | 'subjectKind' | 'group'>,
  records = callRecords(view),
  at = Date.now(),
) {
  const workId = meta.group ? undefined : subjectWork(view, meta);
  if (workId) return workBudgets(c, view, workId, records, at);
  const group = callGroup(c, view, meta);
  const open = group ? group.members.filter((id) => !closed(view.work(id))) : [];
  const seen = new Set<string>();
  return [
    group ? budgetStatus(c, view, { kind: 'group', id: group.id }, records, at) : undefined,
    ...open.flatMap((id) => workBudgets(c, view, id, records, at)),
    budgetStatus(c, view, { kind: 'total' }, records, at),
  ].filter((b): b is BudgetStatus => {
    if (!b) return false;
    const key = `${b.scope.kind}:${b.scope.id ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Поручение и группа вызова на момент вызова: за ними остаётся его расход.
 * У вызова о группе — её открытые поручения.
 */
export function callAttribution(
  c: BudgetContext,
  view: ExecutionView,
  meta: Pick<CallMeta, 'runId' | 'subjectId' | 'subjectKind' | 'group'>,
  all = false,
): Pick<CallRecord, 'workId' | 'groupId' | 'workIds'> {
  const workId = meta.group ? undefined : subjectWork(view, meta);
  if (workId) {
    const groupId = c.scopes.groupOf(workId, view);
    return { workId, ...(groupId ? { groupId } : {}) };
  }
  const group = callGroup(c, view, meta);
  if (!group) return {};
  return {
    groupId: group.id,
    workIds: all ? group.members : group.members.filter((id) => !closed(view.work(id))),
  };
}

/** Бюджет, который запрещает тратить: превышен или не определён при `onUnknown: stop`. */
export function blockingBudget(c: BudgetContext, statuses: BudgetStatus[]) {
  const stopOnUnknown = (c.policy.budgets?.onUnknown ?? 'stop') === 'stop';
  return statuses.find(
    (b) => b.state === 'exceeded' || (b.state === 'undetermined' && stopOnUnknown),
  );
}

/** Отказ до траты: превышенный или неопределённый бюджет не даёт начать вызов. */
export function assertBudget(c: BudgetContext, statuses: BudgetStatus[]) {
  const blocking = blockingBudget(c, statuses);
  if (blocking) throw new TaskFailure('budget', blocking.reason!);
}

/** Компактный вид бюджета для статуса и потребителей. */
export function budgetView(b: BudgetStatus) {
  const usd = b.spent.reportedUsd + b.spent.estimatedUsd;
  return {
    scope: b.scope,
    state: b.state,
    limit: b.limit,
    reportedUsd: b.spent.reportedUsd,
    estimatedUsd: b.spent.estimatedUsd,
    unknownCalls: b.spent.unknownCalls,
    unfinishedCalls: b.spent.unfinishedCalls,
    abandonedCalls: b.spent.abandonedCalls,
    errorCalls: b.spent.errorCalls,
    uncoveredRuns: b.spent.uncoveredRuns,
    durationMs: b.spent.durationMs,
    // Остаток денег известен, только когда неизвестных вызовов и попыток нет.
    remainingUsd:
      b.limit.usd === undefined ||
      b.spent.unknownCalls > b.spent.liveCalls ||
      b.spent.uncoveredRuns > 0
        ? null
        : Math.max(0, b.limit.usd - usd),
    remainingMs:
      b.limit.timeMs === undefined || b.spent.unknownDurationCalls > 0 || b.spent.uncoveredRuns > 0
        ? null
        : Math.max(0, b.limit.timeMs - b.spent.durationMs),
    ...(b.reason ? { reason: b.reason } : {}),
  };
}

/** Бюджеты установки: общий, группы с незавершённой работой, незавершённые поручения. */
export function budgetOverview(c: BudgetContext, view: ExecutionView, records?: CallRecord[]) {
  if (!c.policy.budgets) return undefined;
  const all = records ?? callRecords(view);
  const open = view.works().filter((w) => !closed(w));
  const groups = new Set(
    open.map((w) => c.scopes.groupOf(w.id, view)).filter((g): g is string => !!g),
  );
  const scopes: BudgetScope[] = [
    { kind: 'total' },
    ...[...groups].map((id) => ({ kind: 'group' as const, id })),
    ...open.map((w) => ({ kind: 'work' as const, id: w.id })),
  ];
  return {
    onUnknown: c.policy.budgets.onUnknown,
    budgets: scopes
      .map((scope) => budgetStatus(c, view, scope, all))
      .filter((b): b is BudgetStatus => !!b)
      .map(budgetView),
  };
}
