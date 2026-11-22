/**
 * Разбор ведущего доходит до исполнителя следующей попытки: причина,
 * действие по ней («добавить случаи» у coverage) и гипотеза — в подсказке
 * writer, а не только в состоянии.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HarnessError } from '../src/contracts/index.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';

const broken = "exports.greet = (name) => 'Hi, ' + name;\n";

test('recovery: гипотеза разбора и действие по причине — в подсказке исполнителя третьей попытки', async () => {
  const ctx = setup({
    scenario: {
      writer: [
        implement({ 'src/greet.js': broken }),
        implement({ 'src/greet.js': broken }),
        { ...implement(), recordPrompt: true },
      ],
      reviewer: approve(),
    },
    policy: (p) => {
      p.maxAttempts = 3;
      p.recovery = { mode: 'lead', diagnoseAfter: 2, leadResets: 2 };
    },
  });
  const graph = await runAll(ctx);
  const id = ctx.graph.orders[0]!.id;
  assert.equal(
    ctx.engine.read((v) => v.work(id)!.status),
    'failed',
  );
  ctx.engine.retry(id, undefined, 'recovery');
  await ctx.runner.drain();
  assert.equal(
    ctx.engine.read((v) => v.work(id)!.attempt),
    2,
  );
  assert.throws(
    () => ctx.engine.retry(id, undefined, 'recovery'),
    (e: unknown) => e instanceof HarnessError && e.code === 'DIAGNOSIS_REQUIRED',
  );
  ctx.engine.diagnose(id, {
    cause: 'coverage',
    hypothesis: 'Приветствие должно быть «Hello, <имя>!» с восклицательным знаком',
    evidence: ['gate greets: got Hi, Ada'],
  });
  ctx.engine.retry(id, undefined, 'recovery');
  await ctx.runner.drain();
  assert.equal(
    ctx.engine.read((v) => v.work(id)!.status),
    'done',
    graph.id,
  );
  const prompt = readFileSync(ctx.scenarioPath + '.writer.2.prompt', 'utf8');
  assert.match(prompt, /Lead diagnosis D1 of the previous failed attempts/);
  assert.match(prompt, /cause coverage/);
  assert.match(prompt, /добавить случаи/);
  assert.match(prompt, /Hypothesis to test in this attempt: Приветствие должно быть/);
  assert.match(prompt, /gate greets: got Hi, Ada/);
});
