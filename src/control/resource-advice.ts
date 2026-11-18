import { lstatSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ExecutionPolicy } from '../contracts/index.ts';
import { hostLoad, type HostResources } from '../environment/host-load.ts';

/** Пороги слабой машины: не больше стольких производительных ядер или памяти. */
export const LOW_RESOURCE_CORES = 4;
export const LOW_RESOURCE_MEMORY_BYTES = 16 * 1024 ** 3;

const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};
const gib = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/**
 * Советы `doctor` о ресурсах — предупреждения, а не проблемы: среда годна,
 * но работает медленнее, чем могла бы.
 *
 * - `DEPENDENCY_STORE_RECOMMENDED` — у репозитория есть `pnpm-lock.yaml`, а
 *   `dependencyStore` нет: каждый checkout ставит пакеты заново. Для npm
 *   совета нет: хранилище поддерживает только pnpm.
 * - `LOW_RESOURCES` — не больше 4 производительных ядер или 16 ГБ памяти при
 *   параллельности политики больше 1: одновременные попытки и их gates
 *   делят машину и упираются в пределы времени.
 */
export function resourceWarnings(
  policy: ExecutionPolicy,
  baseDir: string,
  resources: HostResources = hostLoad.resources(),
): string[] {
  const warnings: string[] = [];
  for (const repo of policy.repositories) {
    const root = isAbsolute(repo.path) ? repo.path : resolve(baseDir, repo.path);
    if (!repo.dependencyStore && isFile(join(root, 'pnpm-lock.yaml')))
      warnings.push(
        `DEPENDENCY_STORE_RECOMMENDED: репозиторий ${repo.id}: есть pnpm-lock.yaml, но нет dependencyStore — каждый checkout скачивает и распаковывает пакеты заново; добавьте "dependencyStore": { "manager": "pnpm" } (или harness init --lean)`,
      );
  }
  const low =
    resources.performanceCores <= LOW_RESOURCE_CORES ||
    resources.memoryBytes <= LOW_RESOURCE_MEMORY_BYTES;
  if (low && policy.concurrency > 1) {
    const cores =
      resources.coresSource === 'perflevel0'
        ? `${resources.performanceCores} производительных ядер`
        : `${resources.performanceCores} ядер`;
    const thermal =
      resources.cpuSpeedLimit !== undefined && resources.cpuSpeedLimit < 100
        ? `; сейчас macOS ограничивает частоту процессора до ${resources.cpuSpeedLimit}% (pmset -g therm)`
        : '';
    warnings.push(
      `LOW_RESOURCES: на машине ${cores} и ${gib(resources.memoryBytes)} ГБ памяти, а параллельность политики ${policy.concurrency}: одновременные попытки делят процессор и память, а машина без вентилятора ещё и снижает частоту при нагреве — gates упираются в пределы времени. Для слабой машины — harness init --lean или слой lean в профиле (concurrency 1, gateTimeoutFloorMs 240000)${thermal}`,
    );
  }
  return warnings;
}
