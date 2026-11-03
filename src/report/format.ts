// Форматирование отчёта без локали и часового пояса: одни и те же данные —
// одни и те же байты на любой машине. Модуль без node:* — его импортирует браузер.

import type { ReportDist, ReportMeasure } from '../contracts/report.ts';

const HOUR = 3_600_000;

/** Длительность: «45 s», «58 min», «3.2 h», «20.6 d». */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < HOUR) return `${Math.round(ms / 60_000)} min`;
  if (ms < 48 * HOUR) return `${(ms / HOUR).toFixed(1)} h`;
  return `${(ms / (24 * HOUR)).toFixed(1)} d`;
}

/** Доллары с двумя знаками. */
export const formatUsd = (usd: number) => `$${usd.toFixed(2)}`;

/** «k of n»; процент — только при знаменателе от 20. */
export function formatRatio(k: number, n: number): string {
  return n >= 20 ? `${k} of ${n} (${Math.round((k * 100) / n)}%)` : `${k} of ${n}`;
}

/** Знак границы: «≥ », «≤ » или ничего. */
export const boundPrefix = (m: Pick<ReportMeasure, 'bound'>) =>
  m.bound === 'lower' ? '≥ ' : m.bound === 'upper' ? '≤ ' : '';

/** Мера-доля: «≥ 3 of 19», «unknown». */
export function formatMeasureRatio(m: ReportMeasure): string {
  if (m.value === null || m.bound === 'unknown') return 'unknown';
  return boundPrefix(m) + formatRatio(m.value, m.n);
}

/** Мера в долларах: «≥ $5.73», «= $5.73», «unknown». */
export function formatMeasureUsd(m: ReportMeasure): string {
  if (m.value === null || m.bound === 'unknown') return 'unknown';
  return (m.bound === 'exact' ? '= ' : boundPrefix(m)) + formatUsd(m.value);
}

/**
 * Распределение длительностей: «median 58 min, p75 11.0 h (n=19)»; при
 * n < 5 — перечень значений без медианы.
 */
export function formatDist(d: ReportDist, value: (v: number) => string = formatDuration): string {
  if (d.n === 0) return d.unknown ? `unknown (${d.unknown} not measured)` : 'no data';
  const unknown = d.unknown ? `; ${d.unknown} not measured` : '';
  if (d.median === null)
    return `${d.values.map(value).join(', ')} (n=${d.n}; no median under 5${unknown})`;
  return `median ${value(d.median)}, p75 ${value(d.p75 ?? d.median)}, max ${value(d.max ?? d.median)} (n=${d.n}${unknown})`;
}

/** Окно отчёта простыми словами. */
export function formatWindow(w: { since: string | null; until: string | null }): string {
  if (!w.since && !w.until) return 'all history';
  if (w.since && w.until) return `from ${w.since} to ${w.until} (end excluded)`;
  return w.since ? `since ${w.since}` : `before ${w.until}`;
}
