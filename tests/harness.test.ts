/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тесты портят сырой JSON политики и графа до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_VERSION,
  HarnessError,
  digestOf,
  executionPolicySchema,
  sha256,
  sourceDigest,
  workGraphSchema,
  type ContextSnapshot,
  type ContractDocument,
  type ErrorCode,
  type WorkGraph,
} from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, greet, implement, target } from './runner-fixture.ts';

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};
const graphWith = (graph: WorkGraph, patch: (o: any, g: any) => void) => {
  const raw = structuredClone(graph) as any;
  patch(raw.orders[0], raw);
  return workGraphSchema.parse(raw);
};

test('S1-R1-01: результат завершённой попытки не меняется новой редакцией графа — при неизменном, изменённом и удалённом поручении, и после переоткрытия', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  let h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  const first = h.result('add-greeting').result;
  assert.equal(first.outcome, 'accepted');
  const snapshot = JSON.stringify(first);
  // Неизменное поручение в новой редакции графа (меняется только заголовок источника графа).
  await h.run({
    graph: graphWith(ctx.graph, (_o, g) => (g.source.revision = '2')),
    author: 'claude',
  });
  assert.equal(
    JSON.stringify(h.result('add-greeting', first.runId).result),
    snapshot,
    'неизменное поручение',
  );
  // Изменённое поручение: новая попытка, прежний результат — прежний.
  await h.run({
    graph: graphWith(ctx.graph, (o, g) => {
      g.source.revision = '3';
      o.source.revision = '3';
      o.goal = 'Добавить greet(name) — вторая редакция.';
    }),
    author: 'claude',
  });
  assert.equal(
    JSON.stringify(h.result('add-greeting', first.runId).result),
    snapshot,
    'изменённое поручение',
  );
  assert.notEqual(
    h.result('add-greeting').result.runId,
    first.runId,
    'новая редакция — новая попытка',
  );
  // Удалённое поручение: история читается без ошибок.
  const removed = graphWith(ctx.graph, (o, g) => {
    g.source.revision = '4';
    o.id = 'other';
    o.source.ref = 'other';
  });
  h.engine.register(removed, { trusted: () => false, reachable: () => true });
  assert.equal(
    JSON.stringify(h.result('add-greeting', first.runId).result),
    snapshot,
    'удалённое поручение',
  );
  h.close();
  h = ctx.open();
  assert.equal(
    JSON.stringify(h.result('add-greeting', first.runId).result),
    snapshot,
    'после переоткрытия',
  );
  h.close();
});

const snapshotOf = (files: Record<string, string>, repositoryId?: string): ContextSnapshot => {
  const pinned = Object.entries(files).map(([path, text]) => ({
    path,
    digest: sha256(text),
    bytes: Buffer.byteLength(text),
    content: { encoding: 'utf8' as const, data: text },
  }));
  const entry = {
    id: 'norms',
    kind: 'files',
    version: '1',
    ...(repositoryId ? { repositoryId } : {}),
    required: true,
    files: pinned,
    references: [],
  };
  return {
    apiVersion: API_VERSION,
    sources: [{ ...entry, digest: sourceDigest(entry) }],
    missing: [],
  };
};

test('S1-R1-02: обязательный контекст без снимка — отказ до попытки; правка закреплённого контекстного файла — нарушение области', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    graph: (g) => ((g as any).orders[0].context = ['norms']),
  });
  const h = ctx.open();
  await assert.rejects(h.run({ graph: ctx.graph, author: 'claude' }), refused('NOT_READY'));
  assert.equal(
    h.engine.read((v) => v.attempts().length),
    0,
  );
  assert.equal(ctx.calls('claude', 'writer'), 0, 'writer не вызывался');
  h.close();

  const norms = 'Правило: функции экспортируются через exports.\n';
  const repoCtx = hsetup({
    scenario: {
      writer: implement({ 'src/greet.js': greet, 'src/context.md': 'подменено\n' }),
      reviewer: approve(),
    },
    files: { 'src/context.md': norms },
    graph: (g) => ((g as any).orders[0].context = ['norms']),
    policy: (p) => ((p as any).maxAttempts = 1),
  });
  const h2 = repoCtx.open();
  await h2.run({
    graph: repoCtx.graph,
    author: 'claude',
    context: snapshotOf({ 'src/context.md': norms }, 'app'),
  });
  const work = h2.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'scope-violation');
  assert.match(work.failure!, /защищённые файлы: src\/context\.md/);
  h2.close();
});

test('S1-R1-03: требование с изменённым источником — отказ до writer; актуальное — псевдо-gate в обеих фазах и testcase-доказательство', async () => {
  const text = '## REQ-1 Приветствие\n\ngreet("Ada") возвращает Hello, Ada!';
  const requirement = (source: string) => ({
    id: 'REQ-1',
    source,
    digest: sha256(text),
    text,
    gate: 'unit',
    scenario: 'Приветствие по имени',
    testId: 'greet.greets',
  });
  const ok = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    files: { 'spec.md': text + '\n' },
    graph: (g) => ((g as any).orders[0].requirements = [requirement('spec.md')]),
  });
  let h = ok.open();
  await h.run({ graph: ok.graph, author: 'claude' });
  const a = h.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(
    h.engine.read((v) => v.work('add-greeting')!.status),
    'done',
    a.error,
  );
  for (const phase of ['candidate', 'integration'])
    assert.ok(
      a.evidence.some((e) => e.gate === 'requirement-source' && e.phase === phase && e.passed),
      phase,
    );
  h.close();

  const stale = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    files: { 'spec.md': text + '\n' },
    graph: (g) => ((g as any).orders[0].requirements = [requirement('spec.md')]),
    policy: (p) => ((p as any).maxAttempts = 1),
  });
  writeFileSync(
    join(stale.repo.dir, 'spec.md'),
    '## REQ-1 Приветствие\n\nДругой текст требования.\n',
  );
  stale.repo.git('commit', '-qam', 'spec changed');
  h = stale.open();
  await h.run({ graph: stale.graph, author: 'claude' });
  const work = h.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.match(work.failure!, /Требования изменились или удалены: REQ-1/);
  assert.equal(stale.calls('claude', 'writer'), 0, 'writer не вызывался');
  h.close();

  // testId, которого нет в отчёте, — приёмки нет.
  const unproven = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    files: { 'spec.md': text + '\n' },
    graph: (g) =>
      ((g as any).orders[0].requirements = [
        { ...requirement('spec.md'), testId: 'greet.missing' },
      ]),
    policy: (p) => ((p as any).maxAttempts = 1),
  });
  h = unproven.open();
  const before = target(unproven);
  await h.run({ graph: unproven.graph, author: 'claude' });
  assert.equal(
    h.engine.read((v) => v.work('add-greeting')!.status),
    'failed',
  );
  assert.match(
    h.engine.read((v) => v.work('add-greeting')!.failure!),
    /greet\.missing не выполнялся/,
  );
  assert.equal(target(unproven), before);
  h.close();
});

test('S1-R2-01: источник требований, изменённый или удалённый во время ревью интеграции, — приёмки нет, target неподвижен', async () => {
  const text = '## REQ-1 Приветствие\n\ngreet("Ada") возвращает Hello, Ada!';
  for (const variant of ['change', 'delete'] as const) {
    const ctx = hsetup({
      scenario: { writer: implement(), reviewer: approve() },
      files: { 'spec.md': text + '\n' },
      graph: (g) =>
        ((g as any).orders[0].requirements = [
          {
            id: 'REQ-1',
            source: 'spec.md',
            digest: sha256(text),
            text,
            gate: 'unit',
            scenario: 'Приветствие по имени',
            testId: 'greet.greets',
          },
        ]),
      policy: (p) => ((p as any).maxAttempts = 1),
    });
    // Ревью интеграции (третий вызов reviewer: план, кандидат, интеграция)
    // меняет источник отдельным коммитом основного checkout.
    let reviews = 0;
    const h = ctx.open(ctx.policy, (inner) => ({
      runtime: inner.runtime,
      capabilities: () => inner.capabilities(),
      invoke: async (request, signal) => {
        const response = await inner.invoke(request, signal);
        if (inner.runtime === 'codex' && ++reviews === 3) {
          if (variant === 'change') {
            writeFileSync(join(ctx.repo.dir, 'spec.md'), '## REQ-1 Приветствие\n\nДругое.\n');
            ctx.repo.git('commit', '-qam', 'spec changed');
          } else {
            ctx.repo.git('rm', '-q', 'spec.md');
            ctx.repo.git('commit', '-qm', 'spec removed');
          }
        }
        return response;
      },
    }));
    const before = target(ctx);
    await h.run({ graph: ctx.graph, author: 'claude' });
    assert.equal(reviews, 3, 'изменение сделано во время ревью интеграции');
    const a = h.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.ok(
      a.evidence.some(
        (e) => e.gate === 'requirement-source' && e.phase === 'integration' && e.passed,
      ),
      'источник был актуален на проверке интеграции',
    );
    assert.equal(a.status, 'failed', variant);
    assert.match(
      a.error!,
      variant === 'change'
        ? /Требования изменились или удалены: REQ-1/
        : /Источник требований должен быть обычным Git-файлом: spec\.md/,
      variant,
    );
    assert.equal(target(ctx), before, 'target неподвижен: ' + variant);
    assert.notEqual(
      h.engine.read((v) => v.work('add-greeting')!.status),
      'done',
      variant,
    );
    h.close();
  }
});

test('S1-R1-04: поручение со ссылкой на контракт без одобренного ревью этого digest не выдаётся', async () => {
  const doc: ContractDocument = {
    apiVersion: API_VERSION,
    id: 'api',
    title: 'API приветствия',
    content: 'greet(name) возвращает строку Hello, <name>!',
  };
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    graph: (g) => ((g as any).orders[0].contracts = [{ id: 'api', digest: digestOf(doc) }]),
  });
  const h = ctx.open();
  const blocked = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(
    h.engine.read((v) => v.attempts().length),
    0,
    'без ревью контракта попытки нет',
  );
  assert.ok(blocked.works[0]!.blockers.some((b) => /Контракт api не проходил/.test(b.message)));
  // Ревью другой редакции контракта не подходит.
  await h.review({
    kind: 'contract',
    contract: { ...doc, content: doc.content + ' Иначе.' },
    author: 'claude',
  });
  await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(
    h.engine.read((v) => v.attempts().length),
    0,
  );
  await h.review({ kind: 'contract', contract: doc, author: 'claude' });
  await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(
    h.engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  h.close();
});

test('S1-R1-05/T31: прежний раунд ревью не подтверждает смену reviewer политикой; plan и contract — обеих пар настоящим subprocess', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const doc: ContractDocument = {
    apiVersion: API_VERSION,
    id: 'api',
    title: 'API',
    content: 'Контракт API целиком.',
  };
  let h = ctx.open();
  for (const kind of ['plan', 'contract'] as const) {
    const input =
      kind === 'plan'
        ? { kind, graph: ctx.graph, author: 'claude' as const }
        : { kind, contract: doc, author: 'claude' as const };
    const before = ctx.calls('codex', 'reviewer');
    const r1 = await h.review(input);
    assert.equal(r1.reviewerRuntime, 'codex');
    assert.equal(ctx.calls('codex', 'reviewer'), before + 1, kind + ': вызов fixture runtime');
    assert.equal((await h.review(input)).round, 1, kind + ': то же назначение — без вызова');
    assert.equal(ctx.calls('codex', 'reviewer'), before + 1);
  }
  h.close();
  // Обратная пара для обоих видов: автор codex, reviewer claude.
  const raw = structuredClone(ctx.policy) as any;
  for (const kind of ['plan', 'contract']) raw.review[kind] = { reviewer: { runtime: 'claude' } };
  h = ctx.open(executionPolicySchema.parse(raw));
  await assert.rejects(
    h.review({ kind: 'plan', graph: ctx.graph, author: 'claude' }),
    refused('REVIEWER_SAME_VENDOR'),
  );
  await assert.rejects(
    h.review({ kind: 'contract', contract: doc, author: 'claude' }),
    refused('REVIEWER_SAME_VENDOR'),
  );
  const backPlan = await h.review({ kind: 'plan', graph: ctx.graph, author: 'codex' });
  const backContract = await h.review({ kind: 'contract', contract: doc, author: 'codex' });
  assert.equal(backPlan.reviewerRuntime, 'claude');
  assert.equal(backContract.reviewerRuntime, 'claude');
  assert.equal(backContract.sameVendor, false);
  assert.equal(ctx.calls('claude', 'reviewer'), 2, 'оба вида — настоящий вызов claude');
  h.close();
});

test('S1-R2-02: смена только модели, только effort или только содержимого профиля reviewer — новый раунд plan и contract', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: any) => {
      p.toolProfiles = { rev: { runtime: 'codex', codexShell: true } };
      for (const k of ['plan', 'contract']) p.review[k].reviewer.toolProfile = 'rev';
    },
  });
  const doc: ContractDocument = {
    apiVersion: API_VERSION,
    id: 'api',
    title: 'API',
    content: 'Контракт API целиком.',
  };
  const inputs = [
    { kind: 'plan' as const, graph: ctx.graph, author: 'claude' as const },
    { kind: 'contract' as const, contract: doc, author: 'claude' as const },
  ];
  const variants: [string, (p: any) => void][] = [
    ['исходное', () => {}],
    ['модель', (p) => (p.review.plan.reviewer.model = p.review.contract.reviewer.model = 'm-2')],
    ['effort', (p) => (p.review.plan.reviewer.effort = p.review.contract.reviewer.effort = 'low')],
    ['tools', (p) => (p.toolProfiles.rev.codexShell = false)],
  ];
  const raw = structuredClone(ctx.policy) as any;
  for (const [round, [name, change]] of variants.entries()) {
    change(raw);
    const h = ctx.open(executionPolicySchema.parse(raw));
    for (const input of inputs) {
      const before = ctx.calls('codex', 'reviewer');
      const record = await h.review(input);
      assert.equal(record.round, round + 1, `${input.kind}: ${name} — новый раунд`);
      assert.equal(ctx.calls('codex', 'reviewer'), before + 1, `${input.kind}: ${name} — вызов`);
      assert.equal((await h.review(input)).round, round + 1, `${input.kind}: ${name} — кэш`);
    }
    h.close();
  }
});

test('S1-R1-06: пауза человека до первого запуска сохраняется; первый запуск очереди её не снимает', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  h.engine.pause('operator');
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(
    h.engine.read((v) => v.attempts().length),
    0,
  );
  assert.equal(ctx.calls('claude', 'writer'), 0);
  assert.ok(data.works[0]!.blockers.some((b) => b.code === 'PAUSED'));
  assert.equal(
    h.engine.read((v) => v.control().pauseReason),
    'operator',
  );
  h.engine.resume();
  await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(
    h.engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  h.close();
});

test('S1-R1-07/T04: работающий controller продлевает роль; второй не захватывает её; завершившийся освобождает', async () => {
  const ctx = hsetup({
    scenario: { writer: { ...implement(), sleepMs: 7500 }, reviewer: approve() },
    policy: (p) => ((p as any).leaseMs = 5000),
  });
  const h = ctx.open();
  const running = h.run({ graph: ctx.graph, author: 'claude' });
  await new Promise((r) => setTimeout(r, 6000));
  const other = new Engine({
    host: standaloneHost(new SqliteExecutionStore(ctx.statePath, 'other'), ctx.policy),
    policy: ctx.policy,
  });
  assert.equal(other.lead('other-process'), false, 'роль продлена, пока идёт работа');
  await running;
  assert.equal(
    h.engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  assert.equal(
    h.engine.read((v) => v.controller()),
    undefined,
    'завершившийся освободил роль',
  );
  assert.equal(other.lead('other-process'), true);
  other.release('other-process');
  other.host.store.close();
  h.close();
});

test('S1-R2-03: run при действующей чужой роли controller — явный CONTROLLER_BUSY; чужая роль сохранена, выдачи нет', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const other = new Engine({
    host: standaloneHost(new SqliteExecutionStore(ctx.statePath, 'other'), ctx.policy),
    policy: ctx.policy,
  });
  assert.equal(other.lead('occupied-controller'), true);
  const h = ctx.open();
  await assert.rejects(h.run({ graph: ctx.graph, author: 'claude' }), refused('CONTROLLER_BUSY'));
  assert.equal(
    h.engine.read((v) => v.attempts().length),
    0,
  );
  assert.equal(ctx.calls('claude', 'writer'), 0);
  assert.equal(
    h.engine.read((v) => v.controller()?.owner),
    'occupied-controller',
  );
  other.release('occupied-controller');
  other.host.store.close();
  await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(
    h.engine.read((v) => v.work('add-greeting')!.status),
    'done',
    'после освобождения роли очередь продолжается',
  );
  h.close();
});

test('S1-R1-09: окружение профиля инструментов reviewer применяется; недостающий секрет профиля — отказ окружения до вызова', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: any) => {
      p.toolProfiles = {
        rev: { runtime: 'codex', environment: { values: { PROFILE_MARKER: 'yes' } } },
      };
      p.review.code.reviewer.toolProfile = 'rev';
    },
  });
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(
    h.engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  // Вызов 0 — ревью плана (без профиля), 1 и 2 — ревью кода с профилем.
  assert.equal(ctx.callEnv('codex', 'reviewer', 1)?.get('PROFILE_MARKER'), 'yes');
  assert.equal(
    ctx.callEnv('codex', 'reviewer', 0)?.get('PROFILE_MARKER'),
    undefined,
    'профиль — только у своего назначения',
  );
  h.close();

  const missing = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: any) => {
      p.toolProfiles = {
        rev: {
          runtime: 'codex',
          environment: { secrets: { PROFILE_TOKEN: 'HARNESS_TEST_NOT_SET_7f3' } },
        },
      };
      p.review.code.reviewer.toolProfile = 'rev';
      p.maxAttempts = 1;
    },
  });
  const h2 = missing.open();
  await h2.run({ graph: missing.graph, author: 'claude' });
  const work = h2.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.match(work.failure!, /Не задан секрет окружения: HARNESS_TEST_NOT_SET_7f3/);
  assert.equal(work.failureKind, 'environment');
  assert.equal(missing.callEnv('codex', 'reviewer', 1), undefined, 'ревью кода не вызывалось');
  h2.close();
});

test('S1-R1-10/T11: верхнеуровневый policy.lifecycle исполняется; отказ setup до writer, отказ ready, отказ очистки только интеграции', async () => {
  const step = (id: string, script: string) => ({ id, command: [process.execPath, '-e', script] });
  for (const [lifecycle, reason, writerCalled] of [
    [
      { setup: [step('boot', 'process.exit(3)')], ready: [], teardown: [step('down', '0')] },
      /Шаг boot: exit=3/,
      false,
    ],
    [
      { setup: [], ready: [step('wait', 'process.exit(5)')], teardown: [step('down', '0')] },
      /Шаг wait: exit=5/,
      false,
    ],
    [
      {
        setup: [],
        ready: [],
        teardown: [step('down', "process.exit(process.env.DEVCONTOUR_PHASE==='integration'?4:0)")],
      },
      /Очистка окружения не завершена/,
      true,
    ],
  ] as const) {
    const ctx = hsetup({
      scenario: { writer: implement(), reviewer: approve() },
      policy: (p: any) => ((p.lifecycle = lifecycle), (p.maxAttempts = 1)),
    });
    const h = ctx.open();
    const before = target(ctx);
    await h.run({ graph: ctx.graph, author: 'claude' });
    const work = h.engine.read((v) => v.work('add-greeting')!);
    assert.equal(work.status, 'failed');
    assert.match(work.failure!, reason);
    assert.equal(ctx.calls('claude', 'writer') > 0, writerCalled);
    assert.equal(target(ctx), before, 'принятия нет');
    h.close();
  }
});

test('S1-R1-11: граф из 40 поручений согласуется атомарно', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  const big = workGraphSchema.parse({
    ...ctx.graph,
    id: 'big',
    source: { connector: 'files', ref: 'big', revision: '1' },
    orders: Array.from({ length: 40 }, (_, i) => ({
      ...ctx.graph.orders[0],
      id: 'w' + i,
      source: { connector: 'files', ref: 'w' + i, revision: '1' },
    })),
  });
  h.engine.register(big, { trusted: () => false, reachable: () => true });
  await h.review({ kind: 'plan', graph: big, author: 'claude' });
  h.engine.approve('big', 'agent');
  assert.equal(
    h.engine.read((v) => v.works('big').filter((w) => w.status === 'ready').length),
    40,
  );

  h.close();
});

test('S1-R2-04: секрет профиля из сырого ответа reviewer маскируется в review.json, evidence и результате (plan, contract, code)', async () => {
  const canary = 'canary-7f3a9c-secret';
  process.env.HARNESS_TEST_CANARY_7f3 = canary;
  try {
    const ctx = hsetup({
      scenario: { writer: implement(), reviewer: approve() },
      policy: (p: any) => {
        p.toolProfiles = {
          rev: {
            runtime: 'codex',
            environment: { secrets: { PROFILE_TOKEN: 'HARNESS_TEST_CANARY_7f3' } },
          },
        };
        for (const k of ['plan', 'contract', 'code']) p.review[k].reviewer.toolProfile = 'rev';
      },
    });
    // Допустимый библиотечный адаптер: сырой структурированный ответ несёт
    // значение в summary и в сохраняемых полях находки (path, rule).
    const received = new Set<string>();
    const h = ctx.open(ctx.policy, (inner) => ({
      runtime: inner.runtime,
      capabilities: () => inner.capabilities(),
      invoke: async (request, signal) => {
        const response = await inner.invoke(request, signal);
        const token = request.env.PROFILE_TOKEN;
        if (token === canary) received.add(request.task);
        if (!token || response.status !== 'ok') return response;
        const output = response.output as any;
        return {
          ...response,
          output: {
            ...output,
            summary: `${output.summary} ${token}`,
            findings: [
              ...(output.findings ?? []),
              {
                severity: 'note',
                message: 'заметка',
                path: `src/${token}.js`,
                line: null,
                rule: `rule-${token}`,
                consequence: null,
                evidence: null,
              },
            ],
          },
        };
      },
    }));
    const doc: ContractDocument = {
      apiVersion: API_VERSION,
      id: 'api',
      title: 'API',
      content: 'Контракт API целиком.',
    };
    const contract = await h.review({ kind: 'contract', contract: doc, author: 'claude' });
    await h.run({ graph: ctx.graph, author: 'claude' });
    const plan = h.engine.reviews('plan', ctx.graph.id).at(-1)!;
    const a = h.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(a.status, 'succeeded', a.error);
    // Секрет профиля получил каждый вид reviewer.
    assert.deepEqual([...received].sort(), ['review-code', 'review-contract', 'review-plan']);
    // Каждое сохраняемое представление проверяется отдельно: значение в нём
    // было и замаскировано.
    const persisted: [string, string][] = [
      ['артефакт плана', readFileSync(plan.artifact, 'utf8')],
      ['запись плана', JSON.stringify(plan)],
      ['артефакт контракта', readFileSync(contract.artifact, 'utf8')],
      ['запись контракта', JSON.stringify(contract)],
      ['evidence кода', JSON.stringify(a.evidence.filter((e) => e.kind === 'review'))],
      ...a.evidence
        .filter((e) => e.kind === 'review')
        .map((e): [string, string] => [
          'артефакт ревью кода ' + e.phase,
          readFileSync(e.log, 'utf8'),
        ]),
    ];
    for (const [name, text] of persisted) {
      assert.ok(text.includes('[REDACTED]'), name + ': значение было и замаскировано');
      assert.ok(!text.includes(canary), name + ': секрет сохранён');
    }
    for (const record of [plan, contract])
      assert.ok(
        record.findings.some(
          (f) => f.path?.includes('[REDACTED]') && f.rule?.includes('[REDACTED]'),
        ),
        record.kind + ': path и rule находки замаскированы',
      );
    assert.ok(!JSON.stringify(h.result('add-greeting').result).includes(canary), 'результат');
    h.close();
  } finally {
    delete process.env.HARNESS_TEST_CANARY_7f3;
  }
});

test('T02: предпосылка с результатом движка проверяется настоящей доступностью SHA в target ref', async () => {
  const ctx = hsetup({
    scenario: {
      writer: [implement(), implement({ 'src/farewell.js': 'exports.bye = () => 1;\n' })],
      reviewer: approve(),
    },
  });
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  const done = h.engine.read((v) =>
    v.attempts('add-greeting').find((a) => a.status === 'succeeded')!,
  );
  const withPrereq = (sha: string, id: string) =>
    workGraphSchema.parse({
      ...ctx.graph,
      id,
      source: { connector: 'files', ref: id, revision: '1' },
      orders: [
        {
          ...ctx.graph.orders[0],
          id: id + '-b',
          source: { connector: 'files', ref: id + '-b', revision: '1' },
          dependsOn: ['ext'],
        },
      ],
      prerequisites: [
        {
          id: 'ext',
          repositoryId: 'app',
          resultSha: sha,
          receipt: { kind: 'engine', runId: done.id },
        },
      ],
    });
  // Подтверждение движка корректно (тот же runId и его integration SHA),
  // но SHA недоступен из target ref — отказ настоящей проверкой Git.
  const ref = ctx.policy.repositories[0]!.targetRef;
  ctx.repo.git('update-ref', ref, done.baseSha!);
  await assert.rejects(
    h.run({ graph: withPrereq(done.integrationSha!, 'g-unreachable'), author: 'claude' }),
    refused('NOT_READY'),
  );
  ctx.repo.git('update-ref', ref, done.integrationSha!);
  // Несовпадение SHA с подтверждением — тоже отказ.
  await assert.rejects(
    h.run({ graph: withPrereq(done.candidateSha!, 'g-wrong'), author: 'claude' }),
    refused('NOT_READY'),
  );
  const okRun = await h.run({ graph: withPrereq(done.integrationSha!, 'g-ok'), author: 'claude' });
  assert.equal(okRun.works[0]!.status, 'done');
  h.close();
});

test('T08/T09: ревьюер недоступен — отказ окружения; отклонённое ревью интеграции — не принято; артефакт ревью сохранён', async () => {
  const unavailable = hsetup({
    scenario: {
      writer: implement(),
      reviewer: [approve(), { started: false, exit: 1, stderr: 'Not logged in' }],
    },
    policy: (p: any) => (p.maxAttempts = 1),
  });
  let h = unavailable.open();
  await h.run({ graph: unavailable.graph, author: 'claude' });
  let work = h.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.match(work.failure!, /runtime недоступен/);
  assert.equal(
    h.engine.read((v) => v.attempts()[0]!.evidence.some((e) => e.kind === 'review' && e.passed)),
    false,
  );
  h.close();

  const reject = { ...approve() };
  (reject.result as any) = {
    ...approve().result,
    approved: false,
    summary: 'не покрыт пустой ввод',
  };
  const red = hsetup({
    scenario: { writer: implement(), reviewer: [approve(), approve(), reject] },
    policy: (p: any) => (p.maxAttempts = 1),
  });
  h = red.open();
  const before = target(red);
  await h.run({ graph: red.graph, author: 'claude' });
  work = h.engine.read((v) => v.work('add-greeting')!);
  const a = h.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(work.status, 'failed');
  assert.ok(a.evidence.some((e) => e.kind === 'review' && e.phase === 'candidate' && e.passed));
  const integration = a.evidence.find((e) => e.kind === 'review' && e.phase === 'integration')!;
  assert.equal(integration.passed, false);
  assert.ok((await import('node:fs')).existsSync(integration.log), 'review.json сохранён');
  assert.equal(target(red), before);
  h.close();
});

test('T28: повторное ревью плана — каждая прежняя находка получает состояние с основанием; история не стирается', async () => {
  const blocking = {
    severity: 'blocking',
    message: 'Нет критерия для ошибки ввода',
    path: null,
    line: null,
    rule: 'ac-missing',
    consequence: null,
    evidence: null,
  };
  const note = {
    severity: 'note',
    message: 'Заголовок можно сократить',
    path: null,
    line: null,
    rule: null,
    consequence: null,
    evidence: null,
  };
  const reject = (findings: unknown[], previous: unknown[] = []) => ({
    result: {
      approved: false,
      summary: 'Есть замечания',
      findings,
      discoveries: [],
      execution: { commands: [], noCommandsReason: 'Ревью плана' },
      previous,
    },
  });
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const subject = ctx.graph.id;
  const { findingId } = await import('../src/contracts/index.ts');
  const idB = findingId(subject, blocking);
  const idN = findingId(subject, note);
  const steps = [
    reject([blocking, note]),
    // Раунд 2 молчит о прежней блокирующей находке и «переименовывает» её — не согласует.
    {
      result: {
        ...approve().result,
        findings: [{ ...blocking, message: 'Нет критерия для ошибки ввода (уточнено)' }],
        previous: [{ id: idN, status: 'withdrawn', basis: 'не относится к плану' }],
      },
    },
    // Раунд 3 называет состояние каждой открытой находки с основанием.
    {
      result: {
        ...approve().result,
        previous: [
          { id: idB, status: 'closed', basis: 'добавлен критерий: greet("") возвращает ошибку' },
          {
            id: findingId(subject, {
              rule: 'ac-missing',
              message: 'Нет критерия для ошибки ввода (уточнено)',
            }),
            status: 'closed',
            basis: 'то же исправление',
          },
        ],
      },
    },
  ];
  writeFileSync(ctx.scenarioPath, JSON.stringify({ writer: implement(), reviewer: steps }));
  const h = ctx.open();
  const r1 = await h.review({ kind: 'plan', graph: ctx.graph, author: 'claude' });
  assert.equal(r1.approved, false);
  const fixed = graphWith(ctx.graph, (o, g) => {
    g.source.revision = '2';
    o.source.revision = '2';
    o.acceptance = [...o.acceptance, 'greet("") возвращает ошибку'];
  });
  const r2 = await h.review({ kind: 'plan', graph: fixed, author: 'claude' });
  assert.equal(r2.round, 2);
  assert.equal(r2.approved, false, 'прежняя блокирующая находка без состояния');
  assert.match(r2.summary, new RegExp('Не названо состояние прежней находки ' + idB));
  assert.equal(r2.findings.find((f) => f.id === idN)?.status, 'withdrawn');
  assert.equal(r2.findings.find((f) => f.id === idN)?.basis, 'не относится к плану');
  assert.equal(r2.findings.find((f) => f.id === idB)?.status, 'open', 'не закрыта молчанием');
  assert.equal(
    h.engine.read((v) => v.graph(subject)?.approval),
    undefined,
    'неодобренный раунд не согласует граф',
  );
  const r3 = await h.review({ kind: 'plan', graph: fixed, author: 'claude' });
  assert.equal(r3.round, 3);
  assert.equal(r3.approved, true, r3.summary);
  const closed = r3.findings.find((f) => f.id === idB)!;
  assert.equal(closed.status, 'closed');
  assert.equal(closed.openedIn, 1);
  assert.equal(closed.changedIn, 3);
  assert.match(closed.basis!, /добавлен критерий/);
  assert.equal(
    r3.findings.find((f) => f.id === idN)?.changedIn,
    2,
    'история прежнего раунда сохранена',
  );
  assert.deepEqual(
    h.engine.reviews('plan', subject).map((r) => [r.round, r.approved]),
    [
      [1, false],
      [2, false],
      [3, true],
    ],
  );
  h.close();
});
