// WP-CATALOG (H3-01, H3-02, AC18, AC19): `operationCatalog` против legacy-
// построителя `capabilities` DevContour (agent.ts:273–288), байтовое равенство
// 21 записи настоящего снимка, байтовая граница против legacy-проверок и
// `clipDeep` против `clip` (bounded.ts). Оракул и входы — дословные копии
// DevContour 6a59728 в tests/fixtures/consumer-h3/src. Снимок снят командой
// из tests/fixtures/catalog/README.md:
//   node --import tsx -e "import('./src/application/agent.ts').then(m=>process.stdout.write(JSON.stringify(m.capabilities())))"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  HarnessError,
  operationCatalogSchema,
  planDraft,
  planDraftSchema,
  type OperationCatalog,
} from '../src/contracts/index.ts';
import {
  checkJsonBytes,
  harnessCapabilities,
  jsonBytes,
  operationCatalog,
  sharedOperationNames,
  sharedOperations,
  utf8Bytes,
  type CatalogOperation,
} from '../src/catalog/index.ts';
import { CLIP_DIAGNOSTIC, CLIP_SHORT, clipDeep, clipText } from '../src/projections/index.ts';
import * as root from '../src/index.ts';

interface DomainErrorLike extends Error {
  status: number;
}
interface LegacyCatalogInput {
  pkg: { name: string; version: string };
  agentOperations: readonly string[];
  descriptions: Readonly<Record<string, string>>;
  readOnly: (name: string) => boolean;
  agentInputs: Readonly<Record<string, z.ZodType>>;
}
type Guard = (value: unknown) => unknown;
interface Legacy {
  DomainError: new (message: string, status?: number) => DomainErrorLike;
  digest: (value: unknown) => string;
  SHORT: number;
  DIAGNOSTIC: number;
  short: (text: string | undefined, n?: number) => string | undefined;
  clip: <T>(value: T, n?: number) => T;
  legacyCapabilities: (input: LegacyCatalogInput) => unknown;
  agentBounded: Guard;
  agentRequestGuard: Guard;
  contextResultGuard: Guard;
  preparationRequestGuard: Guard;
  preparationResultGuard: Guard;
  httpBodyGuard: (text: string) => string;
}
type Inputs = LegacyCatalogInput;

const fixture = (path: string) => new URL(`./fixtures/${path}`, import.meta.url);
const legacy = (await import(fixture('consumer-h3/src/devcontour-legacy.mjs').href)) as Legacy;
const inputs = (await import(fixture('consumer-h3/src/devcontour-inputs.mjs').href)) as Inputs;
const snapshotText = readFileSync(fixture('catalog/devcontour-capabilities.json'), 'utf8');
const snapshot = JSON.parse(snapshotText) as OperationCatalog;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Host mapping §1.4: каталог DevContour на общем построителе. */
const hostCatalog = (input: Inputs) =>
  operationCatalog({
    name: input.pkg.name,
    version: input.pkg.version,
    protocolVersion: 1,
    maxInputBytes: 100000,
    maxResultBytes: 65536,
    operations: Object.fromEntries(
      input.agentOperations.map((n) => [
        n,
        {
          description: input.descriptions[n] as string,
          readOnly: input.readOnly(n),
          input: input.agentInputs[n] as z.ZodType,
        },
      ]),
    ),
  });

/* ------------------------------------------------------------------ */
/* AC18: построитель = legacy                                          */
/* ------------------------------------------------------------------ */

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const schemaCorpus: Record<string, z.ZodType> = {
  empty_strict: z.strictObject({}),
  strict_regex: z.strictObject({ id, key: z.string().regex(/^[a-f0-9]{64}$/) }),
  loose_object: z.object({ a: z.string() }),
  passthrough: z.looseObject({ a: z.number() }),
  defaults: z.strictObject({
    limit: z.number().int().min(1).max(50).default(20),
    description: z.string().max(5000).default(''),
    list: z.array(id).default([]),
  }),
  enums: z.strictObject({
    policy: z.enum(['fifo-ready-v1', 'fewest-attempts-v1']),
    action: z.enum(['add-cases', 'new-approach']).optional(),
  }),
  union: z.strictObject({
    value: z.union([z.string().min(1), z.number().int(), z.literal(false)]),
    tagged: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('a'), a: z.string() }),
      z.strictObject({ kind: z.literal('b'), b: z.number() }),
    ]),
  }),
  record: z.strictObject({
    groups: z.record(id, z.array(z.string()).min(1).max(100)),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  nullable: z.strictObject({
    expected: z.string().max(65536).nullable().optional(),
    at: z.number().nullable(),
  }),
  described: z
    .strictObject({
      reason: z.string().trim().min(10).max(2000).describe('Почему — кириллицей 😀'),
      paused: z.boolean().describe('Pause or resume'),
    })
    .describe('Описание объекта'),
  nested: z.strictObject({
    outer: z.strictObject({
      inner: z.array(z.strictObject({ deep: z.tuple([z.string(), z.number()]) })).max(10),
    }),
  }),
  refined: z.strictObject({
    path: z
      .string()
      .min(1)
      .refine((p) => !p.startsWith('/'), 'relative'),
  }),
  plan_draft: planDraftSchema,
  plan_draft_extended: z.strictObject({
    plan: planDraft({
      featureId: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{1,48}$/)
        .optional(),
      assignee: z
        .string()
        .regex(/^[A-Za-z0-9_.@-]{1,80}$/)
        .optional(),
    }),
    boardId: id.optional(),
  }),
};

test('AC18: operationCatalog = legacy-построитель agent.ts:273–288 на корпусе схем', () => {
  const names = Object.keys(schemaCorpus);
  const corpus: Inputs = {
    pkg: { name: 'host-кириллица', version: '1.2.3-beta.4' },
    agentOperations: names,
    descriptions: Object.fromEntries(
      names.map((n, i) => [n, `Операция ${i}: ${n} — "кавычки" \\`]),
    ),
    readOnly: (n) => n.length % 2 === 0,
    agentInputs: schemaCorpus,
  };
  // Весь каталог и каждая операция отдельно.
  assert.equal(
    JSON.stringify(hostCatalog(corpus)),
    JSON.stringify(legacy.legacyCapabilities(corpus)),
  );
  for (const name of names) {
    const one = { ...corpus, agentOperations: [name] };
    assert.equal(
      JSON.stringify(hostCatalog(one)),
      JSON.stringify(legacy.legacyCapabilities(one)),
      name,
    );
  }
  // Пустой каталог.
  const none = { ...corpus, agentOperations: [] };
  assert.equal(JSON.stringify(hostCatalog(none)), JSON.stringify(legacy.legacyCapabilities(none)));
});

test('AC18: 21 запись снимка DevContour побайтово из дословных входов; ключи как в снимке', () => {
  assert.equal(inputs.agentOperations.length, 21);
  const catalog = hostCatalog(inputs);
  assert.deepEqual(Object.keys(catalog), Object.keys(snapshot));
  assert.equal(catalog.name, snapshot.name);
  assert.equal(catalog.version, snapshot.version);
  assert.equal(catalog.protocolVersion, snapshot.protocolVersion);
  assert.equal(catalog.maxInputBytes, snapshot.maxInputBytes);
  assert.equal(catalog.maxResultBytes, snapshot.maxResultBytes);
  const byName = new Map(snapshot.tools.map((t) => [t.name, t]));
  for (const tool of catalog.tools) {
    const expected = byName.get(tool.name);
    assert.ok(expected, tool.name);
    assert.deepEqual(Object.keys(tool), Object.keys(expected), tool.name);
    assert.equal(JSON.stringify(tool), JSON.stringify(expected), tool.name);
  }
  // Порядок подмножества — порядок снимка.
  assert.deepEqual(
    catalog.tools.map((t) => t.name),
    snapshot.tools.map((t) => t.name).filter((n) => inputs.agentOperations.includes(n)),
  );
  // И тот же результат даёт legacy-построитель на тех же входах.
  assert.equal(JSON.stringify(catalog), JSON.stringify(legacy.legacyCapabilities(inputs)));
});

test('AC18: digest подмножества снимка = digest пересобранного каталога; SHA снимка записан', () => {
  // Снимок без перевода строки, его байты — JSON.stringify(capabilities()).
  assert.equal(JSON.stringify(snapshot), snapshotText);
  assert.equal(
    sha256(snapshotText),
    '862305bac2a606004d67a709234f7bbcd08c666e8bcd1b243a0d75e303770f1e',
  );
  assert.equal(legacy.digest(snapshot), sha256(snapshotText));
  const subset = {
    ...snapshot,
    tools: snapshot.tools.filter((t) => inputs.agentOperations.includes(t.name)),
  };
  assert.equal(legacy.digest(hostCatalog(inputs)), legacy.digest(subset));
});

test('AC18/K12: outputSchema только при output; лишние ключи операции игнорируются', () => {
  const input = z.strictObject({ a: z.string() });
  const output = z.strictObject({ ok: z.boolean(), at: z.date().optional() });
  const catalog = operationCatalog({
    name: 'n',
    version: 'v',
    protocolVersion: 1,
    maxInputBytes: 10,
    maxResultBytes: 20,
    operations: {
      with: { description: 'd', readOnly: true, input, output },
      without: { description: 'd', readOnly: false, input },
      extra: {
        description: 'd',
        readOnly: true,
        input,
        api: 'fn',
        limits: { maxInputBytes: 1, maxResultBytes: 1 },
      } as CatalogOperation,
    },
  });
  const [withOut, without, extra] = catalog.tools;
  assert.deepEqual(Object.keys(withOut ?? {}), [
    'name',
    'description',
    'readOnly',
    'inputSchema',
    'outputSchema',
  ]);
  assert.deepEqual(
    withOut?.outputSchema,
    z.toJSONSchema(output, { io: 'output', unrepresentable: 'any' }),
  );
  assert.deepEqual(withOut?.inputSchema, z.toJSONSchema(input, { io: 'input' }));
  assert.equal('outputSchema' in (without ?? {}), false);
  assert.deepEqual(Object.keys(extra ?? {}), ['name', 'description', 'readOnly', 'inputSchema']);
  // Снимок DevContour без outputSchema — и пересборка тоже.
  for (const tool of [...snapshot.tools, ...hostCatalog(inputs).tools])
    assert.equal('outputSchema' in tool, false, tool.name);
  assert.deepEqual(Object.keys(catalog), [
    'name',
    'version',
    'protocolVersion',
    'maxInputBytes',
    'maxResultBytes',
    'tools',
  ]);
});

test("K12: недопустимое имя операции ('1' и др.) → INVALID_INPUT ['operations', имя]", () => {
  const op = { description: 'd', readOnly: true, input: z.strictObject({}) };
  const build = (name: string) =>
    operationCatalog({
      name: 'n',
      version: 'v',
      protocolVersion: 1,
      maxInputBytes: 1,
      maxResultBytes: 1,
      operations: { ok: op, [name]: op },
    });
  for (const name of ['1', '', '-x', '_x', 'a b', 'имя', 'a.b', 'a/b'])
    assert.throws(
      () => build(name),
      (e: unknown) =>
        e instanceof HarnessError &&
        e.code === 'INVALID_INPUT' &&
        e.message === `Каталог: недопустимое имя операции ${name}` &&
        JSON.stringify(e.issues[0]?.path) === JSON.stringify(['operations', name]),
      JSON.stringify(name),
    );
  for (const name of ['a', 'Z', 'plan-check', 'usage_report', 'a1_-B'])
    assert.equal(build(name).tools[1]?.name, name);
});

/* ------------------------------------------------------------------ */
/* H3-01: каталог harness, раздельные каталоги                          */
/* ------------------------------------------------------------------ */

test('H3-01: harnessCapabilities проходит operationCatalogSchema и меньше maxResultBytes', () => {
  const catalog = harnessCapabilities();
  assert.deepEqual(operationCatalogSchema.parse(catalog), catalog);
  assert.equal(catalog.name, 'devcontour-harness');
  assert.equal(catalog.protocolVersion, 1);
  assert.equal(catalog.maxInputBytes, 100000);
  assert.equal(catalog.maxResultBytes, 1048576);
  assert.ok(checkJsonBytes(catalog, catalog.maxResultBytes).within, `${jsonBytes(catalog)}`);
  // Конверт CLI вокруг каталога тоже помещается в предел.
  assert.ok(
    checkJsonBytes({ ok: true, command: 'capabilities', data: catalog }, catalog.maxResultBytes)
      .within,
  );
  assert.deepEqual(
    catalog.tools.map((t) => t.name),
    [...sharedOperationNames],
  );
  for (const tool of catalog.tools) {
    const op = sharedOperations[tool.name as keyof typeof sharedOperations];
    assert.equal(tool.readOnly, op.readOnly, tool.name);
    assert.equal(tool.description, op.description, tool.name);
    assert.ok(tool.outputSchema, tool.name);
  }
  assert.equal(root.harnessCapabilities, harnessCapabilities);
  assert.equal(root.operationCatalog, operationCatalog);
  assert.equal(root.jsonBytes, jsonBytes);
});

test('H3-01: каталоги DevContour и harness строятся одним operationCatalog раздельно', () => {
  const host = hostCatalog(inputs);
  const harness = harnessCapabilities();
  const hostNames = new Set(snapshot.tools.map((t) => t.name));
  const harnessNames = new Set(harness.tools.map((t) => t.name));
  for (const name of harnessNames) assert.equal(hostNames.has(name), false, name);
  for (const name of host.tools.map((t) => t.name))
    assert.equal(harnessNames.has(name), false, name);
  // Тот же построитель: harness = operationCatalog(sharedOperations).
  assert.equal(
    JSON.stringify(harness),
    JSON.stringify(
      operationCatalog({
        name: harness.name,
        version: harness.version,
        protocolVersion: 1,
        maxInputBytes: 100000,
        maxResultBytes: 1048576,
        operations: sharedOperations,
      }),
    ),
  );
  assert.ok(operationCatalogSchema.safeParse(host).success);
  assert.ok(operationCatalogSchema.safeParse(snapshot).success);
});

/* ------------------------------------------------------------------ */
/* M05: байтовая граница = legacy                                       */
/* ------------------------------------------------------------------ */

/** Строка ровно `bytes` UTF-8 байт JSON: `"` + содержимое + `"`. */
const jsonOf = (bytes: number, fill: string, escapedBytes = Buffer.byteLength(fill)) => {
  const inner = bytes - 2;
  const count = Math.floor(inner / escapedBytes);
  return fill.repeat(count) + 'a'.repeat(inner - count * escapedBytes);
};
const fills: [string, string, number?][] = [
  ['ASCII', 'a'],
  ['2 байта', 'я'],
  ['3 байта', '中'],
  ['4 байта', '😀'],
  // JSON.stringify экранирует одиночный суррогат как \ud800 — 6 байт.
  ['одиночный суррогат', '\ud800', 6],
];

const outcome = (f: () => unknown) => {
  try {
    f();
    return 'ok';
  } catch (e) {
    if (e instanceof legacy.DomainError) return `${e.status} ${e.message}`;
    throw e;
  }
};

/** Host mapping §1.4 «Байты»: место, предел и отказ на checkJsonBytes. */
const hostGuards: [string, Guard, number, number, string][] = [
  [
    'agent.ts:302',
    legacy.agentBounded,
    65536,
    413,
    'Ответ превышает 64 KiB; сузьте запрос или используйте CLI-отчёт',
  ],
  ['agent.ts:308/378', legacy.agentRequestGuard, 100000, 413, 'Запрос превышает 100000 байт'],
  [
    'context.ts:291',
    legacy.contextResultGuard,
    65536,
    413,
    'Ответ превышает 64 KiB; сузьте контекст',
  ],
  [
    'preparation-agent.ts:17',
    legacy.preparationRequestGuard,
    100000,
    413,
    'Слишком большой запрос',
  ],
  ['preparation-agent.ts:29', legacy.preparationResultGuard, 65536, 413, 'Ответ превышает 64 KiB'],
];

test('M05: jsonBytes/checkJsonBytes = legacy-проверки на границах 65536/100000 (1–4 байта, суррогат)', () => {
  for (const [place, guard, limit, status, message] of hostGuards)
    for (const [label, fill, escaped] of fills)
      for (const delta of [-1, 0, 1]) {
        const text = jsonOf(limit + delta, fill, escaped);
        for (const value of [text, { input: text.slice(13) }, [text.slice(4)]]) {
          const bytes = Buffer.byteLength(JSON.stringify(value));
          assert.equal(jsonBytes(value), bytes, `${place} ${label}`);
          const check = checkJsonBytes(value, limit);
          assert.deepEqual(check, { bytes, within: bytes <= limit });
          const shared = check.within ? 'ok' : `${status} ${message}`;
          assert.equal(
            shared,
            outcome(() => guard(value)),
            `${place} ${label} ${delta}`,
          );
        }
        const exact = checkJsonBytes(text, limit);
        assert.equal(exact.bytes, limit + delta, `${label} ${delta}`);
        assert.equal(exact.within, delta <= 0);
      }
});

test('K7/M05: utf8Bytes = http.ts:59 Buffer.byteLength сырого текста (суррогат — 3 байта)', () => {
  const limit = 100_000;
  for (const [label, fill] of fills) {
    const unit = Buffer.byteLength(fill);
    for (const delta of [-1, 0, 1]) {
      const count = Math.floor((limit + delta) / unit);
      const text = fill.repeat(count) + 'a'.repeat(limit + delta - count * unit);
      assert.equal(utf8Bytes(text), limit + delta, label);
      assert.equal(utf8Bytes(text), Buffer.byteLength(text));
      const shared = utf8Bytes(text) > limit ? '413 Слишком большой запрос' : 'ok';
      assert.equal(
        shared,
        outcome(() => legacy.httpBodyGuard(text)),
        `${label} ${delta}`,
      );
    }
  }
  assert.equal(utf8Bytes('\ud800'), 3);
  assert.equal(jsonBytes('\ud800'), 8);
  assert.equal(utf8Bytes(''), 0);
  assert.equal(utf8Bytes('😀'), 4);
  // Сырой текст и его JSON различаются: кавычки и escapes.
  assert.notEqual(utf8Bytes('"a"\n'), jsonBytes('"a"\n'));
  assert.equal(jsonBytes('"a"\n'), utf8Bytes(JSON.stringify('"a"\n')));
});

test('K8: значение без JSON → 0, BigInt и цикл бросают как JSON.stringify', () => {
  for (const value of [undefined, () => 1, Symbol('s')]) {
    assert.equal(jsonBytes(value), 0);
    assert.deepEqual(checkJsonBytes(value, 0), { bytes: 0, within: true });
  }
  assert.equal(jsonBytes(null), 4);
  assert.equal(jsonBytes({ a: undefined }), 2);
  assert.equal(jsonBytes([undefined]), 6);
  assert.throws(() => jsonBytes(1n), TypeError);
  assert.throws(() => checkJsonBytes({ n: 1n }, 10), TypeError);
  assert.throws(() => legacy.agentBounded({ n: 1n }), TypeError);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => jsonBytes(cycle), TypeError);
  assert.throws(() => legacy.agentRequestGuard(cycle), TypeError);
});

/* ------------------------------------------------------------------ */
/* M04/AC19/H3-02: clipDeep = legacy clip, размер не ограничивает       */
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

test('M04/AC19: clipText/clipDeep = legacy short/clip на мультиязычном корпусе (300/2000 code units)', () => {
  assert.equal(CLIP_SHORT, legacy.SHORT);
  assert.equal(CLIP_DIAGNOSTIC, legacy.DIAGNOSTIC);
  assert.equal(CLIP_SHORT, 300);
  assert.equal(CLIP_DIAGNOSTIC, 2000);
  const rnd = mulberry32(42);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const units = ['a', 'я', '中', '😀', '\ud800', '👍🏽'];
  const lengths = [0, 1, 299, 300, 301, 1999, 2000, 2001, 5000];
  const text = () => {
    const target = lengths[int(0, lengths.length - 1)] ?? 0;
    let s = '';
    while (s.length < target) s += units[int(0, units.length - 1)] ?? 'a';
    return s.slice(0, target);
  };
  const value = (depth: number): unknown => {
    const kind = int(0, depth > 3 ? 4 : 7);
    if (kind === 0) return text();
    if (kind === 1) return int(-5, 5);
    if (kind === 2) return null;
    if (kind === 3) return rnd() < 0.5;
    if (kind === 4) return undefined;
    if (kind === 5) return Array.from({ length: int(0, 4) }, () => value(depth + 1));
    const obj: Record<string, unknown> = {};
    for (let i = int(0, 4); i > 0; i--) obj[`k${i}`] = value(depth + 1);
    if (rnd() < 0.4) obj.token = text();
    if (rnd() < 0.2) obj.secret = text();
    return obj;
  };
  for (let i = 0; i < 400; i++) {
    const s = text();
    assert.equal(clipText(s), legacy.short(s));
    assert.equal(clipText(s, 2000), legacy.short(s, 2000));
    const v = value(0);
    assert.deepEqual(clipDeep(v), legacy.clip(v), `case ${i}`);
    assert.deepEqual(clipDeep(v, 300), legacy.clip(v, 300), `case ${i} 300`);
    assert.equal(JSON.stringify(clipDeep(v)), JSON.stringify(legacy.clip(v)));
  }
  assert.equal(clipText(undefined), legacy.short(undefined));
  assert.equal(clipText(''), legacy.short(''));
  // Код-юниты, а не символы: эмодзи у границы режется пополам, как у legacy.
  const emoji = 'a'.repeat(299) + '😀';
  assert.equal(clipText(emoji), 'a'.repeat(299) + '\ud83d…');
  assert.equal(clipText(emoji), legacy.short(emoji));
  assert.equal(clipText('я'.repeat(301)), 'я'.repeat(300) + '…');
  assert.equal(clipText('中'.repeat(300)), '中'.repeat(300));
});

test('H3-02/AC19: clipDeep — 300/2000 + «…», token на любой глубине, omitKeys внешнего ответа', () => {
  const value = {
    a: 'x'.repeat(2001),
    b: 'y'.repeat(2000),
    n: 7,
    z: null,
    f: false,
    token: 'верхний',
    nested: [{ token: 's', keep: 'ё'.repeat(2001), deep: { deeper: { token: 't', ok: 1 } } }],
  };
  const clipped = clipDeep(value);
  assert.deepEqual(clipped, {
    a: 'x'.repeat(2000) + '…',
    b: 'y'.repeat(2000),
    n: 7,
    z: null,
    f: false,
    nested: [{ keep: 'ё'.repeat(2000) + '…', deep: { deeper: { ok: 1 } } }],
  });
  assert.deepEqual(clipped, legacy.clip(value));
  assert.deepEqual(clipDeep(value, 300).a, 'x'.repeat(300) + '…');
  // Внешний ответ: token и secret на глубине 3 удаляются, прочее сохраняется.
  const external = {
    level1: { level2: { level3: { token: 'tok', secret: 'sec', public: 'видно', n: 0 } } },
    secret: 'тоже',
    list: [{ inner: [{ secret: 'x', token: 'y', kept: true }] }],
  };
  assert.deepEqual(clipDeep(external, 2000, ['token', 'secret']), {
    level1: { level2: { level3: { public: 'видно', n: 0 } } },
    list: [{ inner: [{ kept: true }] }],
  });
  // По умолчанию omitKeys = ['token']: secret остаётся (как legacy clip).
  assert.deepEqual(clipDeep(external), legacy.clip(external));
  assert.equal(clipDeep(external).secret, 'тоже');
});

test('D0-Q4: clipDeep(v, Infinity) — рекурсивное удаление token без усечения', () => {
  const long = 'ж'.repeat(100000);
  const value = { long, token: 'x', list: [long, { token: 'y', long }], n: 1 };
  assert.deepEqual(clipDeep(value, Infinity), {
    long,
    list: [long, { long }],
    n: 1,
  });
  assert.deepEqual(clipDeep(value, Infinity), legacy.clip(value, Infinity));
});

test('H3-02: clipDeep не ограничивает размер — объект после clip > 65536 отвергает только граница', () => {
  const value = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`f${i}`, 'q'.repeat(2001)]),
  );
  const clipped = clipDeep(value);
  for (const s of Object.values(clipped)) assert.equal(s, 'q'.repeat(2000) + '…');
  const bytes = jsonBytes(clipped);
  assert.ok(bytes > 65536, `${bytes}`);
  assert.equal(checkJsonBytes(clipped, 65536).within, false);
  // Явный отказ границы хоста, ничего не теряется молча.
  assert.equal(
    outcome(() => legacy.agentBounded(clipped)),
    '413 Ответ превышает 64 KiB; сузьте запрос или используйте CLI-отчёт',
  );
  assert.equal(Object.keys(clipped).length, 100);
});
