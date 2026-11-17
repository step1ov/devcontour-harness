import { availableParallelism, loadavg } from 'node:os';

/** Снимок нагрузки хоста; объект — чтобы тест мог подменить чтение. */
export const hostLoad = {
  read: (): HostLoad => ({ load1: loadavg()[0] ?? 0, cpus: Math.max(1, availableParallelism()) }),
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
