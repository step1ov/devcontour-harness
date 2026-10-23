/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-return --
 * Политика фикстуры — сырой JSON примера; форму проверяет executionPolicySchema.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceRecord, GatePolicy } from '../../src/contracts/index.ts';
import { executionPolicySchema, workGraphSchema } from '../../src/contracts/index.ts';
import { cliAdapter } from '../../src/agents/cli-adapter.ts';
import { Harness } from '../../src/control/harness.ts';
import { SqliteExecutionStore } from '../../src/storage/sqlite.ts';
import { TaskFailure } from '../../src/engine/failure.ts';
import { redactor } from '../../src/environment/redaction.ts';
import { inspectPolicy } from '../../src/toolchains/index.ts';
import { junitSummary, runGate } from '../../src/verification/gates.ts';
import { requirementProof } from '../../src/verification/proof.ts';
import {
  PATH,
  approve,
  implementation,
  materialize,
  requireTools,
  root,
  saveEvidence,
  writerStep,
} from '../fixtures/toolchains/setup.ts';

const readState = (state: string) => {
  const store = new SqliteExecutionStore(join(state, 'state.sqlite'), 't03', { readOnly: true });
  try {
    return store.read((v) => ({ work: v.work('pad-labels')!, attempts: v.attempts('pad-labels') }));
  } finally {
    store.close();
  }
};
const brief = (r: { evidence: EvidenceRecord; sha: string; log: string }) => ({
  runId: r.evidence.runId,
  phase: r.evidence.phase,
  sha: r.sha,
  passed: r.evidence.passed,
  exitCode: r.evidence.exitCode,
  summary: r.evidence.summary,
  tests: r.evidence.tests,
  header: r.log.split('\n')[0],
});

/**
 * T03: старый отчёт и cache не дают ложный PASS. Настоящие gotestsum, pytest
 * и turbo; gate исполняется тем же `runGate`, что и в попытке. Каждое
 * evidence привязано к запуску (runId), фазе и SHA.
 */
let runs = 0;
async function gate(cwd: string, g: Partial<GatePolicy> & { command: string[] }) {
  const recorded: EvidenceRecord[] = [];
  const full = {
    id: 'acceptance',
    kind: 'test',
    timeoutMs: 240000,
    report: { type: 'junit', path: '.reports/junit.xml' },
    ...g,
  } as GatePolicy;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const runId = `t03-run-${++runs}`;
  let failure: TaskFailure | undefined;
  try {
    await runGate({
      policy: { isolation: { mode: 'none', domains: [] } },
      record: (e) => {
        const full = { ...e, id: 'e' + runs, runId, createdAt: new Date().toISOString() };
        recorded.push(full);
        return full;
      },
      cwd,
      sha,
      phase: 'integration',
      gate: full,
      artifactDir: mkdtempSync(join(tmpdir(), 'harness-t03-art-')),
      signal: new AbortController().signal,
      execution: {
        env: {
          PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          CI: '1',
          TURBO_TELEMETRY_DISABLED: '1',
          TURBO_NO_UPDATE_NOTIFIER: '1',
        },
        redact: redactor([]),
      },
      boundary: { hidden: [], readable: [] },
    });
  } catch (error) {
    if (!(error instanceof TaskFailure)) throw error;
    failure = error;
  }
  assert.equal(recorded.length, 1);
  const evidence = recorded[0]!;
  assert.equal(evidence.runId, runId);
  assert.equal(evidence.sha, sha, 'evidence на проверенном SHA');
  assert.equal(evidence.phase, 'integration');
  return { evidence, failure, log: readFileSync(evidence.log, 'utf8'), sha };
}
const stale = (cases: string[]) =>
  `<testsuite>${cases.map((c) => `<testcase classname="${c.split('.').slice(0, -1).join('.')}" name="${c.split('.').at(-1)}"/>`).join('')}</testsuite>`;
const commit = (
  f: ReturnType<typeof materialize>,
  files: Record<string, string>,
  message: string,
) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(f.repo, p, '..'), { recursive: true });
    writeFileSync(join(f.repo, p), text);
  }
  f.git('add', '-A');
  f.git('commit', '-qm', message);
};
const scenario = { writer: writerStep({}), reviewer: approve };

test(
  'T03/go: старый зелёный JUnit, exit 0 без отчёта, пустой и только skipped — не PASS; обязательный testcase должен выполниться',
  { timeout: 600_000 },
  async () => {
    requireTools(['go', 'gotestsum']);
    const f = materialize('go', { scenario });
    try {
      const acceptance = [
        'gotestsum',
        '--junitfile',
        '.reports/junit.xml',
        '--',
        '-count=1',
        './...',
      ];
      const allCases = [
        'example.com/fxlabel/label.TestLabelPadsOneDigit',
        'example.com/fxlabel/label.TestLabelPadsTwoDigits',
        'example.com/fxlabel/label.TestLabelKeepsLong',
        'example.com/fxlabel/label.TestFormatVersion',
      ];
      // 1. Текущие тесты падают (реализация до поручения), а на месте отчёта — старый зелёный.
      mkdirSync(join(f.repo, '.reports'), { recursive: true });
      writeFileSync(join(f.repo, '.reports/junit.xml'), stale(allCases));
      const red = await gate(f.repo, { command: acceptance });
      assert.ok(red.failure);
      assert.equal(red.evidence.passed, false);
      assert.match(red.evidence.summary, /TestLabelPadsOneDigit/);
      assert.deepEqual(
        red.evidence.tests
          ?.filter((t) => t.status === 'failed')
          .map((t) => t.id)
          .sort(),
        [allCases[0]!, allCases[1]!].sort(),
        'разобраны настоящие случаи текущего прогона, не старый отчёт',
      );

      // 2. Команда завершилась успешно, но отчёта не создала: старый файл удалён до запуска.
      writeFileSync(join(f.repo, '.reports/junit.xml'), stale(allCases));
      const noReport = await gate(f.repo, { command: ['go', 'vet', './...'] });
      assert.equal(noReport.evidence.exitCode, 0);
      assert.equal(noReport.evidence.passed, false);
      assert.match(noReport.evidence.summary, /ENOENT|no such file/);
      assert.ok(!existsSync(join(f.repo, '.reports/junit.xml')), 'старый отчёт убран до запуска');

      // 3. Пустой отчёт: ни один testcase не выполнился.
      const empty = await gate(f.repo, {
        command: [
          'gotestsum',
          '--junitfile',
          '.reports/junit.xml',
          '--',
          '-count=1',
          '-run',
          '^NoSuchTest$',
          './...',
        ],
      });
      assert.equal(empty.evidence.exitCode, 0);
      assert.equal(empty.evidence.passed, false);
      assert.match(empty.evidence.summary, /не содержит выполненных testcases/);

      // 4. Только пропущенные cases.
      writeFileSync(
        join(f.repo, 'label/skip_test.go'),
        'package label\n\nimport "testing"\n\nfunc TestSkippedOnly(t *testing.T) { t.Skip("not today") }\n',
      );
      const skipped = await gate(f.repo, {
        command: [
          'gotestsum',
          '--junitfile',
          '.reports/junit.xml',
          '--',
          '-count=1',
          '-run',
          '^TestSkippedOnly$',
          './...',
        ],
      });
      assert.equal(skipped.evidence.passed, false);
      assert.match(skipped.evidence.summary, /1 skipped/);
      rmSync(join(f.repo, 'label/skip_test.go'));

      // 5. Исправление: свежий отчёт проходит; обязательный testcase должен реально выполниться.
      commit(f, implementation('go', 'good'), 'fix');
      const narrow = await gate(f.repo, {
        command: [
          'gotestsum',
          '--junitfile',
          '.reports/junit.xml',
          '--',
          '-count=1',
          '-run',
          '^TestLabelPadsOneDigit$',
          './...',
        ],
      });
      assert.equal(narrow.evidence.passed, true, narrow.log);
      const required = { id: 'REQ-LABEL-LONG', gate: 'acceptance', testId: allCases[2]! };
      const unproven = requirementProof(required, [narrow.evidence], narrow.sha);
      assert.equal(unproven.level, 'none');
      assert.match(unproven.reason, /не выполнялся/);
      const full = await gate(f.repo, { command: acceptance });
      assert.equal(full.evidence.passed, true, full.log);
      assert.equal(full.evidence.tests?.length, 4);
      assert.equal(requirementProof(required, [full.evidence], full.sha).level, 'testcase');
      assert.equal(
        requirementProof(required, [full.evidence], red.sha).level,
        'none',
        'evidence другого SHA не подтверждает принятый',
      );
      assert.match(full.log, /^# harness gate acceptance: cwd=\. argv=\["gotestsum"/);
      saveEvidence('T03', 'go', {
        plantedStaleReport: stale(allCases),
        failingWithStaleReport: brief(red),
        exitZeroWithoutReport: { ...brief(noReport), staleRemoved: true },
        emptyReport: brief(empty),
        onlySkipped: brief(skipped),
        requiredCaseDeselected: { gate: brief(narrow), proof: unproven },
        fixedFullRun: {
          gate: brief(full),
          proof: requirementProof(required, [full.evidence], full.sha),
        },
        evidenceOfOtherSha: requirementProof(required, [full.evidence], red.sha),
      });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  },
);

test(
  'T03/python: старый зелёный отчёт pytest не заменяет падающий прогон',
  { timeout: 600_000 },
  async () => {
    requireTools(['uv']);
    const f = materialize('python', { scenario });
    try {
      execFileSync('uv', ['sync', '--locked'], {
        cwd: f.repo,
        env: { ...process.env, PATH },
        stdio: 'pipe',
      });
      mkdirSync(join(f.repo, '.reports'), { recursive: true });
      writeFileSync(
        join(f.repo, '.reports/junit.xml'),
        stale([
          'tests.test_label.test_label_pads_one_digit',
          'tests.test_label.test_label_keeps_long',
        ]),
      );
      const command = ['uv', 'run', '--no-sync', 'pytest', '--junitxml=.reports/junit.xml'];
      const red = await gate(f.repo, { command });
      assert.equal(red.evidence.passed, false);
      assert.match(red.evidence.summary, /test_label_pads_one_digit/);
      commit(f, implementation('python', 'good'), 'fix');
      const green = await gate(f.repo, { command });
      assert.equal(green.evidence.passed, true, green.log);
      assert.equal(
        green.evidence.tests?.every((t) => t.status === 'passed'),
        true,
      );
      saveEvidence('T03', 'python', {
        failingWithStaleReport: brief(red),
        fixed: brief(green),
      });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  },
);

/** Turbo-фикстура с опасной конфигурацией cache и обёрткой acceptance в package script. */
function turboFixture(writer: unknown[], cacheDir?: string) {
  return materialize('turbo', {
    scenario: { writer, reviewer: approve },
    // Входы задачи test не включают src: попадание в cache возможно и для неверного кода.
    edit: (repo) => {
      writeFileSync(
        join(repo, 'turbo.json'),
        JSON.stringify({
          tasks: {
            check: { inputs: ['test/**'] },
            test: { dependsOn: ['check'], inputs: ['test/**'], outputs: ['.reports/**'] },
          },
        }),
      );
      const pkgFile = join(repo, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      pkg.scripts.acceptance = 'turbo run test --filter=@fx/label --output-logs=full';
      writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    },
    policy: (p) => {
      const repo = p.repositories[0];
      repo.gates = repo.gates.map((g: any) =>
        g.id === 'unit-tests' ? { ...g, command: ['pnpm', 'run', 'acceptance'] } : g,
      );
      if (cacheDir)
        repo.environment = {
          values: { ...repo.environment?.values, TURBO_CACHE_DIR: cacheDir },
        };
    },
  });
}
const turboEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  PATH,
  CI: '1',
  TURBO_TELEMETRY_DISABLED: '1',
  TURBO_NO_UPDATE_NOTIFIER: '1',
  ...extra,
});
const raw = (cwd: string, env: NodeJS.ProcessEnv) => {
  const r = spawnSync('pnpm', ['run', 'acceptance'], { cwd, env, encoding: 'utf8' });
  const xml = join(cwd, 'packages/label/.reports/junit.xml');
  return {
    exit: r.status,
    output: r.stdout + r.stderr,
    junit: existsSync(xml) ? junitSummary(readFileSync(xml, 'utf8')) : undefined,
  };
};
const install = (cwd: string) =>
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--offline'], {
    cwd,
    env: turboEnv(),
    stdio: 'pipe',
  });

test(
  'T03/turbo: cache восстанавливает зелёный отчёт без прогона; package script не обходит защиту — preflight CACHE_REPLAY, gate исполняет тесты (TURBO_FORCE)',
  { timeout: 600_000 },
  async () => {
    requireTools(['pnpm']);
    const f = turboFixture([writerStep({})]);
    try {
      install(f.repo);
      const report = { type: 'junit' as const, path: 'packages/label/.reports/junit.xml' };
      const wrapper = ['pnpm', 'run', 'acceptance'];

      // Preflight видит turbo внутри package script.
      const [diagnosis] = await inspectPolicy(executionPolicySchema.parse(f.policy), f.dir);
      assert.deepEqual(
        diagnosis!.problems.map((p) => [p.code, p.field.join('.')]),
        [['CACHE_REPLAY', 'repositories.0.gates.1.command']],
      );

      // Cache заполняется зелёным прогоном верной реализации (вне harness).
      commit(f, implementation('turbo', 'good'), 'good');
      const warm = raw(f.repo, turboEnv());
      assert.equal(warm.exit, 0, warm.output);

      // Опасность: неверная реализация без harness — cache hit и восстановленный зелёный отчёт.
      commit(f, implementation('turbo', 'bad'), 'bad');
      const hazard = raw(f.repo, turboEnv());
      assert.equal(hazard.exit, 0);
      assert.match(hazard.output, /cache hit, replaying/i);
      assert.equal(hazard.junit?.failures, 0, 'отчёт из cache зелёный для сломанного кода');

      // Тот же script через gate: тесты исполняются заново и падают.
      const fresh = await gate(f.repo, { id: 'unit-tests', command: wrapper, report });
      assert.match(fresh.log, /cache bypass, force executing/i);
      assert.match(fresh.log, /fresh=\{"TURBO_FORCE":"true"/);
      assert.equal(fresh.evidence.passed, false);
      assert.match(fresh.evidence.summary, /label pads one digit to three/);

      // Действительное исправление: свежий отчёт на новом SHA.
      commit(f, implementation('turbo', 'good'), 'fix');
      const fixed = await gate(f.repo, { id: 'unit-tests', command: wrapper, report });
      assert.equal(fixed.evidence.passed, true, fixed.log);
      assert.match(fixed.log, /cache bypass, force executing/i);
      assert.notEqual(fixed.sha, fresh.sha);
      saveEvidence('T03', 'turbo-gate', {
        preflight: diagnosis!.problems,
        hazardWithoutHarness: {
          exit: hazard.exit,
          cacheHit: /cache hit, replaying/i.test(hazard.output),
          junit: hazard.junit && { tests: hazard.junit.tests, failures: hazard.junit.failures },
        },
        gateBadSha: {
          sha: fresh.sha,
          runId: fresh.evidence.runId,
          passed: fresh.evidence.passed,
          summary: fresh.evidence.summary,
          tests: fresh.evidence.tests,
          header: fresh.log.split('\n')[0],
        },
        gateFixedSha: {
          sha: fixed.sha,
          runId: fixed.evidence.runId,
          passed: fixed.evidence.passed,
          tests: fixed.evidence.tests,
        },
      });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  },
);

test(
  'T03/turbo-engine: общий заполненный cache и package script через библиотечный Harness.run (без CLI preflight) — неверная реализация не принята, исправление принято свежим прогоном',
  { timeout: 900_000 },
  async () => {
    requireTools(['pnpm']);
    const cacheDir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-t03-turbo-cache-')));
    const f = turboFixture(
      [writerStep(implementation('turbo', 'bad')), writerStep(implementation('turbo', 'good'))],
      cacheDir,
    );
    const warmDir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-t03-turbo-warm-')));
    try {
      // Общий cache заполнен зелёным прогоном верной реализации в отдельной копии.
      execFileSync('git', ['clone', '-q', f.repo, warmDir + '/repo']);
      const warmRepo = warmDir + '/repo';
      for (const [path, text] of Object.entries(implementation('turbo', 'good')))
        writeFileSync(join(warmRepo, path), text);
      install(warmRepo);
      const warm = raw(warmRepo, turboEnv({ TURBO_CACHE_DIR: cacheDir }));
      assert.equal(warm.exit, 0, warm.output);
      // Та же копия с неверной реализацией: cache hit — опасность реальна.
      for (const [path, text] of Object.entries(implementation('turbo', 'bad')))
        writeFileSync(join(warmRepo, path), text);
      const hazard = raw(warmRepo, turboEnv({ TURBO_CACHE_DIR: cacheDir }));
      assert.match(hazard.output, /cache hit, replaying/i);
      assert.equal(hazard.junit?.failures, 0);

      const policy = executionPolicySchema.parse(f.policy);
      const graph = workGraphSchema.parse(
        JSON.parse(readFileSync(join(f.dir, 'graph.json'), 'utf8')),
      );
      const adapters = {
        claude: cliAdapter('claude', {
          executable: join(root, 'tests/fixtures/bin/fake-claude'),
          toolProfiles: policy.toolProfiles,
        }),
        codex: cliAdapter('codex', {
          executable: join(root, 'tests/fixtures/bin/fake-codex'),
          toolProfiles: policy.toolProfiles,
        }),
      };
      const open = () =>
        Harness.open({
          stateDir: f.state,
          policy,
          baseDir: f.dir,
          adapters,
          environment: turboEnv(),
        });
      let h = open();
      try {
        const first = await h.run({ graph, author: 'external' });
        assert.equal(first.works[0]!.status, 'failed');
      } finally {
        h.close();
      }
      assert.equal(f.git('rev-parse', f.targetRef), f.base, 'target ref не сдвинут');
      const failedState = readState(f.state);
      const badGate = failedState.attempts[0]!.evidence.find(
        (e) => e.gate === 'unit-tests' && e.phase === 'candidate',
      )!;
      const badLog = readFileSync(badGate.log, 'utf8');
      assert.equal(badGate.passed, false);
      assert.match(badLog, /cache bypass, force executing/i);

      h = open();
      try {
        h.engine.retry('pad-labels');
        const second = await h.run({ graph, author: 'external' });
        assert.equal(second.works[0]!.status, 'done');
      } finally {
        h.close();
      }
      const { work, attempts } = readState(f.state);
      assert.equal(f.git('rev-parse', f.targetRef), work.resultSha);
      const integration = attempts[1]!.evidence.find(
        (e) => e.gate === 'unit-tests' && e.phase === 'integration',
      )!;
      assert.equal(integration.passed, true);
      assert.equal(integration.sha, work.resultSha);
      assert.match(readFileSync(integration.log, 'utf8'), /cache bypass, force executing/i);
      saveEvidence('T03', 'turbo-engine', {
        sharedCacheDir: '(temp)',
        hazardWithoutHarness: { cacheHit: true, failures: hazard.junit?.failures },
        baseSha: f.base,
        negative: {
          runId: failedState.attempts[0]!.id,
          workStatus: failedState.work.status,
          targetAfter: f.base,
          gate: {
            sha: badGate.sha,
            passed: badGate.passed,
            summary: badGate.summary,
            tests: badGate.tests,
            header: badLog.split('\n')[0],
          },
        },
        positive: {
          runId: attempts[1]!.id,
          resultSha: work.resultSha,
          targetAfter: f.git('rev-parse', f.targetRef),
          gate: { sha: integration.sha, passed: integration.passed, tests: integration.tests },
        },
      });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(warmDir, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  },
);
