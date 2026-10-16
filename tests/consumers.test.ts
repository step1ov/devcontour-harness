/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument --
 * Тесты правят сырой JSON политики и графа до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HarnessError,
  digestOf,
  type AttemptState,
  type EvidenceRecord,
  type ErrorCode,
} from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { runResult } from '../src/engine/result.ts';
import { requirementProof } from '../src/verification/proof.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { components, node } from './components-fixture.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';
import { planReview, trustNone } from './engine-fixture.ts';

const refused = (code: ErrorCode, message?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  if (message) assert.match(e.message, message);
  return true;
};

/** Политика из двух репозиториев: `app` и его потребитель `web` с группой gates. */
const twoRepos = (patch: (p: any) => void = () => {}) =>
  policyOf((p: any) => {
    p.repositories.push({
      ...structuredClone(p.repositories[0]),
      id: 'web',
      path: 'web',
      dependsOn: ['app'],
      gates: [
        { ...p.repositories[0].gates[0], id: 'e2e' },
        { ...p.repositories[0].gates[0], id: 'smoke', resources: ['consumer-db'] },
      ],
      gateGroups: { browser: ['e2e', 'smoke'] },
    });
    p.resources = [{ id: 'consumer-db', kind: 'service', value: 'db' }];
    patch(p);
  });

const withConsumer = (gates = ['@browser']) => {
  const g = graphOf({ a: [] }) as any;
  g.orders[0].consumers = [{ repositoryId: 'web', gates }];
  return g as ReturnType<typeof graphOf>;
};

function evidence(
  e: Engine,
  a: AttemptState,
  gate: string,
  phase: 'candidate' | 'integration',
  extra: Partial<EvidenceRecord> = {},
) {
  e.evidence(a.id, a.token, {
    kind: gate === 'independent-review' ? 'review' : 'test',
    phase,
    sha: phase === 'candidate' ? sha('c') : sha('b'),
    gate,
    passed: true,
    command: ['fixture'],
    exitCode: 0,
    log: '',
    digest: digestOf(gate + phase),
    summary: 'fixture',
    ...extra,
  });
}

test('T21/G02: потребители закрепляются раскрытыми при выдаче; их evidence не закрывает собственные gates; без PASS потребителя и записи проверенного снимка приёмки нет', () => {
  const { engine } = engineOf(twoRepos());
  ready(engine, withConsumer());
  const a = engine.claim('c1')!;
  // Группа потребителя раскрыта в явный список и записана в попытке.
  assert.deepEqual(a.consumers, [{ repositoryId: 'web', gates: ['e2e', 'smoke'] }]);
  engine.phase(a.id, a.token, 'running', { baseSha: sha('e') });
  engine.phase(a.id, a.token, 'verifying', { candidateSha: sha('c') });
  engine.phase(a.id, a.token, 'integrating', { integrationSha: sha('b') });
  // Только evidence потребителя с именем собственного gate: собственный unit он не закрывает.
  evidence(engine, a, 'unit', 'candidate', { consumer: 'web' });
  evidence(engine, a, 'unit', 'integration', { consumer: 'web' });
  evidence(engine, a, 'independent-review', 'candidate');
  evidence(engine, a, 'independent-review', 'integration');
  assert.throws(
    () => engine.finish(a.id, a.token, sha('b')),
    refused('GATE_FAILED', /Нет PASS: candidate\/unit/),
  );
  evidence(engine, a, 'unit', 'candidate');
  evidence(engine, a, 'unit', 'integration');
  // Собственный e2e не закрывает проверку потребителя.
  evidence(engine, a, 'e2e', 'integration');
  assert.throws(
    () => engine.finish(a.id, a.token, sha('b')),
    refused('GATE_FAILED', /Нет PASS проверки потребителя: web\/e2e/),
  );
  evidence(engine, a, 'e2e', 'integration', { consumer: 'web' });
  // PASS потребителя на кандидате или упавший последний — не в счёт.
  evidence(engine, a, 'smoke', 'candidate', { consumer: 'web' });
  assert.throws(() => engine.finish(a.id, a.token, sha('b')), refused('GATE_FAILED', /web\/smoke/));
  evidence(engine, a, 'smoke', 'integration', { consumer: 'web' });
  evidence(engine, a, 'smoke', 'integration', { consumer: 'web', passed: false });
  assert.throws(() => engine.finish(a.id, a.token, sha('b')), refused('GATE_FAILED', /web\/smoke/));
  evidence(engine, a, 'smoke', 'integration', { consumer: 'web' });
  // Без записи о том, что проверено, — приёмки нет.
  assert.throws(
    () => engine.finish(a.id, a.token, sha('b')),
    refused('GATE_FAILED', /не записала снимок с интегрированным результатом/),
  );
  const checked = (provider: string) => ({
    sha: sha('a'),
    tree: sha('d'),
    dependencies: [{ repositoryId: 'app', sha: provider, tree: sha('d'), artifacts: [] }],
    freshness: [{ repositoryId: 'web', snapshot: sha('a'), head: sha('a'), fresh: true }],
    observedAt: '2026-01-01T00:00:00.000Z',
  });
  // Снимок не с интегрированным результатом — тоже отказ.
  engine.consumerChecked(a.id, a.token, 'web', checked(sha('c')));
  assert.throws(
    () => engine.finish(a.id, a.token, sha('b')),
    refused('GATE_FAILED', /не записала снимок/),
  );
  assert.throws(
    () => engine.consumerChecked(a.id, a.token, 'ghost', checked(sha('b'))),
    refused('INVALID_INPUT', /не объявлен попыткой/),
  );
  engine.consumerChecked(a.id, a.token, 'web', checked(sha('b')));
  engine.finish(a.id, a.token, sha('b'));
  const done = engine.read((v) => v.attempt(a.id)!);
  const result = runResult(done, '0.0.0');
  assert.deepEqual(result.checked.consumers, [
    {
      repositoryId: 'web',
      gates: ['e2e', 'smoke'],
      sha: sha('a'),
      tree: sha('d'),
      dependencies: checked(sha('b')).dependencies,
      freshness: checked(sha('b')).freshness,
    },
  ]);
});

test('G04: непокрытые gates — по собственному integration-evidence принятых поручений; evidence потребителя и запись ревью не в счёт', () => {
  const policy = policyOf((p: any) => {
    p.repositories[0].gates = [
      p.repositories[0].gates[0],
      { ...p.repositories[0].gates[0], id: 'nightly' },
      { ...p.repositories[0].gates[0], id: 'engine' },
    ];
  });
  const { engine } = engineOf(policy);
  const g = graphOf({ a: [] }) as any;
  g.orders[0].gates = ['unit'];
  ready(engine, g);
  const a = engine.claim('c1')!;
  assert.deepEqual(a.requiredGates, ['unit']);
  engine.phase(a.id, a.token, 'verifying', { candidateSha: sha('c') });
  engine.phase(a.id, a.token, 'integrating', { integrationSha: sha('b') });
  for (const phase of ['candidate', 'integration'] as const) {
    evidence(engine, a, 'unit', phase);
    evidence(engine, a, 'independent-review', phase);
  }
  // nightly прошёл только как проверка потребителя, engine — только записью ревью.
  evidence(engine, a, 'nightly', 'integration', { consumer: 'web' });
  evidence(engine, a, 'engine', 'integration', { kind: 'review' });
  // До приёмки поручение ничего не покрывает: учитывается принятый SHA.
  assert.deepEqual(engine.uncoveredGates(['a']), [
    { repositoryId: 'app', gates: ['unit', 'nightly', 'engine'] },
  ]);
  engine.finish(a.id, a.token, sha('b'));
  assert.deepEqual(engine.uncoveredGates(['a']), [
    { repositoryId: 'app', gates: ['nightly', 'engine'] },
  ]);
});

test('G01/T20: группа раскрывается один раз в попытке; состав закреплён за попыткой и не меняется новой редакцией; новая редакция области требует нового согласования', () => {
  const policy = policyOf((p: any) => {
    p.repositories[0].gates = [
      p.repositories[0].gates[0],
      { ...p.repositories[0].gates[0], id: 'engine' },
      { ...p.repositories[0].gates[0], id: 'nightly' },
    ];
    p.repositories[0].gateGroups = { regression: ['@core', 'unit'], core: ['unit', 'engine'] };
  });
  const { engine } = engineOf(policy);
  const g = graphOf({ a: [] }) as any;
  g.orders[0].gates = ['@regression'];
  ready(engine, g);
  const a = engine.claim('c1')!;
  assert.deepEqual(a.requiredGates, ['unit', 'engine']);
  assert.ok(!a.requiredGates.includes('nightly'), 'ничего не подключается неявно');
  // Новая редакция с другой областью: прежняя попытка сохраняет свой состав,
  // новое поручение не выдаётся до нового согласования.
  engine.cancel('a', 'новая редакция');
  const narrowed = graphOf({ a: [] }, '2') as any;
  narrowed.orders[0].gates = ['unit'];
  engine.register(narrowed, trustNone);
  assert.deepEqual(
    engine.read((v) => v.attempt(a.id)!.requiredGates),
    ['unit', 'engine'],
  );
  assert.equal(engine.claim('c1'), undefined, 'изменённая область без согласования не выдаётся');
  const state = engine.read((v) => v.graph('g')!);
  engine.recordReview(planReview(engine, state, engine.reviews('plan', 'g').length + 1));
  engine.approve('g', 'agent');
  assert.deepEqual(engine.claim('c1')?.requiredGates, ['unit']);
});

test('G02: ресурсы gates потребителя резервируются на всю попытку; политика потребителя входит в договор попытки', async () => {
  const ctx = components({
    policy: (p) => {
      p.resources = [{ id: 'consumer-db', kind: 'service', value: 'db-1' }];
      p.repositories.find((r: any) => r.id === 'product').gates[0].resources = ['consumer-db'];
    },
  });
  await drive(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  assert.deepEqual(
    a.resources?.map((r) => r.id),
    ['consumer-db'],
    'ресурс gate потребителя зарезервирован',
  );
  // Смена команды gate потребителя — другая политика: digest попытки иной.
  const other = structuredClone(ctx.policy) as any;
  other.repositories.find((r: any) => r.id === 'product').gates[0].timeoutMs = 99_000;
  assert.notEqual(digestOf(other), a.policyDigest);
});

async function drive(ctx: ReturnType<typeof components>) {
  await ctx.runner.init();
  ready(ctx.engine, ctx.graph, 'runner-1');
  await ctx.runner.drain();
}

test('T21/G02: runner проверяет потребителя в его дереве против интегрированного результата; провал потребителя — нет приёмки; деревья убраны', async () => {
  const ctx = components();
  const product = ctx.ref('product');
  await drive(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  const own = a.evidence.filter((e) => e.consumer === 'product');
  assert.equal(own.length, 1);
  assert.equal(own[0]!.phase, 'integration');
  assert.equal(own[0]!.sha, a.integrationSha);
  assert.equal(own[0]!.passed, true, own[0]!.summary);
  const checked = a.consumers![0]!.checked!;
  assert.equal(checked.sha, product, 'проверена голова потребителя');
  assert.deepEqual(
    checked.dependencies.map((d) => [d.repositoryId, d.sha]),
    [['library', a.integrationSha]],
  );
  assert.deepEqual(
    checked.freshness?.map((f) => [f.repositoryId, f.fresh]),
    [['product', true]],
  );
  assert.equal(ctx.ref('product'), product, 'целевая ветка потребителя не тронута');
  assert.equal(ctx.worktrees('product'), 1, 'рабочее дерево потребителя убрано');
  assert.equal(ctx.worktrees('library'), 1);
  const result = runResult(a, '0.0.0');
  assert.equal(result.checked.consumers[0]?.sha, product);

  // Исполнитель не изменил значение: собственные gates зелёные, потребитель — нет.
  const stale = components({
    scenario: {
      writer: {
        files: { 'value.json': '3\n' },
        result: { completed: true, summary: 'value 3', discoveries: [] },
      },
      reviewer: JSON.parse(readFileSync(ctx.scenarioPath, 'utf8')).reviewer,
    },
    policy: (p) => (p.maxAttempts = 1),
  });
  const before = stale.ref('library');
  await drive(stale);
  const failed = stale.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /integration\/product:test/);
  assert.equal(stale.ref('library'), before, 'target провайдера неподвижен');
  assert.equal(stale.worktrees('product'), 1);
});

/** Попытка в фазе интеграции и интегрированное дерево библиотеки со значением `value`. */
function integrated(ctx: ReturnType<typeof components>, value?: string) {
  ready(ctx.engine, ctx.graph, 'runner-1');
  const a = ctx.engine.claim('runner-1')!;
  const lib = ctx.repos.library!;
  const dir = join(ctx.state, 'integrated-' + Math.random().toString(16).slice(2));
  lib.git('worktree', 'add', '--detach', dir, ctx.policy.repositories[0]!.targetRef);
  const git = (...args: string[]) =>
    lib.git('-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args);
  if (value === undefined) {
    git('rm', '-q', 'value.json');
    git('commit', '-qm', 'no value');
  } else {
    writeFileSync(join(dir, 'value.json'), value + '\n');
    git('commit', '-qam', 'value ' + value);
  }
  const at = git('rev-parse', 'HEAD');
  ctx.engine.phase(a.id, a.token, 'verifying', { candidateSha: at });
  ctx.engine.phase(a.id, a.token, 'integrating', { integrationSha: at });
  const consume = () =>
    (
      ctx.runner as unknown as {
        consumers(
          a: AttemptState,
          cwd: string,
          sha: string,
          artifacts: string,
          signal: AbortSignal,
        ): Promise<void>;
      }
    ).consumers(
      ctx.engine.read((v) => v.attempt(a.id)!),
      dir,
      at,
      join(ctx.state, 'artifacts', a.id),
      new AbortController().signal,
    );
  return { a, dir, at, consume };
}

test('T21/G02: транзитивный потребитель собирается против интегрированного провайдера, выполняет свои prepare и lifecycle, записывает проверенное и не оставляет деревьев, даже при отказе', async () => {
  const log = join(
    (await import('node:os')).tmpdir(),
    'harness-lifecycle-' + Math.random().toString(16).slice(2) + '.log',
  );
  const ctx = components({
    chain: true,
    policy: (p) => {
      const product = p.repositories.find((r: any) => r.id === 'product');
      product.prepare = [
        { id: 'install', command: node(`require('fs').writeFileSync('.prepared','')`) },
      ];
      product.lifecycle = {
        setup: [
          {
            id: 'up',
            command: node(`require('fs').appendFileSync(${JSON.stringify(log)},'setup\\n')`),
          },
        ],
        teardown: [
          {
            id: 'down',
            command: node(`require('fs').appendFileSync(${JSON.stringify(log)},'teardown\\n')`),
          },
        ],
      };
    },
  });
  // Потребитель требует, чтобы его подготовка выполнилась.
  writeFileSync(join(ctx.repos.product!.dir, '.expect-prepared'), '');
  ctx.repos.product!.git('add', '.expect-prepared');
  ctx.repos.product!.git('commit', '-qm', 'expect prepared');
  ctx.repos.product!.git(
    'update-ref',
    ctx.policy.repositories.find((r) => r.id === 'product')!.targetRef,
    'HEAD',
  );
  const { a, at, consume } = integrated(ctx, '2');
  await consume();
  const stored = ctx.engine.read((v) => v.attempt(a.id)!);
  const ev = stored.evidence.filter((e) => e.consumer === 'product');
  // PASS: mid собран против интегрированной библиотеки (2), prepare потребителя выполнен.
  assert.equal(ev[0]?.passed, true, ev[0]?.summary);
  assert.equal(readFileSync(log, 'utf8'), 'setup\nteardown\n');
  const checked = stored.consumers![0]!.checked!;
  assert.equal(checked.sha, ctx.ref('product'));
  assert.deepEqual(
    checked.dependencies.map((d) => [d.repositoryId, d.sha]),
    [
      ['library', at],
      ['mid', ctx.ref('mid')],
    ],
  );
  assert.equal(checked.dependencies[1]!.artifacts[0]!.path, 'built.json');
  // Свежесть — для фактических входов: mid и сам потребитель; библиотека
  // подставлена интегрированным результатом и в свежесть не входит.
  assert.deepEqual(
    checked.freshness!.map((x) => [x.repositoryId, x.fresh]),
    [
      ['mid', true],
      ['product', true],
    ],
  );
  assert.equal(ctx.worktrees('mid'), 1);
  assert.equal(ctx.worktrees('product'), 1);

  // Сборка mid падает (у «интегрированной» библиотеки нет value.json): деревья убраны.
  const broken = integratedAgain(ctx, a, undefined);
  await assert.rejects(broken());
  assert.equal(ctx.worktrees('mid'), 1);
  assert.equal(ctx.worktrees('product'), 1);
});

/** Ещё одно интегрированное дерево той же попытки. */
function integratedAgain(
  ctx: ReturnType<typeof components>,
  a: AttemptState,
  value: string | undefined,
) {
  const lib = ctx.repos.library!;
  const dir = join(ctx.state, 'integrated-' + Math.random().toString(16).slice(2));
  lib.git('worktree', 'add', '--detach', dir, ctx.policy.repositories[0]!.targetRef);
  const git = (...args: string[]) =>
    lib.git('-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args);
  if (value === undefined) {
    git('rm', '-q', 'value.json');
    git('commit', '-qm', 'no value');
  } else {
    writeFileSync(join(dir, 'value.json'), value + '\n');
    git('commit', '-qam', 'value ' + value);
  }
  const at = git('rev-parse', 'HEAD');
  return () =>
    (
      ctx.runner as unknown as {
        consumers(
          a: AttemptState,
          cwd: string,
          sha: string,
          artifacts: string,
          signal: AbortSignal,
        ): Promise<void>;
      }
    ).consumers(
      ctx.engine.read((v) => v.attempt(a.id)!),
      dir,
      at,
      join(ctx.state, 'artifacts', a.id),
      new AbortController().signal,
    );
}

/** Фикстура, у потребителя которой изменён договор окружения. */
const withProduct = (patch: (product: any) => void) =>
  components({ policy: (p) => patch(p.repositories.find((r: any) => r.id === 'product')) });

test('T21/G02: подготовка потребителя не подменяет проверяемую голову; двойной отказ виден целиком; незавершённая очистка сохраняет деревья с указанием на receipt окружения', async () => {
  // Подготовка коммитит или правит отслеживаемый файл потребителя — отказ, дерево убрано.
  for (const command of [
    [
      'git',
      '-c',
      'user.email=f@e',
      '-c',
      'user.name=f',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'patched',
    ],
    node(`require('fs').appendFileSync('.gitignore','patched\\n')`),
  ]) {
    const c = withProduct((p) => (p.prepare = [{ id: 'patch', command, timeoutMs: 30_000 }]));
    const { consume } = integrated(c, '2');
    await assert.rejects(
      consume(),
      /Потребитель product: подготовка изменила (HEAD|отслеживаемые файлы)/,
    );
    assert.equal(c.worktrees('product'), 1);
    c.store.close();
  }
  // Двойной отказ: prepare блокирует своё дерево и падает — обе причины видны.
  const locked = withProduct((p) => {
    p.prepare = [
      { id: 'lock', command: ['git', 'worktree', 'lock', '.'], timeoutMs: 30_000 },
      { id: 'fail', command: node('process.exit(7)'), timeoutMs: 30_000 },
    ];
  });
  const both = await integrated(locked, '2')
    .consume()
    .then(
      () => new Error('passed'),
      (e: unknown) => e as Error,
    );
  assert.match(both.message, /fail/);
  assert.match(both.message, /не удалось убрать рабочие деревья проверки потребителя/);
  const left = locked.repos
    .product!.git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .find((p) => p !== locked.repos.product!.dir)!;
  locked.repos.product!.git('worktree', 'unlock', left);
  locked.repos.product!.git('worktree', 'remove', '--force', left);
  locked.store.close();
  // Очистка окружения потребителя не завершилась: деревья — контекст её повторения.
  const teardown = withProduct((p) => {
    p.lifecycle = {
      setup: [],
      ready: [],
      teardown: [{ id: 'down', command: node('process.exit(9)'), timeoutMs: 30_000 }],
    };
  });
  const failure = await integrated(teardown, '2')
    .consume()
    .then(
      () => new Error('passed'),
      (e: unknown) => e as Error,
    );
  assert.match(failure.message, /Очистка окружения не завершена/);
  assert.match(failure.message, /сохранены для повторной очистки .*environment\.json/);
  assert.equal(teardown.worktrees('product'), 2);
  teardown.store.close();
});

test('T22/G03: снимок зависимостей закрепляется до работы; сдвиг ветки зависимости записывается свежестью в попытке и результате, приёмку не запрещает', async () => {
  // Поручение продукта, зависящего от библиотеки; во время ревью кандидата
  // библиотека продвигается параллельной работой.
  const ctx = components({
    graph: (g) => {
      g.orders[0].repositoryId = 'product';
      g.orders[0].writeScope = ['value.json'];
      delete g.orders[0].consumers;
    },
    scenario: {
      writer: {
        files: { 'value.json': '5\n' },
        result: { completed: true, summary: 'value 5', discoveries: [] },
      },
      reviewer: {
        result: {
          approved: true,
          summary: 'ok',
          findings: [],
          discoveries: [],
          execution: { commands: [], noCommandsReason: 'diff' },
          previous: [],
        },
      },
    },
    policy: (p) => {
      // Собственная проверка продукта — его unit; verify требует 2 и здесь не нужен.
      p.repositories.find((r: any) => r.id === 'product').gates = [
        {
          id: 'unit',
          kind: 'test',
          command: [process.execPath, 'unit.js'],
          report: { type: 'junit', path: 'reports/unit.xml' },
        },
      ];
    },
  });
  const snapshot = ctx.ref('library');
  // Сдвиг ветки библиотеки во время работы — через gate продукта на кандидате.
  const advance = node(
    `const {execFileSync}=require('child_process');if(process.env.DEVCONTOUR_PHASE==='candidate'&&!require('fs').existsSync(${JSON.stringify(join(ctx.state, 'advanced'))})){require('fs').writeFileSync(${JSON.stringify(join(ctx.state, 'advanced'))},'');const d=${JSON.stringify(ctx.repos.library!.dir)};execFileSync('git',['-C',d,'-c','user.name=t','-c','user.email=t@t','commit','-q','--allow-empty','-m','parallel']);execFileSync('git',['-C',d,'update-ref',${JSON.stringify(ctx.policy.repositories[0]!.targetRef)},'HEAD']);}`,
  );
  ctx.store.close();
  const raw = structuredClone(ctx.policy) as any;
  raw.repositories.find((r: any) => r.id === 'product').prepare = [
    { id: 'advance', command: advance },
  ];
  const c = reopenWith(ctx, raw);
  await drive(c);
  const a = c.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  assert.deepEqual(
    a.dependencies?.map((d) => [d.repositoryId, d.sha]),
    [['library', snapshot]],
  );
  const head = c.ref('library');
  assert.notEqual(head, snapshot);
  assert.deepEqual(a.dependencyFreshness, [
    { repositoryId: 'library', snapshot, head, fresh: false },
  ]);
  const result = runResult(a, '0.0.0');
  assert.deepEqual(result.checked.freshness, [
    { repositoryId: 'library', snapshot, head, fresh: false },
  ]);
  assert.equal(result.checked.dependencies[0]?.sha, snapshot);
  assert.equal(c.worktrees('library'), 1, 'снимок зависимости убран после попытки');
  c.store.close();
});

function reopenWith(ctx: ReturnType<typeof components>, raw: any) {
  const store = new SqliteExecutionStore(join(ctx.state, 'state.sqlite'), 'test');
  const policy = raw as typeof ctx.policy;
  const engine = new Engine({ host: standaloneHost(store, policy), policy });
  const runner = new (ctx.runner.constructor as typeof import('../src/engine/runner.ts').Runner)({
    ...ctx.runner.options,
    engine,
  });
  return { ...ctx, store, engine, runner, policy };
}

test('T22: исполнитель, изменивший закреплённый снимок зависимости, не проходит', async () => {
  const ctx = components({
    graph: (g) => {
      g.orders[0].repositoryId = 'product';
      delete g.orders[0].consumers;
    },
    policy: (p) => {
      p.maxAttempts = 1;
      p.repositories.find((r: any) => r.id === 'product').gates = [
        {
          id: 'unit',
          kind: 'test',
          command: [process.execPath, 'unit.js'],
          report: { type: 'junit', path: 'reports/unit.xml' },
        },
      ];
    },
  });
  // Gate продукта на кандидате правит дерево снимка библиотеки.
  ctx.store.close();
  const raw = structuredClone(ctx.policy) as any;
  raw.repositories.find((r: any) => r.id === 'product').prepare = [
    {
      id: 'tamper',
      command: node(
        `const p=JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON);require('fs').writeFileSync(p.library+'/value.json','9\\n')`,
      ),
    },
  ];
  const c = reopenWith(ctx, raw);
  const before = c.ref('product');
  await drive(c);
  const a = c.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'failed');
  assert.match(a.error!, /Изменён закреплённый dependency snapshot: library/);
  assert.equal(c.ref('product'), before);
  c.store.close();
});

test('G02: одноимённый testcase потребителя не подтверждает собственное требование поручения', () => {
  const at = sha('b');
  const pass = (extra: Partial<EvidenceRecord>): EvidenceRecord => ({
    id: 'e',
    runId: 'r',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'test',
    phase: 'integration',
    sha: at,
    gate: 'unit',
    passed: true,
    command: [],
    exitCode: 0,
    log: '',
    digest: digestOf('e'),
    summary: '',
    ...extra,
  });
  const consumerOnly = [
    pass({ consumer: 'web', tests: [{ id: 'required-test', status: 'passed' }] }),
    pass({ tests: [{ id: 'different-test', status: 'passed' }] }),
  ];
  assert.equal(
    requirementProof({ id: 'REQ-1', gate: 'unit', testId: 'required-test' }, consumerOnly, at)
      .level,
    'none',
  );
  assert.equal(
    requirementProof(
      { id: 'REQ-1', gate: 'unit', testId: 'required-test' },
      [pass({ tests: [{ id: 'required-test', status: 'passed' }] })],
      at,
    ).level,
    'testcase',
  );
});

test('T22: снимок, изменённый очисткой окружения кандидата, отклоняет попытку до интеграции', async () => {
  const ctx = components({
    graph: (g) => {
      g.orders[0].repositoryId = 'product';
      delete g.orders[0].consumers;
    },
    policy: (p) => {
      p.maxAttempts = 1;
      const product = p.repositories.find((r: any) => r.id === 'product');
      product.gates = [
        {
          id: 'unit',
          kind: 'test',
          command: [process.execPath, 'unit.js'],
          report: { type: 'junit', path: 'reports/unit.xml' },
        },
      ];
      product.lifecycle = {
        setup: [],
        ready: [],
        teardown: [
          {
            id: 'tamper',
            command: node(
              `if(process.env.DEVCONTOUR_PHASE==='candidate'){const p=JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON);require('fs').writeFileSync(p.library+'/value.json','9\\n')}`,
            ),
          },
        ],
      };
    },
  });
  await drive(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'failed');
  assert.match(a.error!, /Изменён закреплённый dependency snapshot: library/);
  assert.equal(a.integrationSha, undefined, 'интеграция не начиналась');
  ctx.store.close();
});
