/**
 * `tasks[].context` коннектора: локальные пакеты контекста (например, оверлей
 * controller-mode) закрепляются в снимке рядом с контекстом задачи Relay.
 * Без поля снимок, ревизия и digest задачи прежние; изменение пакета — новая
 * ревизия набора (новое согласование), но не новая постановка задачи
 * (доставка не конфликтует).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  HarnessError,
  cliDataSchemas,
  contextDigest,
  contractViolation,
  workGraphDigest,
} from '../src/contracts/index.ts';
import {
  ConnectorStore,
  RelayWorkSource,
  openConnector,
  parseConfig,
} from '../src/integrations/connector/index.ts';
import { buildSnapshot } from '../src/integrations/connector/snapshot.ts';
import {
  FakeAdmin,
  FakeRelayTransport,
  emptyFakeState,
  fakeSuiteBackend,
  memoryBackend,
  scenario,
} from '../src/integrations/connector/testing.ts';

const pack = (root: string, dir = join(root, 'work', 'context', 'controller-mode')) => {
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'AGENTS.controller.md'), '# Controller mode\n\nDo not commit.\n');
  writeFileSync(join(dir, 'references', 'AGENTS.md'), '# Product rules\n');
  return dir;
};

const withContext = (config: Record<string, unknown>, ids: string[]) => {
  (config.tasks as Record<string, unknown>[])[0]!.context = ids;
};

test('tasks[].context: пакет закреплён в снимке и в поручении; поручение принимается и доставляется', async () => {
  const s = await scenario(fakeSuiteBackend(), {
    config: (c) => withContext(c, ['controller-mode']),
  });
  try {
    pack(s.root);
    const { opened } = await s.snapshotAndRun();
    const snap = await opened.connector.snapshot(join(s.root, 'snapshot-2'));
    const order = snap.snapshot.graph.orders[0]!;
    assert.deepEqual(order.context.slice(1), ['controller-mode']);
    const source = snap.snapshot.context.sources.find((x) => x.id === 'controller-mode')!;
    assert.deepEqual(
      source.files.map((f) => f.path),
      ['AGENTS.controller.md'],
    );
    assert.deepEqual(
      source.references.map((f) => f.path),
      ['references/AGENTS.md'],
    );
    const result = opened.h.result(s.workId);
    assert.equal(result.result?.outcome, 'accepted');
    assert.equal(result.delivery.at(-1)?.status, 'delivered');
    opened.close();
  } finally {
    await s.cleanup();
  }
});

test('tasks[].context: без поля ревизия и digest задачи прежние; изменение пакета меняет ревизию набора, но не digest задачи', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const plain = await openConnector(parseConfig(structuredClone(s.config), s.root), {
      stateDir: s.state,
      transport: s.project.transport(),
    });
    const before = await plain.source.snapshot();
    assert.equal(before.context.sources.length, 1, 'без tasks[].context — только контекст задачи');
    assert.deepEqual(before.graph.orders[0]!.context, [before.context.sources[0]!.id]);
    assert.ok(!('context' in plain.config.tasks[0]!), 'поле не появляется по умолчанию');
    plain.close();

    const dir = pack(s.root);
    const cfg = structuredClone(s.config) as Record<string, unknown>;
    withContext(cfg, ['controller-mode']);
    const open = () =>
      openConnector(parseConfig(structuredClone(cfg), s.root), {
        stateDir: s.state,
        transport: s.project.transport(),
      });
    const first = await open();
    const a = await first.source.snapshot();
    first.close();
    assert.notEqual(a.revision, before.revision, 'новый пакет — новая ревизия набора');
    writeFileSync(join(dir, 'AGENTS.controller.md'), '# Controller mode v2\n');
    const second = await open();
    const b = await second.source.snapshot();
    second.close();
    assert.notEqual(b.revision, a.revision, 'изменение пакета — новое согласование');
    assert.equal(
      b.manifest.tasks[0]!.semanticDigest,
      a.manifest.tasks[0]!.semanticDigest,
      'постановка задачи та же: доставка не конфликтует',
    );
  } finally {
    await s.cleanup();
  }
});

test('tasks[].context: нет каталога или пакета — NOT_READY до чтения backend; source-check сообщает; имя вида ID контекста задачи — INVALID_INPUT', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const cfg = structuredClone(s.config) as Record<string, unknown>;
    withContext(cfg, ['controller-mode']);
    const connector = await openConnector(parseConfig(structuredClone(cfg), s.root), {
      stateDir: s.state,
      transport: s.project.transport(),
    });
    await assert.rejects(
      () => connector.source.snapshot(),
      (e: unknown) =>
        e instanceof HarnessError && e.code === 'NOT_READY' && /не найден/.test(e.message),
    );
    const report = await connector.check();
    assert.ok(
      report.problems.some((p: string) => /Каталог пакетов контекста/.test(p)),
      'source-check называет отсутствующий каталог',
    );
    mkdirSync(join(s.root, 'work', 'context', 'other'), { recursive: true });
    await assert.rejects(
      () => connector.source.snapshot(),
      (e: unknown) =>
        e instanceof HarnessError && e.code === 'NOT_READY' && /controller-mode/.test(e.message),
    );
    connector.close();

    const custom = pack(s.root, join(s.root, 'packs', 'controller-mode'));
    rmSync(join(s.root, 'work'), { recursive: true });
    const moved = await openConnector(
      parseConfig({ ...structuredClone(cfg), contextDir: 'packs' }, s.root),
      { stateDir: s.state, transport: s.project.transport() },
    );
    const snap = await moved.source.snapshot();
    assert.ok(
      snap.context.sources.some((x) => x.id === 'controller-mode'),
      custom,
    );
    moved.close();

    const clash = structuredClone(cfg);
    withContext(clash, ['c' + '0'.repeat(20)]);
    assert.throws(
      () => parseConfig(clash, s.root),
      (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
    );
  } finally {
    await s.cleanup();
  }
});

test('tasks[].context: без поля снимок совпадает с alpha.12 байт в байт (ревизия, digest задачи, графа и контекста)', async () => {
  // Значения получены кодом v0.1.0-alpha.12 на тех же данных подделки backend.
  const backend = memoryBackend(emptyFakeState('relay-v1-http', 'p1'));
  const admin = new FakeAdmin(backend);
  const transport = new FakeRelayTransport(backend, {
    provider: 'relay-v1-http',
    actor: 'harness',
  });
  const t = admin.createTask({
    title: 'Greet',
    description: 'Add greet(name)',
    column: 'ready',
    criteria: [{ title: 'Greets' }],
  });
  admin.addDocument(t.id, { name: 'Spec', body: 'spec body' });
  const config = parseConfig(
    {
      version: 1,
      provider: 'relay-v1-http',
      projectId: 'p1',
      actor: 'harness',
      relay: { endpoint: 'http://127.0.0.1:1' },
      repository: { id: 'app' },
      tasks: [
        {
          ref: t.id,
          writeScope: ['src'],
          gates: ['unit'],
          criteria: [{ title: 'Greets', gate: 'unit', testId: 'g.g' }],
        },
      ],
    },
    '/project',
  ).config;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-connector-context-')));
  const store = new ConnectorStore(join(dir, 's.sqlite'), {
    provider: 'relay-v1-http',
    projectId: 'p1',
  });
  try {
    const snap = await new RelayWorkSource({ config, transport, store }).snapshot();
    assert.deepEqual(
      {
        revision: snap.revision,
        task: snap.manifest.tasks[0]!.semanticDigest,
        graph: workGraphDigest(snap.graph),
        context: contextDigest(snap.context),
      },
      {
        revision: 'db75d555e496b0b09413a9c4d54c252685ba34a101952039e79745f0f9395db5',
        task: 'c71481194cbdd61cb257385d6418061d4413ff2f3374c4522600a7492881de3e',
        graph: '6940a542b5104f39bca3898156a5aff308eea4a108b74c6f845beb6a0b8627fd',
        context: 'e1c02061866cd3e6a0a0f775e61d2bdce0aa18f03bc502eaa172645646ebdec7',
      },
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const calls = (t: { calls: Record<string, number> }) =>
  Object.values(t.calls).reduce((n, c) => n + c, 0);

test('tasks[].context: изменённый пакет — APPROVAL_STALE до запуска; исполняется закреплённый контекст, его байты видит writer', async () => {
  const s = await scenario(fakeSuiteBackend(), {
    config: (c) => withContext(c, ['controller-mode']),
  });
  try {
    const dir = pack(s.root);
    writeFileSync(join(dir, 'AGENTS.controller.md'), '# Controller mode\n\nMARKER-v1\n');
    const opened = await s.runOnly();
    assert.equal(opened.h.result(s.workId).result?.outcome, 'accepted');
    const seen = execFileSync('grep', ['-rl', 'MARKER-v1', join(s.state, 'artifacts')], {
      encoding: 'utf8',
    });
    assert.match(seen, /implementation/, 'контекст попытки writer содержит байты пакета');
    writeFileSync(join(dir, 'AGENTS.controller.md'), '# Controller mode\n\nMARKER-v2\n');
    await assert.rejects(
      () => opened.connector.prepareRun(opened.h),
      (e: unknown) => e instanceof HarnessError && e.code === 'APPROVAL_STALE',
    );
    // Доставка принятого результата после изменения пакета — не конфликт.
    await opened.connector.deliver(opened.h, s.workId);
    assert.equal(opened.h.result(s.workId).delivery.at(-1)?.status, 'delivered');
    opened.close();
  } finally {
    await s.cleanup();
  }
});

test('tasks[].context: включение поля после принятия не делает доставку конфликтом; нет каталога — отказ без обращений к backend', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const first = await s.runOnly();
    assert.equal(first.h.result(s.workId).result?.outcome, 'accepted');
    first.close();
    withContext(s.config, ['controller-mode']);
    const missing = await s.open();
    const before = calls(missing.transport);
    await assert.rejects(
      () => missing.connector.source.snapshot(),
      (e: unknown) => e instanceof HarnessError && e.code === 'NOT_READY',
    );
    assert.equal(calls(missing.transport), before, 'backend не читается до проверки пакетов');
    missing.close();
    pack(s.root);
    const second = await s.open();
    await second.connector.deliver(second.h, s.workId);
    assert.equal(second.h.result(s.workId).delivery.at(-1)?.status, 'delivered');
    second.close();
  } finally {
    await s.cleanup();
  }
});

test('tasks[].context: пределы контекста — LIMIT_EXCEEDED в снимке и source-check; symlink-пакет — INVALID_INPUT; manifest называет пакеты', async () => {
  const s = await scenario(fakeSuiteBackend(), {
    config: (c) => withContext(c, ['controller-mode']),
  });
  try {
    const dir = pack(s.root);
    const ok = await s.open();
    const fine = await ok.connector.snapshot(join(s.root, 'snap-ok'));
    assert.deepEqual(
      fine.localContext?.map((p) => [p.id, p.files, p.references]),
      [['controller-mode', 1, 1]],
    );
    assert.equal(fine.snapshot.manifest.localContext?.[0]?.digest.length, 64);
    writeFileSync(join(dir, 'big.md'), Buffer.alloc(3 * 1024 * 1024, 'a'));
    const big = await ok.connector.snapshot(join(s.root, 'snap-big'));
    assert.equal(big.eligible, false);
    assert.ok(
      big.problems.some((p) => /LIMIT_EXCEEDED/.test(p) && /fileBytes/.test(p)),
      big.problems.join('; '),
    );
    const report = await ok.connector.check();
    assert.ok(report.problems.some((p: string) => /больше предела/.test(p)));
    ok.close();

    rmSync(join(dir, 'big.md'));
    const real = join(s.root, 'elsewhere');
    pack(s.root, join(real, 'controller-mode'));
    rmSync(dir, { recursive: true });
    symlinkSync(join(real, 'controller-mode'), dir);
    const linked = await s.open();
    await assert.rejects(
      () => linked.connector.source.snapshot(),
      (e: unknown) =>
        e instanceof HarnessError && e.code === 'INVALID_INPUT' && /symlink/.test(e.message),
    );
    linked.close();
  } finally {
    await s.cleanup();
  }
});

test('tasks[].context: перенос пакета между задачами и смена порядка — новая ревизия набора; больше 30 источников — LIMIT_EXCEEDED', async () => {
  const backend = memoryBackend(emptyFakeState('relay-v1-http', 'p1'));
  const admin = new FakeAdmin(backend);
  const transport = new FakeRelayTransport(backend, {
    provider: 'relay-v1-http',
    actor: 'harness',
  });
  const make = (title: string) =>
    admin.createTask({ title, description: 'Do ' + title, column: 'ready', criteria: [] });
  const a = make('First');
  const b = make('Second');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-connector-context-')));
  const packs = join(dir, 'work', 'context');
  for (const id of ['p', 'q']) {
    mkdirSync(join(packs, id), { recursive: true });
    writeFileSync(join(packs, id, 'README.md'), '# ' + id + '\n');
  }
  const store = new ConnectorStore(join(dir, 's.sqlite'), {
    provider: 'relay-v1-http',
    projectId: 'p1',
  });
  const revision = async (ctx: [string[] | undefined, string[] | undefined], extra = 0) => {
    const task = (ref: string, context: string[] | undefined) => ({
      ref,
      writeScope: ['src'],
      ...(context ? { context } : {}),
    });
    const extraTasks = Array.from({ length: extra }, (_, i) =>
      task(make('Extra ' + i).id, undefined),
    );
    const config = parseConfig(
      {
        version: 1,
        provider: 'relay-v1-http',
        projectId: 'p1',
        actor: 'harness',
        relay: { endpoint: 'http://127.0.0.1:1' },
        repository: { id: 'app' },
        tasks: [task(a.id, ctx[0]), task(b.id, ctx[1]), ...extraTasks],
      },
      dir,
    ).config;
    return new RelayWorkSource({ config, transport, store, contextDir: packs }).snapshot();
  };
  try {
    const onA = await revision([['p'], undefined]);
    const onB = await revision([undefined, ['p']]);
    const both = await revision([['p'], ['p']]);
    const pq = await revision([['p', 'q'], undefined]);
    const qp = await revision([['q', 'p'], undefined]);
    const all = [onA, onB, both, pq, qp].map((x) => x.revision);
    assert.equal(new Set(all).size, all.length, 'каждое распределение пакетов — своя ревизия');
    assert.equal(
      onA.manifest.tasks[0]!.semanticDigest,
      onB.manifest.tasks[0]!.semanticDigest,
      'постановка задачи от пакетов не зависит',
    );
    // 29 задач + 2 исходные = 31 контекст задач и пакет p: больше 30 источников.
    const many = await revision([['p'], undefined], 29);
    assert.ok(
      many.problems.some((p) => p.code === 'LIMIT_EXCEEDED' && /предел/.test(p.message)),
      many.problems.map((p) => p.message).join('; '),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tasks[].context: ответы всех команд коннектора — по договору CLI, в том числе с пакетом и после доставки', async () => {
  const s = await scenario(fakeSuiteBackend(), {
    config: (c) => withContext(c, ['controller-mode']),
  });
  try {
    pack(s.root);
    const { opened } = await s.snapshotAndRun();
    const { snapshot, ...snap } = await opened.connector.snapshot(join(s.root, 'snap'));
    assert.ok(snapshot.manifest.localContext);
    cliDataSchemas['source-snapshot'].parse(snap);
    cliDataSchemas['source-check'].parse(await opened.connector.check(s.policy));
    cliDataSchemas['source-status'].parse(await opened.connector.status(opened.h));
    cliDataSchemas['source-deliver'].parse(await opened.connector.deliver(opened.h, s.workId));
    const op = opened.connector.store.operations({ workId: s.workId })[0]!;
    cliDataSchemas['source-reconcile'].parse(await opened.connector.reconcile(opened.h, op.key));
    opened.close();
  } finally {
    await s.cleanup();
  }
});

test('tasks[].context: пакет вне договора источника виден в снимке и source-check; запуск отказывает до runtime', async () => {
  const s = await scenario(fakeSuiteBackend(), {
    config: (c) => withContext(c, ['controller-mode']),
  });
  try {
    const dir = pack(s.root);
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `extra-${i}.md`), 'x\n');
    writeFileSync(join(dir, 'bad*name.md'), 'x\n');
    const o = await s.open();
    const snap = await o.connector.snapshot(join(s.root, 'snap'));
    assert.equal(snap.eligible, false);
    const named = (p: string) => /LIMIT_EXCEEDED/.test(p) && p.includes('controller-mode/');
    assert.ok(
      snap.problems.some((p) => named(p) && p.includes('files')),
      snap.problems.join('; '),
    );
    assert.ok(
      snap.problems.some((p) => named(p) && p.includes('bad*name.md')),
      snap.problems.join('; '),
    );
    const report = await o.connector.check();
    assert.ok(report.problems.some((p: string) => p.includes('controller-mode/bad*name.md')));
    await assert.rejects(
      () => o.connector.prepareRun(o.h),
      (e: unknown) => e instanceof HarnessError && e.code === 'NOT_READY',
    );
    assert.equal(s.calls.writer, 0);
    o.close();
  } finally {
    await s.cleanup();
  }
});

test('снимок: граф, не собранный из данных задач, — NOT_READY с причиной и полем, а не ZodError', () => {
  const config = parseConfig(
    {
      version: 1,
      provider: 'relay-v1-http',
      projectId: 'p1',
      actor: 'harness',
      relay: { endpoint: 'http://127.0.0.1:1' },
      repository: { id: 'app' },
      tasks: [{ ref: 'T1', writeScope: ['src'] }],
    },
    '/project',
  ).config;
  const dependencies = Array.from({ length: 101 }, (_, i) => ({
    id: 'D' + i,
    key: 'D-' + i,
    title: 'Dep',
    column: 'done' as const,
    revision: 1,
    finished: true,
  }));
  assert.throws(
    () =>
      buildSnapshot({
        config,
        identity: { provider: 'relay-v1-http', projectId: 'p1', capabilities: [], build: {} },
        reads: [
          {
            task: {
              id: 'T1',
              key: 'K-1',
              title: 'Greet',
              description: 'Add greet(name)',
              column: 'ready',
              revision: 1,
              parentId: null,
              dependencies: dependencies.map((d) => d.id),
              criteria: [],
            },
            children: [],
            dependencies,
            documents: [],
            consistency: { before: 'x', after: 'x' },
          },
        ],
        rounds: 2,
        receiptOf: (orderId) => ({
          issuer: 'i',
          orderId,
          taskId: 'D',
          repositoryId: 'app',
          resultSha: '1'.repeat(40),
          workId: 'w',
          runId: 'r',
          operation: 'o',
        }),
      }),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'NOT_READY' &&
      /dependsOn/.test(e.message) &&
      e.issues.some((i) => i.path.join('.') === 'source.orders.0.dependsOn'),
  );
});

test('договор CLI: нарушение схемы — INTERNAL с путями полей, сообщение не дамп ZodError', () => {
  const parsed = z
    .strictObject({ a: z.strictObject({ b: z.string() }) })
    .safeParse({ a: { b: 1 } });
  assert.ok(!parsed.success);
  const known = contractViolation(parsed.error);
  assert.equal(known.code, 'INTERNAL');
  assert.deepEqual(known.issues[0]?.path, ['a', 'b']);
  assert.match(known.message, /a\.b: /);
  assert.doesNotMatch(known.message, /"code"/);
  const thrown = (() => {
    try {
      z.string().parse(1);
    } catch (error) {
      return error;
    }
  })();
  assert.ok(thrown instanceof z.ZodError, 'то, что бросает .parse, распознаёт CLI');
});
