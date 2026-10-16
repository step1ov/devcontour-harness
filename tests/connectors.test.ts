/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тесты правят сырой JSON графа до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  API_VERSION,
  Harness,
  HarnessError,
  cliAdapter,
  contextDigest,
  sha256,
  sourceDigest,
  workGraphSchema,
  type ContextSnapshot,
  type ContextSource,
  type DeliveryOutcome,
  type ErrorCode,
  type Prerequisite,
  type ResultSink,
  type RunResult,
  type WorkGraph,
  type WorkSource,
} from '../src/index.ts';
import { approve, bin, implement, setup, target } from './runner-fixture.ts';

// Второй набор подключений — только через публичные порты и exports пакета.
// Engine о них ничего не знает: это проверка, что новый источник, контекст и
// получатель подключаются без изменения движка.

/** Источник поручений в памяти: запись по ref, редакция — `source.revision` графа. */
class MemoryWorkSource implements WorkSource {
  readonly id = 'memory';
  readonly records = new Map<string, WorkGraph>();
  readonly issuers = new Set<string>();
  put(ref: string, graph: WorkGraph) {
    this.records.set(ref, structuredClone(graph));
  }
  fetch(ref: string) {
    const graph = this.records.get(ref);
    if (!graph) throw new HarnessError('NOT_FOUND', 'Нет записи ' + ref);
    return Promise.resolve({ graph: structuredClone(graph), source: graph.source });
  }
  revision(ref: string) {
    return Promise.resolve(this.records.get(ref)?.source.revision);
  }
  /** Текущая редакция поручения в источнике: по ней получатель обнаруживает конфликт. */
  orderRevision(workId: string) {
    for (const graph of this.records.values()) {
      const order = graph.orders.find((o) => o.id === workId);
      if (order) return order.source.revision;
    }
    return undefined;
  }
  trusts(prerequisite: Prerequisite) {
    return Promise.resolve(
      prerequisite.receipt.kind === 'trusted' && this.issuers.has(prerequisite.receipt.issuer),
    );
  }
}

/** Контекст из заметок в памяти: одна заметка — один источник с одним файлом. */
class NotesContextSource implements ContextSource {
  readonly id = 'notes';
  constructor(readonly notes: Record<string, string>) {}
  snapshot(ids: string[]): Promise<ContextSnapshot> {
    const sources = ids.map((id) => {
      const text = this.notes[id];
      if (text === undefined) throw new HarnessError('NOT_READY', 'Нет заметки ' + id);
      const entry = {
        id,
        kind: 'notes',
        version: '1',
        required: true,
        files: [
          {
            path: `${id}.md`,
            digest: sha256(text),
            bytes: Buffer.byteLength(text),
            content: { encoding: 'utf8' as const, data: text },
          },
        ],
        references: [],
      };
      return { ...entry, digest: sourceDigest(entry) };
    });
    return Promise.resolve({ apiVersion: API_VERSION, sources, missing: [] });
  }
}

/** Получатель в памяти, который умеет падать; идемпотентен по ключу. */
class FlakySink implements ResultSink {
  calls = 0;
  failures = 0;
  readonly records = new Map<string, RunResult>();
  constructor(
    readonly id: string,
    readonly source: MemoryWorkSource,
  ) {}
  deliver({ key, result }: { key: string; result: RunResult }): Promise<DeliveryOutcome> {
    this.calls++;
    if (this.failures > 0) {
      this.failures--;
      return Promise.reject(new Error('получатель недоступен'));
    }
    const current = this.source.orderRevision(result.workOrderId);
    if (current !== undefined && current !== result.source.revision)
      return Promise.resolve({ status: 'conflict', currentRevision: current });
    if (!this.records.has(key)) this.records.set(key, structuredClone(result));
    return Promise.resolve({ status: 'delivered', receipt: 'memory:' + key });
  }
}

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};

function project(writer: ReturnType<typeof implement>[]) {
  const ctx = setup({
    scenario: { writer: writer.map((w) => ({ ...w, recordPrompt: true })), reviewer: approve() },
  });
  ctx.store.close();
  const open = () =>
    Harness.open({
      stateDir: ctx.state,
      policy: ctx.policy,
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
    });
  const count = (runtime: string, role: string) => {
    const file = `${ctx.scenarioPath}.${runtime}.${role}.count`;
    return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  };
  /** Всё, что меняет повтор доставки, если бы он исполнял работу заново. */
  const effects = () => ({
    writer: count('claude', 'writer'),
    reviewer: count('codex', 'reviewer'),
    target: target(ctx),
  });
  const graph = (revision: string, patch: (raw: any) => void = () => {}) => {
    const raw = structuredClone(ctx.graph) as any;
    raw.source = { connector: 'memory', ref: 'greeting', revision };
    raw.orders[0].source = { connector: 'memory', ref: 'add-greeting', revision };
    raw.orders[0].context = ['norms'];
    patch(raw);
    return workGraphSchema.parse(raw);
  };
  return { ctx, open, effects, graph };
}

test('T34: второй источник, контекст и получатель через публичные порты — полный цикл; повтор submit — та же работа; сбой и повтор доставки без моделей и Git', async () => {
  const p = project([implement()]);
  const source = new MemoryWorkSource();
  const notes = new NotesContextSource({ norms: 'Норма: экспорт через module.exports.' });
  const sink = new FlakySink('memory-sink', source);
  source.put('greeting', p.graph('1'));
  const h = p.open();

  const submit = async () => {
    const { graph } = await source.fetch('greeting');
    const context = await notes.snapshot(['norms']);
    return {
      graph,
      context,
      data: await h.run({ graph, context, author: 'claude', sink, source }),
    };
  };
  // Первая отправка: работа принята, доставка упала.
  sink.failures = 1;
  const first = await submit();
  assert.equal(first.data.works[0]!.status, 'done');
  const delivered = () => h.result('add-greeting').delivery;
  assert.deepEqual(
    delivered().map((d) => d.status),
    ['failed'],
  );
  assert.equal(sink.records.size, 0);
  // Контекст другого источника закреплён и дошёл до исполнителя.
  assert.equal(h.result('add-greeting').result.inputs.contextDigest, contextDigest(first.context));
  assert.match(
    readFileSync(p.ctx.scenarioPath + '.writer.0.prompt', 'utf8'),
    /Норма: экспорт через module\.exports\./,
  );
  const afterRun = p.effects();
  assert.equal(afterRun.writer, 1);

  // Повтор отправки той же редакции: та же работа, без новой попытки и вызовов;
  // доставка повторяется и проходит.
  const second = await submit();
  assert.equal(second.data.resumed, true, 'та же редакция — продолжение прежней работы');
  assert.equal(
    h.engine.read((v) => v.attempts('add-greeting').length),
    1,
    'одна работа на ключ',
  );
  assert.deepEqual(p.effects(), afterRun, 'повтор submit и доставки не вызывал моделей и Git');
  assert.deepEqual(
    delivered().map((d) => [d.status, d.attempts]),
    [['delivered', 2]],
  );
  assert.equal(sink.records.size, 1);

  // Повтор доставленного: получатель не вызывается, второй записи нет.
  const calls = sink.calls;
  await h.deliver('add-greeting', sink);
  assert.equal(sink.calls, calls, 'доставленное по ключу не отправляется снова');
  assert.equal(sink.records.size, 1);
  assert.deepEqual(p.effects(), afterRun);
  h.close();
});

test('T34: новая редакция в источнике — старый результат её не закрывает; новая редакция — новая работа и своя доставка', async () => {
  const p = project([implement(), implement({ 'src/farewell.js': 'exports.bye = () => 1;\n' })]);
  const source = new MemoryWorkSource();
  const notes = new NotesContextSource({ norms: 'Норма.' });
  const sink = new FlakySink('memory-sink', source);
  source.put('greeting', p.graph('1'));
  const h = p.open();
  const run = async (s: ResultSink) => {
    const { graph } = await source.fetch('greeting');
    return h.run({
      graph,
      context: await notes.snapshot(['norms']),
      author: 'claude',
      sink: s,
      source,
    });
  };
  sink.failures = 1;
  await run(sink);
  const old = h.result('add-greeting').result;
  assert.equal(old.source.revision, '1');
  // Источник получил новую редакцию раньше, чем доставка прошла.
  source.put(
    'greeting',
    p.graph('2', (raw) => (raw.orders[0].goal = 'Добавить greet и прощание bye.')),
  );
  const before = p.effects();
  await h.deliver('add-greeting', sink);
  assert.deepEqual(
    h.result('add-greeting', old.runId).delivery.map((d) => [d.status, d.currentRevision]),
    [['conflict', '2']],
    'старый результат не закрывает новую редакцию',
  );
  assert.equal(sink.records.size, 0);
  assert.deepEqual(p.effects(), before, 'конфликт доставки не вызывал моделей и Git');
  // Новая редакция — новая попытка; её результат доставляется.
  await run(sink);
  const fresh = h.result('add-greeting').result;
  assert.notEqual(fresh.runId, old.runId);
  assert.equal(fresh.source.revision, '2');
  assert.equal(fresh.outcome, 'accepted');
  assert.equal([...sink.records.values()].filter((r) => r.runId === fresh.runId).length, 1);
  assert.equal(
    [...sink.records.values()].some((r) => r.runId === old.runId),
    false,
    'старый результат так и не доставлен',
  );
  // Прежний результат не переписан новой редакцией.
  assert.deepEqual(h.result('add-greeting', old.runId).result, old);
  h.close();
});

test('T34/T02: доверие к receipt внешней предпосылки — решение источника через порт; доступность SHA проверяется всегда', async () => {
  const p = project([implement(), implement({ 'src/farewell.js': 'exports.bye = () => 1;\n' })]);
  const source = new MemoryWorkSource();
  const notes = new NotesContextSource({ norms: 'Норма.' });
  source.put('greeting', p.graph('1'));
  const h = p.open();
  const first = await source.fetch('greeting');
  await h.run({
    graph: first.graph,
    context: await notes.snapshot(['norms']),
    author: 'claude',
    source,
  });
  const done = h.result('add-greeting').result;
  assert.equal(done.outcome, 'accepted');
  const dependent = (sha: string) =>
    workGraphSchema.parse({
      ...p.graph('1'),
      id: 'next',
      source: { connector: 'memory', ref: 'next', revision: '1' },
      orders: [
        {
          ...p.graph('1').orders[0],
          id: 'add-farewell',
          source: { connector: 'memory', ref: 'add-farewell', revision: '1' },
          dependsOn: ['ext'],
        },
      ],
      prerequisites: [
        {
          id: 'ext',
          repositoryId: 'app',
          resultSha: sha,
          receipt: { kind: 'trusted', issuer: 'ops', digest: sha256('receipt') },
        },
      ],
    });
  const context = await notes.snapshot(['norms']);
  const resultSha = (done.shas as { result: string }).result;
  // Источник не доверяет издателю — отказ до записи.
  await assert.rejects(
    h.run({ graph: dependent(resultSha), context, author: 'claude', source }),
    refused('NOT_READY'),
  );
  // Без источника доверенных receipt нет.
  source.issuers.add('ops');
  await assert.rejects(
    h.run({ graph: dependent(resultSha), context, author: 'claude' }),
    refused('NOT_READY'),
  );
  // Доверенный receipt, но SHA недоступен из target ref, — отказ.
  const orphan = p.ctx.repo.git('commit-tree', 'HEAD^{tree}', '-m', 'вне target');
  await assert.rejects(
    h.run({ graph: dependent(orphan), context, author: 'claude', source }),
    refused('NOT_READY'),
  );
  // Источник другого connector не подставляется за граф.
  await assert.rejects(
    h.run({
      graph: dependent(resultSha),
      context,
      author: 'claude',
      source: Object.assign(new MemoryWorkSource(), { id: 'other' }),
    }),
    refused('INVALID_INPUT'),
  );
  assert.equal(
    h.engine.read((v) => v.graph('next')),
    undefined,
    'отказы ничего не записали',
  );
  // Доверие источника и доступный SHA — граф принят и исполнен.
  const ok = await h.run({ graph: dependent(resultSha), context, author: 'claude', source });
  assert.equal(ok.works[0]!.status, 'done');
  h.close();
});
