// Предложения исполнителя ведущему (0.1.0-alpha.70).
//
// Задачи-продолжения вместо доработки: исполнитель сдаёт сделанное с
// доказательствами и предлагает задачу на остаток, который не входит в
// критерии этой работы. Разбор в начале попытки: «делаю / разделить /
// спросить»; предложение разделить уходит ведущему, а не исполняется.
// Принимает или отклоняет предложение в план только ведущий (или оператор),
// никогда исполнитель: принятое предложение — это пункт, который ведущий
// вносит в план обычным ревью плана; само принятие граф не меняет.

import { z } from 'zod';
import { isoTimeSchema } from './primitives.ts';

export const proposalKinds = ['follow-up', 'split'] as const;
export type ProposalKind = (typeof proposalKinds)[number];
export const proposalStatuses = ['proposed', 'accepted', 'rejected'] as const;
export const PROPOSAL_LIMITS = {
  followUps: 10,
  parts: 8,
  perWork: 50,
  acceptance: 10,
} as const;

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Задача-продолжение в ответе исполнителя. */
export const followUpTaskSchema = z.object({
  title: text(3, 180),
  goal: text(10, 4000),
  acceptance: z.array(text(3, 1500)).min(1).max(PROPOSAL_LIMITS.acceptance),
  /** Почему это не входит в критерии нынешней работы. */
  reason: text(3, 2000),
  /** Что уже сделано и чем это доказано (тест, команда, файл). */
  evidence: z.string().trim().max(4000).nullable().optional(),
});
export type FollowUpTask = z.infer<typeof followUpTaskSchema>;

/** Часть предлагаемого разделения. */
export const splitPartSchema = z.object({
  title: text(3, 180),
  goal: text(10, 4000),
  acceptance: z.array(text(3, 1500)).min(1).max(PROPOSAL_LIMITS.acceptance),
});

/**
 * Разбор исполнителя в начале попытки. `implement` — делаю; `split` —
 * работа велика или смешивает независимые части: исполнитель не пишет код и
 * предлагает части (`parts`), решает ведущий; `ask` — вопрос: тот же путь,
 * что `inputRequest`. Нет поля — `implement`.
 */
export const writerTriageSchema = z.object({
  decision: z.enum(['implement', 'split', 'ask']),
  reason: text(3, 2000),
  parts: z.array(splitPartSchema).max(PROPOSAL_LIMITS.parts).nullable().optional(),
});
export type WriterTriage = z.infer<typeof writerTriageSchema>;

/** Записанное предложение работы (`WorkState.proposals`). */
export const workProposalSchema = z.strictObject({
  id: z.string().regex(/^P-[0-9a-f]{12}$/),
  kind: z.enum(proposalKinds),
  runId: z.string().min(1).max(200),
  attempt: z.number().int().positive(),
  at: isoTimeSchema,
  title: z.string().min(1).max(180),
  goal: z.string().max(4000),
  acceptance: z.array(z.string().max(1500)).max(PROPOSAL_LIMITS.acceptance),
  reason: z.string().max(2000),
  evidence: z.string().max(4000).optional(),
  parts: z
    .array(
      z.strictObject({
        title: z.string().max(180),
        goal: z.string().max(4000),
        acceptance: z.array(z.string().max(1500)).max(PROPOSAL_LIMITS.acceptance),
      }),
    )
    .max(PROPOSAL_LIMITS.parts)
    .optional(),
  status: z.enum(proposalStatuses),
  decision: z
    .strictObject({
      by: z.enum(['lead', 'operator']),
      reason: z.string().min(3).max(2000),
      at: isoTimeSchema,
    })
    .optional(),
});
export type WorkProposal = z.infer<typeof workProposalSchema>;

/** Указание исполнителю: разбор в начале и задачи-продолжения. */
export const WRITER_TRIAGE_TEXT =
  'Triage before coding: first decide whether to implement this work order as approved (triage.decision "implement"), whether it is too big or mixes independent parts and should be split (decision "split": write no code, return completed=false and list 2–8 parts, each with a title, goal and observable acceptance criteria — the lead decides, you never re-plan yourself), or whether you must ask (decision "ask": use inputRequest). Leftovers: when every acceptance criterion of this work order is met but you found related work that is outside these criteria, return completed=true and propose it in followUpTasks (title, goal, acceptance, why it is outside this work, evidence of what is done). A follow-up task never replaces an acceptance criterion of this work order; the lead accepts or rejects it into the plan.';

/** Указание reviewer: задачи-продолжения не закрывают критерии работы. */
export const REVIEW_FOLLOW_UPS_TEXT =
  'The writer proposed follow-up tasks for leftovers (listed below). They are proposals to the lead, not part of this work: reject the commit if any acceptance criterion of this work order is deferred to a follow-up instead of being met here.';
