import { existsSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, posix, resolve, sep } from 'node:path';
import type { z } from 'zod';
import {
  HarnessError,
  type ExecutionPolicy,
  type GatePolicy,
  type repositoryPolicySchema,
  type stepSchema,
} from '../contracts/index.ts';
import {
  Manifests,
  goModule,
  join2,
  lockedVersion,
  lockfiles,
  packageManagerField,
  scriptsOf,
  turboTasks,
  uvLocked,
  workspacePackages,
} from './manifests.ts';
import {
  PROBE_TIMEOUT_MS,
  defaultProbe,
  moduleVersionOf,
  resolveExecutable,
  satisfies,
  versionOf,
  type ToolProbe,
} from './probe.ts';

type Repository = z.infer<typeof repositoryPolicySchema>;
type Step = z.infer<typeof stepSchema>;
type Field = (string | number)[];

/**
 * Коды проблем диагностики toolchain. Каждая проблема называет поле
 * конфигурации (`field`) и, когда причина в файле проекта, — путь (`path`).
 */
export const toolchainProblemCodes = [
  'REPOSITORY_MISSING',
  'CWD_MISSING',
  'TOOL_MISSING',
  'TOOL_VERSION',
  'TOOL_VERSION_UNKNOWN',
  'TOOL_NOT_LOCKED',
  'MANIFEST_MISSING',
  'LOCKFILE_MISSING',
  'LOCKFILE_AMBIGUOUS',
  'SCRIPT_UNKNOWN',
  'TASK_UNKNOWN',
  'FILTER_UNKNOWN',
  'INSTALL_UNLOCKED',
  'UNPINNED',
  'IF_PRESENT',
  'CACHE_REPLAY',
  'REPORT_MISMATCH',
  'COMPOSITION_CONFLICT',
  'PROJECT_FILE_MISSING',
  'SCRIPT_UNRESOLVED',
  'TOOL_IN_PROJECT',
] as const;
export type ToolchainProblemCode = (typeof toolchainProblemCodes)[number];

export interface ToolchainProblem {
  code: ToolchainProblemCode;
  field: Field;
  path?: string;
  message: string;
}

export interface PlanEntry {
  phase: 'prepare' | 'dependencyBuild' | 'preflight' | 'setup' | 'ready' | 'teardown' | 'gate';
  id: string;
  kind?: 'check' | 'test';
  /** Каталог запуска относительно корня репозитория (`.` — корень). */
  cwd: string;
  argv: string[];
  report?: string;
  field: Field;
}

export interface ToolEntry {
  name: string;
  /** `path` — из PATH окружения harness; `project` — даёт установленная среда проекта. */
  provider: 'path' | 'project';
  found: boolean;
  version?: string;
  required: { version: string; source: string }[];
  usedBy: string[];
}

export interface ToolchainReport {
  repositoryId: string;
  root: string;
  configSource?: string;
  plan: PlanEntry[];
  tools: ToolEntry[];
  lockfiles: { dir: string; files: string[]; manager?: string; selectedBy?: string }[];
  reports: { gate: string; path: string; cwd: string }[];
  ambiguities: { field: Field; path?: string; message: string; resolvedBy?: string }[];
  /** Замечания, которые не останавливают запуск (совместимость прежних профилей). */
  warnings: ToolchainProblem[];
  problems: ToolchainProblem[];
}

export interface InspectOptions {
  /** Чем запускаются пробы версий; тест подменяет и считает вызовы. */
  probe?: ToolProbe;
  probeTimeoutMs?: number;
  /** Окружение поиска инструментов; по умолчанию — окружение процесса. */
  env?: NodeJS.ProcessEnv;
  /** Откуда загружена конфигурация (файл политики, binding, профиль). */
  configSource?: string;
  /**
   * Каталоги, исполняемые файлы из которых не запускаются никогда: корни
   * репозиториев политики, каталог состояния с worktrees попыток.
   */
  protectedRoots?: string[];
}

/**
 * Исполняемый файл под контролем проекта: его канонический путь (после всех
 * symlink, включая symlink каталога PATH) лежит в защищённом корне — в
 * репозитории (с его node_modules/.bin и .venv) или в каталоге состояния с
 * worktrees попыток. Такой файл диагностика не запускает. Внешние инструменты
 * в node_modules окружения (npm, pnpm из nvm) — не код проекта.
 */
const projectControlled = (real: string, roots: string[]) =>
  roots.some((r) => real === r || real.startsWith(r + sep));
const canonical = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

const fmtField = (f: Field) => f.join('.');
const pathFlag = (args: string[], names: string[]) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) return args[i + 1];
      if (a.startsWith(n + '=')) return a.slice(n.length + 1);
    }
  }
  return undefined;
};
const allFlags = (args: string[], names: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n && args[i + 1] !== undefined) out.push(args[i + 1]!);
      else if (a.startsWith(n + '=')) out.push(a.slice(n.length + 1));
    }
  }
  return out;
};
/** Позиционные аргументы: флаги со значением пропускаются вместе со значением. */
const positional = (args: string[], valued: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (valued.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
};
const normal = (dir: string, rel: string) => {
  const joined = posix.normalize(dir === '.' ? rel : `${dir}/${rel}`).replace(/\/$/, '');
  return joined === '' ? '.' : joined;
};
const count1 = (args: string[]) =>
  args.some((a, i) => a === '-count=1' || (a === '-count' && args[i + 1] === '1'));

const npmScriptAliases: Record<string, string> = {
  test: 'test',
  t: 'test',
  tst: 'test',
  start: 'start',
  stop: 'stop',
  restart: 'restart',
};
const pnpmBuiltins = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'update',
  'up',
  'exec',
  'dlx',
  'run',
  'test',
  't',
  'store',
  'list',
  'ls',
  'why',
  'outdated',
  'audit',
  'config',
  'fetch',
  'rebuild',
  'prune',
  'link',
  'unlink',
  'import',
  'create',
  'licenses',
  'deploy',
]);

/**
 * Диагностика toolchain одного репозитория политики: какие команды и где
 * исполнятся, какие внешние инструменты и версии им нужны, есть ли lockfiles
 * и не противоречат ли они выбору, существуют ли scripts/tasks/фильтры,
 * каталоги и отчёты. Только чтение файлов и ограниченные по времени пробы
 * версий: ни установки, ни кода проекта, ни новых файлов.
 */
export async function inspectRepository(
  repo: Repository,
  root: string,
  field: Field,
  options: InspectOptions & {
    lifecycle?: ExecutionPolicy['lifecycle'];
    environment?: ExecutionPolicy['environment'];
    workspaceGates?: { gate: GatePolicy; field: Field }[];
  } = {},
): Promise<ToolchainReport> {
  const report: ToolchainReport = {
    repositoryId: repo.id,
    root,
    ...(options.configSource ? { configSource: options.configSource } : {}),
    plan: [],
    tools: [],
    lockfiles: [],
    reports: [],
    ambiguities: [],
    warnings: [],
    problems: [],
  };
  const problem = (code: ToolchainProblemCode, f: Field, message: string, path?: string) =>
    report.problems.push({ code, field: f, message, ...(path !== undefined ? { path } : {}) });
  const warning = (code: ToolchainProblemCode, f: Field, message: string) =>
    report.warnings.push({ code, field: f, message });
  if (!existsSync(root)) {
    problem('REPOSITORY_MISSING', [...field, 'path'], 'Каталог репозитория не найден: ' + root);
    return report;
  }
  const m = new Manifests(root);
  const env = options.env ?? process.env;
  const values = { ...options.environment?.values, ...repo.environment?.values };
  const PATH = values.PATH ?? env.PATH;
  const probe = options.probe ?? defaultProbe;
  const timeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

  const tools = new Map<string, ToolEntry>();
  const tool = (name: string, provider: ToolEntry['provider'], usedBy?: Field) => {
    const key = provider + ':' + name;
    let entry = tools.get(key);
    if (!entry) {
      entry = { name, provider, found: false, required: [], usedBy: [] };
      tools.set(key, entry);
    }
    if (usedBy && !entry.usedBy.includes(fmtField(usedBy))) entry.usedBy.push(fmtField(usedBy));
    return entry;
  };
  const requires = (name: string, version: string, source: string) => {
    const entry = tool(name, 'path');
    if (!entry.required.some((r) => r.version === version && r.source === source))
      entry.required.push({ version, source });
  };
  /** Каталог node-проекта → менеджеры, чьи команды в нём исполняются. */
  const managers = new Map<string, Map<string, Field>>();
  const useManager = (dir: string, manager: string, f: Field) => {
    const project = nodeProject(dir);
    const used = managers.get(project) ?? new Map<string, Field>();
    if (!used.has(manager)) used.set(manager, f);
    managers.set(project, used);
  };
  const nodeProject = (dir: string) =>
    m.nearest(dir, 'pnpm-workspace.yaml') ??
    m.ancestors(dir).find((d) => m.lockfilesIn(d).length) ??
    dir;
  const dirOf = (base: string, value: string | undefined, f: Field) => {
    if (value === undefined) return base;
    if (isAbsolute(value)) {
      problem('CWD_MISSING', f, 'Каталог команды должен быть относительным: ' + value);
      return undefined;
    }
    const d = normal(base, value);
    if (d.startsWith('..') || !m.isDir(d)) {
      problem('CWD_MISSING', f, 'Каталог команды не найден в репозитории: ' + d, d);
      return undefined;
    }
    return d;
  };
  const checkScript = (dir: string, script: string | undefined, f: Field, inv?: Invocation) => {
    if (!script) return;
    const scripts = scriptsOf(m, dir);
    if (!scripts)
      return problem(
        'MANIFEST_MISSING',
        f,
        `Нет package.json для script ${script}`,
        join2(dir, 'package.json'),
      );
    if (!(script in scripts))
      problem(
        'SCRIPT_UNKNOWN',
        f,
        `Script ${script} не объявлен в ${join2(dir, 'package.json')}; есть: ${Object.keys(scripts).join(', ') || '—'}`,
        join2(dir, 'package.json'),
      );
    else if (inv) chain(inv, dir, script);
  };
  /**
   * Цепочка package scripts gate: script, вызывающий turbo напрямую или через
   * другой script (`pnpm run`, `pnpm --filter … run`, `npm run`), проверяется
   * так же, как прямой argv. Script, который нельзя разобрать статически
   * (подстановка, конвейер, `sh -c`, `eval`), в turbo-проекте — проблема:
   * угадывать, читает ли он cache, нельзя.
   */
  const chain = (inv: Invocation, dir: string, script: string, seen = new Set<string>()) => {
    if (inv.kind === undefined) return;
    const key = dir + '#' + script;
    if (seen.has(key)) return;
    seen.add(key);
    const text = scriptsOf(m, dir)?.[script];
    if (text === undefined) return;
    const file = join2(dir, 'package.json');
    if (/\$\(|`|(^|[^|])\|(?!\|)|\beval\b|\b(?:ba)?sh\s+-c\b|\bxargs\b/.test(text)) {
      if (m.nearest(dir, 'turbo.json') !== undefined || /\bturbo\b/.test(text))
        problem(
          'SCRIPT_UNRESOLVED',
          inv.field,
          `Script ${script} в ${file} не разбирается статически («${text}»): нельзя доказать, что turbo не восстановит отчёт из cache`,
          file,
        );
      return;
    }
    for (const segment of text.split(/&&|\|\||;/)) {
      const tokens = segment
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => t.replace(/^['"]|['"]$/g, ''));
      const assigned: Record<string, string> = {};
      while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
        const [k, ...v] = tokens.shift()!.split('=');
        assigned[k!] = v.join('=');
      }
      const [t0, ...rest] = tokens;
      if (!t0) continue;
      const force = ['true', '1'].includes(assigned.TURBO_FORCE ?? '') ? ['--force'] : [];
      const viaTurbo = (args: string[], at: string) => turbo(inv, [...args, ...force], at, true);
      if (t0 === 'turbo') viaTurbo(rest, dir);
      else if (t0 === 'npx' && rest[0] === 'turbo') viaTurbo(rest.slice(1), dir);
      else if (t0 === 'pnpm' || t0 === 'npm') {
        const flag = pathFlag(rest, t0 === 'pnpm' ? ['--dir', '-C'] : ['--prefix']);
        const base = flag ? normal(dir, flag) : dir;
        const filters = t0 === 'pnpm' ? allFlags(rest, ['--filter', '-F']) : [];
        const pos = positional(rest, [
          '--dir',
          '-C',
          '--filter',
          '-F',
          '--prefix',
          '-w',
          '--workspace',
        ]);
        if ((pos[0] === 'exec' && pos[1] === 'turbo') || (t0 === 'pnpm' && pos[0] === 'turbo')) {
          viaTurbo(rest.slice(rest.indexOf('turbo') + 1), base);
          continue;
        }
        const name =
          pos[0] === 'run' || pos[0] === 'run-script'
            ? pos[1]
            : pos[0] && npmScriptAliases[pos[0]]
              ? npmScriptAliases[pos[0]]
              : t0 === 'pnpm' && pos[0] && !pnpmBuiltins.has(pos[0])
                ? pos[0]
                : undefined;
        if (!name) continue;
        const targets =
          filters.length || rest.includes('-r') || rest.includes('--recursive')
            ? (
                selectPackages(
                  m.nearest(base, 'pnpm-workspace.yaml') ?? base,
                  filters,
                  inv.field,
                ) ?? []
              ).map((p) => p.dir)
            : [base];
        for (const target of targets) chain(inv, target, name, seen);
      }
    }
  };
  const matchPackages = (
    pkgs: ReturnType<typeof workspacePackages>,
    filter: string,
    wsRoot: string,
  ) => {
    let f = filter
      .replace(/^\.\.\./, '')
      .replace(/\.\.\.$/, '')
      .replace(/^\^/, '');
    if (f.startsWith('{') && f.endsWith('}')) f = f.slice(1, -1);
    const glob = (pattern: string) =>
      new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    if (f.startsWith('./') || f === '.') {
      const want = glob(normal(wsRoot, f));
      return pkgs.filter((p) => want.test(p.dir));
    }
    const want = glob(f);
    return pkgs.filter((p) => p.name !== undefined && want.test(p.name));
  };
  const selectPackages = (
    wsRoot: string,
    filters: string[],
    f: Field,
  ): ReturnType<typeof workspacePackages> | undefined => {
    const pkgs = workspacePackages(m, wsRoot);
    if (!filters.length) return pkgs;
    const out = new Map<string, (typeof pkgs)[number]>();
    for (const filter of filters) {
      const found = matchPackages(pkgs, filter, wsRoot);
      if (!found.length) {
        problem(
          'FILTER_UNKNOWN',
          f,
          `Фильтр ${filter} не выбирает ни одного пакета workspace ${wsRoot}; есть: ${pkgs.map((p) => p.name ?? p.dir).join(', ')}`,
          join2(wsRoot, 'pnpm-workspace.yaml'),
        );
        return undefined;
      }
      for (const p of found) out.set(p.dir, p);
    }
    return [...out.values()];
  };
  const checkReport = (inv: Invocation, dir: string, value: string | undefined, f: Field) => {
    if (!value || !inv.report) return;
    const produced = normal(dir, value);
    if (produced !== posix.normalize(inv.report))
      problem(
        'REPORT_MISMATCH',
        f,
        `Команда пишет JUnit в ${produced}, а gate читает ${inv.report}; отчёт gate не будет свежим`,
      );
  };

  interface Invocation {
    kind?: 'check' | 'test';
    report?: string;
    field: Field;
  }
  const turbo = (inv: Invocation, args: string[], dir: string, projectBin: boolean) => {
    const f = inv.field;
    const ws = m.nearest(dir, 'turbo.json');
    if (projectBin) {
      const root = ws ?? nodeProject(dir);
      const pkg = m.json(join2(root, 'package.json')) ?? {};
      const declared = ['devDependencies', 'dependencies'].map(
        (k) => (pkg[k] as Record<string, string> | undefined)?.turbo,
      );
      const version = declared.find(Boolean);
      const entry = tool('turbo', 'project', f);
      entry.found = Boolean(version);
      if (version) {
        // Диапазон в package.json допустим, если закоммиченный lockfile
        // закрепляет точную разрешённую версию: её и ставит locked install.
        const locked = /^\d+\.\d+\.\d+$/.test(version) ? version : lockedVersion(m, root, 'turbo');
        entry.version = locked ?? version;
        if (!locked)
          problem(
            'UNPINNED',
            f,
            `turbo ${version} в ${join2(root, 'package.json')} без точной версии в lockfile: закрепите версию`,
            join2(root, 'package.json'),
          );
      } else
        problem(
          'TOOL_MISSING',
          f,
          `turbo не объявлен в ${join2(root, 'package.json')}`,
          join2(root, 'package.json'),
        );
    }
    if (!ws)
      return problem('MANIFEST_MISSING', f, 'Нет turbo.json для turbo', join2(dir, 'turbo.json'));
    const valued = [
      '--filter',
      '-F',
      '--cache',
      '--cache-dir',
      '--concurrency',
      '--env-mode',
      '--log-order',
      '--output-logs',
      '--graph',
      '--summarize',
    ];
    const pos = positional(args, valued);
    const tasks = pos[0] === 'run' ? pos.slice(1) : pos.slice(0, 1);
    if (!tasks.length) return problem('TASK_UNKNOWN', f, 'turbo без задачи');
    const known = turboTasks(m, ws) ?? [];
    const filters = allFlags(args, ['--filter', '-F']);
    const selected = selectPackages(ws, filters, f);
    for (const task of tasks) {
      if (!known.some((k) => k === task || k.endsWith('#' + task)))
        problem(
          'TASK_UNKNOWN',
          f,
          `Задача ${task} не объявлена в ${join2(ws, 'turbo.json')}; есть: ${known.join(', ') || '—'}`,
          join2(ws, 'turbo.json'),
        );
      else if (selected && !selected.some((p) => task in p.scripts && p.dir !== ws))
        problem(
          'TASK_UNKNOWN',
          f,
          `Ни один выбранный пакет (${selected.map((p) => p.name ?? p.dir).join(', ')}) не объявляет script ${task}: turbo ничего не исполнит`,
          join2(ws, 'turbo.json'),
        );
    }
    if (inv.kind === 'test') {
      const cache = pathFlag(args, ['--cache']);
      const readDisabled = cache !== undefined && !/:r/.test(cache);
      if (!args.includes('--force') && !readDisabled && values.TURBO_FORCE !== 'true')
        problem(
          'CACHE_REPLAY',
          f,
          'Test gate через turbo без --force (или --cache без чтения): попадание в cache восстановит старый отчёт вместо прогона тестов',
        );
    }
  };
  const goTool = (inv: Invocation, dir: string) => {
    const mod = m.nearest(dir, 'go.mod');
    if (!mod) {
      problem('MANIFEST_MISSING', inv.field, 'Нет go.mod для Go-команды', join2(dir, 'go.mod'));
      return;
    }
    const gm = goModule(m, mod)!;
    if (gm.go) requires('go', '>=' + gm.go, join2(mod, 'go.mod') + '#go');
    if (gm.toolchain) requires('go', '>=' + gm.toolchain, join2(mod, 'go.mod') + '#toolchain');
    if (gm.requires && !m.isFile(join2(mod, 'go.sum')))
      problem('LOCKFILE_MISSING', inv.field, 'go.mod с require без go.sum', join2(mod, 'go.sum'));
  };

  const analyze = (inv: Invocation, argv: string[], dir: string) => {
    const f = inv.field;
    const [exe, ...args] = argv as [string, ...string[]];
    for (const a of argv)
      if (/@latest\b/.test(a)) problem('UNPINNED', f, `Незакреплённая версия в команде: ${a}`);
    if (exe.includes('/')) {
      // Файл проекта: проверяется существование, но не исполняется.
      const rel = isAbsolute(exe) ? m.rel(exe) : normal(dir, exe);
      if (isAbsolute(exe) && rel === undefined) {
        const entry = tool(exe, 'path', f);
        entry.found = Boolean(resolveExecutable(exe, PATH));
        if (!entry.found) problem('TOOL_MISSING', f, 'Исполняемый файл не найден: ' + exe);
      } else if (!rel || !m.isFile(rel))
        problem('PROJECT_FILE_MISSING', f, 'Файл команды не найден в репозитории: ' + exe, rel);
      return;
    }
    tool(exe, 'path', f);
    const name = basename(exe);
    if (name === 'npm') {
      const d = dirOf(dir, pathFlag(args, ['--prefix']), f);
      if (!d) return;
      const pos = positional(args, ['--prefix', '-w', '--workspace']);
      const sub = pos[0];
      useManager(d, 'npm', f);
      if (args.includes('--if-present'))
        problem('IF_PRESENT', f, '--if-present превращает отсутствующий script в зелёный шаг');
      if (sub === 'ci' || sub === 'clean-install') {
        if (!m.isFile(join2(d, 'package.json')))
          problem('MANIFEST_MISSING', f, 'npm ci без package.json', join2(d, 'package.json'));
        const project = nodeProject(d);
        if (!['package-lock.json', 'npm-shrinkwrap.json'].some((l) => m.isFile(join2(project, l))))
          problem(
            'LOCKFILE_MISSING',
            f,
            'npm ci без package-lock.json',
            join2(project, 'package-lock.json'),
          );
      } else if (sub === 'install' || sub === 'i' || sub === 'add' || sub === 'update')
        problem(
          'INSTALL_UNLOCKED',
          f,
          `npm ${sub} может переписать package-lock.json; используйте npm ci`,
        );
      else if (sub === 'run' || sub === 'run-script' || sub === 'rum' || sub === 'urn')
        checkScript(d, pos[1], f, inv);
      else if (sub && npmScriptAliases[sub]) checkScript(d, npmScriptAliases[sub], f, inv);
      return;
    }
    if (name === 'npx') {
      problem(
        'UNPINNED',
        f,
        'npx может скачать пакет; используйте script проекта или npm exec --no',
      );
      return;
    }
    if (name === 'pnpm') {
      const d = dirOf(dir, pathFlag(args, ['--dir', '-C']), f);
      if (!d) return;
      const valued = [
        '--dir',
        '-C',
        '--filter',
        '-F',
        '--reporter',
        '--loglevel',
        '--workspace-concurrency',
      ];
      const pos = positional(args, valued);
      const sub = pos[0];
      useManager(d, 'pnpm', f);
      if (args.includes('--if-present'))
        problem('IF_PRESENT', f, '--if-present превращает отсутствующий script в зелёный шаг');
      const wsRoot = m.nearest(d, 'pnpm-workspace.yaml') ?? d;
      const filters = allFlags(args, ['--filter', '-F']);
      const scriptTargets = (script: string | undefined) => {
        if (!script) return;
        if (!filters.length && !args.includes('-r') && !args.includes('--recursive'))
          return checkScript(d, script, f, inv);
        const selected = selectPackages(wsRoot, filters, f);
        for (const p of selected ?? []) if (script in p.scripts) chain(inv, p.dir, script);
        if (selected && !selected.some((p) => script in p.scripts))
          problem(
            'SCRIPT_UNKNOWN',
            f,
            `Ни один выбранный пакет (${selected.map((p) => p.name ?? p.dir).join(', ')}) не объявляет script ${script}`,
            join2(wsRoot, 'pnpm-workspace.yaml'),
          );
      };
      if (sub === 'install' || sub === 'i') {
        if (!args.includes('--frozen-lockfile'))
          problem(
            'INSTALL_UNLOCKED',
            f,
            'pnpm install без --frozen-lockfile может переписать pnpm-lock.yaml',
          );
        const lockDir = m.nearest(d, 'pnpm-lock.yaml') ?? wsRoot;
        if (!m.isFile(join2(lockDir, 'pnpm-lock.yaml')))
          problem(
            'LOCKFILE_MISSING',
            f,
            'pnpm install без pnpm-lock.yaml',
            join2(wsRoot, 'pnpm-lock.yaml'),
          );
      } else if (sub && ['add', 'remove', 'rm', 'update', 'up'].includes(sub))
        problem('INSTALL_UNLOCKED', f, `pnpm ${sub} меняет зависимости и lockfile`);
      else if (sub === 'exec') {
        const rest = args.slice(args.indexOf('exec') + 1);
        if (rest[0] === 'turbo') turbo(inv, rest.slice(1), d, true);
      } else if (sub === 'dlx') {
        const spec = pos[1] ?? '';
        if (!/^@?[^@]+@\d/.test(spec)) problem('UNPINNED', f, 'pnpm dlx без точной версии пакета');
      } else if (sub === 'run') scriptTargets(pos[1]);
      else if (sub === 'test' || sub === 't') scriptTargets('test');
      else if (sub && !pnpmBuiltins.has(sub)) {
        const scripts = scriptsOf(m, d) ?? {};
        if (sub in scripts || filters.length) scriptTargets(sub);
        else if (sub === 'turbo') turbo(inv, args.slice(args.indexOf('turbo') + 1), d, true);
        else checkScript(d, sub, f, inv);
      }
      return;
    }
    if (name === 'turbo') return turbo(inv, args, dir, false);
    if (name === 'go') {
      let rest = args;
      let d: string | undefined = dir;
      if (rest[0] === '-C') {
        d = dirOf(dir, rest[1], f);
        rest = rest.slice(2);
      } else if (rest[0]?.startsWith('-C=')) {
        d = dirOf(dir, rest[0].slice(3), f);
        rest = rest.slice(1);
      }
      if (!d) return;
      const sub = rest[0];
      if (sub === 'version' || sub === 'env') return;
      goTool(inv, d);
      if (sub === 'get' || (sub === 'mod' && rest[1] === 'tidy'))
        problem('INSTALL_UNLOCKED', f, `go ${rest.slice(0, 2).join(' ')} меняет go.mod/go.sum`);
      if (sub === 'test' && inv.kind === 'test' && !count1(rest))
        warning(
          'CACHE_REPLAY',
          f,
          'go test без -count=1: результат может быть взят из кэша тестов Go (ключ — содержимое; JUnit всё равно пишется заново)',
        );
      return;
    }
    if (name === 'gotestsum') {
      tool('go', 'path', f);
      goTool(inv, dir);
      const split = args.indexOf('--');
      const own = split >= 0 ? args.slice(0, split) : args;
      const goArgs = split >= 0 ? args.slice(split + 1) : [];
      checkReport(inv, dir, pathFlag(own, ['--junitfile']), f);
      if (inv.kind === 'test' && !count1(goArgs))
        warning(
          'CACHE_REPLAY',
          f,
          'gotestsum без -- -count=1: результат может быть взят из кэша тестов Go (ключ — содержимое; JUnit всё равно пишется заново)',
        );
      return;
    }
    if (name === 'uv') {
      const d = dirOf(dir, pathFlag(args, ['--directory', '--project']), f);
      if (!d) return;
      const valued = [
        '--directory',
        '--project',
        '--python',
        '-p',
        '--with',
        '--group',
        '--extra',
        '--package',
      ];
      const pos = positional(args, valued);
      const sub = pos[0];
      if (sub === 'tool' || sub === 'pip') {
        problem('INSTALL_UNLOCKED', f, `uv ${sub} ставит пакеты вне uv.lock`);
        return;
      }
      if (sub === 'self' || sub === 'version' || sub === 'python') return;
      const project = m.nearest(d, 'pyproject.toml');
      if (!project) {
        problem('MANIFEST_MISSING', f, 'Нет pyproject.toml для uv', join2(d, 'pyproject.toml'));
        return;
      }
      const lockDir = m.nearest(d, 'uv.lock') ?? project;
      if (sub === 'sync') {
        if (!args.includes('--locked') && !args.includes('--frozen'))
          problem('INSTALL_UNLOCKED', f, 'uv sync без --locked может переписать uv.lock');
        if (!m.isFile(join2(lockDir, 'uv.lock')))
          problem('LOCKFILE_MISSING', f, 'uv sync --locked без uv.lock', join2(project, 'uv.lock'));
      } else if (sub === 'lock' || sub === 'add' || sub === 'remove')
        problem('INSTALL_UNLOCKED', f, `uv ${sub} меняет uv.lock`);
      else if (sub === 'run') {
        if (!['--no-sync', '--locked', '--frozen'].some((x) => args.includes(x)))
          problem(
            'INSTALL_UNLOCKED',
            f,
            'uv run без --no-sync/--locked может пересобрать среду и uv.lock',
          );
        if (allFlags(args, ['--with']).length)
          problem('UNPINNED', f, 'uv run --with ставит пакет вне uv.lock');
        const at = args.indexOf(pos[1] ?? '\0');
        const inner = at >= 0 ? args.slice(at) : [];
        const innerExe = inner[0];
        if (innerExe && !innerExe.includes('/') && !/^python(\d(\.\d+)?)?$/.test(innerExe)) {
          const locked = uvLocked(m, lockDir);
          const entry = tool(innerExe, 'project', f);
          const version = locked?.get(innerExe.toLowerCase());
          entry.found = version !== undefined;
          if (version) entry.version = version;
          else
            problem(
              'TOOL_NOT_LOCKED',
              f,
              `${innerExe} не закреплён в ${join2(lockDir, 'uv.lock')}: среда попытки его не получит`,
              join2(lockDir, 'uv.lock'),
            );
        }
        if (innerExe === 'pytest') checkReport(inv, d, pytestJunit(inner.slice(1)), f);
      }
      return;
    }
    if (name === 'uvx') {
      if (!/@\d/.test(args.find((a) => !a.startsWith('-')) ?? ''))
        problem('UNPINNED', f, 'uvx без точной версии инструмента');
      return;
    }
    if (name === 'pytest') return checkReport(inv, dir, pytestJunit(args), f);
    if (name === 'node' && args[0] && !args[0].startsWith('-')) {
      const file = normal(dir, args[0]);
      if (!m.isFile(file))
        problem('PROJECT_FILE_MISSING', f, 'Скрипт node не найден в репозитории: ' + args[0], file);
    }
  };

  const steps = (phase: PlanEntry['phase'], list: Step[], at: Field) =>
    list.forEach((step, i) => {
      const entry: PlanEntry = {
        phase,
        id: step.id,
        cwd: '.',
        argv: step.command,
        field: [...at, i, 'command'],
      };
      report.plan.push(entry);
      analyze({ field: entry.field }, step.command, '.');
    });
  steps('prepare', repo.prepare, [...field, 'prepare']);
  steps('dependencyBuild', repo.dependencyBuild, [...field, 'dependencyBuild']);
  steps('preflight', repo.preflight, [...field, 'preflight']);
  // Хранилище зависимостей: промах не останавливает работу, но и не ускоряет её —
  // причину лучше увидеть в диагностике, чем в квитанции каждой попытки.
  if (repo.dependencyStore) {
    const store = repo.dependencyStore;
    const storeField = [...field, 'dependencyStore'];
    tool(store.manager, 'path', [...storeField, 'manager']);
    if (!m.isFile(store.lockfile))
      problem(
        'LOCKFILE_MISSING',
        [...storeField, 'lockfile'],
        'Хранилищу зависимостей нужен lockfile: ' + store.lockfile,
        store.lockfile,
      );
  }
  const lifecycle = repo.lifecycle ?? options.lifecycle;
  const lifecycleField = repo.lifecycle ? [...field, 'lifecycle'] : ['lifecycle'];
  if (lifecycle)
    for (const phase of ['setup', 'ready', 'teardown'] as const)
      steps(phase, lifecycle[phase], [...lifecycleField, phase]);
  const gates = [
    ...repo.gates.map((gate, i) => ({ gate, field: [...field, 'gates', i] })),
    ...(options.workspaceGates ?? []),
  ];
  for (const { gate, field: at } of gates) {
    let cwd: string | undefined = '.';
    if (gate.cwd !== undefined) cwd = dirOf('.', gate.cwd, [...at, 'cwd']);
    const entry: PlanEntry = {
      phase: 'gate',
      id: gate.id,
      kind: gate.kind,
      cwd: cwd ?? gate.cwd ?? '.',
      argv: gate.command,
      ...(gate.report ? { report: gate.report.path } : {}),
      field: [...at, 'command'],
    };
    report.plan.push(entry);
    if (gate.report) report.reports.push({ gate: gate.id, path: gate.report.path, cwd: entry.cwd });
    if (cwd === undefined) continue;
    analyze(
      { kind: gate.kind, ...(gate.report ? { report: gate.report.path } : {}), field: entry.field },
      gate.command,
      cwd,
    );
  }

  // Выбор менеджера пакетов и lockfiles каждого node-проекта.
  const toolchain = repo.toolchain;
  const tcField = [...field, 'toolchain'];
  for (const dir of Object.keys(toolchain?.packageManagers ?? {}))
    if (!m.isDir(dir))
      problem(
        'CWD_MISSING',
        [...tcField, 'packageManagers', dir],
        'Каталог не найден: ' + dir,
        dir,
      );
  const projects = new Set([...managers.keys(), ...Object.keys(toolchain?.packageManagers ?? {})]);
  for (const dir of [...projects].sort()) {
    const used = managers.get(dir) ?? new Map<string, Field>();
    const explicit = toolchain?.packageManagers[dir];
    const declared = packageManagerField(m, dir);
    const files = m.lockfilesIn(dir);
    const lockManagers = [...new Set(files.map((f) => lockfiles[f as keyof typeof lockfiles]))];
    const entry: ToolchainReport['lockfiles'][number] = { dir, files };
    if (used.size > 1)
      problem(
        'COMPOSITION_CONFLICT',
        [...used.values()][1]!,
        `В каталоге ${dir} команды разных менеджеров пакетов: ${[...used.keys()].join(' и ')} (${[...used.values()].map(fmtField).join(', ')})`,
        dir,
      );
    if (explicit && [...used.keys()].some((u) => u !== explicit))
      problem(
        'COMPOSITION_CONFLICT',
        [...tcField, 'packageManagers', dir],
        `Каталог ${dir} закреплён за ${explicit}, но команда использует ${[...used.keys()].join(', ')}`,
        dir,
      );
    if (declared?.version && explicit && declared.name !== explicit)
      problem(
        'COMPOSITION_CONFLICT',
        [...tcField, 'packageManagers', dir],
        `${join2(dir, 'package.json')} объявляет packageManager ${declared.raw}, а политика — ${explicit}`,
        join2(dir, 'package.json'),
      );
    else if (declared?.version && [...used.keys()].some((u) => u !== declared.name))
      problem(
        'COMPOSITION_CONFLICT',
        [...used.values()][0]!,
        `${join2(dir, 'package.json')} объявляет packageManager ${declared.raw}, а команда использует ${[...used.keys()].join(', ')}`,
        join2(dir, 'package.json'),
      );
    if (declared?.version && (declared.name === 'npm' || declared.name === 'pnpm'))
      requires(declared.name, declared.version, join2(dir, 'package.json') + '#packageManager');
    const selected = explicit ?? (declared?.version ? declared.name : undefined);
    if (lockManagers.length > 1) {
      if (selected) {
        entry.manager = selected;
        entry.selectedBy = explicit
          ? fmtField([...tcField, 'packageManagers', dir])
          : join2(dir, 'package.json') + '#packageManager';
        report.ambiguities.push({
          field: [...tcField, 'packageManagers', dir],
          path: dir,
          message: `В ${dir} lockfiles нескольких менеджеров (${files.join(', ')})`,
          resolvedBy: entry.selectedBy,
        });
        if (!lockManagers.includes(selected as never))
          problem(
            'LOCKFILE_MISSING',
            [...tcField, 'packageManagers', dir],
            `Нет lockfile ${selected} в ${dir}`,
            dir,
          );
      } else
        problem(
          'LOCKFILE_AMBIGUOUS',
          [...tcField, 'packageManagers', dir],
          `В ${dir} lockfiles нескольких менеджеров (${files.join(', ')}): выберите менеджер явно (toolchain.packageManagers["${dir}"] или packageManager в package.json)`,
          dir,
        );
    } else if (lockManagers.length === 1) {
      entry.manager = lockManagers[0];
      const other = [...used.keys()].filter((u) => u !== lockManagers[0]);
      if (other.length && !selected)
        problem(
          'COMPOSITION_CONFLICT',
          used.get(other[0]!)!,
          `В ${dir} lockfile ${files[0]} (${lockManagers[0]}), а команда использует ${other.join(', ')}`,
          join2(dir, files[0]!),
        );
    }
    report.lockfiles.push(entry);
  }

  // Требования версий из политики.
  for (const [name, version] of Object.entries(toolchain?.tools ?? {}))
    requires(name, version, fmtField([...tcField, 'tools', name]));

  // Пробы: только внешние инструменты из PATH, по одному разу, с пределом времени.
  const roots = [root, ...(options.protectedRoots ?? [])].flatMap((r) => canonical(r) ?? []);
  const external = (file: string | undefined) => {
    const real = file ? canonical(file) : undefined;
    return real && !projectControlled(real, roots) ? real : undefined;
  };
  const goPath = external(resolveExecutable('go', PATH));
  for (const entry of tools.values()) {
    if (entry.provider !== 'path' || entry.name.includes('/')) continue;
    const file = resolveExecutable(entry.name, PATH);
    const firstUse = entry.usedBy[0];
    const at: Field = firstUse
      ? firstUse.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))
      : [...tcField, 'tools', entry.name];
    if (!file) {
      problem(
        'TOOL_MISSING',
        at,
        `${entry.name} не найден в PATH` +
          (entry.required.length
            ? ` (нужен ${entry.required.map((r) => r.version).join(', ')})`
            : ''),
      );
      continue;
    }
    entry.found = true;
    const real = external(file);
    if (!real) {
      // Инструмент из PATH разрешается (в том числе через symlink файла или
      // каталога PATH) в код проекта: не запускается ни пробой, ни версией.
      entry.provider = 'project';
      problem(
        'TOOL_IN_PROJECT',
        at,
        `${entry.name} из PATH разрешается в файл под контролем проекта (${canonical(file) ?? file}): диагностика его не запускает; нужен внешний инструмент`,
      );
      continue;
    }
    // Под нагрузкой проба может не уложиться в предел: один повтор с
    // удвоенным пределом. Итог по-прежнему ограничен (≤ 3 × timeoutMs).
    const probeEnv = { PATH, HOME: env.HOME, ...(env.TMPDIR ? { TMPDIR: env.TMPDIR } : {}) };
    const argv = [real, entry.name === 'go' ? 'version' : '--version'];
    let run = await probe(argv, { timeoutMs, env: probeEnv });
    if (run.timedOut) run = await probe(argv, { timeoutMs: timeoutMs * 2, env: probeEnv });
    let version =
      run.code === 0 && !run.timedOut ? versionOf(run.stdout + '\n' + run.stderr) : undefined;
    if (!version && goPath && entry.name !== 'go') {
      // Go-бинарник без метки версии (go install): версия модуля из build info.
      const info = await probe([goPath, 'version', '-m', real], {
        timeoutMs,
        env: { PATH, HOME: env.HOME },
      });
      if (info.code === 0) version = moduleVersionOf(info.stdout);
    }
    if (version) entry.version = version;
    for (const req of entry.required) {
      const reqField = req.source.startsWith(fmtField(tcField))
        ? [...tcField, 'tools', entry.name]
        : at;
      const reqPath = req.source.startsWith(fmtField(tcField))
        ? undefined
        : req.source.split('#')[0];
      if (!version)
        problem(
          'TOOL_VERSION_UNKNOWN',
          reqField,
          `Версия ${entry.name} не определена пробой, а ${req.source} требует ${req.version}`,
          reqPath,
        );
      else if (!satisfies(version, req.version))
        problem(
          'TOOL_VERSION',
          reqField,
          `${entry.name} ${version} не подходит: ${req.source} требует ${req.version}`,
          reqPath,
        );
    }
  }
  report.tools = [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  return report;
}

function pytestJunit(args: string[]) {
  return args
    .map((a, i) =>
      a.startsWith('--junitxml=') || a.startsWith('--junit-xml=')
        ? a.slice(a.indexOf('=') + 1)
        : a === '--junitxml' || a === '--junit-xml'
          ? args[i + 1]
          : undefined,
    )
    .find((v) => v !== undefined);
}

/** Диагностика всех репозиториев политики; пути — от каталога политики. */
export async function inspectPolicy(
  policy: ExecutionPolicy,
  baseDir: string,
  options: InspectOptions = {},
) {
  const reports: ToolchainReport[] = [];
  for (const [i, repo] of policy.repositories.entries())
    reports.push(
      await inspectRepository(repo, resolve(baseDir, repo.path), ['repositories', i], {
        ...options,
        // Ни один репозиторий политики не даёт исполняемых файлов для проб.
        protectedRoots: [
          ...(options.protectedRoots ?? []),
          ...policy.repositories.map((r) => resolve(baseDir, r.path)),
        ],
        ...(policy.lifecycle ? { lifecycle: policy.lifecycle } : {}),
        ...(policy.environment ? { environment: policy.environment } : {}),
        workspaceGates: policy.workspaceGates.flatMap((gate, j) =>
          gate.repositoryId === repo.id ? [{ gate, field: ['workspaceGates', j] }] : [],
        ),
      }),
    );
  return reports;
}

/** Проблемы диагностики строками для `doctor.problems`. */
export const problemLines = (reports: ToolchainReport[]) =>
  reports.flatMap((r) =>
    r.problems.map(
      (p) =>
        `toolchain ${r.repositoryId}: ${p.code} ${fmtField(p.field)}${p.path ? ` (${p.path})` : ''}: ${p.message}`,
    ),
  );

/**
 * Обязательный preflight запуска: та же диагностика, что у `doctor`, но
 * проблема — отказ `NOT_READY` до любой записи состояния и вызова runtime.
 */
export async function assertToolchainReady(
  policy: ExecutionPolicy,
  baseDir: string,
  options: InspectOptions = {},
) {
  const reports = await inspectPolicy(policy, baseDir, options);
  const problems = reports.flatMap((r) => r.problems.map((p) => ({ repository: r, problem: p })));
  if (problems.length)
    throw new HarnessError(
      'NOT_READY',
      `Preflight toolchain: ${problems.length} проблем(ы); исправьте конфигурацию до запуска`,
      problems.map(({ problem: p }) => ({
        path: ['policy', ...p.field],
        message: `${p.code}: ${p.message}${p.path ? ` (${p.path})` : ''}`,
      })),
    );
  return reports;
}
