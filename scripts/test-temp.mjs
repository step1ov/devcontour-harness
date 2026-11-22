import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Temporary directories of a test process. Every test file imports
 * `tests/temp-scope.ts` first: it creates one `harness-test-XXXXXX` directory
 * under the TMPDIR it was given, points TMPDIR (and TMP, TEMP) of the process
 * at it, so fixtures, the code under test and every child process write there,
 * and removes it when the process exits. Without it each file left its
 * repositories, states, stores and packed archives behind: gigabytes per full
 * run, and more when files are run one by one outside `scripts/test.mjs`.
 *
 * `HARNESS_KEEP_TEST_TMP=1` keeps the directory for debugging; its path is
 * printed to stderr. A process killed by a signal cannot remove anything:
 * `node scripts/test-temp.mjs report` names such leftovers by the prefix.
 */
export const TEST_TEMP_PREFIX = 'harness-test-';
/** Marker inside a scope: who created it, for the leftover report. */
const OWNER = '.harness-test-owner';
const scoped = Symbol.for('devcontour-harness.test-temp-scope');

export const keepTestTemp = (env = process.env) => env.HARNESS_KEEP_TEST_TMP === '1';

/**
 * Scope this process's temporary files. Idempotent: the second call returns
 * the first directory. `parent` is the TMPDIR the process was given.
 */
export function scopeTestTemp({ parent = tmpdir(), env = process.env, warn = console.error } = {}) {
  if (globalThis[scoped]) return globalThis[scoped];
  // The path keeps the parent's spelling (on macOS the /var alias), as fixtures
  // and production paths do; the prefix stays short because unix sockets of
  // sandbox-runtime live below TMPDIR.
  const dir = mkdtempSync(join(parent, TEST_TEMP_PREFIX));
  try {
    writeFileSync(
      join(dir, OWNER),
      JSON.stringify({ pid: process.pid, file: process.argv[1] ?? '', started: Date.now() }) + '\n',
    );
  } catch {
    // The marker only labels a leftover; a scope without it still works.
  }
  env.TMPDIR = dir;
  env.TMP = dir;
  env.TEMP = dir;
  globalThis[scoped] = dir;
  process.once('exit', () => {
    if (keepTestTemp(env)) warn(`HARNESS_KEEP_TEST_TMP=1: test temporary files kept in ${dir}`);
    else removeTestTemp(dir, warn, parent);
  });
  return dir;
}

/**
 * Remove a scope. Only a direct child of `parent` with the test prefix
 * qualifies, whatever path is passed in. Read-only directories inside (Go
 * module cache, a test that closed a directory) are opened for the owner
 * first; symbolic links are never followed. A leftover that cannot be removed
 * warns instead of failing a passing run.
 */
export function removeTestTemp(path, warn = console.error, parent = dirname(path)) {
  if (!existsSync(path)) return false;
  let real;
  try {
    real = realpathSync(path);
    if (dirname(real) !== realpathSync(parent) || !basename(real).startsWith(TEST_TEMP_PREFIX)) {
      warn(`Not a test temporary directory, left in place: ${path}`);
      return false;
    }
  } catch (error) {
    warn(`Test temporary directory not removed: ${path}: ${error.message}`);
    return false;
  }
  try {
    rmSync(real, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch {
    // Retried below once directories are writable again.
  }
  try {
    openForOwner(real);
    rmSync(real, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch (error) {
    warn(`Test temporary directory not removed: ${path}: ${error.message}`);
    return false;
  }
}

/** chmod u+rwx on every real directory of the tree; links are not followed. */
function openForOwner(dir) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  if ((stat.mode & 0o700) !== 0o700) {
    try {
      chmodSync(dir, stat.mode | 0o700);
    } catch {
      // Not ours to open: rm reports it.
    }
  }
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) openForOwner(join(dir, name));
}

/** Size of a tree in bytes (allocated blocks where known); links are not followed. */
export function treeBytes(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  let total = stat.blocks !== undefined ? stat.blocks * 512 : stat.size;
  if (!stat.isDirectory()) return total;
  let names = [];
  try {
    names = readdirSync(path);
  } catch {
    return total;
  }
  for (const name of names) total += treeBytes(join(path, name));
  return total;
}

/**
 * Leftover test temporary entries directly in `dir`: name with the test
 * prefix, modified at or after `since` (ms) when given. Newest first.
 */
export function findLeftovers(dir, { since } = {}) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!name.startsWith(TEST_TEMP_PREFIX)) continue;
    const path = join(dir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    // The earlier of birth and modification time: birth time is not kept by
    // every file system, and a leftover of an earlier run that a late child
    // touched again is not this run's.
    const created = Math.min(stat.birthtimeMs > 0 ? stat.birthtimeMs : Infinity, stat.mtimeMs);
    if (since !== undefined && created < since) continue;
    let file = '';
    try {
      file = JSON.parse(readFileSync(join(path, OWNER), 'utf8')).file ?? '';
    } catch {
      // No marker: a smoke scratch, a stamp or a scope that lost it.
    }
    found.push({ name, path, bytes: treeBytes(path), created, file });
  }
  return found.sort((a, b) => b.created - a.created);
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}

/** Report lines for leftovers; empty when nothing is left. */
export function leftoverReport(dir, leftovers, limit = 20) {
  if (!leftovers.length) return [];
  const total = leftovers.reduce((sum, l) => sum + l.bytes, 0);
  const lines = [
    `warning: ${leftovers.length} test temporary entr${leftovers.length === 1 ? 'y' : 'ies'} left in ${dir}, ${formatBytes(total)}:`,
  ];
  for (const l of [...leftovers].sort((a, b) => b.bytes - a.bytes).slice(0, limit))
    lines.push(
      `  ${formatBytes(l.bytes).padStart(9)}  ${l.name}${l.file ? '  (' + l.file + ')' : ''}`,
    );
  if (leftovers.length > limit) lines.push(`  … and ${leftovers.length - limit} more`);
  return lines;
}

/** Stamp of one `npm run check`: both steps share the parent shell of npm. */
const stampPath = (dir, ppid) => join(dir, `${TEST_TEMP_PREFIX}run-${ppid}.stamp`);

/**
 * `mark` records the start of a run, `report` warns about leftovers created
 * since then (all prefixed entries without a mark) and never fails: the exit
 * code stays 0.
 */
export function main(args, { dir = tmpdir(), ppid = process.ppid, log = console.log } = {}) {
  const [command] = args;
  const stamp = stampPath(dir, ppid);
  if (command === 'mark') {
    writeFileSync(stamp, String(Date.now()) + '\n');
    return 0;
  }
  if (command !== 'report') {
    log('Usage: node scripts/test-temp.mjs mark|report');
    return 2;
  }
  let since;
  try {
    since = Number(readFileSync(stamp, 'utf8').trim());
    rmSync(stamp, { force: true });
  } catch {
    since = undefined;
  }
  const leftovers = findLeftovers(dir, Number.isFinite(since) ? { since } : {});
  const lines = leftoverReport(dir, leftovers);
  if (lines.length) {
    for (const line of lines) log(line);
    log(
      'They are not removed automatically; a test file killed by a signal, a child process writing after the exit or HARNESS_KEEP_TEST_TMP=1 leaves them.',
    );
  } else {
    log(`test temporary files: nothing left in ${dir}`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]))
  process.exitCode = main(process.argv.slice(2));
