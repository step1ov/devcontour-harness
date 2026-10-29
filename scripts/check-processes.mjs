import { spawn } from 'node:child_process';

/** Own each step's process group so failure and cancellation stop its children too. */
export function checkProcesses() {
  const children = new Set();
  let stopping = false;
  const signalChild = (child, signal) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The owned process group has already exited.
    }
  };
  const stop = (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      signalChild(child, signal);
      // Keep this timer referenced even if npm exits first: a descendant may
      // ignore SIGTERM and keep running after its parent closes its streams.
      setTimeout(() => signalChild(child, 'SIGKILL'), 1000);
    }
  };
  const interrupt = () => {
    process.exitCode = 130;
    stop('SIGINT');
  };
  const terminate = () => {
    process.exitCode = 143;
    stop('SIGTERM');
  };
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
        detached: process.platform !== 'win32',
      });
      children.add(child);
      child.once('error', () => stop());
      child.once('close', (code) => {
        // Stop before forgetting the failed group, including descendants
        // whose stdio was redirected independently from the parent.
        if (code !== 0) stop();
        children.delete(child);
      });
      return child;
    },
    stop,
    dispose() {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    },
  };
}
