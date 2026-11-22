// `harness cleanup LS-…` (alpha.67, P5-2): записи окружения `harness smoke`
// (и проходов его пробы), оставшиеся `cleanup-failed` или `active` при
// умершем владельце. Teardown повторяется по сохранённой записи, пока рабочее
// дерево есть; если дерева уже нет, а ресурсов Docker с меткой прогона нет
// (или CLI контейнеров на машине нет и lifecycle его не называет), запись сверяется в `cleaned` с
// событием `environment.reconciled`. Ничего не удаляется: ни дерево, ни
// ресурсы Docker — команда только проверяет и пишет запись.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { HarnessError, type ExecutionPolicy, type RunEventPayload } from '../contracts/index.ts';
import {
  CONTAINER_ENV_KEYS,
  cleanupEnvironment,
  executionEnvironment,
} from '../environment/lifecycle.ts';

/** ID записи smoke: `LS-<uuid>`. */
export const SMOKE_RUN_ID = /^LS-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Метка прогона на ресурсах Docker (мост compose примера и проектов по нему). */
export const DOCKER_RUN_LABEL = 'devcontour.harness.run';

/**
 * Каким CLI контейнеров спрашивать о ресурсах прогона: `podman`, если шаги
 * lifecycle называют его, иначе `docker`. `explicit` — шаги прямо называют
 * docker, compose или podman; иначе использование неизвестно (мост на node
 * может вызывать Docker сам) — ресурсы всё равно проверяются по метке, если
 * CLI есть.
 */
export function lifecycleContainers(lifecycle: unknown): {
  cli: 'docker' | 'podman';
  explicit: boolean;
} {
  const l =
    lifecycle && typeof lifecycle === 'object' ? (lifecycle as Record<string, unknown>) : undefined;
  const words: string[] = [];
  for (const key of ['setup', 'ready', 'teardown']) {
    const steps = l?.[key];
    if (!Array.isArray(steps)) continue;
    for (const s of steps) {
      const cmd = (s as { command?: unknown } | null)?.command;
      if (Array.isArray(cmd)) for (const c of cmd) if (typeof c === 'string') words.push(c);
    }
  }
  const podman = words.some((c) => /(^|[/\\])podman(-compose)?(\.exe)?$/i.test(c));
  const explicit = words.some((c) =>
    /(^|[/\\])(docker|docker-compose|podman|podman-compose)(\.exe)?$|(^|[/\\.-])compose([.-]|$)/i.test(
      c,
    ),
  );
  return { cli: podman ? 'podman' : 'docker', explicit };
}

/** Итог проверки ресурсов: числа, `undefined` — демон не ответил, `missing` — CLI нет. */
export type ContainerResources =
  { containers: number; volumes: number; networks: number } | undefined | 'missing';

/**
 * Ресурсы с меткой прогона: контейнеры, тома, сети — тем CLI и тем демоном,
 * что у окружения (`env`: `DOCKER_HOST`, `DOCKER_CONTEXT`, `CONTAINER_HOST`…,
 * PATH). `undefined` — проверить нельзя (демон не отвечает); `missing` — CLI
 * нет в PATH окружения.
 */
export function dockerResources(
  runId: string,
  ctx: { bin: string; env: NodeJS.ProcessEnv },
): ContainerResources {
  const filter = `label=${DOCKER_RUN_LABEL}=${runId}`;
  let missing = false;
  const count = (args: string[]) => {
    const r = spawnSync(ctx.bin, [...args, '--filter', filter], {
      encoding: 'utf8',
      timeout: 30_000,
      env: ctx.env,
    });
    if (r.error && 'code' in r.error && r.error.code === 'ENOENT') missing = true;
    if (r.error || r.status !== 0) return undefined;
    return r.stdout.split('\n').filter((l) => l.trim()).length;
  };
  const containers = count(['ps', '-a', '-q']);
  if (missing) return 'missing';
  const volumes = count(['volume', 'ls', '-q']);
  const networks = count(['network', 'ls', '-q']);
  if (containers === undefined || volumes === undefined || networks === undefined) return undefined;
  return { containers, volumes, networks };
}

interface Receipt {
  status: string;
  cwd: string;
  ownerPid?: number;
  runId?: string;
  policyDigest?: string;
  lifecycle?: unknown;
  devcontourEnv?: Record<string, string>;
  /** Демон контейнеров фазы (`CONTAINER_ENV_KEYS`), alpha.67. */
  containerEnv?: Record<string, string>;
}

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Записи окружения прогона smoke и его проходов (`<id>`, `<id>-loopback-1`, `<id>-applied`). */
function smokeReceipts(stateDir: string, id: string): string[] {
  const root = join(stateDir, 'gates-at');
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => n === id || n.startsWith(id + '-'));
  } catch {
    return [];
  }
  return names
    .sort()
    .map((n) => join(root, n, 'artifacts', 'environment', 'environment.json'))
    .filter((p) => existsSync(p));
}

export interface SmokeCleanupInput {
  stateDir: string;
  policy: ExecutionPolicy;
  id: string;
  /** Разрешённые корни рабочих деревьев (каталог состояния, корень деревьев вне дерева). */
  roots: string[];
  /** Событие сверки в журнале состояния. */
  record(runId: string, payload: RunEventPayload<'environment.reconciled'>): void;
  /** Подменённая проверка ресурсов (тесты); по умолчанию — CLI docker/podman окружения. */
  docker?: (runId: string, ctx: { bin: string; env: NodeJS.ProcessEnv }) => ContainerResources;
}

/**
 * Довести или сверить очистку окружений одного smoke. Нет записи smoke —
 * `NOT_FOUND`; всё уже `cleaned` — `nothing-pending`. Живой владелец —
 * `NOT_READY`. Дерево есть — teardown по записи (как у попытки). Дерева нет,
 * а ресурсы Docker с меткой прогона остались или их не проверить —
 * `NOT_READY` с тем, что осталось: запись не меняется.
 */
export async function cleanupSmoke(input: SmokeCleanupInput) {
  const stateDir = resolve(input.stateDir);
  if (!existsSync(join(stateDir, 'gates-at', input.id)))
    throw new HarnessError('NOT_FOUND', 'Запись smoke не найдена: ' + input.id);
  const receipts = smokeReceipts(stateDir, input.id);
  const cleaned: string[] = [];
  const reconciled: {
    receipt: string;
    from: 'cleanup-failed' | 'active';
    worktree: 'absent';
    docker: 'absent' | 'not-used';
  }[] = [];
  const problems: string[] = [];
  for (const path of receipts) {
    const receipt = JSON.parse(await readFile(path, 'utf8')) as Receipt;
    if (receipt.status !== 'cleanup-failed' && receipt.status !== 'active') continue;
    const from: 'cleanup-failed' | 'active' =
      receipt.status === 'active' ? 'active' : 'cleanup-failed';
    const rel = relative(stateDir, path);
    if (receipt.ownerPid && receipt.ownerPid !== process.pid && processAlive(receipt.ownerPid)) {
      problems.push(
        `${rel}: процесс владельца ${receipt.ownerPid} ещё существует — сначала остановите его`,
      );
      continue;
    }
    if (typeof receipt.cwd !== 'string' || !receipt.cwd) {
      problems.push(
        `${rel}: в записи нет рабочего дерева — сверять нечего, проверьте запись вручную`,
      );
      continue;
    }
    if (existsSync(receipt.cwd)) {
      // Дерево на месте — обычный повтор teardown по записи.
      try {
        await cleanupEnvironment(path, input.policy, input.roots, { owner: process.pid });
        cleaned.push(path);
      } catch (error) {
        problems.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    // Дерева нет: teardown исполнить негде. Запись сверяется, только если
    // ресурсов с меткой прогона подтверждённо нет — у того же демона, что у
    // окружения. Использует ли lifecycle контейнеры, по командам не узнать
    // (мост на node вызывает Docker сам): метка проверяется всегда, когда
    // CLI есть.
    const runId = receipt.runId ?? receipt.devcontourEnv?.DEVCONTOUR_RUN_ID;
    const { cli, explicit } = lifecycleContainers(receipt.lifecycle);
    const env = containerEnvOf(input.policy, receipt);
    const bin = process.env.HARNESS_DOCKER_BIN || cli;
    let docker: 'absent' | 'not-used' = 'not-used';
    const left = runId ? (input.docker ?? dockerResources)(runId, { bin, env }) : undefined;
    if (left === 'missing') {
      if (explicit) {
        problems.push(
          `${rel}: ${cli} не найден — ресурсы с меткой ${DOCKER_RUN_LABEL} не проверить`,
        );
        continue;
      }
    } else if (!runId) {
      problems.push(`${rel}: в записи нет ID прогона — ресурсы ${cli} по метке не проверить`);
      continue;
    } else if (!left) {
      problems.push(
        `${rel}: ${cli === 'podman' ? 'Podman' : 'Docker'} не ответил — не проверить ресурсы с меткой ${DOCKER_RUN_LABEL}=${runId}`,
      );
      continue;
    } else {
      const total = left.containers + left.volumes + left.networks;
      if (total) {
        problems.push(
          `${rel}: остались ресурсы Docker с меткой ${DOCKER_RUN_LABEL}=${runId} (контейнеров ${left.containers}, томов ${left.volumes}, сетей ${left.networks}) — уберите их по метке`,
        );
        continue;
      }
      docker = 'absent';
    }
    await writeFile(
      path,
      JSON.stringify(
        {
          ...receipt,
          status: 'cleaned',
          reconciled: { at: new Date().toISOString(), from, worktree: 'absent', docker },
        },
        null,
        2,
      ),
    );
    const payload = { receipt: rel, from, worktree: 'absent' as const, docker };
    input.record(input.id, payload);
    reconciled.push(payload);
  }
  if (problems.length)
    throw new HarnessError(
      'NOT_READY',
      `Очистка smoke ${input.id} не завершена: ${problems.join('; ')}`,
    );
  if (!cleaned.length && !reconciled.length) return { status: 'nothing-pending' as const };
  return {
    status: 'cleaned' as const,
    receipts: cleaned,
    ...(reconciled.length ? { reconciled } : {}),
  };
}

/** Корни, внутри которых лежат рабочие деревья smoke (для повтора teardown). */
export async function smokeRoots(stateDir: string, outside?: string): Promise<string[]> {
  const roots = [await realpath(stateDir)];
  if (outside && existsSync(outside)) roots.push(await realpath(outside));
  return [...new Set(roots)];
}

/**
 * Окружение CLI контейнеров для сверки: окружение процесса, поверх —
 * окружение политики и репозитория записи (как у фаз), поверх — демон,
 * записанный фазой (`containerEnv`).
 */
function containerEnvOf(policy: ExecutionPolicy, receipt: Receipt): NodeJS.ProcessEnv {
  const repo = policy.repositories.find(
    (r) => r.id === receipt.devcontourEnv?.DEVCONTOUR_REPOSITORY_ID,
  );
  let phase: NodeJS.ProcessEnv = {};
  try {
    phase = executionEnvironment([policy.environment, repo?.environment], {}, process.env).env;
  } catch {
    phase = {};
  }
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [...CONTAINER_ENV_KEYS, 'PATH'] as const)
    if (phase[k] !== undefined) out[k] = phase[k];
  return { ...out, ...(receipt.containerEnv ?? {}) };
}
