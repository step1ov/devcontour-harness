import type { z } from 'zod';
import type { executionPolicySchema, ResolvedProfile } from '../contracts/index.ts';
import { notImplemented } from '../projections/stub.ts';

export type DetectedProfile =
  | { id: 'npm-ci' | 'pnpm-frozen'; lockfile: string }
  | { problem: 'stack-ambiguous' | 'stack-unsupported'; files: string[] };

/** Профиль стека по lockfile корня. */
export function detectProfile(root: string): DetectedProfile {
  void root;
  return notImplemented('detectProfile');
}

export interface GeneratedPolicy {
  input: z.input<typeof executionPolicySchema>;
  text: string;
  shadowed: string[];
}
/** Политика проекта из профиля: пользователь JSON не пишет. */
export function generatePolicy(input: {
  profile: ResolvedProfile;
  writer: 'claude' | 'codex';
  packageManager?: { name: string; version?: string };
}): GeneratedPolicy {
  void input;
  return notImplemented('generatePolicy');
}
