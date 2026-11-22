import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
test('async ps', async () => { await promisify(execFile)('ps', ['-ax']); });
