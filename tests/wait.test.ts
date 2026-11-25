import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOf } from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { WAIT_EXIT_CODES, waitFor } from '../src/control/wait.ts';
import { waitDataSchema } from '../src/contracts/cli.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';
import { leadBegin, leadRenew } from '../src/control/lead.ts';

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

const later = (ms: number, fn: () => void) =>
  new Promise<void>((done) =>
    setTimeout(() => {
      fn();
      done();
    }, ms),
  );

const waitOf = (
  env: ReturnType<typeof engineOf>,
  extra: Partial<Parameters<typeof waitFor>[0]> = {},
) =>
  waitFor({
    stateDir: env.dir,
    policy: env.engine.policy,
    baseDir: env.dir,
    timeoutMs: 20_000,
    pollMs: 50,
    ...extra,
  });

test('wait: событие после начала — принятие работы; итог со строкой состояния и курсором; код 0', async () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [], b: [] }));
  const a = env.engine.claim('c1')!;
  const waiting = waitOf(env);
  await later(200, () => accept(env.engine, a.id, a.token));
  const data = await waiting;
  assert.equal(data.kind, 'accepted');
  assert.equal(data.workId, a.workId);
  assert.equal(data.event?.type, 'work.accepted');
  assert.equal(data.cursor, data.event?.seq, 'курсор — сразу за сообщённым событием');
  assert.match(data.status, /принято 1\/2/);
  assert.equal(WAIT_EXIT_CODES[data.kind], 0);
  waitDataSchema.parse(data);
  env.store.close();
});

test('ревью D/E HIGH-1: два события в одной пачке — два wait сообщают оба; событие между wait не теряется', async () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [], b: [], c: [] }));
  const a = env.engine.claim('c1')!;
  const b = env.engine.claim('c1')!;
  const start = await waitOf(env, { timeoutMs: 1000 });
  assert.equal(start.kind, 'timeout');
  // Обе приёмки — до следующего опроса: одна пачка событий.
  accept(env.engine, a.id, a.token);
  accept(env.engine, b.id, b.token);
  const first = await waitOf(env, { after: start.cursor });
  assert.equal(first.workId, a.workId);
  const second = await waitOf(env, { after: first.cursor });
  assert.equal(second.kind, 'accepted');
  assert.equal(second.workId, b.workId, 'второе событие пачки сообщено следующим wait');
  // Событие, случившееся, пока ведущий действовал, — следующему wait.
  const c = env.engine.claim('c1')!;
  accept(env.engine, c.id, c.token);
  const third = await waitOf(env, { after: second.cursor });
  assert.equal(third.workId, c.workId);
  waitDataSchema.parse(third);
  env.store.close();
});

test('ревью D/E HIGH-1: отказ до начала wait без --after — сообщён сразу как ждущий ведущего', async () => {
  const env = engineOf(policyOf((p: Record<string, unknown>) => (p.maxAttempts = 1)));
  ready(env.engine, graphOf({ a: [], b: [] }));
  const a = env.engine.claim('c1')!;
  env.engine.claim('c1');
  env.engine.fail(a.id, a.token, 'gate unit упал', { kind: 'gate' });
  const data = await waitOf(env);
  assert.equal(data.kind, 'failed');
  assert.equal(data.workId, a.workId);
  assert.equal(data.event, undefined, 'сообщено состояние, не событие');
  assert.ok(data.next && data.next.actor !== 'controller', 'следующий шаг — человека');
  assert.equal(WAIT_EXIT_CODES[data.kind], 13);
  env.store.close();
});

test('ревью D/E LOW-2: отказ, за которым harness назначил повтор, — не failed; без повтора — failed', async () => {
  const env = engineOf(policyOf((p: Record<string, unknown>) => (p.maxAttempts = 3)));
  ready(env.engine, graphOf({ a: [], b: [] }));
  const a = env.engine.claim('c1')!;
  env.engine.claim('c1');
  const cursor0 = (await waitOf(env, { timeoutMs: 1000 })).cursor;
  // Отказ уже в журнале к первому опросу; ремонт harness — следующей транзакцией.
  env.engine.fail(a.id, a.token, 'gate unit упал', { kind: 'gate' });
  const waiting = waitOf(env, { after: cursor0, until: ['failed'], timeoutMs: 1500, pollMs: 300 });
  await later(40, () => env.engine.retry(a.workId, undefined, 'recovery'));
  const data = await waiting;
  assert.notEqual(data.kind, 'failed', 'повтор назначен — ведущему нечего делать');
  env.store.close();
  const last = engineOf(policyOf((p: Record<string, unknown>) => (p.maxAttempts = 1)));
  ready(last.engine, graphOf({ a: [], b: [] }));
  const x = last.engine.claim('c1')!;
  last.engine.claim('c1');
  const cursor = (await waitOf(last, { timeoutMs: 1000 })).cursor;
  last.engine.fail(x.id, x.token, 'gate unit упал', { kind: 'gate' });
  const failed = await waitOf(last, { after: cursor, until: ['failed'] });
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.event?.type, 'attempt.failed');
  last.store.close();
});

test('wait: ничего не происходит — timeout с кодом 15; сигнал — aborted с кодом 16; очередь без controller и попыток — stopped сразу', async () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [] }));
  env.engine.claim('c1');
  const started = Date.now();
  const data = await waitOf(env, { timeoutMs: 400 });
  assert.equal(data.kind, 'timeout');
  assert.ok(Date.now() - started >= 400);
  assert.equal(WAIT_EXIT_CODES[data.kind], 15);
  const abort = new AbortController();
  const aborting = waitOf(env, { signal: abort.signal });
  await later(150, () => abort.abort());
  const aborted = await aborting;
  assert.equal(aborted.kind, 'aborted');
  assert.equal(WAIT_EXIT_CODES[aborted.kind], 16);
  // Без активных попыток и роли controller ждать нечего.
  const idle = engineOf();
  ready(idle.engine, graphOf({ a: [] }));
  const stopped = await waitOf(idle);
  assert.equal(stopped.kind, 'stopped');
  assert.ok(stopped.waitedMs < 5000);
  env.store.close();
  idle.store.close();
});

test('ревью D/E LOW-3: ожидание продлевает активную сессию ведущего (onTick → leadRenew); без сессии — ничего', async () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [] }));
  env.engine.claim('c1');
  assert.equal(leadRenew(env.engine), false, 'сессии нет');
  leadBegin(env.engine, { ttlMs: 30 * 60_000 });
  const until = () => env.engine.read((v) => v.local('lead', '@workspace', 'log')?.session?.until);
  const before = until();
  env.clock.now += 20 * 60_000;
  let ticks = 0;
  await waitOf(env, {
    timeoutMs: 500,
    tickMs: 100,
    onTick: () => {
      ticks++;
      leadRenew(env.engine);
    },
  });
  assert.ok(ticks >= 1);
  assert.ok(Date.parse(until()!) > Date.parse(before!), 'аренда продлена');
  env.store.close();
});

test('ревью final M2: метка запуска run (процесс жив, роли ещё нет) — не stopped; метка снята или процесса нет — stopped', async () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [] }));
  env.clock.now = Date.now();
  env.engine.recordRunStart(process.pid, 30 * 60_000);
  const starting = await waitOf(env, { timeoutMs: 600 });
  assert.equal(starting.kind, 'timeout', 'run запускается — очередь не остановлена');
  env.engine.clearRunStart(process.pid);
  assert.equal((await waitOf(env)).kind, 'stopped');
  // Метка процесса, которого нет: очередь стоит.
  env.engine.recordRunStart(2 ** 22 + 12345, 30 * 60_000);
  assert.equal((await waitOf(env)).kind, 'stopped');
  env.store.close();
});

test('ревью final M2: каталога состояния ещё нет — wait ждёт его до предела, а не NOT_FOUND', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'harness-wait-')), 'state');
  const data = await waitFor({
    stateDir: dir,
    policy: engineOf().engine.policy,
    baseDir: dir,
    timeoutMs: 300,
    pollMs: 50,
  });
  assert.equal(data.kind, 'timeout');
  assert.match(data.status, /каталог состояния ещё не создан/);
  waitDataSchema.parse(data);
});
