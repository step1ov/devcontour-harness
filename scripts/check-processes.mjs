import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const MARK = 'DEVCONTOUR_CHECK_INVOCATION';
/** Срок одного снимка ps: под нагрузкой (load 80–110, swap) ps отвечает
 * десятками секунд; срок короче обрывал снимок, а с ним и проверку. */
export const PS_TIMEOUT_MS = 30_000;
const ps = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      args,
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        timeout: PS_TIMEOUT_MS,
        maxBuffer: 64_000_000,
      },
      (error, stdout) => {
        if (!error) return resolve(stdout);
        const why = error.killed
          ? `ps timed out after ${PS_TIMEOUT_MS} ms`
          : (error.code ?? error.signal ?? error.message);
        reject(new Error(`Cannot inventory check processes (${why})`));
      },
    );
  });

async function linuxProcess(pid, mark) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === 'Z') return undefined;
    let marked = false;
    if (mark) {
      try {
        marked = (await readFile(`/proc/${pid}/environ`, 'utf8'))
          .split('\0')
          .includes(`${MARK}=${mark}`);
      } catch {
        /* Other users' environments need not be readable. */
      }
    }
    return { pid, ppid: Number(fields[1]), start: fields[19], marked };
  } catch {
    return undefined;
  }
}

export async function inventory(mark) {
  if (process.platform === 'win32') return [];
  if (process.platform === 'linux') {
    const rows = await Promise.all(
      (await readdir('/proc'))
        .filter((p) => /^\d+$/.test(p))
        .map((p) => linuxProcess(Number(p), mark)),
    );
    return rows.filter(Boolean);
  }
  const stdout = await ps([
    ...(mark ? ['-Eww'] : []),
    '-ax',
    '-o',
    'pid=,ppid=,lstart=,stat=,command=',
  ]);
  return parsePsInventory(stdout, mark);
}

/** Darwin ps lstart is second-granularity; retain invocation ownership too. */
export function parsePsInventory(stdout, mark) {
  const needle = mark ? new RegExp(`(?:^|\\s)${MARK}=${mark}(?:\\s|$)`) : undefined;
  return stdout.split('\n').flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return row && !row[4].startsWith('Z')
      ? [
          {
            pid: Number(row[1]),
            ppid: Number(row[2]),
            start: row[3],
            marked: !!needle?.test(row[5]),
          },
        ]
      : [];
  });
}

/** Historical identities discover candidates; only a fresh ownership chain permits signaling. */
export function ownedProcesses(rows, seen) {
  const owned = new Map(
    rows
      .filter((r) => r.pid !== process.pid && (r.marked || seen.get(r.pid) === r.start))
      .map((r) => [r.pid, r.start]),
  );
  for (let size = -1; size !== owned.size;) {
    size = owned.size;
    for (const row of rows)
      if (row.pid !== process.pid && owned.has(row.ppid)) owned.set(row.pid, row.start);
  }
  return owned;
}

/** Fresh marker/parent ownership and start identity precede each individual signal batch.
 * ps snapshots and kill are not atomic. A remembered PID/start alone never authorizes a signal.
 */
export function signalSameProcesses(candidates, rows, signal, kill = process.kill) {
  const current = ownedProcesses(rows, new Map());
  for (const [pid, start] of candidates)
    if (pid !== process.pid && current.get(pid) === start)
      try {
        kill(pid, signal);
      } catch {
        /* Already exited. */
      }
}

/** Повторы одного снимка: отказ ps под нагрузкой обычно преходящ. */
export const INVENTORY_RETRY = { attempts: 3, backoffMs: 1000 };

/** A snapshot retried with doubling backoff; the last error is thrown. */
export async function inventoryWithRetry(
  read,
  mark,
  {
    attempts = INVENTORY_RETRY.attempts,
    backoffMs = INVENTORY_RETRY.backoffMs,
    sleep = delay,
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read(mark);
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }
}

/** Own tagged descendants as well as children that leave their original process group.
 *
 * A stop signals the check's own running steps (their process groups) at
 * once, then sweeps leaked descendants from fresh snapshots.
 *
 * An unavailable process inventory never stops or fails the check: a failed
 * background round is skipped with a warning, and a cleanup without a
 * snapshot falls back to the check's own live children (their ChildProcess
 * tracks their exit, so this never signals a reused PID). Leaked descendants
 * are still found and stopped whenever ps answers.
 *
 * Options are for tests: `inventory(mark)` replaces the process snapshot,
 * `retry` the retry policy, `warn` the warning sink.
 */
export function checkProcesses({
  inventory: read = inventory,
  retry = {},
  warn = console.error,
} = {}) {
  const mark = randomUUID();
  const children = new Set();
  const seen = new Map();
  let stopping = false;
  let pending;
  let polling;
  /** The final sweep could not take a snapshot: leaks were not looked for. */
  let leakCheckSkipped = false;
  /** Background rounds skipped in a row because no snapshot could be taken. */
  let skipped = 0;
  /** Why the check was stopped when no step's own failure stopped it. */
  let cause;
  const snapshot = (withMark) => inventoryWithRetry(read, withMark ? mark : undefined, retry);
  const remember = (rows) => {
    const found = ownedProcesses(rows, seen);
    for (const [pid, start] of found) seen.set(pid, start);
    return found;
  };
  const sample = async (withMark = false) => remember(await snapshot(withMark));
  // A child whose spawn failed has no pid yet still no exit code: signalling
  // it (child.kill included) would reach pid 0, the caller's process group.
  const hasPid = (child) => Number.isInteger(child.pid) && child.pid > 0;
  const live = () =>
    [...children].filter(
      (child) => hasPid(child) && child.exitCode === null && child.signalCode === null,
    );
  const signalChildren = (signal) => {
    for (const child of live())
      try {
        // A live leader keeps its process group id from being reused.
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* Already exited. */
        }
      }
  };
  /** Without a snapshot: SIGKILL the check's own children still alive 5 s after `since`. */
  const finishChildren = async (since) => {
    while (live().length && Date.now() - since < 5000) await delay(100);
    if (live().length) signalChildren('SIGKILL');
  };
  const sweep = async (initialSignal) => {
    // Grace clocks start at each process's first signal, never before a
    // slow snapshot: pid -> [start, first signal time].
    const signalled = new Map();
    let signalledAt;
    // The check's own running steps are signalled at once: a fail-fast stop
    // or Ctrl-C does not wait for ps.
    if (live().length) {
      signalledAt = Date.now();
      for (const child of live()) signalled.set(child.pid, [undefined, signalledAt]);
      signalChildren(initialSignal);
    }
    for (;;) {
      const sampledAt = Date.now();
      let candidates;
      let current;
      try {
        candidates = await sample(true);
        if (!candidates.size) return;
        // Do not signal an old PID/group after a grace timer: re-read identities.
        // Keep the invocation marker in this fresh snapshot. Coarse lstart plus
        // a historical PID can describe an unrelated replacement process.
        current = await snapshot(true);
      } catch (error) {
        leakCheckSkipped = true;
        warn(
          `warning: ${error.message}; leaked-process cleanup skipped, stopping only the check's own running steps`,
        );
        if (signalledAt === undefined && live().length) {
          signalChildren(initialSignal);
          signalledAt = Date.now();
        }
        return finishChildren(signalledAt ?? Date.now());
      }
      const first = new Map();
      const again = new Map();
      for (const [pid, start] of candidates) {
        const known = signalled.get(pid);
        // A child signalled through its group is recorded before its start is known.
        if (known && known[0] === undefined) known[0] = start;
        if (!known || known[0] !== start) first.set(pid, start);
        // Only a snapshot begun past a process's grace that still shows it proves a survivor.
        else if (sampledAt - known[1] >= 5000)
          throw new Error('Check descendants survived bounded cleanup');
        else again.set(pid, start);
      }
      const now = Date.now();
      signalSameProcesses(first, current, initialSignal);
      for (const [pid, start] of first) signalled.set(pid, [start, now]);
      const late = new Map([...again].filter(([pid]) => now - signalled.get(pid)[1] >= 1000));
      signalSameProcesses(late, current, 'SIGKILL');
      await delay(100);
    }
  };
  // `reason` names the cause of a stop that is not a step's own exit (a
  // spawn failure); only the first stop's reason is kept.
  const stop = (signal = 'SIGTERM', reason) => {
    if (pending) return pending;
    stopping = true;
    cause = reason;
    clearTimeout(poll);
    pending = sweep(signal).catch((error) => {
      process.exitCode ||= 1;
      cause ??= error.message;
      console.error(error.message);
      for (const child of children) {
        if (hasPid(child)) child.kill('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    });
    return pending;
  };
  const interrupt = () => {
    process.exitCode = 130;
    void stop('SIGINT');
  };
  const terminate = () => {
    process.exitCode = 143;
    void stop('SIGTERM');
  };
  /** Background rounds 250 ms apart; after a slow round, max(its duration, 1 s). */
  const POLL_MS = 250;
  let poll;
  const schedule = (gap) => {
    if (stopping) return;
    poll = setTimeout(round, gap);
    poll.unref();
  };
  const round = () => {
    if (stopping) return;
    const started = Date.now();
    polling = sample()
      .then(
        () => {
          if (skipped)
            warn(`check processes: inventory available again after ${skipped} skipped round(s)`);
          skipped = 0;
        },
        (error) => {
          // An unavailable snapshot is not a failure of the check: skip the round.
          if (!skipped++)
            warn(`warning: ${error.message}; skipping this inventory round, steps keep running`);
        },
      )
      .finally(() => {
        polling = undefined;
        const took = Date.now() - started;
        schedule(took > POLL_MS ? Math.max(took, 1000) : POLL_MS);
      });
  };
  schedule(POLL_MS);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  return {
    get stopping() {
      return stopping;
    },
    /** The reason of a stop no step's own exit caused, or of a failed cleanup. */
    get cause() {
      return cause;
    },
    /** True when the cleanup ran without a snapshot (ps unavailable). */
    get leakCheckSkipped() {
      return leakCheckSkipped;
    },
    /** Background inventory rounds skipped in a row (0 while ps answers). */
    get skippedRounds() {
      return skipped;
    },
    spawn(command, args, options = {}) {
      if (stopping) return undefined;
      const child = spawn(command, args, {
        ...options,
        env: { ...(options.env ?? process.env), [MARK]: mark },
        detached: process.platform !== 'win32',
      });
      children.add(child);
      child.once('spawn', () => {
        // An early record only helps; the marker finds the child later anyway.
        // A round in flight already reads the process table.
        if (polling) return;
        void sample(true).catch((error) => {
          warn(`warning: ${error.message}; the new step keeps running`);
        });
      });
      child.once('error', (error) => {
        void stop('SIGTERM', `Cannot start ${command}: ${error.message}`);
      });
      // A detached descendant can keep stdio open, so do not wait for close.
      child.once('exit', (code) => {
        if (code !== 0) void stop();
      });
      child.once('close', () => children.delete(child));
      return child;
    },
    stop,
    async dispose() {
      await stop();
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    },
  };
}
