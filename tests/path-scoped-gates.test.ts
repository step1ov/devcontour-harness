/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
 * Тест правит сырой JSON политики и графа до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  digestOf,
  executionDigest,
  executionPolicySchema,
  gateDigest,
  gateSchema,
  policyDigest,
  policyIssues,
  runResultSchema,
  workGraphSchema,
  type ExecutionPolicy,
  type GatePolicy,
  type RunResult,
} from '../src/contracts/index.ts';
import {
  changedPaths,
  coverageChanges,
  gateBasis,
  gateDecisions,
  matchingPaths,
  notApplicableProblem,
  pathApplicability,
  proofGates,
  providerMovement,
  type ChangedPaths,
} from '../src/verification/applicability.ts';
import { uncoveredGates } from '../src/verification/proof.ts';
import { resultProblems, type ReceiverContext } from '../src/verification/acceptance.ts';
import { runResult } from '../src/engine/result.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';
import { example } from './fixtures.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeGate, repo, write } from './git-fixture.ts';
import { components } from './components-fixture.ts';
import { approve, bin, greet, implement, runAll, setup } from './runner-fixture.ts';
import { Engine } from '../src/engine/engine.ts';
import { Runner } from '../src/engine/runner.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';

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
  // `X/**` и шаблон внутри X задевают сам путь X (подмодуль, файл вместо каталога).
  assert.deepEqual(matchingPaths(['vendor/lib/**'], ['vendor/lib', 'vendor']), [
    'vendor/lib',
    'vendor',
  ]);
  assert.deepEqual(matchingPaths(['web/*.ts'], ['web', 'webx']), ['web']);
  // Подмодуль или ссылка на уровне, который шаблон проходит через glob.
  assert.deepEqual(
    matchingPaths(['packages/*/src/**'], ['packages/ui', 'packages', 'other', 'packages/ui/x']),
    ['packages/ui', 'packages'],
  );
  assert.deepEqual(matchingPaths(['{web,app}/src/**'], ['web', 'lib']), ['web']);
  // Регистр и нормализация Unicode не сужают совпадение.
  assert.deepEqual(matchingPaths(['web/**'], ['WEB/a.ts']), ['WEB/a.ts']);
  assert.deepEqual(matchingPaths(['caf\u00e9/**'], ['cafe\u0301/a']), ['cafe\u0301/a']);
  // Точка и + в шаблоне — буквально.
  assert.deepEqual(matchingPaths(['a.c'], ['abc', 'a.c']), ['a.c']);
});

test('when.paths: схема отклоняет абсолютные пути, .., отрицание, классы и вложенные {}', () => {
  for (const bad of [
    '{..,x}',
    '{a,.}/b',
    '/web/**',
    'web/../x',
    '!web',
    'web/[ab]',
    'a\\b',
    'a//b',
    'a/{b,{c}}',
    '{a',
  ])
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
  // Digests примера политики — те же, что у 0.1.0-alpha.44.
  assert.equal(
    policyDigest(plain),
    'fe2c6fe7a4c099a27c1b32d2f2fd295a887abcb83ea6f8c41dd408b561e00279',
  );
  assert.equal(
    executionDigest(plain),
    '283ae58f297b00c742c2ad627c4ade43748a2e64961bf1148465aa7ca18e8aa2',
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
    '.gitattributes',
    'src/core/.gitattributes',
    '.gitmodules',
    '.lfsconfig',
    'TEST/run.js',
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
        proof: new Set(options.proof ?? []),
        // Нет зелёного SHA под тем же основанием — diff не определён.
        changedFor: (g) => ((options.never ?? []).includes(g.id) ? undefined : changed(files)),
        providersMoved: () => undefined,
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
        proof: new Set(),
        changedFor: () => changed(['src/a.ts']),
        providersMoved: () => undefined,
      }).map((d) => [d.gate.id, d.run]),
    ),
    { ui: true, unit: true },
  );
});

test('провайдеры: сдвиг базы провайдера с зелёного SHA исполняет условный gate, даже если diff потребителя не задел его путей', () => {
  const pin = (repositoryId: string, at: string, digest = 'a') => ({
    repositoryId,
    sha: sha(at),
    artifacts: [{ path: 'built.json', digest: digestOf(digest) }],
  });
  assert.equal(
    providerMovement([], undefined, undefined),
    undefined,
    'без провайдеров — нет сдвига',
  );
  assert.equal(providerMovement([], [], []), undefined);
  assert.equal(providerMovement(['lib'], [pin('lib', '1')], [pin('lib', '1')]), undefined);
  assert.match(providerMovement(['lib'], [pin('lib', '1')], [pin('lib', '2')])!, /lib.*сдвинулась/);
  assert.equal(
    providerMovement(['lib'], [pin('lib', '1')], [pin('lib', '1', 'b')]),
    undefined,
    'тот же SHA, пересобранные artifacts — не сдвиг (невоспроизводимая сборка не отключает условные gates)',
  );
  // Снимок неизвестен (запись прежней версии или провайдер добавлен) — сдвиг.
  assert.match(providerMovement(['lib'], undefined, undefined)!, /lib.*неизвестен/);
  assert.match(providerMovement(['lib'], undefined, [pin('lib', '1')])!, /lib.*неизвестен/);
  assert.match(providerMovement(['lib'], [pin('lib', '1')], [])!, /lib.*неизвестен/);
  // Транзитивный провайдер только в снимках — тоже провайдер.
  assert.match(
    providerMovement(['mid'], [pin('mid', '1'), pin('lib', '1')], [pin('mid', '1')])!,
    /lib.*неизвестен/,
  );
  // Решения: сдвиг провайдера исполняет условный gate; без зелёного SHA или
  // для gate без when функция не нужна.
  const asked: string[] = [];
  const decisions = gateDecisions({
    repo: repoOf([ui(), ui({ id: 'web' })]),
    scope: [ui(), ui({ id: 'web' })],
    proof: new Set(),
    changedFor: () => changed(['src/a.ts']),
    providersMoved: (g) => {
      asked.push(g.id);
      return g.id === 'ui' ? 'база провайдера lib сдвинулась' : undefined;
    },
  });
  assert.deepEqual(
    decisions.map((d) => [d.gate.id, d.run, d.reason, d.record === undefined]),
    [
      ['ui', true, 'база провайдера lib сдвинулась', true],
      ['web', false, 'diff не задел пути gate', false],
    ],
  );
  assert.deepEqual(asked, ['ui', 'web']);
  asked.length = 0;
  gateDecisions({
    repo: repoOf([ui()]),
    scope: [ui()],
    proof: new Set(),
    changedFor: () => undefined,
    providersMoved: (g) => (asked.push(g.id), 'x'),
  });
  assert.deepEqual(asked, [], 'без зелёного SHA сдвиг не спрашивается');
  // Без `providersMoved` вызывающий ручается за провайдеров: решает только diff
  // (так вызывает DevContour, сам ограничивая зелёные SHA теми же провайдерами).
  assert.deepEqual(
    gateDecisions({
      repo: repoOf([ui()]),
      scope: [ui()],
      proof: new Set(),
      changedFor: () => changed(['src/a.ts']),
    }).map((d) => [d.gate.id, d.run, d.reason]),
    [['ui', false, 'diff не задел пути gate']],
  );
});

test('основание gate: определение, ресурсы, окружение, подготовка, toolchain, изоляция, версия и предпосылки меняют digest', () => {
  const raw = structuredClone(example('policy')) as any;
  raw.resources = [{ id: 'port', kind: 'port', value: '4100' }];
  raw.repositories[0].gates = [
    { id: 'build', kind: 'check', command: ['node', 'b.js'], dependsOn: [] },
    {
      id: 'unit',
      kind: 'test',
      command: ['node', 't.js'],
      report: { type: 'junit', path: 'r.xml' },
      dependsOn: [],
    },
    {
      id: 'ui',
      kind: 'check',
      command: ['node', 'ui.js'],
      when: { paths: ['web/**'] },
      dependsOn: ['build'],
      resources: ['port'],
    },
  ];
  const basis = (patch: (p: any) => void = () => {}, version = '1.0.0') => {
    const copy = structuredClone(raw);
    patch(copy);
    const policy = executionPolicySchema.parse(copy);
    const repo = policy.repositories[0]!;
    return gateBasis(
      policy,
      repo,
      repo.gates.find((g) => g.id === 'ui')!,
      version,
    );
  };
  const base = basis();
  assert.equal(basis(), base, 'детерминировано');
  const variants: [string, (p: any) => void, string?][] = [
    ['определение', (p) => (p.repositories[0].gates[2].command = ['node', 'ui2.js'])],
    ['ресурс', (p) => (p.resources[0].value = '4200')],
    ['окружение политики', (p) => (p.environment = { values: { A: '1' } })],
    ['окружение репозитория', (p) => (p.repositories[0].environment = { values: { A: '1' } })],
    ['prepare', (p) => (p.repositories[0].prepare = [{ id: 'i', command: ['npm', 'ci'] }])],
    ['toolchain', (p) => (p.repositories[0].toolchain = { tools: { node: '24.3.0' } })],
    ['изоляция', (p) => (p.isolation = { mode: 'none', domains: [] })],
    ['предпосылка', (p) => (p.repositories[0].gates[0].command = ['node', 'b2.js'])],
    ['версия harness', () => {}, '2.0.0'],
  ];
  for (const [name, patch, version] of variants) assert.notEqual(basis(patch, version), base, name);
  // Не предпосылка (unit) основание не меняет.
  assert.equal(
    basis((p) => (p.repositories[0].gates[1].command = ['node', 't2.js'])),
    base,
  );
  // Режим порядка массива: более ранний check gate — предпосылка.
  const ordered = (p: any) => {
    for (const g of p.repositories[0].gates) delete g.dependsOn;
  };
  assert.notEqual(
    basis((p) => {
      ordered(p);
      p.repositories[0].gates[0].command = ['node', 'b2.js'];
    }),
    basis(ordered),
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
  // Gitlink подмодуля с ignore=all в .gitmodules виден: --ignore-submodules=none.
  write(r.dir, {
    '.gitmodules': '[submodule "lib"]\n\tpath = vendor/lib\n\turl = ./lib\n\tignore = all\n',
  });
  r.git('add', '.gitmodules');
  r.git('update-index', '--add', '--cacheinfo', `160000,${sha('1')},vendor/lib`);
  r.git('commit', '-qm', 'submodule');
  const pinned = r.head();
  r.git('update-index', '--cacheinfo', `160000,${sha('2')},vendor/lib`);
  r.git('commit', '-qm', 'bump');
  const bump = await changedPaths(r.dir, [{ from: pinned, to: r.head() }]);
  assert.deepEqual(bump.files, ['vendor/lib']);
  assert.deepEqual(matchingPaths(['vendor/lib/**'], bump.files), ['vendor/lib']);
  // Замена объекта или grafts подменяют историю: diff неполон, gate исполняется.
  r.git('replace', second, first);
  const replaced = await changedPaths(r.dir, [{ from: base, to: second }]);
  assert.equal(replaced.complete, false);
  assert.match(replaced.problem!, /refs\/replace/);
  r.git('replace', '-d', second);
  assert.equal((await changedPaths(r.dir, [{ from: base, to: second }])).complete, true);
  mkdirSync(join(r.dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(r.dir, '.git', 'info', 'grafts'), second + '\n');
  assert.equal((await changedPaths(r.dir, [{ from: base, to: second }])).complete, false);
  rmSync(join(r.dir, '.git', 'info', 'grafts'));
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
  const final = { app: sha('b') };
  // Без объединённого diff — исполнить; diff задевает путь — исполнить, хотя
  // другое поручение gate прошло; не задевает — gate покрыт.
  assert.deepEqual(uncoveredGates([repository], works), [{ repositoryId: 'app', gates: ['ui'] }]);
  assert.deepEqual(uncoveredGates([repository], works, { app: changed(['web/a.ts']) }, final), [
    { repositoryId: 'app', gates: ['ui'] },
  ]);
  assert.deepEqual(uncoveredGates([repository], works, { app: changed(['src/a.ts']) }, final), []);
  // Diff хоста, не привязанный к записи: неполный, не от её зелёного SHA или
  // с разными концами — считается отсутствующим.
  for (const bad of [
    changed(['src/a.ts'], false),
    { ...changed(['src/a.ts']), ranges: [{ from: sha('9'), to: sha('b') }] },
    {
      ...changed(['src/a.ts']),
      ranges: [
        { from: sha('a'), to: sha('b') },
        { from: sha('c'), to: sha('d') },
      ],
    },
  ])
    assert.deepEqual(uncoveredGates([repository], works, { app: bad }, final), [
      { repositoryId: 'app', gates: ['ui'] },
    ]);
  // Конец diff — не итоговый SHA или итоговый SHA не передан: отсутствует.
  assert.deepEqual(uncoveredGates([repository], works, { app: changed(['src/a.ts']) }), [
    { repositoryId: 'app', gates: ['ui'] },
  ]);
  assert.deepEqual(
    uncoveredGates([repository], works, { app: changed(['src/a.ts']) }, { app: sha('9') }),
    [{ repositoryId: 'app', gates: ['ui'] }],
  );
  // Неприменим во всех поручениях и не задет — не пробел; задет — пробел.
  const skipped = [works[0]!];
  assert.deepEqual(
    uncoveredGates([repository], skipped, { app: changed(['src/a.ts']) }, final),
    [],
  );
  assert.deepEqual(uncoveredGates([repository], skipped, { app: changed(['web/b.ts']) }, final), [
    { repositoryId: 'app', gates: ['ui'] },
  ]);
  // Решение под прежним определением gate — пробел.
  const changedGate = { ...repository, gates: [unit, ui({ when: { paths: ['web'] } })] };
  assert.deepEqual(uncoveredGates([changedGate], skipped, { app: changed(['src/a.ts']) }, final), [
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

/** Сведения о неприменимости; diff кончается на SHA фазы (`to`). */
const record = (gate: GatePolicy, to = sha('c')) => ({
  gateDigest: gateDigest(gate),
  patterns: gate.when!.paths,
  ranges: [{ from: sha('a'), to }],
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
    digest: digestOf(record(gate, at(phase))),
    summary: 'Не применим',
    notApplicable: record(gate, at(phase)),
    ...patch,
  });
  // Движок отклоняет запись неприменимости, которая выдаёт себя за PASS, —
  // под чужим определением, у gate без when или вне области.
  for (const [patch, pattern] of [
    [{ passed: true }, /не может быть PASS/],
    [{ notApplicable: { ...record(gate), gateDigest: 'e'.repeat(64) } }, /другим определением/],
    [{ gate: 'unit' }, /без when/],
    [{ kind: 'test' }, /только у записи вида not-applicable/],
    [{ sha: sha('b') }, /не относится к SHA фазы/],
    [{ notApplicable: record(gate, sha('b')) }, /не относится к SHA фазы/],
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
      digest: digestOf(record(gate, at)),
      summary: 'Не применим',
      notApplicable: record(gate, at),
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

test('приёмка: неприменимость не заменяет исход gate, исполненного на том же SHA', () => {
  const policy = conditionalPolicy();
  const gate = policy.repositories[0]!.gates.find((g) => g.id === 'ui')!;
  const { engine: e, store, a } = claimed(policy);
  const at = (phase: 'candidate' | 'integration') => sha(phase === 'candidate' ? 'c' : 'b');
  const run = (phase: 'candidate' | 'integration', gid: string, passed: boolean) =>
    e.evidence(a.id, a.token, {
      kind: gid === 'independent-review' ? 'review' : 'test',
      phase,
      sha: at(phase),
      gate: gid,
      passed,
      command: ['x'],
      exitCode: passed ? 0 : 1,
      log: '',
      digest: digestOf(gid + phase + passed),
      summary: passed ? 'ok' : 'fail',
    });
  run('candidate', 'ui', false);
  assert.throws(
    () =>
      e.evidence(a.id, a.token, {
        kind: 'not-applicable',
        phase: 'candidate',
        sha: at('candidate'),
        gate: 'ui',
        passed: false,
        command: [],
        exitCode: -1,
        log: '',
        digest: digestOf('na'),
        summary: 'Не применим',
        notApplicable: record(gate, at('candidate')),
      }),
    /уже исполнялся на этом SHA/,
  );
  for (const phase of ['candidate', 'integration'] as const) {
    run(phase, 'unit', true);
    run(phase, 'independent-review', true);
  }
  run('integration', 'ui', true);
  // Решает исход исполнения (FAIL кандидата), а не отсутствие записи.
  assert.throws(() => e.finish(a.id, a.token, sha('b')), /Нет PASS: candidate\/ui$/);
  store.close();
});

/** Коммит в target ref мимо harness: файл поверх текущей головы (без checkout). */
function externalCommit(r: ReturnType<typeof repo>, ref: string, path: string, text: string) {
  const index = join(mkdtempSync(join(tmpdir(), 'harness-index-')), 'index');
  const run = (args: string[], input?: string) =>
    execFileSync('git', args, {
      cwd: r.dir,
      encoding: 'utf8',
      input,
      env: {
        ...process.env,
        GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  const head = run(['rev-parse', ref]);
  run(['read-tree', head]);
  const blob = run(['hash-object', '-w', '--stdin'], text);
  run(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
  const commit = run(['commit-tree', run(['write-tree']), '-p', head, '-m', 'external ' + path]);
  run(['update-ref', ref, commit, head]);
}

test('runner: решение от последнего зелёного SHA по diff Git — правка target мимо harness и задача с суженной областью исполняют gate', async () => {
  const tasks: [string, Record<string, string>, string[]][] = [
    ['t1', { 'src/greet.js': greet }, ['unit', 'ui']],
    ['t2', { 'src/a.js': 'exports.a = 1;\n' }, ['unit', 'ui']],
    ['t3', { 'src/b.js': 'exports.b = 1;\n' }, ['unit', 'ui']],
    ['t4', { 'src/c.js': 'exports.c = 1;\n' }, ['unit', 'ui']],
    ['t5', { 'web/n.js': 'exports.n = 1;\n' }, ['unit']],
    ['t6', { 'src/d.js': 'exports.d = 1;\n' }, ['unit', 'ui']],
    ['t7', { 'src/e.js': 'exports.e = 1;\n' }, ['unit', 'ui']],
  ];
  const ref = () => ctx.policy.repositories[0]!.targetRef;
  const ctx: ReturnType<typeof setup> = setup({
    scenario: { writer: tasks.map(([, files]) => implement(files)), reviewer: approve() },
    policy: (p: any) => {
      p.repositories[0].gates.push({
        id: 'ui',
        kind: 'check',
        command: nodeGate('process.exit(0)'),
        when: { paths: ['web/**'] },
      });
    },
    // Пока t2 пишет кандидата, в target попадает правка web/: кандидат её
    // не видит (gate неприменим), интеграция видит (gate исполняется).
    runner: {
      hooks: {
        implemented: ({ attempt }) => {
          if (attempt.workId === 't2') externalCommit(ctx.repo, ref(), 'web/during.js', '1\n');
        },
      },
    },
    graph: (g: any) => {
      const base = g.orders[0];
      g.orders = tasks.slice(0, 3).map(([id, , gates], i) => ({
        ...structuredClone(base),
        id,
        source: { ...base.source, ref: id },
        title: 'Задача ' + id,
        writeScope: ['src', 'web'],
        gates,
        dependsOn: i ? [tasks[i - 1]![0]] : [],
      }));
    },
  });
  await runAll(ctx);
  // Правка web/ мимо harness после t3; вторая доска: t4 — только src/, t5
  // (суженная область без ui) правит web/, t6 и t7 — только src/.
  externalCommit(ctx.repo, ref(), 'web/outside.js', '2\n');
  const first = ctx.graph as any;
  const outsideCheck = structuredClone(first);
  outsideCheck.id = 'g2';
  outsideCheck.source = { ...first.source, ref: 'g2' };
  outsideCheck.orders = tasks.slice(3).map(([id, , gates], i) => ({
    ...structuredClone(first.orders[0]),
    id,
    source: { ...first.orders[0].source, ref: id },
    title: 'Задача ' + id,
    writeScope: ['src', 'web'],
    gates,
    dependsOn: i ? [tasks[3 + i - 1]![0]] : [],
  }));
  ctx.graph = workGraphSchema.parse(outsideCheck);
  await runAll(ctx);
  const outcome = ctx.engine.read((v) =>
    Object.fromEntries(
      tasks.map(([id]) => {
        const attempt = v.attempts(id).find((x) => x.status === 'succeeded');
        return [
          id,
          [
            v.work(id)?.status,
            ...(['candidate', 'integration'] as const).map(
              (phase) =>
                attempt?.evidence.findLast((e) => e.gate === 'ui' && e.phase === phase)?.kind ??
                '-',
            ),
          ],
        ];
      }),
    ),
  );
  assert.deepEqual(outcome, {
    // Зелёного SHA под этим основанием ещё нет — исполняется.
    t1: ['done', 'test', 'test'],
    // Кандидат не задел web/, интеграция принесла web/during.js.
    t2: ['done', 'not-applicable', 'test'],
    t3: ['done', 'not-applicable', 'not-applicable'],
    // Правка web/ мимо harness — между зелёным SHA (t2) и базой.
    t4: ['done', 'test', 'test'],
    t5: ['done', '-', '-'],
    // Правка web/ задачей без ui в области — между зелёным SHA (t4) и базой.
    t6: ['done', 'test', 'test'],
    t7: ['done', 'not-applicable', 'not-applicable'],
  });
  const attemptOf = (id: string) =>
    ctx.engine.read((v) => v.attempts(id).find((x) => x.status === 'succeeded')!);
  const t1 = attemptOf('t1');
  const t3 = attemptOf('t3');
  const t6 = attemptOf('t6');
  const t7 = attemptOf('t7');
  assert.ok(
    t1.evidence.some((e) => e.gate === 'ui' && e.kind === 'test' && e.gateBasis),
    'исполненный условный gate несёт основание',
  );
  // Diff t3 — от зелёного SHA t2 (интеграция), а не от базы t3.
  const skip3 = t3.evidence.find((e) => e.kind === 'not-applicable' && e.phase === 'integration')!;
  assert.deepEqual(
    skip3.notApplicable!.ranges.map((r) => [r.from, r.to]),
    [
      [attemptOf('t2').integrationSha, t3.candidateSha],
      [attemptOf('t2').integrationSha, t3.integrationSha],
    ],
  );
  assert.deepEqual(skip3.notApplicable!.files, ['src/b.js']);
  const skip7 = t7.evidence.find((e) => e.kind === 'not-applicable' && e.phase === 'integration')!;
  assert.equal(skip7.notApplicable!.ranges[0]!.from, t6.integrationSha);
  // Receipt принятой попытки с неприменимым gate принимает получатель с той же политикой.
  const order = ctx.engine.read((v) => v.work('t7')!.order);
  assert.deepEqual(
    resultProblems(runResult(t7, '0.1.0-test'), {
      order,
      graphId: 'g2',
      contracts: [],
      policy: ctx.policy,
      contextDigest: null,
    }),
    [],
  );
  // Покрытие набора: объединённый diff, собранный harness от зелёных SHA
  // записей неприменимости до итогового SHA.
  const final = ctx.repo.git('rev-parse', ref());
  const evidence = [t3, t7].flatMap((a) => a.evidence);
  const union = await coverageChanges(ctx.repo.dir, evidence, final);
  assert.equal(union.complete, true);
  const works = [t3, t7].map((a) => ({
    repositoryId: 'app',
    resultSha: a.integrationSha,
    evidence: a.evidence,
  }));
  // От зелёного SHA t3 (t2) до итога задет web/ — gate непокрыт.
  assert.deepEqual(uncoveredGates(ctx.policy.repositories, works, { app: union }, { app: final }), [
    { repositoryId: 'app', gates: ['ui'] },
  ]);
  // Только t7: от его зелёного SHA (t6) web/ не задет — покрыт.
  const only7 = await coverageChanges(ctx.repo.dir, t7.evidence, final);
  assert.deepEqual(
    uncoveredGates(ctx.policy.repositories, [works[1]!], { app: only7 }, { app: final }),
    [],
  );
  // Diff хоста не от зелёного SHA t3 (от базы t7) — считается отсутствующим.
  assert.deepEqual(uncoveredGates(ctx.policy.repositories, works, { app: only7 }, { app: final }), [
    { repositoryId: 'app', gates: ['ui'] },
  ]);
  ctx.store.close();
});

test('runner: смена версии harness меняет основание — условный gate исполняется заново', async () => {
  const files = (name: string) => ({ ['src/' + name + '.js']: 'exports.x = 1;\n' });
  const tasks: [string, Record<string, string>][] = [
    ['v1', { 'src/greet.js': greet }],
    ['v2', files('a')],
    ['v3', files('b')],
    ['v4', files('c')],
  ];
  const orders = (g: any, list: typeof tasks, base: any) =>
    list.map(([id], i) => ({
      ...structuredClone(base),
      id,
      source: { ...base.source, ref: id },
      title: 'Задача ' + id,
      writeScope: ['src', 'web'],
      gates: ['unit', 'ui'],
      dependsOn: i ? [list[i - 1]![0]] : [],
    }));
  const ctx = setup({
    scenario: { writer: tasks.map(([, f]) => implement(f)), reviewer: approve() },
    policy: (p: any) => {
      p.repositories[0].gates.push({
        id: 'ui',
        kind: 'check',
        command: nodeGate('process.exit(0)'),
        when: { paths: ['web/**'] },
      });
    },
    graph: (g: any) => {
      g.orders = orders(g, tasks.slice(0, 2), g.orders[0]);
    },
  });
  await runAll(ctx);
  ctx.runner.release();
  // Тот же store и политика, другая версия harness.
  const engine = new Engine({
    host: standaloneHost(ctx.store, ctx.policy),
    policy: ctx.policy,
    version: '9.9.9-test',
  });
  const runner = new Runner({
    engine,
    stateDir: ctx.state,
    baseDir: ctx.repo.dir,
    adapters: {
      claude: cliAdapter('claude', {
        executable: bin('fake-claude'),
        toolProfiles: ctx.policy.toolProfiles,
      }),
      codex: cliAdapter('codex', {
        executable: bin('fake-codex'),
        toolProfiles: ctx.policy.toolProfiles,
      }),
    },
    owner: 'runner-2',
    resourceDatabase: join(ctx.state, 'resources.sqlite'),
  });
  const first = ctx.graph as any;
  const next = structuredClone(first);
  next.id = 'g2';
  next.source = { ...first.source, ref: 'g2' };
  next.orders = orders(next, tasks.slice(2), first.orders[0]);
  await runAll({ ...ctx, engine, runner, graph: workGraphSchema.parse(next) });
  const kinds = engine.read((v) =>
    Object.fromEntries(
      tasks.map(([id]) => {
        const a = v.attempts(id).find((x) => x.status === 'succeeded');
        return [
          id,
          (['candidate', 'integration'] as const).map(
            (phase) => a?.evidence.findLast((e) => e.gate === 'ui' && e.phase === phase)?.kind,
          ),
        ];
      }),
    ),
  );
  assert.deepEqual(kinds, {
    v1: ['test', 'test'],
    v2: ['not-applicable', 'not-applicable'],
    // Зелёный SHA прежней версии harness — другое основание.
    v3: ['test', 'test'],
    v4: ['not-applicable', 'not-applicable'],
  });
  ctx.store.close();
});

test('runner: сдвиг базы провайдера с зелёного SHA исполняет условный gate потребителя; без сдвига — неприменим', async () => {
  const tasks: [string, string][] = [
    ['p1', 'src/a.js'],
    ['p2', 'src/b.js'],
    ['p3', 'src/c.js'],
    ['p4', 'src/d.js'],
  ];
  const ctx = components({
    scenario: {
      writer: tasks.map(([, file]) => implement({ [file]: 'exports.x = 1;\n' })),
      reviewer: approve(),
    },
    policy: (p) => {
      p.repositories.find((r: any) => r.id === 'product').gates = [
        {
          id: 'unit',
          kind: 'test',
          command: [process.execPath, 'unit.js'],
          report: { type: 'junit', path: 'reports/unit.xml' },
        },
        {
          id: 'ui',
          kind: 'check',
          command: nodeGate('process.exit(0)'),
          when: { paths: ['web/**'] },
        },
      ];
    },
  });
  const orders = (base: any, list: typeof tasks) =>
    list.map(([id], i) => ({
      ...structuredClone(base),
      id,
      repositoryId: 'product',
      source: { ...base.source, ref: id },
      title: 'Задача ' + id,
      writeScope: ['src'],
      gates: ['unit', 'ui'],
      dependsOn: i ? [list[i - 1]![0]] : [],
    }));
  const raw = structuredClone(ctx.graph) as any;
  const base = raw.orders[0];
  delete base.consumers;
  const graph = (id: string, list: typeof tasks) =>
    workGraphSchema.parse({
      ...raw,
      id,
      source: { ...raw.source, ref: id },
      orders: orders(base, list),
    });
  await runAll({ ...ctx, graph: graph('g1', tasks.slice(0, 2)) } as any);
  // Библиотека продвигается мимо harness: diff продукта её не видит.
  const library = ctx.repos.library!;
  const ref = ctx.policy.repositories.find((r) => r.id === 'library')!.targetRef;
  externalCommit(library, ref, 'value.json', '3\n');
  await runAll({ ...ctx, graph: graph('g2', tasks.slice(2)) } as any);
  const kinds = ctx.engine.read((v) =>
    Object.fromEntries(
      tasks.map(([id]) => {
        const a = v.attempts(id).find((x) => x.status === 'succeeded');
        return [
          id,
          (['candidate', 'integration'] as const).map(
            (phase) => a?.evidence.findLast((e) => e.gate === 'ui' && e.phase === phase)?.kind,
          ),
        ];
      }),
    ),
  );
  assert.deepEqual(kinds, {
    // Зелёного SHA ещё нет.
    p1: ['test', 'test'],
    p2: ['not-applicable', 'not-applicable'],
    // Библиотека сдвинулась с зелёного SHA (p1).
    p3: ['test', 'test'],
    // Зелёный SHA p3 — под той же базой библиотеки.
    p4: ['not-applicable', 'not-applicable'],
  });
  // Почему p3 исполнял gate: его diff от зелёного SHA (p1) web/ не задевает и
  // неявных входов не несёт — исполнение дал только сдвиг библиотеки.
  const attemptOf = (id: string) =>
    ctx.engine.read((v) => v.attempts(id).find((x) => x.status === 'succeeded')!);
  const [p1, p2, p3, p4] = ['p1', 'p2', 'p3', 'p4'].map(attemptOf);
  const product = ctx.policy.repositories.find((r) => r.id === 'product')!;
  const uiGate = product.gates.find((g) => g.id === 'ui')!;
  const p3Diff = await changedPaths(ctx.repos.product!.dir, [
    { from: p1!.integrationSha!, to: p3!.candidateSha! },
    { from: p1!.integrationSha!, to: p3!.integrationSha! },
  ]);
  assert.equal(pathApplicability(product, uiGate, p3Diff).applies, false);
  assert.match(
    providerMovement(product.dependsOn, p1!.dependencies, p3!.dependencies)!,
    /база провайдера library сдвинулась/,
  );
  assert.equal(providerMovement(product.dependsOn, p1!.dependencies, p2!.dependencies), undefined);
  assert.equal(providerMovement(product.dependsOn, p3!.dependencies, p4!.dependencies), undefined);
  ctx.store.close();
});
