/**
 * H3: DevContour-подобный хост каталога, байтовых границ и pager-ов на
 * установленном пакете. Каждая проверка сравнивает ответ хоста на общих
 * операциях с legacy-оракулом DevContour (`devcontour-legacy.mjs`) и со
 * снимками `expected/*`. Отчёт — JSON на stdout; exit 1 при любом расхождении.
 * Процессов не запускает: HTTP — два локальных сервера `node:http` в этом же
 * процессе.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { z } from 'zod';
import * as root from 'devcontour-harness';
import * as contracts from 'devcontour-harness/contracts';
import * as projections from 'devcontour-harness/projections';
import * as legacy from './devcontour-legacy.mjs';
import * as inputs from './devcontour-inputs.mjs';

const checks = [];
const norm = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const check = (name, actual, expected) =>
  checks.push({
    name,
    ok: JSON.stringify(norm(actual)) === JSON.stringify(norm(expected)),
    actual: norm(actual),
    expected: norm(expected),
  });
const expectedText = (name) =>
  readFileSync(new URL('../expected/' + name, import.meta.url), 'utf8');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Детерминированный PRNG (mulberry32): корпус одинаков в каждом прогоне. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const alphabet = ['a', 'Z', '7', ' ', 'ж', 'Ё', '€', '中', '😀', '\ud800', '"', '\\', '\n'];
const text = (rnd, max) =>
  Array.from(
    { length: Math.floor(rnd() * max) },
    () => alphabet[Math.floor(rnd() * alphabet.length)],
  ).join('');

/* ------------------------------------------------------------------ */
/* Host mapping §1.4: отказ harness → {status, message} DevContour      */
/* ------------------------------------------------------------------ */

const pathOf = (e) => JSON.stringify(e.issues?.[0]?.path ?? []);
const contextMapping = (e) => {
  if (e.code === 'INVALID_INPUT' && pathOf(e) === '["cursor"]')
    return new legacy.DomainError('Некорректный cursor', 400);
  if (e.code === 'INVALID_INPUT' && pathOf(e) === '["cursor","offset"]')
    return new legacy.DomainError('Некорректный cursor offset', 400);
  if (e.code === 'REVISION_CONFLICT')
    return new legacy.DomainError(
      'Контекст изменился или cursor принадлежит другому запросу. Начните с первой страницы.',
    );
  if (e.code === 'RESPONSE_TOO_LARGE')
    return new legacy.DomainError('Элемент контекста превышает лимит ответа', 413);
  return e;
};
const observabilityMapping = (e) => {
  if (e.code === 'INVALID_INPUT' && pathOf(e) === '["cursor","offset"]')
    return new legacy.DomainError('Некорректный cursor');
  if (e.code === 'REVISION_CONFLICT')
    return new legacy.DomainError('Отчёт изменился; начните чтение заново');
  if (e.code === 'RESPONSE_TOO_LARGE')
    return new legacy.DomainError('Запись превышает размер страницы', 413);
  return e;
};
const mapped = (fn, mapping) => {
  try {
    return fn();
  } catch (e) {
    throw e instanceof contracts.HarnessError ? mapping(e) : e;
  }
};
/** Исход вызова: JSON ответа либо `{status, message}` отказа. */
const outcome = (fn) => {
  try {
    return { ok: true, json: JSON.stringify(fn()) };
  } catch (e) {
    return e instanceof legacy.DomainError
      ? { ok: false, status: e.status, message: e.message }
      : { ok: false, status: 'throw', message: `${e?.constructor?.name}: ${e?.code ?? ''}` };
  }
};

// Хост DevContour на общих операциях (host mapping §1.4).
const sharedContextPage = (items, header, revision, binding, input) =>
  mapped(
    () =>
      root.pageItems(items, header, {
        revision,
        binding,
        cursor: input.cursor,
        limit: input.limit,
      }),
    contextMapping,
  );
const sharedObservabilityPage = (records, input) =>
  mapped(() => {
    const p = root.pageItems(
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
  }, observabilityMapping);
const guard = (limit, message) => (value) => {
  if (!root.checkJsonBytes(value, limit).within) throw new legacy.DomainError(message, 413);
  return value;
};
const sharedGuards = {
  agentBounded: guard(65536, 'Ответ превышает 64 KiB; сузьте запрос или используйте CLI-отчёт'),
  agentRequestGuard: guard(100000, 'Запрос превышает 100000 байт'),
  contextResultGuard: guard(65536, 'Ответ превышает 64 KiB; сузьте контекст'),
  preparationRequestGuard: guard(100000, 'Слишком большой запрос'),
  preparationResultGuard: guard(65536, 'Ответ превышает 64 KiB'),
  httpBodyGuard: (body) => {
    if (root.utf8Bytes(body) > 100_000) throw new legacy.DomainError('Слишком большой запрос', 413);
    return body;
  },
};
const hostCapabilities = (src = inputs) =>
  root.operationCatalog({
    name: src.pkg.name,
    version: src.pkg.version,
    protocolVersion: 1,
    maxInputBytes: 100000,
    maxResultBytes: 65536,
    operations: Object.fromEntries(
      src.agentOperations.map((n) => [
        n,
        { description: src.descriptions[n], readOnly: src.readOnly(n), input: src.agentInputs[n] },
      ]),
    ),
  });

/* ------------------------------------------------------------------ */
/* Одна копия zod и одна реализация                                     */
/* ------------------------------------------------------------------ */

const require = createRequire(import.meta.url);
const harnessRequire = createRequire(require.resolve('devcontour-harness'));
check(
  'zod: one copy for host and package',
  require.resolve('zod') === harnessRequire.resolve('zod'),
  true,
);
check(
  'identity: root === ./projections clip, catalog exports',
  [
    ...['CLIP_SHORT', 'CLIP_DIAGNOSTIC', 'clipText', 'clipDeep']
      .filter((k) => root[k] === undefined || root[k] !== projections[k])
      .map((k) => 'projections.' + k),
    ...[
      'operationCatalogSchema',
      'catalogToolSchema',
      'HarnessError',
      'cliCommands',
      'cliDataSchemas',
    ]
      .filter((k) => root[k] === undefined || root[k] !== contracts[k])
      .map((k) => 'contracts.' + k),
    ...[
      'utf8Bytes',
      'jsonBytes',
      'checkJsonBytes',
      'pageItems',
      'operationCatalog',
      'harnessCapabilities',
      'cliInputSchema',
      'isSharedOperation',
      'resolveProfile',
    ].filter((k) => typeof root[k] !== 'function'),
    ...['sharedOperations', 'sharedOperationNames', 'cliTransportLimits']
      .filter((k) => typeof root[k] !== 'object')
      .map((k) => 'object.' + k),
    ...(root.CATALOG_PROTOCOL_VERSION === 1 ? [] : ['CATALOG_PROTOCOL_VERSION']),
  ],
  [],
);

/* ------------------------------------------------------------------ */
/* M04: clip = legacy (bounded.ts:13–26)                               */
/* ------------------------------------------------------------------ */

{
  const rnd = prng(4);
  const strings = [
    undefined,
    '',
    'a'.repeat(300),
    'a'.repeat(301),
    'ж'.repeat(2000),
    'ж'.repeat(2001),
    '😀'.repeat(150) + 'x',
    'a'.repeat(299) + '😀',
    '\ud800'.repeat(301),
    ...Array.from({ length: 200 }, () => text(rnd, 2600)),
  ];
  const limits = [undefined, 1, 300, 2000, Infinity];
  const shortDiff = [];
  for (const s of strings)
    for (const n of limits)
      if (projections.clipText(s, n) !== legacy.short(s, n)) shortDiff.push([s?.length, n]);
  const values = [
    null,
    0,
    false,
    true,
    12.5,
    'x'.repeat(2001),
    ['y'.repeat(2500), { token: 't', a: [{ token: 'deep', b: 'z'.repeat(3000) }] }],
    { token: 'secret', nested: { level: { token: 'x', keep: 'ж'.repeat(2100), n: 1, f: null } } },
    ...Array.from({ length: 50 }, () => ({
      a: text(rnd, 2500),
      b: [text(rnd, 400), { token: text(rnd, 10), c: text(rnd, 2500), d: rnd() }],
      e: rnd() > 0.5,
    })),
  ];
  const clipDiff = [];
  for (const [i, v] of values.entries())
    for (const n of limits)
      if (JSON.stringify(projections.clipDeep(v, n)) !== JSON.stringify(legacy.clip(v, n)))
        clipDiff.push([i, n]);
  check(
    'M04 short/clip = legacy',
    { shortDiff, clipDiff, cases: strings.length * limits.length },
    {
      shortDiff: [],
      clipDiff: [],
      cases: strings.length * limits.length,
    },
  );
  // H3-02: clip ограничивает строки, а не размер объекта.
  const big = projections.clipDeep(Array.from({ length: 100 }, () => 'q'.repeat(2001)));
  check('H3-02 clip does not bound object size', root.jsonBytes(big) > 65536, true);
}

/* ------------------------------------------------------------------ */
/* M05: байтовые проверки = legacy                                      */
/* ------------------------------------------------------------------ */

{
  const diff = [];
  let refused = 0;
  let passed = 0;
  const chars = ['a', 'ж', '€', '😀', '\ud800', '"'];
  for (const [name, limit] of [
    ['agentBounded', 65536],
    ['agentRequestGuard', 100000],
    ['contextResultGuard', 65536],
    ['preparationRequestGuard', 100000],
    ['preparationResultGuard', 65536],
  ])
    for (const c of chars) {
      const m = Math.floor((limit - 64) / Buffer.byteLength(JSON.stringify(c)));
      const base = Buffer.byteLength(JSON.stringify({ q: c.repeat(m) }));
      for (let d = -3; d <= 3; d++) {
        const pad = limit - base + d;
        const value = { q: c.repeat(m) + 'a'.repeat(pad) };
        const a = outcome(() => sharedGuards[name](value));
        const b = outcome(() => legacy[name](value));
        if (JSON.stringify(a) !== JSON.stringify(b)) diff.push([name, c, d]);
        if (a.ok) passed++;
        else refused++;
      }
    }
  for (const c of chars) {
    const m = Math.floor(99000 / Buffer.byteLength(c));
    const base = Buffer.byteLength(c.repeat(m));
    for (let d = -3; d <= 3; d++) {
      const body = c.repeat(m) + 'a'.repeat(100_000 - base + d);
      const a = outcome(() => sharedGuards.httpBodyGuard(body));
      const b = outcome(() => legacy.httpBodyGuard(body));
      if (JSON.stringify(a) !== JSON.stringify(b)) diff.push(['httpBodyGuard', c, d]);
      if (a.ok) passed++;
      else refused++;
    }
  }
  // BigInt: JSON.stringify бросает и в legacy, и в общей мере.
  const bigint = { n: 1n };
  const a = outcome(() => sharedGuards.agentBounded(bigint));
  const b = outcome(() => legacy.agentBounded(bigint));
  if (JSON.stringify(a) !== JSON.stringify(b)) diff.push(['bigint', a, b]);
  check(
    'M05 byte guards = legacy',
    { diff, refused: refused > 0, passed: passed > 0 },
    { diff: [], refused: true, passed: true },
  );
}

/* ------------------------------------------------------------------ */
/* M05: context pager = legacy                                          */
/* ------------------------------------------------------------------ */

const contextRevision = 'r'.repeat(64);
const contextBinding = 'b1';
const contextItems = (rnd, n, big) =>
  Array.from({ length: n }, (_, i) => ({ id: i, path: text(rnd, 40), body: text(rnd, big) }));
const contextHeaders = [
  {},
  { kind: 'files', count: 3 },
  { revision: 'old', items: ['x'], total: -1 },
];

const readAll = (pageOf, initial) => {
  const pages = [];
  let cursor;
  for (let guardN = 0; guardN < 10000; guardN++) {
    const page = pageOf(cursor);
    pages.push(page);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { pages, initial };
};

{
  const rnd = prng(5);
  let cases = 0;
  const diff = [];
  for (let k = 0; k < 120; k++) {
    const big = [50, 2000, 20000, 63000][k % 4];
    const items = contextItems(rnd, 1 + Math.floor(rnd() * 40), big);
    const header = contextHeaders[k % contextHeaders.length];
    const limit = [1, 20, 50][k % 3];
    let cursor;
    for (let step = 0; step < 100; step++) {
      const input = { cursor, limit };
      const a = outcome(() =>
        sharedContextPage(items, header, contextRevision, contextBinding, input),
      );
      const b = outcome(() =>
        legacy.contextPage(items, header, contextRevision, contextBinding, input),
      );
      cases++;
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        diff.push([k, step]);
        break;
      }
      if (!a.ok) break;
      cursor = JSON.parse(a.json).nextCursor;
      if (!cursor) break;
    }
  }
  // Граница 63488 (65536 − 2048) ±1 байт для одного элемента.
  for (let d = -2; d <= 2; d++) {
    const header = { kind: 'edge' };
    const empty = Buffer.byteLength(JSON.stringify({ ...header, items: [{ s: '' }] }));
    const items = [{ s: 'a'.repeat(63488 - empty + d) }, { s: 'b' }];
    const input = { limit: 20 };
    const a = outcome(() =>
      sharedContextPage(items, header, contextRevision, contextBinding, input),
    );
    const b = outcome(() =>
      legacy.contextPage(items, header, contextRevision, contextBinding, input),
    );
    cases++;
    if (JSON.stringify(a) !== JSON.stringify(b)) diff.push(['edge', d]);
  }
  check('M05 context page = legacy', { diff, many: cases >= 500 }, { diff: [], many: true });
}

{
  const items = [{ a: 1 }, { a: 2 }, { a: 3 }];
  const cursorOf = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const cases = [
    cursorOf({ revision: contextRevision, binding: contextBinding }) /* нечитаемый → 400 */,
    cursorOf({ revision: contextRevision, binding: contextBinding, offset: 10000 }) /* 400 */,
    cursorOf({ revision: contextRevision, binding: 'other', offset: 1 }) /* 409 */,
    cursorOf({ revision: 's'.repeat(64), binding: contextBinding, offset: 10000 }) /* 409 */,
  ].map((cursor) => [items, { cursor, limit: 20 }]);
  cases.push([[{ s: 'x'.repeat(70000) }], { limit: 20 }]); /* 413 */
  const shared = cases.map(([it, input]) =>
    outcome(() => sharedContextPage(it, {}, contextRevision, contextBinding, input)),
  );
  const old = cases.map(([it, input]) =>
    outcome(() => legacy.contextPage(it, {}, contextRevision, contextBinding, input)),
  );
  check(
    'M05 context page errors 400/400/409/409/413',
    { shared, statuses: shared.map((o) => o.status) },
    { shared: old, statuses: [400, 400, 409, 409, 413] },
  );
}

/* ------------------------------------------------------------------ */
/* Q4: observability pager = legacy                                     */
/* ------------------------------------------------------------------ */

const records = (rnd, n, big) =>
  Array.from({ length: n }, (_, i) => ({ at: i, model: text(rnd, 20), note: text(rnd, big) }));
{
  const rnd = prng(6);
  const diff = [];
  let cases = 0;
  for (let k = 0; k < 120; k++) {
    const recs = records(rnd, 1 + Math.floor(rnd() * 40), [50, 3000, 20000, 47000][k % 4]);
    const limit = [1, 20, 50][k % 3];
    let cursor;
    for (let step = 0; step < 100; step++) {
      const input = { cursor, limit };
      const a = outcome(() => sharedObservabilityPage(recs, input));
      const b = outcome(() => legacy.observabilityPage(recs, input));
      cases++;
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        diff.push([k, step]);
        break;
      }
      if (!a.ok) break;
      cursor = JSON.parse(a.json).nextCursor;
      if (!cursor) break;
    }
  }
  // Граница 48000 ±1 байт суммы записей.
  for (let d = -2; d <= 2; d++) {
    const empty = Buffer.byteLength(JSON.stringify({ s: '' }));
    const recs = [{ s: 'a'.repeat(48000 - empty + d) }, { s: 'b' }];
    const a = outcome(() => sharedObservabilityPage(recs, { limit: 20 }));
    const b = outcome(() => legacy.observabilityPage(recs, { limit: 20 }));
    cases++;
    if (JSON.stringify(a) !== JSON.stringify(b)) diff.push(['edge', d]);
  }
  check('Q4 observability page = legacy', { diff, many: cases >= 500 }, { diff: [], many: true });
}
{
  const recs = [{ a: 1 }, { a: 2 }];
  const revision = legacy.digest(recs);
  const cases = [
    [recs, { cursor: 'f'.repeat(64) + ':1', limit: 20 }] /* чужой digest → 409 */,
    [recs, { cursor: revision + ':3', limit: 20 }] /* offset > length → 409 */,
    [[{ s: 'x'.repeat(48001) }], { limit: 20 }] /* 413 */,
  ];
  const shared = cases.map(([r, input]) => outcome(() => sharedObservabilityPage(r, input)));
  const old = cases.map(([r, input]) => outcome(() => legacy.observabilityPage(r, input)));
  check(
    'Q4 observability errors 409/409/413',
    { shared, statuses: shared.map((o) => o.status) },
    { shared: old, statuses: [409, 409, 413] },
  );
}

/* ------------------------------------------------------------------ */
/* AC19: страницы собираются без потерь и повторов                      */
/* ------------------------------------------------------------------ */

{
  const rnd = prng(19);
  const problems = [];
  for (let k = 0; k < 30; k++) {
    const items = contextItems(rnd, 5 + Math.floor(rnd() * 60), [500, 3000, 9000][k % 3]);
    const limit = [1, 20, 50][k % 3];
    const ctx = readAll((cursor) =>
      sharedContextPage(items, { kind: 'k' }, contextRevision, contextBinding, { cursor, limit }),
    ).pages;
    if (JSON.stringify(ctx.flatMap((p) => p.items)) !== JSON.stringify(items))
      problems.push(['context', k]);
    if (ctx.some((p) => p.total !== items.length)) problems.push(['context total', k]);
    // Повтор с тем же cursor — та же страница.
    const second = ctx[1]?.nextCursor ?? ctx[0].nextCursor;
    if (
      second &&
      JSON.stringify(
        sharedContextPage(items, { kind: 'k' }, contextRevision, contextBinding, {
          cursor: second,
          limit,
        }),
      ) !==
        JSON.stringify(
          sharedContextPage(items, { kind: 'k' }, contextRevision, contextBinding, {
            cursor: second,
            limit,
          }),
        )
    )
      problems.push(['context repeat', k]);
    const recs = records(rnd, 5 + Math.floor(rnd() * 60), [500, 3000, 7000][k % 3]);
    const obs = readAll((cursor) => sharedObservabilityPage(recs, { cursor, limit })).pages;
    if (JSON.stringify(obs.flatMap((p) => p.records)) !== JSON.stringify(recs))
      problems.push(['observability', k]);
    if (k % 3 === 2 && (ctx.length < 2 || obs.length < 2)) problems.push(['one page only', k]);
  }
  check('AC19 pages reassemble without loss', problems, []);
}

/* ------------------------------------------------------------------ */
/* AC18: каталог DevContour на общем построителе                        */
/* ------------------------------------------------------------------ */

const snapshotText = expectedText('devcontour-capabilities.json');
const snapshot = JSON.parse(snapshotText);
const host = hostCapabilities();
{
  const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
  const corpus = {
    pkg: { name: 'host', version: '1.0.0' },
    agentOperations: [
      'empty',
      'strict_regex',
      'defaults',
      'enums',
      'union',
      'record',
      'nullable',
      'described',
      'nested',
    ],
    descriptions: Object.fromEntries(
      [
        'empty',
        'strict_regex',
        'defaults',
        'enums',
        'union',
        'record',
        'nullable',
        'described',
        'nested',
      ].map((n) => [n, 'Описание ' + n + ' 😀']),
    ),
    readOnly: (n) => n.length % 2 === 0,
    agentInputs: {
      empty: z.strictObject({}),
      strict_regex: z.strictObject({ id, key: z.string().regex(/^[a-f0-9]{64}$/) }),
      defaults: z.strictObject({
        limit: z.number().int().min(1).max(50).default(20),
        description: z.string().max(5000).default(''),
      }),
      enums: z.strictObject({ policy: z.enum(['fifo-ready-v1', 'fewest-attempts-v1']) }),
      union: z.strictObject({
        value: z.union([z.string().min(1), z.number().int(), z.literal(false)]),
      }),
      record: z.strictObject({ groups: z.record(id, z.array(z.string()).min(1).max(100)) }),
      nullable: z.strictObject({ expected: z.string().max(65536).nullable().optional() }),
      described: z.strictObject({ reason: z.string().trim().min(10).describe('Почему') }),
      nested: inputs.agentInputs.plan_import,
    },
  };
  check(
    'AC18 catalog = legacy builder',
    [
      JSON.stringify(hostCapabilities(corpus)) ===
        JSON.stringify(legacy.legacyCapabilities(corpus)),
      JSON.stringify(host) === JSON.stringify(legacy.legacyCapabilities(inputs)),
    ],
    [true, true],
  );
}
{
  const byName = new Map(snapshot.tools.map((t) => [t.name, t]));
  const differ = host.tools
    .filter((t) => {
      const s = byName.get(t.name);
      return (
        !s ||
        JSON.stringify(Object.keys(t)) !== JSON.stringify(Object.keys(s)) ||
        JSON.stringify(t) !== JSON.stringify(s)
      );
    })
    .map((t) => t.name);
  check(
    'AC18 snapshot tools bytes (21)',
    {
      tools: host.tools.length,
      differ,
      keys: Object.keys(host),
      order: host.tools.map((t) => t.name),
    },
    {
      tools: 21,
      differ: [],
      keys: Object.keys(snapshot),
      order: snapshot.tools.map((t) => t.name).filter((n) => inputs.agentOperations.includes(n)),
    },
  );
}
{
  const subset = {
    ...snapshot,
    tools: snapshot.tools.filter((t) => inputs.agentOperations.includes(t.name)),
  };
  check(
    'AC18 catalogDigest subset = legacy',
    {
      roundtrip: JSON.stringify(snapshot) === snapshotText,
      snapshotDigest: legacy.digest(snapshot),
      subset: legacy.digest(host) === legacy.digest(subset),
    },
    {
      roundtrip: true,
      snapshotDigest: '862305bac2a606004d67a709234f7bbcd08c666e8bcd1b243a0d75e303770f1e',
      subset: true,
    },
  );
}
{
  // http.ts:286–304: GET /api/capabilities → json(res, 200, capabilities()).
  const serve = (capabilities) =>
    new Promise((resolve) => {
      const server = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/api/capabilities')
          return legacy.json(res, 200, capabilities());
        legacy.json(res, 404, { error: 'not found' });
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  const fetchBody = async (server) => {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/capabilities`);
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: await response.text(),
    };
  };
  const legacyServer = await serve(() => legacy.legacyCapabilities(inputs));
  const sharedServer = await serve(() => hostCapabilities());
  try {
    const [a, b] = [await fetchBody(sharedServer), await fetchBody(legacyServer)];
    check(
      'AC18 /api/capabilities body = legacy (HTTP)',
      { ...a, digest: sha256(a.body) },
      { ...b, digest: legacy.digest(JSON.parse(b.body)) },
    );
  } finally {
    legacyServer.close();
    sharedServer.close();
  }
}

/* ------------------------------------------------------------------ */
/* H3-01: каталоги хоста и harness раздельны                            */
/* ------------------------------------------------------------------ */

{
  const harness = root.harnessCapabilities();
  const hostNames = new Set(snapshot.tools.map((t) => t.name));
  const harnessNames = harness.tools.map((t) => t.name);
  check(
    'H3-01 host and harness catalogs separate',
    {
      harnessNames,
      overlap: [
        ...harnessNames.filter((n) => hostNames.has(n)),
        ...host.tools.map((t) => t.name).filter((n) => harnessNames.includes(n)),
      ],
      names: [host.name, harness.name],
      version: harness.version,
      limits: [harness.maxInputBytes, harness.maxResultBytes],
      schema: contracts.operationCatalogSchema.safeParse(harness).success,
      within: root.checkJsonBytes(harness, harness.maxResultBytes).within,
      readOnly: harness.tools.map((t) => t.readOnly === !contracts.cliCommands[t.name].writes),
      api: harnessNames.map((n) => typeof root[root.sharedOperations[n].api]),
    },
    {
      harnessNames: [...root.sharedOperationNames],
      overlap: [],
      names: ['devcontour', 'devcontour-harness'],
      version: root.HARNESS_VERSION,
      limits: [100000, 1048576],
      schema: true,
      within: true,
      readOnly: harnessNames.map(() => true),
      api: harnessNames.map(() => 'function'),
    },
  );
}

/* ------------------------------------------------------------------ */
/* Q5: leafContent и digest профиля хоста                               */
/* ------------------------------------------------------------------ */

{
  const shas = JSON.parse(expectedText('devcontour-builtin-profiles.json'));
  const problems = [];
  for (const [id, sha] of Object.entries(shas)) {
    const p = root.resolveProfile(id, { includeLeafContent: true });
    const bytes = readFileSync(join(root.builtinProfilesRoot, id + '.json'));
    if (sha256(p.leafContent) !== sha) problems.push([id, 'sha']);
    if (!Buffer.from(p.leafContent, 'utf8').equals(bytes)) problems.push([id, 'bytes']);
  }
  for (const id of root.builtinProfiles()) {
    const plain = root.resolveProfile(id);
    const p = root.resolveProfile(id, { includeLeafContent: true });
    const { leafContent, ...rest } = p;
    if ('leafContent' in plain) problems.push([id, 'leaf without option']);
    if (JSON.stringify(rest) !== JSON.stringify(plain)) problems.push([id, 'fields']);
    // Формула §1.4 = packs.ts:151 DevContour.
    const hostDigest =
      p.closure.length === 1 && !p.source ? sha256(leafContent) : sha256(JSON.stringify(p.closure));
    if (hostDigest !== p.digest) problems.push([id, 'digest']);
  }
  check(
    'Q5 leafContent and digest',
    { problems, nine: Object.keys(shas).length },
    { problems: [], nine: 9 },
  );
}

/* ------------------------------------------------------------------ */
/* Q5: профиль в форме хоста (layerSchema)                              */
/* ------------------------------------------------------------------ */

{
  // Форма роли DevContour: runtime demo, reviewVendor, нестрогий объект.
  const binding = z.object({
    runtime: z.enum(['codex', 'claude', 'demo']),
    model: z.string().optional(),
  });
  const layerSchema = z.strictObject({
    id: z.string(),
    version: z.string(),
    extends: z.array(z.string()).default([]),
    capabilities: z.array(z.string()).default([]),
    gates: z
      .array(
        z.object({
          id: z.string(),
          kind: z.enum(['check', 'test']),
          command: z.array(z.string()),
          dependsOn: z.array(z.string()).optional(),
          report: z.object({ type: z.literal('junit'), path: z.string() }).optional(),
        }),
      )
      .default([]),
    prepare: z.array(z.object({ id: z.string(), command: z.array(z.string()) })).default([]),
    protectedPaths: z.array(z.string()).default([]),
    generatedPaths: z.array(z.string()).default([]),
    roles: z
      .record(
        z.string(),
        binding.extend({
          reviewer: binding.optional(),
          reviewVendor: z.enum(['different-vendor', 'same-vendor-allowed']).optional(),
        }),
      )
      .default({}),
    contextPacks: z
      .array(
        z.object({ id: z.string(), files: z.array(z.string()), revision: z.string().optional() }),
      )
      .default([]),
  });
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-h3-profile-')));
  mkdirSync(join(repo, 'p'));
  const text = JSON.stringify({
    id: 'host',
    version: '1.0.0',
    gates: [
      { id: 'tests', kind: 'test', command: ['true'], report: { type: 'junit', path: 't.xml' } },
    ],
    prepare: [{ id: 's'.repeat(100), command: ['true'] }],
    roles: { mobile: { runtime: 'demo', reviewVendor: 'same-vendor-allowed', extra: 1 } },
    contextPacks: [{ id: 'rn', files: ['rn.md'], revision: 'a'.repeat(40) }],
  });
  writeFileSync(join(repo, 'p/host.json'), text);
  const refusalOf = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e.code;
    }
  };
  const p = root.resolveProfile('./p/host.json', {
    repository: repo,
    layerSchema,
    includeLeafContent: true,
  });
  check(
    'Q5 host layerSchema',
    {
      strict: refusalOf(() => root.resolveProfile('./p/host.json', { repository: repo })),
      roles: p.roles,
      contextPacks: p.contextPacks,
      step: p.prepare[0].id.length,
      leaf: p.leafContent === text,
      digest: p.digest === sha256(JSON.stringify(p.closure)),
      badSchema: refusalOf(() => root.resolveProfile('node-checks', { layerSchema: null })),
    },
    {
      strict: 'INVALID_INPUT',
      roles: { mobile: { runtime: 'demo', reviewVendor: 'same-vendor-allowed' } },
      contextPacks: [{ id: 'rn', files: ['rn.md'], revision: 'a'.repeat(40) }],
      step: 100,
      leaf: true,
      digest: true,
      badSchema: 'INVALID_INPUT',
    },
  );
}

/* ------------------------------------------------------------------ */
/* K12: outputSchema только при output                                  */
/* ------------------------------------------------------------------ */

{
  const input = z.strictObject({ a: z.string() });
  const output = z.strictObject({ ok: z.boolean() });
  const built = root.operationCatalog({
    name: 'n',
    version: 'v',
    protocolVersion: 1,
    maxInputBytes: 1,
    maxResultBytes: 1,
    operations: {
      with: { description: 'd', readOnly: true, input, output },
      without: { description: 'd', readOnly: true, input },
    },
  });
  let refusal;
  try {
    root.operationCatalog({
      ...built,
      operations: { 1: { description: 'd', readOnly: true, input } },
    });
  } catch (e) {
    refusal = { code: e.code, path: e.issues?.[0]?.path };
  }
  check(
    'outputSchema absent without output',
    {
      host: host.tools.filter((t) => 'outputSchema' in t).map((t) => t.name),
      snapshot: snapshot.tools.filter((t) => 'outputSchema' in t).map((t) => t.name),
      built: built.tools.map((t) => 'outputSchema' in t),
      harness: root.harnessCapabilities().tools.every((t) => typeof t.outputSchema === 'object'),
      refusal,
    },
    {
      host: [],
      snapshot: [],
      built: [true, false],
      harness: true,
      refusal: { code: 'INVALID_INPUT', path: ['operations', '1'] },
    },
  );
}

const failed = checks.filter((c) => !c.ok);
process.stdout.write(
  JSON.stringify({
    ok: !failed.length,
    total: checks.length,
    failed,
    checks: checks.map(({ name, ok }) => ({ name, ok })),
  }) + '\n',
);
process.exit(failed.length ? 1 : 0);
