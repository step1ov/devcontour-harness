import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  API_VERSION,
  HarnessError,
  STATE_VERSION,
  runtimeAssignments,
  sameVendorReviews,
  type Author,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type RuntimeName,
} from '../contracts/index.ts';
import { credentialPaths, isolationSupport } from '../environment/isolation.ts';
import { chooseCheckoutRoot } from '../environment/checkout-root.ts';
import { HARNESS_VERSION } from '../package.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';
import type { ToolchainReport } from '../toolchains/inspect.ts';

/** Диагностика toolchain политики (см. `inspectPolicy` в `./toolchains`). */
export type ToolchainInspect = (
  policy: ExecutionPolicy,
  baseDir: string,
) => Promise<ToolchainReport[]>;

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
  /**
   * Корень рабочих деревьев: выбор по каталогу состояния и репозиториям
   * политики (`chooseCheckoutRoot`) или заданный хостом. Нужны политика и
   * каталог состояния.
   */
  checkouts?: { baseDir: string; checkoutRoot?: string },
  /**
   * Авторы планов и контрактов для предупреждения о ревью тем же вендором:
   * ведущий из manifest проекта; нет — writers ролей политики.
   */
  planAuthors?: readonly Author[],
) {
  const problems: string[] = [];
  const runtimes = [];
  // С политикой обязательны только назначенные ею runtime: сценарий одного
  // вендора или fixture не требует второго CLI.
  const assigned = policy ? runtimeAssignments(policy) : undefined;
  const required = new Set<string>(assigned ? assigned.keys() : ['codex', 'claude']);
  for (const runtime of ['codex', 'claude'] as const) {
    const caps = required.has(runtime)
      ? await adapters[runtime]?.capabilities().catch(() => undefined)
      : undefined;
    const what = assigned?.get(runtime);
    if (!caps?.version && required.has(runtime))
      problems.push(
        `${runtime}: не найден или не отвечает на --version` +
          (what
            ? `; политика назначает его (${what.join(', ')}) — первая попытка или ревью остановится; установите ${runtime} и выполните вход либо подготовьте политику без него (init --review same)`
            : ''),
      );
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
  const checkoutRoot =
    policy && stateDir && checkouts
      ? chooseCheckoutRoot({
          stateDirs: [stateDir],
          repositories: policy.repositories.map((r) =>
            isAbsolute(r.path) ? r.path : resolve(checkouts.baseDir, r.path),
          ),
          hidden: credentialPaths(),
          create: false,
          ...(checkouts.checkoutRoot ? { configured: checkouts.checkoutRoot } : {}),
        })
      : undefined;
  const toolchains =
    policy && toolchain ? await toolchain.inspect(policy, toolchain.baseDir) : undefined;
  for (const r of toolchains ?? [])
    for (const p of r.problems)
      problems.push(
        `toolchain ${r.repositoryId}: ${p.code} ${p.field.join('.')}${p.path ? ` (${p.path})` : ''}: ${p.message}`,
      );
  // Ревью тем же вендором — не отказ, но явное предупреждение.
  const same = policy
    ? sameVendorReviews(
        policy,
        planAuthors?.length
          ? planAuthors
          : [
              ...new Set(
                [
                  ...Object.values(policy.roles),
                  ...policy.repositories.flatMap((r) => Object.values(r.roles ?? {})),
                ].map((b) => b.writer.runtime),
              ),
            ],
      )
    : [];
  const warnings = same.length
    ? [
        {
          code: 'review-same-vendor' as const,
          message: `Ревью тем же вендором, что автор (vendor: same-vendor-allowed): ${[
            ...new Set(
              same.map((s) => `${s.role ? 'code ' + s.role : s.kind} ${s.author}→${s.reviewer}`),
            ),
          ].join(', ')}; независимость ниже, чем у ревью другим вендором`,
        },
      ]
    : [];
  return {
    harness: HARNESS_VERSION,
    apiVersion: API_VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    runtimes,
    sandbox: { os: sandbox.ok, ...(sandbox.ok ? {} : { reason: sandbox.detail }) },
    ...(state ? { state } : {}),
    ...(checkoutRoot ? { checkouts: checkoutRoot } : {}),
    ...(toolchains ? { toolchains } : {}),
    problems,
    ...(warnings.length ? { warnings } : {}),
  };
}
