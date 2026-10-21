/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тест правит сырой JSON политики до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessError, digestOf, type ErrorCode } from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
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

test('S2-R1-10/T06: без PASS gate кандидата приёмки нет, даже если gate интеграции и оба ревью зелёные', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  engine.phase(a.id, a.token, 'verifying', { candidateSha: sha('a') });
  engine.phase(a.id, a.token, 'integrating', { integrationSha: sha('b') });
  const ev = (kind: 'test' | 'review', phase: 'candidate' | 'integration', at: string) =>
    engine.evidence(a.id, a.token, {
      kind,
      phase,
      sha: at,
      gate: kind === 'test' ? 'unit' : 'independent-review',
      passed: true,
      command: [],
      exitCode: 0,
      log: '',
      digest: digestOf(kind + phase),
      summary: '',
    });
  ev('test', 'integration', sha('b'));
  ev('review', 'candidate', sha('a'));
  ev('review', 'integration', sha('b'));
  assert.throws(() => engine.finish(a.id, a.token, sha('b')), refused('GATE_FAILED'));
  assert.notEqual(
    engine.read((v) => v.work('a')!.status),
    'done',
  );
  ev('test', 'candidate', sha('a'));
  engine.finish(a.id, a.token, sha('b'));
  assert.equal(
    engine.read((v) => v.work('a')!.status),
    'done',
  );
});

test('S2-R1-03/T03: новая редакция источника не снимает чужое удержание; снимает только release владельца, в том числе после перезапуска', () => {
  const { engine, store, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  engine.hold(['a'], 'contract-change-1', 'операция идёт');
  assert.equal(engine.claim('c1'), undefined);
  ready(engine, graphOf({ a: [] }, '2'));
  assert.equal(
    engine.read((v) => v.work('a')!.hold?.operation),
    'contract-change-1',
  );
  assert.equal(engine.claim('c1'), undefined, 'новая редакция не открыла выдачу');
  // Перезапуск: другой движок над тем же хранилищем, ещё одна редакция.
  engine.release('c1');
  const restarted = new Engine({
    host: standaloneHost(store, policyOf()),
    policy: policyOf(),
    now: () => clock.now,
  });
  ready(restarted, graphOf({ a: [] }, '3'), 'c2');
  assert.equal(restarted.claim('c2'), undefined);
  restarted.releaseHold('other-operation');
  assert.equal(restarted.claim('c2'), undefined, 'чужая операция не снимает удержание');
  restarted.releaseHold('contract-change-1');
  assert.equal(restarted.claim('c2')?.workId, 'a');
});

test('S2-R1-11/T23: покрытие gates не засчитывает evidence попытки под прежней политикой', () => {
  const { engine, store, clock } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  passEvidence(engine, a.id, a.token, sha('a'), sha('b'));
  engine.finish(a.id, a.token, sha('b'));
  engine.release('c1');
  assert.deepEqual(engine.uncoveredGates(['a']), []);
  const next = policyOf((p: any) => (p.repositories[0].gates[0].command = ['entirely-new-test']));
  const n = new Engine({ host: standaloneHost(store, next), policy: next, now: () => clock.now });
  n.lead('new');
  assert.deepEqual(n.uncoveredGates(['a']), [{ repositoryId: 'app', gates: ['unit'] }]);
  n.release('new');
});

test('S2-R2-01: согласование, связанное с контекстом, не принимает попытку прежнего снимка; попытка нового снимка принимается', () => {
  const { engine } = engineOf();
  const { graph } = engine.register(graphOf({ a: [] }), trustNone);
  const round = (n: number, context: string) =>
    engine.recordReview({ ...planReview(engine, graph, n), contextDigest: context });
  round(1, digestOf('A'));
  engine.approve(graph.id, 'agent', { bindContext: true });
  engine.lead('c1');
  engine.resume();
  const old = engine.claim('c1')!;
  engine.update(old.id, old.token, 'run.context', { contextSnapshot: digestOf('A') });
  passEvidence(engine, old.id, old.token, sha('a'), sha('b'));
  // Пока шла попытка, согласован другой снимок контекста.
  round(2, digestOf('B'));
  engine.approve(graph.id, 'agent', { bindContext: true });
  assert.throws(() => engine.finish(old.id, old.token, sha('b')), refused('APPROVAL_STALE'));
  assert.notEqual(
    engine.read((v) => v.work('a')!.status),
    'done',
  );
  engine.fail(old.id, old.token, 'основание изменилось', { kind: 'stale-base' });
  engine.retry('a');
  const next = engine.claim('c1')!;
  engine.update(next.id, next.token, 'run.context', { contextSnapshot: digestOf('B') });
  passEvidence(engine, next.id, next.token, sha('a'), sha('c'));
  engine.finish(next.id, next.token, sha('c'));
  assert.equal(
    engine.read((v) => v.work('a')!.status),
    'done',
  );
});

test('expire(at): владение, истекающее к моменту at, снимается; живое сейчас — нет без at', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  assert.deepEqual(engine.expire(), [], 'lease ещё действует');
  assert.deepEqual(engine.expire(Number.MAX_SAFE_INTEGER), [a.id]);
  assert.equal(
    engine.read((v) => v.attempt(a.id)!.status),
    'expired',
  );
});

test('Версия проверок по формуле хоста: попытка закрепляет её, приёмка сверяет с текущей формулой', () => {
  const policy = policyOf();
  const { store } = engineOf(policy);
  let salt = 'v1';
  const base = standaloneHost(store, policy);
  const engine = new Engine({
    host: {
      ...base,
      basis: {
        ...base.basis,
        checksDigest: (work, policyDigest) => digestOf({ host: salt, work: work.id, policyDigest }),
      },
    },
    policy,
  });
  ready(engine, graphOf({ a: [] }));
  const a = engine.claim('c1')!;
  const expected = digestOf({
    host: 'v1',
    work: 'a',
    policyDigest: base.basis.policyDigest(
      engine.read((v) => v.work('a')!),
      engine.read((v) => v),
    ),
  });
  assert.equal(a.checks?.effective, expected, 'формула хоста при выдаче');
  passEvidence(engine, a.id, a.token, sha('a'), sha('b'));
  salt = 'v2';
  assert.throws(() => engine.finish(a.id, a.token, sha('b')), /Версия проверок/);
  salt = 'v1';
  engine.finish(a.id, a.token, sha('b'));
  assert.equal(
    engine.read((v) => v.work('a')!.status),
    'done',
  );
});

test('T14: повторная пауза человека — новое решение со своим временем; повтор штатной остановки ничего не меняет', () => {
  const { engine, clock } = engineOf();
  engine.pause('operator');
  const first = engine.read((v) => v.control().pausedAt);
  clock.now += 60_000;
  assert.equal(engine.pause('operator').changed, true);
  const again = engine.read((v) => v.control());
  assert.equal(again.pauseReason, 'operator');
  assert.notEqual(again.pausedAt, first, 'время паузы — время последнего решения');
  assert.equal(again.pausedAt, new Date(clock.now).toISOString());
  engine.resume();
  engine.pause('shutdown');
  const stopped = engine.read((v) => v.control().pausedAt);
  clock.now += 60_000;
  assert.equal(engine.pause('shutdown').changed, false);
  assert.equal(
    engine.read((v) => v.control().pausedAt),
    stopped,
  );
});

test('S3-R1-05: время готовности поручения от хоста записывается в новую попытку при выдаче; без порта — не выдумывается', () => {
  const policy = policyOf();
  const dir = mkdtempSync(join(tmpdir(), 'harness-engine-'));
  const store = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  const asked: string[] = [];
  const host = {
    ...standaloneHost(store, policy),
    readyAt: (work: { id: string }) => {
      asked.push(work.id);
      return '2026-01-01T00:00:05.000Z';
    },
  };
  const engine = new Engine({ host, policy, now: () => Date.parse('2026-01-01T00:00:10.000Z') });
  ready(engine, graphOf({ a: [] }));
  const attempt = engine.claim('c1')!;
  assert.deepEqual(asked, ['a']);
  assert.equal(attempt.wait?.readyAt, '2026-01-01T00:00:05.000Z');
  assert.equal(engine.read((v) => v.attempt(attempt.id))?.wait?.readyAt, attempt.wait?.readyAt);
  const plain = engineOf();
  ready(plain.engine, graphOf({ a: [] }));
  const other = plain.engine.claim('c1')!;
  assert.ok(other.wait?.approvedAt);
  assert.equal(other.wait?.readyAt, undefined);
});

test('Роль controller записывает версию движка; живую роль другой версии не перенимает даже тот же владелец', () => {
  const { engine, store, clock } = engineOf();
  assert.equal(engine.lead('c1'), true);
  assert.equal(
    engine.read((v) => v.controller()?.engineVersion),
    engine.version,
  );
  engine.release('c1');
  assert.equal(
    engine.read((v) => v.controller()),
    undefined,
    'штатное освобождение снимает роль целиком',
  );
  const older = new Engine({
    host: standaloneHost(store, policyOf()),
    policy: policyOf(),
    now: () => clock.now,
    version: '0.0.1-older',
  });
  assert.equal(older.lead('c1'), true);
  assert.equal(engine.lead('c1'), false, 'тот же владелец, другая версия — другой процесс');
  assert.throws(() => engine.claim('c1'), refused('CONTROLLER_BUSY'));
  assert.equal(
    engine.read((v) => v.controller()?.engineVersion),
    '0.0.1-older',
    'чужая роль цела',
  );
  assert.equal(engine.release('c1'), false, 'роль прежней версии не снимается чужим процессом');
  assert.equal(
    engine.read((v) => v.controller()?.owner),
    'c1',
  );
  // Роль, записанная движком без версии, — тоже прежний процесс.
  store.transact('heartbeat', (tx) =>
    tx.setController({ owner: 'c1', leaseUntil: clock.now + 30_000 }),
  );
  assert.equal(engine.lead('c1'), false, 'живая роль без версии не перенимается');
  clock.now += 31_000;
  assert.equal(engine.lead('c1'), true, 'после истечения роль переходит штатно');
  assert.equal(
    engine.read((v) => v.controller()?.engineVersion),
    engine.version,
  );
  engine.release('c1');
});

test('S4-R1-02: движок другой версии не продолжает активную попытку прежним token до истечения срока', () => {
  const { engine: newer, store, clock } = engineOf();
  const older = new Engine({
    host: standaloneHost(store, policyOf()),
    policy: policyOf(),
    now: () => clock.now,
    version: '0.0.1-older',
  });
  ready(older, graphOf({ a: [] }));
  assert.equal(older.lead('c1'), true);
  const a = older.claim('c1')!;
  assert.equal(a.engineVersion, '0.0.1-older');
  const before = () => JSON.stringify(newer.read((v) => v.attempt(a.id)));
  const snapshot = before();
  // Срок попытки и роли не истёк; новая версия не получила роль.
  assert.equal(newer.lead('c1'), false);
  for (const op of [
    () => newer.heartbeat(a.id, a.token),
    () => newer.phase(a.id, a.token, 'verifying', { candidateSha: sha('a') }),
    () => newer.finish(a.id, a.token, sha('a')),
    () => newer.fail(a.id, a.token, 'чужая версия'),
  ])
    assert.throws(op, refused('LEASE_STALE'));
  assert.equal(newer.heartbeatFailed(a.id, a.token, 'x'), false);
  assert.equal(before(), snapshot, 'попытка прежней версии изменена новым движком');
  // Своя версия по-прежнему ведёт попытку.
  older.heartbeat(a.id, a.token);
  // Запись без версии (до появления поля) тоже не продолжается новым движком.
  store.transact('heartbeat', (tx) => {
    const legacy = { ...tx.attempt(a.id)! };
    delete legacy.engineVersion;
    tx.putAttempt(legacy);
  });
  assert.throws(() => newer.heartbeat(a.id, a.token), refused('LEASE_STALE'));
  // Восстановление — только истечением и новой попыткой с новым владением.
  clock.now += 3_600_000;
  newer.expire();
  assert.equal(newer.read((v) => v.attempt(a.id))?.status, 'expired');
});
