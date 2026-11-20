// Усечение строк для ответов агенту и проекций. Предел — на каждую строку,
// а не на размер объекта: байтовый предел транспорта — отдельная граница.

export const CLIP_SHORT = 300;
export const CLIP_DIAGNOSTIC = 2000;

/** Строка длиннее `n` code units обрезается до `n` и получает «…». */
export function clipText(text: string | undefined, n = CLIP_SHORT): string | undefined {
  return text && text.length > n ? text.slice(0, n) + '…' : text;
}

/** Каждая строка на любой глубине — через clipText; ключи `omitKeys` удаляются. */
export function clipDeep<T>(
  value: T,
  n = CLIP_DIAGNOSTIC,
  omitKeys: readonly string[] = ['token'],
): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return clipText(v, n);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => !omitKeys.includes(k))
          .map(([k, x]) => [k, walk(x)]),
      );
    return v;
  };
  return walk(value) as T;
}

/**
 * Замаскировать, затем обрезать до `max` символов. Обратный порядок оставлял
 * бы префикс секрета, разрезанного границей обрезки: маска его уже не узнаёт.
 * `suffix` (уже замаскированный) сохраняется целиком, обрезается текст перед ним.
 */
export function redactThenClip(
  text: string,
  max: number,
  redact?: (text: string) => string,
  suffix = '',
) {
  const masked = redact ? redact(text) : text;
  return (masked.slice(0, Math.max(0, max - suffix.length)) + suffix).slice(0, max);
}

/**
 * Часть строки для человека: текст шаблона (смысл — «ещё нет», «не прошла»;
 * не обрезается) или имя (`{ name }`: ветка, ID, ref), которое при нехватке
 * места сокращается серединой.
 */
export type LinePart = string | { name: string };
export const named = (name: string): LinePart => ({ name });

/** Сократить серединой до `n` code units: начало и конец имени, между ними «…». */
export function elideMiddle(text: string, n: number): string {
  if (text.length <= n) return text;
  if (n <= 1) return n === 1 ? '…' : '';
  let head = Math.ceil((n - 1) / 2);
  let tail = n - 1 - head;
  // Суррогатная пара не разрезается: половина символа выпадает целиком.
  if (/[\uD800-\uDBFF]/.test(text[head - 1] ?? '')) head -= 1;
  if (tail > 0 && /[\uDC00-\uDFFF]/.test(text[text.length - tail] ?? '')) tail -= 1;
  return text.slice(0, head) + '…' + (tail > 0 ? text.slice(text.length - tail) : '');
}

/**
 * Собрать строку не длиннее `max`: текст шаблона сохраняется целиком, места
 * не хватает — сокращаются имена (самые длинные — первыми, до общей длины).
 * `redact` маскирует каждое имя до сокращения: сокращение не оставляет
 * префикса секрета, который маска уже не узнала бы. Если шаблон сам длиннее
 * предела — имена сводятся к «…» и строка обрезается с конца.
 */
export function fitLine(
  parts: readonly LinePart[],
  max: number,
  redact?: (text: string) => string,
): string {
  const names = parts.filter((p): p is { name: string } => typeof p !== 'string');
  const values = names.map((p) => (redact ? redact(p.name) : p.name));
  const fixed = parts.reduce((n, p) => n + (typeof p === 'string' ? p.length : 0), 0);
  const total = values.reduce((n, v) => n + v.length, 0);
  let sizes = values.map((v) => v.length);
  if (fixed + total > max) {
    const budget = max - fixed;
    if (budget < values.filter((v) => v.length > 0).length)
      sizes = values.map((v) => Math.min(1, v.length));
    else {
      // Наибольший общий потолок `cap`, при котором имена укладываются в
      // бюджет; остаток — по одному символу именам, упёршимся в потолок.
      const fits = (cap: number) =>
        values.reduce((n, v) => n + Math.min(v.length, cap), 0) <= budget;
      let lo = 1;
      let hi = Math.max(...values.map((v) => v.length));
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(mid)) lo = mid;
        else hi = mid - 1;
      }
      sizes = values.map((v) => Math.min(v.length, lo));
      let left = budget - sizes.reduce((n, s) => n + s, 0);
      for (let i = 0; i < sizes.length && left > 0; i++)
        if (values[i]!.length > sizes[i]!) {
          sizes[i] = sizes[i]! + 1;
          left -= 1;
        }
    }
  }
  let k = 0;
  const line = parts
    .map((p) => {
      if (typeof p === 'string') return p;
      const i = k++;
      return elideMiddle(values[i]!, sizes[i]!);
    })
    .join('');
  return line.length > max ? line.slice(0, Math.max(0, max - 1)) + '…' : line;
}
