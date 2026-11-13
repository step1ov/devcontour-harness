/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
 * Тест правит сырой JSON политики и графа до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  digestOf,
  executionPolicySchema,
  gateDigest,
  gateSchema,
  policyDigest,
  policyIssues,
  runResultSchema,
  type ExecutionPolicy,
  type GatePolicy,
  type RunResult,
} from '../src/contracts/index.ts';
import {
  changedPaths,
  gateDecisions,
  matchingPaths,
  notApplicableProblem,
  pathApplicability,
  proofGates,
  type ChangedPaths,
} from '../src/verification/applicability.ts';
import { uncoveredGates } from '../src/verification/proof.ts';
import { resultProblems, type ReceiverContext } from '../src/verification/acceptance.ts';
import { runResult } from '../src/engine/result.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';
import { example } from './fixtures.ts';
import { nodeGate, repo, write } from './git-fixture.ts';
import { approve, greet, implement, runAll, setup } from './runner-fixture.ts';

const ui = (patch: Partial<GatePolicy> = {}): GatePolicy =>
  gateSchema.parse({
    id: 'ui',
    kind: 'check',
    command: ['node', 'scripts/ui-check.mjs'],
    when: { paths: ['web/**', 'src/ui/'] },
    ...patch,
  });
const changed = (files: string[], complete = true): ChangedPaths => ({
  ranges: [{ from: sha('a'), to: sha('b') }],
  files: [...files].sort(),
  complete,
  ...(complete ? {} : { problem: 'test' }),
});
const repoOf = (gates: GatePolicy[]) => ({ gates, protectedPaths: ['.github/', 'test/'] });

test('when.paths: glob — **, *, ?, {a,b} и каталог задевают пути по сегментам', () => {
  const files = [
    'web/index.html',
    'web/app/main.ts',
    'src/ui/button.tsx',
    'src/uix.ts',
    'docs/a.md',
    'docs/sub/b.md',
    'pkg/x/test.spec.ts',
    'a.c',
    '.github/w.yml',
  ];
  assert.deepEqual(matchingPaths(['web/**'], files), ['web/index.html', 'web/app/main.ts']);
  // Каталог (с / и без) задевает всё внутри, но не соседа с тем же префиксом.
  assert.deepEqual(matchingPaths(['src/ui'], files), ['src/ui/button.tsx']);
  assert.deepEqual(matchingPaths(['src/ui/'], files), ['src/ui/button.tsx']);
  // `*` — внутри сегмента; совпавший каталог задевает и вложенное.
  assert.deepEqual(matchingPaths(['docs/*.md'], files), ['docs/a.md']);
  assert.deepEqual(matchingPaths(['docs/*'], files), ['docs/a.md', 'docs/sub/b.md']);
  assert.deepEqual(matchingPaths(['**/*.spec.ts'], files), ['pkg/x/test.spec.ts']);
  assert.deepEqual(matchingPaths(['?.c'], files), ['a.c']);
  assert.deepEqual(matchingPaths(['{web,docs}/*.{html,md}'], files), [
    'web/index.html',
    'docs/a.md',
  ]);
  assert.deepEqual(matchingPaths(['**'], ['x', 'y/z']), ['x', 'y/z']);
  // Точка и + в шаблоне — буквально.
  assert.deepEqual(matchingPaths(['a.c'], ['abc', 'a.c']), ['a.c']);
});

test('when.paths: схема отклоняет абсолютные пути, .., отрицание, классы и вложенные {}', () => {
  for (const bad of ['/web/**', 'web/../x', '!web', 'web/[ab]', 'a\\b', 'a//b', 'a/{b,{c}}', '{a'])
    assert.throws(() => ui({ when: { paths: [bad] } }), /./, bad);
  assert.throws(() => ui({ when: { paths: [] } }));
  assert.throws(() => gateSchema.parse({ ...ui(), when: { paths: ['web'], extra: 1 } }));
  // Совместная проверка условия не принимает.
  assert.throws(() =>
    executionPolicySchema.parse({
      ...(example('policy') as any),
      workspaceGates: [
        {
          id: 'w',
          kind: 'check',
          command: ['true'],
          repositoryId: 'app',
          when: { paths: ['web'] },
        },
      ],
    }),
  );
});

test('when: политика без поля сохраняет digest; все test gates условными и генеративный gate условным не бывают', () => {
  const raw = example('policy') as any;
  const plain = executionPolicySchema.parse(raw);
  assert.ok(!('when' in plain.repositories[0]!.gates[0]!), 'нет поля — нет ключа');
  assert.equal(
    policyDigest(plain),
    policyDigest(executionPolicySchema.parse(structuredClone(raw))),
  );
  assert.deepEqual(policyIssues(plain), []);
  const conditional = structuredClone(raw);
  conditional.repositories[0].gates[0].when = { paths: ['src/**'] };
  const parsed = executionPolicySchema.parse(conditional);
  assert.notEqual(policyDigest(parsed), policyDigest(plain), 'when входит в digest');
  assert.ok(
    policyIssues(parsed).some((i) => /test gate без when/.test(i.message)),
    'все test gates условные — отказ',
  );
  const property = structuredClone(raw);
  property.repositories[0].gates.push({
    id: 'prop',
    kind: 'test',
    command: ['node', 'p.js'],
    report: { type: 'junit', path: 'p.xml' },
    property: {},
    when: { paths: ['src'] },
  });
  assert.ok(
    policyIssues(executionPolicySchema.parse(property)).some((i) =>
      /property.*when/.test(i.message),
    ),
  );
});

test('применимость: путь, неявные входы, неизвестный или пустой diff исполняют gate', () => {
  const gate = ui();
  const repo = repoOf([gate]);
  const skip = pathApplicability(repo, gate, changed(['src/core/a.ts']));
  assert.equal(skip.applies, false);
  if (!skip.applies) {
    assert.equal(skip.record.gateDigest, gateDigest(gate));
    assert.deepEqual(skip.record.patterns, ['web/**', 'src/ui/']);
    assert.equal(skip.record.count, 1);
    assert.deepEqual(skip.record.files, ['src/core/a.ts']);
  }
  const applies = (files: string[], complete = true, g = gate) =>
    pathApplicability(repo, g, changed(files, complete));
  assert.match((applies(['web/x.ts']) as any).reason, /путь gate: web\/x\.ts/);
  assert.match((applies(['src/ui/b.tsx']) as any).reason, /путь gate/);
  // Неявные входы: lockfile/манифест в любом каталоге, защищённый путь,
  // каталог проекта harness, файл из команды gate (с учётом cwd).
  for (const input of [
    'package-lock.json',
    'packages/a/package.json',
    'go.sum',
    'test/run.js',
    '.harness/policy.json',
    'scripts/ui-check.mjs',
  ])
    assert.equal(applies([input]).applies, true, input);
  const inCwd = ui({
    cwd: 'apps/web',
    command: ['node', '../../tools/check.mjs', '--config=cfg.json'],
  });
  assert.equal(applies(['tools/check.mjs'], true, inCwd).applies, true);
  assert.equal(applies(['apps/web/cfg.json'], true, inCwd).applies, true);
  assert.equal(applies(['cfg.json'], true, inCwd).applies, false);
  assert.equal(applies(['src/a.ts'], false).applies, true, 'неполный diff');
  assert.equal(applies([]).applies, true, 'пустой diff');
  assert.equal(
    pathApplicability(repo, ui({ when: undefined }), changed(['src/a.ts'])).applies,
    true,
  );
});

test('решения области: доказательство, история определения и предпосылки исполняют условный gate', () => {
  // Явный граф: у unit предпосылок нет (`dependsOn: []`).
  const unit = gateSchema.parse({
    id: 'unit',
    kind: 'test',
    command: ['node', 'test/run.js'],
    report: { type: 'junit', path: 'r.xml' },
    dependsOn: [],
  });
  const e2e = gateSchema.parse({
    id: 'e2e',
    kind: 'test',
    command: ['node', 'e2e.js'],
    report: { type: 'junit', path: 'e.xml' },
    when: { paths: ['web'] },
    dependsOn: ['build'],
  });
  const build = gateSchema.parse({
    id: 'build',
    kind: 'check',
    command: ['node', 'b.js'],
    when: { paths: ['web'] },
    dependsOn: [],
  });
  const gates = [build, ui({ dependsOn: [] }), unit, e2e];
  const decide = (
    files: string[],
    options: { proof?: string[]; never?: string[]; scope?: GatePolicy[] } = {},
  ) =>
    Object.fromEntries(
      gateDecisions({
        repo: repoOf(gates),
        scope: options.scope ?? gates,
        changed: changed(files),
        proof: new Set(options.proof ?? []),
        passedUnder: (g, d) => d === gateDigest(g) && !(options.never ?? []).includes(g.id),
      }).map((d) => [d.gate.id, d.run]),
    );
  assert.deepEqual(decide(['src/a.ts']), { build: false, ui: false, unit: true, e2e: false });
  // e2e задет — его предпосылка build исполняется, хотя её путь не задет иначе.
  assert.deepEqual(decide(['web/a.ts']), { build: true, ui: true, unit: true, e2e: true });
  assert.deepEqual(decide(['src/a.ts'], { proof: ['e2e'] }), {
    build: true,
    ui: false,
    unit: true,
    e2e: true,
  });
  assert.deepEqual(decide(['src/a.ts'], { never: ['ui'] }), {
    build: false,
    ui: true,
    unit: true,
    e2e: false,
  });
  // Режим порядка массива: test gate без dependsOn опирается на более ранние
  // check gates — условный check перед ним исполняется.
  const arrayUnit = gateSchema.parse({
    id: 'unit',
    kind: 'test',
    command: ['node', 'test/run.js'],
    report: { type: 'junit', path: 'r.xml' },
  });
  const ordered = [ui(), arrayUnit];
  assert.deepEqual(
    Object.fromEntries(
      gateDecisions({
        repo: repoOf(ordered),
        scope: ordered,
        changed: changed(['src/a.ts']),
        proof: new Set(),
        passedUnder: () => true,
      }).map((d) => [d.gate.id, d.run]),
    ),
    { ui: true, unit: true },
  );
});

test('доказательства поручения: требования, договоры и источник требований не бывают неприменимыми', () => {
  const proof = proofGates(
    {
      requirements: [
        {
          id: 'REQ-1',
          source: 'docs/r.md',
          digest: 'a'.repeat(64),
          text: 'текст',
          gate: 'ui',
          scenario: 'сценарий',
        },
      ],
    },
    [
      {
        checks: { gate: 'prop', obligations: [{ id: 'o', gates: ['ref'] }] },
      } as any,
    ],
  );
  assert.deepEqual([...proof].sort(), ['prop', 'ref', 'requirement-source', 'ui']);
  const gate = ui();
  const record = {
    notApplicable: (pathApplicability(repoOf([gate]), gate, changed(['src/a.ts'])) as any).record,
  };
  const base = { gates: [gate], gate: 'ui', record, proof: new Set<string>(), ran: [] };
  assert.equal(notApplicableProblem(base), undefined);
  assert.match(notApplicableProblem({ ...base, proof })!, /доказывает требование/);
  assert.match(
    notApplicableProblem({ ...base, gates: [ui({ when: { paths: ['other'] } })] })!,
    /другим определением/,
  );
  assert.match(notApplicableProblem({ ...base, gates: [ui({ when: undefined })] })!, /без when/);
  const unit = gateSchema.parse({
    id: 'unit',
    kind: 'test',
    command: ['x'],
    report: { type: 'junit', path: 'r.xml' },
  });
  assert.match(
    notApplicableProblem({ ...base, gates: [gate, unit], ran: ['unit'] })!,
    /предпосылка исполненного unit/,
  );
});

test('changedPaths: настоящий Git — переименование даёт оба пути, удаление и объединение пар; ошибка — неполный diff', async () => {
  const r = repo({ 'README.md': 'x\n', 'web/old.ts': 'a\n', 'src/gone.ts': 'b\n' });
  const base = r.head();
  r.git('mv', 'web/old.ts', 'new.ts');
  r.git('rm', '-q', 'src/gone.ts');
  r.git('commit', '-qm', 'move');
  const first = r.head();
  write(r.dir, { ' lead space.txt': 'c\n', 'docs/a.md': 'd\n' });
  r.git('add', '-A');
  r.git('commit', '-qm', 'more');
  const second = r.head();
  const one = await changedPaths(r.dir, [{ from: base, to: first }]);
  assert.equal(one.complete, true);
  assert.deepEqual(one.files, ['new.ts', 'src/gone.ts', 'web/old.ts']);
  const union = await changedPaths(r.dir, [
    { from: base, to: first },
    { from: first, to: second },
  ]);
  assert.deepEqual(union.files, [
    ' lead space.txt',
    'docs/a.md',
    'new.ts',
    'src/gone.ts',
    'web/old.ts',
  ]);
  const broken = await changedPaths(r.dir, [{ from: base, to: sha('9') }]);
  assert.equal(broken.complete, false);
  assert.match(broken.problem!, /git diff/);
});

test('покрытие набора: неприменимый gate решается объединённым diff, без него — исполняется на итоговом SHA', () => {
  const gate = ui();
  const unit = gateSchema.parse({
    id: 'unit',
    kind: 'test',
    command: ['x'],
    report: { type: 'junit', path: 'r.xml' },
  });
  const repository = { id: 'app', gates: [unit, gate], protectedPaths: ['.github/'] };
  const na = {
    kind: 'not-applicable' as const,
    phase: 'integration' as const,
    gate: 'ui',
    passed: false,
    notApplicable: {
      gateDigest: gateDigest(gate),
      patterns: ['web/**'],
      ranges: [{ from: sha('a'), to: sha('b') }],
      count: 1,
      files: ['x'],
      pathsDigest: 'f'.repeat(64),
    },
  };
  const pass = (gid: string, at: string) => ({
    kind: 'test' as const,
    phase: 'integration' as const,
    gate: gid,
    sha: at,
    passed: true,
  });
  const works = [
    {
      repositoryId: 'app',
      resultSha: sha('b'),
      evidence: [pass('unit', sha('b')), { ...na, sha: sha('b') }],
    },
    {
      repositoryId: 'app',
      resultSha: sha('c'),
      evidence: [pass('unit', sha('c')), pass('ui', sha('c'))],
    },
  ];
  // Без объединённого diff — исполнить; diff задевает путь — исполнить, хотя
  // другое поручение gate прошло; не задевает — gate покрыт.
  assert.deepEqual(uncoveredGates([repository], works), [{ repositoryId: 'app', gates: ['ui'] }]);
  assert.deepEqual(uncoveredGates([repository], works, { app: changed(['web/a.ts']) }), [
    { repositoryId: 'app', gates: ['ui'] },
  ]);
  assert.deepEqual(uncoveredGates([repository], works, { app: changed(['src/a.ts']) }), []);
  // Неприменим во всех поручениях и не задет — не пробел; задет — пробел.
  const skipped = [works[0]!];
  assert.deepEqual(uncoveredGates([repository], skipped, { app: changed(['src/a.ts']) }), []);
  assert.deepEqual(uncoveredGates([repository], skipped, { app: changed(['web/b.ts']) }), [
    { repositoryId: 'app', gates: ['ui'] },
  ]);
  // Решение под прежним определением gate — пробел.
  const changedGate = { ...repository, gates: [unit, ui({ when: { paths: ['web'] } })] };
  assert.deepEqual(uncoveredGates([changedGate], skipped, { app: changed(['src/a.ts']) }), [
    { repositoryId: 'app', gates: ['ui'] },
  ]);
  // Политика без when — прежнее правило.
  assert.deepEqual(uncoveredGates([{ id: 'app', gates: [unit] }], works), []);
});

/** Политика с условным check gate `ui` (пути `web/`) и областью поручения unit + ui. */
function conditionalPolicy(patch: (p: any) => void = () => {}) {
  return policyOf((p: any) => {
    p.repositories[0].gates.push({
      id: 'ui',
      kind: 'check',
      command: ['node', 'ui.js'],
      when: { paths: ['web/'] },
    });
    patch(p);
  });
}

function claimed(policy: ExecutionPolicy) {
  const ctx = engineOf(policy);
  const graph = graphOf({ a: [] });
  (graph.orders[0] as any).gates = ['unit', 'ui'];
  ready(ctx.engine, graph);
  const a = ctx.engine.claim('c1')!;
  ctx.engine.phase(a.id, a.token, 'verifying', { baseSha: sha('a'), candidateSha: sha('c') });
  ctx.engine.phase(a.id, a.token, 'integrating', { integrationSha: sha('b') });
  return { ...ctx, a };
}

const record = (gate: GatePolicy) => ({
  gateDigest: gateDigest(gate),
  patterns: gate.when!.paths,
  ranges: [{ from: sha('a'), to: sha('c') }],
  count: 1,
  files: ['src/a.ts'],
  pathsDigest: digestOf('src/a.ts'),
});

test('приёмка: неприменимость закрывает обычный gate с when и видна в receipt; подмена определения или вида — отказ', () => {
  const policy = conditionalPolicy();
  const gate = policy.repositories[0]!.gates.find((g) => g.id === 'ui')!;
  const { engine: e, store, a } = claimed(policy);
  const at = (phase: 'candidate' | 'integration') => sha(phase === 'candidate' ? 'c' : 'b');
  const na = (phase: 'candidate' | 'integration', patch: Record<string, unknown> = {}) => ({
    kind: 'not-applicable' as const,
    phase,
    sha: at(phase),
    gate: 'ui',
    passed: false,
    command: [],
    exitCode: -1,
    log: '',
    digest: digestOf(record(gate)),
    summary: 'Не применим',
    notApplicable: record(gate),
    ...patch,
  });
  // Движок отклоняет запись неприменимости, которая выдаёт себя за PASS, —
  // под чужим определением, у gate без when или вне области.
  for (const [patch, pattern] of [
    [{ passed: true }, /не может быть PASS/],
    [{ notApplicable: { ...record(gate), gateDigest: 'e'.repeat(64) } }, /другим определением/],
    [{ gate: 'unit' }, /без when/],
    [{ kind: 'test' }, /только у записи вида not-applicable/],
  ] as const)
    assert.throws(() => e.evidence(a.id, a.token, na('candidate', patch)), pattern);
  for (const phase of ['candidate', 'integration'] as const) {
    e.evidence(a.id, a.token, na(phase));
    for (const kind of ['test', 'review'] as const)
      e.evidence(a.id, a.token, {
        kind,
        phase,
        sha: at(phase),
        gate: kind === 'test' ? 'unit' : 'independent-review',
        passed: true,
        command: ['x'],
        exitCode: 0,
        log: '',
        digest: digestOf(kind + phase),
        summary: 'ok',
      });
  }
  const events = store.events().filter((x) => x.type === 'attempt.gate');
  assert.ok(
    events.some(
      (x) => x.type === 'attempt.gate' && x.payload.notApplicable === true && !x.payload.passed,
    ),
  );
  e.finish(a.id, a.token, sha('b'));
  const { result, order } = e.read((v) => ({
    result: runResult(v.attempt(a.id)!, '0.1.0-test') as RunResult & { outcome: 'accepted' },
    order: v.work('a')!.order,
  }));
  store.close();
  const skipped = result.evidence.filter((x) => x.kind === 'not-applicable');
  assert.deepEqual(
    skipped.map((x) => [x.gate, x.phase, x.passed, x.notApplicable?.gateDigest]),
    [
      ['ui', 'candidate', false, gateDigest(gate)],
      ['ui', 'integration', false, gateDigest(gate)],
    ],
  );
  assert.deepEqual(runResultSchema.parse(JSON.parse(JSON.stringify(result))), result);
  const context: ReceiverContext = {
    order,
    graphId: 'g',
    contracts: [],
    policy,
    contextDigest: null,
  };
  assert.deepEqual(resultProblems(result, context), []);
  const forged = (change: (r: any) => void) => {
    const copy = structuredClone(result) as any;
    change(copy);
    return resultProblems(copy, context);
  };
  const skip = (r: any) => r.evidence.find((x: any) => x.kind === 'not-applicable');
  for (const [name, change, pattern] of [
    [
      'digest',
      (r: any) => (skip(r).notApplicable.gateDigest = 'e'.repeat(64)),
      /другим определением/,
    ],
    ['вид test', (r: any) => (skip(r).kind = 'test'), /неприменимости не согласованы/],
    ['без сведений', (r: any) => delete skip(r).notApplicable, /неприменимости не согласованы/],
    ['PASS', (r: any) => (skip(r).passed = true), /не бывает PASS/],
  ] as const)
    assert.ok(
      forged(change).some((p) => pattern.test(p)),
      name + ': ' + forged(change).join('; '),
    );
  // Получатель, у которого gate безусловный или доказывает требование, PASS
  // не находит.
  const strict = conditionalPolicy((p) => delete p.repositories[0].gates[1].when);
  assert.ok(
    resultProblems(result, { ...context, policy: strict }).some((p) => /Нет PASS: .*\/ui/.test(p)),
  );
});

test('приёмка: неприменимая предпосылка исполненного gate — нет PASS', () => {
  // Режим порядка массива: условный check `ui` раньше test `unit` — его
  // предпосылка; запись неприменимости её не закрывает.
  const policy = conditionalPolicy((p) => {
    p.repositories[0].gates.reverse();
  });
  const gate = policy.repositories[0]!.gates.find((g) => g.id === 'ui')!;
  const { engine: e, store, a } = claimed(policy);
  for (const phase of ['candidate', 'integration'] as const) {
    const at = sha(phase === 'candidate' ? 'c' : 'b');
    e.evidence(a.id, a.token, {
      kind: 'not-applicable',
      phase,
      sha: at,
      gate: 'ui',
      passed: false,
      command: [],
      exitCode: -1,
      log: '',
      digest: digestOf(record(gate)),
      summary: 'Не применим',
      notApplicable: record(gate),
    });
    for (const kind of ['test', 'review'] as const)
      e.evidence(a.id, a.token, {
        kind,
        phase,
        sha: at,
        gate: kind === 'test' ? 'unit' : 'independent-review',
        passed: true,
        command: ['x'],
        exitCode: 0,
        log: '',
        digest: digestOf(kind + phase),
        summary: 'ok',
      });
  }
  assert.throws(() => e.finish(a.id, a.token, sha('b')), /Нет PASS: candidate\/ui.*предпосылка/);
  store.close();
});

test('runner: diff из Git решает по фазам — первый прогон определения, путь, lockfile исполняют gate; прочее — not-applicable', async () => {
  const marker = 'process.exit(0)';
  const tasks: [string, Record<string, string>][] = [
    ['t1', { 'src/greet.js': greet }],
    ['t2', { 'src/extra.js': 'exports.x = 1;\n' }],
    ['t3', { 'web/page.js': 'exports.page = 1;\n' }],
    ['t4', { 'package.json': '{"name":"app"}\n' }],
  ];
  const ctx = setup({
    scenario: { writer: tasks.map(([, files]) => implement(files)), reviewer: approve() },
    policy: (p: any) => {
      p.repositories[0].gates.push({
        id: 'ui',
        kind: 'check',
        command: nodeGate(marker),
        when: { paths: ['web/'] },
      });
    },
    graph: (g: any) => {
      const base = g.orders[0];
      g.orders = tasks.map(([id], i) => ({
        ...structuredClone(base),
        id,
        source: { ...base.source, ref: id },
        title: 'Задача ' + id,
        writeScope: ['src', 'web', 'package.json'],
        gates: ['unit', 'ui'],
        dependsOn: i ? [tasks[i - 1]![0]] : [],
      }));
    },
  });
  await runAll(ctx);
  const outcome = ctx.engine.read((v) =>
    Object.fromEntries(
      tasks.map(([id]) => {
        const attempt = v.attempts(id).find((x) => x.status === 'succeeded');
        return [
          id,
          {
            status: v.work(id)?.status,
            ui: (['candidate', 'integration'] as const).map(
              (phase) =>
                attempt?.evidence.findLast((e) => e.gate === 'ui' && e.phase === phase)?.kind,
            ),
          },
        ];
      }),
    ),
  );
  assert.deepEqual(outcome, {
    // Определение ещё не проходило integration принятой попытки — исполняется.
    t1: { status: 'done', ui: ['test', 'test'] },
    t2: { status: 'done', ui: ['not-applicable', 'not-applicable'] },
    t3: { status: 'done', ui: ['test', 'test'] },
    // Манифест — неявный вход любого условного gate.
    t4: { status: 'done', ui: ['test', 'test'] },
  });
  const { t1, t2 } = ctx.engine.read((v) => ({
    t1: v.attempts('t1').find((x) => x.status === 'succeeded')!,
    t2: v.attempts('t2').find((x) => x.status === 'succeeded')!,
  }));
  const gate = ctx.policy.repositories[0]!.gates.find((g) => g.id === 'ui')!;
  assert.ok(
    t1.evidence.some(
      (e) => e.gate === 'ui' && e.kind === 'test' && e.gateDigest === gateDigest(gate),
    ),
    'исполненный условный gate несёт digest определения',
  );
  const skip = t2.evidence.find((e) => e.kind === 'not-applicable' && e.phase === 'integration')!;
  assert.deepEqual(skip.notApplicable!.files, ['src/extra.js']);
  assert.deepEqual(
    skip.notApplicable!.ranges.map((r) => r.to),
    [t2.candidateSha, t2.integrationSha],
  );
  assert.equal(skip.passed, false);
  // Receipt принятой попытки с неприменимым gate принимает получатель с той же политикой.
  const result = runResult(t2, '0.1.0-test');
  const order = ctx.engine.read((v) => v.work('t2')!.order);
  assert.deepEqual(
    resultProblems(result, {
      order,
      graphId: ctx.graph.id,
      contracts: [],
      policy: ctx.policy,
      contextDigest: null,
    }),
    [],
  );
  ctx.store.close();
});
