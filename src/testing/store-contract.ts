import assert from 'node:assert/strict';
import {
  WORKSPACE_OWNER,
  digestOf,
  type ExecutionStore,
  type RunEventDraft,
  type WorkState,
} from '../contracts/index.ts';

/**
 * Общий набор проверок договора `ExecutionStore`. Его проходят standalone
 * SQLite и адаптер любого хоста: `open` открывает хранилище в каталоге,
 * повторный вызов с тем же каталогом — то же хранилище другим экземпляром.
 * Регистрация тестов — через переданную `test` (node:test).
 */
export function executionStoreContract(
  name: string,
  test: (title: string, fn: () => void | Promise<void>) => unknown,
  open: (dir: string) => ExecutionStore,
  tempDir: () => string,
) {
  const work = (id: string, status: WorkState['status'] = 'ready'): WorkState => ({
    id,
    graphId: 'g',
    order: {
      apiVersion: 'devcontour-harness/v1alpha1',
      id,
      source: { connector: 'files', ref: id, revision: '1' },
      title: 'Поручение ' + id,
      goal: 'Цель поручения ' + id,
      acceptance: ['критерий'],
      role: 'developer',
      repositoryId: 'app',
      relatedRepositories: [],
      writeScope: ['src'],
      dependsOn: [],
      requirements: [],
      contracts: [],
      context: [],
    },
    status,
    attempt: 0,
  });
  const phase = (runId: string, p: 'running' | 'verifying' = 'running'): RunEventDraft => ({
    type: 'attempt.phase',
    runId,
    payload: { phase: p },
  });
  const call = (id: string) => ({
    id,
    stage: 'implementation',
    runtime: 'fixture',
    model: null,
    runtimeVersion: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    outcome: 'returned' as const,
    promptBytes: 1,
    promptDigest: digestOf(id),
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedUsd: null,
      complete: true,
      source: 'fixture' as const,
    },
    costUsd: null,
    costSource: 'unknown' as const,
  });

  test(`${name}: запись видна следующей транзакции и другому экземпляру`, () => {
    const dir = tempDir();
    const a = open(dir);
    a.transact('run.phase', (tx) => {
      tx.putWork(work('w1'));
      tx.emit(phase('r1'));
    });
    assert.equal(
      a.read((v) => v.work('w1')?.status),
      'ready',
    );
    const b = open(dir);
    assert.equal(
      b.read((v) => v.work('w1')?.status),
      'ready',
    );
    b.transact('run.phase', (tx) => tx.putWork({ ...tx.work('w1')!, status: 'running' }));
    assert.equal(
      a.read((v) => v.work('w1')?.status),
      'running',
      'первый экземпляр видит запись второго',
    );
    const events = a.events();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'attempt.phase');
    a.close();
    b.close();
  });

  test(`${name}: исключение откатывает записи, локальные записи и события`, () => {
    const s = open(tempDir());
    assert.throws(() =>
      s.transact('run.phase', (tx) => {
        tx.putWork(work('w1'));
        tx.putLocal('usage', 'app', 'c1', call('c1'));
        tx.emit(phase('r1'));
        throw new Error('отказ');
      }),
    );
    assert.equal(
      s.read((v) => v.work('w1')),
      undefined,
    );
    assert.equal(
      s.read((v) => v.local('usage', 'app', 'c1')),
      undefined,
    );
    assert.deepEqual(s.events(), []);
    s.close();
  });

  test(`${name}: вложенная сохраняет оба изменения; её отказ откатывает только её часть`, () => {
    const s = open(tempDir());
    s.transact('run.claimed', (tx) => {
      tx.putWork(work('outer'));
      s.transact('run.phase', (inner) => {
        assert.ok(inner.work('outer'), 'вложенная видит несохранённое внешней');
        inner.putWork(work('inner'));
        inner.emit(phase('r-inner'));
      });
      assert.throws(() =>
        s.transact('run.phase', (inner) => {
          inner.putWork(work('lost'));
          inner.putLocal('usage', 'app', 'lost', call('lost'));
          inner.emit(phase('r-lost'));
          throw new Error('вложенный отказ');
        }),
      );
      tx.emit(phase('r-outer'));
    });
    assert.ok(s.read((v) => v.work('outer')));
    assert.ok(s.read((v) => v.work('inner')));
    assert.equal(
      s.read((v) => v.work('lost')),
      undefined,
    );
    assert.equal(
      s.read((v) => v.local('usage', 'app', 'lost')),
      undefined,
    );
    assert.deepEqual(
      s.events().map((e) => e.runId),
      ['r-inner', 'r-outer'],
    );
    s.close();
  });

  test(`${name}: Promise внутри транзакции отклоняется, ничего не записано`, () => {
    const s = open(tempDir());
    assert.throws(() =>
      s.transact('run.phase', (tx) => {
        tx.putWork(work('w1'));
        return Promise.resolve(1) as never;
      }),
    );
    assert.equal(
      s.read((v) => v.work('w1')),
      undefined,
    );
    s.close();
  });

  test(`${name}: heartbeat без события; транзакция только с событием его пишет`, () => {
    const s = open(tempDir());
    s.transact('run.phase', (tx) => tx.putWork(work('w1')));
    s.transact('heartbeat', (tx) => tx.putWork({ ...tx.work('w1')!, attempt: 1 }));
    assert.equal(
      s.read((v) => v.work('w1')?.attempt),
      1,
    );
    assert.deepEqual(s.events(), []);
    s.transact('run.phase', (tx) => tx.emit(phase('r1')));
    assert.equal(s.events().length, 1);
    s.close();
  });

  test(`${name}: события закрыты схемой; курсор строго по возрастанию`, () => {
    const s = open(tempDir());
    assert.throws(() =>
      s.transact('run.phase', (tx) =>
        tx.emit({ type: 'attempt.phase', payload: { phase: 'running', token: 'x' } } as never),
      ),
    );
    assert.deepEqual(s.events(), [], 'событие вне договора не записано');
    for (let i = 0; i < 5; i++) s.transact('run.phase', (tx) => tx.emit(phase('r' + i)));
    const all = s.events();
    assert.deepEqual(
      all.map((e) => e.runId),
      ['r0', 'r1', 'r2', 'r3', 'r4'],
    );
    for (let i = 1; i < all.length; i++) assert.ok(all[i]!.seq > all[i - 1]!.seq);
    assert.deepEqual(
      s.events(all[1]!.seq).map((e) => e.runId),
      ['r2', 'r3', 'r4'],
    );
    assert.deepEqual(
      s.events(0, 2).map((e) => e.runId),
      ['r0', 'r1'],
    );
    s.close();
  });

  test(`${name}: локальные записи различаются владельцем и проверяются схемой`, () => {
    const s = open(tempDir());
    s.transact('run.phase', (tx) => {
      tx.putLocal('usage', 'app', 'k', call('a'));
      tx.putLocal('usage', WORKSPACE_OWNER, 'k', call('b'));
    });
    assert.equal(
      s.read((v) => v.local('usage', 'app', 'k')?.id),
      'a',
    );
    assert.equal(
      s.read((v) => v.local('usage', WORKSPACE_OWNER, 'k')?.id),
      'b',
    );
    assert.equal(
      s.read((v) => v.locals('usage').length),
      2,
    );
    assert.equal(
      s.read((v) => v.locals('usage', 'app').length),
      1,
    );
    assert.throws(() =>
      s.transact('run.phase', (tx) => tx.putLocal('usage', 'app', 'bad', { id: 'bad' } as never)),
    );
    assert.equal(
      s.read((v) => v.local('usage', 'app', 'bad')),
      undefined,
    );
    s.close();
  });

  test(`${name}: запись вне договора модели отклоняется целиком`, () => {
    const s = open(tempDir());
    assert.throws(() =>
      s.transact('run.phase', (tx) => tx.putWork({ ...work('w1'), status: 'finished' } as never)),
    );
    assert.equal(
      s.read((v) => v.work('w1')),
      undefined,
    );
    s.close();
  });
}
