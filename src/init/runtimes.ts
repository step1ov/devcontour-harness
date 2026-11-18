import { delimiter, isAbsolute } from 'node:path';
import {
  PROBE_TIMEOUT_MS,
  resolveExecutable,
  versionOf,
  type ToolProbe,
} from '../toolchains/probe.ts';

export type LeadRuntime = 'claude' | 'codex';

export const otherRuntime = (runtime: LeadRuntime): LeadRuntime =>
  runtime === 'claude' ? 'codex' : 'claude';

export interface RuntimeAvailability {
  runtime: LeadRuntime;
  status: 'available' | 'missing' | 'version-error';
  version?: string;
  /** `ok` — вход выполнен, `missing` — нет, `unknown` — проверка не ответила. */
  auth: 'ok' | 'missing' | 'unknown';
}

/**
 * Локальная проверка входа без вызова модели и без диалога: exit 0 — вход
 * выполнен, exit 1 — нет; иное (тайм-аут, неизвестная команда) — неизвестно.
 */
const authStatus: Record<LeadRuntime, string[]> = {
  claude: ['auth', 'status'],
  codex: ['login', 'status'],
};

/**
 * Наличие CLI `claude` и `codex` так, как их найдёт harness при запуске:
 * `HARNESS_<RUNTIME>_BIN`, иначе имя в абсолютных элементах PATH. Проба —
 * `--version`, затем проверка входа; оба процесса в нейтральном каталоге
 * (`ToolProbe`), модель не вызывается.
 */
export async function probeRuntimes(
  env: NodeJS.ProcessEnv,
  probe: ToolProbe,
): Promise<RuntimeAvailability[]> {
  const path = (env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .join(delimiter);
  const out: RuntimeAvailability[] = [];
  for (const runtime of ['claude', 'codex'] as const) {
    const executable = resolveExecutable(
      env[`HARNESS_${runtime.toUpperCase()}_BIN`] || runtime,
      path,
    );
    if (!executable) {
      out.push({ runtime, status: 'missing', auth: 'unknown' });
      continue;
    }
    const run = (args: string[]) =>
      probe([executable, ...args], { timeoutMs: PROBE_TIMEOUT_MS, env }).catch(() => undefined);
    const r = await run(['--version']);
    const version = r && r.code === 0 && !r.timedOut ? versionOf(r.stdout + r.stderr) : undefined;
    if (!version) {
      out.push({ runtime, status: 'version-error', auth: 'unknown' });
      continue;
    }
    const a = await run(authStatus[runtime]);
    const auth =
      !a || a.timedOut ? 'unknown' : a.code === 0 ? 'ok' : a.code === 1 ? 'missing' : 'unknown';
    out.push({ runtime, status: 'available', version, auth });
  }
  return out;
}

/** Runtime пригоден для назначения: CLI отвечает, вход не отсутствует явно. */
export const usable = (r: RuntimeAvailability | undefined) =>
  r?.status === 'available' && r.auth !== 'missing';

/**
 * Подсказка окружения о ведущем. Claude Code задаёт дочерним процессам
 * `CLAUDECODE=1`; Codex CLI — `CODEX_THREAD_ID` командам, которые исполняет
 * агент. Оба маркера сразу (одна сессия запущена из другой) — подсказки нет.
 */
export function leadHint(
  env: NodeJS.ProcessEnv,
): { runtime: LeadRuntime } | { ambiguous: true } | undefined {
  const claude = env.CLAUDECODE === '1';
  const codex = Boolean(env.CODEX_THREAD_ID);
  if (claude && codex) return { ambiguous: true };
  if (claude) return { runtime: 'claude' };
  if (codex) return { runtime: 'codex' };
  return undefined;
}
