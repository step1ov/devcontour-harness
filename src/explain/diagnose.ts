import { resolve } from 'node:path';
import { cliAdapter } from '../agents/cli-adapter.ts';
import type { ExecutionPolicy, RuntimeName } from '../contracts/index.ts';
import type { RuntimeAdapter } from '../contracts/ports.ts';
import { doctor } from '../control/doctor.ts';
import { Harness } from '../control/harness.ts';
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
export async function diagnoseState(
  options: DiagnoseOptions,
): Promise<{ diagnoses: StopDiagnosis[] }> {
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
  try {
    stateInputs = stopInputsOf(h, {
      maxAttempts: policy.maxAttempts,
      repairBudget: policy.repairBudget,
      ...(options.workId !== undefined ? { workId: options.workId } : {}),
    });
  } finally {
    h.close();
  }
  const adapters = options.adapters ?? {
    codex: cliAdapter('codex', { toolProfiles: policy.toolProfiles }),
    claude: cliAdapter('claude', { toolProfiles: policy.toolProfiles }),
  };
  const report = await doctor(policy, adapters);
  const runtimes: StopInput[] = report.runtimes
    // Не назначенный политикой runtime не нужен: его отсутствие не останавливает работу.
    .filter((r) => !r.available && !('reason' in r))
    .map((r) => ({ kind: 'runtime', runtime: { runtime: r.runtime, available: false } }));
  return { diagnoses: [...runtimes, ...stateInputs].map(explainStop) };
}

const link = (e: StopDiagnosis['evidence'][number]) =>
  `${e.kind}:${e.id}${e.sha ? '@' + e.sha : ''}`;

/** Текст `--human`: по строке на диагноз, сообщение и evidence — с отступом. */
export function explainText(data: { diagnoses: StopDiagnosis[] }): string {
  if (!data.diagnoses.length) return 'Остановок нет.\n';
  return data.diagnoses
    .map((d) =>
      [
        `${d.workId ?? '—'} ${d.code} [${d.cause}/${d.phase}] → ${d.actor ?? '—'}: ${d.action}`,
        `  ${d.message}`,
        ...(d.evidence.length ? [`  evidence: ${d.evidence.map(link).join(', ')}`] : []),
      ].join('\n'),
    )
    .join('\n')
    .concat('\n');
}
