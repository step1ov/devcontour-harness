import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { z } from 'zod';
import {
  API_VERSION,
  HARNESS_PROJECT_DIR,
  HarnessError,
  PROJECT_MANIFEST_PATH,
  PROJECT_NOTES_DIR,
  PROJECT_POLICY_PATH,
  PROJECT_WORK_DIR,
  executionPolicySchema,
  projectManifestSchema,
  type ExecutionPolicy,
  type initDataSchema,
  type ProfilePin,
  type ProjectManifest,
} from '../contracts/index.ts';
import { command } from '../environment/process.ts';
import { profilePin, resolveProfile } from '../profiles/resolve.ts';
import { Manifests, packageManagerField } from '../toolchains/manifests.ts';
import { inspectPolicy, problemLines, type ToolchainReport } from '../toolchains/inspect.ts';
import type { ToolProbe } from '../toolchains/probe.ts';
import {
  applyFileWrites,
  checkDestination,
  planFileWrites,
  type FileIntent,
  type FilePlan,
  type FilePlanEntry,
} from '../setup/files.ts';
import {
  PROJECT_REPOSITORY_ID,
  PROJECT_TARGET_REF,
  detectProfile,
  generatePolicy,
} from './policy.ts';

export type InitData = z.infer<typeof initDataSchema>;

/** Маркеры репозитория DevContour: второй controller и state не создаются. */
const devcontourMarkers = ['devcontour.config.json', '.devcontour-local'];

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const lstat = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};
const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
/** realpath ближайшего существующего предка плюс несуществующий хвост. */
const realish = (path: string) => {
  const tail: string[] = [];
  for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
    try {
      return join(realpathSync.native(cursor), ...tail.reverse());
    } catch {
      if (dirname(cursor) === cursor) return resolve(path);
      tail.push(basename(cursor));
    }
  }
};

/**
 * Writer, выбранный при генерации сохранённой политики. Роли профиля задают
 * своих writers сами, поэтому выбор читается по reviewer плана: generatePolicy
 * всегда назначает ему другой вендор, чем выбранный writer.
 */
const writerOf = (policy: ExecutionPolicy | undefined) => {
  const reviewer = policy?.review.plan?.reviewer.runtime;
  return reviewer === 'codex' ? 'claude' : reviewer === 'claude' ? 'codex' : undefined;
};

/** `p-` + первые 16 hex sha256 от realpath корня: тот же проект — тот же id. */
export function projectIdOf(root: string): string {
  return 'p-' + sha256(realpathSync(root)).slice(0, 16);
}

/**
 * Каталог состояния по умолчанию — вне репозитория:
 * `<HARNESS_STATE_HOME | $XDG_STATE_HOME/devcontour-harness | ~/.local/state/devcontour-harness>/projects/<projectId>`.
 */
export function defaultStateDir(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  const home =
    env.HARNESS_STATE_HOME ||
    (env.XDG_STATE_HOME
      ? join(env.XDG_STATE_HOME, 'devcontour-harness')
      : join(env.HOME || homedir(), '.local', 'state', 'devcontour-harness'));
  return join(resolve(home), 'projects', projectId);
}

/**
 * Файл `.harness/<name>` для чтения: `.harness` — настоящий каталог, файл —
 * обычный. Через symlink и не обычный файл не читается: такой путь станет
 * конфликтом плана, а не источником данных снаружи репозитория.
 */
const projectFile = (root: string, rel: string) => {
  if (!lstat(join(root, HARNESS_PROJECT_DIR))?.isDirectory()) return undefined;
  const path = join(root, rel);
  return lstat(path)?.isFile() ? path : undefined;
};

const parseFile = <T>(path: string, schema: z.ZodType<T>, what: string): T => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new HarnessError(
      'INVALID_INPUT',
      `${what} ${path}: не JSON (${(error as Error).message})`,
      [{ path: [path], message: 'invalid-json' }],
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new HarnessError(
      'INVALID_INPUT',
      `${what} ${path}: не проходит схему; исправьте или удалите файл явно`,
      parsed.error.issues.map((i) => ({
        path: [path, ...(i.path as (string | number)[])],
        message: i.message,
      })),
    );
  return parsed.data;
};

/** Manifest проекта; отсутствует — undefined, невалиден — INVALID_INPUT. */
export async function readProjectManifest(
  repository: string,
): Promise<ProjectManifest | undefined> {
  await Promise.resolve();
  const path = projectFile(realpathSync(resolve(repository)), PROJECT_MANIFEST_PATH);
  return path ? parseFile(path, projectManifestSchema, 'Manifest проекта') : undefined;
}

export interface InitOptions {
  repository: string;
  profile?: string;
  writer?: 'claude' | 'codex';
  state?: string;
  plan?: boolean;
  env?: NodeJS.ProcessEnv;
  probe?: ToolProbe;
}
export interface InitPlanned {
  root: string;
  status: 'new' | 'partial' | 'complete';
  manifest: ProjectManifest;
  intents: FileIntent[];
  plan: FilePlan;
  /**
   * Конфликты рабочих каталогов `.harness/work…`, куда агент пишет графы и
   * заметки: init их не создаёт, но не выдаёт агенту путь через symlink.
   */
  workConflicts: FilePlanEntry[];
  policy: ExecutionPolicy;
  profile: ProfilePin;
  shadowed: string[];
  toolchain: ToolchainReport[];
}

const readme = `# .harness

This directory belongs to devcontour-harness for this repository.

- \`policy.json\` — execution policy generated by \`harness init\` from the stack
  profile. Commit it; adjust it deliberately (never weaken gates, isolation or
  budgets to get a green run).
- \`project.json\` — local manifest (absolute paths, state location). Not under Git.
- \`work/\` — work graphs written by the agent; \`work/context/<id>/\` — context
  sources; \`work/context/notes/\` — optional Markdown notes.

Execution state lives outside the repository (see \`project.json\` → \`paths.state\`).

Resume in a new session:

    harness init --repository . --plan
    harness status --state <paths.state>
    harness explain --state <paths.state> --policy .harness/policy.json
`;

/** Корень: каталог, верхний уровень своего Git, с коммитом. */
async function gitRoot(repository: string, env: NodeJS.ProcessEnv) {
  const notRoot = (why: string): never => {
    throw new HarnessError(
      'INVALID_INPUT',
      `--repository должен быть корнем Git-репозитория: ${why}`,
      [{ path: ['--repository'], message: 'not-git-root' }],
    );
  };
  let root: string;
  try {
    root = realpathSync(resolve(repository));
  } catch {
    return notRoot(resolve(repository) + ' не существует');
  }
  if (!lstatSync(root).isDirectory()) notRoot(root + ' не каталог');
  const top = await command(['git', 'rev-parse', '--show-toplevel'], root, { env });
  const toplevel = top.code === 0 ? top.stdout.trim() : '';
  let real = '';
  try {
    real = toplevel ? realpathSync(toplevel) : '';
  } catch {
    real = '';
  }
  if (real !== root)
    notRoot(real ? `${root} внутри репозитория ${real}` : `${root} не в Git-репозитории`);
  const head = await command(['git', 'rev-parse', '--verify', '-q', 'HEAD^{commit}'], root, {
    env,
  });
  if (head.code !== 0)
    throw new HarnessError('NOT_READY', `В репозитории ${root} нет коммитов: сделайте первый`, [
      { path: ['--repository'], message: 'no-commits' },
    ]);
  return root;
}

/**
 * План подготовки: все отказы по существу (1–7) до записи; конфликты плана
 * и проблемы toolchain — данными, их превращает в отказ `initProject`.
 */
export async function planProject(options: InitOptions): Promise<InitPlanned> {
  const env = options.env ?? process.env;
  // 1–2. Корень Git с коммитом.
  const root = await gitRoot(options.repository, env);
  // 3. Репозиторием владеет DevContour.
  for (const marker of devcontourMarkers) {
    const path = join(root, marker);
    if (lstat(path))
      throw new HarnessError(
        'CONTROLLER_BUSY',
        `Репозиторием владеет DevContour (${path}): самостоятельный controller и state не создаются`,
        [{ path: [path], message: 'devcontour-owned' }],
      );
  }
  // 4. Существующий manifest — решения по умолчанию.
  const saved = await readProjectManifest(root);
  // 5. Профиль: --profile, manifest, lockfile.
  let ref = options.profile ?? saved?.profile.ref;
  if (!ref) {
    const detected = detectProfile(root);
    if ('problem' in detected)
      throw new HarnessError(
        'NOT_READY',
        detected.problem === 'stack-ambiguous'
          ? `Профиль не определён: в ${root} несколько lockfile (${detected.files.join(', ')}); укажите --profile`
          : `Профиль не определён: в ${root} нет package-lock.json или pnpm-lock.yaml; укажите --profile`,
        [{ path: ['--profile'], message: detected.problem }],
      );
    ref = detected.id;
  }
  const profile = resolveProfile(ref, { repository: root, repositoryId: PROJECT_REPOSITORY_ID });
  const projectId = projectIdOf(root);
  // 6. Состояние — вне репозитория.
  const state = options.state
    ? resolve(options.state)
    : (saved?.paths.state ?? defaultStateDir(projectId, env));
  if (
    inside(resolve(state), root) ||
    inside(realish(state), root) ||
    inside(realish(state), realish(root))
  )
    throw new HarnessError(
      'INVALID_INPUT',
      `Каталог состояния ${state} внутри репозитория ${root}: worktrees попыток не вкладываются в checkout`,
      [{ path: ['--state'], message: 'state-inside-repository' }],
    );
  // 7. Сохранённая политика сильнее сгенерированной: агент мог её настроить.
  // Сохранённая политика — решение, уже записанное прерванной подготовкой:
  // её writer продолжает выбор, если manifest ещё не записан.
  const savedPolicyPath = projectFile(root, PROJECT_POLICY_PATH);
  const savedPolicy = savedPolicyPath
    ? parseFile(savedPolicyPath, executionPolicySchema, 'Политика проекта')
    : undefined;
  const policyWriter = writerOf(savedPolicy);
  const writer = options.writer ?? saved?.runtimes.writer ?? policyWriter ?? 'claude';
  const declared = packageManagerField(new Manifests(root), '.');
  const generated = generatePolicy({
    profile,
    writer,
    ...(declared ? { packageManager: { name: declared.name, version: declared.version } } : {}),
  });
  const policyPath = join(root, PROJECT_POLICY_PATH);
  const policy = savedPolicy ?? executionPolicySchema.parse(generated.input);

  const pin = profilePin(profile);
  const manifest: ProjectManifest = {
    apiVersion: API_VERSION,
    kind: 'harness-project',
    manifestVersion: 1,
    projectId,
    root,
    repository: { id: PROJECT_REPOSITORY_ID, targetRef: PROJECT_TARGET_REF },
    profile: { ref, pin },
    runtimes: { writer, reviewer: writer === 'claude' ? 'codex' : 'claude' },
    paths: {
      policy: PROJECT_POLICY_PATH,
      work: PROJECT_WORK_DIR,
      notes: PROJECT_NOTES_DIR,
      state,
    },
  };
  projectManifestSchema.parse(manifest);
  // Порядок create-only записей: manifest — решения (профиль, writer, state) —
  // до политики, которая из них выводится; политика последней — признак
  // завершённой подготовки. Прерванная подготовка продолжается по manifest.
  const intents: FileIntent[] = [
    { path: join(root, HARNESS_PROJECT_DIR, '.gitignore'), content: '/project.json\n' },
    { path: join(root, HARNESS_PROJECT_DIR, 'README.md'), content: readme },
    {
      path: join(root, PROJECT_MANIFEST_PATH),
      content: JSON.stringify(manifest, null, 2) + '\n',
      onExisting: 'require-identical',
    },
    { path: policyPath, content: generated.text },
  ];
  const plan = await planFileWrites({ files: intents, root });
  const workConflicts: FilePlanEntry[] = [];
  // Writer сохранённой политики расходится с решением (manifest или явный
  // --writer): решение меняется явно, а не manifest, противоречащий политике.
  if (savedPolicy && policyWriter && writer !== policyWriter)
    workConflicts.push({ path: policyPath, action: 'conflict', conflict: 'content-differs' });
  const harnessDir = join(root, HARNESS_PROJECT_DIR);
  if (!plan.entries.some((e) => e.conflictPath === harnessDir))
    try {
      // Пробный путь внутри notes проверяет каждый уровень work → context → notes.
      await checkDestination(join(root, PROJECT_NOTES_DIR, '.probe'), { root });
    } catch (error) {
      const issue = error instanceof HarnessError ? error.issues[0] : undefined;
      if (!issue) throw error;
      const at = String(issue.path[0]);
      workConflicts.push({
        path: at,
        action: 'conflict',
        conflict: issue.message as NonNullable<FilePlanEntry['conflict']>,
        conflictPath: at,
      });
    }
  const status =
    saved && savedPolicy ? 'complete' : lstat(join(root, HARNESS_PROJECT_DIR)) ? 'partial' : 'new';
  const toolchain = await inspectPolicy(policy, join(root, HARNESS_PROJECT_DIR), {
    configSource: policyPath,
    protectedRoots: [state],
    env,
    ...(options.probe ? { probe: options.probe } : {}),
  });
  return {
    root,
    status,
    manifest,
    intents,
    plan,
    workConflicts,
    policy,
    profile: pin,
    shadowed: generated.shadowed,
    toolchain,
  };
}

function dataOf(
  planned: InitPlanned,
  mode: 'plan' | 'apply',
  written: { created: string[]; preserved: string[] },
): InitData {
  const { root, manifest, policy } = planned;
  const harness = join(root, HARNESS_PROJECT_DIR);
  const policyPath = join(root, PROJECT_POLICY_PATH);
  const workDir = join(root, PROJECT_WORK_DIR);
  const state = manifest.paths.state;
  const graph = join(workDir, '<graph>.json');
  const repository =
    policy.repositories.find((r) => r.id === manifest.repository.id) ?? policy.repositories[0]!;
  const problems = problemLines(planned.toolchain);
  return {
    mode,
    status: planned.status,
    projectId: manifest.projectId,
    root,
    manifestPath: join(root, PROJECT_MANIFEST_PATH),
    manifest,
    files: [...planned.plan.entries, ...planned.workConflicts].map((e) => ({
      path: e.path,
      action: e.action,
      ...(e.conflict ? { conflict: e.conflict } : {}),
      ...(e.conflictPath ? { conflictPath: e.conflictPath } : {}),
    })),
    conflicts: planned.plan.conflicts + planned.workConflicts.length,
    created: written.created,
    preserved: written.preserved,
    profile: planned.profile,
    shadowed: planned.shadowed,
    facts: {
      repositoryId: repository.id,
      targetRef: repository.targetRef,
      roles: Object.entries(policy.roles).flatMap(([id, role]) =>
        role.writer.runtime === 'claude' || role.writer.runtime === 'codex'
          ? [
              {
                id,
                runtime: role.writer.runtime,
                ...(role.writePaths ? { writePaths: role.writePaths } : {}),
              },
            ]
          : [],
      ),
      gates: repository.gates.map((g) => ({ id: g.id, kind: g.kind })),
      workDir,
      contextDir: join(workDir, 'context'),
      notesDir: join(root, PROJECT_NOTES_DIR),
    },
    toolchain: { ready: problems.length === 0, problems },
    next: [
      {
        command: 'doctor',
        args: ['--policy', policyPath],
        why: 'Runtimes, OS-sandbox и toolchain политики до первого запуска',
      },
      {
        command: 'validate',
        args: ['--graph', graph, '--policy', policyPath],
        why: `Проверить граф, записанный агентом в ${workDir}`,
      },
      {
        command: 'run',
        args: [
          '--graph',
          graph,
          '--policy',
          policyPath,
          '--state',
          state,
          '--author',
          manifest.runtimes.writer,
        ],
        why: 'Исполнить граф: ревью плана, попытки, gates, ревью кода, интеграция в target ref',
      },
      {
        command: 'status',
        args: ['--state', state],
        why: 'Состояние поручений; NOT_FOUND — проект ещё не запускали',
      },
      {
        command: 'explain',
        args: ['--state', state, '--policy', policyPath],
        why: `Почему остановилось и кто действует дальше (политика — ${harness}/policy.json)`,
      },
    ],
  };
}

/**
 * `harness init`: план или create-only запись `.harness/`: manifest решений до
 * политики, политика последней.
 * Без `plan` конфликты (8) и проблемы toolchain (9) — отказ до любой записи.
 */
export async function initProject(options: InitOptions): Promise<InitData> {
  const planned = await planProject(options);
  if (options.plan) return dataOf(planned, 'plan', { created: [], preserved: [] });
  // 8. Конфликты: applyFileWrites отказывает PATH_CONFLICT со всеми конфликтами, ничего не записав.
  // Отказ один и называет все конфликты плана — и файлов, и рабочих каталогов.
  const extra = planned.workConflicts.map((e) => ({ path: [e.path], message: e.conflict! }));
  if (planned.plan.conflicts > 0)
    try {
      await applyFileWrites(planned.plan, planned.intents);
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'PATH_CONFLICT')
        throw new HarnessError('PATH_CONFLICT', error.message, [...error.issues, ...extra]);
      throw error;
    }
  const first = planned.workConflicts[0];
  if (first)
    throw new HarnessError(
      'PATH_CONFLICT',
      first.conflict === 'content-differs'
        ? `Сохранённая политика задаёт другого writer: решение меняется явно, а не manifest поверх неё: ${first.path}`
        : `Рабочий каталог .harness — не каталог внутри проекта: ${first.path}`,
      extra,
    );
  // 9. Toolchain действующей политики — в формате preflight `run`.
  const problems = planned.toolchain.flatMap((r) => r.problems);
  if (problems.length)
    throw new HarnessError(
      'NOT_READY',
      `Preflight toolchain: ${problems.length} проблем(ы); исправьте конфигурацию до запуска`,
      problems.map((p) => ({
        path: ['policy', ...p.field],
        message: `${p.code}: ${p.message}${p.path ? ` (${p.path})` : ''}`,
      })),
    );
  const written = await applyFileWrites(planned.plan, planned.intents);
  return dataOf(planned, 'apply', written);
}

export function initText(data: InitData): string {
  const lines = [
    `init ${data.mode}: ${data.status} ${data.projectId}`,
    `root: ${data.root}`,
    `state: ${data.manifest.paths.state}`,
    `profile: ${data.profile.id}@${data.profile.version} (${data.manifest.profile.ref})`,
    `runtimes: writer ${data.manifest.runtimes.writer}, reviewer ${data.manifest.runtimes.reviewer}`,
    ...data.files.map(
      (f) => `${f.action === 'conflict' ? `conflict:${f.conflict ?? '?'}` : f.action} ${f.path}`,
    ),
    ...(data.mode === 'apply'
      ? [`created: ${data.created.length}, preserved: ${data.preserved.length}`]
      : []),
    data.toolchain.ready ? 'toolchain: ready' : 'toolchain: not ready',
    ...data.toolchain.problems.map((p) => '  ' + p),
    'next:',
    ...data.next.map((n) => `  harness ${n.command} ${n.args.join(' ')}  # ${n.why}`),
  ];
  return lines.join('\n') + '\n';
}
