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
      const group = job
        ? outlookOf(v, work.graphId, job.repairs ?? 0, options, control)
        : new Map<string, Outlook>();
      // Готовая работа ждёт предпосылку, на которой движок остановит задание.
      const waitingOn =
        work.status === 'ready'
          ? work.order.dependsOn.filter((d) => {
              const dep = v.work(d);
              return dep && dep.status !== 'done' && (!job || group.get(d) === 'stop');
            })
          : [];
      const outlook: Outlook | undefined = !job
        ? 'stop'
        : waitingOn.length
          ? 'stop'
          : group.get(work.id);
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
          ...(waitingOn.length ? { waitingOn } : {}),
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
  // Сломанные работы без эпизода — в порядке repairDecision. Первая без повтора
  // останавливает задание: ей и всем за ней — stop.
  const queue = (first: Outlook, rest: Outlook) => {
    let stopped = false;
    works
      .filter((w) => w.status === 'failed' && !w.recovery)
      .forEach((w, i) => {
        const outlook =
          !stopped && retryable(w, repairsUsed + i) ? (i === 0 ? first : rest) : 'stop';
        if (outlook === 'stop') stopped = true;
        out.set(w.id, outlook);
      });
  };
  const retryable = (w: (typeof works)[number], used: number) => {
    const rule = repairPolicy[w.failureKind ?? 'unknown'];
    const identical = w.failureFingerprint
      ? v.attempts(w.id).filter((a) => a.failureFingerprint === w.failureFingerprint).length
      : rule.repeats + 1;
    return (
      rule.action === 'retry' &&
      identical - 1 < rule.repeats &&
      w.attempt < options.maxAttempts &&
      used < options.repairBudget
    );
  };
  // Эпизоды разбираются раньше repair, по порядку; первый, на котором движок не
  // может действовать сам, завершает задание.
  const blocking = (w: (typeof works)[number]) => {
    const r = w.recovery!;
    switch (r.status) {
      case 'awaiting-lead':
        // Те же условия, что у резервирования разбора: пауза человека, бюджет,
        // попытки поручения, уже потраченный вызов.
        return (
          (control.paused && control.pauseReason === 'operator') ||
          repairsUsed >= options.repairBudget ||
          w.attempt >= options.maxAttempts ||
          r.calls >= 1
        );
      case 'retry':
        // Разрешённый повтор, который очередь не выдаст: пауза, удержание, бюджет.
        // Для упавшей работы — до engine.retry, для готовой — уже после него.
        return (
          (w.status === 'failed' || w.status === 'ready') &&
          (control.paused || Boolean(w.hold) || Boolean(w.budgetBlock))
        );
      case 'retrying':
        // Повтор уже упал, а эпизод не закрыт: автоматического шага нет.
        return w.status === 'failed';
      case 'applying':
        return false;
      default:
        return true;
    }
  };
  const episodes = works.filter((w) => w.recovery && w.status !== 'cancelled');
  const [episode] = episodes;
  if (episode) {
    if (blocking(episode)) return all('stop');
    all('wait');
    if (episode.recovery!.status === 'retry' && episode.status === 'failed')
      out.set(episode.id, 'retry');
    if (episodes.slice(1).some(blocking)) {
      for (const w of works) if (w.id !== episode.id) out.set(w.id, 'stop');
      return out;
    }
    // Остальные сломанные ждут эпизод; известная остановка среди них — stop.
    queue('wait', 'wait');
    return out;
  }
  const decision = repairDecision(v, works, {
    budgetLeft: options.repairBudget - repairsUsed,
    maxAttempts: options.maxAttempts,
  });
  if (!decision || decision.action === 'stop') return all('stop');
  queue('retry', 'retry');
  return out;
}
