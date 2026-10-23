/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
 * Тест читает JSON-ответ CLI как есть; его форму проверяет сам CLI схемой команды.
 */
/**
 * Протокол ревью через CLI отдельными процессами (docs/review-protocol.md):
 * exit codes и согласованность status/result/help (HP04), история находок
 * после нового процесса (HP03), счётчик повторов reviewer после аварийного
 * завершения controller между ответами (HP06). Writer и reviewer — fixture
 * executables (HARNESS_*_BIN), не живые модели.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestOf, exitCodes } from '../src/contracts/index.ts';
import { bin, implement } from './runner-fixture.ts';
import { close, finding, fixtureCalls, recordedPrompt, verdict } from './review-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const example = fileURLToPath(new URL('../examples/single-task', import.meta.url));
const fixedGreet =
  "exports.greet = (name) => {\n  if (!name) throw new Error('empty name');\n  return 'Hello, ' + name + '!';\n};\n";
const defect = finding('Нет обработки пустого имени');

function project(scenario: unknown, policyPatch: (p: any) => void = () => {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-review-cli-')));
  const app = join(root, 'greeting');
  cpSync(example, app, { recursive: true });
  const scenarioPath = join(root, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const policy = JSON.parse(readFileSync(join(app, 'policy.json'), 'utf8'));
  policy.isolation = { mode: 'none', domains: [] };
  policy.environment = {
    values: { FIXTURE_SCENARIO: scenarioPath },
    secrets: { FIXTURE_TOKEN: 'HARNESS_REVIEW_CLI_SECRET' },
  };
  policy.leaseMs = 5000;
  policy.maxAttempts = 3;
  policyPatch(policy);
  writeFileSync(join(app, 'policy.json'), JSON.stringify(policy, null, 2));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: app,
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
  git('add', '-A');
  git('commit', '-qm', 'init');
  const initial = git('rev-parse', 'HEAD');
  const state = join(root, 'state');
  const harness = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd: app,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        HARNESS_REVIEW_CLI_SECRET: 'cli-secret-9d1e',
        HARNESS_CLAUDE_BIN: bin('fake-claude'),
        HARNESS_CODEX_BIN: bin('fake-codex'),
      },
    });
    let json: any = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      /* аварийно завершённый процесс JSON не печатает */
    }
    return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, json };
  };
  const run = (author = 'external') =>
    harness(
      'run',
      '--graph',
      'graph.json',
      '--policy',
      'policy.json',
      '--state',
      state,
      '--author',
      author,
    );
  const ref = () => {
    try {
      return git('rev-parse', 'refs/heads/harness/accepted');
    } catch {
      return null;
    }
  };
  return { root, app, scenarioPath, harness, run, state, ref, initial };
}

/** Evidence фиксируется в .private/pilot-fixes/evidence/<ID>/, если задан каталог. */
function dump(id: string, name: string, data: unknown) {
  const dir = process.env.HP_EVIDENCE_DIR;
  if (!dir) return;
  const file = join(dir, id, name + '.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

test('HP04: CLI отдельным процессом — ошибка протокола после повторов: exit 4, REVIEW_PROTOCOL_INVALID с путём в run/status/result; содержательный отказ — exit 3', () => {
  // Каждый ответ reviewer ссылается на не выданный ID (структурно верный SHA-256).
  const wrong = { id: digestOf('не выдан'), status: 'closed', basis: 'исправлено' };
  // Первый шаг reviewer — ревью плана (approvalMode agent), далее — ревью кода.
  const p = project({
    writer: implement(),
    reviewer: [verdict(true), verdict(true, { previous: [wrong] })],
  });
  const run = p.run();
  assert.equal(run.status, exitCodes.infrastructure, run.stderr);
  assert.equal(run.status, 4);
  assert.equal(run.json.ok, true);
  assert.equal(run.json.data.works[0].status, 'failed');
  assert.equal(fixtureCalls(p.scenarioPath, 'codex', 'reviewer') - 1, 2, 'вызов + один повтор');
  assert.equal(fixtureCalls(p.scenarioPath, 'claude', 'writer'), 1, 'writer один');
  assert.equal(p.ref(), p.initial, 'target не продвинут');
  const result = p.harness('result', '--state', p.state, '--work', 'add-greeting');
  assert.equal(result.status, 0, result.stderr);
  const r = result.json.data.result;
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.stopReason.code, 'REVIEW_PROTOCOL_INVALID');
  assert.match(r.stopReason.message, /previous\[0\]\.id unknown/);
  assert.match(r.stopReason.message, /candidate [0-9a-f]{40}/);
  assert.match(r.stopReason.message, /вызовов 2 из 2/);
  const refs = r.evidence.filter((e: any) => e.kind === 'review');
  assert.deepEqual(
    refs.map((e: any) => [e.review.call, e.review.protocol, e.review.issues[0].path]),
    [
      [1, 'invalid', 'previous[0].id'],
      [2, 'invalid', 'previous[0].id'],
    ],
  );
  const status = p.harness('status', '--state', p.state);
  assert.equal(status.json.data.works[0].status, 'failed');
  const all = run.stdout + result.stdout + status.stdout;
  assert.ok(!all.includes('cli-secret-9d1e'), 'секреты не выводятся');
  assert.ok(!/"token"/.test(all));
  const help = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), cli, '--help'],
    {
      encoding: 'utf8',
    },
  );
  assert.match(help.stderr, /REVIEW_PROTOCOL_INVALID\) — 4/);
  dump('HP04', 'protocol-run', run.json);
  dump('HP04', 'protocol-result', result.json);

  // Валидный содержательный отказ остаётся REVIEW_REJECTED / exit 3.
  const q = project({
    writer: implement(),
    reviewer: [verdict(true), verdict(false, { findings: [defect] })],
  });
  const rejected = q.run();
  assert.equal(rejected.status, exitCodes.refused, rejected.stderr);
  assert.equal(rejected.status, 3);
  const qr = q.harness('result', '--state', q.state, '--work', 'add-greeting').json.data.result;
  assert.equal(qr.stopReason.code, 'REVIEW_REJECTED');
  assert.equal(qr.findings[0].status, 'open');
  assert.match(qr.findings[0].id, /^[0-9a-f]{64}$/);
  dump('HP04', 'rejected-result', qr);
});

test('HP03: история находок переживает новый процесс между отказом и второй реализацией', () => {
  const p = project({
    writer: [implement(), { ...implement({ 'src/greet.js': fixedGreet }), recordPrompt: true }],
    reviewer: [
      verdict(true), // ревью плана
      verdict(false, { findings: [defect] }),
      { ...verdict(true, { previous: [close(0)] }), recordPrompt: true },
      verdict(true),
    ],
  });
  const first = p.run();
  assert.equal(first.status, 3, first.stderr);
  const r1 = p.harness('result', '--state', p.state, '--work', 'add-greeting').json.data.result;
  const id = r1.findings[0].id as string;
  // Новый процесс: повтор и вторая реализация.
  assert.equal(p.harness('retry', '--state', p.state, '--work', 'add-greeting').status, 0);
  const second = p.run();
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.ok(recordedPrompt(p.scenarioPath, 'writer', 1).includes(id), 'writer получил тот же ID');
  assert.ok(recordedPrompt(p.scenarioPath, 'reviewer', 2).includes(id), 'reviewer — тот же ID');
  const r2 = p.harness('result', '--state', p.state, '--work', 'add-greeting').json.data.result;
  assert.equal(r2.outcome, 'accepted');
  const transitions = r2.evidence.flatMap((e: any) => e.review?.transitions ?? []);
  assert.deepEqual(transitions, [{ id, from: 'open', to: 'closed' }]);
  assert.equal(fixtureCalls(p.scenarioPath, 'claude', 'writer'), 2);
  dump('HP03', 'restart-result', r2);
});

/**
 * HP06/R2-F01: controller убит во время вызова reviewer (барьер fixture —
 * SIGKILL процесса harness до ответа). Новый процесс засчитывает начатый
 * вызов: фактических вызовов runtime по candidate не больше `1 + retries`,
 * записи учёта вызовов совпадают с вызовами fixture.
 */
const restartCases: {
  name: string;
  retries?: number;
  /** Шаги ревью кандидата; `crash` — вызов, во время которого убит controller. */
  candidate: ('malformed' | 'crash' | 'valid')[];
  /** Сколько вызовов кандидата фактически начато всего (оба процесса). */
  invoked: number;
  accepted: boolean;
}[] = [
  {
    name: 'default: убит во время вызова 2',
    candidate: ['malformed', 'crash'],
    invoked: 2,
    accepted: false,
  },
  {
    name: 'default: убит во время вызова 1',
    candidate: ['crash', 'valid'],
    invoked: 2,
    accepted: true,
  },
  {
    name: 'retries 0: убит во время вызова 1',
    retries: 0,
    candidate: ['crash'],
    invoked: 1,
    accepted: false,
  },
  {
    name: 'retries 1: убит во время вызова 2',
    retries: 1,
    candidate: ['malformed', 'crash'],
    invoked: 2,
    accepted: false,
  },
  {
    name: 'retries 2: убит во время вызова 2',
    retries: 2,
    candidate: ['malformed', 'crash', 'valid'],
    invoked: 3,
    accepted: true,
  },
];

for (const c of restartCases)
  test(`HP06/R2-F01: рестарт посреди логического ревью — начатый вызов засчитан (${c.name})`, async () => {
    const step = (k: 'malformed' | 'crash' | 'valid') =>
      k === 'malformed'
        ? { raw: '{"approved": tru' }
        : k === 'crash'
          ? { ...verdict(true), crashHarness: true }
          : verdict(true);
    const p = project(
      {
        writer: implement(),
        reviewer: [
          verdict(true), // ревью плана (author claude)
          ...c.candidate.map(step),
          verdict(true), // integration
          // Лишний вызов кандидата сверх предела получил бы этот шаг (и его счёт).
          verdict(true),
        ],
      },
      (policy) => {
        if (c.retries !== undefined) policy.reviewProtocolRetries = c.retries;
      },
    );
    const crashed = p.run('claude');
    assert.equal(crashed.signal, 'SIGKILL', 'процесс controller убит барьером fixture');
    // Аренда controller и попытки истекает (leaseMs 5 с).
    await new Promise((r) => setTimeout(r, 6500));
    const again = p.run('claude');
    const result = p.harness('result', '--state', p.state, '--work', 'add-greeting').json?.data
      ?.result;
    const fixtureCalls_ = fixtureCalls(p.scenarioPath, 'codex', 'reviewer') - 1;
    const { SqliteExecutionStore } = await import('../src/storage/sqlite.ts');
    const store = new SqliteExecutionStore(join(p.state, 'state.sqlite'), 't', { readOnly: true });
    const attempts = store.read((v) => v.attempts('add-greeting'));
    const usage = store
      .read((v) => v.locals('usage', 'app'))
      .map((x) => x.value as any)
      .filter((r) => /-review$/.test(r.stage) && r.stage !== 'plan-review');
    store.close();
    const candidateCalls = usage.filter((r) => r.stage === 'candidate-review');
    const evidence = attempts.flatMap((a) =>
      a.evidence
        .filter((e) => e.kind === 'review')
        .map((e) => ({
          run: a.id,
          phase: e.phase,
          call: e.reviewRound?.call,
          protocol: e.reviewRound?.protocol,
        })),
    );
    dump('HP06', `round3/restart-retries-${c.retries ?? 'default'}-${c.candidate.join('-')}`, {
      case: c,
      exit: again.status,
      result,
      fixtureInvocations: fixtureCalls_,
      usage: usage.map((r) => ({
        runId: r.runId,
        stage: r.stage,
        outcome: r.outcome,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
      })),
      evidence,
    });
    const limit = 1 + (c.retries ?? 1);
    // Фактические вызовы runtime по кандидату: учёт = fixture, не больше предела.
    assert.equal(candidateCalls.length, c.invoked, 'начатые вызовы кандидата по учёту');
    assert.ok(candidateCalls.length <= limit, `не больше 1 + retries = ${limit}`);
    assert.equal(usage.length, fixtureCalls_, 'учёт вызовов совпадает с вызовами runtime');
    assert.ok(
      candidateCalls.some((r) => r.outcome === 'abandoned'),
      'прерванный вызов остался в учёте',
    );
    assert.equal(fixtureCalls(p.scenarioPath, 'claude', 'writer'), 1, 'writer не вызывается снова');
    if (c.accepted) {
      assert.equal(again.status, 0, again.stderr + again.stdout);
      assert.equal(result.outcome, 'accepted');
      // Номер вызова — номер фактически начатого вызова, а не «снова второй».
      const decisive = evidence.find((e) => e.phase === 'candidate' && e.protocol === 'valid')!;
      assert.equal(decisive.call, c.invoked);
    } else {
      assert.equal(again.status, 4, again.stderr + again.stdout);
      assert.equal(result.stopReason.code, 'REVIEW_PROTOCOL_INVALID');
      assert.match(
        result.stopReason.message,
        new RegExp(`начато вызовов ${c.invoked} из ${limit}`),
      );
      assert.equal(p.ref(), p.initial, 'target не продвинут');
    }
  });

test('HP06/R2-F01: после рестарта прежний SHA не получает нового срока — истёкший срок логического ревью останавливает без вызова', async () => {
  const p = project(
    {
      writer: implement(),
      reviewer: [
        verdict(true),
        { ...verdict(true), crashHarness: true },
        verdict(true),
        verdict(true),
      ],
    },
    (policy) => (policy.runTimeoutMs = 8000),
  );
  const crashed = p.run('claude');
  assert.equal(crashed.signal, 'SIGKILL');
  // Срок логического ревью (8 с от начала вызова 1) истекает до рестарта.
  await new Promise((r) => setTimeout(r, 9500));
  const again = p.run('claude');
  const { SqliteExecutionStore } = await import('../src/storage/sqlite.ts');
  const store = new SqliteExecutionStore(join(p.state, 'state.sqlite'), 't', { readOnly: true });
  const attempts = store.read((v) => v.attempts('add-greeting'));
  const usage = store
    .read((v) => v.locals('usage', 'app'))
    .map((x) => x.value as any)
    .filter((r) => r.stage === 'candidate-review');
  store.close();
  dump('HP06', 'round3/restart-deadline', {
    exit: again.status,
    attempts: attempts.map((a) => ({
      id: a.id,
      status: a.status,
      kind: a.failureKind,
      error: a.error,
    })),
    usage: usage.map((r) => ({ runId: r.runId, outcome: r.outcome, startedAt: r.startedAt })),
  });
  assert.equal(usage.length, 1, 'нового вызова reviewer нет');
  assert.equal(fixtureCalls(p.scenarioPath, 'codex', 'reviewer') - 1, 1);
  const last = attempts.at(-1)!;
  // Явная остановка: без автоматического повтора, который выдал бы новый срок.
  assert.equal(attempts.length, 2, 'новой попытки после остановки нет');
  assert.equal(last.failureKind, 'review-protocol', last.error);
  assert.match(last.error!, /исчерпан срок логического ревью/);
  assert.equal(again.status, 4);
  assert.equal(p.ref(), p.initial);
});
