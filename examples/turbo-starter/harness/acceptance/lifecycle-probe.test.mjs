// Gate `lifecycle-probe` (S04): отмечает момент старта gate в каталоге окружения фазы
// и ведёт себя по файлу режима S04_GATE ({"mode":"pass"|"fail"|"block"}):
//   pass  — успех; fail — отказ проверки; block — ждать, пока процесс harness не исчезнет
//   (сценарий прерывает его SIGKILL при активном окружении).
//   node --test --test-reporter=junit --test-reporter-destination=.artifacts/junit/lifecycle.xml \
//     .harness/acceptance/lifecycle-probe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const dir = env.HARNESS_ENVIRONMENT_DIR ?? env.DEVCONTOUR_ENVIRONMENT_DIR;
const mode =
  env.S04_GATE && existsSync(env.S04_GATE)
    ? JSON.parse(readFileSync(env.S04_GATE, 'utf8')).mode
    : 'pass';

test('S04 lifecycle-probe: gate стартует только в готовом окружении', async () => {
  assert.ok(dir, 'нет каталога окружения фазы');
  const receipt = JSON.parse(readFileSync(join(dir, 'bridge', 'receipt.json'), 'utf8'));
  writeFileSync(
    join(dir, 'gate-started.json'),
    JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      bridge: receipt.status,
      mode,
    }),
  );
  assert.equal(receipt.status, 'ready', 'gate до ready');
  if (mode === 'block') {
    // Процесс harness — владелец окружения из его receipt. Его исчезновение и есть сигнал.
    const owner = JSON.parse(readFileSync(join(dir, 'environment.json'), 'utf8')).ownerPid;
    const alive = () => {
      try {
        process.kill(owner, 0);
        return true;
      } catch (error) {
        return error.code === 'EPERM';
      }
    };
    while (alive()) await new Promise((r) => setTimeout(r, 200));
    assert.fail('процесс harness прерван');
  }
  assert.notEqual(mode, 'fail', 'проверка намеренно провалена (S04 gate failure)');
});
