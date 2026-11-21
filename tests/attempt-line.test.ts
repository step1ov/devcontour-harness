/**
 * Строка сводки попыток (`attemptLine`): в пределе длины хвост — остаток
 * попыток или «повтор — только со сбросом» — сохраняется, сокращается список
 * отказов («и ещё N»), затем начало строки.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPERATOR_VIEW_TEXT as T, operatorViewSchema } from '../src/contracts/index.ts';
import { Harness } from '../src/control/harness.ts';
import { collectOperatorViewInput, viewPolicy } from '../src/control/operator-view.ts';
import { attemptSummaryLine } from '../src/report/compute.ts';
import {
  attemptLine,
  maskText,
  operatorView,
  type AttemptLineFacts,
} from '../src/projections/index.ts';
import { NOW, baseInput, work } from './operator-view-input.ts';
import { viewState } from './view-fixture.ts';

const eight = [
  'defect',
  'incomplete',
  'integration',
  'environment',
  'time-limit',
  'tool',
  'operator',
  'unclassified',
].map((key, i) => ({ key, count: i + 1 }));

const facts = (over: Partial<AttemptLineFacts> = {}): AttemptLineFacts => ({
  total: 40,
  active: 0,
  failed: 36,
  failures: eight,
  timeouts: 5,
  interrupted: 2,
  accepted: 0,
  attempts: { used: 40, max: 6 },
  neutralOut: { used: 3, max: 3 },
  repairs: { used: 1, budget: 6 },
  ...over,
});

const tails = {
  ru: 'исчерпан предел незасчитанных отказов 3 из 3: повтор — только со сбросом, восстановлений группы 5 из 6',
  en: 'the limit of uncounted failures is used up (3 of 3): retry only after a reset, group repairs left 5 of 6',
} as const;

for (const lang of ['ru', 'en'] as const) {
  test(`attemptLine ${lang}: 8 видов отказов в 200 символах — хвост целиком, список сокращён`, () => {
    const full = attemptLine(facts(), lang);
    assert.ok(full.length > T.line, `полная строка длиннее предела: ${full.length}`);
    assert.ok(full.endsWith('; ' + tails[lang]), full);
    for (const f of eight) assert.ok(full.includes(`${f.key} ${f.count}`), f.key);

    const line = attemptLine(facts(), lang, T.line);
    assert.ok(line.length <= T.line, `${line.length}: ${line}`);
    assert.ok(line.endsWith('; ' + tails[lang]), line);
    const m = line.match(lang === 'ru' ? /[(,] ?и ещё (\d+)\)/ : /[(,] ?and (\d+) more\)/);
    assert.ok(m, line);
    const shown = eight.filter((f) => line.includes(`${f.key} ${f.count}`)).length;
    // Показано наибольшее число корзин: ещё одна в предел не влезла бы.
    const next = eight[shown]!;
    assert.ok(line.length + `${next.key} ${next.count}, `.length > T.line, line);
    // Показаны первые корзины; «ещё N» — ровно скрытые.
    assert.equal(Number(m[1]), eight.length - shown);
    for (const f of eight.slice(0, shown)) assert.ok(line.includes(`${f.key} ${f.count}`));
    // Начало строки и прочие числа не тронуты.
    assert.match(
      line,
      lang === 'ru' ? /^попыток 40; отказов 36 \(/ : /^attempts 40; failures 36 \(/,
    );
    if (lang === 'ru') assert.ok(shown >= 1, line);
    assert.ok(line.includes(lang === 'ru' ? 'прервано остановкой 2' : 'interrupted by shutdown 2'));
  });

  test(`attemptLine ${lang}: тесный предел — сначала весь список, затем начало строки; хвост остаётся`, () => {
    const noList = attemptLine(facts(), lang, 150);
    assert.ok(noList.length <= 150, noList);
    assert.ok(noList.endsWith('; ' + tails[lang]), noList);
    const tight = attemptLine(facts(), lang, tails[lang].length + 20);
    assert.ok(tight.length <= tails[lang].length + 20, tight);
    assert.ok(tight.endsWith('…; ' + tails[lang]), tight);
    // Предел меньше хвоста — обрезка с конца, не длиннее предела.
    const tiny = attemptLine(facts(), lang, 30);
    assert.equal(tiny.length, 30);
    assert.ok(tiny.endsWith('…'));
  });

  test(`attemptLine ${lang}: короткая строка не меняется пределом; без исчерпания — остаток попыток`, () => {
    const short = facts({
      total: 2,
      attempts: { used: 2, max: 6 },
      failures: eight.slice(0, 2),
      neutralOut: undefined,
    });
    assert.equal(attemptLine(short, lang, T.line), attemptLine(short, lang));
    assert.ok(
      attemptLine(short, lang, T.line).endsWith(
        lang === 'ru'
          ? 'осталось попыток 4 из 6, восстановлений группы 5 из 6'
          : 'attempts left 4 of 6, group repairs left 5 of 6',
      ),
    );
  });

  test(`view ${lang}: attempts.line из чисел строки — 8 видов отказов не теряют хвост`, () => {
    const f = facts();
    const input = baseInput({
      works: [
        work('w', {
          attemptSummary: {
            ...work('w').attemptSummary,
            failed: f.failed,
            line: attemptLine(f, 'ru'),
            lineEn: attemptLine(f, 'en'),
            lineFacts: f,
          },
        }),
      ],
    });
    const view = operatorView(input, { lang });
    operatorViewSchema.parse(view);
    const line = view.works[0]!.attempts.line!;
    assert.ok(line.length <= T.line, line);
    assert.ok(line.endsWith(tails[lang]), line);
    assert.match(line, lang === 'ru' ? /и ещё \d+/ : /and \d+ more/);
  });

  test(`view ${lang}: маска удлиняет строку — хвост всё равно целиком`, () => {
    const f = facts();
    const input = baseInput({
      works: [
        work('w', {
          attemptSummary: {
            ...work('w').attemptSummary,
            line: attemptLine(f, 'ru'),
            lineEn: attemptLine(f, 'en'),
            lineFacts: f,
          },
        }),
      ],
      // «40» и «36» — известные секреты: маска заменяет числа длинной меткой,
      // и строка без учёта маски вышла бы за предел. «masked» — секрет,
      // совпадающий с меткой: вторая маска поверх готовой строки удлинила бы её.
      mask: { secrets: ['40', '36', 'masked'] },
    });
    const line = operatorView(input, { lang }).works[0]!.attempts.line!;
    assert.ok(line.length <= T.line, line);
    assert.match(line, /‹masked›/);
    // Вторая маска поверх готовой строки дала бы вложенную метку «‹‹masked››».
    assert.doesNotMatch(line, /‹‹|››/);
    assert.doesNotMatch(line, /40|36/);
    // Без маски при подборе строка на этих секретах длиннее предела.
    const unfitted = maskText(attemptLine(f, lang, T.line), 10_000, { secrets: ['40', '36'] })!;
    assert.ok(unfitted.length > T.line, `${unfitted.length}`);
    assert.ok(line.endsWith(tails[lang]), line);
  });
}

test('attemptSummaryLine: предел длины сохраняет «повтор — только со сбросом»', () => {
  const s = {
    total: 40,
    active: 0,
    failed: 36,
    failures: eight as { key: never; count: number }[],
    timeouts: 5,
    interrupted: 2,
    accepted: 0,
  };
  const budget = { attempts: { used: 2, max: 6 }, neutral: { used: 3, max: 3 } };
  const line = attemptSummaryLine(s, budget, 'ru', T.line);
  assert.ok(line.length <= T.line);
  assert.ok(line.endsWith('повтор — только со сбросом'), line);
  assert.ok(attemptSummaryLine(s, budget, 'en', T.line).endsWith('retry only after a reset'));
});

test('view loader: числа строки попыток передаются проекции и дают ту же строку, что status', () => {
  const s = viewState();
  const vp = viewPolicy(s.state, s.policyPath);
  const h = Harness.open({
    stateDir: s.state,
    policy: vp.policy,
    baseDir: vp.baseDir,
    adapters: {},
    readOnly: true,
    readOnlyState: true,
  });
  try {
    const status = h.status(undefined, { detail: true });
    const input = collectOperatorViewInput(h, vp, { now: NOW });
    let failing = 0;
    for (const w of input.works) {
      const sw = status.works.find((x) => x.id === w.id)!;
      const a = w.attemptSummary;
      assert.ok(a.lineFacts, w.id);
      assert.equal(attemptLine(a.lineFacts, 'ru'), sw.attemptSummary.line, w.id);
      assert.equal(attemptLine(a.lineFacts, 'en'), a.lineEn, w.id);
      if (a.lineFacts.failures.length) failing++;
    }
    assert.ok(failing > 0, 'в состоянии есть работа с отказами');
  } finally {
    h.close();
  }
});
