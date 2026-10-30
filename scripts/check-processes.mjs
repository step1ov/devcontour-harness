import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const MARK = 'DEVCONTOUR_CHECK_INVOCATION';
const ps = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      args,
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        timeout: 2000,
        maxBuffer: 64_000_000,
      },
      (error, stdout) =>
        error ? reject(new Error('Cannot inventory check processes')) : resolve(stdout),
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

async function inventory(mark) {
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

/** Own tagged descendants as well as children that leave their original process group. */
export function checkProcesses() {
  const mark = randomUUID();
  const children = new Set();
  const seen = new Map();
  let stopping = false;
  let pending;
  let polling;
  const remember = (rows) => {
    const found = ownedProcesses(rows, seen);
    for (const [pid, start] of found) seen.set(pid, start);
    return found;
  };
  const sample = async (withMark = false) => remember(await inventory(withMark ? mark : undefined));
  const sweep = async (initialSignal) => {
    const started = Date.now();
    for (;;) {
      const candidates = await sample(true);
      if (!candidates.size) return;
      // Do not signal an old PID/group after a grace timer: re-read identities.
      // Keep the invocation marker in this fresh snapshot. Coarse lstart plus
      // a historical PID can describe an unrelated replacement process.
      const current = await inventory(mark);
      signalSameProcesses(
        candidates,
        current,
        Date.now() - started < 1000 ? initialSignal : 'SIGKILL',
      );
      if (Date.now() - started >= 5000)
        throw new Error('Check descendants survived bounded cleanup');
      await delay(100);
    }
  };
  const stop = (signal = 'SIGTERM') => {
    if (pending) return pending;
    stopping = true;
    clearInterval(poll);
    // ChildProcess tracks its own exit; unlike kill(-oldPid), this does not
    // reuse a remembered process group after the leader has exited.
    if (process.platform === 'win32') for (const child of children) child.kill(signal);
    pending = sweep(signal).catch((error) => {
      process.exitCode ||= 1;
      console.error(error.message);
      for (const child of children) {
        child.kill('SIGKILL');
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
  const poll = setInterval(() => {
    if (polling || stopping) return;
    polling = sample()
      .catch((error) => {
        process.exitCode ||= 1;
        console.error(error.message);
        return stop();
      })
      .finally(() => {
        polling = undefined;
      });
  }, 250);
  poll.unref();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  return {
    get stopping() {
      return stopping;
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
        void sample(true).catch((error) => {
          process.exitCode ||= 1;
          console.error(error.message);
          return stop();
        });
      });
      child.once('error', () => {
        void stop();
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
