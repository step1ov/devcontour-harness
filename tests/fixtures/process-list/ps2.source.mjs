import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
test('lists processes', () => { execFileSync('/bin/ps', ['-ax']); });
test('lists again', () => { execFileSync('/bin/ps', ['-o', 'pid']); });
