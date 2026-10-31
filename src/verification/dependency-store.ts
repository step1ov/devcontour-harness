import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  digestOf,
  sha256,
  type DependencyStorePolicy,
  type ExecutionPolicy,
} from '../contracts/index.ts';
import { checkoutPath, type CheckoutRoot } from '../environment/checkout-root.ts';
import { snapshotLimit } from '../environment/isolation.ts';
import type { executionEnvironment } from '../environment/lifecycle.ts';
import { osTool } from '../environment/os-tools.ts';
import { command, gitOutput, processStart } from '../environment/process.ts';
import { ResourcePool, resourceKey } from '../environment/resources.ts';
import {
  declaredManagerVersion,
  defaultProbe,
  dependencyStoreSupports,
  dependencyStoreVersions,
  PROBE_TIMEOUT_MS,
  versionOf,
} from '../toolchains/probe.ts';
import { runCheck, type Boundary } from './gates.ts';

/**
 * Хранилище зависимостей: один seed на lockfile целевой ветки и его копия в
 * каждом checkout. Проект ничего не пишет сам: установка остаётся обычным
 * `pnpm install --frozen-lockfile` в его gate, только хранилище уже заполнено.
 *
 * Граница доверия:
 *
 * - Seed собирается только из lockfile целевой ветки — принятой истории.
 *   Сам harness не даёт кандидату запустить сборку или выбрать её содержимое:
 *   его lockfile только сравнивается с seed (частичное попадание).
 * - Сборка идёт в песочнице проверок с её `isolation.domains`, в каталоге из
 *   одного lockfile: `.npmrc`, `.pnpmfile.cjs` и `pnpm-workspace.yaml` проекта
 *   туда не попадают, и его хуки не исполняются.
 * - Seed лежит под корнем рабочих деревьев или в каталоге состояния: оба
 *   закрыты песочницей на чтение и запись. Копия в checkout принадлежит этому
 *   checkout: обратно в seed ничего не возвращается, а integration и следующая
 *   попытка получают новую копию.
 * - Проверяются байты копии, а не источника: те, что прочитает менеджер, и без
 *   окна между сверкой и копированием. Манифест закреплён в базе ресурсов, вне
 *   дерева seed. Несовпадение — отказ от seed с причиной в квитанции.
 * - Байты, докачанные менеджером при частичном попадании, защищены не seed, а
 *   lockfile: в дереве кандидата они доверены не больше, чем `node_modules`.
 *
 * Условие границы: шаги `prepare` и `lifecycle` идут на хосте вне песочницы, а на
 * integration — над слитым деревом. Если они исполняют код кандидата (скрипт из
 * репозитория), он работает с правами controller и может изменить seed и базу
 * закреплений: граница seed держится только там, где эти шаги кода кандидата не
 * исполняют. `doctor` предупреждает о хранилище рядом с непустым `prepare`.
 *
 * Отсутствие seed, отказ сборки и частичное попадание сводятся к обычной
 * установке: хранилище — ускорение, и проверка из-за него не падает.
 */
type Repo = ExecutionPolicy['repositories'][number];
type Execution = ReturnType<typeof executionEnvironment>;

interface Manager {
  /** Каталог хранилища в корне checkout. */
  dir: string;
  version: string[];
  /** Заполнить хранилище `store` по lockfile в рабочем каталоге команды. */
  fetch(store: string): string[];
  /** Окружение процессов checkout: менеджер берёт хранилище именно отсюда. */
  env(store: string): NodeJS.ProcessEnv;
  /** Отказ сборки, который повторится на том же lockfile при любой сети. */
  permanent: RegExp;
  /** Окружение сборки: конфигурация и кэш хоста в seed не попадают. */
  buildEnv(work: string): NodeJS.ProcessEnv;
  buildFiles: Record<string, string>;
}

const managers: Record<DependencyStorePolicy['manager'], Manager> = {
  pnpm: {
    dir: '.pnpm-store',
    version: ['pnpm', '--version'],
    // `pnpm fetch` читает только lockfile; `--ignore-workspace` не даёт искать
    // pnpm-workspace.yaml вверх от рабочего каталога. Скрипты в seed не идут.
    fetch: (store) => [
      'pnpm',
      'fetch',
      '--ignore-workspace',
      '--ignore-scripts',
      '--store-dir=' + store,
    ],
    env: (store) => ({ npm_config_store_dir: store }),
    // Патчи лежат в репозитории, а сборка видит только lockfile.
    permanent: /ERR_PNPM_(?:PATCH_NOT_FOUND|BROKEN_LOCKFILE|LOCKFILE_BREAKING_CHANGE)/,
    buildEnv: (work) => ({
      npm_config_userconfig: join(work, 'npmrc'),
      npm_config_cache_dir: join(work, 'cache'),
      npm_config_state_dir: join(work, 'state'),
    }),
    buildFiles: { 'package.json': '{}\n', npmrc: '' },
  },
};

const FORMAT = 1;
/** Сколько последних по использованию seeds остаётся: текущий и основа следующего. */
const KEEP_SEEDS = 2;
const FILE_CONCURRENCY = 16;
const CLONE_CONCURRENCY = 8;
/** Глубина, на которой дерево делится на порции клонирования (`v10/files/ab`). */
const CLONE_BATCH_DEPTH = 3;
/** После отказа сборки: отказавший реестр не отнимает предел у каждой попытки. */
const FAILED_BUILD_COOLDOWN_MS = 10 * 60 * 1000;
/** Запас свободного места поверх размера seed при обычном копировании. */
const COPY_HEADROOM = 1.1;
/**
 * Какую долю остатка времени фазы могут занять сборка и ожидание чужой сборки:
 * только эти шаги зависят от сети. Остальное время — работе, которая её ждёт.
 */
const STORE_TIME_SHARE = 1 / 3;

export interface StoreContext {
  policy: Pick<ExecutionPolicy, 'isolation'>;
  /** Каталог seeds репозитория (`dependencyStoreRoot`). */
  root(repositoryId: string): string;
  repoPath(repo: Repo): string;
  /** Граница сборки seed — та же, что у проверок этого контура. */
  boundary: Pick<Boundary, 'hidden' | 'checkouts'>;
  resourceDatabase: string;
  /** Момент (ms), когда истекает время фазы; от остатка считается бюджет хранилища. */
  deadline: number;
}

export interface StoreReceipt {
  outcome: 'hit' | 'partial' | 'miss';
  manager: DependencyStorePolicy['manager'];
  /** Ключ использованного seed. */
  seed?: string;
  mode?: 'clone' | 'copy';
  /** Seed собран этим вызовом. */
  built?: boolean;
  files?: number;
  bytes?: number;
  durationMs: number;
  /** Причина промаха. */
  reason?: string;
  /** Seeds, от которых отказались: причина отказа. */
  refused?: string[];
  /** Переменные окружения процессов этого checkout. */
  env: NodeJS.ProcessEnv;
}

interface Manifest {
  format: number;
  key: string;
  identity: Identity;
  lockSha256: string;
  builtAt: string;
  bytes: number;
  files: Record<string, [sha256: string, mode: number]>;
}
interface Identity {
  manager: string;
  version: string;
  node: string;
  platform: string;
  arch: string;
}
interface Seed {
  key: string;
  store: string;
  manifest: Manifest;
}
interface Store {
  ctx: StoreContext;
  repo: Repo;
  spec: DependencyStorePolicy;
  manager: Manager;
  root: string;
  execution: Execution;
  /** Отмена попытки или оператора: она одна прерывает фазу. */
  outer: AbortSignal;
  /** `outer` и бюджет хранилища: его истечение — промах, а не отказ фазы. */
  signal: AbortSignal;
  budgetMs: number;
  logDir: string;
  identity: Identity;
  receipt: Pick<StoreReceipt, 'refused' | 'built'> & { reason?: string };
}

/** Каталог seeds: том рабочих деревьев и уже закрытое песочницей место. */
export function dependencyStoreRoot(
  placement: CheckoutRoot,
  stateDir: string,
  repositoryId: string,
) {
  return checkoutPath(
    placement,
    join(stateDir, 'dependency-store', repositoryId),
    repositoryId,
    'dependency-store',
  );
}

/** Параллельно, с пределом. Отказ останавливает раздачу и дожидается идущих: никто не пишет после возврата. */
const within = async <T>(items: T[], limit: number, action: (item: T) => Promise<void>) => {
  let next = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        try {
          await action(items[index]!);
        } catch (error) {
          next = items.length;
          throw error;
        }
      }
    }),
  );
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
};

/** Файлы дерева. Ссылка и всё, что не обычный файл, — отказ: seed их не содержит. */
async function regularFiles(root: string) {
  const top = await lstat(root);
  if (!top.isDirectory()) throw new SeedRefused('корень хранилища — не каталог');
  const files: { rel: string; mode: number; size: number }[] = [];
  const walk = async (prefix: string) => {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile()) {
        const st = await lstat(join(root, rel));
        files.push({ rel, mode: st.mode & 0o777, size: st.size });
      } else throw new SeedRefused(`в хранилище не обычный файл: ${rel}`);
    }
  };
  await walk('');
  return files;
}

class SeedRefused extends Error {}

async function fingerprint(root: string) {
  const list = await regularFiles(root);
  // Map, а не объект: файл `__proto__` не должен исчезнуть из отпечатка.
  const files = new Map<string, Manifest['files'][string]>();
  await within(list, FILE_CONCURRENCY, async (f) => {
    files.set(f.rel, [sha256(await readFile(join(root, f.rel))), f.mode]);
  });
  return { files, bytes: list.reduce((sum, f) => sum + f.size, 0) };
}

/** Дерево в точности равно манифесту: тот же набор файлов, байты и права. */
async function assertMatches(root: string, manifest: Manifest) {
  const { files } = await fingerprint(root);
  const expected = Object.keys(manifest.files);
  if (files.size !== expected.length)
    throw new SeedRefused(`набор файлов изменён: ${files.size} вместо ${expected.length}`);
  for (const rel of expected) {
    const [hash, mode] = manifest.files[rel]!;
    const found = files.get(rel);
    if (!found) throw new SeedRefused(`нет файла ${rel}`);
    if (found[0] !== hash) throw new SeedRefused(`изменено содержимое ${rel}`);
    if (found[1] !== mode) throw new SeedRefused(`изменены права ${rel}`);
  }
}

/** Способы размещения дерева; тест подменяет `cloneable`, чтобы проверить обычную копию. */
export const storeTree = {
  /**
   * Предел файлов seed: копия лежит в checkout и входит в сверку защищённых
   * путей. Seed больше неё превратил бы ускорение в отказ каждой проверки.
   */
  maxFiles: Math.floor(snapshotLimit * 0.75),
  /**
   * Предел элементов checkout вместе с копией seed. Запас — на то, что проверки
   * допишут в дерево после развёртывания.
   */
  maxEntries: Math.floor(snapshotLimit * 0.9),
  /** Запись `.gitignore` хранилища; тест подменяет её, чтобы проверить отказ. */
  ignore: (dest: string) => writeFile(join(dest, '.gitignore'), '*\n'),
  /**
   * Том клонирует файлы. `cp -c` на другом томе молча копирует, поэтому способ
   * выясняется заранее: от него зависит проверка свободного места.
   */
  async cloneable(from: string, to: string, sample: string, signal: AbortSignal) {
    if ((await stat(from)).dev !== (await stat(dirname(to))).dev) return false;
    if (process.platform === 'darwin') {
      const df = await command([osTool('df'), '-Y', from], from, { signal, timeoutMs: 10000 });
      return /^\S+\s+apfs\s/m.test(df.stdout);
    }
    if (process.platform !== 'linux') return false;
    const probe = join(dirname(to), `.reflink-probe-${randomUUID()}`);
    const done = await command([osTool('cp'), '--reflink=always', sample, probe], from, {
      signal,
      timeoutMs: 10000,
    });
    await rm(probe, { force: true });
    return done.code === 0;
  },
  async freeBytes(path: string) {
    const free = await statfs(path);
    return Number(free.bavail) * Number(free.bsize);
  },
  /** Копия-при-записи порциями: один `cp` на всё дерево вдвое медленнее. */
  async clone(from: string, to: string, signal: AbortSignal) {
    const batches: [string, string][] = [];
    const expand = async (src: string, dst: string, depth: number) => {
      await mkdir(dst, { recursive: true });
      for (const entry of await readdir(src, { withFileTypes: true }))
        if (entry.isDirectory() && depth + 1 < CLONE_BATCH_DEPTH)
          await expand(join(src, entry.name), join(dst, entry.name), depth + 1);
        else batches.push([join(src, entry.name), join(dst, entry.name)]);
    };
    await expand(from, to, 0);
    const flags =
      process.platform === 'darwin'
        ? ['-c', '-R']
        : ['-R', '--reflink=always', '--preserve=mode,timestamps'];
    await within(batches, CLONE_CONCURRENCY, async ([src, dst]) => {
      const done = await command([osTool('cp'), ...flags, src, dst], from, {
        signal,
        timeoutMs: 120000,
      });
      if (done.code) throw new Error(`Клонирование не удалось: ${done.stderr.trim()}`);
    });
  },
  async copy(from: string, to: string) {
    const files = await regularFiles(from);
    await mkdir(to, { recursive: true });
    await within(
      [...new Set(files.map((f) => dirname(join(to, f.rel))))].sort(),
      FILE_CONCURRENCY,
      async (dir) => void (await mkdir(dir, { recursive: true })),
    );
    await within(files, FILE_CONCURRENCY, (f) =>
      copyFile(join(from, f.rel), join(to, f.rel), constants.COPYFILE_EXCL),
    );
  },
};

/** Элементы дерева вне `node_modules` и `.git`: столько же насчитает сверка защищённых путей. */
async function treeEntries(root: string) {
  let count = 0;
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      count++;
      if (entry.isDirectory()) await walk(join(dir, entry.name));
    }
  };
  await walk(root);
  return count;
}

/** Развернуть seed в `to` и сверить результат; способ — клон, иначе копия. */
async function place(seed: Seed, to: string, signal: AbortSignal) {
  const sample = join(seed.store, '..', 'manifest.json');
  const cloned = await storeTree.cloneable(seed.store, to, sample, signal);
  if (cloned) await storeTree.clone(seed.store, to, signal);
  else {
    const available = await storeTree.freeBytes(dirname(to));
    if (available < seed.manifest.bytes * COPY_HEADROOM)
      throw new Error(
        `копия seed не помещается: нужно ${seed.manifest.bytes} байт, свободно ${available}`,
      );
    await storeTree.copy(seed.store, to);
  }
  await assertMatches(to, seed.manifest);
  return cloned ? ('clone' as const) : ('copy' as const);
}

const pool = <T>(s: Store, action: (pool: ResourcePool) => T) => {
  const resources = new ResourcePool(s.ctx.resourceDatabase);
  try {
    return action(resources);
  } finally {
    resources.close();
  }
};

/** Убрать seed: сначала переименование, чтобы читатель не застал половину. */
async function dropSeed(s: Store, key: string) {
  const trash = join(s.root, 'tmp', randomUUID());
  await mkdir(dirname(trash), { recursive: true });
  await rename(join(s.root, 'seeds', key), trash).catch(() => undefined);
  await rm(trash, { recursive: true, force: true });
  pool(s, (p) => p.setSeedPin(s.root, key, undefined));
}

const refuse = async (s: Store, key: string, why: string) => {
  (s.receipt.refused ??= []).push(`${key}: ${why}`);
  await dropSeed(s, key);
};

/** Seed с закреплённым манифестом; неверный — отказ, отсутствующий — `undefined`. */
async function readSeed(s: Store, key: string): Promise<Seed | undefined> {
  const dir = join(s.root, 'seeds', key);
  const path = join(dir, 'manifest.json');
  const st = await lstat(path).catch(() => undefined);
  if (!st) {
    // Каталог без манифеста сам по себе не seed: публикация атомарна.
    if (await lstat(dir).catch(() => undefined)) await refuse(s, key, 'нет манифеста');
    return undefined;
  }
  if (!st.isFile()) return void (await refuse(s, key, 'манифест — не обычный файл'));
  const raw = await readFile(path);
  if (sha256(raw) !== pool(s, (p) => p.seedPin(s.root, key)))
    return void (await refuse(s, key, 'манифест не совпал с закреплённым'));
  const manifest = JSON.parse(raw.toString('utf8')) as Manifest;
  if (manifest.key !== key) return void (await refuse(s, key, 'ключ манифеста другой'));
  return { key, store: join(dir, 'store'), manifest };
}

const sameIdentity = (a: Identity, b: Identity) => digestOf(a) === digestOf(b);

async function seedKeys(s: Store) {
  return readdir(join(s.root, 'seeds')).catch(() => [] as string[]);
}

/** Самый свежий seed той же среды — частичное попадание или основа сборки. */
async function newestSeed(s: Store) {
  const seeds: Seed[] = [];
  for (const key of await seedKeys(s)) {
    const seed = await readSeed(s, key);
    // Ключ содержит формат, но основа выбирается перебором: seed другого формата
    // не подходит и основой.
    if (seed?.manifest.format === FORMAT && sameIdentity(seed.manifest.identity, s.identity))
      seeds.push(seed);
  }
  return seeds.sort((a, b) => b.manifest.builtAt.localeCompare(a.manifest.builtAt))[0];
}

/**
 * Эксклюзивная секция сборки между процессами: аренда `ResourcePool`, брошенная
 * упавшим процессом снимается штатным `clearAbandoned`. Корректность на ней не
 * держится (публикация атомарна): она только не даёт качать одно и то же дважды.
 * Живую аренду не отнимает ни срок, ни бюджет. Истёк бюджет — `undefined`.
 *
 * В `owner` записан момент запуска владельца: pid после перезапуска контейнера
 * занимает другой процесс, и `clearAbandoned` по одному pid ждал бы вечно.
 * Запись своя у этой аренды, поведение других ресурсов не меняется.
 */
const LEASE_OWNER = 'dependency-store-started:';

async function exclusive<T>(s: Store, work: () => Promise<T>): Promise<T | undefined> {
  const resource = {
    id: 'dependency-store',
    kind: 'service' as const,
    value: 'dependency-store:' + s.root,
  };
  const key = resourceKey(resource);
  const token = randomUUID();
  const owner = LEASE_OWNER + ((await processStart(process.pid)) ?? '');
  const compared = new Set<string>();
  const leases = new ResourcePool(s.ctx.resourceDatabase);
  try {
    while (!leases.tryAcquire([resource], owner, token, s.budgetMs)) {
      const lease = leases.list().find((l) => l.key === key);
      if (lease) {
        try {
          leases.clearAbandoned(key, lease.token);
          continue;
        } catch {
          /* Процесс с этим pid есть (или аренда уже снята): чей он — ниже. */
        }
        const started = lease.owner.startsWith(LEASE_OWNER)
          ? lease.owner.slice(LEASE_OWNER.length)
          : '';
        if (started && !compared.has(lease.token)) {
          compared.add(lease.token);
          const actual = await processStart(lease.pid);
          // Сравнить не с чем — владелец считается живым.
          if (actual && actual !== started) {
            leases.release(lease.token);
            continue;
          }
        }
      }
      try {
        await delay(200, undefined, { signal: s.signal });
      } catch (error) {
        if (s.outer.aborted) throw error;
        return undefined;
      }
    }
    return await work();
  } finally {
    leases.release(token);
    leases.close();
  }
}

const failedMark = (s: Store, key: string) => join(s.root, 'failed', key);

interface FailedBuild {
  reason: string;
  /** Повторится на том же lockfile: сборка не идёт, пока он не изменится. */
  permanent: boolean;
}

/** Действующая пометка отказа сборки этого ключа. */
async function failedBuild(s: Store, key: string) {
  const path = failedMark(s, key);
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  const mark = JSON.parse(raw) as FailedBuild;
  if (mark.permanent) return mark;
  const st = await stat(path).catch(() => undefined);
  return st && Date.now() - st.mtimeMs < FAILED_BUILD_COOLDOWN_MS ? mark : undefined;
}

const failedReason = (mark: FailedBuild) =>
  (mark.permanent ? 'сборка этого lockfile невозможна: ' : 'недавняя сборка не удалась: ') +
  mark.reason;

async function markFailed(s: Store, key: string, reason: string, permanent = false) {
  s.receipt.reason = reason;
  await mkdir(join(s.root, 'failed'), { recursive: true });
  await writeFile(failedMark(s, key), JSON.stringify({ reason, permanent }));
}

/** Один проход сборки в каталоге `work`; итог — дерево с отпечатком или причина отказа. */
async function fetchInto(s: Store, work: string, lock: string, settings: string, base?: Seed) {
  const project = join(work, 'project');
  const store = join(work, 'store');
  await rm(work, { recursive: true, force: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, s.spec.lockfile.split('/').at(-1)!), lock + '\n');
  for (const [name, text] of Object.entries(s.manager.buildFiles))
    await writeFile(join(name === 'package.json' ? project : work, name), text);
  if (base) await place(base, store, s.outer);
  const result = await runCheck(
    { config: s.ctx.policy },
    {
      argv: s.manager.fetch(store),
      cwd: project,
      env: { ...s.execution.env, ...s.manager.buildEnv(work) },
      redact: s.execution.redact,
      signal: s.signal,
      timeoutMs: s.budgetMs,
      write: [work],
      readable: [],
      controller: s.ctx.boundary.hidden,
      ...(s.ctx.boundary.checkouts?.length ? { checkouts: s.ctx.boundary.checkouts } : {}),
      settingsDir: settings,
    },
  );
  await mkdir(s.logDir, { recursive: true });
  await writeFile(
    join(s.logDir, 'dependency-store.log'),
    s.execution.redact(result.stdout + '\n' + result.stderr),
  );
  // Прерванный менеджер мог выйти и без кода ошибки: его store не итог сборки, а
  // пустой store иначе выглядел бы неизбежным отказом самого lockfile.
  if (result.code || result.timedOut || s.signal.aborted) {
    const output = s.execution.redact(result.stderr || result.stdout).trim();
    throw new BuildFailed(
      `сборка seed: код ${result.code}${result.timedOut ? ', предел времени' : ''}: ${output.slice(-500)}`,
      !result.timedOut && s.manager.permanent.test(result.stdout + result.stderr),
    );
  }
  return { store, ...(await fingerprint(store)) };
}

class BuildFailed extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/** Сборка seed и атомарная публикация; отказ — причина и пометка, не исключение. */
async function buildSeed(s: Store, key: string, lock: string, lockSha256: string) {
  await sweep(s);
  const tmp = join(s.root, 'tmp', randomUUID());
  const work = join(tmp, 'work');
  try {
    // Основа — свежий seed той же среды: сдвиг lockfile докачивает только разницу.
    let base = await newestSeed(s);
    let built: Awaited<ReturnType<typeof fetchInto>> | undefined;
    for (;;) {
      try {
        built = await fetchInto(s, work, lock, join(tmp, 'settings'), base);
      } catch (error) {
        if (!(error instanceof SeedRefused) || !base) throw error;
        await refuse(s, base.key, error.message);
        base = undefined;
        continue;
      }
      // Основа копит пакеты прежних lockfile: сверх предела — заново с пустого.
      if (built.bytes <= s.spec.maxBytes || !base) break;
      base = undefined;
    }
    if (built.bytes > s.spec.maxBytes)
      throw new BuildFailed(`seed ${built.bytes} байт больше предела ${s.spec.maxBytes}`, true);
    if (built.files.size > storeTree.maxFiles)
      throw new BuildFailed(
        `seed из ${built.files.size} файлов больше предела ${storeTree.maxFiles}`,
        true,
      );
    // Менеджер мог выйти с кодом 0 и ничего не сохранить: такой seed не ускоряет
    // ничего, а выглядел бы попаданием.
    if (!built.files.size) throw new BuildFailed('менеджер не сохранил ни одного файла', true);
    const manifest: Manifest = {
      format: FORMAT,
      key,
      identity: s.identity,
      lockSha256,
      builtAt: new Date().toISOString(),
      bytes: built.bytes,
      files: Object.fromEntries(built.files),
    };
    const raw = JSON.stringify(manifest);
    const staged = join(tmp, 'seed');
    await mkdir(staged);
    await rename(built.store, join(staged, 'store'));
    await writeFile(join(staged, 'manifest.json'), raw);
    await mkdir(join(s.root, 'seeds'), { recursive: true });
    // Закрепление раньше публикации: читатель не застаёт незакреплённый seed.
    pool(s, (p) => p.setSeedPin(s.root, key, sha256(raw)));
    await rename(staged, join(s.root, 'seeds', key));
    // Новый seed значит новый lockfile: прежние отказы к нему не относятся.
    await rm(join(s.root, 'failed'), { recursive: true, force: true });
    s.receipt.built = true;
    await collect(s, key);
    return { key, store: join(s.root, 'seeds', key, 'store'), manifest };
  } catch (error) {
    if (s.outer.aborted) throw error;
    await markFailed(
      s,
      key,
      s.signal.aborted
        ? `бюджет хранилища ${s.budgetMs} мс истёк`
        : error instanceof Error
          ? error.message
          : String(error),
      error instanceof BuildFailed && error.permanent,
    );
    return undefined;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Брошенные каталоги сборки: вызывается под арендой, живых среди них нет. */
async function sweep(s: Store) {
  for (const name of await readdir(join(s.root, 'tmp')).catch(() => [] as string[]))
    await rm(join(s.root, 'tmp', name), { recursive: true, force: true });
}

/**
 * Предел диска: остаются последние по использованию seeds, не больше
 * `KEEP_SEEDS` и в пределах `maxBytes`. Только что собранный остаётся всегда.
 */
async function collect(s: Store, current: string) {
  const seeds: { key: string; used: number; bytes: number }[] = [];
  for (const key of await seedKeys(s)) {
    const path = join(s.root, 'seeds', key, 'manifest.json');
    const seed = await readFile(path, 'utf8').then(
      async (raw) => ({
        key,
        used: (await stat(path)).mtimeMs,
        bytes: Number((JSON.parse(raw) as Manifest).bytes) || 0,
      }),
      () => undefined,
    );
    if (seed) seeds.push(seed);
  }
  const ordered = seeds.sort(
    (a, b) => Number(b.key === current) - Number(a.key === current) || b.used - a.used,
  );
  let total = 0;
  for (const [i, seed] of ordered.entries()) {
    total += seed.bytes;
    if (i && (i >= KEEP_SEEDS || total > s.spec.maxBytes)) await dropSeed(s, seed.key);
  }
}

/** Точный seed целевой ветки (собирается при нужде), иначе свежий seed той же среды. */
async function chooseSeed(s: Store) {
  const lock = await gitOutput(
    s.ctx.repoPath(s.repo),
    'show',
    `${s.repo.targetRef}:${s.spec.lockfile}`,
  ).catch(() => undefined);
  if (lock === undefined) {
    s.receipt.reason = `${s.spec.lockfile} нет в ${s.repo.targetRef}`;
    return undefined;
  }
  const lockSha256 = sha256(lock);
  const key = digestOf({ format: FORMAT, identity: s.identity, lockSha256 });
  const exact = await readSeed(s, key);
  if (exact) return exact;
  const failed = await failedBuild(s, key);
  if (failed) s.receipt.reason = failedReason(failed);
  else {
    const built = await exclusive(s, async () => {
      const seed = await readSeed(s, key);
      if (seed) return seed;
      // Проверка под арендой: очередь за упавшей сборкой не повторяет её.
      const refused = await failedBuild(s, key);
      if (!refused) return buildSeed(s, key, lock, lockSha256);
      s.receipt.reason = failedReason(refused);
      return undefined;
    });
    if (built) return built;
    s.receipt.reason ??= 'не дождались чужой сборки seed';
  }
  return newestSeed(s);
}

async function identityOf(manager: Manager, spec: DependencyStorePolicy, env: NodeJS.ProcessEnv) {
  const [tool, node] = await Promise.all(
    [manager.version, ['node', '--version']].map((argv) =>
      defaultProbe(argv, { timeoutMs: PROBE_TIMEOUT_MS, env }),
    ),
  );
  if (tool!.code || node!.code) return undefined;
  return {
    manager: spec.manager,
    version: tool!.stdout.trim(),
    node: node!.stdout.trim(),
    platform: process.platform,
    arch: process.arch,
  };
}

/** Почему этой версией менеджера хранилище не пользуется, или `undefined`. */
async function unsupported(identity: Identity, spec: DependencyStorePolicy, cwd: string) {
  const { from, below } = dependencyStoreVersions[spec.manager];
  const pinned = await readFile(join(cwd, 'package.json'), 'utf8')
    .then((raw) => (JSON.parse(raw) as { packageManager?: unknown }).packageManager)
    .catch(() => undefined);
  const versions = [
    versionOf(identity.version) ?? identity.version,
    declaredManagerVersion(pinned, spec.manager),
  ].filter((v) => v !== undefined);
  const wrong = versions.find((v) => !dependencyStoreSupports(spec.manager, v));
  return wrong && `${spec.manager} ${wrong} вне проверенных версий ${from} … <${below}`;
}

/** Lockfile checkout: обычный файл внутри дерева или ничего. */
async function checkoutLock(cwd: string, lockfile: string) {
  const path = join(cwd, lockfile);
  if (!(await lstat(path).catch(() => undefined))?.isFile()) return undefined;
  return sha256((await readFile(path, 'utf8')).trim());
}

/**
 * Подготовить хранилище checkout до `prepare` и gates. Промах — обычный исход:
 * исключение бывает только при отмене, а сводка пишется в `dir`.
 * Окружение менеджера дописывается в `execution` (как `withEnvironment` дописывает
 * каталог окружения) и повторяется в квитанции для хостов с окружением на gate.
 */
export async function materializeStore(
  ctx: StoreContext,
  input: {
    repo: Repo;
    cwd: string;
    execution: Execution;
    signal: AbortSignal;
    /** Каталог артефактов фазы: квитанция и журнал сборки. */
    dir: string;
  },
): Promise<StoreReceipt | undefined> {
  const spec = input.repo.dependencyStore;
  if (!spec) return undefined;
  const started = Date.now();
  const manager = managers[spec.manager];
  const dest = join(input.cwd, manager.dir);
  const summary: Partial<StoreReceipt> & Store['receipt'] = {};
  let env: NodeJS.ProcessEnv = {};
  // Хранилище checkout всегда скрыто от git своим `.gitignore`: и при промахе —
  // менеджер всё равно создаёт его здесь, и проект не обязан его игнорировать.
  const seal = async () => {
    await mkdir(dest, { recursive: true });
    await storeTree.ignore(dest);
    env = manager.env(dest);
    Object.assign(input.execution.env, env);
  };
  try {
    if (ctx.policy.isolation.mode !== 'os')
      summary.reason = 'isolation.mode: none: граница seed не действует, установка обычная';
    // Занятый путь — и ссылка, которую кандидат мог положить, чтобы увести
    // запись controller из дерева: туда ничего не пишется.
    else if (await lstat(dest).catch(() => undefined))
      summary.reason = `${manager.dir} уже есть в дереве`;
    else {
      const identity = await identityOf(manager, spec, input.execution.env);
      const refusal = identity
        ? await unsupported(identity, spec, input.cwd)
        : `не найден ${manager.version[0]} или node`;
      // Вне проверенных версий окружение и дерево остаются как без хранилища.
      if (refusal || !identity) summary.reason = refusal;
      else {
        const lock = await checkoutLock(input.cwd, spec.lockfile);
        if (lock === undefined) summary.reason = `в дереве нет файла ${spec.lockfile}`;
        else {
          const budgetMs = Math.max(
            1,
            Math.floor(Math.min(spec.timeoutMs, (ctx.deadline - Date.now()) * STORE_TIME_SHARE)),
          );
          const s: Store = {
            ctx,
            repo: input.repo,
            spec,
            manager,
            root: ctx.root(input.repo.id),
            execution: input.execution,
            outer: input.signal,
            signal: AbortSignal.any([input.signal, AbortSignal.timeout(budgetMs)]),
            budgetMs,
            logDir: input.dir,
            identity,
            receipt: summary,
          };
          const present = await treeEntries(input.cwd);
          for (let round = 0; round < 2 && !summary.outcome; round++) {
            const seed = await chooseSeed(s);
            if (!seed) break;
            const entries = Object.keys(seed.manifest.files).length + present;
            if (entries > storeTree.maxEntries) {
              // Копия не влезла бы в сверку защищённых путей: проверка упала бы.
              summary.reason = `checkout с копией seed — ${entries} элементов, предел ${storeTree.maxEntries}`;
              break;
            }
            try {
              summary.mode = await place(seed, dest, input.signal);
              await utimes(
                join(s.root, 'seeds', seed.key, 'manifest.json'),
                new Date(),
                new Date(),
              );
              summary.outcome = seed.manifest.lockSha256 === lock ? 'hit' : 'partial';
              summary.seed = seed.key;
              summary.files = Object.keys(seed.manifest.files).length;
              summary.bytes = seed.manifest.bytes;
            } catch (error) {
              await rm(dest, { recursive: true, force: true });
              delete summary.mode;
              if (!(error instanceof SeedRefused)) throw error;
              await refuse(s, seed.key, error.message);
            }
          }
        }
        await seal();
      }
    }
  } catch (error) {
    if (input.signal.aborted) throw error;
    // Квитанция не обещает то, чего в дереве уже нет.
    for (const field of ['outcome', 'mode', 'seed', 'files', 'bytes'] as const)
      delete summary[field];
    summary.reason = error instanceof Error ? error.message : String(error);
    env = {};
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    // Не вышло и это — в дереве ничего не остаётся, как без хранилища.
    await seal().catch(() => rm(dest, { recursive: true, force: true }).catch(() => undefined));
  }
  const receipt: StoreReceipt = {
    outcome: 'miss',
    ...summary,
    manager: spec.manager,
    durationMs: Date.now() - started,
    env,
  };
  // Квитанция — наблюдение, а не условие работы: полный диск не отказ фазы.
  await mkdir(input.dir, { recursive: true })
    .then(() =>
      writeFile(join(input.dir, 'dependency-store.json'), JSON.stringify(receipt, null, 2)),
    )
    .catch(() => undefined);
  return receipt;
}
