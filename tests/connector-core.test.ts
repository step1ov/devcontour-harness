/**
 * Ядро коннектора на управляемой подделке backend (fixture): semantic digest,
 * согласованность многостраничного чтения, доверие receipts, протокол
 * владения и итог для получателя.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessError, type RunResult } from '../src/contracts/index.ts';
import {
  ConnectorStore,
  LeaseLost,
  RelayWorkSource,
  connectorIdOf,
  orderIdOf,
  parseConfig,
  readStable,
  semanticDigest,
  settingsFor,
  summaryText,
  taskIdentity,
  type ConnectorConfigInput,
} from '../src/integrations/connector/index.ts';
import {
  FakeAdmin,
  FakeRelayTransport,
  emptyFakeState,
  memoryBackend,
} from '../src/integrations/connector/testing.ts';
import { redactor } from '../src/environment/redaction.ts';

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'harness-connector-core-')));

function project(provider: 'relay-v1-http' | 'relay-v2-cli' = 'relay-v1-http', projectId = 'p1') {
  const backend = memoryBackend(emptyFakeState(provider, projectId));
  const admin = new FakeAdmin(backend);
  const transport = new FakeRelayTransport(backend, { provider, actor: 'harness' });
  return { backend, admin, transport };
}

const configOf = (taskRef: string, patch: Partial<ConnectorConfigInput> = {}) =>
  parseConfig(
    {
      version: 1,
      provider: 'relay-v1-http',
      projectId: 'p1',
      actor: 'harness',
      relay: { endpoint: 'http://127.0.0.1:1' },
      repository: { id: 'app' },
      tasks: [
        {
          ref: taskRef,
          writeScope: ['src'],
          criteria: [{ title: 'Greets', gate: 'unit', testId: 'greet.greets' }],
        },
      ],
      ...patch,
    },
    '/project',
  ).config;

test('W03/digest: semantic digest не зависит от колонки, комментариев, отметок критериев и ключа; зависит от текста, критериев, документов, зависимостей и mapping', async () => {
  const { admin, transport } = project();
  const task = admin.createTask({
    title: 'Greet',
    description: 'Add greet',
    criteria: [{ title: 'Greets' }],
  });
  const config = configOf(task.id);
  const mapping = config.tasks[0]!;
  const digest = async (cfg = config) =>
    semanticDigest(cfg, cfg.tasks[0]!, await transport.readTask(task.id));
  const base = await digest();
  // Операционные изменения.
  admin.move(task.id, 'in-progress');
  admin.comment(task.id, 'технический комментарий');
  admin.completeCriterion(task.id, task.criteria[0]!);
  assert.equal(
    await digest(),
    base,
    'колонка, комментарий и отметка критерия — не новая постановка',
  );
  // Значимые изменения — каждое отдельно меняет digest.
  const seen = new Set([base]);
  const changed = async (what: string, fn: () => void) => {
    fn();
    const next = await digest();
    assert.ok(!seen.has(next), what);
    seen.add(next);
  };
  await changed('текст', () => admin.updateTask(task.id, { description: 'Add greet v2' }));
  await changed('определение критерия', () =>
    admin.updateCriterion(task.id, task.criteria[0]!, 'Greets politely'),
  );
  await changed('новый критерий', () => admin.addCriterion(task.id, 'Exports'));
  const doc = admin.addDocument(task.id, { name: 'Spec', body: 'v1' });
  await changed('документ добавлен', () => undefined);
  await changed('документ изменён', () => admin.updateDocument(doc.id, 'v2'));
  const dep = admin.createTask({ title: 'Dep', description: 'dependency' });
  await changed('зависимость', () => admin.addDependency(task.id, dep.id));
  const remapped = configOf(task.id, {
    tasks: [
      {
        ref: task.id,
        writeScope: ['src'],
        criteria: [{ title: 'Greets', gate: 'unit', testId: 'greet.other' }],
      },
    ],
  });
  assert.ok(!seen.has(await digest(remapped)), 'mapping');
  void mapping;
});

test('W02/identity: provider, проект и задача разделены; одинаковый номер в разных проектах — разные поручения', () => {
  const a = orderIdOf('relay-v1-http', 'p1', 't1');
  assert.notEqual(a, orderIdOf('relay-v1-http', 'p2', 't1'));
  assert.notEqual(a, orderIdOf('relay-v2-cli', 'p1', 't1'));
  assert.notEqual(a, orderIdOf('relay-v1-http', 'p1', 't2'));
  assert.equal(taskIdentity('relay-v2-cli', 'p:1', 't1'), 'relay-v2-cli:p:1:t1');
  assert.notEqual(connectorIdOf('relay-v1-http', 'p1'), connectorIdOf('relay-v1-http', 'p2'));
  // Provider выбирается только явно; неизвестный — отказ схемы.
  assert.throws(
    () => parseConfig({ ...configOf('t1'), provider: 'relay' }, '/x'),
    (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
  );
  // Настройки адаптера получают projectId/actor конфигурации; relay-v2 пути — от каталога файла.
  const v2 = parseConfig(
    {
      version: 1,
      provider: 'relay-v2-cli',
      projectId: 'p1',
      actor: 'harness',
      relay: { binary: 'tools/relay', config: 'relay/relay.config.json' },
      repository: { id: 'app' },
      tasks: [{ ref: 'PRODUCT-1', writeScope: ['src'] }],
    },
    '/project',
  );
  assert.deepEqual(settingsFor(v2), {
    binary: '/project/tools/relay',
    config: '/project/relay/relay.config.json',
    projectId: 'p1',
    actor: 'harness',
  });
  assert.throws(
    () =>
      settingsFor({
        ...v2,
        config: {
          ...v2.config,
          relay: { ...v2.config.relay, projectId: 'other' },
        } as typeof v2.config,
      }),
    (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
  );
});

test('W04/fake: чужая запись между страницами одного чтения (before≠after) — повторное чтение; непрерывные изменения — явный отказ; ошибка — не пустой список', async () => {
  const { admin, transport } = project();
  const task = admin.createTask({ title: 'Greet', description: 'Add greet' });
  let writes = 1;
  transport.onPage = (page) => {
    if (page === 'links' && writes-- > 0) admin.comment(task.id, 'между страницами');
  };
  const ok = await readStable(transport, [task.id], 3);
  assert.equal(ok.rounds, 3, 'несогласованное чтение отброшено, затем два совпавших');
  transport.onPage = (page) => {
    if (page === 'task') admin.updateTask(task.id, { description: 'Add greet ' + Math.random() });
  };
  await assert.rejects(readStable(transport, [task.id], 2), (e: unknown) => {
    assert.ok(e instanceof HarnessError && e.code === 'NOT_READY');
    assert.match(e.message, /rereads=2/);
    return true;
  });
  transport.onPage = undefined;
  await assert.rejects(readStable(transport, ['missing'], 2), (e: unknown) => {
    assert.ok(e instanceof HarnessError && e.code === 'NOT_READY', String(e));
    return true;
  });
});

test('W05/trusts: доверие только receipt этого коннектора с проверяемым digest; статус done и чужой издатель — нет', async () => {
  const dir = temp();
  try {
    const { transport } = project();
    const config = configOf('t1');
    const store = new ConnectorStore(join(dir, 'c.sqlite'), {
      provider: 'relay-v1-http',
      projectId: 'p1',
    });
    const source = new RelayWorkSource({ config, transport, store });
    const sha = 'a'.repeat(40);
    const p = (
      receipt:
        { kind: 'engine'; runId: string } | { kind: 'trusted'; issuer: string; digest: string },
    ) => ({ id: 'tdep', repositoryId: 'app', resultSha: sha, receipt }) as const;
    assert.equal(await source.trusts(p({ kind: 'engine', runId: 'r1' })), false);
    assert.equal(
      await source.trusts(p({ kind: 'trusted', issuer: source.id, digest: 'f'.repeat(64) })),
      false,
      'нет записи',
    );
    const lease = store.acquire('op', 'test', 5000).lease!;
    const record = {
      issuer: source.id,
      orderId: 'tdep',
      taskId: 'dep',
      repositoryId: 'app',
      resultSha: sha,
      workId: 'tdep',
      runId: 'r1',
      operation: 'op',
    };
    store.putReceipt(record, lease.token);
    const { digestOf } = await import('../src/contracts/digest.ts');
    assert.equal(
      await source.trusts(p({ kind: 'trusted', issuer: source.id, digest: digestOf(record) })),
      true,
    );
    assert.equal(
      await source.trusts(p({ kind: 'trusted', issuer: 'other', digest: digestOf(record) })),
      false,
      'чужой издатель',
    );
    assert.equal(
      await source.trusts({
        ...p({ kind: 'trusted', issuer: source.id, digest: digestOf(record) }),
        resultSha: 'b'.repeat(40),
      }),
      false,
      'другой SHA',
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D06/store: действующий lease не перехватывается; истёкший — новым владельцем с большим fence; запись под утраченным владением отклоняется', async () => {
  const dir = temp();
  try {
    const file = join(dir, 'c.sqlite');
    const a = new ConnectorStore(file, { provider: 'relay-v1-http', projectId: 'p1' });
    const b = new ConnectorStore(file, { provider: 'relay-v1-http', projectId: 'p1' });
    const first = a.acquire('op', 'A', 300).lease!;
    a.putIntent(
      {
        key: 'op',
        provider: 'relay-v1-http',
        projectId: 'p1',
        workId: 'w',
        runId: 'r',
        taskId: 't',
        resultDigest: 'd',
        revision: 'rev',
        outcome: 'accepted',
      },
      first.token,
    );
    const busy = b.acquire('op', 'B', 300);
    assert.equal(busy.lease, undefined);
    assert.equal(busy.holder!.owner, 'A');
    await new Promise((r) => setTimeout(r, 350));
    const second = b.acquire('op', 'B', 5000).lease!;
    assert.ok(second.fence > first.fence);
    assert.throws(
      () => a.updateOp('op', first.token, (o) => o),
      LeaseLost,
      'устаревший владелец ничего не пишет',
    );
    assert.equal(b.operation('op')!.status, 'intent', 'intent не потерян при перехвате');
    // Другой проект в том же файле — отказ.
    assert.throws(() => new ConnectorStore(file, { provider: 'relay-v1-http', projectId: 'p2' }));
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S06/summary: итог для получателя без локальных путей и секретов, с SHA, gates, снимком и маркером', () => {
  const secret = 'canary-secret-value-123';
  const result = {
    apiVersion: 'devcontour-harness/v1alpha1',
    workOrderId: 'tw',
    graphId: 'g',
    source: { connector: 'c', ref: 'relay-v1-http:p1:t1', revision: 'e'.repeat(64) },
    runId: 'run-1',
    attempt: 1,
    repositoryId: 'app',
    targetRef: 'refs/heads/harness/accepted',
    inputs: {} as RunResult['inputs'],
    checked: { dependencies: [], freshness: [], consumers: [] },
    evidence: [
      {
        id: 'e1',
        kind: 'test',
        phase: 'integration',
        gate: 'unit',
        sha: 'c'.repeat(40),
        passed: true,
        digest: 'd'.repeat(64),
        summary: '/Users/someone/state/run/log.txt ' + secret,
        tests: [{ id: 'greet.greets', status: 'passed' }],
      },
    ],
    findings: [],
    limitations: [`Журнал: /private/var/folders/xx/state/artifacts/run.log; токен ${secret}`],
    finishedAt: new Date().toISOString(),
    outcome: 'accepted',
    shas: {
      base: 'a'.repeat(40),
      candidate: 'b'.repeat(40),
      integration: 'c'.repeat(40),
      result: 'c'.repeat(40),
    },
  } as unknown as RunResult;
  const marker = '<!-- devcontour-harness:op=abc:step=1 -->';
  const { body, title } = summaryText({
    marker,
    result,
    task: { key: 'PRODUCT-1', identity: 'relay-v1-http:p1:t1' },
    snapshot: { revision: 'e'.repeat(64), casRevision: 7 },
    criteria: [
      {
        criterionId: 'c1',
        title: 'Greets',
        gate: 'unit',
        testId: 'greet.greets',
        outcome: 'closed',
      },
    ],
    completion: 'задача перемещена в done',
    redact: redactor([secret]),
  });
  assert.ok(body.startsWith(marker));
  assert.ok(!body.includes(secret) && !title.includes(secret), 'секрет замаскирован');
  assert.ok(!body.includes('/private/var') && !body.includes('/Users/'), 'нет локальных путей');
  assert.match(body, /c{40}/);
  assert.match(body, /unit \[integration\]: passed \(1\/1 тестов\)/);
  assert.match(body, /refs\/heads\/harness\/accepted/, 'ref Git — не путь');
  assert.match(body, /Greets: closed ← unit\/greet\.greets/);
  assert.ok(!body.includes('log.txt'), 'текст evidence (журнал) не копируется');
});
