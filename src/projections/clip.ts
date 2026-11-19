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
