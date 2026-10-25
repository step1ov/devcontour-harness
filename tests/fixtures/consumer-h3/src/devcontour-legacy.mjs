/**
 * Legacy-оракул H3: дословные копии алгоритмов DevContour с удалёнными типами.
 * Источник — `devcontour-dedup`, коммит 6a597286a1d59b107fa0365c9a0f01765696af90
 * (ветка `dedup/d1`), файлы `git show <commit>:<path>`:
 *
 * - `short`, `clip`, `SHORT`, `DIAGNOSTIC` — src/application/bounded.ts:7–26;
 * - `contextPage` (`page`, `MAX_RESPONSE`) — src/application/context.ts:205–257;
 * - `observabilityPage` (`page`) — src/application/observability.ts:26–49;
 * - `legacyCapabilities` — src/application/agent.ts:273–288, параметризован
 *   операциями хоста вместо модульных `agentOperations`/`descriptions`/
 *   `readOnly`/`agentInputs` и `package.json`;
 * - байтовые проверки — src/application/agent.ts:301–305 (`bounded`), 308–309
 *   (`run`), 378–379 (`dispatch`); src/application/context.ts:291–292
 *   (`execute`); src/application/preparation-agent.ts:17–18, 29–30;
 *   src/server/http.ts:59 (`body`);
 * - `json` — src/server/http.ts:47–54;
 * - `DomainError` — src/core/model.ts:987–994;
 * - `digest` — src/core/service.ts:41–44.
 *
 * Тела функций не менялись; переименованы только одноимённые `page` и
 * проверки, вынутые из методов классов. Импортирует только `zod` и `node:*`.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/* src/core/model.ts:987–994 */
export class DomainError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

/* src/core/service.ts:41–44 */
export const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');

/* src/application/bounded.ts:7–26 */
/** Сколько знаков текста остаётся в компактной строке. */
export const SHORT = 300;
/** Предел одной строки диагностики (ошибки, отчёты, история эпизода). */
export const DIAGNOSTIC = 2000;

export const short = (text, n = SHORT) => (text && text.length > n ? text.slice(0, n) + '…' : text);

/** Строки не длиннее `n` на любой глубине, без токенов владения. */
export function clip(value, n = DIAGNOSTIC) {
  if (typeof value === 'string') return short(value, n);
  if (Array.isArray(value)) return value.map((v) => clip(v, n));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== 'token')
        .map(([k, v]) => [k, clip(v, n)]),
    );
  return value;
}

/* src/application/context.ts:205–257 */
export const MAX_RESPONSE = 64 * 1024;
export function contextPage(items, header, revision, binding, input) {
  let offset = 0;
  if (input.cursor) {
    let cursor;
    try {
      cursor = z
        .object({
          revision: z.string(),
          binding: z.string(),
          offset: z.number().int().nonnegative(),
        })
        .strict()
        .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString()));
    } catch {
      throw new DomainError('Некорректный cursor', 400);
    }
    if (cursor.revision !== revision || cursor.binding !== binding)
      throw new DomainError(
        'Контекст изменился или cursor принадлежит другому запросу. Начните с первой страницы.',
      );
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > items.length)
      throw new DomainError('Некорректный cursor offset', 400);
    offset = cursor.offset;
  }
  const selected = [];
  while (offset + selected.length < items.length && selected.length < input.limit) {
    const candidate = [...selected, items[offset + selected.length]];
    if (Buffer.byteLength(JSON.stringify({ ...header, items: candidate })) > MAX_RESPONSE - 2048)
      break;
    selected.push(items[offset + selected.length]);
  }
  if (!selected.length && offset < items.length)
    throw new DomainError('Элемент контекста превышает лимит ответа', 413);
  const next = offset + selected.length;
  return {
    ...header,
    revision,
    items: selected,
    total: items.length,
    hasMore: next < items.length,
    nextCursor:
      next < items.length
        ? Buffer.from(JSON.stringify({ revision, binding, offset: next })).toString('base64url')
        : null,
  };
}

/* src/application/observability.ts:26–49 */
export function observabilityPage(records, input) {
  const revision = digest(records);
  const match = input.cursor?.match(/^([a-f0-9]{64}):(\d+)$/);
  if (input.cursor && (!match || match[1] !== revision))
    throw new DomainError('Отчёт изменился; начните чтение заново');
  const offset = Number(match?.[2] ?? 0);
  if (!Number.isSafeInteger(offset) || offset > records.length)
    throw new DomainError('Некорректный cursor');
  let end = offset,
    bytes = 0;
  while (end < records.length && end - offset < input.limit) {
    const size = Buffer.byteLength(JSON.stringify(records[end]));
    if (bytes + size > 48000) break;
    bytes += size;
    end++;
  }
  if (end === offset && offset < records.length)
    throw new DomainError('Запись превышает размер страницы', 413);
  return {
    revision,
    records: records.slice(offset, end),
    nextCursor: end < records.length ? revision + ':' + end : null,
  };
}

/*
 * src/application/agent.ts:273–288. Параметры заменяют модульные значения:
 * `pkg` — разобранный package.json, `agentOperations` — порядок операций,
 * `descriptions`, `readOnly(name)`, `agentInputs` — как в agent.ts.
 */
export function legacyCapabilities({ pkg, agentOperations, descriptions, readOnly, agentInputs }) {
  return {
    name: pkg.name,
    version: pkg.version,
    protocolVersion: 1,
    maxInputBytes: 100000,
    maxResultBytes: 65536,
    tools: agentOperations.map((name) => ({
      name,
      description: descriptions[name],
      readOnly: readOnly(name),
      inputSchema: z.toJSONSchema(agentInputs[name], { io: 'input' }),
    })),
  };
}

/* src/application/agent.ts:301–305 (`AgentService.bounded`) */
export function agentBounded(result) {
  if (Buffer.byteLength(JSON.stringify(result)) > 65536)
    throw new DomainError('Ответ превышает 64 KiB; сузьте запрос или используйте CLI-отчёт', 413);
  return result;
}

/* src/application/agent.ts:308–309 (`run`) и 378–379 (`dispatch`) — один текст */
export function agentRequestGuard(raw) {
  if (Buffer.byteLength(JSON.stringify(raw)) > 100000)
    throw new DomainError('Запрос превышает 100000 байт', 413);
  return raw;
}

/* src/application/context.ts:291–292 (`AgentContext.execute`) */
export function contextResultGuard(result) {
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE)
    throw new DomainError('Ответ превышает 64 KiB; сузьте контекст', 413);
  return result;
}

/* src/application/preparation-agent.ts:17–18 */
export function preparationRequestGuard(raw) {
  if (Buffer.byteLength(JSON.stringify(raw)) > 100000)
    throw new DomainError('Слишком большой запрос', 413);
  return raw;
}

/* src/application/preparation-agent.ts:29–30 */
export function preparationResultGuard(result) {
  if (Buffer.byteLength(JSON.stringify(result)) > 65536)
    throw new DomainError('Ответ превышает 64 KiB', 413);
  return result;
}

/* src/server/http.ts:59 (тело цикла `body`: накопленный текст потока) */
export function httpBodyGuard(text) {
  if (Buffer.byteLength(text) > 100_000) throw new DomainError('Слишком большой запрос', 413);
  return text;
}

/* src/server/http.ts:47–54 */
export const json = (res, status, value) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
};
