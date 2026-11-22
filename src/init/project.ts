import { RU, ruCount } from '../contracts/plural.ts';
import { storeAdvice } from '../control/store-advice.ts';
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
  inputPolicyOf,
  recoveryPolicyOf,
  leadAnswersRule,
  projectManifestSchema,
  runtimeAssignments,
  reviewVendorConflictMessage,
  reviewVendorConflicts,
  sameVendorReviews,
  selectReviewer,
  type ExecutionPolicy,
  type initDataSchema,
  type ProfilePin,
  type ProjectManifest,
} from '../contracts/index.ts';
import { decisionSettingsView } from '../projections/decisions.ts';
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
import { devcontourMarkers, gitFacts } from './inspect.ts';
import {
  leadHint,
  otherRuntime,
  probeRuntimes,
  usable,
  type RuntimeAvailability,
} from './runtimes.ts';
import { defaultProbe } from '../toolchains/probe.ts';
import { proposeNodePin } from '../environment/toolchain-pin.ts';

export type InitData = z.infer<typeof initDataSchema>;

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
export const projectFile = (root: string, rel: string) => {
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
  /** Ведущий: автор планов и контрактов; writer по умолчанию. */
  lead?: 'claude' | 'codex';
  writer?: 'claude' | 'codex';
  /** `auto` (по умолчанию) — `cross`, если нужные CLI доступны, иначе `same`. */
  review?: 'cross' | 'same' | 'auto';
  /** Одна модель на writer и всех reviewers. */
  model?: string;
  state?: string;
  plan?: boolean;
  /** Слой `lean` поверх профиля; в pnpm-репозитории — ещё и `dependencyStore`. */
  lean?: boolean;
  /**
   * Технические вопросы исполнителя решает ведущий (`inputPolicy.leadAnswers.technical`
   * в новой политике). Без флага — человек отвечает на все вопросы, останавливающие работу.
   */
  leadTechnicalAnswers?: boolean;
  /**
   * Кто решает после повторных отказов (`init --recovery`,
   * `--diagnose-after`, `--lead-resets`): `policy.recovery` в новой политике.
   * Сохранённая политика с другим действующим правилом — конфликт, как у
   * `leadTechnicalAnswers`.
   */
  recovery?: { mode: 'lead' | 'user'; diagnoseAfter?: number; leadResets?: number };
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
  lead: InitData['lead'];
  review: InitData['review'];
  runtimes: RuntimeAvailability[];
  warnings: InitData['warnings'];
  toolchainPin?: InitData['toolchainPin'];
  /** Почему сохранённая политика расходится с решениями (конфликт `policy.json`). */
  policyConflict?: string;
  questions: NonNullable<InitData['questions']>;
  decisions: NonNullable<InitData['decisions']>;
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
export async function gitRoot(repository: string, env: NodeJS.ProcessEnv) {
  const notRoot = (why: string): never => {
    throw new HarnessError(
      'INVALID_INPUT',
      `--repository должен быть корнем Git-репозитория: ${why}`,
      [{ path: ['--repository'], message: 'not-git-root' }],
    );
  };
  // Те же факты, что у inspectProject: один алгоритм определения корня.
  const facts = await gitFacts(repository, env);
  if ('problem' in facts)
    return notRoot(
      facts.problem === 'path-missing'
        ? facts.path + ' не существует'
        : facts.problem === 'not-directory'
          ? facts.path + ' не каталог'
          : `${facts.path} не в Git-репозитории`,
    );
  if (facts.root !== facts.path) notRoot(`${facts.path} внутри репозитория ${facts.root}`);
  if (!facts.baseSha)
    throw new HarnessError(
      'NOT_READY',
      `В репозитории ${facts.root} нет коммитов: сделайте первый`,
      [{ path: ['--repository'], message: 'no-commits' }],
    );
  return facts.root;
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
  // Слои — явный --lean или решение manifest.
  const layers = options.lean ? ['lean'] : (saved?.profile.layers ?? []);
  const profile = resolveProfile(ref, {
    repository: root,
    repositoryId: PROJECT_REPOSITORY_ID,
    ...(layers.length ? { layers } : {}),
  });
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
  const savedPolicyPath = projectFile(root, PROJECT_POLICY_PATH);
  const savedPolicy = savedPolicyPath
    ? parseFile(savedPolicyPath, executionPolicySchema, 'Политика проекта')
    : undefined;
  // 8. Ведущий: --lead, manifest, writer прежнего manifest, сохранённая
  // политика (новый checkout: project.json не под Git), окружение, --writer.
  // Молчаливого умолчания нет: неизвестный ведущий — вопрос.
  const hint = leadHint(env);
  const fromPolicy = !saved && savedPolicy ? decisionsOf(savedPolicy) : undefined;
  const lead: InitData['lead'] = options.lead
    ? { runtime: options.lead, source: 'option' }
    : saved?.lead
      ? { runtime: saved.lead, source: 'manifest' }
      : saved
        ? { runtime: saved.runtimes.writer, source: 'legacy-writer' }
        : fromPolicy?.lead
          ? { runtime: fromPolicy.lead, source: 'policy' }
          : hint && 'runtime' in hint
            ? { runtime: hint.runtime, source: 'env' }
            : options.writer
              ? { runtime: options.writer, source: 'writer' }
              : leadUnknown(Boolean(hint));
  const writer = options.writer ?? saved?.runtimes.writer ?? fromPolicy?.writer ?? lead.runtime;
  const model = options.model ?? saved?.model;
  const runtimes = await probeRuntimes(env, options.probe ?? defaultProbe);
  const byName = (r: string) => runtimes.find((x) => x.runtime === r);
  // Ревью: --review cross|same; без него — решение manifest (прежний manifest —
  // cross), сохранённой политики; иначе auto по доступности нужных CLI.
  const requested = options.review ?? (saved || savedPolicy ? undefined : 'auto');
  const review: InitData['review'] =
    requested === 'cross' || requested === 'same'
      ? { mode: requested, source: 'option' }
      : requested === 'auto'
        ? {
            // `same` — только когда собственные CLI ведущего и writer пригодны,
            // а другого вендора нет: без CLI вовсе политика остаётся cross
            // (предупреждения runtime-missing), а не закоммиченное понижение.
            mode:
              [lead.runtime, writer].every((r) => usable(byName(r))) &&
              ![otherRuntime(lead.runtime), otherRuntime(writer)].every((r) => usable(byName(r)))
                ? 'same'
                : 'cross',
            source: 'auto',
          }
        : saved?.review
          ? { mode: saved.review, source: 'manifest' }
          : saved
            ? { mode: 'cross', source: 'legacy' }
            : { mode: reviewModeOf(savedPolicy!, lead.runtime), source: 'policy' };
  const declared = packageManagerField(new Manifests(root), '.');
  // Закреплённый node: версия проекта (.nvmrc, .node-version, engines.node),
  // если она точная и установлена, иначе node, который запускает init.
  const toolchainPin = savedPolicy ? undefined : proposeNodePin(root, env);
  const generated = generatePolicy({
    ...(toolchainPin ? { toolchainPin: toolchainPin.pin } : {}),
    profile,
    lead: lead.runtime,
    writer,
    review: review.mode,
    ...(model ? { model } : {}),
    ...(declared ? { packageManager: { name: declared.name, version: declared.version } } : {}),
    ...(layers.includes('lean') &&
    profile.toolchain?.packageManagers['.'] === 'pnpm' &&
    lstat(join(root, 'pnpm-lock.yaml'))?.isFile()
      ? { dependencyStore: true }
      : {}),
    ...(options.leadTechnicalAnswers ? { leadTechnicalAnswers: true } : {}),
    ...(options.recovery ? { recovery: options.recovery } : {}),
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
    profile: { ref, pin, ...(layers.length ? { layers } : {}) },
    // Запись `harness lean` о прежних значениях политики живёт, пока слой включён.
    ...(layers.includes('lean') && saved?.lean ? { lean: saved.lean } : {}),
    // Manifest прежнего формата с теми же решениями не переписывается: без
    // новых полей он байтово тот же, и продолжение не даёт content-differs.
    ...(saved &&
    !saved.lead &&
    lead.runtime === saved.runtimes.writer &&
    review.mode === 'cross' &&
    !model
      ? {}
      : { lead: lead.runtime, review: review.mode, ...(model ? { model } : {}) }),
    runtimes: { writer, reviewer: review.mode === 'cross' ? otherRuntime(writer) : writer },
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
  // Сохранённая политика не допускает ревью для решений (план и контракт
  // ведущего, код writer): решение меняется явно, а не manifest, которому
  // политика противоречит.
  const refusedReview = savedPolicy
    ? (
        [
          ['plan', lead.runtime],
          ['contract', lead.runtime],
          ['code', writer],
        ] as const
      )
        .map(([kind, author]) => selectReviewer(savedPolicy, kind, { runtime: author }))
        .find((c) => !c.ok)
    : undefined;
  // Правило технических вопросов сохранённой политики меняется её правкой, а не
  // флагом поверх неё: иначе флаг молча не действовал бы.
  const technicalConflict =
    options.leadTechnicalAnswers && savedPolicy
      ? inputPolicyOf(savedPolicy).leadAnswers?.technical !== true
      : false;
  const effective = savedPolicy ? recoveryPolicyOf(savedPolicy) : undefined;
  const recoveryConflict =
    !!options.recovery &&
    !!effective &&
    (effective.mode !== options.recovery.mode ||
      (options.recovery.diagnoseAfter !== undefined &&
        effective.diagnoseAfter !== options.recovery.diagnoseAfter) ||
      (options.recovery.leadResets !== undefined &&
        effective.leadResets !== options.recovery.leadResets));
  if (refusedReview || technicalConflict || recoveryConflict)
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
    ...(toolchainPin
      ? {
          toolchainPin: {
            node: toolchainPin.pin.node,
            version: toolchainPin.version,
            source: toolchainPin.source,
          },
        }
      : {}),
    lead,
    review,
    runtimes,
    warnings: initWarnings(policy, lead.runtime, runtimes, join(root, HARNESS_PROJECT_DIR)),
    ...(refusedReview && !refusedReview.ok
      ? { policyConflict: refusedReview.message }
      : technicalConflict
        ? {
            policyConflict:
              '--lead-technical-answers: сохранённая политика не разрешает ведущему технические вопросы; добавьте inputPolicy.leadAnswers.technical: true в .harness/policy.json',
          }
        : recoveryConflict
          ? {
              policyConflict:
                '--recovery/--diagnose-after/--lead-resets: у сохранённой политики другое правило восстановления; поправьте поле recovery в .harness/policy.json',
            }
          : {}),
    decisions: decisionSettingsView(policy),
    questions: questionsOf(
      policy,
      savedPolicy ? 'policy' : options.leadTechnicalAnswers ? 'option' : 'default',
    ),
  };
}

/**
 * Кто отвечает на вопросы исполнителя при действующей политике — решение,
 * которое `init --plan` показывает человеку: технические вопросы решает
 * ведущий (`--lead-technical-answers`) или все — человек.
 */
function questionsOf(
  policy: ExecutionPolicy,
  source: NonNullable<InitData['questions']>['source'],
): NonNullable<InitData['questions']> {
  const lead = inputPolicyOf(policy).leadAnswers;
  const rule = leadAnswersRule(inputPolicyOf(policy));
  return {
    leadTechnical: lead?.technical === true,
    ...(lead?.maxSeverity !== undefined ? { maxSeverity: lead.maxSeverity } : {}),
    source,
    line: rule.ru,
    lineEn: rule.en,
  };
}

function leadUnknown(ambiguous: boolean): never {
  throw new HarnessError(
    'NOT_READY',
    (ambiguous
      ? 'Ведущий не определён: окружение содержит маркеры и Claude Code (CLAUDECODE), и Codex (CODEX_THREAD_ID). '
      : 'Ведущий не определён: нет --lead, сохранённого manifest и признака сессии Claude Code или Codex. ') +
      'Кто ведёт этот проект — claude или codex? Повторите init с --lead claude или --lead codex: ' +
      'writer по умолчанию — ведущий, ревью — другим CLI, если он установлен (--review).',
    [{ path: ['--lead'], message: 'lead-unknown' }],
  );
}

/**
 * Решения, записанные в сохранённой политике, когда manifest нет (новый
 * checkout: `project.json` не под Git). Ведущий — по правилу ревью плана:
 * `same-vendor-allowed` — его reviewer, иначе другой вендор. Writer — общий
 * writer ролей, если он один, иначе по правилу ревью кода.
 */
function decisionsOf(policy: ExecutionPolicy): {
  lead?: 'claude' | 'codex';
  writer?: 'claude' | 'codex';
} {
  const pick = (rule: ExecutionPolicy['review']['plan']) => {
    const r = rule.reviewer.runtime;
    if (r !== 'claude' && r !== 'codex') return undefined;
    return rule.vendor === 'same-vendor-allowed' ? r : otherRuntime(r);
  };
  const writers = [...new Set(Object.values(policy.roles).map((b) => b.writer.runtime))];
  const [only] = writers;
  const lead = pick(policy.review.plan);
  const writer =
    writers.length === 1 && (only === 'claude' || only === 'codex')
      ? only
      : pick(policy.review.code);
  return { ...(lead ? { lead } : {}), ...(writer ? { writer } : {}) };
}

/** Ревью сохранённой политики для ведущего: тот же вендор допущен — `same`. */
function reviewModeOf(policy: ExecutionPolicy, lead: 'claude' | 'codex'): 'cross' | 'same' {
  const choice = selectReviewer(policy, 'plan', { runtime: lead });
  return choice.ok && choice.sameVendor ? 'same' : 'cross';
}

/**
 * Предупреждения действующей политики: ревью тем же вендором, отсутствующий CLI,
 * хранилище зависимостей, которое не применяется, и свой store/кэш в командах
 * (`storeAdvice`; `baseDir` — каталог политики).
 */
export function initWarnings(
  policy: ExecutionPolicy,
  lead: 'claude' | 'codex',
  runtimes: RuntimeAvailability[],
  baseDir?: string,
): InitData['warnings'] {
  const warnings: InitData['warnings'] = [];
  const same = sameVendorReviews(policy, [lead]);
  if (same.length) {
    const kinds = [...new Set(same.map((s) => (s.role ? `code ${s.role}` : s.kind)))];
    const authors = [...new Set(same.map((s) => s.author))];
    const others = [
      ...new Set(
        authors.flatMap((a) => (a === 'claude' || a === 'codex' ? [otherRuntime(a)] : [])),
      ),
    ];
    warnings.push({
      code: 'review-same-vendor',
      message:
        `Ревью (${kinds.join(', ')}) выполняет runtime того же вендора, что автор (${authors.join(', ')}): ` +
        'политика разрешает это явно (vendor: same-vendor-allowed), но независимость такого ревью ниже. ' +
        `Для ревью другим вендором установите ${others.join(', ')}, выполните вход и подготовьте политику с --review cross.`,
    });
  }
  // Правило роли, которое движок не исполнит: поручения роли не будут выданы.
  for (const conflict of reviewVendorConflicts(policy))
    warnings.push({
      code: 'review-vendor-conflict',
      message: reviewVendorConflictMessage(conflict),
    });
  for (const [runtime, what] of runtimeAssignments(policy)) {
    const r = runtimes.find((x) => x.runtime === runtime);
    if (!r) continue;
    if (r.status !== 'available')
      warnings.push({
        code: 'runtime-missing',
        message:
          `CLI ${runtime} ${r.status === 'missing' ? 'не найден' : 'не ответил на --version'}, а политика назначает его (${what.join(', ')}): ` +
          `doctor назовёт это проблемой до первой попытки. Установите ${runtime} или выберите другое назначение (--review same, --lead, --writer).`,
      });
    else if (r.auth === 'missing')
      warnings.push({
        code: 'runtime-unauthenticated',
        message: `CLI ${runtime} не выполнил вход (${runtime === 'claude' ? 'claude auth status' : 'codex login status'}), а политика назначает его (${what.join(', ')}): выполните вход до запуска.`,
      });
  }
  if (baseDir !== undefined)
    for (const a of storeAdvice(policy, baseDir))
      warnings.push({
        code:
          a.code === 'DEPENDENCY_STORE_UNSUPPORTED'
            ? 'dependency-store-unsupported'
            : a.code === 'DEPENDENCY_STORE_REGISTRY'
              ? 'dependency-store-registry'
              : 'dependency-cache-path',
        message: a.message,
      });
  return warnings;
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
    lead: planned.lead,
    review: planned.review,
    runtimes: planned.runtimes,
    warnings: planned.warnings,
    ...(planned.toolchainPin ? { toolchainPin: planned.toolchainPin } : {}),
    questions: planned.questions,
    decisions: planned.decisions,
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
        ? `Сохранённая политика не подходит решениям init (ведущий ${planned.lead.runtime}, writer ${planned.manifest.runtimes.writer}): ${planned.policyConflict ?? 'ревью не назначается'}. Решение меняется явно — --lead/--writer, совпадающие с политикой, или правка политики, — а не manifest поверх неё: ${first.path}`
        : `Рабочий каталог .harness — не каталог внутри проекта: ${first.path}`,
      extra,
    );
  // 9. Toolchain действующей политики — в формате preflight `run`.
  const problems = planned.toolchain.flatMap((r) => r.problems);
  if (problems.length)
    throw new HarnessError(
      'NOT_READY',
      `Preflight toolchain: ${ruCount(problems.length, RU.problem)}; исправьте конфигурацию до запуска`,
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
    `profile: ${data.profile.id}@${data.profile.version} (${[data.manifest.profile.ref, ...(data.manifest.profile.layers ?? [])].join(' + ')})`,
    `lead: ${data.lead.runtime} (${data.lead.source})`,
    `review: ${data.review.mode} (${data.review.source})`,
    `runtimes: writer ${data.manifest.runtimes.writer}, reviewer ${data.manifest.runtimes.reviewer}`,
    ...(data.toolchainPin
      ? [
          `toolchain.node: ${data.toolchainPin.node} (${data.toolchainPin.source}) — первым в PATH gates, writer и reviewers; другой node — поправьте policy.toolchain.node`,
        ]
      : []),
    ...(data.decisions ? [`recovery: ${data.decisions.summary.ru}`] : []),
    ...(data.questions
      ? [
          `questions: ${data.questions.line}` +
            (data.questions.leadTechnical || data.questions.source === 'policy'
              ? ''
              : ' Чтобы технические вопросы решал ведущий — init --lead-technical-answers.'),
        ]
      : []),
    ...data.runtimes.map(
      (r) => `  ${r.runtime}: ${r.status}${r.version ? ' ' + r.version : ''}, auth ${r.auth}`,
    ),
    ...data.warnings.map((w) => `warning ${w.code}: ${w.message}`),
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
