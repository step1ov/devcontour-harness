import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessError, digestOf, type ErrorCode } from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import {
  engineOf,
  graphOf,
  policyOf,
  ready,
  planReview,
  sha,
  trustNone,
} from './engine-fixture.ts';

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};

/** Провести попытку через обе фазы с PASS всех gates и ревью. */
function passEvidence(
  e: Engine,
  id: string,
  token: string,
  candidate: string,
  integration: string,
) {
  e.phase(id, token, 'verifying', { candidateSha: candidate });
  for (const [phase, at] of [
    ['candidate', candidate],
    ['integration', integration],
  ] as const) {
    if (phase === 'integration') e.phase(id, token, 'integrating', { integrationSha: integration });
    e.evidence(id, token, {
      kind: 'test',
      phase,
      sha: at,
      gate: 'unit',
      passed: true,
      command: ['npm', 'test'],
      exitCode: 0,
      log: '',
      digest: digestOf(phase),
      summary: 'ok',
    });
    e.evidence(id, token, {
      kind: 'review',
      phase,
      sha: at,
      gate: 'independent-review',
      passed: true,
      command: ['codex'],
      exitCode: 0,
      log: '',
      digest: digestOf('r' + phase),
      summary: 'ok',
      findings: [],
    });
  }
}

test('T02: невалидный граф отклоняется до записи; B не выдаётся до принятия A', () => {
  const { engine, store } = engineOf();
  assert.throws(
    () => engine.register(graphOf({ a: ['b'], b: ['a'] }), trustNone),
    refused('GRAPH_CYCLE'),
  );
  assert.throws(
    () => engine.register(graphOf({ a: ['ghost'] }), trustNone),
    refused('GRAPH_UNKNOWN_DEPENDENCY'),
  );
  assert.deepEqual(
    store.read((v) => v.graphs()),
    [],
    'ничего не записано',
  );
  assert.deepEqual(store.events(), []);

  ready(engine, graphOf({ a: [], b: ['a'] }));
  const first = engine.claim('c1')!;
  assert.equal(first.workId, 'a');
  assert.equal(engine.claim('c1'), undefined, 'B ждёт принятия A, а не выдаётся параллельно');
  passEvidence(engine, first.id, first.token, sha('a'), sha('b'));
  engine.finish(first.id, first.token, sha('b'));
  assert.equal(engine.claim('c1')?.workId, 'b', 'после принятия A выдаётся B');
});

test('T02: внешняя предпосылка без подтверждения не принимается; engine-receipt — только успешная попытка', () => {
  const { engine } = engineOf();
  const withPrereq = (receipt: object) => ({
    ...graphOf({ b: ['ext'] }),
    prerequisites: [{ id: 'ext', repositoryId: 'app', resultSha: sha('e'), receipt }],
  });
  assert.throws(
    () =>
      engine.register(
        withPrereq({ kind: 'trusted', issuer: 'board', digest: digestOf('x') }) as never,
        trustNone,
      ),
    refused('NOT_READY'),
  );
  assert.throws(
    () => engine.register(withPrereq({ kind: 'engine', runId: 'never-ran' }) as never, trustNone),
    refused('NOT_READY'),
  );
  // Доверенный источником receipt принимается, только если SHA доступен в target ref.
  assert.throws(
    () =>
      engine.register(
        withPrereq({ kind: 'trusted', issuer: 'board', digest: digestOf('x') }) as never,
        { trusted: () => true, reachable: () => false },
      ),
    refused('NOT_READY'),
  );
  const ok = engine.register(
    withPrereq({ kind: 'trusted', issuer: 'board', digest: digestOf('x') }) as never,
    { trusted: () => true, reachable: () => true },
  );
  assert.equal(ok.resumed, false);
});

test('T03: изменённая постановка — новая редакция; прежнее согласование к ней не относится, принятая история неизменна', () => {
  const { engine } = engineOf();
  const v1 = ready(engine, graphOf({ a: [], b: [] }, '1'));
  const a = engine.claim('c1')!;
  assert.throws(
    () =>
      engine.register(
        graphOf({ a: [], b: [] }, '1').orders.length
          ? {
              ...graphOf({ a: [], b: [] }, '1'),
              orders: graphOf({ a: [], b: [] }, '1').orders.map((o) => ({ ...o, title: 'Иначе' })),
            }
          : graphOf({ a: [] }),
        trustNone,
      ),
    refused('REVISION_CONFLICT'),
    'та же редакция с другим содержанием',
  );
  assert.throws(
    () => engine.register(graphOf({ a: [], c: [] }, '2'), trustNone),
    refused('REVISION_CONFLICT'),
    'новая редакция ждёт активных попыток',
  );
  passEvidence(engine, a.id, a.token, sha('a'), sha('c'));
  engine.finish(a.id, a.token, sha('c'));
  const v2graph = graphOf({ a: [], b: [] }, '2');
  v2graph.orders[1] = { ...v2graph.orders[1]!, goal: 'Другая цель поручения b.' };
  const v2 = engine.register(v2graph, trustNone);
  assert.equal(v2.replaced, true);
  assert.notEqual(v2.graph.digest, v1.digest);
  assert.equal(
    engine.read((v) => v.work('a')?.status),
    'done',
    'принятое с неизменной постановкой остаётся принятым',
  );
  assert.equal(
    engine.read((v) => v.work('b')?.status),
    'draft',
    'изменённое возвращается в черновик',
  );
  assert.equal(engine.claim('c1'), undefined, 'без нового ревью и согласования ничего не выдаётся');
  assert.throws(
    () => engine.approve('g', 'agent'),
    refused('APPROVAL_REQUIRED'),
    'ревью прежнего digest не годится',
  );
  engine.recordReview(planReview(engine, v2.graph, 2));
  engine.approve('g', 'agent');
  assert.equal(engine.claim('c1')?.workId, 'b');
  assert.equal(
    engine.read((v) => v.attempts('a').filter((x) => x.status === 'succeeded').length),
    1,
    'история попыток не переписана',
  );
});

test('T03: смена политики после согласования удерживает выдачу; после claim — отказ fenced-операций', () => {
  const dir = engineOf().dir;
  const first = engineOf(policyOf(), dir);
  ready(first.engine, graphOf({ a: [], b: [] }));
  const a = first.engine.claim('c1')!;
  first.store.close();
  const changed = policyOf((p) => ((p as { maxAttempts: number }).maxAttempts = 5));
  const second = engineOf(changed, dir);
  assert.throws(
    () => second.engine.heartbeat(a.id, a.token),
    refused('APPROVAL_STALE'),
    'попытка под прежней политикой не продолжается',
  );
  second.engine.lead('c1');
  assert.equal(second.engine.claim('c1'), undefined, 'новая политика требует нового согласования');
  const blockers = second.engine.read((v) => second.engine.blockers(v.work('b')!, v));
  assert.ok(
    blockers.some((b) => b.code === 'APPROVAL_STALE'),
    JSON.stringify(blockers),
  );
  second.engine.approve('g', 'agent');
  assert.equal(second.engine.claim('c1')?.workId, 'b');
});

test('T04: поздний ответ прежнего владельца, истёкший lease и второй controller не пишут', () => {
  const { engine, clock, store } = engineOf();
  ready(engine, graphOf({ a: [] }));
  assert.equal(engine.lead('c2'), false, 'второй controller не захватывает действующую роль');
  assert.throws(() => engine.claim('c2'), refused('CONTROLLER_BUSY'));
  const a = engine.claim('c1')!;
  assert.throws(() => engine.heartbeat(a.id, 'forged-token'), refused('LEASE_STALE'));
  clock.now += 31_000;
  assert.throws(
    () =>
      engine.evidence(a.id, a.token, {
        kind: 'test',
        phase: 'candidate',
        sha: sha('a'),
        gate: 'unit',
        passed: true,
        command: [],
        exitCode: 0,
        log: '',
        digest: digestOf('x'),
        summary: '',
      }),
    refused('LEASE_STALE'),
    'истёкший lease',
  );
  const adopted = engine.adopt(a.id, 'c3');
  assert.notEqual(adopted.token, a.token, 'новый владелец получает новый токен');
  assert.throws(
    () => engine.heartbeat(a.id, a.token),
    refused('LEASE_STALE'),
    'старый токен недействителен',
  );
  engine.heartbeat(adopted.id, adopted.token);
  assert.equal(engine.lead('c2'), true, 'истёкшая роль controller переходит');
  const events = JSON.stringify(store.events());
  assert.ok(!events.includes(a.token) && !events.includes(adopted.token), 'токены не в событиях');
});

test('T14: пауза запрещает выдачу и не снимается recovery; отмена не превращается в повтор; shutdown ≠ отмена', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [], b: [] }));
  const a = engine.claim('c1')!;
  engine.pause('operator');
  assert.equal(engine.claim('c1'), undefined, 'пауза запрещает новые claims');
  engine.heartbeat(a.id, a.token);
  engine.clearFailure(['environment']);
  assert.equal(
    engine.read((v) => v.control().paused),
    true,
    'снятие классов отказа не снимает паузу человека',
  );
  engine.cancel('a', 'не нужно');
  assert.throws(
    () => engine.heartbeat(a.id, a.token),
    refused('LEASE_STALE'),
    'отмена отзывает владение',
  );
  assert.equal(
    engine.read((v) => v.work('a')?.status),
    'cancelled',
  );
  assert.equal(
    engine.read((v) => v.work('a')?.attempt),
    1,
    'отмена не возвращает и не тратит повтор сама',
  );
  engine.pause('shutdown');
  assert.equal(
    engine.read((v) => v.control().pauseReason),
    'operator',
    'штатная остановка не подменяет паузу человека',
  );
  engine.resume();
  engine.pause('shutdown');
  assert.equal(
    engine.read((v) => v.control().pauseReason),
    'shutdown',
  );
  assert.equal(engine.claim('c1'), undefined, 'shutdown тоже запрещает выдачу');
  engine.resume();
  assert.equal(
    engine.claim('c1')?.workId,
    'b',
    'после штатной остановки работа продолжается; отменённое не выдаётся',
  );
  engine.retry('a');
  assert.equal(
    engine.read((v) => v.work('a')?.status),
    'ready',
    'повтор отменённого — только явным действием',
  );
});

test('T14: отказ провайдера ставит паузу runtime; recovery снимает только свой класс, решение человека — всё', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [], b: [] }));
  const a = engine.claim('c1')!;
  engine.fail(a.id, a.token, 'Not logged in', { kind: 'provider-auth', blocked: true });
  const control = engine.read((v) => v.control());
  assert.equal(control.paused, true);
  assert.equal(control.pauseReason, 'runtime');
  assert.deepEqual(control.pauseFailures, ['provider-auth']);
  assert.equal(
    engine.read((v) => v.work('a')?.attempt),
    0,
    'отказ провайдера до кандидата попытку не тратит',
  );
  assert.equal(engine.claim('c1'), undefined);
  engine.clearFailure(['environment']);
  assert.equal(
    engine.read((v) => v.control().paused),
    true,
    'чужой класс не снимает паузу',
  );
  engine.clearFailure(['provider-auth']);
  assert.equal(
    engine.read((v) => v.control().paused),
    false,
    'устранённая причина снимает свою паузу',
  );
  // Пауза человека поверх отказа: recovery её не снимает; человек — снимает.
  const b = engine.claim('c1')!;
  engine.fail(b.id, b.token, 'Not logged in', { kind: 'provider-auth', blocked: true });
  engine.pause('operator');
  engine.clearFailure(['provider-auth']);
  assert.equal(
    engine.read((v) => v.control().pauseReason),
    'operator',
  );
  assert.equal(
    engine.read((v) => v.control().paused),
    true,
  );
  engine.resume();
  assert.equal(
    engine.read((v) => v.control().paused),
    false,
  );
  assert.equal(
    engine.read((v) => v.control().pauseFailures),
    undefined,
  );
});

test('Приёмка требует PASS gates и ревью в обеих фазах на точных SHA; отказ publish откатывает приёмку', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  engine.phase(a.id, a.token, 'verifying', { candidateSha: sha('a') });
  assert.throws(
    () => engine.finish(a.id, a.token, sha('b')),
    refused('NOT_READY'),
    'нет интеграции',
  );
  engine.phase(a.id, a.token, 'integrating', { integrationSha: sha('b') });
  assert.throws(() => engine.finish(a.id, a.token, sha('b')), refused('GATE_FAILED'));
  const ev = (
    kind: 'test' | 'review',
    phase: 'candidate' | 'integration',
    at: string,
    passed = true,
  ) =>
    engine.evidence(a.id, a.token, {
      kind,
      phase,
      sha: at,
      gate: kind === 'test' ? 'unit' : 'independent-review',
      passed,
      command: [],
      exitCode: passed ? 0 : 1,
      log: '',
      digest: digestOf(kind + phase + at),
      summary: '',
    });
  ev('test', 'candidate', sha('a'));
  ev('test', 'integration', sha('c')); // PASS на чужом SHA не считается
  assert.throws(() => engine.finish(a.id, a.token, sha('b')), refused('GATE_FAILED'));
  ev('test', 'integration', sha('b'));
  assert.throws(() => engine.finish(a.id, a.token, sha('b')), refused('REVIEW_REJECTED'));
  ev('review', 'candidate', sha('a'));
  ev('review', 'integration', sha('b'), false);
  assert.throws(
    () => engine.finish(a.id, a.token, sha('b')),
    refused('REVIEW_REJECTED'),
    'последнее ревью — отказ',
  );
  ev('review', 'integration', sha('b'));
  assert.throws(
    () =>
      engine.finish(a.id, a.token, sha('b'), () => {
        throw new Error('cannot lock ref');
      }),
    /cannot lock ref/,
  );
  assert.equal(
    engine.read((v) => v.work('a')?.status),
    'integrating',
    'отказ CAS откатил приёмку',
  );
  engine.finish(a.id, a.token, sha('b'));
  assert.equal(
    engine.read((v) => v.work('a')?.resultSha),
    sha('b'),
  );
  assert.throws(
    () => engine.finish(a.id, a.token, sha('b')),
    refused('LEASE_STALE'),
    'повторной приёмки нет',
  );
});

test('Согласование: в operator mode агент не согласует; отклонённый раунд не согласует', () => {
  const op = engineOf(policyOf((p) => ((p as { approvalMode: string }).approvalMode = 'operator')));
  const g = op.engine.register(graphOf({ a: [] }), trustNone).graph;
  op.engine.recordReview(planReview(op.engine, g, 1));
  assert.throws(() => op.engine.approve('g', 'agent'), refused('APPROVAL_REQUIRED'));
  op.engine.approve('g', 'operator');
  const ag = engineOf();
  const g2 = ag.engine.register(graphOf({ a: [] }), trustNone).graph;
  ag.engine.recordReview(planReview(ag.engine, g2, 1, false));
  assert.throws(() => ag.engine.approve('g', 'agent'), refused('REVIEW_REJECTED'));
  assert.throws(
    () => ag.engine.recordReview(planReview(ag.engine, g2, 3)),
    refused('INVALID_INPUT'),
    'раунды подряд',
  );
});

test('T04: поздний finish прежнего владельца после передачи попытки отклоняется', () => {
  const { engine, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  passEvidence(engine, a.id, a.token, sha('a'), sha('b'));
  clock.now += 31_000;
  const adopted = engine.adopt(a.id, 'c2');
  assert.throws(
    () => engine.finish(a.id, a.token, sha('b')),
    refused('LEASE_STALE'),
    'старый токен не принимает',
  );
  assert.equal(
    engine.read((v) => v.work('a')!.status),
    'integrating',
  );
  engine.finish(adopted.id, adopted.token, sha('b'));
  assert.equal(
    engine.read((v) => v.work('a')!.status),
    'done',
  );
});

test('T10: повторы ограничены maxAttempts; после исчерпания — только явный сброс с причиной', () => {
  const { engine } = engineOf(policyOf((p) => ((p as { maxAttempts: number }).maxAttempts = 2)));
  ready(engine, graphOf({ a: [] }));
  for (let i = 0; i < 2; i++) {
    const a = engine.claim('c1')!;
    engine.fail(a.id, a.token, 'cannot lock ref', { kind: 'stale-base' });
    if (i === 0) engine.retry('a');
  }
  assert.throws(() => engine.retry('a'), refused('ATTEMPTS_EXHAUSTED'));
  assert.equal(engine.claim('c1'), undefined, 'исчерпанное не выдаётся');
  engine.retry('a', { reason: 'база обновлена вручную' });
  assert.equal(engine.claim('c1')?.attempt, 1, 'сброс начинает счёт заново');
});
