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
  if (prefix === '.' || prefix === './') return true;
  const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return path === p || path === prefix || path.startsWith(p + '/');
};
/** Пути пересекаются (один внутри другого), без учёта регистра; `.` — всё дерево. */
const overlap = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return inside(x, y) || inside(y, x);
};
/** Путь внутри одного из префиксов (`.` — всё дерево), с учётом регистра, как область записи. */
export const withinInfra = (path: string, prefixes: readonly string[]) =>
  prefixes.some((p) => inside(path, p));

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
 * `--test-reporter-destination=…`, `.harness/acceptance/*.test.mjs`,
 * `--env a.template:b.env`): относительные пути с каталогом или расширением,
 * от `cwd` команды; значение со списком (`:` или `,`) даёт каждую часть.
 * Шаблон glob даёт свой неизменный каталог с `/` на конце (всё внутри него);
 * шаблон без неизменного каталога — каталог команды (`cwd/` или `.` — всё
 * дерево). Абсолютные пути, URL, флаги без значения и аргументы с пробелом
 * или подстановкой (`sh -c "…"`) — не пути дерева.
 *
 * Это эвристика: она не видит файлов, которые команда читает сама (импорты,
 * файлы по умолчанию, скрипты package manager). Гарантии области
 * инфраструктуры от неё не зависят (docs/infra-works.md): шаги на хосте после
 * исполнителя идут по доверенной базе, а существующие файлы области меняются
 * только по `gateChanges`.
 */
export function commandPaths(command: readonly string[], cwd?: string): string[] {
  const out = new Set<string>();
  for (const raw of command) {
    const value = raw.startsWith('-')
      ? raw.includes('=')
        ? raw.slice(raw.indexOf('=') + 1)
        : ''
      : raw;
    if (!value || value.includes('://')) continue;
    if (/\s/.test(value) || value.includes('$') || value.includes('`')) continue;
    for (const part of value.split(/[:,]/)) {
      if (!part || part.startsWith('/') || part.startsWith('~')) continue;
      if (!part.includes('/') && !/\.[A-Za-z0-9]{1,8}$/.test(part) && !GLOB.test(part)) continue;
      if (GLOB.test(part)) {
        const segments = part.split('/');
        const fixed = segments.slice(
          0,
          segments.findIndex((s) => GLOB.test(s)),
        );
        const dir = posixJoin(cwd, fixed.join('/'));
        out.add(dir ? dir + '/' : '.');
        continue;
      }
      const path = posixJoin(cwd, part);
      if (path) out.add(path);
    }
  }
  return [...out];
}

interface StepLike {
  command: readonly string[];
  cwd?: string;
}
interface GateLike {
  command: readonly string[];
  cwd?: string;
}
interface LifecycleLike {
  setup: readonly StepLike[];
  ready: readonly StepLike[];
  teardown: readonly StepLike[];
}
interface RepoLike {
  protectedPaths: readonly string[];
  gates: readonly GateLike[];
  infra?: InfraScope;
  lifecycle?: LifecycleLike;
  prepare: readonly StepLike[];
  dependencyBuild: readonly StepLike[];
  preflight: readonly StepLike[];
  generators?: readonly {
    command: readonly string[];
    cwd?: string;
    tool: readonly string[];
    inputs?: readonly string[];
  }[];
  previews?: readonly {
    build?: readonly StepLike[];
    start: readonly string[];
    cwd?: string;
  }[];
}
/** Окружения уровня политики: lifecycle по умолчанию и совместной проверки. */
export interface PolicyLifecycles {
  lifecycle?: LifecycleLike;
  workspaceLifecycle?: LifecycleLike;
}

/**
 * Файлы шагов на хосте вне песочницы исполнителя, которые называет argv:
 * `lifecycle` репозитория и политики, `workspaceLifecycle`, `prepare`,
 * `dependencyBuild`, `preflight`, генераторы (команда, инструмент и входы) и
 * превью (`build`, `start`). Работа их не меняет вовсе: `infraIssues` не
 * пускает их в область инфраструктуры, runner отказывает такой правке
 * (с разрешением ссылок по доверенной базе). Список — по argv: файлы, которые
 * шаг читает сам, он не называет; от них защищает исполнение шагов после
 * исполнителя по доверенной базе (docs/infra-works.md).
 */
export function hostStepFiles(repo: RepoLike, policy: PolicyLifecycles = {}): string[] {
  const cycle = (l?: LifecycleLike) => (l ? [...l.setup, ...l.ready, ...l.teardown] : []);
  const steps: StepLike[] = [
    ...cycle(repo.lifecycle),
    ...cycle(policy.lifecycle),
    ...cycle(policy.workspaceLifecycle),
    ...repo.prepare,
    ...repo.dependencyBuild,
    ...repo.preflight,
    ...(repo.generators ?? []),
    ...(repo.previews ?? []).flatMap((p) => [
      ...(p.build ?? []).map((b) => ({ command: b.command, ...(p.cwd ? { cwd: p.cwd } : {}) })),
      { command: p.start, ...(p.cwd ? { cwd: p.cwd } : {}) },
    ]),
  ];
  const out = new Set<string>();
  for (const s of steps) for (const p of commandPaths(s.command, s.cwd)) out.add(p);
  for (const g of repo.generators ?? []) {
    for (const t of g.tool) out.add(t);
    for (const t of g.inputs ?? []) out.add(t);
  }
  return [...out];
}

/**
 * Новый файл, который меняет, как инструменты находят и читают прежние
 * файлы области (манифест пакета, `node_modules`, конфигурация с точки или
 * `*.config.*`): новым файлом он не считается — как правка существующего,
 * только по `gateChanges`.
 */
export const resolutionFile = (path: string) => {
  const segments = path.split('/');
  const name = segments.at(-1) ?? '';
  return (
    segments.includes('node_modules') ||
    name === 'package.json' ||
    name.startsWith('.') ||
    /\.config\.[A-Za-z0-9]+$/.test(name) ||
    /^tsconfig.*\.json$/.test(name)
  );
};

/**
 * Согласованность области инфраструктуры репозитория: пути не покрывают
 * корни доверия (`INFRA_TRUST_ROOTS`) и файлы шагов на хосте, лежат внутри
 * `protectedPaths` (продуктовые работы их не меняют) и не повторяются.
 */
export function infraIssues(
  repo: RepoLike,
  path: (string | number)[] = ['infra'],
  policy: PolicyLifecycles = {},
): CodedIssue[] {
  if (!repo.infra) return [];
  const issues: CodedIssue[] = [];
  const add = (where: (string | number)[], message: string) =>
    issues.push({ code: 'INVALID_INPUT', path: [...path, ...where], message });
  const host = hostStepFiles(repo, policy);
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
          `Путь инфраструктуры ${p} покрывает файл шага на хосте ${file}: шаги lifecycle/prepare исполняются вне песочницы — новую версию пишите рядом и переключайте политикой`,
        );
  });
  return issues;
}

export interface InfraScopeInput {
  /** Вид работы. */
  kind: WorkKind;
  /** Область инфраструктуры репозитория; нет — `[]`. */
  paths: readonly string[];
  /** Файлы шагов на хосте (`hostStepFiles` и их цели по ссылкам доверенной базы). */
  hostFiles: readonly string[];
  /** Согласованные планом изменения существующих файлов области (`gateChanges` поручения). */
  gateChanges: readonly string[];
  /** Путь (или его цель по ссылке) есть в доверенной базе кандидата. */
  inBase(path: string): boolean;
  /** Путь в кандидате — символическая ссылка. */
  isLink?(path: string): boolean;
}

/**
 * Решение области инфраструктурной работы (docs/infra-works.md):
 * - `host` — изменённые файлы шагов на хосте;
 * - `link` — символические ссылки в кандидате: их цель не видна лексической
 *   проверке, работа инфраструктуры их не добавляет и не меняет;
 * - `gate` — изменённые или удалённые файлы области, которые есть в
 *   доверенной базе, и новые файлы разрешения (`resolutionFile`) без
 *   согласования планом (`gateChanges`). Любой существующий файл области
 *   может быть файлом gate или его зависимостью (импорт, файл по умолчанию,
 *   скрипт package manager): правка без согласования отклоняется, какой бы
 *   командой gate его ни читал. Новые файлы добавлять можно.
 * Продуктовой работе ничего не добавляется: область инфраструктуры ей
 * защищена через `protected` (`scopeViolations`).
 */
export function infraViolations(changed: readonly string[], input: InfraScopeInput) {
  if (input.kind !== 'infra')
    return { host: [] as string[], gate: [] as string[], link: [] as string[] };
  const host = changed.filter((p) => withinInfra(p, input.hostFiles));
  const link = changed.filter((p) => !host.includes(p) && input.isLink?.(p) === true);
  const gate = changed.filter(
    (p) =>
      !host.includes(p) &&
      !link.includes(p) &&
      (input.inBase(p) || resolutionFile(p)) &&
      !withinInfra(p, input.gateChanges),
  );
  return { host, gate, link };
}
