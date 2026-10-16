import { createHash } from 'node:crypto';

/**
 * Каноническая сериализация: ключи объектов по порядку, без пробелов,
 * `undefined` опускается. Один и тот же смысл даёт один digest независимо
 * от порядка полей в файле поручения.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new TypeError('Нечисловое значение в каноническом JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v ?? null)).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
}

export const sha256 = (text: string | Uint8Array) =>
  createHash('sha256').update(text).digest('hex');

/** Digest значения: SHA-256 его канонического JSON. */
export const digestOf = (value: unknown) => sha256(canonicalJson(value));
