import { RU, ruCount } from '../contracts/plural.ts';
import type { AttemptState, ExecutionView, FailureKind, WorkState } from '../contracts/index.ts';
import { MAX_NEUTRAL_FAILURES, repairPolicy } from './failure.ts';
import {
  failedBeforeWork,
  lastContextLimit,
  repairExplain,
  repairRepeats,
  writerBlockedStop,
} from '../contracts/repair-policy.ts';
import { RECOVERY_THRESHOLD, isNeutral } from './property-recovery.ts';
import { blockingRequest } from './input-requests.ts';

export type RepairDecision =
  | {
      action: 'retry';
      workId: string;
      kind: FailureKind;
      fingerprint: string;
      /** Класс держит выдачу: починив его, нужно снять его блокировку. */
      blocksQueue: boolean;
      reason: string;
    }
  | {
      action: 'stop';
      workId?: string;
      kind?: FailureKind;
      reason: string;
      /** Остановка — пробел приёмки, а не исчерпанный бюджет (`acceptanceGap`). */
      gap?: AcceptanceGap;
    };

/** Свойство или класс входов, по которому ревью отклонило подряд, и эти попытки. */
export interface AcceptanceGap {
  /**
   * `pair:<свойство>␀<класс>` — одно и то же необъявленное свойство с тем же
   * классом входов; `property:<id>` — только свойство; `class:<текст>` —
   * только класс входов.
   */
  key: string;
  runs: string[];
}

const normalized = (c: string) => c.trim().toLowerCase().replace(/\s+/g, ' ');

/** Что отклонившее ревью назвало в попытке: пары, необъявленные свойства и классы входов. */
function namedBy(a: AttemptState) {
  return new Set([
    ...(a.classified ?? []).map((p) => 'pair:' + p.property + '\u0000' + normalized(p.inputClass)),
    ...(a.unboundProperties ?? []).map((p) => 'property:' + p),
    ...(a.inputClasses ?? []).map((c) => 'class:' + normalized(c)),
  ]);
}

/**
 * Сколько отказов подряд нужно для остановки. Одно и то же свойство с тем же
 * классом — один и тот же дефект: двух хватает. Только свойство или только
 * класс (общий класс вроде «граничные случаи» у двух разных дефектов) — слабее,
 * ложная остановка дороже лишнего повтора: нужно три.
 */
const thresholdOf = (key: string) =>
  key.startsWith('pair:') ? RECOVERY_THRESHOLD : RECOVERY_THRESHOLD + 1;

/**
 * Пробел приёмки: последний отказ поручения — отказ ревью, и
 * {@link RECOVERY_THRESHOLD} содержательных отказа ревью подряд, считая его,
 * назвали одно и то же свойство или
 * класс входов. Каждая попытка закрывала конкретный пример, ревью находило
 * следующий из того же класса: зелёные gates этот класс не проверяют, и
 * третья слепая попытка ничего не даст. Объявленные свойства сюда не входят —
 * их ведёт эпизод разбора (`property-recovery.ts`).
 *
 * Счёт — как у эпизода: инфраструктурный отказ не увеличивает и не обнуляет
 * его; прохождение, отказ gate или ревью без этого названия, смена основания
 * поручения (постановки или контрактов) обрывают серию.
 */
export function acceptanceGap(view: ExecutionView, work: WorkState): AcceptanceGap | undefined {
  const own = view.attempts(work.id).filter((a) => a.status !== 'active');
  const last = own.at(-1);
  if (!last || last.status !== 'failed' || last.failureKind !== 'review') return undefined;
  for (const key of namedBy(last)) {
    const runs: string[] = [];
    const threshold = thresholdOf(key);
    for (let i = own.length - 1; i >= 0 && runs.length < threshold; i--) {
      const a = own[i]!;
      if (a.episodeBasis !== last.episodeBasis) break;
      if (isNeutral(a)) continue;
      if (a.status !== 'failed' || a.failureKind !== 'review' || !namedBy(a).has(key)) break;
      runs.push(a.id);
    }
    if (runs.length >= threshold) return { key, runs: runs.reverse() };
  }
  return undefined;
}

/** Упавшие testcases проверок попытки (записи JUnit `tests` непрошедших gates). */
function failedTestcases(a: AttemptState) {
  return new Set(
    a.evidence
      .filter((e) => e.kind === 'test' && !e.passed)
      .flatMap((e) => (e.tests ?? []).filter((t) => t.status === 'failed' && !t.opaque))
      .map((t) => t.id),
  );
}

/** Один и тот же testcase упал в двух содержательных отказах gate подряд. */
export interface RepeatedTestcase {
  testcases: string[];
  runs: string[];
}

/**
 * Повтор с выводом проверки уже был, а упал тот же testcase, и следующая
 * попытка — последняя: у исполнителя нет новой гипотезы, и последняя попытка
 * ушла бы на тот же провал. Последний
 * отказ поручения — `gate`, предыдущий содержательный (инфраструктурные
 * отказы пропускаются) — тоже `gate` того же основания, и общие упавшие
 * testcases есть. Отпечаток отказа здесь не годится: вывод проверки меняется
 * от попытки к попытке, а testcase — нет.
 */
export function repeatedTestcase(
  view: ExecutionView,
  work: WorkState,
  maxAttempts: number,
): RepeatedTestcase | undefined {
  // Только перед последней попыткой: раньше повтор с выводом проверки ещё
  // дёшев и разрешён пределом класса (`repairPolicy.gate.repeats`).
  if (work.attempt + 1 < maxAttempts) return undefined;
  const own = view.attempts(work.id).filter((a) => a.status !== 'active');
  const last = own.at(-1);
  if (!last || last.status !== 'failed' || last.failureKind !== 'gate') return undefined;
  const failed = failedTestcases(last);
  if (!failed.size) return undefined;
  for (let i = own.length - 2; i >= 0; i--) {
    const a = own[i]!;
    if (a.episodeBasis !== last.episodeBasis) return undefined;
    if (isNeutral(a)) continue;
    if (a.status !== 'failed' || a.failureKind !== 'gate') return undefined;
    const same = [...failedTestcases(a)].filter((t) => failed.has(t)).sort();
    return same.length ? { testcases: same.slice(0, 5), runs: [a.id, last.id] } : undefined;
  }
  return undefined;
}

/** Предмет серии словами: свойство и класс, только свойство или только класс. */
function gapSubject(key: string) {
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const clip = (s: string) => s.slice(0, 200);
  if (kind === 'pair') {
    const [property, inputClass] = rest.split('\u0000');
    return `свойству «${clip(property!)}» с классом входов «${clip(inputClass!)}»`;
  }
  return kind === 'property' ? `свойству «${clip(rest)}»` : `классу входов «${clip(rest)}»`;
}

/**
 * Что делать с упавшим поручением группы.
 *
 * Решение принимается только по записанному состоянию: класс отказа,
 * сохранённый в момент падения, число одинаковых отпечатков среди прошлых
 * попыток, бюджет попыток поручения и бюджет восстановлений группы. Ни одного
 * обращения к сети, git или runtime — поэтому вся таблица решений проверяется
 * тестами, а перезапуск процесса ничего не меняет: те же данные дают тот же
 * ответ.
 *
 * Повтор здесь — обычный повтор в пределах бюджета попыток поручения. Сброс
 * бюджета остаётся действием человека: он означает «причина устранена
 * снаружи», и утверждать это за человека контур не вправе.
 */
export function repairDecision(
  view: ExecutionView,
  works: WorkState[],
  options: {
    budgetLeft: number;
    maxAttempts: number;
    /** Вопрос, держащий работу, — как `blockingRequest`; диагноз многих работ читает запросы раз. */
    blocking?: (work: WorkState) => unknown;
  },
): RepairDecision | undefined {
  const blocking = options.blocking ?? ((w: WorkState) => blockingRequest(view, w));
  // Поручение с эпизодом по свойству восстанавливается своим разбором, а не
  // обычным повтором: третья слепая попытка как раз и запрещена.
  // Поручение, ждущее ответа на вопрос исполнителя, не чинится и не
  // останавливает восстановление группы: продолжение — только applyInput, а
  // независимая работа графа идёт своим чередом.
  const broken = works.filter(
    (w) =>
      ['failed', 'cancelled'].includes(w.status) &&
      (w.status === 'cancelled' || !w.recovery) &&
      !(w.status === 'failed' && blocking(w)),
  );
  if (!broken.length) return undefined;

  // Отмена человеком не восстанавливается — ни первой, ни после других.
  // Проверяется раньше выбора поручения: иначе отменённое ждало бы своей
  // очереди за чинимыми и цикл успел бы потратить на них бюджет.
  const cancelled = broken.find((w) => w.status === 'cancelled');
  if (cancelled)
    return {
      action: 'stop',
      workId: cancelled.id,
      kind: 'cancelled',
      reason: `${cancelled.id}: ${repairPolicy.cancelled.explain}`,
    };

  const work = broken[0]!;
  const kind: FailureKind = work.failureKind ?? 'unknown';
  const rule = repairPolicy[kind];
  const detail = work.failure ? ` Отказ: ${work.failure.slice(0, 300)}` : '';

  if (rule.action === 'stop')
    return {
      action: 'stop',
      workId: work.id,
      kind,
      reason: `${work.id}: ${repairExplain(kind, failedBeforeWork(kind, view.attempts(work.id)), writerBlockedStop(kind, view.attempts(work.id)))}${detail}`,
    };

  if (options.budgetLeft <= 0)
    return {
      action: 'stop',
      workId: work.id,
      kind,
      reason: `${work.id}: исчерпан бюджет автоматических восстановлений группы. Продолжение требует решения человека.${detail}`,
    };

  // Сброс бюджета попыток означает «причина устранена снаружи». Цикл такого
  // знания не имеет, поэтому на потолке попыток он останавливается, а не
  // обнуляет счётчик за человека.
  if (work.attempt >= options.maxAttempts)
    return {
      action: 'stop',
      workId: work.id,
      kind,
      reason: `${work.id}: исчерпан бюджет попыток поручения. Устраните причину и повторите со сбросом, указав его.${detail}`,
    };

  // Отказы окружения попытку не тратят, но их предел — свой.
  if ((work.neutralFailures ?? 0) >= MAX_NEUTRAL_FAILURES)
    return {
      action: 'stop',
      workId: work.id,
      kind,
      reason: `${work.id}: ${ruCount(work.neutralFailures ?? 0, RU.failure)} окружения или провайдера после начала работы — предел ${MAX_NEUTRAL_FAILURES}. Это неисправность среды; устраните её и повторите со сбросом, указав его.${detail}`,
    };

  // Тексты отказов ревью разные, и предел одинаковых отпечатков их не
  // ловит; одно и то же нарушенное свойство или класс входов — ловит.
  const gap = acceptanceGap(view, work);
  if (gap)
    return {
      action: 'stop',
      workId: work.id,
      kind,
      gap,
      reason: `${work.id}: пробел приёмки — ревью ${ruCount(gap.runs.length, RU.time)} подряд отклонило по одному и тому же ${gapSubject(gap.key)} при зелёных проверках (попытки ${gap.runs.join(', ')}). Третья слепая попытка не выдаётся: приёмка этот класс не проверяет. Решение ведущего — закрепить класс проверкой (корпус, эталонный набор, свойство в договоре проверки) или разделить задачу.${detail}`,
    };

  // Тот же упавший testcase после повтора с выводом проверки: ведущему, а не
  // последней попытке.
  const repeated = repeatedTestcase(view, work, options.maxAttempts);
  if (repeated)
    return {
      action: 'stop',
      workId: work.id,
      kind,
      reason: `${work.id}: тот же testcase упал второй раз подряд (${repeated.testcases.join(', ')}; попытки ${repeated.runs.join(', ')}), хотя повтор получил вывод проверки. Следующая слепая попытка не выдаётся: у исполнителя нет новой гипотезы. Решение ведущего — разобрать провал (ожидаемое и полученное — в логе gate), уточнить постановку или контекст, затем повторить работу (harness retry) или разделить задачу.${detail}`,
    };

  const fingerprint = work.failureFingerprint;
  const identical = fingerprint
    ? view.attempts(work.id).filter((a) => a.failureFingerprint === fingerprint).length
    : 0;
  const repeats = repairRepeats(kind, lastContextLimit(view.attempts(work.id)));
  if (!fingerprint || identical > repeats)
    return {
      action: 'stop',
      workId: work.id,
      kind,
      reason: fingerprint
        ? `${work.id}: одна и та же причина ${ruCount(identical, RU.time)} подряд, новой гипотезы нет. ${rule.explain}${detail}`
        : `${work.id}: отказ записан без отпечатка, повторы считать нечем.${detail}`,
    };

  return {
    action: 'retry',
    workId: work.id,
    kind,
    fingerprint,
    blocksQueue: rule.blocksQueue ?? false,
    reason: `${work.id}: ${kind}, повтор ${identical} из ${repeats}.${detail}`,
  };
}
