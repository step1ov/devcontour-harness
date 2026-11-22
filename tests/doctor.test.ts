/* eslint-disable @typescript-eslint/no-explicit-any -- фикстура правит сырой JSON политики. */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { doctor } from '../src/control/doctor.ts';
import { HARNESS_VERSION } from '../src/package.ts';
import { engineOf, graphOf, policyOf, ready } from './engine-fixture.ts';

test('doctor называет версии движка, записавшие состояние, и отклоняет состояние более новой версии без записи', async () => {
  const { engine, store, dir } = engineOf();
  ready(engine, graphOf({ a: [] }));
  assert.equal(engine.lead('c1'), true);
  assert.ok(engine.claim('c1'));
  store.close();
  // Попытка, записанная прежней версией движка, — в том же состоянии.
  const file = join(dir, 'state.sqlite');
  const db = new DatabaseSync(file);
  const doc = JSON.parse((db.prepare('SELECT data FROM state').get() as { data: string }).data) as {
    attempts: Record<string, unknown>[];
  };
  doc.attempts.push({ ...doc.attempts[0], id: 'older', engineVersion: '0.1.0-alpha.0' });
  db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(doc));
  db.close();

  const report = await doctor(undefined, {}, dir);
  assert.equal(report.state?.compatible, true);
  assert.deepEqual(report.state?.engineVersions, {
    controller: HARNESS_VERSION,
    attempts: ['0.1.0-alpha.0', HARNESS_VERSION].sort(),
  });

  // Поле, которого эта версия не знает: несовместимо, данные не тронуты.
  const raw = new DatabaseSync(file);
  const newer = JSON.parse(
    (raw.prepare('SELECT data FROM state').get() as { data: string }).data,
  ) as {
    controller: Record<string, unknown>;
  };
  newer.controller = { ...newer.controller, futureField: true };
  raw.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(newer));
  raw.close();
  const data = () => {
    const d = new DatabaseSync(file);
    try {
      return (d.prepare('SELECT data FROM state').get() as { data: string }).data;
    } finally {
      d.close();
    }
  };
  const before = data();
  const refused = await doctor(undefined, {}, dir);
  assert.equal(refused.state?.compatible, false);
  assert.equal(refused.state?.engineVersions, undefined);
  assert.ok(refused.problems.some((p) => /более новая версия|формату этой версии/.test(p)));
  assert.equal(data(), before, 'doctor изменил состояние');
});

test('doctor показывает будущий корень checkout без создания кэша или заданного корня', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'harness-doctor-home-')));
  const previous = { HOME: process.env.HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
  process.env.HOME = home;
  delete process.env.XDG_CACHE_HOME;
  try {
    const policy = policyOf();
    policy.repositories[0]!.path = join(home, 'project');
    const state = join(home, 'project', '.harness-state');
    for (const checkoutRoot of [undefined, join(home, 'configured', 'checkouts')]) {
      const report = await doctor(policy, {}, state, undefined, {
        baseDir: home,
        ...(checkoutRoot ? { checkoutRoot } : {}),
      });
      assert.equal(report.checkouts?.placement, checkoutRoot ? 'configured' : 'cache');
      assert.ok(report.checkouts?.root);
      assert.equal(existsSync(report.checkouts.root), false);
      assert.deepEqual(readdirSync(home), [], 'doctor изменил домашний каталог');
    }
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor (alpha.64): модель и effort по ролям из политики; модель Codex вне кэша моделей — предупреждение, не проблема', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'harness-codex-home-')));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const policy = policyOf((p: Record<string, any>) => {
      p.roles = {
        developer: { writer: { runtime: 'codex', model: 'gpt-known', effort: 'medium' } },
      };
      p.review = {
        code: { reviewer: { runtime: 'claude', model: 'claude-x', effort: 'high' } },
        plan: { reviewer: { runtime: 'codex', model: 'gpt-typo', effort: 'high' } },
        contract: {
          reviewer: { runtime: 'codex', model: 'gpt-known', effort: 'xhigh' },
          alternates: [{ runtime: 'claude' }],
        },
      };
    });
    const run = () =>
      doctor(policy, {}, undefined, undefined, undefined, { resourceDatabase: false });
    const plain = await run();
    assert.deepEqual(plain.models, [
      { use: 'writer developer', runtime: 'codex', model: 'gpt-known', effort: 'medium' },
      { use: 'code-review developer', runtime: 'claude', model: 'claude-x', effort: 'high' },
      { use: 'plan-review', runtime: 'codex', model: 'gpt-typo', effort: 'high' },
      { use: 'contract-review', runtime: 'codex', model: 'gpt-known', effort: 'xhigh' },
      { use: 'contract-review (запасной 1)', runtime: 'claude' },
    ]);
    // Кэша моделей нет — проверки нет.
    assert.equal(plain.warnings!.filter((w) => w.startsWith('codex-')).length, 0);

    writeFileSync(
      join(home, 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'gpt-known',
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'medium' },
              { effort: 'high' },
            ],
          },
        ],
      }),
    );
    const checked = await run();
    const codex = checked.warnings!.filter((w) => w.startsWith('codex-'));
    assert.equal(codex.length, 2, JSON.stringify(codex));
    assert.match(codex[0]!, /^codex-model-unknown: модели gpt-typo \(plan-review\) нет/);
    assert.match(codex[0]!, /model is not supported/);
    assert.match(codex[1]!, /^codex-effort-unknown: gpt-known effort xhigh \(contract-review\)/);
    assert.equal(
      checked.problems.some((p) => p.includes('gpt-typo')),
      false,
      'неизвестная модель — предупреждение, а не проблема',
    );
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
});
