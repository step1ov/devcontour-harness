import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

/**
 * Выбор затронутых тестов для `npm run test:affected`.
 *
 * Тест-файл `tests/*.test.ts` затронут, если изменённый файл входит в его
 * статическое замыкание: `import`/`export … from` от файла теста через
 * helpers и `src/**`, плюс любые другие относительные пути в тексте
 * (`import()`, `new URL('../src/cli.ts', …)`, путь в комментарии), которые
 * берутся целиком.
 *
 * Barrel-модули (`src/index.ts`, `contracts/index.ts`) уточняются по именам:
 * `import { pageItems } from '../src/index.ts'` идёт только в тот модуль,
 * который реэкспортирует `pageItems`, а не во все `export * from`. Иначе
 * почти любой файл src/ попадал бы в замыкание почти каждого теста. Цена
 * уточнения: побочный эффект загрузки соседнего модуля barrel (исключение
 * на верхнем уровне) этот ярус не увидит — его ловят `test:fast` и полный
 * suite. Имя, которое разбор не нашёл среди экспортов модуля, раскрывает
 * модуль целиком (fail safe).
 *
 * Это ярус для итерации над исправлением, а не замена полного suite: всё, что
 * замыкание не видит надёжно, переводит выбор на весь suite.
 *
 * Правила для каждого изменённого пути:
 *  - `tests/<name>.test.ts` — сам этот файл (удалённый — нечего запускать);
 *  - `src/**.ts` — все тесты, в замыкание которых он входит; файл, который не
 *    достижим ни из одного теста, или удалённый файл — весь suite;
 *  - `tests/integration/**` вне замыканий — не входит в `npm test`, только
 *    примечание (запускается `npm run test:integration`);
 *  - всё остальное (package.json, tsconfig*, eslint, scripts/, helpers и
 *    fixtures в tests/, profiles/, schemas/, templates/, docs, …) — весь suite.
 */

const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
// Относительный путь в любом месте текста, без разбора кавычек: непарная
// кавычка в комментарии не должна скрыть зависимость. Путь из комментария
// даёт лишний выбор — это безопасно.
const RELATIVE = /(?<![\w./@-])\.\.?\/[\w./@-]*/g;
// Корневой `src…` как аргумент обхода дерева (`walk('src')`,
// `readdirSync(join(root, 'src'))`) — зависимость от всего каталога.
const ROOTED =
  /\b\w*(?:walk|readdir\w*)\(\s*(?:join\([^,()]*,\s*)?['"`](src(?:\/[\w.-]+)*\/?)['"`]/gi;
// import/export … from '…': default, { … }, * as ns, * и их сочетания.
const CLAUSE = String.raw`\{[^}]*\}|\*\s+as\s+[\w$]+|\*|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?`;
const FROM = new RegExp(
  String.raw`\b(import|export)\s+(?:type\s+)?(${CLAUSE})\s*from\s*(['"])([^'"\n]+)\3`,
  'g',
);
const BARE = /\bimport\s*(['"])([^'"\n]+)\1/g;
const DECLARED =
  /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|type|interface|enum|namespace)\s+([\w$]+)/g;
const LOCAL_LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from\b)/g;
const ALL = 'all';

/** Путь репозитория в виде `a/b/c.ts` (posix) независимо от ОС. */
const rel = (root, abs) => relative(root, abs).split(sep).join(posix.sep);

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Все исходники каталога рекурсивно (абсолютные пути), без node_modules. */
const walk = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.parentPath.split(sep).includes('node_modules'))
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => SOURCE.test(f));

/**
 * Файлы, на которые указывает путь: исходник (`.js` → `.ts`, как у tsx) или
 * все исходники каталога внутри src/ (`'../src/planning/'`). Голые `./` и
 * `../` — не каталог-зависимость, а разбор чужих путей; каталоги вне src/
 * (fixtures) не раскрываются: их изменение и так ведёт к полному suite.
 */
function targetsOf(root, target, literal) {
  if (target === root || !target.startsWith(root + sep)) return [];
  if (target.split(sep).includes('node_modules')) return [];
  if (isDir(target)) {
    const named = literal === undefined || !/(?:^|\/)\.\.?\/?$/.test(literal);
    return named && target.startsWith(join(root, 'src') + sep) ? walk(target) : [];
  }
  if (!SOURCE.test(target)) return [];
  if (isFile(target)) return [target];
  const ts = target.replace(/\.([cm]?)js$/, '.$1ts');
  return ts !== target && isFile(ts) ? [ts] : [];
}

/** `a, type b, c as d` → [[источник, имя снаружи], …]. */
const pairs = (list) =>
  list
    .split(',')
    .map((x) => x.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((x) => {
      const [from, , to] = x.split(/\s+/);
      return [from, to ?? from];
    });

/**
 * Имена, которые запрашивает клауза импорта. Для `* as ns` — члены `ns.x`,
 * если `ns` встречается только так; любое другое использование (передача
 * значением, `Object.keys(ns)`) — модуль целиком.
 */
function importedNames(clause, text) {
  const ns = /\*\s+as\s+([\w$]+)/.exec(clause)?.[1];
  if (ns) {
    const names = new Set();
    const escaped = ns.replace(/\$/g, '\\$');
    for (const m of text.matchAll(
      new RegExp(String.raw`(?<![\w$.])${escaped}\b(\s*\.\s*([\w$]+))?`, 'g'),
    ))
      if (m[2]) names.add(m[2]);
      else if (!/\bas\s+$/.test(text.slice(Math.max(0, m.index - 8), m.index))) return ALL;
    return names;
  }
  const names = new Set();
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) for (const [from] of pairs(braces[1])) names.add(from);
  if (/^[\w$]+/.test(clause.trim())) names.add('default');
  return names;
}

/**
 * Разбор модуля: собственные зависимости (нужны при любом запросе),
 * реэкспорты (идут по запрошенным именам) и локально объявленные экспорты.
 */
export function parseModule(root, file) {
  const text = readFileSync(file, 'utf8');
  const dir = dirname(file);
  const imports = [];
  const reexports = [];
  const locals = new Set();
  const counted = new Map();
  const count = (f) => counted.set(f, (counted.get(f) ?? 0) + 1);
  for (const m of text.matchAll(FROM)) {
    const spec = m[4];
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
    for (const target of targetsOf(root, resolve(dir, spec))) {
      count(target);
      const clause = m[2].trim();
      if (m[1] === 'import') imports.push({ target, names: importedNames(clause, text) });
      else if (clause === '*') reexports.push({ target, star: true });
      else if (clause.startsWith('*')) reexports.push({ target, ns: clause.split(/\s+/).at(-1) });
      else reexports.push({ target, map: pairs(clause.replace(/^\{|\}$/g, '')) });
    }
  }
  for (const m of text.matchAll(BARE)) {
    if (!m[2].startsWith('./') && !m[2].startsWith('../')) continue;
    for (const target of targetsOf(root, resolve(dir, m[2]))) {
      count(target);
      imports.push({ target, names: new Set() });
    }
  }
  // Остальные относительные пути (import(), new URL, каталоги, комментарии) —
  // зависимость от модуля целиком.
  const seen = new Map();
  const loose = [...text.matchAll(RELATIVE)].map((m) => [resolve(dir, m[0]), m[0]]);
  loose.push(...[...text.matchAll(ROOTED)].map((m) => [resolve(root, m[1]), m[1]]));
  for (const [path, literal] of loose)
    for (const target of targetsOf(root, path, literal)) {
      seen.set(target, (seen.get(target) ?? 0) + 1);
      if (seen.get(target) > (counted.get(target) ?? 0)) imports.push({ target, names: ALL });
    }
  for (const m of text.matchAll(DECLARED)) locals.add(m[1]);
  if (/\bexport\s+default\b/.test(text)) locals.add('default');
  for (const m of text.matchAll(LOCAL_LIST)) for (const [, to] of pairs(m[1])) locals.add(to);
  return { imports, reexports, locals };
}

/** Замыкание каждого тест-файла: Map<'tests/x.test.ts', Set<'src/…'>>. */
export function closures(root, testFiles) {
  const parsed = new Map();
  const mod = (f) => {
    if (!parsed.has(f)) parsed.set(f, parseModule(root, f));
    return parsed.get(f);
  };
  const exportsMemo = new Map();
  const exportsOf = (f, stack = new Set()) => {
    if (exportsMemo.has(f)) return exportsMemo.get(f);
    if (stack.has(f)) return new Set();
    stack.add(f);
    const { locals, reexports } = mod(f);
    const names = new Set(locals);
    for (const r of reexports)
      if (r.map) for (const [, to] of r.map) names.add(to);
      else if (r.ns) names.add(r.ns);
      else for (const n of exportsOf(r.target, stack)) if (n !== 'default') names.add(n);
    stack.delete(f);
    exportsMemo.set(f, names);
    return names;
  };
  const result = new Map();
  for (const test of testFiles) {
    const state = new Map();
    const queue = [[test, ALL]];
    while (queue.length) {
      const [file, asked] = queue.pop();
      const m = mod(file);
      let st = state.get(file);
      if (!st) {
        st = { all: false, names: new Set() };
        state.set(file, st);
        for (const i of m.imports) queue.push([i.target, i.names]);
      }
      if (st.all) continue;
      // Имя, которого разбор не нашёл среди экспортов (опечатка в тесте,
      // проверка отсутствия экспорта или пропуск разбора), раскрывает все
      // `export *` модуля: только там оно могло бы скрываться.
      const known = exportsOf(file);
      let delta = asked;
      const unknown = delta !== ALL && [...delta].some((n) => !known.has(n));
      if (delta === ALL) st.all = true;
      else {
        delta = new Set([...delta].filter((n) => !st.names.has(n)));
        for (const n of delta) st.names.add(n);
        if (!delta.size) continue;
      }
      for (const r of m.reexports) {
        if (r.map) {
          const names = r.map.filter(([, to]) => delta === ALL || delta.has(to)).map(([f]) => f);
          if (names.length) queue.push([r.target, new Set(names)]);
        } else if (r.ns) {
          if (delta === ALL || delta.has(r.ns)) queue.push([r.target, ALL]);
        } else if (delta === ALL || unknown) queue.push([r.target, ALL]);
        else {
          const there = exportsOf(r.target);
          const hit = new Set([...delta].filter((n) => there.has(n)));
          if (hit.size) queue.push([r.target, hit]);
        }
      }
    }
    result.set(
      test.startsWith(root) ? rel(root, test) : test,
      new Set([...state.keys()].map((f) => rel(root, f))),
    );
  }
  return result;
}

/**
 * Решение по списку изменённых путей (posix, от корня).
 * @returns {{ full: boolean, reasons: string[], files: Map<string, string[]>, notes: string[] }}
 *   files — выбранный тест → изменённые файлы, из-за которых он выбран.
 */
export function selectTests(root, changed, testFiles) {
  const graph = closures(root, testFiles);
  const files = new Map();
  const reasons = [];
  const notes = [];
  const pick = (test, why) => files.set(test, [...(files.get(test) ?? []), why]);
  for (const path of [...new Set(changed)].sort()) {
    const exists = isFile(join(root, path));
    if (/^tests\/[^/]+\.test\.ts$/.test(path)) {
      if (exists) pick(path, path);
      else notes.push(`${path}: удалён — запускать нечего`);
      continue;
    }
    const users = [...graph].filter(([, deps]) => deps.has(path)).map(([t]) => t);
    if (path.startsWith('src/') && SOURCE.test(path)) {
      if (!exists) reasons.push(`${path}: удалён или переименован`);
      else if (!users.length) reasons.push(`${path}: ни один тест не достигает его статически`);
      else for (const t of users) pick(t, path);
      continue;
    }
    if (path.startsWith('tests/integration/') && !users.length) {
      notes.push(`${path}: вне npm test (npm run test:integration)`);
      continue;
    }
    reasons.push(`${path}: вне src/ и tests/*.test.ts — граница замыкания не доказана`);
  }
  return { full: reasons.length > 0, reasons, files, notes };
}

const git = (root, ...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });

/** База по умолчанию — merge-base с master (локальным или origin). */
export function defaultBase(root) {
  for (const ref of ['master', 'origin/master']) {
    try {
      return git(root, 'merge-base', 'HEAD', ref).trim();
    } catch {
      // следующий кандидат
    }
  }
  throw new Error('test:affected: нет master/origin/master; укажите --base <ref>');
}

/** Изменения относительно base: коммиты, индекс, рабочее дерево и неотслеживаемые. */
export function changedFiles(root, base) {
  const split = (out) => out.split('\0').filter(Boolean);
  return [
    ...split(git(root, 'diff', '--name-only', '--no-renames', '-z', base, '--')),
    ...split(git(root, 'ls-files', '--others', '--exclude-standard', '-z')),
  ];
}

/** Тест-файлы suite (абсолютные пути) — как у scripts/test.mjs. */
export function suiteFiles(root) {
  const dir = join(root, 'tests');
  return readdirSync(dir)
    .filter((n) => n.endsWith('.test.ts'))
    .map((n) => join(dir, n))
    .filter((f) => existsSync(f));
}
