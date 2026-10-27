/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тесты правят сырой JSON политики/графа до разбора схемой и читают JSON-ответ CLI как есть.
 */
/**
 * A7-NET, NET08–NET13: сетевой отказ runtime по настоящему пути — subprocess
 * fixture CLI (`tests/fixtures/bin/fake-claude`/`fake-codex`, ответы моделей
 * запрограммированы сценарием) → CLI adapter → runner → controller
 * (`Harness.run`, CLI `run`). Gates, JUnit и Git — настоящие.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exitCodes,
  type AttemptState,
  type ControlState,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type WorkState,
} from '../src/contracts/index.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { Harness } from '../src/control/harness.ts';
import type { RunnerHooks } from '../src/engine/runner.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, bin, greet, implement, target } from './runner-fixture.ts';

/** Точный текст отказа runtime из L3 (`20261023-131048-live-pilot-2be0`). */
const EPROTO =
  'API Error: EPROTO: The TLS handshake failed. Does the server speak TLS on this port?';
/** Запуск runtime состоялся, затем exit 1 с сетевой диагностикой. */
const networkDown = { exit: 1, stderr: EPROTO };
const L3 = `claude: runtime завершился отказом: код 1: ${EPROTO}`;
const GREETING = 'add-greeting';

type Ctx = ReturnType<typeof hsetup>;

/** Harness поверх того же состояния и fixture subprocess, с хуками runner и обёрткой адаптера. */
function openWith(
  ctx: Ctx,
  options: {
    policy?: ExecutionPolicy;
    hooks?: RunnerHooks;
    wrap?: (adapter: RuntimeAdapter) => RuntimeAdapter;
  } = {},
) {
  const policy = options.policy ?? ctx.policy;
  const wrap = options.wrap ?? ((a: RuntimeAdapter) => a);
  return Harness.open({
    stateDir: ctx.state,
    policy,
    baseDir: ctx.repo.dir,
    adapters: {
      claude: wrap(
        cliAdapter('claude', { executable: bin('fake-claude'), toolProfiles: policy.toolProfiles }),
      ),
      codex: wrap(
        cliAdapter('codex', { executable: bin('fake-codex'), toolProfiles: policy.toolProfiles }),
      ),
    },
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
}

/** Адаптер, который перед вызовом writer выполняет `before(n)` (n — номер вызова writer с 0). */
const beforeWriter =
  (before: (n: number) => void) =>
  (inner: RuntimeAdapter): RuntimeAdapter => {
    let n = 0;
    return {
      runtime: inner.runtime,
      capabilities: () => inner.capabilities(),
      invoke: (request, signal) => {
        if (request.task === 'implement') before(n++);
        return inner.invoke(request, signal);
      },
    };
  };

/** Код остановки результата попытки (у принятого результата его нет). */
const stopCode = (h: Harness, workId: string, runId?: string) => {
  const result = h.result(workId, runId).result;
  return result.outcome === 'accepted' ? undefined : result.stopReason.code;
};
const events = (h: Harness) => h.store.events(0, 500);
const attemptsOf = (h: Harness, workId: string) => h.engine.read((v) => v.attempts(workId));
const repairEvents = (h: Harness, data: { workflow?: { history: { event: string }[] } }) =>
  (data.workflow?.history ?? []).filter((e) => e.event.startsWith('repair:')).map((e) => e.event);

/** Принятие — только после обычных проверок: gate и ревью обеих фаз пройдены на этой попытке. */
function assertNormallyAccepted(attempt: AttemptState) {
  assert.equal(attempt.status, 'succeeded');
  for (const phase of ['candidate', 'integration'] as const) {
    const ofPhase = attempt.evidence.filter((e) => e.phase === phase);
    assert.ok(
      ofPhase.some((e) => e.kind === 'test' && e.gate === 'unit' && e.passed),
      `${phase}: gate unit пройден`,
    );
    assert.ok(
      ofPhase.some((e) => e.kind === 'review' && e.passed),
      `${phase}: независимое ревью одобрило`,
    );
  }
}

test('NET08: writer exit 1 с EPROTO — environment, один repair:environment, вторая попытка принята обычными проверками; зависимая работа ждёт принятия', async () => {
  const ctx = hsetup({
    scenario: {
      writer: [
        networkDown,
        implement(),
        implement({ 'src/farewell.js': 'exports.bye = () => "Bye";\n' }),
      ],
      reviewer: approve(),
    },
    policy: (p: any) => {
      p.maxAttempts = 2;
      p.repairBudget = 1;
    },
    graph: (g: any) => {
      const orders = g.orders as Record<string, unknown>[];
      orders.push({
        ...orders[0],
        id: 'add-farewell',
        source: { connector: 'files', ref: 'add-farewell', revision: '1' },
        title: 'Add a farewell function',
        dependsOn: [GREETING],
      });
    },
  });
  const before = target(ctx);
  // Снимки состояния: в момент записи отказа (до решения о повторе) и перед вторым вызовом writer.
  let atFailure: { work: WorkState; attempts: AttemptState[]; control: ControlState } | undefined;
  const atWriter: { greeting: WorkState; farewell: WorkState }[] = [];
  const h: Harness = openWith(ctx, {
    hooks: {
      failed: ({ attempt }) => {
        atFailure ??= h.engine.read((v) => ({
          work: structuredClone(v.work(attempt.workId)!),
          attempts: structuredClone(v.attempts(attempt.workId)),
          control: structuredClone(v.control()),
        }));
      },
    },
    wrap: beforeWriter(() =>
      atWriter.push(
        h.engine.read((v) => ({
          greeting: structuredClone(v.work(GREETING)!),
          farewell: structuredClone(v.work('add-farewell')!),
        })),
      ),
    ),
  });
  const data = await h.run({ graph: ctx.graph, author: 'claude' });

  // Отказ классифицирован в точке отказа — до retry.
  assert.ok(atFailure, 'отказ записан и отражён хуком');
  assert.equal(atFailure.work.id, GREETING);
  assert.equal(atFailure.work.status, 'failed');
  assert.equal(atFailure.work.failureKind, 'environment');
  assert.equal(atFailure.work.failure, L3, 'точный текст L3 с префиксом runner');
  assert.equal(atFailure.attempts.length, 1);
  assert.equal(atFailure.attempts[0]!.failureKind, 'environment');
  assert.notEqual(atFailure.attempts[0]!.blocked, true, 'CLI запускался: это не отказ до работы');
  // Обрыв сети ничего не говорит о работе: бюджет попыток поручения не тратится.
  assert.equal(atFailure.work.attempt, 0, 'попытка не засчитана');

  // Сохранённые записи после всего прогона.
  const greeting = attemptsOf(h, GREETING);
  assert.equal(greeting.length, 2, 'ровно две writer-попытки этого поручения');
  const [first, second] = greeting as [AttemptState, AttemptState];
  assert.equal(first.status, 'failed');
  assert.equal(first.failureKind, 'environment');
  assert.notEqual(first.blocked, true);
  assert.equal(first.error, L3);
  const failedEvents = events(h).filter((e) => e.type === 'attempt.failed');
  assert.equal(failedEvents.length, 1, 'других отказов в прогоне нет');
  assert.equal(failedEvents[0]!.runId, first.id);
  assert.equal((failedEvents[0]!.payload as any).failureKind, 'environment');
  assert.equal((failedEvents[0]!.payload as any).blocked, false);
  assert.equal(stopCode(h, GREETING, first.id), 'RUNTIME_UNAVAILABLE');

  // Один автоматический repair:environment; retry снял текущий класс отказа.
  assert.deepEqual(repairEvents(h, data), ['repair:environment']);
  assert.equal(data.workflow?.repairs, 1);
  assert.equal(data.workflow?.status, 'completed');
  assert.equal(atWriter.length, 3, 'writer: две попытки add-greeting и одна add-farewell');
  assert.equal(ctx.calls('claude', 'writer'), 3);
  assert.equal(atWriter[1]!.greeting.failureKind, undefined, 'retry очистил failureKind');
  assert.equal(atWriter[1]!.greeting.failureFingerprint, undefined);
  assert.equal(atWriter[1]!.greeting.failure, undefined);

  // Принятие — только обычными проверками; ref продвинут результатом.
  assertNormallyAccepted(second);
  assert.equal(h.result(GREETING).result.outcome, 'accepted');
  const farewell = attemptsOf(h, 'add-farewell');
  assert.equal(farewell.length, 1, 'зависимая работа считается отдельно: одна попытка');
  assertNormallyAccepted(farewell[0]!);
  assert.deepEqual(
    data.works.map((w) => [w.id, w.status]),
    [
      [GREETING, 'done'],
      ['add-farewell', 'done'],
    ],
  );
  assert.notEqual(target(ctx), before);

  // Зависимая работа не начиналась до принятия предпосылки.
  assert.notEqual(atWriter[0]!.farewell.status, 'running');
  assert.notEqual(atWriter[1]!.farewell.status, 'running');
  const log = events(h);
  const accepted = log.find((e) => e.type === 'work.accepted' && e.workId === GREETING)!;
  const claimed = log.find((e) => e.type === 'attempt.claimed' && e.workId === 'add-farewell')!;
  assert.ok(accepted && claimed && claimed.seq > accepted.seq, 'выдача зависимой после принятия');
  h.close();
});

test('NET09: два одинаковых EPROTO при запасе maxAttempts=3/repairBudget=2 — две попытки, один repair, stop RUNTIME_UNAVAILABLE', async () => {
  const ctx = hsetup({
    scenario: { writer: networkDown, reviewer: approve() },
    policy: (p: any) => {
      p.maxAttempts = 3;
      p.repairBudget = 2;
    },
  });
  const before = target(ctx);
  const h = openWith(ctx);
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  const attempts = attemptsOf(h, GREETING);
  assert.equal(attempts.length, 2, 'третьего writer нет');
  assert.equal(ctx.calls('claude', 'writer'), 2);
  for (const a of attempts) {
    assert.equal(a.failureKind, 'environment');
    assert.notEqual(a.blocked, true);
  }
  assert.equal(attempts[0]!.failureFingerprint, attempts[1]!.failureFingerprint, 'один отпечаток');
  assert.deepEqual(repairEvents(h, data), ['repair:environment']);
  assert.equal(data.workflow?.repairs, 1, 'запас бюджета остался: остановил предел отпечатка');
  assert.equal(data.workflow?.status, 'failed');
  assert.match(data.workflow?.error ?? '', /одна и та же причина 2 раз/);
  assert.equal(data.works[0]!.status, 'failed');
  const result = h.result(GREETING).result;
  assert.equal(result.outcome, 'rejected');
  assert.equal(stopCode(h, GREETING), 'RUNTIME_UNAVAILABLE');
  assert.equal(target(ctx), before, 'ref не продвинут');
  h.close();
});

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const singleTask = fileURLToPath(new URL('../examples/single-task', import.meta.url));

test('NET09: CLI run — окончательно отклонённая сетевая работа даёт exit 3; result — RUNTIME_UNAVAILABLE', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-net-cli-')));
  const app = join(root, 'greeting');
  cpSync(singleTask, app, { recursive: true });
  const scenario = join(root, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ writer: networkDown, reviewer: approve() }));
  const policyPath = join(app, 'policy.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
  policy.isolation = { mode: 'none', domains: [] };
  policy.environment = { values: { FIXTURE_SCENARIO: scenario } };
  policy.maxAttempts = 3;
  policy.repairBudget = 2;
  writeFileSync(policyPath, JSON.stringify(policy, null, 2));
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
  const harness = (...args: string[]) => {
    const r = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), cliPath, ...args],
      {
        cwd: app,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          HARNESS_CLAUDE_BIN: bin('fake-claude'),
          HARNESS_CODEX_BIN: bin('fake-codex'),
        },
      },
    );
    return { status: r.status, stderr: r.stderr, json: JSON.parse(r.stdout) as { data: any } };
  };
  const state = join(root, 'state');
  const run = harness(
    'run',
    '--graph',
    'graph.json',
    '--policy',
    'policy.json',
    '--state',
    state,
    '--author',
    'claude',
  );
  assert.equal(run.status, exitCodes.refused, run.stderr);
  assert.equal(run.status, 3);
  assert.equal(run.json.data.works[0].status, 'failed');
  assert.equal(run.json.data.workflow.repairs, 1);
  const counter = `${scenario}.claude.writer.count`;
  assert.ok(existsSync(counter));
  assert.equal(Number(readFileSync(counter, 'utf8')), 2, 'две попытки writer, третьей нет');
  const result = harness('result', '--state', state, '--work', GREETING);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.data.result.outcome, 'rejected');
  assert.equal(result.json.data.result.stopReason.code, 'RUNTIME_UNAVAILABLE');
  assert.equal(git('rev-parse', 'refs/heads/harness/accepted'), initial, 'ref не продвинут');
});

test('NET10: maxAttempts=1 — отказ environment попытку не тратит: повтор и принятие; лимит не повышен', async () => {
  const ctx = hsetup({
    scenario: { writer: [networkDown, implement()], reviewer: approve() },
    policy: (p: any) => {
      Object.assign(p, { maxAttempts: 1, repairBudget: 6 });
    },
  });
  const h = openWith(ctx);
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  const attempts = attemptsOf(h, GREETING);
  assert.deepEqual(
    attempts.map((a) => [a.status, a.failureKind]),
    [
      ['failed', 'environment'],
      ['succeeded', undefined],
    ],
  );
  const work = h.engine.read((v) => v.work(GREETING)!);
  assert.equal(work.status, 'done');
  assert.equal(work.attempt, 1, 'засчитана только попытка, исполнившая работу');
  assert.equal(h.policy.maxAttempts, 1, 'лимит не повышен');
  assert.equal(data.workflow?.repairs, 1);
  h.close();
});

test('NET10: repairBudget=0 — первый отказ environment, повтора нет, ref не продвинут', async () => {
  for (const [label, limits, reason] of [
    [
      'repairBudget=0',
      { maxAttempts: 3, repairBudget: 0 },
      /исчерпан бюджет автоматических восстановлений/,
    ],
  ] as const) {
    const ctx = hsetup({
      scenario: { writer: [networkDown, implement()], reviewer: approve() },
      policy: (p: any) => {
        Object.assign(p, limits);
      },
    });
    const before = target(ctx);
    const h = openWith(ctx);
    const data = await h.run({ graph: ctx.graph, author: 'claude' });
    const attempts = attemptsOf(h, GREETING);
    assert.equal(attempts.length, 1, label + ': повтора нет');
    assert.equal(ctx.calls('claude', 'writer'), 1, label);
    assert.equal(attempts[0]!.failureKind, 'environment', label);
    assert.notEqual(attempts[0]!.blocked, true, label);
    const work = h.engine.read((v) => v.work(GREETING)!);
    assert.equal(work.status, 'failed', label);
    assert.equal(work.failureKind, 'environment', label);
    assert.equal(work.attempt, 0, label + ': отказ окружения попытку не засчитал');
    assert.equal(h.policy.maxAttempts, limits.maxAttempts, label + ': лимит не повышен');
    assert.equal(data.workflow?.repairs ?? 0, 0, label);
    assert.deepEqual(repairEvents(h, data), [], label);
    assert.equal(data.workflow?.status, 'failed', label);
    assert.match(data.workflow?.error ?? '', reason, label);
    assert.equal(
      attempts.some((a) => a.status === 'succeeded'),
      false,
      label + ': нет ложного успеха',
    );
    assert.equal(h.result(GREETING).result.outcome, 'rejected', label);
    assert.equal(target(ctx), before, label + ': ref не продвинут');
    h.close();
  }
});

test('NET11: environment-пауза держит выдачу до восстановления; восстановление снимает только свою причину', async () => {
  // Без других причин: пока отказ окружения не разобран, соседняя готовая работа не выдаётся.
  {
    const ctx = hsetup({
      scenario: {
        writer: [
          networkDown,
          implement({ 'src/greet.js': greet, 'src/one.js': '1;\n' }),
          implement({ 'src/greet.js': greet, 'src/two.js': '2;\n' }),
        ],
        reviewer: approve(),
      },
      policy: (p: any) => (p.concurrency = 1),
      graph: (g: any) => {
        const orders = g.orders as Record<string, unknown>[];
        orders.push({
          ...orders[0],
          id: 'add-other',
          source: { connector: 'files', ref: 'add-other', revision: '1' },
          title: 'Independent order',
        });
      },
    });
    let atFailure: { control: ControlState; other: WorkState; otherAttempts: number } | undefined;
    const h: Harness = openWith(ctx, {
      hooks: {
        failed: () => {
          atFailure ??= h.engine.read((v) => ({
            control: structuredClone(v.control()),
            other: structuredClone(v.work('add-other')!),
            otherAttempts: v.attempts('add-other').length,
          }));
        },
      },
    });
    const data = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.ok(atFailure, 'отказ записан и отражён хуком');
    assert.equal(atFailure.control.paused, true);
    assert.equal(atFailure.control.pauseReason, 'runtime');
    assert.deepEqual(atFailure.control.pauseFailures, ['environment']);
    assert.equal(atFailure.other.status, 'ready');
    assert.equal(atFailure.otherAttempts, 0);
    const log = events(h);
    const paused = log.find((e) => e.type === 'control.paused' && e.payload.reason === 'runtime')!;
    const resumed = log.find(
      (e) => e.type === 'control.resumed' && e.payload.reason === 'runtime' && e.seq > paused.seq,
    )!;
    const otherClaimed = log.find((e) => e.type === 'attempt.claimed' && e.workId === 'add-other')!;
    assert.ok(paused && resumed && otherClaimed);
    assert.ok(otherClaimed.seq > resumed.seq, 'соседняя работа выдана только после снятия паузы');
    assert.deepEqual(repairEvents(h, data), ['repair:environment']);
    assert.deepEqual(
      data.works.map((w) => w.status),
      ['done', 'done'],
    );
    assert.equal(
      h.engine.read((v) => v.control().paused),
      false,
    );
    h.close();
  }

  // Пауза человека, поставленная во время сетевой попытки, остаётся после восстановления.
  {
    const ctx = hsetup({ scenario: { writer: [networkDown, implement()], reviewer: approve() } });
    const h: Harness = openWith(ctx, {
      wrap: beforeWriter((n) => {
        if (n === 0) h.engine.pause('operator');
      }),
    });
    const data = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.equal(attemptsOf(h, GREETING)[0]!.failureKind, 'environment');
    assert.deepEqual(repairEvents(h, data), ['repair:environment'], 'повтор назначен');
    const control = h.engine.read((v) => v.control());
    assert.equal(control.paused, true);
    assert.equal(control.pauseReason, 'operator', 'пауза человека не снята');
    assert.ok(!(control.pauseFailures ?? []).includes('environment'), 'своя причина снята');
    assert.equal(data.works[0]!.status, 'ready', 'поручение готово, но не выдано');
    assert.equal(ctx.calls('claude', 'writer'), 1);
    // Решение человека снимает паузу: работа продолжается обычным путём.
    h.engine.resume();
    const after = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.equal(after.works[0]!.status, 'done');
    assert.equal(ctx.calls('claude', 'writer'), 2);
    h.close();
  }

  // Причина provider-auth, записанная одновременно, остаётся после восстановления environment.
  {
    const ctx = hsetup({ scenario: { writer: [networkDown, implement()], reviewer: approve() } });
    const h: Harness = openWith(ctx, {
      wrap: beforeWriter((n) => {
        if (n === 0)
          h.store.transact('scheduler.paused', (tx) =>
            tx.setControl({
              ...tx.control(),
              paused: true,
              pauseReason: 'runtime',
              pauseFailures: ['provider-auth'],
            }),
          );
      }),
    });
    const data = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.equal(attemptsOf(h, GREETING)[0]!.failureKind, 'environment');
    assert.deepEqual(repairEvents(h, data), ['repair:environment']);
    const control = h.engine.read((v) => v.control());
    assert.equal(control.paused, true);
    assert.equal(control.pauseReason, 'runtime');
    assert.deepEqual(control.pauseFailures, ['provider-auth'], 'снята только environment');
    assert.equal(data.works[0]!.status, 'ready');
    assert.equal(ctx.calls('claude', 'writer'), 1);
    h.close();
  }
});

test('NET12: после исчерпания одинаковых повторов новый процесс сохраняет fingerprint, историю и счётчик; новой попытки нет', async () => {
  const ctx = hsetup({
    scenario: { writer: networkDown, reviewer: approve() },
    policy: (p: any) => {
      p.maxAttempts = 3;
      p.repairBudget = 2;
    },
  });
  let h = openWith(ctx);
  const first = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(first.workflow?.status, 'failed');
  const attempts = structuredClone(attemptsOf(h, GREETING));
  const work = structuredClone(h.engine.read((v) => v.work(GREETING)!));
  assert.equal(attempts.length, 2);
  h.close();

  h = openWith(ctx);
  const again = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.equal(again.workflow?.status, 'failed');
  assert.equal(again.workflow?.repairs, 1, 'счётчик восстановлений сохранён');
  assert.deepEqual(repairEvents(h, again), ['repair:environment'], 'история задания сохранена');
  assert.deepEqual(attemptsOf(h, GREETING), attempts, 'попытки и отпечатки не изменились');
  const reread = h.engine.read((v) => v.work(GREETING)!);
  assert.equal(reread.failureKind, 'environment');
  assert.equal(reread.failureFingerprint, work.failureFingerprint);
  assert.equal(reread.attempt, work.attempt);
  assert.equal(ctx.calls('claude', 'writer'), 2, 'нового вызова writer нет');
  h.close();
});

test('NET12: исторический отказ L3 с классом unknown читается без переклассификации', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  let h = openWith(ctx);
  // Запись alpha.7: тот же текст L3 был сохранён прежним классификатором как unknown.
  const { graph } = h.engine.register(ctx.graph, { trusted: () => false, reachable: () => true });
  await h.review({ kind: 'plan', graph: ctx.graph, author: 'claude' });
  h.engine.approve(graph.id, 'agent');
  h.engine.lead('alpha7');
  h.engine.resume();
  const a = h.engine.claim('alpha7')!;
  h.engine.fail(a.id, a.token, L3, { kind: 'unknown' });
  h.engine.release('alpha7');
  const stored = structuredClone(attemptsOf(h, GREETING));
  const storedWork = structuredClone(h.engine.read((v) => v.work(GREETING)!));
  const storedEvents = structuredClone(events(h));
  h.close();

  h = openWith(ctx);
  assert.deepEqual(attemptsOf(h, GREETING), stored, 'запись попытки не изменена');
  const work = h.engine.read((v) => v.work(GREETING)!);
  assert.deepEqual(work, storedWork, 'запись поручения не изменена');
  assert.equal(work.failureKind, 'unknown');
  assert.equal(stopCode(h, GREETING), 'INTERNAL', 'stopReason по сохранённому классу');
  assert.equal(h.status().works[0]!.status, 'failed');
  assert.deepEqual(events(h), storedEvents, 'чтение не пишет событий');
  assert.equal(
    h.engine.read((v) => v.attempts(GREETING)[0]!.failureKind),
    'unknown',
  );
  h.close();
});

test('NET13: reviewer CLI exit 1 с EPROTO после старта — environment, не review/unknown; accepted только после действительного ревью', async () => {
  const ctx = hsetup({
    scenario: {
      writer: implement(),
      // План, затем ревью кандидата обрывается сетью, затем обычные ревью повтора.
      reviewer: [approve(), networkDown, approve()],
    },
  });
  const before = target(ctx);
  let atFailure: { work: WorkState; attempts: AttemptState[] } | undefined;
  const h: Harness = openWith(ctx, {
    hooks: {
      failed: ({ attempt }) => {
        atFailure ??= h.engine.read((v) => ({
          work: structuredClone(v.work(attempt.workId)!),
          attempts: structuredClone(v.attempts(attempt.workId)),
        }));
      },
    },
  });
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  assert.ok(atFailure);
  assert.equal(atFailure.work.failureKind, 'environment');
  assert.notEqual(atFailure.work.status, 'done', 'accepted нет до действительного ревью');
  const failed = atFailure.attempts[0]!;
  assert.equal(failed.failureKind, 'environment', 'не review и не unknown');
  assert.notEqual(failed.blocked, true);
  assert.ok(failed.candidateSha, 'отказ на пути reviewer — после кандидата');
  assert.equal(failed.error, `codex: runtime завершился отказом: код 1: ${EPROTO}`);
  assert.equal(
    failed.evidence.some((e) => e.kind === 'review' && e.passed),
    false,
    'одобрения ревью у отказавшей попытки нет',
  );
  assert.equal(
    atFailure.attempts.some((x) => x.status === 'succeeded'),
    false,
  );
  const stored = attemptsOf(h, GREETING);
  assert.equal(stored[0]!.failureKind, 'environment');
  assert.equal(stopCode(h, GREETING, stored[0]!.id), 'RUNTIME_UNAVAILABLE');
  // Существующий общий repair:environment, а не отдельный reviewer-механизм.
  assert.deepEqual(repairEvents(h, data), ['repair:environment']);
  assert.equal(stored.length, 2);
  assertNormallyAccepted(stored[1]!);
  assert.equal(data.works[0]!.status, 'done');
  assert.notEqual(target(ctx), before);
  h.close();
});
