/**
 * UU01–UU09: части `harness update` без сети — semver и peer-диапазоны,
 * «что нового» из заметок, чтение tarball, форматы пакета, копия состояния
 * с контрольной суммой и её возврат, защита удаления, задание расписания.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compareVersions, satisfies } from '../src/update/semver.ts';
import { plainPoints, whatsNewOf } from '../src/update/notes.ts';
import { readTarball } from '../src/update/tarball.ts';
import { RUNNING_FORMATS, cachedUpdates, loadUpdatesConfig } from '../src/update/check.ts';
import { formatChanges } from '../src/update/install.ts';
import {
  copyState,
  removeInside,
  restoreState,
  stateFingerprint,
  verifyCopy,
} from '../src/update/state-copy.ts';
import { launchdPlist, linuxInstructions, scheduleArgs } from '../src/update/schedule.ts';
import { updatesConfigSchema } from '../src/contracts/index.ts';

const tmp = (p = 'harness-uu-') => mkdtempSync(join(tmpdir(), p));

test('UU01: compareVersions и satisfies — prerelease по правилу npm', () => {
  assert.ok(compareVersions('0.1.0-alpha.10', '0.1.0-alpha.9') > 0);
  assert.ok(compareVersions('0.1.0', '0.1.0-alpha.60') > 0);
  assert.ok(compareVersions('0.2.0-alpha.1', '0.1.0') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  const peer = '>=0.1.0-alpha.55 <0.2.0';
  assert.ok(satisfies('0.1.0-alpha.60', peer));
  assert.ok(!satisfies('0.1.0-alpha.54', peer));
  assert.ok(!satisfies('0.2.0-alpha.1', peer), 'prerelease другой тройки');
  assert.ok(satisfies('0.1.5', peer));
  assert.ok(satisfies('0.1.0-alpha.61', '^0.1.0-alpha.60'));
  assert.ok(!satisfies('0.2.0', '^0.1.0-alpha.60'));
  assert.ok(satisfies('0.1.0-alpha.61', '0.1.0-alpha.61'));
  assert.ok(satisfies('0.1.0-alpha.61', '<0.1.0-alpha.1 || >=0.1.0-alpha.60'));
  assert.ok(!satisfies('0.1.0-alpha.61', 'latest'), 'нераспознанный диапазон — не удовлетворён');
  assert.ok(!satisfies('not-a-version', '*'));
});

test('UU02: plainPoints — «Коротко», затем ### раздела «Изменения», затем ##, затем абзац', () => {
  assert.deepEqual(
    plainPoints(
      '# x\n\n## Коротко\n\n- Первое `код`\n- **Второе**\n\n## Изменения\n\n### Не это\n',
    ),
    ['Первое код', 'Второе'],
  );
  assert.deepEqual(
    plainPoints('# x\n\nПро форматы.\n\n## Изменения\n\n### A [ссылка](u)\n\nтекст\n\n### B\n'),
    ['A ссылка', 'B'],
  );
  assert.deepEqual(plainPoints('# x\n\n## Обзор: кто дальше\n\n## Совместимость\n'), [
    'Обзор: кто дальше',
  ]);
  assert.deepEqual(plainPoints('# x\n\nТолько абзац\nв две строки.\n'), [
    'Только абзац в две строки.',
  ]);
  const files = new Map([
    ['package/docs/release-notes/0.1.0-alpha.59.md', '## Изменения\n### старое\n'],
    ['package/docs/release-notes/0.1.0-alpha.60.md', '## Изменения\n### шестьдесят\n'],
    ['package/docs/release-notes/0.1.0-alpha.61.md', '## Изменения\n### шестьдесят один\n'],
    ['package/docs/release-notes/0.1.0-alpha.62.md', '## Изменения\n### будущее\n'],
  ]);
  assert.deepEqual(whatsNewOf(files, 'harness', '0.1.0-alpha.59', '0.1.0-alpha.61'), [
    'harness 0.1.0-alpha.61: шестьдесят один',
    'harness 0.1.0-alpha.60: шестьдесят',
  ]);
});

test('UU03: readTarball — пути ustar с prefix, только обычные файлы до предела', () => {
  const dir = tmp();
  const long = 'package/' + 'd'.repeat(90) + '/' + 'e'.repeat(60) + '.md';
  mkdirSync(join(dir, long, '..'), { recursive: true });
  writeFileSync(join(dir, long), 'длинный путь');
  writeFileSync(join(dir, 'package', 'package.json'), '{"name":"x"}');
  writeFileSync(join(dir, 'package', 'big.md'), 'x'.repeat(5000));
  execFileSync('tar', ['-czf', join(dir, 'p.tgz'), '-C', dir, 'package']);
  const files = readTarball(
    readFileSync(join(dir, 'p.tgz')),
    (p) => p.endsWith('.md') || p.endsWith('.json'),
    4096,
  );
  assert.equal(files.get('package/package.json'), '{"name":"x"}');
  assert.equal(files.get(long), 'длинный путь');
  assert.equal(files.has('package/big.md'), false, 'больше предела — не читается');
});

test('UU04: форматы package.json совпадают с константами сборки; смены форматов именуются', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    devcontourHarness: { formats: unknown };
  };
  assert.deepEqual(pkg.devcontourHarness.formats, RUNNING_FORMATS);
  assert.deepEqual(formatChanges(RUNNING_FORMATS, RUNNING_FORMATS), []);
  assert.deepEqual(formatChanges(RUNNING_FORMATS, { ...RUNNING_FORMATS, policy: 2, view: 2 }), [
    'policyVersion: 1 → 2',
    'viewVersion: 1 → 2',
  ]);
  assert.deepEqual(formatChanges(RUNNING_FORMATS, undefined), ['unknown']);
});

test('UU05: настройка — умолчания notify/alpha/same-formats; registry только http(s); чужие поля — отказ', () => {
  assert.deepEqual(updatesConfigSchema.parse({}), {
    mode: 'notify',
    channel: 'alpha',
    autoScope: 'same-formats',
  });
  assert.equal(updatesConfigSchema.safeParse({ registry: 'file:///etc' }).success, false);
  assert.equal(updatesConfigSchema.safeParse({ registry: 'https://r.example/' }).success, true);
  assert.equal(updatesConfigSchema.safeParse({ mode: 'auto', extra: 1 }).success, false);
  assert.equal(updatesConfigSchema.safeParse({ channel: 'Alpha Beta' }).success, false);
  const dir = tmp();
  assert.equal(loadUpdatesConfig(dir).exists, false);
  writeFileSync(join(dir, 'updates.json'), '{"mode":');
  assert.throws(() => loadUpdatesConfig(dir), /невалидный JSON/);
});

function stateDir() {
  const dir = join(tmp(), 'state');
  mkdirSync(join(dir, 'reviews'), { recursive: true });
  mkdirSync(join(dir, 'worktrees', 'w1'), { recursive: true });
  writeFileSync(join(dir, 'worktrees', 'w1', 'big.bin'), 'checkout');
  mkdirSync(join(dir, 'gates-at', 'g1'), { recursive: true });
  writeFileSync(join(dir, 'gates-at', 'g1', '.git'), 'gitdir: x');
  writeFileSync(join(dir, 'binding.json'), '{"policy":{}}');
  writeFileSync(join(dir, 'reviews', 'r1.json'), '{"round":1}');
  symlinkSync('reviews/r1.json', join(dir, 'link.json'));
  const db = new DatabaseSync(join(dir, 'state.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
    CREATE TABLE local (namespace TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(namespace, owner, key));
    INSERT INTO meta VALUES('stateVersion','1');
    INSERT INTO state VALUES(1,'{"v":1}');
    INSERT INTO events(data) VALUES('{"e":1}');`);
  return { dir, db };
}

test('UU06: копия состояния — снимок базы при открытом WAL, суммы, без рабочих деревьев; порча копии обнаруживается', () => {
  const { dir, db } = stateDir();
  try {
    const copy = copyState(dir, join(tmp(), 'copy'));
    const entries = verifyCopy(copy.path, copy.digest);
    assert.deepEqual(entries.map((e) => [e.path, e.kind]).sort(), [
      ['binding.json', 'file'],
      ['link.json', 'symlink'],
      ['reviews/r1.json', 'file'],
      ['state.sqlite', 'sqlite'],
    ]);
    const copied = new DatabaseSync(join(copy.path, 'files', 'state.sqlite'), { readOnly: true });
    assert.deepEqual(
      copied
        .prepare('SELECT data FROM state')
        .all()
        .map((r) => ({ ...r })),
      [{ data: '{"v":1}' }],
    );
    copied.close();
    assert.throws(() => copyState(dir, copy.path), /уже существует/);
    writeFileSync(join(copy.path, 'files', 'reviews', 'r1.json'), '{"round":2}');
    assert.throws(
      () => verifyCopy(copy.path, copy.digest),
      /r1\.json не совпал с контрольной суммой/,
    );
    assert.throws(() => verifyCopy(copy.path, 'f'.repeat(64)), /digest списка не совпал/);
  } finally {
    db.close();
  }
});

test('UU07: отпечаток меняется с данными, не с арендами; возврат копии переносит живые файлы, не удаляя их', () => {
  const { dir, db } = stateDir();
  const copy = copyState(dir, join(tmp(), 'copy'));
  const before = stateFingerprint(dir);
  db.exec(
    "CREATE TABLE leases (kind TEXT, id TEXT, until INTEGER); INSERT INTO leases VALUES('c','1',5)",
  );
  assert.equal(stateFingerprint(dir), before, 'аренды не данные');
  db.exec('UPDATE state SET data=\'{"v":2}\'');
  assert.notEqual(stateFingerprint(dir), before);
  db.close();
  const aside = join(tmp(), 'aside');
  restoreState(dir, copy.path, aside, copy.digest);
  const restored = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true });
  assert.deepEqual(
    restored
      .prepare('SELECT data FROM state')
      .all()
      .map((r) => ({ ...r })),
    [{ data: '{"v":1}' }],
  );
  restored.close();
  const moved = new DatabaseSync(join(aside, 'state.sqlite'), { readOnly: true });
  assert.deepEqual(
    moved
      .prepare('SELECT data FROM state')
      .all()
      .map((r) => ({ ...r })),
    [{ data: '{"v":2}' }],
  );
  moved.close();
  assert.equal(
    readFileSync(join(dir, 'worktrees', 'w1', 'big.bin'), 'utf8'),
    'checkout',
    'рабочие деревья на месте',
  );
  assert.ok(existsSync(join(dir, 'gates-at', 'g1', '.git')));
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('-wal') || n.endsWith('-shm')).length, 0);
});

test('UU08: removeInside удаляет только внутри каталога обновлений', () => {
  const root = tmp();
  mkdirSync(join(root, 'copies', 'a'), { recursive: true });
  removeInside(root, join(root, 'copies', 'a'));
  assert.equal(existsSync(join(root, 'copies', 'a')), false);
  assert.throws(() => removeInside(root, root), /вне каталога обновлений/);
  assert.throws(() => removeInside(root, join(root, '..')), /вне каталога обновлений/);
  assert.throws(
    () => removeInside(join(root, 'copies'), join(root, 'copies-x')),
    /вне каталога обновлений/,
  );
});

test('UU09: расписание — plist с экранированием и PATH; текст systemd/cron для Linux', () => {
  const args = scheduleArgs('/p/node_modules/devcontour-harness/lib/cli.js', '/s & <state>', '/p');
  assert.deepEqual(args.slice(1), [
    '/p/node_modules/devcontour-harness/lib/cli.js',
    'update',
    '--apply',
    '--scheduled',
    '--state',
    '/s & <state>',
    '--prefix',
    '/p',
  ]);
  const plist = launchdPlist('dev.x', args, '/log', '/usr/bin');
  assert.match(plist, /<string>\/s &amp; &lt;state&gt;<\/string>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>9<\/integer>/);
  const text = linuxInstructions(args);
  assert.match(text, /OnCalendar=\*-\*-\* 09:30/);
  assert.match(text, /ExecStart=.* '\/s & <state>'/);
  assert.match(text, /^cron: 30 9 \* \* \* /m);
});

test('UU10: cachedUpdates — нет проверки: подсказка (кроме off); проверка старее установленной версии — «обновлений нет»', () => {
  const state = join(tmp(), 'state');
  const cfg = updatesConfigSchema.parse({});
  assert.equal(cachedUpdates(state, cfg)?.state, 'not-checked');
  assert.equal(cachedUpdates(state, { ...cfg, mode: 'off' }), undefined);
  mkdirSync(state + '-updates', { recursive: true });
  writeFileSync(
    state + '-updates/last-check.json',
    JSON.stringify({
      checkedAt: '2026-11-20T10:00:00.000Z',
      state: 'available',
      mode: 'notify',
      channel: 'alpha',
      current: { harness: '0.1.0-alpha.59' },
      available: { harness: '0.1.0-alpha.60' },
      line: 'Доступна harness 0.1.0-alpha.60',
    }),
  );
  assert.equal(cachedUpdates(state, cfg, '0.1.0-alpha.59')?.state, 'available');
  assert.equal(cachedUpdates(state, cfg, '0.1.0-alpha.60')?.state, 'up-to-date');
});

test('UU11: новый ключ форматов будущей версии называется сменой, а не «неизвестно»', async () => {
  const { formatsFrom } = await import('../src/update/install.ts');
  const next = formatsFrom({ ...RUNNING_FORMATS, relay: 1 });
  assert.ok(next);
  assert.deepEqual(formatChanges(RUNNING_FORMATS, next), ['relay: нет → 1']);
  assert.equal(formatsFrom({ ...RUNNING_FORMATS, state: 'x' }), undefined);
});

test('UU12: пауза обновления — штатная остановка run её не подменяет, человек снимает; роль controller обновления держит run', async () => {
  const { Engine } = await import('../src/engine/engine.ts');
  const { standaloneHost } = await import('../src/engine/standalone.ts');
  const { SqliteExecutionStore } = await import('../src/storage/sqlite.ts');
  const { executionPolicySchema } = await import('../src/contracts/index.ts');
  const { example } = await import('./fixtures.ts');
  const policy = executionPolicySchema.parse(example('policy'));
  const store = new SqliteExecutionStore(join(tmp(), 'state.sqlite'), 'test');
  try {
    const engine = new Engine({ host: standaloneHost(store, policy), policy });
    engine.resume();
    assert.equal(engine.operationPause('harness-update'), true);
    assert.equal(engine.pause('shutdown').changed, false);
    assert.equal(
      engine.read((v) => v.control().pauseOperation),
      'harness-update',
    );
    assert.equal(engine.holdController('harness-update:1'), true);
    assert.equal(engine.lead('run-1'), false, 'run не становится controller');
    assert.equal(engine.holdController('harness-update:2'), false);
    assert.equal(
      engine.holdController('harness-update:2', () => true),
      true,
      'роль умершего обновления переходит',
    );
    assert.equal(engine.resume().changed, true, 'человек снимает паузу прерванного обновления');
    // Пауза операции применения политики по-прежнему только своя.
    engine.operationPause('reconfigure-x');
    assert.throws(() => engine.resume(), /операция применения политики/);
  } finally {
    store.close();
  }
});

test('UU13: отпечаток не меняется от продления роли controller обновления, меняется от события', async () => {
  const { Engine } = await import('../src/engine/engine.ts');
  const { standaloneHost } = await import('../src/engine/standalone.ts');
  const { SqliteExecutionStore } = await import('../src/storage/sqlite.ts');
  const { executionPolicySchema } = await import('../src/contracts/index.ts');
  const { example } = await import('./fixtures.ts');
  const policy = executionPolicySchema.parse(example('policy'));
  const dir = join(tmp(), 'state');
  mkdirSync(dir);
  const store = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  try {
    const engine = new Engine({ host: standaloneHost(store, policy), policy });
    engine.resume();
    engine.operationPause('harness-update');
    assert.equal(engine.holdController('harness-update:1'), true);
    const before = stateFingerprint(dir);
    for (let i = 0; i < 3; i++) assert.equal(engine.holdController('harness-update:1'), true);
    assert.equal(stateFingerprint(dir), before, 'продление аренды — не данные');
    engine.pause('operator');
    assert.notEqual(stateFingerprint(dir), before, 'пауза человека — данные');
  } finally {
    store.close();
  }
});

test('UU14: идёт обновление — регистрация графа, согласование и совместная проверка отказывают CONTROLLER_BUSY; после — идут', async () => {
  const { HarnessError } = await import('../src/contracts/index.ts');
  const { engineOf, graphOf, policyOf, ready } = await import('./engine-fixture.ts');
  const policy = policyOf((p: { workspaceGates?: unknown[] }) => {
    p.workspaceGates = [
      {
        id: 'combo',
        kind: 'test',
        repositoryId: 'app',
        command: ['node', 'combo.js'],
        report: { type: 'junit', path: 'reports/combo.xml' },
      },
    ];
  });
  const { engine } = engineOf(policy);
  ready(engine, graphOf({ a: [] }));
  engine.host.store.transact('task.done', (tx) => {
    tx.putWork({ ...tx.work('a')!, status: 'done', resultSha: 'a'.repeat(40) });
  });
  const busy = (e: unknown) =>
    e instanceof HarnessError &&
    e.code === 'CONTROLLER_BUSY' &&
    /обновление harness/.test(e.message);
  engine.release('c1'); // ready() взял роль controller для c1
  assert.equal(engine.holdController('harness-update:1'), true);
  assert.throws(() => engine.jointStart({ workIds: ['a'] }), busy);
  assert.throws(
    () => engine.register(graphOf({ b: [] }), { trusted: () => false, reachable: () => true }),
    busy,
  );
  assert.throws(() => engine.approve('g', 'agent'), busy);
  engine.release('harness-update:1');
  // Пауза прерванного обновления держит те же операции, пока её не снимут.
  engine.resume();
  engine.operationPause('harness-update');
  assert.throws(() => engine.jointStart({ workIds: ['a'] }), busy);
  engine.operationResume('harness-update');
  const v = engine.jointStart({ workIds: ['a'] });
  assert.ok(v.id);
});

test('UU15: замок — снятие умершего не уводит замок, только что взятый другим; общий каталог установки держит второй update', async () => {
  const { acquireLockAt, acquirePrefixLock } = await import('../src/update/apply.ts');
  const dir = tmp();
  // Умерший держатель (несуществующий pid) — замок снимается и берётся.
  writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: 999999, at: 'old' }));
  const a = acquireLockAt(dir, 'lock', 'занято');
  assert.equal(a.recovered, true);
  assert.throws(() => acquireLockAt(dir, 'lock', 'занято'), /занято \(процесс \d+\)/);
  a.release();
  assert.equal(existsSync(join(dir, 'lock')), false);
  // Нечитаемый молодой замок — занят.
  writeFileSync(join(dir, 'lock'), '');
  assert.throws(() => acquireLockAt(dir, 'lock', 'занято'), /занято/);
  const prefix = tmp();
  mkdirSync(join(prefix, 'node_modules'));
  const first = acquirePrefixLock(prefix);
  assert.throws(() => acquirePrefixLock(prefix), /другой harness update/);
  first.release();
  acquirePrefixLock(prefix).release();
});

/** pid процесса, который уже завершился. */
const deadPid = () => {
  const r = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal(r.status, 0);
  return r.pid;
};

test('UU16: пауза обновления, убитого во время --wait — run, регистрация и совместная проверка её не ждут; незавершённый возврат или живой замок — ждут', async () => {
  const { HarnessError } = await import('../src/contracts/index.ts');
  const { Engine } = await import('../src/engine/engine.ts');
  const { standaloneHost } = await import('../src/engine/standalone.ts');
  const { SqliteExecutionStore } = await import('../src/storage/sqlite.ts');
  const { deadUpdateLock, updateInProgress } = await import('../src/update/busy.ts');
  const { processStartedAt } = await import('../src/environment/live-calls.ts');
  const { graphOf, policyOf, ready } = await import('./engine-fixture.ts');
  const policy = policyOf((p: { workspaceGates?: unknown[] }) => {
    p.workspaceGates = [
      {
        id: 'combo',
        kind: 'test',
        repositoryId: 'app',
        command: ['node', 'combo.js'],
        report: { type: 'junit', path: 'reports/combo.xml' },
      },
    ];
  });
  const dir = join(tmp(), 'state');
  mkdirSync(dir);
  const updates = dir + '-updates';
  mkdirSync(updates);
  const lock = (body: object) => writeFileSync(join(updates, 'lock'), JSON.stringify(body));
  const store = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  try {
    // Чтение каталога обновлений — то же, что передаёт `Harness`.
    const engine = new Engine({
      host: standaloneHost(store, policy),
      policy,
      updateBusy: () => updateInProgress(dir),
      updaterGone: () => deadUpdateLock(dir),
    });
    ready(engine, graphOf({ a: [] }));
    store.transact('task.done', (tx) => {
      tx.putWork({ ...tx.work('a')!, status: 'done', resultSha: 'a'.repeat(40) });
    });
    engine.release('c1');
    const busy = (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'CONTROLLER_BUSY' &&
      /обновление harness/.test(e.message);
    const register = (id: string) =>
      engine.register(graphOf({ [id]: [] }, '1', 'g-' + id), {
        trusted: () => false,
        reachable: () => true,
      });
    const stale = () => engine.read((v) => engine.staleUpdatePause(v));
    const me = { pid: process.pid, startedAt: processStartedAt(process.pid) };
    assert.ok(me.startedAt !== undefined);
    // Обновление идёт: живой замок и пауза — держат.
    lock({ ...me, at: 'x' });
    assert.equal(engine.operationPause('harness-update'), true);
    assert.throws(() => register('b'), busy);
    assert.equal(stale(), undefined);
    assert.equal(engine.clearStaleUpdatePause(), false);
    // Обновление убито во время --wait: замок называет умерший процесс, возврата нет.
    const dead = deadPid();
    lock({ pid: dead, startedAt: 1, at: 'x' });
    assert.deepEqual(stale(), { pid: dead });
    register('c');
    assert.ok(engine.jointStart({ workIds: ['a'] }).id);
    // pid достался другому процессу (момент старта другой) — тоже умер.
    lock({ pid: process.pid, startedAt: me.startedAt - 5000, at: 'x' });
    assert.deepEqual(stale(), { pid: process.pid });
    // Незавершённый возврат держит, даже если процесса нет.
    lock({ pid: dead, startedAt: 1, at: 'x' });
    writeFileSync(join(updates, 'in-progress.json'), JSON.stringify({ id: 'x' }));
    assert.equal(stale(), undefined);
    assert.throws(() => register('d'), busy);
    assert.equal(engine.clearStaleUpdatePause(), false);
    rmSync(join(updates, 'in-progress.json'));
    // Замка нет вовсе (снят руками, пауза прежней версии) — пауза держит.
    rmSync(join(updates, 'lock'));
    assert.equal(stale(), undefined);
    assert.throws(() => register('e'), busy);
    // run снимает устаревшую паузу; в состоянии новых полей нет.
    lock({ pid: dead, startedAt: 1, at: 'x' });
    const before = engine.read((v) => Object.keys(v.control()).sort());
    assert.equal(engine.clearStaleUpdatePause(), true);
    const control = engine.read((v) => v.control());
    assert.equal(control.paused, false);
    assert.equal(control.pauseOperation, undefined);
    assert.ok(Object.keys(control).every((k) => before.includes(k)));
    // Роль controller умершего обновления — не «идёт обновление».
    assert.equal(engine.holdController(`harness-update:${dead}`), true);
    register('f');
    // Пауза другой операции не «устаревшая пауза обновления».
    engine.operationPause('reconfigure-x');
    assert.equal(stale(), undefined);
  } finally {
    store.close();
  }
});

test('UU17: записи библиотеки во время обновления — CONTROLLER_BUSY, как у CLI; resolveInput, carryInputOf и review — до модели и до своих шагов', async () => {
  const { HarnessError } = await import('../src/contracts/index.ts');
  const { hsetup } = await import('./harness-fixture.ts');
  const { approve, implement } = await import('./runner-fixture.ts');
  const { processStartedAt } = await import('../src/environment/live-calls.ts');
  const { Harness } = await import('../src/control/harness.ts');
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const busy = (e: unknown) =>
    e instanceof HarnessError &&
    e.code === 'CONTROLLER_BUSY' &&
    /обновление harness/.test(e.message);
  const updates = ctx.state.replace(/[/\\]+$/, '') + '-updates';
  const me = { pid: process.pid, startedAt: processStartedAt(process.pid) };
  const h = ctx.open();
  try {
    await h.run({ graph: ctx.graph, author: 'claude', once: true });
    const workId = ctx.graph.orders[0]!.id;
    // Обновление идёт: замок живого процесса (этого) в <state>-updates.
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, 'lock'), JSON.stringify({ ...me, at: 'x' }));
    // Шаги после охраны не начинаются: подменённые шаги не вызываются.
    const reached: string[] = [];
    const engine = h.engine as unknown as Record<string, unknown>;
    const saved = new Map<string, unknown>();
    for (const name of ['refreshApplied', 'supersedeInput', 'carryInput', 'applyInput']) {
      saved.set(name, engine[name]);
      engine[name] = () => {
        reached.push(name);
        throw new Error('reached ' + name);
      };
    }
    const before = ctx.calls('codex', 'reviewer');
    await assert.rejects(h.resolveInput('IR-x', { author: 'claude' }), busy);
    await assert.rejects(h.carryInputOf('IR-x', { reason: 'r', author: 'claude' }), busy);
    await assert.rejects(h.review({ kind: 'plan', graph: ctx.graph, author: 'claude' }), busy);
    assert.deepEqual(reached, []);
    for (const [name, fn] of saved) engine[name] = fn;
    assert.equal(ctx.calls('codex', 'reviewer'), before, 'модель не вызывалась');
    // Записи движка: охрана — до поиска запроса или работы (иначе NOT_FOUND).
    const writes: [string, () => unknown][] = [
      ['retry', () => h.engine.retry(workId, { reason: 'r' }, 'operator')],
      ['acceptCodeFindings', () => h.engine.acceptCodeFindings(workId, ['f1'], 'r', 'lead')],
      ['cancel', () => h.engine.cancel(workId, 'r', 'operator')],
      ['refreshApplied', () => h.engine.refreshApplied('IR-x')],
      ['answerInput', () => h.engine.answerInput('IR-x', { by: 'operator' } as never, 1)],
      ['cancelInput', () => h.cancelInput('IR-x', { by: 'operator', reason: 'r' }, 1)],
      [
        'supersedeInput',
        () => h.engine.supersedeInput('IR-x', { by: 'lead', reason: 'r', successor: 's' }, 1),
      ],
      ['applyInput', () => h.engine.applyInput('IR-x', {} as never)],
      ['carryInput', () => h.engine.carryInput('IR-x', {} as never)],
      ['requestReconfigure', () => h.engine.requestReconfigure('op', 'a'.repeat(64))],
    ];
    for (const [name, write] of writes) assert.throws(write, busy, name);
    // Незавершённый возврат — тоже.
    rmSync(join(updates, 'lock'));
    writeFileSync(join(updates, 'in-progress.json'), JSON.stringify({ id: 'x' }));
    for (const [name, write] of writes) assert.throws(write, busy, name);
    // Обновления нет — отказ уже по существу (запроса нет), а не CONTROLLER_BUSY.
    rmSync(join(updates, 'in-progress.json'));
    for (const [name, write] of writes.filter(([n]) => n !== 'requestReconfigure'))
      assert.throws(
        write,
        (e: unknown) => !(e instanceof HarnessError && e.code === 'CONTROLLER_BUSY'),
        name,
      );
    // Общий каталог установки: его замок держит записи, если библиотеке его назвали.
    const prefix = mkdtempSync(join(tmpdir(), 'harness-uu-prefix-'));
    writeFileSync(join(prefix, '.harness-update.lock'), JSON.stringify({ ...me, at: 'x' }));
    const shared = Harness.open({ ...h.options, installPrefix: prefix });
    try {
      assert.throws(() => shared.engine.retry(workId, { reason: 'r' }, 'operator'), busy);
    } finally {
      shared.close();
    }
    // Пауза обновления, умершего до изменений: status объясняет, run снимает.
    h.engine.operationPause('harness-update');
    writeFileSync(join(updates, 'lock'), JSON.stringify({ pid: deadPid(), startedAt: 1 }));
    const queue = h.status(undefined, { detail: true }).detail!.queue;
    assert.equal('liftedByRun' in queue && queue.liftedByRun, true);
    assert.match(
      queue.detail ?? '',
      /^Пауза прерванного обновления: процесс harness update \d+ завершился до изменений/,
    );
    await h.run({ graph: ctx.graph, author: 'claude', once: true });
    assert.equal(
      h.engine.read((v) => v.control().paused),
      false,
    );
  } finally {
    h.close();
  }
});
