import { errorCodes, type ErrorCode } from '../contracts/errors.ts';
import { repairPolicy } from '../contracts/repair-policy.ts';
import { CLIP_DIAGNOSTIC, clipText } from './clip.ts';
import type { Actor, FailureKind, NextAction, PauseReason, WorkStatus } from './enums.ts';

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
    case 'review-protocol':
      return 'REVIEW_PROTOCOL_INVALID';
    case 'scope-violation':
      return 'SCOPE_VIOLATION';
    case 'budget':
      return 'BUDGET_EXHAUSTED';
    case 'cancelled':
      return 'CANCELLED';
    case 'provider-auth':
    case 'environment':
    case 'timeout':
      return 'RUNTIME_UNAVAILABLE';
    case 'stale-base':
    case 'merge':
      return 'GIT_FAILED';
    default:
      return 'INTERNAL';
  }
}

export const stopCauses = [
  'provider-auth',
  'environment',
  'timeout',
  'stale-base',
  'empty-result',
  'scope-violation',
  'gate',
  'review',
  'review-protocol',
  'merge',
  'cancelled',
  'budget',
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
        failure?: string;
        hold?: { operation: string; reason: string };
        budgetBlock?: { reason: string };
        /**
         * Эпизод восстановления свойства: работу ведёт его разбор, а не штатный
         * repair. Статус — как в `PropertyRecovery.status`.
         */
        recovery?: { status: string };
        /** Незавершённые предпосылки, на которых движок остановит задание. */
        waitingOn?: string[];
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
}

/** Русский шаблон сообщения по причине остановки. */
const causeText: Record<StopCause, string> = {
  'provider-auth': 'Провайдер отказал: runtime не авторизован, нет кредитов или исчерпан лимит.',
  environment: 'Окружение не дало исполнителю работать (сеть, TLS/DNS, процесс runtime).',
  timeout: 'Попытка исчерпала отведённое время.',
  'stale-base': 'База прогонов отстала от рабочей ветки.',
  'empty-result': 'Исполнитель отчитался о выполнении, не изменив ни одного файла.',
  'scope-violation': 'Изменения вышли за область поручения или роли.',
  gate: 'Настроенная проверка не прошла.',
  review: 'Независимое ревью отклонило результат.',
  'review-protocol': 'Ответ reviewer нарушил протокол ревью; повторы reviewer исчерпаны.',
  merge: 'Слияние с веткой интеграции не сошлось.',
  cancelled: 'Работа отменена человеком.',
  budget: 'Бюджет расходов или времени исчерпан либо не определён.',
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
  unknown: 'implementation',
  'empty-result': 'implementation',
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
};

const message = (cause: StopCause, ...parts: (string | undefined)[]) =>
  clipText(
    [causeText[cause], ...parts.filter((p): p is string => Boolean(p))].join(' '),
    // clipText добавляет «…» сверх предела: итог не длиннее CLIP_DIAGNOSTIC.
    CLIP_DIAGNOSTIC - 1,
  )!;

/**
 * Решение движка о повторе, как его принял бы `repairDecision`: класс
 * разрешает повтор, одинаковый отпечаток не исчерпан, бюджет попыток и
 * восстановлений группы не исчерпан. Только описание: ничего не планирует.
 */
function retryPlannedOf(input: Extract<StopInput, { kind: 'work' }>) {
  const { work, repair, maxAttempts } = input;
  if (work.status !== 'failed') return false;
  if (work.recovery) return work.recovery.status === 'retry' && repair.outlook === 'retry';
  if (repair.outlook !== undefined && repair.outlook !== 'retry') return false;
  const rule = repairPolicy[work.failureKind ?? 'unknown'];
  return (
    rule.action === 'retry' &&
    repair.sameFailureRepairs < rule.repeats &&
    work.attempt < maxAttempts &&
    repair.groupRepairsUsed < repair.groupRepairBudget
  );
}

function workOutcome(input: Extract<StopInput, { kind: 'work' }>, retry: boolean): Outcome {
  const { work, control, maxAttempts } = input;
  const kind: FailureKind = work.failureKind ?? 'unknown';
  const phase = input.phase ?? failurePhase[kind];
  const exhausted = `Исчерпано ${work.attempt} из ${maxAttempts} попыток; сброс — решение человека.`;
  if (work.status === 'done')
    return {
      code: 'NOT_READY',
      cause: 'not-ready',
      phase: 'delivery',
      actor: null,
      action: 'none',
      note: 'Поручение принято.',
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
  if (work.status === 'failed') {
    if (work.attempt >= maxAttempts)
      return {
        code: 'ATTEMPTS_EXHAUSTED',
        cause: kind,
        phase: 'claim',
        actor: 'user',
        action: 'reset-attempts',
        note: exhausted,
      };
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
        return {
          code: 'RUNTIME_UNAVAILABLE',
          cause: kind,
          phase,
          actor: 'user',
          action: 'fix-environment',
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
        return {
          code: stopCodeOf(kind),
          cause: kind,
          phase,
          actor: 'lead',
          action: 'replan-dependents',
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
      actor: 'lead',
      action: 'diagnose-failure',
      note: `Ждёт ${work.waitingOn.join(', ')}: на них движок остановится; следующий шаг — по их диагнозу.`,
    };
  if (work.status === 'cancelled')
    return {
      code: 'CANCELLED',
      cause: 'cancelled',
      phase: 'claim',
      actor: 'lead',
      action: 'replan-dependents',
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
  if (control.paused && (control.pauseReason === 'operator' || control.pauseReason === 'shutdown'))
    return {
      code: 'PAUSED',
      cause: 'operator-pause',
      phase: 'claim',
      actor: 'user',
      action: 'resume-queue',
      note: 'Продолжение — harness resume.',
    };
  if (control.paused && control.pauseReason === 'runtime') {
    const paused = control.pauseFailures?.[0] ?? 'environment';
    return {
      code: stopCodeOf(paused),
      cause: paused,
      phase: 'claim',
      actor: 'user',
      action: paused === 'provider-auth' ? 'fix-access' : 'fix-environment',
      note: `Выдача остановлена отказом класса ${paused}; после исправления — harness resume.`,
    };
  }
  if (
    control.paused &&
    (control.pauseReason === 'reconfigure' || control.pauseReason === 'base-check')
  )
    return {
      code: 'PAUSED',
      cause: 'not-ready',
      phase: 'claim',
      actor: 'controller',
      action: 'wait',
      note: `Очередь ждёт операции ${control.pauseReason}.`,
    };
  const active = activePhase[work.status];
  if (active)
    return {
      code: 'NOT_READY',
      cause: 'not-ready',
      phase: active,
      actor: 'controller',
      action: 'wait',
      note: `Поручение выполняется (${work.status}).`,
    };
  if (work.status === 'ready' && work.attempt >= maxAttempts)
    return {
      code: 'ATTEMPTS_EXHAUSTED',
      cause: kind,
      phase: 'claim',
      actor: 'user',
      action: 'reset-attempts',
      note: exhausted,
    };
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
      return { code, cause: 'budget', phase: 'claim', actor: 'user', action: 'raise-budget' };
    case 'ATTEMPTS_EXHAUSTED':
      return { code, cause: 'unknown', phase: 'claim', actor: 'user', action: 'reset-attempts' };
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
  const { note, ...outcome } = workOutcome(input, retryPlanned);
  return {
    ...outcome,
    retryPlanned: outcome.action === 'retry',
    message: message(
      outcome.cause,
      note,
      input.work.failure ? `Отказ: ${input.work.failure}` : undefined,
    ),
    evidence: (input.evidence ?? []).slice(-20).map((e) => ({ ...e })),
    workId: input.work.id,
    ...(input.runId ? { runId: input.runId } : {}),
  };
}
