import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * A test run's own temporary directory. Fixtures leave their directories behind:
 * hundreds of thousands of them in the shared directory slow everything that
 * reads it. The prefix stays short because Unix sockets live below it, and the
 * path is kept as the system spells it: on macOS that is the /var alias of
 * /private/var, which production paths meet as well.
 */
export function createScratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Remove a run directory. Only a direct child of the system temporary directory
 * with the run prefix qualifies, whatever path is passed in. A leftover that
 * cannot be removed must not turn a passing run into a crash.
 */
export function removeScratch(path, prefix, warn = console.error) {
  if (!existsSync(path)) return false;
  const real = realpathSync(path);
  if (dirname(real) !== realpathSync(tmpdir()) || !basename(real).startsWith(prefix)) {
    warn(`Not a run directory, left in place: ${path}`);
    return false;
  }
  try {
    rmSync(real, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch (error) {
    warn(`Run directory not removed: ${path}: ${error.message}`);
    return false;
  }
}
