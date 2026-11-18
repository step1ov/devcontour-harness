import { execFileSync } from 'node:child_process';
import { availableParallelism, cpus, loadavg, totalmem } from 'node:os';

/** Снимок нагрузки хоста; объект — чтобы тест мог подменить чтение. */
export const hostLoad = {
  read: (): HostLoad => ({ load1: loadavg()[0] ?? 0, cpus: Math.max(1, availableParallelism()) }),
  /** Ресурсы машины для совета `doctor` (`LOW_RESOURCES`); не для пределов исполнения. */
  resources: (): HostResources => readHostResources(),
};
export interface HostLoad {
  /** Средняя нагрузка за минуту (`os.loadavg()[0]`; на Windows — 0). */
  load1: number;
  /** Доступные процессу ядра. */
  cpus: number;
}
/** Нагрузка хоста словами — свидетельство в тексте отказа. */
export const loadText = (load: HostLoad) =>
  `нагрузка хоста ${Math.round(load.load1 * 10) / 10} на ${load.cpus} ядер`;

/** Ресурсы машины: память, производительные ядра и, на macOS, тепловое ограничение. */
export interface HostResources {
  /** Вся память машины (`os.totalmem()`), байты. */
  memoryBytes: number;
  /**
   * Производительные ядра: на macOS — `sysctl -n hw.perflevel0.physicalcpu`
   * (ядра P у Apple Silicon), иначе — `os.cpus().length`.
   */
  performanceCores: number;
  coresSource: 'perflevel0' | 'cpus';
  /** macOS: `CPU_Speed_Limit` из `pmset -g therm` (100 — без ограничения); только для сведения. */
  cpuSpeedLimit?: number;
}

const run = (file: string, args: string[]) => {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
};

function readHostResources(): HostResources {
  const memoryBytes = totalmem();
  const fallback = Math.max(1, cpus().length);
  if (process.platform !== 'darwin')
    return { memoryBytes, performanceCores: fallback, coresSource: 'cpus' };
  const perf = Number(run('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu'])?.trim());
  const limit = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(run('/usr/bin/pmset', ['-g', 'therm']) ?? '');
  return {
    memoryBytes,
    ...(Number.isInteger(perf) && perf > 0
      ? { performanceCores: perf, coresSource: 'perflevel0' as const }
      : { performanceCores: fallback, coresSource: 'cpus' as const }),
    ...(limit ? { cpuSpeedLimit: Number(limit[1]) } : {}),
  };
}
