import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HarnessError,
  REVIEW_ITEMS_LIMIT,
  WORKSPACE_OWNER,
  contextDigest,
  digestOf,
  findingId,
  mcpEnvironment,
  issuePath,
  acceptedLimitation,
  escalatedFindings,
  openRounds,
  reviewDispositionSchema,
  reviewResultSchema,
  selectReviewer,
  escalationQuestion,
  type Author,
  type ContextSnapshot,
  type ContractDocument,
  type ExecutionPolicy,
  type ReviewDisposition,
  type ReviewFinding,
  type ReviewRecord,
  type ReviewResult,
  type RuntimeAdapter,
  type RuntimeName,
} from '../contracts/index.ts';
import { technicalReviewOutputSchema } from '../agents/schemas.ts';
import { redactInspection } from '../agents/inspect.ts';
import { executionEnvironment } from '../environment/lifecycle.ts';
import { redactDeep, redactThenClip } from '../environment/redaction.ts';
import type { CallMeta } from '../engine/budget.ts';
import type { Engine } from '../engine/engine.ts';
import { TaskFailure } from '../engine/failure.ts';
import { measuredInvoke } from '../engine/measured.ts';
import { contextText } from '../engine/prompt.ts';

/**
 * Пределы схемы для текста находок — на уже замаскированной записи: находки
 * прежнего хоста приходят без маски, и обрезка до неё резала бы секрет.
 */
function boundedFindings(record: ReviewRecord): ReviewRecord {
  return {
    ...record,
    // Итог с причинами протокола не выходит за предел схемы.
    summary: redactThenClip(record.summary, 12000),
    findings: record.findings.map((f) => ({
      ...f,
      message: redactThenClip(f.message, 12000),
      ...(f.rule !== undefined ? { rule: redactThenClip(f.rule, 200) } : {}),
      ...(f.basis !== undefined ? { basis: redactThenClip(f.basis, 4000) } : {}),
    })),
  };
}

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
  /**
   * Решения ведущего или оператора по открытым находкам последнего раунда
   * (`accepted-limitation`, `continue`): применяются этим раундом до вызова
   * reviewer и записываются в его историю. Находку, открытую
   * `REVIEW_ESCALATION_ROUNDS` раундов подряд, решает только оператор.
   */
  dispositions?: ReviewDisposition[];
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
          // Обрезка — после маски, при записи раунда (`boundedFindings`).
          message: f.message,
          ...(f.rule ? { rule: f.rule } : {}),
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
  ) {
    // Решение записывается только раундом: одобренный предмет без нового
    // раунда его не примет, и молча потерянное решение хуже отказа.
    if (input.dispositions?.length)
      throw new HarnessError(
        'INVALID_INPUT',
        `Ревью ${kind} ${subject}: digest уже одобрен раундом ${last.round}; решения по находкам применяет следующий раунд`,
      );
    return last;
  }
  const round = before + 1;
  // Решения ведущего и оператора — до вызова: reviewer видит их результат.
  // Схема — на общей границе: библиотека получает те же правила, что CLI.
  const dispositions = (input.dispositions ?? []).map((d, i) => {
    const parsed = reviewDispositionSchema.safeParse(d);
    if (!parsed.success)
      throw new HarnessError(
        'INVALID_INPUT',
        'Решение по находке не прошло проверку схемы',
        parsed.error.issues.map((x) => ({
          path: ['dispositions', i, ...(x.path as (string | number)[])],
          message: x.message,
        })),
      );
    return parsed.data;
  });
  // Проверка решений и эскалации — до окружения reviewer (порядок отказов
  // прежний); основание решения маскируется ниже, когда маска известна.
  let decided = applyDispositions(lastFindings, dispositions, round, before);
  // Находка, открытая раундами подряд, — решение оператора, а не ещё один
  // оплаченный раунд: вызова нет, пока решения нет.
  const waiting = escalatedFindings(decided, before);
  if (waiting.length) throw escalationError(kind, subject, waiting, before);
  if (input.maxRounds !== undefined && before >= input.maxRounds)
    throw new HarnessError(
      'ATTEMPTS_EXHAUSTED',
      `Исчерпаны раунды ревью ${kind} ${subject}: ${before} из ${input.maxRounds}`,
    );
  const adapter = adapters[choice.reviewer.runtime];
  if (!adapter)
    throw new HarnessError(
      'RUNTIME_UNAVAILABLE',
      'Runtime не подключён: ' + choice.reviewer.runtime,
    );
  const open = decided.filter((f) => f.status === 'open');
  // Ответ обязан назвать каждую открытую находку по ID, а `previous` ограничен:
  // такой раунд не одобрить, и вызов модели был бы оплачен впустую.
  const named = new Set(open.map((f) => f.id)).size;
  if (named > REVIEW_ITEMS_LIMIT)
    throw new HarnessError(
      'REVIEW_PROTOCOL_INVALID',
      `Ревью ${kind} ${subject}: открытых находок ${named}, предел раунда ревью ${REVIEW_ITEMS_LIMIT}; нового вызова нет`,
    );
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
  // Основание решения — маска до обрезки: обрезка до маски оставляла бы префикс секрета.
  if (dispositions.length)
    decided = applyDispositions(lastFindings, dispositions, round, before, execution.redact);
  const prompt = [
    ...input.instructions,
    `Subject: ${kind} ${subject}, digest ${digest}, round ${round}. Author: ${input.author}.`,
    context ? `Pinned context snapshot ${contextKey}.\n\n` + contextText(context) : '',
    ...findingSections(decided, before),
    'Report execution.commands or an empty list with execution.noCommandsReason. Findings need a message; use null where a field does not apply. Give a finding a stable `rule` (its class) and a `path` (the field or file it is about) where they apply.',
  ]
    .filter(Boolean)
    .join('\n\n');
  // Сохранённый запрос маскируется: находки прежнего хоста приходят без маски.
  await writeFile(join(dir, 'prompt.txt'), execution.redact(prompt));
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
      outputSchema: technicalReviewOutputSchema,
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
  // Маска до любой обрезки: основание перехода и правило находки режутся
  // пределами схемы. Текст находки маскируется при записи (ID — по исходному
  // тексту); правило с секретом получает ID по замаскированному правилу.
  if (parsed.success) {
    for (const t of parsed.data.previous) t.basis = execution.redact(t.basis);
    for (const f of parsed.data.findings) if (f.rule) f.rule = execution.redact(f.rule);
  }
  const issue = parsed.error?.issues[0];
  const merged = parsed.success
    ? mergeTechnicalRound(decided, parsed.data, round, subject, execution.redact)
    : undefined;
  const issues = merged
    ? merged.issues
    : [
        execution
          .redact(`Ответ ревью вне схемы: ${issuePath(issue?.path ?? [])}: ${issue?.message}`)
          .slice(0, 500),
      ];
  // Ответ применяется только целиком валидным (docs/review-protocol.md, §8):
  // невалидный не закрывает прежних находок, не заводит новых и не
  // записывает решений ведущего и оператора — раунд записывается
  // неодобренным с причинами, история остаётся прежней. Счёт раундов
  // записи прежней версии замораживается: невалидный раунд его не растит.
  const findings: ReviewRecord['findings'] =
    merged && !issues.length
      ? merged.findings
      : lastFindings.map((f) =>
          f.status === 'open' && f.rounds === undefined
            ? { ...f, rounds: openRounds(f, before) }
            : f,
        );
  const notes = merged && !issues.length ? merged.notes : [];
  const record: ReviewRecord = {
    id: `RV-${kind}-${subject}-${round}`,
    kind,
    subject,
    digest,
    round,
    at: new Date().toISOString(),
    approved: parsed.success && parsed.data.approved && !issues.length,
    summary: ((suffix) =>
      (
        execution
          .redact(parsed.success ? parsed.data.summary : 'Ответ ревью вне схемы')
          .slice(0, Math.max(0, 12000 - suffix.length)) + suffix
      ).slice(0, 12000))(
      (issues.length ? ' / ' + issues.join('; ') : '') +
        (notes.length ? ' / ' + notes.join('; ') : ''),
    ),
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
    boundedFindings(redactDeep(record, execution.redact)),
    input.contract,
    prior?.rounds ?? 0,
  );
}

/**
 * Решения ведущего и оператора по открытым находкам последнего раунда:
 * `accepted-limitation` — находка принята ограничением с основанием,
 * `continue` — оператор разрешил ещё раунды после эскалации. Решение по
 * неизвестной или не открытой находке, повтор находки и решение ведущего по
 * эскалированной находке — отказ до вызова reviewer.
 */
export function applyDispositions(
  findings: ReviewRecord['findings'],
  dispositions: readonly ReviewDisposition[],
  round: number,
  lastRound: number,
  /** Маска основания решения — до обрезки до предела схемы. */
  redact?: (text: string) => string,
): ReviewRecord['findings'] {
  if (!dispositions.length) return findings;
  const byId = new Map(dispositions.map((d) => [d.finding, d]));
  if (byId.size !== dispositions.length)
    throw new HarnessError('INVALID_INPUT', 'Решение по одной находке названо дважды');
  const escalated = new Set(escalatedFindings(findings, lastRound).map((f) => f.id));
  for (const d of dispositions) {
    const f = findings.find((x) => x.id === d.finding);
    if (!f)
      throw new HarnessError('INVALID_INPUT', 'Находки нет в истории предмета: ' + d.finding, [
        { path: ['dispositions', d.finding], message: 'unknown' },
      ]);
    if (f.status !== 'open')
      throw new HarnessError(
        'INVALID_INPUT',
        `Находка ${d.finding} не открыта (${f.status}): решение не нужно`,
        [{ path: ['dispositions', d.finding], message: 'not-open' }],
      );
    if (escalated.has(f.id) && d.by !== 'operator')
      throw new HarnessError(
        'INPUT_REQUIRED',
        `Находка ${d.finding} открыта ${openRounds(f, lastRound)} раундов подряд: решение за оператором (--actor operator)`,
        [{ path: ['dispositions', d.finding], message: 'operator-decision' }],
      );
    if (d.decision === 'continue' && !escalated.has(f.id))
      throw new HarnessError(
        'INVALID_INPUT',
        `Находка ${d.finding} не ждёт решения: продолжение нужно только после эскалации`,
        [{ path: ['dispositions', d.finding], message: 'not-escalated' }],
      );
  }
  return findings.map((f) => {
    const d = byId.get(f.id);
    if (!d) return f;
    const reason = redactThenClip(d.reason, 4000, redact);
    const disposition = {
      decision: d.decision,
      by: d.by,
      reason,
      round,
      rounds: openRounds(f, lastRound),
    };
    return d.decision === 'accepted-limitation'
      ? {
          ...f,
          status: 'withdrawn' as const,
          changedIn: round,
          basis: reason,
          disposition,
        }
      : { ...f, disposition };
  });
}

/** Отказ до вызова: находки ждут решения оператора (вопрос с вариантами). */
function escalationError(
  kind: 'plan' | 'contract',
  subject: string,
  waiting: ReviewRecord['findings'],
  lastRound: number,
) {
  const q = escalationQuestion(
    kind,
    subject,
    waiting.map((f) => ({ id: f.id, rounds: openRounds(f, lastRound) })),
  );
  return new HarnessError(
    'INPUT_REQUIRED',
    `${q.question} Варианты: ${q.options.map((o) => `${o.id} — ${o.label}`).join('; ')}. Ответ: ${q.answer.replace('ID — в findings[]', 'ID — в issues[].path')}`,
    waiting.map((f) => ({
      path: ['findings', f.id],
      message: `открыта ${openRounds(f, lastRound)} раундов: ${f.message.slice(0, 300)}`,
    })),
  );
}

/** Предел истории закрытых находок в запросе reviewer. */
const HISTORY_IN_PROMPT = 50;

/**
 * Разделы запроса о находках предмета: открытые (назвать состояние),
 * принятые ограничения (не поднимать без новых доказательств) и недавняя
 * история закрытых (поднять снова — через `sameAs`).
 */
function findingSections(findings: ReviewRecord['findings'], lastRound: number): string[] {
  const open = findings.filter((f) => f.status === 'open');
  const accepted = findings.filter(acceptedLimitation);
  const closed = findings
    .filter((f) => (f.status === 'closed' || f.status === 'withdrawn') && !acceptedLimitation(f))
    .slice(-HISTORY_IN_PROMPT);
  const brief = (f: ReviewFinding) => ({
    id: f.id,
    severity: f.severity,
    message: f.message,
    ...(f.rule ? { rule: f.rule } : {}),
    ...(f.path ? { path: f.path } : {}),
  });
  return [
    open.length
      ? 'Previous open findings. For each, report its state in `previous` (closed, open or withdrawn) with a concrete basis: ' +
        JSON.stringify(open.map((f) => ({ ...brief(f), rounds: openRounds(f, lastRound) })))
      : '',
    accepted.length
      ? 'Accepted limitations (decided by the lead or the operator, with the reason). Do not report them again and do not list them in `previous`. Re-raise one only with new evidence the reason does not cover: then set `sameAs` to its id and put the new evidence in `evidence`; a re-raise without evidence is ignored: ' +
        JSON.stringify(accepted.map((f) => ({ ...brief(f), reason: f.basis ?? '' })))
      : '',
    closed.length
      ? 'Closed or withdrawn findings (history; do not list them in `previous`). If one is present again, report it with `sameAs` set to its id: ' +
        JSON.stringify(closed.map((f) => ({ ...brief(f), status: f.status })))
      : '',
    'A finding you report that is the same problem as a finding above — even in other words — must carry `sameAs` with that id; do not close the old finding and open a new one for it. Use `sameAs: null` for a new problem.',
  ];
}

/**
 * Применение валидного по схеме ответа reviewer к истории предмета
 * (docs/review-protocol.md, §8). Находка ответа поднимает прежнюю — и
 * сохраняет её ID и счёт раундов — по `sameAs`, по тому же тексту или по
 * тому же непустому пути и правилу; иначе это новая находка. Поднятая снова
 * открытая находка не требует записи в `previous`, а поднятая вопреки
 * переходу `closed`/`withdrawn` остаётся открытой. Принятое ограничение без
 * новых доказательств (`evidence`) не открывается и не блокирует одобрение.
 */
export function mergeTechnicalRound(
  prior: ReviewRecord['findings'],
  result: ReviewResult,
  round: number,
  subject: string,
  redact: (text: string) => string = (t) => t,
): { findings: ReviewRecord['findings']; issues: string[]; notes: string[] } {
  const issues: string[] = [];
  const notes: string[] = [];
  const byId = new Map(prior.map((f) => [f.id, f]));
  const reported = result.findings;
  const pathOf = (p: string | null | undefined) => (p?.trim() ? redact(p) : null);
  // Каноническая цель каждой находки ответа: прежняя находка (с тем, как
  // сопоставлена) или ID новой. Повторы одной цели — одна запись.
  const target: ({ prior: ReviewFinding; how: 'sameAs' | 'text' | 'rule' } | { id: string })[] = [];
  const targeted = new Set<string>();
  const aim = (i: number, f: ReviewFinding, how: 'sameAs' | 'text' | 'rule') => {
    target[i] = { prior: f, how };
    targeted.add(f.id);
  };
  // 1. Явная ссылка reviewer. Неизвестная — подсказка, а не ошибка протокола:
  // находка сопоставляется дальше, оплаченный вердикт цел.
  reported.forEach((r, i) => {
    if (!r.sameAs) return;
    const f = byId.get(r.sameAs);
    if (f) aim(i, f, 'sameAs');
    else notes.push(`sameAs не применён (неизвестная находка): ${r.sameAs}`);
  });
  // 2. Тот же текст: ID находки — ID прежней или её текущей формулировки.
  // Принятое ограничение подавляет повтор, поэтому тем же текстом оно
  // сопоставляется только на том же пути: на другом пути это другая находка.
  reported.forEach((r, i) => {
    if (target[i]) return;
    const id = findingId(subject, r);
    const f = prior.find(
      (p) =>
        (p.id === id || findingId(subject, p) === id) &&
        (!acceptedLimitation(p) || (p.path ?? null) === pathOf(r.path)),
    );
    if (f) aim(i, f, 'text');
  });
  // 3. Тот же непустой путь и правило: переформулировка той же находки.
  // Принятое ограничение так не сопоставляется никогда; находка, уже ставшая
  // целью другой находки ответа, — тоже (две разные находки не сливаются
  // догадкой).
  reported.forEach((r, i) => {
    if (target[i]) return;
    const rule = r.rule?.trim() ? redact(r.rule).slice(0, 200) : undefined;
    const path = pathOf(r.path);
    if (!rule || !path) return;
    const candidates = prior.filter(
      (p) => !targeted.has(p.id) && !acceptedLimitation(p) && p.rule === rule && p.path === path,
    );
    const open = candidates.filter((p) => p.status === 'open');
    const f = candidates.length === 1 ? candidates[0] : open.length === 1 ? open[0] : undefined;
    if (f) aim(i, f, 'rule');
  });
  // 4. Новые находки: ID по тексту; совпавший с прежней находкой, которую
  // текст не сопоставил (принятое ограничение на другом пути), — ID с путём.
  reported.forEach((r, i) => {
    if (target[i]) return;
    let id = findingId(subject, r);
    if (byId.has(id))
      id = digestOf({ subject, rule: r.rule ?? null, message: r.message, path: pathOf(r.path) });
    target[i] = { id };
  });

  // Группы по цели: серьёзность — блокирующая, если блокирует хоть один
  // повтор; доказательства — первые непустые; формулировка — последняя.
  type Group = { rs: (typeof reported)[number][]; how?: 'sameAs' | 'text' | 'rule' };
  const groups = new Map<string, Group>();
  reported.forEach((r, i) => {
    const t = target[i]!;
    const key = 'prior' in t ? t.prior.id : t.id;
    const g = groups.get(key) ?? { rs: [], ...('prior' in t ? { how: t.how } : {}) };
    g.rs.push(r);
    groups.set(key, g);
  });
  const severityOf = (g: Group) =>
    g.rs.some((r) => r.severity === 'blocking') ? ('blocking' as const) : ('note' as const);
  const evidenceOf = (g: Group) => g.rs.map((r) => r.evidence?.trim()).find(Boolean);
  const lastOf = (g: Group) => g.rs.at(-1)!;

  // Принятое ограничение без новых доказательств остаётся принятым.
  const ignored = new Set(
    prior
      .filter((f) => acceptedLimitation(f) && groups.has(f.id) && !evidenceOf(groups.get(f.id)!))
      .map((f) => f.id),
  );
  if (ignored.size)
    notes.push('повтор принятого ограничения без новых доказательств: ' + [...ignored].join(', '));

  // Переходы: только открытые находки, каждая — один раз; открытая, не
  // поднятая снова, обязана быть названа.
  const named = new Set<string>();
  for (const t of result.previous) {
    if (byId.get(t.id)?.status !== 'open') issues.push('Состояние неизвестной находки: ' + t.id);
    if (named.has(t.id)) issues.push('Состояние находки названо дважды: ' + t.id);
    named.add(t.id);
  }
  for (const f of prior)
    if (f.status === 'open' && !named.has(f.id) && !groups.has(f.id))
      issues.push('Не названо состояние прежней находки ' + f.id);

  const transitions = new Map(result.previous.map((t) => [t.id, t]));
  const findings: ReviewRecord['findings'] = prior.map((f) => {
    const g = groups.get(f.id);
    const t = transitions.get(f.id);
    if (g && !ignored.has(f.id)) {
      const r = lastOf(g);
      const wasOpen = f.status === 'open';
      const by = { sameAs: 'sameAs', text: 'тот же текст', rule: 'тот же путь и правило' }[g.how!];
      const basis = wasOpen
        ? t?.status === 'open'
          ? t.basis
          : `поднята снова (${by})` + (t ? `; переход ${t.status} отклонён: ${t.basis}` : '')
        : acceptedLimitation(f)
          ? `новые доказательства: ${evidenceOf(g) ?? ''}`
          : 'найдена снова';
      // Переход в открытую из иного состояния начинает счёт раундов и
      // снимает прежнее решение по находке.
      const { disposition, ...rest } = f;
      return {
        ...(wasOpen ? { ...rest, ...(disposition ? { disposition } : {}) } : rest),
        severity: severityOf(g),
        message: redact(r.message).slice(0, 12000),
        ...(r.rule?.trim() ? { rule: redact(r.rule).slice(0, 200) } : {}),
        path: r.path ?? f.path ?? null,
        line: r.line ?? f.line ?? null,
        status: 'open' as const,
        changedIn: round,
        basis: redact(basis).slice(0, 4000),
        rounds: wasOpen ? openRounds(f, round - 1) + 1 : 1,
      };
    }
    if (f.status === 'open' && t)
      return {
        ...f,
        status: t.status,
        changedIn: round,
        basis: redactThenClip(t.basis, 4000, redact),
        ...(t.status === 'open' ? { rounds: openRounds(f, round - 1) + 1 } : {}),
      };
    return f;
  });
  const added: ReviewFinding[] = [];
  for (const [id, g] of groups) {
    if (byId.has(id)) continue;
    const r = lastOf(g);
    added.push({
      id,
      severity: severityOf(g),
      message: redact(r.message).slice(0, 12000),
      ...(r.rule ? { rule: redact(r.rule).slice(0, 200) } : {}),
      path: r.path ?? null,
      line: r.line ?? null,
      status: 'open',
      openedIn: round,
      changedIn: round,
      rounds: 1,
    });
  }
  const merged = [...findings, ...added];
  // Одобрение — по итоговой истории раунда.
  if (result.approved && merged.some((f) => f.status === 'open' && f.severity === 'blocking'))
    issues.push('approved при блокирующей находке');
  return { findings: merged, issues, notes };
}

/** Предел раундов ревью плана и контракта по политике (`Harness.review`). */
export const reviewRoundCap = (policy: Pick<ExecutionPolicy, 'maxAttempts'>) =>
  policy.maxAttempts * 2;
