import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeliveryOutcome, ResultSink, RunResult } from '../src/contracts/index.ts';
import { memoryDocumentId, memoryResultSink } from '../src/integrations/memory/index.ts';
import { FakeMemoryProvider } from '../src/integrations/memory/testing.ts';
import { approve, greet, target } from './runner-fixture.ts';
import { evidence, msetup, reviewAndApprove } from './memory-fixture.ts';

const DIARY = 'WRITER-DIARY-UNVERIFIED: I verified every edge case myself';

/** Управляемый получатель вида Relay: идемпотентен по ключу, считает внешние мутации. */
class FakeRelaySink implements ResultSink {
  readonly id = 'relay-fake';
  calls = 0;
  mutations = 0;
  readonly records = new Map<string, string>();
  deliver({ key }: { key: string; result: RunResult }): Promise<DeliveryOutcome> {
    this.calls++;
    let receipt = this.records.get(key);
    if (!receipt) {
      this.mutations++;
      receipt = `relay-comment-${this.mutations}`;
      this.records.set(key, receipt);
    }
    return Promise.resolve({ status: 'delivered', receipt });
  }
}

test('M03: доставка памяти независима — сбой памяти не меняет Git и receipt Relay, повтор шлёт только память с тем же document_id, без нового writer', async () => {
  const ctx = msetup({
    scenario: {
      writer: {
        files: { 'src/greet.js': greet },
        result: { completed: true, summary: DIARY, discoveries: [] },
      },
      reviewer: approve(),
    },
    context: ['norms'],
  });
  const relay = new FakeRelaySink();
  const provider = new FakeMemoryProvider('fake-hindsight', []);
  const memory = memoryResultSink(provider, { bank: 'project-app', project: 'app' });
  assert.equal(memory.id, 'memory-fake-hindsight');
  assert.notEqual(memory.id, relay.id);

  let h = ctx.open();
  const snapshot = await ctx.files.snapshot(['norms']);
  await reviewAndApprove(h, ctx.graph, snapshot);
  await h.run({ graph: ctx.graph, author: 'claude', context: snapshot, sink: relay });
  const accepted = h.result('add-greeting');
  assert.equal(accepted.result.outcome, 'accepted');
  const ref = target(ctx);
  assert.equal(accepted.result.outcome === 'accepted' && accepted.result.shas.result, ref);
  const relayState = accepted.delivery.find((d) => d.sink === relay.id)!;
  assert.equal(relayState.status, 'delivered');
  const counts = () => ({
    writer: ctx.calls('claude', 'writer'),
    reviewer: ctx.calls('codex', 'reviewer'),
    runtimeRequests: ctx.requests.length,
    relayCalls: relay.calls,
    relayMutations: relay.mutations,
    retain: provider.calls.retain,
  });
  const afterRun = counts();
  assert.equal(afterRun.writer, 1);
  assert.equal(afterRun.relayMutations, 1);

  // 1. Сбой до записи: состояние памяти — отдельное failed.
  provider.failRetain('before-store');
  let envelope = await h.deliver('add-greeting', memory);
  const failed = envelope.delivery.find((d) => d.sink === memory.id)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  assert.match(failed.lastError!, /retain failed before store/);
  assert.equal(failed.key, `${memory.id}:add-greeting:${accepted.result.runId}`);
  assert.deepEqual(
    envelope.delivery.find((d) => d.sink === relay.id),
    relayState,
    'receipt Relay не изменился',
  );
  assert.equal(envelope.result.outcome, 'accepted', 'принятое не откатывается');
  assert.equal(target(ctx), ref);
  const failedEvents = h
    .events(0, 500)
    .events.filter((e) => e.type === 'delivery.failed')
    .map((e) => (e.payload as { sink: string }).sink);
  assert.deepEqual(failedEvents, [memory.id], 'сбой виден отдельно по получателю памяти');

  // 2. Новый процесс того же состояния; сбой после записи (ответ потерян).
  h.close();
  h = ctx.open();
  provider.failRetain('after-store');
  envelope = await h.deliver('add-greeting', memory);
  assert.equal(envelope.delivery.find((d) => d.sink === memory.id)!.status, 'failed');
  assert.equal(envelope.delivery.find((d) => d.sink === memory.id)!.attempts, 2);
  assert.equal(provider.documents.size, 1);

  // 3. Повтор только памяти: доставлено, тот же документ и операция.
  envelope = await h.deliver('add-greeting', memory);
  const delivered = envelope.delivery.find((d) => d.sink === memory.id)!;
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.attempts, 3);
  const documentId = memoryDocumentId('fake-hindsight', 'project-app', 'app', accepted.result);
  assert.match(delivered.receipt!, new RegExp(`document=${documentId}`));
  assert.equal(new Set(provider.log.map((l) => l.documentId)).size, 1, 'один document_id');
  assert.equal(provider.log[0]!.documentId, documentId);
  assert.equal(new Set(provider.log.map((l) => l.operationId)).size, 1, 'один operation_id');
  assert.match(
    provider.log[0]!.operationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(provider.documents.size, 1, 'нет дубликата документа');
  const doc = provider.documents.get(documentId)!;
  assert.equal(doc.bank, 'project-app');
  assert.equal(doc.metadata.resultSha, ref);
  assert.ok(!doc.content.includes(DIARY), 'в память идёт итог controller, не дневник writer');

  // 4. Уже доставлено: повтор не обращается к провайдеру.
  await h.deliver('add-greeting', memory);
  // Повтор Relay — тоже без второй записи.
  await h.deliver('add-greeting', relay);
  const final = counts();
  assert.equal(final.retain, 3);
  assert.equal(final.writer, afterRun.writer, 'writer не перезапускался');
  assert.equal(final.reviewer, afterRun.reviewer, 'reviewer не перезапускался');
  assert.equal(final.runtimeRequests, afterRun.runtimeRequests, 'нет вызовов runtime');
  assert.equal(final.relayCalls, afterRun.relayCalls, 'доставленное Relay не повторяется');
  assert.equal(final.relayMutations, 1, 'нет дубликата Relay');
  assert.equal(target(ctx), ref, 'Git accepted не изменился');
  const end = h.result('add-greeting');
  assert.deepEqual(
    end.delivery.find((d) => d.sink === relay.id),
    relayState,
  );
  assert.equal(
    h.engine.read((v) => v.attempts('add-greeting').length),
    1,
  );
  evidence('M03', 'states.json', {
    git: { targetRef: ref, unchanged: true },
    relay: { state: relayState, calls: relay.calls, mutations: relay.mutations },
    memory: {
      sink: memory.id,
      states: { first: failed, final: end.delivery.find((d) => d.sink === memory.id) },
      retainLog: provider.log,
      documents: provider.documents.size,
      usage: memory.usage,
    },
    counts: { afterRun, final },
    failedEvents,
  });
  h.close();
});
