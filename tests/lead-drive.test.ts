import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestOf, type InputOutcome } from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { DRIVE_EXIT_CODES, driveLead, parseAgentTemplate } from '../src/control/drive.ts';
import { leadDriveDataSchema } from '../src/contracts/cli.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';
import { example } from './fixtures.ts';

const AGENT = fileURLToPath(new URL('./fixtures/lead-drive/agent.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const GOALS = 'ЦЕЛИ ОПЕРАТОРА: выпуск принят и закрыт';

function accept(e: Engine, id: string, token: string) {
  e.phase(id, token, 'verifying', { candidateSha: sha('c') });
  for (const phase of ['candidate', 'integration'] as const) {
    const at = phase === 'candidate' ? sha('c') : sha('d');
    if (phase === 'integration') e.phase(id, token, 'integrating', { integrationSha: at });
    for (const kind of ['test', 'review'] as const)
      e.evidence(id, token, {
        kind,
        phase,
        sha: at,
        gate: kind === 'test' ? 'unit' : 'independent-review',
        passed: true,
        command: ['x'],
        exitCode: 0,
        log: '',
        digest: digestOf(kind + phase),
        summary: 'ok',
        ...(kind === 'review' ? { findings: [] } : {}),
      });
  }
  e.finish(id, token, sha('d'));
}

/** Вопрос исполнителя серьёзности 8 (как в tests/input-request.test.ts). */
const questionOutcome = (): InputOutcome => ({
  question: {
    question: {
      question: 'Какой формат приветствия выбрать для пользователей?',
      options: [
        { id: 'hello', label: 'Hello, <name>!', consequence: null },
        { id: 'hi', label: 'Hi <name>', consequence: 'короче, но меняет текст' },
      ],
      recommended: 'hello',
      severity: 8,
      rationale: 'Текст виден пользователю',
      affects: [],
    },
    effectiveSeverity: 8,
    floors: [],
    mode: 'request',
  },
  assumptions: [],
  followUps: [],
  criticalHits: [],
  callId: 'call-1',
});

type Env = ReturnType<typeof engineOf>;
interface AgentRecord {
  stdin: string;
  argv: string[];
  env: { [k: string]: string | undefined };
}

/** Драйвер над состоянием теста с поддельным ведущим (`mode`: wait-go | exit). */
function driveOf(
  env: Env | { dir: string; engine: { policy: Engine['policy'] } },
  options: { mode?: 'wait-go' | 'exit' | 'hang'; code?: number; extraArgs?: string[] } = {},
  extra: Partial<Parameters<typeof driveLead>[0]> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-drive-agent-'));
  const promise = driveLead({
    stateDir: env.dir,
    policy: env.engine.policy,
    policyPath: join(env.dir, 'policy.json'),
    baseDir: env.dir,
    agent: [
      process.execPath,
      AGENT,
      dir,
      options.mode ?? 'exit',
      String(options.code ?? 0),
      ...(options.extraArgs ?? []),
    ],
    goals: GOALS,
    harnessBin: '/opt/harness/bin/harness',
    pollMs: 50,
    graceMs: 0,
    waitTimeoutMs: 300,
    ...extra,
  });
  return { dir, promise };
}

const sessionFiles = (dir: string) => readdirSync(dir).filter((f) => /^session-\d+\.json$/.test(f));

async function sessionRecord(dir: string, n: number): Promise<AgentRecord> {
  const file = join(dir, `session-${n}.json`);
  const until = Date.now() + 15_000;
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error('сессия ведущего не началась: ' + n);
    await new Promise((r) => setTimeout(r, 20));
  }
  return JSON.parse(readFileSync(file, 'utf8')) as AgentRecord;
}
const go = (dir: string, n: number) => writeFileSync(join(dir, `session-${n}.go`), '');

test('lead drive: принятие работы, таймауты ожидания и отказ, который harness повторит сам, ведущего не будят', async () => {
  const env = engineOf(policyOf((p: Record<string, unknown>) => (p.maxAttempts = 3)));
  ready(env.engine, graphOf({ a: [], b: [], c: [] }));
  const a = env.engine.claim('c1')!;
  const b = env.engine.claim('c1')!;
  const abort = new AbortController();
  const { dir, promise } = driveOf(env, {}, { signal: abort.signal });
  await new Promise((r) => setTimeout(r, 400));
  accept(env.engine, a.id, a.token);
  assert.ok(env.engine.claim('c1'), 'c работает до конца теста: очередь не стоит');
  // Отказ и повтор harness: работа уже не failed, когда драйвер его видит.
  env.engine.fail(b.id, b.token, 'gate unit упал', { kind: 'gate' });
  env.engine.retry(b.workId, undefined, 'recovery');
  await new Promise((r) => setTimeout(r, 1200));
  abort.abort();
  const data = await promise;
  assert.equal(data.outcome, 'aborted');
  assert.deepEqual(data.sessions, [], 'ни одной сессии ведущего');
  assert.ok(data.waits >= 3, `внутренних ожиданий ${data.waits}`);
  assert.deepEqual(sessionFiles(dir), []);
  assert.equal(DRIVE_EXIT_CODES[data.outcome], 16);
  leadDriveDataSchema.parse(data);
  env.store.close();
});

test('lead drive: отказ, который ждёт ведущего, — новая сессия: цели, сводка события, команды и HARNESS_LEAD_DRIVE на входе; журналы сессии в --log', async () => {
  const env = engineOf(policyOf((p: Record<string, unknown>) => (p.maxAttempts = 1)));
  ready(env.engine, graphOf({ a: [], b: [] }));
  const a = env.engine.claim('c1')!;
  env.engine.claim('c1');
  env.engine.fail(a.id, a.token, 'gate unit упал', { kind: 'gate' });
  const logDir = join(mkdtempSync(join(tmpdir(), 'harness-drive-log-')), 'logs');
  const { dir, promise } = driveOf(env, {}, { idleSessions: 1, logDir });
  const data = await promise;
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0]!.kind, 'failed');
  assert.equal(data.sessions[0]!.workId, a.workId);
  const rec = await sessionRecord(dir, 1);
  assert.ok(rec.stdin.startsWith(GOALS), 'сначала цели оператора');
  assert.match(rec.stdin, /Событие: failed/);
  assert.ok(rec.stdin.includes(a.workId));
  assert.ok(rec.stdin.includes('H=/opt/harness/bin/harness'));
  assert.ok(rec.stdin.includes(`$H retry --state`), 'команды этого события');
  assert.ok(rec.stdin.includes('$H guide recovery'));
  assert.match(rec.stdin, /HARNESS_LEAD_DRIVE=1: ждёт драйвер/);
  assert.ok(!/session-|history/i.test(rec.stdin), 'без истории прошлых сессий');
  assert.equal(rec.env.HARNESS_LEAD_DRIVE, '1');
  assert.equal(rec.env.HARNESS_LEAD_DRIVE_CURSOR, String(data.sessions[0]!.cursor));
  assert.equal(rec.env.HARNESS_LEAD_DRIVE_SESSION, '1');
  assert.equal(rec.env.HARNESS_LEAD_DRIVE_EVENT, 'failed');
  // Ведущий ничего не изменил, --idle-sessions 1: остановка с диагнозом.
  assert.equal(data.outcome, 'no-progress');
  assert.equal(DRIVE_EXIT_CODES[data.outcome], 21);
  assert.equal(readFileSync(join(logDir, 'session-1.prompt.md'), 'utf8'), rec.stdin);
  assert.match(readFileSync(join(logDir, 'session-1.err'), 'utf8'), /fake lead session 1/);
  assert.ok(existsSync(join(logDir, 'session-1.out')));
  leadDriveDataSchema.parse(data);
  env.store.close();
});

test('lead drive: очередь без harness run будит ведущего; N сессий подряд без изменений — остановка no-progress, не бесконечный перезапуск; подстановки шаблона', async () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [] }));
  const { dir, promise } = driveOf(env, { code: 7, extraArgs: ['s{session}:c{cursor}'] });
  const data = await promise;
  assert.equal(data.outcome, 'no-progress');
  assert.equal(data.sessions.length, 3, 'по умолчанию — 3 сессии без изменений');
  assert.ok(data.sessions.every((s) => s.kind === 'stopped' && s.exitCode === 7 && !s.progressed));
  assert.match(data.message, /3 сессии ведущего подряд не изменили состояние/);
  assert.match(data.message, /код выхода 7/);
  assert.match(data.message, /fake lead session 3/, 'хвост stderr в диагнозе');
  const rec = await sessionRecord(dir, 2);
  assert.equal(rec.argv.at(-1), `s2:c${data.sessions[1]!.cursor}`);
  assert.match(rec.stdin, /`harness run` не идёт/);
  assert.match(rec.stdin, /nohup \$H run --graph/);
  assert.deepEqual(sessionFiles(dir).length, 3);
  env.store.close();
});

test('lead drive: каталога состояния ещё нет — ведущий разбужен настроить и запустить run', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'harness-drive-nostate-')), 'state');
  const { dir: agentDir, promise } = driveOf(
    { dir, engine: { policy: policyOf() } },
    {},
    { idleSessions: 1 },
  );
  const data = await promise;
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0]!.kind, 'stopped');
  assert.match((await sessionRecord(agentDir, 1)).stdin, /каталог состояния ещё не создан/);
});

const ownerPolicy = () =>
  policyOf((p: Record<string, unknown>) => {
    p.inputPolicy = { threshold: 7 };
    p.maxAttempts = 1;
  });

test('lead drive: вопрос владельца, а больше идти нечему (run не идёт) — уведомление и выход owner (20) без сессии ведущего', async () => {
  const env = engineOf(ownerPolicy());
  ready(env.engine, graphOf({ a: [] }));
  const a = env.engine.claim('c1')!;
  env.engine.fail(a.id, a.token, 'вопрос', { kind: 'needs-input', input: questionOutcome() });
  const lines: string[] = [];
  const { dir, promise } = driveOf(env, {}, { onLog: (l) => lines.push(l) });
  const data = await promise;
  assert.equal(data.outcome, 'owner');
  assert.equal(DRIVE_EXIT_CODES[data.outcome], 20);
  assert.deepEqual(data.sessions, []);
  assert.deepEqual(sessionFiles(dir), []);
  assert.match(data.message, /run не идёт, а дальше всё ждёт ответа владельца/);
  assert.match(data.message, /IR-[a-f0-9]{24}/);
  assert.match(data.message, /Какой формат приветствия/);
  assert.equal(data.notices.length, 1);
  assert.equal(data.notices[0]!.kind, 'owner-question');
  assert.equal(data.notices[0]!.workId, a.workId);
  assert.ok(lines.some((l) => l.startsWith('владельцу: вопрос исполнителя IR-')));
  leadDriveDataSchema.parse(data);
  env.store.close();
});

test('lead drive: вопрос владельца не останавливает драйвер, пока другое идёт; отказ независимой работы — сессия ведущего; ответ владельца — сессия ведущего', async () => {
  const env = engineOf(ownerPolicy());
  ready(env.engine, graphOf({ a: [], b: [], c: [] }));
  const a = env.engine.claim('c1')!;
  const b = env.engine.claim('c1')!;
  env.engine.fail(a.id, a.token, 'вопрос', { kind: 'needs-input', input: questionOutcome() });
  const c = env.engine.claim('c1')!; // c работает до конца: очередь не стоит
  assert.ok(c);
  const abort = new AbortController();
  const { dir, promise } = driveOf(env, { mode: 'wait-go' }, { signal: abort.signal });
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(sessionFiles(dir), [], 'вопрос владельца ведущего не будит');
  // Независимая работа b падает без повтора: дело ведущего.
  env.engine.fail(b.id, b.token, 'gate unit упал', { kind: 'gate' });
  const first = await sessionRecord(dir, 1);
  assert.equal(first.env.HARNESS_LEAD_DRIVE_EVENT, 'failed');
  assert.ok(first.stdin.includes(b.workId));
  env.engine.recordLead((log, now) => ({
    log: {
      ...log,
      entries: [
        ...log.entries,
        { at: new Date(now).toISOString(), kind: 'note', action: 'lead.note', plain: 'разбираю b' },
      ],
    },
    result: undefined,
  }));
  go(dir, 1);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sessionFiles(dir).length, 1, 'драйвер продолжил ждать');
  // Владелец ответил (оператор) — ведущий применяет ответ.
  const request = env.engine.read((v) => v.locals('input-requests'))[0]!.value;
  env.engine.answerInput(
    request.id,
    { text: 'Hello', optionId: 'hello', actor: { kind: 'operator' } },
    request.version,
  );
  const second = await sessionRecord(dir, 2);
  assert.equal(second.env.HARNESS_LEAD_DRIVE_EVENT, 'question');
  assert.match(second.stdin, /владелец ответил на вопрос исполнителя/);
  assert.match(second.stdin, /input-resolve/);
  go(dir, 2);
  await new Promise((r) => setTimeout(r, 1300));
  abort.abort();
  const data = await promise;
  assert.equal(data.outcome, 'aborted');
  assert.deepEqual(
    data.sessions.map((s) => s.kind),
    ['failed', 'question'],
  );
  assert.deepEqual(
    data.notices.map((n) => [n.kind, n.requestId]),
    [
      ['owner-question', request.id],
      ['owner-answered', request.id],
    ],
  );
  leadDriveDataSchema.parse(data);
  env.store.close();
});

test('lead drive: вопрос, на который ведущему отвечать можно, — сессия ведущего', async () => {
  const lead = engineOf(
    policyOf(
      (p: Record<string, unknown>) =>
        (p.inputPolicy = { threshold: 7, leadAnswers: { maxSeverity: 10 } }),
    ),
  );
  ready(lead.engine, graphOf({ a: [], b: [] }));
  const x = lead.engine.claim('c1')!;
  lead.engine.claim('c1');
  lead.engine.fail(x.id, x.token, 'вопрос', { kind: 'needs-input', input: questionOutcome() });
  const second = driveOf(lead, {}, { idleSessions: 1 });
  const woke = await second.promise;
  assert.equal(woke.sessions[0]?.kind, 'question');
  assert.deepEqual(woke.notices, []);
  assert.match((await sessionRecord(second.dir, 1)).stdin, /\$H input-show/);
  lead.store.close();
});

test('lead drive: сессия дольше --session-timeout снята (SIGTERM, затем SIGKILL) и считается неудачной', async () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [] }));
  const started = Date.now();
  const { promise } = driveOf(
    env,
    { mode: 'hang' },
    { idleSessions: 1, sessionTimeoutMs: 400, killGraceMs: 300 },
  );
  const data = await promise;
  assert.ok(Date.now() - started < 8000, 'снята по сроку, не дождались 15 с поддельного ведущего');
  assert.equal(data.outcome, 'no-progress');
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0]!.timedOut, true);
  assert.equal(data.sessions[0]!.exitCode, null);
  assert.match(data.message, /превысила --session-timeout/);
  leadDriveDataSchema.parse(data);
  env.store.close();
});

test('lead drive: весь код принят — сессия ведущего; release done записан — выход 0; сессия с изменениями сбрасывает счёт простоя', async () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [] }));
  const a = env.engine.claim('c1')!;
  const { dir, promise } = driveOf(env, { mode: 'wait-go' }, { idleSessions: 1 });
  await new Promise((r) => setTimeout(r, 300));
  accept(env.engine, a.id, a.token);
  const rec = await sessionRecord(dir, 1);
  assert.equal(rec.env.HARNESS_LEAD_DRIVE_EVENT, 'release-ready');
  assert.match(rec.stdin, /\$H review-release/);
  assert.match(rec.stdin, /\$H release done/);
  // «Ведущий» закончил выпуск, пока сессия идёт.
  env.engine.recordLead((log, now) => ({
    log: {
      ...log,
      release: { doneAt: new Date(now).toISOString(), summary: 'Выпуск готов', works: 1 },
      entries: [
        ...log.entries,
        {
          at: new Date(now).toISOString(),
          kind: 'release-done',
          action: 'release.done',
          plain: 'ведущий закончил выпуск',
        },
      ],
    },
    result: undefined,
  }));
  go(dir, 1);
  const data = await promise;
  assert.equal(data.outcome, 'release-done');
  assert.equal(DRIVE_EXIT_CODES[data.outcome], 0);
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0]!.progressed, true);
  // Выпуск уже закончен — драйвер выходит сразу, без сессии.
  const again = driveOf(env);
  assert.equal((await again.promise).outcome, 'release-done');
  assert.deepEqual(sessionFiles(again.dir), []);
  leadDriveDataSchema.parse(data);
  env.store.close();
});

test('lead drive: предел --max-sessions — выход max-sessions (22); команда не запускается — agent-error (23)', async () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [] }));
  const { promise } = driveOf(env, {}, { maxSessions: 2, idleSessions: 5 });
  const data = await promise;
  assert.equal(data.outcome, 'max-sessions');
  assert.equal(DRIVE_EXIT_CODES[data.outcome], 22);
  assert.equal(data.sessions.length, 2);
  const broken = await driveLead({
    stateDir: env.dir,
    policy: env.engine.policy,
    policyPath: join(env.dir, 'policy.json'),
    baseDir: env.dir,
    agent: [join(env.dir, 'нет-такой-команды')],
    goals: GOALS,
    harnessBin: 'harness',
    pollMs: 50,
    graceMs: 0,
    waitTimeoutMs: 300,
  });
  assert.equal(broken.outcome, 'agent-error');
  assert.equal(DRIVE_EXIT_CODES[broken.outcome], 23);
  assert.match(broken.message, /не запустилась/);
  env.store.close();
});

test('lead drive: шаблон --agent разбирается без оболочки — кавычки и экранирование; незакрытая кавычка и пустой шаблон — отказ', () => {
  assert.deepEqual(
    parseAgentTemplate(`codex exec --json -C '/a b/site' -c "model_reasoning_effort=high" -`),
    ['codex', 'exec', '--json', '-C', '/a b/site', '-c', 'model_reasoning_effort=high', '-'],
  );
  assert.deepEqual(parseAgentTemplate(`a\\ b "c\\"d" ''`), ['a b', 'c"d', '']);
  assert.throws(() => parseAgentTemplate(`codex 'exec`), /незакрытая кавычка/);
  assert.throws(() => parseAgentTemplate('   '), /пустой шаблон/);
});

test('CLI lead drive: синоним, код выхода исхода и конверт; без --agent — INVALID_INPUT', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-drive-cli-'));
  const policy = join(root, 'policy.json');
  writeFileSync(policy, JSON.stringify(example('policy')));
  const prompt = join(root, 'goals.md');
  writeFileSync(prompt, GOALS + '\n');
  const agentDir = mkdtempSync(join(tmpdir(), 'harness-drive-cli-agent-'));
  const state = join(root, 'state');
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_LEAD_DRIVE_GRACE_MS: '0' },
      timeout: 60_000,
    });
  const r = run([
    'lead',
    'drive',
    '--state',
    state,
    '--policy',
    policy,
    '--agent',
    `'${process.execPath}' '${AGENT}' '${agentDir}' exit 0`,
    '--prompt-file',
    prompt,
    '--idle-sessions',
    '1',
    '--timeout',
    '2s',
  ]);
  assert.equal(r.status, 21, r.stderr);
  const envelope = JSON.parse(r.stdout) as { ok: boolean; command: string; data: unknown };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, 'lead-drive');
  assert.equal(leadDriveDataSchema.parse(envelope.data).outcome, 'no-progress');
  assert.match(r.stderr, /harness lead drive: сессия 1: stopped/);
  const rec = JSON.parse(readFileSync(join(agentDir, 'session-1.json'), 'utf8')) as AgentRecord;
  assert.ok(rec.stdin.startsWith(GOALS));
  assert.equal(rec.env.HARNESS_LEAD_DRIVE, '1');
  const missing = run([
    'lead-drive',
    '--state',
    state,
    '--policy',
    policy,
    '--prompt-file',
    prompt,
  ]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--agent/);
});
