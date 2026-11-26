import { chmod, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import {
  COMPOSE_READINESS_FILE,
  SERVICE_PORT_KEYS,
  servicePortKeys,
  servicePortsFromFile,
} from './compose-env.ts';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { z } from 'zod';
import {
  digestOf,
  environmentSchema,
  lifecycleSchema,
  stepSchema,
  TaskFailure,
  stepOutputText,
  type ExecutionPolicy,
  type ToolchainPin,
} from '../contracts/index.ts';
import { pinnedSource } from './toolchain-pin.ts';
import {
  dependencyNetworkFailure,
  dependencyNetworkMessage,
  registryFailureLine,
} from './dependency-network.ts';
import { protectedChanges, protectedSnapshot, SandboxPolicyError } from './isolation.ts';
import { command } from './process.ts';
import {
  baseCheckoutEnv,
  removeBaseCheckout,
  withBaseCheckout,
  type TrustedTree,
} from './trusted-tree.ts';
import { containerIdentity, containerUse } from './container-identity.ts';
import { ensurePortsFree } from './port-probe.ts';
import { leaseScope } from './survivors.ts';
import { redactDeep, redactor, type Redactor } from './redaction.ts';
import { maskedTail } from '../verification/failure-summary.ts';
export { redactor } from './redaction.ts';

/** Предел хвоста вывода упавшего шага (сообщение, receipt, smoke). */
export const STEP_TAIL_LIMIT = 600;

type Environment = z.infer<typeof environmentSchema>;
type Lifecycle = z.infer<typeof lifecycleSchema>;
type Step = z.infer<typeof stepSchema>;

/**
 * Отказ обязательной очистки окружения: приёмка с ним не происходит.
 * Исходный отказ работы, если он был, — `cause`: класс и причина попытки —
 * его (`classifyFailure`), очистка лишь дописана к тексту. Без исходного
 * отказа это отказ окружения `cleanup`: ресурсы попытки не освобождены, о
 * коде это ничего не говорит.
 */
export class CleanupFailure extends Error {
  override name = 'CleanupFailure';
  constructor(message: string, original?: Error) {
    super(message, original ? { cause: original } : undefined);
  }
  /** Исходный отказ работы, если он был. */
  get original(): Error | undefined {
    return this.cause instanceof Error ? this.cause : undefined;
  }
  /** Тот же отказ с дописанной причиной; исходный отказ сохраняется. */
  extend(suffix: string) {
    return new CleanupFailure(`${this.message}; ${suffix}`, this.original);
  }
}

/** Жив ли процесс (сигнал 0 не доставляется, только проверяется). */
/**
 * Записать файл только для владельца (0600, ревью M1/M2 alpha.72): receipt
 * окружения и файл окружения попытки несут тестовые секреты попытки.
 * `mode` действует только при создании — у прежнего файла права правятся.
 */
export async function writePrivate(path: string, data: string) {
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
}

export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function executionEnvironment(
  profiles: (Environment | undefined)[],
  devcontour: NodeJS.ProcessEnv = {},
  source = process.env,
  /**
   * Закреплённый toolchain политики (`policy.toolchain`): каталог node
   * первым в PATH окружения, одинаково для каждой фазы и процесса. Не
   * разрешился — `ToolchainPinError` (отказ окружения до работы).
   */
  toolchain?: ToolchainPin,
) {
  source = pinnedSource(toolchain, source);
  // Окружение прогона — минимальное: исполнитель не должен наследовать всё,
  // что оказалось у оператора. Но учётные данные runtime живут в системном
  // хранилище, а найти их там нельзя, не зная имени учётной записи: без USER
  // claude на macOS отвечает «Not logged in», и единственным выходом остаётся
  // передать API-ключ — то есть платить за то, что уже оплачено подпиской.
  // USER и LOGNAME — не секреты, а адрес в хранилище.
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    HOME: source.HOME,
    TMPDIR: source.TMPDIR,
    USER: source.USER,
    LOGNAME: source.LOGNAME ?? source.USER,
    CI: '1',
  };
  const secretValues: string[] = [];
  // Имена переменных с маскируемыми значениями — шагам, которые сами пишут
  // диагностику (`harness env-up`): значения на диск не попадают (ревью 2).
  const secretNames = new Set<string>();
  for (const profile of profiles) {
    if (!profile) continue;
    for (const key of profile.inherit) {
      if (source[key] === undefined) throw new Error(`Не задана переменная окружения: ${key}`);
      env[key] = source[key];
      // Наследуемые значения тоже маскируются — вызывающему не нужно
      // объявлять каждый токен провайдера, — но только похожие на секрет:
      // по имени или длиной. Очень короткое общее значение (`FORCE_COLOR=1`,
      // `CI=true`) иначе вырезалось бы из каждой строки вывода.
      if (source[key] && inheritedSecret(key, source[key])) {
        secretValues.push(source[key]);
        secretNames.add(key);
      }
    }
    Object.assign(env, profile.values);
    for (const [key, from] of Object.entries(profile.secrets)) {
      if (!source[from]) throw new Error(`Не задан секрет окружения: ${from} (для ${key})`);
      env[key] = source[from];
      secretValues.push(source[from]);
      secretNames.add(key);
    }
  }
  // Переменные контура: исторические DEVCONTOUR_* — часть договора проверок
  // пользователей — и их псевдонимы HARNESS_* с теми же значениями.
  for (const [key, value] of Object.entries(devcontour)) {
    env[key] = value;
    if (key.startsWith('DEVCONTOUR_')) env['HARNESS_' + key.slice('DEVCONTOUR_'.length)] = value;
  }
  // Тестовые секреты попытки (alpha.72, `attemptEnv.secrets`) маскируются как
  // объявленные: список имён приходит с переменными попытки и в receipt, так
  // что и очистка в новом процессе маскирует те же значения.
  for (const key of (env.HARNESS_ATTEMPT_SECRETS ?? '').split(',').filter(Boolean)) {
    const value = env[key];
    if (!value) continue;
    secretValues.push(value);
    secretNames.add(key);
  }
  if (secretNames.size) env.HARNESS_SECRET_NAMES = [...secretNames].sort().join(',');
  const result: {
    env: NodeJS.ProcessEnv;
    redact: Redactor;
    /** Вложенные `.git`, созданные подготовкой фазы (`preparationGuard`). */
    prepared?: PreparedProtected;
    /** Наблюдатель шагов `runSteps` (lifecycle, prepare): замер и исход каждого шага. */
    onStep?: (step: StepOutcome) => void;
  } = { env, redact: redactor(secretValues) };
  return result;
}

/** Имя переменной похоже на секрет. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|AUTH|PRIVATE)/i;
/** Наименьшая длина наследуемого значения без секретного имени, которое маскируется. */
export const INHERITED_SECRET_MIN = 8;

/**
 * Маскировать ли наследуемое значение: имя похоже на секрет (значение не
 * короче 4 знаков, как у настроек коннектора) или значение длинное
 * (`INHERITED_SECRET_MIN`). Объявленные `secrets` маскируются всегда.
 */
export const inheritedSecret = (key: string, value: string) =>
  SECRET_NAME.test(key) ? value.length >= 4 : value.length >= INHERITED_SECRET_MIN;
/**
 * Маска по тем секретам и наследуемым значениям, что заданы, — даже когда
 * окружение целиком собрать нельзя. Незаданный секрет — причина отказа, но не
 * повод снимать маску с остальных: известный секрет иначе сохранялся бы в
 * команде и итоге проверки.
 */
export function availableRedactor(profiles: (Environment | undefined)[], source = process.env) {
  const values: string[] = [];
  for (const profile of profiles) {
    if (!profile) continue;
    for (const key of profile.inherit) if (source[key]) values.push(source[key]);
    for (const from of Object.values(profile.secrets)) if (source[from]) values.push(source[from]);
  }
  return redactor(values);
}
/**
 * Исход одного шага `runSteps` для наблюдателя (`execution.onStep`): стадия —
 * имя каталога логов шага (`setup`, `ready`, `prepare`, `teardown`).
 */
export interface StepOutcome {
  stage: string;
  id: string;
  durationMs: number;
  /** Шаг прошёл: exit 0, без предела и отмены. */
  ok: boolean;
  /** Код выхода; нет — процесс не запустился (`spawnError`). */
  exitCode?: number;
  timedOut: boolean;
  /** Шаг остановлен сигналом фазы (отмена, предел фазы). */
  aborted: boolean;
  /** Сигнал, которым завершился процесс шага (`SIGKILL` после предела, чужой сигнал). */
  signal?: string;
  /**
   * Хвост вывода упавшего шага (0.1.0-alpha.68): последние строки stdout и
   * stderr с маской секретов, до `STEP_TAIL_LIMIT` знаков.
   */
  tail?: string;
  /** Код системной ошибки запуска (`ENOENT` — нет исполняемого файла, `EACCES`). */
  spawnError?: string;
  log?: string;
  /** Пояснение стадии без команды (исход хранилища зависимостей). */
  detail?: string;
  /**
   * Подпись сетевого отказа реестра в выводе упавшей установки
   * (`registryFailureLine`) — без сверки входов с базой: только для
   * диагноза `harness smoke`, попытки по нему не судятся.
   */
  registryFailure?: string;
  /**
   * Стадия прошла, но ничего не дала: хранилище зависимостей не использовано
   * (промах, отказ сборки seed). Не отказ — и не «пройдено».
   */
  unused?: boolean;
}

export async function runSteps(
  steps: Step[],
  cwd: string,
  dir: string,
  execution: ReturnType<typeof executionEnvironment>,
  signal: AbortSignal,
  /** SHA базы попытки: только с ним шаг установки может стать `dependency-network`. */
  trustedBase?: string,
) {
  await mkdir(dir, { recursive: true });
  for (const step of steps) {
    signal.throwIfAborted();
    const started = Date.now();
    const stage = basename(dir);
    let result: Awaited<ReturnType<typeof command>>;
    try {
      result = await command(step.command, cwd, {
        activity: { kind: 'step', label: step.id },
        signal,
        timeoutMs: step.timeoutMs,
        env: execution.env,
        redact: execution.redact,
      });
    } catch (error) {
      execution.onStep?.({
        stage,
        id: step.id,
        durationMs: Date.now() - started,
        ok: false,
        timedOut: false,
        aborted: signal.aborted,
        spawnError: (error as NodeJS.ErrnoException).code ?? 'ERROR',
      });
      throw error;
    }
    const log = join(dir, step.id + '.log');
    await writeFile(log, result.stdout + '\n' + result.stderr);
    const registry =
      result.code && !result.timedOut && !signal.aborted
        ? registryFailureLine(step.command, result.code, result.stdout + '\n' + result.stderr)
        : undefined;
    const failed = Boolean(result.code || result.timedOut || signal.aborted);
    // Причина упавшего шага — в тексте отказа, receipt и smoke, а не только в
    // логе: сигнал процесса и хвост вывода с маской (0.1.0-alpha.68).
    const exitSignal = failed ? (result.diagnostics?.signal ?? undefined) : undefined;
    const tail = failed
      ? maskedTail(result.stdout, result.stderr, execution.redact, STEP_TAIL_LIMIT)
      : '';
    execution.onStep?.({
      stage,
      id: step.id,
      durationMs: Date.now() - started,
      ok: !failed,
      exitCode: result.code,
      timedOut: result.timedOut,
      aborted: signal.aborted,
      log,
      ...(exitSignal ? { signal: exitSignal } : {}),
      ...(tail ? { tail } : {}),
      ...(registry ? { registryFailure: execution.redact(registry) } : {}),
    });
    if (failed) {
      const message =
        `Шаг ${step.id}: exit=${result.code}; timeout=${result.timedOut}` +
        (exitSignal ? `; signal=${exitSignal}` : '') +
        (stage === 'ready' || stage === 'setup' || stage === 'teardown'
          ? `; стадия ${stage}`
          : '') +
        stepOutputText(tail);
      // Шаг установки зависимостей, упавший на сети или реестре: отказ среды
      // с причиной в сообщении, а не неизвестный (environment/dependency-network.ts).
      const network =
        !result.timedOut && !signal.aborted
          ? await dependencyNetworkFailure({
              argv: step.command,
              code: result.code,
              output: result.stdout + '\n' + result.stderr,
              root: cwd,
              ...(trustedBase ? { base: trustedBase } : {}),
            })
          : undefined;
      if (network)
        throw new TaskFailure(
          'environment',
          dependencyNetworkMessage(execution.redact(network), message),
          undefined,
          'dependency-network',
        );
      throw new Error(message);
    }
  }
}

/**
 * Защищённые пути, которыми владеет подготовка фазы: вложенные `.git`
 * (подмодули, клоны зависимостей), созданные или изменённые её шагами. Пути —
 * относительно корня дерева фазы. Сверки исполнителя, установки и gates той
 * же фазы не считают нарушением только их исчезновение; изменение остаётся
 * нарушением.
 */
export type PreparedProtected = Set<string>;

/** Есть ли у фазы подготовка, которую стоит сверять. */
export function preparesTree(
  lifecycle: Lifecycle | undefined,
  prepare: readonly Step[],
  store: unknown,
) {
  return !!(lifecycle?.setup.length || lifecycle?.ready.length || prepare.length || store);
}

/**
 * Вложенный `.git` (файл подмодуля или каталог клона) ниже корня дерева.
 * Корневой `.git` с его `config` и `hooks` сюда не входит.
 */
const nestedGit = (root: string, path: string) =>
  basename(path).toLowerCase() === '.git' && dirname(path) !== root;

/**
 * Сверка защищённых путей вокруг подготовки фазы: шагов lifecycle `setup` и
 * `ready`, хранилища зависимостей и шагов `prepare`. Их задаёт политика, и
 * исполняются они обычным процессом хоста, вне песочницы, — запреты имён на
 * них не действуют. Снимок снимается до `withEnvironment`, сверка — сразу
 * после `prepare`, до черновика, установки и исполнителя.
 *
 * - Вложенный `.git`, созданный или изменённый подготовкой (`git submodule
 *   update --init`, клоны менеджеров зависимостей), разрешён и переходит во
 *   владение подготовки: проверка записывает его в `execution.prepared`, и
 *   сверки исполнителя, установки и gates этой фазы его исчезновение
 *   (уборка фикстуры переносом родителя) нарушением не считают. Изменение
 *   его содержимого или подмена другим `.git` — по-прежнему нарушение.
 * - Любой другой защищённый путь — конфигурация IDE, агента, shell или
 *   корневого `.git` — созданный, изменённый или удалённый подготовкой, —
 *   отказ среды (`sandbox-policy`) с путями в сообщении: его чинит политика,
 *   а не код задачи.
 *
 * Без песочницы ОС (`os = false`) или без подготовки (`active = false`)
 * сверки нет: обходить дерево незачем.
 */
export function preparationGuard(os: boolean, root: string, active = true) {
  type Check = (execution?: { prepared?: PreparedProtected }) => void;
  if (!os || !active) return (() => {}) as Check;
  const environment = (message: string) =>
    new TaskFailure('environment', message, undefined, 'sandbox-policy');
  let before: Map<string, string>;
  try {
    before = protectedSnapshot(root);
  } catch (error) {
    if (error instanceof SandboxPolicyError) throw environment(error.message);
    throw error;
  }
  const check: Check = (execution) => {
    let changed: string[];
    try {
      changed = protectedChanges(before, root);
    } catch (error) {
      if (error instanceof SandboxPolicyError) throw environment(error.message);
      throw error;
    }
    const refused = changed.filter((p) => !nestedGit(root, p));
    if (refused.length)
      throw environment(
        'Подготовка окружения (lifecycle setup/ready, хранилище зависимостей, prepare) создала, ' +
          'изменила или удалила защищённые пути (конфигурация IDE, агента, shell или корневого git): ' +
          refused
            .slice(0, 5)
            .map((p) => relative(root, p))
            .join(', ') +
          (refused.length > 5 ? ` и ещё ${refused.length - 5}` : '') +
          '. Шаги подготовки задаёт политика, и исполняются они вне песочницы: такие пути в ' +
          'дереве проверки они не создают, не меняют и не удаляют — держите их вне worktree',
      );
    if (execution && changed.length) {
      execution.prepared ??= new Set();
      for (const p of changed) execution.prepared.add(relative(root, p));
    }
  };
  return check;
}

/**
 * Точка подмены для тестов: фазы берут сверку подготовки отсюда (как
 * `hostLoad` у gate), и тест проверяет, что каждая фаза её вызывает.
 */
export const preparation = { guard: preparationGuard };

// Teardown uses a fresh deadline: cancellation must not cancel cleanup itself.
// The receipt is retained after crashes and can be explicitly resumed with environment-cleanup.
export async function withEnvironment<T>(
  lifecycle: Lifecycle | undefined,
  cwd: string,
  dir: string,
  execution: ReturnType<typeof executionEnvironment>,
  signal: AbortSignal,
  action: () => Promise<T>,
  measure: <R>(stage: string, action: () => Promise<R>) => Promise<R> = (_stage, action) =>
    action(),
  /** Предупреждения пробы портов (порт, занятый чужим процессом только на wildcard). */
  warn?: (message: string) => void,
  /**
   * Работа инфраструктуры (docs/infra-works.md): teardown исполняется в
   * отдельном чистом checkout доверенной базы (`trusted-tree.ts`), дерево
   * кандидата не меняется.
   */
  trusted?: TrustedTree,
): Promise<T> {
  // Порты аренды свободны до lifecycle, prepare и gates фазы; внутри фазы
  // их законно держат её службы, и вложенная фаза их не проверяет.
  const warnings = await ensurePortsFree();
  if (warnings.length) {
    // Предупреждение видно в артефактах фазы (`port-probe.json`) и стадией
    // `port-shared:<порт>` в замерах попытки.
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'port-probe.json'), JSON.stringify({ warnings }, null, 2));
    for (const message of warnings) {
      warn?.(message);
      const port = /^Порт (\d+)/.exec(message)?.[1] ?? 'unknown';
      await measure(`port-shared:${port}`, () => Promise.resolve());
    }
  }
  const scope = leaseScope.getStore();
  if (scope && !scope.environment)
    return leaseScope.run({ ...scope, environment: true }, () =>
      phaseEnvironment(lifecycle, cwd, dir, execution, signal, action, measure, trusted),
    );
  return phaseEnvironment(lifecycle, cwd, dir, execution, signal, action, measure, trusted);
}

/**
 * Снять переменные портов сервисов (`HX_*`) с окружения фазы и с файла
 * окружения попытки (`HARNESS_ATTEMPT_ENV_FILE`): порты прошлой фазы
 * принадлежат снятому стеку.
 */
async function clearServicePorts(env: NodeJS.ProcessEnv) {
  const file = env.HARNESS_ATTEMPT_ENV_FILE;
  if (!file) return;
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return;
  }
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    // Только порты, которые записал `env-up` (ревью 2): переменные политики
    // с тем же префиксом остаются.
    const keys = servicePortKeys(data);
    if (!keys.length && !(SERVICE_PORT_KEYS in data)) return;
    for (const k of keys) delete env[k];
    const kept = Object.fromEntries(
      Object.entries(data).filter(([k]) => !keys.includes(k) && k !== SERVICE_PORT_KEYS),
    );
    await writePrivate(file, JSON.stringify(kept, null, 2) + '\n');
  } catch {
    /* файл не JSON — его пишет не harness: не трогаем */
  }
}

/**
 * Перемаскировать `compose-readiness.json` попытки маской controller — по
 * разобранным строкам, а не по тексту JSON (экранирование не прячет секрет).
 */
async function remaskReadiness(execution: ReturnType<typeof executionEnvironment>) {
  const file = execution.env.HARNESS_ATTEMPT_ENV_FILE;
  if (!file) return;
  const path = join(dirname(file), COMPOSE_READINESS_FILE);
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) return;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = execution.redact(text);
  }
  await writeFile(path, JSON.stringify(redactDeep(data, execution.redact), null, 2)).catch(
    () => undefined,
  );
}

/** Порты сервисов этой фазы (после setup и ready) — в окружение её gates. */
async function refreshServicePorts(env: NodeJS.ProcessEnv) {
  const file = env.HARNESS_ATTEMPT_ENV_FILE;
  if (!file) return;
  const text = await readFile(file, 'utf8').catch(() => undefined);
  Object.assign(env, servicePortsFromFile(text));
}

/** Переменные, которые выбирают демон контейнеров (селекторы). */
export const CONTAINER_SELECTOR_KEYS = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'CONTAINER_HOST',
  'CONTAINER_CONNECTION',
] as const;
/**
 * Что запись окружения хранит для сверки очистки: селекторы и где искать CLI
 * и его конфигурацию по умолчанию (`PATH`, `HOME`: `~/.docker`, текущий
 * контекст). Повтор teardown по записи берёт только селекторы.
 */
export const CONTAINER_ENV_KEYS = [...CONTAINER_SELECTOR_KEYS, 'PATH', 'HOME'] as const;
/** Окружение демона фазы: каждый ключ явно, отсутствующий — `null`. */
export type ContainerEnv = Partial<Record<(typeof CONTAINER_ENV_KEYS)[number], string | null>>;
const containerEnv = (env: NodeJS.ProcessEnv): ContainerEnv =>
  Object.fromEntries(
    CONTAINER_ENV_KEYS.map((k) => [k, typeof env[k] === 'string' ? env[k] : null]),
  );
/**
 * Применить записанное окружение демона поверх окружения процесса: заданные
 * ключи — значением, `null` — снять (окружение фазы его не имело).
 */
export function replayContainerEnv(
  env: NodeJS.ProcessEnv,
  recorded: ContainerEnv,
  keys: readonly (typeof CONTAINER_ENV_KEYS)[number][] = CONTAINER_ENV_KEYS,
) {
  for (const k of keys) {
    if (!(k in recorded)) continue;
    const v = recorded[k];
    if (v === null || v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * Идентичность демона в записи окружения: по CLI — ID (`null` — не получен);
 * `{pending: true}` — запрос ещё не завершён (фаза прервалась раньше). Нет
 * поля — запись до alpha.67 или шаги без docker/podman.
 */
export type ContainerIdentityRecord = Record<string, string | null> | { pending: true };
const usesContainers = (lifecycle: Lifecycle) => {
  const use = containerUse(lifecycle);
  return 'clis' in use && use.clis.length > 0;
};
export const identityPending = (r: unknown) =>
  !!r && typeof r === 'object' && (r as { pending?: unknown }).pending === true;

/** Запись окружения фазы на диске: путь и изменяемый объект. */
interface ReceiptFile {
  path: string;
  data: Record<string, unknown>;
}
const saveReceipt = (r: ReceiptFile) => writePrivate(r.path, JSON.stringify(r.data, null, 2));

/**
 * Teardown: в дереве фазы или — у работы инфраструктуры (`trusted`) — в
 * отдельном чистом checkout доверенной базы (`trusted-tree.ts`) с тем же
 * окружением процесса (ID прогона, репозиторий, порты, каталог окружения);
 * свой компонент в `*_COMPONENTS_JSON` указывает на checkout. Путь checkout
 * записывается в запись окружения до его создания; свои оставшиеся checkout
 * (записанный `trustedCheckout`, неубранные `trustedLeftovers`,
 * зарегистрированные worktree) убираются; неубранный — путь в
 * `trustedLeftovers` и заметка `trustedLeftover`, итог teardown прежний.
 */
async function teardownIn(
  trusted: TrustedTree | undefined,
  lifecycle: Lifecycle,
  cwd: string,
  dir: string,
  execution: ReturnType<typeof executionEnvironment>,
  receipt?: ReceiptFile,
) {
  if (!trusted) return teardown(lifecycle, cwd, dir, execution);
  const data = receipt?.data;
  const leftovers = (): string[] =>
    Array.isArray(data?.trustedLeftovers)
      ? (data.trustedLeftovers as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
  const prior = [
    ...(typeof data?.trustedCheckout === 'string' ? [data.trustedCheckout] : []),
    ...leftovers(),
  ];
  const save = async (edit: (d: Record<string, unknown>) => void) => {
    if (!receipt) return;
    edit(receipt.data);
    await saveReceipt(receipt);
  };
  await withBaseCheckout(
    cwd,
    trusted.base,
    dir,
    (base) =>
      teardown(lifecycle, base, dir, {
        ...execution,
        env: baseCheckoutEnv(execution.env, cwd, base),
      }),
    {
      prior,
      record: (path) =>
        save((d) => {
          d.trustedCheckout = path;
        }),
      leftover: (path, note) =>
        save((d) => {
          d.trustedLeftovers = [...new Set([...leftovers(), path])];
          d.trustedLeftover = note;
        }),
      collected: (path) =>
        save((d) => {
          const rest = leftovers().filter((p) => p !== path);
          if (rest.length) d.trustedLeftovers = rest;
          else {
            delete d.trustedLeftovers;
            delete d.trustedLeftover;
          }
        }),
    },
  );
}

/**
 * Идентичность демона каждого CLI, который шаги вызывают сами
 * (`containerUse`), в окружении фазы: сверка очистки сравнит её с демоном,
 * которого спросит. Не известно, какие CLI, — поля нет; CLI нет или демон не
 * ответил — `null`.
 */
async function containerIdentities(
  lifecycle: Lifecycle,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  const use = containerUse(lifecycle);
  if (!('clis' in use) || !use.clis.length) return undefined;
  const out: Record<string, string | null> = {};
  for (const cli of use.clis) {
    const id = await containerIdentity(cli, env, undefined, signal);
    out[cli] = id && 'id' in id ? id.id : null;
  }
  return out;
}

async function phaseEnvironment<T>(
  lifecycle: Lifecycle | undefined,
  cwd: string,
  dir: string,
  execution: ReturnType<typeof executionEnvironment>,
  signal: AbortSignal,
  action: () => Promise<T>,
  measure: <R>(stage: string, action: () => Promise<R>) => Promise<R>,
  trusted?: TrustedTree,
): Promise<T> {
  if (!lifecycle) return action();
  // Порты сервисов `harness env-up` (alpha.70, ревью 1): прежние фазы
  // переменных не передают — до setup они снимаются с файла окружения
  // попытки и с окружения фазы, после setup и ready — читаются заново.
  await clearServicePorts(execution.env);
  await mkdir(dir, { recursive: true });
  // Каталог окружения фазы — вне worktree, рядом с receipt: шаги lifecycle
  // хранят в нём своё состояние (env-файлы, снимок ресурсов), а prepare и
  // gates той же фазы находят его по переменной. Попадает в receipt, поэтому
  // повторная очистка в новом процессе видит тот же каталог.
  execution.env.DEVCONTOUR_ENVIRONMENT_DIR = dir;
  execution.env.HARNESS_ENVIRONMENT_DIR = dir;
  const receiptPath = join(dir, 'environment.json');
  const receipt = {
    version: 1,
    ownerPid: process.pid,
    devcontourEnv: Object.fromEntries(
      Object.entries(execution.env).filter(([key]) => key.startsWith('DEVCONTOUR_')),
    ),
    // Переменные попытки облегчённого режима (alpha.69): имя проекта compose,
    // порты, шлюз — очистка в новом процессе повторяет их точно.
    ...((keys) =>
      keys
        ? {
            attemptEnv: Object.fromEntries(
              keys
                .split(',')
                .filter((k) => execution.env[k] !== undefined)
                .map((k) => [k, execution.env[k]!]),
            ),
          }
        : {})(execution.env.HARNESS_ATTEMPT_ENV_KEYS),
    cwd,
    lifecycle,
    policyDigest: digestOf(lifecycle),
    status: 'active',
    startedAt: new Date().toISOString(),
    runId: execution.env.DEVCONTOUR_RUN_ID,
    // Демон контейнеров фазы: сверка очистки спрашивает тот же демон.
    containerEnv: containerEnv(execution.env),
    ...(trusted ? { trusted } : {}),
    // Идентичность демона ещё не получена: запись, оставшаяся `pending`
    // (фаза прервалась до запроса), — демон не известен, а не прежняя запись.
    containerIdentity: usesContainers(lifecycle)
      ? ({ pending: true } as ContainerIdentityRecord)
      : undefined,
  };
  const receiptFile: ReceiptFile = { path: receiptPath, data: receipt };
  await writePrivate(receiptPath, JSON.stringify(receipt, null, 2));
  // Упавшие шаги фазы — в receipt (0.1.0-alpha.68): какой шаг, код или
  // сигнал, предел и хвост вывода с маской; teardown — отдельно.
  const failedSteps: StepOutcome[] = [];
  const observe = execution.onStep;
  execution.onStep = (s) => {
    if (!s.ok) failedSteps.push(s);
    observe?.(s);
  };
  let result: T | undefined, failure: Error | undefined;
  try {
    await measure('setup', async () => {
      // Демон шагов на момент фазы (для сверки очистки): в замере setup, с
      // сигналом фазы и коротким пределом.
      if (receipt.containerIdentity) {
        receipt.containerIdentity = (await containerIdentities(
          lifecycle,
          execution.env,
          signal,
        )) ?? { pending: true };
        await saveReceipt(receiptFile);
      }
      await runSteps(lifecycle.setup, cwd, join(dir, 'setup'), execution, signal).finally(() =>
        // Диагностика готовности `env-up` — ещё раз маской секретов политики.
        remaskReadiness(execution),
      );
    });
    await measure('ready', () =>
      runSteps(lifecycle.ready, cwd, join(dir, 'ready'), execution, signal).finally(() =>
        remaskReadiness(execution),
      ),
    );
    await refreshServicePorts(execution.env);
    result = await action();
  } catch (error) {
    // A thrown undefined/false must still fail the attempt after cleanup.
    failure =
      error instanceof Error
        ? error
        : new Error('Операция окружения завершилась ошибкой', { cause: error });
  }
  try {
    await measure('cleanup', () =>
      teardownIn(trusted, lifecycle, cwd, dir, execution, receiptFile),
    );
    receipt.status = 'cleaned';
  } catch (error) {
    receipt.status = 'cleanup-failed';
    failure = new CleanupFailure(
      `${failure instanceof Error ? failure.message + '; ' : ''}Очистка окружения не завершена: ${error instanceof Error ? error.message : String(error)}`,
      failure,
    );
  } finally {
    execution.onStep = observe;
  }
  const stepFailure = failedSteps.find((s) => s.stage !== 'teardown');
  const cleanupFailures = failedSteps.filter((s) => s.stage === 'teardown');
  if (stepFailure) receiptFile.data.failure = stepReceipt(stepFailure);
  if (cleanupFailures.length) receiptFile.data.cleanupFailure = cleanupFailures.map(stepReceipt);
  await writePrivate(receiptPath, JSON.stringify(receiptFile.data, null, 2));
  if (failure) throw failure;
  return result as T;
}
/**
 * Упавший шаг в receipt окружения: стадия, шаг, код выхода или сигнал,
 * предел (`timedOut`), отмена фазы, отказ запуска и хвост вывода с маской.
 */
export interface StepFailureReceipt {
  stage: string;
  step: string;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  tail?: string;
  log?: string;
}
const stepReceipt = (s: StepOutcome): StepFailureReceipt => ({
  stage: s.stage,
  step: s.id,
  ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
  ...(s.signal ? { signal: s.signal } : {}),
  timedOut: s.timedOut,
  aborted: s.aborted,
  ...(s.spawnError ? { spawnError: s.spawnError } : {}),
  ...(s.tail ? { tail: s.tail } : {}),
  ...(s.log ? { log: s.log } : {}),
});

async function teardown(
  lifecycle: Lifecycle,
  cwd: string,
  dir: string,
  execution: ReturnType<typeof executionEnvironment>,
) {
  const failures: string[] = [];
  for (const step of lifecycle.teardown) {
    try {
      await runSteps(
        [step],
        cwd,
        join(dir, 'teardown'),
        execution,
        AbortSignal.timeout(step.timeoutMs + 2000),
      );
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}
/**
 * Завершить очистку окружения, прерванную падением процесса: по сохранённому
 * receipt, только внутри разрешённых корней, только при той же политике
 * очистки и только когда процесс-владелец уже не существует (или это он сам,
 * `options.owner`, после окончания попытки).
 */
export async function cleanupEnvironment(
  receiptPath: string,
  policy: ExecutionPolicy,
  allowedRoots: string[],
  /** `owner` — процесс, который вправе повторить очистку своего окружения сам. */
  options: { owner?: number } = {},
) {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
    cwd: string;
    status: string;
    policyDigest: string;
    ownerPid?: number;
    runId?: string;
    devcontourEnv?: Record<string, string>;
    attemptEnv?: Record<string, string>;
    trusted?: TrustedTree;
    containerEnv?: ContainerEnv;
    containerIdentity?: ContainerIdentityRecord;
    trustedLeftovers?: unknown;
  };
  const cwd = await realpath(receipt.cwd);
  if (!allowedRoots.some((root) => cwd.startsWith(root + sep)))
    throw new Error('Окружение находится вне рабочих каталогов');
  const repositoryId = receipt.devcontourEnv?.DEVCONTOUR_REPOSITORY_ID;
  const repo = policy.repositories.find((r) => r.id === repositoryId);
  if (repositoryId && !repo) throw new Error('Неизвестный репозиторий сохранённого окружения');
  const lifecycle = [repo?.lifecycle, policy.lifecycle]
    .filter(Boolean)
    .find((l) => digestOf(l) === receipt.policyDigest);
  if (!lifecycle)
    throw new Error('Политика очистки изменилась; сверьте сохранённое окружение вручную');
  if (receipt.status === 'cleaned') {
    // Очистка завершена, но checkout базы тогда убрать не удалось: собрать
    // записанные (только их) и очистить список.
    if (receipt.trusted && Array.isArray(receipt.trustedLeftovers)) {
      const dir = join(receiptPath, '..');
      const left: string[] = [];
      for (const path of receipt.trustedLeftovers)
        if (
          typeof path === 'string' &&
          (await removeBaseCheckout(cwd, dir, path, { recorded: true }))
        )
          left.push(path);
      const next: Record<string, unknown> = { ...receipt };
      if (left.length) next.trustedLeftovers = left;
      else {
        delete next.trustedLeftovers;
        delete next.trustedLeftover;
      }
      await writePrivate(receiptPath, JSON.stringify(next, null, 2));
    }
    return { status: 'already-cleaned' as const };
  }
  if (receipt.ownerPid && receipt.ownerPid !== options.owner && processAlive(receipt.ownerPid))
    throw new Error('Процесс владельца окружения ещё существует; сначала остановите его');
  const execution = executionEnvironment(
    [policy.environment, repo?.environment],
    {
      ...receipt.devcontourEnv,
      ...(receipt.runId ? { DEVCONTOUR_RUN_ID: receipt.runId } : {}),
      ...receipt.attemptEnv,
    },
    process.env,
    policy.toolchain,
  );
  // Тот же демон контейнеров, что у фазы: селекторы окружающего процесса,
  // которых у фазы не было, снимаются; конфигурация docker — та же
  // (`DOCKER_CONFIG` фазы или `~/.docker` её HOME: текущий контекст лежит
  // там). PATH и HOME процесса — нынешние (toolchain).
  if (receipt.containerEnv) {
    replayContainerEnv(execution.env, receipt.containerEnv, CONTAINER_SELECTOR_KEYS);
    const home = receipt.containerEnv.HOME;
    if (!receipt.containerEnv.DOCKER_CONFIG && home)
      execution.env.DOCKER_CONFIG = join(home, '.docker');
  }
  // Демон, записанный фазой, — тот же и сейчас: иначе teardown (например
  // `compose down --volumes`) ушёл бы к чужому демону. Нет записи
  // идентичности (до alpha.67) — прежнее поведение.
  if (identityPending(receipt.containerIdentity))
    throw new Error(
      'Идентичность демона фазы не дописана (фаза прервалась до запроса) — демон не известен, teardown по записи не исполнен; проверьте ресурсы по метке вручную',
    );
  if (receipt.containerIdentity)
    for (const [cli, recorded] of Object.entries(receipt.containerIdentity)) {
      if (cli !== 'docker' && cli !== 'podman') continue;
      const now = await containerIdentity(cli, execution.env);
      const id = now && 'id' in now ? now.id : undefined;
      if (!recorded || id !== recorded)
        throw new Error(
          !recorded
            ? `Демон ${cli} фазы не был опознан — teardown по записи не исполнен; проверьте ресурсы по метке вручную`
            : id
              ? `Демон ${cli} сейчас другой, чем у фазы (${id} ≠ ${recorded}) — teardown по записи не исполнен`
              : `Демон ${cli} не ответил — teardown по записи не исполнен`,
        );
    }
  const dir = join(receiptPath, '..');
  const file: ReceiptFile = { path: receiptPath, data: receipt };
  await teardownIn(receipt.trusted, lifecycle, cwd, dir, execution, file);
  await writePrivate(receiptPath, JSON.stringify({ ...file.data, status: 'cleaned' }, null, 2));
  return { status: 'cleaned' as const };
}
