import {
  WORKSPACE_OWNER,
  type CallRecord,
  type ExecutionPolicy,
  type ExecutionView,
  type Usage,
} from '../contracts/index.ts';

// Учёт вызовов моделей: стоимость, время и живость вызова. Без зависимостей
// от процессов и ОС — их регистрирует слой окружения (`environment/live-calls.ts`).

export type Price = ExecutionPolicy['prices'][number];

/**
 * Стоимость вызова. Сообщённая провайдером — как есть, и при ошибке вызова.
 * Оценка по тарифу — только по полным счётчикам: у оборванного вызова они
 * частичные, и оценка выдала бы нижнюю границу за стоимость.
 */
export function priceUsage(usage: Usage, price?: Price) {
  if (usage.reportedUsd !== null)
    return { costUsd: usage.reportedUsd, costSource: 'provider-reported' as const };
  const { inputTokens: i, outputTokens: o, cacheReadTokens: r, cacheWriteTokens: w } = usage;
  if (!price || !usage.complete || i === null || o === null || r === null || w === null)
    return { costUsd: null, costSource: 'unknown' as const };
  if (i < r + w) return { costUsd: null, costSource: 'unknown' as const };
  return {
    costUsd:
      ((i - r - w) * price.input + o * price.output + r * price.cacheRead + w * price.cacheWrite) /
      1e6,
    costSource: 'tariff-estimate' as const,
  };
}

/** Начало идущих вызовов этого процесса по монотонным часам. */
const activeStarts = new Map<string, number>();
export const activeStart = (id: string) => activeStarts.get(id);
export const startActive = (id: string) => activeStarts.set(id, performance.now());
export const endActive = (id: string) => activeStarts.delete(id);

/** Монотонные часы ОС, нс, и идентификатор текущей загрузки; их регистрирует слой окружения. */
let monotonicNow: (() => bigint) | undefined;
let currentBoot: string | undefined;
export const registerMonotonic = (now: () => bigint, boot: string | undefined) => {
  monotonicNow = now;
  currentBoot = boot;
};

/**
 * Время вызова: монотонное, если записано; иначе по меткам до завершения, а у
 * идущего — до `at`. `null` — время неизвестно: метки противоречат друг другу
 * (часы переведены назад), и ноль выдал бы потраченное время за непотраченное.
 */
export const callDurationMs = (r: CallRecord, at = Date.now()): number | null => {
  if (r.durationMs !== undefined) return r.durationMs;
  if (r.durationUnknown) return null;
  // Идущий вызов этого процесса — по монотонным часам: перевод системных
  // часов не уменьшает уже потраченное время.
  const started = r.outcome === 'active' ? activeStart(r.id) : undefined;
  if (started !== undefined) return Math.round(performance.now() - started);
  // Идущий вызов другого процесса той же машины и той же загрузки ОС — по
  // монотонным часам ОС; часы другой загрузки несравнимы.
  if (
    r.outcome === 'active' &&
    r.startedHr &&
    monotonicNow &&
    r.bootId !== undefined &&
    r.bootId === currentBoot
  ) {
    const elapsed = Number((monotonicNow() - BigInt(r.startedHr)) / 1_000_000n);
    if (elapsed >= 0) return Math.max(elapsed, r.elapsedMs ?? 0);
  }
  // Идущий вызов без сравнимых монотонных часов: время по системным часам
  // может уменьшиться при их откате, поэтому оно неизвестно.
  if (r.outcome === 'active') return null;
  const elapsed =
    Date.parse(r.finishedAt ?? r.abandonedAt ?? new Date(at).toISOString()) -
    Date.parse(r.startedAt);
  // Сохранённый монотонный замер — нижняя граница: откат часов не опускает
  // время ниже него.
  if (r.elapsedMs !== undefined) return Math.max(r.elapsedMs, elapsed);
  return elapsed >= 0 ? elapsed : null;
};

/**
 * Стоимость вызова известна, когда она сообщена провайдером (в том числе 0 и
 * при ошибке или прерывании) или оценена по полным счётчикам завершённого
 * вызова. Идущий вызов ещё может стоить больше записанного; у прерванного
 * оценка — лишь нижняя граница: после неё он мог продолжать тратить.
 */
export const knownCost = (r: CallRecord) =>
  r.costUsd !== null &&
  r.outcome !== 'active' &&
  (r.outcome !== 'abandoned' || r.costSource === 'provider-reported');

export function usageTotals(records: CallRecord[], uncovered = false, at = Date.now()) {
  const complete =
    records.length > 0 &&
    !uncovered &&
    records.every(
      (r) =>
        r.outcome !== 'active' &&
        r.outcome !== 'abandoned' &&
        r.usage.complete &&
        r.costUsd !== null,
    );
  const sum = (source: CallRecord['costSource']) =>
    records.filter((r) => r.costSource === source).reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const reportedUsd = sum('provider-reported');
  const estimatedUsd = sum('tariff-estimate');
  const knownCostUsd = reportedUsd + estimatedUsd;
  return {
    calls: records.length,
    costUsd: complete ? knownCostUsd : null,
    knownCostUsd,
    /** Сообщено провайдером. */
    reportedUsd,
    /** Оценено по тарифу. */
    estimatedUsd,
    complete,
    unknownCalls: records.filter((r) => !knownCost(r)).length,
    estimatedCalls: records.filter((r) => r.costSource === 'tariff-estimate').length,
    reportedCalls: records.filter((r) => r.costSource === 'provider-reported').length,
    /** Идущие вызовы и прерванные падением процесса. */
    unfinishedCalls: records.filter((r) => r.outcome === 'active').length,
    abandonedCalls: records.filter((r) => r.outcome === 'abandoned').length,
    errorCalls: records.filter((r) => r.outcome === 'error').length,
    // Неизвестное время входит своей достоверной нижней границей (сохранённым
    // монотонным замером): исчерпание по известной части видно и при
    // `onUnknown: continue`.
    durationMs: records.reduce((s, r) => s + (callDurationMs(r, at) ?? r.elapsedMs ?? 0), 0),
    /** Вызовы с неизвестным временем: их время в `durationMs` не вошло. */
    unknownDurationCalls: records.filter((r) => callDurationMs(r, at) === null).length,
  };
}

/* ------------------------------------------------------------------ */
/* Живость вызова                                                      */
/* ------------------------------------------------------------------ */

/**
 * Процесс, который ведёт вызов. Процессы и ОС — дело слоя окружения: он
 * регистрирует свой процесс и проверку чужого владельца. Без регистрации
 * чужой владелец живым не считается (консервативно).
 */
export type CallOwner = NonNullable<CallRecord['process']>;
let current: CallOwner | undefined;
let foreignAlive: (owner: CallOwner) => boolean = () => false;
let foreignGone: (owner: CallOwner) => boolean = () => false;
export function registerProcess(
  owner: CallOwner,
  alive: (owner: CallOwner) => boolean,
  gone: (owner: CallOwner) => boolean,
) {
  current = owner;
  foreignAlive = alive;
  foreignGone = gone;
}
/** Процесс, от имени которого записываются вызовы; `undefined` — не зарегистрирован. */
export const currentProcess = () => current;
export const currentBootId = () => currentBoot;

/**
 * Вызов идёт на самом деле. Свой — ещё не завершён в этом процессе. Чужой —
 * его процесс существует и это тот же процесс (pid этого процесса у чужой
 * записи значит, что pid достался нам; момент старта сверяет слой окружения),
 * и вызов не старше `maxMs`. Владелец, которого подтвердить нельзя, живым не
 * считается.
 */
export function liveCall(r: CallRecord, at: number, maxMs: number) {
  if (r.outcome !== 'active' || !r.process) return false;
  if (current && r.process.id === current.id) return activeStart(r.id) !== undefined;
  if (r.process.pid === process.pid || r.process.startedAt === undefined) return false;
  if (at - Date.parse(r.startedAt) > maxMs) return false;
  return foreignAlive(r.process);
}

/**
 * Владелец записи точно не ведёт вызов: процесса нет, или pid достался
 * другому процессу. Владелец, которого нельзя ни подтвердить, ни
 * опровергнуть, ушедшим не считается: восстановление не закрывает, возможно,
 * идущий вызов.
 */
export function ownerGone(r: CallRecord) {
  if (!r.process || (current && r.process.id === current.id)) return false;
  if (r.process.pid === process.pid) return true;
  return foreignGone(r.process);
}

/** Все записи вызовов всех владельцев (workspace и репозиториев). */
export function callRecords(view: ExecutionView): CallRecord[] {
  const seen = new Map<string, CallRecord>();
  for (const { value } of view.locals('usage')) seen.set(value.id, value);
  return [...seen.values()];
}

/** Владелец локальной записи вызова: репозиторий или workspace. */
export const callOwner = (r: Pick<CallRecord, 'repositoryId'>) => r.repositoryId ?? WORKSPACE_OWNER;
