import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  API_VERSION,
  HarnessError,
  STATE_VERSION,
  inputPolicyOf,
  leadAnswersRule,
  runtimeAssignments,
  sameVendorReviews,
  type Author,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type RuntimeName,
} from '../contracts/index.ts';
import { credentialPaths, isolationSupport } from '../environment/isolation.ts';
import { chooseCheckoutRoot } from '../environment/checkout-root.ts';
import { inspectPort, PORT_ADVICE } from '../environment/port-probe.ts';
import { leadSandboxCheck, type LeadSandboxProbe } from '../environment/lead-sandbox.ts';
import { defaultResourceDatabase, ResourcePool, resourceKey } from '../environment/resources.ts';
import { HARNESS_VERSION } from '../package.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';
import type { ToolchainReport } from '../toolchains/inspect.ts';
import { resourceWarnings } from './resource-advice.ts';
import { timeBudgetWarnings } from '../verification/time-budget.ts';

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
 * версия последней писала состояние. С политикой — предупреждения
 * (`warnings`): порт ресурса только на wildcard, ревью тем же вендором
 * (`review-same-vendor: …`), сумма пределов шагов фазы больше `runTimeoutMs`
 * (`timeBudgetWarnings`), советы о ресурсах машины (`resourceWarnings`); они
 * не попадают в `problems`.
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
   * Необязательные параметры: `resourceDatabase` — база блокировок ресурсов
   * (по умолчанию общая база машины; читается, только если есть; `false` —
   * порты ресурсов не пробуются); `planAuthors` — авторы планов и контрактов
   * для предупреждения о ревью тем же вендором (ведущий из manifest проекта;
   * нет — writers ролей политики); `leadSandbox` — проверить, не работает ли
   * ведущий внутри песочницы (`leadSandboxCheck`; объект — подменённые пробы):
   * при признаках — строка в `problems` с объяснением и флагами Codex.
   */
  options: {
    resourceDatabase?: string | false;
    planAuthors?: readonly Author[];
    leadSandbox?: true | Partial<LeadSandboxProbe>;
  } = {},
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
  // Проба портов привязывает их и зовёт lsof; вызывающий без нужды в ней
  // (explain) передаёт `resourceDatabase: false`.
  const { resourceDatabase = defaultResourceDatabase(), planAuthors } = options;
  const ports =
    policy && resourceDatabase !== false ? await portStatus(policy, resourceDatabase) : [];
  const leadSandbox = options.leadSandbox
    ? leadSandboxCheck({
        repositories: (policy?.repositories ?? []).map((r) =>
          isAbsolute(r.path)
            ? r.path
            : resolve(toolchain?.baseDir ?? checkouts?.baseDir ?? process.cwd(), r.path),
        ),
        ...(stateDir ? { stateDir } : {}),
        ...(options.leadSandbox === true ? {} : { probe: options.leadSandbox }),
      })
    : undefined;
  if (leadSandbox?.inside) problems.push('lead-sandbox: ' + leadSandbox.advice);
  const warnings: string[] = [];
  for (const p of ports)
    if (p.status === 'busy')
      problems.push(
        `Порт ${p.port} (ресурс ${p.id}) занят вне аренды: ${p.holder}. Фаза попытки с этим ресурсом откажет environment/resource-busy. ${PORT_ADVICE}`,
      );
    else if (p.status === 'wildcard-only')
      warnings.push(
        `Порт ${p.port} (ресурс ${p.id}) на всех адресах держит ${p.holder}; loopback свободен — служба попытки должна слушать 127.0.0.1. ${PORT_ADVICE}`,
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
  if (same.length)
    warnings.push(
      `review-same-vendor: Ревью тем же вендором, что автор (vendor: same-vendor-allowed): ${[
        ...new Set(
          same.map((s) => `${s.role ? 'code ' + s.role : s.kind} ${s.author}→${s.reviewer}`),
        ),
      ].join(', ')}; независимость ниже, чем у ревью другим вендором`,
    );
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
    ...(ports.length ? { ports } : {}),
    ...(leadSandbox ? { leadSandbox } : {}),
    problems,
    ...(policy ? { questions: questionRule(policy) } : {}),
    // Предупреждения не делают среду негодной: порт только на wildcard, ревью
    // тем же вендором, пределы шагов фазы больше `runTimeoutMs`
    // (`timeBudgetWarnings`, худший случай) и советы о ресурсах машины
    // (`resourceWarnings`).
    ...(policy
      ? {
          warnings: [
            ...warnings,
            ...timeBudgetWarnings(policy).map((w) => w.message),
            ...resourceWarnings(policy, toolchain?.baseDir ?? checkouts?.baseDir ?? process.cwd()),
          ],
        }
      : {}),
  };
}

/**
 * Порты ресурсов политики: проба тем же способом, что перед фазой, без
 * остановки процессов. Порт под арендой (идёт попытка) не пробуется: его
 * законно держит её служба.
 */
async function portStatus(policy: ExecutionPolicy, database: string) {
  const declared = policy.resources.filter((r) => r.kind === 'port');
  if (!declared.length) return [];
  let leased = new Set<string>();
  const known = existsSync(database);
  if (known)
    try {
      const pool = new ResourcePool(database);
      try {
        leased = new Set(pool.list().map((l) => l.key));
      } finally {
        pool.close();
      }
    } catch {
      /* база не читается — аренды неизвестны, порт пробуется */
    }
  const out = [];
  for (const r of declared) {
    const port = Number(r.value);
    if (leased.has(resourceKey(r))) {
      out.push({ id: r.id, port, status: 'leased' as const });
      continue;
    }
    out.push({ id: r.id, port, ...(await inspectPort(port, known ? database : undefined)) });
  }
  return out;
}

/** Кто отвечает на вопросы исполнителя при политике — простыми словами. */
function questionRule(policy: ExecutionPolicy) {
  const input = inputPolicyOf(policy);
  const rule = leadAnswersRule(input);
  return {
    leadTechnical: input.leadAnswers?.technical === true,
    ...(input.leadAnswers?.maxSeverity !== undefined
      ? { maxSeverity: input.leadAnswers.maxSeverity }
      : {}),
    line: rule.ru,
    lineEn: rule.en,
  };
}
