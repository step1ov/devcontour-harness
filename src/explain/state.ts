import { HarnessError } from '../contracts/errors.ts';
import { repairPolicy } from '../contracts/repair-policy.ts';
import type { WorkStatus } from '../contracts/index.ts';
import type { Harness } from '../control/harness.ts';
import { repairDecision } from '../engine/repair.ts';
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
      // Чинит только задание, которое продолжит работу: активное, по текущей
      // редакции графа и с непотраченными попытками стадии (как `claim`).
      const job = jobs.find((j) => j.id === work.graphId && h.workflows.continues(j, v));
      const outlook = job
        ? outlookOf(v, work.graphId, job.repairs ?? 0, options, control).get(work.id)
        : 'stop';
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
          ...(work.recovery ? { recovery: { status: work.recovery.status } } : {}),
        },
        maxAttempts: options.maxAttempts,
        repair: {
          sameFailureRepairs: fingerprint ? identical - 1 : repairPolicy[kind].repeats,
          groupRepairsUsed: job?.repairs ?? 0,
          groupRepairBudget: job ? options.repairBudget : 0,
          ...(outlook ? { outlook } : {}),
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

type View = Parameters<Parameters<Harness['engine']['read']>[0]>[0];
type Outlook = 'retry' | 'wait' | 'stop';

/**
 * Что сделает движок с каждой сломанной работой группы при следующей стадии —
 * тем же порядком, что `Harness.advance`: сначала первый эпизод восстановления
 * свойства (его разбор решает за группу), затем `repairDecision`; бюджет
 * восстановлений группы общий, поэтому работы дальше в очереди получают
 * повтор, только если его хватит и на тех, кто впереди.
 */
function outlookOf(
  v: View,
  graphId: string,
  repairsUsed: number,
  options: StopInputOptions,
  control: ReturnType<View['control']>,
): Map<string, Outlook> {
  const works = v.works(graphId);
  const out = new Map<string, Outlook>();
  const all = (o: Outlook) => {
    for (const w of works) out.set(w.id, o);
    return out;
  };
  const episode = works.find((w) => w.recovery && w.status !== 'cancelled');
  if (episode) {
    const status = episode.recovery!.status;
    if (status === 'awaiting-lead') {
      const blocked =
        (control.paused && control.pauseReason === 'operator') ||
        repairsUsed >= options.repairBudget;
      return all(blocked ? 'stop' : 'wait');
    }
    if (status === 'retry') {
      all('wait');
      if (episode.status === 'failed') out.set(episode.id, 'retry');
      return out;
    }
    if (status === 'applying' || status === 'retrying') return all('wait');
    return all('stop');
  }
  const decision = repairDecision(v, works, {
    budgetLeft: options.repairBudget - repairsUsed,
    maxAttempts: options.maxAttempts,
  });
  if (!decision || decision.action === 'stop') return all('stop');
  // Очередь сломанных — в порядке repairDecision; каждый повтор тратит бюджет группы.
  const broken = works.filter((w) => w.status === 'failed' && !w.recovery);
  broken.forEach((w, i) => {
    const kind = w.failureKind ?? 'unknown';
    const rule = repairPolicy[kind];
    const identical = w.failureFingerprint
      ? v.attempts(w.id).filter((a) => a.failureFingerprint === w.failureFingerprint).length
      : rule.repeats + 1;
    const retry =
      rule.action === 'retry' &&
      identical - 1 < rule.repeats &&
      w.attempt < options.maxAttempts &&
      repairsUsed + i < options.repairBudget;
    out.set(w.id, w.id === decision.workId ? 'retry' : retry ? 'retry' : 'stop');
  });
  return out;
}
