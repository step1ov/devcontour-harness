/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Фикстура правит сырой JSON политики; ответ CLI читается как есть.
 */
/**
 * `harness handoff` и `handoffPack`: пакет передачи контекста из хранилища.
 * Состояние создаётся операциями движка (выдача, отказ, стадия, учёт вызовов)
 * — без runtime и моделей.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HANDOFF_LIMITS,
  HANDOFF_MAX_BYTES,
  HANDOFF_MIN_BYTES,
  cliDataSchemas,
  exitCodes,
  handoffNextSteps,
  handoffPackSchema,
  publishedSchemas,
  type RuntimeAdapter,
  type RuntimeRequest,
  type Usage,
} from '../src/contracts/index.ts';
import { Harness } from '../src/control/harness.ts';
import { measuredInvoke } from '../src/engine/measured.ts';
import { clipSafe, fitPack } from '../src/handoff/pack.ts';
import * as root from '../src/index.ts';
import { handoffMarkdown, handoffPack, statusOf, type HandoffSource } from '../src/index.ts';
import { policySecrets } from '../src/environment/redaction.ts';
import { nextSteps } from '../src/projections/index.ts';
import { hsetup } from './harness-fixture.ts';
import { graphOf, ready } from './engine-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (args: string[]) => {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
/** Строка Markdown со следующим шагом. */
const nextLine = (md: string) => md.split('## Следующий шаг\n\n')[1]!.split('\n')[0]!;
/** Срок владения попытки в прошлом: владелец пропал, запись не закрыта. */
const abandon = (h: Harness, runId: string) =>
  h.store.transact('run.phase', (tx) =>
    tx.putAttempt({ ...tx.attempt(runId)!, leaseUntil: Date.now() - 1000 }),
  );

/** Доска: `a` упала на gate, `b` ждёт `a`, `c` идёт на стадии gate. */
function board(patchPolicy: (p: any) => void = () => {}) {
  const ctx = hsetup({
    scenario: {},
    policy: (p) => {
      (p as any).budgets = { total: { usd: 5 } };
      patchPolicy(p);
    },
  });
  writeFileSync(
    join(ctx.state, 'binding.json'),
    JSON.stringify({ policy: ctx.policy, baseDir: ctx.repo.dir }),
  );
  const h = ctx.open();
  ready(h.engine, graphOf({ a: [], b: ['a'], c: [] }));
  const a = h.engine.claim('c1')!;
  assert.equal(a.workId, 'a');
  h.engine.fail(a.id, a.token, 'unit: ' + 'x'.repeat(5000), { kind: 'gate' });
  const c = h.engine.claim('c1')!;
  assert.equal(c.workId, 'c');
  h.engine.timingStarted(c.id, c.token, 'candidate-test:unit');
  return { ctx, h, a, c };
}

test('handoff: пакет из хранилища — активная работа, провалы, остановки, бюджеты, следующий шаг', () => {
  const { ctx, h, a, c } = board();
  try {
    const pack = handoffPack(h, { intentions: ['  Разобрать отказ gate у a  ', ''] });
    assert.ok(handoffPackSchema.safeParse(pack).success);
    assert.equal(pack.handoffVersion, 1);
    assert.deepEqual(pack.limits, {
      maxAttempts: ctx.policy.maxAttempts,
      repairBudget: ctx.policy.repairBudget,
    });
    assert.deepEqual(
      { works: pack.summary.works, open: pack.summary.open, done: pack.summary.done },
      { works: 3, open: 3, done: 0 },
    );

    // Активная работа и её стадия.
    assert.equal(pack.active.length, 1);
    const active = pack.active[0]!;
    assert.equal(active.workId, 'c');
    assert.equal(active.runId, c.id);
    assert.equal(active.stage?.name, 'candidate-test:unit');
    assert.equal(active.stale, false);
    assert.deepEqual(pack.unfinished, []);

    // Открытые поручения: идущая, упавшая, ждущая; следующий шаг каждой.
    assert.deepEqual(
      pack.works.map((w) => [w.id, w.status, w.next.step]),
      [
        ['c', 'running', 'attempt-running'],
        ['a', 'failed', 'retry-within-budget'],
        ['b', 'ready', 'awaiting-claim'],
      ],
    );
    const failedWork = pack.works.find((w) => w.id === 'a')!;
    assert.equal(failedWork.failureKind, 'gate');
    assert.equal(failedWork.failure!.length, HANDOFF_LIMITS.text + 1, 'причина усечена');
    assert.ok(pack.works.find((w) => w.id === 'b')!.blockers.length > 0);

    // Провал с классом отказа, кодом и текущим статусом поручения.
    assert.equal(pack.failures.length, 1);
    const f = pack.failures[0]!;
    assert.deepEqual(
      [f.runId, f.failureKind, f.code, f.workStatus],
      [a.id, 'gate', 'GATE_FAILED', 'failed'],
    );
    assert.ok(f.error!.endsWith('…'));

    // Остановки — explain; решения — первыми.
    assert.ok(pack.stops.some((d) => d.workId === 'a' && d.code === 'GATE_FAILED'));
    const decision = (d: (typeof pack.stops)[number]) =>
      (d.actor === 'user' || d.actor === 'lead') && d.action !== 'wait';
    const firstWait = pack.stops.findIndex((d) => !decision(d));
    assert.ok(firstWait > 0 && pack.stops.slice(firstWait).every((d) => !decision(d)));
    // Задания графа нет: движок сам не чинит — следующий шаг у ведущего (как explain).
    assert.deepEqual(
      [failedWork.next.actor, failedWork.next.action, failedWork.next.step],
      ['lead', 'diagnose-failure', 'retry-within-budget'],
    );
    assert.ok(pack.stops.every((d) => d.message.length <= HANDOFF_LIMITS.text + 1));

    // Бюджеты: расход против предела.
    const total = pack.budgets!.entries.find((b) => b.scope === 'total')!;
    assert.equal(total.limitUsd, 5);
    assert.equal(total.state, 'within');
    assert.equal(total.complete, true);

    assert.deepEqual(
      [pack.next.actor, pack.next.action, pack.next.workId, pack.next.code],
      ['lead', 'diagnose-failure', 'a', 'GATE_FAILED'],
    );
    assert.deepEqual(pack.intentions, ['Разобрать отказ gate у a']);
    assert.deepEqual(pack.truncated, {
      works: 0,
      stops: 0,
      failures: 0,
      unfinished: 0,
      budgets: 0,
      budgetsWithin: 0,
      repairs: 0,
      intentions: 0,
      intentionsDropped: 0,
      bySize: false,
    });
    assert.ok(!JSON.stringify(pack).includes(c.token), 'токен владения не в пакете');

    const md = handoffMarkdown(pack);
    for (const section of [
      '# Передача контекста',
      '## Следующий шаг',
      '## Очередь',
      '## Активная работа',
      '## Решения и остановки',
      '## Открытые поручения',
      '## Последние провалы',
      '## Бюджеты',
      '## Намерения',
    ])
      assert.ok(md.includes(section), section);
    assert.equal(
      nextLine(md),
      `- **lead: diagnose-failure** — a (GATE_FAILED): ${pack.next.detail}`,
    );
    assert.match(md, /candidate-test:unit/);
    assert.match(md, /- Разобрать отказ gate у a/);
    assert.match(md, /a \(сейчас failed\) #1/);
    assert.ok(!md.includes('x'.repeat(HANDOFF_LIMITS.text + 1)), 'длинный текст усечён');

    // Фильтр графа: неизвестный граф — NOT_FOUND.
    assert.equal(handoffPack(h, { graphId: 'g' }).summary.works, 3);
    assert.throws(() => handoffPack(h, { graphId: 'nope' }), { code: 'NOT_FOUND' });
    assert.throws(
      () => handoffPack(h, { intentions: Array.from({ length: 21 }, (_, i) => 'i' + i) }),
      { code: 'INVALID_INPUT' },
    );
    // Усечённое намерение отмечено.
    const long = handoffPack(h, { intentions: ['z'.repeat(1500)] });
    assert.equal(long.truncated.intentions, 1);
    assert.equal(long.intentions[0]!.length, HANDOFF_LIMITS.intentionChars + 1);
    assert.match(handoffMarkdown(long), /Усечено намерений: 1/);
  } finally {
    h.close();
  }
});

test('handoff: истёкшее владение — незавершённая попытка; списки ограничены пределами', () => {
  const ctx = hsetup({ scenario: {}, policy: (p) => ((p as any).maxAttempts = 3) });
  const h = ctx.open();
  try {
    const ids = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`w${i}`, []]));
    ready(h.engine, graphOf(ids));
    for (let i = 0; i < 12; i++) {
      const run = h.engine.claim('c1')!;
      h.engine.fail(run.id, run.token, 'gate ' + i, { kind: 'gate' });
    }
    h.engine.retry('w0');
    const stuck = h.engine.claim('c1')!;
    assert.equal(stuck.workId, 'w0');
    abandon(h, stuck.id);
    const pack = handoffPack(h);
    assert.equal(pack.failures.length, HANDOFF_LIMITS.failures);
    assert.equal(pack.truncated.failures, 12 - HANDOFF_LIMITS.failures);
    assert.ok(pack.failures.every((f) => f.code === 'GATE_FAILED'));
    assert.deepEqual(
      pack.unfinished.map((u) => [u.runId, u.stale, u.current]),
      [[stuck.id, true, true]],
    );
    assert.equal(pack.active[0]?.stale, true);
    const md = handoffMarkdown(pack);
    assert.match(md, /владение истекло/);
    assert.match(md, /… и ещё 2 провалов/);
  } finally {
    h.close();
  }
});

test('handoff next: свежий срок владения без controller — ждать до срока, без harness run', () => {
  const ctx = hsetup({ scenario: {} });
  const h = ctx.open();
  try {
    ready(h.engine, graphOf({ a: [], b: [] }));
    h.engine.claim('c1');
    h.engine.release('c1');
    const pack = handoffPack(h);
    assert.equal(pack.active[0]!.stale, false);
    assert.deepEqual(
      [pack.next.actor, pack.next.action, pack.next.step, pack.next.workId, pack.next.command],
      ['controller', 'wait', 'attempt-running', 'a', undefined],
    );
    assert.ok(pack.next.detail!.includes(pack.active[0]!.leaseUntil));
    assert.match(pack.next.detail!, /проверить процесс-владелец/);
  } finally {
    h.close();
  }
});

test('handoff: пауза очереди и повтор controller — строка «повтор ждёт снятия паузы»', () => {
  const ctx = hsetup({ scenario: {} });
  const h = ctx.open();
  try {
    const g = ready(h.engine, graphOf({ a: [], b: [] }));
    h.workflows.start({ kind: 'graph', id: g.id, authorRuntime: 'claude' });
    const a = h.engine.claim('c1')!;
    h.engine.fail(a.id, a.token, 'gate', { kind: 'gate' });
    h.engine.pause('operator');
    const pack = handoffPack(h);
    const wa = pack.works.find((w) => w.id === 'a')!;
    assert.deepEqual([wa.next.actor, wa.next.action], ['controller', 'retry']);
    assert.match(handoffMarkdown(pack), /Повтор ждёт снятия паузы очереди/);
    h.engine.resume();
    assert.doesNotMatch(handoffMarkdown(handoffPack(h)), /Повтор ждёт снятия паузы/);
  } finally {
    h.close();
  }
});

test('handoff next: попытка без живого владельца — harness run, а не ожидание', () => {
  const ctx = hsetup({ scenario: {} });
  const h = ctx.open();
  try {
    ready(h.engine, graphOf({ a: [], b: ['a'] }));
    const a = h.engine.claim('c1')!;
    // Живой controller и свежая попытка — ждать.
    const live = handoffPack(h).next;
    assert.deepEqual(
      [live.actor, live.action, live.step, live.workId],
      ['controller', 'wait', 'attempt-running', 'a'],
    );
    assert.equal(live.command, undefined);
    // Срок владения истёк, controller ещё держит роль — он сам истечёт попытку.
    abandon(h, a.id);
    const expiring = handoffPack(h).next;
    assert.equal(expiring.step, 'awaiting-claim');
    assert.equal(expiring.command, undefined);
    assert.match(expiring.detail!, /controller истечёт/);
    // Controller отпустил роль: ждать некого — следующий шаг harness run.
    h.engine.release('c1');
    const pack = handoffPack(h);
    assert.equal(pack.controller?.live ?? false, false);
    assert.notEqual(pack.next.step, 'attempt-running');
    assert.deepEqual([pack.next.workId, pack.next.command], ['a', 'harness run']);
    assert.match(nextLine(handoffMarkdown(pack)), /Команда: `harness run`/);
  } finally {
    h.close();
  }
});

test('handoff next: без решений — первый шаг поручения; без controller — harness run; пусто — none', () => {
  const ctx = hsetup({ scenario: {} });
  const h = ctx.open();
  try {
    const empty = handoffPack(h).next;
    assert.deepEqual([empty.action, empty.detail], ['none', 'Работы нет']);
    ready(h.engine, graphOf({ a: [] }));
    h.engine.release('c1');
    const idle = handoffPack(h);
    assert.ok(
      !idle.stops.some((d) => (d.actor === 'lead' || d.actor === 'user') && d.action !== 'wait'),
      JSON.stringify(idle.stops),
    );
    assert.deepEqual(
      [idle.next.actor, idle.next.workId, idle.next.step, idle.next.command],
      ['controller', 'a', 'awaiting-claim', 'harness run'],
    );
    // Отменённая работа — решение ведущего (explain: пересогласовать зависимых).
    h.engine.cancel('a', 'не нужно');
    const closed = handoffPack(h);
    assert.deepEqual(
      [closed.next.actor, closed.next.action, closed.next.workId],
      ['lead', 'replan-dependents', 'a'],
    );
  } finally {
    h.close();
  }
});

test('handoff: пауза очереди — одна остановка без workId, решение ведущего не вытеснено', () => {
  const ctx = hsetup({ scenario: {}, policy: (p) => ((p as any).budgets = { work: { usd: 1 } }) });
  const h = ctx.open();
  try {
    const deps: Record<string, string[]> = { a: [] };
    for (let i = 0; i < 70; i++) deps['w' + String(i).padStart(2, '0')] = [];
    ready(h.engine, graphOf(deps));
    const a = h.engine.claim('c1')!;
    assert.equal(a.workId, 'a');
    h.engine.fail(a.id, a.token, 'gate', { kind: 'gate' });
    h.engine.pause('operator');
    const pack = handoffPack(h);
    const queue = pack.stops.filter((d) => d.queue);
    assert.equal(queue.length, 1, 'пауза очереди — одна запись');
    assert.equal(queue[0]!.workId, undefined);
    assert.equal(queue[0]!.code, 'PAUSED');
    assert.equal(queue[0]!.worksCount, 70);
    assert.equal(queue[0]!.works!.length, HANDOFF_LIMITS.stopWorks);
    assert.ok(
      pack.stops.some((d) => d.workId === 'a' && d.actor === 'lead' && d.action !== 'wait'),
    );
    assert.ok(pack.stops.length < HANDOFF_LIMITS.stops);
    assert.equal(pack.truncated.stops, 0);
    // Пауза — решение человека, следующий шаг — resume; строка поручения её не повторяет.
    assert.deepEqual(
      [pack.next.actor, pack.next.action, pack.next.command, pack.next.workId],
      ['user', 'resume-queue', 'harness resume', undefined],
    );
    assert.ok(pack.works.every((w) => w.blockers.every((b) => b.code !== 'PAUSED')));
    assert.equal(pack.works.length, HANDOFF_LIMITS.works);
    assert.equal(pack.truncated.works, 71 - HANDOFF_LIMITS.works);
    // Бюджеты поручений в пределах и без расхода не перечисляются.
    assert.deepEqual(pack.budgets!.entries, []);
    assert.equal(pack.truncated.budgets, 0, 'не срезаны пределом');
    assert.equal(pack.truncated.budgetsWithin, 71, 'в пределах и без расхода');
    const md = handoffMarkdown(pack);
    assert.match(md, /очередь PAUSED .* Поручений: 70 \(w00, /);
    assert.match(md, /… и ещё 21 поручений/);
    assert.match(md, /Бюджеты поручений в пределах и без расхода не показаны: 71/);
  } finally {
    h.close();
  }
});

test('handoff: пауза runtime — классы отказа и операция паузы в очереди', () => {
  const ctx = hsetup({ scenario: {} });
  const h = ctx.open();
  try {
    ready(h.engine, graphOf({ a: [], b: [] }));
    const a = h.engine.claim('c1')!;
    h.engine.fail(a.id, a.token, 'Not logged in', { kind: 'provider-auth' });
    const pack = handoffPack(h);
    assert.deepEqual(
      [pack.queue.paused, pack.queue.reason, pack.queue.failures],
      [true, 'runtime', ['provider-auth']],
    );
    assert.match(handoffMarkdown(pack), /Классы отказа паузы runtime: provider-auth/);
    // Пауза операции: её имя — в очереди.
    h.engine.resume();
    h.engine.operationPause('op-reconfigure-1');
    const held = handoffPack(h);
    assert.equal(held.queue.operation, 'op-reconfigure-1');
    assert.match(handoffMarkdown(held), /Паузу держит операция op-reconfigure-1/);
  } finally {
    h.close();
  }
});

test('handoff: длинные строки хранилища усечены, а не роняют пакет; секреты политики маскируются', () => {
  const secret = 'sk-handoff-secret-0123456789';
  process.env.HANDOFF_TEST_SECRET = secret;
  const ctx = hsetup({
    scenario: {},
    policy: (p) => {
      (p as any).environment = {
        ...(p as any).environment,
        secrets: { API_KEY: 'HANDOFF_TEST_SECRET' },
      };
    },
  });
  const h = ctx.open();
  try {
    const owner = 'o'.repeat(300);
    ready(h.engine, graphOf({ a: [], b: [], c: [] }), owner);
    const a = h.engine.claim(owner)!;
    h.engine.timingStarted(a.id, a.token, 's'.repeat(250));
    const b = h.engine.claim(owner)!;
    h.engine.fail(b.id, b.token, `token ${secret} rejected`, { kind: 'gate' });
    // Имя операции хранилище само ограничивает 200 знаками; причина — нет.
    h.engine.hold(['c'], 'op-' + 'h'.repeat(197), 'r'.repeat(600));
    const at = new Date(h.engine.clock()).toISOString();
    h.store.transact('task.retry', (tx) => {
      const w = tx.work('b')!;
      tx.putWork({
        ...w,
        recovery: {
          id: 'RC-b',
          property: 'p'.repeat(200),
          basis: h.engine.episodeOf(w, tx),
          runs: [b.id],
          openedAt: at,
          status: 'awaiting-lead',
          calls: 0,
          history: [{ at, event: 'opened' }],
          version: 1,
        },
      });
    });
    const pack = handoffPack(h);
    assert.ok(handoffPackSchema.safeParse(pack).success);
    assert.equal(pack.controller!.owner.length, HANDOFF_LIMITS.name + 1);
    assert.equal(pack.active[0]!.stage!.name.length, HANDOFF_LIMITS.name + 1);
    const c = pack.works.find((w) => w.id === 'c')!;
    assert.equal(c.hold!.operation.length, 200);
    assert.equal(c.hold!.reason.length, HANDOFF_LIMITS.text + 1);
    const wb = pack.works.find((w) => w.id === 'b')!;
    assert.equal(wb.recovery!.property.length, 200);
    assert.equal(wb.next.property, 'p'.repeat(200), 'свойство эпизода сохраняется при диагнозе');
    const json = JSON.stringify(pack);
    assert.ok(!json.includes(secret), 'секрет политики замаскирован');
    assert.match(pack.failures[0]!.error!, /\[REDACTED\]/);
    assert.ok(!handoffMarkdown(pack).includes(secret));
  } finally {
    delete process.env.HANDOFF_TEST_SECRET;
    h.close();
  }
});

test('handoff: clipSafe не разрывает суррогатную пару', () => {
  assert.equal(clipSafe('a'.repeat(299) + '😀' + 'b', 300), 'a'.repeat(299) + '…');
  assert.equal(clipSafe('ok', 300), 'ok');
  assert.equal(clipSafe('a'.repeat(301), 300), 'a'.repeat(300) + '…');
});

/** Usage с сообщённой стоимостью или без неё (неизвестная). */
const usage = (reportedUsd: number | null): Usage => ({
  inputTokens: 10,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reportedUsd,
  complete: reportedUsd !== null,
  source: 'claude-result',
});
const adapter = (u: Usage): RuntimeAdapter => ({
  runtime: 'claude',
  capabilities: () =>
    Promise.resolve({
      runtime: 'claude',
      structuredOutput: true,
      sandbox: ['none'],
      cancellation: true,
      usage: true,
      fixture: true,
    }),
  invoke: () =>
    Promise.resolve({
      status: 'ok',
      model: 'cheap',
      runtimeVersion: 'v',
      text: '',
      usage: u,
      diagnostics: { exitCode: 0 },
    }),
});
let calls = 0;
const request = (): RuntimeRequest => ({
  callId: `handoff-call-${++calls}`,
  task: 'implement',
  binding: { runtime: 'claude', model: 'cheap' },
  cwd: tmpdir(),
  prompt: 'p',
  session: { kind: 'fresh' },
  sandbox: { mode: 'none', writable: [], denied: [], network: { domains: [] } },
  timeoutMs: 60_000,
  env: {},
});

test('handoff: бюджеты — расход против предела, неполный расход — нижняя граница; --graph', async () => {
  const ctx = hsetup({
    scenario: {},
    policy: (p) =>
      ((p as any).budgets = { total: { usd: 5 }, work: { usd: 1 }, onUnknown: 'continue' }),
  });
  const h = ctx.open();
  try {
    ready(h.engine, graphOf({ a: [], b: [] }));
    ready(h.engine, graphOf({ x: [] }, '1', 'g2'));
    const a = h.engine.claim('c1')!;
    assert.equal(a.workId, 'a');
    const signal = new AbortController().signal;
    const meta = { repositoryId: 'app', runId: a.id, stage: 'implementation' };
    await measuredInvoke(h.engine, adapter(usage(0.4)), request(), signal, meta);
    let pack = handoffPack(h);
    const total = pack.budgets!.entries.find((e) => e.scope === 'total')!;
    assert.deepEqual(
      [total.reportedUsd, total.estimatedUsd, total.complete, total.remainingUsd],
      [0.4, 0, true, 4.6],
    );
    const work = pack.budgets!.entries.find((e) => e.scope === 'work' && e.id === 'a')!;
    assert.equal(work.remainingUsd, 0.6);
    assert.ok(!pack.budgets!.entries.some((e) => e.id === 'b'), 'без расхода не перечислен');
    assert.match(handoffMarkdown(pack), /\| total \| within \| \$0\.40 \| \$5\.00 \| \$4\.60/);

    // Вызов без стоимости: сумма — нижняя граница, остатка нет.
    await measuredInvoke(h.engine, adapter(usage(null)), request(), signal, meta);
    pack = handoffPack(h);
    const partial = pack.budgets!.entries.find((e) => e.scope === 'total')!;
    assert.deepEqual(
      [partial.complete, partial.unknownCalls, partial.remainingUsd],
      [false, 1, null],
    );
    assert.match(handoffMarkdown(pack), /≥ \$0\.40 \(неполно: 1 вызовов без стоимости\)/);

    // --graph: бюджеты поручений и групп чужого графа не показываются.
    const other = handoffPack(h, { graphId: 'g2' });
    assert.ok(other.budgets!.entries.every((e) => e.scope !== 'work'));
    assert.ok(other.budgets!.entries.every((e) => e.scope !== 'group' || e.id === 'g2'));
  } finally {
    h.close();
  }
});

test('handoff: худший случай — пределы заполнены, пакет не больше HANDOFF_MAX_BYTES', () => {
  const ctx = hsetup({ scenario: {}, policy: (p) => ((p as any).maxAttempts = 2) });
  const h = ctx.open();
  try {
    const deps = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`w${i}`, []]));
    ready(h.engine, graphOf(deps));
    const long = (c: string) => c.repeat(4000);
    for (let i = 0; i < 80; i++) {
      const run = h.engine.claim('c1')!;
      h.engine.fail(run.id, run.token, long(String(i % 10)) + i, { kind: 'gate' });
    }
    const ids = Array.from({ length: 80 }, (_, i) => `w${i}`);
    h.engine.hold(ids, 'op-' + 'h'.repeat(197), long('r'));
    const pack = handoffPack(h, {
      intentions: Array.from({ length: HANDOFF_LIMITS.intentions }, () => long('i')),
    });
    const bytes = Buffer.byteLength(JSON.stringify(pack));
    assert.ok(bytes <= HANDOFF_MAX_BYTES, `${bytes} байт`);
    // Каждый список: показано + не вошло = всего (80 поручений, 80 провалов,
    // 80 диагнозов поручений и роль controller).
    assert.equal(pack.works.length + pack.truncated.works, 80);
    assert.equal(pack.failures.length + pack.truncated.failures, 80);
    assert.equal(pack.stops.length + pack.truncated.stops, 81);
    assert.ok(pack.works.length <= HANDOFF_LIMITS.works);
    assert.ok(pack.stops.every((d) => d.evidence.length <= HANDOFF_LIMITS.evidence));
    assert.equal(pack.truncated.intentions, HANDOFF_LIMITS.intentions);
  } finally {
    h.close();
  }
});

test('handoff: предел в байтах — ANSI, управляющие символы и кириллица; записи отбрасываются, а не отказ', () => {
  const ctx = hsetup({ scenario: {}, policy: (p) => ((p as any).maxAttempts = 2) });
  const h = ctx.open();
  try {
    const deps = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`w${i}`, []]));
    ready(h.engine, graphOf(deps));
    const ansi = '\x1b[31mОшибка\x1b[0m \x1b]0;title\x07'.repeat(400);
    for (let i = 0; i < 80; i++) {
      const run = h.engine.claim('c1')!;
      h.engine.fail(run.id, run.token, ansi + i, { kind: 'gate' });
    }
    h.store.transact('task.retry', (tx) => {
      for (let i = 0; i < 80; i++) {
        const w = tx.work('w' + i)!;
        tx.putWork({ ...w, order: { ...w.order, title: 'Ж'.repeat(180) } });
      }
    });
    const ids = Array.from({ length: 80 }, (_, i) => `w${i}`);
    h.engine.hold(ids, 'op-1', '\x01'.repeat(3000) + 'Причина'.repeat(100));
    const intentions = Array.from({ length: 20 }, (_, i) => 'Я'.repeat(1000) + i);
    for (const pack of [handoffPack(h, { intentions }), handoffPack(h)]) {
      const json = JSON.stringify(pack);
      assert.ok(Buffer.byteLength(json) <= HANDOFF_MAX_BYTES, `${Buffer.byteLength(json)} байт`);
      assert.ok(handoffPackSchema.safeParse(pack).success);
      assert.ok(!/\\u00[01]/.test(json), 'нет управляющих символов');
      assert.ok(!json.includes('[31m'), 'нет ANSI');
      assert.match(pack.failures[0]!.error!, /^Ошибка Ошибка/);
      const t = pack.truncated;
      assert.equal(pack.works.length + t.works, 80);
      assert.equal(pack.failures.length + t.failures, 80);
    }
    const full = handoffPack(h, { intentions });
    assert.equal(full.truncated.bySize, false, 'реальная доска укладывается после очистки текста');
    // Меньший предел: записи уходят в порядке «намерения, старые провалы,
    // поручения без решения»; решения остаются.
    const before = structuredClone(full);
    const fitted = fitPack(structuredClone(full), 60 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 60 * 1024);
    const t = fitted.truncated;
    assert.equal(t.bySize, true);
    assert.equal(t.intentionsDropped, 20);
    assert.deepEqual(fitted.intentions, []);
    assert.equal(fitted.failures.length + t.failures, 80);
    assert.deepEqual(
      fitted.failures.map((f) => f.runId),
      before.failures.slice(0, fitted.failures.length).map((f) => f.runId),
      'остаются новые провалы',
    );
    // Поручения отбрасываются только после всех намерений и провалов.
    assert.ok(fitted.works.length < before.works.length);
    assert.deepEqual(fitted.failures, []);
    assert.equal(fitted.works.length + t.works, 80);
    assert.deepEqual(
      fitted.works.map((w) => w.id),
      before.works.slice(0, fitted.works.length).map((w) => w.id),
      'остаются первые по порядку',
    );
    assert.ok(handoffPackSchema.safeParse(fitted).success);
    assert.match(handoffMarkdown(fitted), /Пакет урезан по пределу размера/);
    assert.match(handoffMarkdown(fitted), /Отброшено намерений ради предела размера: 20/);
  } finally {
    h.close();
  }
});

test('handoff: предел в байтах — поручение без решения уходит раньше поручений с решением', () => {
  const { h } = board();
  try {
    const pack = handoffPack(h);
    assert.deepEqual(
      pack.works.map((w) => [w.id, w.next.actor, w.next.action]),
      [
        ['c', 'controller', 'wait'],
        ['a', 'lead', 'diagnose-failure'],
        ['b', 'lead', 'diagnose-failure'],
      ],
    );
    // Предел, в который пакет входит без провалов и без поручения c.
    const manual = structuredClone(pack);
    manual.failures = [];
    manual.works = manual.works.filter((w) => w.id !== 'c');
    const limit = Buffer.byteLength(JSON.stringify(manual)) + 8;
    const fitted = fitPack(structuredClone(pack), limit);
    assert.deepEqual(
      fitted.works.map((w) => w.id),
      ['a', 'b'],
    );
    assert.deepEqual([fitted.truncated.failures, fitted.truncated.works], [1, 1]);
    assert.equal(fitted.stops.length, pack.stops.length, 'остановки целы');
  } finally {
    h.close();
  }
});

test('handoff: весь пакет — один снимок; вложенное чтение хранилища без второго BEGIN', () => {
  const { ctx, h } = board();
  try {
    // Второе соединение пишет между внешним и вложенным чтением: вложенное его не видит.
    const other = ctx.open();
    try {
      const seen = h.store.read((outer) => {
        const before = outer.control().paused;
        other.engine.pause('operator');
        const inner = h.store.read((v) => v.control().paused);
        return { before, inner };
      });
      assert.deepEqual(seen, { before: false, inner: false });
      assert.equal(
        h.store.read((v) => v.control().paused),
        true,
        'новое чтение видит запись',
      );
    } finally {
      other.close();
    }
    // handoffPack внутри чтения: status, диагнозы и задания — тот же снимок.
    const pack = h.engine.read(() => handoffPack(h));
    assert.equal(pack.queue.paused, true);
  } finally {
    h.close();
  }
});

test('handoff: только чтение — база и события не меняются', () => {
  const { ctx, h } = board();
  h.close();
  const file = join(ctx.state, 'state.sqlite');
  const sha = () => createHash('sha256').update(readFileSync(file)).digest('hex');
  const before = sha();
  const r = Harness.open({
    stateDir: ctx.state,
    policy: ctx.policy,
    baseDir: ctx.repo.dir,
    readOnly: true,
    readOnlyState: true,
  });
  try {
    const events = r.store.events(0, 10000).length;
    handoffMarkdown(handoffPack(r, { intentions: ['x'] }));
    assert.equal(r.store.events(0, 10000).length, events, 'чтение не пишет событий');
  } finally {
    r.close();
  }
  assert.equal(sha(), before, 'база состояния не изменена');
  // CLI — тоже только чтение.
  assert.equal(harness(['handoff', '--state', ctx.state, '--format', 'md']).status, exitCodes.ok);
  assert.equal(sha(), before, 'база состояния не изменена CLI');
});

test('handoff CLI: JSON-конверт по умолчанию, --format md — Markdown; отказы — JSON', () => {
  const { ctx, h } = board();
  h.close();
  const json = harness(['handoff', '--state', ctx.state]);
  assert.equal(json.status, exitCodes.ok, json.stderr);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, 'handoff');
  assert.ok(cliDataSchemas.handoff.safeParse(envelope.data).success);
  assert.equal(envelope.data.active[0].workId, 'c');
  assert.deepEqual(envelope.data.intentions, []);

  const md = harness(
    ['handoff', '--state', ctx.state, '--format', 'md'].concat([
      '--intent',
      'проверить b',
      '--intent',
      'x',
    ]),
  );
  assert.equal(md.status, exitCodes.ok, md.stderr);
  assert.match(md.stdout, /^# Передача контекста/);
  assert.match(md.stdout, /- проверить b\n- x\n$/);

  const refusal = (args: string[], code: string, exit: number) => {
    const r = harness(args);
    assert.equal(r.status, exit, args.join(' '));
    const e = JSON.parse(r.stdout) as { ok: boolean; error: { code: string; message: string } };
    assert.equal(e.ok, false);
    assert.equal(e.error.code, code, args.join(' '));
    return e;
  };
  const missing = join(mkdtempSync(join(tmpdir(), 'h-handoff-')), 'none');
  refusal(['handoff', '--state', missing], 'NOT_FOUND', exitCodes.refused);
  assert.equal(existsSync(missing), false, 'читающая команда не создаёт каталог');
  refusal(['handoff', '--state', ctx.state, '--graph', 'nope'], 'NOT_FOUND', exitCodes.refused);
  const intents = Array.from({ length: 21 }, (_, i) => ['--intent', 'i' + i]).flat();
  refusal(['handoff', '--state', ctx.state, ...intents], 'INVALID_INPUT', exitCodes.input);
  refusal(['handoff', '--state', ctx.state, '--format', 'html'], 'INVALID_INPUT', exitCodes.input);
  refusal(['handoff', '--state', ctx.state, '--json'], 'INVALID_INPUT', exitCodes.input);
  const foreign = refusal(
    ['status', '--state', ctx.state, '--intent', 'x'],
    'INVALID_INPUT',
    exitCodes.input,
  );
  assert.match(foreign.error.message, /--intent поддерживают: handoff/);
});

test('handoff: договор — перечень шагов совпадает с проекцией, схема опубликована', () => {
  assert.deepEqual([...handoffNextSteps], [...nextSteps]);
  assert.equal(publishedSchemas['handoff-pack'], handoffPackSchema);
});

/** Часы движка остановлены: два пакета одной доски сравнимы целиком. */
const freeze = (h: Harness) => {
  const at = h.engine.clock();
  (h.engine as any).now = () => at;
};

/** Доска на 80 поручений с длинными текстами: пакет урезается меньшим пределом. */
function wideBoard(fill = 'Ж') {
  const ctx = hsetup({ scenario: {}, policy: (p) => ((p as any).maxAttempts = 2) });
  const h = ctx.open();
  const deps = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`w${i}`, []]));
  ready(h.engine, graphOf(deps));
  for (let i = 0; i < 80; i++) {
    const run = h.engine.claim('c1')!;
    h.engine.fail(run.id, run.token, (fill === 'Ж' ? 'Ошибка '.repeat(60) : fill.repeat(290)) + i, {
      kind: 'gate',
    });
  }
  h.store.transact('task.retry', (tx) => {
    for (let i = 0; i < 80; i++) {
      const w = tx.work('w' + i)!;
      tx.putWork({ ...w, order: { ...w.order, title: fill.repeat(180) } });
    }
  });
  freeze(h);
  const intentions = Array.from({ length: 20 }, (_, i) => 'Я'.repeat(1000) + i);
  return { h, intentions };
}

test('handoff maxBytes: меньший предел хоста — тот же порядок отбрасывания и счётчики, что у fitPack', () => {
  const { h, intentions } = wideBoard();
  try {
    const full = handoffPack(h, { intentions });
    assert.equal(full.truncated.bySize, false);
    for (const limit of [HANDOFF_MIN_BYTES, 16 * 1024, 64 * 1024]) {
      const pack = handoffPack(h, { intentions, maxBytes: limit });
      assert.deepEqual(pack, fitPack(structuredClone(full), limit), `предел ${limit}`);
      assert.ok(Buffer.byteLength(JSON.stringify(pack)) <= limit, `${limit}`);
      assert.equal(pack.truncated.bySize, true);
      assert.equal(pack.works.length + pack.truncated.works, 80);
      assert.equal(pack.failures.length + pack.truncated.failures, 80);
      assert.ok(handoffPackSchema.safeParse(pack).success);
    }
    // Предел по умолчанию — HANDOFF_MAX_BYTES.
    assert.deepEqual(handoffPack(h, { intentions, maxBytes: HANDOFF_MAX_BYTES }), full);
    // measure: json и markdown дают одно, пока Markdown не длиннее JSON.
    assert.deepEqual(
      handoffPack(h, { intentions, maxBytes: 32 * 1024, measure: 'markdown' }),
      handoffPack(h, { intentions, maxBytes: 32 * 1024 }),
    );
  } finally {
    h.close();
  }
});

test('handoff measure markdown: Markdown длиннее JSON — укладываются оба, порядок отбрасывания прежний', () => {
  // «|» в ячейке Markdown экранируется: Markdown пакета длиннее его JSON.
  const { h, intentions } = wideBoard('|');
  try {
    const full = handoffPack(h, { intentions });
    const limit = 32 * 1024;
    const byJson = handoffPack(h, { intentions, maxBytes: limit });
    assert.ok(Buffer.byteLength(handoffMarkdown(byJson)) > limit, 'Markdown длиннее предела');
    const md = handoffPack(h, { intentions, maxBytes: limit, measure: 'markdown' });
    assert.ok(Buffer.byteLength(handoffMarkdown(md)) <= limit);
    assert.ok(Buffer.byteLength(JSON.stringify(md)) <= limit);
    assert.ok(md.truncated.works > byJson.truncated.works);
    assert.equal(md.works.length + md.truncated.works, 80);
    assert.deepEqual(
      md.works.map((w) => w.id),
      byJson.works.slice(0, md.works.length).map((w) => w.id),
      'тот же порядок: уходят последние',
    );
    assert.deepEqual(fitPack(structuredClone(full), limit, 'markdown'), md);
    assert.ok(handoffPackSchema.safeParse(md).success);
  } finally {
    h.close();
  }
});

test('handoff maxBytes и measure: значение вне границ — отказ INVALID_INPUT', () => {
  const { h } = board();
  try {
    for (const maxBytes of [0, HANDOFF_MIN_BYTES - 1, HANDOFF_MAX_BYTES + 1, 4096.5, NaN, -1])
      assert.throws(
        () => handoffPack(h, { maxBytes }),
        (e: any) => e.code === 'INVALID_INPUT' && e.issues?.[0]?.path?.[0] === 'maxBytes',
        String(maxBytes),
      );
    assert.throws(
      () => handoffPack(h, { measure: 'html' as any }),
      (e: any) => e.code === 'INVALID_INPUT',
    );
    assert.ok(handoffPack(h, { maxBytes: HANDOFF_MIN_BYTES }));
    assert.ok(handoffPack(h, { maxBytes: HANDOFF_MAX_BYTES }));
  } finally {
    h.close();
  }
});

test('handoff: узкий источник хоста (не Harness) даёт тот же пакет и то же состояние', () => {
  const { h } = board();
  try {
    freeze(h);
    const { engine, policy, workflows } = h;
    const source: HandoffSource = {
      engine,
      policy,
      workflows: {
        list: () => workflows.list(),
        continues: (j, v, o) => workflows.continues(j, v, o),
      },
    };
    assert.ok(!(source instanceof Harness));
    assert.deepEqual(handoffPack(source), handoffPack(h));
    assert.deepEqual(handoffPack(source, { graphId: 'g' }), handoffPack(h, { graphId: 'g' }));
    assert.deepEqual(
      statusOf(source, undefined, { detail: true }),
      h.status(undefined, { detail: true }),
    );
    assert.deepEqual(statusOf({ engine, policy }), h.status());
  } finally {
    h.close();
  }
});

test('handoff: policySecrets из корня пакета — та же функция, что маска пакета по умолчанию', () => {
  assert.equal(root.policySecrets, policySecrets);
  assert.equal(typeof root.composeRedactors, 'function');
  const policy = {
    repositories: [{ gates: [{ secrets: { TOKEN: 'HW_SECRET_A' } }] }],
    secrets: { B: 'HW_SECRET_B' },
  };
  assert.deepEqual(root.policySecrets(policy, { HW_SECRET_A: 'aaa', HW_SECRET_B: 'bbb' }), [
    'aaa',
    'bbb',
  ]);
});
