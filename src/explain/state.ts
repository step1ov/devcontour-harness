import { HarnessError } from '../contracts/errors.ts';
import { blocksWork } from '../contracts/index.ts';
import {
  MAX_NEUTRAL_FAILURES,
  lastContextLimit,
  repairPolicy,
  repairRepeats,
} from '../contracts/repair-policy.ts';
import type {
  AttemptState,
  ControlState,
  ExecutionPolicy,
  ExecutionView,
  InputRequest,
  WorkState,
  WorkStatus,
  WorkflowJob,
} from '../contracts/index.ts';
import type { Engine } from '../engine/engine.ts';
import { acceptanceGap, repairDecision } from '../engine/repair.ts';
import { requestsIndex } from '../engine/input-requests.ts';
import { callRecords } from '../engine/usage.ts';
import { activeOf } from '../engine/engine.ts';
import { inputStateOf } from '../projections/input.ts';
import type { EvidenceLink, StopInput, StopPhase } from '../projections/stop.ts';

/**
 * Что читают диагнозы по сохранённому состоянию (`stopInputsOf`) и пакет
 * передачи контекста: движок над хранилищем, политика исполнения и очередь
 * заданий графов — список заданий и решение, продолжит ли задание работу.
 * `Harness` удовлетворяет ему структурно (`workflows` — его `WorkflowQueue`);
 * хост со своим движком передаёт свой адаптер заданий.
 */
export interface StopSource {
  readonly engine: Engine;
  readonly policy: ExecutionPolicy;
  readonly workflows: {
    /** Задания очереди; диагнозы и пакет читают задания `kind: 'graph'`. */
    list(): readonly WorkflowJob[];
    /** Продолжит ли очередь задание сама (как `WorkflowQueue.continues`). */
    continues(
      job: WorkflowJob,
      view: ExecutionView,
      options?: { reconfigureApplies?: boolean },
    ): boolean;
  };
}

export interface StopInputOptions {
  maxAttempts: number;
  repairBudget: number;
  /** Одна работа; неизвестная — `NOT_FOUND`. */
  workId?: string;
  /**
   * Набор работ (не вместе с `workId`): входы каждой — те же, что у вызова с
   * её `workId`, за одно чтение. Неизвестная — `NOT_FOUND`.
   */
  workIds?: readonly string[];
}

/**
 * Control таким, каким его увидит следующий run этого процесса: run снимает
 * паузу «не запускали» (без причины) и штатную остановку, а применимый запрос
 * политики применяет до выдачи стадии (с ним снимается и его пауза). Общий
 * для `explain` и `status --detail`. `lifted` — пауза есть, но её снимет run.
 * Документ не меняется: `control` — прежний объект или его копия.
 */
export function nextRunControl(h: { readonly engine: Engine }, v: ExecutionView) {
  const raw = v.control();
  const liftsReconfigure =
    h.engine.reconfigureApplies(v) &&
    raw.pauseReason === 'reconfigure' &&
    raw.pauseOperation === raw.reconfigure?.operation;
  const lifted =
    raw.paused && (!raw.pauseReason || raw.pauseReason === 'shutdown' || liftsReconfigure);
  const control: ControlState = lifted
    ? { ...raw, paused: false, pauseReason: undefined, pauseFailures: undefined }
    : raw;
  return { control, lifted };
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
 *
 * Выбор: `workId` — одна работа, `workIds` — набор (входы каждой — те же,
 * что у вызова с её `workId`, в порядке состояния), без них — доска. Всё, что
 * общее для работ (прогноз групп, обратные зависимости, запросы, записи
 * вызовов), читается один раз за вызов, поэтому диагноз набора и доски
 * линеен по числу работ и их связей.
 */
export function stopInputsOf(h: StopSource, options: StopInputOptions): StopInput[] {
  if (options.workId !== undefined && options.workIds !== undefined)
    throw new HarnessError('INVALID_INPUT', 'Укажите workId или workIds, не оба');
  const selected =
    options.workIds !== undefined
      ? new Set(options.workIds)
      : options.workId !== undefined
        ? new Set([options.workId])
        : undefined;
  const jobs = h.workflows.list().filter((j) => j.kind === 'graph');
  const now = h.engine.clock();
  return h.engine.read((v) => {
    const works = v.works();
    // Первая работа с этим id — как `v.work(id)`; все зависимости графа — в нём.
    const byId = new Map<string, WorkState>();
    for (const w of works) if (!byId.has(w.id)) byId.set(w.id, w);
    if (selected)
      for (const id of selected)
        if (!byId.has(id)) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + id);
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
    const { control } = nextRunControl(h, v);
    const reconfigureApplies = h.engine.reconfigureApplies(v);
    const memo = <K, T>(fn: (key: K) => T) => {
      const cache = new Map<K, T>();
      return (key: K): T => {
        if (!cache.has(key)) cache.set(key, fn(key));
        return cache.get(key) as T;
      };
    };
    const once = <T>(fn: () => T) => {
      let value: { result: T } | undefined;
      return () => (value ??= { result: fn() }).result;
    };
    // Бюджет держит выдачу по тому же расчёту, которым следующий claim ставит
    // или снимает budgetBlock; записанное поле — лишь кэш этого расчёта
    // (после повышения бюджета оно устаревает, выключенные бюджеты не держат).
    let records: ReturnType<typeof callRecords> | undefined;
    const budgetById = memo((id: string) =>
      h.engine.policy.budgets
        ? h.engine.budgetBlockOf(id, v, (records ??= callRecords(v)))
        : undefined,
    );
    const budgetReason = (w: WorkState) => budgetById(w.id);
    const budgetHeld = (w: WorkState) => Boolean(budgetReason(w));
    // Внешние предпосылки графа claim не проверяет, даже если id совпал с работой.
    const external = memo(
      (graphId: string) => new Set(v.graph(graphId)?.graph.prerequisites.map((p) => p.id) ?? []),
    );
    // Набор и доска читают попытки одним проходом (порядок — как у `v.attempts(id)`).
    let attemptsByWork: Map<string, AttemptState[]> | undefined;
    const attemptsOf = memo((workId: string): AttemptState[] => {
      if (selected?.size === 1) return v.attempts(workId);
      if (!attemptsByWork) {
        attemptsByWork = new Map();
        for (const a of v.attempts()) {
          const list = attemptsByWork.get(a.workId);
          if (list) list.push(a);
          else attemptsByWork.set(a.workId, [a]);
        }
      }
      return attemptsByWork.get(workId) ?? [];
    });
    const requestsFor = requestsIndex(v);
    const requestsById = memo((id: string) => requestsFor(byId.get(id)!));
    // Согласование графа, устаревшее для этой политики: в режиме agent run сам
    // пересогласует план и начнёт новое задание (бюджет восстановлений с нуля),
    // в режиме operator работа не выдаётся до согласования человеком.
    const agentMode = h.policy.approvalMode === 'agent';
    const staleness = h.engine.approvalStaleness(v);
    const staleById = memo((id: string) => staleness(byId.get(id)!));
    const staleOf = (w: WorkState) => staleById(w.id);
    const liveJob = memo((graphId: string) =>
      jobs.find((j) => j.id === graphId && h.workflows.continues(j, v, { reconfigureApplies })),
    );
    const jobOf = (graphId: string, w: WorkState) => {
      const live = liveJob(graphId);
      if (live) return live;
      if (agentMode && staleOf(w) && jobs.some((j) => j.id === graphId)) return { repairs: 0 };
      return undefined;
    };
    // Прогноз по каждому графу — с первой работой графа в порядке состояния;
    // снятие паузы runtime — глобальное (clearFailure), ему нужны все графы.
    const firstOf = new Map<string, WorkState>();
    for (const w of works) if (!firstOf.has(w.graphId)) firstOf.set(w.graphId, w);
    const byGraph = new Map<string, WorkState[]>();
    for (const w of works) {
      const list = byGraph.get(w.graphId);
      if (list) list.push(w);
      else byGraph.set(w.graphId, [w]);
    }
    const ctx: OutlookContext = {
      v,
      byId,
      external,
      attemptsOf,
      requestsOf: requestsById,
    };
    const groupOf = memo((graphId: string): Map<string, Outlook> => {
      const job = jobOf(graphId, firstOf.get(graphId)!);
      return job
        ? outlookOf(
            ctx,
            graphId,
            byGraph.get(graphId) ?? [],
            job.repairs ?? 0,
            options,
            control,
            budgetHeld,
          )
        : new Map<string, Outlook>();
    });
    const pauseLifts = once(() => {
      if (!(control.pauseReason === 'runtime' && (control.pauseFailures ?? []).length > 0))
        return false;
      const everyGroup = new Map([...firstOf.keys()].flatMap((g) => [...groupOf(g)]));
      return (control.pauseFailures ?? []).every((kind) =>
        works.some(
          (w) =>
            w.status === 'failed' &&
            !w.recovery &&
            w.failureKind === kind &&
            repairPolicy[kind].blocksQueue === true &&
            everyGroup.get(w.id) === 'retry',
        ),
      );
    });
    // Незавершённые работы, которые прямо ждут отменённую: только их и
    // перепланирует replan-dependents. Ждущая через отменённую же
    // промежуточную — забота диагноза той; через принятую — не ждёт вовсе.
    let dependents: Map<string, string[]> | undefined;
    const openDependentsOf = (id: string) => {
      if (!dependents) {
        dependents = new Map();
        for (const w of works) {
          if (w.status === 'done' || w.status === 'cancelled') continue;
          const outside = external(w.graphId);
          for (const dep of new Set(w.order.dependsOn)) {
            if (outside.has(dep)) continue;
            const list = dependents.get(dep);
            if (list) list.push(w.id);
            else dependents.set(dep, [w.id]);
          }
        }
      }
      return [...(dependents.get(id) ?? [])];
    };
    // Первая отменённая работа графа: она останавливает восстановление группы.
    const cancelledIn = new Map<string, string>();
    for (const w of works)
      if (w.status === 'cancelled' && !cancelledIn.has(w.graphId)) cancelledIn.set(w.graphId, w.id);
    const active = once(() => activeOf(v));
    // Вопрос исполнителя, держащий работу: состояние, вопрос и варианты
    // (усекает explain), ответ — версией и digest; почему ответ сейчас не
    // применится — по тем же пределам, что у applyInput.
    const inputOf = (work: WorkState, attempts: readonly AttemptState[]) => {
      // Вопрос держит и готовую работу (новая редакция графа, устаревшее
      // применение): диагноз называет его при любом статусе, кроме итоговых.
      if (work.status === 'done' || work.status === 'cancelled') return undefined;
      const requests = requestsById(work.id);
      const question = requests
        .filter((r) => r.kind === 'question' && r.blocking && inputStateOf(r))
        .at(-1);
      if (!question) return undefined;
      const answer = question.answers.at(-1);
      const refusal = [
        question.stale ? `основание устарело до выдачи (${question.stale.reason})` : '',
        work.attempt >= options.maxAttempts
          ? `исчерпаны попытки (${work.attempt} из ${options.maxAttempts}): применение — со сбросом и причиной`
          : '',
        budgetReason(work) ?? '',
        active().some((a) => byId.get(a.workId)?.graphId === work.graphId)
          ? 'в графе идут попытки: новое согласование ждёт их окончания'
          : '',
      ].filter(Boolean);
      const own = attempts.flatMap((a) => a.assumptions ?? []).length;
      const followUps = requests.filter(
        (r) => r.kind === 'follow-up' && r.lifecycle === 'pending',
      ).length;
      return {
        requestId: question.id,
        state: inputStateOf(question)!,
        question: question.question.question,
        options: question.question.options.map((o) => o.id),
        ...(answer ? { answer: { revision: answer.revision, digest: answer.digest } } : {}),
        ...(refusal.length ? { refusal: refusal.join('; ') } : {}),
        ...(own ? { assumptions: own } : {}),
        ...(followUps ? { followUps } : {}),
      };
    };
    // Готовая работа ждёт предпосылку, на которой движок остановит задание:
    // сломанную без автоматического шага или саму ждущую такую (транзитивно).
    // Готовая и выдаваемая предпосылка движок не останавливает. Ответ зависит
    // только от предпосылки и графа ждущей работы (есть ли у неё задание,
    // прогноз группы, внешние предпосылки): граф ацикличен, поэтому ответ
    // запоминается для всех ждущих работ графа; работа на пути обхода — false,
    // как повторный визит прежнего обхода.
    const stopsFor = memo((key: string) => {
      const [graphId, hasJob] = [key.slice(0, -2), key.endsWith('\u00001')];
      const known = new Map<string, boolean>();
      const visiting = new Set<string>();
      const outside = external(graphId);
      const decide = (id: string): boolean => {
        if (outside.has(id)) return false;
        const dep = byId.get(id);
        if (!dep || dep.status === 'done') return false;
        // Сломанная без автоматического шага — или такая, которую повтор переведёт
        // в готовую, но бюджет её не выдаст.
        if (dep.status === 'failed' || dep.status === 'cancelled')
          return !hasJob || groupOf(graphId).get(id) === 'stop' || budgetHeld(dep);
        // Готовая, которую движок не выдаст: эпизод (blocksClaim), бюджет
        // (budgetBlock) или исчерпанные попытки.
        if (
          dep.status === 'ready' &&
          ((dep.recovery && !['retry', 'closed'].includes(dep.recovery.status)) ||
            budgetHeld(dep) ||
            dep.attempt >= options.maxAttempts)
        )
          return true;
        return dep.status === 'ready' && dep.order.dependsOn.some((d) => stops(d));
      };
      const stops = (id: string): boolean => {
        const cached = known.get(id);
        if (cached !== undefined) return cached;
        if (visiting.has(id)) return false;
        visiting.add(id);
        const result = decide(id);
        visiting.delete(id);
        known.set(id, result);
        return result;
      };
      return stops;
    });
    for (const work of works) {
      if (work.status === 'done') continue;
      if (selected && !selected.has(work.id)) continue;
      // Отменённая (или упавшая отменой) — решение, только пока её ждут.
      const openDependents =
        work.status === 'cancelled' ||
        (work.status === 'failed' && work.failureKind === 'cancelled')
          ? openDependentsOf(work.id)
          : undefined;
      // Отменённая без ждущих — не остановка доски: в общий explain и пакет
      // не входит (как принятая); explain этой работы её показывает. Упавшая
      // отменой остаётся открытой работой: её диагноз (действия нет) нужен
      // строке поручения в пакете.
      if (work.status === 'cancelled' && openDependents && !openDependents.length && !selected)
        continue;
      const attempts = attemptsOf(work.id);
      const last = attempts.filter((a) => a.status !== 'active').at(-1);
      const kind = work.failureKind ?? 'unknown';
      const fingerprint = work.failureFingerprint;
      const identical = fingerprint
        ? attempts.filter((a) => a.failureFingerprint === fingerprint).length
        : 0;
      // Чинит только задание, которое продолжит работу: активное, по текущей
      // редакции графа и с непотраченными попытками стадии (как `claim`).
      const job = jobOf(work.graphId, work);
      const group = groupOf(work.graphId);
      const approvalStale = !agentMode ? staleOf(work) : undefined;
      const stops = stopsFor(work.graphId + (job ? '\u00001' : '\u00000'));
      const waitingOn = work.status === 'ready' ? work.order.dependsOn.filter((d) => stops(d)) : [];
      const outlook: Outlook | undefined =
        !job || approvalStale ? 'stop' : waitingOn.length ? 'stop' : group.get(work.id);
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
          ...(work.failureKind === 'context-exhausted' && lastContextLimit(attempts)
            ? { contextLimit: lastContextLimit(attempts) }
            : {}),
          ...((input) => (input ? { input } : {}))(inputOf(work, attempts)),
          ...(work.failure !== undefined ? { failure: work.failure } : {}),
          ...(work.hold
            ? { hold: { operation: work.hold.operation, reason: work.hold.reason } }
            : {}),
          ...((reason) => (reason ? { budgetBlock: { reason } } : {}))(budgetReason(work)),
          ...(work.recovery ? { recovery: { status: work.recovery.status } } : {}),
          ...(waitingOn.length ? { waitingOn } : {}),
          ...(approvalStale ? { approvalStale } : {}),
          ...(openDependents ? { openDependents } : {}),
          ...((stoppedBy) => (stoppedBy ? { repairStoppedBy: stoppedBy } : {}))(
            // Отмена в группе останавливает её восстановление: сёстрам — почему.
            work.status === 'failed' && work.failureKind !== 'cancelled' && !work.recovery && job
              ? cancelledIn.get(work.graphId)
              : undefined,
          ),
          ...((live) =>
            live && live.state !== 'active'
              ? {
                  liveness: {
                    state: live.state,
                    lastMovementAt: live.lastMovementAt,
                    ...(live.activity
                      ? { activity: `${live.activity.kind} ${live.activity.label}` }
                      : {}),
                    ...(live.action ? { action: live.action } : {}),
                  },
                }
              : {})(
            ((a) => (a?.status === 'active' ? a.liveness : undefined))(
              work.activeRunId ? v.attempt(work.activeRunId) : undefined,
            ),
          ),
        },
        maxAttempts: options.maxAttempts,
        repair: {
          sameFailureRepairs: fingerprint
            ? identical - 1
            : repairRepeats(kind, lastContextLimit(attempts)),
          groupRepairsUsed: job?.repairs ?? 0,
          groupRepairBudget: job ? options.repairBudget : 0,
          ...(outlook ? { outlook } : {}),
        },
        control: {
          // Пауза runtime, все причины которой снимет назначенный repair группы
          // (clearFailure блокирующего класса), для остальных работ не держит выдачу.
          paused: control.paused && !(work.status !== 'failed' && pauseLifts()),
          ...(control.pauseReason ? { pauseReason: control.pauseReason } : {}),
          ...(control.pauseFailures ? { pauseFailures: [...control.pauseFailures] } : {}),
        },
        ...(last ? { phase: phaseOf[last.phase] ?? 'claim', runId: last.id } : {}),
        evidence,
      });
    }
    // Неблокирующие запросы ведущему (автономный режим): отдельными
    // диагнозами — работу они не держат, но ждут решения.
    for (const work of works) {
      if (selected && !selected.has(work.id)) continue;
      for (const r of requestsById(work.id))
        if (r.kind === 'follow-up' && r.lifecycle === 'pending')
          inputs.push({
            kind: 'input',
            request: {
              id: r.id,
              workId: r.workId,
              question: r.question.question,
              severity: r.effectiveSeverity,
            },
          });
    }
    return inputs;
  });
}

type View = Parameters<Parameters<Engine['read']>[0]>[0];
type Outlook = 'retry' | 'wait' | 'stop';

/** Чтения одного вызова `stopInputsOf`, общие для прогнозов всех групп. */
interface OutlookContext {
  v: View;
  /** Работы по id — как `v.work(id)`. */
  byId: ReadonlyMap<string, WorkState>;
  /** Внешние предпосылки графа. */
  external: (graphId: string) => Set<string>;
  /** Попытки работы — как `v.attempts(workId)`. */
  attemptsOf: (workId: string) => AttemptState[];
  requestsOf: (workId: string) => InputRequest[];
}

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
  ctx: OutlookContext,
  graphId: string,
  works: readonly WorkState[],
  repairsUsed: number,
  options: StopInputOptions,
  control: ReturnType<View['control']>,
  budgetHeld: (w: WorkState) => boolean,
): Map<string, Outlook> {
  const out = new Map<string, Outlook>();
  for (const w of works) out.set(w.id, 'stop');
  let used = repairsUsed;
  // Предпосылка, которая не станет принятой, пока движок идёт по эпизодам:
  // отменённая, сломанная без обещанного раньше в проходе шага, готовая, которую
  // claim не выдаст, — или ждущая такую (транзитивно). Внешние не держат.
  const external = ctx.external(graphId);
  const depStops = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (external.has(id)) return false;
    const dep = ctx.byId.get(id);
    if (!dep || dep.status === 'done') return false;
    if (dep.status === 'cancelled') return true;
    if (dep.status === 'failed') return out.get(id) === 'stop';
    if (dep.status !== 'ready') return false;
    return (
      Boolean(dep.hold) ||
      budgetHeld(dep) ||
      dep.attempt >= options.maxAttempts ||
      (dep.recovery !== undefined && !['retry', 'closed'].includes(dep.recovery.status)) ||
      dep.order.dependsOn.some((d) => depStops(d, seen))
    );
  };
  // Повтор не будет выдан: пауза, hold, бюджет, исчерпанные попытки (claim их
  // проверяет и у готовой работы) или предпосылка, на которой claim встанет.
  const unclaimable = (w: (typeof works)[number]) =>
    control.paused ||
    Boolean(w.hold) ||
    w.attempt >= options.maxAttempts ||
    budgetHeld(w) ||
    w.order.dependsOn.some((d) => depStops(d));
  const episodes = works.filter((w) => w.recovery && w.status !== 'cancelled');
  for (const w of episodes) {
    const r = w.recovery!;
    let step: Outlook | undefined;
    // Шаг эпизода, который ведёт к повтору, продолжает группу, только если этот
    // повтор будет выдан: afterDecision паузу не снимает, hold, budgetBlock и
    // остановленная предпосылка держат.
    let continues = true;
    const active = ['running', 'verifying', 'reviewing', 'integrating'].includes(w.status);
    switch (r.status) {
      case 'awaiting-lead':
        // Условия резервирования разбора; разбор тратит единицу общего бюджета.
        if (
          !(control.paused && control.pauseReason === 'operator') &&
          used < options.repairBudget &&
          w.attempt < options.maxAttempts &&
          r.calls < 1 &&
          // Вызов ведущего проверяет бюджет поручения: превышенный — отказ.
          !budgetHeld(w)
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
        if (!unclaimable(w)) step = w.status === 'failed' ? 'retry' : 'wait';
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
    const decision = repairDecision(ctx.v, [...works], {
      blocking: (w) => ctx.requestsOf(w.id).find(blocksWork),
      budgetLeft: options.repairBudget - used,
      maxAttempts: options.maxAttempts,
    });
    if (!decision || decision.action === 'stop') return out;
  }
  // Пока идут эпизоды, сломанные без эпизода ждут; дальше — повтор по очереди.
  const ahead: Outlook = episodes.length ? 'wait' : 'retry';
  for (const [i, w] of plain.entries()) {
    const rule = repairPolicy[w.failureKind ?? 'unknown'];
    const attempts = ctx.attemptsOf(w.id);
    const repeats = repairRepeats(w.failureKind ?? 'unknown', lastContextLimit(attempts));
    const identical = w.failureFingerprint
      ? attempts.filter((a) => a.failureFingerprint === w.failureFingerprint).length
      : repeats + 1;
    const retry =
      rule.action === 'retry' &&
      identical - 1 < repeats &&
      !acceptanceGap(ctx.v, w) &&
      (w.neutralFailures ?? 0) < MAX_NEUTRAL_FAILURES &&
      w.attempt < options.maxAttempts &&
      used + i < options.repairBudget;
    if (!retry) break;
    out.set(w.id, ahead);
  }
  return out;
}
