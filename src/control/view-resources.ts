// Загрузчик «Что задействовано» (`resources` представления оператора) для
// node: политика, манифест проекта рядом с ней, записи окружений lifecycle
// (`environment.json`) и каталог хранилища зависимостей в каталоге
// состояния. Только чтение: процессы не запускаются, сеть не трогается,
// каталог состояния не создаётся и не пишется. Единственная проверка вне
// файлов — жив ли процесс-владелец окружения (`kill(pid, 0)`, как у
// `cleanupEnvironment`). Ничего не бросает: нечитаемое просто отсутствует.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  WORKSPACE_OWNER,
  profileNetwork,
  projectManifestSchema,
  vendorOf,
  type ExecutionPolicy,
  type ReviewRule,
  type RuntimeBinding,
} from '../contracts/index.ts';
import { processAlive } from '../environment/lifecycle.ts';
import type { ResourcesInput } from '../projections/view-resources.ts';

/** Пределы обхода каталога состояния: представление не читает весь диск. */
const SCAN = {
  /** Каталогов попыток/прогонов на корень (новые по имени не упорядочены — берутся по порядку имён). */
  runs: 2000,
  /** Записей окружений всего. */
  receipts: 1000,
  /** Глубина поиска `environment.json` внутри артефактов попытки. */
  depth: 5,
  /** Наибольший читаемый файл записи. */
  bytes: 256 * 1024,
  /** Служб в одном compose. */
  services: 10,
} as const;

export interface ResourcesLoadOptions {
  /** Закончена ли попытка (по записям хранилища); нет — не известно. */
  attemptFinished?: (runId: string) => boolean | undefined;
  /** Проверка процесса-владельца; тест подменяет. */
  processAlive?: (pid: number) => boolean;
  /** Удержанные gates (`Engine.environmentGateHolds`). */
  heldGates?: ResourcesInput['heldGates'];
}

const readJson = (path: string): unknown => {
  try {
    if (statSync(path).size > SCAN.bytes) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};
const dirs = (path: string): string[] => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
};
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

type Steps = { id?: unknown; command?: unknown }[] | undefined;
const stepIds = (steps: Steps) =>
  (Array.isArray(steps) ? steps : []).flatMap((s) => (str(obj(s)?.id) ? [str(obj(s)?.id)!] : []));
/** Docker ли окружение: команда шага setup/teardown — docker или compose. */
const usesDocker = (lifecycle: unknown) => {
  const l = obj(lifecycle);
  if (!l) return false;
  for (const key of ['setup', 'ready', 'teardown']) {
    const steps = l[key];
    if (!Array.isArray(steps)) continue;
    for (const s of steps) {
      const cmd = obj(s)?.command;
      if (
        Array.isArray(cmd) &&
        cmd.some(
          (c) =>
            typeof c === 'string' &&
            /(^|[/\\])(docker|docker-compose|podman)(\.exe)?$|(^|[/\\.-])compose([.-]|$)/i.test(c),
        )
      )
        return true;
    }
  }
  return false;
};

/** Записи окружений состояния: попытки, `gates-at` и совместные проверки. */
function receiptPaths(stateDir: string): {
  paths: { path: string; run: string; workspace: boolean }[];
  skipped: number;
} {
  const out: { path: string; run: string; workspace: boolean }[] = [];
  let skipped = 0;
  const push = (path: string, run: string, workspace: boolean) => {
    if (out.length < SCAN.receipts) out.push({ path, run, workspace });
    else skipped++;
  };
  const walk = (dir: string, run: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.isFile() && e.name === 'environment.json') push(join(dir, e.name), run, false);
      else if (e.isDirectory() && depth > 0) walk(join(dir, e.name), run, depth - 1);
    }
  };
  const artifacts = join(stateDir, 'artifacts');
  const runs = dirs(artifacts);
  skipped += Math.max(0, runs.length - SCAN.runs);
  for (const run of runs.slice(0, SCAN.runs)) walk(join(artifacts, run), run, SCAN.depth);
  const gatesAt = dirs(join(stateDir, 'gates-at'));
  skipped += Math.max(0, gatesAt.length - SCAN.runs);
  for (const run of gatesAt.slice(0, SCAN.runs))
    walk(join(stateDir, 'gates-at', run, 'artifacts', 'environment'), run, 0);
  const joint = dirs(join(stateDir, 'joint'));
  skipped += Math.max(0, joint.length - SCAN.runs);
  for (const run of joint.slice(0, SCAN.runs)) {
    const path = join(stateDir, 'joint', run, 'environment', 'environment.json');
    try {
      if (statSync(path).isFile()) push(path, run, true);
    } catch {
      /* нет записи */
    }
  }
  return { paths: out, skipped };
}

/** Службы compose из записи моста (`bridge/compose.json`, пример turbo-starter). */
function composeServices(envDir: string): { name: string; image?: string }[] {
  const services = obj(obj(readJson(join(envDir, 'bridge', 'compose.json')))?.services);
  if (!services) return [];
  return Object.entries(services)
    .slice(0, SCAN.services)
    .map(([name, s]) => {
      const image = str(obj(s)?.image);
      return { name, ...(image ? { image } : {}) };
    });
}

function environments(
  stateDir: string,
  options: ResourcesLoadOptions,
): { list: ResourcesInput['environments']; skipped: number } {
  const alive = options.processAlive ?? processAlive;
  const { paths, skipped } = receiptPaths(stateDir);
  const list: ResourcesInput['environments'] = [];
  for (const { path, run, workspace } of paths) {
    const r = obj(readJson(path));
    if (!r) continue;
    const status = str(r.status) ?? 'active';
    const pid =
      typeof r.ownerPid === 'number' && Number.isInteger(r.ownerPid) && r.ownerPid > 0
        ? r.ownerPid
        : undefined;
    // Процесс проверяется только у незакрытой записи: закрытой он не нужен.
    let ownerAlive: boolean | undefined;
    if (status === 'active' && pid !== undefined) {
      try {
        ownerAlive = alive(pid);
      } catch {
        ownerAlive = undefined;
      }
    }
    const runId = str(r.runId) ?? run;
    let attemptFinished: boolean | undefined;
    if (status === 'active' && options.attemptFinished) {
      try {
        attemptFinished = options.attemptFinished(runId);
      } catch {
        attemptFinished = undefined;
      }
    }
    const lifecycle = obj(r.lifecycle);
    const services = composeServices(join(path, '..'));
    const repositoryId = workspace
      ? WORKSPACE_OWNER
      : (str(obj(r.devcontourEnv)?.DEVCONTOUR_REPOSITORY_ID) ?? WORKSPACE_OWNER);
    const startedAt = str(r.startedAt);
    list.push({
      repositoryId,
      scope: workspace ? 'workspace' : 'attempt',
      status,
      ...(ownerAlive !== undefined ? { ownerAlive } : {}),
      ...(attemptFinished !== undefined ? { attemptFinished } : {}),
      runId,
      ...(startedAt ? { startedAt } : {}),
      setup: stepIds(lifecycle?.setup as Steps),
      docker: services.length > 0 || usesDocker(lifecycle),
      services,
    });
  }
  return { list, skipped };
}

/** Число готовых seeds хранилища репозитория; нет каталога — не известно. */
function seedCount(stateDir: string, repositoryId: string): number | undefined {
  try {
    return readdirSync(join(stateDir, 'dependency-store', repositoryId, 'seeds'), {
      withFileTypes: true,
    }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).length;
  } catch {
    return undefined;
  }
}

/**
 * Ведущий из манифеста проекта рядом с политикой. Манифест не по схеме
 * (другой ревизии) ещё называет ведущего, если поле `lead` — известный
 * runtime; нет манифеста или поля — нет.
 */
function manifestLead(baseDir: string): 'claude' | 'codex' | undefined {
  const raw = readJson(join(baseDir, 'project.json'));
  const parsed = projectManifestSchema.safeParse(raw);
  if (parsed.success) return parsed.data.lead;
  const r = obj(raw);
  return r?.kind === 'harness-project' && (r.lead === 'claude' || r.lead === 'codex')
    ? r.lead
    : undefined;
}

/**
 * Вход проекции «Что задействовано». `stateDir` — каталог состояния проекта
 * (`artifacts/`, `gates-at/`, `joint/`, `dependency-store/`); `baseDir` —
 * каталог политики (там `project.json`). Ничего не пишет и не бросает.
 */
export function resourcesInputOf(
  policy: ExecutionPolicy,
  stateDir: string,
  baseDir: string,
  options: ResourcesLoadOptions = {},
): ResourcesInput | undefined {
  try {
    const roles: ResourcesInput['roles'] = [];
    const bind = (b: RuntimeBinding) => ({
      runtime: b.runtime,
      vendor: vendorOf(b.runtime),
      ...(b.model ? { model: b.model } : {}),
      ...(b.effort ? { effort: b.effort } : {}),
    });
    const reviewers = (
      rule: ReviewRule | undefined,
      review: 'plan' | 'contract' | 'code',
      extra: { role: string; reviewsRole?: string; repositoryId?: string },
    ) => {
      if (!rule) return;
      roles.push({ ...extra, kind: 'reviewer', review, ...bind(rule.reviewer) });
      for (const alt of rule.alternates ?? [])
        roles.push({ ...extra, kind: 'reviewer', review, alternate: true, ...bind(alt) });
    };
    const writer = (
      role: string,
      binding: ExecutionPolicy['roles'][string],
      repositoryId?: string,
    ) => {
      const profile = binding.writer.toolProfile
        ? policy.toolProfiles[binding.writer.toolProfile]
        : undefined;
      const network = profileNetwork(binding.writer.runtime, profile);
      roles.push({
        role,
        kind: 'writer',
        ...bind(binding.writer),
        ...(repositoryId ? { repositoryId } : {}),
        ...(network ? { network } : {}),
      });
      reviewers(binding.review, 'code', {
        role,
        reviewsRole: role,
        ...(repositoryId ? { repositoryId } : {}),
      });
    };
    for (const [role, binding] of Object.entries(policy.roles)) writer(role, binding);
    for (const repo of policy.repositories) {
      for (const [role, binding] of Object.entries(repo.roles ?? {}))
        writer(role, binding, repo.id);
      reviewers(repo.review, 'code', { role: 'code', repositoryId: repo.id });
    }
    for (const kind of ['plan', 'contract', 'code'] as const)
      reviewers(policy.review[kind], kind, { role: kind });

    const lead = manifestLead(baseDir);
    const lifecycles: ResourcesInput['lifecycles'] = [];
    for (const repo of policy.repositories) {
      const l = repo.lifecycle ?? policy.lifecycle;
      if (l)
        lifecycles.push({
          repositoryId: repo.id,
          scope: 'attempt',
          setup: stepIds(l.setup),
          docker: usesDocker(l),
        });
    }
    if (policy.workspaceLifecycle)
      lifecycles.push({
        repositoryId: WORKSPACE_OWNER,
        scope: 'workspace',
        setup: stepIds(policy.workspaceLifecycle.setup),
        docker: usesDocker(policy.workspaceLifecycle),
      });
    const env = environments(stateDir, options);

    return {
      mode: policy.mode,
      sandbox: policy.isolation.mode,
      domains: policy.isolation.domains.length,
      roles,
      ...(lead ? { lead: { runtime: lead, vendor: vendorOf(lead) } } : {}),
      toolchain: {
        ...(policy.toolchain?.node ? { node: policy.toolchain.node } : {}),
        tools: policy.repositories.flatMap((r) =>
          Object.entries(r.toolchain?.tools ?? {}).map(([name, version]) => ({
            name,
            version,
            repositoryId: r.id,
          })),
        ),
        packageManagers: policy.repositories.flatMap((r) =>
          Object.entries(r.toolchain?.packageManagers ?? {}).map(([dir, manager]) => ({
            repositoryId: r.id,
            dir,
            manager,
          })),
        ),
      },
      dependencyStores: policy.repositories.map((r) => {
        if (!r.dependencyStore) return { repositoryId: r.id };
        const seeds = seedCount(stateDir, r.id);
        return {
          repositoryId: r.id,
          manager: r.dependencyStore.manager,
          ...(seeds !== undefined ? { seeds } : {}),
        };
      }),
      lifecycles,
      environments: env.list,
      ...(env.skipped ? { environmentsTruncated: env.skipped } : {}),
      gates: policy.repositories.map((r) => ({ repositoryId: r.id, count: r.gates.length })),
      workspaceGates: policy.workspaceGates.length,
      ...(options.heldGates?.length ? { heldGates: options.heldGates } : {}),
    };
  } catch {
    return undefined;
  }
}
