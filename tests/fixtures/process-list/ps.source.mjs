import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
test('lists processes', () => { execFileSync('/bin/ps', ['-ax']); });
