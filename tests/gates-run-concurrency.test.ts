import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_OWNER } from '../src/contracts/index.ts';
import { engineOf } from './engine-fixture.ts';

/**
 * Запись прогона `harness gates` в состояние, пока другое соединение (как
 * работающий controller) держит транзакцию записи: WAL и busy_timeout
 * хранилища ждут её конца, а не отказывают.
 */
test('gates-runs: запись прогона ждёт чужую транзакцию записи (WAL, busy_timeout) и проходит', async () => {
  const env = engineOf();
  const db = join(env.dir, 'state.sqlite');
  const marker = join(env.dir, 'locked');
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const fs = require('node:fs');
       const db = new DatabaseSync(${JSON.stringify(db)});
       db.exec('PRAGMA busy_timeout=20000; BEGIN IMMEDIATE;');
       db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('holder', 'x')");
       fs.writeFileSync(${JSON.stringify(marker)}, '1');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
       db.exec('COMMIT;');
       db.close();`,
    ],
    { stdio: 'inherit' },
  );
  const exited = new Promise<number | null>((done) => holder.on('exit', done));
  for (let i = 0; i < 400 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(existsSync(marker), 'чужая транзакция записи открыта');
  const started = Date.now();
  env.engine.recordGatesRun('app', 'a'.repeat(40), {
    id: 'GA-1',
    at: new Date().toISOString(),
    digest: 'd'.repeat(64),
    passed: true,
    gates: [{ gate: 'unit', status: 'passed', basis: 'b'.repeat(64) }],
  });
  const waited = Date.now() - started;
  assert.equal(await exited, 0);
  assert.ok(waited >= 500, `запись дождалась конца чужой транзакции (${waited} мс)`);
  const runs = env.engine.read(
    (v) => v.local('gates-runs', WORKSPACE_OWNER, `app@${'a'.repeat(40)}`)?.runs,
  );
  assert.equal(runs?.[0]?.id, 'GA-1');
  env.store.close();
});
