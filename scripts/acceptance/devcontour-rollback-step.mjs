/**
 * C02/T42c': дополнительный шаг к `scripts/rollback-scenario.ts` DevContour —
 * та же фикстура (конфигурация, владелец роли, принятие с настоящим коммитом),
 * но запись ревью попытки несёт поля протокола alpha.6 (`reviewRound`,
 * `findings[].id/status`), а процесс «падает» с живой ролью controller. Так
 * предпосылка «формат состояния новой версии изменён» становится настоящей,
 * без изменения кода DevContour и без нового метода хоста.
 *
 *   node --import tsx devcontour-rollback-step.mjs crash-review <dir> <central|component> <задача>
 *   (cwd и env DEVCONTOUR_COPY — копия DevContour с проверяемым архивом)
 *
 * Итог — JSON в stdout (как у шагов rollback-scenario: accepted, leader, tasks,
 * databases); несоответствие — исключение и ненулевой exit.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [step, dir, topology, letter] = process.argv.slice(2);
const copy = process.env.DEVCONTOUR_COPY;
if (step !== 'crash-review' || !dir || !topology || !letter || !copy) {
  console.error(
    'devcontour-rollback-step: crash-review <dir> <topology> <задача> (DEVCONTOUR_COPY)',
  );
  process.exit(2);
}
const load = (rel) => import(pathToFileURL(join(copy, rel)).href);
const { configSchema } = await load('src/core/model.ts');
const { repositories } = await load('src/core/repositories.ts');
const { DevContour } = await load('src/core/service.ts');
const { Store } = await load('src/core/store.ts');
const version = (rel) => JSON.parse(readFileSync(join(copy, rel), 'utf8')).version;
const devcontourVersion = version('package.json');
const harnessVersion = version('node_modules/devcontour-harness/package.json');
// Владелец роли — та же формула, что в rollback-scenario.ts.
const owner = 'controller-' + devcontourVersion + '-' + harnessVersion;
const product = join(dir, 'product');
const workspace = join(dir, 'workspace');
const DIGEST = 'e'.repeat(64);
const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Rollback check',
      GIT_AUTHOR_EMAIL: 'rollback-check@example.invalid',
      GIT_COMMITTER_NAME: 'Rollback check',
      GIT_COMMITTER_EMAIL: 'rollback-check@example.invalid',
    },
  }).trim();
// Конфигурация — та же, что в rollback-scenario.ts (фикстура не экспортирует её).
const config = configSchema.parse({
  version: 1,
  name: 'Rollback check',
  repository: product,
  workspaceRoot: workspace,
  storage: topology,
  mode: 'demo',
  concurrency: 1,
  roles: { qa: { runtime: 'demo' } },
  reviewer: { runtime: 'demo' },
  gates: [
    {
      id: 'test',
      kind: 'test',
      command: ['node', 'verify.mjs'],
      report: { type: 'junit', path: '.reports/junit.xml' },
    },
  ],
});
const database = join(workspace, '.devcontour-local', 'state.sqlite');
const store = new Store(
  database,
  config.storage === 'component' ? repositories(config) : undefined,
);
const h = new DevContour(store, config);

const title = 'Task ' + letter;
const team = h.store.read().team;
const target = h.store.read().tasks.find((t) => t.title === title);
if (team && target.assignee !== team.member) h.assign(target.id, team.member);
h.pause(false);
assert.equal(h.leader(owner), true, 'роль controller не получена');
const run = h.claim(owner);
assert.ok(run, 'задача не выдана');
assert.equal(h.store.read().tasks.find((t) => t.id === run.taskId).title, title);
mkdirSync(join(product, 'tasks'), { recursive: true });
writeFileSync(join(product, 'tasks', `${letter}-${run.id}.txt`), `${title} ${run.id}\n`);
git(product, 'add', 'tasks');
git(product, 'commit', '-qm', `Task ${title}, attempt ${run.id}`);
const sha = git(product, 'rev-parse', 'HEAD');
h.phase(run.id, run.token, 'integrating', { candidateSha: sha, integrationSha: sha });
const findingId = createHash('sha256').update('rollback-finding').digest('hex');
for (const phase of ['candidate', 'integration']) {
  const base = { phase, sha, command: ['fixture'], exitCode: 0, log: 'fixture', digest: DIGEST };
  h.evidence(run.id, run.token, {
    ...base,
    kind: 'test',
    gate: 'test',
    passed: true,
    summary: 'ok',
  });
  // Раунд ревью протокола alpha.6: поля, которых строгие схемы прежних версий не знают.
  h.evidence(run.id, run.token, {
    ...base,
    kind: 'review',
    gate: 'independent-review',
    passed: true,
    summary: 'Rollback fixture: review round with alpha.6 protocol fields',
    findings: [{ severity: 'note', message: 'fixture note', id: findingId, status: 'closed' }],
    reviewRound: {
      version: 1,
      scope: 'a'.repeat(64),
      round: 1,
      call: 1,
      calls: 2,
      protocol: 'valid',
      expected: [],
      transitions: [{ id: findingId, from: 'open', to: 'closed', basis: 'fixed' }],
    },
  });
}
h.finish(run.id, run.token, sha);
// «Падение»: роль controller не снимается.
const s = store.read();
store.close();
const databases = {};
for (const file of [database, join(product, '.devcontour-local', 'state.sqlite')].filter(
  existsSync,
)) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const hash = createHash('sha256');
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all())
      hash.update(name + JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()));
    databases[file.slice(dir.length + 1)] = hash.digest('hex');
  } finally {
    db.close();
  }
}
const reviewRounds = s.runs
  .filter((r) => r.id === run.id)
  .flatMap((r) => r.evidence ?? [])
  .filter((e) => e.reviewRound).length;
console.log(
  JSON.stringify(
    {
      step,
      topology,
      devcontourVersion,
      harnessVersion,
      accepted: { run: run.id, sha },
      leader: s.leader,
      reviewRounds,
      tasks: Object.fromEntries(
        s.tasks.map((t) => [t.title, { status: t.status, resultSha: t.resultSha }]),
      ),
      databases,
    },
    null,
    2,
  ),
);
