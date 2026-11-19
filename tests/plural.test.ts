/**
 * Русские формы при числе (`ruForm`, `ruCount`) и строки harness, где число
 * стоит перед словом: бюджет («у 1 попытки вызовы не записаны»). Пакет
 * передачи, сверка принятого и прочие строки — в своих тестах (handoff,
 * accepted-target). Ожидания записаны словами, а не той же функцией.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RU, ruCount, ruForm, type RuForms } from '../src/contracts/plural.ts';
import { budgetStatus } from '../src/engine/budget.ts';

const attempt: RuForms = ['попытка', 'попытки', 'попыток'];

test('ruForm: 1/2/5/11/21/22/25 и соседние числа', () => {
  const cases: [number, string][] = [
    [0, 'попыток'],
    [1, 'попытка'],
    [2, 'попытки'],
    [4, 'попытки'],
    [5, 'попыток'],
    [11, 'попыток'],
    [12, 'попыток'],
    [14, 'попыток'],
    [21, 'попытка'],
    [22, 'попытки'],
    [25, 'попыток'],
    [101, 'попытка'],
    [111, 'попыток'],
    [112, 'попыток'],
    [122, 'попытки'],
  ];
  for (const [n, form] of cases) assert.equal(ruForm(n, attempt), form, String(n));
  assert.equal(ruForm(-21, attempt), 'попытка', 'знак не влияет');
  assert.equal(ruForm(1.5, attempt), 'попытки', 'дробное — форма «2–4»');
});

test('ruCount: родительный падеж после «у» и «из»', () => {
  assert.equal(ruCount(1, RU.attemptGen), '1 попытки');
  assert.equal(ruCount(2, RU.attemptGen), '2 попыток');
  assert.equal(ruCount(5, RU.attemptGen), '5 попыток');
  assert.equal(ruCount(11, RU.attemptGen), '11 попыток');
  assert.equal(ruCount(21, RU.attemptGen), '21 попытки');
  assert.equal(ruCount(22, RU.callGen), '22 вызовов');
  assert.equal(ruCount(21, RU.callGen), '21 вызова');
  assert.equal(ruCount(1, RU.time), '1 раз');
  assert.equal(ruCount(3, RU.time), '3 раза');
  assert.equal(ruCount(25, RU.time), '25 раз');
  assert.equal(ruCount(2, RU.round), '2 раунда');
  assert.equal(ruCount(21, RU.file), '21 файл');
});

test('бюджет: «у 1 попытки», «у 21 попытки», «у 5 попыток» — без «у 1 попыток»', () => {
  // Минимальный вид: одна попытка без записей вызовов и с кандидатом.
  const view = (n: number) => {
    const attempts = Array.from({ length: n }, (_, k) => ({
      id: `r${k}`,
      workId: 'a',
      callsRecorded: false,
      candidateSha: 'c'.repeat(40),
    }));
    return {
      attempts: () => attempts,
      locals: () => [],
      work: () => ({ id: 'a', graphId: 'g' }),
      works: () => [{ id: 'a', graphId: 'g' }],
    };
  };
  const reason = (n: number) => {
    const s = budgetStatus(
      {
        policy: { budgets: { work: { usd: 5 } }, runTimeoutMs: 60_000 },
        scopes: { members: () => ['a'] },
      } as never,
      view(n) as never,
      { kind: 'work', id: 'a' },
      [],
      Date.parse('2026-11-19T00:00:00Z'),
    );
    return s?.reason ?? '';
  };
  assert.match(reason(1), /у 1 попытки вызовы не записаны/);
  assert.match(reason(2), /у 2 попыток вызовы не записаны/);
  assert.match(reason(5), /у 5 попыток вызовы не записаны/);
  assert.match(reason(21), /у 21 попытки вызовы не записаны/);
  assert.doesNotMatch(reason(1), /у 1 попыток/);
});
