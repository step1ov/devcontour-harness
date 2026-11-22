import './temp-scope.ts';
/**
 * Отказ списка процессов без отчёта JUnit: настоящие выводы `node --test`
 * (TAP и spec) из песочницы macOS, где `/bin/ps` не запускается. Упавшие
 * тесты читаются по блокам: заголовок `✖ failing tests:` и итоги — не
 * провалы, два теста с одинаковым признаком — не «лишний» провал, а
 * проваленное утверждение рядом с `ps` остаётся засчитанным провалом.
 * Исходники тестов — `tests/fixtures/process-list/*.source.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { processListFailure } from '../src/verification/process-list.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/process-list/${name}`, import.meta.url), 'utf8');

for (const reporter of ['spec', 'tap'] as const) {
  test(`${reporter}: один тест на ps — отказ среды`, () => {
    const s = processListFailure(fixture(`ps.${reporter}.txt`));
    assert.equal(s?.named, true);
    assert.match(s.line, /spawnSync \/bin\/ps EPERM/);
  });

  test(`${reporter}: два теста на ps (одинаковые строки признака) — отказ среды, а не засчитанный провал`, () => {
    assert.equal(processListFailure(fixture(`ps2.${reporter}.txt`))?.named, true);
  });

  test(`${reporter}: асинхронный execFile('ps') — голый spawn EPERM без другой ошибки — отказ среды`, () => {
    const s = processListFailure(fixture(`ps-async.${reporter}.txt`));
    assert.ok(s, 'async spawn EPERM');
    assert.equal(s.named, false);
    assert.match(s.line, /spawn EPERM/);
  });

  test(`${reporter}: упавший набор (subtestsFailed) — не свой провал; его тест на ps — отказ среды`, () => {
    assert.ok(processListFailure(fixture(`ps-suite.${reporter}.txt`)));
  });

  test(`${reporter}: ps и настоящее проваленное утверждение — засчитанный провал`, () => {
    assert.equal(processListFailure(fixture(`ps-mixed.${reporter}.txt`)), undefined);
  });
}

test('голый spawn EPERM рядом с другой ошибкой теста и без имени программы — не признак', () => {
  const tap = [
    'TAP version 13',
    'not ok 1 - spawns',
    '  ---',
    "  error: 'spawn EPERM'",
    '  stack: |-',
    '    TypeError: cannot read x of undefined',
    '  ...',
    '# fail 1',
  ].join('\n');
  assert.equal(processListFailure(tap), undefined);
  // Тот же голый отказ, но текст называет программу — признак.
  assert.ok(processListFailure(tap.replace("'spawn EPERM'", "'spawn EPERM' path: '/bin/ps'")));
});

test('итог прогона называет больше упавших, чем прочитано блоков, — не доказано, засчитанный провал', () => {
  const out = fixture('ps.tap.txt').replace('# fail 1', '# fail 2');
  assert.equal(processListFailure(out), undefined);
});
