/**
 * 0.1.0-alpha.70: справочник причин отказов. Каждый класс отказа и каждая
 * причина окружения описаны (что значит, кто действует, типичные
 * исправления); документ совпадает с данными; explain ссылается на него.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  environmentCauseCatalog,
  environmentCauses,
  failureCausesMarkdown,
  failureKindCatalog,
  failureKinds,
  failureRefOf,
} from '../src/contracts/index.ts';

test('справочник покрывает каждый класс отказа и каждую причину окружения', () => {
  assert.deepEqual(Object.keys(failureKindCatalog).sort(), [...failureKinds].sort());
  assert.deepEqual(Object.keys(environmentCauseCatalog).sort(), [...environmentCauses].sort());
  for (const e of [
    ...Object.values(failureKindCatalog),
    ...Object.values(environmentCauseCatalog),
  ]) {
    assert.ok(e.meaning.length > 10);
    assert.ok(e.fixes.length > 0);
  }
});

test('docs/failure-causes.md совпадает с данными справочника; ссылки — на его якоря', () => {
  const doc = readFileSync(new URL('../docs/failure-causes.md', import.meta.url), 'utf8');
  assert.equal(doc, failureCausesMarkdown().trimEnd() + '\n', 'документ генерируется из данных');
  assert.equal(failureRefOf('gate'), 'docs/failure-causes.md#kind-gate');
  assert.equal(
    failureRefOf('needs-lead', 'writer-split'),
    'docs/failure-causes.md#cause-writer-split',
  );
  assert.equal(failureRefOf('review', 'none'), 'docs/failure-causes.md#kind-review');
  assert.equal(failureRefOf(undefined), undefined);
  for (const kind of failureKinds) assert.ok(doc.includes(`<a id="kind-${kind}"></a>`), kind);
  for (const cause of environmentCauses)
    assert.ok(doc.includes(`<a id="cause-${cause}"></a>`), cause);
});
