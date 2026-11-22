import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  API_VERSION,
  codeReview,
  HarnessError,
  STATE_VERSION,
  inputPolicyOf,
  leadAnswersRule,
  reviewVendorConflictMessage,
  reviewVendorConflicts,
  runtimeAssignments,
  sameVendorReviews,
  type Author,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type RuntimeBinding,
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
import { BROWSER_ADVICE, isBrowserRunner } from './browser-checks.ts';
import { decisionSettingsView, recoveryPolicyOf } from '../projections/decisions.ts';
import { timeBudgetWarnings } from '../verification/time-budget.ts';
import { processListBackend } from '../verification/gates.ts';
import { processListLine, type ProcessListCapability } from '../verification/process-list.ts';
import { resolveNodePin, sameNode, toolchainFacts } from '../environment/toolchain-pin.ts';

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
 * не попадают в `problems`. Правило ревью кода роли с reviewer того же
 * вендора, что writer, без `vendor: same-vendor-allowed`
 * (`review-vendor-conflict: …`) — проблема: движок не выдаст поручение роли,
 * приёмка отклонит результат.
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
    /** Окружение для сверки закреплённого toolchain; по умолчанию `process.env`. */
    environment?: NodeJS.ProcessEnv;
    /**
     * Пробовать список процессов в песочнице проверок (`ps` под той же
     * изоляцией, что gates): `sandbox.processList` и строка в `notes`. CLI
     * передаёт `true`; функция — подменённая проба.
     */
    processList?: true | (() => Promise<ProcessListCapability>);
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
  // Список процессов в песочнице проверок: недоступен — не проблема среды
  // (gate может его не вызывать), а строка с советом до первой попытки.
  const processList = !options.processList
    ? undefined
    : policy?.isolation.mode === 'none'
      ? ({ status: 'not-isolated', detail: 'isolation.mode: none' } as ProcessListCapability)
      : sandbox.ok
        ? await (options.processList === true ? processListBackend.probe : options.processList)()
        : undefined;
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
  // Правило ревью кода роли, которое движок и приёмка не исполнят (reviewer
  // того же вендора без разрешения), — проблема: поручения роли не выдаются.
  if (policy)
    for (const conflict of reviewVendorConflicts(policy))
      problems.push('review-vendor-conflict: ' + reviewVendorConflictMessage(conflict));
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
  // Проверки в браузере среди шагов пробы исполнителя — ожидаемое состояние,
  // а не проблема: песочница исполнителя браузер не запускает.
  const notes: string[] = [
    ...(processList?.status === 'unavailable'
      ? ['sandbox-process-list: ' + processListLine(processList)]
      : []),
  ];
  for (const note of (policy?.repositories ?? []).flatMap((r) => {
    const browser = (r.writerProbe ?? []).filter(isBrowserRunner).map((s) => s.id);
    return browser.length
      ? [`browser-checks ${r.id} (${browser.join(', ')}): ${BROWSER_ADVICE}`]
      : [];
  }))
    notes.push(note);
  const models = policy ? policyModels(policy) : [];
  if (policy) warnings.push(...codexModelWarnings(models));
  // Закреплённый toolchain: каталог и версия, сверка с node первым в PATH
  // этого процесса. Без закрепления — совет в notes (не предупреждение).
  const pin = policy ? toolchainPinCheck(policy, options.environment ?? process.env) : undefined;
  if (pin?.problem) problems.push(pin.problem);
  if (pin?.warning) warnings.push(pin.warning);
  if (pin?.note) notes.push(pin.note);
  // Кто решает после отказов и на технические вопросы: те же тексты, что у
  // панели; необычное сочетание — предупреждение, шлюз не до исчерпания — заметка.
  const decisions = policy ? decisionSettingsView(policy) : undefined;
  if (decisions?.warning) warnings.push(decisions.warning.ru);
  if (policy) {
    const r = recoveryPolicyOf(policy);
    if (r.enabled && r.diagnoseAfter >= policy.maxAttempts)
      notes.push(
        `recovery.diagnoseAfter ${r.diagnoseAfter} ≥ maxAttempts ${policy.maxAttempts}: разбора ведущего до исчерпания попыток нет — только при исчерпании`,
      );
  }
  return {
    harness: HARNESS_VERSION,
    apiVersion: API_VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    runtimes,
    sandbox: {
      os: sandbox.ok,
      ...(sandbox.ok ? {} : { reason: sandbox.detail }),
      // Возможность списка процессов в песочнице проверок и её строка для человека.
      ...(processList
        ? { processList: { ...processList, line: processListLine(processList) } }
        : {}),
    },
    ...(state ? { state } : {}),
    ...(checkoutRoot ? { checkouts: checkoutRoot } : {}),
    ...(toolchains ? { toolchains } : {}),
    ...(pin?.report ? { toolchainPin: pin.report } : {}),
    ...(ports.length ? { ports } : {}),
    ...(leadSandbox ? { leadSandbox } : {}),
    problems,
    ...(notes.length ? { notes } : {}),
    ...(policy ? { questions: questionRule(policy) } : {}),
    ...(decisions ? { decisions } : {}),
    // Модель и effort каждого назначения: кто пишет и кто ревьюит, чем.
    ...(policy ? { models } : {}),
    // Предупреждения не делают среду негодной: порт только на wildcard, ревью
    // тем же вендором, пределы шагов фазы больше `runTimeoutMs`
    // (`timeBudgetWarnings`, худший случай) и советы о ресурсах машины
    // (`resourceWarnings`).
    ...(policy
      ? {
          // Одно предупреждение из двух источников печатается один раз.
          warnings: [
            ...new Set([
              ...warnings,
              ...timeBudgetWarnings(policy).map((w) => w.message),
              ...resourceWarnings(
                policy,
                toolchain?.baseDir ?? checkouts?.baseDir ?? process.cwd(),
              ),
            ]),
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

/** Назначение политики: кто (writer роли, reviewer вида ревью), каким runtime, моделью и effort. */
export interface PolicyModel {
  /** `writer <роль>`, `code-review <роль>`, `plan-review`, `contract-review`; репозиторий — в скобках. */
  use: string;
  runtime: RuntimeName;
  /** Нет — модель runtime по умолчанию. */
  model?: string;
  effort?: RuntimeBinding['effort'];
}

/**
 * Модель и effort по ролям политики: writer каждой роли (и переопределения
 * репозитория), reviewer кода роли, планов и контрактов, с запасными. Без
 * модели — runtime выберет свою по умолчанию.
 */
export function policyModels(policy: ExecutionPolicy): PolicyModel[] {
  const out: PolicyModel[] = [];
  const add = (use: string, b: RuntimeBinding) =>
    out.push({
      use,
      runtime: b.runtime,
      ...(b.model ? { model: b.model } : {}),
      ...(b.effort ? { effort: b.effort } : {}),
    });
  const rule = (use: string, r: { reviewer: RuntimeBinding; alternates?: RuntimeBinding[] }) => {
    add(use, r.reviewer);
    for (const [i, a] of (r.alternates ?? []).entries()) add(`${use} (запасной ${i + 1})`, a);
  };
  for (const [role, b] of Object.entries(policy.roles)) {
    add(`writer ${role}`, b.writer);
    rule(`code-review ${role}`, codeReview(policy, role));
  }
  for (const repo of policy.repositories) {
    for (const [role, b] of Object.entries(repo.roles ?? {})) {
      add(`writer ${role} (${repo.id})`, b.writer);
      rule(`code-review ${role} (${repo.id})`, codeReview(policy, role, repo.id));
    }
    // Ревью кода репозитория меняет reviewer и для ролей политики в нём.
    if (repo.review)
      for (const role of Object.keys(policy.roles))
        if (!repo.roles?.[role])
          rule(`code-review ${role} (${repo.id})`, codeReview(policy, role, repo.id));
  }
  rule('plan-review', policy.review.plan);
  rule('contract-review', policy.review.contract);
  return out;
}

/**
 * Модели Codex, которых нет в кэше моделей Codex (`$CODEX_HOME/models_cache.json`,
 * по умолчанию `~/.codex`): с учётной записью ChatGPT такая модель отклоняется
 * сразу («model is not supported…»). Нет файла или он не читается — проверки нет.
 * Предупреждение, не проблема: кэш мог устареть.
 */
export function codexModelWarnings(
  models: PolicyModel[],
  file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'),
) {
  const codex = models.filter((m) => m.runtime === 'codex' && m.model);
  if (!codex.length || !existsSync(file)) return [];
  let known: Map<string, string[] | undefined>;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      models?: { slug?: unknown; supported_reasoning_levels?: { effort?: unknown }[] }[];
    };
    if (!Array.isArray(raw.models)) return [];
    known = new Map(
      raw.models.flatMap((m) =>
        typeof m.slug === 'string'
          ? [
              [
                m.slug,
                Array.isArray(m.supported_reasoning_levels)
                  ? m.supported_reasoning_levels.flatMap((l) =>
                      typeof l.effort === 'string' ? [l.effort] : [],
                    )
                  : undefined,
              ] as const,
            ]
          : [],
      ),
    );
  } catch {
    return [];
  }
  const warnings: string[] = [];
  const unknown = new Map<string, string[]>();
  const efforts = new Map<string, string[]>();
  for (const m of codex) {
    const levels = known.get(m.model!);
    if (!known.has(m.model!)) unknown.set(m.model!, [...(unknown.get(m.model!) ?? []), m.use]);
    else if (m.effort && levels && !levels.includes(m.effort)) {
      const key = `${m.model} effort ${m.effort}`;
      efforts.set(key, [...(efforts.get(key) ?? []), m.use]);
    }
  }
  for (const [model, uses] of unknown)
    warnings.push(
      `codex-model-unknown: модели ${model} (${uses.join(', ')}) нет среди моделей Codex в ${file} (${[...known.keys()].join(', ')}); Codex с учётной записью ChatGPT отклонит её сразу («model is not supported») — проверьте имя модели в политике`,
    );
  for (const [what, uses] of efforts)
    warnings.push(
      `codex-effort-unknown: ${what} (${uses.join(', ')}) не входит в уровни этой модели по ${file}`,
    );
  return warnings;
}

/**
 * Сверка закреплённого toolchain (`policy.toolchain.node`) для `doctor`:
 * разрешённый каталог и версия; node первым в PATH процесса, если он другой
 * (путь или версия), — предупреждение: процессы прогона получат закреплённый,
 * а команды, запущенные вручную из этой оболочки, — другой. Не разрешилось —
 * проблема. Нет закрепления — совет.
 */
export function toolchainPinCheck(
  policy: Pick<ExecutionPolicy, 'toolchain'>,
  env: NodeJS.ProcessEnv,
): {
  report?: DoctorToolchainPin;
  problem?: string;
  warning?: string;
  note?: string;
} {
  const current = toolchainFacts(env.PATH).node;
  if (!policy.toolchain)
    return {
      note: `toolchain-pin: node не закреплён — gates, writer и reviewers получают node из PATH того, кто запустил harness${current ? ` (сейчас v${current.version}, ${current.path})` : ''}; закрепите policy.toolchain.node (версия или каталог), чтобы каждый этап исполнялся одним node`,
    };
  let resolved: ReturnType<typeof resolveNodePin>;
  try {
    resolved = resolveNodePin(policy.toolchain, env);
  } catch (error) {
    return {
      problem: 'toolchain-pin: ' + (error instanceof Error ? error.message : String(error)),
    };
  }
  const pinned = { version: resolved.version, path: join(resolved.binDir, 'node') };
  const matches = current ? sameNode(current, pinned) : false;
  const report: DoctorToolchainPin = {
    requested: resolved.requested,
    binDir: resolved.binDir,
    version: resolved.version,
    ...(current ? { pathNode: current } : {}),
    matches,
  };
  return {
    report,
    ...(matches
      ? {}
      : {
          warning: `toolchain-pin: node первым в PATH (${current ? `v${current.version}, ${current.path}` : 'не найден'}) отличается от закреплённого policy.toolchain.node=${resolved.requested} (v${resolved.version}, ${pinned.path}): harness ставит закреплённый первым в PATH gates, writer и reviewers; команды, запущенные вручную из этой оболочки, получат другой node`,
        }),
  };
}

/** Закреплённый toolchain в ответе `doctor`. */
export interface DoctorToolchainPin {
  requested: string;
  binDir: string;
  version: string;
  pathNode?: { version: string; path: string };
  matches: boolean;
}
