import { describe, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
describe('processes', () => {
  test('async ps', async () => { await promisify(execFile)('ps', ['-ax']); });
  test('passes', () => {});
});
