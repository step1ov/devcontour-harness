import { FAILURE_PATHS_RELEASE_TEXT } from '../engine/prompt.ts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  HarnessError,
  REVIEW_ITEMS_LIMIT,
  WORKSPACE_OWNER,
  codeReview,
  codeReviewRecordSchema,
  digestOf,
  findingId,
  gatesDataSchema,
  issuePath,
  mcpEnvironment,
  reviewIssues,
  reviewResultSchema,
  roleBinding,
  selectReviewer,
  type Author,
  type CodeReviewGates,
  type CodeReviewRecord,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type RuntimeName,
  type ReviewPassesRecord,
  blockingOf,
  mergePasses,
  needsSecondPass,
  refutePromptText,
  refuteResultSchema,
  reviewPassModeOf,
} from '../contracts/index.ts';
import { refuteOutputSchema, reviewOutputSchema } from '../agents/schemas.ts';
import { redactInspection } from '../agents/inspect.ts';
import { chooseCheckoutRoot, checkoutPath } from '../environment/checkout-root.ts';
import { credentialPaths } from '../environment/isolation.ts';
import { executionEnvironment } from '../environment/lifecycle.ts';
import { git, hostGitArgs } from '../environment/process.ts';
import { redactDeep, redactThenClip } from '../environment/redaction.ts';
import type { Engine } from '../engine/engine.ts';
import { TaskFailure } from '../engine/failure.ts';
import { measuredInvoke } from '../engine/measured.ts';
import { GATES_RESULT_FILE } from './gates-check.ts';

/** Git без обрезки вывода: stdout целиком (Buffer), предел — `maxBuffer`. */
export const rawGit = (cwd: string, args: string[], options: { maxBuffer?: number } = {}) =>
  new Promise<Buffer>((resolveOut, reject) => {
    execFile(
      'git',
      hostGitArgs(cwd, args),
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        timeout: REVIEW_CODE_GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
      },
      (error, stdout) => {
        if (error) reject(error instanceof Error ? error : new Error('git: отказ'));
        else resolveOut(stdout);
      },
    );
  });

/** Прерванный обзор (сигнал, предел времени) — отказ CANCELLED; раунд не записывается. */
const cancelled = (signal: AbortSignal) =>
  new HarnessError(
    'CANCELLED',
    'Обзор кода прерван: ' +
      (signal.reason instanceof Error ? signal.reason.message : 'предел времени'),
  );

/** Предел одного вызова git подготовки обзора (diff, имена). */
const REVIEW_CODE_GIT_TIMEOUT_MS = 120_000;

/** Предел diff обзора: больший — отказ до вызова (сузьте диапазон). */
export const REVIEW_CODE_DIFF_LIMIT = 4 * 1024 * 1024;

export interface CodeReviewInput {
  /** Репозиторий политики; нет — единственный. */
  repositoryId?: string;
  /** Роль, правило ревью кода которой выбирает reviewer; нет — единственная роль репозитория. */
  role?: string;
  /** Автор кода; нет — writer роли. */
  author?: Author;
  /** База (SHA или ref): diff — от merge-base(base, head). */
  base: string;
  /** Проверяемый коммит (SHA, ref или `HEAD`). */
  head: string;
  signal?: AbortSignal;
}

export interface CodeReviewContext {
  engine: Engine;
  policy: ExecutionPolicy;
  adapters: Partial<Record<RuntimeName, RuntimeAdapter>>;
  stateDir: string;
  repoPath(path: string): string;
  checkoutRoot?: string;
  environment?: NodeJS.ProcessEnv;
}

const rev = async (path: string, ref: string, flag: string, repositoryId: string) => {
  try {
    return await git(path, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
  } catch {
    throw new HarnessError('NOT_FOUND', `Коммит ${ref} не найден в ${repositoryId}`, [
      { path: [flag], message: ref },
    ]);
  }
};

/** Репозиторий обзора: названный или единственный в политике; иначе отказ. */
export function reviewRepository(policy: ExecutionPolicy, repositoryId: string | undefined) {
  const repo = repositoryId
    ? policy.repositories.find((r) => r.id === repositoryId)
    : policy.repositories.length === 1
      ? policy.repositories[0]
      : undefined;
  if (!repo)
    throw new HarnessError(
      repositoryId ? 'NOT_FOUND' : 'INVALID_INPUT',
      repositoryId
        ? 'Репозиторий не объявлен в политике: ' + repositoryId
        : `В политике несколько репозиториев (${policy.repositories.map((r) => r.id).join(', ')}): назовите --repository`,
    );
  return repo;
}

/**
 * Ревью выпуска поверх обзора ветки (`harness review-release`): договор
 * выпуска, прочитанный на проверяемом head, — разделы запроса reviewer.
 */
export interface ReleaseContract {
  /**
   * Договор выпуска на head: текст для запроса (обрезан пределами запроса) и
   * digest ПОЛНОГО текста — основание раунда (правка за пределом обрезки —
   * тоже другой договор).
   */
  contract(at: { path: string; head: string }): Promise<{ prompt: string; digest: string }>;
}

/** Роли, применимые к репозиторию: общие и свои роли репозитория. */
const rolesOf = (policy: ExecutionPolicy, repositoryId: string) => [
  ...new Set([
    ...Object.keys(policy.roles),
    ...Object.keys(policy.repositories.find((r) => r.id === repositoryId)?.roles ?? {}),
  ]),
];

/**
 * Последний итог `harness gates --sha` на этом коммите в каталоге состояния
 * (`gates-at/<id>/result.json`): самый поздний по времени записи. Файлы вне
 * схемы и чужих SHA пропускаются.
 */
export async function gatesEvidenceFor(
  stateDir: string,
  repositoryId: string,
  sha: string,
): Promise<CodeReviewGates | undefined> {
  const root = join(stateDir, 'gates-at');
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return undefined;
  }
  let best: CodeReviewGates | undefined;
  for (const name of names) {
    const file = join(root, name, GATES_RESULT_FILE);
    let raw: unknown;
    try {
      if (!(await stat(file)).isFile()) continue;
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const at = (raw as { at?: unknown } | null)?.at;
    const parsed = gatesDataSchema.safeParse((raw as { data?: unknown } | null)?.data);
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || !parsed.success) continue;
    const d = parsed.data;
    if (d.repositoryId !== repositoryId || d.sha !== sha) continue;
    const candidate: CodeReviewGates = {
      id: d.id,
      sha: d.sha,
      passed: d.passed,
      at: new Date(Date.parse(at)).toISOString(),
      gates: d.gates.slice(0, 200).map((g) => ({ gate: g.gate, status: g.status })),
      logs: d.logs.slice(0, 1000),
    };
    if (!best || Date.parse(candidate.at) > Date.parse(best.at)) best = candidate;
  }
  return best;
}

/**
 * Технический обзор уже написанной ветки (`harness review-code`). Reviewer
 * выбирается правилом ревью кода роли по вендору автора (отказ до вызова),
 * читает diff `merge-base(base, head)..head` в отдельном рабочем дереве на
 * `head` (только чтение) и отвечает по схеме ревью. Раунд записывается в
 * `code-reviews` каталога состояния; поручения, попытки и target ref не
 * меняются: это не приёмка.
 */
export function reviewCode(
  ctx: CodeReviewContext,
  input: CodeReviewInput,
): Promise<CodeReviewRecord> {
  return reviewBranch(ctx, input);
}

/**
 * Общий ход обзора ветки и ревью выпуска (`release`): выбор reviewer,
 * diff, раунды предмета с переходами прежних находок, запись в `code-reviews`.
 * Ревью выпуска отличается предметом (репозиторий, роль, SHA базы — head
 * выпуска движется с каждой принятой работой), вступлением запроса и
 * договором выпуска в нём.
 */
export async function reviewBranch(
  ctx: CodeReviewContext,
  input: CodeReviewInput,
  release?: ReleaseContract,
): Promise<CodeReviewRecord> {
  const { engine, policy } = ctx;
  const label = release ? 'review-release' : 'review-code';
  const repo = reviewRepository(policy, input.repositoryId);
  const roles = rolesOf(policy, repo.id);
  const role = input.role ?? (roles.length === 1 ? roles[0] : undefined);
  if (!role)
    throw new HarnessError(
      'INVALID_INPUT',
      `${label}: у репозитория ${repo.id} несколько ролей (${roles.join(', ')}): назовите --role`,
      [{ path: ['--role'], message: roles.join(', ') }],
    );
  const binding = roleBinding(policy, role, repo.id);
  if (!binding)
    throw new HarnessError('NOT_FOUND', `Роль ${role} не описана в политике`, [
      { path: ['--role'], message: role },
    ]);
  const author: Author = input.author ?? binding.writer.runtime;
  const choice = selectReviewer(policy, 'code', { runtime: author }, role, repo.id);
  if (!choice.ok) throw new HarnessError(choice.code, choice.message);
  const rule = codeReview(policy, role, repo.id);
  const profile = choice.reviewer.toolProfile;
  const reviewerBinding = digestOf({
    reviewer: choice.reviewer,
    vendor: rule.vendor,
    ...(profile ? { tools: policy.toolProfiles[profile] ?? null } : {}),
  });

  const path = ctx.repoPath(repo.path);
  const base = await rev(path, input.base, '--base', repo.id);
  const head = await rev(path, input.head, '--head', repo.id);
  let mergeBase: string;
  try {
    mergeBase = await git(path, 'merge-base', base, head);
  } catch {
    throw new HarnessError('INVALID_INPUT', `У ${input.base} и ${input.head} нет общего предка`, [
      { path: ['--base'], message: input.base },
    ]);
  }
  // Полный вывод git без обрезки (`git()` хранит только хвост stdout) и имена
  // без C-кавычек и обрезки пробелов (`-z`).
  const names = (await rawGit(path, ['diff', '--name-only', '-z', '--no-renames', mergeBase, head]))
    .toString('utf8')
    .split('\0')
    .filter((n) => n.length > 0);
  // Выпуск без изменений в репозитории (все работы уже выполнены — alpha.69):
  // ревью выпуска идёт против текущего дерева, diff пуст и назван так.
  if (!names.length && !release)
    throw new HarnessError(
      'INVALID_INPUT',
      `${label}: между merge-base(${input.base}, ${input.head}) и ${input.head} нет изменений`,
      [{ path: ['--head'], message: input.head }],
    );
  let diff: string;
  try {
    diff = (
      await rawGit(path, ['diff', '--no-ext-diff', '--no-textconv', mergeBase, head], {
        maxBuffer: REVIEW_CODE_DIFF_LIMIT,
      })
    ).toString('utf8');
  } catch (error) {
    if ((error as { code?: string }).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
    throw new HarnessError(
      'INVALID_INPUT',
      `${label}: diff больше предела ${REVIEW_CODE_DIFF_LIMIT} байт; сузьте диапазон`,
      [{ path: ['--base'], message: input.base }],
    );
  }
  const commits = Number(await git(path, 'rev-list', '--count', `${mergeBase}..${head}`));
  const subject = release
    ? digestOf({ kind: 'release-review', repositoryId: repo.id, role, base })
    : digestOf({
        kind: 'code-review',
        repositoryId: repo.id,
        role,
        base: input.base,
        head: input.head,
      });
  const contract = release ? await release.contract({ path, head }) : undefined;
  const contextDigest = contract?.digest;

  const rounds = engine.read((v) =>
    v
      .locals('code-reviews', WORKSPACE_OWNER)
      .map((r) => r.value)
      .filter((r) => r.subject === subject)
      .sort((a, b) => a.round - b.round),
  );
  const last = rounds.at(-1);
  // Итог gates на head — часть основания раунда: новый итог (в том числе
  // провал после прежнего PASS) — новый раунд, а не прежнее одобрение.
  const gates = await gatesEvidenceFor(ctx.stateDir, repo.id, head);
  if (
    last &&
    last.approved &&
    last.head === head &&
    last.mergeBase === mergeBase &&
    last.authorRuntime === author &&
    last.reviewerBinding === reviewerBinding &&
    last.gates?.id === gates?.id &&
    last.contextDigest === contextDigest
  )
    return last;
  const before = last?.round ?? 0;
  const maxRounds = policy.maxAttempts * 2;
  if (before >= maxRounds)
    throw new HarnessError(
      'ATTEMPTS_EXHAUSTED',
      `Исчерпаны раунды обзора ${repo.id} ${input.base}..${input.head} (${maxRounds})`,
    );
  const adapter = ctx.adapters[choice.reviewer.runtime];
  if (!adapter)
    throw new HarnessError(
      'RUNTIME_UNAVAILABLE',
      'Runtime не подключён: ' + choice.reviewer.runtime,
    );
  const lastFindings = last?.findings ?? [];
  const open = lastFindings.filter((f) => f.status === 'open');
  if (new Set(open.map((f) => f.id)).size > REVIEW_ITEMS_LIMIT)
    throw new HarnessError(
      'REVIEW_PROTOCOL_INVALID',
      `Обзор ${repo.id}: открытых находок больше предела ${REVIEW_ITEMS_LIMIT}; нового вызова нет`,
    );
  const round = before + 1;

  const tools = profile ? policy.toolProfiles[profile] : undefined;
  let execution: ReturnType<typeof executionEnvironment>;
  try {
    execution = executionEnvironment(
      [
        policy.environment,
        repo.environment,
        tools?.environment,
        ...(tools ? [mcpEnvironment(tools)] : []),
      ],
      {},
      ctx.environment ?? process.env,
      policy.toolchain,
    );
  } catch (error) {
    throw new HarnessError(
      'RUNTIME_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
    );
  }

  const id = `${release ? 'RR' : 'RC'}-${randomUUID()}`;
  const stateDir = resolve(ctx.stateDir);
  const dir = join(stateDir, label, id);
  await mkdir(dir, { recursive: true });
  const repos = policy.repositories.map((r) => ctx.repoPath(r.path));
  const hidden = [...new Set([stateDir, ...repos])];
  // Рабочее дерево на head — вне дерева репозитория, как у `harness gates`.
  const placement = chooseCheckoutRoot({
    stateDirs: [stateDir],
    repositories: repos,
    hidden: [...hidden, ...credentialPaths()],
    ...(ctx.checkoutRoot ? { configured: ctx.checkoutRoot } : {}),
  });
  const trees = checkoutPath(placement, dir, repo.id, label, id);
  const cwd = join(trees, 'worktree');
  await mkdir(dirname(cwd), { recursive: true });

  const prompt = [
    release
      ? 'You independently review a release before it is declared done: the accepted target of all works of this release. Do not edit files. Every work already passed its own gates and per-attempt review; your job is the release as a whole against the RELEASE CONTRACT below: the orders and their acceptance criteria, the briefs, the owner answers and answer documents, and the deploy topology. Check that what the tests exercised is what production will run: production routing and environment (gateway/proxy configs, production env files, public URLs of media, uploads and API) must route every user-visible path the works added, not only the API port the tests called directly. A missing or inconsistent production route, env value or deploy step is a blocking finding. Report concrete findings with path, line, rule, consequence and evidence.'
      : 'You independently review an already written branch: code written outside the harness. Do not edit files. This is a technical review, not acceptance. Reject missing tests, weakened tests or checks, policy changes and unsafe changes. Report concrete findings with path, line, rule, consequence and evidence.',
    `Role: ${role}. Repository: ${repo.id}. Author: ${author}. Review subject round ${round}.`,
    `Base ${input.base} (${base}); merge base ${mergeBase}; head ${input.head} (${head}); ${commits} commits, ${names.length} files. The working directory is a detached checkout of head.`,
    gates
      ? `Gates run by the controller on head (harness gates ${gates.id}, ${gates.at}): ` +
        JSON.stringify({ passed: gates.passed, gates: gates.gates })
      : 'No controller gate results are recorded for head; gates were not run by the harness for this review.',
    open.length
      ? 'Previous open findings. For each, report its state in `previous` (closed, open or withdrawn) with a concrete basis: ' +
        JSON.stringify(open.map((f) => ({ id: f.id, severity: f.severity, message: f.message })))
      : '',
    contract?.prompt ?? '',
    release ? FAILURE_PATHS_RELEASE_TEXT : '',
    'Report execution.commands or an empty list with execution.noCommandsReason. Findings need a message; use null where a field does not apply.',
    names.length
      ? 'Exact diff to review:\n' + diff
      : 'There are no changes between the release base and head in this repository (the release changed nothing here): review the accepted tree at head against the release contract and approve only if it already satisfies every criterion.',
    'No secrets in output. Explain actions and evidence, not private reasoning.',
  ]
    .filter(Boolean)
    .join('\n\n');
  await writeFile(join(dir, 'prompt.txt'), prompt);

  const signal = input.signal ?? AbortSignal.timeout(policy.runTimeoutMs + 5000);
  let added = false;
  let response: Awaited<ReturnType<typeof measuredInvoke>>;
  // Reviewer только читает: изменённое им дерево (файлы, HEAD) — отказ раунда,
  // проверяется до уборки дерева.
  let mutated: string | undefined;
  let passes: ReviewPassesRecord | undefined;
  try {
    await git(path, 'worktree', 'add', '--detach', cwd, head);
    added = true;
    response = await measuredInvoke(
      engine,
      adapter,
      {
        callId: randomUUID(),
        task: 'review-code',
        binding: choice.reviewer,
        cwd,
        prompt,
        outputSchema: reviewOutputSchema,
        session: { kind: 'fresh' },
        sandbox: {
          mode: policy.isolation.mode,
          writable: [],
          denied: hidden,
          ...(placement.root ? { checkouts: [placement.root] } : {}),
          readable: [cwd, ...repos.map((r) => join(r, '.git'))],
          network: { domains: policy.isolation.domains },
        },
        timeoutMs: policy.runTimeoutMs,
        env: Object.fromEntries(
          Object.entries(execution.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        artifactDir: dir,
        secrets: [...(execution.redact.secrets ?? [])],
      },
      signal,
      { repositoryId: repo.id, subjectId: subject, subjectKind: 'other', stage: 'code-review' },
    ).catch((error: unknown) => {
      if (signal.aborted) throw cancelled(signal);
      if (error instanceof TaskFailure && error.kind === 'budget')
        throw new HarnessError('BUDGET_EXHAUSTED', error.message);
      throw error;
    });
    const dirty = await git(
      cwd,
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--ignored',
    ).catch(() => '(git status не ответил)');
    const now = await git(cwd, 'rev-parse', 'HEAD').catch(() => '');
    if (dirty || now !== head)
      mutated = `reviewer изменил рабочее дерево обзора${now !== head ? ' (HEAD сдвинут)' : ''}`;
    // Второй проход приёмки выпуска (alpha.70, умолчание `always`): свежий
    // вызов reviewer опровергает блокирующие находки и ищет пропущенные —
    // в своём detached-дереве head: его изменения не трогают первый проход.
    if (release && response.status === 'ok' && !mutated) {
      const first = reviewResultSchema.safeParse(response.output);
      const choice2 = reviewPassModeOf(policy.review.passes, { kind: 'release' });
      if (first.success && !reviewIssues(first.data, open).length) {
        const blocking = blockingOf(first.data.findings);
        const record0 = {
          mode: choice2.mode,
          source: choice2.source,
          first: blocking.length,
          confirmed: blocking.length,
          refuted: [],
          missed: 0,
          overturned: false,
        } satisfies Omit<ReviewPassesRecord, 'status'>;
        if (
          !needsSecondPass(choice2.mode, {
            approved: first.data.approved,
            blocking: blocking.length,
          })
        )
          passes = choice2.mode === 'off' ? undefined : { ...record0, status: 'skipped' };
        else {
          const refuteCwd = cwd + '-refute';
          let refute: Awaited<ReturnType<typeof measuredInvoke>> | undefined;
          let refuteDirty = false;
          // Уборка дерева второго прохода — на любом исходе, и при отмене или
          // исчерпанном бюджете (ревью 3).
          try {
            refute = await git(path, 'worktree', 'add', '--detach', refuteCwd, head)
              .then(() =>
                measuredInvoke(
                  engine,
                  adapter,
                  {
                    callId: randomUUID(),
                    task: 'review-refute',
                    binding: choice.reviewer,
                    cwd: refuteCwd,
                    prompt: prompt + '\n\n' + refutePromptText(blocking, choice2.mode),
                    outputSchema: refuteOutputSchema,
                    session: { kind: 'fresh' },
                    sandbox: {
                      mode: policy.isolation.mode,
                      writable: [],
                      denied: hidden,
                      ...(placement.root ? { checkouts: [placement.root] } : {}),
                      readable: [refuteCwd, ...repos.map((r) => join(r, '.git'))],
                      network: { domains: policy.isolation.domains },
                    },
                    timeoutMs: policy.runTimeoutMs,
                    env: Object.fromEntries(
                      Object.entries(execution.env).filter(
                        (e): e is [string, string] => e[1] !== undefined,
                      ),
                    ),
                    artifactDir: join(dir, 'refute'),
                    secrets: [...(execution.redact.secrets ?? [])],
                  },
                  signal,
                  {
                    repositoryId: repo.id,
                    subjectId: subject,
                    subjectKind: 'other',
                    stage: 'code-review-refute',
                  },
                ),
              )
              .catch((error: unknown) => {
                if (signal.aborted) throw cancelled(signal);
                if (error instanceof TaskFailure && error.kind === 'budget')
                  throw new HarnessError('BUDGET_EXHAUSTED', error.message);
                return undefined;
              });
            // Дерево второго прохода проверяется до уборки (ревью 2) — с index
            // controller, так что флаги index дерева изменений не прячут; то же
            // правило, что у ревью попытки: без игнорируемых файлов (ревью 3).
            refuteDirty =
              !!refute &&
              (!!(await git(refuteCwd, 'status', '--porcelain', '--untracked-files=all').catch(
                () => 'unknown',
              )) ||
                (await git(refuteCwd, 'rev-parse', 'HEAD').catch(() => '')) !== head);
          } finally {
            await git(path, 'worktree', 'remove', '--force', refuteCwd).catch(() => undefined);
            // Дерево создано выше этим вызовом.
            await rm(refuteCwd, { recursive: true, force: true }).catch(() => undefined);
          }
          const parsed2 =
            refute?.status === 'ok' && !refuteDirty
              ? refuteResultSchema.safeParse(refute.output)
              : undefined;
          if (!parsed2?.success)
            passes = {
              ...record0,
              status: 'failed',
              reason: refuteDirty
                ? 'reviewer изменил своё дерево'
                : refute
                  ? refute.status !== 'ok'
                    ? 'второй вызов: ' + refute.status
                    : 'ответ второго прохода вне схемы'
                  : 'второй вызов не выполнен',
            };
          else {
            const reopened = first.data.previous.some(
              (t) =>
                t.status === 'open' &&
                lastFindings.find((f) => f.id === t.id)?.severity === 'blocking',
            );
            const merged = mergePasses(
              { approved: first.data.approved, findings: first.data.findings, reopened },
              parsed2.data,
              choice2.mode,
            );
            response = {
              ...response,
              output: {
                ...first.data,
                approved: merged.approved,
                findings: merged.findings,
              },
            };
            passes = {
              ...record0,
              status: 'ran',
              confirmed: merged.confirmed,
              refuted: merged.refuted.map((r) => ({
                message: execution.redact(r.message).slice(0, 4000),
                basis: execution.redact(r.basis).slice(0, 4000),
              })),
              missed: merged.missed,
              overturned: !first.data.approved && merged.approved,
            };
          }
        }
      }
    }
  } finally {
    if (added) await git(path, 'worktree', 'remove', '--force', cwd).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    if (trees !== dir) await rmdir(trees).catch(() => undefined);
  }
  if (signal.aborted) throw cancelled(signal);
  if (response.status !== 'ok')
    throw new HarnessError(
      'RUNTIME_UNAVAILABLE',
      `Обзор кода: ${response.status}${response.diagnostics.reason ? ': ' + response.diagnostics.reason : ''}`,
    );
  const parsed = reviewResultSchema.safeParse(response.output);
  const issue = parsed.error?.issues[0];
  const issues = [
    ...(parsed.success
      ? reviewIssues(parsed.data, open)
      : [
          execution
            .redact(`Ответ ревью вне схемы: ${issuePath(issue?.path ?? [])}: ${issue?.message}`)
            .slice(0, 500),
        ]),
    ...(mutated ? [mutated] : []),
  ];
  // Как ревью плана (docs/review-protocol.md, §8): ответ применяется только
  // целиком валидным; иначе раунд неодобрен, прежние находки не меняются.
  const applied = parsed.success && !issues.length ? parsed.data : undefined;
  const transitions = new Map((applied?.previous ?? []).map((t) => [t.id, t]));
  const reported = (applied?.findings ?? []).map((f) => ({ ...f, id: findingId(subject, f) }));
  const findings: CodeReviewRecord['findings'] = [
    ...lastFindings.map((f) => {
      const t = transitions.get(f.id);
      if (f.status === 'open' && t)
        return {
          ...f,
          status: t.status,
          changedIn: round,
          basis: execution.redact(t.basis).slice(0, 4000),
        };
      if (f.status !== 'open' && reported.some((r) => r.id === f.id))
        return { ...f, status: 'open' as const, changedIn: round, basis: 'найдена снова' };
      return f;
    }),
    ...reported
      .filter((f) => !lastFindings.some((p) => p.id === f.id))
      .map((f) => ({
        id: f.id,
        severity: f.severity,
        message: execution.redact(f.message).slice(0, 12000),
        ...(f.rule ? { rule: execution.redact(f.rule).slice(0, 200) } : {}),
        path: f.path ? execution.redact(f.path).slice(0, 500) : null,
        line: f.line ?? null,
        status: 'open' as const,
        openedIn: round,
        changedIn: round,
      })),
  ];
  const record: CodeReviewRecord = codeReviewRecordSchema.parse({
    id,
    kind: release ? 'release' : 'code',
    acceptance: false,
    subject,
    repositoryId: repo.id,
    role,
    // Свободный текст — маска до обрезки: обрезка до маски (`redactDeep` ниже)
    // оставляла бы префикс секрета.
    refs: {
      base: redactThenClip(input.base, 500, execution.redact),
      head: redactThenClip(input.head, 500, execution.redact),
    },
    base,
    head,
    mergeBase,
    files: names.slice(0, 500).map((n) => redactThenClip(n, 1000, execution.redact)),
    filesTotal: names.length,
    commits,
    diffDigest: digestOf(diff),
    ...(contextDigest ? { contextDigest } : {}),
    round,
    at: new Date().toISOString(),
    // Одобрение — и по итоговым находкам: повторно открытая блокирующая
    // находка (тот же текст, сообщённый заметкой) раунд не одобряет.
    approved:
      parsed.success &&
      parsed.data.approved &&
      !issues.length &&
      !findings.some((f) => f.status === 'open' && f.severity === 'blocking'),
    summary: redactThenClip(
      (parsed.success ? parsed.data.summary : 'Ответ ревью вне схемы') +
        (issues.length ? ' / ' + issues.join('; ') : ''),
      12000,
      execution.redact,
    ),
    authorRuntime: author,
    reviewerRuntime: choice.reviewer.runtime,
    ...(response.model ? { reviewerModel: response.model } : {}),
    sameVendor: choice.sameVendor,
    reviewerBinding,
    ...(gates ? { gates } : {}),
    ...(passes ? { passes } : {}),
    findings,
    artifact: join(dir, 'review.json'),
  });
  const artifact = redactDeep(
    { response: parsed.success ? parsed.data : null, issues, inspection: null },
    execution.redact,
  );
  await writeFile(
    record.artifact,
    JSON.stringify(
      {
        ...artifact,
        inspection: response.inspection
          ? redactInspection(response.inspection, execution.redact)
          : null,
      },
      null,
      2,
    ),
  );
  // Сохраняемое представление — после маскировки, проверенное схемой: поля
  // уже замаскированы до обрезки, повторная маскировка их не удлиняет.
  const saved = codeReviewRecordSchema.parse(redactDeep(record, execution.redact));
  engine.host.store.transact('findings.recorded', (tx) => {
    // Нумерация раундов предмета — подряд: параллельный обзор того же предмета
    // не записывает второй раунд с тем же номером.
    const taken = tx
      .locals('code-reviews', WORKSPACE_OWNER)
      .some((r) => r.value.subject === subject && r.value.round === round);
    if (taken)
      throw new HarnessError(
        'REVISION_CONFLICT',
        `Раунд ${round} обзора уже записан параллельным вызовом`,
      );
    tx.putLocal('code-reviews', WORKSPACE_OWNER, saved.id, saved);
  });
  return saved;
}
