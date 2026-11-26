/**
 * alpha.72, P9-3: пауза, которую поставил ведущий (перепланирование), — его
 * решение: status, explain и представление называют ведущего тем, кто её
 * снимет, и не говорят человеку «от вас: возобновить выдачу».
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliDataSchemas, controlStateSchema, operatorViewSchema } from '../src/contracts/index.ts';
import { collectOperatorViewInput } from '../src/control/operator-view.ts';
import { operatorView } from '../src/projections/operator-view.ts';
import { statusOf, statusText } from '../src/control/status.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop, queuePause } from '../src/projections/stop.ts';
import type { Engine } from '../src/engine/engine.ts';
import { engineOf, graphOf, ready } from './engine-fixture.ts';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (...args: string[]) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', cli, ...args],
    { encoding: 'utf8' },
  );
  return {
    status: r.status,
    stderr: r.stderr,
    json: JSON.parse(r.stdout) as { ok: boolean; data?: unknown; error?: { code: string } },
  };
};

const noJobs = { list: () => [], continues: () => false };
const sourceOf = (engine: Engine) => ({ engine, policy: engine.policy, workflows: noJobs });

test('alpha.72: пауза ведущего — status, explain и строка этапа называют ведущего; человеку ничего', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [], b: [] }));
  env.engine.pause('operator', 'lead');
  const control = env.engine.read((v) => v.control());
  controlStateSchema.parse(control);
  assert.equal(control.pausedBy, 'lead');
  const event = env.store
    .events(0, 1000)
    .filter((e) => e.type === 'control.paused')
    .at(-1)!;
  assert.deepEqual(event.payload, { reason: 'operator', by: 'lead' });

  const data = cliDataSchemas.status.parse(
    statusOf(sourceOf(env.engine), undefined, { detail: true }),
  );
  assert.equal(data.detail?.queue.actor, 'lead');
  assert.equal(data.detail?.queue.by, 'lead');
  const a = data.works.find((w) => w.id === 'a')!;
  assert.deepEqual(a.stage?.needs, { actor: 'lead', action: 'resume-queue' });
  assert.match(a.stage.line, /не выдаётся: пауза очереди: поставил ведущий/);
  assert.match(a.stage.line, /от вас: ничего — ход ведущего \(возобновить выдачу\)/);
  assert.doesNotMatch(a.stage.line, /поставил оператор/);
  assert.match(statusText(data), /поставил ведущий \(перепланирование\) — снимет ведущий/);
  const stop = stopInputsOf(sourceOf(env.engine), { maxAttempts: 3, repairBudget: 2 })
    .filter((i) => i.kind === 'work')
    .map(explainStop)[0]!;
  assert.deepEqual([stop.actor, stop.action], ['lead', 'resume-queue']);
  assert.match(stop.message, /Паузу поставил ведущий/);

  // Представление: очередь и эскалации называют ведущего, не человека.
  const view = operatorViewSchema.parse(
    operatorView(
      collectOperatorViewInput(
        {
          engine: env.engine,
          policy: env.engine.policy,
          workflows: noJobs as never,
          stateDir: env.dir,
          baseDir: env.dir,
        },
        { raw: env.engine.policy, warnings: [], baseDir: env.dir },
        { now: env.engine.clock(), lang: 'ru' },
      ),
    ),
  );
  assert.equal(view.progress.queue.actor, 'lead');
  assert.ok(
    !view.escalations.some((e) => e.action === 'resume-queue' && e.actor === 'operator'),
    JSON.stringify(view.escalations),
  );

  // Снятие паузы снимает и автора; пауза человека — прежняя.
  env.engine.resume();
  assert.equal(env.engine.read((v) => v.control()).pausedBy, undefined);
  env.engine.pause('operator');
  assert.equal(env.engine.read((v) => v.control()).pausedBy, undefined);
  const human = cliDataSchemas.status.parse(
    statusOf(sourceOf(env.engine), undefined, { detail: true }),
  );
  assert.equal(human.detail?.queue.actor, 'user');
  assert.equal(human.detail?.queue.by, undefined);
  assert.match(human.works[0]!.stage!.line, /поставил оператор/);
  // Пауза человека поверх паузы ведущего — человека.
  env.engine.pause('operator', 'lead');
  env.engine.pause('operator', 'operator');
  assert.equal(env.engine.read((v) => v.control()).pausedBy, undefined);
  // Автор читается только у паузы operator.
  assert.equal(
    queuePause({ paused: true, pauseReason: 'shutdown', pausedBy: 'lead' })?.actor,
    'user',
  );
  env.store.close();
});

test('alpha.72: CLI pause — --by lead, в открытой сессии ведущего по умолчанию ведущий; --by operator — человек', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [] }));
  writeFileSync(
    join(env.dir, 'binding.json'),
    JSON.stringify({ policy: env.engine.policy, baseDir: env.dir }),
  );
  env.store.close();
  const queue = () =>
    (
      harness('status', '--state', env.dir, '--detail').json.data as {
        detail: { queue: { actor?: string; by?: string } };
      }
    ).detail.queue;
  assert.equal(
    harness('pause', '--state', env.dir, '--by', 'boss').json.error?.code,
    'INVALID_INPUT',
  );
  assert.equal(harness('pause', '--state', env.dir).status, 0);
  assert.deepEqual(queue(), { ...queue(), actor: 'user' });
  assert.equal(queue().by, undefined);
  assert.equal(harness('pause', '--state', env.dir, '--by', 'lead').status, 0);
  assert.equal(queue().by, 'lead');
  assert.equal(queue().actor, 'lead');
  // Открытая сессия ведущего: пауза без --by — его; --by operator — человека.
  assert.equal(harness('resume', '--state', env.dir).status, 0);
  assert.equal(harness('lead', 'begin', '--state', env.dir, '--ttl', '30m').status, 0);
  assert.equal(harness('pause', '--state', env.dir).status, 0);
  assert.equal(queue().by, 'lead');
  assert.equal(harness('pause', '--state', env.dir, '--by', 'operator').status, 0);
  assert.equal(queue().by, undefined);
  assert.equal(queue().actor, 'user');
});
