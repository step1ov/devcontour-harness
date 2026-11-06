import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  API_VERSION,
  HARNESS_PROJECT_DIR,
  PROJECT_MANIFEST_PATH,
  projectFactsSchema,
  type ProjectDiagnosticCode,
  type ProjectFacts,
} from '../contracts/index.ts';
import { command } from '../environment/process.ts';
import { profilePin, resolveProfile } from '../profiles/resolve.ts';
import { Manifests, lockfiles, packageManagerField, scriptsOf } from '../toolchains/manifests.ts';
import {
  defaultProbe,
  PROBE_TIMEOUT_MS,
  resolveExecutable,
  satisfies,
  versionOf,
  type ToolProbe,
} from '../toolchains/probe.ts';
import { PROJECT_REPOSITORY_ID, detectProfile } from './policy.ts';

/** Маркеры репозитория DevContour: второй controller и state не создаются. */
export const devcontourMarkers = ['devcontour.config.json', '.devcontour-local'];

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Git без записи: optional locks выключены, чтобы `status` не обновлял индекс,
 * а пользовательские hooks и fsmonitor не запускались.
 */
const gitEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, GIT_OPTIONAL_LOCKS: '0' });
const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  command(['git', '-c', 'core.fsmonitor=false', ...args], cwd, { env: gitEnv(env) });

export type GitFacts =
  | { problem: 'path-missing' | 'not-directory' | 'not-git-repository'; path: string }
  | {
      path: string;
      /** realpath верхнего уровня Git. */
      root: string;
      worktree: 'main' | 'linked';
      baseSha: string | null;
      branch: string | null;
    };

/** Корень Git каталога `path`, вид worktree и HEAD — только чтением. */
export async function gitFacts(path: string, env: NodeJS.ProcessEnv): Promise<GitFacts> {
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    return { problem: 'path-missing', path: resolve(path) };
  }
  if (!lstatSync(real).isDirectory()) return { problem: 'not-directory', path: real };
  const top = await git(real, env, 'rev-parse', '--show-toplevel');
  let root = '';
  try {
    root = top.code === 0 ? realpathSync(top.stdout.trim()) : '';
  } catch {
    root = '';
  }
  if (!root) return { problem: 'not-git-repository', path: real };
  const dirs = await git(
    root,
    env,
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
  );
  const [gitDir, commonDir] = dirs.stdout.trim().split('\n');
  const canonical = (p?: string) => {
    try {
      return p ? realpathSync(p) : '';
    } catch {
      return p ?? '';
    }
  };
  const worktree =
    dirs.code === 0 && canonical(gitDir) !== canonical(commonDir) ? 'linked' : 'main';
  const head = await git(root, env, 'rev-parse', '--verify', '-q', 'HEAD^{commit}');
  const branch = await git(root, env, 'symbolic-ref', '-q', '--short', 'HEAD');
  return {
    path: real,
    root,
    worktree,
    baseSha: head.code === 0 ? head.stdout.trim() : null,
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
  };
}

export interface InspectProjectOptions {
  repository: string;
  env?: NodeJS.ProcessEnv;
  /** Проба `--version`; по умолчанию — процесс во временном каталоге. */
  probe?: ToolProbe;
  /** Runtime, наличие которых проверить; по умолчанию оба. */
  runtimes?: ('claude' | 'codex')[];
}

type Diagnostic = ProjectFacts['diagnostics'][number];

/** Типичные имена проверок в scripts; остальные scripts — просто факты. */
const checkName = /^(check|test|tests|typecheck|type-check|types|lint|build|verify|ci)(:.+)?$/;

/**
 * Факты готовности репозитория к первому запуску без записи: Git-корень и
 * base SHA, lockfiles и менеджер пакетов, подходящие встроенные профили с
 * digest, scripts проверок, версии инструментов и наличие CLI runtime.
 * Ничего не создаёт и не исполняет из манифестов; модели не вызываются,
 * авторизация runtime остаётся неизвестной. Генерация `.harness` и target ref
 * — дело `init`; DevContour применяет к фактам собственные правила размещения.
 */
export async function inspectProject(options: InspectProjectOptions): Promise<ProjectFacts> {
  const env = options.env ?? process.env;
  const probe = options.probe ?? defaultProbe;
  const diagnostics: Diagnostic[] = [];
  const add = (
    code: ProjectDiagnosticCode,
    severity: Diagnostic['severity'],
    message: string,
    action: string,
    path?: string,
  ) => diagnostics.push({ code, severity, message, action, ...(path ? { path } : {}) });

  const facts = await gitFacts(options.repository, env);
  let root: string | undefined;
  let gitSummary: ProjectFacts['git'] = {
    root: null,
    worktree: null,
    baseSha: null,
    branch: null,
    dirty: null,
    changes: [],
  };
  if ('problem' in facts) {
    const text = {
      'path-missing': ['Каталог не существует', 'Укажите существующий каталог репозитория'],
      'not-directory': ['Путь — не каталог', 'Укажите каталог репозитория'],
      'not-git-repository': [
        'Каталог не в Git-репозитории',
        'Выполните git init и первый коммит или укажите корень репозитория',
      ],
    }[facts.problem];
    add(facts.problem, 'blocker', text[0]!, text[1]!, facts.path);
  } else {
    root = facts.root;
    gitSummary = {
      root: facts.root,
      worktree: facts.worktree,
      baseSha: facts.baseSha,
      branch: facts.branch,
      dirty: null,
      changes: [],
    };
    if (facts.path !== facts.root)
      add(
        'inside-repository',
        'blocker',
        `Каталог внутри репозитория ${facts.root}`,
        `Укажите корень репозитория ${facts.root}`,
        facts.path,
      );
    if (facts.worktree === 'linked')
      add(
        'git-worktree',
        'blocker',
        'Каталог — дополнительный Git worktree, а не основной checkout',
        'Укажите основной checkout репозитория',
        facts.root,
      );
    if (!facts.baseSha)
      add(
        'no-commits',
        'blocker',
        'В репозитории нет коммитов',
        'Сделайте первый коммит: base SHA нужен попыткам',
        facts.root,
      );
    else {
      const status = await git(
        facts.root,
        env,
        '--no-optional-locks',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=normal',
      );
      const dirty = status.code === 0 ? status.stdout.length > 0 : null;
      gitSummary.dirty = dirty;
      // Записи -z: `XY путь`, у переименования следом исходный путь отдельной записью.
      const entries = status.code === 0 ? status.stdout.split('\0') : [];
      for (let i = 0; i < entries.length && gitSummary.changes.length < 50; i++) {
        const entry = entries[i]!;
        if (entry.length < 4) continue;
        gitSummary.changes.push(entry.slice(3));
        if (entry[0] === 'R' || entry[0] === 'C') i++;
      }
      if (dirty)
        add(
          'dirty-checkout',
          'warning',
          'В рабочем дереве есть незакоммиченные изменения',
          'Закоммитьте или уберите их сами: попытки начинаются от base SHA, незакоммиченное в них не попадёт',
          facts.root,
        );
    }
  }

  const markers = {
    devcontour: root ? devcontourMarkers.filter((m) => exists(join(root, m))) : [],
    harnessProject: root ? exists(join(root, PROJECT_MANIFEST_PATH)) : false,
  };
  if (root && markers.devcontour.length)
    add(
      'devcontour-owned',
      'info',
      `Репозиторием уже управляет DevContour (${markers.devcontour.join(', ')})`,
      'Продолжайте через DevContour; самостоятельный controller не создаётся',
      join(root, markers.devcontour[0]!),
    );
  if (root && markers.harnessProject)
    add(
      'harness-project',
      'info',
      `Проект harness уже подготовлен (${HARNESS_PROJECT_DIR}/)`,
      'Повторный init продолжит по сохранённому manifest',
      join(root, PROJECT_MANIFEST_PATH),
    );

  let lockfileList: string[] = [];
  let packageManager: ProjectFacts['packageManager'] = { status: 'none' };
  const profiles: ProjectFacts['profiles'] = [];
  let scripts: ProjectFacts['scripts'] = [];
  let required: { version: string; source: string } | undefined;
  if (root) {
    const m = new Manifests(root);
    lockfileList = m.lockfilesIn('.');
    const pkg = m.isFile('package.json') ? m.json('package.json') : undefined;
    if (!m.isFile('package.json'))
      add(
        'package-json-missing',
        'warning',
        'В корне нет package.json',
        'Быстрый маршрут поддерживает npm и pnpm: нужен package.json в корне',
        join(root, 'package.json'),
      );
    else if (!pkg)
      add(
        'package-json-invalid',
        'blocker',
        'package.json не читается как JSON-объект',
        'Исправьте package.json',
        join(root, 'package.json'),
      );
    const declared = pkg ? packageManagerField(m, '.') : undefined;
    const detected = detectProfile(root);
    if ('problem' in detected) {
      if (detected.problem === 'stack-ambiguous') {
        packageManager = { status: 'ambiguous' };
        add(
          'stack-ambiguous',
          'blocker',
          `Несколько lockfile: ${detected.files.join(', ')}`,
          'Оставьте lockfile одного менеджера или выберите профиль явно',
          root,
        );
      } else
        add(
          'stack-unsupported',
          'blocker',
          lockfileList.length
            ? `Нет подходящего профиля для ${lockfileList.join(', ')}`
            : 'Нет package-lock.json или pnpm-lock.yaml',
          'Поддерживаются npm (package-lock.json) и pnpm (pnpm-lock.yaml); выберите профиль явно',
          root,
        );
    } else {
      const name = lockfiles[detected.lockfile as keyof typeof lockfiles] as 'npm' | 'pnpm';
      packageManager = { status: 'detected', name, lockfile: detected.lockfile };
    }
    if (declared)
      packageManager.declared = {
        name: declared.name,
        ...(declared.version ? { version: declared.version } : {}),
      };
    if (declared && packageManager.name && declared.name !== packageManager.name)
      add(
        'manager-mismatch',
        'warning',
        `packageManager объявляет ${declared.name}, lockfile — ${packageManager.name}`,
        'Согласуйте поле packageManager и lockfile',
        join(root, 'package.json'),
      );
    const candidates =
      'problem' in detected
        ? detected.problem === 'stack-ambiguous'
          ? (['npm-ci', 'pnpm-frozen'] as const)
          : []
        : [detected.id];
    for (const id of candidates) {
      const resolved = resolveProfile(id, {
        repository: root,
        repositoryId: PROJECT_REPOSITORY_ID,
      });
      profiles.push(profilePin(resolved));
      if (!('problem' in detected)) {
        const manager = packageManager.name!;
        const pinned = resolved.toolchain?.tools[manager];
        required =
          declared?.name === manager && declared.version
            ? { version: declared.version, source: 'package.json#packageManager' }
            : pinned
              ? { version: pinned, source: `profile ${resolved.id}@${resolved.version}` }
              : undefined;
      }
    }
    scripts = Object.entries(pkg ? (scriptsOf(m, '.') ?? {}) : {})
      .filter(([, cmd]) => typeof cmd === 'string')
      .map(([name, cmd]) => ({ name, command: cmd }));
    if (pkg && !scripts.some((s) => checkName.test(s.name)))
      add(
        'no-check-scripts',
        'warning',
        'В package.json нет scripts проверок (test, check, typecheck, lint, build)',
        'Добавьте команду проверки: gates исполняют существующие команды проекта',
        join(root, 'package.json'),
      );
  }
  const checks = scripts.map((s) => s.name).filter((n) => checkName.test(n));

  // Пробы — только `--version` в нейтральном каталоге.
  const versionProbe = async (name: string) => {
    const executable = resolveExecutable(name, env.PATH);
    if (!executable) return { status: 'missing' as const };
    const r = await probe([executable, '--version'], { timeoutMs: PROBE_TIMEOUT_MS, env }).catch(
      () => undefined,
    );
    const version = r && r.code === 0 && !r.timedOut ? versionOf(r.stdout + r.stderr) : undefined;
    return version ? { status: 'ok' as const, version } : { status: 'version-error' as const };
  };
  const tools: ProjectFacts['tools'] = [];
  for (const name of ['git', 'node', ...(packageManager.name ? [packageManager.name] : [])]) {
    const probed = await versionProbe(name);
    const need = name === packageManager.name ? required : undefined;
    const status =
      probed.status === 'ok' && need && !satisfies(probed.version, need.version)
        ? 'mismatch'
        : probed.status;
    tools.push({
      name,
      status,
      ...(probed.status === 'ok' ? { version: probed.version } : {}),
      ...(need ? { required: need } : {}),
    });
    if (status === 'missing')
      add('tool-missing', 'blocker', `${name} не найден в PATH`, `Установите ${name}`);
    else if (status === 'version-error')
      add(
        'tool-version-error',
        'blocker',
        `${name} не ответил на --version`,
        `Проверьте установку ${name}`,
      );
    else if (status === 'mismatch')
      add(
        'tool-version-mismatch',
        'warning',
        `${name} ${probed.status === 'ok' ? probed.version : ''} не совпадает с требуемой ${need!.version} (${need!.source})`,
        `Установите ${name} ${need!.version} или задайте версию явно`,
      );
  }
  const runtimes: ProjectFacts['runtimes'] = [];
  for (const runtime of options.runtimes ?? (['claude', 'codex'] as const)) {
    const probed = await versionProbe(runtime);
    const status = probed.status === 'ok' ? 'available' : probed.status;
    runtimes.push({
      runtime,
      status,
      ...(probed.status === 'ok' ? { version: probed.version } : {}),
      auth: 'unknown',
    });
    if (status === 'missing')
      add(
        'runtime-missing',
        'warning',
        `CLI ${runtime} не найден в PATH`,
        `Установите ${runtime} и выполните вход, если политика назначает его`,
      );
    else if (status === 'version-error')
      add(
        'runtime-version-error',
        'warning',
        `CLI ${runtime} не ответил на --version`,
        `Проверьте установку ${runtime}`,
      );
  }

  return projectFactsSchema.parse({
    apiVersion: API_VERSION,
    kind: 'project-facts',
    path: facts.path,
    git: gitSummary,
    lockfiles: lockfileList,
    packageManager,
    profiles,
    scripts,
    checks,
    tools,
    runtimes,
    markers,
    diagnostics,
    ready: !diagnostics.some((d) => d.severity === 'blocker'),
  });
}
