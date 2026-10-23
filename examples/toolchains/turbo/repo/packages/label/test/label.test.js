import { test } from 'node:test';
import assert from 'node:assert/strict';
import { label } from '../src/label.js';

test('label pads one digit to three', () => {
  assert.equal(label(7), 'item-007');
});
test('label pads two digits to three', () => {
  assert.equal(label(42), 'item-042');
});
test('label keeps long numbers', () => {
  assert.equal(label(1234), 'item-1234');
});
