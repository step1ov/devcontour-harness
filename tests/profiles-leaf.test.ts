/**
 * Q5 (WP-PROFILE): `resolveProfile(ref, { includeLeafContent: true })` даёт
 * `leafContent` — текст файла листа в том виде, в каком он прочитан (= `raw`
 * DevContour); digest, closure и остальные поля не меняются. Локальные
 * профили — `tests/fixtures/profiles-leaf/repo/profiles`: `local-node.json`
 * наследует встроенный `node-checks`, `chain.json` — локальный `base.json`.
 * Тексты отказов harness (K10) зафиксированы таблицей префиксов.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError, type ResolvedProfile } from '../src/index.ts';
import {
  builtinProfiles,
  builtinProfilesRoot,
  resolveProfile,
  type ResolveProfileOptions,
} from '../src/profiles/resolve.ts';

const repo = fileURLToPath(new URL('./fixtures/profiles-leaf/repo', import.meta.url));
const devcontourShas = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/catalog/devcontour-builtin-profiles.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, string>;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Digest для D3 (§1.4) — формула `packs.ts:151` DevContour. */
const hostDigest = (p: ResolvedProfile & { leafContent: string }) =>
  p.closure.length === 1 && !p.source ? sha256(p.leafContent) : sha256(JSON.stringify(p.closure));

/** Разрешение с опцией и без: ключ только с опцией, прочие поля те же, текст — байты файла. */
function leafOf(ref: string, file: string, options: ResolveProfileOptions = {}) {
  const plain = resolveProfile(ref, options);
  const withLeaf = resolveProfile(ref, { ...options, includeLeafContent: true });
  assert.equal('leafContent' in plain, false, `${ref}: без опции ключа нет`);
  assert.equal(
    'leafContent' in resolveProfile(ref, { ...options, includeLeafContent: false }),
    false,
    `${ref}: includeLeafContent:false — ключа нет`,
  );
  const { leafContent, ...rest } = withLeaf;
  assert.deepEqual(rest, plain, `${ref}: остальные поля те же`);
  assert.deepEqual(Object.keys(withLeaf), [...Object.keys(plain), 'leafContent'], ref);
  const bytes = readFileSync(file);
  assert.equal(leafContent, bytes.toString('utf8'), `${ref}: leafContent = текст файла`);
  assert.ok(Buffer.from(leafContent, 'utf8').equals(bytes), `${ref}: те же байты`);
  assert.equal(withLeaf.digest, hostDigest(withLeaf), `${ref}: digest = формула §1.4`);
  return withLeaf;
}

test('Q5: каждый встроенный профиль — leafContent = байты файла, digest и поля не меняются', () => {
  const ids = builtinProfiles();
  assert.equal(ids.length, 13);
  for (const id of ids) {
    const file = join(builtinProfilesRoot, id + '.json');
    const p = leafOf(id, file);
    // Один встроенный файл — digest его байтов; составной — digest замыкания.
    if (p.closure.length === 1) assert.equal(p.digest, sha256(readFileSync(file)), id);
    else assert.equal(p.digest, sha256(JSON.stringify(p.closure)), id);
    assert.equal(p.closure.at(-1)!.ref, 'builtin:' + id);
    assert.equal(p.closure.at(-1)!.digest, sha256(readFileSync(file)), id);
  }
  // Наследующие встроенные профили покрыты: closure длиннее одного слоя.
  assert.ok(ids.some((id) => resolveProfile(id).closure.length > 1));
});

test('Q5: локальный профиль, наследующий node-checks, — leafContent листа, digest замыкания', () => {
  const file = join(repo, 'profiles/local-node.json');
  const p = leafOf('./profiles/local-node.json', file, { repository: repo });
  assert.deepEqual(p.source, { repositoryId: 'main', path: 'profiles/local-node.json' });
  assert.deepEqual(
    p.closure.map((c) => c.ref),
    ['builtin:node-checks', 'local:profiles/local-node.json'],
  );
  assert.equal(p.digest, sha256(JSON.stringify(p.closure)));
  assert.ok(p.leafContent.includes('кириллица') && p.leafContent.includes('✓'));
  // Лист — не база: текст node-checks в leafContent не попадает.
  assert.notEqual(
    p.leafContent,
    readFileSync(join(builtinProfilesRoot, 'node-checks.json'), 'utf8'),
  );
});

test('Q5: локальный профиль, наследующий локальный, — leafContent листа, не базы', () => {
  const file = join(repo, 'profiles/chain.json');
  const p = leafOf('./profiles/chain.json', file, { repository: repo, repositoryId: 'product' });
  assert.deepEqual(p.source, { repositoryId: 'product', path: 'profiles/chain.json' });
  assert.deepEqual(
    p.closure.map((c) => c.ref),
    ['local:profiles/base.json', 'local:profiles/chain.json'],
  );
  assert.equal(p.digest, sha256(JSON.stringify(p.closure)));
  // Одиночный локальный файл (closure 1, но source есть) — тоже digest замыкания.
  const base = leafOf('./profiles/base.json', join(repo, 'profiles/base.json'), {
    repository: repo,
  });
  assert.equal(base.closure.length, 1);
  assert.equal(base.digest, sha256(JSON.stringify(base.closure)));
  assert.notEqual(base.digest, sha256(base.leafContent));
});

test('Q5: SHA-256 девяти встроенных профилей DevContour равны профилям harness', () => {
  assert.equal(Object.keys(devcontourShas).length, 9);
  for (const [id, sha] of Object.entries(devcontourShas)) {
    assert.equal(sha256(readFileSync(join(builtinProfilesRoot, id + '.json'))), sha, id);
    // И digest разрешения единственного файла — тот же SHA.
    const p = resolveProfile(id, { includeLeafContent: true });
    assert.equal(sha256(p.leafContent), sha, id);
  }
});

/** Каталог отказов K10: каждая строка — свой минимальный репозиторий профилей. */
function refusalRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-profiles-leaf-')));
  const root = join(dir, 'repo');
  const builtin = join(dir, 'builtin');
  mkdirSync(root);
  mkdirSync(builtin);
  const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
  const junit = { type: 'junit', path: '.reports/t.xml' };
  const testGate = { id: 'tests', kind: 'test', command: ['true'], report: junit };
  writeFileSync(join(root, 'bad.json'), '{ not json');
  json(join(root, 'schema.json'), { id: 'schema', version: 1 });
  json(join(root, 'target.json'), { id: 'target', version: '1.0.0', gates: [testGate] });
  symlinkSync(join(root, 'target.json'), join(root, 'link.json'));
  json(join(root, 'reserved.json'), {
    id: 'reserved',
    version: '1.0.0',
    gates: [testGate, { id: 'requirement-source', kind: 'check', command: ['true'] }],
  });
  // Test gate без JUnit и ни одного с JUnit: harness сначала проверяет каждый gate (K10).
  json(join(root, 'no-junit.json'), {
    id: 'no-junit',
    version: '1.0.0',
    gates: [{ id: 'tests', kind: 'test', command: ['true'] }],
  });
  json(join(root, 'checks-only.json'), {
    id: 'checks-only',
    version: '1.0.0',
    gates: [{ id: 'lint', kind: 'check', command: ['true'] }],
  });
  json(join(root, 'cycle-a.json'), { id: 'a', version: '1.0.0', extends: ['./cycle-b.json'] });
  json(join(root, 'cycle-b.json'), { id: 'b', version: '1.0.0', extends: ['./cycle-a.json'] });
  writeFileSync(join(root, 'huge.json'), ' '.repeat(128 * 1024 + 1));
  writeFileSync(join(dir, 'outside.json'), '{}');
  json(join(builtin, 'wrong.json'), { id: 'other', version: '1.0.0', gates: [testGate] });
  return { root, builtin };
}

test('Q5/K10: тексты отказов resolveProfile harness — таблица префиксов', () => {
  const { root, builtin } = refusalRepo();
  const local = { repository: root };
  const table: [string, ResolveProfileOptions, string][] = [
    ['./missing.json', local, 'Профиль не найден: missing.json'],
    ['./link.json', local, 'Профиль не допускает symlink: link.json'],
    ['./bad.json', local, 'Профиль local:bad.json: не JSON'],
    ['./schema.json', local, 'Профиль local:schema.json: version: '],
    ['wrong', { builtinRoot: builtin }, 'ID встроенного профиля не совпадает: builtin:wrong'],
    ['./reserved.json', local, 'Зарезервированный gate: requirement-source'],
    ['./no-junit.json', local, 'Test gate требует JUnit: tests'],
    ['./checks-only.json', local, 'Итоговый профиль требует test gate с JUnit'],
    ['./cycle-a.json', local, 'Цикл наследования профилей: local:cycle-a.json'],
    ['./huge.json', local, 'Профиль требует файл до 128 KiB'],
    ['../outside.json', local, 'Профиль должен находиться внутри репозитория'],
    ['./target.json', {}, 'Локальный профиль требует корень репозитория'],
    ['a/b.json', local, 'Профиль: укажите встроенный ID либо относительный ./file.json'],
  ];
  for (const [ref, options, prefix] of table) {
    for (const leaf of [false, true]) {
      let caught: unknown;
      try {
        resolveProfile(ref, { ...options, includeLeafContent: leaf });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof HarnessError, `${ref}: HarnessError`);
      assert.equal(caught.code, 'INVALID_INPUT', ref);
      assert.ok(
        caught.message.startsWith(prefix),
        `${ref}: «${caught.message}» начинается с «${prefix}»`,
      );
    }
  }
  // Отказ symlink — от ссылки, а не от содержимого: целевой файл — валидный профиль.
  assert.equal(resolveProfile('./target.json', local).id, 'target');
});
