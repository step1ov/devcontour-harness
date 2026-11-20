import { ruCount } from '../contracts/plural.ts';
import { lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ExecutionPolicy } from '../contracts/index.ts';
import { hostLoad, type HostResources } from '../environment/host-load.ts';
import { digestThreadsCap } from '../verification/file-digests.ts';
import { dependencyStoreSupports } from '../toolchains/probe.ts';
import { pinnedPnpm, storeAdvice } from './store-advice.ts';

/**
 * Пороги слабой машины: не больше 4 производительных ядер или меньше 16 ГиБ
 * памяти (машина с ровно 16 ГиБ — не слабая). Известный предел: вне macOS
 * ядра — `os.cpus().length`, то есть логические (с hyperthreading), и
 * машина с 2 физическими ядрами и 4 потоками считается по 4.
 */
export const LOW_RESOURCE_CORES = 4;
export const LOW_RESOURCE_MEMORY_BYTES = 16 * 1024 ** 3;

/** Поля политики, которые задаёт слой lean. */
const LEAN_POLICY = '"concurrency": 1, "runTimeoutMs": 1800000, "gateTimeoutFloorMs": 240000';

/** Корень проекта harness политики: каталог над `.harness/`; иначе политика вне проекта. */
const projectRootOf = (baseDir: string) => {
  const dir = resolve(baseDir);
  return basename(dir) === '.harness' ? dirname(dir) : undefined;
};

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
 * но работает медленнее, чем могла бы. Для подготовленного проекта совет
 * называет `harness lean --repository <корень> --plan` (корень — над
 * `.harness/` политики), для нового — `init --lean`; для политики вне
 * проекта — поля, которые задать в ней самой.
 *
 * - `DEPENDENCY_STORE_RECOMMENDED` — у репозитория есть `pnpm-lock.yaml`, а
 *   `dependencyStore` нет: каждый checkout ставит пакеты заново. Для npm
 *   совета нет: хранилище поддерживает только pnpm.
 * - `LOW_RESOURCES` — слабая машина (пороги выше) при параллельности
 *   политики больше 1. Ограничение частоты macOS (`pmset -g therm`)
 *   упоминается, только когда оно меньше 100%.
 * - `DEPENDENCY_STORE_UNSUPPORTED`, `DEPENDENCY_CACHE_PATH` — см. `storeAdvice`:
 *   хранилище не применяется для закреплённой версии pnpm или проверки
 *   собирают свой store/кэш.
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
  const project = projectRootOf(baseDir);
  policy.repositories.forEach((repo, i) => {
    const at = isAbsolute(repo.path) ? repo.path : resolve(baseDir, repo.path);
    const pinned = pinnedPnpm(at);
    // Версия вне проверенных: совет включить хранилище был бы пустым —
    // о ней говорит DEPENDENCY_STORE_UNSUPPORTED.
    if (
      !repo.dependencyStore &&
      isFile(join(at, 'pnpm-lock.yaml')) &&
      !(pinned && !dependencyStoreSupports('pnpm', pinned))
    )
      warnings.push(
        `DEPENDENCY_STORE_RECOMMENDED: репозиторий ${repo.id}: есть pnpm-lock.yaml, но нет dependencyStore — каждый checkout скачивает и распаковывает пакеты заново. ` +
          (project
            ? `В подготовленном проекте — harness lean --repository ${project} --plan, затем без --plan (вместе со слоем lean; lean --off снимает), или только хранилище: в политике repositories[${i}]: "dependencyStore": { "manager": "pnpm" }; новый проект — harness init --lean`
            : `Добавьте в политику repositories[${i}]: "dependencyStore": { "manager": "pnpm" }; проект harness — harness lean --repository <корень проекта> --plan, новый — harness init --lean`),
      );
  });
  const low =
    resources.performanceCores <= LOW_RESOURCE_CORES ||
    resources.memoryBytes < LOW_RESOURCE_MEMORY_BYTES;
  if (low && policy.concurrency > 1) {
    const cores =
      resources.coresSource === 'perflevel0'
        ? ruCount(resources.performanceCores, [
            'производительное ядро',
            'производительных ядра',
            'производительных ядер',
          ])
        : ruCount(resources.performanceCores, ['ядро', 'ядра', 'ядер']);
    const thermal =
      resources.cpuSpeedLimit !== undefined && resources.cpuSpeedLimit < 100
        ? `; сейчас macOS ограничивает частоту процессора до ${resources.cpuSpeedLimit}% (pmset -g therm)`
        : '';
    warnings.push(
      `LOW_RESOURCES: на машине ${cores} и ${gib(resources.memoryBytes)} ГБ памяти, а параллельность политики ${policy.concurrency}: одновременные попытки делят процессор и память, и gates упираются в пределы времени. ` +
        (project
          ? `В подготовленном проекте — harness lean --repository ${project} --plan (изменения полей), затем без --plan: слой lean (${LEAN_POLICY}, для pnpm — dependencyStore; policyDigest меняется, согласованные графы — заново review-plan; lean --off снимает); новый проект — harness init --lean`
          : `Задайте в политике ${LEAN_POLICY} (для pnpm — и dependencyStore); проект harness — harness lean --repository <корень проекта> --plan, новый — harness init --lean`) +
        thermal,
    );
  }
  for (const a of storeAdvice(policy, baseDir)) warnings.push(`${a.code}: ${a.message}`);
  const threads = env.HARNESS_DIGEST_THREADS;
  if (threads !== undefined && digestThreadsCap(env) === undefined)
    warnings.push(
      `DIGEST_THREADS_INVALID: HARNESS_DIGEST_THREADS=${JSON.stringify(threads)} — ожидается целое 1–8; значение не действует, потоков сверки — по умолчанию`,
    );
  return warnings;
}
