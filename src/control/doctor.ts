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
import type { ToolchainReport } from '../toolchains/inspect.ts';

/** Диагностика toolchain политики (см. `inspectPolicy` в `./toolchains`). */
export type ToolchainInspect = (
  policy: ExecutionPolicy,
  baseDir: string,
) => Promise<ToolchainReport[]>;

/** Runtime, которые политика действительно назначает writer или reviewer. */
function usedRuntimes(policy: ExecutionPolicy) {
  const used = new Set<string>();
  const rule = (r?: { reviewer: { runtime: string }; alternates?: { runtime: string }[] }) => {
    if (!r) return;
    used.add(r.reviewer.runtime);
    for (const a of r.alternates ?? []) used.add(a.runtime);
  };
  for (const k of ['code', 'plan', 'contract'] as const) rule(policy.review[k]);
  const roles = [
    ...Object.values(policy.roles),
    ...policy.repositories.flatMap((r) => Object.values(r.roles ?? {})),
  ];
  for (const b of roles) {
    used.add(b.writer.runtime);
    rule(b.review);
  }
  for (const r of policy.repositories) rule(r.review);
  return used;
}

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
  /**
   * Диагностика toolchain репозиториев (инструменты и версии, lockfiles,
   * scripts/tasks, cwd, отчёты) — только чтением и ограниченными пробами
   * версий. Передаётся явно (CLI — `inspectPolicy` из `./toolchains`): корень
   * пакета не тянет модуль toolchains сам.
   */
  toolchain?: { baseDir: string; inspect: ToolchainInspect },
) {
  const problems: string[] = [];
  const runtimes = [];
  // С политикой обязательны только назначенные ею runtime: сценарий одного
  // вендора или fixture не требует второго CLI.
  const required = policy ? usedRuntimes(policy) : new Set(['codex', 'claude']);
  for (const runtime of ['codex', 'claude'] as const) {
    const caps = required.has(runtime)
      ? await adapters[runtime]?.capabilities().catch(() => undefined)
      : undefined;
    if (!caps?.version && required.has(runtime))
      problems.push(`${runtime}: не найден или не отвечает на --version`);
    runtimes.push({
      runtime,
      available: Boolean(caps?.version),
      ...(caps?.version ? { version: caps.version } : {}),
      structuredOutput: caps?.structuredOutput ?? false,
      cancellation: caps?.cancellation ?? false,
      ...(required.has(runtime) ? {} : { reason: 'не назначен политикой' }),
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
  const toolchains =
    policy && toolchain ? await toolchain.inspect(policy, toolchain.baseDir) : undefined;
  for (const r of toolchains ?? [])
    for (const p of r.problems)
      problems.push(
        `toolchain ${r.repositoryId}: ${p.code} ${p.field.join('.')}${p.path ? ` (${p.path})` : ''}: ${p.message}`,
      );
  return {
    harness: HARNESS_VERSION,
    apiVersion: API_VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    runtimes,
    sandbox: { os: sandbox.ok, ...(sandbox.ok ? {} : { reason: sandbox.detail }) },
    ...(state ? { state } : {}),
    ...(toolchains ? { toolchains } : {}),
    problems,
  };
}
