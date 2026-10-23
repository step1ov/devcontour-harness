import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { label } from '../src/label.js';

const contract = JSON.parse(
  readFileSync(new URL('../../contract/label.json', import.meta.url), 'utf8'),
);
test('frontend label follows the shared contract', () => {
  for (const [n, expected] of contract.examples) assert.equal(label(n), expected);
});
