import { resolve } from 'node:path';
import { cliAdapter } from '../agents/cli-adapter.ts';
import type { ExecutionPolicy, ReviewSubjectSummary, RuntimeName } from '../contracts/index.ts';
import type { RuntimeAdapter } from '../contracts/ports.ts';
import { doctor } from '../control/doctor.ts';
import { Harness } from '../control/harness.ts';
import { reviewSummaryRows, reviewsText } from '../control/review-summary.ts';
import { attemptSummaries, attemptsByWork, type attemptSummaryView } from '../control/status.ts';
import { verificationOf, type WorkVerification } from '../report/verification.ts';
import { explainStop, type StopDiagnosis, type StopInput } from '../projections/stop.ts';
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
  try {
    stateInputs = stopInputsOf(h, {
      maxAttempts: policy.maxAttempts,
      repairBudget: policy.repairBudget,
      ...(options.workId !== undefined ? { workId: options.workId } : {}),
    });
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
          const x = verificationOf(w, attemptsOf(w.id));
          return x ? [{ workId: w.id, ...x }] : [];
        }),
      };
    }));
    // Ревью плана и контрактов — та же сводка, что у `status`.
    ({ reviews, reviewsTruncated } = h.engine.read((v) => reviewSummaryRows(v, policy)));
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
  return {
    diagnoses: [...runtimes, ...stateInputs].map(explainStop),
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
