import './temp-scope.ts';
/**
 * 0.1.0-alpha.69: один и тот же провал gate (те же упавшие тесты и то же
 * утверждение) у засчитанных провалов работы с несвязанными изменениями —
 * подсказка ведущему проверить gate и тест базы и команда прогона gate на
 * базовом коммите (`harness gates --sha <base>`). Только подсказка: счёт
 * попыток не меняется; уже записанный прогон на базе называется явно.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { digestOf, type GateFailureSummary } from '../src/contracts/index.ts';
import { diagnoseState } from '../src/explain/diagnose.ts';
import {
  failureSignature,
  normalizeAssertion,
  repeatedGateFailure,
  type RepeatedFailureAttempt,
} from '../src/projections/repeated-failure.ts';
import { explainStop } from '../src/projections/stop.ts';
import { graphOf, ready } from './engine-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { bin } from './runner-fixture.ts';

const BASE = 'b'.repeat(40);
const sha = (c: string) => c.repeat(40);

const failed = (
  id: string,
  candidate: string,
  summary: GateFailureSummary,
  extra: Partial<RepeatedFailureAttempt> = {},
): RepeatedFailureAttempt => ({
  id,
  status: 'failed',
  failureKind: 'gate',
  baseSha: BASE,
  candidateSha: sha(candidate),
  evidence: [
    {
      kind: 'test',
      gate: 'unit',
      passed: false,
      sha: sha(candidate),
      runId: id,
      failureSummary: summary,
    },
  ],
  ...extra,
});

const login = (ms: number): GateFailureSummary => ({
  tests: ['login keeps session'],
  assertion: `AssertionError: expected 200, got 500 (${ms}ms) at /private/tmp/run-${ms}/app/test/login.test.ts:12`,
  source: 'output',
});

test('подпись: длительности, каталоги попыток и пробелы не различают провалы; скрытый вывод подписи не имеет', () => {
  assert.equal(failureSignature(login(12)), failureSignature(login(15)));
  assert.notEqual(
    failureSignature(login(12)),
    failureSignature({ ...login(12), assertion: 'AssertionError: expected 200, got 404' }),
  );
  assert.equal(failureSignature({ withheld: true }), undefined);
  assert.equal(failureSignature({ tail: 'x' }), undefined);
  assert.equal(normalizeAssertion('a   b\n c'), 'a b c');
});

test('повторный провал при непересекающихся изменениях — подсказка и команда прогона на базе', () => {
  const attempts = [failed('r1', 'c', login(12)), failed('r2', 'd', login(15))];
  const files: Record<string, string[]> = { r1: ['src/a.ts'], r2: ['src/b.ts', 'test/b.test.ts'] };
  const found = repeatedGateFailure(attempts, {
    changedFiles: (id) => files[id],
    gatesArgs: '--state /s',
  });
  assert.ok(found);
  assert.equal(found.relation, 'disjoint');
  assert.deepEqual(found.runIds, ['r1', 'r2']);
  assert.equal(found.command, `harness gates --state /s --sha ${BASE} --gate unit`);
  assert.match(found.line.ru, /Один и тот же провал gate unit у 2 попыток \(r1, r2\)/);
  assert.match(found.line.ru, /упали login keeps session/);
  assert.match(found.line.ru, /изменения попыток не пересекаются по файлам/);
  assert.ok(found.line.ru.includes(found.command), found.line.ru);
  assert.ok(found.line.en.includes(found.command), found.line.en);
});

test('изменения пересекаются, но тестов не трогают — подсказка; трогают тесты — нет', () => {
  const attempts = [failed('r1', 'c', login(12)), failed('r2', 'd', login(15))];
  const untouched = repeatedGateFailure(attempts, {
    changedFiles: () => ['src/shared.ts'],
  });
  assert.equal(untouched?.relation, 'tests-untouched');
  assert.match(untouched.line.ru, /не трогают тестов/);
  const related = repeatedGateFailure(attempts, {
    changedFiles: () => ['src/shared.ts', 'test/login.test.ts'],
  });
  assert.equal(related, undefined, 'обе попытки правили один тест — связь не исключена');
  // Файлы одной из попыток неизвестны — подсказки нет.
  assert.equal(
    repeatedGateFailure(attempts, { changedFiles: (id) => (id === 'r1' ? ['a'] : undefined) }),
    undefined,
  );
});

test('разные провалы, один кандидат, провалы не gate — подсказки нет', () => {
  const files = () => ['src/a.ts'];
  const other = { ...login(12), assertion: 'TypeError: x is undefined' };
  assert.equal(
    repeatedGateFailure([failed('r1', 'c', login(12)), failed('r2', 'd', other)], {
      changedFiles: (id) => (id === 'r1' ? ['a'] : ['b']),
    }),
    undefined,
  );
  assert.equal(
    repeatedGateFailure([failed('r1', 'c', login(12)), failed('r2', 'c', login(15))], {
      changedFiles: files,
    }),
    undefined,
    'тот же кандидат — не разные изменения',
  );
  assert.equal(
    repeatedGateFailure(
      [failed('r1', 'c', login(12)), failed('r2', 'd', login(15), { failureKind: 'review' })],
      { changedFiles: (id) => (id === 'r1' ? ['a'] : ['b']) },
    ),
    undefined,
  );
});

test('прогон gate на базе уже записан: тот же провал — сказано явно; прошёл — тоже', () => {
  const attempts = [failed('r1', 'c', login(12)), failed('r2', 'd', login(15))];
  const changedFiles = (id: string) => (id === 'r1' ? ['a.ts'] : ['b.ts']);
  const baseRun = (passed: boolean, summary?: GateFailureSummary) => () => [
    {
      kind: 'test' as const,
      gate: 'unit',
      passed,
      sha: BASE,
      runId: 'r0',
      ...(summary ? { failureSummary: summary } : {}),
    },
  ];
  const same = repeatedGateFailure(attempts, {
    changedFiles,
    evidenceAt: baseRun(false, login(9)),
  });
  assert.equal(same?.base?.outcome, 'same-failure');
  assert.match(same.line.ru, /На базе b{12} gate unit уже падал так же \(прогон r0\)/);
  assert.match(same.line.ru, /исправить gate или тест базы/);
  const passed = repeatedGateFailure(attempts, { changedFiles, evidenceAt: baseRun(true) });
  assert.equal(passed?.base?.outcome, 'passed');
  assert.match(passed.line.ru, /На базе b{12} gate unit проходил/);
});

test('explain: строка о повторном провале — в сообщении диагноза работы', () => {
  const d = explainStop({
    kind: 'work',
    work: {
      id: 'w',
      status: 'failed',
      attempt: 2,
      failureKind: 'gate',
      repeatedFailure: { line: 'Один и тот же провал gate unit у 2 попыток (r1, r2): …' },
      failure: 'длинный текст отказа',
    },
    maxAttempts: 3,
    repair: { sameFailureRepairs: 2, groupRepairsUsed: 0, groupRepairBudget: 6, outlook: 'stop' },
    control: { paused: false },
  });
  assert.match(d.message, /Один и тот же провал gate unit у 2 попыток.*Отказ: длинный текст/s);
});

test('harness explain: две попытки с тем же провалом и разными файлами — подсказка с командой на базе', async () => {
  const ctx = hsetup({
    scenario: {},
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 6),
  });
  writeFileSync(
    join(ctx.state, 'binding.json'),
    JSON.stringify({ policy: ctx.policy, baseDir: ctx.repo.dir }),
  );
  const base = ctx.repo.head();
  // Два кандидата от базы, каждый меняет свой файл.
  const candidate = (file: string) => {
    ctx.repo.git('checkout', '-q', '--detach', base);
    writeFileSync(join(ctx.repo.dir, file), `${file}\n`);
    ctx.repo.git('add', '-A');
    ctx.repo.git('commit', '-q', '-m', file);
    return ctx.repo.head();
  };
  const c1 = candidate('a.txt');
  const c2 = candidate('b.txt');
  const gate = ctx.policy.repositories[0]!.gates[0]!.id;
  const h = ctx.open();
  try {
    ready(h.engine, graphOf({ w: [] }));
    for (const [i, c] of [c1, c2].entries()) {
      const run = h.engine.claim('c1')!;
      assert.ok(run, `попытка ${i + 1} выдана`);
      h.engine.phase(run.id, run.token, 'verifying', { baseSha: base, candidateSha: c });
      h.engine.evidence(run.id, run.token, {
        kind: 'test',
        phase: 'candidate',
        sha: c,
        gate,
        passed: false,
        command: ['node', 'test/run.js'],
        exitCode: 1,
        log: '',
        digest: digestOf(c),
        summary: 'Код выхода 1: упали login keeps session',
        failureSummary: login(10 + i),
      });
      h.engine.fail(run.id, run.token, `candidate/${gate}: Код выхода 1`, { kind: 'gate' });
      if (i === 0) h.engine.retry('w');
    }
    assert.equal(
      h.engine.read((v) => v.work('w')!.attempt),
      2,
      'обе попытки засчитаны — подсказка счёт не меняет',
    );
  } finally {
    h.close();
  }
  const data = await diagnoseState({
    stateDir: ctx.state,
    policy: ctx.policy,
    baseDir: ctx.repo.dir,
    workId: 'w',
    adapters: {
      claude: cliAdapter('claude', { executable: bin('fake-claude'), toolProfiles: {} }),
      codex: cliAdapter('codex', { executable: bin('fake-codex'), toolProfiles: {} }),
    },
  });
  const work = data.diagnoses.find((d) => d.workId === 'w')!;
  assert.match(work.message, new RegExp(`Один и тот же провал gate ${gate} у 2 попыток`));
  assert.ok(
    work.message.includes(`harness gates --state ${ctx.state} --sha ${base} --gate ${gate}`),
    work.message,
  );
});
