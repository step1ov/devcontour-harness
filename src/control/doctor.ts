import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_VERSION,
  HarnessError,
  STATE_VERSION,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type RuntimeName,
} from '../contracts/index.ts';
import { isolationSupport } from '../environment/isolation.ts';
import { HARNESS_VERSION } from '../package.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';

/**
 * Проверка среды без live-вызова модели: версия пакета и Node, наличие
 * runtime (по `--version`) и их возможности, OS-sandbox, совместимость
 * каталога состояния. Каталог состояния открывается только если он есть;
 * для совместимого состояния называются версии движка, встреченные в нём
 * (роль controller и попытки), — перед обновлением и откатом видно, какая
 * версия последней писала состояние.
 */
export async function doctor(
  policy: ExecutionPolicy | undefined,
  adapters: Partial<Record<RuntimeName, RuntimeAdapter>>,
  stateDir?: string,
) {
  const problems: string[] = [];
  const runtimes = [];
  for (const runtime of ['codex', 'claude'] as const) {
    const caps = await adapters[runtime]?.capabilities().catch(() => undefined);
    if (!caps?.version) problems.push(`${runtime}: не найден или не отвечает на --version`);
    runtimes.push({
      runtime,
      available: Boolean(caps?.version),
      ...(caps?.version ? { version: caps.version } : {}),
      structuredOutput: caps?.structuredOutput ?? false,
      cancellation: caps?.cancellation ?? false,
    });
  }
  const sandbox = isolationSupport();
  if (!sandbox.ok && policy?.isolation.mode === 'os') problems.push(sandbox.detail);
  let state:
    | {
        stateVersion: number;
        compatible: boolean;
        engineVersions?: { controller?: string; attempts: string[] };
      }
    | undefined;
  if (stateDir && existsSync(join(stateDir, 'state.sqlite'))) {
    try {
      const store = new SqliteExecutionStore(
        join(stateDir, 'state.sqlite'),
        'devcontour-harness@' + HARNESS_VERSION,
        // Диагностика не становится писателем: автор, PRAGMA и данные прежние.
        { readOnly: true },
      );
      let engineVersions;
      try {
        engineVersions = store.read((view) => {
          const controller = view.controller()?.engineVersion;
          return {
            ...(controller ? { controller } : {}),
            attempts: [
              ...new Set(
                view.attempts().flatMap((a) => (a.engineVersion ? [a.engineVersion] : [])),
              ),
            ].sort(),
          };
        });
      } finally {
        store.close();
      }
      state = { stateVersion: STATE_VERSION, compatible: true, engineVersions };
    } catch (error) {
      state = { stateVersion: -1, compatible: false };
      problems.push(error instanceof HarnessError ? error.message : String(error));
    }
  }
  return {
    harness: HARNESS_VERSION,
    apiVersion: API_VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    runtimes,
    sandbox: { os: sandbox.ok, ...(sandbox.ok ? {} : { reason: sandbox.detail }) },
    ...(state ? { state } : {}),
    problems,
  };
}
