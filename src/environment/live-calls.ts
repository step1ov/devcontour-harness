import { randomUUID } from 'node:crypto';
import { osBootId, osTool, osToolEnv } from './os-tools.ts';
import { execFileSync } from 'node:child_process';
import { registerMonotonic, registerProcess, type CallOwner } from '../engine/usage.ts';
import { processAlive } from './lifecycle.ts';

/** Момент старта процесса по данным ОС, мс; `undefined` — узнать нельзя. */
export function processStartedAt(pid: number): number | undefined {
  try {
    const out = execFileSync(osTool('ps'), ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: osToolEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    const at = Date.parse(out);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Этот процесс: по нему восстановление и бюджет отличают свои идущие вызовы.
 * Момент старта отличает процесс от другого, получившего тот же pid.
 */
export const CURRENT_PROCESS: CallOwner = {
  id: randomUUID(),
  pid: process.pid,
  ...((at) => (at === undefined ? {} : { startedAt: at }))(processStartedAt(process.pid)),
};

/** Тот же ли это процесс: pid существует и момент старта совпадает. */
const sameProcess = (owner: CallOwner) => {
  if (owner.startedAt === undefined || !processAlive(owner.pid)) return false;
  // Оба момента — из одного источника (ОС) с одним округлением: у того же
  // процесса они равны, любое расхождение — другой процесс.
  return processStartedAt(owner.pid) === owner.startedAt;
};

/** Процесса нет или pid достался другому процессу; неизвестное — не «ушёл». */
const gone = (owner: CallOwner) => {
  if (!processAlive(owner.pid)) return true;
  if (owner.startedAt === undefined) return false;
  const started = processStartedAt(owner.pid);
  return started !== undefined && started !== owner.startedAt;
};

/** Идентификатор текущей загрузки ОС (`osBootId`). */
export const BOOT_ID = osBootId();

registerProcess(CURRENT_PROCESS, sameProcess, gone);
registerMonotonic(() => process.hrtime.bigint(), BOOT_ID);
