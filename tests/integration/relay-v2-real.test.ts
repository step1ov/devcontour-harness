/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
   независимый read-back: сырой JSON настоящего CLI проверяется assertions, а не типами. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TransportError } from '../../src/integrations/connector/transport.ts';
import {
  createTransport,
  type RelayV2CallLog,
  type RelayV2TransportOptions,
} from '../../src/integrations/relay-v2/index.ts';
import {
  createLossyRelayV2Wrapper,
  createRelayV2Fixture,
  relayV2Binary,
  relayV2Info,
  type RelayV2Project,
} from '../../scripts/acceptance/relay-v2-fixture.mjs';

/**
 * R02/R03/R04 (части транспорта) и D02 (транспортная часть) на НАСТОЯЩЕМ
 * Relay-2 CLI с изолированными временными проектами. Нет binary — тест
 * падает как BLOCKED, а не пропускается.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPGRADE = join(ROOT, '.private/integration-upgrade');
const BIN = relayV2Binary();
const INFO = relayV2Info(BIN);

function requireBinary(): string {
  if (!BIN)
    assert.fail(
      'BLOCKED: настоящий Relay-2 binary не найден. Соберите relay-2 (commit a3ee804, Bun 1.4.3) и задайте HARNESS_RELAY2_BIN',
    );
  return BIN;
}

/** Evidence пишется только при наличии локального каталога приёмки. */
function evidence(id: string, name: string, value: unknown) {
  if (!existsSync(UPGRADE)) return;
  const dir = join(UPGRADE, 'evidence', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}
const LOG = join(UPGRADE, 'logs', 'relay-v2-real-argv.jsonl');
if (existsSync(UPGRADE)) {
  mkdirSync(dirname(LOG), { recursive: true });
  writeFileSync(LOG, '');
}

const cleanups: (() => void)[] = [];
after(() => {
  for (const c of cleanups.reverse()) c();
});

function fixture(second = false) {
  const bin = requireBinary();
  const fx = createRelayV2Fixture({ bin, second });
  cleanups.push(fx.cleanup);
  return fx;
}

function open(
  project: RelayV2Project,
  test: string,
  options: RelayV2TransportOptions = {},
  extra: Record<string, unknown> = {},
) {
  const calls: RelayV2CallLog[] = [];
  const t = createTransport(
    project.settings({
      build: { sha256: INFO.sha256, ...(INFO.commit ? { commit: INFO.commit } : {}) },
      ...extra,
    }),
    {
      ...options,
      onCall: (c) => {
        calls.push(c);
        if (existsSync(dirname(LOG))) appendFileSync(LOG, `${JSON.stringify({ test, ...c })}\n`);
        options.onCall?.(c);
      },
    },
  );
  return { t, calls };
}

async function refusal(promise: Promise<unknown>): Promise<TransportError> {
  const e = await promise.then(
    () => assert.fail('ожидался отказ'),
    (x: unknown) => x,
  );
  assert.ok(e instanceof TransportError, String(e));
  return e;
}

test('R02/real: идентичность сборки — sha256 проверен, commit записан, capabilities выведены пробами (а не версией 0.0.0)', async () => {
  const fx = fixture();
  const { t, calls } = open(fx.a, 'identity');
  const id = await t.identity();
  assert.equal(id.provider, 'relay-v2-cli');
  assert.equal(id.projectId, fx.a.projectId);
  assert.equal(id.build.sha256, INFO.sha256);
  assert.equal(id.build.sha256Verified, 'true');
  assert.equal(INFO.cliVersion, '0.0.0', '--version не идентифицирует сборку');
  for (const cap of [
    'relay-2.envelope.json-v1',
    'relay-2.task.read',
    'relay-2.task.children',
    'relay-2.task.progress',
    'relay-2.task.criterion',
    'relay-2.task.comment',
    'relay-2.document.target',
    'relay-2.history.session',
    'relay-2.history.checkpoint',
    'relay-2.history.list',
  ])
    assert.ok(id.capabilities.includes(cap), cap);
  const generation = fx.a.generation();
  assert.equal(id.build.generation, String(generation), 'проверка идентичности ничего не пишет');
  assert.equal(calls.filter((c) => c.mutation).length, 0);
  assert.equal(fx.a.cli(['session', 'list']).items.length, 0, 'проверка не создаёт историю');
  evidence('R02', 'build.json', INFO);
  evidence('R02', 'identity.json', id);
});

test('R02/real: полное чтение задачи — критерии, зависимость, подзадача, документ дословно; generation до/после', async () => {
  const fx = fixture();
  const { seed } = fx.a;
  const { t, calls } = open(fx.a, 'read', { pageLimit: 1 });
  const read = await t.readTask(seed.main.key);
  const raw = fx.a.cli(['task', 'get', seed.main.key]);
  assert.equal(read.task.id, raw.id);
  assert.equal(read.task.revision, raw.revision);
  assert.equal(read.task.description, 'Main **md**');
  assert.deepEqual(
    read.task.criteria.map((c) => [c.title, c.summary, c.completed]),
    [
      ['C1', 'first', false],
      ['C2', '', false],
    ],
  );
  assert.deepEqual(read.task.dependencies, [seed.dependency.id]);
  assert.deepEqual(
    read.dependencies.map((d) => [d.key, d.finished]),
    [[seed.dependency.key, false]],
  );
  assert.deepEqual(
    read.children.map((c) => [c.key, c.finished]),
    [[seed.subtask.key, false]],
  );
  assert.equal(read.documents.length, 1);
  assert.equal(read.documents[0]!.body, seed.document.body, 'тело документа байт в байт');
  assert.equal(read.consistency.before, read.consistency.after);
  assert.equal(read.consistency.before, String(fx.a.generation()));
  assert.ok(calls.every((c) => !c.mutation));
  assert.ok(
    calls.every(
      (c) => c.argv.includes(`--config=${fx.a.config}`) && c.argv.includes('--format=json'),
    ),
  );
  evidence('R02', 'read-task.json', read);
});

test('R02/real: pagination с настоящим cursor — изменение между страницами (SNAPSHOT_CONFLICT) → полный перечит, не смешанный список', async () => {
  const fx = fixture();
  const { seed } = fx.a;
  for (const n of [2, 3])
    fx.a.cli(
      ['task', 'create', '--board=product', `--title=Sub ${n}`, `--parent=${seed.main.key}`],
      { actor: 'fixture' },
    );
  let injected = false;
  const { t, calls } = open(fx.a, 'pagination', {
    pageLimit: 1,
    onCall: (c) => {
      // Конкурентная запись сразу после первой страницы детей (не после пробы).
      if (!injected && c.argv.includes('children') && c.argv.includes('--limit=1')) {
        injected = true;
        fx.a.cli(['task', 'comment', 'add', seed.dependency.key, '--body=concurrent'], {
          actor: 'other',
        });
      }
    },
  });
  const read = await t.readTask(seed.main.key);
  assert.ok(injected);
  assert.ok(
    calls.some((c) => c.code === 'SNAPSHOT_CONFLICT'),
    'stale cursor обнаружен',
  );
  assert.deepEqual(read.children.map((c) => c.title).sort(), ['Sub 2', 'Sub 3', 'Sub task']);
  assert.notEqual(
    read.consistency.before,
    read.consistency.after,
    'generation до/после показывает изменение ядру',
  );
  evidence('R02', 'pagination-calls.json', calls);
});

test('R02/real: CAS move и конфликт с actualRevision; done guard; criterion complete/reopen; TASK_DONE', async () => {
  const fx = fixture();
  const { seed } = fx.a;
  const { t } = open(fx.a, 'cas');
  const r0 = fx.a.cli(['task', 'get', seed.main.key]).revision as number;
  const moved = await t.move(seed.main.key, { column: 'in-progress', ifRevision: r0 });
  assert.equal(moved.revision, r0 + 1);
  const stale = await refusal(t.move(seed.main.key, { column: 'review', ifRevision: r0 }));
  assert.equal(stale.kind, 'conflict');
  assert.equal(stale.details.code, 'REVISION_CONFLICT');
  assert.equal(stale.details.actualRevision, r0 + 1);
  assert.equal(
    fx.a.cli(['task', 'get', seed.main.key]).data.column,
    'in-progress',
    'отклонённая запись не применена',
  );

  const guard = await refusal(t.move(seed.main.key, { column: 'done', ifRevision: r0 + 1 }));
  assert.equal(guard.kind, 'refused');
  assert.equal(guard.details.code, 'TASK_INCOMPLETE');

  let rev = r0 + 1;
  for (const c of seed.criteria)
    rev = (
      await t.setCriterion(seed.main.key, { criterionId: c.id, completed: true, ifRevision: rev })
    ).revision;
  assert.equal(rev, r0 + 3);
  const again = await t.setCriterion(seed.main.key, {
    criterionId: seed.criteria[0]!.id,
    completed: true,
    ifRevision: rev,
  });
  assert.equal(again.revision, rev, 'повтор complete — no-op у Relay-2');
  rev = (
    await t.setCriterion(seed.main.key, {
      criterionId: seed.criteria[0]!.id,
      completed: false,
      ifRevision: rev,
    })
  ).revision;
  rev = (
    await t.setCriterion(seed.main.key, {
      criterionId: seed.criteria[0]!.id,
      completed: true,
      ifRevision: rev,
    })
  ).revision;
  // Блокеры остались (зависимость и подзадача): done guard не обходится.
  assert.equal(
    (await refusal(t.move(seed.main.key, { column: 'done', ifRevision: rev }))).details.code,
    'TASK_INCOMPLETE',
  );
  for (const k of [seed.dependency.key, seed.subtask.key]) {
    const r = fx.a.cli(['task', 'get', k]).revision as number;
    await t.move(k, { column: 'done', ifRevision: r });
  }
  const done = await t.move(seed.main.key, { column: 'done', ifRevision: rev });
  assert.equal(fx.a.cli(['task', 'progress', seed.main.key]).completed, true);
  const locked = await refusal(
    t.setCriterion(seed.main.key, {
      criterionId: seed.criteria[1]!.id,
      completed: false,
      ifRevision: done.revision,
    }),
  );
  assert.equal(locked.kind, 'refused');
  assert.equal(locked.details.code, 'TASK_DONE');
  const read = await t.readTask(seed.main.key);
  assert.equal(read.task.column, 'done');
  assert.ok(read.dependencies.every((d) => d.finished) && read.children.every((c) => c.finished));
  evidence('R02', 'cas-and-guards.json', {
    r0,
    stale: stale.details,
    guard: guard.details,
    locked: locked.details,
    final: read.task,
  });
});

test('R02/real: комментарий append-only — повтор создаёт второй, ревизия задачи не меняется, generation растёт', async () => {
  const fx = fixture();
  const { seed } = fx.a;
  const { t, calls } = open(fx.a, 'comments');
  const rev = fx.a.cli(['task', 'get', seed.main.key]).revision as number;
  const g0 = fx.a.generation();
  const body = 'harness-result marker=op-1\n\n`sha` $(not expanded)';
  const c1 = await t.addComment(seed.main.key, { title: 'Result', body });
  const g1 = fx.a.generation();
  const c2 = await t.addComment(seed.main.key, { title: 'Result', body });
  assert.notEqual(c1.commentId, c2.commentId);
  assert.ok(g1 > g0 && fx.a.generation() > g1);
  assert.equal(fx.a.cli(['task', 'get', seed.main.key]).revision, rev);
  const listed = await t.listComments(seed.main.key);
  assert.deepEqual(
    listed.map((c) => [c.id, c.body, c.actor]),
    [
      [c1.commentId, body, 'harness'],
      [c2.commentId, body, 'harness'],
    ],
  );
  const add = calls.filter((c) => c.operation === 'task.comment' && c.mutation);
  assert.equal(add.length, 2);
  assert.ok(
    add.every(
      (c) =>
        c.argv.includes('--actor=harness') && !c.argv.some((a) => a.startsWith('--if-revision')),
    ),
  );
  evidence('R02', 'comments.json', { g0, g1, comments: listed });
});

test('R04/relay-v2: история — start, intent, повторные checkpoints как мутации, fork/attach/child complete, result с accept, complete; устаревшая ревизия → conflict', async () => {
  const fx = fixture();
  const { seed } = fx.a;
  const { t } = open(fx.a, 'history');
  const marker = `hx-${Date.now()}`;
  const s = await t.startSession({
    title: `Attempt ${marker}`,
    description: `task ${seed.main.key}`,
    client: 'harness',
    sourceSessionId: 'attempt-1',
  });
  assert.equal(s.session.status, 'open');
  assert.equal(s.session.revision, 1);
  const run = s.runId!;
  const intent = await t.openIntent(s.session.id, {
    runId: run,
    ifRevision: 1,
    title: 'Execute',
    body: 'plan',
    references: [seed.main.key],
  });
  assert.equal(intent.checkpoint!.kind, 'intent');
  assert.equal(intent.session.revision, 2);
  const p1 = await t.checkpoint(intent.checkpoint!.id, 'progress', {
    runId: run,
    ifRevision: 2,
    title: 'P',
    body: 'same',
  });
  const p2 = await t.checkpoint(intent.checkpoint!.id, 'progress', {
    runId: run,
    ifRevision: 3,
    title: 'P',
    body: 'same',
  });
  assert.notEqual(
    p1.checkpoint!.id,
    p2.checkpoint!.id,
    'повтор с тем же содержанием — новая запись',
  );
  assert.equal(p2.session.revision, 4);
  const stale = await refusal(
    t.checkpoint(intent.checkpoint!.id, 'progress', {
      runId: run,
      ifRevision: 3,
      title: 'P',
      body: 'same',
    }),
  );
  assert.equal(stale.kind, 'conflict');
  assert.equal(stale.details.code, 'REVISION_CONFLICT');
  assert.equal(stale.details.actualRevision, 4);

  const fork = await t.fork(intent.checkpoint!.id, {
    runId: run,
    ifRevision: 4,
    title: 'Child',
    description: `child of ${marker}`,
  });
  assert.equal(fork.childSession!.status, 'pending');
  assert.equal(fork.childSession!.parentSessionId, s.session.id);
  assert.equal(fork.session.revision, 5);
  const attached = await t.attach(fork.childSession!.id, {
    ifRevision: fork.childSession!.revision,
    client: 'harness',
  });
  assert.equal(attached.session.status, 'open');
  const childDone = await t.finishSession(fork.childSession!.id, 'complete', {
    runId: attached.runId!,
    ifRevision: attached.session.revision,
    result: 'child ok',
  });
  assert.equal(childDone.session.status, 'completed');
  const parentRev = (await t.getSession(s.session.id)).revision;
  // Закрыть intent нельзя без принятия результата ребёнка.
  const unaccepted = await refusal(
    t.checkpoint(intent.checkpoint!.id, 'result', {
      runId: run,
      ifRevision: parentRev,
      title: 'R',
      body: 'done',
    }),
  );
  assert.equal(unaccepted.kind, 'conflict');
  const result = await t.checkpoint(intent.checkpoint!.id, 'result', {
    runId: run,
    ifRevision: parentRev,
    title: 'R',
    body: 'done',
    summary: 'sha abc',
    checks: 'npm test: pass',
    acceptedSessionIds: [fork.childSession!.id],
  });
  assert.equal(result.checkpoint!.kind, 'result');
  const fin = await t.finishSession(s.session.id, 'complete', {
    runId: run,
    ifRevision: result.session.revision,
    result: 'accepted',
  });
  assert.equal(fin.session.status, 'completed');
  assert.equal(fin.session.result, 'accepted');
  const done = await refusal(
    t.finishSession(s.session.id, 'cancel', {
      runId: run,
      ifRevision: fin.session.revision,
      result: 'x',
    }),
  );
  assert.equal(done.kind, 'conflict');

  const cps = await t.checkpoints(s.session.key);
  assert.deepEqual(
    cps.map((c) => c.kind),
    ['intent', 'progress', 'progress', 'result'],
  );
  assert.ok(cps.every((c) => c.sessionId === s.session.id && c.runId === run));
  const found = await t.findSessions(marker);
  assert.deepEqual(found.map((f) => f.id).sort(), [s.session.id, fork.childSession!.id].sort());
  assert.deepEqual((await t.findSessions(`${marker}-absent`)).length, 0);
  // Независимый read-back тем же binary.
  const history = fx.a.cli(['session', 'history', s.session.id]).items as {
    data: { kind: string };
  }[];
  assert.deepEqual(history.filter((h) => h.data.kind).length >= 4, true);
  assert.equal(fx.a.cli(['session', 'get', s.session.id]).data.status, 'completed');
  evidence('R04', 'relay-v2-history.json', {
    session: fin.session,
    child: childDone.session,
    checkpoints: cps,
    stale: stale.details,
  });
});

test('R04/relay-v2: после takeover устаревший run не пишет и не завершает сессию (fencing), новый владелец завершает', async () => {
  const fx = fixture();
  const { t } = open(fx.a, 'takeover');
  const s = await t.startSession({ title: 'Takeover', description: '', client: 'harness' });
  const old = s.runId!;
  const taken = await t.takeover(s.session.id, {
    ifRevision: 1,
    reason: 'controller restart',
    client: 'harness',
  });
  assert.notEqual(taken.runId, old);
  assert.equal(taken.session.currentRunId, taken.runId);
  const write = await refusal(
    t.openIntent(s.session.id, {
      runId: old,
      ifRevision: taken.session.revision,
      title: 'I',
      body: 'B',
    }),
  );
  assert.equal(write.kind, 'conflict');
  assert.equal(write.details.code, 'CONFLICT');
  const finish = await refusal(
    t.finishSession(s.session.id, 'complete', {
      runId: old,
      ifRevision: taken.session.revision,
      result: 'stale',
    }),
  );
  assert.equal(finish.kind, 'conflict');
  const current = await t.getSession(s.session.id);
  assert.equal(current.status, 'open');
  assert.equal(current.revision, taken.session.revision, 'устаревший владелец ничего не записал');
  const cancelled = await t.finishSession(s.session.id, 'cancel', {
    runId: taken.runId!,
    ifRevision: current.revision,
    result: 'cancelled by harness',
  });
  assert.equal(cancelled.session.status, 'cancelled');
  evidence('R04', 'relay-v2-takeover.json', {
    old,
    taken: taken.session,
    write: write.details,
    finish: finish.details,
    cancelled: cancelled.session,
  });
});

function gitWorktree(): { repo: string; worktree: string; cleanup: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'relay-v2-wt-')));
  const repo = join(base, 'repo');
  const worktree = join(base, 'attempt');
  mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: base },
    });
    assert.equal(r.status, 0, r.stderr);
  };
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'x\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', '-b', 'attempt', worktree);
  return { repo, worktree, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (name === '.git') continue;
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

function snapshot(p: RelayV2Project & { seed: { main: { key: string } } }) {
  const task = p.cli(['task', 'get', p.seed.main.key]);
  return {
    projectId: p.projectId,
    generation: p.generation(),
    revision: task.revision as number,
    column: task.data.column as string,
    comments: (task.data.comments as unknown[]).length,
    sessions: (p.cli(['session', 'list']).items as unknown[]).length,
  };
}

test('R03/relay-v2: cwd в новом Git worktree, где по cwd обнаружился бы другой проект, — все операции идут в настроенный проект; второй не тронут; новых файлов Relay в worktree нет', async () => {
  const fx = fixture(true);
  const a = fx.a;
  const b = fx.b!;
  assert.equal(a.seed.main.key, b.seed.main.key, 'одинаковые ключи задач в двух проектах');
  const wt = gitWorktree();
  cleanups.push(wt.cleanup);
  // Проект B обнаруживался бы по cwd: его relay.config.json лежит в worktree.
  copyFileSync(b.config, join(wt.worktree, 'relay.config.json'));
  const discovered = spawnSync(a.bin, ['storage', 'status', '--format=json'], {
    cwd: wt.worktree,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...b.env },
    encoding: 'utf8',
  });
  assert.equal(
    JSON.parse(discovered.stdout).data.projectId,
    b.projectId,
    'контроль: без --config cwd выбрал бы B',
  );
  const filesBefore = listFiles(wt.worktree);
  const beforeA = snapshot(a);
  const beforeB = snapshot(b);

  const { t, calls } = open(a, 'R03', { cwd: wt.worktree });
  const id = await t.identity();
  assert.equal(id.projectId, a.projectId);
  const read = await t.readTask(a.seed.main.key);
  assert.equal(read.task.id, a.seed.main.id);
  assert.notEqual(read.task.id, b.seed.main.id);
  await t.move(a.seed.main.key, { column: 'in-progress', ifRevision: read.task.revision });
  await t.addComment(a.seed.main.key, { title: 'r03', body: 'comment to A' });
  const s = await t.startSession({ title: 'R03 attempt', description: '', client: 'harness' });
  await t.finishSession(s.session.id, 'cancel', {
    runId: s.runId!,
    ifRevision: s.session.revision,
    result: 'r03',
  });

  const afterA = snapshot(a);
  const afterB = snapshot(b);
  assert.deepEqual(afterB, beforeB, 'второй проект неизменён');
  assert.equal(afterA.column, 'in-progress');
  assert.equal(afterA.comments, beforeA.comments + 1);
  assert.equal(afterA.sessions, beforeA.sessions + 1);
  assert.ok(afterA.generation > beforeA.generation);
  assert.deepEqual(listFiles(wt.worktree), filesBefore, 'в worktree не создано config/DB');
  assert.ok(!listFiles(wt.worktree).some((f) => /sqlite|\.relay/.test(f)));
  for (const c of calls) {
    assert.equal(c.cwd, wt.worktree);
    assert.ok(c.argv.includes(`--config=${a.config}`), c.argv.join(' '));
    if (c.mutation) assert.ok(c.argv.includes('--actor=harness'));
  }
  evidence(
    'R03',
    'argv.json',
    calls.map((c) => ({
      operation: c.operation,
      mutation: c.mutation,
      argv: c.argv.slice(1),
      cwd: c.cwd,
      exit: c.exitCode,
    })),
  );
  evidence('R03', 'read-back.json', {
    worktreeFiles: filesBefore,
    a: { before: beforeA, after: afterA },
    b: { before: beforeB, after: afterB },
  });
});

test('R03/relay-v2: ожидаемый projectId не совпадает с config — чтение и мутации заблокированы, ни один проект не изменён', async () => {
  const fx = fixture(true);
  const a = fx.a;
  const b = fx.b!;
  const beforeA = snapshot(a);
  const beforeB = snapshot(b);
  // Config проекта A, но ожидается projectId проекта B.
  const { t, calls } = open(a, 'R03-mismatch', {}, { projectId: b.projectId });
  const e = await refusal(t.identity());
  assert.equal(e.kind, 'refused');
  assert.equal(e.details.code, 'PROJECT_ID_MISMATCH');
  const rev = beforeA.revision;
  const results = await Promise.allSettled([
    t.move(a.seed.main.key, { column: 'review', ifRevision: rev }),
    t.addComment(a.seed.main.key, { title: 'x', body: 'must not land' }),
    t.startSession({ title: 'must not land', description: '', client: 'harness' }),
    t.readTask(a.seed.main.key),
  ]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.ok(
      r.reason instanceof TransportError && r.reason.details.code === 'PROJECT_ID_MISMATCH',
    );
  }
  assert.equal(calls.filter((c) => c.mutation).length, 0, 'ни одной мутации не отправлено');
  assert.deepEqual(snapshot(a), beforeA);
  assert.deepEqual(snapshot(b), beforeB);
  evidence('R03', 'project-id-mismatch.json', {
    error: { kind: e.kind, ...e.details, message: e.message },
    a: beforeA,
    b: beforeB,
    calls: calls.map((c) => c.argv.slice(1)),
  });
});

test('D02/relay-v2 (транспорт): получатель записал комментарий, ответ потерян — транспорт не объявляет успех; read-back находит ровно одну запись', async () => {
  const fx = fixture();
  const { seed } = fx.a;
  const dir = mkdtempSync(join(tmpdir(), 'relay-v2-lossy-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [mode, kind] of [
    ['drop', 'protocol'],
    ['hang', 'uncertain'],
  ] as const) {
    const marker = `op-${mode}-${Date.now()}`;
    const wrapper = createLossyRelayV2Wrapper({
      bin: fx.a.bin,
      dir: join(dir, mode),
      match: ['comment', 'add', marker],
      mode,
    });
    // Обёртка — другой файл: sha256 сборки не задаётся, идентичность проверяется пробами.
    const t = createTransport(
      { ...fx.a.settings(), binary: wrapper.path, timeoutMs: 4000 },
      { killGraceMs: 200 },
    );
    const before = (await t.listComments(seed.main.key)).filter((c) =>
      c.body.includes(marker),
    ).length;
    assert.equal(before, 0);
    const e = await refusal(
      t.addComment(seed.main.key, { title: 'Result', body: `result ${marker}` }),
    );
    assert.equal(e.kind, kind);
    assert.equal(e.details.mutation, true);
    assert.equal(wrapper.hits(), 1, 'настоящая команда выполнена один раз');
    const found = (await t.listComments(seed.main.key)).filter((c) => c.body.includes(marker));
    assert.equal(found.length, 1, 'у получателя ровно одна запись с marker');
    evidence('D02', `relay-v2-${mode}.json`, {
      error: { kind: e.kind, ...e.details, message: e.message },
      readBack: found,
    });
  }
});
