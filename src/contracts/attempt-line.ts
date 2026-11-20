// Строка сводки попыток поручения (`attempts.line` у status, explain и
// представления оператора) на двух языках и в пределе длины. Хвост строки —
// остаток попыток или требуемое действие («повтор — только со сбросом») —
// не обрезается: при нехватке места сначала сокращается список отказов
// («и ещё N»), затем начало строки.

/** Числа сводки попыток (`attemptSummaryOf`) и остаток пределов. */
export interface AttemptLineFacts {
  total: number;
  active: number;
  failed: number;
  /** Отказы по корзинам в порядке сводки. */
  failures: readonly { key: string; count: number }[];
  timeouts: number;
  interrupted: number;
  accepted: number;
  attempts: { used: number; max: number };
  /** Предел незасчитанных отказов исчерпан: вместо остатка попыток — повтор только со сбросом. */
  neutralOut?: { used: number; max: number };
  repairs?: { used: number; budget: number };
}

const words = {
  ru: {
    total: (n: number, active: number) => `попыток ${n}${active ? ` (идёт ${active})` : ''}`,
    failed: (n: number) => `отказов ${n}`,
    more: (n: number) => `и ещё ${n}`,
    timeouts: (n: number) => `по времени ${n}`,
    interrupted: (n: number) => `прервано остановкой ${n}`,
    accepted: (n: number) => `принято ${n}`,
    neutralOut: (used: number, max: number) =>
      `исчерпан предел незасчитанных отказов ${used} из ${max}: повтор — только со сбросом`,
    left: (left: number, max: number) => `осталось попыток ${left} из ${max}`,
    repairs: (left: number, budget: number) => `, восстановлений группы ${left} из ${budget}`,
  },
  en: {
    total: (n: number, active: number) => `attempts ${n}${active ? ` (${active} running)` : ''}`,
    failed: (n: number) => `failures ${n}`,
    more: (n: number) => `and ${n} more`,
    timeouts: (n: number) => `time limit ${n}`,
    interrupted: (n: number) => `interrupted by shutdown ${n}`,
    accepted: (n: number) => `accepted ${n}`,
    neutralOut: (used: number, max: number) =>
      `the limit of uncounted failures is used up (${used} of ${max}): retry only after a reset`,
    left: (left: number, max: number) => `attempts left ${left} of ${max}`,
    repairs: (left: number, budget: number) => `, group repairs left ${left} of ${budget}`,
  },
} as const;

/** Обрезать с конца до `max` code units с «…», не разрезая суррогатную пару. */
function clipEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  let head = max - 1;
  if (/[\uD800-\uDBFF]/.test(text[head - 1] ?? '')) head -= 1;
  return text.slice(0, head) + '…';
}

/**
 * Строка сводки попыток не длиннее `max`. Хвост (остаток попыток или
 * «повтор — только со сбросом» и восстановления группы) сохраняется целиком;
 * не помещается — список отказов сокращается до первых корзин и «и ещё N»
 * (`and N more`), затем, если и без списка длинно, обрезается начало строки
 * до хвоста. Хвост длиннее предела — обрезается с конца (предел меньше
 * шаблона хвоста). `redact` (маска) применяется к каждому кандидату до
 * сравнения с пределом: результат уже замаскирован и не длиннее `max`.
 */
export function attemptLine(
  f: AttemptLineFacts,
  lang: 'ru' | 'en' = 'ru',
  max = Number.POSITIVE_INFINITY,
  redact: (text: string) => string = (t) => t,
): string {
  const w = words[lang];
  const left = (used: number, of: number) => Math.max(0, of - used);
  const tail =
    (f.neutralOut
      ? w.neutralOut(f.neutralOut.used, f.neutralOut.max)
      : w.left(left(f.attempts.used, f.attempts.max), f.attempts.max)) +
    (f.repairs ? w.repairs(left(f.repairs.used, f.repairs.budget), f.repairs.budget) : '');
  const rest = [w.timeouts(f.timeouts), w.interrupted(f.interrupted), w.accepted(f.accepted)];
  const lineWith = (shown: number) => {
    const list = f.failures.slice(0, shown).map((x) => `${x.key} ${x.count}`);
    const hidden = f.failures.length - shown;
    if (hidden > 0) list.push(w.more(hidden));
    const failed = w.failed(f.failed) + (list.length ? ` (${list.join(', ')})` : '');
    return [w.total(f.total, f.active), failed, ...rest].join('; ');
  };
  // Предел — для строки после маски: маска удлиняет текст, и обрезка после
  // неё отрезала бы хвост.
  for (let shown = f.failures.length; shown >= 0; shown--) {
    const line = redact(lineWith(shown) + '; ' + tail);
    if (line.length <= max) return line;
  }
  const end = redact(tail);
  if (end.length + 2 >= max) return clipEnd(end, max);
  return clipEnd(redact(lineWith(0)), max - end.length - 2) + '; ' + end;
}
