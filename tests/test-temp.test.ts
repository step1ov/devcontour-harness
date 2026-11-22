import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEST_TEMP_PREFIX,
  findLeftovers,
  leftoverReport,
  main,
  removeTestTemp,
} from '../scripts/test-temp.mjs';

const module = new URL('../scripts/test-temp.mjs', import.meta.url).href;
const testsDir = fileURLToPath(new URL('.', import.meta.url));

/** A child node process under its own TMPDIR: a broken guard never meets the real one. */
function child(sandbox: string, script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_KEEP_TEST_TMP: '', ...env, TMPDIR: sandbox },
  });
}

test('This test process writes into its own scope below the TMPDIR it was given', () => {
  assert.ok(basename(tmpdir()).startsWith(TEST_TEMP_PREFIX), tmpdir());
  assert.equal(process.env.TMP, tmpdir());
  assert.equal(process.env.TEMP, tmpdir());
});

test('A scope gets everything the process writes and is removed on exit, read-only trees included', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'scope-'));
  writeFileSync(join(sandbox, 'neighbour'), 'x');
  const r = child(
    sandbox,
    `import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
     import { tmpdir } from 'node:os';
     import { join } from 'node:path';
     import { scopeTestTemp } from ${JSON.stringify(module)};
     const dir = scopeTestTemp();
     if (scopeTestTemp() !== dir) throw new Error('not idempotent');
     if (tmpdir() !== dir || process.env.TMP !== dir) throw new Error('TMPDIR not scoped');
     const repo = mkdtempSync(join(tmpdir(), 'harness-repo-'));
     // Go module cache style: a read-only directory with content.
     const cache = join(repo, 'mod', 'pkg@v1');
     mkdirSync(cache, { recursive: true });
     writeFileSync(join(cache, 'go.mod'), 'module pkg\\n');
     chmodSync(cache, 0o555);
     chmodSync(join(repo, 'mod'), 0o555);
     // A link out of the scope must not be followed by the cleanup.
     symlinkSync(${JSON.stringify(join(sandbox, 'neighbour'))}, join(repo, 'out'));
     console.log(dir);`,
  );
  assert.equal(r.status, 0, r.stderr);
  const dir = r.stdout.trim();
  assert.equal(dirname(dir), sandbox);
  assert.ok(basename(dir).startsWith(TEST_TEMP_PREFIX));
  assert.equal(existsSync(dir), false, 'removed on exit');
  assert.deepEqual(readdirSync(sandbox), ['neighbour'], 'nothing else is touched');
  assert.equal(readFileSync(join(sandbox, 'neighbour'), 'utf8'), 'x');
});

test('HARNESS_KEEP_TEST_TMP=1 keeps the scope and names it', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'keep-'));
  const r = child(
    sandbox,
    `import { writeFileSync } from 'node:fs';
     import { join } from 'node:path';
     import { scopeTestTemp } from ${JSON.stringify(module)};
     const dir = scopeTestTemp();
     writeFileSync(join(dir, 'evidence'), 'x');
     console.log(dir);`,
    { HARNESS_KEEP_TEST_TMP: '1' },
  );
  assert.equal(r.status, 0, r.stderr);
  const dir = r.stdout.trim();
  assert.equal(readFileSync(join(dir, 'evidence'), 'utf8'), 'x');
  assert.ok(r.stderr.includes(dir), r.stderr);
  // The leftover report names the kept scope and the file that created it.
  const [left] = findLeftovers(sandbox);
  assert.equal(left?.path, dir);
  assert.ok(left.bytes > 0);
});

test('Removal touches only a prefixed direct child of the parent', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'guard-'));
  const quiet = () => undefined;
  const sibling = mkdtempSync(join(sandbox, 'not-a-scope-'));
  const scope = mkdtempSync(join(sandbox, TEST_TEMP_PREFIX));
  const nested = mkdtempSync(join(scope, TEST_TEMP_PREFIX));
  const link = join(sandbox, TEST_TEMP_PREFIX + 'link');
  symlinkSync(sibling, link);
  assert.equal(removeTestTemp(sandbox, quiet, dirname(sandbox)), false, 'no prefix');
  assert.equal(removeTestTemp(sibling, quiet, sandbox), false, 'a sibling without the prefix');
  assert.equal(removeTestTemp(join(scope, '..'), quiet, sandbox), false, 'a path into the parent');
  assert.equal(removeTestTemp(link, quiet, sandbox), false, 'a prefixed link to another directory');
  assert.equal(removeTestTemp(nested, quiet, sandbox), false, 'not a direct child of the parent');
  assert.equal(removeTestTemp(join(sandbox, 'missing'), quiet, sandbox), false);
  assert.equal(existsSync(sibling) && existsSync(nested), true);
  assert.equal(removeTestTemp(scope, quiet, sandbox), true);
  assert.equal(existsSync(scope), false);
  assert.equal(existsSync(sibling), true);
});

test('A scope that cannot be removed warns instead of throwing', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'stuck-'));
  const scope = mkdtempSync(join(sandbox, TEST_TEMP_PREFIX));
  const warnings: string[] = [];
  // The parent is closed: nothing inside it can be unlinked.
  writeFileSync(join(scope, 'file'), 'x');
  chmodSync(sandbox, 0o500);
  try {
    assert.equal(
      removeTestTemp(scope, (text) => warnings.push(text), sandbox),
      false,
    );
    assert.match(warnings[0] ?? '', /not removed/);
  } finally {
    chmodSync(sandbox, 0o700);
  }
  assert.equal(
    removeTestTemp(scope, (text) => warnings.push(text), sandbox),
    true,
  );
});

test('The report lists only prefixed entries of this run, with sizes, and never fails', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'report-'));
  const lines: string[] = [];
  const log = (text: string) => lines.push(text);
  const old = join(sandbox, TEST_TEMP_PREFIX + 'old');
  mkdirSync(old);
  const past = Date.now() / 1000 - 3600;
  utimesSync(old, past, past);
  mkdirSync(join(sandbox, 'other-tool-dir'));
  writeFileSync(join(sandbox, 'other-tool-dir', 'big'), Buffer.alloc(64 * 1024));

  assert.equal(main(['mark'], { dir: sandbox, ppid: 4242, log }), 0);
  const fresh = join(sandbox, TEST_TEMP_PREFIX + 'fresh');
  mkdirSync(fresh);
  writeFileSync(join(fresh, 'blob'), Buffer.alloc(32 * 1024));
  writeFileSync(
    join(fresh, '.harness-test-owner'),
    JSON.stringify({ pid: 1, file: '/x/tests/heavy.test.ts' }),
  );
  writeFileSync(join(sandbox, TEST_TEMP_PREFIX + 'smoke-file'), 'x');

  assert.equal(main(['report'], { dir: sandbox, ppid: 4242, log }), 0);
  const text = lines.join('\n');
  assert.match(text, /warning: 2 test temporary entries left in /);
  assert.match(text, /harness-test-fresh {2}\(\/x\/tests\/heavy\.test\.ts\)/);
  assert.match(text, /harness-test-smoke-file/);
  assert.ok(!text.includes('harness-test-old'), 'created before the run');
  assert.ok(!text.includes('other-tool-dir'), 'not harness-owned');
  assert.ok(!text.includes('.stamp'), 'the stamp itself is consumed');
  assert.equal(existsSync(fresh) && existsSync(old), true, 'report only, nothing removed');

  // Without a mark every prefixed entry counts.
  lines.length = 0;
  assert.equal(main(['report'], { dir: sandbox, ppid: 4242, log }), 0);
  assert.match(lines.join('\n'), /warning: 3 test temporary entries/);

  lines.length = 0;
  const empty = mkdtempSync(join(tmpdir(), 'report-empty-'));
  assert.equal(main(['report'], { dir: empty, ppid: 4242, log }), 0);
  assert.match(lines[0] ?? '', /nothing left/);
  assert.deepEqual(leftoverReport(empty, []), []);
});

test('Every test file imports the temp scope before anything else', () => {
  const files = readdirSync(testsDir, { recursive: true, encoding: 'utf8' }).filter((f) =>
    f.endsWith('.test.ts'),
  );
  assert.ok(files.length > 100, String(files.length));
  const missing = files.filter((file) => {
    const scope = relative(dirname(join(testsDir, file)), join(testsDir, 'temp-scope.ts'));
    const first = readFileSync(join(testsDir, file), 'utf8')
      .split('\n')
      .find((line) => /^import\s/.test(line));
    const expected = `import '${scope.startsWith('.') ? scope : './' + scope}';`;
    return first !== expected;
  });
  assert.deepEqual(missing, [], 'first import must be the temp scope');
});
