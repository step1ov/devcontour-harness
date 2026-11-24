import { resolve } from 'node:path';
import { cliAdapter } from '../agents/cli-adapter.ts';
import type { ExecutionPolicy, ReviewSubjectSummary, RuntimeName } from '../contracts/index.ts';
import type { RuntimeAdapter } from '../contracts/ports.ts';
import { doctor } from '../control/doctor.ts';
import { Harness } from '../control/harness.ts';
import { reviewSummaryRows, reviewsText } from '../control/review-summary.ts';
import { attemptSummaries, attemptsByWork, type attemptSummaryView } from '../control/status.ts';
import { verificationOf, type WorkVerification } from '../report/verification.ts';
import { currentRevisionAttempts } from '../report/compute.ts';
import { explainStop, type StopDiagnosis, type StopInput } from '../projections/stop.ts';
import {
  failureSignature,
  repeatedGateFailure,
  type RepeatedFailureAttempt,
} from '../projections/repeated-failure.ts';
import { changedPaths } from '../verification/applicability.ts';
import { repositoryPath } from '../control/gates-check.ts';
import type { ExecutionView } from '../contracts/ports.ts';
import { stopInputsOf } from './state.ts';

export interface DiagnoseOptions {
  stateDir: string;
  policy: ExecutionPolicy;
  baseDir: string;
  workId?: string;
  adapters?: Partial<Record<RuntimeName, RuntimeAdapter>>;
}

/**
 * `harness explain`: диагнозы runtime, controller и поручений; только чтение.
 *
 * Состояние открывается только для чтения (процесс не становится писателем);
 * отсутствующее состояние — `NOT_FOUND`, каталог не создаётся. Доступность
 * runtime — та же проба `--version`, что у `doctor`, без вызова модели.
 * Порядок: runtime (codex, claude), controller, поручения (h1-spec K3).
 */
export async function diagnoseState(options: DiagnoseOptions): Promise<ExplainData> {
  const { policy } = options;
  const h = Harness.open({
    stateDir: resolve(options.stateDir),
    policy,
    baseDir: options.baseDir,
    readOnly: true,
    readOnlyState: true,
    ...(options.adapters ? { adapters: options.adapters } : {}),
  });
  let stateInputs: StopInput[];
  let attempts: AttemptSummaryRow[];
  let attemptsTruncated: number;
  let verification: VerificationRow[];
  let reviews: ReviewSubjectSummary[];
  let reviewsTruncated: number;
  let queue: ExplainData['queue'];
  let repeated: ReturnType<typeof repeatedFailureInputs> = [];
  try {
    stateInputs = stopInputsOf(h, {
      maxAttempts: policy.maxAttempts,
      repairBudget: policy.repairBudget,
      ...(options.workId !== undefined ? { workId: options.workId } : {}),
    });
    repeated = h.engine.read((v) => repeatedFailureInputs(v, stateInputs));
    // Сводка попыток каждого поручения выбора — та же, что `status`; строк
    // не больше `EXPLAIN_ATTEMPT_ROWS`, остальные — числом.
    ({ attempts, attemptsTruncated, verification } = h.engine.read((v) => {
      const summaryOf = attemptSummaries(h, v);
      const attemptsOf = attemptsByWork(v);
      const works = v
        .works()
        .filter((w) => options.workId === undefined || w.id === options.workId);
      const shown = works.slice(0, EXPLAIN_ATTEMPT_ROWS);
      return {
        attempts: shown.map((w) => ({ workId: w.id, ...summaryOf(w) })),
        attemptsTruncated: Math.max(0, works.length - EXPLAIN_ATTEMPT_ROWS),
        // Что проверено и как — та же проверка, что у `status`.
        verification: shown.flatMap((w) => {
          const x = verificationOf(w, currentRevisionAttempts(w, attemptsOf(w.id)));
          return x ? [{ workId: w.id, ...x }] : [];
        }),
      };
    }));
    // Ревью плана и контрактов — та же сводка, что у `status`.
    ({ reviews, reviewsTruncated } = h.engine.read((v) => reviewSummaryRows(v, policy)));
    // Никто не запущен, готовые работы есть (P5-4): новый запуск — ход
    // ведущего, вопрос держит только свои работы. Та же строка, что `status`.
    if (options.workId === undefined) {
      const runner = h.status().runner;
      if (runner?.state === 'not-running' && runner.ready)
        queue = {
          actor: 'lead',
          action: 'start-run',
          ready: runner.ready,
          ...(runner.heldByQuestion ? { heldByQuestion: runner.heldByQuestion } : {}),
          line: runner.line,
          lineEn: runner.lineEn,
        };
    }
  } finally {
    h.close();
  }
  const adapters = options.adapters ?? {
    codex: cliAdapter('codex', { toolProfiles: policy.toolProfiles }),
    claude: cliAdapter('claude', { toolProfiles: policy.toolProfiles }),
  };
  // Без пробы портов: explain не привязывает порты и не зовёт lsof.
  const report = await doctor(policy, adapters, undefined, undefined, undefined, {
    resourceDatabase: false,
  });
  const runtimes: StopInput[] = report.runtimes
    // Не назначенный политикой runtime не нужен: его отсутствие не останавливает работу.
    .filter((r) => !r.available && !('reason' in r))
    .map((r) => ({ kind: 'runtime', runtime: { runtime: r.runtime, available: false } }));
  stateInputs = await withRepeatedFailures(stateInputs, repeated, options);
  return {
    diagnoses: [...runtimes, ...stateInputs].map(explainStop),
    ...(queue ? { queue } : {}),
    attempts,
    ...(attemptsTruncated ? { attemptsTruncated } : {}),
    ...(verification.length ? { verification } : {}),
    ...(reviews.length ? { reviews } : {}),
    ...(reviewsTruncated ? { reviewsTruncated } : {}),
  };
}

/** Строка проверки поручения в ответе `explain`. */
export type VerificationRow = { workId: string } & WorkVerification;

/** Строка сводки попыток поручения в ответе `explain`. */
export type AttemptSummaryRow = { workId: string } & ReturnType<typeof attemptSummaryView>;

/** Ответ `explain`: диагнозы и сводка попыток по поручениям. */
export interface ExplainData {
  diagnoses: StopDiagnosis[];
  /** alpha.67: новый запуск — ход ведущего (`explainDataSchema.queue`). */
  queue?: {
    actor: 'lead';
    action: 'start-run';
    ready: number;
    heldByQuestion?: string[];
    line: string;
    lineEn: string;
  };
  attempts?: AttemptSummaryRow[];
  attemptsTruncated?: number;
  verification?: VerificationRow[];
  reviews?: ReviewSubjectSummary[];
  reviewsTruncated?: number;
}

/** Предел строк сводки попыток в ответе `explain`; остальные — `attemptsTruncated`. */
export const EXPLAIN_ATTEMPT_ROWS = 100;

const link = (e: StopDiagnosis['evidence'][number]) =>
  `${e.kind}:${e.id}${e.sha ? '@' + e.sha : ''}`;

/** Текст `--human`: по строке на диагноз, сообщение и evidence — с отступом. */
export function explainText(data: ExplainData): string {
  const stops = data.diagnoses.length
    ? data.diagnoses
        .map((d) =>
          [
            `${d.workId ?? '—'} ${d.code} [${d.cause}/${d.phase}] → ${d.actor ?? '—'}: ${d.action}`,
            `  ${d.message}`,
            ...(d.evidence.length ? [`  evidence: ${d.evidence.map(link).join(', ')}`] : []),
          ].join('\n'),
        )
        .join('\n')
        .concat('\n')
    : 'Остановок нет.\n';
  return (
    (data.queue ? `→ lead: ${data.queue.line}\n` : '') +
    stops +
    verificationText(data.verification ?? []) +
    attemptsText(data.attempts ?? []) +
    (data.attemptsTruncated ? `  … и ещё поручений: ${data.attemptsTruncated}\n` : '') +
    reviewsText(data.reviews, data.reviewsTruncated)
  );
}

/** Раздел «Проверки и ревью — кто и как» текста `--human`: сводная строка на поручение. */
export function verificationText(rows: readonly { workId: string; line: string }[]): string {
  if (!rows.length) return '';
  return ['Проверки и ревью — кто и как:', ...rows.map((r) => `  ${r.workId}: ${r.line}`)]
    .join('\n')
    .concat('\n');
}

/** Раздел «Попытки» текста `--human`: строка сводки на поручение. */
export function attemptsText(rows: readonly { workId: string; line: string }[]): string {
  if (!rows.length) return '';
  return ['Попытки:', ...rows.map((r) => `  ${r.workId}: ${r.line}`)].join('\n').concat('\n');
}

/** Попытки работы с повторным провалом gate и прогоны на их базах — из одного чтения. */
function repeatedFailureInputs(v: ExecutionView, inputs: readonly StopInput[]) {
  const out: {
    workId: string;
    repositoryId: string;
    attempts: RepeatedFailureAttempt[];
    base: Map<string, RepeatedFailureAttempt['evidence']>;
  }[] = [];
  for (const input of inputs) {
    if (input.kind !== 'work' || input.work.status === 'done' || input.work.status === 'cancelled')
      continue;
    const attempts = v.attempts(input.work.id);
    // Дешёвый отбор до git: две и больше засчитанных провала gate с подписью.
    const signed = attempts.filter(
      (a) =>
        a.status === 'failed' &&
        a.failureKind === 'gate' &&
        failureSignature(
          a.evidence.findLast((e) => e.kind === 'test' && !e.passed && !e.consumer)?.failureSummary,
        ),
    );
    if (signed.length < 2) continue;
    const bases = new Set(signed.flatMap((a) => (a.baseSha ? [a.baseSha] : [])));
    const base = new Map<string, RepeatedFailureAttempt['evidence']>();
    for (const w of v.works())
      for (const a of v.attempts(w.id))
        for (const e of a.evidence)
          if (bases.has(e.sha) && e.gate)
            base.set(`${e.sha}\u0000${e.gate}`, [
              ...(base.get(`${e.sha}\u0000${e.gate}`) ?? []),
              e,
            ]);
    out.push({ workId: input.work.id, repositoryId: signed[0]!.repositoryId, attempts, base });
  }
  return out;
}

/**
 * Подсказка о повторном провале gate (`repeatedGateFailure`): файлы изменения
 * каждой попытки — `git diff база..кандидат` в checkout репозитория (деревья
 * попыток делят его объекты). Git не ответил — подсказки нет.
 */
async function withRepeatedFailures(
  inputs: StopInput[],
  repeated: ReturnType<typeof repeatedFailureInputs>,
  options: DiagnoseOptions,
): Promise<StopInput[]> {
  if (!repeated.length) return inputs;
  const lines = new Map<string, string>();
  for (const r of repeated) {
    const repo = options.policy.repositories.find((x) => x.id === r.repositoryId);
    if (!repo) continue;
    const cwd = repositoryPath(options.baseDir)(repo);
    const files = new Map<string, readonly string[]>();
    for (const a of r.attempts) {
      if (a.status !== 'failed' || a.failureKind !== 'gate' || !a.baseSha || !a.candidateSha)
        continue;
      const changed = await changedPaths(cwd, [{ from: a.baseSha, to: a.candidateSha }]).catch(
        () => undefined,
      );
      if (changed?.complete) files.set(a.id, changed.files);
    }
    const found = repeatedGateFailure(r.attempts, {
      changedFiles: (id) => files.get(id),
      evidenceAt: (sha, gate) => r.base.get(`${sha}\u0000${gate}`) ?? [],
      gatesArgs:
        `--state ${resolve(options.stateDir)}` +
        (options.policy.repositories.length > 1 ? ` --repository ${repo.id}` : ''),
    });
    if (found) lines.set(r.workId, found.line.ru);
  }
  return inputs.map((i) =>
    i.kind === 'work' && lines.has(i.work.id)
      ? { ...i, work: { ...i.work, repeatedFailure: { line: lines.get(i.work.id)! } } }
      : i,
  );
}
