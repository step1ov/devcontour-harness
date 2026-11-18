import { lstatSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ExecutionPolicy } from '../contracts/index.ts';
import { hostLoad, type HostResources } from '../environment/host-load.ts';
import { digestThreadsCap } from '../verification/file-digests.ts';

/**
 * Пороги слабой машины: не больше 4 производительных ядер или меньше 16 ГиБ
 * памяти (машина с ровно 16 ГиБ — не слабая). Известный предел: вне macOS
 * ядра — `os.cpus().length`, то есть логические (с hyperthreading), и
 * машина с 2 физическими ядрами и 4 потоками считается по 4.
 */
export const LOW_RESOURCE_CORES = 4;
export const LOW_RESOURCE_MEMORY_BYTES = 16 * 1024 ** 3;

/** Что задать в существующей `.harness/policy.json`, чтобы получить слой lean. */
const LEAN_POLICY = '"concurrency": 1, "runTimeoutMs": 1800000, "gateTimeoutFloorMs": 240000';

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
 * но работает медленнее, чем могла бы. Текст годится и для готового проекта:
 * `init --lean` при существующем manifest — `content-differs`, поэтому совет
 * называет поля политики, а `init --lean` — только для нового проекта.
 *
 * - `DEPENDENCY_STORE_RECOMMENDED` — у репозитория есть `pnpm-lock.yaml`, а
 *   `dependencyStore` нет: каждый checkout ставит пакеты заново. Для npm
 *   совета нет: хранилище поддерживает только pnpm.
 * - `LOW_RESOURCES` — слабая машина (пороги выше) при параллельности
 *   политики больше 1. Ограничение частоты macOS (`pmset -g therm`)
 *   упоминается, только когда оно меньше 100%.
 * - `DIGEST_THREADS_INVALID` — `HARNESS_DIGEST_THREADS` задана, но не целое
 *   1–8: значение не действует.
 */
export function resourceWarnings(
  policy: ExecutionPolicy,
  baseDir: string,
  resources: HostResources = hostLoad.resources(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const warnings: string[] = [];
  policy.repositories.forEach((repo, i) => {
    const root = isAbsolute(repo.path) ? repo.path : resolve(baseDir, repo.path);
    if (!repo.dependencyStore && isFile(join(root, 'pnpm-lock.yaml')))
      warnings.push(
        `DEPENDENCY_STORE_RECOMMENDED: репозиторий ${repo.id}: есть pnpm-lock.yaml, но нет dependencyStore — каждый checkout скачивает и распаковывает пакеты заново. В готовом проекте добавьте в политику (.harness/policy.json) repositories[${i}]: "dependencyStore": { "manager": "pnpm" }; новый проект — harness init --lean`,
      );
  });
  const low =
    resources.performanceCores <= LOW_RESOURCE_CORES ||
    resources.memoryBytes < LOW_RESOURCE_MEMORY_BYTES;
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
      `LOW_RESOURCES: на машине ${cores} и ${gib(resources.memoryBytes)} ГБ памяти, а параллельность политики ${policy.concurrency}: одновременные попытки делят процессор и память, и gates упираются в пределы времени. В готовом проекте задайте в политике (.harness/policy.json) ${LEAN_POLICY} (для pnpm — и dependencyStore); новый проект — harness init --lean${thermal}`,
    );
  }
  const threads = env.HARNESS_DIGEST_THREADS;
  if (threads !== undefined && digestThreadsCap(env) === undefined)
    warnings.push(
      `DIGEST_THREADS_INVALID: HARNESS_DIGEST_THREADS=${JSON.stringify(threads)} — ожидается целое 1–8; значение не действует, потоков сверки — по умолчанию`,
    );
  return warnings;
}
