// Работы инфраструктуры harness (`kind: infra`, 0.1.0-alpha.67, docs/infra-works.md).
//
// Инфраструктурный код проекта под harness — мосты окружения, обёртки gates,
// приёмочные тесты в `.harness/` — пишет исполнитель обычным циклом попыток,
// а не ведущий во время настройки. Политика объявляет область инфраструктуры
// репозитория (`repositories[].infra.paths`): только работа `kind: infra` может
// её менять, продуктовые работы — нет. Здесь — чистые правила без Git и
// файловой системы: их проверяют `policyIssues`, `crossIssues` и runner.

import { z } from 'zod';
import { relativePathSchema } from './primitives.ts';
import type { CodedIssue } from './errors.ts';

/** Вид работы: нет поля — продуктовая (прежние поручения и их digest не меняются). */
export const workKinds = ['product', 'infra'] as const;
export const workKindSchema = z.enum(workKinds);
export type WorkKind = (typeof workKinds)[number];

/** Предел путей области инфраструктуры репозитория. */
export const INFRA_PATHS_MAX = 32;

/**
 * Область инфраструктуры репозитория: пути, принадлежащие harness, которые
 * меняют только работы `kind: infra` (например `.harness/acceptance/`,
 * `.harness/infra/`). Совпадение — путь или префикс каталога, как у
 * `writePaths`. Необязательное поле без умолчания: политика без него
 * сохраняет digest.
 */
export const infraScopeSchema = z.strictObject({
  paths: z.array(relativePathSchema).min(1).max(INFRA_PATHS_MAX),
});
export type InfraScope = z.infer<typeof infraScopeSchema>;

/**
 * Корни доверия проекта: политика, профиль, связка, manifest, обновления,
 * пакет контекста и установленный пакет. Их не меняет ни одна работа —
 * область инфраструктуры их не может покрывать: работа, правящая политику,
 * выдала бы себе gates.
 */
export const INFRA_TRUST_ROOTS = [
  '.harness/policy.json',
  '.harness/profile.json',
  '.harness/connector.json',
  '.harness/project.json',
  '.harness/updates.json',
  '.harness/.gitignore',
  '.harness/README.md',
  '.harness/work/',
  '.harness-tools/',
  '.git/',
  '.devcontour/',
] as const;

const inside = (path: string, prefix: string) => {
  const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return path === p || path === prefix || path.startsWith(p + '/');
};
/** Пути пересекаются (один внутри другого), без учёта регистра. */
const overlap = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return inside(x, y) || inside(y, x);
};
/** Путь внутри одного из префиксов (`.` — всё дерево), с учётом регистра, как область записи. */
export const withinInfra = (path: string, prefixes: readonly string[]) =>
  prefixes.some((p) => p === '.' || inside(path, p));

const GLOB = /[*?{[]/;
const posixJoin = (cwd: string | undefined, path: string) => {
  const parts = [...(cwd ? cwd.split('/') : []), ...path.split('/')].filter(
    (s) => s !== '' && s !== '.',
  );
  const out: string[] = [];
  for (const s of parts) {
    if (s === '..') {
      if (!out.length) return undefined;
      out.pop();
    } else out.push(s);
  }
  return out.join('/') || undefined;
};

/**
 * Пути файлов в argv команды (`node .harness/bridge.mjs exec -- …`,
 * `--test-reporter-destination=…`, `.harness/acceptance/*.test.mjs`):
 * относительные пути с каталогом или расширением, от `cwd` команды. Шаблон
 * glob даёт свой неизменный каталог с `/` на конце (всё внутри него).
 * Абсолютные пути, URL и флаги без значения — не пути дерева.
 */
export function commandPaths(command: readonly string[], cwd?: string): string[] {
  const out = new Set<string>();
  for (const raw of command) {
    const value = raw.startsWith('-')
      ? raw.includes('=')
        ? raw.slice(raw.indexOf('=') + 1)
        : ''
      : raw;
    if (!value || value.startsWith('/') || value.startsWith('~') || value.includes('://')) continue;
    if (!value.includes('/') && !/\.[A-Za-z0-9]{1,8}$/.test(value)) continue;
    if (/\s/.test(value) || value.includes('$')) continue;
    if (GLOB.test(value)) {
      const segments = value.split('/');
      const fixed = segments.slice(
        0,
        segments.findIndex((s) => GLOB.test(s)),
      );
      const dir = posixJoin(cwd, fixed.join('/'));
      if (dir) out.add(dir + '/');
      continue;
    }
    const path = posixJoin(cwd, value);
    if (path) out.add(path);
  }
  return [...out];
}

interface StepLike {
  command: readonly string[];
}
interface GateLike {
  command: readonly string[];
  cwd?: string;
}
interface RepoLike {
  protectedPaths: readonly string[];
  gates: readonly GateLike[];
  infra?: InfraScope;
  lifecycle?: {
    setup: readonly StepLike[];
    ready: readonly StepLike[];
    teardown: readonly StepLike[];
  };
  prepare: readonly StepLike[];
  dependencyBuild: readonly StepLike[];
  preflight: readonly StepLike[];
  generators?: readonly { command: readonly string[]; cwd?: string; tool: readonly string[] }[];
}

/**
 * Файлы шагов на хосте вне песочницы исполнителя: `lifecycle`, `prepare`,
 * `dependencyBuild`, `preflight` и генераторы (команда и инструмент). Их
 * исполнение идёт до ревью кандидата, поэтому работа их не меняет вовсе —
 * инфраструктурная работа (`infraIssues` не пускает их в область
 * инфраструктуры, runner отказывает такой правке).
 */
export function hostStepFiles(
  repo: RepoLike,
  workspaceLifecycle?: {
    setup: readonly StepLike[];
    ready: readonly StepLike[];
    teardown: readonly StepLike[];
  },
): string[] {
  const steps: { command: readonly string[]; cwd?: string }[] = [
    ...(repo.lifecycle
      ? [...repo.lifecycle.setup, ...repo.lifecycle.ready, ...repo.lifecycle.teardown]
      : []),
    ...(workspaceLifecycle
      ? [...workspaceLifecycle.setup, ...workspaceLifecycle.ready, ...workspaceLifecycle.teardown]
      : []),
    ...repo.prepare,
    ...repo.dependencyBuild,
    ...repo.preflight,
    ...(repo.generators ?? []),
  ];
  const out = new Set<string>();
  for (const s of steps) for (const p of commandPaths(s.command, s.cwd)) out.add(p);
  for (const g of repo.generators ?? []) for (const t of g.tool) out.add(t);
  return [...out];
}

/**
 * Файлы определения gates внутри области инфраструктуры: пути команд gates
 * (скрипт, каталог или шаблон тестов). Gate инфраструктурной работы
 * исполняется по доверенной базе: файл gate, который есть в базе, работа
 * меняет только с согласованием плана (`gateChanges` поручения).
 */
export function gateDefinitionFiles(repo: RepoLike): string[] {
  const infra = repo.infra?.paths ?? [];
  if (!infra.length) return [];
  const out = new Set<string>();
  for (const g of repo.gates)
    for (const p of commandPaths(g.command, g.cwd))
      if (withinInfra(p, infra) || infra.some((i) => inside(i, p))) out.add(p);
  return [...out];
}

/**
 * Согласованность области инфраструктуры репозитория: пути не покрывают
 * корни доверия (`INFRA_TRUST_ROOTS`) и файлы шагов на хосте, лежат внутри
 * `protectedPaths` (продуктовые работы их не меняют) и не повторяются.
 */
export function infraIssues(
  repo: RepoLike,
  path: (string | number)[] = ['infra'],
  workspaceLifecycle?: Parameters<typeof hostStepFiles>[1],
): CodedIssue[] {
  if (!repo.infra) return [];
  const issues: CodedIssue[] = [];
  const add = (where: (string | number)[], message: string) =>
    issues.push({ code: 'INVALID_INPUT', path: [...path, ...where], message });
  const host = hostStepFiles(repo, workspaceLifecycle);
  const seen = new Set<string>();
  repo.infra.paths.forEach((p, i) => {
    const at = ['paths', i];
    const key = p.toLowerCase().replace(/\/$/, '');
    if (seen.has(key)) add(at, 'Повтор пути инфраструктуры ' + p);
    seen.add(key);
    for (const root of INFRA_TRUST_ROOTS)
      if (overlap(p, root))
        add(
          at,
          `Путь инфраструктуры ${p} пересекает корень доверия ${root}: политику, связку и manifest работа не меняет`,
        );
    if (!repo.protectedPaths.some((q) => inside(p, q) || inside(p.replace(/\/$/, ''), q)))
      add(
        at,
        `Путь инфраструктуры ${p} вне protectedPaths: продуктовая работа могла бы его менять — добавьте его или его каталог в protectedPaths`,
      );
    for (const file of host)
      if (overlap(file, p))
        add(
          at,
          `Путь инфраструктуры ${p} покрывает файл шага на хосте ${file}: шаги lifecycle/prepare исполняются вне песочницы до ревью — новую версию пишите рядом и переключайте политикой`,
        );
  });
  return issues;
}

export interface InfraScopeInput {
  /** Вид работы. */
  kind: WorkKind;
  /** Область инфраструктуры репозитория; нет — `[]`. */
  paths: readonly string[];
  /** Файлы gates внутри области (`gateDefinitionFiles`). */
  gateFiles: readonly string[];
  /** Файлы шагов на хосте (`hostStepFiles`). */
  hostFiles: readonly string[];
  /** Согласованные планом изменения файлов gates (`gateChanges` поручения). */
  gateChanges: readonly string[];
  /** Путь есть в доверенной базе кандидата. */
  inBase(path: string): boolean;
}

/**
 * Решение области инфраструктурной работы: `host` — изменённые файлы шагов
 * на хосте; `gate` — изменённые файлы gates доверенной базы без согласования
 * планом. Продуктовой работе ничего не добавляется: область инфраструктуры ей
 * защищена через `protected` (`scopeViolations`), а прежние правила её
 * области не меняются.
 */
export function infraViolations(changed: readonly string[], input: InfraScopeInput) {
  if (input.kind !== 'infra') return { host: [] as string[], gate: [] as string[] };
  const host = changed.filter((p) => withinInfra(p, input.hostFiles));
  const gate = changed.filter(
    (p) =>
      !host.includes(p) &&
      withinInfra(p, input.gateFiles) &&
      input.inBase(p) &&
      !withinInfra(p, input.gateChanges),
  );
  return { host, gate };
}
