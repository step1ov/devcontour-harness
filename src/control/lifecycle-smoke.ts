import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { HarnessError, TaskFailure, type ExecutionPolicy } from '../contracts/index.ts';
import { CleanupFailure, type StepOutcome } from '../environment/lifecycle.ts';
import { runGatesAt } from '../verification/gates-at.ts';
import { commitOf, repositoryOf, repositoryPath } from './gates-check.ts';

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
 *   заданы, сеть реестра, защищённые пути, git).
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
  log?: string;
  /** Пояснение стадии: исход хранилища зависимостей (`hit`, `partial`, `miss: причина`). */
  detail?: string;
}

export interface LifecycleSmokeFailure {
  class: LifecycleFailureClass;
  stage?: string;
  step?: string;
  message: string;
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
}

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
}

const stepOf = (s: StepOutcome): LifecycleSmokeStep => ({
  stage: s.stage,
  id: s.id,
  status: s.ok ? 'passed' : 'failed',
  durationMs: s.durationMs,
  ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
  ...(s.timedOut ? { timedOut: true } : {}),
  ...(s.log ? { log: s.log } : {}),
  ...(s.detail ? { detail: s.detail } : {}),
});

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
  const where = failed ? { stage: failed.stage, step: failed.id } : {};
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
  // Шаг упал сам (не отменён пределом), а предел истёк позже — в уборке:
  // причина — шаг.
  if (context.timedOut && failed && !failed.ok && !failed.aborted && failed.stage !== 'teardown')
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
  try {
    const result = await runGatesAt(
      {
        policy,
        stateDir,
        repoPath,
        boundary: () => ({
          hidden: [...new Set([stateDir, ...repos])],
          readable: repos.map((r) => join(r, '.git')),
        }),
        ...(input.resourceDatabase ? { resourceDatabase: input.resourceDatabase } : {}),
        ...(input.checkoutRoot ? { checkoutRoot: input.checkoutRoot } : {}),
        ...(input.environment ? { environment: input.environment } : {}),
      },
      {
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
      },
    );
    warnings = result.warnings;
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
  return {
    id,
    repositoryId: repo.id,
    sha,
    passed: !failure,
    durationMs: Date.now() - started,
    steps,
    ...(failure ? { failure } : {}),
    logs: join(stateDir, 'gates-at', id),
    ...(warnings?.length ? { warnings } : {}),
  };
}

/** Таблица шагов для человека (`harness smoke --human`). */
export function smokeText(data: LifecycleSmokeResult) {
  const width = Math.max(5, ...data.steps.map((s) => `${s.stage}/${s.id}`.length));
  const lines = data.steps.map((s) =>
    `${`${s.stage}/${s.id}`.padEnd(width)}  ${s.status.padEnd(6)}  ${String(s.exitCode ?? '-').padEnd(4)}  ${seconds(s.durationMs)}${s.timedOut ? ' (timeout)' : ''}`.trimEnd(),
  );
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
      ...(data.warnings ?? []).map((w) => `предупреждение: ${w}`),
    ].join('\n') + '\n'
  );
}
