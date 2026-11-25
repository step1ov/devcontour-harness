import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { controllerTemp } from '../src/environment/controller-temp.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';

/**
 * Ревью A1 L5: через обычный runner проверки reviewer идут в одноразовой
 * копии коммита (cwd проверки — копия, не дерево кандидата), копия
 * убирается и после успешного вызова, и после отказа reviewer.
 */

const probePolicy = (p: Record<string, unknown>) => {
  p.runTimeoutMs = 60_000;
  p.reviewProbes = { commandTimeoutMs: 20_000, budgetMs: 40_000, reserveMs: 5_000 };
};
const pwd = [process.execPath, '-e', 'console.log("cwd=" + process.cwd())'];
const probeDirs = () => readdirSync(controllerTemp.dir()).filter((n) => n.startsWith('hx-probe-'));

test('ревью A1 L5: runner — проверки reviewer в копии коммита; запись probeCopy в review.json; копия убрана', async () => {
  const before = probeDirs().length;
  const ctx = setup({
    writer: 'claude',
    reviewer: 'codex',
    scenario: {
      writer: implement(),
      reviewer: [
        { ...approve(), probes: [pwd] },
        { ...approve(), probes: [pwd] },
      ],
    },
    policy: probePolicy,
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts())[0]!;
  assert.equal(a.status, 'succeeded', a.error);
  const reviews = a.evidence.filter((e) => e.kind === 'review');
  assert.ok(reviews.length >= 1);
  for (const e of reviews) {
    const saved = JSON.parse(readFileSync(e.log, 'utf8')) as {
      probeCopy?: { status: string };
      probes?: { output?: string }[];
    };
    assert.equal(saved.probeCopy?.status, 'copy', 'проверки шли в копии');
    const journal = readFileSync(join(e.log, '..', 'probes.jsonl'), 'utf8');
    assert.match(journal, /cwd=[^"\\]*hx-probe-[^"\\]*\/tree/, 'cwd проверки — копия');
  }
  assert.equal(probeDirs().length, before, 'копии убраны');
  ctx.store.close();
});

test('ревью A1 L5: отказ reviewer после проверки — копия всё равно убрана', async () => {
  const before = probeDirs().length;
  const ctx = setup({
    writer: 'claude',
    reviewer: 'codex',
    scenario: {
      writer: implement(),
      reviewer: [{ ...approve(), probes: [pwd], exit: 1 }],
    },
    policy: (p: Record<string, unknown>) => {
      probePolicy(p);
      p.maxAttempts = 1;
    },
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts())[0]!;
  assert.notEqual(a.status, 'succeeded');
  assert.equal(probeDirs().length, before, 'копия убрана после отказа');
  ctx.store.close();
});
