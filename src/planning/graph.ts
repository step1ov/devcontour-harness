import type { CodedIssue } from '../contracts/errors.ts';
import type { SourceRef, WorkGraph } from '../contracts/index.ts';
import type { PlanningFacts, StandalonePlanDraft } from '../contracts/planning.ts';
import { notImplemented } from './stub.ts';

/** Draft → WorkGraph (OP-PLAN-04): digests контрактов из фактов, не выдумываются. */
export function draftToGraph(
  draft: StandalonePlanDraft,
  options: {
    graphId: string;
    source: SourceRef;
    facts: PlanningFacts;
    idOf?: (key: string) => string;
  },
): { graph?: WorkGraph; issues: CodedIssue[] } {
  void draft;
  void options;
  return notImplemented('draftToGraph');
}
