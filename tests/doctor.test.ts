import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { doctor } from '../src/control/doctor.ts';
import { HARNESS_VERSION } from '../src/package.ts';
import { engineOf, graphOf, ready } from './engine-fixture.ts';

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
