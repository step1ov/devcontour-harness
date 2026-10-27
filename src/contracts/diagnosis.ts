import { z } from 'zod';
import { errorCodes, type ErrorCode } from './errors.ts';

// Литералы повторяют `projections/*`: проекции не импортируют zod-контракты
// (браузер), а тест сверяет оба перечня поэлементно.
export const diagnosisActors = ['controller', 'lead', 'user'] as const;
export const diagnosisActions = [
  'none',
  'wait',
  'review-plan',
  'retry',
  'diagnose-failure',
  'reset-attempts',
  'raise-budget',
  'replan-dependents',
  'recovery-decision',
  'user-decision',
  'resume-queue',
  'fix-environment',
  'fix-access',
] as const;
export const diagnosisCauses = [
  'provider-auth',
  'environment',
  'timeout',
  'stale-base',
  'empty-result',
  'unfinished',
  'scope-violation',
  'gate',
  'review',
  'review-protocol',
  'merge',
  'cancelled',
  'budget',
  'needs-lead',
  'unknown',
  'runtime-missing',
  'controller-busy',
  'operator-pause',
  'approval-required',
  'not-ready',
] as const;
export const diagnosisPhases = [
  'preflight',
  'claim',
  'implementation',
  'gates',
  'review',
  'integration',
  'delivery',
] as const;

/** Объяснение остановки: код, причина, фаза, кто действует и что допустимо. */
export const stopDiagnosisSchema = z.strictObject({
  code: z.enum(Object.keys(errorCodes) as [ErrorCode, ...ErrorCode[]]),
  cause: z.enum(diagnosisCauses),
  phase: z.enum(diagnosisPhases),
  actor: z.enum(diagnosisActors).nullable(),
  action: z.enum(diagnosisActions),
  /** Описание решения движка о повторе; диагностика сама ничего не планирует. */
  retryPlanned: z.boolean(),
  message: z.string().max(2000),
  evidence: z
    .array(
      z.strictObject({
        kind: z.enum(['attempt', 'evidence', 'event', 'doctor']),
        id: z.string(),
        sha: z.string().optional(),
      }),
    )
    .max(20),
  workId: z.string().optional(),
  runId: z.string().optional(),
});
