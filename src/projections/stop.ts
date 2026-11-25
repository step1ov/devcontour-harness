import { failureRefOf } from '../contracts/failure-catalog.ts';
import { RU, ruCount } from '../contracts/plural.ts';
import { errorCodes, type ErrorCode } from '../contracts/errors.ts';
import {
  NO_RETRY_ENVIRONMENT_EXPLAIN,
  repairPolicy,
  repairRepeats,
} from '../contracts/repair-policy.ts';
import type { NoRetryEnvironmentCause } from '../contracts/execution.ts';
import { CLIP_DIAGNOSTIC, clipText } from './clip.ts';
import type { Actor, FailureKind, NextAction, PauseReason, WorkStatus } from './enums.ts';
import type { InputState } from './input.ts';
import { ruleOutcome } from './decisions.ts';
import { gateHoldLine, type RetryRoute } from './gate-hold.ts';

/**
 * Код остановки по классу отказа. Это та же таблица, которой RunResult
 * называет stopReason: сетевой класс приходит из сохранённого failureKind
 * (его ставит classifyFailure в точке отказа), текст здесь не разбирается.
 */
export function stopCodeOf(kind: FailureKind | undefined): ErrorCode {
  switch (kind) {
    case 'gate':
    case 'empty-result':
      return 'GATE_FAILED';
    case 'review':
      return 'REVIEW_REJECTED';
    case 'needs-lead':
      return 'APPROVAL_REQUIRED';
    case 'review-protocol':
      return 'REVIEW_PROTOCOL_INVALID';
    case 'scope-violation':
      return 'SCOPE_VIOLATION';
    case 'budget':
      return 'BUDGET_EXHAUSTED';
    case 'cancelled':
      return 'CANCELLED';
    case 'context-exhausted':
      return 'CONTEXT_EXHAUSTED';
    case 'needs-input':
      return 'INPUT_REQUIRED';
    case 'provider-auth':
    case 'environment':
    case 'timeout':
    case 'stalled':
      return 'RUNTIME_UNAVAILABLE';
    case 'stale-base':
    case 'merge':
      return 'GIT_FAILED';
    default:
      return 'INTERNAL';
  }
}

export interface QueuePause {
  code: ErrorCode;
  cause: StopCause;
  actor: Actor;
  action: NextAction;
}

/**
 * Кто и что снимает паузу выдачи — то же рассуждение, которым `explainStop`
 * объясняет остановку на claim: пауза оператора и штатной остановки снимается
 * `resume`; пауза отказа runtime — исправлением первого класса отказа
 * (`pauseFailures`, без него — окружение); паузу reconfigure и base-check
 * снимает сама операция. Без паузы — `undefined`. Пауза без причины —
 * прежние записи паузы рантайма (как в `queueStop`).
 */
export function queuePause(control: {
  paused: boolean;
  pauseReason?: PauseReason;
  pauseFailures?: readonly FailureKind[];
}): QueuePause | undefined {
  if (!control.paused) return undefined;
  const reason = control.pauseReason ?? 'runtime';
  if (reason === 'operator' || reason === 'shutdown')
    return { code: 'PAUSED', cause: 'operator-pause', actor: 'user', action: 'resume-queue' };
  if (reason === 'runtime') {
    const paused = control.pauseFailures?.[0] ?? 'environment';
    return {
      code: stopCodeOf(paused),
      cause: paused,
      actor: 'user',
      action: paused === 'provider-auth' ? 'fix-access' : 'fix-environment',
    };
  }
  return { code: 'PAUSED', cause: 'not-ready', actor: 'controller', action: 'wait' };
}

export const stopCauses = [
  'provider-auth',
  'environment',
  'timeout',
  'stalled',
  'context-exhausted',
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
  'needs-input',
  'unknown',
  'runtime-missing',
  'controller-busy',
  'operator-pause',
  'approval-required',
  'not-ready',
] as const;
export type StopCause = (typeof stopCauses)[number];
export const stopPhases = [
  'preflight',
  'claim',
  'implementation',
  'gates',
  'review',
  'integration',
  'delivery',
] as const;
export type StopPhase = (typeof stopPhases)[number];
export interface EvidenceLink {
  kind: 'attempt' | 'evidence' | 'event' | 'doctor';
  id: string;
  sha?: string;
}
export type StopInput =
  | {
      kind: 'work';
      work: {
        id: string;
        status: WorkStatus;
        attempt: number;
        failureKind?: FailureKind;
        /** Предел окна контекста последнего отказа `context-exhausted`. */
        contextLimit?: 'prompt-too-long' | 'blocking-limit';
        /**
         * Отказ окружения без повтора (`sandbox-process-list`, 0.1.0-alpha.66;
         * `sandbox-signal`, `sandbox-browser` — 0.1.0-alpha.68): повтора нет,
         * ход ведущего — поменять gate или команду.
         */
        environmentCause?: NoRetryEnvironmentCause;
        /**
         * Gate работы удержан отказом без повтора (`ENVIRONMENT_GATE_HELD`,
         * 0.1.0-alpha.66): `workId` — работа, чья попытка упала на ps из базы.
         */
        gateHold?: {
          gate: string;
          workId: string;
          runId: string;
          route?: RetryRoute;
          /** Причина удержания; нет — `sandbox-process-list`. */
          cause?: NoRetryEnvironmentCause;
        };
        /**
         * Отказ без повтора исчерпал предел незасчитанных отказов работы
         * (`MAX_NEUTRAL_FAILURES`): маршрут повтора (`retryRoute`) — ход по
         * исчерпанию, а не простой повтор ведущего.
         */
        retryRoute?: RetryRoute;
        failure?: string;
        /**
         * Один и тот же провал gate у засчитанных провалов с несвязанными
         * изменениями (`repeatedGateFailure`, 0.1.0-alpha.69): подсказка
         * ведущему проверить gate и тест базы, с командой прогона на базе.
         */
        repeatedFailure?: { line: string };
        /**
         * Отказ до начала работы (причина `preflight`): последняя попытка не
         * засчитана и исполнитель не вызывался — фаза `preflight`, у
         * `needs-lead` — неполные входы работы, а не пустой результат.
         */
        preflight?: boolean;
        /**
         * Исполнитель остановился, назвав причиной окружение (`writerBlocked`
         * последней попытки): ход ведущего; `summary` — итог исполнителя.
         */
        writerBlocked?: { summary?: string };
        /**
         * Исполнитель предложил разделить работу (alpha.70, `writerSplit`
         * последней попытки): ID предложения и частей; решает ведущий.
         */
        writerSplit?: { proposal: string; parts: number; status?: string };
        hold?: { operation: string; reason: string };
        budgetBlock?: { reason: string };
        /**
         * Эпизод восстановления свойства: работу ведёт его разбор, а не штатный
         * repair. Статус — как в `PropertyRecovery.status`.
         */
        recovery?: { status: string };
        /**
         * Восстановление ведущим (`policy.recovery.mode: lead`): удержание
         * выдачи (разбор после `diagnoseAfter` отказов, перепланирование,
         * противоречие), ход по исчерпанным попыткам и строка последнего
         * сброса ведущего. Нет поля — правило `user`, explain прежний.
         */
        leadRecovery?: {
          hold?:
            | { kind: 'diagnosis-required'; failures: string[] }
            | { kind: 'replan' | 'contradiction'; diagnosis: string; hypothesis?: string };
          exhausted:
            | {
                actor: 'lead';
                step: 'diagnose' | 'reset' | 'replan';
                diagnosis?: string;
                index?: number;
                cap?: number;
              }
            | { actor: 'user'; why: string; diagnosis?: string };
          leadResets: number;
          line?: string;
        };
        /** Незавершённые предпосылки, на которых движок остановит задание. */
        waitingOn?: string[];
        /**
         * alpha.67: открытые работы инфраструктуры прежнего графа её
         * репозиториев (draft, исчерпанные, упавшие — тоже): пока они не
         * приняты или не отменены, работа не выдаётся.
         */
        infraWaitingOn?: string[];
        /** Согласование графа устарело для этой политики (режим operator). */
        approvalStale?: string;
        /**
         * Ревью плана графа идёт в живом процессе `harness run` (запись вызова
         * `plan-review` открыта, её процесс жив): согласование — ход harness,
         * а не ведущего. `since` — начало вызова.
         */
        planReview?: { since: string };
        /**
         * У отменённой работы: незавершённые работы, которые прямо от неё
         * зависят. Пусто — перепланировать нечего (действия нет); не задано —
         * неизвестно, прежнее replan-dependents.
         */
        openDependents?: string[];
        /**
         * Отменённая работа той же группы, из-за которой движок не
         * восстанавливает группу сам (`repairDecision`: любая отмена — stop).
         */
        repairStoppedBy?: string;
        /**
         * Активная попытка без движения по обходу controller: что не
         * двигалось, сколько и что controller сделает (`action` у stalled).
         */
        /**
         * Открытая стадия активной попытки (последний незакрытый замер) и её
         * начало: подготовка (`prepare`, `dependency-store`) видна до исполнителя.
         */
        openStage?: { stage: string; startedAt: string; preparing: boolean };
        liveness?: {
          state: 'quiet' | 'stalled';
          lastMovementAt: string;
          activity?: string;
          action?: 'stop' | 'report';
        };
        /**
         * Вопрос исполнителя, держащий работу (`needs-input`): состояние,
         * вопрос и варианты (усечённые), ответ — версией и digest, без
         * текста; почему ответ сейчас не применяется; сколько решений
         * исполнитель принял сам и сколько запросов ждут ведущего.
         */
        input?: {
          requestId: string;
          state: InputState;
          question?: string;
          options?: string[];
          /** Рекомендуемый исполнителем вариант (ID). */
          recommended?: string;
          /** Исполнитель пометил вопрос техническим (`impact: technical`). */
          impact?: 'technical';
          /** Вопрос ждёт ответа, и политика разрешает ответ ведущему — по этому правилу. */
          leadMay?: 'technical' | 'severity';
          /**
           * Последний ответ; `by` — кто его записал (оператор, ведущий, хост);
           * `basis` — правило политики ответа ведущего, `reason` — его причина.
           */
          answer?: {
            revision: number;
            digest: string;
            by?: 'operator' | 'lead' | 'host';
            basis?: 'technical' | 'severity';
            reason?: string;
          };
          refusal?: string;
          assumptions?: number;
          followUps?: number;
        };
      };
      maxAttempts: number;
      repair: {
        sameFailureRepairs: number;
        groupRepairsUsed: number;
        groupRepairBudget: number;
        /**
         * Что движок сделает с этой работой, когда продолжит задание графа
         * (вычисляется тем же порядком решений, что `advance`): `retry` —
         * назначит повтор, `wait` — сначала занят другим (разбор свойства,
         * другое поручение группы), `stop` — автоматического действия нет.
         * Не задано — решение выводится из счётчиков.
         */
        outlook?: 'retry' | 'wait' | 'stop';
      };
      control: { paused: boolean; pauseReason?: PauseReason; pauseFailures?: FailureKind[] };
      phase?: StopPhase;
      runId?: string;
      evidence?: EvidenceLink[];
    }
  | { kind: 'error'; error: { code: ErrorCode; message: string } }
  /**
   * Неблокирующий запрос ведущему (follow-up): критическое решение,
   * принятое исполнителем в автономном режиме. Работу он не держит.
   */
  | {
      kind: 'input';
      request: { id: string; workId: string; question: string; severity: number };
    }
  | { kind: 'runtime'; runtime: { runtime: string; available: boolean; reason?: string } };
export interface StopDiagnosis {
  code: ErrorCode;
  cause: StopCause;
  phase: StopPhase;
  actor: Actor;
  action: NextAction;
  retryPlanned: boolean;
  message: string;
  evidence: EvidenceLink[];
  workId?: string;
  runId?: string;
  /** Справочник причин отказов (alpha.70): `docs/failure-causes.md#…`. */
  reference?: string;
}

/** Кто ответил на вопрос исполнителя — словами сообщения. */
const answerActorText = { operator: 'оператор', lead: 'ведущий', host: 'хост' } as const;

/** Русский шаблон сообщения по причине остановки. */
const causeText: Record<StopCause, string> = {
  'provider-auth': 'Провайдер отказал: runtime не авторизован, нет кредитов или исчерпан лимит.',
  environment: 'Окружение не дало исполнителю работать (сеть, TLS/DNS, процесс runtime).',
  timeout: 'Попытка исчерпала отведённое время.',
  stalled:
    'Процесс попытки жив, но не двигался дольше порога: нет вывода, расхода процессора и смены стадий.',
  'context-exhausted':
    'Исполнителю не хватило окна контекста модели: задача или её контекст не помещаются в одну попытку.',
  'stale-base': 'База прогонов отстала от рабочей ветки.',
  'empty-result': 'Исполнитель отчитался о выполнении, не изменив ни одного файла.',
  unfinished: 'Исполнитель не доделал работу и сообщил об этом.',
  'scope-violation': 'Изменения вышли за область поручения или роли.',
  gate: 'Настроенная проверка не прошла.',
  review: 'Независимое ревью отклонило результат.',
  'review-protocol': 'Ответ reviewer нарушил протокол ревью; повторы reviewer исчерпаны.',
  merge: 'Слияние с веткой интеграции не сошлось.',
  cancelled: 'Работа отменена человеком.',
  budget: 'Бюджет расходов или времени исчерпан либо не определён.',
  'needs-lead':
    'Пустой результат без механического основания считать работу сделанной: решение ведущего.',
  'needs-input': 'Исполнитель остановился с вопросом: работа ждёт ответа и его применения.',
  unknown: 'Класс отказа не определён.',
  'runtime-missing': 'Назначенный политикой runtime не найден или не отвечает на --version.',
  'controller-busy': 'Очередь ведёт другой процесс controller.',
  'operator-pause': 'Очередь остановлена.',
  'approval-required': 'Граф ждёт ревью и согласования плана.',
  'not-ready': 'Поручение не готово к выдаче.',
};

/** Фаза по умолчанию для класса отказа поручения. */
const failurePhase: Record<FailureKind, StopPhase> = {
  'provider-auth': 'implementation',
  environment: 'implementation',
  timeout: 'implementation',
  stalled: 'implementation',
  'context-exhausted': 'implementation',
  unknown: 'implementation',
  'empty-result': 'implementation',
  unfinished: 'implementation',
  'needs-lead': 'review',
  'needs-input': 'implementation',
  gate: 'gates',
  review: 'review',
  'review-protocol': 'review',
  'stale-base': 'integration',
  merge: 'integration',
  'scope-violation': 'integration',
  budget: 'claim',
  cancelled: 'claim',
};

const activePhase: Partial<Record<WorkStatus, StopPhase>> = {
  running: 'implementation',
  verifying: 'gates',
  reviewing: 'review',
  integrating: 'integration',
};

type Outcome = Pick<StopDiagnosis, 'code' | 'cause' | 'phase' | 'actor' | 'action'> & {
  /** Пояснение к шаблону причины (без текста отказа). */
  note?: string;
  /** Текст причины вместо шаблона `causeText` (та же причина, другой случай). */
  text?: string;
};

/** Шаблон `needs-lead` для отказа до начала работы (неполные входы, не пустой результат). */
const preflightNeedsLeadText =
  'Работа отказала до начала: её входы при загрузке неполны (например, не найден закреплённый при выдаче снимок контекста); решение ведущего.';
/** Последствия и шаг — без повтора причины (полное объяснение — `PREFLIGHT_NEEDS_LEAD_EXPLAIN`). */
const preflightNeedsLeadSteps =
  'Попытка не засчитана, исполнитель не вызывался, очередь не остановлена, автоматического повтора нет: восстановите входы (снимок) или согласуйте работу заново, затем повторите.';

/** Шаблон `needs-lead` для остановки исполнителя из-за окружения (`writerBlocked`). */
const writerBlockedText =
  'Исполнитель остановился, не доделав работу: окружение закрыло обязательный шаг; решение ведущего.';
/** Итог исполнителя и шаг ведущего (полное объяснение — `WRITER_BLOCKED_EXPLAIN`). */
const writerBlockedSteps = (summary: string | undefined) =>
  (summary ? `Итог исполнителя: «${clipText(summary, 300)}». ` : '') +
  'Попытка не засчитана, автоматического повтора нет: проверьте шаг (harness smoke --writer-probe), разрешите его в политике, положите источник в контекст или вынесите шаг в проверки harness, затем повторите работу.';

/** Шаблон `needs-lead`: исполнитель предложил разделить работу (alpha.70). */
const writerSplitText =
  'Исполнитель в начале попытки предложил разделить работу и кода не писал; решение ведущего.';
const writerSplitSteps = (split: { proposal: string; parts: number; status?: string }) =>
  `Предложение ${split.proposal}, частей ${split.parts}${split.status && split.status !== 'proposed' ? ` (${split.status === 'accepted' ? 'принято' : 'отклонено'})` : ''}. Попытка не засчитана. Принять — harness proposal --proposal ${split.proposal} --decision accept и внести части в план (review-plan); отклонить — --decision reject с основанием и повторить работу (retry --by lead).`;

const message = (cause: StopCause, ...parts: (string | undefined)[]) =>
  messageWith(causeText[cause], ...parts);

const messageWith = (head: string, ...parts: (string | undefined)[]) =>
  clipText(
    [head, ...parts.filter((p): p is string => Boolean(p))].join(' '),
    // clipText добавляет «…» сверх предела: итог не длиннее CLIP_DIAGNOSTIC.
    CLIP_DIAGNOSTIC - 1,
  )!;

/**
 * Решение движка о повторе, как его принял бы `repairDecision`: класс
 * разрешает повтор, одинаковый отпечаток не исчерпан, бюджет попыток и
 * восстановлений группы не исчерпан. Только описание: ничего не планирует.
 */
function retryPlannedOf(
  input: Extract<StopInput, { kind: 'work' }>,
  /** Не учитывать ожидание инфраструктуры (повтор был бы по классу отказа). */
  ignoreInfra = false,
) {
  const { work, repair, maxAttempts } = input;
  if (work.status !== 'failed') return false;
  // Ожидание инфраструктуры прежнего графа: повтор не выдастся.
  if (!ignoreInfra && work.infraWaitingOn?.length) return false;
  if (work.leadRecovery?.hold) return false;
  if (work.recovery) return work.recovery.status === 'retry' && repair.outlook === 'retry';
  if (repair.outlook !== undefined && repair.outlook !== 'retry') return false;
  const rule = repairPolicy[work.failureKind ?? 'unknown'];
  return (
    rule.action === 'retry' &&
    repair.sameFailureRepairs <
      repairRepeats(work.failureKind ?? 'unknown', work.contextLimit, work.environmentCause) &&
    work.attempt < maxAttempts &&
    repair.groupRepairsUsed < repair.groupRepairBudget
  );
}

/**
 * Отмена — решение ведущего (перепланировать ждущих), только пока от работы
 * прямо зависит незавершённая; без таких — действия нет. Состав не известен
 * (`undefined`) — прежнее replan-dependents.
 */
function cancelledOutcome(
  dependents: string[] | undefined,
  phase: StopPhase,
  failed = false,
): Outcome {
  // Упавшая отменой работа открыта, а движок её не повторяет: без ждущих
  // решает человек — повторить или отменить её.
  if (failed && dependents && !dependents.length)
    return {
      code: 'CANCELLED',
      cause: 'cancelled',
      phase,
      actor: 'user',
      action: 'user-decision',
      note: 'Попытка отменена, работа открыта, движок её не повторяет: повторить (harness retry) или отменить работу.',
    };
  if (dependents && !dependents.length)
    return {
      code: 'CANCELLED',
      cause: 'cancelled',
      phase,
      actor: null,
      action: 'none',
      note: 'Незавершённых зависимых работ нет: перепланировать нечего.',
    };
  return {
    code: 'CANCELLED',
    cause: 'cancelled',
    phase,
    actor: 'lead',
    action: 'replan-dependents',
    ...(dependents
      ? {
          note: `Ждут отменённую: ${dependents.slice(0, 5).join(', ')}${dependents.length > 5 ? ` и ещё ${dependents.length - 5}` : ''}.`,
        }
      : {}),
  };
}

function workOutcome(input: Extract<StopInput, { kind: 'work' }>, retry: boolean): Outcome {
  const { work, control, maxAttempts } = input;
  // Открытая работа инфраструктуры прежнего графа держит выдачу: готовой
  // работы и упавшей, которую повторил бы controller (повтор не выдался бы).
  // Ход человека или ведущего по упавшей (разбор, сброс) остаётся её шагом.
  if (
    work.infraWaitingOn?.length &&
    (work.status === 'ready' || (work.status === 'failed' && retryPlannedOf(input, true)))
  )
    return {
      code: 'NOT_READY',
      cause: 'not-ready',
      phase: 'claim',
      // Как ожидание зависимости: по этой работе не действует никто; шаг —
      // по диагнозу работы инфраструктуры (её разбор, согласование, сброс или
      // отмена по плану). Движок её сам не отменяет.
      actor: null,
      action: 'wait',
      note: `Ждёт работы инфраструктуры прежнего графа ${work.infraWaitingOn.join(', ')}: продуктовая работа её репозитория не выдаётся, пока та не принята или не отменена; следующий шаг — по диагнозу ${work.infraWaitingOn[0]} (harness explain --work ${work.infraWaitingOn[0]}).`,
    };
  const kind: FailureKind = work.failureKind ?? 'unknown';
  // Отказ до начала работы — фаза preflight, какой бы ни была фаза попытки.
  const phase = work.preflight ? 'preflight' : (input.phase ?? failurePhase[kind]);
  const exhausted = `Исчерпано ${work.attempt} из ${ruCount(maxAttempts, RU.attemptGen)}; сброс — решение человека.`;
  const exhaustedOutcome = (): Outcome => {
    const lead = work.leadRecovery?.exhausted;
    const head = `Исчерпано ${work.attempt} из ${ruCount(maxAttempts, RU.attemptGen)}`;
    if (lead?.actor === 'lead')
      return lead.step === 'reset'
        ? {
            ...ruleOutcome('exhausted-lead-reset'),
            code: 'ATTEMPTS_EXHAUSTED',
            cause: kind,
            phase: 'claim',
            note: `${head}; есть свежий технический разбор ${lead.diagnosis}: ведущий сам даёт новый предел (сброс ${lead.index} из ${lead.cap}) — harness retry --work ${work.id} --reset --by lead --diagnosis ${lead.diagnosis}.`,
          }
        : lead.step === 'replan'
          ? {
              ...ruleOutcome('diagnosis-split'),
              cause: kind,
              phase: 'claim',
              note: `${head}; разбор ${lead.diagnosis}: задача велика — перепланируйте и согласуйте разделение.`,
            }
          : {
              ...ruleOutcome('exhausted-diagnose'),
              code: 'ATTEMPTS_EXHAUSTED',
              cause: kind,
              phase: 'claim',
              note: `${head}; сбросы ведущего ещё есть: ведущий разбирает последний отказ (harness diagnose --work ${work.id} --cause … --hypothesis "…"), при технической причине даёт новый предел сам.`,
            };
    const why = lead?.actor === 'user' ? lead.why : undefined;
    return {
      ...ruleOutcome('exhausted-user'),
      code: 'ATTEMPTS_EXHAUSTED',
      cause: kind,
      phase: 'claim',
      note:
        why === 'cap'
          ? `${head}; сбросы ведущего потрачены (${work.leadRecovery!.leadResets}): сброс — решение человека.`
          : why === 'cause'
            ? `${head}; разбор ${lead!.diagnosis} — не техническая причина: сброс — решение человека.`
            : why === 'repeated'
              ? `${head}; по разбору ${lead!.diagnosis} уже сбрасывали: сброс — решение человека.`
              : why === 'budget'
                ? `${head}; бюджет работы исчерпан: решение человека.`
                : exhausted,
    };
  };
  if (work.status === 'done')
    return {
      code: 'NOT_READY',
      cause: 'not-ready',
      phase: 'delivery',
      actor: null,
      action: 'none',
      note: 'Поручение принято.',
    };
  // Ревью плана уже идёт: согласование ведёт harness (ниже, вместо шага
  // согласования); вопрос, исчерпание и отказ остаются впереди.
  if (work.approvalStale && !work.planReview)
    return {
      code: 'APPROVAL_STALE',
      cause: 'approval-required',
      phase: 'claim',
      actor: 'lead',
      action: 'review-plan',
      note: work.approvalStale,
    };
  const automatic = input.repair.outlook === 'wait';
  if (
    work.recovery &&
    !retry &&
    // Исчерпанные попытки — раньше эпизода: движок откажет в повторе по ним.
    !(work.status === 'failed' && work.attempt >= maxAttempts) &&
    (work.status === 'failed' ||
      // Готовую работу эпизод держит, только если не разрешает выдачу (как
      // blocksClaim движка) или разрешённый повтор не выдаётся очередью.
      (work.status === 'ready' &&
        !automatic &&
        (!['retry', 'closed'].includes(work.recovery.status) ||
          control.paused ||
          Boolean(work.hold) ||
          Boolean(work.budgetBlock))))
  ) {
    // Работу ведёт разбор свойства: шаг определяет его статус, а не класс отказа.
    if (
      !automatic &&
      control.paused &&
      (work.status === 'failed' || (work.status === 'ready' && work.recovery.status === 'retry')) &&
      (work.recovery.status === 'awaiting-lead' || work.recovery.status === 'retry')
    )
      // Разрешённый повтор не выдаётся, пока очередь стоит: сначала снять паузу.
      return control.pauseReason === 'runtime'
        ? {
            code: stopCodeOf(control.pauseFailures?.[0] ?? 'environment'),
            cause: control.pauseFailures?.[0] ?? 'environment',
            phase: 'claim',
            actor: 'user',
            action:
              control.pauseFailures?.[0] === 'provider-auth' ? 'fix-access' : 'fix-environment',
            note: `Восстановление свойства (${work.recovery.status}) ждёт снятия паузы runtime.`,
          }
        : {
            code: 'PAUSED',
            cause: 'operator-pause',
            phase: 'claim',
            actor: 'user',
            action: 'resume-queue',
            note: `Восстановление свойства (${work.recovery.status}) ждёт снятия паузы.`,
          };
    if (!automatic && work.budgetBlock)
      return {
        code: 'BUDGET_EXHAUSTED',
        cause: 'budget',
        phase: 'claim',
        actor: 'user',
        action: 'raise-budget',
        note: `Восстановление свойства (${work.recovery.status}) не продолжится: ${work.budgetBlock.reason}`,
      };
    return automatic
      ? {
          code: stopCodeOf(kind),
          cause: kind,
          phase,
          actor: 'controller',
          action: 'wait',
          note: `Идёт восстановление свойства (${work.recovery.status}): движок продолжит его сам.`,
        }
      : {
          code: stopCodeOf(kind),
          cause: kind,
          phase,
          actor: 'user',
          action: 'user-decision',
          note: `Восстановление свойства (${work.recovery.status}) ждёт решения человека.`,
        };
  }
  if (
    work.status === 'failed' &&
    !retry &&
    work.attempt < maxAttempts &&
    input.repair.outlook === 'wait'
  )
    return {
      code: stopCodeOf(kind),
      cause: kind,
      phase,
      actor: 'controller',
      action: 'wait',
      note: 'Движок сначала занят другим поручением группы.',
    };
  // Вопрос исполнителя: шаг определяет состояние запроса, а не класс отказа.
  const question = work.input;
  if (
    question &&
    work.status !== 'cancelled' &&
    (question.state === 'awaiting-answer' ||
      question.state === 'answered-not-applied' ||
      question.state === 'carry-stale')
  ) {
    const head = `Вопрос ${question.requestId}${question.question ? `: «${clipText(question.question, 200)}»` : ''}${question.options?.length ? `; варианты: ${question.options.join(', ')}` : ''}${question.recommended ? `; рекомендация исполнителя: ${question.recommended}` : ''}.`;
    const by =
      question.answer?.basis === 'technical'
        ? ` (решено ведущим (технический вопрос)${question.answer.reason ? `: ${clipText(question.answer.reason, 200)}` : ''})`
        : question.answer?.by
          ? ` (ответил: ${answerActorText[question.answer.by]})`
          : '';
    const own = [
      question.assumptions ? `Решено исполнителем: ${question.assumptions}.` : '',
      question.followUps ? `Запросов ведущему: ${question.followUps}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (question.state === 'awaiting-answer' && question.leadMay === 'technical')
      return {
        ...ruleOutcome('input-technical'),
        code: 'INPUT_REQUIRED',
        cause: 'needs-input',
        phase,
        note: [
          head,
          'Технический вопрос: политика разрешает ведущему решить его самому (inputPolicy.leadAnswers.technical) — harness input-answer --actor lead --reason "<почему>"; ответ будет показан как «решено ведущим (технический вопрос)». Если выбор всё же меняет то, что увидит пользователь, передайте вопрос человеку дословно с одной строкой пояснения.',
          own,
        ]
          .filter(Boolean)
          .join(' '),
      };
    if (question.state === 'awaiting-answer')
      return {
        ...ruleOutcome('input-user'),
        code: 'INPUT_REQUIRED',
        cause: 'needs-input',
        phase,
        note: [
          head,
          'Вопрос к человеку: передайте ему вопрос, варианты и рекомендацию дословно и запишите его ответ его словами — harness input-answer --actor operator; ведущий (--actor lead) сам не отвечает, если политика этого не разрешила (inputPolicy.leadAnswers).',
          own,
        ]
          .filter(Boolean)
          .join(' '),
      };
    if (question.state === 'carry-stale')
      return {
        code: 'INPUT_REQUIRED',
        cause: 'needs-input',
        phase,
        actor: 'lead',
        action: 'apply-input',
        note: [
          head,
          `Перенесённый ответ r${question.answer?.revision ?? '?'}${by} устарел до выдачи${question.refusal ? `: ${question.refusal}` : ''}.`,
          'Выходы: перенести снова (harness input-carry --request <id> --reason …) или снять перенесённый ответ (input-cancel) — работа продолжится без него.',
          own,
        ]
          .filter(Boolean)
          .join(' '),
      };
    return {
      code: 'INPUT_REQUIRED',
      cause: 'needs-input',
      phase,
      actor: 'lead',
      action: 'apply-input',
      note: [
        head,
        `Ответ r${question.answer?.revision ?? '?'} (${question.answer?.digest.slice(0, 12) ?? '—'})${by} записан, но не применён${question.refusal ? `: ${question.refusal}` : ''}.`,
        'Дальше: harness input-resolve --request <id> (снимок, ревью плана и применение одним вызовом; по шагам — input-context, review-plan со снимком, input-apply).',
        own,
      ]
        .filter(Boolean)
        .join(' '),
    };
  }
  // Gate удержан отказом без повтора: выдачи нет, пока ведущий не поменяет
  // gate или не повторит остановленную работу после исправления теста.
  const gateHold = work.gateHold;
  if (gateHold && (work.status === 'ready' || work.status === 'draft'))
    return {
      ...ruleOutcome('environment-gate-held'),
      cause: 'environment',
      phase: 'claim',
      note: gateHoldLine(gateHold, work.id, gateHold.route).ru + '.',
    };
  // Восстановление ведущим держит выдачу: разбор, перепланирование или
  // решение человека по противоречию — раньше класса отказа и исчерпания.
  const hold = work.leadRecovery?.hold;
  if (hold && work.status !== 'cancelled') {
    if (hold.kind === 'diagnosis-required')
      return {
        ...ruleOutcome('diagnosis-required'),
        cause: kind,
        phase: 'claim',
        note: `Засчитанных отказов без разбора: ${hold.failures.length} (${hold.failures.join(', ')}). Третьей слепой попытки нет: ведущий разбирает причину — harness diagnose --work ${work.id} --cause coverage|approach|split|contradiction|environment|other --hypothesis "…"; следующая попытка получит гипотезу.`,
      };
    if (hold.kind === 'replan')
      return {
        ...ruleOutcome('diagnosis-split'),
        cause: kind,
        phase: 'claim',
        note: `Разбор ${hold.diagnosis}: задача велика — ведущий перепланирует (новая редакция графа с разделением) и проводит ревью плана; попыток это само не добавляет.`,
      };
    return {
      ...ruleOutcome('diagnosis-contradiction'),
      cause: kind,
      phase: 'claim',
      note: `Разбор ${hold.diagnosis}: противоречивое обещание${hold.hypothesis ? ` — «${clipText(hold.hypothesis, 300)}»` : ''}. Решение человека: уточнить постановку (новая редакция) или сбросить попытки с причиной.`,
    };
  }
  if (work.status === 'failed') {
    if (work.attempt >= maxAttempts) return exhaustedOutcome();
    if (retry)
      return {
        code: stopCodeOf(kind),
        cause: kind,
        phase,
        actor: 'controller',
        action: 'retry',
        note: 'Движок назначит повтор в пределах бюджетов.',
      };
    switch (kind) {
      case 'provider-auth':
        return {
          code: 'RUNTIME_UNAVAILABLE',
          cause: kind,
          phase,
          actor: 'user',
          action: 'fix-access',
        };
      case 'environment':
      case 'timeout':
      case 'stalled':
        // Gate зовёт ps в песочнице ОС: повтор не поможет, правит ведущий.
        // Предел незасчитанных отказов исчерпан и без такой причины
        // (alpha.71, P8-4(b)): ход по исчерпанию из того же правила.
        if (kind === 'environment' && (work.environmentCause || work.retryRoute?.limit)) {
          // Предел незасчитанных отказов исчерпан: простой повтор ведущего
          // движок отклонит — ход по исчерпанию из того же правила.
          const route = work.retryRoute;
          if (route?.limit)
            return {
              ...ruleOutcome(
                route.step === 'user-reset'
                  ? 'exhausted-user'
                  : route.step === 'reset'
                    ? 'exhausted-lead-reset'
                    : route.step === 'replan'
                      ? 'diagnosis-split'
                      : 'exhausted-diagnose',
              ),
              ...(route.step === 'replan' ? {} : { code: 'ATTEMPTS_EXHAUSTED' as const }),
              cause: kind,
              phase: 'claim',
              note:
                `${work.environmentCause ? NO_RETRY_ENVIRONMENT_EXPLAIN[work.environmentCause] : 'Попытки работы съели отказы окружения; после исправления окружения ведущий разбирает их причиной environment с доказательством (harness diagnose --cause environment --evidence …) и сбрасывает попытки сам.'} У работы ${route.limit.ru}: ` +
                `${route.actor === 'user' ? 'сброс — решение человека с причиной' : 'ход ведущего'} — ${route.command}.`,
            };
          if (work.environmentCause)
            return {
              ...ruleOutcome('environment-gate-command'),
              cause: kind,
              phase,
              note: NO_RETRY_ENVIRONMENT_EXPLAIN[work.environmentCause],
            };
        }
        return {
          code: 'RUNTIME_UNAVAILABLE',
          cause: kind,
          phase,
          actor: 'user',
          action: 'fix-environment',
        };
      case 'needs-lead':
        return {
          code: stopCodeOf(kind),
          cause: kind,
          phase,
          actor: 'lead',
          action: 'diagnose-failure',
          ...(work.writerSplit
            ? { text: writerSplitText, note: writerSplitSteps(work.writerSplit) }
            : work.writerBlocked
              ? {
                  text: writerBlockedText,
                  note: writerBlockedSteps(work.writerBlocked.summary),
                }
              : work.preflight
                ? { text: preflightNeedsLeadText, note: preflightNeedsLeadSteps }
                : {}),
        };
      case 'review-protocol':
      case 'unknown':
        return {
          code: stopCodeOf(kind),
          cause: kind,
          phase,
          actor: 'user',
          action: 'user-decision',
        };
      case 'budget':
        return {
          code: 'BUDGET_EXHAUSTED',
          cause: kind,
          phase: 'claim',
          actor: 'user',
          action: 'raise-budget',
        };
      case 'cancelled':
        // Поручение со статусом failed и классом cancelled: отмена не повторяется.
        return cancelledOutcome(work.openDependents, phase, true);
      case 'context-exhausted':
        return {
          code: stopCodeOf(kind),
          cause: kind,
          phase,
          actor: 'lead',
          action: 'diagnose-failure',
          // Повтор упоминается, только если он был: первый отказ вне задания
          // графа тоже приходит сюда, без повтора.
          note:
            work.contextLimit === 'prompt-too-long'
              ? 'Окно контекста модели превышено уже первым запросом, повтор только удлинит его: разделите поручение или сократите контекст (меньше файлов и вывода в подсказке, уже область).'
              : input.repair.sameFailureRepairs > 0
                ? 'Окна контекста модели не хватило и на повторе: разделите поручение или сократите контекст (меньше файлов и вывода в подсказке, уже область).'
                : 'Окна контекста модели не хватило: повторите с меньшим контекстом, разделите поручение или сократите контекст (меньше файлов и вывода в подсказке, уже область).',
        };
      default:
        return {
          code: stopCodeOf(kind),
          cause: kind,
          phase,
          actor: 'lead',
          action: 'diagnose-failure',
        };
    }
  }
  if (work.status === 'ready' && work.waitingOn?.length)
    return {
      code: 'NOT_READY',
      cause: 'not-ready',
      phase: 'claim',
      // Ожидание зависимости — не ход по этой работе: по ней не действует
      // никто (движок её не сдвинет, ведущему разбирать нечего); что делать,
      // говорит диагноз самой зависимости (её разбор, сброс, решение человека).
      actor: null,
      action: 'wait',
      note: `Ждёт ${work.waitingOn.join(', ')}: сама эта работа ничего не требует; на зависимости движок остановится, следующий шаг — по её диагнозу.`,
    };
  if (work.status === 'cancelled') return cancelledOutcome(work.openDependents, 'claim');
  // Шаг согласования, пока идёт ревью плана (запуск, review-plan или
  // повторное согласование с ответом): ход harness, а не ведущего.
  if (work.planReview && (work.status === 'draft' || work.approvalStale))
    return {
      code: work.approvalStale ? 'APPROVAL_STALE' : 'APPROVAL_REQUIRED',
      cause: 'approval-required',
      phase: 'claim',
      actor: 'controller',
      action: 'review-plan',
      note: `Идёт ревью плана (с ${work.planReview.since}): согласование — по его итогу, ведущему для него ничего делать не нужно.`,
    };
  if (work.status === 'draft')
    return {
      code: 'APPROVAL_REQUIRED',
      cause: 'approval-required',
      phase: 'claim',
      actor: 'lead',
      action: 'review-plan',
    };
  if (work.hold)
    return {
      code: 'NOT_READY',
      cause: 'not-ready',
      phase: 'claim',
      actor: 'controller',
      action: 'wait',
      note: `Выдача удержана операцией ${work.hold.operation}: ${work.hold.reason}`,
    };
  if (work.budgetBlock)
    return {
      code: 'BUDGET_EXHAUSTED',
      cause: 'budget',
      phase: 'claim',
      actor: 'user',
      action: 'raise-budget',
      note: work.budgetBlock.reason,
    };
  const pause = control.pauseReason ? queuePause(control) : undefined;
  if (pause)
    return {
      ...pause,
      phase: 'claim',
      note:
        control.pauseReason === 'runtime'
          ? `Выдача остановлена отказом класса ${pause.cause}; после исправления — harness resume.`
          : pause.action === 'wait'
            ? `Очередь ждёт операции ${control.pauseReason}.`
            : 'Продолжение — harness resume.',
    };
  const active = activePhase[work.status];
  const idle = work.liveness;
  if (active && idle) {
    const what = idle.activity ? ` (${idle.activity})` : '';
    // Сообщённое зависание остаётся за человеком: controller его не остановит.
    if (idle.state === 'stalled' && idle.action !== 'stop')
      return {
        code: 'RUNTIME_UNAVAILABLE',
        cause: 'stalled',
        phase: active,
        actor: 'user',
        action: 'fix-environment',
        note: `Попытка зависла${what}: движения нет с ${idle.lastMovementAt}. Политика только сообщает (stallSweep.action: report); снимок — в событии attempt.liveness.`,
      };
    return {
      code: 'NOT_READY',
      cause: idle.state === 'stalled' ? 'stalled' : 'not-ready',
      phase: active,
      actor: 'controller',
      action: 'wait',
      note:
        idle.state === 'stalled'
          ? `Попытка зависла${what}: controller останавливает её исходом stalled.`
          : `Поручение выполняется (${work.status}), но без движения${what} с ${idle.lastMovementAt}.`,
    };
  }
  if (active)
    return {
      code: 'NOT_READY',
      cause: 'not-ready',
      phase: active,
      actor: 'controller',
      action: 'wait',
      // Интеграция повторяет стадии подготовки уже после исполнителя.
      note:
        work.status === 'running' && work.openStage?.preparing
          ? `Поручение выполняется (${work.status}): подготовка — ${work.openStage.stage} с ${work.openStage.startedAt}; исполнитель ещё не запущен.`
          : `Поручение выполняется (${work.status}).`,
    };
  if (work.status === 'ready' && work.attempt >= maxAttempts) return exhaustedOutcome();
  return {
    code: 'NOT_READY',
    cause: 'not-ready',
    phase: 'claim',
    actor: 'controller',
    action: 'wait',
  };
}

function errorOutcome(code: ErrorCode): Omit<Outcome, 'note'> {
  switch (code) {
    case 'CONTROLLER_BUSY':
      return { code, cause: 'controller-busy', phase: 'claim', actor: 'lead', action: 'wait' };
    case 'PAUSED':
      return {
        code,
        cause: 'operator-pause',
        phase: 'claim',
        actor: 'user',
        action: 'resume-queue',
      };
    case 'APPROVAL_REQUIRED':
    case 'APPROVAL_STALE':
      return {
        code,
        cause: 'approval-required',
        phase: 'claim',
        actor: 'lead',
        action: 'review-plan',
      };
    case 'GATE_FAILED':
      return { code, cause: 'gate', phase: 'gates', actor: 'lead', action: 'diagnose-failure' };
    case 'REVIEW_REJECTED':
      return { code, cause: 'review', phase: 'review', actor: 'lead', action: 'diagnose-failure' };
    case 'REVIEW_PROTOCOL_INVALID':
      return {
        code,
        cause: 'review-protocol',
        phase: 'review',
        actor: 'user',
        action: 'user-decision',
      };
    case 'SCOPE_VIOLATION':
      return {
        code,
        cause: 'scope-violation',
        phase: 'integration',
        actor: 'lead',
        action: 'diagnose-failure',
      };
    case 'BUDGET_EXHAUSTED':
    case 'BUDGET_UNKNOWN':
      return { ...ruleOutcome('budget-exhausted'), code, cause: 'budget', phase: 'claim' };
    case 'ATTEMPTS_EXHAUSTED':
      return { ...ruleOutcome('exhausted-user'), code, cause: 'unknown', phase: 'claim' };
    case 'DIAGNOSIS_REQUIRED':
      return { ...ruleOutcome('diagnosis-required'), code, cause: 'not-ready', phase: 'claim' };
    case 'CONTEXT_EXHAUSTED':
      return {
        code,
        cause: 'context-exhausted',
        phase: 'implementation',
        actor: 'lead',
        action: 'diagnose-failure',
      };
    case 'RUNTIME_UNAVAILABLE':
      return {
        code,
        cause: 'environment',
        phase: 'preflight',
        actor: 'user',
        action: 'fix-environment',
      };
  }
  switch (errorCodes[code]) {
    case 'input':
      return {
        code,
        cause: 'not-ready',
        phase: 'preflight',
        actor: 'lead',
        action: 'diagnose-failure',
      };
    case 'refused':
      return {
        code,
        cause: 'not-ready',
        phase: 'claim',
        actor: 'lead',
        action: 'diagnose-failure',
      };
    case 'infrastructure':
      return {
        code,
        cause: 'environment',
        phase: 'preflight',
        actor: 'user',
        action: 'fix-environment',
      };
  }
}

/**
 * Объяснение остановки (OP-DIAG-05): только чтение, ничего не планирует.
 * Класс отказа берётся из сохранённого `failureKind` — текст ошибки здесь не
 * разбирается и не переклассифицируется (исторический `unknown` остаётся им).
 */
export function explainStop(input: StopInput): StopDiagnosis {
  if (input.kind === 'runtime') {
    const { runtime, available, reason } = input.runtime;
    if (!available)
      return {
        code: 'RUNTIME_UNAVAILABLE',
        cause: 'runtime-missing',
        phase: 'preflight',
        actor: 'user',
        action: 'fix-environment',
        retryPlanned: false,
        message: message('runtime-missing', `Runtime: ${runtime}.`, reason),
        evidence: [{ kind: 'doctor', id: runtime }],
      };
    return {
      code: 'NOT_READY',
      cause: 'not-ready',
      phase: 'preflight',
      actor: null,
      action: 'none',
      retryPlanned: false,
      message: clipText(`Runtime ${runtime} доступен.`, CLIP_DIAGNOSTIC - 1)!,
      evidence: [],
    };
  }
  if (input.kind === 'input') {
    const r = input.request;
    return {
      code: 'INPUT_REQUIRED',
      cause: 'needs-input',
      phase: 'implementation',
      actor: 'lead',
      action: 'answer-input',
      retryPlanned: false,
      message: clipText(
        `Решение исполнителя ждёт ведущего (неблокирующий запрос ${r.id}, серьёзность ${r.severity}): «${clipText(r.question, 300)}». Работа не остановлена, утверждённое не изменено; пересмотр — обычной корректировкой.`,
        CLIP_DIAGNOSTIC - 1,
      )!,
      evidence: [],
      workId: r.workId,
    };
  }
  if (input.kind === 'error') {
    const outcome = errorOutcome(input.error.code);
    return {
      ...outcome,
      retryPlanned: false,
      message: message(outcome.cause, input.error.message),
      evidence: [],
    };
  }
  const retryPlanned = retryPlannedOf(input);
  const { note, text, ...outcome } = workOutcome(input, retryPlanned);
  return {
    ...outcome,
    retryPlanned: outcome.action === 'retry',
    message: messageWith(
      text ?? causeText[outcome.cause],
      note,
      input.work.repairStoppedBy && outcome.action !== 'retry'
        ? `Автоматическое восстановление группы остановлено отменой ${input.work.repairStoppedBy}.`
        : undefined,
      input.work.leadRecovery?.line && input.work.status !== 'done'
        ? `Сейчас: ${input.work.leadRecovery.line}.`
        : undefined,
      input.work.repeatedFailure &&
        input.work.status !== 'done' &&
        input.work.status !== 'cancelled'
        ? input.work.repeatedFailure.line
        : undefined,
      input.work.failure ? `Отказ: ${input.work.failure}` : undefined,
    ),
    evidence: (input.evidence ?? []).slice(-20).map((e) => ({ ...e })),
    workId: input.work.id,
    ...(input.runId ? { runId: input.runId } : {}),
    // Справочник причин (alpha.70): только у отказа работы.
    ...((ref) => (ref ? { reference: ref } : {}))(
      input.work.status === 'failed' && input.work.failureKind
        ? failureRefOf(
            input.work.failureKind,
            input.work.writerSplit
              ? 'writer-split'
              : input.work.writerBlocked
                ? 'writer-environment'
                : (input.work.environmentCause ?? input.work.gateHold?.cause),
          )
        : undefined,
    ),
  };
}
