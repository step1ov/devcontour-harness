/**
 * `harness lean`: включение и выключение слоя lean в подготовленном проекте —
 * точный возврат политики и manifest, план без записи, отказ при идущем run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HarnessError,
  cliCommands,
  cliDataSchemas,
  executionDigest,
  executionPolicySchema,
  leanDataSchema,
  projectManifestSchema,
  workGraphSchema,
} from '../src/contracts/index.ts';
import { leanMismatch, switchLean, type LeanOptions } from '../src/init/lean.ts';
import { planProject, type InitOptions } from '../src/init/project.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import type { ToolProbe } from '../src/toolchains/probe.ts';
import { clone, example } from './fixtures.ts';

const fixture = fileURLToPath(new URL('./fixtures/standalone/npm-app', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const probe: ToolProbe = (argv) =>
  Promise.resolve({
    code: 0,
    stdout: argv.some((a) => /(^|\/)npm(-cli\.js)?$/.test(a)) ? '11.4.2\n' : 'v24.3.0\n',
    stderr: '',
    timedOut: false,
  });

/**
 * Подготовленный проект: копия npm-приложения в своём Git; `pnpm` — с
 * pnpm-lock.yaml вместо package-lock.json. Файлы `.harness/` — ровно те, что
 * пишет init (`lean` — `init --lean`).
 */
async function project(stack: 'npm' | 'pnpm', init: { lean?: boolean } = {}) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-leansw-')));
  const root = join(scratch, 'app');
  cpSync(fixture, root, { recursive: true });
  if (stack === 'pnpm') {
    rmSync(join(root, 'package-lock.json'));
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const env = { ...process.env, HARNESS_STATE_HOME: join(scratch, 'state-home') };
  const opts = (extra: Partial<InitOptions> = {}): InitOptions => ({
    repository: root,
    env,
    probe,
    lead: 'claude',
    ...extra,
  });
  // Toolchain pnpm в тестах не установлен: файлы init пишутся по его плану.
  const planned = await planProject(opts(init.lean ? { lean: true } : {}));
  for (const intent of planned.intents) {
    mkdirSync(join(intent.path, '..'), { recursive: true });
    writeFileSync(intent.path, intent.content);
  }
  const policyPath = join(root, '.harness/policy.json');
  const manifestPath = join(root, '.harness/project.json');
  const read = () => ({
    policy: readFileSync(policyPath, 'utf8'),
    manifest: readFileSync(manifestPath, 'utf8'),
  });
  const lean = (extra: Partial<LeanOptions> = {}) =>
    switchLean({ repository: root, env, ...extra });
  return {
    root,
    env,
    opts,
    policyPath,
    manifestPath,
    read,
    lean,
    state: planned.manifest.paths.state,
    parsed: () => executionPolicySchema.parse(JSON.parse(read().policy)),
  };
}

const LEAN_FIELDS = (p: ReturnType<typeof executionPolicySchema.parse>) => ({
  concurrency: p.concurrency,
  runTimeoutMs: p.runTimeoutMs,
  gateTimeoutFloorMs: p.gateTimeoutFloorMs,
  dependencyStore: p.repositories[0]!.dependencyStore,
});

for (const stack of ['npm', 'pnpm'] as const)
  test(`lean ${stack}: включение даёт поля init --lean, выключение возвращает файлы байт в байт`, async () => {
    const p = await project(stack);
    const original = p.read();
    const on = await p.lean();
    leanDataSchema.parse(on);
    assert.equal(on.mode, 'apply');
    assert.equal(on.enabledBefore, false);
    assert.equal(on.enabled, true);
    assert.equal(on.changed, true);
    assert.deepEqual(on.problems, []);
    assert.notEqual(on.policyDigest.before, on.policyDigest.after);
    assert.ok(on.notes.some((n) => n.includes('policyDigest меняется')));
    // Те же поля исполнения, что у политики init --lean этого стека.
    const reference = await project(stack, { lean: true });
    assert.deepEqual(LEAN_FIELDS(p.parsed()), LEAN_FIELDS(reference.parsed()));
    const policy = p.parsed();
    assert.equal(policy.concurrency, 1);
    assert.equal(policy.gateTimeoutFloorMs, 240_000);
    assert.equal(policy.runTimeoutMs, 1_800_000);
    assert.equal(policy.repositories[0]!.dependencyStore !== undefined, stack === 'pnpm');
    const fields = on.changes.filter((c) => c.file === 'policy').map((c) => c.field);
    // runTimeoutMs профиля без слоя уже 1800000 (вывод из пределов шагов): не меняется.
    assert.deepEqual(fields, [
      'concurrency',
      'gateTimeoutFloorMs',
      ...(stack === 'pnpm' ? ['repositories[0].dependencyStore'] : []),
    ]);
    // Manifest: слой, закрепление профиля со слоем и запись прежних значений.
    const manifest = projectManifestSchema.parse(JSON.parse(p.read().manifest));
    assert.deepEqual(manifest.profile.layers, ['lean']);
    assert.deepEqual(
      manifest.profile.pin,
      projectManifestSchema.parse(JSON.parse(reference.read().manifest)).profile.pin,
    );
    assert.deepEqual(
      manifest.lean?.policy.map((c) => c.field),
      ['concurrency', 'gateTimeoutFloorMs'],
    );
    assert.equal(manifest.lean?.policy[0]!.previous, undefined);
    assert.equal(manifest.lean?.dependencyStore !== undefined, stack === 'pnpm');
    // Прочие поля политики не тронуты.
    const before = JSON.parse(original.policy) as Record<string, unknown>;
    const after = JSON.parse(p.read().policy) as Record<string, unknown>;
    for (const key of Object.keys(before).filter((k) => k !== 'runTimeoutMs'))
      if (key !== 'repositories') assert.deepEqual(after[key], before[key], key);
    // init после переключения согласован с manifest: ни конфликтов, ни записи.
    const planned = await planProject(p.opts());
    assert.equal(planned.plan.conflicts + planned.workConflicts.length, 0);
    assert.equal(planned.status, 'complete');

    // Повтор — без изменений.
    const between = p.read();
    const again = await p.lean();
    assert.equal(again.changed, false);
    assert.deepEqual(again.changes, []);
    assert.deepEqual(p.read(), between);

    const off = await p.lean({ off: true });
    assert.equal(off.enabledBefore, true);
    assert.equal(off.enabled, false);
    assert.equal(off.changed, true);
    assert.deepEqual(p.read(), original);
    const offAgain = await p.lean({ off: true });
    assert.equal(offAgain.changed, false);
    assert.deepEqual(p.read(), original);
  });

test('lean: явные параллельность 3 и срок 20 мин — включение ставит слой и говорит об этом, выключение возвращает их', async () => {
  const p = await project('npm');
  const custom = JSON.parse(p.read().policy) as Record<string, unknown>;
  custom.concurrency = 3;
  custom.runTimeoutMs = 1_200_000;
  writeFileSync(p.policyPath, JSON.stringify(custom, null, 2) + '\n');
  const original = p.read();
  const on = await p.lean();
  assert.equal(p.parsed().concurrency, 1);
  assert.ok(
    on.notes.some((n) => /concurrency: в политике было явно 3; .*lean --off вернёт 3/.test(n)),
    on.notes.join('\n'),
  );
  assert.deepEqual(
    on.changes.find((c) => c.field === 'concurrency'),
    { file: 'policy', field: 'concurrency', before: 3, after: 1 },
  );
  assert.deepEqual(
    on.changes.find((c) => c.field === 'runTimeoutMs'),
    { file: 'policy', field: 'runTimeoutMs', before: 1_200_000, after: 1_800_000 },
  );
  assert.equal(p.parsed().runTimeoutMs, 1_800_000);
  await p.lean({ off: true });
  assert.deepEqual(p.read(), original);
  assert.equal(p.parsed().concurrency, 3);
  assert.equal(p.parsed().runTimeoutMs, 1_200_000);
});

test('lean --plan: изменения полей без записи; поле, изменённое после включения, — PATH_CONFLICT', async () => {
  const p = await project('pnpm');
  const original = p.read();
  const plan = await p.lean({ plan: true });
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.changed, true);
  assert.equal(plan.enabled, true);
  assert.deepEqual(p.read(), original, 'план ничего не пишет');
  assert.deepEqual(
    plan.changes.map((c) => `${c.file} ${c.field}`),
    [
      'policy concurrency',
      'policy gateTimeoutFloorMs',
      'policy repositories[0].dependencyStore',
      'manifest profile.layers',
      'manifest profile.pin',
      'manifest lean',
    ],
  );
  assert.deepEqual(plan.changes[1], {
    file: 'policy',
    field: 'gateTimeoutFloorMs',
    after: 240_000,
  });
  // План совпадает с применением.
  const applied = await p.lean();
  assert.deepEqual(applied.changes, plan.changes);

  // Ручная правка после включения: выключение её не перезаписывает.
  const edited = JSON.parse(p.read().policy) as Record<string, unknown>;
  edited.concurrency = 2;
  writeFileSync(p.policyPath, JSON.stringify(edited, null, 2) + '\n');
  const before = p.read();
  const offPlan = await p.lean({ off: true, plan: true });
  assert.deepEqual(
    offPlan.problems.map((x) => [x.code, x.field]),
    [['PATH_CONFLICT', 'concurrency']],
  );
  assert.match(offPlan.problems[0]!.message, /изменено вручную после включения/);
  await assert.rejects(
    p.lean({ off: true }),
    (e: unknown) => e instanceof HarnessError && e.code === 'PATH_CONFLICT',
  );
  assert.deepEqual(p.read(), before, 'отказ ничего не пишет');
});

test('lean --off после init --lean: значения профиля без слоя — файлы init без --lean', async () => {
  for (const stack of ['npm', 'pnpm'] as const) {
    const p = await project(stack, { lean: true });
    const plain = await project(stack);
    const leanFields = LEAN_FIELDS(p.parsed());
    const off = await p.lean({ off: true });
    assert.equal(off.changed, true, stack);
    assert.equal(p.read().policy, plain.read().policy, stack);
    const manifest = projectManifestSchema.parse(JSON.parse(p.read().manifest));
    const expected = projectManifestSchema.parse(JSON.parse(plain.read().manifest));
    assert.deepEqual(manifest.profile, expected.profile, stack);
    assert.equal(manifest.lean, undefined, stack);
    const planned = await planProject(p.opts());
    assert.equal(planned.plan.conflicts + planned.workConflicts.length, 0, stack);
    // И снова включить — с записью прежних значений.
    await p.lean();
    assert.deepEqual(LEAN_FIELDS(p.parsed()), leanFields, stack);
  }
});

test('lean без manifest: NOT_READY с объяснением, ничего не пишет', async () => {
  const p = await project('npm');
  rmSync(p.manifestPath);
  const before = readFileSync(p.policyPath, 'utf8');
  await assert.rejects(
    p.lean(),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'NOT_READY' &&
      /project\.json/.test(e.message) &&
      /harness init --repository/.test(e.message) &&
      e.issues[0]?.message === 'manifest-missing',
  );
  assert.equal(readFileSync(p.policyPath, 'utf8'), before);
});

test('lean при идущем run: живая роль controller и попытка — CONTROLLER_BUSY; согласования прежней политики названы', async () => {
  const p = await project('npm');
  const policy = p.parsed();
  const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') };
  mkdirSync(p.state, { recursive: true });
  const store = new SqliteExecutionStore(join(p.state, 'state.sqlite'), 'test');
  let n = 0;
  const engine = new Engine({
    host: standaloneHost(store, policy),
    policy,
    now: () => clock.now,
    id: () => `id-${String(++n).padStart(16, '0')}`,
  });
  try {
    const base = clone(example('graph')) as { orders: Record<string, unknown>[] };
    const graph = workGraphSchema.parse({
      ...base,
      id: 'g',
      source: { connector: 'files', ref: 'g', revision: '1' },
      orders: [
        {
          ...base.orders[0],
          id: 'a',
          source: { connector: 'files', ref: 'a', revision: '1' },
          gates: policy.repositories[0]!.gates.map((g) => g.id),
        },
      ],
    });
    const { graph: state } = engine.register(graph, {
      trusted: () => false,
      reachable: () => true,
    });
    assert.equal(state.policyDigest, executionDigest(policy));
    const binding = engine.reviewerBinding('plan', 'claude');
    engine.recordReview({
      id: 'RV-g-1',
      kind: 'plan',
      subject: state.id,
      digest: state.digest,
      round: 1,
      at: '2026-01-01T00:00:00.000Z',
      approved: true,
      summary: 'план годен',
      authorRuntime: 'claude',
      reviewerRuntime: 'codex',
      sameVendor: false,
      findings: [],
      artifact: 'reviews/1.json',
      ...(binding ? { reviewerBinding: binding } : {}),
    });
    engine.approve(state.id, 'agent');
    assert.equal(engine.lead('c1'), true);
    engine.resume();
    const attempt = engine.claim('c1');
    assert.ok(attempt, 'попытка выдана');
    const original = p.read();
    const at = (ms: number) => () => ms;

    const plan = await p.lean({ plan: true, now: at(clock.now) });
    assert.deepEqual(
      plan.problems.map((x) => x.code),
      ['CONTROLLER_BUSY', 'CONTROLLER_BUSY'],
    );
    assert.match(plan.problems[0]!.message, /controller держит c1/);
    assert.match(plan.problems[1]!.message, /Идёт попытка/);
    assert.deepEqual(plan.staleApprovals, ['g']);
    await assert.rejects(
      p.lean({ now: at(clock.now) }),
      (e: unknown) => e instanceof HarnessError && e.code === 'CONTROLLER_BUSY',
    );
    assert.deepEqual(p.read(), original);

    // Сроки истекли (процесс прерван): попытка — пояснение, переключение проходит.
    const later = clock.now + 24 * 3600_000;
    const done = await p.lean({ now: at(later) });
    assert.deepEqual(done.problems, []);
    assert.ok(
      done.notes.some((x) => /прервана/.test(x)),
      done.notes.join('\n'),
    );
    assert.deepEqual(done.staleApprovals, ['g']);
    assert.ok(done.next.some((x) => x.command === 'review-plan'));
    assert.ok(done.notes.some((x) => /графы g .*APPROVAL_STALE/.test(x)));

    // Завершённый граф (все поручения done или cancelled) не устаревает.
    engine.cancel('a');
    await p.lean({ off: true, now: at(later) });
    assert.deepEqual(p.read(), original);
    // Политика снова та, под которой согласован граф, но граф завершён.
    const finished = await p.lean({ plan: true, now: at(later) });
    assert.deepEqual(finished.problems, []);
    assert.deepEqual(finished.staleApprovals, []);
    assert.ok(!finished.notes.some((x) => /APPROVAL_STALE/.test(x)), finished.notes.join('\n'));
    assert.ok(finished.notes.some((x) => /policyDigest меняется/.test(x)));
    assert.ok(!finished.next.some((x) => x.command === 'review-plan'));
  } finally {
    store.close();
  }
});

test('CLI lean: договор, JSON-конверт, --plan --human, отказ exit 3, флаги только своей команды', async () => {
  assert.ok('lean' in cliCommands);
  assert.equal(cliCommands.lean.writes, true);
  assert.deepEqual(
    cliCommands.lean.args.map((a) => a.name),
    ['--repository', '--state', '--off', '--plan', '--human'],
  );
  assert.equal(cliDataSchemas.lean, leanDataSchema);
  const p = await project('npm');
  const harness = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      encoding: 'utf8',
      env: { ...p.env, NODE_OPTIONS: '' },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const original = p.read();
  const human = harness('lean', '--repository', p.root, '--plan', '--human');
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^lean plan: выключен → включён/);
  assert.match(human.stdout, /policy concurrency: — → 1/);
  assert.match(human.stdout, /manifest profile\.layers: — → \["lean"\]/);
  assert.deepEqual(p.read(), original);
  const applied = harness('lean', '--repository', p.root);
  assert.equal(applied.status, 0, applied.stderr);
  const envelope = JSON.parse(applied.stdout) as { ok: boolean; command: string; data: unknown };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, 'lean');
  assert.equal(leanDataSchema.parse(envelope.data).changed, true);
  const off = harness('lean', '--repository', p.root, '--off');
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(p.read(), original);
  // --off — только у lean; --lean у lean — отказ входа.
  for (const args of [
    ['init', '--repository', p.root, '--off'],
    ['lean', '--repository', p.root, '--lean'],
  ]) {
    const r = harness(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal((JSON.parse(r.stdout) as { ok: boolean }).ok, false);
  }
  // Без manifest — отказ по существу (exit 3) тем же конвертом.
  rmSync(p.manifestPath);
  const missing = harness('lean', '--repository', p.root);
  assert.equal(missing.status, 3);
  assert.equal((JSON.parse(missing.stdout) as { error: { code: string } }).error.code, 'NOT_READY');
});

const crash = (after: number) => {
  let n = 0;
  return () => {
    if (++n === after) throw new Error('crash after rename');
  };
};
const tmpLeft = (root: string) =>
  readdirSync(join(root, '.harness')).filter((f) => f.endsWith('.tmp'));

test('lean: прерывание после первого rename — повтор и обратное направление сходятся к точным байтам', async () => {
  const p = await project('pnpm');
  const original = p.read();
  await p.lean();
  const on = p.read();
  await p.lean({ off: true });
  assert.deepEqual(p.read(), original);

  // Включение: manifest записан, политика — нет.
  await assert.rejects(p.lean({ afterReplace: crash(1) }), /crash after rename/);
  assert.equal(p.read().policy, original.policy);
  assert.equal(p.read().manifest, on.manifest);
  assert.match(leanMismatch(p.policyPath).join('\n'), /LEAN_MISMATCH: .*concurrency/);
  await p.lean();
  assert.deepEqual(p.read(), on, 'повтор включения дописывает политику');
  assert.deepEqual(leanMismatch(p.policyPath), []);
  await p.lean({ off: true });
  assert.deepEqual(p.read(), original);

  await assert.rejects(p.lean({ afterReplace: crash(1) }), /crash after rename/);
  await p.lean({ off: true });
  assert.deepEqual(p.read(), original, 'выключение после прерванного включения');

  // Выключение: политика возвращена, manifest — ещё со слоем.
  await p.lean();
  await assert.rejects(p.lean({ off: true, afterReplace: crash(1) }), /crash after rename/);
  assert.equal(p.read().policy, original.policy);
  assert.equal(p.read().manifest, on.manifest);
  assert.match(leanMismatch(p.policyPath).join('\n'), /LEAN_MISMATCH/);
  await p.lean({ off: true });
  assert.deepEqual(p.read(), original, 'повтор выключения дописывает manifest');

  await p.lean();
  await assert.rejects(p.lean({ off: true, afterReplace: crash(1) }), /crash after rename/);
  await p.lean();
  assert.deepEqual(p.read(), on, 'включение после прерванного выключения');
  assert.deepEqual(tmpLeft(p.root), []);
});

test('lean: файл изменён между чтением и rename — REVISION_CONFLICT; половина переключения названа и дописывается повтором', async () => {
  const p = await project('npm');
  const original = p.read();
  // Первый файл (manifest при включении) изменён: ничего не записано.
  const touched = original.manifest.replace(/\n$/, '\n\n');
  await assert.rejects(
    p.lean({
      beforeReplace: (path) => {
        if (path === p.manifestPath) writeFileSync(path, touched);
      },
    }),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'REVISION_CONFLICT' &&
      /не записано, файлы прежние/.test(e.message),
  );
  assert.deepEqual(p.read(), { policy: original.policy, manifest: touched });
  assert.deepEqual(tmpLeft(p.root), []);
  writeFileSync(p.manifestPath, original.manifest);

  // Политика изменена во время замены manifest: manifest записан, политика — нет.
  const edited = JSON.parse(original.policy) as Record<string, unknown>;
  edited.approvalMode = 'operator';
  await assert.rejects(
    p.lean({
      beforeReplace: (path) => {
        if (path === p.manifestPath)
          writeFileSync(p.policyPath, JSON.stringify(edited, null, 2) + '\n');
      },
    }),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'REVISION_CONFLICT' &&
      e.message.includes(`${p.manifestPath} уже записан`) &&
      e.message.startsWith(p.policyPath),
  );
  assert.deepEqual(tmpLeft(p.root), []);
  const resumed = await p.lean();
  assert.deepEqual(resumed.problems, []);
  const policy = p.parsed();
  assert.equal(policy.concurrency, 1);
  assert.equal(policy.gateTimeoutFloorMs, 240_000);
  assert.equal(policy.approvalMode, 'operator', 'чужая правка сохранена');
  await p.lean({ off: true });
  assert.equal(p.read().manifest, original.manifest);
  assert.equal(p.parsed().approvalMode, 'operator');
});

test('lean --off после init --lean и поднятых пределов gates: поле, которое слой не задаёт, не конфликт; срок фазы — в notes', async () => {
  const p = await project('npm', { lean: true });
  const raised = JSON.parse(p.read().policy) as {
    repositories: { gates: { timeoutMs?: number }[] }[];
  };
  for (const gate of raised.repositories[0]!.gates) gate.timeoutMs = 1_200_000;
  writeFileSync(p.policyPath, JSON.stringify(raised, null, 2) + '\n');
  const plan = await p.lean({ off: true, plan: true });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(
    plan.changes.filter((c) => c.file === 'policy').map((c) => c.field),
    ['concurrency', 'gateTimeoutFloorMs'],
  );
  assert.ok(
    plan.notes.some((n) => /^срок фазы: /.test(n)),
    plan.notes.join('\n'),
  );
  await p.lean({ off: true });
  assert.equal(p.parsed().runTimeoutMs, 1_800_000);
});

test('lean --off: dependencyStore, настроенный вручную после включения, — PATH_CONFLICT', async () => {
  const p = await project('pnpm');
  await p.lean();
  const edited = JSON.parse(p.read().policy) as {
    repositories: { dependencyStore: { maxBytes: number } }[];
  };
  edited.repositories[0]!.dependencyStore.maxBytes = 1024 * 1024 * 1024;
  writeFileSync(p.policyPath, JSON.stringify(edited, null, 2) + '\n');
  const plan = await p.lean({ off: true, plan: true });
  assert.deepEqual(
    plan.problems.map((x) => [x.code, x.field]),
    [['PATH_CONFLICT', 'repositories[0].dependencyStore']],
  );
});

test('lean --state: проверка идущего run в названном каталоге состояния', async () => {
  const p = await project('npm');
  const other = join(p.root, '..', 'other-state');
  mkdirSync(other, { recursive: true });
  const policy = p.parsed();
  const store = new SqliteExecutionStore(join(other, 'state.sqlite'), 'test');
  const engine = new Engine({ host: standaloneHost(store, policy), policy });
  try {
    assert.equal(engine.lead('c9'), true);
    assert.deepEqual((await p.lean({ plan: true })).problems, []);
    const busy = await p.lean({ plan: true, state: other });
    assert.deepEqual(
      busy.problems.map((x) => x.code),
      ['CONTROLLER_BUSY'],
    );
  } finally {
    engine.release('c9');
    store.close();
  }
});
