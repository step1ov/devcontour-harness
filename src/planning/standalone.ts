import { notImplemented } from './stub.ts';

export interface RequirementFact {
  repositoryId: string;
  source: string;
  requirements: { id: string; text: string; digest: string }[];
}

/** Host-инструкции самостоятельного CLI: ведущий агент сам пишет draft. */
export function standaloneInstructions(input: { requirements: RequirementFact[] }): string[] {
  void input;
  return notImplemented('standaloneInstructions');
}
