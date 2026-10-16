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

/** Состояние прежней находки в новом раунде ревью. */
export const findingTransitionSchema = z.strictObject({
  id: digestSchema,
  status: z.enum(['open', 'closed', 'withdrawn']),
  /** Основание: что изменилось или почему находка снята. */
  basis: z.string().min(3).max(4000),
});

/**
 * Ответ reviewer. Принятие (`approved: true`) при любой блокирующей находке
 * — отказ; `previous` обязан назвать состояние каждой прежней открытой
 * находки этого предмета (см. `reviewIssues`).
 */
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
