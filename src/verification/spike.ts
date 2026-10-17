import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { arch, cpus, platform } from 'node:os';
import { join } from 'node:path';
import {
  HarnessError,
  digestOf,
  spikeInputSchema,
  spikeSchema,
  type ExecutionPolicy,
  type ExecutionView,
  type Spike,
} from '../contracts/index.ts';
import type { Engine } from '../engine/engine.ts';
import { git } from '../environment/process.ts';
import { executionEnvironment } from '../environment/lifecycle.ts';
import { redactDeep } from '../environment/redaction.ts';
import { runCheck } from './gates.ts';

/** Что нужно эксперименту от controller. */
export interface SpikeContext {
  engine: Engine;
  policy: ExecutionPolicy;
  stateDir: string;
  repoPath(repo: ExecutionPolicy['repositories'][number]): string;
  /** Закрытое проверке и открытое внутри него. */
  boundary(): { hidden: string[]; readable: string[] };
  environment?: NodeJS.ProcessEnv;
}

/** Эксперимент репозитория по ID или undefined. */
export function spikeOf(view: ExecutionView, repositoryId: string, id: string) {
  return view.local('spikes', repositoryId, id);
}

/** Эксперименты репозитория. */
export function spikesOf(view: ExecutionView, repositoryId?: string) {
  return view.locals('spikes', repositoryId).map((x) => x.value);
}

/**
 * Ограниченный эксперимент выполнимости: команда на закреплённом SHA в
 * отдельном worktree, для каждого размера — под той же изоляцией, что gates,
 * с пределом времени. После таймаута большие размеры не запускаются: они
 * ничего не добавят к выводу. Результат с версиями среды и пределами вывода
 * сохраняется под digest; ссылка тяжёлого обязательства закрепляет этот digest.
 */
export async function runSpike(ctx: SpikeContext, raw: unknown): Promise<Spike> {
  const input = spikeInputSchema.parse(raw);
  const repo = input.repositoryId
    ? ctx.policy.repositories.find((r) => r.id === input.repositoryId)
    : ctx.policy.repositories[0];
  if (!repo) throw new HarnessError('NOT_FOUND', 'Репозиторий не объявлен: ' + input.repositoryId);
  // Окружение и его маска — до любой работы: недостающий секрет — отказ без
  // worktree и записи, а известные значения не попадают в сохраняемую запись.
  const environmentOf = (size: number) =>
    executionEnvironment(
      [ctx.policy.environment, repo.environment],
      { DEVCONTOUR_SPIKE_SIZE: String(size), DEVCONTOUR_SEED: String(input.seed) },
      ctx.environment ?? process.env,
    );
  let redact: (text: string) => string;
  try {
    redact = environmentOf(input.sizes[0]!).redact;
  } catch (error) {
    throw new HarnessError(
      'RUNTIME_UNAVAILABLE',
      'Окружение эксперимента: ' + (error instanceof Error ? error.message : String(error)),
    );
  }
  const path = ctx.repoPath(repo);
  const sha = input.sha ?? (await git(path, 'rev-parse', 'HEAD'));
  await git(path, 'cat-file', '-e', `${sha}^{commit}`).catch(() => {
    throw new HarnessError('NOT_FOUND', `Commit ${sha} недоступен в ${repo.id}`);
  });
  const id = 'SP-' + randomUUID();
  const root = join(ctx.stateDir, 'spikes');
  const dir = join(root, id);
  await mkdir(root, { recursive: true });
  await git(path, 'worktree', 'add', '--detach', dir, sha);
  const results: Spike['results'] = [];
  try {
    const boundary = ctx.boundary();
    for (const size of input.sizes) {
      const environment = environmentOf(size);
      const started = Date.now();
      const result = await runCheck(
        { config: ctx.policy },
        {
          argv: input.command,
          cwd: dir,
          env: environment.env,
          redact: environment.redact,
          timeoutMs: input.timeoutMs,
          signal: AbortSignal.timeout(input.timeoutMs + 60000),
          write: [dir],
          readable: boundary.readable,
          controller: boundary.hidden,
          settingsDir: join(root, `${id}-settings`),
        },
      );
      results.push({
        size,
        ms: Date.now() - started,
        outcome: result.timedOut ? 'timeout' : result.code === 0 ? 'ok' : 'error',
        exitCode: result.code,
      });
      if (result.timedOut) break;
    }
  } catch (error) {
    // Класс отказа сохраняется, известные значения из текста — нет.
    if (error instanceof Error) error.message = redact(error.message);
    throw error;
  } finally {
    await git(path, 'worktree', 'remove', '--force', dir).catch(() => undefined);
  }
  const outcome = results.some((r) => r.outcome === 'timeout')
    ? 'inconclusive'
    : results.some((r) => r.outcome === 'error')
      ? 'failed'
      : 'feasible';
  const timeout = results.find((r) => r.outcome === 'timeout');
  const limits =
    outcome === 'inconclusive'
      ? `Таймаут ${input.timeoutMs} мс на размере ${timeout!.size}: для этого способа и бюджета вывод не сделан. Это не доказательство невыполнимости или трудности и не основание менять требование.`
      : outcome === 'failed'
        ? 'Команда эксперимента завершилась ошибкой: вывод о выполнимости не сделан.'
        : `Успех на размерах ${input.sizes.join(', ')} с seed ${input.seed} в указанной среде. Не доказывает верхней границы на любом входе и других размерах.`;
  const record = {
    id,
    repositoryId: repo.id,
    sha,
    command: input.command,
    seed: input.seed,
    sizes: input.sizes,
    timeoutMs: input.timeoutMs,
    question: input.question,
    results,
    outcome,
    limits,
    environment: {
      platform: platform(),
      arch: arch(),
      node: process.version,
      cpus: cpus().length,
      isolation: ctx.policy.isolation.mode,
    },
    at: new Date().toISOString(),
  } satisfies Omit<Spike, 'digest'>;
  // Сохраняется и возвращается маскированная форма; digest — от неё.
  const safe = redactDeep(record, redact);
  const spike = spikeSchema.parse({ ...safe, digest: digestOf(safe) });
  ctx.engine.host.store.transact('checks.spike', (tx) => tx.putLocal('spikes', repo.id, id, spike));
  return spike;
}
