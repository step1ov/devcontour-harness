import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { z } from 'zod';
import {
  digestOf,
  environmentSchema,
  lifecycleSchema,
  stepSchema,
  type ExecutionPolicy,
} from '../contracts/index.ts';
import { command } from './process.ts';
import { redactor } from './redaction.ts';
export { redactor } from './redaction.ts';

type Environment = z.infer<typeof environmentSchema>;
type Lifecycle = z.infer<typeof lifecycleSchema>;
type Step = z.infer<typeof stepSchema>;

/** Отказ обязательной очистки окружения: приёмка с ним не происходит. */
export class CleanupFailure extends Error {
  override name = 'CleanupFailure';
}

/** Жив ли процесс (сигнал 0 не доставляется, только проверяется). */
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
) {
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
  for (const profile of profiles) {
    if (!profile) continue;
    for (const key of profile.inherit) {
      if (source[key] === undefined) throw new Error(`Не задана переменная окружения: ${key}`);
      env[key] = source[key];
      // Inherited values are also redacted: callers need not classify every provider token.
      if (source[key]) secretValues.push(source[key]);
    }
    Object.assign(env, profile.values);
    for (const [key, from] of Object.entries(profile.secrets)) {
      if (!source[from]) throw new Error(`Не задан секрет окружения: ${from} (для ${key})`);
      env[key] = source[from];
      secretValues.push(source[from]);
    }
  }
  // Переменные контура: исторические DEVCONTOUR_* — часть договора проверок
  // пользователей — и их псевдонимы HARNESS_* с теми же значениями.
  for (const [key, value] of Object.entries(devcontour)) {
    env[key] = value;
    if (key.startsWith('DEVCONTOUR_')) env['HARNESS_' + key.slice('DEVCONTOUR_'.length)] = value;
  }
  return { env, redact: redactor(secretValues) };
}
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
export async function runSteps(
  steps: Step[],
  cwd: string,
  dir: string,
  execution: ReturnType<typeof executionEnvironment>,
  signal: AbortSignal,
) {
  await mkdir(dir, { recursive: true });
  for (const step of steps) {
    signal.throwIfAborted();
    const result = await command(step.command, cwd, {
      signal,
      timeoutMs: step.timeoutMs,
      env: execution.env,
      redact: execution.redact,
    });
    await writeFile(join(dir, step.id + '.log'), result.stdout + '\n' + result.stderr);
    if (result.code || result.timedOut || signal.aborted)
      throw new Error(`Шаг ${step.id}: exit=${result.code}; timeout=${result.timedOut}`);
  }
}

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
): Promise<T> {
  if (!lifecycle) return action();
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
    cwd,
    lifecycle,
    policyDigest: digestOf(lifecycle),
    status: 'active',
    startedAt: new Date().toISOString(),
    runId: execution.env.DEVCONTOUR_RUN_ID,
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  let result: T | undefined, failure: Error | undefined;
  try {
    await measure('setup', () =>
      runSteps(lifecycle.setup, cwd, join(dir, 'setup'), execution, signal),
    );
    await measure('ready', () =>
      runSteps(lifecycle.ready, cwd, join(dir, 'ready'), execution, signal),
    );
    result = await action();
  } catch (error) {
    // A thrown undefined/false must still fail the attempt after cleanup.
    failure =
      error instanceof Error
        ? error
        : new Error('Операция окружения завершилась ошибкой', { cause: error });
  }
  try {
    await measure('cleanup', () => teardown(lifecycle, cwd, dir, execution));
    receipt.status = 'cleaned';
  } catch (error) {
    receipt.status = 'cleanup-failed';
    failure = new CleanupFailure(
      `${failure instanceof Error ? failure.message + '; ' : ''}Очистка окружения не завершена: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  if (failure) throw failure;
  return result as T;
}
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
  if (receipt.status === 'cleaned') return { status: 'already-cleaned' as const };
  if (receipt.ownerPid && receipt.ownerPid !== options.owner && processAlive(receipt.ownerPid))
    throw new Error('Процесс владельца окружения ещё существует; сначала остановите его');
  const execution = executionEnvironment([policy.environment, repo?.environment], {
    ...receipt.devcontourEnv,
    ...(receipt.runId ? { DEVCONTOUR_RUN_ID: receipt.runId } : {}),
  });
  await teardown(lifecycle, cwd, join(receiptPath, '..'), execution);
  await writeFile(receiptPath, JSON.stringify({ ...receipt, status: 'cleaned' }, null, 2));
  return { status: 'cleaned' as const };
}
