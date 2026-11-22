// Длительность флага CLI (0.1.0-alpha.66): всегда с единицей — `90s`, `30m`,
// `2h`. Голое число отклоняется: у `lead-begin --ttl` и `preview-start --ttl`
// раньше были разные единицы (минуты и секунды), и одно число значило разное.

import { HarnessError } from '../contracts/index.ts';

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** Длительность в человеческом виде для текста отказа: `90s`, `30m`, `12h`. */
function shown(ms: number): string {
  if (ms % UNIT_MS.h === 0 && ms >= UNIT_MS.h) return `${ms / UNIT_MS.h}h`;
  if (ms % UNIT_MS.m === 0 && ms >= UNIT_MS.m) return `${ms / UNIT_MS.m}m`;
  return `${ms / UNIT_MS.s}s`;
}

/**
 * Разобрать `--<flag>`: целое число с суффиксом `s`, `m` или `h` в пределах
 * `[minMs, maxMs]`. `zero: true` разрешает голый `0` (например, `--idle 0` —
 * «не по простою»): у нуля единица не нужна. Иначе — `INVALID_INPUT`, текст
 * называет суффиксы и пределы.
 */
export function parseDurationFlag(
  flag: string,
  raw: string,
  limits: { minMs: number; maxMs: number; zero?: boolean },
): number {
  const value = raw.trim();
  if (limits.zero && /^0+([smh])?$/.test(value)) return 0;
  const match = /^(\d+)([smh])$/.exec(value);
  const ms = match ? Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS] : NaN;
  if (!Number.isSafeInteger(ms) || ms < limits.minMs || ms > limits.maxMs)
    throw new HarnessError(
      'INVALID_INPUT',
      `--${flag}: длительность с единицей — s (секунды), m (минуты) или h (часы), например 90s, 30m, 2h; ` +
        `от ${shown(limits.minMs)} до ${shown(limits.maxMs)}` +
        (limits.zero ? '; 0 — выключить' : '') +
        (/^\d+(\.\d+)?$/.test(value) ? '; голое число не принимается' : ''),
      [{ path: [`--${flag}`], message: raw }],
    );
  return ms;
}
