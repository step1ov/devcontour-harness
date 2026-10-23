/* eslint-disable @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment --
 * Тест читает JSON-ответ CLI и состояние как есть.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteExecutionStore } from '../../src/storage/sqlite.ts';
import {
  approve,
  requireTools,
  saveEvidence,
  implementation,
  materialize,
  writerStep,
} from '../fixtures/toolchains/setup.ts';

/**
 * T04: подготовка воспроизводима в новой попытке. Каждая попытка — свой
 * worktree, и prepare (npm ci / uv sync --locked) исполняется в нём заново:
 * изменённые первой попыткой node_modules, .venv и выходы во вторую не
 * протекают. Locked install с несовместимым lockfile — диагностируемый
 * отказ шага до writer, lockfile не переписан.
 */
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const readState = (state: string) => {
  const store = new SqliteExecutionStore(join(state, 'state.sqlite'), 't04', { readOnly: true });
  try {
    return store.read((v) => ({ work: v.work('pad-labels')!, attempts: v.attempts('pad-labels') }));
  } finally {
    store.close();
  }
};

for (const [variant, tampered, fresh] of [
  [
    'npm',
    ['node_modules/picocolors/picocolors.js', '.reports/junit.xml'],
    'node_modules/picocolors/package.json',
  ],
  ['python', ['.venv/TAMPERED', '.venv/pyvenv.cfg', '.reports/junit.xml'], '.venv/pyvenv.cfg'],
] as const)
  test(
    `T04/${variant}: изменённые среда и выходы первой попытки не видны второй (разные worktree)`,
    { timeout: 600_000 },
    () => {
      requireTools(variant === 'npm' ? ['npm'] : ['uv']);
      const stale = '<testsuite><testcase classname="stale" name="green"/></testsuite>';
      const tamper = Object.fromEntries(
        tampered.map((p) => [p, p.endsWith('.xml') ? stale : 'TAMPERED by attempt 1\n']),
      );
      const f = materialize(variant, {
        scenario: {
          writer: [
            writerStep({ ...implementation(variant, 'bad'), ...tamper }),
            writerStep(implementation(variant, 'good'), { observe: [...tampered, fresh] }),
          ],
          reviewer: approve,
        },
      });
      try {
        const first = f.run();
        assert.equal(first.status, 3, first.stderr);
        assert.equal(readState(f.state).work.status, 'failed');
        const retry = f.harness('retry', '--state', f.state, '--work', 'pad-labels');
        assert.equal(retry.status, 0, retry.stderr);
        const second = f.run();
        assert.equal(second.status, 0, second.stderr);
        const { work, attempts } = readState(f.state);
        assert.equal(work.status, 'done');
        assert.equal(attempts.length, 2);
        assert.notEqual(attempts[0]!.worktree, attempts[1]!.worktree, 'разные worktree');
        const observed = JSON.parse(readFileSync(`${f.scenario}.writer.1.observed`, 'utf8'));
        for (const path of tampered)
          assert.notEqual(observed[path], tamper[path], `${path} протёк из первой попытки`);
        assert.equal(observed['.reports/junit.xml'], null, 'выход первой попытки не виден');
        assert.ok(observed[fresh], `${fresh}: среда второй попытки установлена заново`);
        if (variant === 'python') assert.equal(observed['.venv/TAMPERED'], null);
        assert.equal(f.git('rev-parse', f.targetRef), work.resultSha);
        saveEvidence('T04', `${variant}-two-attempts`, {
          baseSha: f.base,
          attempts: attempts.map((a) => ({
            runId: a.id,
            status: a.status,
            worktree: a.worktree,
            candidateSha: a.candidateSha,
          })),
          tamperedByAttempt1: tamper,
          observedByAttempt2BeforeWriting: observed,
          resultSha: work.resultSha,
          targetAfter: f.git('rev-parse', f.targetRef),
          prepareLogs: attempts.map((a) => {
            const file = join(f.state, 'artifacts', a.id, 'candidate', 'prepare', 'install.log');
            return { runId: a.id, sha256: existsSync(file) ? sha(readFileSync(file)) : null };
          }),
        });
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    },
  );

const incompatible: [string, string[], (repo: string) => void, string, RegExp][] = [
  [
    'npm',
    ['npm'],
    (repo) => {
      const p = join(repo, 'package.json');
      writeFileSync(
        p,
        readFileSync(p, 'utf8').replace('"picocolors": "1.1.1"', '"picocolors": "1.1.0"'),
      );
    },
    'package-lock.json',
    /in sync|does not satisfy|Missing: picocolors|Invalid: lock file/i,
  ],
  [
    'pnpm',
    ['pnpm'],
    (repo) => {
      const p = join(repo, 'packages/label/package.json');
      writeFileSync(
        p,
        readFileSync(p, 'utf8').replace('"picocolors": "1.1.1"', '"picocolors": "1.1.0"'),
      );
    },
    'pnpm-lock.yaml',
    /ERR_PNPM_OUTDATED_LOCKFILE|not up to date/i,
  ],
  [
    'python',
    ['uv'],
    (repo) => {
      const p = join(repo, 'pyproject.toml');
      writeFileSync(p, readFileSync(p, 'utf8').replace('pytest==8.4.1', 'pytest==8.4.0'));
    },
    'uv.lock',
    /needs to be updated|--locked/i,
  ],
];
for (const [variant, tools, edit, lock, diagnostic] of incompatible)
  test(
    `T04/${variant}: locked install с несовместимым lockfile — отказ шага с диагностикой, lockfile не переписан`,
    { timeout: 600_000 },
    () => {
      requireTools(tools);
      const f = materialize(variant, {
        edit,
        scenario: { writer: writerStep(implementation(variant, 'good')), reviewer: approve },
      });
      try {
        const lockBefore = sha(readFileSync(join(f.repo, lock)));
        const run = f.run();
        assert.equal(run.status, 3, run.stderr);
        const { work, attempts } = readState(f.state);
        assert.equal(work.status, 'failed');
        assert.match(work.failure ?? '', /Шаг install/);
        assert.equal(f.count('claude.writer'), 0, 'writer не вызывался: отказ до реализации');
        assert.equal(f.git('rev-parse', f.targetRef), f.base, 'target ref не сдвинут');
        assert.equal(sha(readFileSync(join(f.repo, lock))), lockBefore, 'lockfile checkout цел');
        assert.equal(f.git('status', '--porcelain'), '');
        const log = join(
          f.state,
          'artifacts',
          attempts[0]!.id,
          'candidate',
          'prepare',
          'install.log',
        );
        assert.ok(existsSync(log));
        assert.match(readFileSync(log, 'utf8'), diagnostic, 'лог шага называет причину');
        saveEvidence('T04', `${variant}-incompatible-lockfile`, {
          lockfile: lock,
          sha256Before: lockBefore,
          sha256After: sha(readFileSync(join(f.repo, lock))),
          gitDiffLockfile: f.git('diff', f.base, f.git('rev-parse', f.targetRef), '--', lock),
          workStatus: work.status,
          failure: work.failure,
          writerCalls: f.count('claude.writer'),
          targetMoved: f.git('rev-parse', f.targetRef) !== f.base,
          installLogTail: readFileSync(log, 'utf8').trim().split('\n').slice(-6),
        });
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    },
  );
