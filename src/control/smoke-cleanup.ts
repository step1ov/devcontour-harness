// `harness cleanup LS-…` (alpha.67, P5-2): записи окружения `harness smoke`
// (и проходов его пробы), оставшиеся `cleanup-failed` или `active` при
// умершем владельце. Teardown повторяется по сохранённой записи, пока рабочее
// дерево есть; если дерева уже нет, а у демона фазы ресурсов с меткой прогона
// подтверждённо нет (или шаги контейнеров не запускают), запись сверяется в `cleaned` с
// событием `environment.reconciled`. Ничего не удаляется: ни дерево, ни
// ресурсы Docker — команда только проверяет и пишет запись.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { HarnessError, type ExecutionPolicy, type RunEventPayload } from '../contracts/index.ts';
import {
  cleanupEnvironment,
  replayContainerEnv,
  type ContainerEnv,
} from '../environment/lifecycle.ts';

/** ID записи smoke: `LS-<uuid>`. */
export const SMOKE_RUN_ID = /^LS-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Метка прогона на ресурсах Docker (мост compose примера и проектов по нему). */
export const DOCKER_RUN_LABEL = 'devcontour.harness.run';

/** Команды, которые сами контейнеров не запускают. */
const INERT = new Set([
  'true',
  'false',
  ':',
  'echo',
  'printf',
  'sleep',
  'test',
  'mkdir',
  'rm',
  'rmdir',
  'cp',
  'mv',
  'touch',
  'cat',
  'ls',
]);
/** Обёртки, которые могут сменить окружение или исполнить строку. */
const WRAPPERS = new Set(['env', 'sudo', 'doas', 'ssh', 'xargs', 'nohup', 'nice', 'timeout']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** Флаг или присваивание, которое выбирает демон в argv (а не окружением фазы). */
const ENDPOINT =
  /^(--context|--host|-H|--url|--connection|--remote|--identity)(=|$)|^(DOCKER_HOST|DOCKER_CONTEXT|CONTAINER_HOST|CONTAINER_CONNECTION)=/;

/**
 * Как lifecycle выбирает контейнеры (по argv шагов):
 * - `inert` — все шаги из команд, которые контейнеров не запускают;
 * - `unknown` — демон выбран не окружением фазы (`--context`, `--host`,
 *   присваивание `DOCKER_HOST=` в argv) или команда завёрнута (`env`, `sudo`,
 *   `ssh`, `sh -c`): какой демон спрашивать, не узнать;
 * - иначе `clis` — каких CLI спрашивать: названные шагами (`docker`,
 *   `podman`, compose), а если не названы (мост на node вызывает их сам) —
 *   оба. Демон — окружение фазы (`containerEnv` записи).
 */
export function lifecycleContainers(
  lifecycle: unknown,
):
  | { kind: 'inert' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'clis'; clis: ('docker' | 'podman')[]; explicit: boolean } {
  const l =
    lifecycle && typeof lifecycle === 'object' ? (lifecycle as Record<string, unknown>) : undefined;
  const commands: string[][] = [];
  for (const key of ['setup', 'ready', 'teardown']) {
    const steps = l?.[key];
    if (!Array.isArray(steps)) continue;
    for (const s of steps) {
      const cmd = (s as { command?: unknown } | null)?.command;
      if (Array.isArray(cmd)) commands.push(cmd.filter((c): c is string => typeof c === 'string'));
    }
  }
  const head = (c: string[]) => (c[0] ?? '').split(/[/\\]/).at(-1)!.toLowerCase();
  if (commands.every((c) => INERT.has(head(c)))) return { kind: 'inert' };
  for (const c of commands) {
    const h = head(c);
    if (WRAPPERS.has(h)) return { kind: 'unknown', reason: `шаг завёрнут в ${h}` };
    if (SHELLS.has(h) && c.slice(1).some((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a)))
      return { kind: 'unknown', reason: `шаг — строка оболочки ${h} -c` };
    const flag = c.find((a) => ENDPOINT.test(a));
    if (flag) return { kind: 'unknown', reason: `демон выбран в argv (${flag.split('=')[0]})` };
  }
  // CLI называет сама команда шага; мост (`node compose-bridge.mjs`) — нет:
  // какой CLI он вызовет, не узнать, спрашиваются оба.
  const heads = commands.map(head).map((h) => h.replace(/\.exe$/, ''));
  const podman = heads.some((h) => h === 'podman' || h === 'podman-compose');
  const docker = heads.some((h) => h === 'docker' || h === 'docker-compose');
  const opaque = heads.some(
    (h) => !INERT.has(h) && !['podman', 'podman-compose', 'docker', 'docker-compose'].includes(h),
  );
  if (!opaque && podman && !docker) return { kind: 'clis', clis: ['podman'], explicit: true };
  if (!opaque && docker && !podman) return { kind: 'clis', clis: ['docker'], explicit: true };
  return { kind: 'clis', clis: ['docker', 'podman'], explicit: !opaque };
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
  /** Демон контейнеров фазы (`CONTAINER_ENV_KEYS`, отсутствующие — `null`), alpha.67. */
  containerEnv?: ContainerEnv;
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
    // фазы (её записанное окружение, без окружения этого процесса). Демон или
    // CLI не известны — NOT_READY (закрыто по умолчанию).
    const runId = receipt.runId ?? receipt.devcontourEnv?.DEVCONTOUR_RUN_ID;
    const shape = lifecycleContainers(receipt.lifecycle);
    let docker: 'absent' | 'not-used' = 'not-used';
    if (shape.kind === 'unknown') {
      problems.push(
        `${rel}: не узнать, какой демон контейнеров использовал lifecycle: ${shape.reason}`,
      );
      continue;
    }
    if (shape.kind === 'clis') {
      if (!receipt.containerEnv) {
        problems.push(
          `${rel}: запись окружения без containerEnv (до alpha.67) — демон контейнеров фазы не известен, проверьте ресурсы по метке ${DOCKER_RUN_LABEL} вручную`,
        );
        continue;
      }
      if (!runId) {
        problems.push(`${rel}: в записи нет ID прогона — ресурсы по метке не проверить`);
        continue;
      }
      const env = phaseContainerEnv(receipt.containerEnv);
      const seen: string[] = [];
      let failed = false;
      for (const cli of shape.clis) {
        const bin =
          (cli === 'docker' ? process.env.HARNESS_DOCKER_BIN : process.env.HARNESS_PODMAN_BIN) ||
          cli;
        const left = (input.docker ?? dockerResources)(runId, { bin, env });
        if (left === 'missing') continue;
        seen.push(cli);
        if (!left) {
          problems.push(
            `${rel}: ${cli === 'podman' ? 'Podman' : 'Docker'} не ответил — не проверить ресурсы с меткой ${DOCKER_RUN_LABEL}=${runId}`,
          );
          failed = true;
          break;
        }
        const total = left.containers + left.volumes + left.networks;
        if (total) {
          problems.push(
            `${rel}: остались ресурсы ${cli === 'podman' ? 'Podman' : 'Docker'} с меткой ${DOCKER_RUN_LABEL}=${runId} (контейнеров ${left.containers}, томов ${left.volumes}, сетей ${left.networks}) — уберите их по метке`,
          );
          failed = true;
          break;
        }
      }
      if (failed) continue;
      if (!seen.length || (shape.explicit && seen.length < shape.clis.length)) {
        problems.push(
          `${rel}: ${shape.clis.join('/')} не найден в PATH фазы — ресурсы с меткой ${DOCKER_RUN_LABEL} не проверить`,
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
 * Окружение CLI контейнеров для сверки — только записанное окружение фазы
 * (`containerEnv`: демон, конфигурация, PATH, HOME); ключи, которых у фазы не
 * было (`null`), не задаются, окружение этого процесса не подмешивается.
 */
function phaseContainerEnv(recorded: ContainerEnv): NodeJS.ProcessEnv {
  return replayContainerEnv({}, recorded);
}
