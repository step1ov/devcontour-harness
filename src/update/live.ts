import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionPolicy } from '../contracts/index.ts';
import { WorkflowQueue } from '../control/workflow.ts';
import { HARNESS_VERSION } from '../package.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';

/**
 * Что сейчас идёт в каталоге состояния (обновление ждёт или отказывает):
 * живая роль controller (`harness run`), попытки с действующим владением,
 * совместные проверки, задания графа с действующей арендой. Одно чтение
 * только для чтения; базы нет — ничего не идёт.
 */
export function liveWork(
  stateDir: string,
  policy: ExecutionPolicy,
  now = Date.now(),
  /** Роль controller самого обновления — не «идущая работа». */
  ignoreOwner?: string,
): string[] {
  const file = join(stateDir, 'state.sqlite');
  if (!existsSync(file)) return [];
  return SqliteExecutionStore.readOnce(file, 'devcontour-harness@' + HARNESS_VERSION, (store) => {
    const out: string[] = [];
    store.read((v) => {
      const lease = v.controller();
      if (
        lease &&
        lease.leaseUntil > now &&
        lease.owner !== ignoreOwner &&
        !deadUpdater(lease.owner)
      )
        out.push(`идёт harness run (${lease.owner})`);
      for (const a of (v.activeAttempts ? v.activeAttempts() : v.attempts()).filter(
        (a) => a.status === 'active',
      )) {
        const until = v.attemptLease?.(a.id)?.leaseUntil ?? a.leaseUntil;
        if (until > now) out.push(`идёт попытка ${a.id} поручения ${a.workId}`);
      }
      for (const j of v.verifications())
        if (j.status === 'active' && j.leaseUntil > now)
          out.push(`идёт совместная проверка ${j.id}`);
    });
    for (const j of new WorkflowQueue(store, policy, () => now).list())
      if (j.status === 'running' && (j.leaseUntil ?? 0) > now)
        out.push(`идёт задание ${j.kind} ${j.id}`);
    return out;
  });
}

/**
 * Роль controller обновления (`harness-update:<pid>`) умершего процесса:
 * не идущая работа — её сразу забирает следующее обновление.
 */
export function deadUpdater(owner: string): boolean {
  const m = /^harness-update:(\d+)$/.exec(owner);
  if (!m) return false;
  try {
    process.kill(Number(m[1]), 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'EPERM';
  }
}
