import { z } from 'zod';
import {
  authorSchema,
  digestSchema,
  idSchema,
  isoTimeSchema,
  relativePathSchema,
  runtimeNameSchema,
} from './primitives.ts';
import { digestOf } from './digest.ts';

/**
 * Ответы исполнителей. Runtime возвращает сырой текст/JSON (`RuntimeResponse.output`
 * — вход парсера); движок разбирает его этими схемами. Ответ вне схемы —
 * отказ ревью или реализации, а не самооценка writer.
 */

/** Находка, которую исполнитель предлагает завести отдельной работой (bug/debt). */
export const discoverySchema = z.strictObject({
  kind: z.enum(['bug', 'debt']),
  title: z.string().min(3).max(180),
  path: relativePathSchema,
  line: z.number().int().positive(),
  observation: z.string().min(10).max(3000),
  consequence: z.string().min(3).max(1500),
  reproduction: z.string().min(3).max(3000),
});

export const implementationResultSchema = z.object({
  completed: z.boolean(),
  summary: z.string(),
  discoveries: z.array(discoverySchema).max(20).default([]),
});
export type ImplementationResult = z.infer<typeof implementationResultSchema>;

export const reproductionSchema = z.object({
  property: z.string().max(200).nullable(),
  input: z.string().min(1).max(8000),
  /**
   * Класс входов, к которому относится пример: генератор или семейство, а не
   * экземпляр. Следующая попытка чинит класс; два отказа подряд по одному
   * классу — пробел приёмки (`repairDecision`). Длина не ограничивается
   * схемой: длинный ответ обрезается при записи, а не отбрасывает пример.
   */
  inputClass: z.string().nullable().optional(),
  expected: z.string().max(2000).nullable(),
  actual: z.string().max(2000).nullable(),
  command: z.array(z.string()).max(64).nullable(),
  executed: z.boolean(),
  /** runId запуска probe, на котором находка воспроизведена; `null` — гипотеза. */
  run: z.string().nullable().optional(),
});

export const reviewExecutionSchema = z.strictObject({
  commands: z
    .array(
      z.strictObject({
        command: z.string().min(1).max(12000),
        exitCode: z.number().int(),
        summary: z.string().min(1).max(4000),
      }),
    )
    .max(100),
  noCommandsReason: z.string().min(1).max(4000).nullable(),
});

/**
 * Основание перехода: не меньше трёх непробельных символов. Те же правила —
 * `pattern` wire-схемы CLI runtime (`agents/schemas.ts`): длину строки
 * structured output выразить нельзя, поэтому и Zod длину сверху не
 * ограничивает — сохраняемое основание обрезается до 4000 символов.
 */
export const FINDING_BASIS_PATTERN = '\\S[\\s\\S]*\\S[\\s\\S]*\\S';
export const FINDING_ID_PATTERN = '^[0-9a-f]{64}$';
export const findingStatuses = ['open', 'closed', 'withdrawn'] as const;
export type FindingStatus = (typeof findingStatuses)[number];

/** Состояние прежней находки в новом раунде ревью. */
export const findingTransitionSchema = z.strictObject({
  id: digestSchema,
  status: z.enum(findingStatuses),
  /** Основание: что изменилось или почему находка снята. */
  basis: z.string().regex(new RegExp(FINDING_BASIS_PATTERN), 'Основание перехода пусто'),
});

/**
 * Ответ reviewer. Принятие (`approved: true`) при любой блокирующей находке
 * — отказ; `previous` обязан назвать состояние каждой прежней открытой
 * находки этого предмета (см. `reviewIssues`).
 */
/** Основание «приёмка уже выполнена»: названные gates и что их evidence показывает. */
export const alreadySatisfiedSchema = z.strictObject({
  gates: z.array(z.string().min(1).max(200)).min(1).max(20),
  evidence: z.string().min(1).max(4000),
});
export type AlreadySatisfied = z.infer<typeof alreadySatisfiedSchema>;

export const reviewResultSchema = z.object({
  execution: reviewExecutionSchema.optional(),
  approved: z.boolean(),
  summary: z.string(),
  discoveries: z.array(discoverySchema).max(20).default([]),
  findings: z.array(
    z.object({
      severity: z.enum(['blocking', 'note']),
      message: z.string(),
      path: z.string().nullable().optional(),
      line: z.number().int().positive().nullable().optional(),
      rule: z.string().nullable().optional(),
      consequence: z.string().nullable().optional(),
      evidence: z.string().nullable().optional(),
      // Негодное воспроизведение отбрасывает только его, а не весь оплаченный вердикт.
      reproduction: reproductionSchema.nullable().optional().catch(null),
    }),
  ),
  previous: z.array(findingTransitionSchema).default([]),
  /**
   * Подтверждение reviewer, что приёмка поручения уже выполнена на базе без
   * изменений (исполнитель сдал пустой результат): gates, чьё прошедшее
   * evidence это показывает, и основание. Учитывается только для попытки без
   * изменений; там без него принятие не засчитывается (`empty-result`).
   */
  alreadySatisfied: alreadySatisfiedSchema.nullable().optional(),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;

/** Идентичность находки: предмет, класс и текст. Новый текст — новая находка. */
export const findingId = (subject: string, finding: { rule?: string | null; message: string }) =>
  digestOf({ subject, rule: finding.rule ?? null, message: finding.message });

export const reviewFindingSchema = z.strictObject({
  id: digestSchema,
  severity: z.enum(['blocking', 'note']),
  message: z.string().max(12000),
  rule: z.string().max(200).optional(),
  path: z.string().max(500).nullable().optional(),
  line: z.number().int().positive().nullable().optional(),
  status: z.enum(['open', 'closed', 'withdrawn']),
  /** Раунд, в котором находка появилась, и раунд последнего изменения статуса. */
  openedIn: z.number().int().positive(),
  changedIn: z.number().int().positive(),
  basis: z.string().max(4000).optional(),
});

/**
 * Раунд технического ревью плана (графа) или контракта. Раунды предмета
 * нумеруются подряд и не переписываются; переименование предмета не
 * начинает историю заново — предмет задаётся ID, а не заголовком.
 */
export const reviewRecordSchema = z.strictObject({
  id: z.string().min(1).max(200),
  kind: z.enum(['plan', 'contract']),
  /** ID предмета: ID графа или контракта. */
  subject: idSchema,
  /** Digest проверенного предложения: согласование относится только к нему. */
  digest: digestSchema,
  round: z.number().int().positive(),
  at: isoTimeSchema,
  approved: z.boolean(),
  summary: z.string().max(12000),
  /**
   * Автор предложения, заданный вызовом ревью (`--author`) и закреплённый за
   * предметом и digest: повтор с тем же digest и другим автором — новый
   * раунд, а не согласованный прежний.
   */
  authorRuntime: authorSchema,
  reviewerRuntime: runtimeNameSchema,
  reviewerModel: z.string().optional(),
  sameVendor: z.boolean(),
  /**
   * Digest назначения reviewer (runtime, модель, effort, профиль, правило
   * вендора) по политике на момент раунда. Раунд подтверждает предмет только
   * при том же назначении; смена reviewer политикой требует нового раунда.
   */
  reviewerBinding: digestSchema.optional(),
  /**
   * Digest закреплённого снимка контекста, который получил reviewer плана.
   * Раунд подтверждает граф только с тем же снимком: другой контекст — новый
   * раунд, а не прежнее одобрение.
   */
  contextDigest: digestSchema.optional(),
  /** Все находки предмета на момент раунда: новые и прежние с их статусами. */
  findings: z.array(reviewFindingSchema),
  artifact: z.string().max(1000),
});
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

/**
 * Согласованность ответа reviewer с историей предмета: approved без
 * блокирующих находок и без открытых блокирующих прежних, у каждой прежней
 * открытой находки названо состояние, ссылки только на известные находки.
 */
export function reviewIssues(
  result: ReviewResult,
  previousOpen: { id: string; severity: 'blocking' | 'note' }[],
): string[] {
  const issues: string[] = [];
  const known = new Map(previousOpen.map((f) => [f.id, f]));
  const named = new Set<string>();
  for (const t of result.previous) {
    if (!known.has(t.id)) issues.push('Состояние неизвестной находки: ' + t.id);
    if (named.has(t.id)) issues.push('Состояние находки названо дважды: ' + t.id);
    named.add(t.id);
  }
  for (const f of previousOpen)
    if (!named.has(f.id)) issues.push('Не названо состояние прежней находки ' + f.id);
  const stillBlocking = result.previous.some(
    (t) => t.status === 'open' && known.get(t.id)?.severity === 'blocking',
  );
  if (result.approved && (result.findings.some((f) => f.severity === 'blocking') || stillBlocking))
    issues.push('approved при блокирующей находке');
  return issues;
}

/* ------------------------------------------------------------------ */
/* История находок ревью кода (docs/review-protocol.md)                */
/* ------------------------------------------------------------------ */

/** Дополнительных вызовов reviewer при ошибке протокола, когда политика их не задаёт. */
export const DEFAULT_REVIEW_PROTOCOL_RETRIES = 1;

/** Причины ошибки протокола ответа reviewer. */
export const protocolIssueReasons = [
  'schema',
  'unknown',
  'duplicate',
  'not-open',
  'missing',
  'approved-with-blocking',
] as const;
export type ProtocolIssueReason = (typeof protocolIssueReasons)[number];

/** Причина ошибки протокола: путь поля ответа (`previous[0].id`), класс и пояснение. */
export const protocolIssueSchema = z.strictObject({
  path: z.string().max(300),
  reason: z.enum(protocolIssueReasons),
  message: z.string().max(1000),
});
export type ProtocolIssue = z.infer<typeof protocolIssueSchema>;

/**
 * Сведения раунда ревью кода в evidence (аддитивное поле `reviewRound`).
 * Валидный раунд несёт применённые переходы; невалидный — только причины и
 * историю не меняет.
 */
export const reviewRoundSchema = z.strictObject({
  version: z.literal(1),
  /** Область истории: поручение и репозиторий. */
  scope: digestSchema,
  /** Номер раунда области; невалидный вызов несёт номер раунда, который не состоялся. */
  round: z.number().int().positive(),
  /** Номер вызова reviewer в логическом ревью (область, фаза, SHA) и предел вызовов. */
  call: z.number().int().positive(),
  calls: z.number().int().positive().max(3),
  /**
   * `valid` — раунд применён; `invalid` — ошибка протокола (засчитывается в
   * повторы); `unsafe` — reviewer изменил дерево или HEAD: вердикт не
   * применяется и протокольным повтором не считается.
   */
  protocol: z.enum(['valid', 'invalid', 'unsafe']),
  /** Открытые находки, состояние которых reviewer должен был назвать. */
  expected: z.array(digestSchema).max(500),
  issues: z.array(protocolIssueSchema).max(50).optional(),
  transitions: z
    .array(
      z.strictObject({
        id: digestSchema,
        from: z.enum(findingStatuses),
        to: z.enum(findingStatuses),
        basis: z.string().max(4000),
      }),
    )
    .max(500)
    .optional(),
  /** Согласованная постановка поручения на момент раунда. */
  spec: digestSchema.optional(),
  /**
   * `legacy` — адаптер reviewer без протокола переходов
   * (`RuntimeCapabilities.reviewProtocol`): переходы не требовались, находки
   * записаны открытыми, закрытия не выдумываются. Нет поля — строгий раунд.
   */
  mode: z.enum(['strict', 'legacy']).optional(),
});
export type ReviewRound = z.infer<typeof reviewRoundSchema>;

/** Область истории находок ревью кода: поручение в репозитории. */
export const codeReviewScope = (repositoryId: string, workId: string) =>
  digestOf({ kind: 'code-review', repositoryId, workId });

interface FindingOrigin {
  runId: string;
  phase: 'candidate' | 'integration';
  sha: string;
  round: number;
}

/** ID находки, выданный controller при записи валидного раунда. */
export const codeFindingId = (
  scope: string,
  origin: FindingOrigin,
  index: number,
  finding: { severity: string; message: string },
) =>
  digestOf({
    v: 1,
    scope,
    runId: origin.runId,
    phase: origin.phase,
    sha: origin.sha,
    round: origin.round,
    index,
    severity: finding.severity,
    message: finding.message,
  });

/** Детерминированный ID находки записи alpha.5 (без ID) — из неизменяемого origin. */
export const legacyFindingId = (
  scope: string,
  evidence: { id: string; runId: string; phase: string; sha: string },
  index: number,
  finding: { severity: string; message: string },
) =>
  digestOf({
    v: 'legacy-1',
    scope,
    evidence: evidence.id,
    runId: evidence.runId,
    phase: evidence.phase,
    sha: evidence.sha,
    index,
    severity: finding.severity,
    message: finding.message,
  });

export interface FindingTransitionRecord {
  round: number;
  runId: string;
  phase: 'candidate' | 'integration';
  sha: string;
  from: FindingStatus;
  to: FindingStatus;
  basis: string;
}

/** Находка в истории ревью кода поручения. */
export interface CodeFinding {
  id: string;
  severity: string;
  message: string;
  path: string | null;
  line: number | null;
  status: FindingStatus;
  origin: FindingOrigin & { evidence: string; spec?: string; legacy?: true };
  openedIn: number;
  changedIn: number;
  basis?: string;
  transitions: FindingTransitionRecord[];
}

export interface CodeReviewHistory {
  scope: string;
  /** Номер последнего состоявшегося раунда области (0 — раундов не было). */
  round: number;
  findings: CodeFinding[];
}

/** Минимум сведений попытки, из которых собирается история (структурно — `AttemptState`). */
export interface HistoryAttempt {
  id: string;
  status: string;
  failureKind?: string | undefined;
  evidence: {
    id: string;
    runId: string;
    kind: 'test' | 'review';
    phase: 'candidate' | 'integration';
    sha: string;
    passed: boolean;
    findings?:
      | {
          severity: string;
          message: string;
          path?: string | null | undefined;
          line?: number | null | undefined;
          id?: string | undefined;
        }[]
      | undefined;
    reviewRound?: ReviewRound | undefined;
  }[];
}

/**
 * История находок области по evidence попыток поручения (в порядке записи).
 * Применяются только валидные раунды; невалидные вызовы историю не меняют.
 * Записи alpha.5 без `reviewRound`: находки отклонившего ревью открыты с
 * детерминированно восстановленным ID.
 */
export function codeReviewHistory(attempts: HistoryAttempt[], scope: string): CodeReviewHistory {
  const byId = new Map<string, CodeFinding>();
  let round = 0;
  for (const a of attempts)
    for (const e of a.evidence) {
      if (e.kind !== 'review') continue;
      const r = e.reviewRound;
      if (!r) {
        // Запись прежней версии: свой раунд, находки отказа — открытые.
        round++;
        if (e.passed) continue;
        (e.findings ?? []).forEach((f, index) => {
          const id = legacyFindingId(scope, e, index, f);
          if (byId.has(id)) return;
          byId.set(id, {
            id,
            severity: f.severity,
            message: f.message,
            path: f.path ?? null,
            line: f.line ?? null,
            status: 'open',
            origin: {
              runId: e.runId,
              phase: e.phase,
              sha: e.sha,
              round,
              evidence: e.id,
              legacy: true,
            },
            openedIn: round,
            changedIn: round,
            transitions: [],
          });
        });
        continue;
      }
      if (r.scope !== scope || r.protocol !== 'valid') continue;
      round = Math.max(round, r.round);
      for (const t of r.transitions ?? []) {
        const f = byId.get(t.id);
        if (!f) continue;
        f.status = t.to;
        f.changedIn = r.round;
        f.basis = t.basis;
        f.transitions.push({
          round: r.round,
          runId: e.runId,
          phase: e.phase,
          sha: e.sha,
          from: t.from,
          to: t.to,
          basis: t.basis,
        });
      }
      for (const f of e.findings ?? []) {
        if (!f.id || byId.has(f.id)) continue;
        byId.set(f.id, {
          id: f.id,
          severity: f.severity,
          message: f.message,
          path: f.path ?? null,
          line: f.line ?? null,
          status: 'open',
          origin: {
            runId: e.runId,
            phase: e.phase,
            sha: e.sha,
            round: r.round,
            evidence: e.id,
            ...(r.spec ? { spec: r.spec } : {}),
          },
          openedIn: r.round,
          changedIn: r.round,
          transitions: [],
        });
      }
    }
  return { scope, round, findings: [...byId.values()] };
}

/** Начатые вызовы reviewer попытки по фазе: записи учёта вызовов (до invoke). */
export interface StartedReviewCalls {
  /** Число начатых вызовов (запись учёта создаётся до внешнего вызова). */
  count: number;
  /** Начало первого из них, epoch ms. */
  firstStartMs?: number;
  /** Время, уже израсходованное этими вызовами (завершёнными и прерванными), мс. */
  spentMs: number;
}

/**
 * Состояние логического ревью (область, фаза, SHA) по записанному состоянию:
 * сколько вызовов reviewer уже начато, когда начался первый и сколько времени
 * израсходовано. Начатый вызов — запись учёта вызова, сделанная до внешнего
 * invoke (`measuredInvoke`): прерванный вызов (controller убит до ответа)
 * засчитывается так же, как завершённый. Логическое ревью продолжается через
 * попытки, прерванные до вердикта (истёкшие, отказ окружения), и закрывается
 * валидным вердиктом или иным завершением попытки (в том числе остановкой
 * `review-protocol`). Записи без учёта вызовов (прежние версии) считаются по
 * невалидным evidence.
 */
export function logicalReview(
  attempts: (HistoryAttempt & { candidateSha?: string; integrationSha?: string })[],
  scope: string,
  phase: 'candidate' | 'integration',
  sha: string,
  started: (attemptId: string) => StartedReviewCalls,
) {
  let used = 0;
  let spentMs = 0;
  let firstStartMs: number | undefined;
  let runs: string[] = [];
  const reset = () => {
    used = 0;
    spentMs = 0;
    firstStartMs = undefined;
    runs = [];
  };
  for (const a of attempts) {
    const at = phase === 'candidate' ? a.candidateSha : a.integrationSha;
    if (at !== sha) continue;
    const reviews = a.evidence.filter(
      (e) =>
        e.kind === 'review' && e.phase === phase && e.sha === sha && e.reviewRound?.scope === scope,
    );
    if (reviews.some((e) => e.reviewRound?.protocol === 'valid')) {
      reset();
      continue;
    }
    const calls = started(a.id);
    const invalid = reviews.filter((e) => e.reviewRound?.protocol === 'invalid').length;
    used += Math.max(calls.count, invalid);
    spentMs += calls.spentMs;
    runs.push(a.id);
    if (calls.firstStartMs !== undefined)
      firstStartMs = Math.min(firstStartMs ?? calls.firstStartMs, calls.firstStartMs);
    // Прерванная до вердикта попытка (рестарт) продолжает то же логическое
    // ревью; любое другое завершение его закрывает.
    const interrupted =
      a.status === 'expired' || (a.status === 'failed' && a.failureKind === 'environment');
    if (a.status !== 'active' && !interrupted) reset();
  }
  /** `runs` — попытки, вызовы которых входят в это логическое ревью. */
  return { used, spentMs, runs, ...(firstStartMs !== undefined ? { firstStartMs } : {}) };
}

/** Путь поля ответа в виде `previous[0].id`. */
export const issuePath = (path: readonly PropertyKey[]) =>
  path.map((p, i) => (typeof p === 'number' ? `[${p}]` : (i ? '.' : '') + String(p))).join('') ||
  '(response)';

export type CodeReviewVerdict =
  | { valid: false; issues: ProtocolIssue[]; result?: ReviewResult }
  | {
      valid: true;
      result: ReviewResult;
      round: number;
      transitions: { id: string; from: FindingStatus; to: FindingStatus; basis: string }[];
      /** Находки ответа с выданными ID, по порядку ответа. */
      findings: (ReviewResult['findings'][number] & { id: string })[];
    };

/**
 * Проверка ответа reviewer целиком против истории области — до любой
 * записи. Каждая прежняя открытая находка названа ровно одним переходом;
 * закрытые/снятые — только явным повторным открытием; неизвестный, чужой и
 * повторный ID — ошибка; `approved` при blocking, оставшейся открытой, или при
 * новой blocking — ошибка. Невалидный ответ ничего не меняет.
 */
export function checkCodeReview(
  output: unknown,
  history: CodeReviewHistory,
  origin: Omit<FindingOrigin, 'round'>,
  /**
   * Адаптер без протокола переходов: ответ проверяется как в alpha.5 — без
   * прежних открытых находок (их состояние не требуется, ссылки на прежние
   * ID неизвестны). Схема и противоречивый approved — по-прежнему ошибки.
   */
  options: { legacy?: boolean } = {},
): CodeReviewVerdict {
  const parsed = reviewResultSchema.safeParse(output);
  if (!parsed.success)
    return {
      valid: false,
      issues: parsed.error.issues.slice(0, 50).map((i) => ({
        path: issuePath(i.path),
        reason: 'schema' as const,
        message: i.message.slice(0, 1000),
      })),
    };
  const result = parsed.data;
  const issues: ProtocolIssue[] = [];
  const prior = options.legacy ? [] : history.findings;
  const byId = new Map(prior.map((f) => [f.id, f]));
  const named = new Set<string>();
  const transitions: { id: string; from: FindingStatus; to: FindingStatus; basis: string }[] = [];
  result.previous.forEach((t, i) => {
    const known = byId.get(t.id);
    if (named.has(t.id)) {
      issues.push({
        path: `previous[${i}].id`,
        reason: 'duplicate',
        message: 'Состояние находки названо повторно: ' + t.id,
      });
      return;
    }
    named.add(t.id);
    if (!known) {
      issues.push({
        path: `previous[${i}].id`,
        reason: 'unknown',
        message: 'Находки с этим ID нет в истории поручения: ' + t.id,
      });
      return;
    }
    if (known.status !== 'open' && t.status !== 'open') {
      issues.push({
        path: `previous[${i}].status`,
        reason: 'not-open',
        message: `Находка ${t.id} уже ${known.status}; допустимо только повторное открытие (open)`,
      });
      return;
    }
    transitions.push({ id: t.id, from: known.status, to: t.status, basis: t.basis.slice(0, 4000) });
  });
  for (const f of prior)
    if (f.status === 'open' && !named.has(f.id))
      issues.push({
        path: 'previous',
        reason: 'missing',
        message: 'Не названо состояние открытой находки ' + f.id,
      });
  const blockingOpen = transitions.some(
    (t) => t.to === 'open' && byId.get(t.id)?.severity === 'blocking',
  );
  if (result.approved && (result.findings.some((f) => f.severity === 'blocking') || blockingOpen))
    issues.push({
      path: 'approved',
      reason: 'approved-with-blocking',
      message: 'approved: true при открытой blocking-находке',
    });
  if (issues.length) return { valid: false, issues: issues.slice(0, 50), result };
  const round = history.round + 1;
  return {
    valid: true,
    result,
    round,
    transitions,
    findings: result.findings.map((f, index) => ({
      ...f,
      id: codeFindingId(history.scope, { ...origin, round }, index, f),
    })),
  };
}
