import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

// Три уровня проверки (README, «Разработка»):
//   npm test                — весь suite; npm run check добавляет --release;
//   npm run test:fast       — весь suite без медленного яруса (slowTests);
//   npm run test:affected   — файлы, чьё замыкание затрагивает изменение.
// Все режимы используют один и тот же запуск: process isolation, tsx и не
// более четырёх тест-файлов одновременно.

// Scheduling hints, not a test allowlist. Every tests/*.test.ts file is run.
// Start expensive files first to avoid a single long file at the end. Keep
// process isolation and the existing limit of four simultaneous test files.
const slowFirst = [
  'harness',
  'corpus',
  'consumers',
  'runner',
  'reuse',
  'roles',
  'cli-run',
  'repair',
  'joint',
  'review-probe',
  'property',
  'recovery',
  'dependency-store',
];

// Медленный ярус: тесты дольше ~60 с хотя бы в двух из последних полных
// прогонов. `npm test` и `npm run check` выполняют их как обычно; пропускает
// их только `npm run test:fast` (--fast). Шаблон — начало имени теста; имя,
// которое больше ни с чем не совпадает, полный прогон печатает предупреждением.
const slowTests = [
  // explain-differential.test.ts — дифференциальный оракул H1
  'H1 differential oracle: ',
  // review-lifecycle.test.ts
  'HP02: неверные переходы не обходят ревью',
  // connector-suite.test.ts (fake-relay-v1-http)
  'D02/fake-relay-v1-http: ',
  'D03/fake-relay-v1-http: ',
  'D04/fake-relay-v1-http: ',
  'D05/fake-relay-v1-http: ',
  'W05/fake-relay-v1-http: ',
  // corpus.test.ts
  'AC13/AC19: подтверждённый дефект останавливает следующего кандидата',
  // connectors.test.ts
  'T34: новая редакция в источнике',
  'T34/T02: доверие к receipt внешней предпосылки',
  // explain-engine-run.test.ts
  'H1-03: explain = run — пауза shutdown (lead)',
  // cli-explain.test.ts
  'H1-03: --work — только это поручение',
  // joint.test.ts
  'T24: два репозитория',
  // roles.test.ts
  'S2.2/T31: четыре пары writer → reviewer',
];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slowPatterns = slowTests.map((s) => new RegExp('^' + escape(s)));

const directory = new URL('../tests/', import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const rank = (name) => {
  const index = slowFirst.indexOf(name.replace(/\.test\.ts$/, ''));
  return index < 0 ? slowFirst.length : index;
};
const all = readdirSync(directory)
  .filter((name) => name.endsWith('.test.ts'))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  .map((name) => fileURLToPath(new URL(name, directory)));
if (!all.length) throw new Error('No tests/*.test.ts files found');

const usage =
  'Usage: node scripts/test.mjs [--list] [--fast] [--release] [--affected [--base <ref>]]\n' +
  'For targeted runs use node --import tsx --test <options> <files>';
const args = process.argv.slice(2);
const flags = { list: false, fast: false, release: false, affected: false, base: undefined };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--list') flags.list = true;
  else if (a === '--fast') flags.fast = true;
  else if (a === '--release') flags.release = true;
  else if (a === '--affected') flags.affected = true;
  else if (a === '--base' && args[i + 1] && !args[i + 1].startsWith('--')) flags.base = args[++i];
  else throw new Error(usage);
}
if (flags.base !== undefined && !flags.affected) throw new Error('--base requires --affected');
if (flags.release && (flags.fast || flags.affected))
  throw new Error('--release is the full suite: no --fast or --affected');

let files = all;
if (flags.affected) {
  const { changedFiles, defaultBase, selectTests } = await import('./affected.mjs');
  const base = flags.base ?? defaultBase(root);
  const changed = changedFiles(root, base);
  const choice = selectTests(root, changed, all);
  console.log(`test:affected: base ${base}, изменено файлов: ${changed.length}`);
  for (const note of choice.notes) console.log(`  примечание: ${note}`);
  if (choice.full) {
    console.log('  весь suite (fail safe):');
    for (const r of choice.reasons) console.log(`    ${r}`);
  } else {
    files = all.filter((f) => choice.files.has(relativeTest(f)));
    console.log(`  выбрано тест-файлов: ${files.length} из ${all.length}`);
    for (const f of files) {
      const why = choice.files.get(relativeTest(f));
      console.log(
        `    ${relativeTest(f)} ← ${why.slice(0, 3).join(', ')}${why.length > 3 ? ` (+${why.length - 3})` : ''}`,
      );
    }
  }
}
function relativeTest(file) {
  return 'tests/' + file.slice(fileURLToPath(directory).length);
}

if (flags.list) {
  console.log(files.join('\n'));
} else if (!files.length) {
  console.log('test:affected: нет затронутых тест-файлов');
} else {
  // Node's CLI sorts file arguments alphabetically. The public run API preserves
  // the supplied order while retaining the normal Node test runner semantics.
  const controller = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    controller.abort();
  };
  const terminate = () => {
    process.exitCode = 143;
    controller.abort();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const results = run({
    files,
    concurrency: 4,
    execArgv: ['--import', 'tsx'],
    signal: controller.signal,
    ...(flags.fast ? { testSkipPatterns: slowPatterns } : {}),
  });
  const matched = new Set();
  results.on('test:fail', () => (process.exitCode ||= 1));
  results.on('test:pass', ({ name, skip, todo }) => {
    slowPatterns.forEach((p, i) => p.test(name) && matched.add(i));
    // Pattern-filtered tests are not emitted as skipped; explicit skip/todo
    // remains an error in every tier.
    if (skip || todo) {
      console.error('Full test suite must not contain skipped or todo tests.');
      process.exitCode ||= 1;
    }
  });
  // Тесты не пишут в настоящий кэш пользователя (корни рабочих деревьев,
  // src/environment/checkout-root.ts): новый элемент в нём — провал прогона.
  const xdg = process.env.XDG_CACHE_HOME;
  const cache =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'devcontour-harness')
      : join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.cache'), 'devcontour-harness');
  const entries = () => {
    try {
      return readdirSync(cache);
    } catch {
      return [];
    }
  };
  const before = new Set(entries());
  results.once('end', () => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    const added = entries().filter((name) => !before.has(name));
    if (added.length) {
      console.error(`Tests wrote into the user cache ${cache}: ${added.join(', ')}`);
      process.exitCode ||= 1;
    }
    if (files === all && !flags.fast && !controller.signal.aborted) {
      const stale = slowTests.filter((_, i) => !matched.has(i));
      for (const s of stale)
        console.error(`scripts/test.mjs: шаблон медленного яруса ни с чем не совпал: «${s}»`);
    }
  });
  results.compose(spec).pipe(process.stdout);
}
