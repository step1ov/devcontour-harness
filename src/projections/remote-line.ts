// Строка удалённой ветки принятой работы (`target.remote.line` / `lineEn`):
// общий шаблон загрузчика (`status`, `result`) и представления оператора.
// Слова состояния стоят до имени ветки и не сокращаются: при нехватке места
// имя сокращается серединой, и «ещё нет» не читается как «уже».

import { fitLine, named, type LinePart } from './clip.ts';

export type RemoteLineState = 'pushed' | 'not-pushed' | 'unknown';

/** Части строки: `name` — короткое имя удалённой ветки, `reason` — почему неизвестно. */
export function remoteLineParts(
  state: RemoteLineState,
  lang: 'ru' | 'en',
  name: string,
  reason = '',
): LinePart[] {
  const ru = lang === 'ru';
  if (state === 'pushed')
    return [ru ? 'уже в удалённой ветке ' : 'already on the remote branch ', named(name)];
  if (state === 'not-pushed')
    return [
      ru
        ? 'принято локально; ещё нет в удалённой ветке '
        : 'accepted locally; not yet on the remote branch ',
      named(name),
    ];
  return [ru ? 'неизвестно (' : 'unknown (', named(reason), ')'];
}

/** Строка не длиннее `max`; `redact` маскирует имя и причину до сокращения. */
export function remoteLine(
  state: RemoteLineState,
  lang: 'ru' | 'en',
  name: string,
  max: number,
  reason = '',
  redact?: (text: string) => string,
): string {
  return fitLine(remoteLineParts(state, lang, name, reason), max, redact).trimEnd();
}
