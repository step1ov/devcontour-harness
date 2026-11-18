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
 * Локальная проверка входа без вызова модели и без диалога. Вход отсутствует
 * только по явному ответу: `claude auth status` — JSON с `loggedIn: false`,
 * `codex login status` — «Not logged in». Иное (тайм-аут, другой формат,
 * ошибка конфигурации) — неизвестно, а не «не вошёл».
 */
const authStatus: Record<LeadRuntime, string[]> = {
  claude: ['auth', 'status'],
  codex: ['login', 'status'],
};
const authOf = (
  runtime: LeadRuntime,
  r: { code: number; stdout: string; stderr: string; timedOut: boolean } | undefined,
): RuntimeAvailability['auth'] => {
  if (!r || r.timedOut) return 'unknown';
  if (runtime === 'claude') {
    try {
      const parsed = JSON.parse(r.stdout) as { loggedIn?: unknown };
      return parsed.loggedIn === true ? 'ok' : parsed.loggedIn === false ? 'missing' : 'unknown';
    } catch {
      return 'unknown';
    }
  }
  const text = r.stdout + r.stderr;
  if (/not logged in/i.test(text)) return 'missing';
  return r.code === 0 && /logged in/i.test(text) ? 'ok' : 'unknown';
};

/**
 * Наличие CLI `claude` и `codex` так, как их найдёт harness при запуске:
 * `HARNESS_<RUNTIME>_BIN`, иначе имя в абсолютных элементах PATH. Проба —
 * `--version`, затем проверка входа; оба процесса в нейтральном каталоге
 * (`ToolProbe`), модель не вызывается. Runtime пробуются параллельно.
 */
export async function probeRuntimes(
  env: NodeJS.ProcessEnv,
  probe: ToolProbe,
): Promise<RuntimeAvailability[]> {
  const path = (env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .join(delimiter);
  const one = async (runtime: LeadRuntime): Promise<RuntimeAvailability> => {
    const executable = resolveExecutable(
      env[`HARNESS_${runtime.toUpperCase()}_BIN`] || runtime,
      path,
    );
    if (!executable) return { runtime, status: 'missing', auth: 'unknown' };
    const run = (args: string[]) =>
      probe([executable, ...args], { timeoutMs: PROBE_TIMEOUT_MS, env }).catch(() => undefined);
    const r = await run(['--version']);
    const version = r && r.code === 0 && !r.timedOut ? versionOf(r.stdout + r.stderr) : undefined;
    if (!version) return { runtime, status: 'version-error', auth: 'unknown' };
    return {
      runtime,
      status: 'available',
      version,
      auth: authOf(runtime, await run(authStatus[runtime])),
    };
  };
  return Promise.all((['claude', 'codex'] as const).map(one));
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
