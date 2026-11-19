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
} from '../contracts/index.ts';
import { reviewOutputSchema } from '../agents/schemas.ts';
import { redactInspection } from '../agents/inspect.ts';
import { chooseCheckoutRoot, checkoutPath } from '../environment/checkout-root.ts';
import { credentialPaths } from '../environment/isolation.ts';
import { executionEnvironment } from '../environment/lifecycle.ts';
import { git } from '../environment/process.ts';
import { redactDeep } from '../environment/redaction.ts';
import type { Engine } from '../engine/engine.ts';
import { TaskFailure } from '../engine/failure.ts';
import { measuredInvoke } from '../engine/measured.ts';
import { GATES_RESULT_FILE } from './gates-check.ts';

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
export async function reviewCode(
  ctx: CodeReviewContext,
  input: CodeReviewInput,
): Promise<CodeReviewRecord> {
  const { engine, policy } = ctx;
  const repo = input.repositoryId
    ? policy.repositories.find((r) => r.id === input.repositoryId)
    : policy.repositories.length === 1
      ? policy.repositories[0]
      : undefined;
  if (!repo)
    throw new HarnessError(
      input.repositoryId ? 'NOT_FOUND' : 'INVALID_INPUT',
      input.repositoryId
        ? 'Репозиторий не объявлен в политике: ' + input.repositoryId
        : `В политике несколько репозиториев (${policy.repositories.map((r) => r.id).join(', ')}): назовите --repository`,
    );
  const roles = rolesOf(policy, repo.id);
  const role = input.role ?? (roles.length === 1 ? roles[0] : undefined);
  if (!role)
    throw new HarnessError(
      'INVALID_INPUT',
      `review-code: у репозитория ${repo.id} несколько ролей (${roles.join(', ')}): назовите --role`,
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
  const names = (await git(path, 'diff', '--name-only', '--no-renames', mergeBase, head))
    .split('\n')
    .filter(Boolean);
  if (!names.length)
    throw new HarnessError(
      'INVALID_INPUT',
      `review-code: между merge-base(${input.base}, ${input.head}) и ${input.head} нет изменений`,
      [{ path: ['--head'], message: input.head }],
    );
  const diff = await git(path, 'diff', '--no-ext-diff', '--no-textconv', mergeBase, head);
  if (Buffer.byteLength(diff) > REVIEW_CODE_DIFF_LIMIT)
    throw new HarnessError(
      'INVALID_INPUT',
      `review-code: diff ${Buffer.byteLength(diff)} байт больше предела ${REVIEW_CODE_DIFF_LIMIT}; сузьте диапазон`,
      [{ path: ['--base'], message: input.base }],
    );
  const commits = Number(await git(path, 'rev-list', '--count', `${mergeBase}..${head}`));
  const subject = digestOf({
    kind: 'code-review',
    repositoryId: repo.id,
    role,
    base: input.base,
    head: input.head,
  });

  const rounds = engine.read((v) =>
    v
      .locals('code-reviews', WORKSPACE_OWNER)
      .map((r) => r.value)
      .filter((r) => r.subject === subject)
      .sort((a, b) => a.round - b.round),
  );
  const last = rounds.at(-1);
  if (
    last &&
    last.approved &&
    last.head === head &&
    last.mergeBase === mergeBase &&
    last.authorRuntime === author &&
    last.reviewerBinding === reviewerBinding
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
  const gates = await gatesEvidenceFor(ctx.stateDir, repo.id, head);

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
    );
  } catch (error) {
    throw new HarnessError(
      'RUNTIME_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
    );
  }

  const id = `RC-${randomUUID()}`;
  const stateDir = resolve(ctx.stateDir);
  const dir = join(stateDir, 'review-code', id);
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
  const trees = checkoutPath(placement, dir, repo.id, 'review-code', id);
  const cwd = join(trees, 'worktree');
  await mkdir(dirname(cwd), { recursive: true });

  const prompt = [
    'You independently review an already written branch: code written outside the harness. Do not edit files. This is a technical review, not acceptance. Reject missing tests, weakened tests or checks, policy changes and unsafe changes. Report concrete findings with path, line, rule, consequence and evidence.',
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
    'Report execution.commands or an empty list with execution.noCommandsReason. Findings need a message; use null where a field does not apply.',
    'Exact diff to review:\n' + diff,
    'No secrets in output. Explain actions and evidence, not private reasoning.',
  ]
    .filter(Boolean)
    .join('\n\n');
  await writeFile(join(dir, 'prompt.txt'), prompt);

  let added = false;
  let response: Awaited<ReturnType<typeof measuredInvoke>>;
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
      input.signal ?? AbortSignal.timeout(policy.runTimeoutMs + 5000),
      { repositoryId: repo.id, subjectId: subject, subjectKind: 'other', stage: 'code-review' },
    ).catch((error: unknown) => {
      if (error instanceof TaskFailure && error.kind === 'budget')
        throw new HarnessError('BUDGET_EXHAUSTED', error.message);
      throw error;
    });
  } finally {
    if (added) await git(path, 'worktree', 'remove', '--force', cwd).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    if (trees !== dir) await rmdir(trees).catch(() => undefined);
  }
  if (response.status !== 'ok')
    throw new HarnessError(
      'RUNTIME_UNAVAILABLE',
      `Обзор кода: ${response.status}${response.diagnostics.reason ? ': ' + response.diagnostics.reason : ''}`,
    );
  const parsed = reviewResultSchema.safeParse(response.output);
  const issue = parsed.error?.issues[0];
  const issues = parsed.success
    ? reviewIssues(parsed.data, open)
    : [
        execution
          .redact(`Ответ ревью вне схемы: ${issuePath(issue?.path ?? [])}: ${issue?.message}`)
          .slice(0, 500),
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
        return { ...f, status: t.status, changedIn: round, basis: t.basis.slice(0, 4000) };
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
        ...(f.rule ? { rule: f.rule.slice(0, 200) } : {}),
        path: f.path ?? null,
        line: f.line ?? null,
        status: 'open' as const,
        openedIn: round,
        changedIn: round,
      })),
  ];
  const record: CodeReviewRecord = codeReviewRecordSchema.parse({
    id,
    kind: 'code',
    acceptance: false,
    subject,
    repositoryId: repo.id,
    role,
    refs: { base: input.base.slice(0, 500), head: input.head.slice(0, 500) },
    base,
    head,
    mergeBase,
    files: names.slice(0, 500).map((n) => n.slice(0, 1000)),
    filesTotal: names.length,
    commits,
    diffDigest: digestOf(diff),
    round,
    at: new Date().toISOString(),
    approved: parsed.success && parsed.data.approved && !issues.length,
    summary:
      execution
        .redact(parsed.success ? parsed.data.summary : 'Ответ ревью вне схемы')
        .slice(0, 12000) + (issues.length ? ' / ' + issues.join('; ') : ''),
    authorRuntime: author,
    reviewerRuntime: choice.reviewer.runtime,
    ...(response.model ? { reviewerModel: response.model } : {}),
    sameVendor: choice.sameVendor,
    reviewerBinding,
    ...(gates ? { gates } : {}),
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
  const saved = redactDeep(record, execution.redact);
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
