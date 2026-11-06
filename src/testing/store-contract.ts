import assert from 'node:assert/strict';
import {
  WORKSPACE_OWNER,
  answerDigest,
  digestOf,
  inputRequestId,
  type ExecutionStore,
  type InputRequest,
  type RunEventDraft,
  type WorkState,
} from '../contracts/index.ts';

/**
 * Запрос исполнителя (`input-requests`) для проверок адаптера: вопрос с
 * вариантами, основание исходной попытки, без ответов (`pending`).
 */
export function sampleInputRequest(runId = 'run-1', workId = 'w1'): InputRequest {
  const d = digestOf(runId);
  return {
    id: inputRequestId(runId, 0),
    kind: 'question',
    blocking: true,
    workId,
    graphId: 'g',
    runId,
    attempt: 1,
    callId: 'call-1',
    question: {
      question: 'Какой формат даты в ответе API?',
      options: [
        { id: 'iso', label: 'ISO 8601', consequence: null },
        { id: 'unix', label: 'Unix seconds', consequence: 'меняет договор клиентов' },
      ],
      recommended: 'iso',
      severity: 8,
      rationale: 'Формат виден клиентам',
      affects: ['api'],
    },
    effectiveSeverity: 10,
    floors: ['declared'],
    criticalHits: [],
    draft: { digest: d, files: ['src/a.ts'] },
    createdAt: '2026-01-01T00:00:00.000Z',
    originBasis: {
      source: { connector: 'files', ref: workId, revision: '1' },
      graphId: 'g',
      graphDigest: d,
      orderDigest: d,
      policyDigest: d,
      contextDigest: null,
      baseSha: 'a'.repeat(40),
      inputPolicy: { threshold: 7, criticalPaths: [] },
    },
    lifecycle: 'pending',
    answers: [],
    version: 1,
  };
}

/** Тот же запрос с ответом: `answered`, следующая версия. */
export function answeredInputRequest(request: InputRequest, text = 'ISO 8601'): InputRequest {
  const content = {
    revision: request.answers.length + 1,
    text,
    optionId: null,
    kind: 'clarification' as const,
  };
  return {
    ...request,
    lifecycle: 'answered',
    answers: [
      ...request.answers,
      {
        ...content,
        actor: { kind: 'operator' },
        digest: answerDigest(request.id, content),
        at: '2026-01-01T00:01:00.000Z',
      },
    ],
    version: request.version + 1,
  };
}

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

  test(`${name}: состояние без вопросов исполнителя читается с пустым списком запросов`, () => {
    const dir = tempDir();
    const a = open(dir);
    a.transact('run.phase', (tx) => tx.putWork(work('w1')));
    a.close();
    const b = open(dir);
    assert.deepEqual(
      b.read((v) => v.locals('input-requests')),
      [],
    );
    assert.equal(
      b.read((v) => v.local('input-requests', 'app', inputRequestId('run-1', 0))),
      undefined,
    );
    b.close();
  });

  test(`${name}: запрос исполнителя хранится у владельца, версия видна другому экземпляру`, () => {
    const dir = tempDir();
    const a = open(dir);
    const request = sampleInputRequest();
    a.transact('run.failed', (tx) => {
      tx.putLocal('input-requests', 'app', request.id, request);
      tx.emit({
        type: 'input.requested',
        workId: 'w1',
        runId: 'run-1',
        payload: {
          requestId: request.id,
          kind: 'question',
          blocking: true,
          lifecycle: 'pending',
          effectiveSeverity: 10,
          floors: ['declared'],
          criticalHits: 0,
          questionDigest: digestOf(request.question),
          draftDigest: request.draft!.digest,
        },
      });
    });
    assert.deepEqual(
      a.read((v) => v.local('input-requests', 'app', request.id)),
      request,
    );
    assert.equal(
      a.read((v) => v.local('input-requests', WORKSPACE_OWNER, request.id)),
      undefined,
      'владелец — репозиторий поручения',
    );
    const b = open(dir);
    const answered = answeredInputRequest(request);
    b.transact('input.answered', (tx) =>
      tx.putLocal('input-requests', 'app', request.id, answered),
    );
    assert.equal(
      a.read((v) => v.local('input-requests', 'app', request.id)?.version),
      2,
    );
    assert.equal(
      a.read((v) => v.local('input-requests', 'app', request.id)?.answers[0]?.digest),
      answered.answers[0]!.digest,
    );
    assert.deepEqual(
      a.events().map((e) => e.type),
      ['input.requested'],
    );
    a.close();
    b.close();
  });

  test(`${name}: запросы исполнителя разных владельцев — список без владельца с owner и key, с владельцем — только его`, () => {
    const s = open(tempDir());
    const app = sampleInputRequest('run-app', 'w1');
    const lib = sampleInputRequest('run-lib', 'w2');
    s.transact('run.failed', (tx) => {
      tx.putLocal('input-requests', 'app', app.id, app);
      tx.putLocal('input-requests', 'lib', lib.id, lib);
    });
    // Движок ищет запрос по ID среди всех владельцев (answer, apply, cancel).
    const all = s.read((v) => v.locals('input-requests'));
    assert.deepEqual(
      all.map((r) => [r.owner, r.key, r.value.id]).sort(),
      [
        ['app', app.id, app.id],
        ['lib', lib.id, lib.id],
      ].sort(),
    );
    assert.deepEqual(
      s.read((v) => v.locals('input-requests', 'lib')).map((r) => [r.owner, r.key]),
      [['lib', lib.id]],
    );
    s.close();
  });

  test(`${name}: запрос исполнителя хранится ровно таким, каким записан, на каждой версии`, () => {
    // Правила версий (вопрос и основание неизменяемы, ответы только
    // дополняются, CAS по version) проверяет движок; хранилище обязано
    // хранить запись целиком: не сливать, не переупорядочивать, не
    // оставлять прежнюю версию.
    const dir = tempDir();
    const s = open(dir);
    const v1 = sampleInputRequest();
    const v2 = answeredInputRequest(v1, 'ISO');
    const v3 = answeredInputRequest(v2, 'ISO 8601, UTC');
    const v4: InputRequest = {
      ...v3,
      lifecycle: 'applied',
      target: {
        originDigest: digestOf(v3.originBasis),
        answerDigest: v3.answers[1]!.digest,
        graphDigest: v3.originBasis.graphDigest,
        orderDigest: v3.originBasis.orderDigest,
        policyDigest: v3.originBasis.policyDigest,
        contextDigest: digestOf('context'),
        review: { round: 2, approved: true, reviewerBinding: null },
        actor: 'agent',
        digest: digestOf('target'),
      },
      version: v3.version + 1,
    };
    for (const value of [v1, v2, v3, v4]) {
      s.transact('input.answered', (tx) => tx.putLocal('input-requests', 'app', v1.id, value));
      assert.deepEqual(
        s.read((v) => v.local('input-requests', 'app', v1.id)),
        value,
        'версия ' + value.version,
      );
    }
    s.close();
    const again = open(dir);
    const stored = again.read((v) => v.local('input-requests', 'app', v1.id))!;
    assert.deepEqual(stored, v4);
    assert.deepEqual(stored.question, v1.question);
    assert.deepEqual(stored.originBasis, v1.originBasis);
    assert.deepEqual(
      stored.answers.map((a) => [a.revision, a.text]),
      [
        [1, 'ISO'],
        [2, 'ISO 8601, UTC'],
      ],
    );
    assert.equal(again.read((v) => v.locals('input-requests')).length, 1, 'одна запись на ключ');
    again.close();
  });

  test(`${name}: запрос вне схемы и откат транзакции не оставляют записи`, () => {
    const s = open(tempDir());
    const request = sampleInputRequest();
    const invalid: unknown[] = [
      { ...request, extra: true },
      { ...request, id: 'IR-short' },
      { ...request, lifecycle: 'open' },
      { ...request, question: { ...request.question, severity: 11 } },
      { ...request, question: { ...request.question, recommended: 'nope' } },
      answeredInputRequest(request, 'x'.repeat(3001)),
    ];
    for (const value of invalid)
      assert.throws(() =>
        s.transact('run.failed', (tx) =>
          tx.putLocal('input-requests', 'app', request.id, value as InputRequest),
        ),
      );
    assert.throws(() =>
      s.transact('run.failed', (tx) => {
        tx.putLocal('input-requests', 'app', request.id, request);
        throw new Error('отказ');
      }),
    );
    assert.deepEqual(
      s.read((v) => v.locals('input-requests')),
      [],
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
