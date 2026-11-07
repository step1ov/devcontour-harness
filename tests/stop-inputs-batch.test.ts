/**
 * Диагноз многих работ за одно чтение: `stopInputsOf` с `workIds` даёт для
 * каждой работы те же входы, что вызов с её `workId`, а доска (без выбора) —
 * те же, что набор всех работ (кроме отменённых без ждущих). Общее для работ
 * читается один раз: на доске из 400 работ число чтений вида не растёт с
 * числом работ, и диагноз на виде хоста, который строит ответ каждого чтения
 * заново, укладывается в щедрый предел. Модели не вызываются.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessError } from '../src/contracts/errors.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop, type StopInput } from '../src/projections/stop.ts';
import {
  boardOf,
  hostLikeView,
  mulberry32,
  perfBoardOf,
  type BoardSpec,
} from './stop-inputs-fixture.ts';

const shapes = ['chain', 'fan', 'cancelled-roots', 'random'] as const;

/** Входы, относящиеся к работе: вход controller, её вход и её запросы ведущему. */
const ofWork = (inputs: StopInput[], id: string) =>
  inputs.filter(
    (i) =>
      i.kind === 'error' ||
      (i.kind === 'work' && i.work.id === id) ||
      (i.kind === 'input' && i.request.workId === id),
  );

test('workIds: входы каждой работы набора совпадают с вызовом по её workId', () => {
  let compared = 0;
  const seen = new Set<string>();
  for (let seed = 1; seed <= 48; seed++) {
    const spec: BoardSpec = {
      shape: shapes[seed % shapes.length]!,
      size: 12 + ((seed * 7) % 36),
      seed,
      approvalMode: seed % 3 === 0 ? 'operator' : 'agent',
      second: seed % 5 === 0,
    };
    const board = boardOf(spec);
    const opts = { maxAttempts: board.policy.maxAttempts, repairBudget: board.policy.repairBudget };
    const ids = board.ids();
    const per = new Map(ids.map((id) => [id, stopInputsOf(board.source, { ...opts, workId: id })]));
    const batch = stopInputsOf(board.source, { ...opts, workIds: ids });
    const full = stopInputsOf(board.source, opts);
    for (const id of ids) {
      assert.deepEqual(ofWork(batch, id), per.get(id), `seed ${seed}: ${id} в наборе`);
      const own = per.get(id)!.find((i) => i.kind === 'work');
      if (own?.kind === 'work') {
        seen.add(`status:${own.work.status}`);
        for (const f of ['waitingOn', 'openDependents', 'recovery', 'hold', 'approvalStale'])
          if (f in own.work) seen.add(f);
        seen.add(`outlook:${own.repair.outlook}`);
        if (own.control.paused) seen.add('paused');
      }
      compared++;
    }
    // Доска — набор всех работ без отменённых, которых никто не ждёт.
    const shown = batch.filter(
      (i) =>
        !(
          i.kind === 'work' &&
          i.work.status === 'cancelled' &&
          i.work.openDependents !== undefined &&
          !i.work.openDependents.length
        ),
    );
    assert.deepEqual(full, shown, `seed ${seed}: доска = набор всех`);
    assert.deepEqual(full.map(explainStop), shown.map(explainStop));
    // Случайное подмножество — в порядке состояния, независимо от порядка запроса.
    const rnd = mulberry32(seed * 31);
    const subset = ids.filter(() => rnd() < 0.3).reverse();
    const part = stopInputsOf(board.source, { ...opts, workIds: subset });
    assert.deepEqual(
      part,
      batch.filter(
        (i) =>
          i.kind === 'error' ||
          (i.kind === 'work' && subset.includes(i.work.id)) ||
          (i.kind === 'input' && subset.includes(i.request.workId)),
      ),
      `seed ${seed}: подмножество`,
    );
  }
  assert.ok(compared > 1000, `сравнено ${compared}`);
  // Генератор действительно даёт разные формы.
  for (const form of [
    'status:ready',
    'status:failed',
    'status:cancelled',
    'waitingOn',
    'openDependents',
    'recovery',
    'hold',
    'approvalStale',
    'outlook:stop',
    'outlook:retry',
    'outlook:wait',
    'paused',
  ])
    assert.ok(seen.has(form), `нет формы ${form}`);
});

test('workIds: неизвестная работа — NOT_FOUND, вместе с workId — INVALID_INPUT, пустой набор — без работ', () => {
  const board = boardOf({ shape: 'fan', size: 12, seed: 7 });
  const opts = { maxAttempts: 3, repairBudget: 3 };
  const [first] = board.ids();
  assert.throws(
    () => stopInputsOf(board.source, { ...opts, workIds: [first!, 'missing'] }),
    (e: unknown) =>
      e instanceof HarnessError && e.code === 'NOT_FOUND' && /missing/.test(e.message),
  );
  assert.throws(
    () => stopInputsOf(board.source, { ...opts, workId: first!, workIds: [first!] }),
    (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
  );
  assert.deepEqual(
    stopInputsOf(board.source, { ...opts, workIds: [] }).filter((i) => i.kind !== 'error'),
    [],
  );
});

/**
 * До исправления доска делала чтения на каждую работу и обход зависимостей:
 * на виде хоста цепочка глубиной 100 читала граф и работу тысячи раз
 * (около 8 с), 200 отменённых корней — сотни чтений графа на поиск ждущих.
 */
for (const shape of ['failed', 'cancelled', 'chain'] as const)
  test(`производительность: доска из 400 работ (${shape}) читает вид постоянное число раз`, () => {
    const counts = new Map<string, number>();
    const board = perfBoardOf(shape, hostLikeView(counts));
    const opts = { maxAttempts: 3, repairBudget: 3 };
    for (const form of ['full', 'batch'] as const) {
      counts.clear();
      const started = performance.now();
      const inputs = stopInputsOf(
        board.source,
        form === 'full' ? opts : { ...opts, workIds: board.ids },
      );
      const elapsed = performance.now() - started;
      const reads = [...counts.values()].reduce((a, b) => a + b, 0);
      assert.ok(inputs.filter((i) => i.kind === 'work').length >= 200, form);
      assert.ok(
        reads <= 40,
        `${form}: ${reads} чтений вида на 400 работ: ${JSON.stringify([...counts])}`,
      );
      assert.ok(elapsed < 2_000, `${form}: ${Math.round(elapsed)} мс`);
    }
  });
