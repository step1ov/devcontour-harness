import type { CodedIssue } from '../contracts/errors.ts';
import type { CheckGap, PlanDraft, PlanningFacts } from '../contracts/planning.ts';
import { notImplemented } from './stub.ts';

/** Структурные проблемы draft (OP-PLAN-03); с `facts` — и ссылки на факты проекта. */
export function draftIssues(
  draft: PlanDraft,
  options?: { known?: readonly string[]; facts?: PlanningFacts },
): CodedIssue[] {
  void draft;
  void options;
  return notImplemented('draftIssues');
}
/** Недостающие проверки: план их подготовки, а не удаление из draft. */
export function checkGaps(draft: PlanDraft, facts: PlanningFacts): CheckGap[] {
  void draft;
  void facts;
  return notImplemented('checkGaps');
}
