export interface RequirementFact {
  repositoryId: string;
  source: string;
  requirements: { id: string; text: string; digest: string }[];
}

/**
 * Host-инструкции самостоятельного CLI (T1–T6): ведущий агент сам пишет draft,
 * отдельная модель планирования не вызывается.
 */
export function standaloneInstructions(input: { requirements: RequirementFact[] }): string[] {
  return [
    'You are the lead agent and write this draft yourself: a JSON document matching schemas/plan-draft.schema.json of the installed harness package. No other model is called for planning. Check it with harness plan-check; the draft approves nothing — plan review and approval follow.',
    'Task keys become work order IDs (1–80 characters of A-Z, a-z, 0-9, _ and -). description becomes the order goal and acceptance its criteria, without surrounding whitespace: description 10–12000 characters, at most 30 acceptance items of 3–1500 characters, at most 30 contracts. Omitted writePaths mean the whole repository. A library task proves its consumers with consumers: [{ "repositoryId", "gates" }].',
    'Gates run on the candidate and integration commits of a task, never on its base. Put a new feature test in the same task as the behaviour it proves and bind it through a requirement (test gate, scenario, testId): it may fail before the implementation and must pass on the accepted commit. Never plan a task whose own gates are expected to fail.',
    'If a needed check is not configured, reference it anyway: do not drop it or replace it with a weaker gate or a typecheck. plan-check reports it in checkPlan; prepare the check (a policy gate, or a bootstrap task proven by existing gates) and verify it before the main implementation is approved. A project already failing on its base is a separate first task, not an expected red.',
    'Ask the user a short question for every real ambiguity of the goal instead of guessing; the answer goes into the brief, and a changed brief makes this draft stale.',
    ...(input.requirements.length
      ? [
          'Requirement snapshots at HEAD (copy id, source, text and digest exactly; no other requirements exist): ' +
            JSON.stringify(input.requirements),
        ]
      : []),
  ];
}
