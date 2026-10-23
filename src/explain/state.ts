import { HarnessError } from '../contracts/errors.ts';
import { repairPolicy } from '../contracts/repair-policy.ts';
import type { WorkStatus } from '../contracts/index.ts';
import type { Harness } from '../control/harness.ts';
import type { EvidenceLink, StopInput, StopPhase } from '../projections/stop.ts';

export interface StopInputOptions {
  maxAttempts: number;
  repairBudget: number;
  workId?: string;
}

const phaseOf: Partial<Record<WorkStatus, StopPhase>> = {
  running: 'implementation',
  verifying: 'gates',
  reviewing: 'review',
  integrating: 'integration',
};

/**
 * Входы explainStop из сохранённого состояния; ничего не пишет.
 *
 * Класс отказа — сохранённый `failureKind` (его поставил классификатор в
 * точке отказа); текст ошибки здесь не разбирается. Счётчики восстановления
 * подставляются так, как их видит `repairDecision` (h1-spec K4): без
 * отпечатка повторять нечего, без задания графа движок сам не чинит.
 * Первым идёт вход действующей роли controller, затем поручения (кроме
 * принятых) в порядке состояния.
 */
export function stopInputsOf(h: Harness, options: StopInputOptions): StopInput[] {
  const jobs = h.workflows.list().filter((j) => j.kind === 'graph');
  const now = h.engine.clock();
  return h.engine.read((v) => {
    const works = v.works();
    if (options.workId !== undefined && !works.some((w) => w.id === options.workId))
      throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + options.workId);
    const inputs: StopInput[] = [];
    const lease = v.controller();
    if (lease && lease.leaseUntil > now)
      inputs.push({
        kind: 'error',
        error: {
          code: 'CONTROLLER_BUSY',
          message: `Роль controller держит ${lease.owner} до ${new Date(lease.leaseUntil).toISOString()}.`,
        },
      });
    const control = v.control();
    for (const work of works) {
      if (work.status === 'done') continue;
      if (options.workId !== undefined && work.id !== options.workId) continue;
      const attempts = v.attempts(work.id);
      const last = attempts.filter((a) => a.status !== 'active').at(-1);
      const kind = work.failureKind ?? 'unknown';
      const fingerprint = work.failureFingerprint;
      const identical = fingerprint
        ? attempts.filter((a) => a.failureFingerprint === fingerprint).length
        : 0;
      const job = jobs.find((j) => j.id === work.graphId);
      const evidence: EvidenceLink[] = last
        ? [
            { kind: 'attempt', id: last.id },
            ...last.evidence
              .filter((e) => !e.passed)
              .map((e): EvidenceLink => ({ kind: 'evidence', id: e.id, sha: e.sha })),
          ]
        : [];
      inputs.push({
        kind: 'work',
        work: {
          id: work.id,
          status: work.status,
          attempt: work.attempt,
          ...(work.failureKind ? { failureKind: work.failureKind } : {}),
          ...(work.failure !== undefined ? { failure: work.failure } : {}),
          ...(work.hold
            ? { hold: { operation: work.hold.operation, reason: work.hold.reason } }
            : {}),
          ...(work.budgetBlock ? { budgetBlock: { reason: work.budgetBlock.reason } } : {}),
          ...(work.recovery ? { recovery: true } : {}),
        },
        maxAttempts: options.maxAttempts,
        repair: {
          sameFailureRepairs: fingerprint ? identical - 1 : repairPolicy[kind].repeats,
          groupRepairsUsed: job?.repairs ?? 0,
          groupRepairBudget: job ? options.repairBudget : 0,
        },
        control: {
          paused: control.paused,
          ...(control.pauseReason ? { pauseReason: control.pauseReason } : {}),
          ...(control.pauseFailures ? { pauseFailures: [...control.pauseFailures] } : {}),
        },
        ...(last ? { phase: phaseOf[last.phase] ?? 'claim', runId: last.id } : {}),
        evidence,
      });
    }
    return inputs;
  });
}
