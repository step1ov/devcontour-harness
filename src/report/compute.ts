// Отчёт об эффекте harness: чистая функция данных исполнения. Модуль без
// node:* и без zod — его импортирует браузер; схема ответа —
// `valueReportSchema` (src/contracts/report.ts).

import { HarnessError } from '../contracts/errors.ts';
import type {
  AttemptState,
  CallRecord,
  EvidenceRecord,
  FailureKind,
  GraphState,
  PauseReason,
  PropertyRecovery,
  WorkState,
} from '../contracts/execution.ts';
import type { EnvironmentCause, RunEvent, RunEventPayload } from '../contracts/events.ts';
import type { ReviewRecord } from '../contracts/review.ts';
import type { InputRequest } from '../contracts/input.ts';
import { inputStateOf } from '../projections/input.ts';
import type { FailureBucket, ReportDist, ReportMeasure, ValueReport } from '../contracts/report.ts';
import {
  formatDuration,
  formatMeasureRatio,
  formatMeasureUsd,
  formatRatio,
  formatUsd,
  formatWindow,
} from './format.ts';

/** Литералы `src/contracts/report.ts` (тест сверяет поэлементно). */
export const reportVersion = 1;
export const reportLimits = {
  works: 50,
  evidence: 50,
  weeks: 12,
  rows: 50,
  jsonBytes: 512 * 1024,
  htmlBytes: 1024 * 1024,
} as const;
export const failureBucketNames = [
  'defect',
  'incomplete',
  'integration',
  'environment',
  'time-limit',
  'tool',
  'operator',
  'budget',
  'unknown',
  'unclassified',
  'input',
] as const satisfies readonly FailureBucket[];

/** Данные исполнения: те же формы, что отдают `ExecutionView` и `events()`. */
export interface ValueReportInput {
  works: readonly WorkState[];
  attempts: readonly AttemptState[];
  /** Записи учёта вызовов (`locals('usage')`). */
  calls?: readonly CallRecord[];
  /** Раунды ревью плана и контрактов (`locals('reviews')`). */
  reviews?: readonly ReviewRecord[];
  /** Журнал событий: паузы и согласования. */
  events?: readonly RunEvent[];
  /** Графы: согласования, если событий нет. */
  graphs?: readonly GraphState[];
  /** Вопросы исполнителей (`locals('input-requests')`): в отчёт — только числа. */
  inputRequests?: readonly InputRequest[];
}

export interface ValueReportOptions {
  /** Начало окна (включительно): ISO-время с поясом, дата `YYYY-MM-DD` или `7d`/`4w` до `asOf`. */
  since?: string;
  /** Конец окна (не включительно): ISO-время с поясом или дата. */
  until?: string;
  /** Момент отчёта; по умолчанию — последняя метка времени в данных (не часы). */
  asOf?: string;
  /** Без заголовков поручений и метки проекта. */
  noTitles?: boolean;
  /** Версия harness в заголовке. */
  harnessVersion?: string;
  /** Метка проекта (например, имя каталога состояния). */
  label?: string;
  /** Каталог состояния: пути evidence записываются относительно него. */
  stateDir?: string;
}

/* ------------------------------------------------------------------ */
/* Время и окно                                                        */
/* ------------------------------------------------------------------ */

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const RELATIVE = /^(\d{1,4})([dw])$/;

const at = (iso: string) => Date.parse(iso);
const toIso = (ms: number) => new Date(ms).toISOString();

function parseTime(value: string, name: string): number {
  const ms = ISO.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms))
    throw new HarnessError(
      'INVALID_INPUT',
      `${name}: ожидается ISO-время с поясом (2026-10-26T00:00:00Z) или дата 2026-10-26`,
      [{ path: [name], message: value }],
    );
  return ms;
}

/** Последняя метка времени в данных — `asOf` по умолчанию. */
function latestOf(input: ValueReportInput): number | undefined {
  let latest: number | undefined;
  const see = (iso: string | undefined) => {
    if (!iso) return;
    const ms = at(iso);
    if (!Number.isNaN(ms) && (latest === undefined || ms > latest)) latest = ms;
  };
  for (const a of input.attempts) {
    see(a.startedAt);
    see(a.finishedAt);
  }
  for (const c of input.calls ?? []) {
    see(c.startedAt);
    see(c.finishedAt);
  }
  for (const r of input.reviews ?? []) see(r.at);
  for (const e of input.events ?? []) see(e.at);
  return latest;
}

interface Window {
  since: number | undefined;
  until: number | undefined;
  asOf: number;
}

function windowOf(input: ValueReportInput, options: ValueReportOptions): Window {
  const until = options.until === undefined ? undefined : parseTime(options.until, '--until');
  let asOf: number;
  if (options.asOf !== undefined) asOf = parseTime(options.asOf, '--as-of');
  else {
    const latest = latestOf(input);
    asOf = latest ?? until ?? 0;
    if (until !== undefined && asOf > until) asOf = until;
  }
  let since: number | undefined;
  if (options.since !== undefined) {
    const rel = RELATIVE.exec(options.since);
    since = rel
      ? asOf - Number(rel[1]) * (rel[2] === 'w' ? WEEK : DAY)
      : parseTime(options.since, '--since');
  }
  if (since !== undefined && until !== undefined && since >= until)
    throw new HarnessError('INVALID_INPUT', '--since должно быть раньше --until', [
      { path: ['--since'], message: `${toIso(since)} >= ${toIso(until)}` },
    ]);
  return { since, until, asOf };
}

/** Неизвестное время не входит ни в одно окно (и в неограниченное тоже): итог не зависит от окна. */
const inWindow = (w: Window, iso: string | undefined) => {
  if (!iso) return false;
  const ms = at(iso);
  return (w.since === undefined || ms >= w.since) && (w.until === undefined || ms < w.until);
};

/* ------------------------------------------------------------------ */
/* Классы отказа                                                       */
/* ------------------------------------------------------------------ */

const bucketOfKind: Record<FailureKind, FailureBucket> = {
  gate: 'defect',
  review: 'defect',
  'scope-violation': 'defect',
  'empty-result': 'incomplete',
  unfinished: 'incomplete',
  'context-exhausted': 'incomplete',
  'needs-lead': 'incomplete',
  'needs-input': 'input',
  'stale-base': 'integration',
  merge: 'integration',
  environment: 'environment',
  'provider-auth': 'environment',
  stalled: 'environment',
  timeout: 'time-limit',
  'review-protocol': 'tool',
  cancelled: 'operator',
  budget: 'budget',
  unknown: 'unknown',
};

const finishedStatuses = new Set(['failed', 'cancelled', 'expired']);

/** Числа вопросов исполнителя в окне: состояния вопросов, запросы ведущему, решения исполнителя. */
function inputCounts(
  requests: readonly InputRequest[],
  attempts: readonly AttemptState[],
  w: Window,
): NonNullable<ValueReport['inputs']> {
  const inside = requests.filter((r) => inWindow(w, r.createdAt));
  const questions = inside.filter((r) => r.kind === 'question' && r.blocking);
  const state = (s: string) => questions.filter((r) => inputStateOf(r) === s).length;
  return {
    questions: questions.length,
    awaitingAnswer: state('awaiting-answer'),
    answeredNotApplied: state('answered-not-applied'),
    appliedAwaitingClaim: state('applied-awaiting-claim'),
    delivered: state('delivered'),
    closed: questions.filter((r) => r.lifecycle === 'cancelled' || r.lifecycle === 'superseded')
      .length,
    declined: inside.filter((r) => r.kind === 'question' && !r.blocking).length,
    followUps: inside.filter((r) => r.kind === 'follow-up').length,
    assumptions: attempts.reduce((n, a) => n + (a.assumptions?.length ?? 0), 0),
  };
}

/**
 * Корзина отказа попытки; `null` — попытка не отказ (успех, идёт) или
 * прервана штатной остановкой (`interrupted`, считается отдельно).
 * Отказ окружения (`blocked`) и истёкшее владение — `environment`; попытка
 * без класса (записана до классификации) — `unclassified`, а не «проект».
 */
export function failureBucketOf(a: AttemptState): FailureBucket | null {
  if (!finishedStatuses.has(a.status) || a.interrupted === 'shutdown') return null;
  if (a.blocked) return 'environment';
  if (a.failureKind) return bucketOfKind[a.failureKind];
  if (a.status === 'expired') return 'environment';
  if (a.status === 'cancelled') return 'operator';
  return 'unclassified';
}

/**
 * Засчитанная в предел попыток — то же правило, что у движка (`counted` в
 * `attempt.diagnosed`): не засчитаны прерванные штатной остановкой, отказы до
 * работы (`blocked`), отказы окружения и провайдера (`environment`,
 * `provider-auth`) и истёкшее владение. Зависание (`stalled`) засчитано.
 */
const counted = (a: AttemptState) =>
  a.status !== 'active' &&
  a.interrupted !== 'shutdown' &&
  !a.blocked &&
  a.status !== 'expired' &&
  a.failureKind !== 'environment' &&
  a.failureKind !== 'provider-auth';

/** Gate подготовки: установка зависимостей — его отказ часто сетевой (M6). */
const setupGate = (gate: string) => /install|setup|bootstrap|deps|dependenc/i.test(gate);

/** Отказ gate только в gates подготовки: возможно, сеть или реестр, а не код (M6). */
const setupOnlyFailure = (a: AttemptState) => {
  if (a.failureKind !== 'gate' || a.blocked) return false;
  const failing = a.evidence.filter((e) => e.kind === 'test' && !e.passed);
  return failing.length > 0 && failing.every((e) => setupGate(e.gate));
};

/* ------------------------------------------------------------------ */
/* Статистика                                                          */
/* ------------------------------------------------------------------ */

const round2 = (x: number) => Math.round(x * 100) / 100;
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

function dist(values: number[], unknown: number, integer = true): ReportDist {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const fix = (x: number) => (integer ? Math.round(x) : round2(x));
  if (n < 5) return { n, unknown, median: null, p75: null, max: null, values: sorted.map(fix) };
  const median = n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  return {
    n,
    unknown,
    median: fix(median),
    p75: fix(sorted[Math.ceil(0.75 * n) - 1]!),
    max: fix(sorted[n - 1]!),
    values: [],
  };
}

const measure = (
  value: number | null,
  n: number,
  unknown: number,
  bound: ReportMeasure['bound'],
): ReportMeasure => ({ value, n, unknown, bound });

/* ------------------------------------------------------------------ */
/* Пути и тексты                                                       */
/* ------------------------------------------------------------------ */

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/**
 * Путь evidence для отчёта: относительно каталога состояния; путь вне него
 * (в том числе в домашнем каталоге) — только имя файла после `…/`.
 */
export function reportPath(path: string | undefined, stateDir: string | undefined) {
  if (!path) return null;
  const norm = path.replace(/\\/g, '/');
  const base = stateDir?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && norm.startsWith(base + '/')) {
    const rel = norm.slice(base.length + 1);
    if (!rel.split('/').includes('..')) return clip(rel, 300);
  }
  const relative = !norm.startsWith('/') && !/^[A-Za-z]:/.test(norm) && !norm.startsWith('~');
  if (relative && !norm.split('/').includes('..')) return clip(norm, 300);
  return '…/' + clip(norm.split('/').filter(Boolean).at(-1) ?? '', 200);
}

/** Сравнение строк по кодовым единицам: без локали (`localeCompare` зависит от ICU и LANG). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Время сравнивается моментом, а не строкой: у ISO с поясом лексический порядок неверен. */
const timeOrder = (a: string | undefined, b: string | undefined) =>
  (a ? at(a) : -Infinity) - (b ? at(b) : -Infinity) || 0;
const byTimeThenId = <T extends { id: string }>(time: (x: T) => string | undefined) => {
  return (a: T, b: T) => timeOrder(time(a), time(b)) || cmp(a.id, b.id);
};

/* ------------------------------------------------------------------ */
/* Отчёт                                                               */
/* ------------------------------------------------------------------ */

/** Цена вызова известна — то же правило, что `knownCost` учёта (`src/engine/usage.ts`). */
export const callCostKnown = (r: CallRecord) =>
  r.costUsd !== null &&
  r.outcome !== 'active' &&
  (r.outcome !== 'abandoned' || r.costSource === 'provider-reported');

/** Вызов полностью учтён: завершён, счётчики полные, цена есть (`usageTotals.complete`). */
const callComplete = (r: CallRecord) =>
  r.outcome !== 'active' && r.outcome !== 'abandoned' && r.usage.complete && r.costUsd !== null;

interface WorkFacts {
  work: WorkState;
  attempts: AttemptState[];
  accepting: AttemptState | undefined;
  acceptedAt: string | undefined;
  finishedAt: string | undefined;
  outcome: 'accepted' | 'failed' | 'cancelled' | undefined;
}

/**
 * Отчёт об эффекте: что дали проверки, ревью и исполнение на данных
 * проекта. Чистая функция: тот же вход и те же параметры — тот же объект
 * (порядок входных массивов, часы и часовой пояс не влияют). Ответ
 * соответствует `valueReportSchema`.
 */
export function valueReport(
  input: ValueReportInput,
  options: ValueReportOptions = {},
): ValueReport {
  const w = windowOf(input, options);
  const works = [...input.works].sort((a, b) => cmp(a.id, b.id));
  const attempts = [...input.attempts].sort(byTimeThenId((a) => a.startedAt));
  const calls = [...(input.calls ?? [])].sort(byTimeThenId((c) => c.startedAt));
  const reviews = [...(input.reviews ?? [])].sort(
    (a, b) =>
      cmp(a.kind, b.kind) || cmp(a.subject, b.subject) || a.round - b.round || cmp(a.id, b.id),
  );
  const events = [...(input.events ?? [])].sort((a, b) => a.seq - b.seq);
  const graphs = [...(input.graphs ?? [])].sort((a, b) => cmp(a.id, b.id));

  const attemptsOf = new Map<string, AttemptState[]>();
  for (const a of attempts) {
    const list = attemptsOf.get(a.workId) ?? [];
    list.push(a);
    attemptsOf.set(a.workId, list);
  }
  const callsOfRun = new Map<string, CallRecord[]>();
  const callsOfWork = new Map<string, CallRecord[]>();
  const runIds = new Set(attempts.map((a) => a.id));
  for (const c of calls) {
    if (c.runId && runIds.has(c.runId)) {
      const list = callsOfRun.get(c.runId) ?? [];
      list.push(c);
      callsOfRun.set(c.runId, list);
    } else if (c.workId && c.subjectKind === 'work') {
      const list = callsOfWork.get(c.workId) ?? [];
      list.push(c);
      callsOfWork.set(c.workId, list);
    }
  }

  /* Поручения: исход и время ----------------------------------------- */
  const facts: WorkFacts[] = works.map((work) => {
    const own = attemptsOf.get(work.id) ?? [];
    const accepting =
      work.status === 'done' ? own.filter((a) => a.status === 'succeeded').at(-1) : undefined;
    const lastFinished = own
      .map((a) => a.finishedAt)
      .filter((x): x is string => !!x)
      .sort(timeOrder)
      .at(-1);
    const outcome =
      work.status === 'done'
        ? ('accepted' as const)
        : work.status === 'failed'
          ? ('failed' as const)
          : work.status === 'cancelled' && own.length > 0
            ? ('cancelled' as const)
            : undefined;
    const finishedAt = outcome === 'accepted' ? accepting?.finishedAt : lastFinished;
    return {
      work,
      attempts: own,
      accepting,
      acceptedAt: outcome === 'accepted' ? accepting?.finishedAt : undefined,
      finishedAt,
      outcome,
    };
  });
  const accepted = facts.filter((f) => f.outcome === 'accepted' && inWindow(w, f.acceptedAt));
  const acceptedIds = new Set(accepted.map((f) => f.work.id));
  const finished = facts.filter((f) => f.outcome && inWindow(w, f.finishedAt));
  const windowAttempts = attempts.filter((a) => inWindow(w, a.startedAt));
  const windowCalls = calls.filter((c) => inWindow(w, c.startedAt));
  const windowReviews = reviews.filter((r) => inWindow(w, r.at));
  const windowEvents = events.filter((e) => inWindow(w, e.at));
  const failedAttempts = windowAttempts.filter((a) => finishedStatuses.has(a.status));

  const isFirstPass = (f: WorkFacts) =>
    f.attempts.filter(counted).length === 1 && !!f.accepting && counted(f.accepting);
  /**
   * Первая попытка неизвестна: кроме принявшей, засчитаны только отказы без
   * класса — будь они отказами окружения, попытка была бы первой.
   */
  const firstPassUnknown = (f: WorkFacts) => {
    if (isFirstPass(f) || !f.accepting) return false;
    const others = f.attempts.filter((a) => a !== f.accepting && counted(a));
    return (
      others.length > 0 &&
      others.every((a) => {
        const b = failureBucketOf(a);
        return b === 'unknown' || b === 'unclassified';
      })
    );
  };
  /**
   * Возврат до приёмки: `defect` — есть отказ `defect`; `setup` — только
   * отказы gate подготовки; `unknown` — отказов `defect` нет, но есть отказы
   * без класса; `no` — ни того ни другого.
   */
  const sentBack = (f: WorkFacts): 'defect' | 'setup' | 'unknown' | 'no' => {
    const end = f.accepting ? f.attempts.indexOf(f.accepting) : f.attempts.length;
    const before = f.attempts.slice(0, end);
    const defects = before.filter((a) => failureBucketOf(a) === 'defect');
    if (defects.length) return defects.every(setupOnlyFailure) ? 'setup' : 'defect';
    return before.some((a) => {
      const b = failureBucketOf(a);
      return b === 'unknown' || b === 'unclassified';
    })
      ? 'unknown'
      : 'no';
  };
  const leadOf = (f: WorkFacts): { ms: number | null; fallback: boolean } => {
    const first = f.attempts[0];
    const start = first?.wait?.approvedAt ?? f.work.approvedAt;
    const end = f.accepting?.finishedAt;
    if (!start || !end) return { ms: null, fallback: false };
    const ms = at(end) - at(start);
    return { ms: ms >= 0 ? ms : null, fallback: !first?.wait?.approvedAt };
  };
  const machineOf = (list: readonly AttemptState[]) =>
    sum(list.map((a) => (a.finishedAt ? Math.max(0, at(a.finishedAt) - at(a.startedAt)) : 0)));

  /* Стоимость попыток и поручений ------------------------------------ */
  /**
   * Расход попытки. `callsRecorded` значит «учёт вызовов полон», а не «вызовы
   * есть»: записи попытки без флага тоже её расход, но лишь нижняя граница;
   * без флага и без записей расход неизвестен.
   */
  const attemptCost = (a: AttemptState) => {
    const own = callsOfRun.get(a.id) ?? [];
    const known = own.filter(callCostKnown);
    return {
      usd: sum(known.map((c) => c.costUsd!)),
      unknown: own.length - known.length,
      calls: own.length,
      complete: !!a.callsRecorded && own.every(callComplete),
    };
  };
  const workCost = (f: WorkFacts) => {
    const own = [
      ...f.attempts.flatMap((a) => callsOfRun.get(a.id) ?? []),
      ...(callsOfWork.get(f.work.id) ?? []),
    ];
    const known = own.filter(callCostKnown);
    const usd = round2(sum(known.map((c) => c.costUsd!)));
    const uninstrumented = f.attempts.some((a) => !a.callsRecorded);
    const unknown = own.length - known.length;
    const bound: ReportMeasure['bound'] =
      known.length === 0 && (unknown > 0 || uninstrumented)
        ? 'unknown'
        : unknown > 0 || uninstrumented || !own.every(callComplete)
          ? 'lower'
          : 'exact';
    return { usd, unknown, bound };
  };

  /* Дефекты (D1–D7) -------------------------------------------------- */
  const defectAttempts = windowAttempts.filter((a) => failureBucketOf(a) === 'defect');
  const failingOf = (a: AttemptState): EvidenceRecord[] => {
    const kind = a.failureKind === 'gate' ? 'test' : a.failureKind === 'review' ? 'review' : null;
    return a.evidence.filter((e) => !e.passed && (kind === null || e.kind === kind));
  };
  const byKind = { gate: 0, review: 0, 'scope-violation': 0 };
  const byPhase = { candidate: 0, integration: 0, unknown: 0 };
  for (const a of defectAttempts) {
    if (
      a.failureKind === 'gate' ||
      a.failureKind === 'review' ||
      a.failureKind === 'scope-violation'
    )
      byKind[a.failureKind] += 1;
    const phase = failingOf(a).at(-1)?.phase;
    byPhase[phase ?? 'unknown'] += 1;
  }
  const gateRows = new Map<
    string,
    { gate: string; phase: 'candidate' | 'integration'; failed: number }
  >();
  for (const a of defectAttempts)
    for (const e of a.evidence)
      if (e.kind === 'test' && !e.passed) {
        const key = e.gate + '\u0000' + e.phase;
        const row = gateRows.get(key) ?? { gate: e.gate, phase: e.phase, failed: 0 };
        row.failed += 1;
        gateRows.set(key, row);
      }
  const byGate = [...gateRows.values()]
    .sort((a, b) => b.failed - a.failed || cmp(a.gate, b.gate) || cmp(a.phase, b.phase))
    .map((r) => ({ ...r, gate: clip(r.gate, 200), setup: setupGate(r.gate) }));

  const windowEvidence = windowAttempts.flatMap((a) => a.evidence.map((e) => ({ a, e })));
  const rejectedReviews = windowEvidence.filter(({ e }) => e.kind === 'review' && !e.passed);
  const reviewsBlock = {
    rejected: rejectedReviews.length,
    candidate: rejectedReviews.filter(({ e }) => e.phase === 'candidate').length,
    integration: rejectedReviews.filter(({ e }) => e.phase === 'integration').length,
    blockingFindings: sum(
      rejectedReviews.map(
        ({ e }) => (e.findings ?? []).filter((f) => f.severity === 'blocking').length,
      ),
    ),
    withoutFindings: rejectedReviews.filter(({ e }) => !(e.findings ?? []).length).length,
  };

  // D4: ревью кандидата отклонило, хотя каждый обязательный gate прошёл на том же SHA.
  let green = 0;
  let greenRejected = 0;
  for (const a of windowAttempts) {
    const required = a.requiredGates ?? [];
    if (!required.length) continue;
    for (const e of a.evidence) {
      if (e.kind !== 'review' || e.phase !== 'candidate') continue;
      const allGreen = required.every((g) =>
        a.evidence.some(
          (x) =>
            x.kind === 'test' &&
            x.phase === 'candidate' &&
            !x.consumer &&
            x.gate === g &&
            x.sha === e.sha &&
            x.passed &&
            (x.checks === undefined || e.checks === undefined || x.checks === e.checks),
        ),
      );
      if (!allGreen) continue;
      green += 1;
      if (!e.passed) greenRejected += 1;
    }
  }

  // D6: раунды ревью плана и контрактов; блокирующие находки — по ID, последний статус.
  const pcFindings = new Map<string, string>();
  for (const r of windowReviews)
    for (const f of r.findings)
      if (f.severity === 'blocking')
        pcFindings.set(`${r.kind}\u0000${r.subject}\u0000${f.id}`, f.status);
  const pcStatuses = [...pcFindings.values()];
  const kindRounds = (kind: 'plan' | 'contract') => {
    const list = windowReviews.filter((r) => r.kind === kind);
    return { rounds: list.length, rejected: list.filter((r) => !r.approved).length };
  };

  // D7: находки, отозванные reviewer, среди находок со статусом (прокси точности).
  const statusOf = new Map<string, string | undefined>();
  let withoutId = 0;
  for (const { a, e } of windowEvidence)
    if (e.kind === 'review')
      for (const f of e.findings ?? []) {
        if (f.id) statusOf.set(`code\u0000${a.workId}\u0000${f.id}`, f.status);
        else withoutId += 1;
      }
  for (const r of windowReviews)
    for (const f of r.findings) statusOf.set(`${r.kind}\u0000${r.subject}\u0000${f.id}`, f.status);
  const statuses = [...statusOf.values()];
  const withStatus = statuses.filter((s) => s !== undefined);

  type EvidenceRef = ValueReport['defects']['items'][number];
  const allItems = defectAttempts
    .flatMap((a): EvidenceRef[] => {
      const failing = failingOf(a);
      if (!failing.length)
        return [
          {
            workId: a.workId,
            runId: a.id,
            attempt: a.attempt,
            kind: 'scope' as const,
            phase: null,
            gate: null,
            at: toIso(at(a.finishedAt ?? a.startedAt)),
            sha: a.candidateSha?.slice(0, 12) ?? null,
            log: null,
            blocking: null,
          },
        ];
      return failing.map((e) => ({
        workId: a.workId,
        runId: a.id,
        attempt: a.attempt,
        kind: e.kind,
        phase: e.phase,
        gate: clip(e.gate, 200),
        at: toIso(at(e.createdAt)),
        sha: e.sha.slice(0, 12),
        log: reportPath(e.log, options.stateDir),
        blocking:
          e.kind === 'review'
            ? (e.findings ?? []).filter((f) => f.severity === 'blocking').length
            : null,
      }));
    })
    .sort((x, y) => cmp(y.at, x.at) || cmp(x.runId, y.runId) || cmp(x.gate ?? '', y.gate ?? ''));
  const items = allItems.slice(0, reportLimits.evidence);

  /* Автономность (A1–A5) ---------------------------------------------- */
  const episodes = new Map<string, PropertyRecovery & { workId: string }>();
  for (const f of facts)
    for (const r of [
      ...(f.work.recoveryHistory ?? []),
      ...(f.work.recovery ? [f.work.recovery] : []),
    ])
      episodes.set(r.id, { ...r, workId: f.work.id });
  const operatorDecisions = [...episodes.values()].filter(
    (r) => r.decision?.source.kind === 'operator' && inWindow(w, r.decision.decidedAt),
  );
  const holds = windowEvents.filter((e) => e.type === 'work.held' && !e.payload.released);
  const cancelledAttempts = windowAttempts.filter((a) => failureBucketOf(a) === 'operator');
  // Действие человека — только запись с актёром-человеком: решение recovery
  // оператора, повтор и отмена с `by: operator`. Удержание (`work.held`) актёра
  // не называет: его ставят и операции хоста (например, смена контракта),
  // поэтому оно показано отдельно и в действия человека не входит.
  const actedOn = new Set<string>(
    [...episodes.values()]
      .filter((r) => r.decision?.source.kind === 'operator')
      .map((r) => r.workId),
  );
  // Вмешательства с актёром (`work.retried`, `work.cancelled`, `base.moved`):
  // запись идёт с первого события версии, которая их пишет (она же пишет
  // `attempt.diagnosed` при каждом отказе). Раньше него действие могло быть,
  // но не записано, — поручение, начатое раньше, «без действий» не считается.
  const interventionTypes = new Set([
    'work.retried',
    'work.cancelled',
    'base.moved',
    'attempt.diagnosed',
  ]);
  const firstRecorded = events.find((e) => interventionTypes.has(e.type));
  const recordedFrom = firstRecorded ? at(firstRecorded.at) : undefined;
  // Актёр не назван: повтор или отмена хостом (`host`) и любое удержание
  // (`work.held`, его ставит и человек, и операция хоста) — поручение с ними
  // «без действий человека» не считается, а неизвестно.
  const unattributed = new Set<string>();
  // Порядок — по `seq` журнала, а не по времени: `at` события — часы записи,
  // а время попытки — часы движка (их задаёт хост), сравнивать их нельзя.
  const reopenedAt = new Map<string, number[]>();
  const registeredAt = new Map<string, number[]>();
  const endSeq = new Map<string, number>();
  const startSeq = new Map<string, number>();
  const push = (m: Map<string, number[]>, key: string, ms: number) =>
    m.set(key, [...(m.get(key) ?? []), ms]);
  for (const e of events) {
    if (e.type === 'graph.registered' && e.graphId) push(registeredAt, e.graphId, e.seq);
    if (e.runId && e.type === 'attempt.claimed') startSeq.set(e.runId, e.seq);
    if (
      e.runId &&
      (e.type === 'attempt.failed' ||
        e.type === 'attempt.cancelled' ||
        e.type === 'attempt.expired' ||
        // Записывающая версия пишет их сразу за концом попытки: конец — с ними.
        e.type === 'attempt.diagnosed' ||
        e.type === 'work.cancelled')
    )
      endSeq.set(e.runId, Math.max(endSeq.get(e.runId) ?? 0, e.seq));
    if (!e.workId) continue;
    if (e.type === 'work.held') unattributed.add(e.workId);
    if (e.type === 'work.retried') push(reopenedAt, e.workId, e.seq);
    if (e.type !== 'work.retried' && e.type !== 'work.cancelled') continue;
    if (e.payload.by === 'operator') actedOn.add(e.workId);
    else if (e.payload.by === 'host') unattributed.add(e.workId);
  }
  // Пробел записи (откат на версию без этих событий и повторное обновление):
  // после начала записи новая попытка поручения после отказа или отмены
  // невозможна без повтора — нет ни `work.retried`, ни новой редакции графа
  // между концом прежней попытки и выдачей новой (по `seq`), значит, повтор
  // шёл версией, которая его не записывает. Без этих событий попытки (журнал
  // неполон) пробел не определяется.
  const gapWorks = new Set<string>();
  const gapInWindow = new Set<string>();
  if (recordedFrom !== undefined)
    for (const f of facts)
      for (let i = 1; i < f.attempts.length; i++) {
        const prev = f.attempts[i - 1]!;
        const cur = f.attempts[i]!;
        if (!finishedStatuses.has(prev.status) || prev.interrupted === 'shutdown') continue;
        const from = endSeq.get(prev.id);
        const to = startSeq.get(cur.id);
        if (from === undefined || to === undefined || from < firstRecorded!.seq) continue;
        const between = (seq: number) => seq > from && seq < to;
        if (
          (reopenedAt.get(f.work.id) ?? []).some(between) ||
          (registeredAt.get(f.work.graphId) ?? []).some(between)
        )
          continue;
        gapWorks.add(f.work.id);
        if (inWindow(w, cur.startedAt)) gapInWindow.add(f.work.id);
      }
  /** Начало жизни поручения: согласование первой попытки или поручения, иначе первая попытка. */
  const startOf = (f: WorkFacts) => {
    const first = f.attempts[0];
    const iso = first?.wait?.approvedAt ?? f.work.approvedAt ?? first?.startedAt;
    return iso ? at(iso) : undefined;
  };
  const coveredWork = (f: WorkFacts) => {
    const start = startOf(f);
    return (
      recordedFrom !== undefined &&
      start !== undefined &&
      start >= recordedFrom &&
      !gapWorks.has(f.work.id)
    );
  };
  const acceptedActed = accepted.filter((f) => actedOn.has(f.work.id)).length;
  // Отсутствие действия человека известно, если поручение начато после
  // начала записи, без пробела в ней, и у него нет действий без актёра.
  const acceptedUnknown = accepted.filter(
    (f) => !actedOn.has(f.work.id) && (!coveredWork(f) || unattributed.has(f.work.id)),
  ).length;
  const zero = <A extends readonly string[]>(actors: A) =>
    Object.fromEntries(actors.map((a) => [a, 0])) as Record<A[number], number>;
  const recorded =
    recordedFrom === undefined
      ? null
      : (() => {
          const r = {
            from: toIso(recordedFrom),
            bound: 'exact' as 'exact' | 'lower',
            retries: zero(['operator', 'recovery', 'host'] as const),
            resets: zero(['operator', 'recovery', 'host'] as const),
            cancellations: zero(['operator', 'host', 'graph'] as const),
            cancelledWithoutAttempt: 0,
            baseMoves: zero(['operator', 'controller', 'host'] as const),
            baseMovesBound: 'lower' as const,
            gaps: gapInWindow.size,
          };
          for (const e of windowEvents)
            if (e.type === 'work.retried') {
              r.retries[e.payload.by] += 1;
              if (e.payload.reset) r.resets[e.payload.by] += 1;
            } else if (e.type === 'work.cancelled') {
              r.cancellations[e.payload.by] += 1;
              if (!e.payload.hadAttempt) r.cancelledWithoutAttempt += 1;
            } else if (e.type === 'base.moved') r.baseMoves[e.payload.by] += 1;
          // Окно начинается раньше записи: в нём есть попытки или события до неё.
          const before = (ms: number) => ms < recordedFrom;
          if (
            gapInWindow.size > 0 ||
            windowAttempts.some((a) => before(at(a.startedAt))) ||
            windowEvents.some((e) => before(at(e.at))) ||
            accepted.some((f) => before(startOf(f) ?? -Infinity))
          )
            r.bound = 'lower';
          return r;
        })();
  // Сумма — только точная: при нижней границе её нет (`null`), числа по
  // актёрам с границей — в `recorded`. Сдвиги базы — всегда нижняя граница:
  // перенос вне `fencedRefMove` (например, `moveBase` без `move`) не пишется.
  const total = (counts: Record<string, number> | undefined) =>
    counts && recorded?.bound === 'exact' ? sum(Object.values(counts)) : null;
  const escalated = new Set<string>([
    ...[...episodes.values()]
      .filter(
        (r) => (r.status === 'awaiting-user' || r.status === 'stopped') && inWindow(w, r.openedAt),
      )
      .map((r) => r.id),
    ...windowEvents
      .filter(
        (e) =>
          e.type === 'work.recovery' &&
          (e.payload.status === 'awaiting-user' || e.payload.status === 'stopped'),
      )
      .map((e) => (e.type === 'work.recovery' ? e.payload.recoveryId : '')),
  ]);

  // Согласования: по событиям — для графов, у которых события согласования
  // есть; по состоянию графа — для прочих; ни того ни другого — неизвестно.
  const approvalEvents = events.filter((e) => e.type === 'graph.approved');
  const evented = new Set(approvalEvents.map((e) => e.graphId ?? ''));
  let fromEvents = 0;
  let fromState = 0;
  const approvalCount = { operator: 0, agent: 0 };
  for (const e of approvalEvents)
    if (e.type === 'graph.approved' && inWindow(w, e.at)) {
      approvalCount[e.payload.actor] += 1;
      fromEvents += 1;
    }
  for (const g of graphs)
    if (!evented.has(g.id) && g.approval && inWindow(w, g.approval.at)) {
      approvalCount[g.approval.actor] += 1;
      fromState += 1;
    }
  const approvalsKnown = approvalEvents.length > 0 || graphs.some((g) => g.approval);
  const approvals = {
    ...approvalCount,
    source: !approvalsKnown
      ? ('none' as const)
      : fromEvents && fromState
        ? ('mixed' as const)
        : fromState
          ? ('state' as const)
          : ('events' as const),
  };

  // Паузы: каждое `control.paused` до следующего `control.resumed` (открытая — до asOf).
  const pauseRows = new Map<
    PauseReason,
    { count: number; pausedMs: number; open: number; failures: Set<FailureKind> }
  >();
  // Время паузы — пересечение с окном [since, until или asOf); пауза, начатая
  // до окна, входит своим временем внутри окна, но не числом пауз.
  const windowStart = w.since ?? -Infinity;
  const windowEnd = Math.min(w.asOf, w.until ?? w.asOf);
  const rowOf = (reason: PauseReason) => {
    const row = pauseRows.get(reason) ?? { count: 0, pausedMs: 0, open: 0, failures: new Set() };
    pauseRows.set(reason, row);
    return row;
  };
  let openPause: { reason: PauseReason; at: number; inside: boolean } | undefined;
  const closePause = (end: number, open: boolean) => {
    if (!openPause) return;
    const overlap = Math.min(end, windowEnd) - Math.max(openPause.at, windowStart);
    if (overlap > 0 || openPause.inside) {
      const row = rowOf(openPause.reason);
      row.pausedMs += Math.max(0, overlap);
      if (open && openPause.inside) row.open += 1;
    }
  };
  for (const e of events) {
    if (e.type === 'control.paused') {
      closePause(at(e.at), false);
      const inside = inWindow(w, e.at);
      openPause = { reason: e.payload.reason, at: at(e.at), inside };
      if (inside) {
        const row = rowOf(e.payload.reason);
        row.count += 1;
        for (const k of e.payload.failures ?? []) row.failures.add(k);
      }
    } else if (e.type === 'control.resumed' && openPause) {
      closePause(at(e.at), false);
      openPause = undefined;
    }
  }
  if (openPause) closePause(windowEnd, true);
  const pauseOrder: PauseReason[] = [
    'operator',
    'shutdown',
    'runtime',
    'base-check',
    'reconfigure',
  ];
  const pauses = pauseOrder
    .filter((r) => pauseRows.has(r))
    .map((reason) => {
      const row = pauseRows.get(reason)!;
      return {
        reason,
        count: row.count,
        pausedMs: Math.round(row.pausedMs),
        open: row.open,
        failures: [...row.failures].sort(),
      };
    });
  const runtimePauses = windowEvents.filter(
    (e) =>
      e.type === 'control.paused' &&
      e.payload.reason === 'runtime' &&
      (e.payload.failures ?? []).some((k) => bucketOfKind[k] === 'environment'),
  ).length;

  /* Скорость (S1–S6) -------------------------------------------------- */
  const leads = accepted.map(leadOf);
  const leadValues = leads.filter((l) => l.ms !== null).map((l) => l.ms!);
  const depWaits: number[] = [];
  const queueWaits: number[] = [];
  for (const a of windowAttempts) {
    if (a.wait?.approvedAt && a.wait.readyAt) {
      const ms = at(a.wait.readyAt) - at(a.wait.approvedAt);
      if (ms >= 0) depWaits.push(ms);
    }
    if (a.wait?.readyAt) {
      const ms = at(a.startedAt) - at(a.wait.readyAt);
      if (ms >= 0) queueWaits.push(ms);
    }
  }
  const families = new Map<
    string,
    { spans: number[]; accepted: number; rejected: number; incomplete: number }
  >();
  for (const a of windowAttempts)
    for (const t of a.timings ?? []) {
      const family = t.stage.split(':')[0]!;
      const row = families.get(family) ?? { spans: [], accepted: 0, rejected: 0, incomplete: 0 };
      if (!t.finishedAt) row.incomplete += 1;
      else {
        const ms = Math.max(0, at(t.finishedAt) - at(t.startedAt));
        row.spans.push(ms);
        if (a.status === 'succeeded') row.accepted += ms;
        else if (a.status !== 'active') row.rejected += ms;
      }
      families.set(family, row);
    }
  const stagesAll = [...families.entries()]
    .map(([family, r]) => ({
      family: clip(family, 200),
      spans: r.spans.length,
      totalMs: Math.round(sum(r.spans)),
      medianMs: dist(r.spans, 0).median,
      acceptedMs: Math.round(r.accepted),
      rejectedMs: Math.round(r.rejected),
      incomplete: r.incomplete,
    }))
    .sort((a, b) => b.totalMs - a.totalMs || cmp(a.family, b.family));

  const perAccepted = accepted.map((f) => f.attempts.length);
  const buckets = { '1': 0, '2': 0, '3': 0, '4-6': 0, '7+': 0 };
  for (const n of perAccepted)
    buckets[n <= 1 ? '1' : n === 2 ? '2' : n === 3 ? '3' : n <= 6 ? '4-6' : '7+'] += 1;
  const firstPass = accepted.filter(isFirstPass).length;
  const firstPassUnknownCount = accepted.filter(firstPassUnknown).length;
  const firstPassRaw = accepted.filter((f) => f.attempts.length === 1).length;

  /* Стоимость (C1–C6) ------------------------------------------------- */
  const knownCalls = windowCalls.filter(callCostKnown);
  const unknownCalls = windowCalls.filter((c) => !callCostKnown(c));
  const reasonOf = (c: CallRecord) =>
    c.outcome === 'active'
      ? 'active'
      : c.outcome === 'abandoned'
        ? 'abandoned'
        : !c.usage.complete
          ? 'incomplete'
          : 'noPrice';
  const unknownBy = { noPrice: 0, incomplete: 0, active: 0, abandoned: 0 };
  for (const c of unknownCalls) unknownBy[reasonOf(c)] += 1;
  const unknownRuntimes = new Map<string, number>();
  for (const c of unknownCalls)
    unknownRuntimes.set(c.runtime, (unknownRuntimes.get(c.runtime) ?? 0) + 1);
  const knownUsd = sum(knownCalls.map((c) => c.costUsd!));
  const reportedUsd = sum(
    knownCalls.filter((c) => c.costSource === 'provider-reported').map((c) => c.costUsd!),
  );
  const estimatedUsd = sum(
    knownCalls.filter((c) => c.costSource === 'tariff-estimate').map((c) => c.costUsd!),
  );
  const partialAttempts = windowAttempts.filter((a) => !a.callsRecorded);
  const uninstrumented = partialAttempts.length;
  const withoutCalls = partialAttempts.filter((a) => !callsOfRun.has(a.id)).length;
  const spendBound: ReportMeasure['bound'] =
    accepted.length === 0 ||
    (knownCalls.length === 0 &&
      (unknownCalls.length > 0 || uninstrumented > 0 || windowCalls.length === 0))
      ? 'unknown'
      : unknownCalls.length > 0 || uninstrumented > 0 || !windowCalls.every(callComplete)
        ? 'lower'
        : 'exact';
  const perAcceptedUsd = measure(
    spendBound === 'unknown' ? null : round2(knownUsd / accepted.length),
    accepted.length,
    unknownCalls.length + uninstrumented,
    spendBound,
  );
  // Все завершённые попытки окна: и без полного учёта (их расход — нижняя граница).
  const attemptCosts = windowAttempts
    .filter((a) => a.status !== 'active')
    .map((a) => ({ a, cost: attemptCost(a) }));
  const attemptsBound = (list: typeof attemptCosts): ReportMeasure['bound'] =>
    list.every(({ cost }) => cost.complete)
      ? 'exact'
      : list.some(({ cost }) => cost.usd > 0 || cost.calls > cost.unknown)
        ? 'lower'
        : list.length
          ? 'unknown'
          : 'exact';
  const fullyPriced = attemptCosts.filter(({ cost }) => cost.complete && cost.unknown === 0);
  // Прерванная штатной остановкой попытка не отклонена: следующая продолжает её работу.
  const rejectedCosts = attemptCosts.filter(
    ({ a }) => a.status !== 'succeeded' && a.interrupted !== 'shutdown',
  );
  const bucketUsd = new Map<FailureBucket, number>();
  for (const { a, cost } of rejectedCosts) {
    const b = failureBucketOf(a);
    if (b) bucketUsd.set(b, (bucketUsd.get(b) ?? 0) + cost.usd);
  }
  const stageRows = new Map<string, { calls: number; knownUsd: number; unknownCalls: number }>();
  for (const c of windowCalls) {
    const row = stageRows.get(c.stage) ?? { calls: 0, knownUsd: 0, unknownCalls: 0 };
    row.calls += 1;
    if (callCostKnown(c)) row.knownUsd += c.costUsd!;
    else row.unknownCalls += 1;
    stageRows.set(c.stage, row);
  }
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, incompleteCalls: 0 };
  for (const c of windowCalls) {
    tokens.input += c.usage.inputTokens ?? 0;
    tokens.output += c.usage.outputTokens ?? 0;
    tokens.cacheRead += c.usage.cacheReadTokens ?? 0;
    tokens.cacheWrite += c.usage.cacheWriteTokens ?? 0;
    if (!c.usage.complete) tokens.incompleteCalls += 1;
  }

  /* Окружение (E1–E5) ------------------------------------------------- */
  const bucketCounts = new Map<FailureBucket, number>();
  for (const a of failedAttempts) {
    const b = failureBucketOf(a);
    if (b) bucketCounts.set(b, (bucketCounts.get(b) ?? 0) + 1);
  }
  const interrupted = failedAttempts.filter((a) => a.interrupted === 'shutdown').length;
  const failedTotal = failedAttempts.length - interrupted;
  const unclassifiedOrUnknown =
    (bucketCounts.get('unknown') ?? 0) + (bucketCounts.get('unclassified') ?? 0);
  const classified = failedTotal - unclassifiedOrUnknown;
  const envAttempts = failedAttempts.filter((a) => failureBucketOf(a) === 'environment');
  const envCount = envAttempts.length;
  const setupCheckFailures = failedAttempts.filter(setupOnlyFailure).length;
  // Подпричины окружения (E3): `attempt.diagnosed` той же попытки; отказ
  // без события записан до версии, которая их пишет.
  const diagnosisOf = new Map<string, RunEventPayload<'attempt.diagnosed'>>();
  for (const e of events)
    if (e.type === 'attempt.diagnosed' && e.runId) diagnosisOf.set(e.runId, e.payload);
  const causes = diagnosisOf.size
    ? (() => {
        const rows = new Map<EnvironmentCause, { count: number; counted: number }>();
        let undiagnosed = 0;
        for (const a of envAttempts) {
          const d = diagnosisOf.get(a.id);
          if (!d) {
            undiagnosed += 1;
            continue;
          }
          const row = rows.get(d.cause) ?? { count: 0, counted: 0 };
          row.count += 1;
          if (d.counted) row.counted += 1;
          rows.set(d.cause, row);
        }
        return {
          rows: [...rows.entries()]
            .map(([cause, r]) => ({ cause, count: r.count, counted: r.counted }))
            .sort((x, y) => y.count - x.count || cmp(x.cause, y.cause)),
          diagnosed: envAttempts.length - undiagnosed,
          undiagnosed,
          bound: undiagnosed ? ('lower' as const) : ('exact' as const),
        };
      })()
    : null;
  const rechecks = { flaky: 0, confirmed: 0 };
  for (const { e } of windowEvidence) if (e.recheck) rechecks[e.recheck.outcome] += 1;

  const sentBackCount = { defect: 0, setup: 0, unknown: 0, no: 0 };
  for (const f of accepted) sentBackCount[sentBack(f)] += 1;

  /* Недели (T1–T2) ---------------------------------------------------- */
  const weekly = weeksOf({
    w,
    attempts: windowAttempts,
    accepted: accepted.map((f) => ({
      at: f.acceptedAt,
      firstPass: isFirstPass(f),
      lead: leadOf(f).ms,
    })),
    calls: windowCalls,
  });

  /* Таблица поручений ------------------------------------------------- */
  const rowsAll = finished
    .slice()
    .sort((a, b) => timeOrder(b.finishedAt, a.finishedAt) || cmp(a.work.id, b.work.id));
  const workRows = rowsAll.slice(0, reportLimits.works).map((f) => {
    const cost = workCost(f);
    const rejections = new Map<FailureBucket, number>();
    for (const a of f.attempts) {
      const b = failureBucketOf(a);
      if (b) rejections.set(b, (rejections.get(b) ?? 0) + 1);
    }
    return {
      id: f.work.id,
      ...(options.noTitles ? {} : { title: clip(f.work.order.title, 180) }),
      outcome: f.outcome!,
      finishedAt: f.finishedAt ? toIso(at(f.finishedAt)) : null,
      attempts: f.attempts.length,
      counted: f.attempts.filter(counted).length,
      leadMs: f.outcome === 'accepted' ? leadOf(f).ms : null,
      knownUsd: cost.usd,
      unknownCalls: cost.unknown,
      costBound: cost.bound,
      rejections: failureBucketNames
        .filter((b) => rejections.has(b))
        .map((b) => ({ key: b, count: rejections.get(b)! })),
    };
  });

  /* Покрытие ------------------------------------------------------------ */
  const engineSet = [
    ...new Set(windowAttempts.map((a) => a.engineVersion).filter((x): x is string => !!x)),
  ].sort();
  const coverage = {
    works: new Set(windowAttempts.map((a) => a.workId)).size,
    attempts: windowAttempts.length,
    failed: failedTotal,
    withFailureKind: failedAttempts.filter(
      (a) => a.interrupted !== 'shutdown' && (a.failureKind || a.blocked),
    ).length,
    withTimings: windowAttempts.filter((a) => a.timings?.length).length,
    withCalls: windowAttempts.filter((a) => a.callsRecorded).length,
    withWait: windowAttempts.filter((a) => a.wait?.approvedAt).length,
    doneWithoutAttempt: facts.filter((f) => f.outcome === 'accepted' && !f.accepting).length,
    withEngineVersion: windowAttempts.filter((a) => a.engineVersion).length,
    engines: engineSet.slice(0, 20).map((e) => clip(e, 200)),
    enginesTruncated: engineSet.length > 20,
    calls: windowCalls.length,
    reviews: windowReviews.length,
    events: windowEvents.length,
    eventsFrom: events[0]?.at ? toIso(at(events[0].at)) : null,
  };

  const report: ValueReport = {
    reportVersion: reportVersion,
    harnessVersion: options.harnessVersion ?? 'unknown',
    label: options.noTitles || !options.label ? null : clip(options.label, 200),
    window: {
      since: w.since === undefined ? null : toIso(w.since),
      until: w.until === undefined ? null : toIso(w.until),
      asOf: toIso(w.asOf),
    },
    enoughData: accepted.length >= 3,
    coverage,
    summary: { status: 'ok', headlines: [] },
    defects: {
      rejected: defectAttempts.length,
      byKind,
      byPhase,
      sentBack: measure(
        sentBackCount.defect + sentBackCount.setup,
        accepted.length,
        sentBackCount.unknown,
        sentBackCount.unknown && sentBackCount.setup
          ? 'unknown'
          : sentBackCount.unknown
            ? 'lower'
            : sentBackCount.setup
              ? 'upper'
              : 'exact',
      ),
      sentBackSetupOnly: sentBackCount.setup,
      sentBackRange: {
        min: sentBackCount.defect,
        max: sentBackCount.defect + sentBackCount.setup + sentBackCount.unknown,
      },
      byGate: byGate.slice(0, reportLimits.rows),
      byGateTruncated: byGate.length > reportLimits.rows,
      reviews: reviewsBlock,
      afterGreenGates: measure(greenRejected, green, 0, 'exact'),
      integration: byPhase.integration,
      planContract: {
        rounds: windowReviews.length,
        rejected: windowReviews.filter((r) => !r.approved).length,
        plans: kindRounds('plan'),
        contracts: kindRounds('contract'),
        blockingClosed: pcStatuses.filter((s) => s === 'closed').length,
        blockingOpen: pcStatuses.filter((s) => s === 'open').length,
        blockingWithdrawn: pcStatuses.filter((s) => s === 'withdrawn').length,
      },
      withdrawn: measure(
        withStatus.filter((s) => s === 'withdrawn').length,
        withStatus.length,
        statuses.length - withStatus.length + withoutId,
        withStatus.length ? 'exact' : 'unknown',
      ),
      items,
      itemsTotal: allItems.length,
      itemsTruncated: allItems.length > items.length,
    },
    autonomy: {
      withAction: measure(
        acceptedActed,
        accepted.length,
        recorded ? acceptedUnknown : 0,
        !accepted.length ? 'unknown' : !recorded || acceptedUnknown ? 'lower' : 'exact',
      ),
      // Без записанного актёра повторов, сбросов и сдвигов базы «без действий
      // человека» не измерить: значение неизвестно, а не верхняя граница N.
      // С записью — нижняя граница, пока есть поручения, начатые до неё.
      withoutAction: recorded
        ? measure(
            accepted.length - acceptedActed - acceptedUnknown,
            accepted.length,
            acceptedUnknown,
            !accepted.length ? 'unknown' : acceptedUnknown ? 'lower' : 'exact',
          )
        : measure(null, accepted.length, accepted.length, 'unknown'),
      actions: {
        operatorDecisions: operatorDecisions.length,
        holds: holds.length,
        cancelledAttempts: cancelledAttempts.length,
        retries: total(recorded?.retries),
        resets: total(recorded?.resets),
        baseMoves: null,
        recorded,
      },
      approvals,
      pauses,
      escalations: escalated.size,
    },
    speed: {
      leadTime: dist(leadValues, leads.length - leadValues.length),
      leadTimeFallback: leads.filter((l) => l.ms !== null && l.fallback).length,
      dependencyWait: dist(depWaits, 0),
      queueWait: dist(queueWaits, 0),
      stages: stagesAll.slice(0, reportLimits.rows),
      stagesTruncated: stagesAll.length > reportLimits.rows,
      firstPass: measure(
        firstPass,
        accepted.length,
        firstPassUnknownCount,
        firstPassUnknownCount ? 'lower' : 'exact',
      ),
      firstPassRaw: measure(firstPassRaw, accepted.length, 0, 'exact'),
      finished: {
        accepted: finished.filter((f) => f.outcome === 'accepted').length,
        failed: finished.filter((f) => f.outcome === 'failed').length,
        cancelled: finished.filter((f) => f.outcome === 'cancelled').length,
      },
      attemptsPerAccepted: {
        n: perAccepted.length,
        buckets,
        median: perAccepted.length >= 5 ? dist(perAccepted, 0, false).median : null,
        mean: perAccepted.length ? round2(sum(perAccepted) / perAccepted.length) : null,
      },
      attemptsOnOther: windowAttempts.filter((a) => !acceptedIds.has(a.workId)).length,
      machineTime: dist(
        accepted.map((f) => machineOf(f.attempts)),
        0,
      ),
    },
    cost: {
      calls: windowCalls.length,
      knownCalls: knownCalls.length,
      knownUsd: round2(knownUsd),
      reportedUsd: round2(reportedUsd),
      estimatedUsd: round2(estimatedUsd),
      unknown: {
        total: unknownCalls.length,
        ...unknownBy,
        byRuntime: [...unknownRuntimes.entries()]
          .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
          .slice(0, 20)
          .map(([runtime, n]) => ({ runtime: clip(runtime, 200), calls: n })),
      },
      attemptsWithoutCalls: withoutCalls,
      attemptsPartialCalls: uninstrumented - withoutCalls,
      perAccepted: perAcceptedUsd,
      perAttempt: dist(
        fullyPriced.map(({ cost }) => cost.usd),
        attemptCosts.length - fullyPriced.length,
        false,
      ),
      rejected: {
        bound: attemptsBound(attemptCosts),
        usd: round2(sum(rejectedCosts.map(({ cost }) => cost.usd))),
        totalUsd: round2(sum(attemptCosts.map(({ cost }) => cost.usd))),
        attempts: attemptCosts.length,
        byBucket: failureBucketNames
          .filter((b) => bucketUsd.has(b))
          .map((b) => ({ bucket: b, usd: round2(bucketUsd.get(b)!) })),
      },
      byStage: [...stageRows.entries()]
        .map(([stage, r]) => ({
          stage: clip(stage, 200),
          calls: r.calls,
          knownUsd: round2(r.knownUsd),
          unknownCalls: r.unknownCalls,
        }))
        .sort((a, b) => b.knownUsd - a.knownUsd || b.calls - a.calls || cmp(a.stage, b.stage))
        .slice(0, reportLimits.rows),
      tokens,
    },
    environment: {
      failed: failedTotal,
      classified,
      interrupted,
      buckets: failureBucketNames.map((b) => ({ bucket: b, count: bucketCounts.get(b) ?? 0 })),
      share: measure(
        envCount,
        classified,
        unclassifiedOrUnknown,
        !classified ? 'unknown' : setupCheckFailures ? 'lower' : 'exact',
      ),
      setupCheckFailures,
      timeLimit: bucketCounts.get('time-limit') ?? 0,
      causes,
      neutral: {
        // Тот же расход, что у корзины `environment` раздела расходов.
        costBound: attemptsBound(attemptCosts.filter(({ a }) => envAttempts.includes(a))),
        attempts: envCount,
        blocked: envAttempts.filter((a) => a.blocked).length,
        machineMs: Math.round(machineOf(envAttempts)),
        knownUsd: round2(bucketUsd.get('environment') ?? 0),
        runtimePauses,
      },
      rechecks,
    },
    weeks: weekly,
    ...(input.inputRequests ? { inputs: inputCounts(input.inputRequests, windowAttempts, w) } : {}),
    works: { rows: workRows, total: rowsAll.length, truncated: rowsAll.length > workRows.length },
    limitations: [],
  };
  report.summary = summaryOf(report, failedAttempts.length);
  report.limitations = limitationsOf(report);
  assertReportBytes(JSON.stringify(report), reportLimits.jsonBytes, 'JSON');
  return report;
}

/**
 * Предел размера отчёта (`REPORT_LIMITS`): его обеспечивают пределы списков,
 * поэтому превышение — дефект harness (`INTERNAL`), а не усечение молча.
 */
export function assertReportBytes(text: string, limit: number, what: string) {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > limit)
    throw new HarnessError(
      'INTERNAL',
      `Отчёт ${what}: ${bytes} байт больше предела ${limit}; пределы списков нарушены (дефект harness)`,
    );
}

/* ------------------------------------------------------------------ */
/* Недели                                                              */
/* ------------------------------------------------------------------ */

/** Понедельник недели (UTC) в мс. */
const mondayOf = (ms: number) => {
  const day = Math.floor(ms / DAY);
  // 1970-01-01 — четверг: смещение до понедельника.
  return (day - ((day + 3) % 7)) * DAY;
};

/** ISO-неделя `2026-W44` по понедельнику (UTC). */
export function isoWeekOf(ms: number): string {
  const thursday = new Date(mondayOf(ms) + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / WEEK) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function weeksOf(input: {
  w: Window;
  attempts: readonly AttemptState[];
  accepted: readonly { at: string | undefined; firstPass: boolean; lead: number | null }[];
  calls: readonly CallRecord[];
}): ValueReport['weeks'] {
  interface Acc {
    attempts: number;
    accepted: number;
    firstPass: number;
    defects: number;
    environment: number;
    knownUsd: number;
    unknownCalls: number;
    leads: number[];
    engines: Set<string>;
  }
  const weeks = new Map<number, Acc>();
  const acc = (iso: string) => {
    const key = mondayOf(at(iso));
    let row = weeks.get(key);
    if (!row) {
      row = {
        attempts: 0,
        accepted: 0,
        firstPass: 0,
        defects: 0,
        environment: 0,
        knownUsd: 0,
        unknownCalls: 0,
        leads: [],
        engines: new Set(),
      };
      weeks.set(key, row);
    }
    return row;
  };
  for (const a of input.attempts) {
    const row = acc(a.startedAt);
    row.attempts += 1;
    row.engines.add(a.engineVersion ?? 'unknown');
    const b = failureBucketOf(a);
    if (b === 'defect') row.defects += 1;
    if (b === 'environment') row.environment += 1;
  }
  for (const f of input.accepted) {
    if (!f.at) continue;
    const row = acc(f.at);
    row.accepted += 1;
    if (f.firstPass) row.firstPass += 1;
    if (f.lead !== null) row.leads.push(f.lead);
  }
  for (const c of input.calls) {
    const row = acc(c.startedAt);
    if (callCostKnown(c)) row.knownUsd += c.costUsd!;
    else row.unknownCalls += 1;
  }
  const keys = [...weeks.keys()].sort((a, b) => b - a);
  const shown = keys.slice(0, reportLimits.weeks);
  const older = keys.slice(reportLimits.weeks);
  const rows: ValueReport['weeks']['rows'] = [];
  shown.forEach((key, i) => {
    const row = weeks.get(key)!;
    const previous = shown[i + 1] ?? older[0];
    const prevEngines = previous === undefined ? undefined : weeks.get(previous)!.engines;
    const engines = [...row.engines].sort();
    rows.push({
      kind: 'week',
      week: isoWeekOf(key),
      attempts: row.attempts,
      accepted: row.accepted,
      firstPass: row.firstPass,
      defects: row.defects,
      environment: row.environment,
      knownUsd: round2(row.knownUsd),
      unknownCalls: row.unknownCalls,
      leadMedianMs: row.leads.length >= 5 ? dist(row.leads, 0).median : null,
      engines: engines.slice(0, 5),
      enginesTruncated: engines.length > 5,
      engineChanged:
        prevEngines !== undefined &&
        (prevEngines.size !== row.engines.size || engines.some((e) => !prevEngines.has(e))),
    });
    const next = shown[i + 1];
    if (next !== undefined && key - next > WEEK)
      rows.push({ kind: 'gap', from: isoWeekOf(next + WEEK), to: isoWeekOf(key - WEEK) });
  });
  const total = (pick: (r: Acc) => number) => sum(older.map((k) => pick(weeks.get(k)!)));
  return {
    rows,
    earlier: older.length
      ? {
          kind: 'earlier',
          from: isoWeekOf(older.at(-1)!),
          to: isoWeekOf(older[0]!),
          weeks: older.length,
          attempts: total((r) => r.attempts),
          accepted: total((r) => r.accepted),
          firstPass: total((r) => r.firstPass),
          defects: total((r) => r.defects),
          environment: total((r) => r.environment),
          knownUsd: round2(total((r) => r.knownUsd)),
          unknownCalls: total((r) => r.unknownCalls),
        }
      : null,
    active: keys.length,
  };
}

/* ------------------------------------------------------------------ */
/* Сводка и ограничения                                                */
/* ------------------------------------------------------------------ */

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function summaryOf(r: ValueReport, failedAttempts: number): ValueReport['summary'] {
  const n = r.speed.attemptsPerAccepted.n;
  const window = formatWindow(r.window);
  if (!r.enoughData)
    return {
      status: 'not-enough-data',
      text: `Not enough data yet: ${plural(n, 'task')} accepted in the window (${window}); the summary needs at least 3.`,
      accepted: n,
      attempts: r.coverage.attempts,
      failedAttempts,
      works: r.coverage.works,
    };
  const fp = r.speed.firstPass;
  const sb = r.defects.sentBack;
  const lead = r.speed.leadTime;
  const spend = r.cost.perAccepted;
  const env = r.environment.share;
  const pct = (k: number, of: number) => (of >= 20 ? ` (${Math.round((k * 100) / of)}%)` : '');
  const leadValue =
    lead.median !== null
      ? formatDuration(lead.median)
      : lead.values.length
        ? lead.values.map(formatDuration).join(', ')
        : 'unknown';
  const unpriced = r.cost.unknown.total;
  const withoutCalls = r.cost.attemptsWithoutCalls;
  const partialCalls = r.cost.attemptsPartialCalls;
  const spendWhy = [
    unpriced ? plural(unpriced, 'call') + ' without a known price' : '',
    withoutCalls ? plural(withoutCalls, 'attempt') + ' without call records' : '',
    partialCalls ? plural(partialCalls, 'attempt') + ' with possibly incomplete call records' : '',
  ]
    .filter(Boolean)
    .join(', ');
  const spendValue = formatMeasureUsd(spend);
  const range = r.defects.sentBackRange;
  const sentBackValue =
    sb.bound === 'unknown' ? `${range.min}–${range.max} of ${sb.n}` : formatMeasureRatio(sb);
  return {
    status: 'ok',
    headlines: [
      {
        id: 'accepted',
        value: String(n),
        text:
          fp.bound === 'lower'
            ? `${plural(n, 'task')} accepted. At least ${fp.value} of them${pct(fp.value ?? 0, n)} on the first try; for ${plural(fp.unknown, 'more task')} it is unknown (failures without a class).`
            : `${plural(n, 'task')} accepted. ${fp.value} of them${pct(fp.value ?? 0, n)} on the first try.`,
        basis: `Accepted: merged after all required checks and an independent review. First try: the accepting attempt was the only counted attempt (environment failures except stalls, blocked-before-work attempts, expired leases and shutdowns are not counted). Window: ${window}.`,
        measure: fp,
      },
      {
        id: 'sent-back',
        value: sentBackValue,
        text: `${sb.bound === 'lower' ? 'At least ' : sb.bound === 'upper' ? 'At most ' : sb.bound === 'unknown' ? 'Between ' : ''}${sb.bound === 'unknown' ? `${range.min} and ${range.max} of ${sb.n}` : formatRatio(sb.value ?? 0, sb.n)} accepted tasks were sent back by checks, review or the scope rule before merge${sb.unknown ? `; ${plural(sb.unknown, 'task')} had only failures without a class before merge` : ''}. Nothing merged without passing every required check and review.`,
        basis: `An attempt rejected as gate, review or scope-violation before the accepting attempt.${r.defects.sentBackSetupOnly ? ` ${plural(r.defects.sentBackSetupOnly, 'task')} counted only through setup-check failures, which may be network or registry errors.` : ''}${sb.bound === 'exact' ? '' : sb.bound === 'lower' ? ' Failures without a class are not counted, so this is a lower bound.' : sb.bound === 'upper' ? ' So this is an upper bound.' : ' Both caveats apply, so a range is shown.'}`,
        measure: sb,
      },
      {
        id: 'lead-time',
        value: leadValue,
        text:
          lead.median !== null
            ? `From approval to merge: median ${leadValue} (n=${lead.n}).`
            : `From approval to merge: ${leadValue} (n=${lead.n}; no median under 5).`,
        basis: `Wall clock from the first attempt's approval to the accepting attempt, including queue waits and pauses.${r.speed.leadTimeFallback ? ` ${plural(r.speed.leadTimeFallback, 'task')} used the task approval time because the first attempt has no wait record.` : ''}${lead.unknown ? ` ${plural(lead.unknown, 'task')} could not be measured.` : ''}`,
        measure: measure(lead.median, lead.n, lead.unknown, lead.n ? 'exact' : 'unknown'),
      },
      {
        id: 'spend',
        value: spendValue,
        text:
          spend.bound === 'unknown'
            ? `Spend per accepted task is unknown${spendWhy ? ` (${spendWhy})` : ''}.`
            : spend.bound === 'exact'
              ? `Spend per accepted task ${spendValue}: every call has a known price.`
              : `Known spend ${spendValue} per accepted task${spendWhy ? ` (${spendWhy}${unpriced ? ': configure prices' : ''})` : ''}.`,
        basis: `Known spend ${formatUsd(r.cost.knownUsd)} over ${plural(r.cost.calls, 'call')} in the window (plans, contracts, implementation and review) divided by ${plural(n, 'accepted task')}.`,
        measure: spend,
      },
      {
        id: 'environment',
        value: formatMeasureRatio(env),
        text:
          env.value === null
            ? 'No classified failed attempts in the window.'
            : env.bound === 'lower'
              ? `At least ${formatRatio(env.value, env.n)} classified failed attempts were caused by the environment; ${plural(r.environment.setupCheckFailures, 'more failure')} in setup checks may be environment too.`
              : `${formatRatio(env.value, env.n)} classified failed attempts were caused by the environment, not your code.`,
        basis: `Environment: sandbox, network, provider access and expired leases. ${plural(r.environment.timeLimit, 'time-limit failure')} (ambiguous) and ${plural(env.unknown, 'unknown or unclassified failure')} are not distributed.`,
        measure: env,
      },
    ],
  };
}

function limitationsOf(r: ValueReport): ValueReport['limitations'] {
  const recorded = r.autonomy.actions.recorded;
  const causes = r.environment.causes;
  const out: ValueReport['limitations'] = [
    {
      id: 'no-baseline',
      text: 'There is no before-harness baseline: the report does not compare with work done without the harness.',
    },
    ...(recorded === null
      ? [
          {
            id: 'actions-not-recorded',
            text: 'Human actions are counted only where a person is recorded as the actor (operator recovery decisions); retries, resets, cancellations and base moves have no recorded actor yet, so tasks that needed no human action are not measurable yet.',
          },
        ]
      : []),
    {
      id: 'check-network',
      text: 'Network or registry errors inside checks are classified as check failures, so rejections by checks can be overstated; setup checks are marked.',
    },
    ...(causes === null
      ? [
          {
            id: 'environment-cause',
            text: 'Environment failures have no recorded sub-cause (sandbox, network, provider, lease).',
          },
        ]
      : []),
    {
      id: 'reviewer-precision',
      text: 'A rejected candidate is not proof of a real defect: reviewer precision is not measured; withdrawn findings are only a proxy.',
    },
    {
      id: 'escaped-defects',
      text: 'Defects found after merge and human time outside the tool are not visible to the harness.',
    },
  ];
  const c = r.coverage;
  const add = (id: string, cond: boolean, text: string) => {
    if (cond) out.push({ id, text });
  };
  if (recorded) {
    const unknown = r.autonomy.withoutAction.unknown;
    add(
      'actions-from',
      recorded.bound === 'lower',
      `Retries, resets, cancellations and base moves are recorded with their actor from ${recorded.from}; the window has activity before that, so action counts are lower bounds.`,
    );
    add(
      'actions-unknown',
      unknown > 0,
      `${plural(unknown, 'accepted task')} started before actions were recorded, ${unknown === 1 ? 'was' : 'were'} held, or ${unknown === 1 ? 'was' : 'were'} retried or cancelled by the host without a named actor, so tasks that needed no human action are a lower bound.`,
    );
    add(
      'recording-gap',
      recorded.gaps > 0,
      `${plural(recorded.gaps, 'task')} got a new attempt after a failure or cancellation without a recorded retry (an older version ran in between, for example after a rollback); actions there are not recorded.`,
    );
    out.push({
      id: 'base-moves',
      text: 'Base moves are a lower bound: moves outside the fenced path are not recorded; they are not attributed to tasks.',
    });
    out.push({
      id: 'rollback-gap',
      text: 'If an older version ran after recording began (rollback and re-upgrade), its retries, cancellations and base moves are not recorded; only gaps that left a new attempt without a retry are detected.',
    });
  }
  if (causes)
    add(
      'environment-cause-from',
      causes.undiagnosed > 0,
      `${plural(causes.undiagnosed, 'environment failure')} recorded before sub-causes were recorded ${causes.undiagnosed === 1 ? 'has' : 'have'} no sub-cause; sub-causes are shown for the rest.`,
    );
  const unclassified = r.environment.buckets.find((b) => b.bucket === 'unclassified')!.count;
  add(
    'unclassified',
    unclassified > 0,
    `${plural(unclassified, 'failed attempt')} without a failure class (recorded before classification) ${unclassified === 1 ? 'is' : 'are'} shown as unclassified, not as defects.`,
  );
  add(
    'timings',
    c.attempts > c.withTimings,
    `${c.attempts - c.withTimings} of ${c.attempts} attempts have no stage timings; stage time covers the rest.`,
  );
  add(
    'calls',
    r.cost.attemptsWithoutCalls > 0,
    `${r.cost.attemptsWithoutCalls} of ${c.attempts} attempts have no call records, so their spend is unknown.`,
  );
  add(
    'partial-calls',
    r.cost.attemptsPartialCalls > 0,
    `${r.cost.attemptsPartialCalls} of ${c.attempts} attempts have call records that are not marked complete; their spend is a lower bound.`,
  );
  add(
    'done-without-attempt',
    c.doneWithoutAttempt > 0,
    `${plural(c.doneWithoutAttempt, 'done task')} without a succeeded attempt ${c.doneWithoutAttempt === 1 ? 'has' : 'have'} no acceptance time and ${c.doneWithoutAttempt === 1 ? 'is' : 'are'} not counted as accepted.`,
  );
  add(
    'holds-actor',
    r.autonomy.actions.holds + (recorded ? 0 : r.autonomy.actions.cancelledAttempts) > 0,
    recorded
      ? 'Holds record no actor (host operations hold tasks too): they are not counted as human actions, and held tasks are counted as unknown, not as needing no human action.'
      : 'Holds and cancelled attempts record no actor (host operations hold tasks too), so they are not counted as human actions.',
  );
  add(
    'approvals-unknown',
    r.autonomy.approvals.source === 'none',
    'No approval records: plan approvals are unknown, not zero.',
  );
  add(
    'prices',
    r.cost.unknown.total > 0,
    `${r.cost.unknown.total} of ${r.cost.calls} calls have no known price (no tariff ${r.cost.unknown.noPrice}, incomplete telemetry ${r.cost.unknown.incomplete}, active ${r.cost.unknown.active}, abandoned ${r.cost.unknown.abandoned}); spend is a lower bound.`,
  );
  add(
    'lead-fallback',
    r.speed.leadTimeFallback > 0,
    `${plural(r.speed.leadTimeFallback, 'accepted task')} started from the task approval time, which a re-approval overwrites.`,
  );
  add(
    'events',
    c.eventsFrom === null,
    `No events are recorded: pauses are not shown${r.autonomy.approvals.source === 'none' ? ', approvals are unknown' : ''}.`,
  );
  add(
    'events-from',
    c.eventsFrom !== null && (r.window.since === null || c.eventsFrom > r.window.since),
    `${r.autonomy.approvals.source === 'events' || r.autonomy.approvals.source === 'mixed' ? 'Pauses and approvals are' : 'Pauses are'} counted from events, which start at ${c.eventsFrom}.`,
  );
  add(
    'engines',
    c.engines.length > 1 || (c.withEngineVersion < c.attempts && c.withEngineVersion > 0),
    `Several engine versions in the window (${c.engines.join(', ')}${c.withEngineVersion < c.attempts ? ', unknown' : ''}): weeks where the version changed are marked.`,
  );
  add(
    'small-sample',
    r.speed.leadTime.n > 0 && r.speed.leadTime.n < 5,
    'Fewer than 5 values: medians are not shown, the values are listed.',
  );
  add(
    'works-truncated',
    r.works.truncated,
    `The task table shows the newest ${r.works.rows.length} of ${r.works.total} tasks.`,
  );
  add(
    'items-truncated',
    r.defects.itemsTruncated,
    `Rejection evidence shows the newest ${r.defects.items.length} of ${r.defects.itemsTotal} items.`,
  );
  add(
    'weeks-folded',
    r.weeks.earlier !== null,
    `Weeks before the newest ${r.weeks.rows.filter((x) => x.kind === 'week').length} active weeks are folded into one row.`,
  );
  return out;
}
