/**
 * Явный разбор конфликта CAS без изменения постановки (fixture backend):
 * автоматического повтора нет; `recheck` оператора перечитывает постановку и
 * продолжает доставку от новой ревизии.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalBarrier,
  fakeSuiteBackend,
  harnessComments,
  scenario,
} from '../src/integrations/connector/testing.ts';

test('D04/recheck: несемантическое чужое изменение между сверкой и CAS — conflict; recheck оператора продолжает без дублей', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const barrier = new LocalBarrier();
    const o = await s.runOnly({
      faults: [{ op: 'setCriterion', nth: 1, action: 'barrier', barrier }],
    });
    const pending = o.h.deliver(s.workId, o.connector.sink);
    await Promise.race([
      barrier.reached,
      new Promise((_, no) => setTimeout(() => no(new Error('барьер не достигнут')), 30_000)),
    ]);
    // Чужое перемещение: ревизия меняется, постановка — нет.
    await s.project.admin.move(s.task.id, 'in-progress');
    barrier.release();
    await pending;
    const conflict = o.h.result(s.workId).delivery.at(-1)!;
    assert.equal(conflict.status, 'conflict');
    const key = o.connector.store.operations({ workId: s.workId })[0]!.key;
    // Без решения — только диагностика.
    const plain = await o.connector.reconcile(o.h, key);
    assert.equal(plain.resolved, false);
    const rechecked = await o.connector.reconcile(o.h, key, { kind: 'recheck' });
    assert.equal(rechecked.resolved, true, rechecked.facts.join('; '));
    assert.equal(o.h.result(s.workId).delivery.at(-1)!.status, 'delivered');
    const read = await o.transport.readTask(s.task.id);
    assert.equal(read.task.column, 'done');
    assert.equal((await harnessComments(o.transport, s.task.id)).length, 1);
  } finally {
    await s.cleanup();
  }
});
