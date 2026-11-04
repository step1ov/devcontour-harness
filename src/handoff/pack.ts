import {
  HANDOFF_LIMITS,
  HANDOFF_MAX_BYTES,
  HANDOFF_MIN_BYTES,
  HANDOFF_VERSION,
  handoffPackSchema,
  type HandoffPack,
} from '../contracts/handoff.ts';
import { HarnessError } from '../contracts/errors.ts';
import type { AttemptState, WorkState, WorkStatus } from '../contracts/execution.ts';
import { statusOf } from '../control/status.ts';
import { policySecrets, redactor } from '../environment/redaction.ts';
import { stopInputsOf, type StopSource } from '../explain/state.ts';
import { handoffMarkdown } from './markdown.ts';
import { activeStatuses } from '../projections/enums.ts';
import { nextAction } from '../projections/next.ts';
import { explainStop, stopCodeOf, type StopDiagnosis } from '../projections/stop.ts';

export interface HandoffOptions {
  /** Только этот граф; нет — вся доска. */
  graphId?: string;
  /** Намерения агента: единственный текст пакета не из хранилища. */
  intentions?: readonly string[];
  /**
   * Маска текстов из хранилища (ошибки, причины, сообщения). По умолчанию —
   * значения секретов политики из окружения процесса, как у коннектора:
   * маска знает только те значения, что заданы в окружении читающего
   * процесса. Секрет, которого в нём нет (другая машина, другой процесс
   * controller), не маскируется — передайте свою маску.
   */
  redact?: (text: string) => string;
  /**
   * Предел пакета в байтах UTF-8: целое от `HANDOFF_MIN_BYTES` до
   * `HANDOFF_MAX_BYTES` (по умолчанию). Хост с меньшим пределом ответа
   * получает тот же порядок отбрасывания и те же счётчики `truncated`, что и
   * при пределе по умолчанию; иное значение — отказ `INVALID_INPUT`.
   * Уложиться не гарантируется: неотбрасываемые записи могут быть больше
   * предела. `truncated.bySize` значит «записи отброшены», а не «уложился»:
   * размер результата хост проверяет сам.
   */
  maxBytes?: number;
  /**
   * Что укладывается в `maxBytes`: `json` (по умолчанию) — сериализованный
   * пакет; `markdown` — и JSON, и `handoffMarkdown(pack)`, для хоста, который
   * отдаёт пакет Markdown. Свой раздел хост учитывает, уменьшая `maxBytes`.
   */
  measure?: 'json' | 'markdown';
}

/**
 * Что читает пакет: движок над хранилищем (`read`, `clock`, блокировки,
 * бюджеты), политика исполнения и очередь заданий графов (`list`,
 * `continues`). `Harness` удовлетворяет ему структурно; хост со своим
 * `Engine` передаёт `{ engine, policy, workflows }` со своим адаптером
 * заданий — экземпляр `Harness` не нужен.
 */
export type HandoffSource = StopSource;

type Stop = HandoffPack['stops'][number];
type Next = HandoffPack['next'];

/**
 * Строка не длиннее `n` code units и «…»; суррогатная пара не разрывается.
 * В отличие от `clipText`, предел не может разрезать символ вне BMP.
 */
/**
 * Текст для пакета: без escape-последовательностей терминала (ANSI CSI, OSC)
 * и с каждой серией управляющих символов, заменённой одним пробелом (кроме перевода строки и
 * табуляции): в JSON каждый такой символ стоил бы 6 байт.
 */
export function plainText(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]+/g, ' ');
}

export function clipSafe(text: string, n: number): string {
  if (text.length <= n) return text;
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n) + '…';
}
/** Поле объекта только при заданном значении (exactOptionalPropertyTypes). */
const opt = <K extends string, T>(key: K, value: T | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, T>>;

const isActive = (s: WorkStatus) => (activeStatuses as readonly WorkStatus[]).includes(s);
/** Порядок открытых поручений в пакете: идущие, упавшие, план, остальные. */
const rank = (s: WorkStatus) =>
  isActive(s) ? 0 : s === 'failed' ? 1 : s === 'draft' ? 2 : s === 'ready' ? 3 : 4;
/** Решение: действует человек или ведущий, и действие — не ожидание. */
const isDecision = (d: { actor: string | null; action: string }) =>
  (d.actor === 'user' || d.actor === 'lead') && d.action !== 'wait';
/** Порядок остановок: решения человека, затем ведущего, затем ожидания. */
const actorRank = (d: Stop) => (!isDecision(d) ? 2 : d.actor === 'user' ? 0 : 1);

/**
 * Пакет передачи контекста ведущего агента из хранилища (`harness handoff`).
 * Только чтение: собирается из тех же проекций, что `status --detail`
 * (очередь, активные попытки, блокировки, бюджеты) и `explain` (остановки,
 * решения, ожидаемое действие; без проб runtime), плюс `nextAction` по
 * каждому открытому поручению и последние провалы попыток. Размер ограничен
 * `HANDOFF_LIMITS` и `HANDOFF_MAX_BYTES`. Агент добавляет только `intentions`.
 *
 * Весь пакет читается одним снимком хранилища: status, диагнозы и задания
 * графов — вложенные чтения внутри одного `read`.
 *
 * Пакет не больше `maxBytes` (по умолчанию `HANDOFF_MAX_BYTES`) в UTF-8: при
 * превышении записи отбрасываются в порядке «намерения с конца, старые
 * провалы, поручения без решения, остановки без решения, незавершённые
 * попытки, остальные поручения и остановки, строки бюджетов» и учитываются
 * в `truncated`; отказа по размеру нет. Сводка, очередь, идущие попытки,
 * задания и следующий шаг не отбрасываются: предел для них — лучшее
 * усилие.
 *
 * Источник — `Harness` или любой `HandoffSource` хоста.
 */
export function handoffPack(h: HandoffSource, options: HandoffOptions = {}): HandoffPack {
  const maxBytes = options.maxBytes ?? HANDOFF_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < HANDOFF_MIN_BYTES || maxBytes > HANDOFF_MAX_BYTES)
    throw new HarnessError(
      'INVALID_INPUT',
      `maxBytes ${maxBytes}: нужно целое от ${HANDOFF_MIN_BYTES} до ${HANDOFF_MAX_BYTES}`,
      [
        {
          path: ['maxBytes'],
          message: `${maxBytes} вне ${HANDOFF_MIN_BYTES}..${HANDOFF_MAX_BYTES}`,
        },
      ],
    );
  const measure = options.measure ?? 'json';
  if (measure !== 'json' && measure !== 'markdown')
    throw new HarnessError('INVALID_INPUT', `measure ${String(measure)}: json или markdown`, [
      { path: ['measure'], message: String(measure) },
    ]);
  return h.engine.read(() => build(h, options, maxBytes, measure));
}

function build(
  h: HandoffSource,
  options: HandoffOptions,
  maxBytes: number,
  measure: 'json' | 'markdown',
): HandoffPack {
  const { graphId } = options;
  const intentions = (options.intentions ?? []).map((s) => s.trim()).filter(Boolean);
  if (intentions.length > HANDOFF_LIMITS.intentions)
    throw new HarnessError(
      'INVALID_INPUT',
      `Намерений ${intentions.length}, предел ${HANDOFF_LIMITS.intentions}`,
      [{ path: ['intentions'], message: `${intentions.length} > ${HANDOFF_LIMITS.intentions}` }],
    );
  const redact = options.redact ?? redactor(policySecrets(h.policy));
  /** Текст из хранилища: маска секретов и предел поля. */
  const text = <T extends string | undefined>(s: T, n: number = HANDOFF_LIMITS.text) =>
    (s === undefined ? undefined : clipSafe(plainText(redact(s)), n)) as T;
  const name = <T extends string | undefined>(s: T) => text(s, HANDOFF_LIMITS.name);

  const status = statusOf(h, graphId, { detail: true });
  if (graphId !== undefined && !status.graphs.length)
    throw new HarnessError('NOT_FOUND', 'Граф не найден: ' + graphId);
  const detail = status.detail!;
  const { maxAttempts, repairBudget } = h.policy;
  const now = h.engine.clock();
  const q = detail.queue;
  const qCause = 'cause' in q ? q.cause : undefined;
  const blockersOf = new Map(status.works.map((w) => [w.id, w.blockers]));

  const read = h.engine.read((v) => {
    const works = v.works(graphId);
    const attempts = works.flatMap((w) => v.attempts(w.id));
    return { works, attempts };
  });
  const byId = new Map<string, WorkState>(read.works.map((w) => [w.id, w]));
  const title = (id: string) => text(byId.get(id)?.order.title ?? id);

  // Сводка по статусам — в порядке появления.
  const counts = new Map<WorkStatus, number>();
  for (const w of read.works) counts.set(w.status, (counts.get(w.status) ?? 0) + 1);
  const open = read.works
    .filter((w) => w.status !== 'done' && w.status !== 'cancelled')
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rank(a.w.status) - rank(b.w.status) || a.i - b.i)
    .map(({ w }) => w);

  // Остановки и решения — диагнозы explain по сохранённому состоянию.
  const inGraph = (d: StopDiagnosis) => graphId === undefined || !d.workId || byId.has(d.workId);
  const raw = stopInputsOf(h, { maxAttempts, repairBudget })
    .map(explainStop)
    .filter((d) => d.action !== 'none' && inGraph(d));
  // Диагноз поручения: explain знает, продолжит ли движок работу сам.
  const diagnosisOf = new Map<string, StopDiagnosis>();
  for (const d of raw) if (d.workId && !diagnosisOf.has(d.workId)) diagnosisOf.set(d.workId, d);
  const stopOf = (d: StopDiagnosis): Stop => ({
    code: d.code,
    cause: d.cause,
    phase: d.phase,
    actor: d.actor,
    action: d.action,
    retryPlanned: d.retryPlanned,
    message: text(d.message),
    evidence: d.evidence.slice(0, HANDOFF_LIMITS.evidence).map((e) => ({
      kind: e.kind,
      id: name(e.id),
      ...opt('sha', e.sha?.slice(0, 64)),
    })),
    ...opt('workId', d.workId),
    ...opt('runId', name(d.runId)),
  });
  // Остановка выдачи общей паузой очереди и повторы одного диагноза на
  // выдаче сворачиваются в одну запись: иначе они вытесняют решения.
  const queueStop = (d: StopDiagnosis) =>
    q.paused &&
    d.phase === 'claim' &&
    d.code === q.code &&
    d.cause === qCause &&
    d.actor === q.actor &&
    d.action === q.action;
  interface Entry {
    stop: Stop;
    ids: string[];
    queue: boolean;
  }
  const groups = new Map<string, Entry>();
  const ordered: Entry[] = [];
  for (const d of raw) {
    const queue = Boolean(d.workId) && queueStop(d);
    const key = queue
      ? 'queue'
      : d.workId && d.phase === 'claim'
        ? [d.code, d.cause, d.actor, d.action, d.message].join('\u0000')
        : undefined;
    const group = key ? groups.get(key) : undefined;
    if (group) {
      if (d.workId) group.ids.push(d.workId);
      continue;
    }
    const entry = { stop: stopOf(d), ids: d.workId ? [d.workId] : [], queue };
    if (key) groups.set(key, entry);
    ordered.push(entry);
  }
  if (q.paused && !groups.has('queue') && q.code && q.action && qCause)
    ordered.unshift({
      stop: {
        code: q.code,
        cause: qCause,
        phase: 'claim',
        actor: q.actor ?? null,
        action: q.action,
        retryPlanned: false,
        message: text(q.detail ?? `Очередь на паузе: ${q.reason ?? 'runtime'}`),
        evidence: [],
      },
      ids: [],
      queue: true,
    });
  const diagnoses = ordered
    .map(({ stop, ids, queue }): Stop => {
      if (!queue && ids.length < 2) return stop;
      const { workId: _w, runId: _r, ...rest } = stop;
      void _w;
      void _r;
      return {
        ...rest,
        ...(queue ? { queue: true as const } : {}),
        ...(ids.length
          ? { works: ids.slice(0, HANDOFF_LIMITS.stopWorks), worksCount: ids.length }
          : {}),
      };
    })
    .map((d, i) => ({ d, i }))
    .sort((a, b) => actorRank(a.d) - actorRank(b.d) || a.i - b.i)
    .map(({ d }) => d);
  const stops = diagnoses.slice(0, HANDOFF_LIMITS.stops);

  const works = open.slice(0, HANDOFF_LIMITS.works).map((w) => {
    const view = nextAction({
      status: w.status,
      attempt: w.attempt,
      maxAttempts,
      ...opt('hold', w.hold),
      ...opt('recovery', w.recovery),
    });
    // Кто и что — по диагнозу explain, когда он есть; стадия и свойство — по nextAction.
    const d = diagnosisOf.get(w.id);
    const next = {
      actor: d ? d.actor : view.actor,
      action: d ? d.action : view.action,
      step: view.step,
      ...opt('property', name(view.property)),
      ...opt('detail', text(d ? d.message : view.detail)),
    };
    // Пауза очереди одна на всех: её показывает `queue`, а не каждая строка.
    const blockers = (blockersOf.get(w.id) ?? []).filter((b) => !(q.paused && b.code === 'PAUSED'));
    return {
      id: w.id,
      graphId: w.graphId,
      title: title(w.id),
      status: w.status,
      attempt: w.attempt,
      ...opt('failureKind', w.failureKind),
      ...opt('failure', text(w.failure)),
      ...(w.hold
        ? { hold: { operation: name(w.hold.operation), reason: text(w.hold.reason) } }
        : {}),
      ...(w.recovery
        ? {
            recovery: {
              status: w.recovery.status,
              property: name(w.recovery.property),
              ...opt('reason', text(w.recovery.reason)),
              ...opt('proposal', text(w.recovery.decision?.proposal)),
            },
          }
        : {}),
      blockers: blockers
        .slice(0, HANDOFF_LIMITS.blockers)
        .map((b) => ({ code: b.code, message: text(b.message) })),
      ...(blockers.length > HANDOFF_LIMITS.blockers
        ? { blockersTruncated: blockers.length - HANDOFF_LIMITS.blockers }
        : {}),
      next,
    };
  });

  // Провалы попыток — новые первыми.
  const time = (a: AttemptState) => a.finishedAt ?? a.startedAt;
  const failed = read.attempts
    .filter((a) => a.status === 'failed' || a.status === 'expired')
    .sort((a, b) => time(b).localeCompare(time(a)) || b.attempt - a.attempt);
  const failures = failed.slice(0, HANDOFF_LIMITS.failures).map((a) => ({
    runId: name(a.id),
    workId: a.workId,
    ...opt('workStatus', byId.get(a.workId)?.status),
    attempt: a.attempt,
    status: a.status as 'failed' | 'expired',
    phase: a.phase,
    ...opt('finishedAt', a.finishedAt),
    ...opt('failureKind', a.failureKind),
    code: stopCodeOf(a.failureKind),
    ...opt('error', text(a.error)),
  }));

  // Незавершённые записи: попытка не закрыта, но владение истекло или
  // поручение уже ведёт другую попытку.
  const unfinishedAll = read.attempts
    .filter((a) => a.status === 'active')
    .map((a) => ({
      a,
      stale: a.leaseUntil <= now,
      current: byId.get(a.workId)?.activeRunId === a.id,
    }))
    .filter((x) => x.stale || !x.current);
  const unfinished = unfinishedAll
    .slice(0, HANDOFF_LIMITS.unfinished)
    .map(({ a, stale, current }) => ({
      runId: name(a.id),
      workId: a.workId,
      attempt: a.attempt,
      phase: a.phase,
      startedAt: a.startedAt,
      stale,
      current,
      ...opt('interrupted', a.interrupted),
    }));

  const active = detail.attempts.map((a) => ({
    workId: a.workId,
    title: title(a.workId),
    runId: name(a.runId),
    attempt: a.attempt,
    phase: a.phase,
    runtime: name(a.runtime),
    elapsedMs: a.elapsedMs,
    ...(a.stage ? { stage: { name: name(a.stage.name), elapsedMs: a.stage.elapsedMs } } : {}),
    ...opt('sinceHeartbeatMs', a.lease.sinceHeartbeatMs),
    leaseUntil: new Date(a.lease.leaseUntil).toISOString(),
    stale: a.lease.stale,
    gates: a.gates,
  }));

  const queue = {
    paused: q.paused,
    ...opt('reason', q.reason),
    ...opt('detail', text(q.detail)),
    ...opt('since', q.since),
    ...opt('operation', name(q.operation)),
    ...('failures' in q && q.failures?.length ? { failures: [...q.failures] } : {}),
    ...('liftedByRun' in q ? { liftedByRun: q.liftedByRun } : {}),
    ...opt('code', q.code),
    ...(q.actor !== undefined ? { actor: q.actor } : {}),
    ...opt('action', q.action),
  };

  // Бюджеты: общий и групп этого графа — всегда; поручений — только с
  // расходом или не в пределах; затем общий предел строк.
  const relevant = (status.budgets?.budgets ?? []).filter((b) =>
    b.scope.kind === 'total'
      ? true
      : b.scope.kind === 'group'
        ? graphId === undefined || b.scope.id === graphId
        : b.scope.id !== undefined && byId.has(b.scope.id),
  );
  const shown = relevant
    .filter(
      (b) =>
        b.scope.kind !== 'work' ||
        b.state !== 'within' ||
        b.reportedUsd + b.estimatedUsd > 0 ||
        b.unknownCalls + b.unfinishedCalls + b.abandonedCalls > 0,
    )
    .map((b, i) => ({ b, i }))
    .sort(
      (x, y) =>
        (x.b.scope.kind === 'work' ? 1 : 0) - (y.b.scope.kind === 'work' ? 1 : 0) || x.i - y.i,
    )
    .map(({ b }) => b);
  const budgetEntries = shown.slice(0, HANDOFF_LIMITS.budgets).map((b) => ({
    scope: b.scope.kind,
    ...opt('id', name(b.scope.id)),
    state: b.state,
    ...opt('limitUsd', b.limit.usd),
    ...opt('limitMs', b.limit.timeMs),
    reportedUsd: b.reportedUsd,
    estimatedUsd: b.estimatedUsd,
    complete: b.unknownCalls + b.unfinishedCalls + b.abandonedCalls + b.uncoveredRuns === 0,
    unknownCalls: b.unknownCalls,
    unfinishedCalls: b.unfinishedCalls,
    abandonedCalls: b.abandonedCalls,
    uncoveredRuns: b.uncoveredRuns,
    durationMs: b.durationMs,
    remainingUsd: b.remainingUsd,
    remainingMs: b.remainingMs,
    ...opt('reason', text(b.reason)),
  }));
  const budgets = status.budgets
    ? { onUnknown: status.budgets.onUnknown, entries: budgetEntries }
    : undefined;

  const graphIds = new Set(status.graphs.map((g) => g.id));
  const repairsAll = h.workflows
    .list()
    .filter((j) => j.kind === 'graph' && graphIds.has(j.id) && j.status !== 'completed')
    .map((j) => ({ graphId: j.id, status: j.status, used: j.repairs ?? 0, budget: repairBudget }));
  const repairs = repairsAll.slice(0, HANDOFF_LIMITS.repairs);

  const controller = status.controller
    ? {
        owner: name(status.controller.owner),
        until: new Date(status.controller.leaseUntil).toISOString(),
        live: status.controller.leaseUntil > now,
      }
    : undefined;

  const cleanIntentions = intentions.map(plainText);
  const clippedIntentions = cleanIntentions.map((s) => clipSafe(s, HANDOFF_LIMITS.intentionChars));
  const pack: HandoffPack = {
    handoffVersion: HANDOFF_VERSION,
    at: new Date(now).toISOString(),
    ...opt('graphId', graphId),
    limits: { maxAttempts, repairBudget },
    summary: {
      works: read.works.length,
      open: open.length,
      done: counts.get('done') ?? 0,
      cancelled: counts.get('cancelled') ?? 0,
      byStatus: [...counts].map(([s, c]) => ({ status: s, count: c })),
    },
    queue,
    ...opt('controller', controller),
    active,
    unfinished,
    works,
    stops,
    failures,
    ...opt('budgets', budgets),
    repairs,
    next: boardNext({
      diagnoses,
      active,
      staleRecords: unfinishedAll.some((x) => x.stale),
      works,
      total: read.works.length,
      controllerLive: Boolean(controller?.live),
      liftedByRun: 'liftedByRun' in q && q.liftedByRun === true,
    }),
    intentions: clippedIntentions,
    truncated: {
      works: open.length - works.length,
      stops: diagnoses.length - stops.length,
      failures: failed.length - failures.length,
      unfinished: unfinishedAll.length - unfinished.length,
      budgets: shown.length - budgetEntries.length,
      budgetsWithin: relevant.length - shown.length,
      repairs: repairsAll.length - repairs.length,
      intentions: cleanIntentions.filter((s, i) => s !== clippedIntentions[i]).length,
      intentionsDropped: 0,
      bySize: false,
    },
  };
  return handoffPackSchema.parse(fitPack(pack, maxBytes, measure));
}

/** Решение в строке поручения или в остановке. */
const decides = (n: { actor: string | null; action: string }) => isDecision(n);

/**
 * Предел размера в байтах UTF-8: записи отбрасываются в фиксированном
 * порядке, пока пакет не уложится; каждая — в `truncated`. С `markdown`
 * мерой служит больший из размеров JSON и `handoffMarkdown(pack)`.
 */
export function fitPack(
  pack: HandoffPack,
  maxBytes: number = HANDOFF_MAX_BYTES,
  measure: 'json' | 'markdown' = 'json',
): HandoffPack {
  const json = () => Buffer.byteLength(JSON.stringify(pack));
  const size =
    measure === 'markdown'
      ? () => Math.max(json(), Buffer.byteLength(handoffMarkdown(pack)))
      : json;
  const t = pack.truncated;
  const dropLast = <T>(list: T[], keep: (x: T) => boolean = () => false) => {
    for (let i = list.length - 1; i >= 0; i--)
      if (!keep(list[i]!)) {
        list.splice(i, 1);
        return true;
      }
    return false;
  };
  const steps: (() => boolean)[] = [
    () => dropLast(pack.intentions) && (t.intentionsDropped++, true),
    () => dropLast(pack.failures) && (t.failures++, true),
    () => dropLast(pack.works, (w) => decides(w.next)) && (t.works++, true),
    () => dropLast(pack.stops, decides) && (t.stops++, true),
    () => dropLast(pack.unfinished) && (t.unfinished++, true),
    () => dropLast(pack.works) && (t.works++, true),
    () => dropLast(pack.stops) && (t.stops++, true),
    () => Boolean(pack.budgets && dropLast(pack.budgets.entries)) && (t.budgets++, true),
  ];
  for (const step of steps)
    while (size() > maxBytes) {
      t.bySize = true;
      if (!step()) break;
    }
  return pack;
}

/**
 * Следующий шаг доски: первое решение человека или ведущего (`explain`);
 * иначе идущая попытка с живым владельцем — ждать controller; попытка без
 * живого владельца — `harness run` (истечёт брошенную попытку и продолжит
 * очередь); иначе первый открытый шаг поручения (без controller —
 * `harness run`); иначе ничего.
 */
function boardNext(input: {
  diagnoses: Stop[];
  active: HandoffPack['active'];
  staleRecords: boolean;
  works: HandoffPack['works'];
  total: number;
  controllerLive: boolean;
  liftedByRun: boolean;
}): Next {
  const decision = input.diagnoses.find(isDecision);
  if (decision)
    return {
      actor: decision.actor,
      action: decision.action,
      code: decision.code,
      ...opt('workId', decision.workId),
      detail: decision.message,
      ...(decision.action === 'resume-queue' ? { command: 'harness resume' as const } : {}),
    };
  const running = input.active.find((a) => !a.stale);
  if (running && input.controllerLive)
    return {
      actor: 'controller',
      action: 'wait',
      step: 'attempt-running',
      workId: running.workId,
      detail: 'Идёт попытка с живым владельцем; controller продолжит очередь',
    };
  // Свежий срок владения без controller: попытку ведёт живой (или только что
  // пропавший) процесс — run её не перехватит, пока срок не истечёт.
  if (running)
    return {
      actor: 'controller',
      action: 'wait',
      step: 'attempt-running',
      workId: running.workId,
      detail: `Владение попыткой действует до ${running.leaseUntil}: ждать или проверить процесс-владелец`,
    };
  const abandoned = input.active.find((a) => a.stale);
  if (abandoned || input.staleRecords)
    return {
      actor: 'controller',
      action: 'wait',
      step: 'awaiting-claim',
      ...opt('workId', abandoned?.workId),
      detail: input.controllerLive
        ? 'Владение попыткой истекло: controller истечёт её и выдаст работу заново'
        : 'Попытка без живого владельца: harness run истечёт её и продолжит очередь',
      ...(input.controllerLive ? {} : { command: 'harness run' as const }),
    };
  const first = input.works.find((w) => w.next.action !== 'none');
  if (first) {
    const idle = !input.controllerLive && (first.next.actor === 'controller' || input.liftedByRun);
    return {
      ...first.next,
      workId: first.id,
      ...(idle
        ? {
            detail: 'Очередь ждёт controller: работу продолжит harness run',
            command: 'harness run' as const,
          }
        : {}),
    };
  }
  return {
    actor: null,
    action: 'none',
    detail: input.total ? 'Вся работа завершена' : 'Работы нет',
  };
}
