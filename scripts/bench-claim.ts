/**
 * Микрозамер выдачи при длинной истории: `claim` на доске, где выдавать
 * нечего (поручения удержаны), при росте числа прежних попыток с записями
 * вызовов. Печатает время одного `claim` с бюджетами и без них (разница —
 * цена учёта бюджетов) и сколько попыток и записей вызовов он прочёл.
 * Запуск: `node --import tsx scripts/bench-claim.ts [--legacy]`; `--legacy` —
 * записи вызовов без поручения (оно — по попытке).
 */
import { historyBoard } from '../tests/claim-cost-fixture.ts';

const legacy = process.argv.includes('--legacy');
const rounds = 20;
const measure = (history: number, budgets: boolean) => {
  const b = historyBoard(history, { legacy, ...(budgets ? {} : { budgets: null }) });
  b.engine.claim('c1');
  b.reset();
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) b.engine.claim('c1');
  const ms = (performance.now() - t0) / rounds;
  const counters = { ...b.counters };
  b.store.close();
  return { ms, counters };
};
for (const history of [0, 250, 1000, 4000]) {
  const base = measure(history, false);
  const { ms, counters } = measure(history, true);
  console.log(
    `history=${history}${legacy ? ' legacy' : ''}: claim ${ms.toFixed(2)} ms ` +
      `(без бюджетов ${base.ms.toFixed(2)} ms); на claim прочитано попыток ` +
      `${counters.attempts / rounds}, записей вызовов ${counters.usage / rounds}`,
  );
}
