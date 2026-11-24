import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  HarnessError,
  TaskFailure,
  type ExecutionPolicy,
  strictSandbox,
} from '../contracts/index.ts';
import { CleanupFailure, type StepOutcome } from '../environment/lifecycle.ts';
import { DEPENDENCY_NETWORK } from '../environment/dependency-network.ts';
import { runGatesAt } from '../verification/gates-at.ts';
import { commitOf, repositoryOf, repositoryPath } from './gates-check.ts';
import { SMOKE_RESULT_FILE } from './setup-progress.ts';
import {
  loopbackTrials,
  probeWriter,
  trialLoopback,
  writerProbeText,
  type WriterProbeInput,
  type WriterProbeResult,
} from './writer-probe.ts';
import { applyWriterLoopback, loopbackChanges } from './writer-loopback.ts';
import { writeFile } from 'node:fs/promises';
import { processListBackend, processListCallers } from '../verification/gates.ts';
import { processListLine, type ProcessListCapability } from '../verification/process-list.ts';

/**
 * Класс отказа окружения `harness smoke`:
 * - `port-busy` — порт ресурса занят до начала фазы;
 * - `timeout` — шаг превысил свой `timeoutMs`, проверка — `runTimeoutMs`, или
 *   проверка замолкла дольше порога обхода зависших;
 * - `crash` — шаг завершился ненулевым кодом;
 * - `missing-tool` — исполняемого файла шага нет или он не запускается
 *   (`ENOENT`, `EACCES`, код 126/127 оболочки);
 * - `cleanup` — упал только `teardown`: службы могли остаться запущенными;
 * - `tree-changed` — подготовка изменила отслеживаемые файлы проверяемого SHA;
 * - `environment` — прочий отказ среды (переменная или секрет окружения не
 *   заданы, сеть реестра — в том числе упавшая на ней установка
 *   зависимостей, защищённые пути, git).
 */
export type LifecycleFailureClass =
  'port-busy' | 'timeout' | 'crash' | 'missing-tool' | 'cleanup' | 'tree-changed' | 'environment';

export interface LifecycleSmokeStep {
  /** `dependencies`, `worktree`, `setup`, `ready`, `dependency-store`, `prepare`, `teardown`. */
  stage: string;
  id: string;
  status: 'passed' | 'failed';
  durationMs: number;
  exitCode?: number;
  timedOut?: boolean;
  /** Сигнал, которым завершился процесс упавшего шага (0.1.0-alpha.68). */
  signal?: string;
  /** Хвост вывода упавшего шага с маской секретов (0.1.0-alpha.68). */
  tail?: string;
  log?: string;
  /** Пояснение стадии: исход хранилища зависимостей (`hit`, `partial`, `miss: причина`). */
  detail?: string;
  /**
   * Шаг не отказал, но ничего не дал: хранилище зависимостей не использовано
   * (промах или отказ сборки seed, причина — в `detail`). Таблица `--human`
   * показывает такой шаг как `miss`, а не `passed` (alpha.61).
   */
  unused?: boolean;
}

export interface LifecycleSmokeFailure {
  class: LifecycleFailureClass;
  stage?: string;
  step?: string;
  message: string;
  /** Хвост вывода упавшего шага с маской секретов (0.1.0-alpha.68). */
  tail?: string;
  /** Что сделать человеку или агенту: без попыток и без правки кода задачи. */
  advice: string;
}

export interface LifecycleSmokeResult {
  id: string;
  repositoryId: string;
  sha: string;
  passed: boolean;
  durationMs: number;
  /** Шаги окружения в порядке исполнения, с длительностью. */
  steps: LifecycleSmokeStep[];
  failure?: LifecycleSmokeFailure;
  logs: string;
  warnings?: string[];
  /** Проба исполнителя (`--writer-probe`): команды `writerProbe` в его изоляции. */
  writerProbe?: WriterProbeResult;
  /**
   * Список процессов в песочнице ОС проверок (`isolation.mode: os`): проба
   * `ps` в той же изоляции, что gates, строка для человека и файлы дерева на
   * этом SHA, которые вызывают `ps`/`pgrep`/`top` (до 10). Недоступен и такие
   * файлы есть — предупреждение `sandbox-process-list`: gate, исполняющий их,
   * упадёт `GATE_SANDBOX_PROCESS_LIST`.
   */
  processList?: SmokeProcessList;
}

/** Список процессов в песочнице проверок в ответе `harness smoke`. */
export type SmokeProcessList = ProcessListCapability & { line: string; callers?: string[] };

export interface LifecycleSmokeInput {
  policy: ExecutionPolicy;
  baseDir: string;
  /** Каталог состояния: логи шагов (`gates-at/<id>`); база состояния не открывается. */
  stateDir: string;
  repositoryId?: string;
  /** SHA, ref или `HEAD` checkout репозитория. */
  rev: string;
  signal?: AbortSignal;
  resourceDatabase?: string;
  checkoutRoot?: string;
  environment?: NodeJS.ProcessEnv;
  /** Каждый шаг по мере исполнения (CLI печатает ход в stderr). */
  onStep?(step: LifecycleSmokeStep): void;
  /**
   * Явный запуск оператором (`harness smoke`): сборка seed, недавно упавшая
   * из-за сети реестра, повторяется сразу, а не по сроку пометки.
   */
  retryStoreNetworkFailure?: boolean;
  /**
   * После `prepare` прогнать команды `writerProbe` репозитория в точной
   * изоляции каждого его исполнителя (без модели): что закрыто и почему.
   */
  writerProbe?: boolean;
  /** Файл политики (`--policy`): для команды применения loopback и самого применения. */
  policyPath?: string;
  /**
   * Проба нашла шаги, которые открывает сеть loopback (`resolves`): записать
   * `network: "loopback"` в файл политики `policyPath`, приложить запись с
   * причиной и повторить пробу под новой политикой.
   */
  applyLoopback?: boolean;
  /**
   * sha256 байтов файла политики, из которых разобрана `policy` (CLI — при
   * загрузке `--policy`). Нужен для `applyLoopback`: запись — только в ту же
   * политику, которую проверила проба.
   */
  policySha?: string;
  /** Исполняемые файлы runtime для пробы (`HARNESS_<RUNTIME>_BIN`). */
  executables?: Partial<Record<'codex' | 'claude', string>>;
  /**
   * Проба списка процессов в песочнице проверок: по умолчанию — общая
   * (`processListBackend`) при `isolation.mode: os`; `false` — не пробовать;
   * функция — подменённая проба.
   */
  processList?: false | (() => Promise<ProcessListCapability>);
}

export { processListCallers } from '../verification/gates.ts';
export { SMOKE_RESULT_FILE };

async function smokeProcessList(
  input: LifecycleSmokeInput,
  repoPath: string,
  sha: string,
): Promise<SmokeProcessList | undefined> {
  if (input.processList === false || !strictSandbox(input.policy)) return undefined;
  const capability = await (input.processList ?? processListBackend.probe)();
  const callers =
    capability.status === 'unavailable' ? await processListCallers(repoPath, sha) : [];
  return {
    ...capability,
    line: processListLine(capability),
    ...(callers.length ? { callers } : {}),
  };
}

const stepOf = (s: StepOutcome): LifecycleSmokeStep => ({
  stage: s.stage,
  id: s.id,
  status: s.ok ? 'passed' : 'failed',
  durationMs: s.durationMs,
  ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
  ...(s.timedOut ? { timedOut: true } : {}),
  ...(s.signal ? { signal: s.signal } : {}),
  ...(s.tail ? { tail: s.tail } : {}),
  ...(s.log ? { log: s.log } : {}),
  ...(s.detail ? { detail: s.detail } : {}),
  ...(s.unused ? { unused: true } : {}),
});

/** Статус шага для человека: неиспользованная стадия — `miss`, а не `passed`. */
export const stepStatusText = (s: Pick<LifecycleSmokeStep, 'status' | 'unused'>) =>
  s.unused && s.status === 'passed' ? 'miss' : s.status;

/** Пояснение шага для человека: промах хранилища — «не используется: причина». */
export const stepDetailText = (s: Pick<LifecycleSmokeStep, 'detail' | 'unused'>) =>
  s.detail && s.unused ? 'не используется: ' + s.detail.replace(/^miss(?::\s*)?/, '') : s.detail;

const seconds = (ms: number) => `${Math.round(ms / 1000)} с`;

/**
 * Класс отказа и совет по ошибке проверки и первому упавшему шагу.
 * Экспортируется для тестов; порядок проверок — от самого конкретного
 * признака к общему.
 */
export function classifyLifecycleFailure(
  error: unknown,
  failed: StepOutcome | undefined,
  context: { policy: ExecutionPolicy; timedOut: boolean },
): LifecycleSmokeFailure {
  const message = error instanceof Error ? error.message : String(error);
  const where = failed
    ? {
        stage: failed.stage,
        step: failed.id,
        ...(!failed.ok && failed.tail ? { tail: failed.tail } : {}),
      }
    : {};
  const log = failed?.log ? ` Лог шага: ${failed.log}.` : '';
  // Исходный отказ классифицируется сам по себе: упавший после него teardown
  // его причиной не становится.
  if (error instanceof CleanupFailure && error.original)
    return {
      ...classifyLifecycleFailure(
        error.original,
        failed?.stage === 'teardown' ? undefined : failed,
        context,
      ),
      message,
    };
  if (error instanceof TaskFailure && error.diagnosis === 'resource-busy') {
    const port = /Порт (\d+)/.exec(message)?.[1];
    return {
      class: 'port-busy',
      message,
      advice:
        `Порт${port ? ' ' + port : ''} занят до начала окружения: найдите держателя` +
        (port ? ` (\`lsof -nP -iTCP:${port} -sTCP:LISTEN\`)` : '') +
        ' и остановите его (часто — старый dev-сервер или служба прошлой попытки), затем повторите smoke. Код задачи не меняйте.',
    };
  }
  // Шаг упал сам (не отменён пределом), а предел истёк или проверка замолкла
  // позже — в уборке: причина — шаг.
  if (
    (context.timedOut || (error instanceof TaskFailure && error.kind === 'stalled')) &&
    failed &&
    !failed.ok &&
    !failed.aborted &&
    failed.stage !== 'teardown'
  )
    return classifyLifecycleFailure(new Error(message), failed, { ...context, timedOut: false });
  if (context.timedOut)
    return {
      class: 'timeout',
      ...where,
      message,
      advice: `Окружение не уложилось в runTimeoutMs (${seconds(context.policy.runTimeoutMs)}): замерьте шаги (steps[].durationMs) и поднимите runTimeoutMs или вынесите долгую подготовку из lifecycle/prepare (docs/slow-environments.md).`,
    };
  if (error instanceof TaskFailure && error.kind === 'stalled')
    return {
      class: 'timeout',
      ...where,
      message,
      advice:
        'Шаг замолк дольше порога обхода зависших (stallSweep): проверьте, не ждёт ли он ввода, сети или службы; поднимите stallSweep.stalledMs, если шаг законно долго молчит.',
    };
  if (failed && !failed.ok) {
    const code = failed.exitCode;
    if (failed.stage === 'teardown')
      return {
        class: 'cleanup',
        ...where,
        message,
        advice: `teardown упал: службы окружения могли остаться запущенными — проверьте процессы и порты до следующего запуска.${log}`,
      };
    if (
      failed.spawnError === 'ENOENT' ||
      failed.spawnError === 'EACCES' ||
      code === 126 ||
      code === 127
    )
      return {
        class: 'missing-tool',
        ...where,
        message,
        advice: `Команда шага ${failed.id} не найдена или не запускается (${failed.spawnError ?? 'exit ' + code}): установите инструмент или укажите абсолютный путь; PATH окружения — PATH процесса harness.${log}`,
      };
    if (failed.timedOut)
      return {
        class: 'timeout',
        ...where,
        message,
        advice: `Шаг ${failed.id} превысил свой timeoutMs (${seconds(failed.durationMs)}): поднимите timeoutMs шага, если он законно долгий, или проверьте, не ждёт ли он ввода, сети или службы.${log}`,
      };
    // Установка упала на сети или реестре (обрыв, предел времени, 403 прокси):
    // отказ среды, а не настройка проекта; в `run` такой отказ попытку не
    // тратит (dependency-network).
    if (failed.registryFailure)
      return {
        class: 'environment',
        ...where,
        message: `${DEPENDENCY_NETWORK}: ${failed.registryFailure}. ${message}`,
        advice: `Установка зависимостей не получила пакеты из реестра — отказ сети или реестра, а не проекта: повторите smoke; частые обрывы снимает хранилище зависимостей (dependencyStore, docs/slow-environments.md): prepare берёт пакеты из него, а не из сети.${log}`,
      };
    if (code !== undefined && code !== 0)
      return {
        class: 'crash',
        ...where,
        message,
        advice: `Шаг ${failed.id} (${failed.stage}) завершился с кодом ${code}: причина — в логе шага; это настройка окружения проекта (lifecycle, prepare, seed), а не код задачи.${log}`,
      };
  }
  if (error instanceof CleanupFailure)
    return {
      class: 'cleanup',
      ...where,
      message,
      advice:
        'teardown упал: службы окружения могли остаться запущенными — проверьте процессы и порты до следующего запуска.' +
        log,
    };
  if (message === 'Проверка изменила проверяемый код')
    return {
      class: 'tree-changed',
      message,
      advice:
        'Шаги окружения изменили отслеживаемые файлы проверяемого коммита: пишите артефакты подготовки в неотслеживаемые или игнорируемые пути (или в DEVCONTOUR_ENVIRONMENT_DIR).',
    };
  return {
    class: 'environment',
    ...where,
    message,
    advice:
      'Отказ среды до или между шагами: проверьте переменные и секреты окружения политики, сеть реестра и git; подробности — в сообщении.' +
      log,
  };
}

/**
 * Только окружение репозитория на коммите (`harness smoke`): снимки
 * зависимостей, рабочее дерево, lifecycle `setup`/`ready`, хранилище
 * зависимостей, `prepare` и `teardown` — тем же исполнением, что фаза
 * integration (`runGatesAt` с `lifecycleOnly`), без gates и без вызовов
 * моделей. Попытка не создаётся, база состояния не открывается.
 *
 * Отказ окружения — данные (`passed: false`, `failure` с классом и советом);
 * прерывание вызывающим — отказ `CANCELLED`.
 */
export async function smokeLifecycle(input: LifecycleSmokeInput): Promise<LifecycleSmokeResult> {
  const { policy } = input;
  if (input.applyLoopback && (!input.writerProbe || !input.policyPath || !input.policySha))
    throw new HarnessError(
      'INVALID_INPUT',
      'applyLoopback записывает сеть loopback в файл политики по итогам пробы: нужны writerProbe, policyPath и policySha (sha256 разобранных байтов политики)',
    );
  const repo = repositoryOf(policy, input.repositoryId);
  const repoPath = repositoryPath(input.baseDir);
  const sha = await commitOf(repoPath(repo), input.rev, repo.id);
  const stateDir = resolve(input.stateDir);
  const repos = policy.repositories.map(repoPath);
  const id = 'LS-' + randomUUID();
  const outcomes: StepOutcome[] = [];
  const steps: LifecycleSmokeStep[] = [];
  const started = Date.now();
  let warnings: string[] | undefined;
  let failure: LifecycleSmokeFailure | undefined;
  let probe: WriterProbeResult | undefined;
  const gatesContext = (p: ExecutionPolicy) => ({
    policy: p,
    stateDir,
    repoPath,
    boundary: () => ({
      hidden: [...new Set([stateDir, ...repos])],
      readable: repos.map((r) => join(r, '.git')),
    }),
    ...(input.resourceDatabase ? { resourceDatabase: input.resourceDatabase } : {}),
    ...(input.checkoutRoot ? { checkoutRoot: input.checkoutRoot } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.retryStoreNetworkFailure ? { retryStoreNetworkFailure: true } : {}),
  });
  const probeDir = join(stateDir, 'gates-at', id, 'writer-probe');
  type TreeContext = Parameters<NonNullable<Parameters<typeof runGatesAt>[1]['afterPrepare']>>[0];
  const probeInput = (p: ExecutionPolicy, ctx: TreeContext, sub = ''): WriterProbeInput => ({
    policy: p,
    repo: p.repositories.find((r) => r.id === repo.id) ?? repo,
    cwd: ctx.cwd,
    boundary: ctx.boundary,
    dir: join(probeDir, sub),
    runId: id,
    signal: ctx.signal,
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.executables ? { executables: input.executables } : {}),
  });
  /**
   * Свежее подготовленное дерево для прохода пробы — так же, как у первого
   * прохода (снимки, дерево, хранилище, prepare), но без строк в таблице
   * шагов: повтор под loopback и проба под записанной политикой не идут на
   * остатках прежнего прохода (кеш сборщика повторяет его отказ). Проходы
   * идут друг за другом: ресурсы gates держит один проход.
   */
  // Шаги последнего свежего прохода: упавший — причина его отказа.
  let freshOutcomes: StepOutcome[] = [];
  const inFreshTree = (
    p: ExecutionPolicy,
    suffix: string,
    run: (ctx: TreeContext) => Promise<void>,
  ) => {
    freshOutcomes = [];
    return runGatesAt(gatesContext(p), {
      id: `${id}-${suffix}`,
      repositoryId: repo.id,
      sha,
      gates: [],
      lifecycleOnly: true,
      record: () => {
        throw new Error('smoke: gates не исполняются');
      },
      onStep: (s) => freshOutcomes.push(s),
      afterPrepare: run,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  };
  const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let firstInput: WriterProbeInput | undefined;
  try {
    const result = await runGatesAt(gatesContext(policy), {
      id,
      repositoryId: repo.id,
      sha,
      gates: [],
      lifecycleOnly: true,
      record: () => {
        throw new Error('smoke: gates не исполняются');
      },
      onStep: (s) => {
        outcomes.push(s);
        const step = stepOf(s);
        steps.push(step);
        input.onStep?.(step);
      },
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.writerProbe
        ? {
            afterPrepare: async (ctx: TreeContext) => {
              firstInput = probeInput(policy, ctx);
              probe = await probeWriter(firstInput);
            },
          }
        : {}),
    });
    warnings = result.warnings;
    const first = probe;
    if (first && firstInput) {
      // Повтор под loopback — в свежем дереве и свежем TMPDIR, по одному на
      // исполнителя: дерево первого прохода хранит кеш его отказа.
      // Итог повтора предварительный, пока проход не завершился целиком
      // (teardown, проверка дерева): иначе отказ уборки держал бы ресурсы при
      // PASS, а правка отслеживаемого файла давала бы `resolves`.
      let k = 0;
      for (const writer of loopbackTrials(first)) {
        const suffix = `loopback-${++k}`;
        let commit: (() => void) | undefined;
        try {
          await inFreshTree(policy, suffix, async (ctx) => {
            commit = await trialLoopback(probeInput(policy, ctx), first, writer);
          });
        } catch (error) {
          if (input.signal?.aborted) throw error;
          commit = await trialLoopback(firstInput, first, writer, failureText(error));
        }
        commit?.();
      }
      if (loopbackChanges(first).length) {
        if (!input.applyLoopback || !input.policyPath || !input.policySha)
          // Одна команда: применить и повторить пробу — решение ведущего.
          first.loopbackCommand = `harness smoke --state ${stateDir} --policy ${input.policyPath ?? '<файл политики>'} --repository ${repo.id} --sha ${input.rev} --writer-probe --apply-loopback`;
        else {
          const applied = applyWriterLoopback({
            policyPath: input.policyPath,
            probedSha: input.policySha,
            repositoryId: repo.id,
            probe: first,
          });
          await writeFile(
            join(probeDir, 'loopback-receipt.json'),
            JSON.stringify(applied.receipt, null, 2) + '\n',
          );
          // Повтор пробы под записанной политикой — в свежем дереве: исход —
          // по ней, и только когда проход завершился целиком.
          let again: WriterProbeResult | undefined;
          try {
            await inFreshTree(applied.policy, 'applied', async (ctx) => {
              again = await probeWriter(probeInput(applied.policy, ctx, 'applied'));
            });
            if (!again) throw new Error('проба в свежем дереве не исполнена');
            probe = { ...again, loopbackApplied: applied.receipt };
          } catch (error) {
            if (input.signal?.aborted) throw error;
            // Политика уже записана (запись — в loopbackApplied), но её
            // проверка не завершилась: проба не зелёная, smoke — FAIL.
            const message = `Повтор пробы под записанной политикой не завершился: ${failureText(error)}`;
            probe = {
              ...first,
              ok: false,
              notes: [...(first.notes ?? []), message + '.'],
              loopbackApplied: applied.receipt,
            };
            const timedOut = error instanceof HarnessError && error.code === 'CANCELLED';
            failure = {
              ...classifyLifecycleFailure(
                error,
                freshOutcomes.find((o) => !o.ok),
                { policy: applied.policy, timedOut },
              ),
              message,
            };
          }
        }
      }
    }
  } catch (error) {
    // Отмена вызывающим — не отказ окружения.
    if (input.signal?.aborted)
      throw new HarnessError(
        'CANCELLED',
        'Проверка окружения прервана: ' +
          ((input.signal.reason as Error | undefined)?.message ?? 'сигнал'),
      );
    // Иначе CANCELLED изнутри — предел runTimeoutMs проверки.
    const timedOut = error instanceof HarnessError && error.code === 'CANCELLED';
    if (error instanceof HarnessError && !timedOut && error.code !== 'GIT_FAILED') throw error;
    failure = classifyLifecycleFailure(
      error,
      // Первый упавший шаг — причина; teardown после него — уборка.
      outcomes.find((o) => !o.ok),
      { policy, timedOut },
    );
  }
  // Список процессов в песочнице проверок: о нём smoke говорит до попыток,
  // а не gate после работы исполнителя.
  const processList = await smokeProcessList(input, repoPath(repo), sha);
  if (processList?.callers?.length)
    warnings = [
      ...(warnings ?? []),
      `sandbox-process-list: ${processList.callers.join(', ')} вызывают ps/pgrep/top; ${processList.line}`,
    ];
  const durationMs = Date.now() - started;
  // Итог рядом с логами (alpha.67): ход настройки в представлении читает
  // исход и длительность smoke и пробы. Неудачная запись итога не отменяет
  // проверку.
  await writeFile(
    join(stateDir, 'gates-at', id, SMOKE_RESULT_FILE),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        data: {
          id,
          repositoryId: repo.id,
          sha,
          passed: !failure,
          durationMs,
          ...(failure ? { failure: { class: failure.class } } : {}),
          ...(probe ? { writerProbe: { ok: probe.ok } } : {}),
        },
      },
      null,
      2,
    ),
  ).catch(() => undefined);
  return {
    id,
    repositoryId: repo.id,
    sha,
    passed: !failure,
    durationMs,
    steps,
    ...(failure ? { failure } : {}),
    logs: join(stateDir, 'gates-at', id),
    ...(warnings?.length ? { warnings } : {}),
    ...(probe ? { writerProbe: probe } : {}),
    ...(processList ? { processList } : {}),
  };
}

/** Таблица шагов для человека (`harness smoke --human`). */
export function smokeText(data: LifecycleSmokeResult) {
  const width = Math.max(5, ...data.steps.map((s) => `${s.stage}/${s.id}`.length));
  const lines = data.steps.map((s) => {
    const detail = stepDetailText(s);
    const row =
      `${`${s.stage}/${s.id}`.padEnd(width)}  ${stepStatusText(s).padEnd(6)}  ${String(s.exitCode ?? '-').padEnd(4)}  ${seconds(s.durationMs)}${s.timedOut ? ' (timeout)' : ''}${s.signal ? ` (${s.signal})` : ''}${detail ? '  ' + detail : ''}`.trimEnd();
    // Хвост вывода упавшего шага (с маской): причина видна без лога.
    return s.status === 'failed' && s.tail
      ? [row, ...s.tail.split('\n').map((l) => `${' '.repeat(width + 2)}| ${l}`)].join('\n')
      : row;
  });
  return (
    [
      `${data.repositoryId} @ ${data.sha.slice(0, 12)} — окружение ${data.passed ? 'PASS' : 'FAIL'} (${seconds(data.durationMs)})`,
      `${'шаг'.padEnd(width)}  ${'status'.padEnd(6)}  exit  время`,
      ...(lines.length ? lines : ['(шагов окружения нет)']),
      ...(data.failure
        ? [
            `отказ: ${data.failure.class}${data.failure.step ? ` (${data.failure.stage}/${data.failure.step})` : ''} — ${data.failure.message}`,
            `что сделать: ${data.failure.advice}`,
          ]
        : []),
      `логи: ${data.logs}`,
      ...(data.processList && !data.processList.callers?.length
        ? [`возможность: ${data.processList.line}`]
        : []),
      ...(data.warnings ?? []).map((w) => `предупреждение: ${w}`),
    ].join('\n') +
    '\n' +
    (data.writerProbe ? writerProbeText(data.writerProbe) : '')
  );
}
