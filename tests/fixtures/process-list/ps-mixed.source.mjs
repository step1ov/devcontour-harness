import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
test('lists processes', () => { execFileSync('/bin/ps', ['-ax']); });
test('adds numbers', () => { assert.equal(1 + 2, 4); });
