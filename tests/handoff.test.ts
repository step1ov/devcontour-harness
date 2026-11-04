/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument --
 * Фикстура правит сырой JSON политики; ответ CLI читается как есть.
 */
/**
 * `harness handoff` и `handoffPack`: пакет передачи контекста из хранилища.
 * Состояние создаётся операциями движка (выдача, отказ, стадия) — без
 * runtime и моделей.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HANDOFF_LIMITS,
  cliDataSchemas,
  exitCodes,
  handoffNextSteps,
  handoffPackSchema,
  publishedSchemas,
} from '../src/contracts/index.ts';
import { handoffMarkdown, handoffPack } from '../src/index.ts';
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

    // Провал с классом отказа и кодом.
    assert.equal(pack.failures.length, 1);
    assert.deepEqual(
      {
        runId: pack.failures[0]!.runId,
        kind: pack.failures[0]!.failureKind,
        code: pack.failures[0]!.code,
      },
      { runId: a.id, kind: 'gate', code: 'GATE_FAILED' },
    );
    assert.ok(pack.failures[0]!.error!.endsWith('…'));

    // Остановки — explain; решения человека и ведущего — первыми.
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

    // Следующий шаг: решение, если оно есть, иначе ожидание controller.
    assert.deepEqual(
      [pack.next.actor, pack.next.action, pack.next.workId, pack.next.code],
      ['lead', 'diagnose-failure', 'a', 'GATE_FAILED'],
    );

    assert.deepEqual(pack.intentions, ['Разобрать отказ gate у a']);
    assert.deepEqual(pack.truncated, { works: 0, stops: 0, failures: 0, unfinished: 0 });
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
    assert.match(md, /candidate-test:unit/);
    assert.match(md, /- Разобрать отказ gate у a/);
    assert.ok(!md.includes('x'.repeat(HANDOFF_LIMITS.text + 1)), 'длинный текст усечён');

    // Фильтр графа: неизвестный граф — NOT_FOUND.
    assert.equal(handoffPack(h, { graphId: 'g' }).summary.works, 3);
    assert.throws(() => handoffPack(h, { graphId: 'nope' }), { code: 'NOT_FOUND' });
    assert.throws(
      () => handoffPack(h, { intentions: Array.from({ length: 21 }, (_, i) => 'i' + i) }),
      { code: 'INVALID_INPUT' },
    );
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
    // Владелец пропал: срок владения в прошлом, запись попытки не закрыта.
    h.store.transact('run.phase', (tx) =>
      tx.putAttempt({ ...tx.attempt(stuck.id)!, leaseUntil: Date.now() - 1000 }),
    );
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

test('handoff CLI: Markdown по умолчанию, --json — конверт по договору; отказы — JSON', () => {
  const { ctx, h } = board();
  h.close();
  const md = harness(['handoff', '--state', ctx.state, '--intent', 'проверить b', '--intent', 'x']);
  assert.equal(md.status, exitCodes.ok, md.stderr);
  assert.match(md.stdout, /^# Передача контекста/);
  assert.match(md.stdout, /- проверить b\n- x\n$/);

  const json = harness(['handoff', '--state', ctx.state, '--json']);
  assert.equal(json.status, exitCodes.ok, json.stderr);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, 'handoff');
  assert.ok(cliDataSchemas.handoff.safeParse(envelope.data).success);
  assert.equal(envelope.data.active[0].workId, 'c');
  assert.deepEqual(envelope.data.intentions, []);

  const missing = join(mkdtempSync(join(tmpdir(), 'h-handoff-')), 'none');
  const refused = harness(['handoff', '--state', missing]);
  assert.equal(refused.status, exitCodes.refused);
  assert.equal(JSON.parse(refused.stdout).error.code, 'NOT_FOUND');
  assert.equal(existsSync(missing), false, 'читающая команда не создаёт каталог');

  const foreign = harness(['status', '--state', ctx.state, '--json']);
  assert.equal(foreign.status, exitCodes.input);
  assert.match(JSON.parse(foreign.stdout).error.message, /--json поддерживают: handoff/);
});

test('handoff: договор — перечень шагов совпадает с проекцией, схема опубликована', () => {
  assert.deepEqual([...handoffNextSteps], [...nextSteps]);
  assert.equal(publishedSchemas['handoff-pack'], handoffPackSchema);
});
