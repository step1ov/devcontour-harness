/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call --
 * Тест правит сырой JSON политики/графа примера и читает JSON-ответ CLI как есть.
 */
/**
 * H1-03, H1-05: `harness explain` настоящим subprocess CLI над состоянием,
 * которое оставили настоящие прогоны. Codex и claude — fixture executables
 * (`tests/fixtures/bin/fake-claude`/`fake-codex`): ответы моделей и отказы
 * runtime (exit 1 с EPROTO, «Not logged in», непригодный вывод) запрограммированы
 * сценарием, живых моделей нет. Gates, JUnit и Git — настоящие.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executionPolicySchema,
  exitCodes,
  workGraphSchema,
  type ExecutionPolicy,
} from '../src/contracts/index.ts';
import { explainDataSchema } from '../src/contracts/cli.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { Harness } from '../src/control/harness.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { diagnoseState } from '../src/explain/diagnose.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import type { StopDiagnosis } from '../src/projections/stop.ts';
import { approve, bin, implement } from './runner-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const example = fileURLToPath(new URL('../examples/single-task', import.meta.url));
const GREETING = 'add-greeting';
/** Точный текст отказа runtime из L3: запуск состоялся, затем exit 1 с сетевой диагностикой. */
const EPROTO =
  'API Error: EPROTO: The TLS handshake failed. Does the server speak TLS on this port?';
const networkDown = { exit: 1, stderr: EPROTO };
const wrongGreet = "exports.greet = (name) => 'Hi, ' + name;\n";

interface Scenario {
  writer?: unknown;
  reviewer?: unknown;
}

/** Пример пакета с собственным Git; codex/claude — подставные fixture executables. */
function project(
  scenario: Scenario,
  patchPolicy: (p: any) => void = () => {},
  patchGraph: (g: any) => void = () => {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-cli-explain-')));
  const app = join(root, 'greeting');
  cpSync(example, app, { recursive: true });
  const scenarioPath = join(root, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const policyPath = join(app, 'policy.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  policy.isolation = { mode: 'none', domains: [] };
  policy.environment = { values: { FIXTURE_SCENARIO: scenarioPath } };
  patchPolicy(policy);
  writeFileSync(policyPath, JSON.stringify(policy, null, 2));
  const graphPath = join(app, 'graph.json');
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  patchGraph(graph);
  writeFileSync(graphPath, JSON.stringify(graph, null, 2));
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
  const harness = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd: app,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        HARNESS_CLAUDE_BIN: bin('fake-claude'),
        HARNESS_CODEX_BIN: bin('fake-codex'),
        ...env,
      },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const json = (args: string[], env?: Record<string, string>) => {
    const r = harness(args, env);
    return { ...r, json: JSON.parse(r.stdout) as { ok: boolean; data: any; error?: any } };
  };
  const state = join(root, 'state');
  const parsedPolicy = (): ExecutionPolicy =>
    executionPolicySchema.parse(JSON.parse(readFileSync(policyPath, 'utf8')));
  return { root, app, git, harness, json, state, scenarioPath, policy: parsedPolicy };
}
type Project = ReturnType<typeof project>;

const run = (p: Project, ...extra: string[]) =>
  p.json(['run', '--graph', 'graph.json', '--policy', 'policy.json', '--state', p.state, ...extra]);

/** Неизменность при чтении: sha базы, число событий, refs, счётчики вызовов fixture. */
function snapshot(p: Project) {
  const db = join(p.state, 'state.sqlite');
  const sha = (file: string) =>
    createHash('sha256')
      .update(existsSync(file) ? readFileSync(file) : '')
      .digest('hex');
  // Данные — база и журнал WAL (отсутствующий журнал равен пустому). Индекс
  // `-shm` — разделяемая память читателей SQLite, а не данные состояния.
  const files = { 'state.sqlite': sha(db), 'state.sqlite-wal': sha(db + '-wal') };
  const store = new SqliteExecutionStore(db, 'snapshot', { readOnly: true });
  let events: number;
  try {
    events = store.events(0, 1_000_000).length;
  } finally {
    store.close();
  }
  const counters = Object.fromEntries(
    readdirSync(dirname(p.scenarioPath))
      .filter((f) => f.startsWith(basename(p.scenarioPath)) && f.endsWith('.count'))
      .map((f) => [f, readFileSync(join(dirname(p.scenarioPath), f), 'utf8')]),
  );
  return {
    files,
    events,
    refs: p.git('for-each-ref', '--format=%(refname) %(objectname)'),
    counters,
    stateEntries: readdirSync(p.state)
      .filter((f) => !/^state\.sqlite-(wal|shm)$/.test(f))
      .sort(),
  };
}

/**
 * `explain` JSON и `--human` настоящим CLI; данные равны `diagnoseState`
 * библиотеки с теми же fixture executables; до и после всё неизменно.
 */
async function explain(
  p: Project,
  options: { env?: Record<string, string>; work?: string; codexBin?: string } = {},
) {
  const args = ['explain', '--state', p.state, '--policy', 'policy.json'];
  if (options.work) args.push('--work', options.work);
  const before = snapshot(p);
  const out = p.json(args, options.env);
  assert.equal(out.status, exitCodes.ok, out.stderr);
  assert.equal(out.json.ok, true);
  const data = explainDataSchema.parse(out.json.data);
  const human = p.harness([...args, '--human'], options.env);
  assert.equal(human.status, out.status, 'тот же exit code у --human');
  assert.throws(() => JSON.parse(human.stdout) as unknown, 'при --human на stdout текст, не JSON');
  const lib = await diagnoseState({
    stateDir: p.state,
    policy: p.policy(),
    baseDir: p.app,
    ...(options.work ? { workId: options.work } : {}),
    adapters: {
      claude: cliAdapter('claude', { executable: bin('fake-claude'), toolProfiles: {} }),
      codex: cliAdapter('codex', {
        executable: options.codexBin ?? bin('fake-codex'),
        toolProfiles: {},
      }),
    },
  });
  assert.deepEqual(data, lib, 'данные CLI равны diagnoseState библиотеки');
  for (const d of data.diagnoses) {
    const head = `${d.workId ?? '—'} ${d.code} [${d.cause}/${d.phase}] → ${d.actor ?? '—'}: ${d.action}`;
    assert.ok(human.stdout.includes(head + '\n  ' + d.message), `--human: ${head}`);
  }
  assert.deepEqual(snapshot(p), before, 'explain ничего не меняет');
  return data.diagnoses;
}

const shape = (d: StopDiagnosis) => [d.code, d.cause, d.phase, d.actor, d.action, d.retryPlanned];
const attemptsOf = (p: Project) => {
  const store = new SqliteExecutionStore(join(p.state, 'state.sqlite'), 'probe', {
    readOnly: true,
  });
  try {
    return store.read((v) => v.attempts(GREETING));
  } finally {
    store.close();
  }
};
const only = (diagnoses: StopDiagnosis[]) => {
  assert.equal(diagnoses.length, 1, JSON.stringify(diagnoses, null, 2));
  return diagnoses[0]!;
};

/**
 * Прогон, прерванный сразу после отказа: задание графа поставлено, затем
 * один шаг очереди (`once`) — решение о повторе ещё не исполнено. Так
 * выглядит состояние, которое застаёт `explain`, если controller остановлен
 * между отказом и восстановлением. Вызовы runtime — те же fixture subprocess.
 */
async function interruptedAfterFailure(p: Project) {
  const policy = p.policy();
  const h = Harness.open({
    stateDir: p.state,
    policy,
    baseDir: p.app,
    adapters: {
      claude: cliAdapter('claude', {
        executable: bin('fake-claude'),
        toolProfiles: policy.toolProfiles,
      }),
      codex: cliAdapter('codex', {
        executable: bin('fake-codex'),
        toolProfiles: policy.toolProfiles,
      }),
    },
  });
  try {
    const graph = workGraphSchema.parse(
      JSON.parse(readFileSync(join(p.app, 'graph.json'), 'utf8')),
    );
    const { graph: registered } = h.engine.register(graph, {
      trusted: () => false,
      reachable: () => true,
    });
    h.workflows.start({ kind: 'graph', id: registered.id, authorRuntime: 'claude' });
    await h.run({ graph, author: 'claude', once: true });
  } finally {
    h.close();
  }
}

test('H1-03: writer exit 1 с EPROTO, повтор разрешён — environment/implementation, controller/retry, retryPlanned', async () => {
  const p = project({ writer: [networkDown, implement()], reviewer: approve() }, (x) => {
    x.maxAttempts = 3;
    x.repairBudget = 2;
  });
  await interruptedAfterFailure(p);
  const [attempt] = attemptsOf(p);
  assert.equal(attempt!.failureKind, 'environment', 'класс поставлен в точке отказа');
  const d = only(await explain(p));
  assert.deepEqual(shape(d), [
    'RUNTIME_UNAVAILABLE',
    'environment',
    'implementation',
    'controller',
    'retry',
    true,
  ]);
  assert.equal(d.workId, GREETING);
  assert.equal(d.runId, attempt!.id);
  assert.deepEqual(d.evidence, [{ kind: 'attempt', id: attempt!.id }]);
  assert.match(d.message, /EPROTO/);
});

test('H1-03: writer EPROTO после исчерпания одинаковых повторов — user/fix-environment, повтора нет', async () => {
  const p = project({ writer: networkDown, reviewer: approve() }, (x) => {
    x.maxAttempts = 3;
    x.repairBudget = 2;
  });
  const r = run(p, '--author', 'claude');
  assert.equal(r.status, exitCodes.refused, r.stderr);
  const attempts = attemptsOf(p);
  assert.equal(attempts.length, 2, 'один repair:environment, затем остановка');
  const d = only(await explain(p));
  assert.deepEqual(shape(d), [
    'RUNTIME_UNAVAILABLE',
    'environment',
    'implementation',
    'user',
    'fix-environment',
    false,
  ]);
  assert.equal(d.runId, attempts.at(-1)!.id);
});

test('H1-03/NET13: reviewer exit 1 с EPROTO — environment, phase review', async () => {
  const p = project({ writer: implement(), reviewer: [approve(), networkDown] }, (x) => {
    x.repairBudget = 0;
  });
  const r = run(p, '--author', 'claude');
  assert.equal(r.status, exitCodes.refused, r.stderr);
  assert.equal(attemptsOf(p)[0]!.failureKind, 'environment');
  const d = only(await explain(p));
  assert.deepEqual(shape(d), [
    'RUNTIME_UNAVAILABLE',
    'environment',
    'review',
    'user',
    'fix-environment',
    false,
  ]);
});

test('H1-03: writer «Not logged in» — provider-auth, user/fix-access', async () => {
  const p = project({
    writer: { started: false, exit: 1, stderr: 'Not logged in · Please run /login' },
    reviewer: approve(),
  });
  run(p, '--author', 'claude');
  assert.equal(attemptsOf(p)[0]!.failureKind, 'provider-auth');
  const d = only(await explain(p));
  assert.deepEqual(shape(d), [
    'RUNTIME_UNAVAILABLE',
    'provider-auth',
    'implementation',
    'user',
    'fix-access',
    false,
  ]);
});

test('H1-03: непригодный вывод writer — INTERNAL/unknown, user/user-decision', async () => {
  const p = project({ writer: { raw: 'not json at all' }, reviewer: approve() });
  run(p, '--author', 'claude');
  assert.equal(attemptsOf(p)[0]!.failureKind, 'unknown');
  const d = only(await explain(p));
  assert.deepEqual(shape(d), [
    'INTERNAL',
    'unknown',
    'implementation',
    'user',
    'user-decision',
    false,
  ]);
});

test('H1-03: непригодный отчёт reviewer — REVIEW_PROTOCOL_INVALID, review, user/user-decision', async () => {
  const p = project({ writer: implement(), reviewer: [approve(), { raw: '{broken' }] });
  run(p, '--author', 'claude');
  assert.equal(attemptsOf(p)[0]!.failureKind, 'review-protocol');
  const d = only(await explain(p));
  assert.deepEqual(shape(d), [
    'REVIEW_PROTOCOL_INVALID',
    'review-protocol',
    'review',
    'user',
    'user-decision',
    false,
  ]);
});

test('H1-03: неверная реализация — GATE_FAILED/gates; повтор разрешён — controller/retry, исчерпан — lead/diagnose-failure; evidence провала с sha', async () => {
  const retry = project({ writer: implement({ 'src/greet.js': wrongGreet }), reviewer: approve() });
  await interruptedAfterFailure(retry);
  const planned = only(await explain(retry));
  assert.deepEqual(shape(planned), ['GATE_FAILED', 'gate', 'gates', 'controller', 'retry', true]);

  const p = project(
    { writer: implement({ 'src/greet.js': wrongGreet }), reviewer: approve() },
    (x) => {
      x.repairBudget = 0;
    },
  );
  const r = run(p, '--author', 'claude');
  assert.equal(r.status, exitCodes.refused, r.stderr);
  const d = only(await explain(p));
  assert.deepEqual(shape(d), ['GATE_FAILED', 'gate', 'gates', 'lead', 'diagnose-failure', false]);
  const attempt = attemptsOf(p)[0]!;
  const failed = attempt.evidence.filter((e) => !e.passed);
  assert.ok(failed.length > 0);
  assert.deepEqual(d.evidence, [
    { kind: 'attempt', id: attempt.id },
    ...failed.map((e) => ({ kind: 'evidence', id: e.id, sha: e.sha })),
  ]);
});

test('H1-03: расход writer (costUsd сценария) сверх budgets — BUDGET_EXHAUSTED, claim, user/raise-budget', async () => {
  const p = project({ writer: { ...implement(), costUsd: 5 }, reviewer: approve() }, (x) => {
    x.budgets = { work: { usd: 3 }, onUnknown: 'continue' };
  });
  run(p, '--author', 'claude');
  assert.equal(attemptsOf(p)[0]!.failureKind, 'budget');
  const d = only(await explain(p));
  assert.deepEqual(shape(d), [
    'BUDGET_EXHAUSTED',
    'budget',
    'claim',
    'user',
    'raise-budget',
    false,
  ]);
});

test('H1-03: действующая роль controller другого процесса — CONTROLLER_BUSY, lead/wait; роль цела', async () => {
  const p = project({ writer: implement(), reviewer: approve() });
  assert.equal(run(p).status, exitCodes.ok);
  const policy = p.policy();
  const other = new Engine({
    host: standaloneHost(new SqliteExecutionStore(join(p.state, 'state.sqlite'), 'other'), policy),
    policy,
  });
  try {
    assert.equal(other.lead('occupied-controller'), true);
    const d = only(await explain(p));
    assert.deepEqual(shape(d), [
      'CONTROLLER_BUSY',
      'controller-busy',
      'claim',
      'lead',
      'wait',
      false,
    ]);
    assert.equal(d.workId, undefined);
    assert.match(d.message, /occupied-controller/);
    assert.equal(
      other.read((v) => v.controller()?.owner),
      'occupied-controller',
    );
  } finally {
    other.release('occupied-controller');
    other.host.store.close();
  }
});

/** Два поручения: первое принято шагом `--once`, второе свободно; затем пауза оператора. */
function pausedProject() {
  const p = project(
    {
      writer: [implement(), implement({ 'src/farewell.js': 'exports.bye = () => "Bye";\n' })],
      reviewer: approve(),
    },
    () => {},
    (g) => {
      g.orders.push({
        ...g.orders[0],
        id: 'add-farewell',
        source: { connector: 'files', ref: 'add-farewell', revision: '1' },
        title: 'Add a farewell function',
        dependsOn: [GREETING],
      });
    },
  );
  assert.equal(run(p, '--once').status, exitCodes.ok);
  assert.equal(p.json(['pause', '--state', p.state]).json.data.control.paused, true);
  return p;
}

test('H1-03: пауза оператора — PAUSED/operator-pause, user/resume-queue; принятое поручение диагноза не даёт', async () => {
  const p = pausedProject();
  const d = only(await explain(p));
  assert.deepEqual(shape(d), ['PAUSED', 'operator-pause', 'claim', 'user', 'resume-queue', false]);
  assert.equal(d.workId, 'add-farewell');
});

test('H1-03: HARNESS_CODEX_BIN=/nonexistent — runtime-missing первым (K3), evidence doctor', async () => {
  const p = pausedProject();
  const diagnoses = await explain(p, {
    env: { HARNESS_CODEX_BIN: '/nonexistent' },
    codexBin: '/nonexistent',
  });
  assert.equal(diagnoses.length, 2);
  assert.deepEqual(shape(diagnoses[0]!), [
    'RUNTIME_UNAVAILABLE',
    'runtime-missing',
    'preflight',
    'user',
    'fix-environment',
    false,
  ]);
  assert.deepEqual(diagnoses[0]!.evidence, [{ kind: 'doctor', id: 'codex' }]);
  assert.equal(diagnoses[1]!.workId, 'add-farewell');
});

test('H1-03: --work — только это поручение; неизвестный id — NOT_FOUND, exit 3', async () => {
  const p = pausedProject();
  assert.equal(only(await explain(p, { work: 'add-farewell' })).workId, 'add-farewell');
  assert.deepEqual(await explain(p, { work: GREETING }), [], 'принятое — без диагноза');
  const before = snapshot(p);
  const r = p.json(['explain', '--state', p.state, '--policy', 'policy.json', '--work', 'nope']);
  assert.equal(r.status, exitCodes.refused);
  assert.equal(r.json.error.code, 'NOT_FOUND');
  assert.deepEqual(snapshot(p), before);
});

test('H1-03/H1-05: нет state — NOT_FOUND, каталог не создан; --human отказа — тот же JSON-конверт и exit', () => {
  const p = project({ writer: implement(), reviewer: approve() });
  const missing = join(p.root, 'no-state');
  const args = ['explain', '--state', missing, '--policy', 'policy.json'];
  const r = p.json(args);
  assert.equal(r.status, exitCodes.refused);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'NOT_FOUND');
  assert.equal(existsSync(missing), false, 'каталог состояния не создан');
  const human = p.harness([...args, '--human']);
  assert.equal(human.status, r.status);
  assert.deepEqual(JSON.parse(human.stdout), r.json, 'отказ при --human — тот же конверт');
  assert.equal(existsSync(missing), false);
  // --human только у init и explain.
  assert.equal(p.harness(['status', '--state', missing, '--human']).status, exitCodes.input);
});
