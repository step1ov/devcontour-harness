#!/usr/bin/env node
/**
 * S03 — один владелец worktree и параллельные среды. Две попытки (s03-a,
 * s03-b) одного графа исполняются harness одновременно (concurrency 2) в своих
 * worktree; lifecycle — compose-bridge (Docker project, порт, том на попытку и
 * фазу). Gate db-isolation пишет значение в свою базу и через барьер сверяет,
 * что во второй базе его нет. Сценарий держит контрольный контейнер с меткой
 * fixture и проверяет после teardown попытки A: ресурсов A нет, база B цела,
 * контрольный контейнер работает. В конце сценарий удаляет контрольный
 * контейнер по своей метке владельца.
 *
 *   node scripts/acceptance/starter-s03.mjs --evidence <dir> --logs <dir> [--work <dir>] [--source <url|path>]
 * Код выхода: 0 PASS, 1 FAIL, 3 BLOCKED (нет Docker).
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  approve,
  git,
  implement,
  prepareStarterFixture,
  starterGraph,
  starterPolicy,
} from './starter-fixture.mjs';
import {
  docker,
  dockerInventory,
  finish,
  foreign,
  foreignPreserved,
  harness,
  harnessSpawn,
  readTrace,
  recorder,
  requireDocker,
  traceShims,
  waitFor,
  walk,
} from './starter-lib.mjs';

const { values } = parseArgs({
  options: {
    work: { type: 'string' },
    source: { type: 'string' },
    evidence: { type: 'string' },
    logs: { type: 'string' },
  },
});
// Канонический путь: Git сообщает worktree через realpath (/private/var… на macOS).
const W = (() => {
  const dir = resolve(values.work ?? mkdtempSync(join(tmpdir(), 'starter-s03-')));
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
})();
const rec = recorder(
  join(resolve(values.evidence ?? join(W, 'evidence')), 'S03'),
  join(resolve(values.logs ?? join(W, 'logs')), 'S03'),
);
const token = randomBytes(4).toString('hex');
const CONTROL_LABEL = `devcontour.fixture.owner=s03-${token}`;
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Receipt bridge фазы попытки по имени проекта: state/artifacts/<run>/<phase>/environment/bridge. */
function bridgeReceipts(state) {
  return walk(join(state, 'artifacts'))
    .filter((f) => f.endsWith('/bridge/receipt.json'))
    .map((f) => ({ file: f, receipt: json(f) }));
}
const owned = (project) => ({
  containers: docker(['ps', '-a', '-q', '--filter', `label=devcontour.harness.project=${project}`])
    .split('\n')
    .filter(Boolean),
  volumes: docker(['volume', 'ls', '-q', '--filter', `label=devcontour.harness.project=${project}`])
    .split('\n')
    .filter(Boolean),
  networks: docker([
    'network',
    'ls',
    '-q',
    '--filter',
    `label=devcontour.harness.project=${project}`,
  ])
    .split('\n')
    .filter(Boolean),
});
const empty = (o) => !o.containers.length && !o.volumes.length && !o.networks.length;
const psql = (container, sql) =>
  docker(['exec', container, 'psql', '-U', 'harness', '-d', 'acceptance', '-tAc', sql])
    .split('\n')
    .filter(Boolean);

let child;
const runIds = new Set();
async function main() {
  rec.json('docker.json', requireDocker());
  const before = dockerInventory();
  const fixture = prepareStarterFixture({
    workDir: W,
    installPnpm: false,
    ...(values.source ? { source: values.source } : {}),
    log: rec.log,
  });
  rec.json('fixture.json', fixture.manifest);
  const trace = join(W, 'trace.tsv');
  const shims = traceShims(join(W, 'shims'), trace, ['git', 'pnpm', 'harness']);
  const registry = join(homedir(), 'worktrees', '.state');
  const registryBefore = existsSync(registry) ? walk(registry).sort() : null;

  // Контрольный ресурс fixture: не принадлежит ни одной попытке.
  const control = docker([
    'run',
    '-d',
    '--pull',
    'never',
    '--label',
    CONTROL_LABEL,
    '--label',
    'devcontour.fixture.scenario=S03',
    '--name',
    `s03-control-${token}`,
    'busybox:1.36',
    'sleep',
    '3600',
  ]);
  rec.json('control.json', { id: control, label: CONTROL_LABEL });

  const dir = join(W, 'run');
  const barrier = join(dir, 'barrier');
  mkdirSync(barrier, { recursive: true });
  const scenario = join(dir, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      writer: implement({ 's03/marker.txt': 'S03 parallel environments\n' }),
      reviewer: approve(),
    }),
  );
  const policy = starterPolicy(fixture, {
    template: 'policy.lifecycle.json',
    scenario,
    edit: (p) => {
      const repo = p.repositories[0];
      repo.environment.values.S03_BARRIER = barrier;
      // S03 не проверяет секреты (это S06): пароль базы — обычное значение политики.
      repo.environment.values.HX_DB_PASSWORD = 'harness-s03';
      repo.environment.secrets = {};
      p.concurrency = 2;
    },
  });
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy, null, 2));
  rec.json('policy.json', policy);
  const order = (id) => ({
    ...starterGraph().orders[0],
    id,
    source: { connector: 'files', ref: id, revision: '1' },
    title: `S03 parallel environment ${id}`,
    goal: 'Add s03/marker.txt; the db-isolation gate proves this attempt has its own database.',
    acceptance: ['db-isolation passes in an environment owned by this attempt'],
    writeScope: ['s03'],
    gates: ['db-isolation'],
    context: [],
  });
  writeFileSync(
    join(dir, 'graph.json'),
    JSON.stringify(
      starterGraph({
        edit: (g) => {
          g.id = 'turbo-starter-s03';
          g.orders = [order('s03-a'), order('s03-b')];
        },
      }),
      null,
      2,
    ),
  );
  const state = join(dir, 'state');
  const env = { PATH: [shims, process.env.PATH].join(':') };
  const target = policy.repositories[0].targetRef;
  git(fixture.repo, ['update-ref', target, fixture.baselineSha]);

  child = harnessSpawn(
    rec,
    'run',
    [
      'run',
      '--graph',
      'graph.json',
      '--policy',
      'policy.json',
      '--state',
      state,
      '--author',
      'external',
    ],
    { cwd: dir, env },
  );
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));

  // Обе попытки в своих средах: снимок worktree и ресурсов при живых обеих.
  const a = await waitFor(
    's03-a в среде',
    () => existsSync(join(barrier, 's03-a.json')) && json(join(barrier, 's03-a.json')),
    600000,
  );
  const b = await waitFor(
    's03-b в среде',
    () => existsSync(join(barrier, 's03-b.json')) && json(join(barrier, 's03-b.json')),
    600000,
  );
  runIds.add(a.run);
  runIds.add(b.run);
  const worktreesDuring = git(fixture.repo, ['worktree', 'list', '--porcelain']);
  rec.text('worktree-list-during.txt', worktreesDuring);
  const trees = worktreesDuring
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9));
  rec.check(
    'S03: git worktree — основной checkout и только деревья harness',
    trees[0] === fixture.repo &&
      trees.slice(1).every((t) => t.startsWith(join(state, 'worktrees') + '/')) &&
      trees.length >= 3,
    trees,
  );
  rec.json('environments.json', { a, b });
  rec.check(
    'S03: разные Docker project, порты, тома',
    a.project !== b.project &&
      a.port !== b.port &&
      a.volumes.every((v) => !b.volumes.includes(v)) &&
      a.volumes.length > 0,
    { a, b },
  );
  const labels = (container) =>
    JSON.parse(docker(['inspect', '--format', '{{json .Config.Labels}}', container]));
  const la = labels(a.container);
  const lb = labels(b.container);
  rec.json('owner-labels.json', { a: la, b: lb });
  rec.check(
    'S03: метки владельца у ресурсов попыток',
    la['devcontour.harness.run'] === a.run &&
      lb['devcontour.harness.run'] === b.run &&
      la['devcontour.harness.project'] === a.project,
    { la, lb },
  );
  const readA = await waitFor(
    'read-back A',
    () =>
      existsSync(join(barrier, 's03-a.readback.json')) &&
      json(join(barrier, 's03-a.readback.json')),
    300000,
  );
  const readB = await waitFor(
    'read-back B',
    () =>
      existsSync(join(barrier, 's03-b.readback.json')) &&
      json(join(barrier, 's03-b.readback.json')),
    300000,
  );
  rec.json('readback-before-teardown.json', { a: readA, b: readB });
  rec.check(
    'S03: данные A не видны в базе B и наоборот',
    readA.own.length === 1 &&
      readA.own[0] === a.value &&
      !readA.other.includes(a.value) &&
      readB.own[0] === b.value &&
      !readB.other.includes(b.value),
    { readA, readB },
  );

  // Teardown A (кандидат) завершается, пока B держит свою среду.
  await waitFor(
    'teardown кандидата A',
    () =>
      empty(owned(a.project)) &&
      bridgeReceipts(state).some(
        (r) => r.receipt.project === a.project && r.receipt.status === 'cleaned',
      ),
    600000,
    500,
  );
  const bState = docker(['inspect', '--format', '{{.State.Status}}', b.container]);
  const controlState = docker(['inspect', '--format', '{{.State.Status}}', control]);
  const bRows = psql(b.container, 'SELECT v FROM marks ORDER BY v');
  const aReceipt = bridgeReceipts(state).find((r) => r.receipt.project === a.project);
  rec.copy(aReceipt.file, 'receipt-a-candidate.json');
  const checked = {
    ok:
      bState === 'running' &&
      controlState === 'running' &&
      bRows.length === 1 &&
      bRows[0] === b.value,
    aResources: owned(a.project),
    bState,
    controlState,
    bRows,
  };
  rec.json('after-a-teardown.json', checked);
  writeFileSync(join(barrier, 'a-teardown.checked.json'), JSON.stringify(checked));
  rec.check(
    'S03: после teardown A — B и контрольный ресурс работают, база B цела',
    checked.ok,
    checked,
  );

  const exit = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('run не завершился за 20 мин')), 1200000),
    ),
  ]);
  rec.json('run-exit.json', exit);
  rec.check('S03: run завершился успешно', exit.code === 0, exit);
  const status = harness(rec, 'status', ['status', '--state', state], { cwd: dir, env });
  const works = status.json?.data?.works ?? [];
  rec.json('status.json', works);
  rec.check(
    'S03: обе попытки приняты',
    works.length === 2 && works.every((w) => w.status === 'done'),
    works,
  );
  rec.copy(join(barrier, 's03-b.after-a-teardown.json'), 'readback-b-after-a-teardown.json');
  const receipts = bridgeReceipts(state).map((r) => ({
    file: r.file.slice(state.length + 1),
    project: r.receipt.project,
    owner: r.receipt.owner,
    ports: r.receipt.ports,
    labels: r.receipt.labels,
    status: r.receipt.status,
    cleanup: r.receipt.cleanup,
  }));
  rec.json('environment-receipts.json', receipts);
  rec.check(
    'S03: четыре среды (2 попытки × candidate/integration), все очищены',
    receipts.length === 4 && receipts.every((r) => r.status === 'cleaned'),
    receipts,
  );
  rec.check(
    'S03: порты всех сред различны',
    new Set(receipts.map((r) => r.ports.POSTGRES_PORT)).size === 4,
    receipts.map((r) => r.ports),
  );
  const worktreesAfter = git(fixture.repo, ['worktree', 'list', '--porcelain']);
  rec.text('worktree-list-after.txt', worktreesAfter);
  rec.check(
    'S03: после прогона остался только основной checkout',
    worktreesAfter.split('\n').filter((l) => l.startsWith('worktree ')).length === 1,
    worktreesAfter,
  );
  const commands = readTrace(trace);
  rec.json('trace-summary.json', {
    git: commands.filter((c) => c.tool === 'git').length,
    pnpm: commands.filter((c) => c.tool === 'pnpm'),
    harness: commands.filter((c) => c.tool === 'harness'),
    worktreeAdds: commands.filter(
      (c) => c.tool === 'git' && c.argv[0] === 'worktree' && c.argv[1] === 'add',
    ),
  });
  rec.check(
    'S03: нет starter worktree:create и вложенного harness',
    !commands.some((c) => c.tool === 'pnpm' && c.argv.some((x) => x.startsWith('worktree:'))) &&
      !commands.some((c) => c.tool === 'harness') &&
      commands
        .filter((c) => c.tool === 'git' && c.argv[0] === 'worktree' && c.argv[1] === 'add')
        .every((c) => c.argv.some((x) => x.startsWith(join(state, 'worktrees') + '/'))),
    'trace',
  );
  const registryAfter = existsSync(registry) ? walk(registry).sort() : null;
  rec.check(
    'S03: реестр starter ~/worktrees/.state не тронут',
    JSON.stringify(registryAfter) === JSON.stringify(registryBefore),
    { registryBefore, registryAfter },
  );

  // Контрольный ресурс удаляет сам тест по своей метке.
  const mine = docker(['ps', '-aq', '--filter', `label=${CONTROL_LABEL}`])
    .split('\n')
    .filter(Boolean);
  if (mine.length) docker(['rm', '-f', ...mine]);
  const after = dockerInventory();
  rec.json('docker-foreign.json', { before: foreign(before), after: foreign(after) });
  const preserved = foreignPreserved(foreign(before), foreign(after));
  rec.json('docker-foreign-preserved.json', preserved);
  rec.check('S03: чужие ресурсы сохранены, Docker context не изменён', preserved.ok, preserved);
}

let error;
try {
  await main();
} catch (e) {
  error = e;
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  // Уборка теста: свой контрольный контейнер и — при отказе — ресурсы своих попыток.
  try {
    const leftovers = docker(['ps', '-aq', '--filter', `label=${CONTROL_LABEL}`])
      .split('\n')
      .filter(Boolean);
    if (leftovers.length) docker(['rm', '-f', ...leftovers]);
    for (const run of runIds) {
      const c = docker(['ps', '-aq', '--filter', `label=devcontour.harness.run=${run}`])
        .split('\n')
        .filter(Boolean);
      if (c.length) docker(['rm', '-f', '-v', ...c]);
      const v = docker(['volume', 'ls', '-q', '--filter', `label=devcontour.harness.run=${run}`])
        .split('\n')
        .filter(Boolean);
      if (v.length) docker(['volume', 'rm', '-f', ...v]);
      const n = docker(['network', 'ls', '-q', '--filter', `label=devcontour.harness.run=${run}`])
        .split('\n')
        .filter(Boolean);
      if (n.length) docker(['network', 'rm', ...n]);
    }
  } catch (cleanup) {
    rec.log('cleanup теста не завершена: ' + cleanup.message);
    error ??= cleanup;
  }
}
finish(rec, 'S03', error, { work: W });
