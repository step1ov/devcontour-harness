/**
 * 0.1.0-alpha.73: движок тонкого режима. Сбой среды проверки сдачи
 * (`gate-environment`) и конфликт слияния с целью (`merge-conflict`) — ход
 * ведущего, как остановка исполнителя из-за окружения: попытка не засчитана,
 * без паузы очереди и без удержаний. Сессия writer записывается в попытку.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attemptCounted, attemptSummaryOf } from '../src/report/compute.ts';
import { countedFailure } from '../src/projections/lead-recovery.ts';
import { engineOf, graphOf, policyOf, ready } from './engine-fixture.ts';

function setup() {
  const env = engineOf(policyOf((p) => (p.concurrency = 1)));
  ready(env.engine, graphOf({ a: [], b: [] }));
  return env;
}

for (const cause of ['gate-environment', 'merge-conflict'] as const)
  test(`${cause}: ведущему, не засчитана, без паузы и удержания`, () => {
    const { engine: e, store } = setup();
    const a = e.claim('c1')!;
    e.fail(a.id, a.token, `сдача: ${cause}`, { kind: 'needs-lead', cause });
    const w = e.read((v) => v.work(a.workId)!);
    assert.equal(w.status, 'failed');
    assert.equal(w.failureKind, 'needs-lead');
    assert.equal(w.attempt, 0, 'попытка не засчитана');
    assert.equal(w.neutralFailures, 1);
    assert.equal(w.environmentHold, undefined, 'удержания нет');
    assert.equal(e.read((v) => v.control()).paused, false, 'очередь не на паузе');
    const attempt = e.read((v) => v.attempts(a.workId)[0]!);
    assert.equal(attempt.leadCause, cause);
    assert.equal(attempt.writerBlocked, undefined, 'не остановка исполнителя');
    const diagnosed = store
      .events(0, 500)
      .filter((x) => x.type === 'attempt.diagnosed')
      .map((x) => x.payload as { cause: string; counted: boolean });
    assert.deepEqual(diagnosed, [{ failureKind: 'needs-lead', cause, counted: false }]);
    // Проекции считают так же, как движок.
    assert.equal(countedFailure(attempt), false);
    assert.equal(attemptCounted(attempt, [attempt], 3), false);
    assert.match(
      attemptSummaryOf(w, [attempt]).lastFailure?.reference ?? '',
      new RegExp(`#cause-${cause}$`),
    );
    // Другая работа выдаётся.
    assert.ok(e.claim('c1'), 'вторая работа выдана');
  });

test('прежний needs-lead без причины тонкого режима засчитан, как раньше', () => {
  const { engine: e } = setup();
  const a = e.claim('c1')!;
  e.fail(a.id, a.token, 'needs lead', { kind: 'needs-lead' });
  const attempt = e.read((v) => v.attempts(a.workId)[0]!);
  assert.equal(attempt.leadCause, undefined);
  assert.equal(e.read((v) => v.work(a.workId)!).attempt, 1);
});

test('сессия writer записывается в попытку под fencing', () => {
  const { engine: e } = setup();
  const a = e.claim('c1')!;
  e.recordWriterSession(a.id, a.token, { runtime: 'codex', id: 'thread-1', mode: 'fresh' });
  assert.deepEqual(
    e.read((v) => v.attempts(a.workId)[0]!.writerSession),
    {
      runtime: 'codex',
      id: 'thread-1',
      mode: 'fresh',
    },
  );
  e.recordWriterSession(a.id, a.token, {
    runtime: 'codex',
    id: 'thread-2',
    mode: 'fallback',
    reason: 'сессия thread-1 не продолжена',
  });
  assert.equal(
    e.read((v) => v.attempts(a.workId)[0]!.writerSession?.mode),
    'fallback',
  );
  assert.throws(() =>
    e.recordWriterSession(a.id, 'x'.repeat(32), { runtime: 'codex', id: 't', mode: 'fresh' }),
  );
});
