// Загрузчик представления оператора для node (`harness view`): политика,
// снимок состояния (`status --detail` и записи хранилища одним `read`),
// сверка принятого с target ref (git), манифест проекта рядом с политикой.
// Числа берутся из тех же функций, что у `status` и `report`; проекция
// (`operatorView`, `workDetailView`) только раскладывает и маскирует.
// Только чтение: каталог состояния не создаётся и не пишется.

import { existsSync, readFileSync } from 'node:fs';
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
  findingCounts,
  leadMayAnswer,
  policyDigest,
  projectManifestSchema,
  reviewVerdictText,
  type ExecutionPolicy,
  type ExecutionView,
  type InputRequest,
  type ReviewRecord,
  type statusDataSchema,
} from '../contracts/index.ts';
import { HARNESS_VERSION } from '../package.ts';
import { callCostKnown, failureBucketOf, interruptedByShutdown } from '../report/compute.ts';
import { callRecords } from '../engine/usage.ts';
import { requestsOf } from '../engine/input-requests.ts';
import { inputStateOf } from '../projections/input.ts';
import { explainStop } from '../projections/stop.ts';
import { stopInputsIn } from '../explain/state.ts';
import { policySecrets } from '../environment/redaction.ts';
import {
  operatorView,
  workDetailView,
  type OperatorReviewInput,
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
import { statusOf } from './status.ts';
import { acceptedTargets } from './target.ts';
import { WorkflowQueue } from './workflow.ts';
import { reviewRoundCap } from './review.ts';
import { reviewSummaries } from './review-summary.ts';

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
                'политика --policy отличается от привязанной к состоянию: представление построено по --policy',
              messageEn:
                'the --policy file differs from the policy bound to the state: the view uses --policy',
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

/** Английская строка сводки попыток — те же числа, что `attemptSummaryLine`. */
function attemptLineEn(s: StatusWork['attemptSummary'], final: boolean): string | undefined {
  if (!s) return undefined;
  const left = (used: number, max: number) => Math.max(0, max - used);
  // Как `attemptSummaryView`: у итоговой работы предел незасчитанных не держит.
  const neutralOut = !final && s.neutral.used >= s.neutral.max;
  return [
    `attempts ${s.total}${s.active ? ` (${s.active} running)` : ''}`,
    `failures ${s.failed}${s.failures.length ? ` (${s.failures.map((f) => `${f.key} ${f.count}`).join(', ')})` : ''}`,
    `time limit ${s.timeouts}`,
    `interrupted by shutdown ${s.interrupted}`,
    `accepted ${s.accepted}`,
    (neutralOut
      ? `the limit of uncounted failures is used up (${s.neutral.used} of ${s.neutral.max}): retry only after a reset`
      : `attempts left ${left(s.attempts.used, s.attempts.max)} of ${s.attempts.max}`) +
      (s.repairs ? `, group repairs left ${s.repairs.left} of ${s.repairs.budget}` : ''),
  ].join('; ');
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

function reviewsOf(v: ExecutionView, policy: ExecutionPolicy): OperatorReviewInput[] {
  const records = lastBySubject(
    v.locals('reviews', WORKSPACE_OWNER).map((r) => r.value),
    (r) => `${r.kind}\0${r.subject}`,
  );
  const plans: OperatorReviewInput[] = reviewSummaries(v, policy).map((s) => {
    const r = records.get(`${s.kind}\0${s.subject}`)!;
    const counts = findingCounts(r.findings);
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
      spend: s.spend,
      findings: findingsOf(r.findings),
      ...(s.escalation
        ? { escalation: { round: r.round, findings: s.escalation.findings.map((f) => f.id) } }
        : {}),
      line: s.line,
      lineEn: `${s.kind} ${s.subject}: ${reviewVerdictText(s.approved, counts, 'en')}; rounds ${s.rounds.used}${s.rounds.max === null ? '' : '/' + s.rounds.max}`,
    };
  });
  const spend = new Map<string, { calls: number; knownUsd: number; unknownCalls: number }>();
  for (const c of callRecords(v)) {
    if (c.stage !== 'code-review' || !c.subjectId) continue;
    const s = spend.get(c.subjectId) ?? { calls: 0, knownUsd: 0, unknownCalls: 0 };
    s.calls += 1;
    if (callCostKnown(c)) s.knownUsd += c.costUsd ?? 0;
    else s.unknownCalls += 1;
    spend.set(c.subjectId, s);
  }
  const code = [
    ...lastBySubject(
      v.locals('code-reviews', WORKSPACE_OWNER).map((r) => r.value),
      (r) => r.subject,
    ).values(),
  ].map((r): OperatorReviewInput => {
    const counts = findingCounts(r.findings);
    const scope = `${r.repositoryId}/${r.role} ${r.refs.base}..${r.refs.head}`;
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
      spend: spend.get(r.subject) ?? { calls: 0, knownUsd: 0, unknownCalls: 0 },
      findings: findingsOf(r.findings),
      line: `код ${scope}: ${reviewVerdictText(r.approved, counts, 'ru')}; раундов ${r.round}`,
      lineEn: `code ${scope}: ${reviewVerdictText(r.approved, counts, 'en')}; rounds ${r.round}`,
    };
  });
  return [...plans, ...code].sort(
    (a, b) => b.at.localeCompare(a.at) || a.subject.localeCompare(b.subject),
  );
}

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
  const status = statusWithTargets(h);
  const jobs = h.workflows.list().filter((j) => j.kind === 'graph');
  return h.engine.read((v) => {
    const attempts = v.attempts();
    const attemptsOf = new Map<string, typeof attempts>();
    for (const a of attempts) attemptsOf.set(a.workId, [...(attemptsOf.get(a.workId) ?? []), a]);
    const runWork = new Map(attempts.map((a) => [a.id, a.workId]));
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
      stops.push({
        workId: input.work.id,
        code: d.code,
        actor: d.actor,
        action: d.action,
        ...(sw?.stage?.since ? { since: sw.stage.since } : {}),
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
        (r) =>
          !r.workIds &&
          (r.workId === sw.id ||
            (!r.workId && r.runId !== undefined && runWork.get(r.runId) === sw.id)),
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
          ...((en) => (en ? { lineEn: en } : {}))(
            attemptLineEn(summary, sw.status === 'done' || sw.status === 'cancelled'),
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
    const questions = requestsOf(v)
      .filter((r) => r.kind === 'question' && !closed.has(r.workId))
      .flatMap((r) => {
        const state = inputStateOf(r);
        if (!state) return [];
        const impact = (r.question as { impact?: string | null }).impact ?? undefined;
        const plain = plainOf(r);
        const by = r.answers.at(-1)?.actor.kind;
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
            leadMay: leadMayAnswer(r, inputPolicy),
          },
        ];
      });
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
      reviews: reviewsOf(v, policy),
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
      },
      ...(controller ? { controller: { leaseUntil: controller.leaseUntil } } : {}),
      ...(status.budgets ? { budgets: status.budgets.budgets } : {}),
      warnings: view.warnings,
      mask: maskContextOf(policy, view.baseDir, h.stateDir),
    };
  });
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
    queue: { paused: false },
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
  const project = (input: OperatorViewInput) =>
    options.workId !== undefined
      ? workDetailView(input, options.workId, projection)
      : operatorView(input, projection);
  if (!existsSync(join(stateDir, 'state.sqlite')))
    return project(emptyInput(policy, options.now ?? Date.now(), stateDir));
  // Однократное чтение без файлов в каталоге состояния (как `report`):
  // неизменяемое открытие с проверкой после чтения, иначе обычное.
  return SqliteExecutionStore.readOnce(
    join(stateDir, 'state.sqlite'),
    'devcontour-harness@' + HARNESS_VERSION,
    (store) => {
      const engine = new Engine({
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
          ...(options.now !== undefined ? { now: options.now } : {}),
          ...(options.lang ? { lang: options.lang } : {}),
        }),
      );
    },
  );
}
