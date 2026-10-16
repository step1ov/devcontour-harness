import {
  digestOf,
  type AttemptState,
  type ExecutionView,
  type FailureKind,
  type WorkState,
} from '../contracts/index.ts';

// Переиспользование реализации после несостоявшейся проверки.
//
// Реализация — самая дорогая фаза попытки. Если после неё отказала не работа,
// а окружение (оборвался транспорт проверяющего, истёк срок владения, кончилось
// время ревью), новая попытка писала тот же код заново. Одинаковое дерево
// файлов при этом ничего не доказывает: код переиспользуется, только когда
// совпадают все основания, на которых он был написан, — и проверки с ревью
// исполняются заново. Всё, что не совпало или не записано, означает обычную
// попытку с нуля.

/** Отказы, которые ничего не говорят о коде кандидата. */
export const reusableFailures: readonly FailureKind[] = ['environment', 'timeout'];

/**
 * Основания фазы реализации: всё, от чего зависел написанный код. Знания
 * хоста (у DevContour — память) приходят закреплённым контекстом и входят
 * сюда его digest, отдельного поля у движка нет.
 */
export interface ImplementationBasis {
  /** Согласованная постановка поручения. */
  spec: string;
  /** Контракты, на которые поручение ссылается, по их digest. */
  contracts: Record<string, string>;
  /** Договор исполнения: проверки, окружение, роли, изоляция. */
  policyDigest: string;
  runtime: string;
  model?: string;
  /** Целевая ветка, от которой ответвлён кандидат. */
  baseSha: string;
  /** Digest закреплённого снимка контекста. */
  context: string | null;
  dependencies: unknown;
  /** Версия движка: правила области и сборки запроса. */
  engineVersion: string;
  /** Принятая версия корпуса: новый подтверждённый случай — новое основание. */
  corpus?: string;
}

export function implementationBasis(
  work: WorkState,
  attempt: AttemptState,
  baseSha: string,
  engineVersion: string,
) {
  const basis: ImplementationBasis = {
    spec: work.approvedDigest ?? '',
    contracts: Object.fromEntries(work.order.contracts.map((c) => [c.id, c.digest])),
    policyDigest: attempt.policyDigest,
    runtime: attempt.runtime,
    ...(attempt.model ? { model: attempt.model } : {}),
    baseSha,
    context: attempt.contextSnapshot ?? null,
    dependencies: attempt.dependencies ?? [],
    engineVersion: attempt.engineVersion ?? engineVersion,
    ...(attempt.checks?.corpus ? { corpus: attempt.checks.corpus.digest } : {}),
  };
  return digestOf(basis);
}

export type ReuseDecision =
  { reuse: true; from: AttemptState; candidateSha: string } | { reuse: false; reason: string };

/**
 * Можно ли вместо новой реализации взять кандидата предыдущей попытки.
 *
 * Только непосредственно предыдущая попытка того же поручения: пропустить
 * более позднее отклонение ревью и вернуться к старому коду значило бы
 * проигнорировать замечание. Только кандидат, прошедший реализацию (записан
 * его SHA), и только после отказа, не относящегося к коду. Основания должны
 * совпасть целиком.
 */
export function reusableImplementation(
  view: ExecutionView,
  work: WorkState,
  currentRunId: string,
  basis: string,
): ReuseDecision {
  if (!work.approvedDigest) return { reuse: false, reason: 'поручение не согласовано' };
  const previous = view
    .attempts(work.id)
    .filter((a) => a.id !== currentRunId)
    .at(-1);
  if (!previous) return { reuse: false, reason: 'предыдущей попытки нет' };
  if (!['failed', 'expired'].includes(previous.status))
    return { reuse: false, reason: `предыдущая попытка ${previous.status}` };
  if (!previous.failureKind || !reusableFailures.includes(previous.failureKind))
    return {
      reuse: false,
      reason: `отказ класса ${previous.failureKind ?? 'unknown'} относится к коду или не определён`,
    };
  if (!previous.candidateSha || !previous.implementationBasis)
    return { reuse: false, reason: 'кандидат предыдущей попытки не записан' };
  if (previous.implementationBasis !== basis)
    return { reuse: false, reason: 'основания реализации изменились' };
  return { reuse: true, from: previous, candidateSha: previous.candidateSha };
}

/**
 * Черновик предыдущей попытки, с которого стоит продолжить.
 *
 * Время реализации кончилось раньше работы — или ревью отклонило готового
 * кандидата за конкретные находки. Повтор с пустого дерева тратит предел
 * попытки на уже сделанное и нередко упирается в него снова. Черновик берётся
 * только у последней содержательной попытки. Проверки и ревью он не заменяет —
 * это отправная точка.
 */
export type Draft = (
  | {
      kind: 'unfinished';
      runId: string;
      /** Чем кончилась попытка до кандидата: время, «не закончил», обрыв. */
      reason: FailureKind;
      patch: string;
      digest: string;
      files: string[];
    }
  | {
      kind: 'candidate';
      runId: string;
      /** Чем кончилась попытка с готовым кандидатом: ревью, проверка, время ревью. */
      reason: FailureKind;
      error?: string;
      baseSha: string;
      candidateSha: string;
    }
) & {
  /**
   * Постановка или контракты менялись после попытки-источника. Черновик всё
   * равно берётся: переутверждение ради уточнения контракта выбрасывало
   * почти готовую работу. Исполнитель узнаёт, что сверять его нужно с новой.
   */
  respecified: boolean;
};

export function continuableDraft(
  view: ExecutionView,
  work: WorkState,
  currentRunId: string,
): Draft | undefined {
  // Попытка, не оставившая ни кандидата, ни черновика (обрыв до начала
  // работы, «не закончил» без правок), о коде ничего не говорит: черновик
  // берётся у последней попытки, которая его оставила.
  const previous = view
    .attempts(work.id)
    .filter(
      (a) => a.id !== currentRunId && !(a.status === 'failed' && !a.candidateSha && !a.partial),
    )
    .at(-1);
  if (!previous || previous.status !== 'failed') return undefined;
  if (previous.candidateSha && previous.baseSha && previous.failureKind && work.approvedDigest) {
    // Отказ провайдера кода не касается: такой кандидат берётся
    // переиспользованием, а не черновиком.
    if (previous.failureKind === 'provider-auth') return undefined;
    return {
      kind: 'candidate',
      runId: previous.id,
      reason: previous.failureKind,
      ...(previous.error ? { error: previous.error } : {}),
      baseSha: previous.baseSha,
      candidateSha: previous.candidateSha,
      respecified: previous.startedAt < (work.approvedAt ?? ''),
    };
  }
  if (!previous.partial || !previous.failureKind || previous.candidateSha) return undefined;
  const contracts = Object.fromEntries(work.order.contracts.map((c) => [c.id, c.digest]));
  return {
    kind: 'unfinished',
    reason: previous.failureKind,
    runId: previous.id,
    patch: previous.partial.patch,
    digest: previous.partial.digest,
    files: previous.partial.files,
    respecified:
      previous.partial.spec !== work.approvedDigest ||
      digestOf(previous.partial.contracts) !== digestOf(contracts),
  };
}
