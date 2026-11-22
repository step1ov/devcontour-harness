/**
 * P4-6 (пилот 4): все задачи приняты harness, доставки подтверждены, но
 * задачи у получателя не закрыты — привязки критериев называли testcase без
 * classname (`orders.api.access` вместо `test.orders.api.access`: node:test
 * пишет `classname="test"`). Здесь то же на fixture: testcase отчёта
 * `greet.greets`, привязка `greets`.
 *
 * Проверяется: причина «не доказан» называет отсутствие и похожий ID;
 * правка привязок не меняет постановку (ни нового плана, ни доработки);
 * `source-deliver --reprove` закрывает задачу тем же результатом без
 * моделей, повтор ничего не отправляет; изменённая постановка — conflict с
 * причиной; запуск с недоказуемой привязкой — отказ до попыток. И P4-3:
 * правка необязательного документа после приёмки не даёт конфликта доставки.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessError } from '../src/contracts/index.ts';
import {
  fakeSuiteBackend,
  harnessComments,
  scenario,
  type Scenario,
} from '../src/integrations/connector/testing.ts';
import { criteriaBindingIssues, knownTestcases } from '../src/integrations/connector/bindings.ts';
import { parseConfig } from '../src/integrations/connector/config.ts';
import {
  buildSnapshot,
  legacySemanticDigest,
  legacyStatementSame,
} from '../src/integrations/connector/snapshot.ts';
import type { TaskRead } from '../src/integrations/connector/transport.ts';

const wrong = { title: 'Greets by name', gate: 'unit', testId: 'greets' };
const fixBinding = (s: Scenario) => {
  (s.config.tasks as { criteria: { testId?: string }[] }[])[0]!.criteria[0]!.testId =
    'greet.greets';
};

test('P4-6/reproduce: принятый результат доставлен, критерий не доказан — причина называет отсутствие testcase и похожий ID; задача не закрыта', async () => {
  const s = await scenario(fakeSuiteBackend(), { mapping: [{ ...wrong }] });
  try {
    const { opened } = await s.snapshotAndRun();
    assert.equal(opened.h.engine.read((v) => v.work(s.workId))?.status, 'done');
    assert.equal(opened.h.result(s.workId).delivery.at(-1)?.status, 'delivered');
    const read = await opened.transport.readTask(s.task.id);
    assert.notEqual(read.task.column, 'done', 'задача не закрыта');
    assert.equal(read.task.criteria[0]!.completed, false);
    const op = opened.connector.store.operations({ workId: s.workId }).at(-1)!;
    const criteria = op.receipt!.criteria as { outcome: string; reason?: string }[];
    assert.equal(criteria[0]!.outcome, 'unproven');
    assert.match(criteria[0]!.reason!, /отсутствует в evidence gate unit \(есть greet\.greets/);
    // Без --reprove повтор доставки ничего не меняет: доставка подтверждена.
    const again = await opened.connector.deliver(opened.h, s.workId);
    assert.equal(again.deliveries[0]!.delivery.at(-1)?.status, 'delivered');
    assert.notEqual((await opened.transport.readTask(s.task.id)).task.column, 'done');
  } finally {
    await s.cleanup();
  }
});

test('P4-6/reprove: исправленная привязка — та же постановка (без нового плана и доработки); --reprove закрывает задачу тем же результатом без моделей; повтор — тот же ключ, без записей', async () => {
  const s = await scenario(fakeSuiteBackend(), { mapping: [{ ...wrong }] });
  try {
    const first = await s.snapshotAndRun();
    const revision = first.opened.connector.store.latestSnapshotAny()!.revision;
    const comments = (await harnessComments(first.opened.transport, s.task.id)).length;
    first.opened.close();
    const calls = { ...s.calls };

    fixBinding(s);
    const o = await s.open();
    // Правка привязок не меняет постановку: снимок тот же, запуск не требует согласования.
    const snap = await o.connector.snapshot();
    assert.equal(snap.revision, revision, 'ревизия набора та же');
    assert.equal(snap.created, false);
    await o.connector.prepareRun(o.h);
    const status = await o.connector.status(o.h);
    const task = status.tasks[0]!;
    assert.equal((task.remote as { matchesSnapshot: boolean }).matchesSnapshot, true);
    assert.equal(task.proof?.reprovable, 1);
    assert.match(task.proof?.next ?? '', /source-deliver --reprove/);

    const data = await o.connector.reprove(o.h);
    assert.equal(data.reprove, true);
    const delivery = data.deliveries[0]!.delivery;
    assert.equal(delivery.length, 1);
    assert.equal(delivery[0]!.status, 'delivered');
    assert.match(delivery[0]!.key, /:reprove-[a-f0-9]{16}:/);
    const read = await o.transport.readTask(s.task.id);
    assert.equal(read.task.column, 'done', 'задача закрыта');
    assert.equal(read.task.criteria[0]!.completed, true);
    const after = await harnessComments(o.transport, s.task.id);
    assert.equal(after.length, comments + 1, 'один комментарий повторного доказательства');
    assert.match(after.at(-1)!.body, /Повторное доказательство того же принятого результата/);
    assert.deepEqual(s.calls, calls, 'ни writer, ни reviewer не вызывались');
    const work = o.h.engine.read((v) => v.work(s.workId))!;
    assert.equal(work.status, 'done');
    assert.equal(work.rework, undefined, 'доработка не открыта');

    // Повтор с теми же привязками: тот же ключ, получатель не трогается.
    const writes = { ...o.transport.calls };
    const repeat = await o.connector.reprove(o.h, s.workId);
    assert.equal(repeat.deliveries[0]!.delivery[0]!.key, delivery[0]!.key);
    assert.equal(repeat.deliveries[0]!.delivery[0]!.status, 'delivered');
    for (const k of ['addComment', 'setCriterion', 'move'])
      assert.equal(o.transport.calls[k] ?? 0, writes[k] ?? 0, k + ' не вызывался');
    // Обычная доставка остаётся прежней записью.
    assert.equal(
      o.h.result(s.workId).delivery.filter((d) => !d.key.includes(':reprove-')).length,
      1,
    );
  } finally {
    await s.cleanup();
  }
});

test('P4-6/reprove-conflict: изменённая постановка — conflict с причиной, задача не закрывается старым результатом', async () => {
  const s = await scenario(fakeSuiteBackend(), { mapping: [{ ...wrong }] });
  try {
    (await s.snapshotAndRun()).opened.close();
    await s.project.admin.updateTask(s.task.id, { description: 'Совсем другая постановка v2.' });
    fixBinding(s);
    const o = await s.open();
    const data = await o.connector.reprove(o.h, s.workId);
    assert.equal(data.deliveries[0]!.delivery[0]!.status, 'conflict');
    const op = o.connector.store.operations({ workId: s.workId }).find((x) => x.reprove)!;
    assert.match(op.reason ?? '', /постановка изменилась/);
    const read = await o.transport.readTask(s.task.id);
    assert.notEqual(read.task.column, 'done');
    assert.equal(read.task.criteria[0]!.completed, false);
  } finally {
    await s.cleanup();
  }
});

test('P4-6/preflight: после первой попытки testcase gate известен — привязка без classname отказ NOT_READY до попыток; source-check называет её; исправленная проходит', async () => {
  const s = await scenario(fakeSuiteBackend(), { mapping: [{ ...wrong }] });
  try {
    const { opened } = await s.snapshotAndRun();
    await assert.rejects(
      opened.connector.prepareRun(opened.h),
      (e: unknown) =>
        e instanceof HarnessError &&
        e.code === 'NOT_READY' &&
        /Привязки критериев не доказываются/.test(e.message) &&
        /укажите testId «greet\.greets»/.test(e.message) &&
        /новый план не нужен/.test(e.message),
    );
    const known = (await import('../src/integrations/connector/commands.ts')).Connector.known(
      opened.h,
    );
    const check = await opened.connector.check(s.policy, s.repo, known);
    assert.ok(
      check.problems.some((p) => /greet\.greets/.test(p)),
      check.problems.join('\n'),
    );
    opened.close();
    fixBinding(s);
    const o = await s.open();
    await o.connector.prepareRun(o.h);
  } finally {
    await s.cleanup();
  }
});

test('P4-6/bindings: gate вне политики, без JUnit, вне gates задачи — ошибки; приставка classname — предупреждение; новый ID без отчётов — не ошибка', () => {
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
          ref: 'T-1',
          writeScope: ['src'],
          gates: ['unit', 'lint'],
          criteria: [
            { title: 'a', gate: 'nope', testId: 'x.a' },
            { title: 'b', gate: 'lint', testId: 'x.b' },
            { title: 'c', gate: 'e2e', testId: 'x.c' },
            { title: 'd', gate: 'unit', testId: 'orders.new' },
            { title: 'e', gate: 'unit', testId: 'test.orders.fresh' },
            { title: 'f', gate: 'lint', evidence: 'gate' },
          ],
        },
      ],
    },
    '/project',
  ).config;
  const gate = (id: string, report: boolean) => ({
    id,
    kind: report ? 'test' : 'check',
    command: ['true'],
    timeoutMs: 1000,
    ...(report ? { report: { type: 'junit', path: 'r.xml' } } : {}),
  });
  const policy = {
    repositories: [
      { id: 'app', gates: [gate('unit', true), gate('lint', false), gate('e2e', true)] },
    ],
  } as never;
  const known = knownTestcases([
    {
      gate: 'unit',
      phase: 'integration',
      tests: [{ id: 'test.orders.a', status: 'passed' }],
    } as never,
  ]);
  const issues = criteriaBindingIssues(config, policy, known);
  const by = (c: string) => issues.find((i) => i.criterion === c);
  assert.equal(by('a')?.level, 'error');
  assert.match(by('b')!.message, /нет JUnit-отчёта/);
  assert.match(by('c')!.message, /не входит в gates задачи/);
  assert.equal(by('d')?.level, 'warning');
  assert.match(by('d')!.message, /начинаются с «test\.»/);
  assert.equal(by('e'), undefined, 'новый тест с верной приставкой');
  assert.equal(by('f'), undefined, 'evidence: gate без отчёта');
});

test('P4-3/document: правка необязательного документа после приёмки — доставка без конфликта, задача закрыта; обязательного — conflict', async () => {
  for (const required of [false, true]) {
    const s = await scenario(fakeSuiteBackend(), {
      config: required
        ? (c) => {
            (c.tasks as Record<string, unknown>[])[0]!.requiredDocuments = ['Answer'];
          }
        : undefined,
    });
    try {
      const doc = await s.project.admin.addDocument(s.task.id, {
        name: 'Answer',
        body: 'Временный ответ ведущего',
      });
      const o = await s.runOnly();
      assert.equal(o.h.engine.read((v) => v.work(s.workId))?.status, 'done');
      await s.project.admin.updateDocument(doc.id, 'Подтверждённый ответ владельца');
      const data = await o.connector.deliver(o.h, s.workId);
      const status = data.deliveries[0]!.delivery.at(-1)?.status;
      const column = (await o.transport.readTask(s.task.id)).task.column;
      if (required) {
        assert.equal(status, 'conflict', 'обязательный документ — постановка');
        assert.notEqual(column, 'done');
      } else {
        assert.equal(status, 'delivered', 'необязательный документ — контекст');
        assert.equal(column, 'done');
      }
    } finally {
      await s.cleanup();
    }
  }
});

test('P4-6/legacy: результат до alpha.66 (digest v1 с прежними привязками) — постановка сверяется по закреплённому снимку; правка описания — не та же', () => {
  const raw = (testId: string) => ({
    version: 1,
    provider: 'relay-v1-http',
    projectId: 'p1',
    actor: 'harness',
    relay: { endpoint: 'http://127.0.0.1:1' },
    repository: { id: 'app' },
    tasks: [
      {
        ref: 't1',
        writeScope: ['src'],
        requiredDocuments: ['Spec'],
        criteria: [{ title: 'Greets', gate: 'unit', testId }],
      },
    ],
  });
  const before = parseConfig(raw('greets'), '/p').config;
  const after = parseConfig(raw('greet.greets'), '/p').config;
  const read = (description: string): TaskRead =>
    ({
      task: {
        id: 't1',
        key: 'APP-1',
        title: 'Greet',
        description,
        column: 'ready',
        revision: 3,
        parentId: null,
        dependencies: [],
        criteria: [{ id: 'c1', title: 'Greets', completed: false }],
      },
      children: [],
      dependencies: [],
      documents: [{ id: 'd1', key: 'DOC-1', name: 'Spec', revision: 1, body: 'spec' }],
      consistency: { before: 'a', after: 'a' },
    }) as never;
  const built = buildSnapshot({
    config: before,
    identity: { provider: 'relay-v1-http', projectId: 'p1', capabilities: [], build: {} },
    reads: [read('Add greet(name)')],
    rounds: 1,
    receiptOf: () => undefined,
  });
  // Так снимок записала прежняя версия: semanticDigest — v1, полей legacy нет.
  const v1 = legacySemanticDigest(before, before.tasks[0]!, read('Add greet(name)'));
  const manifest = {
    ...built.manifest,
    legacyRevision: undefined,
    tasks: built.manifest.tasks.map((t) => ({ ...t, semanticDigest: v1, legacyDigest: undefined })),
  };
  const store = { snapshots: () => [{ graph: built.graph, context: built.context, manifest }] };
  const op = { revision: v1, workId: built.manifest.tasks[0]!.orderId };
  assert.notEqual(legacySemanticDigest(after, after.tasks[0]!, read('Add greet(name)')), v1);
  assert.equal(
    legacyStatementSame(store, op, read('Add greet(name)'), after.tasks[0]!, after),
    true,
  );
  assert.equal(legacyStatementSame(store, op, read('Changed'), after.tasks[0]!, after), false);
  const scoped = parseConfig(
    {
      ...raw('greet.greets'),
      tasks: [
        {
          ...raw('x').tasks[0]!,
          writeScope: ['lib'],
          criteria: [{ title: 'Greets', gate: 'unit', testId: 'greet.greets' }],
        },
      ],
    },
    '/p',
  ).config;
  assert.equal(
    legacyStatementSame(store, op, read('Add greet(name)'), scoped.tasks[0]!, scoped),
    false,
  );
});

test('upgrade: снимок, закреплённый до alpha.66 (ревизия v1), остаётся закреплённым — source-snapshot не создаёт новый, run не требует согласования', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const o = await s.open();
    const fresh = await o.connector.snapshot();
    const record = o.connector.store.latestSnapshotAny()!;
    const manifest = record.manifest as {
      legacyRevision?: string;
      tasks: { semanticDigest: string; legacyDigest?: string }[];
    };
    const legacy = manifest.legacyRevision!;
    assert.ok(legacy && legacy !== fresh.revision);
    // Запись прежней версии: ревизия v1, manifest без полей alpha.66.
    o.connector.store.putSnapshot({
      revision: legacy,
      graphId: record.graphId,
      graph: record.graph,
      context: record.context,
      manifest: {
        ...manifest,
        revision: legacy,
        legacyRevision: undefined,
        tasks: manifest.tasks.map((t) => ({
          ...t,
          semanticDigest: t.legacyDigest!,
          legacyDigest: undefined,
        })),
      },
    });
    const again = await o.connector.snapshot();
    assert.equal(again.revision, legacy, 'закреплён прежний снимок');
    assert.equal(again.created, false);
    assert.equal(o.connector.store.latestSnapshotAny()!.revision, legacy);
    await o.connector.prepareRun(o.h);
  } finally {
    await s.cleanup();
  }
});
