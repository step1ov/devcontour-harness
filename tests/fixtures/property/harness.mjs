// FIXTURE: генеративная проверка для gate harness: эталон, генератор и уменьшение
// входа задаёт проект; harness только прогоняет их и пишет отчёт.
//
// Использование (скопируйте файл в проект, он без зависимостей):
//
//   import { properties } from './harness.mjs';
//   await properties([{
//     testId: 'knapsack-optimal',          // стабильный id: testcase JUnit и критерий
//     cases: 300,                          // не меньше 1: ноль входов ничего не доказывает
//     generate: (rng) => input,            // rng() → [0, 1)
//     families: [                          // необязательно: семейства входов
//       { id: 'boundary', cases: 50, generate: (rng) => input },
//     ],
//     valid: (input) => boolean,           // вход в объявленной области (для корпуса)
//     oracle: (input) => expected,         // заведомо верный ответ на малом входе
//     subject: (input) => actual,          // проверяемая реализация
//     shrink: (input) => [smaller, ...],   // кандидаты меньше, по убыванию пользы
//     equal: (a, b) => boolean,            // по умолчанию — сравнение JSON
//     reduceMs: 2000,                      // предел уменьшения
//   }]);
//
// Seed задаёт контур (DEVCONTOUR_SEED): повтор с тем же seed даёт тот же вход.
// Отчёт пишется в DEVCONTOUR_PROPERTY_REPORT до каждого случая: если проверка
// зависнет и гейт её остановит, в отчёте останется вход, на котором она шла.
// Найденный контрпример записывается сразу, до уменьшения; уменьшение
// ограничено по времени и при таймауте сохраняет исходный вход.
//
// Контур дополнительно передаёт:
// - DEVCONTOUR_PROPERTIES — свойства области задачи через запятую; остальные
//   не запускаются (общий файл проверок, разные задачи);
// - DEVCONTOUR_CORPUS — закреплённый корпус подтверждённых случаев: каждый
//   прогоняется на проверяемой реализации и сверяется с записанным ожиданием;
// - DEVCONTOUR_CASE и DEVCONTOUR_CASE_RESULT — режим одного случая: эталон и
//   реализация на одном входе, без генератора. Так контур подтверждает пример
//   ревьюера закреплённым эталоном.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const write = (path, value) => {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
};
const xml = (text) =>
  String(text).replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
  );
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const jsonEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function evaluate(p, input) {
  let actual;
  try {
    actual = p.subject(structuredClone(input));
  } catch (error) {
    actual = { error: String(error?.message ?? error) };
  }
  return actual;
}

/** Режим одного случая: ответ эталона и реализации на одном входе. */
function single(list, path, out) {
  const request = JSON.parse(readFileSync(path, 'utf8'));
  const p = list.find((x) => x.testId === request.property);
  const result = { property: request.property };
  if (!p) result.error = 'unknown property';
  else if (p.valid && !p.valid(structuredClone(request.input))) result.valid = false;
  else {
    result.valid = true;
    try {
      result.expected = p.oracle(structuredClone(request.input));
    } catch (error) {
      result.oracleError = String(error?.message ?? error);
    }
    result.actual = evaluate(p, request.input);
    if (!('oracleError' in result))
      result.equal = (p.equal ?? jsonEqual)(result.actual, result.expected);
  }
  write(out, result);
  console.log(JSON.stringify(result));
  return result;
}

export async function properties(list) {
  if (process.env.DEVCONTOUR_CASE)
    return single(list, process.env.DEVCONTOUR_CASE, process.env.DEVCONTOUR_CASE_RESULT);
  const seed = Number(process.env.DEVCONTOUR_SEED ?? Math.floor(Math.random() * 2 ** 32));
  const reportPath = process.env.DEVCONTOUR_PROPERTY_REPORT;
  const junitPath = process.env.DEVCONTOUR_REPORT_PATH;
  const selected = process.env.DEVCONTOUR_PROPERTIES
    ? process.env.DEVCONTOUR_PROPERTIES.split(',').filter(Boolean)
    : undefined;
  const report = { version: 1, seed, properties: [] };
  const save = () => write(reportPath, report);
  const chosen = selected
    ? selected.map((id) => list.find((p) => p.testId === id) ?? { testId: id, unknown: true })
    : list;
  for (const p of chosen) {
    const entry = { testId: p.testId, status: 'running', cases: 0 };
    report.properties.push(entry);
    if (p.unknown) {
      entry.status = 'failed';
      entry.error = 'свойство не определено в проверке';
      save();
      continue;
    }
    // Ноль входов ничего не доказывает: такая проверка — отказ, а не PASS.
    const plan = [
      ...(p.cases > 0 ? [{ id: undefined, cases: p.cases, generate: p.generate }] : []),
      ...(p.families ?? []).filter((f) => f.cases > 0),
    ];
    if (!plan.length || plan.some((f) => typeof f.generate !== 'function')) {
      entry.status = 'failed';
      entry.error = 'выборка пуста: задайте cases не меньше 1 и генератор';
      save();
      continue;
    }
    if (p.families?.length) entry.families = {};
    const equal = p.equal ?? jsonEqual;
    const fails = (input) => {
      const actual = evaluate(p, input);
      const expected = p.oracle(structuredClone(input));
      return equal(actual, expected) ? undefined : { expected, actual };
    };
    let failed = false;
    for (const family of plan) {
      const rng = mulberry32(seed ^ hash(p.testId + (family.id ? ':' + family.id : '')));
      for (let i = 0; i < family.cases && !failed; i++) {
        const input = family.generate(rng);
        entry.current = input;
        save();
        const failure = fails(input);
        entry.cases++;
        if (family.id) entry.families[family.id] = (entry.families[family.id] ?? 0) + 1;
        if (!failure) continue;
        failed = true;
        delete entry.current;
        entry.status = 'failed';
        entry.counterexample = { original: input, ...failure };
        save();
        // Уменьшение: жадно берём первого меньшего кандидата, который всё ещё
        // нарушает свойство. Предел времени сохраняет исходный контрпример.
        const deadline = Date.now() + (p.reduceMs ?? 2000);
        let current = input;
        let progress = true;
        while (progress && p.shrink) {
          progress = false;
          for (const candidate of p.shrink(current)) {
            if (Date.now() > deadline) {
              entry.counterexample.reductionTimedOut = true;
              progress = false;
              break;
            }
            const f = fails(candidate);
            if (f) {
              current = candidate;
              progress = true;
              entry.counterexample = { original: input, reduced: current, ...f };
              save();
              break;
            }
          }
        }
      }
      if (failed) break;
    }
    if (entry.status === 'running') {
      entry.status = 'passed';
      delete entry.current;
    }
    save();
  }
  // Корпус подтверждённых случаев: каждый — регрессия на одном входе.
  // Свидетельство выполнения — hash отсортированных `id:pass|fail`: контур
  // сверяет его с закреплённым манифестом и видит пропущенный случай.
  if (process.env.DEVCONTOUR_CORPUS) {
    const bytes = readFileSync(process.env.DEVCONTOUR_CORPUS);
    const corpus = JSON.parse(bytes.toString('utf8'));
    const lines = [];
    const failedCases = [];
    for (const c of corpus.cases) {
      if (selected && !selected.includes(c.property)) continue;
      const p = list.find((x) => x.testId === c.property);
      const entry = report.properties.find((x) => x.testId === c.property);
      const actual = p ? evaluate(p, c.input) : { error: 'свойство не определено в проверке' };
      const ok = !!p && (p.equal ?? jsonEqual)(actual, c.expected);
      lines.push(`${c.id}:${ok ? 'pass' : 'fail'}`);
      if (ok) continue;
      if (failedCases.length < 20)
        failedCases.push({ id: c.id, property: c.property, expected: c.expected, actual });
      if (entry && entry.status === 'passed') {
        entry.status = 'failed';
        entry.counterexample = { original: c.input, expected: c.expected, actual, case: c.id };
      }
    }
    report.corpus = {
      digest: sha256(bytes),
      executed: lines.length,
      passed: lines.filter((l) => l.endsWith(':pass')).length,
      witness: sha256(lines.sort().join('\n')),
      failed: failedCases,
    };
    save();
  }
  const failed = report.properties.filter((p) => p.status !== 'passed');
  write(
    junitPath,
    `<testsuite name="properties" tests="${report.properties.length}" failures="${failed.length}">` +
      report.properties
        .map(
          (p) =>
            `<testcase name="${xml(p.testId)}">` +
            (p.status === 'passed'
              ? ''
              : `<failure message="${xml(p.error ?? JSON.stringify(p.counterexample?.reduced ?? p.counterexample?.original))}"/>`) +
            '</testcase>',
        )
        .join('') +
      '</testsuite>',
  );
  console.log(
    `seed ${seed}: ${report.properties.length - failed.length}/${report.properties.length} properties hold`,
  );
  for (const p of failed)
    console.log(`${p.testId}: ${p.error ?? JSON.stringify(p.counterexample)}`);
  if (failed.length || !report.properties.length) process.exitCode = 1;
  return report;
}

function hash(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
