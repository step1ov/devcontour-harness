/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тесты портят сырой JSON политики и графа до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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

test('S1-R1-05/T31: прежний раунд ревью не подтверждает смену reviewer политикой; plan и contract ревью — настоящим subprocess обеих пар', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  let h = ctx.open();
  const r1 = await h.review({ kind: 'plan', graph: ctx.graph, author: 'claude' });
  assert.equal(r1.reviewerRuntime, 'codex');
  assert.equal(ctx.calls('codex', 'reviewer'), 1, 'ревью плана — вызов fixture runtime');
  assert.equal(
    await h.review({ kind: 'plan', graph: ctx.graph, author: 'claude' }).then((r) => r.round),
    1,
    'тот же digest и назначение — без вызова',
  );
  assert.equal(ctx.calls('codex', 'reviewer'), 1);
  h.close();
  const raw = structuredClone(ctx.policy) as any;
  raw.review.plan = { reviewer: { runtime: 'claude' }, vendor: 'different-vendor' };
  h = ctx.open(executionPolicySchema.parse(raw));
  await assert.rejects(
    h.review({ kind: 'plan', graph: ctx.graph, author: 'claude' }),
    refused('REVIEWER_SAME_VENDOR'),
  );
  // Обратная пара: автор codex, reviewer claude — настоящий вызов claude.
  const back = await h.review({ kind: 'plan', graph: ctx.graph, author: 'codex' });
  assert.equal(back.reviewerRuntime, 'claude');
  assert.equal(back.round, 2);
  assert.equal(ctx.calls('claude', 'reviewer'), 1);
  h.close();
  raw.review.plan = { reviewer: { runtime: 'codex', model: 'other-model' } };
  h = ctx.open(executionPolicySchema.parse(raw));
  const changed = await h.review({ kind: 'plan', graph: ctx.graph, author: 'claude' });
  assert.equal(changed.round, 3, 'смена модели reviewer — новый раунд, а не кэш');
  const doc: ContractDocument = {
    apiVersion: API_VERSION,
    id: 'api',
    title: 'API',
    content: 'Контракт API целиком.',
  };
  const contract = await h.review({ kind: 'contract', contract: doc, author: 'claude' });
  assert.equal(contract.reviewerRuntime, 'codex');
  assert.equal(contract.sameVendor, false);
  h.close();
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

test('S1-R1-07/T04/T14: работающий controller продлевает роль; второй не захватывает её; завершившийся освобождает; новый процесс продолжает', async () => {
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
  // Результат движка с SHA, которого нет в target ref (кандидат), — отказ.
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
