import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
  git('init', '-q', '-b', 'main');
  write(dir, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
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
