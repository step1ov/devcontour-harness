/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Фикстура правит сырой JSON политики и графа до разбора схемой.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  API_VERSION,
  digestOf,
  type CheckDeclaration,
  type ContractDocument,
} from '../src/contracts/index.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { Harness } from '../src/control/harness.ts';
import { approve, bin, setup } from './runner-fixture.ts';

/**
 * Обезличенный проект для договора проверки: рюкзак на малых входах и
 * полнота достижимых сумм. Эталоны — полный перебор, закреплены контрактом;
 * генераторы и семейства входов — в общем файле проверок `check.mjs`.
 */
export const oracle = `export function best(items, cap) {
  let top = 0;
  for (let mask = 0; mask < 1 << items.length; mask++) {
    let w = 0, v = 0;
    items.forEach((it, i) => { if (mask & (1 << i)) { w += it.w; v += it.v; } });
    if (w <= cap && v > top) top = v;
  }
  return top;
}
export function sums(weights, cap) {
  const out = new Set();
  for (let mask = 0; mask < 1 << weights.length; mask++) {
    let w = 0;
    weights.forEach((x, i) => { if (mask & (1 << i)) w += x; });
    if (w <= cap) out.add(w);
  }
  return [...out].sort((a, b) => a - b);
}
`;
export const check = (cases = 120) => `import { properties } from './harness.mjs';
import { best, sums } from './oracle.mjs';
import { solve } from './src/knap.mjs';
import { reach } from './src/reach.mjs';
const int = (rng, max) => Math.floor(rng() * (max + 1));
const item = (rng) => ({ w: int(rng, 6), v: int(rng, 9) });
const valid = (x) => !!x && Array.isArray(x.items) && x.items.length <= 8 &&
  x.items.every((it) => Number.isInteger(it.w) && it.w >= 0 && Number.isInteger(it.v) && it.v >= 0) &&
  Number.isInteger(x.cap) && x.cap >= 0 && x.cap <= 30;
await properties([
  {
    testId: 'knapsack-optimal',
    cases: ${cases},
    valid,
    families: [
      { id: 'boundary', cases: 30, generate: (rng) => ({
        items: Array.from({ length: 1 + int(rng, 3) }, () => ({ w: int(rng, 1) * int(rng, 6), v: int(rng, 9) })),
        cap: int(rng, 1) ? 0 : int(rng, 6),
      }) },
      { id: 'adversarial', cases: 30, generate: (rng) => ({
        items: Array.from({ length: 5 + int(rng, 2) }, () => item(rng)),
        cap: 4 + int(rng, 10),
      }) },
    ],
    generate: (rng) => ({ items: Array.from({ length: int(rng, 6) }, () => item(rng)), cap: int(rng, 10) }),
    oracle: ({ items, cap }) => best(items, cap),
    subject: ({ items, cap }) => solve(items, cap),
    shrink: ({ items, cap }) => [
      ...items.map((_, i) => ({ items: items.filter((__, j) => j !== i), cap })),
      ...(cap > 0 ? [{ items, cap: cap - 1 }] : []),
    ],
  },
  {
    testId: 'reach-complete',
    cases: ${cases},
    valid: (x) => !!x && Array.isArray(x.weights) && x.weights.length <= 8 && Number.isInteger(x.cap),
    families: [
      { id: 'boundary', cases: 20, generate: (rng) => ({ weights: [0, int(rng, 3)], cap: int(rng, 3) }) },
    ],
    generate: (rng) => ({ weights: Array.from({ length: int(rng, 5) }, () => int(rng, 6)), cap: int(rng, 12) }),
    oracle: ({ weights, cap }) => sums(weights, cap),
    subject: ({ weights, cap }) => reach(weights, cap),
  },
]);
`;
const dp = (filter = 'items') => `export function solve(items, cap) {
  const t = new Array(cap + 1).fill(0);
  for (const it of ${filter}) for (let c = cap; c >= it.w; c--) t[c] = Math.max(t[c], t[c - it.w] + it.v);
  return t[cap];
}
`;
/** Реализации рюкзака: верная и дефектные, которые точечные тесты пропускают. */
export const knap = {
  correct: dp(),
  // Учитывает только первые три предмета: часть входов пропущена.
  firstThree: dp('items.slice(0, 3)'),
  // Ошибается на границе: предметы нулевого веса не берёт.
  zeroWeight: dp('items.filter((it) => it.w > 0)'),
  // Подогнана под один контрпример: исправлен ровно он, класс остался.
  fitted: (input: { items: { w: number; v: number }[]; cap: number }, answer: number) =>
    `const fixed = ${JSON.stringify(input)};
const same = (items, cap) => cap === fixed.cap && items.length === fixed.items.length &&
  items.every((it, i) => it.w === fixed.items[i].w && it.v === fixed.items[i].v);
export function solve(items, cap) {
  if (same(items, cap)) return ${answer};
  const t = new Array(cap + 1).fill(0);
  for (const it of items.slice(0, 3)) for (let c = cap; c >= it.w; c--) t[c] = Math.max(t[c], t[c - it.w] + it.v);
  return t[cap];
}
`,
  stub: 'export function solve() { throw new Error("todo"); }\n',
};
export const reach = `export function reach(weights, cap) {
  let set = new Set([0]);
  for (const w of weights) for (const s of [...set]) if (s + w <= cap) set.add(s + w);
  return [...set].filter((s) => s <= cap).sort((a, b) => a - b);
}
`;

const harness = readFileSync(
  fileURLToPath(new URL('./fixtures/property/harness.mjs', import.meta.url)),
  'utf8',
);
const blob = (text: string) =>
  execFileSync('git', ['hash-object', '--stdin'], { input: text }).toString().trim();

/** Договор проверки рюкзака и полноты сумм. */
export function declaration(overrides: Partial<CheckDeclaration> = {}): CheckDeclaration {
  const obligation = (property: string, requirement: string) => ({
    property,
    requirements: [requirement],
    promise: property === 'knapsack-optimal' ? ('optimality' as const) : ('completeness' as const),
    domain: {
      inputs: 'Целые неотрицательные веса и ценности, до 8 предметов',
      bounds: 'Вместимость от 0 до 30',
      invalid: 'Отрицательные и нецелые значения отклоняются',
    },
    answer: { rules: 'Точное значение; порядок не важен', ties: 'Равные оптимумы равнозначны' },
    method: {
      kind: 'oracle' as const,
      description: 'Полный перебор подмножеств',
      applicability: 'До 8 предметов',
      artifacts: ['oracle.mjs', 'check.mjs'],
    },
    coverage: {
      families:
        property === 'knapsack-optimal'
          ? [
              {
                id: 'boundary',
                kind: 'boundary' as const,
                description: 'Нулевые веса',
                minCases: 30,
              },
              {
                id: 'adversarial',
                kind: 'adversarial' as const,
                description: 'Много предметов',
                minCases: 30,
              },
            ]
          : [{ id: 'boundary', kind: 'boundary' as const, description: 'Нули', minCases: 20 }],
      minCases: 100,
      corpus: true,
    },
    resources: { subject: 'Меньше секунды на вход', oracle: 'Меньше секунды на вход' },
    hard: false,
  });
  return {
    version: 1,
    gate: 'properties',
    obligations: [
      obligation('knapsack-optimal', 'AC-optimal'),
      obligation('reach-complete', 'AC-reach'),
    ],
    corpus: { format: 'JSON-вход свойства', extensible: true, maxCases: 500 },
    ...overrides,
  };
}

/** Находка ревью с воспроизводимым входом — так её пишет reviewer. */
export function rejection(reproduction: {
  property: string;
  input: string;
  expected: string | null;
  actual: string | null;
}) {
  return {
    result: {
      approved: false,
      summary: 'Fixture review rejects',
      findings: [
        {
          severity: 'blocking',
          message: `Свойство ${reproduction.property} нарушено на ${reproduction.input}`,
          path: 'src/knap.mjs',
          line: 1,
          rule: null,
          consequence: null,
          evidence: null,
          reproduction: {
            ...reproduction,
            command: ['rm', '-rf', '/'],
            executed: false,
            run: null,
          },
        },
      ],
      discoveries: [],
      execution: { commands: [], noCommandsReason: 'Проверка по diff' },
      previous: [],
    },
  };
}

export const propertyGate = () => ({
  id: 'properties',
  kind: 'test',
  command: [process.execPath, 'check.mjs'],
  timeoutMs: 60000,
  report: { type: 'junit', path: '.reports/properties.xml' },
  property: {},
});

/**
 * Проект с генеративным gate на fixture runtime. `properties` — свойства
 * поручения (по умолчанию оба); `declaration: false` — без договора проверки.
 */
export function propertySetup(options: {
  writer: unknown;
  reviewer?: unknown;
  lead?: unknown;
  properties?: string[] | false;
  declaration?: CheckDeclaration | false;
  cases?: number;
  policy?: (p: Record<string, unknown>) => void;
  files?: Record<string, string>;
  /** Закреплённые файлы контракта; по умолчанию — эталон, checker и harness. */
  artifacts?: string[];
  /** Gates поручения; по умолчанию — генеративный `properties`. */
  gates?: string[];
  writeScope?: string[];
  now?: () => number;
}) {
  const files: Record<string, string> = {
    'oracle.mjs': oracle,
    'check.mjs': check(options.cases),
    'harness.mjs': harness,
    'src/knap.mjs': knap.stub,
    'src/reach.mjs': reach,
    '.gitignore': '.reports/\n',
    ...options.files,
  };
  const contract: ContractDocument = {
    apiVersion: API_VERSION,
    id: 'knap',
    repositoryId: 'app',
    title: 'Knapsack',
    content: 'Оптимум рюкзака и полнота сумм по oracle.mjs.',
    artifacts: (options.artifacts ?? ['oracle.mjs', 'check.mjs', 'harness.mjs']).map((path) => ({
      path,
      blob: blob(files[path]!),
    })),
    ...(options.declaration === false ? {} : { checks: options.declaration ?? declaration() }),
  };
  const properties =
    options.properties === false
      ? undefined
      : (options.properties ?? ['knapsack-optimal', 'reach-complete']);
  const ctx = setup({
    ...(options.now ? { now: options.now } : {}),
    scenario: {
      writer: options.writer,
      reviewer: options.reviewer ?? approve(),
      ...(options.lead ? { lead: options.lead } : {}),
    },
    files,
    policy: (p: any) => {
      p.repositories[0].gates = [propertyGate()];
      p.repositories[0].protectedPaths = ['harness.mjs', '.gitignore'];
      p.maxAttempts = 4;
      options.policy?.(p as Record<string, unknown>);
    },
    graph: (g: any) => {
      g.orders[0].gates = options.gates ?? ['properties'];
      g.orders[0].writeScope = options.writeScope ?? ['src'];
      g.orders[0].contracts = [{ id: 'knap', digest: digestOf(contract) }];
      if (properties) g.orders[0].properties = properties;
    },
  });
  ctx.engine.recordReview(
    {
      id: 'RV-contract-knap-1',
      kind: 'contract',
      subject: 'knap',
      digest: digestOf(contract),
      round: 1,
      at: '2026-01-01T00:00:00.000Z',
      approved: true,
      summary: 'контракт годен',
      authorRuntime: 'claude',
      reviewerRuntime: 'codex',
      sameVendor: false,
      reviewerBinding: ctx.engine.reviewerBinding('contract', 'claude')!,
      findings: [],
      artifact: 'reviews/contract-1.json',
    },
    contract,
  );
  return { ...ctx, contract };
}

/** Тот же проект через публичные операции `Harness` (хранилище фикстуры закрывается). */
export function propertyHarness(ctx: ReturnType<typeof propertySetup>) {
  ctx.store.close();
  return Harness.open({
    stateDir: ctx.state,
    policy: ctx.policy,
    baseDir: ctx.repo.dir,
    adapters: {
      claude: cliAdapter('claude', { executable: bin('fake-claude') }),
      codex: cliAdapter('codex', { executable: bin('fake-codex') }),
    },
  });
}
