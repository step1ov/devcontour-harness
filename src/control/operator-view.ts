// Загрузчик представления оператора для node (`harness view`): политика,
// снимок состояния (`status --detail` и записи хранилища одним `read`),
// сверка принятого с target ref (git), манифест проекта рядом с политикой.
// Числа берутся из тех же функций, что у `status` и `report`; проекция
// (`operatorView`, `workDetailView`) только раскладывает и маскирует.
// Только чтение: каталог состояния не создаётся и не пишется.

import { resourcesInputOf } from './view-resources.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { z } from 'zod';
import {
  DEFAULT_INPUT_POLICY,
  DEFAULT_STALL_SWEEP,
  HarnessError,
  STATE_VERSION,
  WORKSPACE_OWNER,
  executionPolicySchema,
  escalatedFindings,
  findingCounts,
  leadMayAnswer,
  policyDigest,
  PROJECT_MANIFEST_PATH,
  HARNESS_PROJECT_DIR,
  type SetupProgress,
  projectManifestSchema,
  reviewVerdictText,
  type ExecutionPolicy,
  type ExecutionView,
  type InputRequest,
  type CallRecord,
  type CodeReviewRecord,
  type ReviewRecord,
  type statusDataSchema,
  type AttemptState,
  type RunEvent,
  type WorkState,
} from '../contracts/index.ts';
import { HARNESS_VERSION } from '../package.ts';
import {
  attemptCounted,
  callCostKnown,
  currentRevisionAttempts,
  failureBucketOf,
  interruptedByShutdown,
} from '../report/compute.ts';
import { failurePlainOf } from '../report/failure-plain.ts';
import { notLaunched, reviewFacts } from '../report/verification.ts';
import { callRecords } from '../engine/usage.ts';
import { legacyGroupCall } from '../engine/budget.ts';
import { requestsOf } from '../engine/input-requests.ts';
import { attemptLine, type AttemptLineFacts } from '../contracts/attempt-line.ts';
import { named, type LinePart } from '../projections/clip.ts';
import { inputStateOf } from '../projections/input.ts';
import { explainStop } from '../projections/stop.ts';
import { diagnosisRequired, workTrack } from '../projections/track.ts';
import { recoveryPolicyOf, type RecoveryPolicy } from '../projections/decisions.ts';
import { blockingRequest } from '../engine/input-requests.ts';
import { stopInputsIn } from '../explain/state.ts';
import { policySecrets } from '../environment/redaction.ts';
import {
  operatorView,
  setupView,
  workDetailView,
  type SetupView,
  type OperatorActivityInput,
  type OperatorDecisionInput,
  type OperatorReviewInput,
  type OperatorSourceInput,
  type OperatorView,
  type OperatorViewInput,
  type OperatorViewOptions,
  type OperatorWorkInput,
  type WorkDetailView,
} from '../projections/operator-view.ts';
import { Engine } from '../engine/engine.ts';
import { standaloneHost } from '../engine/standalone.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';
import { Harness } from './harness.ts';
import { carriedInput, statusOf } from './status.ts';
import { acceptedTargets } from './target.ts';
import { WorkflowQueue } from './workflow.ts';
import { reviewRoundCap, strictReviewRoundCap } from './review.ts';
import { LIGHT_ROUNDS_EN, reviewSubjectSummary, subjectRoundBudget } from './review-summary.ts';
import { stageOfStep } from './stage.ts';
import { setupProgress } from './setup-progress.ts';
import { cachedUpdates, installedHarness, loadUpdatesConfig } from '../update/check.ts';
import type { PreviewView, UpdatesView } from '../projections/operator-view.ts';
import { livePreviews } from './preview.ts';

type StatusData = z.output<typeof statusDataSchema>;
/** Поручение `status`; поля alpha.55 (`verification`, `lastFailure`, `plain`) — по наличию. */
type StatusWork = StatusData['works'][number] & {
  verification?: OperatorWorkInput['verification'];
};

/** Политика представления и откуда она взята. */
export interface ViewPolicy {
  policy: ExecutionPolicy;
  baseDir: string;
  /** Политика файла (`--policy`) до подстановки умолчаний; нет — привязанная. */
  raw?: unknown;
  warnings: { code: string; message: string; messageEn: string }[];
}

const readJson = (path: string, what: string): unknown => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new HarnessError(
      'INVALID_INPUT',
      `${what}: файл недоступен: ${(error as Error).message}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new HarnessError(
      'INVALID_INPUT',
      `${what}: невалидный JSON: ${(error as Error).message}`,
    );
  }
};

const parsePolicy = (value: unknown, what: string) => {
  const r = executionPolicySchema.safeParse(value);
  if (r.success) return r.data;
  throw new HarnessError(
    'INVALID_INPUT',
    `${what}: вход не прошёл проверку схемы`,
    r.error.issues.map((i) => ({
      path: [what, ...(i.path as (string | number)[])],
      message: i.message,
    })),
  );
};

/**
 * Политика представления: `--policy`, иначе привязанная к состоянию.
 * Нет ни той, ни другой — `POLICY_REQUIRED`; обе и разные — предупреждение
 * `POLICY_DIGEST_MISMATCH` (представление строится по `--policy`).
 */
export function viewPolicy(stateDir: string, policyPath?: string): ViewPolicy {
  const bindingFile = join(stateDir, 'binding.json');
  const bound = existsSync(bindingFile)
    ? (() => {
        const raw = readJson(bindingFile, 'binding') as { policy?: unknown; baseDir?: unknown };
        return {
          policy: parsePolicy(raw?.policy, 'policy'),
          baseDir: typeof raw?.baseDir === 'string' ? raw.baseDir : dirname(resolve(stateDir)),
        };
      })()
    : undefined;
  if (policyPath) {
    const raw = readJson(policyPath, 'policy');
    const policy = parsePolicy(raw, 'policy');
    const warnings =
      bound && policyDigest(bound.policy) !== policyDigest(policy)
        ? [
            {
              code: 'POLICY_DIGEST_MISMATCH',
              message:
                'Файл политики, переданный панели, отличается от политики, с которой работает harness: настройки и числа показаны по файлу. Чтобы видеть действующую политику, откройте представление без --policy.',
              messageEn:
                'The policy file given to the panel differs from the policy harness runs with: settings and numbers follow the file. To see the policy in effect, open the view without --policy.',
            },
          ]
        : [];
    return { policy, baseDir: dirname(resolve(policyPath)), raw, warnings };
  }
  if (!bound)
    throw new HarnessError(
      'POLICY_REQUIRED',
      'Каталог состояния не найден или не инициализирован, а --policy не передан: ' + stateDir,
      [{ path: ['--policy'], message: 'required without a bound state' }],
    );
  return { ...bound, warnings: [] };
}

/** Пути настроек представления, взятые из умолчаний harness. */
export function defaultedPaths(policy: ExecutionPolicy, raw: unknown): string[] {
  const out: string[] = [];
  if (!policy.stallSweep) out.push('timeouts.stall');
  if (!policy.inputPolicy) out.push('thresholds.inputSeverity');
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const pairs: [string, string][] = [
    ['approvalMode', 'approvalMode'],
    ['mode', 'mode'],
    ['concurrency', 'concurrency'],
    ['maxAttempts', 'thresholds.maxAttempts'],
    ['repairBudget', 'thresholds.repairBudget'],
    ['runTimeoutMs', 'timeouts.runTimeoutMs'],
    ['leaseMs', 'timeouts.leaseMs'],
  ];
  for (const [key, path] of pairs) if (!(key in r)) out.push(path);
  const input = r.inputPolicy as Record<string, unknown> | undefined;
  if (input && typeof input === 'object' && !('threshold' in input))
    out.push('thresholds.inputSeverity');
  // Числа восстановления, взятые из умолчаний (`settings.decisions[].source`).
  const recovery = r.recovery as Record<string, unknown> | undefined;
  if (recovery && typeof recovery === 'object')
    for (const key of ['diagnoseAfter', 'leadResets'])
      if (!(key in recovery)) out.push('decisions.recovery.' + key);
  const budgets = r.budgets as Record<string, unknown> | undefined;
  if (budgets && typeof budgets === 'object' && !('onUnknown' in budgets))
    out.push('budgetOnUnknown');
  return [...new Set(out)].sort();
}

/** `profile.layers` манифеста рядом с политикой; нет манифеста или он не по схеме — нет. */
function manifestLayers(baseDir: string): string[] | undefined {
  try {
    const parsed = projectManifestSchema.safeParse(
      JSON.parse(readFileSync(join(baseDir, 'project.json'), 'utf8')),
    );
    return parsed.success ? (parsed.data.profile.layers ?? []) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Факты строки сводки попыток (`attemptLine`) — те же числа, что
 * `attemptSummaryLine`: проекция собирает из них строку в своём пределе, не
 * теряя хвоста («повтор — только со сбросом»).
 */
function attemptFacts(
  s: StatusWork['attemptSummary'],
  final: boolean,
): AttemptLineFacts | undefined {
  if (!s) return undefined;
  // Как `attemptSummaryView`: у итоговой работы предел незасчитанных не держит.
  const neutralOut = !final && s.neutral.used >= s.neutral.max;
  return {
    total: s.total,
    active: s.active,
    failed: s.failed,
    failures: s.failures,
    timeouts: s.timeouts,
    interrupted: s.interrupted,
    accepted: s.accepted,
    attempts: { used: s.attempts.used, max: s.attempts.max },
    ...(neutralOut ? { neutralOut: s.neutral } : {}),
    ...(s.repairs ? { repairs: { used: s.repairs.used, budget: s.repairs.budget } } : {}),
    ...(s.rework
      ? {
          rework: {
            revision: s.rework.revision,
            acceptedSha: s.rework.acceptedSha,
            fresh: s.rework.fresh,
          },
        }
      : {}),
  };
}

const lastBySubject = <R extends { subject: string; round: number }>(
  rows: readonly R[],
  key: (r: R) => string,
) => {
  const last = new Map<string, R>();
  for (const r of rows) {
    const prev = last.get(key(r));
    if (!prev || r.round > prev.round) last.set(key(r), r);
  }
  return last;
};

const findingsOf = (findings: ReviewRecord['findings']) =>
  findings.map((f) => ({
    id: f.id,
    severity: f.severity,
    status:
      f.status === 'withdrawn' && f.disposition?.decision === 'accepted-limitation'
        ? 'accepted-limitation'
        : f.status,
    ...(f.rounds !== undefined ? { rounds: f.rounds } : {}),
    ...(f.disposition
      ? {
          disposition: {
            decision: f.disposition.decision,
            by: f.disposition.by,
            round: f.disposition.round,
          },
        }
      : {}),
    message: f.message,
  }));

type ReviewRound = NonNullable<OperatorViewInput['reviewRounds']>[number];

/** Раунды по предмету: одна запись на (вид, предмет, раунд), время — первой записи. */
const roundsOf = <R extends { subject: string; round: number; at: string }>(
  rows: readonly R[],
  kind: (r: R) => ReviewRound['kind'],
): ReviewRound[] => {
  const seen = new Set<string>();
  const out: ReviewRound[] = [];
  for (const r of rows) {
    const key = `${kind(r)}\0${r.subject}\0${r.round}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: kind(r), at: r.at });
  }
  return out;
};

/**
 * Строка ревью кода по частям: «код app/writer base..head: вердикт; раундов
 * N». Refs (до 500 символов) — имена: проекция маскирует их и сокращает
 * серединой, вердикт и раунды остаются в пределе строки представления.
 */
export function codeReviewLineParts(
  r: {
    repositoryId: string;
    role: string;
    refs: { base: string; head: string };
    approved: boolean;
    round: number;
  },
  counts: Parameters<typeof reviewVerdictText>[1],
  lang: 'ru' | 'en',
): LinePart[] {
  const ru = lang === 'ru';
  return [
    ru ? 'код ' : 'code ',
    named(`${r.repositoryId}/${r.role}`),
    ' ',
    named(r.refs.base),
    '..',
    named(r.refs.head),
    `: ${reviewVerdictText(r.approved, counts, lang)}; ${ru ? 'раундов' : 'rounds'} ${r.round}`,
  ];
}

/** Строка ревью плана или контракта: ID предмета — имя, остальное — шаблон. */
function subjectLineParts(line: string, head: string, subject: string): LinePart[] {
  const prefix = `${head} ${subject}`;
  return line.startsWith(prefix) ? [head + ' ', named(subject), line.slice(prefix.length)] : [line];
}

const joinParts = (parts: readonly LinePart[]) =>
  parts.map((p) => (typeof p === 'string' ? p : p.name)).join('');

export function reviewsOf(
  v: ExecutionView,
  policy: ExecutionPolicy,
): { reviews: OperatorReviewInput[]; rounds: ReviewRound[] } {
  const rows = v.locals('reviews', WORKSPACE_OWNER).map((r) => r.value);
  const records = lastBySubject(rows, (r) => `${r.kind}\0${r.subject}`);
  // Расход вызовов ревью предмета — правило `reviewSummaries` (стадии
  // plan-review / contract-review по ID предмета) и полнота учёта; без
  // предела сводки status: пределы и счёт опущенного — у проекции.
  type Spend = { calls: number; knownUsd: number; unknownCalls: number; incompleteCalls: number };
  const spend = new Map<string, Spend>();
  const add = (key: string, c: CallRecord) => {
    const s = spend.get(key) ?? { calls: 0, knownUsd: 0, unknownCalls: 0, incompleteCalls: 0 };
    s.calls += 1;
    if (callCostKnown(c)) s.knownUsd += c.costUsd ?? 0;
    else s.unknownCalls += 1;
    if (!callComplete(c)) s.incompleteCalls += 1;
    spend.set(key, s);
  };
  for (const c of callRecords(v)) {
    if (!c.subjectId) continue;
    if (c.stage === 'plan-review') add(`plan\0${c.subjectId}`, c);
    else if (c.stage === 'contract-review') add(`contract\0${c.subjectId}`, c);
    else if (c.stage === 'code-review') add(`code\0${c.subjectId}`, c);
  }
  const none: Spend = { calls: 0, knownUsd: 0, unknownCalls: 0, incompleteCalls: 0 };
  const max = reviewRoundCap(policy);
  const plans: OperatorReviewInput[] = [...records.entries()].map(([key, r]) => {
    const spent = spend.get(key) ?? none;
    const s = reviewSubjectSummary(
      r,
      max,
      spent,
      subjectRoundBudget(
        v,
        r.kind,
        r.subject,
        rows.filter((x) => x.kind === r.kind && x.subject === r.subject),
        max,
      ),
    );
    const counts = findingCounts(r.findings);
    const waiting = escalatedFindings(r.findings, r.round);
    return {
      kind: s.kind,
      subject: s.subject,
      at: r.at,
      approved: s.approved,
      rounds: {
        used: s.rounds.used,
        max: s.rounds.max,
        ...(s.rounds.remaining !== undefined ? { remaining: s.rounds.remaining } : {}),
        ...(s.rounds.free !== undefined ? { free: s.rounds.free } : {}),
      },
      open: s.open,
      accepted: s.accepted,
      reviewer: {
        runtime: r.reviewerRuntime,
        ...(r.reviewerModel ? { model: r.reviewerModel } : {}),
      },
      sameVendor: r.sameVendor,
      spend: { ...s.spend, incompleteCalls: spent.incompleteCalls },
      findings: findingsOf(r.findings),
      // Все ждущие решения находки: предел и счёт опущенного — у проекции.
      ...(waiting.length
        ? { escalation: { round: r.round, findings: waiting.map((f) => f.id) } }
        : {}),
      ...((en) => ({
        line: s.line,
        lineEn: en,
        lineParts: {
          ru: subjectLineParts(s.line, s.kind === 'plan' ? 'план' : 'контракт', s.subject),
          en: subjectLineParts(en, s.kind, s.subject),
        },
      }))(
        `${s.kind} ${s.subject}: ${reviewVerdictText(s.approved, counts, 'en')}; rounds ${s.rounds.max === null ? `${r.round}, ${LIGHT_ROUNDS_EN}` : `${s.rounds.used}/${s.rounds.max}`}`,
      ),
    };
  });
  const codeRows = v.locals('code-reviews', WORKSPACE_OWNER).map((r) => r.value);
  const code = [...lastBySubject(codeRows, (r) => r.subject).values()].map(
    (r): OperatorReviewInput => {
      const counts = findingCounts(r.findings);
      return {
        kind: 'code',
        subject: r.subject,
        at: r.at,
        approved: r.approved,
        rounds: { used: r.round, max: null },
        open: { blocking: counts.blocking, notes: counts.notes },
        accepted: counts.accepted,
        reviewer: {
          runtime: r.reviewerRuntime,
          ...(r.reviewerModel ? { model: r.reviewerModel } : {}),
        },
        sameVendor: r.sameVendor,
        spend: spend.get(`code\0${r.subject}`) ?? none,
        findings: findingsOf(r.findings),
        ...((ru, en) => ({ line: joinParts(ru), lineEn: joinParts(en), lineParts: { ru, en } }))(
          codeReviewLineParts(r, counts, 'ru'),
          codeReviewLineParts(r, counts, 'en'),
        ),
      };
    },
  );
  return {
    reviews: [...plans, ...code].sort(
      (a, b) => b.at.localeCompare(a.at) || a.subject.localeCompare(b.subject),
    ),
    rounds: [...roundsOf(rows, (r) => r.kind), ...roundsOf(codeRows, () => 'code' as const)],
  };
}

/**
 * Раунды ревью в попытках: один на (область, номер раунда) по первой валидной
 * записи протокола (`reviewRound.protocol: valid`) — повторы вызова и
 * невалидные или небезопасные ответы раундом не считаются, как в
 * `codeReviewHistory`. Запись прежней версии без `reviewRound` — свой раунд.
 */
export function attemptReviewRounds(attempts: readonly AttemptState[]) {
  const seen = new Set<string>();
  const out: { kind: 'attempt'; at: string }[] = [];
  for (const a of attempts)
    for (const e of a.evidence) {
      if (e.kind !== 'review') continue;
      const r = e.reviewRound;
      if (r) {
        if (r.protocol !== 'valid') continue;
        const key = `${r.scope}\0${r.round}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push({ kind: 'attempt', at: e.createdAt });
    }
  return out;
}

/** Самый поздний момент по времени (не по строке: у записи бывает смещение зоны). */
export const latestTime = (times: readonly (string | undefined)[]) =>
  times.reduce<string | undefined>((best, t) => {
    if (!t || !Number.isFinite(Date.parse(t))) return best;
    if (!best) return t;
    const d = Date.parse(t) - Date.parse(best);
    return d > 0 || (d === 0 && t > best) ? t : best;
  }, undefined);

/** Ближайший ранг: наименьшее значение, не меньше которого доля `p` образцов. */
const nearestRank = (sorted: readonly number[], p: number) =>
  sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;

/**
 * Наблюдаемые длительности этапов по закончившимся попыткам (без прерванных
 * остановкой): у попытки этап длится от начала первого его замера до конца
 * последнего (`stageOfStep`); этап с незакрытым замером образцом не считается.
 * Идущие попытки не входят: их текущий этап ещё не кончился.
 */
export function stageTypicalOf(
  attempts: readonly AttemptState[],
): Record<string, { p50Ms: number; p90Ms: number; samples: number }> {
  const samples = new Map<string, number[]>();
  for (const a of attempts) {
    if (a.status === 'active' || interruptedByShutdown(a)) continue;
    const spans = new Map<string, { s: number; e: number; open: boolean }>();
    for (const t of a.timings ?? []) {
      const stage = stageOfStep(t.stage);
      if (!stage) continue;
      const s = Date.parse(t.startedAt);
      const e = t.finishedAt ? Date.parse(t.finishedAt) : NaN;
      const cur = spans.get(stage) ?? { s: Infinity, e: -Infinity, open: false };
      if (!Number.isFinite(s) || !Number.isFinite(e)) cur.open = true;
      else {
        cur.s = Math.min(cur.s, s);
        cur.e = Math.max(cur.e, e);
      }
      spans.set(stage, cur);
    }
    for (const [stage, x] of spans) {
      if (x.open || !(x.e >= x.s)) continue;
      const xs = samples.get(stage) ?? [];
      xs.push(x.e - x.s);
      samples.set(stage, xs);
    }
  }
  const out: Record<string, { p50Ms: number; p90Ms: number; samples: number }> = {};
  for (const [stage, xs] of [...samples].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const sorted = [...xs].sort((a, b) => a - b);
    out[stage] = {
      p50Ms: Math.round(nearestRank(sorted, 0.5)),
      p90Ms: Math.round(nearestRank(sorted, 0.9)),
      samples: sorted.length,
    };
  }
  return out;
}

/**
 * События ленты «кто что делал» из записей, которые представление уже
 * читает: попытки и их записи проверок и ревью, раунды ревью плана,
 * контракта и кода, вопросы исполнителя и ответы. Окно и предел — у проекции.
 */
export function activityInputOf(
  attempts: readonly AttemptState[],
  planRows: readonly ReviewRecord[],
  codeRows: readonly CodeReviewRecord[],
  requests: readonly InputRequest[],
  works: readonly Pick<WorkState, 'id' | 'rework'>[] = [],
): OperatorActivityInput[] {
  const out: OperatorActivityInput[] = [];
  // Доработка после приёмки: последняя открытая новой редакцией (`WorkState.rework`).
  for (const w of works)
    if (w.rework) {
      out.push({
        kind: 'work.reopened',
        at: w.rework.reopenedAt,
        workId: w.id,
        revision: w.rework.revision,
        sha: w.rework.accepted.resultSha,
        fresh: w.rework.fresh,
      });
      // Ревизия 6: доработка оставлена — работа вернулась к принятой редакции.
      if (w.rework.abandoned)
        out.push({
          kind: 'work.rework-abandoned',
          at: w.rework.abandoned.at,
          workId: w.id,
          revision: w.rework.revision,
          sha: w.rework.accepted.resultSha,
          by: w.rework.abandoned.by,
        });
    }
  const blockingOf = (fs: readonly { severity: string; status?: string }[]) =>
    fs.filter((f) => f.severity === 'blocking' && (f.status === undefined || f.status === 'open'))
      .length;
  for (const a of attempts) {
    out.push({
      kind: 'attempt.started',
      at: a.startedAt,
      workId: a.workId,
      attempt: a.attempt,
      runtime: a.runtime,
    });
    if (a.status === 'succeeded' && a.finishedAt)
      out.push({
        kind: 'work.accepted',
        at: a.finishedAt,
        workId: a.workId,
        attempt: a.attempt,
        ...(a.integrationSha ? { sha: a.integrationSha } : {}),
        // Ветка, закреплённая за попыткой при выдаче, а не нынешняя политики.
        ...(a.pinned?.targetRef ? { ref: a.pinned.targetRef } : {}),
      });
    else if (a.status !== 'active' && a.finishedAt) {
      const interrupted = interruptedByShutdown(a);
      const bucket = failureBucketOf(a);
      out.push({
        kind: 'attempt.ended',
        at: a.finishedAt,
        workId: a.workId,
        attempt: a.attempt,
        outcome: interrupted
          ? 'interrupted'
          : a.status === 'cancelled' || a.status === 'expired'
            ? a.status
            : 'failed',
        ...(bucket ? { reason: failurePlainOf(a, bucket) } : {}),
        // Правило движка: не засчитаны прерванные остановкой, отказы до работы,
        // окружения и провайдера, истёкшее владение.
        ...(interrupted ||
        a.blocked ||
        a.writerBlocked ||
        a.status === 'expired' ||
        a.failureKind === 'environment' ||
        a.failureKind === 'provider-auth'
          ? { uncounted: true }
          : {}),
      });
    }
    for (const e of a.evidence) {
      if (e.kind === 'test')
        out.push({
          kind: 'gate',
          at: e.createdAt,
          workId: a.workId,
          attempt: a.attempt,
          gate: e.consumer ? `${e.gate}@${e.consumer}` : e.gate,
          phase: e.phase,
          passed: e.passed,
          ...(e.recheck ? { recheck: e.recheck.outcome } : {}),
          ...(e.reusedEvidence ? { reused: true } : {}),
          // Правило строк проверки (`verificationRows`): запуск не состоялся.
          ...(!e.passed && !e.reusedEvidence && notLaunched(e.summary)
            ? { notLaunched: true }
            : {}),
        });
      else if (e.kind === 'review' && (!e.reviewRound || e.reviewRound.protocol === 'valid')) {
        const facts = reviewFacts(e);
        out.push({
          kind: 'review',
          at: e.createdAt,
          scope: 'attempt',
          subject: a.workId,
          workId: a.workId,
          attempt: a.attempt,
          phase: e.phase,
          approved: e.passed,
          blocking: blockingOf(e.findings ?? []),
          reviewer: a.reviewer,
          ...(facts.inspection === 'diff-only' ? { inspection: 'diff-only' as const } : {}),
          ...(facts.inspection === 'commands'
            ? { inspection: 'commands' as const, commands: facts.commands ?? 0 }
            : {}),
        });
      }
    }
  }
  // Эскалация — в раунде, где находка начала ждать решения: снова ждёт
  // (после «продолжать» или повторного открытия) — новая эскалация.
  const waiting = new Map<string, Set<string>>();
  const rounds = <R extends { subject: string; round: number }>(rows: readonly R[]) =>
    [...rows].sort((x, y) => x.round - y.round);
  for (const r of rounds(planRows)) {
    out.push({
      kind: 'review',
      at: r.at,
      scope: r.kind,
      subject: r.subject,
      round: r.round,
      approved: r.approved,
      blocking: blockingOf(r.findings),
      reviewer: r.reviewerRuntime,
    });
    const key = `${r.kind}\0${r.subject}`;
    const now = escalatedFindings(r.findings, r.round);
    const before = waiting.get(key) ?? new Set<string>();
    const fresh = now.filter((f) => !before.has(String(f.id)));
    waiting.set(key, new Set(now.map((f) => String(f.id))));
    if (fresh.length)
      out.push({
        kind: 'review.escalated',
        at: r.at,
        scope: r.kind,
        subject: r.subject,
        findings: fresh.length,
        round: r.round,
      });
  }
  for (const r of rounds(codeRows)) {
    out.push({
      kind: 'review',
      at: r.at,
      scope: 'code',
      subject: r.subject,
      label: `${r.repositoryId}/${r.role} ${r.refs.base}..${r.refs.head}`,
      round: r.round,
      approved: r.approved,
      blocking: blockingOf(r.findings),
      reviewer: r.reviewerRuntime,
    });
  }
  for (const q of requests) {
    if (q.kind !== 'question') continue;
    out.push({
      kind: 'question.asked',
      at: q.createdAt,
      workId: q.workId,
      requestId: q.id,
      severity: q.effectiveSeverity,
    });
    for (const x of q.answers)
      out.push({
        kind: 'question.answered',
        at: x.at,
        workId: q.workId,
        requestId: q.id,
        by: x.actor.kind,
        ...(x.actor.kind === 'lead' && x.basis ? { basis: x.basis } : {}),
      });
  }
  return out;
}

/** События журнала, из которых представление берёт решения (ревизия 8). */
export const DECISION_EVENT_TYPES = [
  'work.cancelled',
  'work.reopened',
  'work.rework-abandoned',
  'graph.registered',
  'graph.approved',
  'budget.raised',
  'policy.applied',
] as const;

/** Сколько последних событий решений читает представление. */
const DECISION_EVENTS_LIMIT = 2000;

/** События решений из хранилища (выборка по типу); без хранилища — нет. */
export function decisionEventsOf(
  store: Pick<SqliteExecutionStore, 'eventsOfTypes'> | undefined,
): RunEvent[] {
  return store ? store.eventsOfTypes(DECISION_EVENT_TYPES, DECISION_EVENTS_LIMIT) : [];
}

/**
 * Кто согласовал ту редакцию плана, регистрация которой вызвала событие `e`
 * графа (0.1.0-alpha.68, ревью r1–r2). Движок пишет в одной транзакции
 * регистрации отмены и отказы от доработок до `graph.registered`, а
 * переоткрытия — после: регистрация — следующее `graph.registered` того же
 * графа (отмена, отказ) или предыдущее (переоткрытие). Согласование — первое
 * `graph.approved` того же графа после регистрации с тем же digest, и между
 * ними нет другой регистрации (замена редакции). Иначе актёр неизвестен.
 */
function approvalAfter(events: readonly RunEvent[], e: RunEvent): 'agent' | 'operator' | undefined {
  const same = events.filter((x) => x.graphId === e.graphId);
  const registration =
    e.type === 'work.reopened'
      ? same.filter((x) => x.seq < e.seq && x.type === 'graph.registered').at(-1)
      : same.find((x) => x.seq > e.seq && x.type === 'graph.registered');
  if (!registration || registration.type !== 'graph.registered') return undefined;
  const digest = registration.payload.digest;
  for (const x of same) {
    if (x.seq <= registration.seq) continue;
    if (x.type === 'graph.registered' && x.payload.digest !== digest) return undefined;
    if (x.type === 'graph.approved')
      return x.payload.digest === digest ? x.payload.actor : undefined;
  }
  return undefined;
}

/**
 * Решения (ревизия 8) по записям хранилища и журнала: разборы и сбросы
 * ведущего и человека (`WorkState.leadRecovery`), ответы на вопросы
 * исполнителя с актёром, решения по находкам ревью (план, контракт —
 * последний раунд предмета; код — `WorkState.codeReviewDecisions`), отмены,
 * переоткрытия и оставленные доработки (`work.*`), повторные согласования
 * (`graph.approved` с `reapproval`). Только факты: фразы и актёра `by`
 * выводит проекция.
 */
export function decisionsInputOf(
  works: readonly WorkState[],
  requests: readonly InputRequest[],
  planRows: readonly ReviewRecord[],
  events: readonly RunEvent[],
  recovery: RecoveryPolicy,
): OperatorDecisionInput[] {
  const out: OperatorDecisionInput[] = [];
  for (const w of works) {
    for (const d of w.leadRecovery?.diagnoses ?? [])
      (d.addenda ?? []).forEach((a, i) =>
        out.push({
          kind: 'diagnosis-addendum',
          at: a.at,
          workId: w.id,
          diagnosis: d.id,
          index: i + 1,
          text: a.text,
        }),
      );
    for (const d of w.leadRecovery?.diagnoses ?? [])
      out.push({
        kind: 'diagnosis',
        at: d.at,
        workId: w.id,
        diagnosis: d.id,
        cause: d.cause,
        failures: d.failures.length,
        required: diagnosisRequired(w, d, recovery),
        ...(d.hypothesis ? { hypothesis: d.hypothesis } : {}),
      });
    for (const r of w.leadRecovery?.resets ?? [])
      out.push({
        kind: 'reset',
        at: r.at,
        workId: w.id,
        by: r.by,
        granted: r.granted,
        spent: r.spent,
        ...(r.index !== undefined ? { index: r.index } : {}),
        ...(r.cap !== undefined ? { cap: r.cap } : {}),
        ...(r.diagnosis ? { diagnosis: r.diagnosis } : {}),
      });
    for (const d of w.codeReviewDecisions ?? [])
      out.push({
        kind: 'finding',
        at: d.at,
        scope: 'code',
        subject: w.id,
        workId: w.id,
        findingId: d.finding,
        decision: d.decision,
        by: d.by,
        round: d.round,
        reason: d.reason,
      });
  }
  for (const q of requests) {
    if (q.kind !== 'question') continue;
    for (const x of q.answers)
      out.push({
        kind: 'answer',
        at: x.at,
        workId: q.workId,
        requestId: q.id,
        revision: x.revision,
        by: x.actor.kind,
        ...(x.basis ? { basis: x.basis } : {}),
        answerKind: x.kind,
        ...(x.reason ? { reason: x.reason } : {}),
      });
  }
  // Решения по находкам плана и контракта — по последнему раунду предмета:
  // время — раунда, в котором решение применено.
  const bySubject = new Map<string, ReviewRecord[]>();
  for (const r of planRows) {
    const key = `${r.kind}\0${r.subject}`;
    bySubject.set(key, [...(bySubject.get(key) ?? []), r]);
  }
  for (const rows of bySubject.values()) {
    const last = rows.reduce((a, b) => (b.round > a.round ? b : a));
    for (const f of last.findings)
      if (f.disposition)
        out.push({
          kind: 'finding',
          at: rows.find((r) => r.round === f.disposition!.round)?.at ?? last.at,
          scope: last.kind,
          subject: last.subject,
          findingId: f.id,
          decision: f.disposition.decision,
          by: f.disposition.by,
          round: f.disposition.round,
          reason: f.disposition.reason,
        });
  }
  for (const e of events) {
    if (e.type === 'work.cancelled' && e.workId)
      out.push({
        kind: 'cancel',
        at: e.at,
        workId: e.workId,
        seq: e.seq,
        by: e.payload.by,
        ...((a) => (a ? { approvedBy: a } : {}))(
          e.payload.by === 'graph' ? approvalAfter(events, e) : undefined,
        ),
      });
    else if (e.type === 'work.reopened' && e.workId)
      out.push({
        kind: 'reopen',
        at: e.at,
        workId: e.workId,
        seq: e.seq,
        revision: e.payload.revision,
        budget: e.payload.budget,
        acceptedSha: e.payload.acceptedSha,
        ...((a) => (a ? { approvedBy: a } : {}))(approvalAfter(events, e)),
      });
    else if (e.type === 'work.rework-abandoned' && e.workId)
      out.push({
        kind: 'rework-abandoned',
        at: e.at,
        workId: e.workId,
        seq: e.seq,
        revision: e.payload.revision,
        acceptedSha: e.payload.acceptedSha,
        by: e.payload.by,
        ...((a) => (a ? { approvedBy: a } : {}))(
          e.payload.by === 'graph' ? approvalAfter(events, e) : undefined,
        ),
      });
    else if (e.type === 'budget.raised')
      out.push({
        kind: 'budget',
        at: e.at,
        seq: e.seq,
        generation: e.payload.generation,
        changes: e.payload.changes,
        // Причину и кто решил называет повторное согласование после правки
        // политики (`reapprove --by --reason`), если оно было.
        // Только в том же поколении политики: повторное согласование после
        // этого подъёма и до следующего применения политики (ревью r2);
        // иначе причины нет.
        ...((r) =>
          r && r.type === 'graph.approved' && r.payload.reapproval
            ? { by: r.payload.reapproval.by, reason: r.payload.reapproval.reason }
            : {})(
          ((next) =>
            events.find(
              (x) =>
                x.seq > e.seq &&
                (next === undefined || x.seq < next) &&
                x.type === 'graph.approved' &&
                !!x.payload.reapproval,
            ))(
            // Граница — применение следующего поколения: `policy.applied` того
            // же поколения пишется рядом с подъёмом (ревью r3).
            events.find(
              (x) =>
                x.seq > e.seq &&
                x.type === 'policy.applied' &&
                x.payload.generation > e.payload.generation,
            )?.seq,
          ),
        ),
      });
    else if (e.type === 'graph.approved' && e.payload.reapproval && e.graphId)
      out.push({
        kind: 'reapproval',
        at: e.at,
        graphId: e.graphId,
        seq: e.seq,
        by: e.payload.reapproval.by,
        round: e.payload.reapproval.round,
        reason: e.payload.reapproval.reason,
      });
  }
  return out;
}

/**
 * Доработка открыта (ревизия 8): работа переоткрыта новой редакцией плана
 * после приёмки, доработка не принята, не оставлена и не отменена. Кто —
 * актёр согласования редакции после события `work.reopened` этой доработки.
 */
export function reopenedOf(
  w: Pick<WorkState, 'id' | 'status' | 'rework'>,
  events: readonly RunEvent[],
): OperatorWorkInput['reopened'] {
  const r = w.rework;
  if (!r || r.abandoned || w.status === 'done' || w.status === 'cancelled') return undefined;
  const e = events.findLast(
    (x) => x.type === 'work.reopened' && x.workId === w.id && x.payload.revision === r.revision,
  );
  const approved = e ? approvalAfter(events, e) : undefined;
  return {
    at: r.reopenedAt,
    ...(approved ? { by: approved === 'agent' ? ('lead' as const) : ('operator' as const) } : {}),
    revision: r.revision,
    budget: r.fresh ? 'fresh' : 'carried',
    acceptedSha: r.accepted.resultSha,
    spent: r.spent,
  };
}

/**
 * Итог ревью кандидата и интеграции по попыткам (ревизия 8): последний
 * применённый раунд попытки и фазы (протокол `valid` или запись прежней
 * версии без `reviewRound`); только неприменённые ответы — `invalid`.
 */
export function attemptReviewsOf(
  own: readonly AttemptState[],
  earlier: ReadonlySet<string>,
): NonNullable<OperatorWorkInput['attemptReviews']> {
  const out: NonNullable<OperatorWorkInput['attemptReviews']>[number][] = [];
  const open = (f: { status?: string }) => f.status === undefined || f.status === 'open';
  for (const a of [...own].sort((x, y) => x.attempt - y.attempt))
    for (const phase of ['candidate', 'integration'] as const) {
      const rows = a.evidence.filter((e) => e.kind === 'review' && e.phase === phase);
      if (!rows.length) continue;
      const applied = rows.filter((e) => !e.reviewRound || e.reviewRound.protocol === 'valid');
      const e = applied.at(-1) ?? rows.at(-1)!;
      const findings = applied.length ? (e.findings ?? []).filter(open) : [];
      out.push({
        attempt: a.attempt,
        phase,
        verdict: !applied.length ? 'invalid' : e.passed ? 'approved' : 'rejected',
        findings: findings.filter((f) => f.severity === 'blocking').length,
        notes: findings.filter((f) => f.severity !== 'blocking').length,
        at: e.createdAt,
        ...(earlier.has(a.id) ? { earlier: true as const } : {}),
      });
    }
  return out;
}

/** Вызов полностью учтён: завершён, usage полный, цена есть (правило отчёта). */
const callComplete = (r: CallRecord) =>
  r.outcome !== 'active' && r.outcome !== 'abandoned' && r.usage.complete && r.costUsd !== null;

/** Чтение представления: движок над хранилищем, политика, задания графов, каталоги. */
export interface ViewSource {
  readonly engine: Engine;
  readonly policy: ExecutionPolicy;
  readonly workflows: WorkflowQueue;
  readonly stateDir: string;
  /** Каталог, от которого разрешаются пути репозиториев политики. */
  readonly baseDir: string;
  /** Хранилище для событий решений (ревизия 8); нет — решений из журнала нет. */
  readonly store?: Pick<SqliteExecutionStore, 'eventsOfTypes'>;
}

/** `Harness.status(undefined, {detail: true})`: статус и сверка принятого с target ref. */
function statusWithTargets(s: ViewSource): StatusData {
  const data = statusOf(s, undefined, { detail: true });
  const accepted = s.engine.read((v) =>
    data.works.flatMap((w) => {
      const work = w.status === 'done' && w.resultSha ? v.work(w.id) : undefined;
      return work
        ? [{ id: w.id, repositoryId: work.order.repositoryId, acceptedSha: w.resultSha! }]
        : [];
    }),
  );
  if (!accepted.length) return data;
  const targets = acceptedTargets(
    s.policy,
    (p) => (isAbsolute(p) ? p : resolve(s.baseDir, p)),
    accepted,
  );
  return {
    ...data,
    works: data.works.map((w) => {
      const target = targets.get(w.id);
      return target ? { ...w, target } : w;
    }),
  };
}

/**
 * Поручение прежней записи вызова без `workId` — то же правило, что у
 * `status` (`recordWorkOf`): по попытке, затем по ID предмета, если это не
 * вызов о группе.
 */
function legacyWork(r: CallRecord, runWork: Map<string, string>, works: Set<string>) {
  const byRun = r.runId !== undefined ? runWork.get(r.runId) : undefined;
  if (byRun) return byRun;
  if (r.subjectKind && r.subjectKind !== 'work') return undefined;
  if (legacyGroupCall(r)) return undefined;
  return r.subjectId && works.has(r.subjectId) ? r.subjectId : undefined;
}

/** «Что изменится для пользователя»: строка рекомендованного варианта, иначе первая названная. */
function plainOf(r: InputRequest): string | undefined {
  type Option = { id: string; forUser?: string | null };
  const options = r.question.options as readonly Option[];
  const pick =
    options.find((o) => o.id === r.question.recommended && o.forUser) ??
    options.find((o) => o.forUser);
  return pick?.forUser ?? undefined;
}

export interface CollectOptions {
  /** Часы представления; по умолчанию — часы движка. */
  now?: number;
  /** Язык строк, которые harness формулирует только по-русски (причины сверки, пауза). */
  lang?: 'ru' | 'en';
}

/** Причины `unavailable` сверки принятого (`acceptedTargets`) по-английски. */
const unavailableEn: [RegExp, string][] = [
  [/^репозиторий не объявлен в политике$/, 'the repository is not declared in the policy'],
  [/^checkout репозитория не найден$/, 'the repository checkout is not found'],
  [/^checkout репозитория не доверен$/, 'the repository checkout is not trusted'],
  [/^ref не прочитан$/, 'the ref could not be read'],
  [/^принятый коммит не прочитан$/, 'the accepted commit could not be read'],
  [/^git не ответил вовремя$/, 'git did not answer in time'],
  [/^git не найден$/, 'git is not found'],
  [/^сверка прервана: предел (\d+) с$/, 'the check was cut off: the $1 s limit'],
];
const translateUnavailable = (reason: string) => {
  for (const [re, en] of unavailableEn) if (re.test(reason)) return reason.replace(re, en);
  return reason;
};

/**
 * Вход проекции из открытого harness: `status --detail` (этап, сводки,
 * бюджеты, ревью, очередь, сверка принятого) и записи хранилища одним
 * чтением, плюс диагноз остановок `explain` по тем же часам.
 */
export function collectOperatorViewInput(
  source: ViewSource | Harness,
  view: Pick<ViewPolicy, 'raw' | 'warnings' | 'baseDir'>,
  options: CollectOptions = {},
): OperatorViewInput {
  const h: ViewSource =
    source instanceof Harness
      ? {
          engine: source.engine,
          policy: source.policy,
          workflows: source.workflows,
          stateDir: source.options.stateDir,
          baseDir: source.options.baseDir,
          store: source.store,
        }
      : source;
  const policy = h.policy;
  const now = options.now ?? h.engine.clock();
  // Один снимок: вложенные чтения хранилища (status, задания графов) видят
  // ту же транзакцию, что и записи ниже.
  // События решений (ревизия 8): выборка по типу до снимка состояния.
  const events = decisionEventsOf(h.store);
  const recovery = recoveryPolicyOf(policy);
  return h.engine.read((v) => {
    const status = statusWithTargets(h);
    const jobs = h.workflows.list().filter((j) => j.kind === 'graph');
    const attempts = v.attempts();
    const attemptsOf = new Map<string, typeof attempts>();
    for (const a of attempts) attemptsOf.set(a.workId, [...(attemptsOf.get(a.workId) ?? []), a]);
    const runWork = new Map(attempts.map((a) => [a.id, a.workId]));
    // Попытки прежних редакций доработанных после приёмки работ: прогноз
    // меряет доработку только её попытками.
    const earlier = new Set<string>();
    for (const w of v.works())
      if (w.rework) {
        const own = attemptsOf.get(w.id) ?? [];
        const current = new Set(currentRevisionAttempts(w, own).map((a) => a.id));
        for (const a of own) if (!current.has(a.id)) earlier.add(a.id);
      }
    const known = new Set(v.works().map((w) => w.id));
    const gateHolds = h.engine.environmentGateHolds(v);
    const records = callRecords(v);
    const complete = (r: (typeof records)[number]) =>
      r.outcome !== 'active' && r.outcome !== 'abandoned' && r.usage.complete && r.costUsd !== null;
    // Диагноз остановок, как `stage.needs` у status, но с кодом.
    const stops: OperatorViewInput['stops'][number][] = [];
    const seen = new Set<string>();
    for (const input of stopInputsIn(
      { engine: h.engine, policy, workflows: h.workflows },
      { maxAttempts: policy.maxAttempts, repairBudget: policy.repairBudget },
      v,
      { jobs, now },
    )) {
      if (input.kind !== 'work' || seen.has(input.work.id)) continue;
      seen.add(input.work.id);
      const d = explainStop(input);
      const sw = status.works.find((w) => w.id === input.work.id);
      // С какого момента стоит: начало этапа, иначе конец последней попытки
      // работы, иначе регистрация графа — из хранилища, а не часы проекции,
      // чтобы токен неизменного состояния не менялся.
      const since =
        sw?.stage?.since ??
        latestTime(attemptsOf.get(input.work.id)?.map((a) => a.finishedAt) ?? []) ??
        v.graph(v.work(input.work.id)?.graphId ?? '')?.registeredAt;
      stops.push({
        workId: input.work.id,
        code: d.code,
        actor: d.actor,
        action: d.action,
        ...(since ? { since } : {}),
      });
    }
    const queue = status.detail?.queue;
    if (queue?.paused && (queue.actor === 'user' || queue.actor === 'lead'))
      stops.push({
        code: queue.code ?? 'PAUSED',
        actor: queue.actor,
        action: queue.action ?? 'resume-queue',
        ...(queue.since ? { since: queue.since } : {}),
      });
    const works: OperatorWorkInput[] = (status.works as StatusWork[]).map((sw) => {
      const w = v.work(sw.id)!;
      const own = attemptsOf.get(sw.id) ?? [];
      const ownRecords = records.filter(
        (r) => !r.workIds && (r.workId ?? legacyWork(r, runWork, known)) === sw.id,
      );
      const active = sw.activeRunId ? v.attempt(sw.activeRunId) : undefined;
      const summary = sw.attemptSummary!;
      const stage = sw.stage!;
      // Планируемая (ревизия 6): зарегистрирована, план не согласован, попыток
      // не было и это не доработка принятой работы.
      const graphState = v.graph(sw.graphId);
      const unapproved = !graphState?.approval || graphState.approval.digest !== graphState.digest;
      const planned = sw.status === 'draft' && unapproved && !own.length && !w.rework;
      return {
        id: sw.id,
        graphId: sw.graphId,
        status: sw.status,
        title: w.order.title,
        ...(planned ? { planned: true as const } : {}),
        ...(w.order.kind === 'infra' ? { kind: 'infra' as const } : {}),
        ...((seen) => (seen ? { seenAt: seen.at } : {}))(
          v.local('work-seen', WORKSPACE_OWNER, sw.id),
        ),
        ...(sw.resultSha ? { resultSha: sw.resultSha } : {}),
        ...(w.order.dependsOn.length ? { dependsOn: w.order.dependsOn } : {}),
        stage: {
          name: stage.name,
          ...(stage.step ? { step: stage.step } : {}),
          ...(stage.since ? { since: stage.since } : {}),
          next: stage.next,
          ...(stage.needs ? { needs: stage.needs } : {}),
          spend: stage.spend,
        },
        spendFacts: {
          uncoveredRuns: own.filter((a) => a.status !== 'active' && !a.callsRecorded).length,
          incompleteCalls: ownRecords.filter((r) => !complete(r)).length,
        },
        attemptSummary: {
          ...summary,
          // Класс отказа и засчитана ли попытка — фактами, не фразой (P13).
          ...((last) =>
            last
              ? {
                  lastFailure: {
                    ...last,
                    ...((a) => (a ? { counted: attemptCounted(a, own, policy.maxAttempts) } : {}))(
                      own.find((x) => x.id === last.runId),
                    ),
                  },
                }
              : {})(summary.lastFailure),
          ...((facts) => (facts ? { lineEn: attemptLine(facts, 'en'), lineFacts: facts } : {}))(
            attemptFacts(summary, sw.status === 'done' || sw.status === 'cancelled'),
          ),
        },
        track: ((o) => ({
          ru: workTrack(w, own, { ...o, lang: 'ru' }),
          en: workTrack(w, own, { ...o, lang: 'en' }),
        }))({
          maxAttempts: policy.maxAttempts,
          recovery,
          question: !!blockingRequest(v, w),
          budgetHeld: sw.blockers.some((b) => b.code === 'BUDGET_EXHAUSTED'),
          ...((held) => (held ? { gateHold: held.gate } : {}))(
            h.engine.gateHoldsOf(w, gateHolds)[0],
          ),
        }),
        ...((r) => (r ? { reopened: r } : {}))(reopenedOf(w, events)),
        ...((rows) => (rows.length ? { attemptReviews: rows } : {}))(
          attemptReviewsOf(own, earlier),
        ),
        rechecks: own.reduce((n, a) => n + a.evidence.filter((e) => e.recheck).length, 0),
        ...(sw.liveness ? { liveness: sw.liveness } : {}),
        ...(active?.status === 'active'
          ? {
              active: { runtime: active.runtime, ...(active.model ? { model: active.model } : {}) },
            }
          : {}),
        blockers: sw.blockers,
        ...(sw.input ? { input: sw.input } : {}),
        ...(sw.target
          ? {
              target:
                options.lang === 'en' && sw.target.unavailable !== undefined
                  ? { ...sw.target, unavailable: translateUnavailable(sw.target.unavailable) }
                  : sw.target,
            }
          : {}),
        ...(sw.verification ? { verification: sw.verification } : {}),
      };
    });
    const closed = new Set(
      works.filter((w) => w.status === 'done' || w.status === 'cancelled').map((w) => w.id),
    );
    const inputPolicy = policy.inputPolicy ?? DEFAULT_INPUT_POLICY;
    // Вопросы закрытых работ — только для деталей работы (`closed`): обзор их
    // не показывает, детали называют, кто и почему ответил. Отмена работы
    // переводит её запросы в `cancelled`, замена — в `superseded`: у закрытой
    // работы такой вопрос остаётся с состоянием по своему lifecycle.
    const questions = requestsOf(v)
      .filter((r) => r.kind === 'question')
      .flatMap((r) => {
        const raw = inputStateOf(r) ?? (closed.has(r.workId) ? r.lifecycle : undefined);
        if (!raw) return [];
        // Ответ у идущей попытки — `delivered` (как `status.works[].input`).
        const carried = closed.has(r.workId)
          ? undefined
          : carriedInput({ requestId: r.id, state: raw }, attemptsOf.get(r.workId) ?? []);
        const state = carried?.state ?? raw;
        const impact = (r.question as { impact?: string | null }).impact ?? undefined;
        const plain = plainOf(r);
        const last = r.answers.at(-1);
        const by = last?.actor.kind;
        return [
          {
            requestId: r.id,
            workId: r.workId,
            state,
            version: r.version,
            severity: r.effectiveSeverity,
            createdAt: r.createdAt,
            text: r.question.question,
            ...(plain ? { plain } : {}),
            ...(impact ? { impact } : {}),
            ...(by ? { answeredBy: by } : {}),
            ...(last
              ? {
                  answer: {
                    by: last.actor.kind,
                    ...(last.basis ? { basis: last.basis } : {}),
                    ...(last.reason ? { reason: last.reason } : {}),
                    at: last.at,
                  },
                }
              : {}),
            ...(closed.has(r.workId) ? { closed: true } : {}),
            ...(carried?.carrier ? { carrier: carried.carrier } : {}),
            options: r.question.options.map((o) => ({ id: o.id, label: o.label })),
            recommended: r.question.recommended,
            ...(r.question.rationale ? { rationale: r.question.rationale } : {}),
            leadMay: leadMayAnswer(r, inputPolicy),
          },
        ];
      });
    const reviews = reviewsOf(v, policy);
    const activity = activityInputOf(
      attempts,
      v.locals('reviews', WORKSPACE_OWNER).map((r) => r.value),
      v.locals('code-reviews', WORKSPACE_OWNER).map((r) => r.value),
      requestsOf(v),
      v.works(),
    );
    const decisions = decisionsInputOf(
      v.works(),
      requestsOf(v),
      v.locals('reviews', WORKSPACE_OWNER).map((r) => r.value),
      events,
      recovery,
    );
    const control = v.control();
    const controller = v.controller();
    const raw = view.raw;
    return {
      now,
      harnessVersion: HARNESS_VERSION,
      stateVersion: status.stateVersion,
      policy,
      policyDigest: policyDigest(policy),
      effective: {
        inputPolicy,
        stall: policy.stallSweep ?? DEFAULT_STALL_SWEEP,
        // Порог настроек — предел строгого режима; в облегчённом раундов не
        // считают (строки ревью: «без предела»), поле договора — число.
        reviewRoundCap: strictReviewRoundCap(policy),
      },
      defaulted: defaultedPaths(policy, raw),
      ...((layers) => (layers ? { manifestLayers: layers } : {}))(manifestLayers(view.baseDir)),
      works,
      attempts: attempts.map((a) => ({
        workId: a.workId,
        runId: a.id,
        attempt: a.attempt,
        ...(earlier.has(a.id) ? { earlier: true as const } : {}),
        status: a.status,
        startedAt: a.startedAt,
        ...(a.finishedAt ? { finishedAt: a.finishedAt } : {}),
        failureBucket: failureBucketOf(a),
        interrupted: interruptedByShutdown(a),
        callsRecorded: !!a.callsRecorded,
        runtime: a.runtime,
        ...(a.model ? { model: a.model } : {}),
        stages: a.timings ?? [],
        ...((reached) => (reached ? { reached } : {}))(reachedStage(a.timings ?? [])),
      })),
      gateEvents: attempts.flatMap((a) =>
        a.evidence
          .filter((e) => e.kind !== 'review')
          .map((e) => ({
            at: e.createdAt,
            passed: e.passed,
            applicable: e.kind === 'test',
            ...(e.recheck ? { recheck: true } : {}),
            ...(e.reusedEvidence ? { reused: true } : {}),
          })),
      ),
      calls: records.map((r) => ({
        at: r.finishedAt ?? r.startedAt,
        knownUsd: callCostKnown(r) ? r.costUsd : null,
        complete: complete(r),
      })),
      questions,
      reviews: reviews.reviews,
      reviewRounds: [
        ...reviews.rounds,
        // Ревью в попытке: одна запись evidence ревью на попытку и фазу (кандидат, интеграция).
        ...attemptReviewRounds(attempts),
      ],
      stageTypical: stageTypicalOf(attempts),
      stops,
      queue: {
        paused: control.paused,
        ...(queue?.reason ? { reason: queue.reason } : {}),
        ...(queue?.detail
          ? {
              detail:
                options.lang === 'en' && 'liftedByRun' in queue && queue.liftedByRun
                  ? 'the next harness run lifts the pause'
                  : queue.detail,
            }
          : {}),
        ...(queue?.actor !== undefined ? { actor: queue.actor } : {}),
        ...(queue?.action ? { action: queue.action } : {}),
        ...(status.runner
          ? {
              runner: status.runner.state,
              ...(status.runner.restartBy ? { restartBy: status.runner.restartBy } : {}),
              ...(status.runner.ready ? { ready: status.runner.ready } : {}),
              ...(status.runner.readyWorks ? { readyWorks: status.runner.readyWorks } : {}),
              ...(status.runner.heldByQuestion
                ? { heldByQuestion: status.runner.heldByQuestion }
                : {}),
              line: status.runner.line,
              lineEn: status.runner.lineEn,
            }
          : !works.length && !attempts.length && !records.length && !controller
            ? NEVER_RUN
            : {}),
      },
      ...(controller ? { controller: { leaseUntil: controller.leaseUntil } } : {}),
      ...((log) =>
        log
          ? {
              lead: {
                ...(log.session
                  ? {
                      session: {
                        since: log.session.since,
                        until: log.session.until,
                        ...(log.session.endedAt ? { endedAt: log.session.endedAt } : {}),
                      },
                    }
                  : {}),
                entries: log.entries,
                ...(log.release
                  ? { release: { doneAt: log.release.doneAt, summary: log.release.summary } }
                  : {}),
              },
            }
          : {})(v.local('lead', WORKSPACE_OWNER, 'log')),
      ...((outline) => (outline ? { outline } : {}))(
        v.local('release-outline', WORKSPACE_OWNER, 'outline'),
      ),
      ...((r) => (r ? { resources: r } : {}))(
        resourcesInputOf(policy, h.stateDir, view.baseDir, {
          // Попытка закончилась по снимку хранилища: квитанция окружения
          // «active» у закончившейся попытки — оставшееся после неё.
          attemptFinished: (runId) => {
            const a = v.attempt(runId);
            return a ? a.status !== 'active' : undefined;
          },
          heldGates: h.engine
            .environmentGateHolds(v)
            .map((x) => ({ repositoryId: x.repositoryId, gate: x.gate, workId: x.workId })),
        }),
      ),
      ...(status.budgets ? { budgets: status.budgets.budgets } : {}),
      activity,
      decisions,
      warnings: view.warnings,
      mask: maskContextOf(policy, view.baseDir, h.stateDir),
      ...sourcesInput(h.stateDir, known),
    };
  });
}

/**
 * Связки с источниками задач в каталоге состояния
 * (`<state>/connectors/*.sqlite`): срез последнего снимка, совместимость и
 * вопросы владельцу из последнего наблюдения. Только чтение, без сети;
 * повреждённая или чужая база пропускается (представление не отказывает).
 */
export function connectorSources(
  stateDir: string,
  works: ReadonlySet<string> = new Set(),
): OperatorSourceInput[] {
  return readConnectorSources(stateDir, works).sources;
}

/** Поля входа о связках: срезы и число баз, которые прочитать не удалось. */
function sourcesInput(
  stateDir: string,
  works?: ReadonlySet<string>,
): Pick<OperatorViewInput, 'sources' | 'sourcesUnread'> {
  const { sources, unread } = readConnectorSources(stateDir, works);
  return { ...(sources.length ? { sources } : {}), ...(unread ? { sourcesUnread: unread } : {}) };
}

/**
 * Связки каталога состояния и число баз коннектора, которые есть, но не
 * прочитаны (чужая схема, другая версия, повреждение): по ним нельзя сказать,
 * что снимка нет. База известной схемы без снимка и наблюдения — не
 * прочитанная трекером связка, а не ошибка чтения.
 */
function readConnectorSources(
  stateDir: string,
  works: ReadonlySet<string> = new Set(),
): { sources: OperatorSourceInput[]; unread: number } {
  const dir = join(resolve(stateDir), 'connectors');
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.sqlite'))
      .sort();
  } catch {
    return { sources: [], unread: 0 };
  }
  const out: OperatorSourceInput[] = [];
  let unread = 0;
  for (const file of files) {
    const path = join(dir, file);
    // Без журнала — неизменяемое открытие (ни одного файла рядом с базой); если
    // за время чтения база изменилась, чтение повторяется обычным открытием.
    const mark = () => {
      const st = statSync(path, { throwIfNoEntry: false });
      return JSON.stringify([
        st?.size,
        st?.mtimeMs,
        existsSync(path + '-wal'),
        existsSync(path + '-journal'),
      ]);
    };
    const before = mark();
    const journal = existsSync(path + '-wal') || existsSync(path + '-journal');
    let source = readConnectorDb(path, file, works, !journal);
    if (!journal && mark() !== before) source = readConnectorDb(path, file, works, false);
    if (source === 'unreadable') unread++;
    else if (source !== 'empty') out.push(source);
  }
  return { sources: out, unread };
}

function readConnectorDb(
  path: string,
  file: string,
  works: ReadonlySet<string>,
  immutable: boolean,
): OperatorSourceInput | 'empty' | 'unreadable' {
  let db: DatabaseSync | undefined;
  try {
    if (!immutable) db = new DatabaseSync(path, { readOnly: true });
    else {
      const url = pathToFileURL(path);
      url.searchParams.set('mode', 'ro');
      url.searchParams.set('immutable', '1');
      db = new DatabaseSync(url, { readOnly: true });
    }
    const meta = (k: string) =>
      (db!.prepare('SELECT value FROM meta WHERE key=?').get(k) as { value: string } | undefined)
        ?.value;
    const provider = meta('provider');
    const projectId = meta('projectId');
    // Только база коннектора известной схемы: чужая или другой версии — пропуск.
    if (!provider || !projectId || meta('schema') !== '1') return 'unreadable';
    const row = db.prepare('SELECT data FROM snapshots ORDER BY rowid DESC LIMIT 1').get() as
      { data: string } | undefined;
    const manifest = row
      ? (JSON.parse(row.data) as { manifest?: SnapshotManifestLike }).manifest
      : undefined;
    let observation: RelayObservationLike | undefined;
    try {
      const o = db.prepare('SELECT data FROM observations WHERE key=?').get('relay') as
        { data: string } | undefined;
      observation = o ? (JSON.parse(o.data) as RelayObservationLike) : undefined;
    } catch {
      observation = undefined;
    }
    if (!manifest && !observation) return 'empty';
    const connector =
      manifest?.connector ?? observation?.connector ?? file.replace(/\.sqlite$/, '');
    const compatibility = observation?.compatibility ?? manifest?.compatibility;
    // Срез — из последнего чтения (наблюдение), а не из записи снимка: запись
    // той же ревизии не обновляется, а колонка и зависимости меняются без неё.
    const scope = observation?.scope ?? {
      readAt: manifest?.readAt,
      tasks: manifest?.tasks ?? [],
      problems: manifest?.problems ?? [],
    };
    const release = releaseOf(db, path, scope, works);
    const deliveries = sourceReviewsOf(db, release.tasks);
    const delivered = deliveredOf(db);
    return {
      connector,
      provider,
      ...(release.tasks.length ? { release: release.tasks } : {}),
      ...(release.startedAt ? { releaseStartedAt: release.startedAt } : {}),
      ...(deliveries.length ? { reviews: deliveries } : {}),
      ...(delivered.length ? { delivered } : {}),
      tasks: scope.tasks.map((t) => ({
        id: t.id,
        key: t.key,
        ...(t.title ? { title: t.title } : {}),
        orderId: t.orderId,
        ...(works.has(t.orderId) ? { workId: t.orderId } : {}),
        problems: scope.problems
          .filter((p) => p.taskId === t.id)
          .map((p) => ({ code: p.code, message: p.message })),
      })),
      ...(compatibility
        ? {
            compatibility: {
              level: compatibility.level,
              taskContext: compatibility.taskContext,
              taskContextUsed: compatibility.taskContextUsed,
              contractVersion: compatibility.contractVersion,
              recommended: compatibility.recommended,
            },
          }
        : {}),
      ...((at) => (at ? { observedAt: at } : {}))(observation?.at ?? manifest?.readAt),
      ...(observation?.questions ? { questions: observation.questions.items } : {}),
    };
  } catch {
    /* не база коннектора или другой версии — пропустить */
    return 'unreadable';
  } finally {
    db?.close();
  }
}

/** Порядок этапов попытки для «дальше всего дошла» (`reachedStage`). */
const REACHED_ORDER = ['prepare', 'writer', 'gates', 'review', 'integration'] as const;

/** Самый дальний этап, до которого попытка дошла по своим замерам. */
function reachedStage(timings: readonly { stage: string }[]): string | undefined {
  let best = -1;
  for (const t of timings) {
    const stage = stageOfStep(t.stage);
    const k = stage ? (REACHED_ORDER as readonly string[]).indexOf(stage) : -1;
    if (k > best) best = k;
  }
  return best < 0 ? undefined : REACHED_ORDER[best];
}

/** Сколько последних снимков связки читает объём выпуска (`releaseOf`). */
const RELEASE_SNAPSHOTS = 500;

type ScopeLike = NonNullable<RelayObservationLike['scope']>;
type ReleaseTask = NonNullable<OperatorSourceInput['release']>[number];

type SnapshotTask = { id: string; key: string; title?: string; orderId: string; column?: string };
type SnapshotProblem = { taskId: string; code: string; message: string };
type SnapshotRows = {
  at: string;
  /** Граф снимка (выборка задач): у каждой выборки — своя последняя запись. */
  graphId?: string;
  tasks: SnapshotTask[];
  problems: SnapshotProblem[];
  /** Зависимости поручений снимка: orderId → orderId зависимостей. */
  deps: Record<string, string[]>;
}[];

/**
 * Разобранные снимки связки по файлу базы: представление опрашивается часто,
 * а снимков до 500 — ключ кэша — размер и время изменения базы и её журнала.
 */
const snapshotCache = new Map<string, { key: string; rows: SnapshotRows }>();

function snapshotRows(db: DatabaseSync, path: string): SnapshotRows {
  const stamp = (p: string) => {
    const st = statSync(p, { throwIfNoEntry: false });
    return st ? [st.size, st.mtimeMs] : null;
  };
  const key = JSON.stringify([stamp(path), stamp(path + '-wal')]);
  const hit = snapshotCache.get(path);
  if (hit && hit.key === key) return hit.rows;
  const raw = db
    .prepare(
      `SELECT created_at AS at, json_extract(data, '$.manifest.tasks') AS tasks,
              json_extract(data, '$.manifest.problems') AS problems,
              graph_id AS graph,
              (SELECT json_group_array(json_array(json_extract(o.value, '$.id'),
                                                  json_extract(o.value, '$.dependsOn')))
                 FROM json_each(data, '$.graph.orders') AS o) AS deps
         FROM (SELECT rowid, created_at, graph_id, data FROM snapshots ORDER BY rowid DESC LIMIT ${RELEASE_SNAPSHOTS})
        ORDER BY rowid`,
    )
    .all() as {
    at: string;
    tasks: string | null;
    problems: string | null;
    graph: string | null;
    deps: string | null;
  }[];
  const parse = <T>(text: string | null): T[] => {
    try {
      const v = text ? (JSON.parse(text) as unknown) : [];
      return Array.isArray(v) ? (v as T[]) : [];
    } catch {
      return [];
    }
  };
  const depsOf = (text: string | null) => {
    const out: Record<string, string[]> = {};
    for (const pair of parse<unknown>(text)) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
      let list: unknown = pair[1];
      if (typeof list === 'string')
        try {
          list = JSON.parse(list);
        } catch {
          list = [];
        }
      out[pair[0]] = Array.isArray(list)
        ? list.filter((x): x is string => typeof x === 'string').slice(0, 100)
        : [];
    }
    return out;
  };
  const rows = raw.map((r) => ({
    at: r.at,
    ...(typeof r.graph === 'string' && r.graph ? { graphId: r.graph } : {}),
    tasks: parse<SnapshotTask>(r.tasks),
    problems: parse<SnapshotProblem>(r.problems),
    deps: depsOf(r.deps),
  }));
  // Предел кэша — несколько связок одного процесса (панель читает свои базы).
  if (snapshotCache.size >= 32) snapshotCache.clear();
  snapshotCache.set(path, { key, rows });
  return rows;
}

/**
 * Объём выпуска (доска связки): задачи всех снимков связки, а не только
 * последнего среза `run`. О каждой задаче — последнее, что о ней записано
 * (колонка, проблемы), и время, когда она впервые попала в снимок; последнее
 * чтение (наблюдение или последний снимок) дополняет и уточняет снимки.
 * Задача, которой нет в последнем чтении и у которой нет работы harness
 * (удалена с доски или выведена из области), в выпуск не входит. Начало
 * выпуска — первое появление задачи, оставшейся в нём.
 */
function releaseOf(
  db: DatabaseSync,
  path: string,
  scope: ScopeLike,
  works: ReadonlySet<string>,
): { tasks: ReleaseTask[]; startedAt?: string } {
  const rows = snapshotRows(db, path);
  const byId = new Map<string, ReleaseTask>();
  const put = (
    at: string | undefined,
    tasks: readonly SnapshotTask[],
    problems: readonly SnapshotProblem[],
    row?: SnapshotRows[number],
  ) => {
    for (const t of tasks) {
      const prev = byId.get(t.id);
      const deps = row?.deps[t.orderId] ?? prev?.dependsOn;
      const graphId = row?.graphId ?? prev?.graphId;
      byId.set(t.id, {
        id: t.id,
        key: t.key,
        ...((title) => (title ? { title } : {}))(t.title ?? prev?.title),
        orderId: t.orderId,
        ...(works.has(t.orderId) ? { workId: t.orderId } : {}),
        ...((column) => (column ? { column } : {}))(t.column ?? prev?.column),
        ...((first) => (first ? { firstSeenAt: first } : {}))(prev?.firstSeenAt ?? at),
        ...(graphId ? { graphId } : {}),
        ...(deps?.length ? { dependsOn: deps } : {}),
        ...(row || prev?.snapshot ? { snapshot: true as const } : {}),
        problems: problems
          .filter((p) => p.taskId === t.id)
          .map((p) => ({ code: p.code, message: p.message })),
      });
    }
  };
  for (const r of rows) put(r.at, r.tasks, r.problems, r);
  put(scope.readAt, scope.tasks, scope.problems);
  const latest = new Set(scope.tasks.map((t) => t.id));
  // Планируемая работа (P4-5): задачи последней записи каждой выборки
  // (графа снимка) — проверенный, но не согласованный план — входят в выпуск,
  // даже если последнее чтение связки было уже (выборка `run --source`).
  const lastOfGraph = new Map<string, SnapshotRows[number]>();
  for (const r of rows) if (r.graphId) lastOfGraph.set(r.graphId, r);
  const planned = new Set<string>();
  for (const r of lastOfGraph.values()) for (const t of r.tasks) planned.add(t.id);
  const tasks = [...byId.values()].filter(
    (t) => latest.has(t.id) || works.has(t.orderId) || planned.has(t.id),
  );
  const starts = tasks
    .map((t) => t.firstSeenAt)
    .filter((x): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x)))
    .sort((x, y) => Date.parse(x) - Date.parse(y));
  return { tasks, ...(starts[0] ? { startedAt: starts[0] } : {}) };
}

/**
 * Принятые работы, оставленные в источнике на проверку человеку: последняя
 * доставка задачи — принятый результат, перенесённый в колонку не `done`
 * (`completion.mode: review-only` или своя колонка), и по последнему
 * чтению задача не закрыта и не отменена.
 */
function sourceReviewsOf(
  db: DatabaseSync,
  release: readonly ReleaseTask[],
): NonNullable<OperatorSourceInput['reviews']> {
  let rows: { task: string; work: string; status: string; data: string; at: string }[];
  try {
    rows = db
      .prepare(
        `SELECT task_id AS task, work_id AS work, status, data, updated_at AS at FROM operations
          ORDER BY updated_at, rowid`,
      )
      .all() as typeof rows;
  } catch {
    return [];
  }
  // Последняя операция задачи любого состояния заменяет прежние: новая
  // доставка в работе или с конфликтом — уже не «ждёт проверки».
  const last = new Map<string, (typeof rows)[number]>();
  for (const r of rows) last.set(r.task, r);
  for (const [task, r] of last) if (r.status !== 'delivered') last.delete(task);
  const tasks = new Map(release.map((t) => [t.id, t]));
  const out: NonNullable<OperatorSourceInput['reviews']>[number][] = [];
  for (const r of last.values()) {
    let op: {
      outcome?: string;
      steps?: {
        kind?: string;
        status?: string;
        input?: { column?: unknown };
        updatedAt?: string;
      }[];
    };
    try {
      op = JSON.parse(r.data) as typeof op;
    } catch {
      continue;
    }
    if (op.outcome !== 'accepted') continue;
    const move = op.steps?.find((s) => s.kind === 'move' && s.status === 'done');
    const column = typeof move?.input?.column === 'string' ? move.input.column : undefined;
    if (!column || column === 'done' || column === 'cancelled') continue;
    const task = tasks.get(r.task);
    const closed = task?.problems.some(
      (p) => p.code === 'TASK_DONE' || p.code === 'TASK_CANCELLED',
    );
    if (closed || task?.column === 'done' || task?.column === 'cancelled') continue;
    out.push({
      taskId: r.task,
      ...(task?.key ? { key: task.key } : {}),
      workId: r.work,
      column,
      since: move?.updatedAt ?? r.at,
    });
  }
  return out;
}

/**
 * Работы, доставленные в источник (ревизия 6, шаг ведущего «доставка»):
 * последняя операция задачи доставлена и несёт принятый результат.
 */
function deliveredOf(db: DatabaseSync): string[] {
  let rows: { task: string; work: string; status: string; data: string }[];
  try {
    rows = db
      .prepare(
        `SELECT task_id AS task, work_id AS work, status, data FROM operations
          ORDER BY updated_at, rowid`,
      )
      .all() as typeof rows;
  } catch {
    return [];
  }
  const last = new Map<string, (typeof rows)[number]>();
  for (const r of rows) last.set(r.task, r);
  const out = new Set<string>();
  for (const r of last.values()) {
    if (r.status !== 'delivered') continue;
    try {
      if ((JSON.parse(r.data) as { outcome?: string }).outcome === 'accepted') out.add(r.work);
    } catch {
      /* запись не разобрана — не доставка */
    }
  }
  return [...out].sort();
}

/** Поля manifest снимка коннектора, которые читает представление. */
interface SnapshotManifestLike {
  connector?: string;
  readAt?: string;
  tasks?: { id: string; key: string; title?: string; orderId: string }[];
  problems?: { taskId: string; code: string; message: string }[];
  compatibility?: RelayObservationLike['compatibility'];
}
interface RelayObservationLike {
  at?: string;
  connector?: string;
  compatibility?: {
    level: string;
    taskContext: boolean;
    taskContextUsed: boolean;
    contractVersion: number | null;
    recommended: string;
  };
  questions?: { items: NonNullable<OperatorSourceInput['questions']> };
  scope?: {
    readAt?: string;
    tasks: { id: string; key: string; title?: string; orderId: string }[];
    problems: { taskId: string; code: string; message: string }[];
  };
}

/** Что маскировать: домашний каталог, корни репозиториев и каталог политики, секреты политики. */
export function maskContextOf(policy: ExecutionPolicy, baseDir: string, stateDir?: string) {
  const roots = [
    ...policy.repositories.map((r) => (isAbsolute(r.path) ? r.path : resolve(baseDir, r.path))),
    resolve(baseDir),
    ...(stateDir ? [resolve(stateDir)] : []),
  ];
  return { home: homedir(), roots, secrets: policySecrets(policy) };
}

/**
 * Очередь каталога, с которым harness ещё ничего не запускал: не «идёт» и не
 * «стоит» — первый запуск делает ведущий.
 */
const NEVER_RUN = {
  neverRun: true,
  line: 'Ещё ничего не запускали — ведущий начнёт с harness run.',
  lineEn: 'Nothing has run yet — the lead starts with harness run.',
} as const;

/** Пустой вход: состояния ещё нет, настройки — из политики. */
function emptyInput(policy: ViewPolicy, now: number, stateDir: string): OperatorViewInput {
  return {
    now,
    harnessVersion: HARNESS_VERSION,
    stateVersion: STATE_VERSION,
    policy: policy.policy,
    policyDigest: policyDigest(policy.policy),
    effective: {
      inputPolicy: policy.policy.inputPolicy ?? DEFAULT_INPUT_POLICY,
      stall: policy.policy.stallSweep ?? DEFAULT_STALL_SWEEP,
      reviewRoundCap: strictReviewRoundCap(policy.policy),
    },
    defaulted: defaultedPaths(policy.policy, policy.raw),
    ...((layers) => (layers ? { manifestLayers: layers } : {}))(manifestLayers(policy.baseDir)),
    works: [],
    attempts: [],
    gateEvents: [],
    calls: [],
    questions: [],
    reviews: [],
    stops: [],
    queue: { paused: false, ...NEVER_RUN },
    activity: [],
    decisions: [],
    ...(policy.policy.budgets ? { budgets: [] } : {}),
    warnings: [
      ...policy.warnings,
      {
        code: 'STATE_NOT_FOUND',
        message: 'состояния пока нет: harness run ещё не запускался с этим каталогом',
        messageEn: 'there is no state yet: harness run has not used this state directory',
      },
    ],
    mask: maskContextOf(policy.policy, policy.baseDir, stateDir),
    ...sourcesInput(stateDir),
  };
}

export interface HarnessViewOptions extends Omit<OperatorViewOptions, 'maxBytes'> {
  /** Каталог состояния; без него — из `.harness/project.json` репозитория `repository`. */
  stateDir?: string;
  /**
   * Корень репозитория проекта (ревизия 5): состояние и политика — из
   * `.harness/project.json` и `.harness/policy.json` при каждом чтении, так что
   * панель, запущенная до настройки, подхватит их, когда они появятся.
   */
  repository?: string;
  /** Файл политики; без него — привязанная к состоянию. */
  policyPath?: string;
  /** Детали работы вместо обзора. */
  workId?: string;
  /** Часы представления (тесты). */
  now?: number;
}

/**
 * Представление оператора по каталогу состояния (`harness view`): только
 * чтение; нет состояния — пустое представление по `--policy`.
 */
export function harnessView(
  options: HarnessViewOptions,
): OperatorView | WorkDetailView | SetupView {
  const located = locateProject(options);
  const now = options.now ?? Date.now();
  // Ход настройки (ревизия 7): по `.harness/` проекта и записям smoke/gates
  // каталога состояния — только в раскладке проекта harness.
  const progressOf = (harnessDir: string | undefined, stateDir?: string) =>
    harnessDir && basename(harnessDir) === HARNESS_PROJECT_DIR && existsSync(harnessDir)
      ? setupProgress({ harnessDir, ...(stateDir ? { stateDir } : {}), now })
      : undefined;
  const setup = (waitingFor: 'project' | 'policy', progress?: SetupProgress) =>
    setupView(
      {
        now,
        harnessVersion: HARNESS_VERSION,
        stateVersion: STATE_VERSION,
        waitingFor,
        ...(progress ? { progress } : {}),
      },
      options.lang ? { lang: options.lang } : {},
    );
  if (!located)
    return setup(
      'project',
      options.repository
        ? progressOf(join(resolve(options.repository), HARNESS_PROJECT_DIR))
        : undefined,
    );
  const stateDir = located.stateDir;
  // Политика проекта из manifest, которой ещё нет, — не явный `--policy`:
  // без неё действует привязка состояния (или прежний отказ POLICY_REQUIRED).
  const policyPath =
    located.policyPath && (options.policyPath || existsSync(located.policyPath))
      ? located.policyPath
      : undefined;
  // Документ настройки — только для `--repository`: manifest есть, но ни
  // привязки, ни политики проекта, ни базы состояния ещё нет. `--state`
  // сохраняет прежнюю форму (пустой обзор по `--policy` или отказ), явный
  // `--policy` без файла и база без привязки — прежние отказы.
  if (
    located.fromManifest &&
    !options.policyPath &&
    !existsSync(join(stateDir, 'binding.json')) &&
    !existsSync(join(stateDir, 'state.sqlite')) &&
    (policyPath === undefined || !existsSync(policyPath))
  )
    return setup('policy', progressOf(located.policyPath && dirname(located.policyPath), stateDir));
  const policy = viewPolicy(stateDir, policyPath);
  const projection: OperatorViewOptions = {
    ...(options.windowMs !== undefined ? { windowMs: options.windowMs } : {}),
    ...(options.bucketMs !== undefined ? { bucketMs: options.bucketMs } : {}),
    ...(options.titles !== undefined ? { titles: options.titles } : {}),
    ...(options.lang ? { lang: options.lang } : {}),
  };
  const updates = options.workId === undefined ? updatesInput(stateDir, policy.baseDir) : undefined;
  // Живые превью результата — из их receipt, только чтение (docs/previews.md).
  const previews = options.workId === undefined ? previewsInput(stateDir) : undefined;
  const project = (input: OperatorViewInput) => {
    if (options.workId !== undefined) return workDetailView(input, options.workId, projection);
    // Пока работ нет — ход настройки (ревизия 7).
    const progress = input.works.length
      ? undefined
      : progressOf(policyPath ? dirname(policyPath) : policy.baseDir, stateDir);
    return operatorView(
      {
        ...input,
        ...(updates ? { updates } : {}),
        ...(previews ? { previews } : {}),
        ...(progress ? { setup: progress } : {}),
      },
      projection,
    );
  };
  if (!existsSync(join(stateDir, 'state.sqlite')))
    return project(emptyInput(policy, options.now ?? Date.now(), stateDir));
  // Однократное чтение без файлов в каталоге состояния (как `report`):
  // неизменяемое открытие с проверкой после чтения, иначе обычное.
  return SqliteExecutionStore.readOnce(
    join(stateDir, 'state.sqlite'),
    'devcontour-harness@' + HARNESS_VERSION,
    (store) => {
      // Одни часы на всё чтение: этап, живость и окно истории — от одного `now`.
      const now = options.now ?? Date.now();
      const engine = new Engine({
        now: () => now,
        host: standaloneHost(store, policy.policy),
        policy: policy.policy,
      });
      const source: ViewSource = {
        engine,
        policy: policy.policy,
        workflows: new WorkflowQueue(store, policy.policy, () => engine.clock()),
        stateDir,
        baseDir: policy.baseDir,
        store,
      };
      return project(
        collectOperatorViewInput(source, policy, {
          now,
          ...(options.lang ? { lang: options.lang } : {}),
        }),
      );
    },
  );
}

/**
 * Каталог состояния и файл политики представления: явные (`stateDir`,
 * `policyPath`) или из manifest репозитория (`.harness/project.json`). Нет
 * manifest — `undefined` (проект ещё не настроен).
 */
export function locateProject(options: {
  stateDir?: string;
  repository?: string;
  policyPath?: string;
}): { stateDir: string; policyPath?: string; fromManifest?: true } | undefined {
  if (options.stateDir)
    return {
      stateDir: resolve(options.stateDir),
      ...(options.policyPath ? { policyPath: resolve(options.policyPath) } : {}),
    };
  if (!options.repository)
    throw new HarnessError('INVALID_INPUT', 'Нужен --state или --repository', [
      { path: ['--state'], message: 'required without --repository' },
    ]);
  const root = resolve(options.repository);
  const file = join(root, PROJECT_MANIFEST_PATH);
  if (!existsSync(file)) return undefined;
  const manifest = projectManifestSchema.safeParse(readJson(file, 'project'));
  if (!manifest.success)
    throw new HarnessError('INVALID_INPUT', 'Файл проекта не по схеме: ' + file, [
      { path: [PROJECT_MANIFEST_PATH], message: manifest.error.issues[0]?.message ?? 'invalid' },
    ]);
  return {
    // Относительный каталог состояния — от корня репозитория, а не от cwd.
    stateDir: resolve(root, manifest.data.paths.state),
    policyPath: options.policyPath
      ? resolve(options.policyPath)
      : join(root, manifest.data.paths.policy),
    fromManifest: true,
  };
}

/**
 * Обновления для представления: последняя проверка `harness update --check`
 * из `<state>-updates/last-check.json` и режим из `.harness/updates.json`.
 * Ни настройки, ни проверки — поля нет; настройка не по схеме — тоже нет
 * (представление не ломается, отказ видно в `harness update`).
 */
/** Живые превью для представления: receipt `running` с живым supervisor; нет — undefined. */
function previewsInput(stateDir: string): PreviewView[] | undefined {
  const list = livePreviews(stateDir).flatMap((r) =>
    r.url
      ? [
          {
            id: r.id,
            repositoryId: r.repositoryId,
            ...(r.title ? { title: r.title } : {}),
            url: r.url,
            ref: r.ref,
            sha: r.sha,
            ...(r.workId ? { workId: r.workId } : {}),
            startedAt: r.startedAt,
            expiresAt: r.expiresAt,
            state: 'running' as const,
          },
        ]
      : [],
  );
  return list.length ? list : undefined;
}

function updatesInput(stateDir: string, baseDir: string): UpdatesView | undefined {
  try {
    const { config, exists } = loadUpdatesConfig(baseDir, { quiet: true });
    const installed = installedHarness(baseDir);
    const cached = cachedUpdates(stateDir, config, installed);
    if (!cached || (!exists && cached.state === 'not-checked')) return undefined;
    const c = cached.check;
    const current =
      c && cached.state !== 'up-to-date'
        ? c.current
        : { harness: installed, ...(c?.current.ui ? { ui: c.current.ui } : {}) };
    return {
      state: cached.state,
      mode: config.mode,
      current,
      ...(c?.available && cached.state !== 'up-to-date' ? { available: c.available } : {}),
      ...(c ? { checkedAt: c.checkedAt } : {}),
      line: cached.line,
      ...(c?.whatsNew?.length && cached.state !== 'up-to-date' ? { whatsNew: c.whatsNew } : {}),
      ...(c?.command && cached.state !== 'up-to-date' ? { command: c.command } : {}),
    };
  } catch {
    return undefined;
  }
}
