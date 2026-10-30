import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HarnessError,
  REVIEW_ITEMS_LIMIT,
  WORKSPACE_OWNER,
  contextDigest,
  findingId,
  mcpEnvironment,
  reviewIssues,
  issuePath,
  reviewResultSchema,
  selectReviewer,
  type Author,
  type ContextSnapshot,
  type ContractDocument,
  type ExecutionPolicy,
  type ReviewRecord,
  type RuntimeAdapter,
  type RuntimeName,
} from '../contracts/index.ts';
import { reviewOutputSchema } from '../agents/schemas.ts';
import { redactInspection } from '../agents/inspect.ts';
import { executionEnvironment } from '../environment/lifecycle.ts';
import { redactDeep } from '../environment/redaction.ts';
import type { CallMeta } from '../engine/budget.ts';
import type { Engine } from '../engine/engine.ts';
import { TaskFailure } from '../engine/failure.ts';
import { measuredInvoke } from '../engine/measured.ts';
import { contextText } from '../engine/prompt.ts';

/**
 * Раунд технического ревью плана или контракта — одна реализация для
 * standalone `Harness.review` и для хоста, который ведёт движок поверх своего
 * хранилища. Хост задаёт предмет (ID, digest, автор), свои разделы запроса и
 * рабочий каталог reviewer; harness выбирает reviewer по правилу вендора
 * политики (отказ до вызова), вызывает его под учётом бюджета, требует
 * состояние каждой прежней открытой находки и записывает раунд в историю.
 * Тот же digest и назначение, уже одобренные последним раундом, — тот же
 * раунд без вызова модели.
 */
export interface TechnicalReviewInput {
  kind: 'plan' | 'contract';
  /** ID предмета: граф или контракт. */
  subject: string;
  /** Digest предмета, к которому относится одобрение. */
  digest: string;
  author: Author;
  /** Разделы запроса хоста: что проверять и сам документ. */
  instructions: string[];
  /** Закреплённый контекст плана: его digest — часть основания раунда. */
  context?: ContextSnapshot;
  /** Контракт, закрепляемый одобренным раундом по digest. */
  contract?: ContractDocument;
  /** Репозиторий, окружение которого получает reviewer (по умолчанию — первый). */
  repositoryId?: string;
  /** Рабочий каталог reviewer (только чтение). */
  cwd: string;
  /** Каталог артефактов раунда. */
  artifactDir: string;
  /** Пути, закрытые reviewer (состояние controller). */
  denied: string[];
  /** Дополнительно читаемые пути. */
  readable?: string[];
  /** Учёт вызова: предмет и группа. */
  meta: Omit<CallMeta, 'stage'> & { stage?: string };
  /** Предел раундов предмета; нет — без предела. */
  maxRounds?: number;
  /**
   * Раунды предмета, которые хост провёл до harness и хранит сам. Учитываются,
   * только пока у предмета нет раундов в движке: нумерация продолжается после
   * них, а находки последнего из них — прежние открытые находки, состояние
   * которых reviewer обязан назвать. Это история, а не одобрение: у прежних
   * раундов нет digest, назначения и PASS, и ничего из этого не выводится.
   */
  history?: {
    rounds: number;
    findings: { severity: 'blocking' | 'note'; message: string; rule?: string }[];
  };
  /** Источник значений окружения (по умолчанию `process.env`). */
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export async function technicalReview(
  engine: Engine,
  policy: ExecutionPolicy,
  adapters: Partial<Record<RuntimeName, RuntimeAdapter>>,
  input: TechnicalReviewInput,
): Promise<ReviewRecord> {
  const { kind, subject, digest, context } = input;
  const contextKey = context ? contextDigest(context) : undefined;
  const rounds = engine.reviews(kind, subject);
  const last = rounds.at(-1);
  const prior = rounds.length ? undefined : input.history;
  // Раунды подряд: последний номер — число проведённых, с прежними хоста.
  const before = last ? last.round : (prior?.rounds ?? 0);
  // Находки последнего раунда: движка или, до первого раунда в нём, прежнего хоста.
  const lastFindings: ReviewRecord['findings'] =
    last?.findings ??
    (prior?.rounds
      ? prior.findings.map((f) => ({
          id: findingId(subject, f),
          severity: f.severity,
          message: f.message.slice(0, 12000),
          ...(f.rule ? { rule: f.rule.slice(0, 200) } : {}),
          path: null,
          line: null,
          status: 'open' as const,
          openedIn: prior.rounds,
          changedIn: prior.rounds,
        }))
      : []);
  // Назначение reviewer по текущей политике: прежний раунд подтверждает предмет
  // только при том же назначении; недопустимый автор — отказ до вызова.
  const choice = selectReviewer(policy, kind, { runtime: input.author });
  if (!choice.ok) throw new HarnessError(choice.code, choice.message);
  const binding = engine.reviewerBinding(kind, input.author)!;
  if (
    last &&
    last.digest === digest &&
    last.authorRuntime === input.author &&
    last.approved &&
    last.reviewerBinding === binding &&
    last.contextDigest === contextKey
  )
    return last;
  if (input.maxRounds !== undefined && before >= input.maxRounds)
    throw new HarnessError('ATTEMPTS_EXHAUSTED', `Исчерпаны раунды ревью ${kind} ${subject}`);
  const adapter = adapters[choice.reviewer.runtime];
  if (!adapter)
    throw new HarnessError(
      'RUNTIME_UNAVAILABLE',
      'Runtime не подключён: ' + choice.reviewer.runtime,
    );
  const open = lastFindings.filter((f) => f.status === 'open');
  // Ответ обязан назвать каждую открытую находку, а `previous` ограничен:
  // такой раунд не одобрить, и вызов модели был бы оплачен впустую.
  if (open.length > REVIEW_ITEMS_LIMIT)
    throw new HarnessError(
      'REVIEW_PROTOCOL_INVALID',
      `Ревью ${kind} ${subject}: открытых находок ${open.length}, предел раунда ревью ${REVIEW_ITEMS_LIMIT}; нового вызова нет`,
    );
  const round = before + 1;
  const dir = input.artifactDir;
  await mkdir(dir, { recursive: true });
  const repo =
    policy.repositories.find((r) => r.id === input.repositoryId) ?? policy.repositories[0]!;
  // Окружение reviewer — с профилем инструментов его назначения; недостающий секрет — отказ до вызова.
  const tools = choice.reviewer.toolProfile
    ? policy.toolProfiles[choice.reviewer.toolProfile]
    : undefined;
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
      input.environment ?? process.env,
    );
  } catch (error) {
    throw new HarnessError(
      'RUNTIME_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
    );
  }
  const prompt = [
    ...input.instructions,
    `Subject: ${kind} ${subject}, digest ${digest}, round ${round}. Author: ${input.author}.`,
    context ? `Pinned context snapshot ${contextKey}.\n\n` + contextText(context) : '',
    open.length
      ? 'Previous open findings. For each, report its state in `previous` (closed, open or withdrawn) with a concrete basis: ' +
        JSON.stringify(open.map((f) => ({ id: f.id, severity: f.severity, message: f.message })))
      : '',
    'Report execution.commands or an empty list with execution.noCommandsReason. Findings need a message; use null where a field does not apply.',
  ]
    .filter(Boolean)
    .join('\n\n');
  await writeFile(join(dir, 'prompt.txt'), prompt);
  // Вызов под учётом: бюджет проверяется до вызова, расход закрепляется за предметом.
  const response = await measuredInvoke(
    engine,
    adapter,
    {
      callId: randomUUID(),
      task: kind === 'plan' ? 'review-plan' : 'review-contract',
      binding: choice.reviewer,
      cwd: input.cwd,
      prompt,
      outputSchema: reviewOutputSchema,
      session: { kind: 'fresh' },
      sandbox: {
        mode: policy.isolation.mode,
        writable: [],
        denied: input.denied,
        readable: [input.cwd, ...(input.readable ?? [])],
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
    { ...input.meta, stage: input.meta.stage ?? kind + '-review' },
  ).catch((error: unknown) => {
    if (error instanceof TaskFailure && error.kind === 'budget')
      throw new HarnessError('BUDGET_EXHAUSTED', error.message);
    throw error;
  });
  if (response.status !== 'ok')
    throw new HarnessError(
      'RUNTIME_UNAVAILABLE',
      `Ревью ${kind}: ${response.status}${response.diagnostics.reason ? ': ' + response.diagnostics.reason : ''}`,
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
  // Ответ применяется только целиком валидным (docs/review-protocol.md, §8):
  // невалидный не закрывает прежних находок и не заводит новых — раунд
  // записывается неодобренным с причинами, история остаётся прежней.
  const applied = parsed.success && !issues.length ? parsed.data : undefined;
  const transitions = new Map((applied?.previous ?? []).map((t) => [t.id, t]));
  const reported = (applied?.findings ?? []).map((f) => ({ ...f, id: findingId(subject, f) }));
  const findings: ReviewRecord['findings'] = [
    ...lastFindings.map((f) => {
      const t = transitions.get(f.id);
      if (f.status === 'open' && t)
        return { ...f, status: t.status, changedIn: round, basis: t.basis.slice(0, 4000) };
      // Повторно найденная закрытая/снятая находка открывается снова, а не
      // теряется как дубликат по ID.
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
  const record: ReviewRecord = {
    id: `RV-${kind}-${subject}-${round}`,
    kind,
    subject,
    digest,
    round,
    at: new Date().toISOString(),
    approved: parsed.success && parsed.data.approved && !issues.length,
    summary:
      execution
        .redact(parsed.success ? parsed.data.summary : 'Ответ ревью вне схемы')
        .slice(0, 12000) + (issues.length ? ' / ' + issues.join('; ') : ''),
    authorRuntime: input.author,
    reviewerRuntime: choice.reviewer.runtime,
    ...(response.model ? { reviewerModel: response.model } : {}),
    sameVendor: choice.sameVendor,
    reviewerBinding: binding,
    ...(contextKey ? { contextDigest: contextKey } : {}),
    findings,
    artifact: join(dir, 'review.json'),
  };
  // Сохраняемые представления маскируются полным окружением вызова: сырой
  // структурированный ответ адаптера может нести значение секрета профиля.
  const artifact = redactDeep(
    { response: parsed.success ? parsed.data : null, issues, inspection: null },
    execution.redact,
  );
  // Inspection маскируется по полям: служебные значения не текст reviewer.
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
  // Снимок, который видел reviewer, хранится по digest: согласование этого
  // раунда делает его действующим контекстом графа.
  if (context && contextKey)
    engine.host.store.transact('run.context', (tx) =>
      tx.putLocal('context-snapshots', WORKSPACE_OWNER, contextKey, context),
    );
  return engine.recordReview(
    redactDeep(record, execution.redact),
    input.contract,
    prior?.rounds ?? 0,
  );
}
