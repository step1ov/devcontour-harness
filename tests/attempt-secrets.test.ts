/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тест правит сырой JSON политики до разбора схемой.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  ATTEMPT_SECRETS_KEY,
  attemptSecrets,
  attemptVariables,
} from '../src/environment/attempt-ports.ts';
import { executionEnvironment } from '../src/environment/lifecycle.ts';
import { executionPolicySchema } from '../src/contracts/index.ts';
import { attemptSecretsNote } from '../src/engine/prompt.ts';
import { example } from './fixtures.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';

// alpha.72, P9-1: тестовые секреты попытки (`attemptEnv.secrets`) даёт
// harness — вопрос исполнителя «откуда взять секреты до env-up» не возникает.

test('alpha.72: attemptEnv.secrets — схема: имена переменных, без повторов и пересечения с портами', () => {
  const parse = (attemptEnv: unknown) =>
    executionPolicySchema.safeParse({ ...example('policy'), attemptEnv }).success;
  assert.equal(parse({ secrets: ['POSTGRES_PASSWORD', 'IMGPROXY_KEY'] }), true);
  assert.equal(parse({ secrets: ['A', 'A'] }), false);
  assert.equal(parse({ ports: ['API_PORT'], secrets: ['API_PORT'] }), false);
  assert.equal(parse({ secrets: ['HARNESS_X'] }), false);
  assert.equal(parse({ secrets: ['PATH'] }), false);
  assert.equal(parse({ secrets: ['lower'] }), false);
});

test('alpha.72: значения — случайные на попытку, заданные окружением политики не перекрываются', () => {
  const policy = { secrets: ['POSTGRES_PASSWORD', 'IMGPROXY_KEY', 'GIVEN', 'INHERITED'] };
  const env = { inherit: ['INHERITED'], values: { GIVEN: 'x' }, secrets: {} };
  const a = attemptSecrets(policy, [undefined, env]);
  const b = attemptSecrets(policy, [env]);
  assert.deepEqual(Object.keys(a).sort(), ['IMGPROXY_KEY', 'POSTGRES_PASSWORD']);
  for (const v of Object.values(a)) assert.match(v, /^[0-9a-f]{48}$/);
  assert.notEqual(a.POSTGRES_PASSWORD, b.POSTGRES_PASSWORD, 'у каждой попытки свои');
  assert.notEqual(a.POSTGRES_PASSWORD, a.IMGPROXY_KEY);
  assert.deepEqual(attemptSecrets(undefined), {});
  assert.deepEqual(attemptSecrets({ ports: ['P'] }), {});
  // Переменные попытки несут значения и список имён; без секретов — прежние.
  const vars = attemptVariables('a1', {}, undefined, 'app', undefined, a);
  assert.equal(vars.POSTGRES_PASSWORD, a.POSTGRES_PASSWORD);
  assert.equal(vars[ATTEMPT_SECRETS_KEY], 'IMGPROXY_KEY,POSTGRES_PASSWORD');
  assert.ok(vars.HARNESS_ATTEMPT_ENV_KEYS!.split(',').includes('POSTGRES_PASSWORD'));
  assert.equal(ATTEMPT_SECRETS_KEY in attemptVariables('a1', {}, undefined, 'app'), false);
});

test('alpha.72: окружение шага маскирует тестовые секреты и называет их в HARNESS_SECRET_NAMES', () => {
  const secrets = attemptSecrets({ secrets: ['DB_PASSWORD'] });
  const value = secrets.DB_PASSWORD!;
  const execution = executionEnvironment(
    [{ inherit: [], values: {}, secrets: { API_TOKEN: 'SRC_TOKEN' } }],
    attemptVariables('a1', {}, undefined, 'app', undefined, secrets),
    { PATH: '/bin', SRC_TOKEN: 'token-value-123' },
  );
  assert.equal(execution.env.DB_PASSWORD, value);
  assert.equal(execution.env.HARNESS_SECRET_NAMES, 'API_TOKEN,DB_PASSWORD');
  assert.equal(execution.redact(`pw=${value} t=token-value-123`).includes(value), false);
  assert.equal(execution.redact(`t=token-value-123`).includes('token-value-123'), false);
  // Очистка в новом процессе: те же переменные из receipt — та же маска.
  const again = executionEnvironment(
    [],
    { DB_PASSWORD: value, [ATTEMPT_SECRETS_KEY]: 'DB_PASSWORD' },
    { PATH: '/bin' },
  );
  assert.equal(again.redact(value).includes(value), false);
  assert.equal(again.env.HARNESS_SECRET_NAMES, 'DB_PASSWORD');
});

test('alpha.72: подсказка исполнителю называет тестовые секреты и запрещает постоянные пароли', () => {
  const note = attemptSecretsNote(['DB_PASSWORD', 'JWT_SECRET']);
  assert.match(note, /DB_PASSWORD, JWT_SECRET/);
  assert.match(note, /random value .* per attempt/);
  assert.match(note, /do not ask how to provide them/);
  assert.match(note, /attemptEnv\.secrets/);
});

test(
  'alpha.72: попытка облегчённого режима — gate получает тестовые секреты переменной и файлом 0600, журналы их не хранят',
  { timeout: 120_000 },
  async () => {
    const gate = `
const fs = require('fs');
const e = process.env;
const problems = [];
if (!/^[0-9a-f]{48}$/.test(e.DB_PASSWORD || '')) problems.push('secret ' + (e.DB_PASSWORD || '').length);
if (e.PRESET !== 'from-policy') problems.push('preset');
if (!(e.HARNESS_SECRET_NAMES || '').split(',').includes('DB_PASSWORD')) problems.push('names');
try {
  const file = JSON.parse(fs.readFileSync(e.HARNESS_ATTEMPT_ENV_FILE, 'utf8'));
  if (file.DB_PASSWORD !== e.DB_PASSWORD) problems.push('env-file value');
  if ('PRESET' in file) problems.push('env-file preset');
  if ((fs.statSync(e.HARNESS_ATTEMPT_ENV_FILE).mode & 0o077) !== 0) problems.push('env-file mode');
} catch (x) { problems.push('env-file ' + x.message); }
// Значение в выводе gate — журнал его маскирует.
console.log('secret is ' + e.DB_PASSWORD);
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,
  '<testsuite><testcase classname="light" name="secrets">' + (problems.length ? '<failure message="' + problems.join(';').replace(/[<&"]/g, '') + '"/>' : '') + '</testcase></testsuite>');
`;
    const ctx = setup({
      scenario: { writer: implement(), reviewer: approve() },
      files: { 'test/secrets.js': gate },
      policy: (p) => {
        p.harnessMode = 'light';
        p.maxAttempts = 1;
        p.attemptEnv = { secrets: ['DB_PASSWORD', 'PRESET'] };
        (p.environment as { values: Record<string, string> }).values.PRESET = 'from-policy';
        const repo = (p.repositories as Record<string, any>[])[0]!;
        repo.gates[0].command = [process.execPath, 'test/secrets.js'];
        repo.lifecycle = {
          setup: [{ id: 'up', command: ['true'] }],
          teardown: [{ id: 'down', command: ['true'] }],
        };
      },
    });
    await runAll(ctx);
    const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(a.status, 'succeeded', a.error);
    const files = (name: string) =>
      execFileSync('find', [ctx.state, '-name', name], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean);
    const [envFile] = files('attempt-env.json');
    assert.ok(envFile, 'файл окружения попытки есть');
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    const value = (JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>)
      .DB_PASSWORD!;
    assert.match(value, /^[0-9a-f]{48}$/);
    // Receipt окружения хранит секрет для очистки в новом процессе.
    for (const r of files('environment.json'))
      assert.equal(
        (JSON.parse(readFileSync(r, 'utf8')) as { attemptEnv?: Record<string, string> }).attemptEnv
          ?.DB_PASSWORD,
        value,
      );
    // Кроме файла окружения и receipt, значение нигде не записано: вывод
    // gate, evidence и состояние его маскируют.
    const leaks = execFileSync('grep', ['-rlF', value, ctx.state], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((f) => !['attempt-env.json', 'environment.json'].includes(basename(f)));
    assert.deepEqual(leaks, []);
    // Вывод gate записан (маской), то есть проверка не пустая.
    assert.ok(
      execFileSync('grep', ['-rlF', 'secret is', ctx.state], { encoding: 'utf8' }).trim(),
      'вывод gate сохранён',
    );
  },
);
