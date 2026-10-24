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
    const pauseLifts = (group: Map<string, Outlook>) =>
      control.pauseReason === 'runtime' &&
      (control.pauseFailures ?? []).length > 0 &&
      (control.pauseFailures ?? []).every((kind) =>
        works.some(
          (w) =>
            w.status === 'failed' &&
            !w.recovery &&
            w.failureKind === kind &&
            repairPolicy[kind].blocksQueue === true &&
            group.get(w.id) === 'retry',
        ),
      );
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
      // Готовая работа ждёт предпосылку, на которой движок остановит задание:
      // сломанную без автоматического шага или саму ждущую такую (транзитивно).
      // Готовая и выдаваемая предпосылка движок не останавливает.
      const stops = (id: string, seen = new Set<string>()): boolean => {
        if (seen.has(id)) return false;
        seen.add(id);
        const dep = v.work(id);
        if (!dep || dep.status === 'done') return false;
        // Сломанная без автоматического шага.
        if (dep.status === 'failed' || dep.status === 'cancelled')
          return !job || group.get(id) === 'stop';
        // Готовая, которую движок не выдаст: эпизод (blocksClaim), бюджет
        // (budgetBlock) или исчерпанные попытки.
        if (
          dep.status === 'ready' &&
          ((dep.recovery && !['retry', 'closed'].includes(dep.recovery.status)) ||
            Boolean(dep.budgetBlock) ||
            dep.attempt >= options.maxAttempts)
        )
          return true;
        return dep.status === 'ready' && dep.order.dependsOn.some((d) => stops(d, seen));
      };
      const waitingOn = work.status === 'ready' ? work.order.dependsOn.filter((d) => stops(d)) : [];
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
          // Пауза runtime, все причины которой снимет назначенный repair группы
          // (clearFailure блокирующего класса), для остальных работ не держит выдачу.
          paused: control.paused && !(work.status !== 'failed' && pauseLifts(group)),
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
 * Что сделает движок с каждой работой группы, если каждое его автоматическое
 * действие удастся, — проходом в порядке `Harness.advance`. Сначала эпизоды
 * восстановления свойств по порядку: разбор ведущего тратит единицу общего
 * бюджета, разрешённый повтор требует свободной попытки и выдачи; первый
 * эпизод, на котором движок действовать не может, завершает задание — ему и
 * всему, что за ним, stop. Затем repair: отмена в группе останавливает его
 * целиком (как `repairDecision`); сломанные по очереди получают повтор, пока
 * хватает общего бюджета, первая без повтора останавливает остальных.
 * Обещается только то, что движок сделает без человека.
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
  for (const w of works) out.set(w.id, 'stop');
  let used = repairsUsed;
  const unclaimable = (w: (typeof works)[number]) =>
    control.paused || Boolean(w.hold) || Boolean(w.budgetBlock);
  const episodes = works.filter((w) => w.recovery && w.status !== 'cancelled');
  for (const w of episodes) {
    const r = w.recovery!;
    let step: Outlook | undefined;
    // Шаг эпизода, который ведёт к повтору, продолжает группу, только если этот
    // повтор будет выдан: afterDecision паузу не снимает, hold и budgetBlock держат.
    let continues = true;
    const active = ['running', 'verifying', 'reviewing', 'integrating'].includes(w.status);
    switch (r.status) {
      case 'awaiting-lead':
        // Условия резервирования разбора; разбор тратит единицу общего бюджета.
        if (
          !(control.paused && control.pauseReason === 'operator') &&
          used < options.repairBudget &&
          w.attempt < options.maxAttempts &&
          r.calls < 1
        ) {
          used++;
          step = 'wait';
          continues = !unclaimable(w);
        }
        break;
      case 'applying':
        // После подтверждения случаев нужен повтор: без свободной попытки — остановка.
        if (w.attempt < options.maxAttempts) {
          step = 'wait';
          continues = !unclaimable(w);
        }
        break;
      case 'retry':
        // Повтор из эпизода: engine.retry требует свободной попытки, выдача — очереди.
        if (!unclaimable(w) && (w.status !== 'failed' || w.attempt < options.maxAttempts))
          step = w.status === 'failed' ? 'retry' : 'wait';
        break;
      case 'retrying':
        // Повтор идёт, только пока попытка действует; готовую работу эпизод не выдаёт.
        if (active) step = 'wait';
        break;
    }
    // Эпизод, на котором движок не действует сам, завершает задание.
    if (!step) return out;
    out.set(w.id, step);
    if (!continues) return out;
  }
  const plain = works.filter((w) => w.status === 'failed' && !w.recovery);
  // Любая отмена останавливает repair группы (repairDecision), и с эпизодом тоже.
  if (works.some((w) => w.status === 'cancelled')) return out;
  if (!episodes.length) {
    const decision = repairDecision(v, works, {
      budgetLeft: options.repairBudget - used,
      maxAttempts: options.maxAttempts,
    });
    if (!decision || decision.action === 'stop') return out;
  }
  // Пока идут эпизоды, сломанные без эпизода ждут; дальше — повтор по очереди.
  const ahead: Outlook = episodes.length ? 'wait' : 'retry';
  for (const [i, w] of plain.entries()) {
    const rule = repairPolicy[w.failureKind ?? 'unknown'];
    const identical = w.failureFingerprint
      ? v.attempts(w.id).filter((a) => a.failureFingerprint === w.failureFingerprint).length
      : rule.repeats + 1;
    const retry =
      rule.action === 'retry' &&
      identical - 1 < rule.repeats &&
      w.attempt < options.maxAttempts &&
      used + i < options.repairBudget;
    if (!retry) break;
    out.set(w.id, ahead);
  }
  return out;
}
