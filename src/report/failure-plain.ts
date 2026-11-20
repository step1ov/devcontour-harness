// Почему поручение повторяется — простыми словами: класс и причина последнего
// отказа попытки. Модуль без node:* и без zod (его импортирует браузер через
// отчёт). Свободный текст ошибки попытки сюда не попадает: из него берётся
// только номер занятого порта; остальное — ID gates и класс отказа. Исключение
// — итог исполнителя (`writerSummary`) незавершённой попытки, в кавычках.

import type { AttemptState, FailureKind } from '../contracts/execution.ts';
import type { FailureBucket } from '../contracts/report.ts';
import { verificationRows } from './verification.ts';

export interface PlainText {
  ru: string;
  en: string;
}

/** Корзина отказа простыми словами (`failureBucketOf`). */
export const failureBucketText: Record<FailureBucket, PlainText> = {
  defect: { ru: 'дефект', en: 'defect' },
  incomplete: { ru: 'не доделано', en: 'incomplete' },
  integration: { ru: 'слияние', en: 'merge' },
  environment: { ru: 'окружение', en: 'environment' },
  'time-limit': { ru: 'время', en: 'time limit' },
  tool: { ru: 'инструмент', en: 'tool' },
  operator: { ru: 'оператор', en: 'operator' },
  budget: { ru: 'бюджет', en: 'budget' },
  unknown: { ru: 'неизвестно', en: 'unknown' },
  unclassified: { ru: 'без класса', en: 'unclassified' },
  input: { ru: 'вопрос исполнителя', en: 'executor question' },
};

/** Класс отказа попытки простыми словами. */
export const failureKindText: Record<FailureKind, PlainText> = {
  'provider-auth': {
    ru: 'нет доступа к модели (вход или ключ)',
    en: 'no access to the model (login or key)',
  },
  environment: { ru: 'сбой окружения', en: 'environment failure' },
  timeout: { ru: 'превышен предел времени', en: 'the time limit was exceeded' },
  stalled: { ru: 'процесс завис без движения', en: 'the process hung without progress' },
  'context-exhausted': {
    ru: 'задача не поместилась в контекст модели',
    en: 'the task did not fit the model context',
  },
  'stale-base': { ru: 'целевая ветка ушла вперёд', en: 'the target branch moved ahead' },
  'empty-result': { ru: 'исполнитель ничего не изменил', en: 'the writer changed nothing' },
  unfinished: { ru: 'исполнитель не доделал работу', en: 'the writer did not finish' },
  'scope-violation': {
    ru: 'изменены файлы вне области задачи',
    en: 'files outside the task scope were changed',
  },
  gate: { ru: 'не прошли проверки', en: 'gates failed' },
  review: { ru: 'ревью нашло замечания', en: 'the review raised findings' },
  'review-protocol': {
    ru: 'ревьюер ответил не по протоколу',
    en: 'the reviewer broke the review protocol',
  },
  merge: { ru: 'слияние не удалось', en: 'the merge failed' },
  cancelled: { ru: 'попытку отменили', en: 'the attempt was cancelled' },
  budget: { ru: 'исчерпан бюджет', en: 'the budget ran out' },
  'needs-lead': { ru: 'нужно решение ведущего', en: 'the lead has to decide' },
  'needs-input': { ru: 'исполнитель задал вопрос', en: 'the writer asked a question' },
  unknown: { ru: 'причина не определена', en: 'the cause is unknown' },
};

const PLAIN_MAX = 300;
const clip = (s: string) => (s.length > PLAIN_MAX ? s.slice(0, PLAIN_MAX - 1) + '…' : s);

/** Номер порта из ошибки «Порт N … занят» (проба портов перед фазой). */
const busyPort = (error: string | undefined) =>
  error ? /Порт (\d{1,5})[^.;\n]*занят/.exec(error)?.[1] : undefined;

/**
 * Упавшие gates попытки — по строкам проверки (`verificationRows`): записи
 * текущего SHA фазы, последняя запись gate в фазе; ID — только допустимые.
 */
function failingGates(a: AttemptState): string[] {
  const failed = verificationRows(a)
    .filter((r) => r.kind === 'gate' && r.result === 'failed')
    .map((r) => (r.consumer ? `${r.gate}@${r.consumer}` : r.gate));
  return [...new Set(failed)];
}

/**
 * Причина отказа попытки простыми словами: «окружение — порт 3000 занят»,
 * «дефект — не прошли проверки: lint, test». Без свободного текста ошибки.
 */
export function failurePlainOf(a: AttemptState, bucket: FailureBucket): PlainText {
  const head = failureBucketText[bucket];
  let detail: PlainText;
  const port = busyPort(a.error);
  if (port) detail = { ru: `порт ${port} занят`, en: `port ${port} is busy` };
  else if (a.writerBlocked)
    detail = {
      ru: 'окружение закрыло исполнителю обязательный шаг',
      en: 'the environment blocked a step the writer must run',
    };
  else if (a.failureKind === 'gate') {
    const gates = failingGates(a).slice(0, 8);
    detail = gates.length
      ? {
          ru: `не прошли проверки: ${gates.join(', ')}`,
          en: `gates failed: ${gates.join(', ')}`,
        }
      : failureKindText.gate;
  } else if (a.failureKind) detail = failureKindText[a.failureKind];
  else if (a.blocked)
    detail = { ru: 'окружение не дало начать работу', en: 'the environment blocked the start' };
  else if (a.status === 'expired')
    detail = {
      ru: 'процесс попытки пропал (владение истекло)',
      en: 'the attempt process vanished (lease expired)',
    };
  else if (a.status === 'cancelled') detail = failureKindText.cancelled;
  else detail = failureKindText.unknown;
  // Итог исполнителя своими словами — единственный свободный текст здесь: без
  // него «не доделано» не говорит, чего не хватило (источник, инструмент, сеть).
  const said = a.writerSummary?.trim().replace(/\s+/g, ' ');
  const quote = said ? `: «${said.length > 200 ? said.slice(0, 199) + '…' : said}»` : '';
  return {
    ru: clip(`${head.ru} — ${detail.ru}${quote}`),
    en: clip(`${head.en} — ${detail.en}${quote}`),
  };
}
