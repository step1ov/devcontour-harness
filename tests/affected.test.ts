import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedFiles,
  closures,
  defaultBase,
  selectTests,
  suiteFiles,
} from '../scripts/affected.mjs';

/**
 * Выбор `npm run test:affected` на временном дереве: замыкание через barrel
 * по именам, пути вне import, обход каталога, fail safe для всего, что
 * замыкание не доказывает, и список изменений из Git (коммиты, индекс,
 * рабочее дерево, неотслеживаемые).
 */

const tree: Record<string, string> = {
  'package.json': '{"type":"module"}\n',
  'src/index.ts': [
    "export * from './a.ts';",
    "export { b, type B } from './b.ts';",
    "export * as nsC from './c.ts';",
    "export { HARNESS } from './version.ts';",
  ].join('\n'),
  'src/a.ts': "import { shared } from './shared.ts';\nexport const a = shared + 1;\n",
  'src/b.ts': 'export const b = 2;\nexport type B = number;\n',
  'src/c.ts': 'export const c = 3;\n',
  'src/version.ts': 'export const HARNESS = "x";\n',
  'src/shared.ts': 'export const shared = 0;\n',
  'src/cli.ts': "import { b } from './b.js';\nconsole.log(b);\n",
  'src/lazy.ts': "export const lazy = () => import('./late.ts');\n",
  'src/late.ts': 'export const late = 1;\n',
  'src/sub/one.ts': 'export const one = 1;\n',
  'src/orphan.ts': 'export const orphan = 1;\n',
  'tests/helper.ts': "export { a } from '../src/index.ts';\n",
  // Только b: a.ts, c.ts и shared.ts через barrel не тянутся.
  'tests/b.test.ts': "import { b } from '../src/index.ts';\nvoid b;\n",
  // Через helper: a → a.ts → shared.ts.
  'tests/a.test.ts': "import { a } from './helper.ts';\nvoid a;\n",
  // Namespace только через члены — по именам.
  'tests/ns.test.ts': "import * as root from '../src/index.ts';\nvoid root.HARNESS;\n",
  // Namespace значением — модуль целиком.
  'tests/whole.test.ts': "import * as root from '../src/index.ts';\nObject.keys(root);\n",
  // Путь вне import (subprocess CLI) и динамический import.
  'tests/cli.test.ts': [
    "const cli = new URL('../src/cli.ts', import.meta.url);",
    "import { lazy } from '../src/lazy.ts';",
    'void cli; void lazy;',
  ].join('\n'),
  // Обход каталога src/sub целиком.
  'tests/walk.test.ts': [
    "import { readdirSync } from 'node:fs';",
    'const walk = (d: string) => readdirSync(d);',
    "walk('src/sub');",
  ].join('\n'),
  // Отсутствующий экспорт — раскрываются все export * barrel.
  'tests/missing.test.ts': "import * as root from '../src/index.ts';\nvoid root.notThere;\n",
  'tests/integration/live.test.ts': "import { c } from '../../src/c.ts';\nvoid c;\n",
  'tests/fixtures/data.json': '{}\n',
};

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-affected-')));
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const tests = Object.keys(tree)
    .filter((p) => /^tests\/[^/]+\.test\.ts$/.test(p))
    .map((p) => join(root, p));
  return { root, tests };
}

function cleanup(root: string) {
  // Удаляем только собственный каталог mkdtemp внутри системного tmp.
  assert.ok(root.startsWith(realpathSync(tmpdir()) + sep) && /harness-affected-/.test(root), root);
  rmSync(root, { recursive: true, force: true });
}

const picked = (root: string, tests: string[], changed: string[]) => {
  const s = selectTests(root, changed, tests);
  return { ...s, picked: [...s.files.keys()].sort() };
};

test('affected: barrel уточняется по именам; helper, namespace, URL, import() и обход каталога входят в замыкание', () => {
  const { root, tests } = fixture();
  try {
    const g = closures(root, tests);
    const has = (t: string, f: string) => g.get(t)!.has(f);
    assert.ok(has('tests/b.test.ts', 'src/b.ts'));
    assert.ok(!has('tests/b.test.ts', 'src/a.ts'), 'export * не тянется без имени');
    assert.ok(!has('tests/b.test.ts', 'src/c.ts'), 'export * as не тянется без имени');
    assert.ok(has('tests/a.test.ts', 'tests/helper.ts'));
    assert.ok(has('tests/a.test.ts', 'src/shared.ts'), 'собственные импорты модуля — всегда');
    assert.ok(!has('tests/a.test.ts', 'src/b.ts'));
    assert.ok(has('tests/ns.test.ts', 'src/version.ts'));
    assert.ok(!has('tests/ns.test.ts', 'src/a.ts'));
    for (const f of ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/shared.ts'])
      assert.ok(has('tests/whole.test.ts', f), 'namespace значением: ' + f);
    assert.ok(has('tests/cli.test.ts', 'src/cli.ts'), 'путь new URL');
    assert.ok(has('tests/cli.test.ts', 'src/b.ts'), '.js → .ts из cli.ts');
    assert.ok(has('tests/cli.test.ts', 'src/late.ts'), 'import()');
    assert.ok(has('tests/walk.test.ts', 'src/sub/one.ts'), 'обход каталога');
    assert.ok(has('tests/missing.test.ts', 'src/a.ts'), 'неизвестное имя раскрывает export *');
    assert.ok(!has('tests/missing.test.ts', 'src/b.ts'), 'именованные реэкспорты — по имени');
  } finally {
    cleanup(root);
  }
});

test('affected: выбор по изменённым файлам и fail safe для всего, что замыкание не доказывает', () => {
  const { root, tests } = fixture();
  try {
    let s = picked(root, tests, ['src/shared.ts']);
    assert.equal(s.full, false);
    assert.deepEqual(s.picked, ['tests/a.test.ts', 'tests/missing.test.ts', 'tests/whole.test.ts']);
    assert.deepEqual(s.files.get('tests/a.test.ts'), ['src/shared.ts']);

    s = picked(root, tests, ['src/b.ts', 'tests/walk.test.ts']);
    assert.equal(s.full, false);
    assert.deepEqual(s.picked, [
      'tests/b.test.ts',
      'tests/cli.test.ts',
      'tests/walk.test.ts',
      'tests/whole.test.ts',
    ]);

    s = picked(root, tests, ['tests/integration/live.test.ts', 'tests/gone.test.ts']);
    assert.equal(s.full, false);
    assert.deepEqual(s.picked, []);
    assert.equal(s.notes.length, 2, s.notes.join('\n'));

    for (const path of [
      'package.json',
      'tsconfig.json',
      'scripts/test.mjs',
      'tests/helper.ts',
      'tests/fixtures/data.json',
      'docs/x.md',
      'src/orphan.ts',
      'src/removed.ts',
    ]) {
      s = picked(root, tests, ['src/b.ts', path]);
      assert.equal(s.full, true, path);
      assert.ok(
        s.reasons.some((r) => r.startsWith(path + ':')),
        path + ': ' + s.reasons.join(' | '),
      );
    }
  } finally {
    cleanup(root);
  }
});

test('affected: изменения из Git — коммиты от merge-base, индекс, рабочее дерево и неотслеживаемые', () => {
  const { root } = fixture();
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: root,
        encoding: 'utf8',
      });
    git('init', '-q', '-b', 'master');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('switch', '-qc', 'feature');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 5;\n');
    git('commit', '-qam', 'change a');
    writeFileSync(join(root, 'src/b.ts'), 'export const b = 6;\n');
    git('add', 'src/b.ts');
    writeFileSync(join(root, 'src/c.ts'), 'export const c = 7;\n');
    writeFileSync(join(root, 'src/new.ts'), 'export const n = 1;\n');
    git('mv', 'src/late.ts', 'src/later.ts');
    const base = defaultBase(root);
    assert.equal(base, git('rev-parse', 'master').trim());
    assert.deepEqual(changedFiles(root, base).sort(), [
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/late.ts',
      'src/later.ts',
      'src/new.ts',
    ]);
  } finally {
    cleanup(root);
  }
});

test('affected: root-src walk and readdir observe sources absent from the barrel', () => {
  const { root, tests } = fixture();
  try {
    for (const [name, source] of [
      ['root-walk', "walk('src');"],
      ['root-readdir', "readdirSync(join(root, 'src'));"],
    ] as const) {
      const file = join(root, 'tests', name + '.test.ts');
      writeFileSync(file, source);
      tests.push(file);
    }
    const selected = selectTests(root, ['src/orphan.ts'], tests);
    assert.equal(selected.full, false);
    assert.deepEqual([...selected.files.keys()].sort(), [
      'tests/root-readdir.test.ts',
      'tests/root-walk.test.ts',
    ]);
    const actual = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
    const real = selectTests(actual, ['src/integrations/relay-v2/protocol.ts'], suiteFiles(actual));
    assert.equal(real.full, false);
    assert.ok(
      real.files.has('tests/boundaries.test.ts'),
      'whole-source boundary check observes the changed source',
    );
  } finally {
    cleanup(root);
  }
});
