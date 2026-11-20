/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call --
 * Тест читает JSON-ответы CLI и файлы как есть.
 */
/**
 * UP01–UP12: `harness update` настоящим subprocess CLI против поддельного
 * реестра npm (локальный HTTP) и настоящего npm, который ставит поддельные
 * пакеты во временный проект. Живого реестра, публикации и моделей нет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executionPolicySchema,
  operatorViewSchema,
  updateDataSchema,
} from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { example } from './fixtures.ts';
import {
  FORMATS,
  fakeHarness,
  fakeRegistry,
  fakeUi,
  npmEnv,
  type FakeRegistry,
} from './update-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface Project {
  dir: string;
  state: string;
  home: string;
  env: Record<string, string>;
  harness(...args: string[]): { status: number | null; json: any; stdout: string; stderr: string };
  harnessAsync(...args: string[]): Promise<{ status: number | null; json: any; stderr: string }>;
  installed(name: string): string | undefined;
  manifest(): any;
  engine(): { engine: Engine; close(): void };
}

function project(
  registry: FakeRegistry,
  o: { ui?: boolean; leaseMs?: number; config?: Record<string, unknown> } = {},
): Project {
  const base = mkdtempSync(join(tmpdir(), 'harness-update-'));
  const dir = join(base, 'project');
  const home = join(base, 'home');
  const state = join(base, 'state');
  mkdirSync(join(dir, '.harness'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = { ...npmEnv(registry.url, home), HOME: home };
  const deps: Record<string, string> = { 'devcontour-harness': '0.1.0-alpha.60' };
  if (o.ui !== false) deps['devcontour-harness-ui'] = '0.1.0-alpha.4';
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      { name: 'proj', version: '1.0.0', private: true, devDependencies: deps },
      null,
      2,
    ),
  );
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  assert.equal(install.status, 0, install.stderr);
  const raw = { ...example('policy'), leaseMs: o.leaseMs ?? 30000 };
  const policy = executionPolicySchema.parse(raw);
  writeFileSync(join(dir, '.harness', 'policy.json'), JSON.stringify(raw, null, 2));
  if (o.config) writeFileSync(join(dir, '.harness', 'updates.json'), JSON.stringify(o.config));
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, 'binding.json'),
    JSON.stringify({ policy, baseDir: join(dir, '.harness') }, null, 2),
  );
  const engine = () => {
    const store = new SqliteExecutionStore(join(state, 'state.sqlite'), 'test');
    return {
      engine: new Engine({ host: standaloneHost(store, policy), policy }),
      close: () => store.close(),
    };
  };
  // Новое состояние начинается с паузы выдачи: очередь идёт, как после первого run.
  const first = engine();
  first.engine.resume();
  first.close();
  const runEnv = { ...process.env, NODE_OPTIONS: '', ...env };
  const parse = (stdout: string) => {
    try {
      return JSON.parse(stdout);
    } catch {
      return undefined;
    }
  };
  return {
    dir,
    state,
    home,
    env,
    harness: (...args) => {
      const r = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), cli, ...args],
        {
          cwd: dir,
          env: runEnv,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      return { status: r.status, json: parse(r.stdout), stdout: r.stdout, stderr: r.stderr };
    },
    harnessAsync: (...args) =>
      new Promise((done) => {
        const child = spawn(
          process.execPath,
          ['--import', import.meta.resolve('tsx'), cli, ...args],
          {
            cwd: dir,
            env: runEnv,
          },
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => (out += String(d)));
        child.stderr.on('data', (d: Buffer) => (err += String(d)));
        child.on('close', (status) => done({ status, json: parse(out), stderr: err }));
      }),
    installed: (name) => {
      const file = join(dir, 'node_modules', name, 'package.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : undefined;
    },
    manifest: () => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
    engine,
  };
}

async function registryWith(...versions: ReturnType<typeof fakeHarness>[]) {
  const r = await fakeRegistry();
  for (const v of versions) r.publish(v);
  return r;
}

const base = () => [
  fakeHarness('0.1.0-alpha.60'),
  fakeUi('0.1.0-alpha.4', '>=0.1.0-alpha.55 <0.2.0'),
];

test('UP01: --check — доступная пара, что нового из заметок tarball, запросы только к реестру; офлайн — «не удалось проверить», exit 0', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    const none = p.harness('update', '--check', '--state', p.state);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.json.data.check.state, 'up-to-date', JSON.stringify(none.json.data.check));
    assert.match(
      none.json.data.line,
      /Обновлений нет: установлены harness 0\.1\.0-alpha\.60 и панель 0\.1\.0-alpha\.4/,
    );

    registry.publish(fakeHarness('0.1.0-alpha.61'));
    registry.publish(fakeUi('0.1.0-alpha.5', '>=0.1.0-alpha.60 <0.2.0'));
    registry.resetRequests();
    const r = p.harness('update', '--check', '--state', p.state);
    assert.equal(r.status, 0, r.stderr);
    updateDataSchema.parse(r.json.data);
    const c = r.json.data.check;
    assert.equal(c.state, 'available');
    assert.deepEqual(c.current, { harness: '0.1.0-alpha.60', ui: '0.1.0-alpha.4' });
    assert.deepEqual(c.available, { harness: '0.1.0-alpha.61', ui: '0.1.0-alpha.5' });
    assert.deepEqual(c.whatsNew, [
      'harness 0.1.0-alpha.61: Новое в 0.1.0-alpha.61',
      'harness 0.1.0-alpha.61: Второе в 0.1.0-alpha.61',
      'панель 0.1.0-alpha.5: Панель 0.1.0-alpha.5 показывает обновления',
    ]);
    assert.equal(c.formatChanges, undefined);
    assert.match(c.command, /^harness update --apply --state /);
    assert.ok(registry.requests.length > 0);
    assert.ok(
      registry.requests.every((q) => q.startsWith('GET ')),
      registry.requests.join('\n'),
    );
    // Ничего не поставлено.
    assert.equal(p.installed('devcontour-harness'), '0.1.0-alpha.60');
    // Сохранённая проверка — в <state>-updates.
    assert.equal(
      JSON.parse(readFileSync(p.state + '-updates/last-check.json', 'utf8')).state,
      'available',
    );

    const human = p.harness('update', '--check', '--state', p.state, '--human');
    assert.match(human.stdout, /Что нового:\n {2}• harness 0\.1\.0-alpha\.61: Новое/);

    await registry.close();
    const offline = p.harness('update', '--check', '--state', p.state);
    assert.equal(offline.status, 0, offline.stderr);
    assert.equal(offline.json.data.check.state, 'unavailable');
    assert.match(offline.json.data.line, /^Не удалось проверить обновления: /);
    // Найденная раньше пара остаётся видна.
    assert.deepEqual(offline.json.data.check.available, {
      harness: '0.1.0-alpha.61',
      ui: '0.1.0-alpha.5',
    });
  } finally {
    await registry.close().catch(() => {});
  }
});

test('UP02: пара по peer-диапазону — новейшая панель не подходит к новейшему harness, берётся совместимая', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness('0.1.0-alpha.61'));
    registry.publish(fakeUi('0.1.0-alpha.5', '>=0.1.0-alpha.60 <0.2.0'), '');
    registry.publish(fakeUi('0.1.0-alpha.6', '>=0.1.0-alpha.62 <0.2.0'));
    const r = p.harness('update', '--check', '--state', p.state);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.data.check.available, {
      harness: '0.1.0-alpha.61',
      ui: '0.1.0-alpha.5',
    });
    assert.match(
      r.json.data.check.note,
      /Панель 0\.1\.0-alpha\.6 не подходит к harness 0\.1\.0-alpha\.61/,
    );
  } finally {
    await registry.close();
  }
});

test('UP03: --apply — точные версии обоих пакетов, копия состояния с суммой, doctor, событие, очередь не на паузе', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness('0.1.0-alpha.61'));
    registry.publish(fakeUi('0.1.0-alpha.5', '>=0.1.0-alpha.60 <0.2.0'));
    const r = p.harness('update', '--apply', '--state', p.state);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const d = updateDataSchema.parse(r.json.data);
    assert.equal(d.outcome, 'applied');
    assert.deepEqual(d.to, { harness: '0.1.0-alpha.61', ui: '0.1.0-alpha.5' });
    assert.deepEqual(
      d.steps!.map((s) => [s.step, s.ok]),
      [
        ['pause', true],
        ['idle', true],
        ['state-copy', true],
        ['install', true],
        ['installed', true],
        ['doctor', true],
        ['state-read', true],
        ['panel-check', true],
        ['event', true],
      ],
    );
    assert.equal(p.installed('devcontour-harness'), '0.1.0-alpha.61');
    assert.equal(p.installed('devcontour-harness-ui'), '0.1.0-alpha.5');
    // --save-exact в тот же раздел.
    assert.deepEqual(p.manifest().devDependencies, {
      'devcontour-harness': '0.1.0-alpha.61',
      'devcontour-harness-ui': '0.1.0-alpha.5',
    });
    // Копия состояния с контрольной суммой.
    assert.ok(d.stateCopy && existsSync(join(d.stateCopy.path, 'files', 'state.sqlite')));
    assert.equal(readFileSync(join(d.stateCopy.path, 'digest'), 'utf8').trim(), d.stateCopy.digest);
    // Событие и снятая пауза.
    const events = p.harness('events', '--state', p.state, '--limit', '1000');
    const updated = events.json.data.events.filter((e: any) => e.type === 'harness.updated');
    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0].payload, {
      action: 'applied',
      from: { harness: '0.1.0-alpha.60', ui: '0.1.0-alpha.4' },
      to: { harness: '0.1.0-alpha.61', ui: '0.1.0-alpha.5' },
      by: 'operator',
    });
    const status = p.harness('status', '--state', p.state);
    assert.equal(status.json.data.control.paused, false);
    // Повтор — up-to-date, ничего не ставится.
    const again = p.harness('update', '--apply', '--state', p.state);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.json.data.outcome, 'up-to-date');
  } finally {
    await registry.close();
  }
});

test('UP04: идёт run (живая роль controller) — отказ busy без установки; --wait ждёт окончания и ставит', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry, { leaseMs: 5000 });
    registry.publish(fakeHarness('0.1.0-alpha.61'));
    const e = p.engine();
    assert.equal(e.engine.lead('c1'), true);
    e.close();
    const before = readFileSync(join(p.dir, 'package.json'), 'utf8');
    const busy = p.harness('update', '--apply', '--state', p.state);
    assert.equal(busy.status, 3, busy.stderr);
    assert.equal(busy.json.data.outcome, 'busy');
    assert.match(busy.json.data.line, /идёт harness run \(c1\)/);
    assert.equal(p.installed('devcontour-harness'), '0.1.0-alpha.60');
    assert.equal(readFileSync(join(p.dir, 'package.json'), 'utf8'), before);
    assert.equal(existsSync(p.state + '-updates/copies'), false, 'копии нет — ничего не начато');
    // Роль controller без продления истекает через leaseMs: --wait дожидается.
    const waited = p.harness('update', '--apply', '--state', p.state, '--wait', '1');
    assert.equal(waited.status, 0, waited.stderr + waited.stdout);
    assert.equal(waited.json.data.outcome, 'applied');
    assert.equal(p.installed('devcontour-harness'), '0.1.0-alpha.61');
  } finally {
    await registry.close();
  }
});

test('UP05: сбой проверки новой версии — автоматический возврат прежних пакетов и package.json; расписание ту же пару не повторяет', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness('0.1.0-alpha.61', { fail: true }));
    registry.publish(fakeUi('0.1.0-alpha.5', '>=0.1.0-alpha.60 <0.2.0'));
    const before = readFileSync(join(p.dir, 'package.json'), 'utf8');
    const lock = readFileSync(join(p.dir, 'package-lock.json'), 'utf8');
    const r = p.harness('update', '--apply', '--state', p.state);
    assert.equal(r.status, 4, r.stderr + r.stdout);
    const d = updateDataSchema.parse(r.json.data);
    assert.equal(d.outcome, 'restored');
    assert.ok(d.steps!.some((s) => s.step === 'doctor' && !s.ok));
    assert.ok(d.steps!.some((s) => s.step === 'restore-packages' && s.ok));
    assert.equal(p.installed('devcontour-harness'), '0.1.0-alpha.60');
    assert.equal(p.installed('devcontour-harness-ui'), '0.1.0-alpha.4');
    assert.equal(readFileSync(join(p.dir, 'package.json'), 'utf8'), before);
    assert.equal(readFileSync(join(p.dir, 'package-lock.json'), 'utf8'), lock);
    const events = p.harness('events', '--state', p.state, '--limit', '1000');
    const updated = events.json.data.events.filter((e: any) => e.type === 'harness.updated');
    assert.deepEqual(
      updated.map((e: any) => e.payload.action),
      ['restored'],
    );
    assert.equal(p.harness('status', '--state', p.state).json.data.control.paused, false);
    // Копия не понадобилась (состояние не менялось) и не копится.
    assert.deepEqual(readdirSync(p.state + '-updates/copies'), []);
    writeFileSync(join(p.dir, '.harness', 'updates.json'), JSON.stringify({ mode: 'auto' }));
    const scheduled = p.harness('update', '--apply', '--scheduled', '--state', p.state);
    assert.equal(scheduled.status, 0, scheduled.stderr);
    assert.equal(scheduled.json.data.outcome, 'skipped');
    assert.match(scheduled.json.data.line, /не прошло проверку и было возвращено/);
    assert.equal(p.installed('devcontour-harness'), '0.1.0-alpha.60');
  } finally {
    await registry.close();
  }
});

test('UP06: смена форматов — решение владельца: apply и расписание не ставят, --confirm-formats ставит; откат возвращает состояние из копии', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry, { ui: false, config: { mode: 'auto' } });
    registry.publish(fakeHarness('0.1.0-alpha.61', { formats: { ...FORMATS, state: 2 } }));
    const check = p.harness('update', '--check', '--state', p.state);
    assert.equal(check.json.data.check.state, 'needs-decision');
    assert.deepEqual(check.json.data.check.formatChanges, ['stateVersion: 1 → 2']);
    assert.match(check.json.data.check.command, /--confirm-formats$/);
    for (const args of [[], ['--scheduled']]) {
      const r = p.harness('update', '--apply', '--state', p.state, ...args);
      assert.equal(r.status, 3, r.stderr);
      assert.equal(r.json.data.outcome, 'needs-decision');
      assert.match(r.json.data.line, /^Нужно ваше решение: /);
      assert.equal(p.installed('devcontour-harness'), '0.1.0-alpha.60');
    }
    const refused = p.harness(
      'update',
      '--apply',
      '--scheduled',
      '--confirm-formats',
      '--state',
      p.state,
    );
    assert.equal(refused.status, 2);

    const applied = p.harness('update', '--apply', '--confirm-formats', '--state', p.state);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    assert.equal(p.installed('devcontour-harness'), '0.1.0-alpha.61');
    // Работа после обновления (событие) — затем откат: формат различался, состояние — из копии.
    const e = p.engine();
    e.engine.pause('operator');
    e.close();
    const rb = p.harness('update', '--rollback', '--state', p.state);
    assert.equal(rb.status, 0, rb.stderr + rb.stdout);
    assert.equal(rb.json.data.outcome, 'rolled-back');
    assert.equal(p.installed('devcontour-harness'), '0.1.0-alpha.60');
    assert.match(rb.json.data.line, /состояние возвращено из копии/);
    const replaced = join(p.state + '-updates', 'replaced');
    assert.equal(readdirSync(replaced).length, 1, 'состояние новой версии перенесено, не удалено');
    // В возвращённой копии паузы оператора (поставленной после обновления) нет.
    const status = p.harness('status', '--state', p.state);
    assert.equal(status.json.data.control.paused, false);
    const nothing = p.harness('update', '--rollback', '--state', p.state);
    assert.equal(nothing.status, 3);
    assert.equal(nothing.json.data.outcome, 'nothing-to-roll-back');
  } finally {
    await registry.close();
  }
});

test('UP07: откат при тех же форматах — прежняя пара, живое состояние сохранено', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness('0.1.0-alpha.61'));
    registry.publish(fakeUi('0.1.0-alpha.5', '>=0.1.0-alpha.60 <0.2.0'));
    assert.equal(p.harness('update', '--apply', '--state', p.state).status, 0);
    const e = p.engine();
    e.engine.pause('operator');
    e.close();
    const rb = p.harness('update', '--rollback', '--state', p.state);
    assert.equal(rb.status, 0, rb.stderr + rb.stdout);
    assert.deepEqual(rb.json.data.to, { harness: '0.1.0-alpha.60', ui: '0.1.0-alpha.4' });
    assert.equal(p.installed('devcontour-harness'), '0.1.0-alpha.60');
    assert.equal(p.installed('devcontour-harness-ui'), '0.1.0-alpha.4');
    assert.match(rb.json.data.line, /состояние читается прежней версией — оставлено как есть/);
    // Пауза оператора после обновления — в живом состоянии, не потеряна.
    const status = p.harness('status', '--state', p.state);
    assert.equal(status.json.data.control.paused, true);
    assert.equal(status.json.data.control.pauseReason, 'operator');
    const events = p.harness('events', '--state', p.state, '--limit', '1000');
    assert.deepEqual(
      events.json.data.events
        .filter((x: any) => x.type === 'harness.updated')
        .map((x: any) => x.payload.action),
      ['applied', 'rolled-back'],
    );
  } finally {
    await registry.close();
  }
});

test('UP08: view и status --human показывают доступное обновление без запросов к реестру', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry, { config: { mode: 'notify' } });
    registry.publish(fakeHarness('0.1.0-alpha.61'));
    registry.publish(fakeUi('0.1.0-alpha.5', '>=0.1.0-alpha.60 <0.2.0'));
    assert.equal(p.harness('update', '--check', '--state', p.state).status, 0);
    registry.resetRequests();
    const view = p.harness('view', '--state', p.state);
    assert.equal(view.status, 0, view.stderr);
    const doc = operatorViewSchema.parse(view.json.data);
    assert.equal(doc.viewRevision, 4);
    assert.equal(doc.updates?.state, 'available');
    assert.equal(doc.updates?.mode, 'notify');
    assert.deepEqual(doc.updates?.available, { harness: '0.1.0-alpha.61', ui: '0.1.0-alpha.5' });
    assert.ok(doc.updates?.whatsNew?.length);
    const status = p.harness('status', '--state', p.state, '--human');
    assert.equal(status.status, 0, status.stderr);
    assert.match(
      status.stdout,
      /Обновления: Доступна harness 0\.1\.0-alpha\.61 и панель 0\.1\.0-alpha\.5/,
    );
    assert.deepEqual(registry.requests, [], 'view и status в сеть не ходят');
  } finally {
    await registry.close();
  }
});

test('UP09: --schedule daily — задание launchd пользователя с командой update; off — убрано', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    const log = join(p.home, 'launchctl.log');
    const fake = join(p.home, 'launchctl');
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
    const env = { HARNESS_LAUNCHCTL_BIN: fake };
    const run = (...args: string[]) => {
      const r = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), cli, ...args],
        {
          cwd: p.dir,
          env: { ...process.env, NODE_OPTIONS: '', ...p.env, ...env },
          encoding: 'utf8',
        },
      );
      return { status: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
    };
    const on = run('update', '--schedule', 'daily', '--state', p.state);
    assert.equal(on.status, 0, on.stderr);
    if (process.platform !== 'darwin') {
      assert.match(on.json.data.schedule.instructions, /systemd/);
      return;
    }
    const file = on.json.data.schedule.file as string;
    assert.ok(file.startsWith(join(p.home, 'Library', 'LaunchAgents')));
    const plist = readFileSync(file, 'utf8');
    assert.match(
      plist,
      /<string>update<\/string>\s*<string>--apply<\/string>\s*<string>--scheduled<\/string>/,
    );
    assert.ok(
      plist.includes(
        `<string>${join(p.dir, 'node_modules', 'devcontour-harness', 'cli.js')}</string>`,
      ),
    );
    assert.match(readFileSync(log, 'utf8'), /^bootstrap gui\/\d+ /m);
    const off = run('update', '--schedule', 'off', '--state', p.state);
    assert.equal(off.status, 0, off.stderr);
    assert.equal(existsSync(file), false);
    assert.match(readFileSync(log, 'utf8'), /^bootout gui\/\d+ /m);
  } finally {
    await registry.close();
  }
});

test('UP10: запущенная панель этого каталога состояния перезапускается новой версией', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeUi('0.1.0-alpha.5', '>=0.1.0-alpha.60 <0.2.0'));
    const panel = spawn(
      process.execPath,
      [join(p.dir, 'node_modules', '.bin', 'devcontour-harness-ui'), '--state', p.state],
      { detached: true, stdio: 'ignore' },
    );
    panel.unref();
    await new Promise((r) => setTimeout(r, 500));
    let started: number | undefined;
    try {
      const r = await p.harnessAsync('update', '--apply', '--state', p.state);
      assert.equal(r.status, 0, r.stderr);
      assert.match(
        r.json.data.panel,
        /Панель перезапущена версией 0\.1\.0-alpha\.5 \(pid (\d+), http:\/\/127\.0\.0\.1:4790\/\)/,
      );
      started = Number(/pid (\d+)/.exec(r.json.data.panel)![1]);
      assert.throws(() => process.kill(panel.pid!, 0), 'прежняя панель остановлена');
      process.kill(started, 0);
      assert.match(
        readFileSync(p.state + '-updates/panel.log', 'utf8'),
        /"version":"0\.1\.0-alpha\.5"/,
      );
    } finally {
      for (const pid of [panel.pid, started])
        try {
          if (pid) process.kill(pid, 'SIGTERM');
        } catch {
          // уже остановлен
        }
    }
  } finally {
    await registry.close();
  }
});

test('UP11: --mode пишет .harness/updates.json; настройка не по схеме — INVALID_INPUT; флаги только у своих действий', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    const r = p.harness('update', '--mode', 'auto', '--state', p.state);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(p.dir, '.harness', 'updates.json'), 'utf8')), {
      mode: 'auto',
      channel: 'alpha',
      autoScope: 'same-formats',
    });
    assert.equal(p.harness('update', '--mode', 'sometimes', '--state', p.state).status, 2);
    writeFileSync(join(p.dir, '.harness', 'updates.json'), JSON.stringify({ mode: 'always' }));
    const bad = p.harness('update', '--check', '--state', p.state);
    assert.equal(bad.status, 2);
    assert.equal(bad.json.error.code, 'INVALID_INPUT');
    // status не ломается из-за настройки обновлений.
    assert.equal(p.harness('status', '--state', p.state).status, 0);
    assert.equal(p.harness('update', '--state', p.state).status, 2);
    assert.equal(p.harness('update', '--check', '--apply', '--state', p.state).status, 2);
    assert.equal(p.harness('update', '--check', '--wait', '5', '--state', p.state).status, 2);
    assert.equal(p.harness('status', '--check', '--state', p.state).status, 2);
  } finally {
    await registry.close();
  }
});

test('UP12: прерванное обновление (замок умершего процесса и пауза операции) снимается следующей командой update', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    const e = p.engine();
    assert.equal(e.engine.operationPause('harness-update'), true);
    e.close();
    mkdirSync(p.state + '-updates', { recursive: true });
    writeFileSync(
      p.state + '-updates/lock',
      JSON.stringify({ pid: 999999, at: new Date().toISOString() }),
    );
    assert.equal(p.harness('status', '--state', p.state).json.data.control.paused, true);
    const r = p.harness('update', '--check', '--state', p.state);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(p.harness('status', '--state', p.state).json.data.control.paused, false);
    assert.equal(existsSync(p.state + '-updates/lock'), false);
  } finally {
    await registry.close();
  }
});
