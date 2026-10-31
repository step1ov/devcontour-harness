import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createScratch, removeScratch } from '../scripts/test-scratch.mjs';

const prefix = 'hr-';

test('Run directories are unique, sit directly under the system one and are removed', () => {
  const [a, b] = [createScratch(prefix), createScratch(prefix)];
  assert.notEqual(a, b);
  assert.equal(dirname(a), tmpdir().replace(/\/$/, ''), 'keeps the system spelling of the path');
  writeFileSync(join(a, 'left-behind'), 'x');
  assert.equal(removeScratch(a, prefix), true);
  assert.equal(existsSync(a), false);
  assert.equal(existsSync(b), true, 'another run is untouched');
  assert.equal(removeScratch(b, prefix), true);
});

test('Run cleanup cannot touch the parent or anything but a run directory', () => {
  // In a child under a throwaway TMPDIR: a broken guard must never meet the real one.
  const sandbox = mkdtempSync(join(tmpdir(), 'scratch-guard-'));
  const module = new URL('../scripts/test-scratch.mjs', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import { existsSync, mkdtempSync } from 'node:fs';
       import { tmpdir } from 'node:os';
       import { join } from 'node:path';
       import { createScratch, removeScratch } from ${JSON.stringify(module)};
       const prefix = ${JSON.stringify(prefix)};
       const quiet = () => undefined;
       const sibling = mkdtempSync(join(tmpdir(), 'not-a-run-'));
       assert.equal(removeScratch(tmpdir(), prefix, quiet), false, 'the parent');
       assert.equal(removeScratch(sibling, prefix, quiet), false, 'a sibling without the prefix');
       const run = createScratch(prefix);
       assert.equal(removeScratch(join(run, '..'), prefix, quiet), false, 'a path into the parent');
       assert.equal(removeScratch(run, prefix), true);
       assert.equal(existsSync(sibling), true);
       assert.equal(existsSync(tmpdir()), true);`,
    ],
    { encoding: 'utf8', env: { ...process.env, TMPDIR: sandbox } },
  );
  rmSync(sandbox, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
});

test('A run removes its directory while TMPDIR still points into it', () => {
  const run = createScratch(prefix);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = run;
  try {
    assert.equal(removeScratch(run, prefix), true);
    assert.equal(existsSync(run), false);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
});

test('A leftover that cannot be removed warns instead of failing the run', () => {
  const run = createScratch(prefix);
  const closed = join(run, 'closed');
  mkdirSync(closed);
  writeFileSync(join(closed, 'file'), 'x');
  chmodSync(closed, 0);
  const warnings: string[] = [];
  try {
    assert.equal(
      removeScratch(run, prefix, (text: string) => warnings.push(text)),
      false,
    );
    assert.match(warnings[0]!, /not removed/);
  } finally {
    chmodSync(closed, 0o755);
    assert.equal(removeScratch(run, prefix), true);
  }
});
