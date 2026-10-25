// WP-PAGE (H3-02, AC19): `pageItems` против legacy-оракула DevContour —
// дословных копий `page` из context.ts:205–257 и observability.ts:26–49
// (tests/fixtures/consumer-h3/src/devcontour-legacy.mjs, коммит 6a59728).
// Успех сравнивается по `JSON.stringify`, отказ — по `{status, message}`
// после host mapping §1.4 спецификации H3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessError } from '../src/contracts/errors.ts';
import { jsonBytes, pageItems, type PageOptions } from '../src/catalog/index.ts';
import * as root from '../src/index.ts';

interface DomainErrorLike extends Error {
  status: number;
}
interface PageInput {
  cursor?: string;
  limit: number;
}
interface ObservabilityDto {
  revision: string;
  records: unknown[];
  nextCursor: string | null;
}
interface Legacy {
  DomainError: new (message: string, status?: number) => DomainErrorLike;
  digest: (value: unknown) => string;
  contextPage: (
    items: unknown[],
    header: Record<string, unknown>,
    revision: string,
    binding: string,
    input: PageInput,
  ) => { nextCursor: string | null; items: unknown[] };
  observabilityPage: (records: unknown[], input: PageInput) => ObservabilityDto;
}
const legacy = (await import(
  new URL('./fixtures/consumer-h3/src/devcontour-legacy.mjs', import.meta.url).href
)) as Legacy;

/* ------------------------------------------------------------------ */
/* Host mapping §1.4: отказ harness → {status, message} DevContour      */
/* ------------------------------------------------------------------ */

type Outcome = { ok: true; json: string } | { ok: false; status: number | string; message: string };
type Mapping = (e: HarnessError) => { status: number; message: string } | undefined;

const pathOf = (e: HarnessError) => JSON.stringify(e.issues[0]?.path ?? []);
const contextMapping: Mapping = (e) => {
  if (e.code === 'INVALID_INPUT' && pathOf(e) === '["cursor"]')
    return { status: 400, message: 'Некорректный cursor' };
  if (e.code === 'INVALID_INPUT' && pathOf(e) === '["cursor","offset"]')
    return { status: 400, message: 'Некорректный cursor offset' };
  if (e.code === 'REVISION_CONFLICT')
    return {
      status: 409,
      message:
        'Контекст изменился или cursor принадлежит другому запросу. Начните с первой страницы.',
    };
  if (e.code === 'RESPONSE_TOO_LARGE')
    return { status: 413, message: 'Элемент контекста превышает лимит ответа' };
  return undefined;
};
const observabilityMapping: Mapping = (e) => {
  if (e.code === 'INVALID_INPUT' && pathOf(e) === '["cursor","offset"]')
    return { status: 409, message: 'Некорректный cursor' };
  if (e.code === 'REVISION_CONFLICT')
    return { status: 409, message: 'Отчёт изменился; начните чтение заново' };
  if (e.code === 'RESPONSE_TOO_LARGE')
    return { status: 413, message: 'Запись превышает размер страницы' };
  return undefined;
};

const thrown = (e: unknown): Outcome => ({
  ok: false,
  status: 'throw',
  message: e instanceof Error ? e.constructor.name : typeof e,
});
const runLegacy = (f: () => unknown): Outcome => {
  try {
    return { ok: true, json: JSON.stringify(f()) };
  } catch (e) {
    if (e instanceof legacy.DomainError) return { ok: false, status: e.status, message: e.message };
    return thrown(e);
  }
};
const runHarness = (f: () => unknown, mapping: Mapping): Outcome => {
  try {
    return { ok: true, json: JSON.stringify(f()) };
  } catch (e) {
    if (e instanceof HarnessError) {
      const mapped = mapping(e);
      return mapped
        ? { ok: false, ...mapped }
        : { ok: false, status: 'unmapped', message: `${e.code} ${pathOf(e)}` };
    }
    return thrown(e);
  }
};

/** Host DevContour context на harness: `pageItems(items, header, {revision, binding, cursor, limit})`. */
const sharedContext = (
  items: unknown[],
  header: Record<string, unknown>,
  revision: string,
  binding: string,
  input: PageInput,
) => pageItems(items, header, { revision, binding, cursor: input.cursor, limit: input.limit });

/** Host DevContour observability на harness: digest-offset, мера элементов, 48000, DTO хоста. */
const sharedObservability = (records: unknown[], input: PageInput): ObservabilityDto => {
  const p = pageItems(
    records,
    {},
    {
      cursorFormat: 'digest-offset',
      measure: 'items',
      revision: legacy.digest(records),
      cursor: input.cursor,
      limit: input.limit,
      maxBytes: 48000,
      reserveBytes: 0,
    },
  );
  return { revision: p.revision, records: p.items, nextCursor: p.nextCursor };
};

const compareContext = (
  items: unknown[],
  header: Record<string, unknown>,
  revision: string,
  binding: string,
  input: PageInput,
  label: string,
) => {
  const expected = runLegacy(() => legacy.contextPage(items, header, revision, binding, input));
  const actual = runHarness(
    () => sharedContext(items, header, revision, binding, input),
    contextMapping,
  );
  assert.deepEqual(actual, expected, label);
  return expected;
};
const compareObservability = (records: unknown[], input: PageInput, label: string) => {
  const expected = runLegacy(() => legacy.observabilityPage(records, input));
  const actual = runHarness(() => sharedObservability(records, input), observabilityMapping);
  assert.deepEqual(actual, expected, label);
  return expected;
};

/* ------------------------------------------------------------------ */
/* Детерминированный корпус                                            */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pools = [
  'abcxyz ABC0189_-',
  'абвгдеёжзийклмнопрстуфхцчшщъыьэюяЖЁ',
  '😀🚀👍🏽🇷🇺',
  '𐏿',
  '"\\\n\t\u0001/',
  '中文字符測試',
];

function generator(seed: number) {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
  const text = (length: number) => {
    let s = '';
    while (s.length < length) {
      const pool = pick(pools);
      // Код-юниты пула: суррогаты эмодзи могут разрезаться — это нужный случай.
      s += pool[int(0, pool.length - 1)] ?? 'a';
    }
    return s;
  };
  const size = () => {
    const r = rnd();
    if (r < 0.03) return int(12000, 30000);
    if (r < 0.15) return int(1000, 6000);
    return int(0, 120);
  };
  const item = (): unknown => {
    const kind = int(0, 5);
    if (kind === 0) return text(size());
    if (kind === 1) return int(-1000, 1000);
    if (kind === 2) return null;
    if (kind === 3) return [text(size()), int(0, 9), { k: text(int(0, 10)) }];
    return {
      id: `item-${int(0, 99999)}`,
      text: text(size()),
      nested: { flag: rnd() < 0.5, note: text(int(0, 40)), list: [text(int(0, 8))] },
    };
  };
  const header = (): Record<string, unknown> =>
    pick([
      {},
      { project: text(int(0, 30)) },
      { revision: 'header-revision', items: ['из заголовка'] },
      { total: -1, hasMore: 'да', nextCursor: 'x', title: text(int(0, 200)) },
      { repositoryId: 'main', summary: text(int(0, 3000)) },
    ]);
  const limit = () => pick([1, 20, 50, int(1, 50)]);
  return { rnd, int, pick, text, item, header, limit };
}

const b64 = (value: unknown, encoding: 'base64url' | 'base64' = 'base64url') =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString(encoding);

const contextCursors = (revision: string, binding: string, length: number) => [
  '',
  null,
  b64({}),
  b64('{}'),
  'не base64 !!!',
  '***',
  b64('not json'),
  b64([revision, binding, 0]),
  b64({ revision, binding, offset: 0, extra: 1 }),
  b64({ revision, binding }),
  b64({ revision, binding, offset: '1' }),
  b64({ revision, binding, offset: 0 }, 'base64'),
  b64({ revision, binding, offset: -1 }),
  b64({ revision, binding, offset: 1.5 }),
  b64({ revision, binding, offset: 2 ** 53 }),
  b64({ revision, binding, offset: 10000 }),
  b64({ revision, binding, offset: length }),
  b64({ revision, binding, offset: length + 1 }),
  b64({ revision, binding: binding + '-чужой', offset: 0 }),
  b64({ revision: 'старая', binding, offset: 0 }),
  b64({ revision: 'старая', binding, offset: 10000 }),
  b64({ revision: 'старая', binding, offset: -1 }),
];
const observabilityCursors = (revision: string, length: number) => [
  '',
  null,
  'мусор',
  revision,
  `${revision}:`,
  `${revision}:-1`,
  `${revision}:1.5`,
  `${revision}:0`,
  `${revision}:000`,
  `${revision}:${String(length).padStart(5, '0')}`,
  `${revision}:${length}`,
  `${revision}:${length + 1}`,
  `${revision}:10000`,
  `${revision}:${'9'.repeat(20)}`,
  `${revision}:9007199254740993`,
  `${revision.toUpperCase()}:0`,
  `${'0'.repeat(64)}:0`,
  `${'0'.repeat(64)}:${'9'.repeat(20)}`,
  `${revision}:0 `,
  ` ${revision}:0`,
];

const SCENARIOS = 520;

test('H3-02/AC19: корпус context pager = legacy context.ts:205–257 (≥ 500 сценариев, обход и порча cursor)', () => {
  let calls = 0;
  let multiPage = 0;
  const seen = new Set<number | string>();
  for (let seed = 1; seed <= SCENARIOS; seed++) {
    const g = generator(seed);
    const items = Array.from({ length: g.int(0, 45) }, g.item);
    const header = g.header();
    const revision = legacy.digest({ seed, items });
    const binding = JSON.stringify({ operation: 'task_briefing', taskId: `T-${seed}` });
    const limit = g.limit();
    const label = (step: string) => `seed ${seed} ${step}`;
    const collected: unknown[] = [];
    let cursor: string | undefined;
    for (let step = 0; step < 200; step++) {
      const outcome = compareContext(
        items,
        header,
        revision,
        binding,
        { cursor, limit },
        label(`#${step}`),
      );
      calls++;
      seen.add(outcome.ok ? 'ok' : outcome.status);
      if (outcome.ok && step === 1) multiPage++;
      if (!outcome.ok) break;
      // Повтор того же cursor — та же страница (выборочно: корпус и так квадратичен).
      if (step % 4 === 0) {
        compareContext(
          items,
          header,
          revision,
          binding,
          { cursor, limit },
          label(`#${step} repeat`),
        );
        calls++;
      }
      const page = JSON.parse(outcome.json) as { items: unknown[]; nextCursor: string | null };
      collected.push(...page.items);
      if (page.nextCursor === null) {
        assert.equal(JSON.stringify(collected), JSON.stringify(items), label('reassembly'));
        break;
      }
      cursor = page.nextCursor;
    }
    const bad = contextCursors(revision, binding, items.length);
    const extra = g.pick(bad) as string | undefined;
    const spoiled = compareContext(
      items,
      header,
      revision,
      binding,
      { cursor: extra, limit },
      label('bad cursor'),
    );
    seen.add(spoiled.ok ? 'ok' : spoiled.status);
    calls++;
  }
  assert.ok(calls >= SCENARIOS * 2, `calls ${calls}`);
  // Корпус действительно проходит все ветви: успех, 400, 409, 413 и многостраничный обход.
  assert.deepEqual([...seen].sort(), [400, 409, 413, 'ok']);
  assert.ok(multiPage > SCENARIOS / 10, `multi-page ${multiPage}`);
});

test('H3-02/AC19: корпус observability pager = legacy observability.ts:26–49 (≥ 500 сценариев)', () => {
  let calls = 0;
  let multiPage = 0;
  const seen = new Set<number | string>();
  for (let seed = 10001; seed < 10001 + SCENARIOS; seed++) {
    const g = generator(seed);
    const records = Array.from({ length: g.int(0, 40) }, g.item);
    const limit = g.limit();
    const label = (step: string) => `seed ${seed} ${step}`;
    const collected: unknown[] = [];
    let cursor: string | undefined;
    for (let step = 0; step < 200; step++) {
      const outcome = compareObservability(records, { cursor, limit }, label(`#${step}`));
      calls++;
      seen.add(outcome.ok ? 'ok' : outcome.status);
      if (outcome.ok && step === 1) multiPage++;
      if (!outcome.ok) break;
      if (step % 4 === 0) {
        compareObservability(records, { cursor, limit }, label(`#${step} repeat`));
        calls++;
      }
      const page = JSON.parse(outcome.json) as ObservabilityDto;
      collected.push(...page.records);
      if (page.nextCursor === null) {
        assert.equal(JSON.stringify(collected), JSON.stringify(records), label('reassembly'));
        break;
      }
      cursor = page.nextCursor;
    }
    const bad = observabilityCursors(legacy.digest(records), records.length);
    const spoiled = compareObservability(
      records,
      { cursor: g.pick(bad) as string | undefined, limit },
      label('bad'),
    );
    seen.add(spoiled.ok ? 'ok' : spoiled.status);
    calls++;
  }
  assert.ok(calls >= SCENARIOS * 2, `calls ${calls}`);
  assert.deepEqual([...seen].sort(), [409, 413, 'ok']);
  assert.ok(multiPage > SCENARIOS / 10, `multi-page ${multiPage}`);
});

/* ------------------------------------------------------------------ */
/* Cursor: все случаи спецификации с ожидаемым статусом                 */
/* ------------------------------------------------------------------ */

const multilingual = [
  'привет',
  '😀🚀',
  '\ud800',
  { text: 'ёжик в тумане', n: 1 },
  'abc',
  ['中文', null],
  'конец',
];

test('H3-02: cursor json-base64url — пустой, мусор, лишний ключ, base64 +/=, offset, чужой binding, устаревшая revision', () => {
  const revision = 'rev-1';
  const binding = 'task_briefing:T-1';
  const items = multilingual;
  const n = items.length;
  const cases: [string, unknown, number | 'ok' | 'throw'][] = [
    ["''", '', 'ok'],
    ['null', null, 'ok'],
    ['{} (объект)', {}, 400],
    ['base64 {}', b64({}), 400],
    ['мусор', 'не base64 !!!', 400],
    ['не JSON', b64('not json'), 400],
    ['лишний ключ', b64({ revision, binding, offset: 0, extra: 1 }), 400],
    ['без offset', b64({ revision, binding }), 400],
    ['строковый offset', b64({ revision, binding, offset: '1' }), 400],
    ['offset −1', b64({ revision, binding, offset: -1 }), 400],
    ['offset 1.5', b64({ revision, binding, offset: 1.5 }), 400],
    ['offset 2**53', b64({ revision, binding, offset: 2 ** 53 }), 400],
    ['offset 10000', b64({ revision, binding, offset: 10000 }), 400],
    ['offset = length', b64({ revision, binding, offset: n }), 'ok'],
    ['offset = length + 1', b64({ revision, binding, offset: n + 1 }), 400],
    ['offset 3', b64({ revision, binding, offset: 3 }), 'ok'],
    ['чужой binding', b64({ revision, binding: 'task_briefing:T-2', offset: 0 }), 409],
    ['устаревшая revision', b64({ revision: 'rev-0', binding, offset: 0 }), 409],
    ['устаревшая revision, плохой offset', b64({ revision: 'rev-0', binding, offset: 10000 }), 409],
    ['устаревшая revision, offset −1', b64({ revision: 'rev-0', binding, offset: -1 }), 400],
  ];
  // Стандартный base64 с `+`, `/` и `=`: ревизия подобрана так, что алфавиты различаются.
  const plusSlash = '>>>???';
  const std = b64({ revision: plusSlash, binding, offset: 2 }, 'base64');
  assert.match(std, /[+/=]/);
  cases.push(['стандартный base64 +/=', std, 'ok']);
  for (const [label, cursor, status] of cases) {
    const rev = label === 'стандартный base64 +/=' ? plusSlash : revision;
    const outcome = compareContext(
      items,
      { title: 'Задача' },
      rev,
      binding,
      { cursor: cursor as string, limit: 2 },
      label,
    );
    if (status === 'ok') assert.equal(outcome.ok, true, label);
    else assert.equal(outcome.ok ? 'ok' : outcome.status, status, label);
  }
});

test('H3-02: отказы json-base64url — коды и пути harness до mapping', () => {
  const opts = (cursor: string): PageOptions => ({ revision: 'r', binding: 'b', cursor, limit: 5 });
  const expectError = (cursor: string, code: string, path: (string | number)[]) =>
    assert.throws(
      () => pageItems(multilingual, {}, opts(cursor)),
      (e: unknown) =>
        e instanceof HarnessError &&
        e.code === code &&
        JSON.stringify(e.issues[0]?.path) === JSON.stringify(path),
      cursor,
    );
  expectError('мусор', 'INVALID_INPUT', ['cursor']);
  expectError(b64({ revision: 'r', binding: 'b', offset: 100 }), 'INVALID_INPUT', [
    'cursor',
    'offset',
  ]);
  expectError(b64({ revision: 'x', binding: 'b', offset: 100 }), 'REVISION_CONFLICT', ['cursor']);
  expectError(b64({ revision: 'r', binding: 'x', offset: 0 }), 'REVISION_CONFLICT', ['cursor']);
  assert.throws(() => pageItems(multilingual, {}, opts('мусор')), {
    message: 'Некорректный cursor',
  });
});

test('Q4: cursor digest-offset — ведущие нули, верхний регистр, \\d+ сверх safe, чужой digest', () => {
  const records = multilingual;
  const revision = legacy.digest(records);
  const n = records.length;
  const cases: [string, string | null, number | 'ok' | 'throw'][] = [
    ["''", '', 'ok'],
    ['null', null, 'ok'],
    ['мусор', 'мусор', 409],
    ['без offset', `${revision}:`, 409],
    ['offset −1', `${revision}:-1`, 409],
    ['offset 1.5', `${revision}:1.5`, 409],
    ['ведущие нули', `${revision}:0003`, 'ok'],
    ['ноль', `${revision}:000`, 'ok'],
    ['= length', `${revision}:${n}`, 'ok'],
    ['length + 1', `${revision}:${n + 1}`, 409],
    ['10000', `${revision}:10000`, 409],
    ['сверх safe', `${revision}:${'9'.repeat(20)}`, 409],
    ['2**53 + 1', `${revision}:9007199254740993`, 409],
    ['верхний регистр hex', `${revision.toUpperCase()}:0`, 409],
    ['чужой digest', `${'0'.repeat(64)}:0`, 409],
    ['чужой digest, плохой offset', `${'0'.repeat(64)}:${'9'.repeat(20)}`, 409],
    ['пробел', `${revision}:0 `, 409],
  ];
  for (const [label, cursor, status] of cases) {
    const outcome = compareObservability(records, { cursor: cursor as string, limit: 3 }, label);
    if (status === 'ok') assert.equal(outcome.ok, true, label);
    else assert.equal(outcome.ok ? 'ok' : outcome.status, status, label);
  }
  // До mapping: чужой/нечитаемый — REVISION_CONFLICT, offset — INVALID_INPUT ['cursor','offset'].
  const opts = (cursor: string): PageOptions => ({
    cursorFormat: 'digest-offset',
    revision,
    cursor,
    limit: 3,
  });
  for (const [cursor, code, path] of [
    ['мусор', 'REVISION_CONFLICT', ['cursor']],
    [`${'0'.repeat(64)}:0`, 'REVISION_CONFLICT', ['cursor']],
    [`${revision}:${'9'.repeat(20)}`, 'INVALID_INPUT', ['cursor', 'offset']],
    [`${revision}:${n + 1}`, 'INVALID_INPUT', ['cursor', 'offset']],
  ] as const)
    assert.throws(
      () => pageItems(records, {}, opts(cursor)),
      (e: unknown) =>
        e instanceof HarnessError &&
        e.code === code &&
        JSON.stringify(e.issues[0]?.path) === JSON.stringify(path),
      cursor,
    );
});

/* ------------------------------------------------------------------ */
/* Границы байт ±1 и пределы                                           */
/* ------------------------------------------------------------------ */

/** Строка с заданным числом UTF-8 байт: двухбайтовая кириллица и ASCII-добивка. */
const sized = (bytes: number, fill = 'я'): string => {
  const unit = Buffer.byteLength(fill);
  const count = Math.floor(bytes / unit);
  return fill.repeat(count) + 'a'.repeat(bytes - count * unit);
};

test('H3-02: граница context 63488 ±1 байт страницы (кириллица, эмодзи, ASCII)', () => {
  const budget = 64 * 1024 - 2048;
  assert.equal(budget, 63488);
  for (const fill of ['a', 'я', '😀', '中'])
    for (const delta of [-1, 0, 1]) {
      // Одна запись: `{"items":["…"]}` = 14 байт обвязки.
      const one: string[] = [sized(budget + delta - 14, fill)];
      assert.equal(jsonBytes({ items: one }), budget + delta);
      const outcome = compareContext(one, {}, 'r', 'b', { limit: 20 }, `${fill} one ${delta}`);
      assert.equal(outcome.ok ? 'ok' : outcome.status, delta > 0 ? 413 : 'ok');
      // Две записи: вторая доводит страницу ровно до предела ±1.
      const first = 'первая';
      const two: string[] = [
        first,
        sized(budget + delta - jsonBytes({ items: [first, ''] }), fill),
      ];
      assert.equal(jsonBytes({ items: two }), budget + delta);
      const page = compareContext(two, {}, 'r', 'b', { limit: 20 }, `${fill} two ${delta}`);
      assert.ok(page.ok);
      const parsed = JSON.parse(page.json) as { items: unknown[]; hasMore: boolean };
      assert.equal(parsed.items.length, delta > 0 ? 1 : 2);
      assert.equal(parsed.hasMore, delta > 0);
      // С заголовком: его байты входят в бюджет страницы.
      const header = { revision: 'из заголовка', items: 'заменяется', note: 'ж' };
      const headed: string[] = [
        sized(budget + delta - jsonBytes({ ...header, items: [''] }), fill),
      ];
      assert.equal(jsonBytes({ ...header, items: headed }), budget + delta);
      const h = compareContext(headed, header, 'r', 'b', { limit: 1 }, `${fill} header ${delta}`);
      assert.equal(h.ok ? 'ok' : h.status, delta > 0 ? 413 : 'ok');
    }
});

test('Q4: граница observability 48000 ±1 байт суммы записей', () => {
  for (const fill of ['a', 'я', '😀'])
    for (const delta of [-1, 0, 1]) {
      const one: string[] = [sized(48000 + delta - 2, fill)];
      assert.equal(jsonBytes(one[0]), 48000 + delta);
      const o = compareObservability(one, { limit: 20 }, `${fill} one ${delta}`);
      assert.equal(o.ok ? 'ok' : o.status, delta > 0 ? 413 : 'ok');
      const first = 'первая';
      const two: string[] = [first, sized(48000 + delta - jsonBytes(first) - 2, fill)];
      assert.equal(jsonBytes(two[0]) + jsonBytes(two[1]), 48000 + delta);
      const t = compareObservability(two, { limit: 20 }, `${fill} two ${delta}`);
      assert.ok(t.ok);
      assert.equal((JSON.parse(t.json) as ObservabilityDto).records.length, delta > 0 ? 1 : 2);
    }
});

test('H3-02: пределы 1/20/50 и одиночный oversized → RESPONSE_TOO_LARGE без усечения', () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ i, text: `строка ${i} 😀` }));
  for (const limit of [1, 20, 50]) {
    const outcome = compareContext(items, {}, 'r', 'b', { limit }, `limit ${limit}`);
    assert.ok(outcome.ok);
    assert.equal((JSON.parse(outcome.json) as { items: unknown[] }).items.length, limit);
    const o = compareObservability(items, { limit }, `obs limit ${limit}`);
    assert.ok(o.ok);
    assert.equal((JSON.parse(o.json) as ObservabilityDto).records.length, limit);
  }
  // Oversized на середине: первая страница отдаёт предшествующие, следующая — отказ.
  const big = 'ы'.repeat(40000);
  const withBig = ['a', 'b', big, 'c'];
  const first = compareContext(withBig, {}, 'r', 'b', { limit: 50 }, 'big first');
  assert.ok(first.ok);
  const cursor = (JSON.parse(first.json) as { nextCursor: string }).nextCursor;
  const second = compareContext(withBig, {}, 'r', 'b', { cursor, limit: 50 }, 'big second');
  assert.deepEqual(second, {
    ok: false,
    status: 413,
    message: 'Элемент контекста превышает лимит ответа',
  });
  assert.throws(
    () => pageItems(withBig, {}, { revision: 'r', binding: 'b', cursor, limit: 50 }),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'RESPONSE_TOO_LARGE' &&
      JSON.stringify(e.issues[0]?.path) === '["items",2]' &&
      e.message ===
        `Элемент 2 не помещается в предел ответа: ${jsonBytes({ items: [big] })} > 63488 байт`,
  );
  const obsBig = compareObservability([big], { limit: 5 }, 'obs big');
  assert.deepEqual(obsBig, { ok: false, status: 413, message: 'Запись превышает размер страницы' });
  assert.throws(
    () =>
      pageItems(
        [big],
        {},
        {
          cursorFormat: 'digest-offset',
          measure: 'items',
          revision: legacy.digest([big]),
          limit: 5,
          maxBytes: 48000,
          reserveBytes: 0,
        },
      ),
    {
      name: 'HarnessError',
      message: `Элемент 0 не помещается в предел ответа: ${jsonBytes(big)} > 48000 байт`,
    },
  );
});

/* ------------------------------------------------------------------ */
/* Сборка, повтор cursor, вход не мутируется                           */
/* ------------------------------------------------------------------ */

const walk = (items: readonly unknown[], options: PageOptions) => {
  const out: unknown[] = [];
  const cursors: (string | undefined)[] = [];
  let cursor: string | undefined;
  for (;;) {
    cursors.push(cursor);
    const page = pageItems(items, { kind: 'список' }, { ...options, cursor });
    assert.equal(page.total, items.length);
    assert.equal(page.hasMore, page.nextCursor !== null);
    out.push(...page.items);
    if (page.nextCursor === null) return { out, cursors };
    cursor = page.nextCursor;
  }
};

test('AC19: мультиязычные страницы обоих кодеков собираются без потерь и повторов', () => {
  const g = generator(777);
  const items = Object.freeze(
    Array.from({ length: 300 }, (_, i) => ({ i, text: g.text(i % 7 === 0 ? 4000 : 60) })),
  );
  const before = JSON.stringify(items);
  const revision = legacy.digest(items);
  for (const options of [
    { revision, binding: 'b', limit: 17 },
    { cursorFormat: 'json-base64url', revision, binding: 'b', limit: 50, measure: 'items' },
    { cursorFormat: 'digest-offset', revision, limit: 13 },
    {
      cursorFormat: 'digest-offset',
      revision,
      limit: 50,
      measure: 'items',
      maxBytes: 30000,
      reserveBytes: 0,
    },
  ] satisfies PageOptions[]) {
    const { out, cursors } = walk(items, options);
    assert.equal(JSON.stringify(out), before, JSON.stringify(options));
    assert.equal(new Set(out.map((x) => (x as { i: number }).i)).size, items.length);
    assert.ok(cursors.length > 2, 'страниц больше двух');
    // Повтор с тем же cursor — та же страница.
    for (const cursor of cursors)
      assert.equal(
        JSON.stringify(pageItems(items, {}, { ...options, cursor })),
        JSON.stringify(pageItems(items, {}, { ...options, cursor })),
      );
  }
  assert.equal(JSON.stringify(items), before, 'вход не мутирован');
});

test('H3-02: заголовок с ключами revision/items/total не перекрывает поля страницы и не мутируется', () => {
  const header = Object.freeze({
    revision: 'из заголовка',
    items: ['чужое'],
    total: 99,
    hasMore: 'да',
    nextCursor: 'x',
    title: 'Задача',
  });
  const items = Object.freeze(['a', 'б']);
  const page = pageItems(items, header, { revision: 'r', binding: 'b', limit: 1 });
  assert.deepEqual(Object.keys(page), [
    'revision',
    'items',
    'total',
    'hasMore',
    'nextCursor',
    'title',
  ]);
  assert.equal(page.revision, 'r');
  assert.deepEqual(page.items, ['a']);
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.title, 'Задача');
  compareContext([...items], { ...header }, 'r', 'b', { limit: 1 }, 'header keys');
  // Пустой список: страница без cursor.
  assert.deepEqual(pageItems([], {}, { revision: 'r', binding: 'b', limit: 1 }), {
    revision: 'r',
    items: [],
    total: 0,
    hasMore: false,
    nextCursor: null,
  });
  assert.equal(root.pageItems, pageItems);
});

/* ------------------------------------------------------------------ */
/* Ошибки опций                                                        */
/* ------------------------------------------------------------------ */

test("H3-02: ошибки опций → INVALID_INPUT ['options', ключ] раньше cursor", () => {
  const hex = 'a'.repeat(64);
  const cases: [Record<string, unknown>, string][] = [
    [{ limit: 0 }, 'limit'],
    [{ limit: -1 }, 'limit'],
    [{ limit: 1.5 }, 'limit'],
    [{ limit: Number.NaN }, 'limit'],
    [{ limit: 2 ** 53 }, 'limit'],
    [{ limit: '5' }, 'limit'],
    [{ limit: 0, maxBytes: 0 }, 'limit'],
    [{ maxBytes: 0 }, 'maxBytes'],
    [{ maxBytes: 1.5 }, 'maxBytes'],
    [{ maxBytes: Infinity }, 'maxBytes'],
    [{ maxBytes: 0, reserveBytes: -1 }, 'maxBytes'],
    [{ reserveBytes: -1 }, 'reserveBytes'],
    [{ reserveBytes: 1.5 }, 'reserveBytes'],
    [{ maxBytes: 100, reserveBytes: 100 }, 'reserveBytes'],
    [{ maxBytes: 1000 }, 'reserveBytes'],
    [{ cursorFormat: 'digest-offset', revision: 'r', binding: undefined }, 'revision'],
    [
      { cursorFormat: 'digest-offset', revision: hex.toUpperCase(), binding: undefined },
      'revision',
    ],
    [{ cursorFormat: 'digest-offset', revision: hex + 'a', binding: undefined }, 'revision'],
  ];
  for (const [patch, key] of cases)
    assert.throws(
      () =>
        pageItems(
          ['a'],
          {},
          {
            revision: 'r',
            binding: 'b',
            limit: 5,
            cursor: 'мусор',
            ...patch,
          },
        ),
      (e: unknown) =>
        e instanceof HarnessError &&
        e.code === 'INVALID_INPUT' &&
        JSON.stringify(e.issues[0]?.path) === JSON.stringify(['options', key]),
      JSON.stringify(patch),
    );
  // Допустимые пределы: reserveBytes = maxBytes − 1 проходит опции; дальше — бюджет страницы.
  assert.throws(
    () =>
      pageItems(
        ['a'],
        {},
        { revision: 'r', binding: 'b', limit: 1, maxBytes: 100, reserveBytes: 99 },
      ),
    { name: 'HarnessError', message: 'Элемент 0 не помещается в предел ответа: 15 > 1 байт' },
  );
  assert.doesNotThrow(() =>
    pageItems(
      ['a'],
      {},
      { cursorFormat: 'digest-offset', revision: hex, limit: 1, reserveBytes: 0 },
    ),
  );
});
