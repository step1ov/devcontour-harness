import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Immutable, process-local initial repositories. Copy files (including .git),
// never hardlink or share an object database: hooks, refs and worktrees in one
// test must not affect another. Different initial contents get different seeds.
const seeds = new Map<string, string>();
// This helper can be dynamically imported inside a test. A test-scoped after
// hook would delete the process cache before the next test uses it.
process.once('exit', () => {
  for (const seed of seeds.values()) rmSync(seed, { recursive: true, force: true });
});

/** Настоящий временный Git-репозиторий с первым коммитом. */
export function repo(files: Record<string, string> = { 'README.md': 'app\n' }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-repo-')));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  const key = JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  const cached = seeds.get(key);
  if (cached) {
    cpSync(cached, dir, { recursive: true });
  } else {
    git('init', '-q', '-b', 'main');
    write(dir, files);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const seed = realpathSync(mkdtempSync(join(tmpdir(), 'harness-git-seed-')));
    cpSync(dir, seed, { recursive: true });
    seeds.set(key, seed);
  }
  return { dir, git, head: () => git('rev-parse', 'HEAD') };
}

export function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** Команда gate: node-скрипт, исполняемый в cwd проверки. */
export const nodeGate = (script: string) => [process.execPath, '-e', script];

/** Скрипт, пишущий JUnit в DEVCONTOUR_REPORT_PATH. */
export const junit = (cases: string) =>
  `require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite>${cases}</testsuite>')`;
