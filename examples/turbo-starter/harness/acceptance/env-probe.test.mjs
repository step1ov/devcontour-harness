// Gate `env-probe` (S06): процесс проверки получает только объявленное окружение.
// Значения canary не выводятся; в каталог окружения пишутся только имена переменных.
// Если в дереве есть `s06/trigger-fail`, проверка намеренно падает с выводом секрета —
// harness обязан замаскировать его в логах, evidence и итоге.
//   node .harness/compose-bridge.mjs exec -- node --test --test-reporter=junit \
//     --test-reporter-destination=.artifacts/junit/env-probe.xml .harness/acceptance/env-probe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const dir = env.HARNESS_ENVIRONMENT_DIR ?? env.DEVCONTOUR_ENVIRONMENT_DIR;
/** Ключи, которые задаёт harness для шагов и gates (HARNESS_ — псевдонимы DEVCONTOUR_). */
const HARNESS_KEYS = [
  'REPOSITORY_ID',
  'RUN_ID',
  'TASK_ID',
  'PHASE',
  'RESOURCES_JSON',
  'DEPENDENCIES_JSON',
  'COMPONENTS_JSON',
  'ENVIRONMENT_DIR',
  'REPORT_PATH',
  'PROCESS_MARK',
];
const BASE = ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'CI'];
/** Добавляют node --test и compose-bridge exec; macOS добавляет __CF_USER_TEXT_ENCODING каждому процессу. */
const TOOLING = ['NODE_TEST_CONTEXT', 'HX_PROJECT', 'HX_ENV_DIR', '__CF_USER_TEXT_ENCODING'];
/** Свежесть test-gate: harness отключает Turbo cache и кэш тестов Go (значения не секреты). */
const FRESHNESS = ['TURBO_FORCE', 'GOFLAGS'];

test('S06 env-probe: разрешённая переменная доступна', () => {
  assert.match(env.S06_ALLOWED ?? '', /^canary-allowed-/);
});
test('S06 env-probe: неразрешённая переменная оператора отсутствует', () => {
  assert.equal(env.S06_DISALLOWED, undefined);
  assert.equal(env.DEVCONTOUR_OPERATOR_CANARY, undefined, 'чужая DEVCONTOUR_* переменная');
  assert.equal(env.HARNESS_OPERATOR_CANARY, undefined, 'чужая HARNESS_* переменная');
});
test('S06 env-probe: секрет передан процессу по имени из политики', () => {
  assert.match(env.HX_DB_PASSWORD ?? '', /^canary-secret-/);
  assert.equal(env.POSTGRES_PASSWORD, env.HX_DB_PASSWORD, 'env-файл окружения');
});
test('S06 env-probe: окружение — только объявленное и совместимое HARNESS_/DEVCONTOUR_', () => {
  const declared = (env.S06_DECLARED ?? '').split(',').filter(Boolean);
  const envFile = (env.S06_ENV_FILE_KEYS ?? '').split(',').filter(Boolean);
  const allowed = new Set([
    ...BASE,
    ...TOOLING,
    ...FRESHNESS,
    ...declared,
    ...envFile,
    ...HARNESS_KEYS.flatMap((k) => ['DEVCONTOUR_' + k, 'HARNESS_' + k]),
  ]);
  const keys = Object.keys(env).sort();
  if (dir) {
    mkdirSync(join(dir, 'probe'), { recursive: true });
    writeFileSync(
      join(dir, 'probe', `env-keys-${env.DEVCONTOUR_PHASE}.json`),
      JSON.stringify(keys),
    );
  }
  const extra = keys.filter((k) => !allowed.has(k));
  assert.deepEqual(extra, [], 'необъявленные переменные: ' + extra.join(', '));
  for (const k of ['RUN_ID', 'TASK_ID', 'PHASE', 'REPOSITORY_ID'])
    assert.equal(env['HARNESS_' + k], env['DEVCONTOUR_' + k], 'псевдоним HARNESS_' + k);
});
if (existsSync('s06/trigger-fail'))
  test('S06 env-probe: команда падает с выводом секрета (маскирование harness)', () => {
    const secret = env.HX_DB_PASSWORD;
    console.log('stdout leak attempt: ' + secret);
    console.error('stderr leak attempt: ' + secret);
    throw new Error('failure with secret ' + secret);
  });
