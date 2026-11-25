/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
 * Фикстура правит сырой JSON политики и графа.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivedApplicabilityOn,
  gateSchema,
  integrationReuseOn,
  policyIssues,
  sha256,
  type GatePolicy,
} from '../src/contracts/index.ts';
import {
  conditionalGate,
  derivationAllowed,
  derivedRecordChecks,
  gateDecisions,
  notApplicableProblem,
  pathApplicability,
  type ChangedPaths,
  type GateCondition,
} from '../src/verification/applicability.ts';
import { uncoveredGates } from '../src/verification/proof.ts';
import {
  escapesPackage,
  packageBinding,
  packageClosure,
  pnpmWorkspacePatterns,
  workspaceGraphAt,
  type WorkspacePackage,
} from '../src/verification/workspace-graph.ts';
import { approve, greet, implement, runAll, setup } from './runner-fixture.ts';
import { repo, write } from './git-fixture.ts';
import { executionPolicySchema } from '../src/contracts/index.ts';
import { example } from './fixtures.ts';

const gate = (patch: Record<string, unknown>): GatePolicy =>
  gateSchema.parse({ id: 'g', kind: 'check', command: ['true'], ...patch });

test('packageBinding: --filter, -F, -C, npm -w, yarn workspace и cwd; неизвестное — undefined', () => {
  const b = (command: string[], cwd?: string) =>
    packageBinding({ command, ...(cwd ? { cwd } : {}) });
  assert.deepEqual(b(['pnpm', '--filter', '@oim/web', 'run', 'build']), [{ name: '@oim/web' }]);
  assert.deepEqual(b(['pnpm', '-F', 'web...', 'build']), [{ name: 'web' }]);
  // Фильтр каталога pnpm — все проекты под ним (ревью B, L3).
  assert.deepEqual(b(['pnpm', '--filter=./apps/web', 'lint']), [{ under: 'apps/web' }]);
  assert.deepEqual(b(['pnpm', '--filter', '{./packages/a}', 'test']), [{ under: 'packages/a' }]);
  assert.deepEqual(b(['pnpm', '-C', 'apps/admin', 'run', 'build']), [{ dir: 'apps/admin' }]);
  assert.deepEqual(b(['npm', '--workspace', '@a/b', 'run', 'test']), [{ name: '@a/b' }]);
  assert.deepEqual(b(['npm', '-w', 'packages/x', 'test']), [{ dir: 'packages/x' }]);
  assert.deepEqual(b(['yarn', 'workspace', 'api', 'build']), [{ name: 'api' }]);
  assert.deepEqual(b(['pnpm', 'run', 'test'], 'apps/web'), [{ dir: 'apps/web' }], 'cwd у pnpm');
  assert.deepEqual(
    b(['env', 'CI=1', 'pnpm', '--filter', 'api', 'test']),
    [{ name: 'api' }],
    'ведущий env пропускается',
  );
  // Неизвестно: зависимые, шаблоны, весь workspace, корень, выход за корень.
  for (const command of [
    ['pnpm', '--filter', '...web', 'build'],
    ['pnpm', '--filter', '@oim/*', 'build'],
    ['pnpm', '--filter', 'web^...', 'build'],
    ['pnpm', '-r', 'build'],
    ['pnpm', '--filter', 'web', '-w', 'build'],
    ['pnpm', 'run', 'env:check'],
    ['npm', '--workspaces', 'test'],
    ['npm', 'test'],
    ['node', 'scripts/check.mjs'],
    // Ревью B, H2/M1: выход за пакет и непрозрачные программы.
    ['pnpm', '-C', '../..', 'test'],
    ['pnpm', '--filter', 'api', 'exec', 'vitest', '--root', '..', 'run'],
    ['pnpm', 'exec', 'turbo', 'run', 'test'],
    ['pnpm', 'exec', 'sh', '-c', 'cd ../.. && pnpm -r test'],
  ])
    assert.equal(b(command), undefined, command.join(' '));
  assert.equal(b(['node', 'x.js'], '.'), undefined);
  // cwd — только у менеджера пакетов (ревью B, M1).
  for (const command of [
    ['node', '--test', 'test/**/*.test.mjs'],
    ['sh', '-c', 'cd ../.. && pnpm -r test'],
    ['make', 'test'],
    ['turbo', 'run', 'test'],
    ['nx', 'test', 'web'],
    ['npx', 'vitest', 'run'],
  ])
    assert.equal(b(command, 'packages/a'), undefined, 'cwd: ' + command.join(' '));
});

test('pnpmWorkspacePatterns: список, строка [a, b], кавычки и комментарии; не разобрать — undefined', () => {
  assert.deepEqual(
    pnpmWorkspacePatterns(
      'packages:\n  - "apps/*"\n  - \'packages/*\' # libs\n  - "!packages/old"\nallowBuilds:\n  x: true\n',
    ),
    ['apps/*', 'packages/*', '!packages/old'],
  );
  assert.deepEqual(pnpmWorkspacePatterns('packages: [apps/*, "libs/**"]\n'), ['apps/*', 'libs/**']);
  assert.equal(pnpmWorkspacePatterns('catalog:\n  a: 1\n'), undefined);
  assert.equal(pnpmWorkspacePatterns('packages:\n  apps: x\n'), undefined);
});

const pkg = (dir: string, name: string, deps: string[] = [], scripts = {}): WorkspacePackage => ({
  dir,
  name,
  dependencies: deps,
  scripts,
});
const graph = [
  pkg('packages/a', 'a'),
  pkg('packages/b', 'b', ['a', 'left-pad']),
  pkg('packages/c', 'c'),
  pkg('apps/web', '@x/web', ['b']),
  pkg('apps/tool', 'tool', [], { build: 'node ../../scripts/build.mjs' }),
];

test('packageClosure: пакет и его зависимости в workspace транзитивно; не найден, script за пакетом и предел — причина', () => {
  assert.deepEqual(packageClosure(graph, [{ name: '@x/web' }], 64), {
    ok: true,
    packages: ['@x/web'],
    dirs: ['apps/web', 'packages/a', 'packages/b'],
  });
  // Каталог gate внутри пакета — этот пакет.
  assert.deepEqual(packageClosure(graph, [{ dir: 'packages/c/test' }], 64), {
    ok: true,
    packages: ['c'],
    dirs: ['packages/c'],
  });
  assert.match(
    (packageClosure(graph, [{ name: 'missing' }], 64) as { reason: string }).reason,
    /не найден/,
  );
  assert.match(
    (packageClosure(graph, [{ dir: 'scripts' }], 64) as { reason: string }).reason,
    /не найден/,
  );
  assert.match(
    (packageClosure(graph, [{ name: 'tool' }], 64) as { reason: string }).reason,
    /выходит за его каталог/,
  );
  assert.match(
    (packageClosure(graph, [{ name: '@x/web' }], 2) as { reason: string }).reason,
    /больше 2/,
  );
});

const changed = (files: string[]): ChangedPaths => ({
  ranges: [{ from: 'a'.repeat(40), to: 'b'.repeat(40) }],
  files,
  complete: true,
});
const webGate = gate({ id: 'web-build', command: ['pnpm', '--filter', '@x/web', 'run', 'build'] });
const webCondition: GateCondition = {
  paths: ['apps/web', 'packages/a', 'packages/b'],
  derived: { packages: ['@x/web'] },
};
const repoOf = { protectedPaths: ['.github/'] };
const unitGate = gate({ id: 'unit', kind: 'test', report: { type: 'junit', path: 'r.xml' } });

test('применимость по умолчанию: нетронутый пакет — not-applicable с путями; зависимость, lockfile, манифест и файл корня — исполняется', () => {
  const skip = pathApplicability(
    repoOf,
    webGate,
    changed(['packages/c/x.ts', 'docs/a.md', 'README.md']),
    webCondition,
  );
  assert.equal(skip.applies, false);
  assert.deepEqual(!skip.applies && skip.record.patterns, webCondition.paths);
  assert.deepEqual(!skip.applies && skip.record.derived, { packages: ['@x/web'] });
  for (const [file, reason] of [
    ['packages/a/src/index.ts', /изменён пакет gate: packages\/a/],
    ['apps/web/page.tsx', /изменён пакет gate/],
    ['pnpm-lock.yaml', /неявный вход gate: pnpm-lock.yaml/],
    ['packages/c/package.json', /неявный вход/],
    ['tsconfig.base.json', /неявный вход gate: tsconfig.base.json/],
    ['.harness/policy.json', /неявный вход/],
    ['.github/workflows/ci.yml', /неявный вход/],
  ] as const) {
    const d = pathApplicability(repoOf, webGate, changed(['packages/c/x.ts', file]), webCondition);
    assert.ok(d.applies, file);
    assert.match(d.applies ? d.reason : '', reason);
  }
  // Файл корня — неявный вход только применимости по умолчанию, не when.paths.
  const explicit = gate({ id: 'docs', when: { paths: ['docs/**'] } });
  assert.equal(pathApplicability(repoOf, explicit, changed(['tsconfig.base.json'])).applies, false);
});

test('применимость по умолчанию: явный when.paths перекрывает, when.always и gate без привязки исполняются всегда', () => {
  const unit = gate({ id: 'unit', kind: 'test', report: { type: 'junit', path: 'r.xml' } });
  const explicit = gate({
    id: 'web-docs',
    command: ['pnpm', '--filter', '@x/web', 'run', 'docs'],
    when: { paths: ['docs/**'] },
  });
  const always = gate({
    id: 'web-e2e',
    command: ['pnpm', '--filter', '@x/web', 'run', 'e2e'],
    when: { always: true },
  });
  const root = gate({ id: 'env-check', command: ['pnpm', 'run', 'env:check'] });
  // Явный граф (dependsOn: []): более ранние check gates — не предпосылки.
  const gates = [unit, webGate, explicit, always, root].map((g) => ({ ...g, dependsOn: [] }));
  assert.equal(derivationAllowed(gates, webGate, true), true);
  assert.equal(derivationAllowed(gates, explicit, true), false, 'явный when.paths — свои пути');
  assert.equal(derivationAllowed(gates, always, true), false);
  assert.equal(derivationAllowed(gates, root, true), false, 'привязка неизвестна');
  assert.equal(conditionalGate(gates, explicit, true), true);
  assert.equal(conditionalGate(gates, always, true), false);
  // Решения области: без условия — исполняется; явное — по своим путям.
  const conditions = new Map<string, GateCondition>([
    ['web-build', webCondition],
    ['web-docs', { paths: ['docs/**'] }],
  ]);
  const decisions = gateDecisions({
    repo: { gates, protectedPaths: [] },
    scope: gates,
    proof: new Set(),
    changedFor: () => changed(['packages/c/x.ts']),
    conditionFor: (g) => conditions.get(g.id),
  });
  assert.deepEqual(
    decisions.map((d) => [d.gate.id, d.run]),
    [
      ['unit', true],
      ['web-build', false],
      ['web-docs', false],
      ['web-e2e', true],
      ['env-check', true],
    ],
  );
  assert.match(decisions[1]!.reason, /не задел пакеты gate: apps\/web, packages\/a, packages\/b/);
  assert.equal(decisions[2]!.record?.derived, undefined, 'явное условие — без derived');
  // Единственный test gate пакета не становится условным: test gate без when остаётся.
  const onlyTest = gate({
    id: 'web-test',
    kind: 'test',
    report: { type: 'junit', path: 'r.xml' },
    command: ['pnpm', '--filter', '@x/web', 'test'],
  });
  assert.equal(derivationAllowed([onlyTest, webGate], onlyTest, true), false);
  assert.equal(derivationAllowed([onlyTest, unit], onlyTest, true), true);
  // Схема: when.always допустим, test gate с when.always считается безусловным.
  const policy = structuredClone(example('policy')) as any;
  policy.repositories[0].gates[0].when = { always: true };
  assert.deepEqual(
    policyIssues(executionPolicySchema.parse(policy)).filter((i) =>
      /test gate без when/.test(i.message),
    ),
    [],
  );
});

test('приёмка: запись derived закрывает gate пакета; у when.always и gate без привязки — отказ', () => {
  const unit = gate({ id: 'unit', kind: 'test', report: { type: 'junit', path: 'r.xml' } });
  const always = gate({ ...webGate, id: 'web-e2e', when: { always: true } });
  const root = gate({ id: 'env-check', command: ['pnpm', 'run', 'env:check'] });
  const gates = [unit, webGate, always, root];
  const skip = pathApplicability(repoOf, webGate, changed(['packages/c/x.ts']), webCondition);
  assert.ok(!skip.applies);
  const record = { notApplicable: !skip.applies ? skip.record : undefined };
  assert.equal(
    notApplicableProblem({
      gates,
      gate: 'web-build',
      record,
      proof: new Set(),
      ran: [],
      derived: true,
    }),
    undefined,
  );
  assert.match(
    notApplicableProblem({
      gates,
      gate: 'web-e2e',
      record,
      proof: new Set(),
      ran: [],
      derived: true,
    }) ?? '',
    /без when не бывает неприменимым/,
  );
  assert.match(
    notApplicableProblem({
      gates,
      gate: 'env-check',
      record,
      proof: new Set(),
      ran: [],
      derived: true,
    }) ?? '',
    /не привязан к пакету workspace/,
  );
  // Запись без derived у gate без when.paths — прежний отказ.
  const plain = { ...record.notApplicable! };
  delete plain.derived;
  assert.match(
    notApplicableProblem({
      gates,
      gate: 'web-build',
      record: { notApplicable: plain },
      proof: new Set(),
      ran: [],
      derived: true,
    }) ?? '',
    /без when не бывает неприменимым/,
  );
  // Покрытие набора: объединённый diff задел зависимость — gate непокрыт; нет — покрыт.
  const works = [
    {
      repositoryId: 'app',
      resultSha: 'b'.repeat(40),
      evidence: [
        {
          kind: 'not-applicable',
          phase: 'integration',
          sha: 'b'.repeat(40),
          gate: 'web-build',
          passed: false,
          notApplicable: record.notApplicable!,
        },
        ...['unit', 'web-e2e', 'env-check'].map((g) => ({
          kind: 'test',
          phase: 'integration',
          sha: 'b'.repeat(40),
          gate: g,
          passed: true,
        })),
      ],
    },
  ] as Parameters<typeof uncoveredGates>[1];
  const repos = [{ id: 'app', gates, protectedPaths: [] }];
  const union = (files: string[]) => ({
    app: { ranges: [{ from: 'a'.repeat(40), to: 'c'.repeat(40) }], files, complete: true },
  });
  assert.deepEqual(
    uncoveredGates(
      repos,
      works,
      union(['packages/c/y.ts']),
      { app: 'c'.repeat(40) },
      { derived: true },
    ),
    [],
  );
  assert.deepEqual(
    uncoveredGates(
      repos,
      works,
      union(['packages/a/y.ts']),
      { app: 'c'.repeat(40) },
      { derived: true },
    ),
    [{ repositoryId: 'app', gates: ['web-build'] }],
  );
});

test('workspaceGraphAt: граф из объектов Git на SHA, не из рабочего дерева; без workspace — причина', async () => {
  const r = repo({
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "!packages/old"\n',
    'package.json': '{"name":"root","private":true}\n',
    'packages/a/package.json': '{"name":"a"}\n',
    'packages/b/package.json': '{"name":"b","devDependencies":{"a":"workspace:*"}}\n',
    'packages/old/package.json': '{"name":"old"}\n',
    'packages/b/node_modules/x/package.json': '{"name":"x"}\n',
  });
  const head = r.git('rev-parse', 'HEAD');
  const g = await workspaceGraphAt(r.dir, head);
  assert.ok(Array.isArray(g), JSON.stringify(g));
  assert.deepEqual(
    g.map((p) => [p.dir, p.name, p.dependencies]),
    [
      ['packages/a', 'a', []],
      ['packages/b', 'b', ['a']],
    ],
  );
  const plain = repo({ 'package.json': '{"name":"root"}\n' });
  assert.match(
    JSON.stringify(await workspaceGraphAt(plain.dir, plain.git('rev-parse', 'HEAD'))),
    /нет workspace/,
  );
  // npm workspaces в корневом package.json.
  const npm = repo({
    'package.json': '{"name":"root","workspaces":["libs/*"]}\n',
    'libs/x/package.json': '{"name":"x"}\n',
  });
  const n = await workspaceGraphAt(npm.dir, npm.git('rev-parse', 'HEAD'));
  assert.deepEqual(Array.isArray(n) && n.map((p) => p.dir), ['libs/x']);
});

/**
 * Runner на настоящем workspace: gate-b (cwd packages/b, зависит от a),
 * gate-c (cwd packages/c), gate-c-docs (cwd packages/c, явный when.paths
 * docs/**), gate-always (cwd packages/c, when.always) и корневой unit.
 */
test('runner: gate пакета не исполняется, когда diff не задел пакет и зависимости; зависимость и lockfile исполняют; явный when.paths и always перекрывают', async () => {
  const tasks: [string, Record<string, string>][] = [
    ['t1', { 'packages/b/x.js': '1\n' }],
    ['t2', { 'packages/c/x.js': '2\n' }],
    ['t3', { 'packages/a/x.js': '3\n' }],
    ['t4', { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }],
  ];
  const check = (id: string, extra: Record<string, unknown>) => ({
    id,
    kind: 'check',
    // Привязка по cwd — только у менеджера пакетов (ревью B, M1).
    command: ['npm', 'run', '--silent', 'check'],
    // Явный граф: более ранние check gates — не предпосылки (иначе gate-always
    // исполнял бы их всегда).
    dependsOn: [],
    ...extra,
  });
  const ctx = setup({
    files: {
      'src/greet.js': greet,
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
      'package.json': '{"name":"root","private":true}\n',
      'packages/a/package.json': '{"name":"a","scripts":{"check":"node -e 0"}}\n',
      'packages/b/package.json':
        '{"name":"b","dependencies":{"a":"workspace:*"},"scripts":{"check":"node -e 0"}}\n',
      'packages/c/package.json': '{"name":"c","scripts":{"check":"node -e 0"}}\n',
    },
    scenario: { writer: tasks.map(([, files]) => implement(files)), reviewer: approve() },
    policy: (p: any) => {
      p.harnessMode = 'light';
      p.integrationReuse = 'off';
      p.repositories[0].gates.push(
        check('gate-b', { cwd: 'packages/b' }),
        check('gate-c', { cwd: 'packages/c' }),
        check('gate-c-docs', { cwd: 'packages/c', when: { paths: ['docs/**'] } }),
        check('gate-always', { cwd: 'packages/c', when: { always: true } }),
      );
    },
    graph: (g: any) => {
      const base = g.orders[0];
      g.orders = tasks.map(([id], i) => ({
        ...structuredClone(base),
        id,
        source: { ...base.source, ref: id },
        title: 'Задача ' + id,
        writeScope: ['packages', 'pnpm-lock.yaml'],
        gates: ['unit', 'gate-b', 'gate-c', 'gate-c-docs', 'gate-always'],
        dependsOn: i ? [tasks[i - 1]![0]] : [],
      }));
    },
  });
  await runAll(ctx);
  const outcome = ctx.engine.read((v) =>
    Object.fromEntries(
      tasks.map(([id]) => {
        const a = v.attempts(id).find((x) => x.status === 'succeeded');
        const kinds = (gateId: string) =>
          (['candidate', 'integration'] as const)
            .map((phase) => {
              const e = a?.evidence.findLast((x) => x.gate === gateId && x.phase === phase);
              return e?.kind === 'not-applicable' ? 'na' : e ? 'run' : '-';
            })
            .join('/');
        return [
          id,
          [
            v.work(id)?.status,
            ...['unit', 'gate-b', 'gate-c', 'gate-c-docs', 'gate-always'].map(kinds),
          ],
        ];
      }),
    ),
  );
  assert.deepEqual(outcome, {
    // Зелёного SHA ещё нет — исполняется всё.
    t1: ['done', 'run/run', 'run/run', 'run/run', 'run/run', 'run/run'],
    // packages/c: gate-b неприменим (нетронуты b и a), gate-c исполняется,
    // явный when.paths docs/** — неприменим, always — исполняется.
    t2: ['done', 'run/run', 'na/na', 'run/run', 'na/na', 'run/run'],
    // packages/a — зависимость b: gate-b исполняется, gate-c неприменим.
    t3: ['done', 'run/run', 'run/run', 'na/na', 'na/na', 'run/run'],
    // lockfile — неявный вход: исполняется всё.
    t4: ['done', 'run/run', 'run/run', 'run/run', 'run/run', 'run/run'],
  });
  const t2 = ctx.engine.read((v) => v.attempts('t2').find((x) => x.status === 'succeeded')!);
  const skip = t2.evidence.find((e) => e.gate === 'gate-b' && e.kind === 'not-applicable')!;
  assert.deepEqual(skip.notApplicable!.patterns, ['packages/a', 'packages/b']);
  assert.deepEqual(skip.notApplicable!.derived, { packages: ['b'] });
  assert.match(skip.summary, /не задел пакеты gate в workspace \(packages\/a, packages\/b\)/);
  const docs = t2.evidence.find((e) => e.gate === 'gate-c-docs' && e.kind === 'not-applicable')!;
  assert.equal(docs.notApplicable!.derived, undefined);
  ctx.store.close();
});

test('doctor: GATE_ALWAYS_RUNS — gate корня без when.paths и when.always исполняется в каждой попытке; пакет, when и always — без заметки', async () => {
  const { doctor, alwaysRunsNotes } = await import('../src/control/doctor.ts');
  const raw = structuredClone(example('policy')) as any;
  raw.repositories[0].gates.push(
    { id: 'api-acceptance', kind: 'check', command: ['node', 'test/run-acceptance.mjs'] },
    { id: 'web-build', kind: 'check', command: ['pnpm', '--filter', '@x/web', 'run', 'build'] },
    { id: 'docs', kind: 'check', command: ['node', 'd.js'], when: { paths: ['docs/**'] } },
    { id: 'e2e', kind: 'check', command: ['node', 'e.js'], when: { always: true } },
  );
  const policy = executionPolicySchema.parse(raw);
  assert.deepEqual(alwaysRunsNotes(policy), [
    'GATE_ALWAYS_RUNS app (unit, api-acceptance): исполняется в каждой попытке — добавьте when.paths (пути приложений, их зависимостей в workspace и общей поддержки тестов) или when.always',
  ]);
  const report = await doctor(policy, {}, undefined, undefined, undefined, {
    resourceDatabase: false,
  });
  assert.ok(report.notes?.some((n) => n.startsWith('GATE_ALWAYS_RUNS app (unit, api-acceptance)')));
  assert.ok(!report.problems?.some((p) => p.includes('GATE_ALWAYS_RUNS')));
});

test('ревью B H2: выход за пакет в script — cd .., --root .., -w, -r, вызов другого пакета; обычные scripts — нет', () => {
  for (const text of [
    'cd .. && vitest',
    'vitest --root .. run',
    'pnpm -w run test',
    'pnpm -r build',
    'pnpm --filter other test',
    'tsc -p ../../tsconfig.json',
    'node ../scripts/x.mjs',
  ])
    assert.equal(escapesPackage(text), true, text);
  for (const text of ['vitest run', 'tsc -p .', 'next build', 'eslint src --max-warnings 0'])
    assert.equal(escapesPackage(text), false, text);
  for (const script of ['cd .. && vitest', 'vitest --root .. run', 'pnpm -w run test'])
    assert.equal(
      packageClosure([pkg('packages/a', 'a', [], { test: script })], [{ name: 'a' }], 64).ok,
      false,
      script,
    );
});

test('ревью B H2: file:/link: и tsconfig extends/references/paths — пути замыкания; вне репозитория — нет применимости', async () => {
  const r = repo({
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "packages/a/sub"\n',
    'package.json': '{"name":"root","private":true}\n',
    'packages/a/package.json': '{"name":"a","dependencies":{"x":"link:../../vendored/x"}}\n',
    'packages/a/tsconfig.json':
      '{\n  // общий конфиг\n  "extends": "../../tooling/tsconfig/base.json",\n  "references": [{ "path": "../b" }],\n  "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["../../shared/src/*"] }, },\n}\n',
    'packages/a/sub/package.json': '{"name":"a-sub","dependencies":{"c":"workspace:*"}}\n',
    'packages/b/package.json': '{"name":"b"}\n',
    'packages/c/package.json': '{"name":"c"}\n',
    'packages/t/package.json': '{"name":"@repo/tsconfig"}\n',
    'packages/d/package.json': '{"name":"d"}\n',
    'packages/d/tsconfig.build.json': '{"extends":"@repo/tsconfig/base.json"}\n',
    'packages/e/package.json': '{"name":"e","devDependencies":{"y":"file:../../../outside"}}\n',
    'packages/f/package.json': '{"name":"f"}\n',
    'packages/f/tsconfig.json': '{"extends":"../../../outside/tsconfig.json"}\n',
  });
  const g = await workspaceGraphAt(r.dir, r.git('rev-parse', 'HEAD'));
  assert.ok(Array.isArray(g), JSON.stringify(g));
  const a = packageClosure(g, [{ name: 'a' }], 64);
  assert.deepEqual(a.ok && a.dirs, [
    'packages/a',
    'packages/b',
    'shared/src',
    'tooling/tsconfig/base.json',
    'vendored/x',
  ]);
  // extends по имени пакета workspace — каталог этого пакета.
  const d = packageClosure(g, [{ name: 'd' }], 64);
  assert.deepEqual(d.ok && d.dirs, ['packages/d', 'packages/t']);
  // Цель вне репозитория — нет применимости по умолчанию.
  assert.match(
    (packageClosure(g, [{ name: 'e' }], 64) as { reason: string }).reason,
    /вне репозитория/,
  );
  assert.match(
    (packageClosure(g, [{ name: 'f' }], 64) as { reason: string }).reason,
    /вне репозитория/,
  );
  // Ревью B L3: фильтр каталога pnpm — и вложенные проекты с их зависимостями.
  const under = packageClosure(g, [{ under: 'packages/a' }], 64);
  assert.ok(under.ok && under.dirs.includes('packages/a/sub') && under.dirs.includes('packages/c'));
  const deepest = packageClosure(g, [{ dir: 'packages/a/src' }], 64);
  assert.ok(deepest.ok && !deepest.dirs.includes('packages/c'), 'cwd — только свой пакет');
});

test('ревью B H1: unbound codegen — предпосылка gate пакета; codegen исполняется — исполняется и он; приёмка требует PASS', () => {
  const codegen = gate({ id: 'codegen', command: ['node', 'scripts/gen.mjs'], dependsOn: [] });
  const apiTest = gate({
    id: 'api-test',
    command: ['pnpm', '--filter', 'api', 'test'],
    dependsOn: ['codegen'],
  });
  const unit = gate({
    id: 'unit',
    kind: 'test',
    report: { type: 'junit', path: 'r.xml' },
    dependsOn: [],
  });
  const gates = [codegen, apiTest, unit];
  const condition: GateCondition = { paths: ['packages/api'], derived: { packages: ['api'] } };
  const decisions = gateDecisions({
    repo: { gates, protectedPaths: [] },
    scope: gates,
    proof: new Set(),
    changedFor: () => changed(['schema/api.yaml']),
    conditionFor: (g) => (g.id === 'api-test' ? condition : undefined),
  });
  const api = decisions.find((d) => d.gate.id === 'api-test')!;
  assert.equal(api.run, true, 'вывод исполняемой предпосылки — вход gate');
  assert.match(api.reason, /исполняется его предпосылка codegen/);
  assert.equal(api.record, undefined);
  // Явный when.paths — прежнее правило: owner принял этот риск сам.
  const explicitDecisions = gateDecisions({
    repo: { gates, protectedPaths: [] },
    scope: gates,
    proof: new Set(),
    changedFor: () => changed(['schema/api.yaml']),
    conditionFor: (g) => (g.id === 'api-test' ? { paths: ['packages/api'] } : undefined),
  });
  assert.equal(explicitDecisions.find((d) => d.gate.id === 'api-test')!.run, false);
  // Приёмка: запись derived при исполненной предпосылке — нет PASS.
  const skip = pathApplicability(repoOf, apiTest, changed(['schema/api.yaml']), condition);
  assert.ok(!skip.applies);
  assert.match(
    notApplicableProblem({
      gates,
      gate: 'api-test',
      record: { notApplicable: skip.record },
      proof: new Set(),
      ran: ['codegen'],
      derived: true,
    }) ?? '',
    /предпосылка codegen исполнялась/,
  );
});

test('ревью B L1/L2: применимость по умолчанию — облегчённый режим или явное on; перенос у получателя без режима — выключен', () => {
  assert.equal(derivedApplicabilityOn({}), true);
  assert.equal(derivedApplicabilityOn({ harnessMode: 'strict' }), false);
  assert.equal(derivedApplicabilityOn({ harnessMode: 'strict', derivedApplicability: 'on' }), true);
  assert.equal(derivedApplicabilityOn({ derivedApplicability: 'off' }), false);
  assert.equal(derivationAllowed([webGate, unitGate], webGate, false), false);
  assert.equal(integrationReuseOn({}), false, 'получатель без режима');
  assert.equal(integrationReuseOn({ harnessMode: 'light' }), true);
  assert.equal(integrationReuseOn({ integrationReuse: 'identical-tree' }), true);
});

test('ревью B M2: получатель сверяет запись derived своим Git — подделка узких путей и diff, задевший пакет, — отказ', async () => {
  const r = repo({
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    'package.json': '{"name":"root","private":true}\n',
    'packages/a/package.json': '{"name":"a"}\n',
    'packages/b/package.json': '{"name":"b","dependencies":{"a":"workspace:*"}}\n',
    'packages/c/package.json': '{"name":"c"}\n',
  });
  const base = r.git('rev-parse', 'HEAD');
  const commit = (path: string) => {
    r.git('checkout', '-q', base);
    write(r.dir, { [path]: '1\n' });
    r.git('add', '-A');
    r.git('commit', '-qm', path);
    return r.git('rev-parse', 'HEAD');
  };
  const onC = commit('packages/c/x.js');
  const onA = commit('packages/a/x.js');
  const bGate = gate({ id: 'b-check', command: ['pnpm', '--filter', 'b', 'check'] });
  const repoPolicy = { gates: [bGate], protectedPaths: [] };
  const record = (to: string, files: string[], patterns: string[], sha = to, from = base) => ({
    id: 'e-' + to.slice(0, 6) + patterns.length + sha.slice(0, 4),
    gate: 'b-check',
    phase: 'candidate',
    sha,
    notApplicable: {
      gateDigest: 'd'.repeat(64),
      patterns,
      ranges: [{ from, to }],
      count: files.length,
      files,
      pathsDigest: sha256(files.join('\0')),
      derived: { packages: ['b'] },
    },
  });
  const check = async (e: ReturnType<typeof record>, anchor?: string) =>
    (
      await derivedRecordChecks(
        r.dir,
        repoPolicy,
        [e],
        { base, candidate: e.sha },
        anchor ? () => anchor : undefined,
      )
    ).get(e.id);
  const honest = record(onC, ['packages/c/x.js'], ['packages/a', 'packages/b']);
  assert.equal(await check(honest), undefined, 'честная запись подтверждена');
  assert.match(
    (await check(record(onA, ['packages/a/x.js'], ['packages/b']))) ?? '',
    /не замыкание пакетов gate/,
  );
  assert.match(
    (await check(record(onA, ['packages/a/x.js'], ['packages/a', 'packages/b']))) ?? '',
    /применим/,
  );
  // Ревью B2 M1: старая посторонняя пара (кончается не на SHA записи) — отказ.
  assert.match(
    (await check(record(onC, ['packages/c/x.js'], ['packages/a', 'packages/b'], onA))) ?? '',
    /кончаются на .* а не на SHA записи/,
  );
  // Зелёный SHA — не предок базы или не тот, что знает получатель, — отказ.
  assert.match(
    (await check(record(onC, ['packages/c/x.js'], ['packages/a', 'packages/b'], onC, onA))) ?? '',
    /не предок базы/,
  );
  assert.match((await check(honest, onA)) ?? '', /не зелёный SHA gate/);
  assert.equal(await check(honest, base), undefined);
});
