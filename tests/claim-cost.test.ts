/**
 * Цена выдачи при длинной истории: `claim`, которому выдавать нечего, не
 * перечитывает прежние попытки и записи вызовов, пока версия данных та же;
 * после изменения — читает историю один раз, а не на каждое готовое поручение
 * и каждую его область бюджета. Бюджетные удержания, которые пишет `claim`, —
 * те же, что у замороженных бюджетов (`budget-oracle.ts`), в том числе после
 * изменения записей вызовов и попыток между выдачами (кэш не устаревает).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_OWNER, type AttemptState } from '../src/contracts/index.ts';
import { callRecords } from '../src/engine/usage.ts';
import * as oracle from './budget-oracle.ts';
import { callOf, historyBoard } from './claim-cost-fixture.ts';
import { sha } from './engine-fixture.ts';

const FIXED = Date.parse('2026-06-01T00:00:00.000Z');
const frozen = <T>(fn: () => T): T => {
  const realNow = Date.now;
  Date.now = () => FIXED;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
};

type Board = ReturnType<typeof historyBoard>;

/** Удержания, записанные `claim`, и ожидаемые по замороженным бюджетам. */
function blocks(b: Board) {
  return b.engine.read((v) => {
    const c = b.engine.budgetContext();
    return b.ids.map((id) => ({
      id,
      written: v.work(id)!.budgetBlock?.reason,
      expected: oracle.blockingBudget(c, oracle.workBudgets(c, v, id, callRecords(v), FIXED))
        ?.reason,
    }));
  });
}

function claimCost(history: number, legacy: boolean) {
  const b = historyBoard(history, { legacy });
  b.reset();
  b.engine.claim('c1');
  const first = { ...b.counters };
  b.reset();
  b.engine.claim('c1');
  b.engine.claim('c1');
  const steady = { ...b.counters };
  b.store.close();
  return { first, steady };
}

for (const legacy of [false, true])
  test(`claim на простое не читает историю: цена не растёт с ней${legacy ? ' (записи без поручения)' : ''}`, () => {
    const small = claimCost(20, legacy);
    const large = claimCost(600, legacy);
    // Без изменений данных — ни попыток, ни записей вызовов.
    assert.deepEqual(small.steady, { attempts: 0, usage: 0 });
    assert.deepEqual(large.steady, { attempts: 0, usage: 0 });
    // Первая выдача после изменения читает историю один раз (+1 попытка-образец
    // и записи о ней), а не на каждое из 8 поручений и 3 области бюджетов.
    // Прежние записи без поручения узнают его по попытке — тоже один раз.
    const once = (h: number) => ({ attempts: h + 1 + (legacy ? h : 0), usage: h });
    assert.deepEqual(large.first, once(600));
    assert.deepEqual(small.first, once(20));
  });

test('удержания claim = замороженные бюджеты; изменения между выдачами не теряются кэшем', () => {
  for (const legacy of [false, true]) {
    const tag = legacy ? 'legacy' : 'modern';
    // 40 попыток по $0.01 на 8 поручений: у каждого $0.05 — предел $0.05 исчерпан.
    const b = historyBoard(40, {
      legacy,
      budgets: { work: { usd: 0.06 }, onUnknown: 'stop' },
    });
    const step = (label: string, expectBlocked: string[]) => {
      frozen(() => b.engine.claim('c1'));
      const got = blocks(b);
      for (const r of got) assert.equal(r.written, r.expected, `${tag} ${label}: ${r.id}`);
      assert.deepEqual(
        got.filter((r) => r.written).map((r) => r.id),
        expectBlocked,
        `${tag} ${label}: удержанные`,
      );
    };
    step('в пределах', []);
    step('повтор без изменений', []);
    // Новая запись вызова поручения w3: его предел исчерпан со следующей выдачи.
    b.store.transact('task.retry', (tx) =>
      tx.putLocal(
        'usage',
        WORKSPACE_OWNER,
        'call-extra',
        callOf('extra', { runId: 'old-3', ...(legacy ? {} : { workId: 'w3' }) }),
      ),
    );
    step('после новой записи', ['w3']);
    // Попытка w5 становится попыткой без учёта вызовов: бюджет не определён.
    b.store.transact('task.retry', (tx) => {
      const a: Partial<AttemptState> = { ...tx.attempt('old-13')!, candidateSha: sha('c') };
      delete a.callsRecorded;
      tx.putAttempt(a as AttemptState);
      // Запись её реализации снимается: вызовы попытки не записаны.
      tx.putLocal('usage', WORKSPACE_OWNER, 'call-13', {
        ...callOf(13, { runId: 'other', stage: 'review' }),
      });
    });
    step('после попытки без учёта', ['w3', 'w5']);
    b.store.close();
  }
});

test('удержания claim = замороженные бюджеты с попытками без учёта вызовов в истории', () => {
  const b = historyBoard(30, { uncovered: 3, legacy: true });
  frozen(() => b.engine.claim('c1'));
  for (const r of blocks(b)) assert.equal(r.written, r.expected, r.id);
  assert.ok(
    blocks(b).every((r) => r.written?.includes('не определён')),
    'общий бюджет не определён',
  );
  b.store.close();
});

test('кэш учёта вызовов: вложенная выдача видит незафиксированный расход, откат не оставляет фантомов', () => {
  const budgets = { total: { usd: 0.01 }, onUnknown: 'stop' };
  const totalBlocked = (b: Board) => b.engine.read((v) => v.work('w0')!.budgetBlock?.reason);
  const spend = (id: string) =>
    callOf(id, { workId: 'w0', groupId: 'g', startedAt: '2025-12-31T00:00:00.000Z' });
  // Кэш прогрет; вложенная выдача после записи расхода во внешней транзакции.
  const warm = historyBoard(0, { budgets });
  frozen(() => warm.engine.claim('c1'));
  assert.equal(totalBlocked(warm), undefined, 'без расхода — не держит');
  frozen(() =>
    warm.store.transact('task.retry', (tx) => {
      tx.putLocal('usage', WORKSPACE_OWNER, 'call-uncommitted', spend('uncommitted'));
      warm.engine.claim('c1');
    }),
  );
  assert.match(totalBlocked(warm) ?? '', /Бюджет total исчерпан/, 'вложенная выдача видит расход');
  warm.store.close();
  // Кэш пуст; первая выдача — во внешней транзакции, которая затем откатывается.
  const cold = historyBoard(0, { budgets });
  assert.throws(() =>
    frozen(() =>
      cold.store.transact('task.retry', (tx) => {
        tx.putLocal('usage', WORKSPACE_OWNER, 'call-rolled-back', spend('rolled-back'));
        cold.engine.claim('c1');
        throw new Error('откат');
      }),
    ),
  );
  frozen(() => cold.engine.claim('c1'));
  const got = blocks(cold);
  for (const r of got) assert.equal(r.written, r.expected, `после отката: ${r.id}`);
  assert.equal(totalBlocked(cold), undefined, 'откаченный расход не держит');
  cold.store.close();
});

test('pristine: только внешняя транзакция без записей', () => {
  const b = historyBoard(0, { budgets: null });
  b.store.transact('task.retry', (tx) => {
    assert.equal(tx.pristine?.(), true, 'нетронутая внешняя');
    b.store.transact('task.retry', (inner) => assert.equal(inner.pristine?.(), false, 'вложенная'));
    tx.putLocal('usage', WORKSPACE_OWNER, 'call-x', callOf('x'));
    assert.equal(tx.pristine?.(), false, 'после локальной записи');
  });
  b.store.transact('task.retry', (tx) => {
    tx.emit({
      type: 'work.held',
      graphId: 'g',
      workId: 'w0',
      payload: { operation: 'x', reason: 'y', released: true },
    });
    assert.equal(tx.pristine?.(), false, 'после события');
  });
  b.store.transact('task.retry', (tx) => {
    tx.putWork({ ...tx.work('w0')! });
    assert.equal(tx.pristine?.(), false, 'после записи модели');
  });
  b.store.read((v) => assert.notEqual(v.pristine?.(), true, 'вид чтения'));
  b.store.close();
});
