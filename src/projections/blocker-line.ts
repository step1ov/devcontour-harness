// Блокировка удержания (`blockers[].plain`): «удержано операцией <имя> — ждёт
// её конца». Имя операции договором не ограничено. Загрузчик (`status`)
// сокращает его серединой до предела строки status; представление
// восстанавливает части строки, маскирует имя и сокращает под свой предел.
// Маска — до сокращения: имя, уже сокращённое загрузчиком, представление не
// показывает («…»), иначе разрезанный секрет пережил бы маску.

import { fitLine, named, type LinePart } from './clip.ts';

/** Предел `blockers[].plain` / `plainEn` в `status` (схема `cli.ts`). */
export const BLOCKER_PLAIN_MAX = 300;

const HOLD = {
  ru: { head: 'удержано операцией', tail: ' — ждёт её конца' },
  en: { head: 'held by an operation', tail: ' — waiting for it to finish' },
} as const;

/** Строка удержания для `status`: имя сокращается серединой до `BLOCKER_PLAIN_MAX`. */
export function holdLine(lang: 'ru' | 'en', operation: string): string {
  const { head, tail } = HOLD[lang];
  return operation ? fitLine([head + ' ', named(operation), tail], BLOCKER_PLAIN_MAX) : head + tail;
}

/**
 * Части строки удержания из `plain` загрузчика; не строка удержания — `undefined`.
 * Строка длиной в предел status могла быть сокращена: имени нет, вместо него «…».
 */
export function holdLineParts(plain: string): LinePart[] | undefined {
  for (const { head, tail } of Object.values(HOLD)) {
    if (!plain.startsWith(head + ' ') || !plain.endsWith(tail)) continue;
    const name = plain.slice(head.length + 1, plain.length - tail.length);
    if (!name) continue;
    return [head + ' ', named(plain.length >= BLOCKER_PLAIN_MAX ? '…' : name), tail];
  }
  return undefined;
}
