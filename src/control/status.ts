import type { z } from 'zod';
import {
  STATE_VERSION,
  inputPolicyOf,
  type statusDataSchema,
  type AttemptState,
  type CallRecord,
  type ExecutionPolicy,
  type ExecutionView,
  type WorkState,
  type WorkflowJob,
} from '../contracts/index.ts';
import { attemptSummaryLine, attemptSummaryOf, type AttemptBudget } from '../report/compute.ts';
import { budgetOverview, legacyGroupCall } from '../engine/budget.ts';
import { callRecords } from '../engine/usage.ts';
import type { Engine } from '../engine/engine.ts';
import { requestsOf } from '../engine/input-requests.ts';
import { reviewSummaryRows, reviewsText } from './review-summary.ts';
import { MAX_NEUTRAL_FAILURES } from '../contracts/repair-policy.ts';
import {
  livePlanReviews,
  nextRunControl,
  repairJobOf,
  stopInputsIn,
  type StopSource,
} from '../explain/state.ts';
import { explainStop } from '../projections/stop.ts';
import { workStageOf, type StageNeeds } from './stage.ts';
import { blockerCodeText, plainBlocker, type BlockerCode } from './blocker-plain.ts';
import { verificationOf } from '../report/verification.ts';
import {
  CLIP_DIAGNOSTIC,
  attemptView,
  clipText,
  queuePause,
  queueStop,
  workInputOf,
} from '../projections/index.ts';

/**
 * Что читает `statusOf`: движок над хранилищем и политика исполнения.
 * `Harness` удовлетворяет ему структурно; хост со своим `Engine` передаёт
 * `{ engine, policy }`.
 */
export interface StatusSource {
  readonly engine: Engine;
  readonly policy: ExecutionPolicy;
  /**
   * Задания графов (`Harness.workflows`, тот же адаптер, что у
   * `StopSource`): с ними сводка попыток называет остаток восстановлений
   * группы по правилу `explain` (`repairJobOf`). Нет — сводка без `repairs`.
   */
  readonly workflows?: StopSource['workflows'];
}

/** Попытки всех работ одним проходом по хранилищу (порядок — как у `v.attempts(id)`). */
export function attemptsByWork(v: ExecutionView): (workId: string) => AttemptState[] {
  const byWork = new Map<string, AttemptState[]>();
  for (const a of v.attempts()) {
    const list = byWork.get(a.workId);
    if (list) list.push(a);
    else byWork.set(a.workId, [a]);
  }
  return (workId) => byWork.get(workId) ?? [];
}

/**
 * Сводки попыток работ одного чтения: попытки — одним проходом, задание
 * группы — `repairJobOf` (как `explain`), если источник передал задания.
 */
export function attemptSummaries(source: StatusSource, v: ExecutionView) {
  const attemptsOf = attemptsByWork(v);
  const workflows = source.workflows;
  const jobOf = workflows
    ? repairJobOf({ engine: source.engine, policy: source.policy, workflows }, v)
    : undefined;
  return (w: WorkState) =>
    attemptSummaryView(w, attemptsOf(w.id), source.policy, jobOf?.(w.graphId, w));
}

/**
 * Сводка попыток поручения для `status` и `explain`: числа — `attemptSummaryOf`
 * (правила отчёта), остаток попыток — по засчитанным `work.attempt` и
 * `maxAttempts`, восстановлений — по заданию графа и `repairBudget`; `line` —
 * `attemptSummaryLine`.
 */
/** Предел `attempts.line` схемы `status` (`attemptSummarySchema.line`). */
const ATTEMPT_LINE_MAX = 1000;

export function attemptSummaryView(
  work: WorkState,
  attempts: readonly AttemptState[],
  policy: Pick<ExecutionPolicy, 'maxAttempts' | 'repairBudget'>,
  job?: Pick<WorkflowJob, 'repairs'>,
) {
  const summary = attemptSummaryOf(work, attempts);
  const neutral = { used: work.neutralFailures ?? 0, max: MAX_NEUTRAL_FAILURES };
  // Предел незасчитанных отказов держит только незавершённую работу: у
  // принятой или отменённой строка называет итог, а не повтор со сбросом.
  const final = work.status === 'done' || work.status === 'cancelled';
  const budget: AttemptBudget = {
    attempts: { used: work.attempt, max: policy.maxAttempts },
    ...(final ? {} : { neutral }),
    ...(job ? { repairs: { used: job.repairs ?? 0, budget: policy.repairBudget } } : {}),
  };
  const left = (used: number, max: number) => Math.max(0, max - used);
  return {
    ...summary,
    attempts: { ...budget.attempts, left: left(work.attempt, policy.maxAttempts) },
    neutral,
    ...(budget.repairs
      ? { repairs: { ...budget.repairs, left: left(budget.repairs.used, budget.repairs.budget) } }
      : {}),
    line: attemptSummaryLine(summary, budget, 'ru', ATTEMPT_LINE_MAX),
  };
}

/**
 * Состояние очереди, графов и поручений (`Harness.status`, `harness status`)
 * над движком и политикой источника. С `detail` — ещё снимок наблюдателя:
 * почему стоит выдача (`queueStop` и `queuePause`) и активные попытки
 * (`attemptView`); без него ответ прежний. Только чтение, один `read`.
 */
export function statusOf(
  source: StatusSource,
  graphId?: string,
  options: { detail?: boolean } = {},
) {
  const { engine } = source;
  // Задания графов — из их адаптера до чтения (как у explain); диагноз,
  // этап и всё остальное — внутри одного чтения: один снимок хранилища.
  const jobs = source.workflows?.list().filter((j) => j.kind === 'graph');
  return engine.read((v) => {
    const summaryOf = attemptSummaries(source, v);
    const now = engine.clock();
    const attemptsOf = attemptsByWork(v);
    const selected = v.works(graphId);
    // Что нужно от кого — диагнозом explain по тому же виду и часам.
    const needsOf = jobs ? stageNeedsOf(source, v, { jobs, now }) : undefined;
    // Ревью плана, идущее в живом `harness run`: согласование — ход harness.
    const planReviews = livePlanReviews(v, source.policy, now);
    // Собственные вызовы поручения (без вызовов о группе) — одним проходом;
    // прежняя запись без поручения — по индексам попыток и поручений (правило
    // `recordWorkOf`), а не поиском по хранилищу на каждую запись.
    const runWork = new Map<string, string>();
    for (const a of v.attempts()) runWork.set(a.id, a.workId);
    const known = new Set(v.works().map((w) => w.id));
    const ids = new Set(selected.map((w) => w.id));
    const recordsByWork = new Map<string, CallRecord[]>();
    for (const r of callRecords(v)) {
      if (r.workIds) continue;
      const id = r.workId ?? legacyWork(r, runWork, known);
      if (!id || !ids.has(id)) continue;
      const list = recordsByWork.get(id);
      if (list) list.push(r);
      else recordsByWork.set(id, [r]);
    }
    return {
      stateVersion: STATE_VERSION,
      control: v.control(),
      ...(v.controller() ? { controller: v.controller() } : {}),
      graphs: v
        .graphs()
        .filter((g) => !graphId || g.id === graphId)
        .map((g) => ({
          id: g.id,
          digest: g.digest,
          source: g.graph.source,
          approved: g.approval?.digest === g.digest,
        })),
      works: selected.map((w) => ({
        id: w.id,
        graphId: w.graphId,
        status: w.status,
        attempt: w.attempt,
        ...(w.activeRunId ? { activeRunId: w.activeRunId } : {}),
        ...((a) =>
          a?.status === 'active' && a.liveness && a.liveness.state !== 'active'
            ? { liveness: a.liveness.state }
            : {})(w.activeRunId ? v.attempt(w.activeRunId) : undefined),
        ...(w.resultSha ? { resultSha: w.resultSha } : {}),
        // Вопрос исполнителя: ID, состояние, версия и серьёзность, без текста;
        // неблокирующие запросы ведущему — числом.
        // У итоговой работы вопрос — история: статус его не показывает.
        ...((view, raw) => {
          const active = w.activeRunId ? v.attempt(w.activeRunId) : undefined;
          const input = carriedInput(
            view.input && w.status !== 'done' && w.status !== 'cancelled' ? view.input : undefined,
            attemptsOf(w.id),
          );
          const reviewSince = planReviews.get(w.graphId);
          const planReview =
            reviewSince && w.status !== 'done' && w.status !== 'cancelled' && !active
              ? { since: reviewSince }
              : undefined;
          // Причина простыми словами и кто её снимает — рядом с кодом и сообщением.
          const needs = planReview
            ? { actor: 'controller' as const, action: 'review-plan' as const }
            : (needsOf?.(w) ??
              (input?.state === 'awaiting-answer'
                ? {
                    // Технический вопрос при leadAnswers.technical решает ведущий.
                    actor: input.leadMay === 'technical' ? ('lead' as const) : ('user' as const),
                    action: 'answer-input' as const,
                  }
                : undefined));
          const plainContext = {
            control: v.control(),
            approvalMode: source.policy.approvalMode,
            status: w.status,
            work: w,
            statusOf: (id: string) => v.work(id)?.status,
            needsOf: (id: string) => ((d) => (d ? needsOf?.(d) : undefined))(v.work(id)),
            ...(needs ? { needs } : {}),
            ...(active?.status === 'active' ? { active: true } : {}),
            ...(planReview ? { planReview: true } : {}),
          };
          const blockers = withSteps(raw.map((b) => ({ ...b, ...plainBlocker(b, plainContext) })));
          // Строка этапа называет блокировку, которую снимают первой
          // (`blockerOrder`; порядок `blockers` прежний, порядок — в `step`).
          const first = [...blockers].sort(blockerOrder)[0];
          const attemptSummary = summaryOf(w);
          const verification = verificationOf(w, attemptsOf(w.id));
          return {
            ...(input ? { input } : {}),
            ...(view.followUps ? { followUps: view.followUps } : {}),
            blockers,
            attemptSummary,
            stage: workStageOf({
              work: w,
              attempts: attemptsOf(w.id),
              ...(active ? { active } : {}),
              ...(input ? { inputState: input.state } : {}),
              blocked: blockers.length > 0,
              records: recordsByWork.get(w.id) ?? [],
              maxAttempts: source.policy.maxAttempts,
              ...(attemptSummary.lastFailure ? { lastFailure: attemptSummary.lastFailure } : {}),
              ...(first ? { blockedBy: first } : {}),
              ...(needs ? { needs } : {}),
              ...(planReview ? { planReview } : {}),
              now,
            }),
            ...(verification ? { verification } : {}),
          };
        })(workInputOf(requestsOf(v, w), inputPolicyOf(source.policy)), engine.blockers(w, v)),
      })),
      ...((r) => (r ? { runner: r } : {}))(
        runnerOf(v, selected, planReviews, now, (w) => needsOf?.(w)),
      ),
      ...((budgets) => (budgets ? { budgets } : {}))(budgetOverview(engine.budgetContext(), v)),
      ...(({ reviews, reviewsTruncated }) => ({
        ...(reviews.length ? { reviews } : {}),
        ...(reviewsTruncated ? { reviewsTruncated } : {}),
      }))(reviewSummaryRows(v, source.policy, graphId === undefined ? {} : { graphId })),
      ...(options.detail ? { detail: statusDetail(source, v, graphId) } : {}),
    };
  });
}

/**
 * Применённый ответ и попытка, за которой он закреплён при выдаче
 * (`AttemptState.input`): идёт она — ответ уже у попытки (`delivered`, ждать
 * нечего); закончилась, не передав его исполнителю, — ответ получит
 * следующая попытка (`carrier.running: false`).
 */
export function carriedInput<T extends { requestId: string; state: string }>(
  input: T | undefined,
  attempts: readonly AttemptState[],
): (T & { carrier?: { attempt: number; running: boolean } }) | undefined {
  if (!input || (input.state !== 'applied-awaiting-claim' && input.state !== 'delivered'))
    return input;
  const carrier = attempts.findLast((a) => a.input?.requestId === input.requestId);
  if (!carrier) return input;
  const running = carrier.status === 'active';
  return {
    ...input,
    ...(running && input.state === 'applied-awaiting-claim' ? { state: 'delivered' } : {}),
    carrier: { attempt: carrier.attempt, running },
  };
}

/**
 * Порядок снятия блокировок: согласование (и пауза очереди) раньше всего —
 * без него сброс попыток и ответы ничего не изменят; дальше — по тому, кто
 * действует: человек, ведущий, harness, никто.
 */
const codeRank = (code: string) =>
  code === 'APPROVAL_STALE' || code === 'APPROVAL_REQUIRED' ? 0 : code === 'PAUSED' ? 1 : 2;
export const blockerOrder = (
  a: { code: string; actor?: string | null },
  b: { code: string; actor?: string | null },
) => codeRank(a.code) - codeRank(b.code) || actorRank(a.actor) - actorRank(b.actor);

const person = (actor: string | null | undefined) => actor === 'user' || actor === 'lead';

/**
 * `step` — порядок снятия, когда блокировки снимают разные люди (человек и
 * ведущий): у их блокировок 1, 2, … по `blockerOrder`; ход harness без номера.
 */
function withSteps<B extends { code: string; actor?: string | null }>(
  blockers: B[],
): (B & { step?: number })[] {
  if (new Set(blockers.filter((b) => person(b.actor)).map((b) => b.actor)).size < 2)
    return blockers;
  const order = [...blockers].sort(blockerOrder).filter((b) => person(b.actor));
  return blockers.map((b) => (person(b.actor) ? { ...b, step: order.indexOf(b) + 1 } : b));
}

/**
 * Кто двигает очередь (`runner`): живой controller, попытка с действующим
 * владением или ревью плана в живом run — `running`; иначе открытые
 * поручения сдвинет только новый `harness run` (его делает ведущий). Нет
 * открытых поручений — поля нет.
 */
function runnerOf(
  v: ExecutionView,
  works: readonly WorkState[],
  planReviews: ReadonlyMap<string, string>,
  now: number,
  needsOf: (w: WorkState) => StageNeeds | undefined,
) {
  const open = works.filter((w) => w.status !== 'done' && w.status !== 'cancelled');
  if (!open.length) return undefined;
  const graphs = new Set(open.map((w) => w.graphId));
  const reviews = [...planReviews]
    .filter(([g]) => graphs.has(g))
    .map(([graphId, since]) => ({ graphId, since }));
  const lease = v.controller();
  const attempt = open.some((w) => {
    const a = w.activeRunId ? v.attempt(w.activeRunId) : undefined;
    return a?.status === 'active' && a.leaseUntil > now;
  });
  if (reviews.length) {
    const ids = reviews.map((r) => r.graphId).join(', ');
    return {
      state: 'running' as const,
      planReviews: reviews.slice(0, 50),
      line: `Идёт ревью плана ${ids} (harness run) — выдача начнётся после согласования; от вас ничего не нужно.`,
      lineEn: `The plan review of ${ids} is running (harness run) — work starts after approval; nothing is needed from you.`,
    };
  }
  if ((lease && lease.leaseUntil > now) || attempt)
    return {
      state: 'running' as const,
      line: 'Очередь идёт: harness запущен.',
      lineEn: 'The queue is running: harness is up.',
    };
  // Никто не запущен: ждут ли открытые поручения только запуска или сперва
  // ответа, решения человека или хода ведущего.
  // Нет диагноза — ход controller; `null` (ждёт зависимости) — ничей.
  const waitsRun = open.some((w) => {
    const needs = needsOf(w);
    return !needs || needs.actor === 'controller';
  });
  return {
    state: 'not-running' as const,
    restartBy: 'lead' as const,
    line: waitsRun
      ? 'Очередь стоит — никто не запущен: работу сдвинет только новый запуск (ведущий: harness run).'
      : 'Очередь стоит — никто не запущен: после ответа или решения нужен новый запуск (ведущий: harness run).',
    lineEn: waitsRun
      ? 'The queue is idle — nothing is running: only a new run moves the work (the lead: harness run).'
      : 'The queue is idle — nothing is running: after the answer or decision a new run is needed (the lead: harness run).',
  };
}

/**
 * Что нужно по каждому поручению — `actor` и `action` диагноза `explain`
 * (`stopInputsIn` → `explainStop`, отбор доски) в виде и по часам
 * вызывающего чтения. Принятое поручение и отменённое без ждущих в диагнозы
 * не входят: им ничего не нужно; идущему без остановки — ход controller.
 */
function stageNeedsOf(
  source: StatusSource,
  v: ExecutionView,
  context: { jobs: readonly WorkflowJob[]; now: number },
): (w: WorkState) => StageNeeds {
  const byWork = new Map<string, StageNeeds>();
  // Отбор доски, как у `explain` без `--work`: отменённая без ждущих в него
  // не входит (ей ничего не нужно), а не получает диагноз выбранной работы.
  for (const input of stopInputsIn(
    { engine: source.engine, policy: source.policy, workflows: source.workflows! },
    { maxAttempts: source.policy.maxAttempts, repairBudget: source.policy.repairBudget },
    v,
    context,
  ))
    if (input.kind === 'work' && !byWork.has(input.work.id)) {
      const d = explainStop(input);
      byWork.set(input.work.id, { actor: d.actor, action: d.action });
    }
  return (w) =>
    byWork.get(w.id) ??
    (w.status === 'done' || w.status === 'cancelled'
      ? { actor: null, action: 'none' }
      : { actor: 'controller', action: 'wait' });
}

/**
 * Поручение прежней записи вызова без `workId` — правило `recordWorkOf`
 * (`subjectWork`) по готовым индексам: сначала по попытке, затем по ID
 * предмета, если вид предмета не назван иначе и это не прежний вызов о группе.
 */
function legacyWork(r: CallRecord, runWork: Map<string, string>, works: Set<string>) {
  const byRun = r.runId !== undefined ? runWork.get(r.runId) : undefined;
  if (byRun) return byRun;
  if (r.subjectKind && r.subjectKind !== 'work') return undefined;
  if (legacyGroupCall(r)) return undefined;
  return r.subjectId && works.has(r.subjectId) ? r.subjectId : undefined;
}

function statusDetail(source: StatusSource, v: ExecutionView, graphId?: string) {
  const { engine, policy } = source;
  const now = engine.clock();
  const control = v.control();
  const works = v.works(graphId);
  const attempts = v.works().flatMap((w) => v.attempts(w.id));
  // Последний отказ классов паузы runtime — её подробность (как `queueStop`
  // хоста по ошибкам планировщика): порядок — по времени завершения.
  const failures = new Set(control.pauseFailures ?? []);
  const errors = attempts
    .filter((a) => a.status === 'failed' && a.failureKind && failures.has(a.failureKind))
    .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''))
    .map((a, i) => ({ seq: i + 1, ...(a.error ? { message: a.error } : {}) }));
  const stop = queueStop({
    paused: control.paused,
    ...(control.pauseReason ? { pauseReason: control.pauseReason } : {}),
    errors,
  });
  const repositoryGates = (id: string) =>
    policy.repositories.find((r) => r.id === id)?.gates.map((g) => g.id);
  // Пауза, которую снимет следующий run, глазами explain: выдача не стоит,
  // поручения ждут controller.
  const queue = nextRunControl(source, v).lifted
    ? {
        paused: true,
        ...(control.pauseReason ? { reason: control.pauseReason } : {}),
        detail: 'Паузу снимет следующий harness run',
        ...(control.pausedAt ? { since: control.pausedAt } : {}),
        ...(control.pauseOperation ? { operation: control.pauseOperation } : {}),
        liftedByRun: true as const,
        code: 'NOT_READY' as const,
        cause: 'not-ready' as const,
        actor: 'controller' as const,
        action: 'wait' as const,
      }
    : {
        ...stop,
        ...(stop.detail ? { detail: clipText(stop.detail, CLIP_DIAGNOSTIC)! } : {}),
        ...(control.paused && control.pausedAt ? { since: control.pausedAt } : {}),
        ...(control.paused && control.pauseOperation ? { operation: control.pauseOperation } : {}),
        ...(control.paused && control.pauseFailures?.length
          ? { failures: [...control.pauseFailures] }
          : {}),
        ...(queuePause(control) ?? {}),
      };
  return {
    at: new Date(now).toISOString(),
    queue,
    attempts: works
      .map((w) => (w.activeRunId ? v.attempt(w.activeRunId) : undefined))
      .filter((a) => a?.status === 'active')
      .map((a) => {
        const gates = repositoryGates(a!.repositoryId);
        return attemptView(a!, {
          now,
          leaseMs: policy.leaseMs,
          ...(gates ? { repositoryGates: gates } : {}),
        });
      }),
  };
}

const answeredBy = { operator: 'оператор', lead: 'ведущий', host: 'хост' } as const;
/** Порядок блокировок для человека: его ход, ход ведущего, harness, итог. */
const actorRank = (actor: string | null | undefined) =>
  actor === 'user' ? 0 : actor === 'lead' ? 1 : actor === 'controller' ? 2 : 3;
const actorWho = { user: 'вы', lead: 'ведущий', controller: 'harness' } as const;
const actorText = {
  user: 'нужно от вас',
  lead: 'ход ведущего',
  controller: 'harness сам',
} as const;

/**
 * Текст `status --human`: состояние выдачи и строка на поручение — статус и
 * сводка попыток (`attemptSummaryLine`); с отступом — этап простыми словами
 * (`works[].stage.line`), вопрос исполнителя с тем, кто ответил,
 * блокировки простыми словами с кодами и что проверено и как
 * (`works[].verification.line`).
 */
export function statusText(data: z.output<typeof statusDataSchema>): string {
  const c = data.control;
  // Пауза «очередь ещё не запускали» и штатная остановка снимет следующий
  // run: о ней говорит строка `runner` (кто двигает очередь).
  const lifted = c.paused && (!c.pauseReason || c.pauseReason === 'shutdown');
  const out = [
    c.paused && !(lifted && data.runner)
      ? `Выдача на паузе${c.pauseReason ? ` (${c.pauseReason})` : ''}.`
      : (data.runner?.line ?? 'Выдача идёт.'),
  ];
  if (c.paused && !lifted && data.runner?.state === 'not-running') out.push(data.runner.line);
  if (!data.works.length) out.push('Поручений нет.');
  for (const w of data.works) {
    out.push(`${w.id} [${w.status}]${w.attemptSummary ? ': ' + w.attemptSummary.line : ''}`);
    if (w.stage) out.push(`  сейчас: ${w.stage.line.slice(w.id.length + 2)}`);
    if (w.input)
      out.push(
        `  вопрос ${w.input.requestId} [${w.input.state}, серьёзность ${w.input.severity}${w.input.impact === 'technical' ? ', технический' : ''}]` +
          (w.input.carrier
            ? w.input.carrier.running
              ? `: ответ у идущей попытки ${w.input.carrier.attempt} — ждать нечего`
              : `: ответ был у попытки ${w.input.carrier.attempt}, она остановилась до передачи исполнителю — его получит следующая попытка`
            : '') +
          (w.input.answerBasis === 'technical'
            ? ': решено ведущим (технический вопрос)'
            : w.input.answeredBy
              ? `: ответил ${answeredBy[w.input.answeredBy]}`
              : w.input.state === 'awaiting-answer'
                ? w.input.leadMay === 'technical'
                  ? ': технический вопрос — решает ведущий (input-answer --actor lead --reason)'
                  : ': ждёт ответа человека (input-show, input-answer --actor operator)'
                : ''),
      );
    // Блокировки простыми словами (кто снимает — в скобках), коды — после.
    if (w.blockers.length) {
      const sorted = [...w.blockers].sort(blockerOrder);
      // Снимают разные люди (`step`): «сначала ведущий: …; затем вы: …».
      out.push(
        `  не выдаётся: ${sorted
          .map((b) => {
            // Без простого текста (ответ другой версии) — общий текст кода,
            // а не сообщение: в нём может быть текст хоста.
            const text = b.plain ?? blockerCodeText[b.code as BlockerCode]?.ru ?? b.code;
            if (b.step !== undefined && b.actor && b.plain)
              return `${b.step === 1 ? 'сначала' : 'затем'} ${actorWho[b.actor]}: ${text}`;
            return b.plain && b.actor ? `${text} (${actorText[b.actor]})` : text;
          })
          .join('; ')} [коды: ${w.blockers.map((b) => b.code).join(', ')}]`,
      );
    }
    if (w.verification) out.push(`  проверки: ${w.verification.line}`);
    // Принятая версия против текущего target ref: непроверенное после приёмки.
    if (w.target) out.push(`  ${w.target.line} (${w.target.lineEn})`);
    // Удалённая ветка — по локальной remote-tracking ref, без fetch.
    if (w.target?.remote) out.push(`  удалённая ветка: ${w.target.remote.line}`);
  }
  return out.join('\n') + '\n' + reviewsText(data.reviews, data.reviewsTruncated);
}

/**
 * Доска «успокоилась» для `status --human --watch`: ничего не сдвинется без
 * человека или ведущего. Не успокоилась, пока идёт попытка с действующим
 * владением (по `detail.attempts[].lease.stale`; без `detail` — любая
 * активная) или живой controller (`controller.leaseUntil` в будущем) сдвинет
 * открытое поручение, которому ничего не нужно от человека или ведущего
 * (`stage.needs.actor` controller или неизвестно), или идёт задание графа с
 * действующей арендой (`liveJobs`: восстановление группы). Попытка умершего
 * владельца без живого controller сама не продолжится.
 */
export function statusSettled(
  data: z.output<typeof statusDataSchema>,
  now: number,
  options: { liveJobs?: number } = {},
): boolean {
  // Восстановление группы идёт под арендой задания графа, после того как
  // run отпустил роль controller: живое задание — тоже движение.
  if (options.liveJobs) return false;
  const live = !!data.controller && data.controller.leaseUntil > now;
  const stale = new Set(
    (data.detail?.attempts ?? []).filter((a) => a.lease.stale).map((a) => a.runId),
  );
  if (data.works.some((w) => w.activeRunId && (live || !stale.has(w.activeRunId)))) return false;
  if (!live) return true;
  return !data.works.some(
    (w) =>
      w.status !== 'done' &&
      w.status !== 'cancelled' &&
      // Нет диагноза — ход controller; `null` (ждёт зависимости) — ничей.
      (w.stage?.needs ? w.stage.needs.actor : 'controller') === 'controller',
  );
}

/** Кадр `status --human --watch`: время снимка, период, текст `statusText`. */
export function statusFrame(
  data: z.output<typeof statusDataSchema>,
  at: number,
  intervalMs: number,
): string {
  return (
    `harness status — ${new Date(at).toISOString()} (обновление каждые ${Math.round(intervalMs / 1000)} с; Ctrl-C — выход)\n` +
    statusText(data)
  );
}
