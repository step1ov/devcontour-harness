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
import { nextRunControl, repairJobOf, stopInputsIn, type StopSource } from '../explain/state.ts';
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
    line: attemptSummaryLine(summary, budget),
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
          const input =
            view.input && w.status !== 'done' && w.status !== 'cancelled' ? view.input : undefined;
          const active = w.activeRunId ? v.attempt(w.activeRunId) : undefined;
          // Причина простыми словами и кто её снимает — рядом с кодом и сообщением.
          const needs =
            needsOf?.(w) ??
            (input?.state === 'awaiting-answer'
              ? {
                  // Технический вопрос при leadAnswers.technical решает ведущий.
                  actor: input.leadMay === 'technical' ? ('lead' as const) : ('user' as const),
                  action: 'answer-input' as const,
                }
              : undefined);
          const plainContext = {
            control: v.control(),
            approvalMode: source.policy.approvalMode,
            status: w.status,
            work: w,
            statusOf: (id: string) => v.work(id)?.status,
            needsOf: (id: string) => ((d) => (d ? needsOf?.(d) : undefined))(v.work(id)),
            ...(needs ? { needs } : {}),
          };
          const blockers = raw.map((b) => ({ ...b, ...plainBlocker(b, plainContext) }));
          // Строка этапа называет блокировку, которую снимает человек, раньше
          // хода ведущего и harness (порядок `blockers` прежний).
          const first = [...blockers].sort((a, b) => actorRank(a.actor) - actorRank(b.actor))[0];
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
              now,
            }),
            ...(verification ? { verification } : {}),
          };
        })(workInputOf(requestsOf(v, w), inputPolicyOf(source.policy)), engine.blockers(w, v)),
      })),
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
  const out = [
    c.paused ? `Выдача на паузе${c.pauseReason ? ` (${c.pauseReason})` : ''}.` : 'Выдача идёт.',
  ];
  if (!data.works.length) out.push('Поручений нет.');
  for (const w of data.works) {
    out.push(`${w.id} [${w.status}]${w.attemptSummary ? ': ' + w.attemptSummary.line : ''}`);
    if (w.stage) out.push(`  сейчас: ${w.stage.line.slice(w.id.length + 2)}`);
    if (w.input)
      out.push(
        `  вопрос ${w.input.requestId} [${w.input.state}, серьёзность ${w.input.severity}${w.input.impact === 'technical' ? ', технический' : ''}]` +
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
    if (w.blockers.length)
      out.push(
        `  не выдаётся: ${[...w.blockers]
          .sort((a, b) => actorRank(a.actor) - actorRank(b.actor))
          .map((b) =>
            // Без простого текста (ответ другой версии) — общий текст кода,
            // а не сообщение: в нём может быть текст хоста.
            b.plain
              ? `${b.plain}${b.actor ? ` (${actorText[b.actor]})` : ''}`
              : (blockerCodeText[b.code as BlockerCode]?.ru ?? b.code),
          )
          .join('; ')} [коды: ${w.blockers.map((b) => b.code).join(', ')}]`,
      );
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
      (w.stage?.needs?.actor ?? 'controller') === 'controller',
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
