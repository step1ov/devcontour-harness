import { resolve } from 'node:path';
import { cliAdapter } from '../agents/cli-adapter.ts';
import type { ExecutionPolicy, RuntimeName } from '../contracts/index.ts';
import type { RuntimeAdapter } from '../contracts/ports.ts';
import { doctor } from '../control/doctor.ts';
import { Harness } from '../control/harness.ts';
import { attemptSummaryView, liveGraphJobs } from '../control/status.ts';
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
  try {
    stateInputs = stopInputsOf(h, {
      maxAttempts: policy.maxAttempts,
      repairBudget: policy.repairBudget,
      ...(options.workId !== undefined ? { workId: options.workId } : {}),
    });
    // Сводка попыток каждого поручения выбора — та же, что `status`.
    attempts = h.engine.read((v) => {
      const jobs = liveGraphJobs(h.workflows);
      return v
        .works()
        .filter((w) => options.workId === undefined || w.id === options.workId)
        .map((w) => ({
          workId: w.id,
          ...attemptSummaryView(w, v.attempts(w.id), policy, jobs.get(w.graphId)),
        }));
    });
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
  return { diagnoses: [...runtimes, ...stateInputs].map(explainStop), attempts };
}

/** Строка сводки попыток поручения в ответе `explain`. */
export type AttemptSummaryRow = { workId: string } & ReturnType<typeof attemptSummaryView>;

/** Ответ `explain`: диагнозы и сводка попыток по поручениям. */
export interface ExplainData {
  diagnoses: StopDiagnosis[];
  attempts?: AttemptSummaryRow[];
}

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
  return stops + attemptsText(data.attempts ?? []);
}

/** Раздел «Попытки» текста `--human`: строка сводки на поручение. */
export function attemptsText(rows: readonly { workId: string; line: string }[]): string {
  if (!rows.length) return '';
  return ['Попытки:', ...rows.map((r) => `  ${r.workId}: ${r.line}`)].join('\n').concat('\n');
}
