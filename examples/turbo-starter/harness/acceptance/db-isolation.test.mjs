// Gate `db-isolation` (S03): две попытки в своих worktree и своих Docker-проектах.
// Запуск через compose-bridge exec (env-файл окружения фазы даёт POSTGRES_* и HX_PROJECT):
//   node .harness/compose-bridge.mjs exec -- node --test --test-reporter=junit \
//     --test-reporter-destination=.artifacts/junit/db-isolation.xml .harness/acceptance/db-isolation.test.mjs
// Барьер сценария — каталог S03_BARRIER (явные файлы-события, без случайных задержек).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const project = env.HX_PROJECT;
const task = env.HARNESS_TASK_ID ?? env.DEVCONTOUR_TASK_ID;
const run = env.HARNESS_RUN_ID ?? env.DEVCONTOUR_RUN_ID;
const phase = env.HARNESS_PHASE ?? env.DEVCONTOUR_PHASE;
const barrier = env.S03_BARRIER;
const value = `${task}:${run}:${phase}`;

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const containerOf = (name) =>
  docker(
    'ps',
    '-q',
    '--no-trunc',
    '--filter',
    `label=devcontour.harness.project=${name}`,
    '--filter',
    'label=com.docker.compose.service=postgres',
  );
const psql = (container, sql) =>
  docker('exec', container, 'psql', '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-tAc', sql)
    .split('\n')
    .filter(Boolean);
const volumesOf = (container) =>
  JSON.parse(docker('inspect', '--format', '{{json .Mounts}}', container))
    .map((m) => m.Name)
    .filter(Boolean);
async function waitFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`барьер не наступил: ${path}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

const own = containerOf(project);

test('S03 db-isolation: своя база попытки принимает и возвращает значение', () => {
  assert.ok(project && own, 'нет контейнера postgres проекта ' + project);
  psql(own, 'CREATE TABLE IF NOT EXISTS marks (v text PRIMARY KEY)');
  psql(own, `INSERT INTO marks VALUES ('${value}') ON CONFLICT DO NOTHING`);
  assert.deepEqual(psql(own, 'SELECT v FROM marks ORDER BY v'), [value]);
});

if (phase === 'candidate' && barrier) {
  const other = task === 's03-a' ? 's03-b' : 's03-a';
  test('S03 db-isolation: база другой попытки не видит значение этой, и наоборот', async () => {
    mkdirSync(barrier, { recursive: true });
    const mine = {
      task,
      run,
      project,
      container: own,
      port: Number(env.POSTGRES_PORT),
      volumes: volumesOf(own),
      value,
    };
    writeFileSync(join(barrier, `${task}.json`), JSON.stringify(mine, null, 2));
    const theirs = await waitFile(join(barrier, `${other}.json`), 180_000);
    assert.notEqual(theirs.project, mine.project, 'Docker project');
    assert.notEqual(theirs.port, mine.port, 'порт');
    assert.notDeepEqual(theirs.volumes, mine.volumes, 'тома');
    // Обе стороны записали значения — сверка read-back после барьера.
    writeFileSync(join(barrier, `${task}.written`), '{}');
    await waitFile(join(barrier, `${other}.written`), 180_000);
    const ownRows = psql(own, 'SELECT v FROM marks ORDER BY v');
    const theirRows = psql(theirs.container, 'SELECT v FROM marks ORDER BY v');
    writeFileSync(
      join(barrier, `${task}.readback.json`),
      JSON.stringify({ own: ownRows, other: theirRows }, null, 2),
    );
    assert.deepEqual(ownRows, [value], 'в своей базе только своё значение');
    assert.ok(!theirRows.includes(value), 'значение этой попытки видно в чужой базе');
    assert.ok(theirRows.includes(theirs.value), 'в чужой базе нет её значения');
  });
  if (task === 's03-b')
    test('S03 db-isolation: после teardown попытки A база B цела', async () => {
      // Сценарий подтверждает: окружение A удалено, контрольный ресурс жив.
      const checked = await waitFile(join(barrier, 'a-teardown.checked.json'), 600_000);
      assert.equal(checked.ok, true, JSON.stringify(checked));
      const rows = psql(own, 'SELECT v FROM marks ORDER BY v');
      writeFileSync(join(barrier, 's03-b.after-a-teardown.json'), JSON.stringify(rows));
      assert.deepEqual(rows, [value]);
    });
}
