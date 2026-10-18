import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HarnessError,
  WORKSPACE_OWNER,
  contextDigest,
  findingId,
  mcpEnvironment,
  reviewIssues,
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
  if (input.maxRounds !== undefined && rounds.length >= input.maxRounds)
    throw new HarnessError('ATTEMPTS_EXHAUSTED', `Исчерпаны раунды ревью ${kind} ${subject}`);
  const adapter = adapters[choice.reviewer.runtime];
  if (!adapter)
    throw new HarnessError(
      'RUNTIME_UNAVAILABLE',
      'Runtime не подключён: ' + choice.reviewer.runtime,
    );
  const open = (last?.findings ?? []).filter((f) => f.status === 'open');
  const round = rounds.length + 1;
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
  const issues = parsed.success ? reviewIssues(parsed.data, open) : ['Ответ ревью вне схемы'];
  const transitions = new Map((parsed.success ? parsed.data.previous : []).map((t) => [t.id, t]));
  const findings: ReviewRecord['findings'] = [
    ...(last?.findings ?? []).map((f) => {
      const t = transitions.get(f.id);
      return f.status === 'open' && t
        ? { ...f, status: t.status, changedIn: round, basis: t.basis.slice(0, 4000) }
        : f;
    }),
    ...(parsed.success ? parsed.data.findings : [])
      .map((f) => ({ ...f, id: findingId(subject, f) }))
      .filter((f) => !(last?.findings ?? []).some((p) => p.id === f.id))
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
  await writeFile(
    record.artifact,
    JSON.stringify(
      redactDeep(
        {
          response: parsed.success ? parsed.data : null,
          issues,
          inspection: response.inspection ?? null,
        },
        execution.redact,
      ),
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
  return engine.recordReview(redactDeep(record, execution.redact), input.contract);
}
