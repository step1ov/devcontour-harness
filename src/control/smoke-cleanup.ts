// `harness cleanup LS-…` (alpha.67, P5-2): записи окружения `harness smoke`
// (и проходов его пробы), оставшиеся `cleanup-failed` или `active` при
// умершем владельце. Teardown повторяется по сохранённой записи, пока рабочее
// дерево есть; если дерева уже нет, а ресурсов Docker с меткой прогона нет
// (или lifecycle Docker не использует), запись сверяется в `cleaned` с
// событием `environment.reconciled`. Ничего не удаляется: ни дерево, ни
// ресурсы Docker — команда только проверяет и пишет запись.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { HarnessError, type ExecutionPolicy, type RunEventPayload } from '../contracts/index.ts';
import { cleanupEnvironment } from '../environment/lifecycle.ts';

/** ID записи smoke: `LS-<uuid>`. */
export const SMOKE_RUN_ID = /^LS-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Метка прогона на ресурсах Docker (мост compose примера и проектов по нему). */
export const DOCKER_RUN_LABEL = 'devcontour.harness.run';

/** Docker ли окружение: команда шага lifecycle — docker, compose или podman. */
export function lifecycleUsesDocker(lifecycle: unknown): boolean {
  const l =
    lifecycle && typeof lifecycle === 'object' ? (lifecycle as Record<string, unknown>) : undefined;
  if (!l) return false;
  for (const key of ['setup', 'ready', 'teardown']) {
    const steps = l[key];
    if (!Array.isArray(steps)) continue;
    for (const s of steps) {
      const cmd = (s as { command?: unknown } | null)?.command;
      if (
        Array.isArray(cmd) &&
        cmd.some(
          (c) =>
            typeof c === 'string' &&
            /(^|[/\\])(docker|docker-compose|podman)(\.exe)?$|(^|[/\\.-])compose([.-]|$)/i.test(c),
        )
      )
        return true;
    }
  }
  return false;
}

/**
 * Ресурсы Docker с меткой прогона: контейнеры, тома, сети. `undefined` —
 * проверить нельзя (нет CLI, демон не отвечает): сверять запись по ней нельзя.
 */
export function dockerResources(
  runId: string,
  docker = process.env.HARNESS_DOCKER_BIN || 'docker',
): { containers: number; volumes: number; networks: number } | undefined {
  const filter = `label=${DOCKER_RUN_LABEL}=${runId}`;
  const count = (args: string[]) => {
    const r = spawnSync(docker, [...args, '--filter', filter], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (r.error || r.status !== 0) return undefined;
    return r.stdout.split('\n').filter((l) => l.trim()).length;
  };
  const containers = count(['ps', '-a', '-q']);
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
  /** Подменённая проверка ресурсов Docker (тесты); по умолчанию — CLI docker. */
  docker?: (runId: string) => ReturnType<typeof dockerResources>;
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
    // ресурсов с меткой прогона подтверждённо нет.
    const runId = receipt.runId ?? receipt.devcontourEnv?.DEVCONTOUR_RUN_ID;
    const usesDocker = lifecycleUsesDocker(receipt.lifecycle);
    let docker: 'absent' | 'not-used' = 'not-used';
    if (usesDocker) {
      if (!runId) {
        problems.push(`${rel}: в записи нет ID прогона — ресурсы Docker по метке не проверить`);
        continue;
      }
      const left = (input.docker ?? dockerResources)(runId);
      if (!left) {
        problems.push(
          `${rel}: Docker не ответил — не проверить ресурсы с меткой ${DOCKER_RUN_LABEL}=${runId}`,
        );
        continue;
      }
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
