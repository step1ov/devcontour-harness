/**
 * Порядок заданий технической очереди: номер постановки (`seq`), а не часы.
 * Равное или откатившееся `startedAt` не меняет, какое задание новее; номер
 * переживает переоткрытие хранилища; задания без номера (прежние версии)
 * читаются и старше любого задания с номером.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { WORKSPACE_OWNER, localSchemas } from '../src/contracts/index.ts';
import {
  WorkflowQueue,
  compareWorkflowJobs,
  newestWorkflowJob,
  type WorkflowSubjects,
} from '../src/control/workflow.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { engineOf } from './engine-fixture.ts';

/** Предметы хоста: любой ID — предмет, digest входа — от ID. */
const subjects: WorkflowSubjects = {
  input: (_kind, id) => ({ digest: createHash('sha256').update(id).digest('hex') }),
};

test('workflow seq: откат и равенство часов не меняют новейшее задание; номер переживает переоткрытие', () => {
  const { store, clock, engine, dir } = engineOf();
  const flow = new WorkflowQueue(store, engine.policy, () => clock.now, subjects);
  const start = (id: string) => flow.start({ kind: 'board', id, authorRuntime: 'codex' });
  // Ключи — digest: порядок по ключу с порядком постановки не совпадает.
  const a = start('zz-first');
  clock.now -= 60_000; // часы откатились
  const b = start('aa-second');
  const c = start('mm-third'); // то же время, что у b
  assert.equal(b.startedAt, c.startedAt);
  assert.ok(Date.parse(b.startedAt) < Date.parse(a.startedAt));
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
  assert.deepEqual(
    flow.list().map((j) => j.id),
    ['zz-first', 'aa-second', 'mm-third'],
  );
  assert.equal(newestWorkflowJob(flow.list())?.id, 'mm-third');
  // Повтор постановки — то же задание, номер прежний.
  assert.equal(start('zz-first').seq, 1);
  // Обновление задания номера не меняет.
  flow.fail(flow.claim(a.key)!, 'сломалось');
  assert.equal(flow.get(a.key).seq, 1);
  store.close();

  const reopened = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  try {
    const again = new WorkflowQueue(reopened, engine.policy, () => clock.now, subjects);
    clock.now -= 3_600_000;
    const d = again.start({ kind: 'board', id: 'bb-fourth', authorRuntime: 'claude' });
    assert.equal(d.seq, 4);
    assert.equal(newestWorkflowJob(again.list())?.id, 'bb-fourth');
    assert.deepEqual(
      again.list().map((j) => j.seq),
      [1, 2, 3, 4],
    );
  } finally {
    reopened.close();
  }
});

test('workflow seq: задание прежней версии без номера читается и старше заданий с номером', () => {
  const { store, clock, engine } = engineOf();
  const flow = new WorkflowQueue(store, engine.policy, () => clock.now, subjects);
  const fresh = flow.start({ kind: 'board', id: 'new', authorRuntime: 'codex' });
  // Записи прежней версии: без `seq`, позже по часам, чем новое.
  const legacy = (id: string, key: string, minutes: number) => {
    const rest: Omit<typeof fresh, 'seq'> & { seq?: number } = { ...fresh };
    delete rest.seq;
    const job = {
      ...rest,
      id,
      key: key.repeat(64),
      startedAt: new Date(clock.now + minutes * 60_000).toISOString(),
    };
    assert.equal(localSchemas['workflow-jobs'].safeParse(job).success, true);
    store.transact('workflow.updated', (tx) =>
      tx.putLocal('workflow-jobs', WORKSPACE_OWNER, job.key, job),
    );
    return job;
  };
  legacy('old-late', '0', 20);
  legacy('old-early', 'f', 10);
  assert.deepEqual(
    flow.list().map((j) => j.id),
    ['old-early', 'old-late', 'new'],
  );
  assert.equal(newestWorkflowJob(flow.list())?.id, 'new');
  // Следующая постановка — после наибольшего номера, прежние записи номер не занимают.
  assert.equal(flow.start({ kind: 'board', id: 'next', authorRuntime: 'codex' }).seq, 2);
});

test('compareWorkflowJobs: прежние записи — по времени (не по строке), затем по ключу', () => {
  const j = (key: string, startedAt: string, seq?: number) => ({
    key,
    startedAt,
    ...(seq ? { seq } : {}),
  });
  // '12:00+03:00' (09:00Z) по строке позже '09:30Z', по времени — раньше.
  const early = j('a', '2026-01-01T12:00:00.000+03:00');
  const late = j('b', '2026-01-01T09:30:00.000Z');
  assert.ok(early.startedAt.localeCompare(late.startedAt) > 0, 'лексический порядок обратный');
  assert.ok(compareWorkflowJobs(early, late) < 0);
  assert.ok(compareWorkflowJobs(j('a', early.startedAt), j('b', early.startedAt)) < 0);
  assert.ok(compareWorkflowJobs(late, j('z', '2000-01-01T00:00:00.000Z', 1)) < 0);
  assert.ok(
    compareWorkflowJobs(
      j('z', '2030-01-01T00:00:00.000Z', 1),
      j('a', '2000-01-01T00:00:00.000Z', 2),
    ) < 0,
  );
  assert.equal(newestWorkflowJob([]), undefined);
});
