import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceRecord, GatePolicy } from '../src/contracts/index.ts';
import { redactor } from '../src/environment/redaction.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { runGate } from '../src/verification/gates.ts';
import { junit, nodeGate, repo, write } from './git-fixture.ts';

const policy = { isolation: { mode: 'none' as const, domains: [] } };

async function gate(
  dir: string,
  sha: string,
  g: Partial<GatePolicy> & { command: string[] },
  secret?: string,
) {
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  const full = {
    id: 'unit',
    kind: 'test',
    timeoutMs: 20000,
    report: { type: 'junit', path: 'test-results/junit.xml' },
    ...g,
  } as GatePolicy;
  let failure: TaskFailure | undefined;
  try {
    await runGate({
      policy,
      record: (e) => {
        recorded.push(e);
        return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
      },
      cwd: dir,
      sha,
      phase: 'candidate',
      gate: full,
      artifactDir: mkdtempSync(join(tmpdir(), 'harness-art-')),
      signal: new AbortController().signal,
      execution: {
        env: { ...process.env, SECRET: secret ?? '' },
        redact: redactor(secret ? [secret] : []),
      },
      boundary: { hidden: [], readable: [] },
    });
  } catch (error) {
    if (!(error instanceof TaskFailure)) throw error;
    failure = error;
  }
  assert.equal(recorded.length, 1, 'evidence записывается при любом исходе');
  return { evidence: recorded[0]!, failure };
}

test('T06: test gate принимается только по свежему непустому JUnit без отказов', async () => {
  const r = repo();
  const sha = r.head();
  const ok = await gate(r.dir, sha, {
    command: nodeGate(junit('<testcase classname="g" name="greets"/>')),
  });
  assert.equal(ok.failure, undefined);
  assert.equal(ok.evidence.passed, true);
  assert.deepEqual(ok.evidence.tests, [{ id: 'g.greets', status: 'passed' }]);

  const variants: [string, string[], RegExp][] = [
    ['exit != 0', nodeGate(`${junit('<testcase name="a"/>')};process.exit(3)`), /Код выхода 3/],
    [
      'нет отчёта, слово PASS в stdout',
      nodeGate(`console.log('PASS: all tests passed')`),
      /ENOENT|no such file/,
    ],
    ['пустой отчёт', nodeGate(junit('')), /не содержит выполненных testcases/],
    [
      'повреждённый XML',
      nodeGate(
        `require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase')`,
      ),
      /Некорректный JUnit/,
    ],
    [
      'failure',
      nodeGate(junit('<testcase name="a"><failure message="boom"/></testcase>')),
      /1 failures.*a: boom/,
    ],
    [
      'error',
      nodeGate(junit('<testcase name="a"><error message="crash"/></testcase>')),
      /1 failures/,
    ],
    ['skipped', nodeGate(junit('<testcase name="a"><skipped/></testcase>')), /1 skipped/],
  ];
  for (const [name, command, reason] of variants) {
    const { evidence, failure } = await gate(r.dir, sha, { command });
    assert.ok(failure, name);
    assert.equal(failure.kind, 'gate', name);
    assert.equal(evidence.passed, false, name);
    assert.match(evidence.summary, reason, name);
  }
  // Старый отчёт предыдущего прогона не засчитывается: путь очищается до запуска.
  write(r.dir, { 'test-results/junit.xml': '<testsuite><testcase name="old"/></testsuite>' });
  const stale = await gate(r.dir, sha, { command: nodeGate('0') });
  assert.equal(stale.evidence.passed, false, 'старый отчёт не подтверждает');
});

test('T07: gate, изменивший HEAD или отслеживаемый файл, не проходит', async () => {
  const r = repo({ 'src/a.js': 'a\n' });
  const sha = r.head();
  const tracked = await gate(r.dir, sha, {
    command: nodeGate(
      `require('fs').writeFileSync('src/a.js','changed');${junit('<testcase name="a"/>')}`,
    ),
  });
  assert.match(tracked.evidence.summary, /изменил отслеживаемые файлы/);
  r.git('checkout', '--', 'src/a.js');
  const head = await gate(r.dir, sha, {
    command: nodeGate(
      `const c=require('child_process');c.execFileSync('git',['-c','user.name=x','-c','user.email=x@x','commit','-q','--allow-empty','-m','x']);${junit('<testcase name="a"/>')}`,
    ),
  });
  assert.match(head.evidence.summary, /изменил HEAD/);
  assert.equal(head.evidence.passed, false);
});

test('Секрет окружения маскируется в выводе, сводке и логе gate', async () => {
  const r = repo();
  const secret = 'sk-test-0123456789abcdef';
  const { evidence } = await gate(
    r.dir,
    r.head(),
    { command: nodeGate(`console.error('token=' + process.env.SECRET); process.exit(1)`) },
    secret,
  );
  assert.ok(!evidence.summary.includes(secret));
  assert.match(evidence.summary, /\[REDACTED\]/);
  const log = (await import('node:fs')).readFileSync(evidence.log, 'utf8');
  assert.ok(!log.includes(secret), 'лог на диске замаскирован');
  writeFileSync(join(r.dir, 'unused'), '');
});

test('Отчёт за пределами worktree и cwd вне worktree отклоняются до записи', async () => {
  const r = repo();
  await assert.rejects(
    () =>
      gate(r.dir, r.head(), {
        command: nodeGate('0'),
        report: { type: 'junit', path: '../outside.xml' },
      }),
    /Report выходит из worktree/,
  );
});
