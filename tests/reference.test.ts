import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  checkDeclarationSchema,
  digestOf,
  type CheckDeclaration,
  type ContractDocument,
  type GatePolicy,
  type Obligation,
} from '../src/contracts/index.ts';
import {
  declarationProblems,
  orderCheckManifest,
  orderPropertyProblems,
  referenceNote,
  suiteBasis,
} from '../src/verification/checks.ts';
import { propertyGates } from '../src/verification/acceptance.ts';
import { writeSelfCheck } from '../src/verification/self-check.ts';
import { implement, runAll } from './runner-fixture.ts';
import { declaration as knapDeclaration, knap, oracle, propertySetup } from './property-fixture.ts';

/**
 * Проверка по закреплённым эталонным наборам: ответы эталона получены
 * заранее, сверены с другим способом и закреплены артефактами контракта;
 * gates сверяют с ними реализацию и отчитываются долей покрытия.
 */

const gate = (id: string, property = false) =>
  ({
    id,
    kind: 'test',
    command: ['node', `${id}.mjs`],
    timeoutMs: 60000,
    report: { type: 'junit', path: `.reports/${id}.xml` },
    ...(property ? { property: {} } : {}),
  }) as GatePolicy;
const plain = [gate('golden-a'), gate('golden-b'), gate('fuzz', true)];
const artifacts = ['replay.mjs', 'golden-a.json', 'golden-b.json', 'oracle.mjs'];

/** Эталонное обязательство: два gate, по набору на каждый. */
function reference(over: Partial<Obligation> = {}): Obligation {
  return {
    property: 'knapsack-optimal',
    requirements: ['AC-optimal'],
    promise: 'optimality',
    domain: {
      inputs: 'Целые неотрицательные веса и ценности, до 8 предметов',
      bounds: 'Вместимость от 0 до 30',
      invalid: 'Отрицательные и нецелые значения отклоняются',
    },
    answer: { rules: 'Точное значение оптимума' },
    method: {
      kind: 'oracle',
      description: 'Ответы полного перебора, вычисленные заранее',
      applicability: 'До 8 предметов',
      artifacts: ['replay.mjs', 'oracle.mjs'],
    },
    coverage: {
      families: [
        { id: 'boundary', kind: 'boundary', description: 'Нулевые веса', minCases: 20 },
        { id: 'adversarial', kind: 'adversarial', description: 'Много предметов', minCases: 30 },
      ],
      minCases: 80,
      corpus: false,
    },
    resources: { subject: 'Меньше секунды на вход', oracle: 'Перебор вне gate, заранее' },
    hard: false,
    gates: ['golden-a', 'golden-b'],
    verification: 'reference',
    reference: {
      oracle: { description: 'Полный перебор подмножеств', limits: 'До 8 предметов, 2^8 масок' },
      crossChecks: [
        { family: 'малые входы', against: 'DP по вместимости', matches: 800, total: 800 },
      ],
      sets: [
        {
          gate: 'golden-a',
          artifacts: ['golden-a.json'],
          minCases: 40,
          families: [{ id: 'boundary', minCases: 20 }],
        },
        {
          gate: 'golden-b',
          artifacts: ['golden-b.json'],
          minCases: 40,
          families: [{ id: 'adversarial', minCases: 30 }],
        },
      ],
      gaps: 'Входы больше 8 предметов и вместимость больше 30 наборы не покрывают',
    },
    ...over,
  };
}
const declaration = (o: Obligation = reference()): CheckDeclaration =>
  checkDeclarationSchema.parse({ version: 1, gate: 'golden-a', obligations: [o] });
const problems = (d: CheckDeclaration, gates = plain) =>
  declarationProblems(d, { gates, repositoryId: 'app', artifacts });
const contract = (checks: CheckDeclaration): ContractDocument => ({
  apiVersion: 'devcontour-harness/v1alpha1',
  id: 'knap',
  title: 'Knapsack',
  content: 'Оптимум рюкзака по эталонным наборам.',
  checks,
});

test('Эталонное обязательство на gates без генератора принимается; генеративное — по-прежнему нет', () => {
  assert.deepEqual(problems(declaration()), []);
  const generative = { ...reference(), verification: undefined, reference: undefined };
  assert.deepEqual(problems(declaration(generative)), [
    'свойство knapsack-optimal: gate golden-a не генеративный (нет property)',
    'свойство knapsack-optimal: gate golden-b не генеративный (нет property)',
  ]);
});

test('Структурные пропуски эталонной проверки называются до вызова модели', () => {
  const r = reference().reference!;
  const cases: [Partial<Obligation>, RegExp][] = [
    [{ reference: undefined }, /для способа reference опишите эталонные наборы/],
    [{ verification: undefined }, /эталонные наборы объявлены, но способ исполнения не reference/],
    [
      { reference: { ...r, sets: [{ ...r.sets[0]!, artifacts: ['golden-c.json'] }, r.sets[1]!] } },
      /набор 1: golden-c\.json не объявлен артефактом контракта/,
    ],
    [
      { reference: { ...r, sets: [r.sets[0]!] } },
      /gate golden-b не сверяет ни одного эталонного набора/,
    ],
    [
      { reference: { ...r, sets: [r.sets[0]!, { ...r.sets[1]!, gate: 'fuzz' }] } },
      /набор 2: gate fuzz не среди gates обязательства/,
    ],
    [
      { reference: { ...r, sets: [r.sets[0]!, { ...r.sets[1]!, minCases: 30 }] } },
      /наборы требуют 70 входов, меньше общего минимума 80/,
    ],
    [
      {
        reference: {
          ...r,
          sets: [r.sets[0]!, { ...r.sets[1]!, families: [{ id: 'adversarial', minCases: 10 }] }],
        },
      },
      /семейство adversarial: наборы требуют 10 входов, меньше минимума семейства 30/,
    ],
    [
      {
        reference: {
          ...r,
          sets: [r.sets[0]!, { ...r.sets[1]!, families: [{ id: 'typical', minCases: 30 }] }],
        },
      },
      /набор 2: семейство typical не объявлено в покрытии/,
    ],
    [
      { reference: { ...r, sets: [{ ...r.sets[0]!, minCases: 10 }, r.sets[1]!] } },
      /набор 1: семейства требуют 20 входов, больше минимума набора 10/,
    ],
    [
      { reference: { ...r, crossChecks: [{ ...r.crossChecks[0]!, matches: 799 }] } },
      /сверка эталона «малые входы» расходится \(799 из 800\)/,
    ],
    [
      { reference: { ...r, crossChecks: [{ ...r.crossChecks[0]!, matches: 801 }] } },
      /совпало 801 из 800/,
    ],
    [
      // Один gate договора: отказ — из-за способа, а не из-за чужого gate.
      {
        gates: ['golden-a'],
        reference: { ...r, sets: [r.sets[0]!, { ...r.sets[1]!, gate: 'golden-a' }] },
        coverage: { ...reference().coverage, corpus: true },
      },
      /корпус пополняет генератор; эталонные наборы закреплены/,
    ],
    [{ gates: ['golden-a', 'golden-b', 'golden-a'] }, /gates повторяются/],
    [{ gates: ['golden-a', 'golden-c'] }, /gate golden-c не настроен в репозитории app/],
  ];
  for (const [over, expected] of cases) {
    const found = problems(declaration(reference(over)));
    assert.ok(
      found.some((p) => expected.test(p)),
      `${expected}: ${JSON.stringify(found)}`,
    );
  }
});

test('Генеративное обязательство со своими gates: каждый генеративный, корпус — только у gate договора', () => {
  const own = {
    ...reference(),
    verification: undefined,
    reference: undefined,
    gates: ['fuzz'],
  } satisfies Obligation;
  assert.deepEqual(
    problems(checkDeclarationSchema.parse({ version: 1, gate: 'fuzz', obligations: [own] })),
    [],
  );
  const corpus = checkDeclarationSchema.parse({
    version: 1,
    gate: 'golden-a',
    obligations: [{ ...own, coverage: { ...own.coverage, corpus: true } }],
    corpus: { format: 'JSON', extensible: true },
  });
  assert.ok(
    problems(corpus).some((p) =>
      /корпус исполняет gate договора golden-a, а не свои gates/.test(p),
    ),
  );
});

test('Манифест gate — его доля наборов; генеративный манифест и основание корпуса прежние', () => {
  const contracts = [contract(declaration())];
  const order = { properties: ['knapsack-optimal'] };
  assert.deepEqual(orderCheckManifest(order, contracts, 'golden-a')?.properties, [
    {
      id: 'knapsack-optimal',
      minCases: 40,
      families: [{ id: 'boundary', minCases: 20 }],
      reference: { artifacts: ['golden-a.json'] },
    },
  ]);
  assert.deepEqual(orderCheckManifest(order, contracts, 'golden-b')?.properties[0]?.families, [
    { id: 'adversarial', minCases: 30 },
  ]);
  assert.equal(orderCheckManifest(order, contracts, 'fuzz'), undefined);
  assert.deepEqual(
    propertyGates(order, contracts).byGate,
    new Map([
      ['golden-a', ['knapsack-optimal']],
      ['golden-b', ['knapsack-optimal']],
    ]),
  );
  // Договор без новых полей: манифест и основание корпуса — прежней формы.
  const old = contract(knapDeclaration());
  const manifest = orderCheckManifest(order, [old], 'properties')!;
  assert.deepEqual(manifest.properties[0], {
    id: 'knapsack-optimal',
    minCases: 100,
    families: [
      { id: 'boundary', minCases: 30 },
      { id: 'adversarial', minCases: 30 },
    ],
  });
  const d = old.checks!;
  assert.equal(
    suiteBasis(old),
    digestOf({
      artifacts: [],
      gate: d.gate,
      obligations: d.obligations.map((o) => ({
        property: o.property,
        domain: o.domain,
        answer: o.answer,
        method: o.method,
      })),
    }),
  );
  assert.notEqual(
    suiteBasis(contract(declaration())),
    suiteBasis(
      contract(
        declaration(
          reference({ reference: { ...reference().reference!, gaps: 'Другие пределы наборов' } }),
        ),
      ),
    ),
  );
});

test('Поручение: эталонное свойство на gate без генератора согласуется, каждый его gate — в области', () => {
  const contracts = [contract(declaration())];
  const order = {
    id: 'w',
    properties: ['knapsack-optimal'],
    gates: ['golden-a', 'golden-b'],
    requirements: [{ id: 'AC-optimal', gate: 'golden-b', testId: 'knapsack-optimal' }],
  };
  const configured = { configured: plain, scope: ['golden-a', 'golden-b'] };
  assert.deepEqual(orderPropertyProblems(order as never, contracts, configured), []);
  assert.deepEqual(
    orderPropertyProblems(order as never, contracts, { configured: plain, scope: ['golden-a'] }),
    ['w: свойство knapsack-optimal проверяет gate golden-b, которого нет в поручении'],
  );
  const generative = contract(
    declaration({ ...reference(), verification: undefined, reference: undefined }),
  );
  assert.match(
    orderPropertyProblems(order as never, [generative], configured).join('; '),
    /gate golden-a свойства knapsack-optimal не генеративный/,
  );
});

test('Reviewer контракта видит пределы наборов (gaps) и сверку эталона', () => {
  const note = referenceNote(declaration());
  assert.match(note, /Входы больше 8 предметов и вместимость больше 30 наборы не покрывают/);
  assert.match(note, /"matches":800,"total":800/);
  assert.match(note, /a promise that rests on a gap/);
  assert.equal(referenceNote(knapDeclaration()), '');
});

test('Самопроверка исполнителя прогоняет и gates эталонных наборов, свойство — один раз', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-reference-self-'));
  try {
    const plan = await writeSelfCheck({
      order: { id: 'w', properties: ['knapsack-optimal'] },
      contracts: [contract(declaration())],
      gates: plain,
      dir: join(dir, 'self'),
      seed: 1,
    });
    assert.deepEqual(plan?.properties, ['knapsack-optimal']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Входы с ответами перебора: эталон вычислен заранее и закреплён файлом. */
const best = (items: { w: number; v: number }[], cap: number) => {
  let top = 0;
  for (let mask = 0; mask < 1 << items.length; mask++) {
    let w = 0,
      v = 0;
    items.forEach((it, i) => {
      if (mask & (1 << i)) {
        w += it.w;
        v += it.v;
      }
    });
    if (w <= cap && v > top) top = v;
  }
  return top;
};
function golden(seed: number, families: Record<string, number>) {
  let x = seed;
  const rnd = (max: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % (max + 1));
  return Object.entries(families).flatMap(([family, n]) =>
    Array.from({ length: n }, () => {
      const count = family === 'adversarial' ? 6 + rnd(2) : 1 + rnd(4);
      const items = Array.from({ length: count }, () => ({
        w: family === 'boundary' ? 0 : rnd(6),
        v: rnd(9),
      }));
      const cap = rnd(12);
      return { family, input: { items, cap }, expected: best(items, cap) };
    }),
  );
}
/** Сверка реализации с набором: отчёт свойств и JUnit с testcase по property ID. */
const replay = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { solve } from './src/knap.mjs';
const [file, limit, mode] = process.argv.slice(2);
const set = JSON.parse(readFileSync(file, 'utf8')).slice(0, Number(limit) || undefined);
const families = {};
let counterexample;
for (const c of set) {
  const actual = solve(c.input.items, c.input.cap);
  families[c.family] = (families[c.family] ?? 0) + 1;
  if (actual !== c.expected) { counterexample = { original: c.input, expected: c.expected, actual }; break; }
}
const status = counterexample ? 'failed' : 'passed';
const out = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const report = process.env.DEVCONTOUR_PROPERTY_REPORT;
if (report && mode !== 'silent')
  out(report, JSON.stringify({ version: 1, properties: [{ testId: 'knapsack-optimal', status,
    cases: Object.values(families).reduce((a, b) => a + b, 0), families,
    ...(counterexample ? { counterexample } : {}) }] }));
out(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite name="golden" tests="1" failures="' + (counterexample ? 1 : 0) +
  '"><testcase name="knapsack-optimal">' + (counterexample ? '<failure message="mismatch"/>' : '') + '</testcase></testsuite>');
process.exit(counterexample ? 1 : 0);
`;

function referenceSetup(options: { writer: unknown; args?: Record<string, string[]> }) {
  const files = {
    'replay.mjs': replay,
    'oracle.mjs': oracle,
    'golden-a.json': JSON.stringify(golden(7, { boundary: 20, typical: 20 })),
    'golden-b.json': JSON.stringify(golden(11, { adversarial: 30, typical: 10 })),
  };
  return propertySetup({
    writer: options.writer,
    properties: ['knapsack-optimal'],
    declaration: declaration(),
    files,
    artifacts,
    gates: ['golden-a', 'golden-b'],
    policy: (p) => {
      (p as { repositories: { gates: unknown[] }[] }).repositories[0]!.gates = [
        'golden-a',
        'golden-b',
      ].map((id) => ({
        id,
        kind: 'test',
        command: [process.execPath, 'replay.mjs', `${id}.json`, ...(options.args?.[id] ?? [])],
        timeoutMs: 60000,
        report: { type: 'junit', path: `.reports/${id}.xml` },
      }));
      p.maxAttempts = 1;
    },
  });
}
const attempt = (ctx: ReturnType<typeof referenceSetup>) =>
  ctx.engine.read((v) => v.attempts('add-greeting')[0]!);

test('Gates эталонных наборов без генератора получают путь отчёта и доводят поручение до приёмки', async () => {
  const ctx = referenceSetup({ writer: implement({ 'src/knap.mjs': knap.correct }) });
  await runAll(ctx);
  const a = attempt(ctx);
  assert.equal(a.status, 'succeeded', a.error);
  for (const id of ['golden-a', 'golden-b']) {
    const e = a.evidence.filter((x) => x.gate === id);
    assert.equal(e.length, 2, `${id}: кандидат и интеграция`);
    for (const x of e) {
      assert.equal(x.property?.level, 'manifest');
      assert.deepEqual(x.property?.manifest?.properties, ['knapsack-optimal']);
      assert.equal(x.property?.report?.properties[0]?.cases, 40);
    }
  }
});

test('Зелёный JUnit и код 0 не заменяют доли набора: недобор входов — отказ gate', async () => {
  const ctx = referenceSetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    args: { 'golden-b': ['25'] },
  });
  await runAll(ctx);
  const a = attempt(ctx);
  const e = a.evidence.find((x) => x.gate === 'golden-b')!;
  assert.equal(e.exitCode, 0);
  assert.equal(e.passed, false);
  assert.match(
    e.summary,
    /Проверка по эталонным наборам не подтвердила покрытие: свойство knapsack-optimal: проверено 25 входов из обязательных 40; свойство knapsack-optimal, семейство adversarial: проверено 25 входов из обязательных 30/,
  );
  assert.equal(a.status, 'failed');
});

test('Gate эталонных наборов без отчёта не проходит; расхождение с эталоном называет вход', async () => {
  const silent = referenceSetup({
    writer: implement({ 'src/knap.mjs': knap.correct }),
    args: { 'golden-a': ['0', 'silent'] },
  });
  await runAll(silent);
  const e = attempt(silent).evidence.find((x) => x.gate === 'golden-a')!;
  assert.equal(e.exitCode, 0);
  assert.equal(e.passed, false);
  assert.match(e.summary, /Проверка по эталонным наборам не отчиталась: отчёт свойств не записан/);

  const wrong = referenceSetup({ writer: implement({ 'src/knap.mjs': knap.zeroWeight }) });
  await runAll(wrong);
  const a = attempt(wrong);
  assert.equal(a.status, 'failed');
  assert.match(
    a.error!,
    /golden-a: .*свойство knapsack-optimal нарушено на .*ожидалось \d+, получено \d+/,
  );
});
