/**
 * Диагноз многих работ за одно чтение: `stopInputsOf` с `workIds` даёт для
 * каждой работы те же входы, что вызов с её `workId`, а доска (без выбора) —
 * те же, что набор всех работ (кроме отменённых без ждущих). Эталон —
 * замороженная прежняя реализация (`stop-inputs-oracle.ts`), которая читает
 * вид заново на каждую работу. `Engine.approvalStaleness` сверяется с
 * причинами `APPROVAL_STALE` из `blockers`. Общее для работ читается один раз:
 * на доске из 400 работ число чтений вида не растёт с числом работ (и с
 * бюджетами тоже). Модели не вызываются.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessError } from '../src/contracts/errors.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop, type StopInput } from '../src/projections/stop.ts';
import { policyOf } from './engine-fixture.ts';
import {
  boardOf,
  hostLikeView,
  mulberry32,
  perfBoardOf,
  type BoardSpec,
} from './stop-inputs-fixture.ts';
import { referenceStopInputsOf } from './stop-inputs-oracle.ts';

const shapes = ['chain', 'fan', 'cancelled-roots', 'random'] as const;

const specOf = (seed: number): BoardSpec => ({
  shape: shapes[seed % shapes.length]!,
  size: 12 + ((seed * 7) % 36),
  seed,
  approvalMode: seed % 3 === 0 ? 'operator' : 'agent',
  second: seed % 5 === 0 || seed % 7 === 0,
  rich: seed % 2 === 0 || seed > 60,
});

/** Входы, относящиеся к работе: вход controller, её вход и её запросы ведущему. */
const ofWork = (inputs: StopInput[], id: string) =>
  inputs.filter(
    (i) =>
      i.kind === 'error' ||
      (i.kind === 'work' && i.work.id === id) ||
      (i.kind === 'input' && i.request.workId === id),
  );

/**
 * Без поля `preflight` (R7-3), которого прежняя реализация не знала; само
 * поле проверяется отдельно: оно стоит ровно у упавших работ, чья последняя
 * попытка не засчитана классом не окружения.
 */
const withoutPreflight = (inputs: StopInput[]) =>
  inputs.map((i) => {
    if (i.kind !== 'work' || !i.work.preflight) return i;
    const work = { ...i.work };
    delete work.preflight;
    return { ...i, work };
  });

test('stopInputsOf совпадает с прежней реализацией (эталон) на доске и по каждой работе; workIds — с вызовами по workId', () => {
  let compared = 0;
  const seen = new Set<string>();
  for (let seed = 1; seed <= 80; seed++) {
    const board = boardOf(specOf(seed));
    const opts = { maxAttempts: board.policy.maxAttempts, repairBudget: board.policy.repairBudget };
    const ids = board.ids();
    const full = stopInputsOf(board.source, opts);
    assert.deepEqual(
      withoutPreflight(full),
      referenceStopInputsOf(board.source, opts),
      `seed ${seed}: доска = эталон`,
    );
    const per = new Map(ids.map((id) => [id, stopInputsOf(board.source, { ...opts, workId: id })]));
    const batch = stopInputsOf(board.source, { ...opts, workIds: ids });
    for (const id of ids) {
      const own = per.get(id)!;
      assert.deepEqual(
        withoutPreflight(own),
        referenceStopInputsOf(board.source, { ...opts, workId: id }),
        `seed ${seed}: ${id} = эталон`,
      );
      assert.deepEqual(ofWork(batch, id), own, `seed ${seed}: ${id} в наборе`);
      for (const i of own) {
        if (i.kind === 'error') seen.add('controller-busy');
        if (i.kind === 'input') seen.add('follow-up');
        if (i.kind !== 'work') continue;
        const w = i.work;
        seen.add(`status:${w.status}`);
        for (const f of [
          'waitingOn',
          'openDependents',
          'recovery',
          'hold',
          'approvalStale',
          'budgetBlock',
          'preflight',
        ] as const)
          if (f in w) seen.add(f);
        if (w.input) seen.add(`input:${w.input.state}`);
        if (w.input?.refusal) seen.add('input-refusal');
        seen.add(`outlook:${i.repair.outlook}`);
        if (i.control.paused) seen.add('paused');
        // preflight — у упавшей работы, чья последняя попытка не засчитана.
        const last = board.engine
          .read((v) => v.attempts(id))
          .filter((a) => a.status !== 'active')
          .at(-1);
        assert.equal(
          w.preflight === true,
          w.status === 'failed' &&
            Boolean(last?.blocked) &&
            last?.failureKind === w.failureKind &&
            w.failureKind !== 'environment' &&
            w.failureKind !== 'provider-auth',
          `seed ${seed}: ${id} preflight`,
        );
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
    assert.deepEqual(
      stopInputsOf(board.source, { ...opts, workIds: subset }),
      batch.filter(
        (i) =>
          i.kind === 'error' ||
          (i.kind === 'work' && subset.includes(i.work.id)) ||
          (i.kind === 'input' && subset.includes(i.request.workId)),
      ),
      `seed ${seed}: подмножество`,
    );
  }
  assert.ok(compared > 1500, `сравнено ${compared}`);
  // Генератор действительно даёт разные формы.
  const missing = [
    'status:ready',
    'status:failed',
    'status:cancelled',
    'status:running',
    'waitingOn',
    'openDependents',
    'recovery',
    'hold',
    'approvalStale',
    'budgetBlock',
    'preflight',
    'input:awaiting-answer',
    'input:answered-not-applied',
    'input-refusal',
    'follow-up',
    'controller-busy',
    'outlook:stop',
    'outlook:retry',
    'outlook:wait',
    'paused',
  ].filter((form) => !seen.has(form));
  assert.deepEqual(missing, [], 'формы, которых генератор не дал');
});

test('approvalStaleness = первая причина APPROVAL_STALE из blockers: устаревшая постановка, политика после согласования, отказ хоста', () => {
  let stale = 0;
  const reasons = new Set<string>();
  const agree = (engine: Engine, label: string) =>
    engine.read((v) => {
      const of = engine.approvalStaleness(v);
      for (const w of v.works()) {
        const expected = engine.blockers(w, v).find((b) => b.code === 'APPROVAL_STALE')?.message;
        assert.equal(of(w), expected, `${label}: ${w.id}`);
        if (expected) {
          stale++;
          reasons.add(expected.replace(/\s.*/, ''));
        }
      }
    });
  for (let seed = 1; seed <= 40; seed++) {
    const board = boardOf(specOf(seed));
    agree(board.engine, `seed ${seed}`);
    // Та же доска под политикой с другой исполнительной частью: согласование
    // графа устарело для неё.
    const changed = policyOf((p) => {
      p.maxAttempts = 4;
      p.repairBudget = board.policy.repairBudget;
      p.approvalMode = board.policy.approvalMode;
    });
    agree(
      new Engine({ host: standaloneHost(board.store, changed), policy: changed }),
      `seed ${seed} policy`,
    );
    // Хост отказывает части работ причиной APPROVAL_STALE (и части — другой).
    const host = standaloneHost(board.store, board.policy);
    agree(
      new Engine({
        host: {
          ...host,
          guards: {
            ...host.guards,
            claimable: (w) =>
              w.id.endsWith('1')
                ? { code: 'APPROVAL_STALE', message: 'Хост: основание изменилось' }
                : w.id.endsWith('2')
                  ? { code: 'NOT_READY', message: 'Хост: не сейчас' }
                  : null,
          },
        },
        policy: board.policy,
      }),
      `seed ${seed} host`,
    );
  }
  assert.ok(stale > 100, `устаревших ${stale}`);
  assert.deepEqual([...reasons].sort(), ['Политика', 'Постановка', 'Хост:']);
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
 * Защита — число чтений вида: до исправления доска читала вид на каждую
 * работу и шаг зависимостей (цепочка глубиной 100 — тысячи чтений графа и
 * работы, около 8 с на виде хоста; с бюджетами — попытки и записи вызовов на
 * каждую работу). Время — только щедрая страховка от зависания.
 */
for (const budgets of [false, true])
  for (const shape of ['failed', 'cancelled', 'chain'] as const)
    test(`производительность: доска из 400 работ (${shape}${budgets ? ', бюджеты' : ''}) читает вид постоянное число раз`, () => {
      const counts = new Map<string, number>();
      const board = perfBoardOf(shape, hostLikeView(counts), budgets);
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
        assert.ok(elapsed < 10_000, `${form}: ${Math.round(elapsed)} мс`);
      }
    });
