// Загрузчик представления оператора для node (`harness view`): политика,
// снимок состояния (`status --detail` и записи хранилища одним `read`),
// сверка принятого с target ref (git), манифест проекта рядом с политикой.
// Числа берутся из тех же функций, что у `status` и `report`; проекция
// (`operatorView`, `workDetailView`) только раскладывает и маскирует.
// Только чтение: каталог состояния не создаётся и не пишется.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
} from '../contracts/index.ts';
import { HARNESS_VERSION } from '../package.ts';
import {
  attemptCounted,
  callCostKnown,
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
import { stopInputsIn } from '../explain/state.ts';
import { policySecrets } from '../environment/redaction.ts';
import {
  operatorView,
  workDetailView,
  type OperatorActivityInput,
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
import { reviewRoundCap } from './review.ts';
import { reviewSubjectSummary } from './review-summary.ts';
import { stageOfStep } from './stage.ts';
import { cachedUpdates, installedHarness, loadUpdatesConfig } from '../update/check.ts';
import type { UpdatesView } from '../projections/operator-view.ts';

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
    const s = reviewSubjectSummary(r, max, spent);
    const counts = findingCounts(r.findings);
    const waiting = escalatedFindings(r.findings, r.round);
    return {
      kind: s.kind,
      subject: s.subject,
      at: r.at,
      approved: s.approved,
      rounds: s.rounds,
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
        `${s.kind} ${s.subject}: ${reviewVerdictText(s.approved, counts, 'en')}; rounds ${s.rounds.used}${s.rounds.max === null ? '' : '/' + s.rounds.max}`,
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
): OperatorActivityInput[] {
  const out: OperatorActivityInput[] = [];
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
        }
      : source;
  const policy = h.policy;
  const now = options.now ?? h.engine.clock();
  // Один снимок: вложенные чтения хранилища (status, задания графов) видят
  // ту же транзакцию, что и записи ниже.
  return h.engine.read((v) => {
    const status = statusWithTargets(h);
    const jobs = h.workflows.list().filter((j) => j.kind === 'graph');
    const attempts = v.attempts();
    const attemptsOf = new Map<string, typeof attempts>();
    for (const a of attempts) attemptsOf.set(a.workId, [...(attemptsOf.get(a.workId) ?? []), a]);
    const runWork = new Map(attempts.map((a) => [a.id, a.workId]));
    const known = new Set(v.works().map((w) => w.id));
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
      return {
        id: sw.id,
        graphId: sw.graphId,
        status: sw.status,
        title: w.order.title,
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
        reviewRoundCap: reviewRoundCap(policy),
      },
      defaulted: defaultedPaths(policy, raw),
      ...((layers) => (layers ? { manifestLayers: layers } : {}))(manifestLayers(view.baseDir)),
      works,
      attempts: attempts.map((a) => ({
        workId: a.workId,
        runId: a.id,
        attempt: a.attempt,
        status: a.status,
        startedAt: a.startedAt,
        ...(a.finishedAt ? { finishedAt: a.finishedAt } : {}),
        failureBucket: failureBucketOf(a),
        interrupted: interruptedByShutdown(a),
        callsRecorded: !!a.callsRecorded,
        runtime: a.runtime,
        ...(a.model ? { model: a.model } : {}),
        stages: a.timings ?? [],
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
              line: status.runner.line,
              lineEn: status.runner.lineEn,
            }
          : !works.length && !attempts.length && !records.length && !controller
            ? NEVER_RUN
            : {}),
      },
      ...(controller ? { controller: { leaseUntil: controller.leaseUntil } } : {}),
      ...(status.budgets ? { budgets: status.budgets.budgets } : {}),
      activity,
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
    return {
      connector,
      provider,
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
      reviewRoundCap: reviewRoundCap(policy.policy),
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
  stateDir: string;
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
export function harnessView(options: HarnessViewOptions): OperatorView | WorkDetailView {
  const stateDir = resolve(options.stateDir);
  const policy = viewPolicy(stateDir, options.policyPath);
  const projection: OperatorViewOptions = {
    ...(options.windowMs !== undefined ? { windowMs: options.windowMs } : {}),
    ...(options.bucketMs !== undefined ? { bucketMs: options.bucketMs } : {}),
    ...(options.titles !== undefined ? { titles: options.titles } : {}),
    ...(options.lang ? { lang: options.lang } : {}),
  };
  const updates = options.workId === undefined ? updatesInput(stateDir, policy.baseDir) : undefined;
  const project = (input: OperatorViewInput) =>
    options.workId !== undefined
      ? workDetailView(input, options.workId, projection)
      : operatorView(updates ? { ...input, updates } : input, projection);
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
 * Обновления для представления: последняя проверка `harness update --check`
 * из `<state>-updates/last-check.json` и режим из `.harness/updates.json`.
 * Ни настройки, ни проверки — поля нет; настройка не по схеме — тоже нет
 * (представление не ломается, отказ видно в `harness update`).
 */
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
