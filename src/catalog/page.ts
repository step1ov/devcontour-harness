import { z } from 'zod';
import { HarnessError } from '../contracts/errors.ts';
import { jsonBytes } from './bytes.ts';

/**
 * Формат cursor: `json-base64url` — base64url JSON `{revision, binding, offset}`
 * (страница привязана к ревизии данных и к запросу); `digest-offset` —
 * `<sha256 ревизии>:<offset>` (только ревизия).
 */
export type CursorFormat = 'json-base64url' | 'digest-offset';
/** Мера бюджета: `page` — JSON всей страницы с заголовком; `items` — сумма JSON элементов. */
export type PageMeasure = 'page' | 'items';

interface PageBudget {
  cursor?: string;
  /** Не больше стольких элементов на странице. */
  limit: number;
  /** Предел байт страницы; по умолчанию 65536. */
  maxBytes?: number;
  /** Запас под конверт транспорта; по умолчанию 2048. */
  reserveBytes?: number;
  measure?: PageMeasure;
}

export type PageOptions = PageBudget &
  (
    | { cursorFormat?: 'json-base64url'; revision: string; binding: string }
    | { cursorFormat: 'digest-offset'; revision: string; binding?: never }
  );

export type Page<T, H extends Record<string, unknown> = Record<never, never>> = Omit<
  H,
  'revision' | 'items' | 'total' | 'hasMore' | 'nextCursor'
> & { revision: string; items: T[]; total: number; hasMore: boolean; nextCursor: string | null };

const cursorSchema = z.strictObject({
  revision: z.string(),
  binding: z.string(),
  offset: z.number().int().nonnegative(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const inputError = (path: string[], message: string): never => {
  throw new HarnessError(
    'INVALID_INPUT',
    path[0] === 'cursor' ? message : `pageItems: ${message}`,
    [{ path, message }],
  );
};
const optionError = (key: string, message: string): never => {
  throw new HarnessError('INVALID_INPUT', `pageItems: ${message}`, [
    { path: ['options', key], message },
  ]);
};
const staleCursor = (): never => {
  throw new HarnessError(
    'REVISION_CONFLICT',
    'Cursor относится к другой ревизии или другому запросу: начните с первой страницы',
    [{ path: ['cursor'], message: 'stale' }],
  );
};
const badOffset = (): never => {
  throw new HarnessError('INVALID_INPUT', 'Некорректный cursor offset', [
    { path: ['cursor', 'offset'], message: 'out-of-range' },
  ]);
};

/**
 * Страница элементов с cursor. Элементы набираются по порядку, пока страница
 * (или сумма элементов) помещается в `maxBytes − reserveBytes` и их меньше
 * `limit`. Чистая функция: тот же cursor на тех же данных — та же страница.
 *
 * Отказы: нечитаемый cursor — `INVALID_INPUT ['cursor']`; offset вне
 * `[0, items.length]` — `INVALID_INPUT ['cursor','offset']`; cursor другой
 * ревизии/запроса — `REVISION_CONFLICT`; первый элемент страницы не
 * помещается — `RESPONSE_TOO_LARGE` (данные не усекаются).
 */
export function pageItems<T, H extends Record<string, unknown> = Record<never, never>>(
  items: readonly T[],
  header: H,
  options: PageOptions,
): Page<T, H> {
  // Форма входа — до любых расчётов: неверный вызов хоста — INVALID_INPUT, не TypeError.
  if (!Array.isArray(items)) inputError(['items'], 'items — массив');
  if (!isRecord(header)) inputError(['header'], 'header — объект');
  if (!isRecord(options)) inputError(['options'], 'options — объект');
  const { limit, maxBytes = 65536, reserveBytes = 2048, measure = 'page', revision } = options;
  // Кодек по умолчанию — только при отсутствующем поле; null и прочее — отказ.
  const format = options.cursorFormat === undefined ? 'json-base64url' : options.cursorFormat;
  if (format !== 'json-base64url' && format !== 'digest-offset')
    optionError('cursorFormat', 'cursorFormat — json-base64url или digest-offset');
  const digestOffset = format === 'digest-offset';
  if (measure !== 'page' && measure !== 'items') optionError('measure', 'measure — page или items');
  if (typeof revision !== 'string') optionError('revision', 'revision — строка');
  const binding = (options as { binding?: unknown }).binding;
  if (digestOffset ? binding !== undefined : typeof binding !== 'string')
    optionError(
      'binding',
      digestOffset ? 'binding не задаётся кодеку digest-offset' : 'binding — строка',
    );
  // null и '' — первая страница, как у прежних pager хоста.
  if (options.cursor != null && typeof options.cursor !== 'string')
    inputError(['cursor'], 'Некорректный cursor');
  if (!Number.isSafeInteger(limit) || limit < 1) optionError('limit', 'limit — целое ≥ 1');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    optionError('maxBytes', 'maxBytes — целое ≥ 1');
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0 || reserveBytes >= maxBytes)
    optionError('reserveBytes', 'reserveBytes — целое из [0, maxBytes)');
  if (digestOffset && !/^[a-f0-9]{64}$/.test(revision))
    optionError('revision', 'revision кодека digest-offset — sha256 hex');

  let offset = 0;
  const { cursor } = options;
  if (cursor && digestOffset) {
    const match = cursor.match(/^([a-f0-9]{64}):(\d+)$/);
    if (!match || match[1] !== revision) staleCursor();
    offset = Number(match![2]);
    if (!Number.isSafeInteger(offset) || offset > items.length) badOffset();
  } else if (cursor) {
    let parsed: z.infer<typeof cursorSchema>;
    try {
      parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    } catch {
      throw new HarnessError('INVALID_INPUT', 'Некорректный cursor', [
        { path: ['cursor'], message: 'unreadable' },
      ]);
    }
    if (parsed.revision !== revision || parsed.binding !== binding) staleCursor();
    if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > items.length)
      badOffset();
    offset = parsed.offset;
  }

  const budget = maxBytes - reserveBytes;
  const sizeOf = (selected: readonly T[], next: T) =>
    measure === 'page' ? jsonBytes({ ...header, items: [...selected, next] }) : jsonBytes(next);
  const selected: T[] = [];
  let used = 0;
  while (offset + selected.length < items.length && selected.length < limit) {
    const next = items[offset + selected.length] as T;
    const size = sizeOf(selected, next);
    if (measure === 'page' ? size > budget : used + size > budget) break;
    used += size;
    selected.push(next);
  }
  if (!selected.length && offset < items.length) {
    const bytes = sizeOf([], items[offset] as T);
    throw new HarnessError(
      'RESPONSE_TOO_LARGE',
      `Элемент ${offset} не помещается в предел ответа: ${bytes} > ${budget} байт`,
      [{ path: ['items', offset], message: `${bytes} > ${budget}` }],
    );
  }
  const end = offset + selected.length;
  const nextCursor =
    end >= items.length
      ? null
      : digestOffset
        ? revision + ':' + end
        : Buffer.from(
            JSON.stringify({
              revision,
              binding,
              offset: end,
            }),
          ).toString('base64url');
  return {
    ...header,
    revision,
    items: selected,
    total: items.length,
    hasMore: end < items.length,
    nextCursor,
  };
}
