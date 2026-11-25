/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call --
 * Тест читает JSON-ответы CLI и файлы как есть.
 */
/**
 * UP01–UP12: `harness update` настоящим subprocess CLI против поддельного
 * реестра npm (локальный HTTP) и настоящего npm, который ставит поддельные
 * пакеты во временный проект. Живого реестра, публикации и моделей нет.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
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
import { HARNESS_VERSION } from '../src/package.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { processStartedAt } from '../src/environment/live-calls.ts';
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

/**
 * Версии поддельных пакетов выводятся из версии этого репозитория и далеко
 * впереди неё: выпуск harness не делает «новую» пару текущей и не ломает набор.
 */
const fakeVersion = (offset: number) =>
  HARNESS_VERSION.replace(/\d+$/, (n) => String(Number(n) + offset));
const LOW = fakeVersion(95);
const CUR = fakeVersion(100);
const NEW = fakeVersion(101);
const NEW2 = fakeVersion(102);
/** Регулярное выражение из текста с версиями (точки — буквально). */
const rx = (text: string, end = '', start = '') =>
  new RegExp(start + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + end);

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
  o: { ui?: boolean; leaseMs?: number; config?: Record<string, unknown>; harness?: string } = {},
): Project {
  const base = mkdtempSync(join(tmpdir(), 'harness-update-'));
  const dir = join(base, 'project');
  const home = join(base, 'home');
  const state = join(base, 'state');
  mkdirSync(join(dir, '.harness'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = { ...npmEnv(registry.url, home), HOME: home };
  const deps: Record<string, string> = { 'devcontour-harness': o.harness ?? CUR };
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

const base = () => [fakeHarness(CUR), fakeUi('0.1.0-alpha.4', `>=${LOW} <0.2.0`)];

test('UP01: --check — доступная пара, что нового из заметок tarball, запросы только к реестру; офлайн — «не удалось проверить», exit 0', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    const none = p.harness('update', '--check', '--state', p.state);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.json.data.check.state, 'up-to-date', JSON.stringify(none.json.data.check));
    assert.match(
      none.json.data.line,
      rx(`Обновлений нет: установлены harness ${CUR} и панель 0.1.0-alpha.4`),
    );

    registry.publish(fakeHarness(NEW));
    registry.publish(fakeUi('0.1.0-alpha.5', `>=${CUR} <0.2.0`));
    registry.resetRequests();
    const r = p.harness('update', '--check', '--state', p.state);
    assert.equal(r.status, 0, r.stderr);
    updateDataSchema.parse(r.json.data);
    const c = r.json.data.check;
    assert.equal(c.state, 'available');
    assert.deepEqual(c.current, { harness: CUR, ui: '0.1.0-alpha.4' });
    assert.deepEqual(c.available, { harness: NEW, ui: '0.1.0-alpha.5' });
    assert.deepEqual(c.whatsNew, [
      `harness ${NEW}: Новое в ${NEW}`,
      `harness ${NEW}: Второе в ${NEW}`,
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
    assert.equal(p.installed('devcontour-harness'), CUR);
    // Сохранённая проверка — в <state>-updates.
    assert.equal(
      JSON.parse(readFileSync(p.state + '-updates/last-check.json', 'utf8')).state,
      'available',
    );

    const human = p.harness('update', '--check', '--state', p.state, '--human');
    assert.match(human.stdout, rx(`Что нового:\n  • harness ${NEW}: Новое`));

    await registry.close();
    const offline = p.harness('update', '--check', '--state', p.state);
    assert.equal(offline.status, 0, offline.stderr);
    assert.equal(offline.json.data.check.state, 'unavailable');
    assert.match(offline.json.data.line, /^Не удалось проверить обновления: /);
    // Найденная раньше пара остаётся видна.
    assert.deepEqual(offline.json.data.check.available, {
      harness: NEW,
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
    registry.publish(fakeHarness(NEW));
    registry.publish(fakeUi('0.1.0-alpha.5', `>=${CUR} <0.2.0`), '');
    registry.publish(fakeUi('0.1.0-alpha.6', `>=${NEW2} <0.2.0`));
    const r = p.harness('update', '--check', '--state', p.state);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.data.check.available, {
      harness: NEW,
      ui: '0.1.0-alpha.5',
    });
    assert.match(r.json.data.check.note, rx(`Панель 0.1.0-alpha.6 не подходит к harness ${NEW}`));
  } finally {
    await registry.close();
  }
});

test('UP03: --apply — точные версии обоих пакетов, копия состояния с суммой, doctor, событие, очередь не на паузе', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness(NEW));
    registry.publish(fakeUi('0.1.0-alpha.5', `>=${CUR} <0.2.0`));
    const r = p.harness('update', '--apply', '--state', p.state);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const d = updateDataSchema.parse(r.json.data);
    assert.equal(d.outcome, 'applied');
    assert.deepEqual(d.to, { harness: NEW, ui: '0.1.0-alpha.5' });
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
    assert.equal(p.installed('devcontour-harness'), NEW);
    assert.equal(p.installed('devcontour-harness-ui'), '0.1.0-alpha.5');
    // --save-exact в тот же раздел.
    assert.deepEqual(p.manifest().devDependencies, {
      'devcontour-harness': NEW,
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
      from: { harness: CUR, ui: '0.1.0-alpha.4' },
      to: { harness: NEW, ui: '0.1.0-alpha.5' },
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
    registry.publish(fakeHarness(NEW));
    const e = p.engine();
    assert.equal(e.engine.lead('c1'), true);
    e.close();
    const before = readFileSync(join(p.dir, 'package.json'), 'utf8');
    const busy = p.harness('update', '--apply', '--state', p.state);
    assert.equal(busy.status, 3, busy.stderr);
    assert.equal(busy.json.data.outcome, 'busy');
    assert.match(busy.json.data.line, /идёт harness run \(c1\)/);
    assert.equal(p.installed('devcontour-harness'), CUR);
    assert.equal(readFileSync(join(p.dir, 'package.json'), 'utf8'), before);
    assert.equal(existsSync(p.state + '-updates/copies'), false, 'копии нет — ничего не начато');
    // Роль controller без продления истекает через leaseMs: --wait дожидается.
    const waited = p.harness('update', '--apply', '--state', p.state, '--wait', '1');
    assert.equal(waited.status, 0, waited.stderr + waited.stdout);
    assert.equal(waited.json.data.outcome, 'applied');
    assert.equal(p.installed('devcontour-harness'), NEW);
  } finally {
    await registry.close();
  }
});

test('UP05: сбой проверки новой версии — автоматический возврат прежних пакетов и package.json; расписание ту же пару не повторяет', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness(NEW, { fail: true }));
    registry.publish(fakeUi('0.1.0-alpha.5', `>=${CUR} <0.2.0`));
    const before = readFileSync(join(p.dir, 'package.json'), 'utf8');
    const lock = readFileSync(join(p.dir, 'package-lock.json'), 'utf8');
    const r = p.harness('update', '--apply', '--state', p.state);
    assert.equal(r.status, 4, r.stderr + r.stdout);
    const d = updateDataSchema.parse(r.json.data);
    assert.equal(d.outcome, 'restored');
    assert.ok(d.steps!.some((s) => s.step === 'doctor' && !s.ok));
    assert.ok(d.steps!.some((s) => s.step === 'restore-packages' && s.ok));
    assert.equal(p.installed('devcontour-harness'), CUR);
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
    assert.deepEqual(readdirSync(p.state + '-updates/copies'), [], JSON.stringify(d.steps));
    writeFileSync(join(p.dir, '.harness', 'updates.json'), JSON.stringify({ mode: 'auto' }));
    const scheduled = p.harness('update', '--apply', '--scheduled', '--state', p.state);
    assert.equal(scheduled.status, 0, scheduled.stderr);
    assert.equal(scheduled.json.data.outcome, 'skipped');
    assert.match(
      scheduled.json.data.line,
      /по расписанию не ставится: не прошла проверку и была возвращена/,
    );
    assert.equal(p.installed('devcontour-harness'), CUR);
  } finally {
    await registry.close();
  }
});

test('UP06: смена форматов — решение владельца: apply и расписание не ставят, --confirm-formats ставит; откат возвращает состояние из копии', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry, { ui: false, config: { mode: 'auto' } });
    registry.publish(fakeHarness(NEW, { formats: { ...FORMATS, state: 2 } }));
    const check = p.harness('update', '--check', '--state', p.state);
    assert.equal(check.json.data.check.state, 'needs-decision');
    assert.deepEqual(check.json.data.check.formatChanges, ['stateVersion: 1 → 2']);
    assert.match(check.json.data.check.command, rx(` --confirm-formats harness@${NEW}`, '$'));
    for (const args of [[], ['--scheduled']]) {
      const r = p.harness('update', '--apply', '--state', p.state, ...args);
      assert.equal(r.status, 3, r.stderr);
      assert.equal(r.json.data.outcome, 'needs-decision');
      assert.match(r.json.data.line, /^Нужно ваше решение: /);
      assert.equal(p.installed('devcontour-harness'), CUR);
    }
    const refused = p.harness(
      'update',
      '--apply',
      '--scheduled',
      '--confirm-formats',
      `harness@${NEW}`,
      '--state',
      p.state,
    );
    assert.equal(refused.status, 2);

    // Решение о другой паре (или флаг без пары, что видел владелец) — не ставит.
    const other = p.harness(
      'update',
      '--apply',
      '--confirm-formats',
      `harness@${NEW2}`,
      '--state',
      p.state,
    );
    assert.equal(other.status, 3, other.stderr);
    assert.match(
      other.json.data.line,
      rx(`Решение было о harness@${NEW2}, а реестр сейчас предлагает harness@${NEW}`, '', '^'),
    );
    assert.equal(p.installed('devcontour-harness'), CUR);
    const applied = p.harness(
      'update',
      '--apply',
      '--confirm-formats',
      `harness@${NEW}`,
      '--state',
      p.state,
    );
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    assert.equal(p.installed('devcontour-harness'), NEW);
    // Работа после обновления (событие) — затем откат: формат различался, состояние — из копии.
    const e = p.engine();
    e.engine.pause('operator');
    e.close();
    const rb = p.harness('update', '--rollback', '--state', p.state);
    assert.equal(rb.status, 0, rb.stderr + rb.stdout);
    assert.equal(rb.json.data.outcome, 'rolled-back');
    assert.equal(p.installed('devcontour-harness'), CUR);
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
    registry.publish(fakeHarness(NEW));
    registry.publish(fakeUi('0.1.0-alpha.5', `>=${CUR} <0.2.0`));
    assert.equal(p.harness('update', '--apply', '--state', p.state).status, 0);
    const e = p.engine();
    e.engine.pause('operator');
    e.close();
    const rb = p.harness('update', '--rollback', '--state', p.state);
    assert.equal(rb.status, 0, rb.stderr + rb.stdout);
    assert.deepEqual(rb.json.data.to, { harness: CUR, ui: '0.1.0-alpha.4' });
    assert.equal(p.installed('devcontour-harness'), CUR);
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
    registry.publish(fakeHarness(NEW));
    registry.publish(fakeUi('0.1.0-alpha.5', `>=${CUR} <0.2.0`));
    assert.equal(p.harness('update', '--check', '--state', p.state).status, 0);
    registry.resetRequests();
    const view = p.harness('view', '--state', p.state);
    assert.equal(view.status, 0, view.stderr);
    const doc = operatorViewSchema.parse(view.json.data);
    assert.equal(doc.viewRevision, 10);
    assert.equal(doc.updates?.state, 'available');
    assert.equal(doc.updates?.mode, 'notify');
    assert.deepEqual(doc.updates?.available, { harness: NEW, ui: '0.1.0-alpha.5' });
    assert.ok(doc.updates?.whatsNew?.length);
    const status = p.harness('status', '--state', p.state, '--human');
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, rx(`Обновления: Доступна harness ${NEW} и панель 0.1.0-alpha.5`));
    assert.deepEqual(registry.requests, [], 'view и status в сеть не ходят');
  } finally {
    await registry.close();
  }
});

test('UP08b: view и status сравнивают проверку с установленной в проекте версией, а не с запущенным harness', async () => {
  // Запущенный harness (исходники репозитория) новее установленного в проекте и
  // равен найденной паре: проверка всё равно «доступна», как у update --check.
  const old = fakeVersion(-1);
  const registry = await registryWith(fakeHarness(old));
  try {
    const p = project(registry, { ui: false, harness: old, config: { mode: 'notify' } });
    registry.publish(fakeHarness(HARNESS_VERSION));
    const check = p.harness('update', '--check', '--state', p.state);
    assert.equal(check.status, 0, check.stderr);
    assert.deepEqual(check.json.data.check.available, { harness: HARNESS_VERSION });
    const view = p.harness('view', '--state', p.state);
    assert.equal(view.status, 0, view.stderr);
    const doc = operatorViewSchema.parse(view.json.data);
    assert.equal(doc.updates?.state, 'available');
    assert.deepEqual(doc.updates?.current, { harness: old });
    const status = p.harness('status', '--state', p.state, '--human');
    assert.match(status.stdout, rx(`Обновления: Доступна harness ${HARNESS_VERSION}`));
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
    registry.publish(fakeUi('0.1.0-alpha.5', `>=${CUR} <0.2.0`));
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

test('UP13: новая версия успела изменить состояние и не прошла проверку — состояние возвращено из копии, изменённое — в replaced', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness(NEW, { fail: true, touch: true }));
    registry.publish(fakeUi('0.1.0-alpha.5', `>=${CUR} <0.2.0`));
    const r = p.harness('update', '--apply', '--state', p.state);
    assert.equal(r.status, 4, r.stderr + r.stdout);
    const d = updateDataSchema.parse(r.json.data);
    assert.equal(d.outcome, 'restored');
    assert.match(d.line, /состояние возвращено из копии/);
    assert.equal(
      existsSync(join(p.state, 'touched-by-new')),
      false,
      'изменение новой версии убрано',
    );
    const replaced = join(p.state + '-updates', 'replaced');
    const [dir] = readdirSync(replaced);
    assert.ok(
      existsSync(join(replaced, dir!, 'touched-by-new')),
      'изменённое перенесено, не удалено',
    );
    assert.ok(d.stateCopy && existsSync(d.stateCopy.path), 'копия, которой вернули, сохранена');
    assert.equal(p.installed('devcontour-harness'), CUR);
    // Возвращённое состояние читается и очередь идёт.
    const status = p.harness('status', '--state', p.state);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.json.data.control.paused, false);
    assert.equal(existsSync(p.state + '-updates/in-progress.json'), false);
  } finally {
    await registry.close();
  }
});

test('UP14: очередь на паузе человека до обновления — пауза остаётся; роль controller обновления отпущена', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness(NEW));
    const e = p.engine();
    e.engine.pause('operator');
    e.close();
    const r = p.harness('update', '--apply', '--state', p.state);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.json.data.steps[0].detail, /очередь уже была на паузе/);
    const status = p.harness('status', '--state', p.state);
    assert.equal(status.json.data.control.paused, true);
    assert.equal(status.json.data.control.pauseReason, 'operator');
    assert.equal(status.json.data.controller, undefined, 'роль controller отпущена');
  } finally {
    await registry.close();
  }
});

test('UP15: замок живого процесса — CONTROLLER_BUSY, ничего не ставится; pid после перезагрузки (другой момент старта) — замок снят', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness(NEW));
    mkdirSync(p.state + '-updates', { recursive: true });
    const lock = p.state + '-updates/lock';
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, startedAt: processStartedAt(process.pid), at: 'x' }),
    );
    const busy = p.harness('update', '--apply', '--state', p.state);
    assert.equal(busy.status, 3, busy.stderr);
    assert.equal(busy.json.error.code, 'CONTROLLER_BUSY');
    assert.equal(p.installed('devcontour-harness'), CUR);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: 1, at: 'x' }));
    const r = p.harness('update', '--apply', '--state', p.state);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(p.installed('devcontour-harness'), NEW);
    assert.equal(existsSync(lock), false);
  } finally {
    await registry.close();
  }
});

test('UP16: после ручного отката расписание в режиме auto ту же пару не ставит', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry, { config: { mode: 'auto' } });
    registry.publish(fakeHarness(NEW));
    registry.publish(fakeUi('0.1.0-alpha.5', `>=${CUR} <0.2.0`));
    assert.equal(
      p.harness('update', '--apply', '--scheduled', '--state', p.state).json.data.outcome,
      'applied',
    );
    assert.equal(
      p.harness('update', '--rollback', '--state', p.state).json.data.outcome,
      'rolled-back',
    );
    // status после отката называет установленную версию, а не прежнюю проверку.
    assert.match(
      p.harness('status', '--state', p.state, '--human').stdout,
      rx(`Возвращены harness ${CUR}`),
    );
    const s = p.harness('update', '--apply', '--scheduled', '--state', p.state);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.json.data.outcome, 'skipped');
    assert.match(s.json.data.line, /откачена вручную/);
    assert.equal(p.installed('devcontour-harness'), CUR);
    assert.match(
      p.harness('status', '--state', p.state, '--human').stdout,
      /по расписанию не ставится: откачена вручную/,
    );
    // Вручную — ставится.
    assert.equal(p.harness('update', '--apply', '--state', p.state).json.data.outcome, 'applied');
  } finally {
    await registry.close();
  }
});

test('UP17: процесс убит после установки, до проверки — следующий update --check возвращает прежнюю пару и снимает паузу', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness(NEW));
    registry.publish(fakeUi('0.1.0-alpha.5', `>=${CUR} <0.2.0`));
    // npm, который после установки убивает вызвавший его harness (SIGKILL: finally не идёт).
    const wrapper = join(p.home, 'npm-killer');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nnpm "$@"; code=$?\ncase " $* " in *" --save-exact "*) kill -9 $PPID;; esac\nexit $code\n`,
      { mode: 0o755 },
    );
    const killed = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), cli, 'update', '--apply', '--state', p.state],
      {
        cwd: p.dir,
        env: { ...process.env, NODE_OPTIONS: '', ...p.env, HARNESS_NPM_BIN: wrapper },
        encoding: 'utf8',
      },
    );
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.equal(p.installed('devcontour-harness'), NEW, 'пакеты остались новыми');
    assert.ok(existsSync(p.state + '-updates/in-progress.json'));
    assert.equal(p.harness('status', '--state', p.state).json.data.control.paused, true);
    const r = p.harness('update', '--check', '--state', p.state);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(
      r.json.data.line,
      rx(`Прерванное обновление завершено возвратом: harness ${CUR}`, '', '^'),
    );
    assert.equal(p.installed('devcontour-harness'), CUR);
    assert.equal(p.installed('devcontour-harness-ui'), '0.1.0-alpha.4');
    assert.equal(p.manifest().devDependencies['devcontour-harness'], CUR);
    assert.equal(existsSync(p.state + '-updates/in-progress.json'), false);
    const status = p.harness('status', '--state', p.state);
    assert.equal(status.json.data.control.paused, false);
    const events = p.harness('events', '--state', p.state, '--limit', '1000');
    assert.deepEqual(
      events.json.data.events
        .filter((x: any) => x.type === 'harness.updated')
        .map((x: any) => x.payload.action),
      ['restored'],
    );
  } finally {
    await registry.close();
  }
});

test('UP18: откат в проекте меняет только записи двух пакетов — зависимость, добавленная после обновления, остаётся', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness(NEW));
    registry.publish(fakeUi('0.1.0-alpha.5', `>=${CUR} <0.2.0`));
    assert.equal(p.harness('update', '--apply', '--state', p.state).json.data.outcome, 'applied');
    mkdirSync(join(p.dir, 'local-dep'));
    writeFileSync(
      join(p.dir, 'local-dep', 'package.json'),
      JSON.stringify({ name: 'local-dep', version: '1.0.0' }),
    );
    const add = spawnSync(
      'npm',
      ['install', '--save-dev', '--no-audit', '--no-fund', './local-dep'],
      {
        cwd: p.dir,
        env: { ...process.env, ...p.env },
        encoding: 'utf8',
      },
    );
    assert.equal(add.status, 0, add.stderr);
    const rb = p.harness('update', '--rollback', '--state', p.state);
    assert.equal(rb.status, 0, rb.stderr + rb.stdout);
    assert.equal(p.installed('devcontour-harness'), CUR);
    assert.equal(p.installed('devcontour-harness-ui'), '0.1.0-alpha.4');
    const deps = p.manifest().devDependencies;
    assert.equal(deps['devcontour-harness'], CUR);
    assert.equal(deps['local-dep'], 'file:local-dep');
    assert.ok(existsSync(join(p.dir, 'node_modules', 'local-dep', 'package.json')));
  } finally {
    await registry.close();
  }
});

test('UP19: во время обновления (или до возврата прерванного) gates, smoke, review-code и согласование отказывают CONTROLLER_BUSY', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    mkdirSync(p.state + '-updates', { recursive: true });
    writeFileSync(
      p.state + '-updates/lock',
      JSON.stringify({ pid: process.pid, startedAt: processStartedAt(process.pid), at: 'x' }),
    );
    for (const args of [
      ['gates', '--state', p.state, '--sha', 'HEAD'],
      ['smoke', '--state', p.state, '--sha', 'HEAD'],
      ['review-code', '--state', p.state, '--base', 'HEAD', '--head', 'HEAD'],
      ['approve', '--state', p.state, '--subject', 'g', '--digest', 'sha256:' + '0'.repeat(64)],
      // Команды записи alpha.60 (ответы, находки ревью, сброс, связка с источником).
      ['input-resolve', '--state', p.state, '--request', 'IR-x'],
      ['input-carry', '--state', p.state, '--request', 'IR-x', '--reason', 'r'],
      [
        'review-accept',
        '--state',
        p.state,
        '--work',
        'w',
        '--accept-limitation',
        'f',
        '--reason',
        'r',
      ],
      ['retry', '--state', p.state, '--work', 'w', '--reset', '--reason', 'r'],
      ['source-snapshot', '--state', p.state, '--source', 'connector.json'],
      ['source-deliver', '--state', p.state, '--source', 'connector.json'],
      ['run', '--state', p.state, '--source', 'connector.json', '--policy', 'policy.json'],
    ]) {
      const r = p.harness(...args);
      assert.equal(r.status, 3, args[0] + ' ' + r.stderr);
      assert.equal(r.json.error.code, 'CONTROLLER_BUSY', args[0]);
      assert.match(r.json.error.message, /идёт harness update/, args[0]);
    }
    // Команды чтения идут.
    for (const args of [
      ['status', '--state', p.state],
      ['view', '--state', p.state],
      ['events', '--state', p.state],
      ['doctor', '--state', p.state],
    ]) {
      const r = p.harness(...args);
      assert.equal(r.status, 0, args[0] + ' ' + r.stderr);
    }
    const plan = p.harness(
      'review-plan',
      '--state',
      p.state,
      '--graph',
      'g.json',
      '--author',
      'claude',
    );
    assert.equal(plan.json.error.code, 'CONTROLLER_BUSY');
    rmSync(p.state + '-updates/lock');
    writeFileSync(p.state + '-updates/in-progress.json', JSON.stringify({ id: 'x' }));
    const r = p.harness('gates', '--state', p.state, '--sha', 'HEAD');
    assert.equal(r.json.error.code, 'CONTROLLER_BUSY');
    assert.match(r.json.error.message, /прерванное обновление ждёт возврата/);
  } finally {
    await registry.close();
  }
});

test('UP20: база состояния без binding.json — apply и rollback требуют --policy; с --policy — охраняется как обычно', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness(NEW));
    rmSync(join(p.state, 'binding.json'));
    const e = p.engine();
    assert.equal(e.engine.lead('c1'), true);
    e.close();
    const args = ['update', '--apply', '--state', p.state, '--prefix', p.dir];
    const refused = p.harness(...args);
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal(refused.json.error.code, 'POLICY_REQUIRED');
    const busy = p.harness(...args, '--policy', join(p.dir, '.harness', 'policy.json'));
    assert.equal(busy.status, 3, busy.stderr);
    assert.equal(busy.json.data.outcome, 'busy');
    assert.match(busy.json.data.line, /идёт harness run \(c1\)/);
    assert.equal(p.installed('devcontour-harness'), CUR);
  } finally {
    await registry.close();
  }
});

test('UP21: общий каталог установки — замок у каталога установки держит update второго каталога состояния и его gates', async () => {
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    registry.publish(fakeHarness(NEW));
    writeFileSync(
      join(p.dir, '.harness-update.lock'),
      JSON.stringify({
        pid: process.pid,
        startedAt: processStartedAt(process.pid),
        at: 'other-state',
      }),
    );
    const r = p.harness('update', '--apply', '--state', p.state);
    assert.equal(r.status, 3, r.stderr);
    assert.equal(r.json.error.code, 'CONTROLLER_BUSY');
    assert.match(
      r.json.error.message,
      /Пакеты этого каталога установки уже обновляет другой harness update/,
    );
    assert.equal(p.installed('devcontour-harness'), CUR);
    const gates = p.harness('gates', '--state', p.state, '--sha', 'HEAD');
    assert.equal(gates.json.error.code, 'CONTROLLER_BUSY');
    assert.match(gates.json.error.message, /пакетов в /);
    // Пустая пара в --confirm-formats — неверный вход.
    assert.equal(p.harness('update', '--apply', '--confirm-formats', '--state', p.state).status, 2);
    rmSync(join(p.dir, '.harness-update.lock'));
    const ok = p.harness('update', '--apply', '--state', p.state);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.equal(
      existsSync(join(p.dir, '.harness-update.lock')),
      false,
      'замок снят после обновления',
    );
  } finally {
    await registry.close();
  }
});

test('UP22: реестр не знает пакет или версию (E404, ETARGET) — причина простыми словами, а не «code E404»; прочие отказы прежние', async () => {
  const { fetchTarball, peerDependencies } = await import('../src/update/npm.ts');
  const registry = await registryWith(...base());
  try {
    const p = project(registry);
    // Панель стоит в проекте, а в реестре её нет: настоящий npm отвечает E404.
    registry.unpublish('devcontour-harness-ui');
    const r = p.harness('update', '--check', '--state', p.state);
    assert.equal(r.status, 0, r.stderr);
    updateDataSchema.parse(r.json.data);
    const c = r.json.data.check;
    assert.equal(c.state, 'unavailable');
    assert.match(
      c.line,
      /^Не удалось проверить обновления: пакет devcontour-harness-ui ещё не опубликован в npm/,
    );
    assert.match(c.error, /0\.1\.0-alpha\.4/);
    assert.doesNotMatch(c.line + c.error, /E404/);
    // Пакет есть, версии нет: настоящий npm отвечает ETARGET.
    const o = { cwd: p.dir, registry: registry.url };
    await assert.rejects(
      fetchTarball('devcontour-harness', NEW2, o),
      rx(`версия ${NEW2} пакета devcontour-harness ещё не опубликована в npm`),
    );
    await assert.rejects(
      peerDependencies('devcontour-harness-ui', '0.1.0-alpha.4', o),
      /пакет devcontour-harness-ui ещё не опубликован в npm/,
    );
    // `npm view` версии, которой нет у опубликованного пакета, — E404 «No match
    // found for version»: это версия, а не пакет.
    await assert.rejects(
      peerDependencies('devcontour-harness', NEW2, o),
      rx(`версия ${NEW2} пакета devcontour-harness ещё не опубликована в npm`),
    );
    // Иной отказ (реестр не отвечает) — прежняя строка npm, без «не опубликован».
    await registry.close();
    const offline = p.harness('update', '--check', '--state', p.state);
    assert.equal(offline.json.data.check.state, 'unavailable');
    assert.doesNotMatch(offline.json.data.line, /не опубликован/);
  } finally {
    await registry.close().catch(() => {});
  }
});

test('UP23: установлена версия новее тега канала и есть в реестре — строка: опубликована, но тег канала на неё не указывает; обновление не нужно', async () => {
  // NEW есть в реестре (ставится точной версией), но тег alpha — на CUR.
  const registry = await registryWith(...base());
  registry.publish(fakeHarness(NEW), '');
  try {
    const p = project(registry, { harness: NEW });
    const r = p.harness('update', '--check', '--state', p.state);
    assert.equal(r.status, 0, r.stderr);
    updateDataSchema.parse(r.json.data);
    const c = r.json.data.check;
    assert.equal(c.state, 'up-to-date', JSON.stringify(c));
    assert.equal(c.available, undefined);
    assert.match(
      c.line,
      rx(
        `Обновление не нужно: установлен harness ${NEW} — новее тега канала alpha (${CUR}): версия опубликована, но тег канала на неё не указывает; панель 0.1.0-alpha.4 — последняя опубликованная (канал alpha).`,
      ),
    );
    assert.doesNotMatch(c.line, /Обновлений нет|ещё не опубликована/);
  } finally {
    await registry.close().catch(() => {});
  }
});

test('UP24: версия новее тега канала — «ещё не опубликована» только когда её нет в списке версий реестра; alpha.10 новее alpha.9 (не по строке)', async () => {
  const OLDER = '0.1.0-alpha.9';
  const NEWER = '0.1.0-alpha.10';
  const registry = await registryWith(fakeHarness(OLDER));
  registry.publish(fakeHarness(NEWER), '');
  try {
    const p = project(registry, { harness: NEWER, ui: false });
    assert.equal(p.installed('devcontour-harness'), NEWER);
    const listed = p.harness('update', '--check', '--state', p.state);
    assert.equal(listed.status, 0, listed.stderr);
    const a = listed.json.data.check;
    assert.equal(a.state, 'up-to-date', JSON.stringify(a));
    assert.equal(
      a.line,
      `Обновление не нужно: установлен harness ${NEWER} — новее тега канала alpha (${OLDER}): версия опубликована, но тег канала на неё не указывает (канал alpha).`,
    );

    // Версии в реестре нет (сборка до публикации): тег — на alpha.9.
    registry.unpublish('devcontour-harness');
    registry.publish(fakeHarness(OLDER));
    const absent = p.harness('update', '--check', '--state', p.state);
    assert.equal(absent.status, 0, absent.stderr);
    const b = absent.json.data.check;
    assert.equal(b.state, 'up-to-date', JSON.stringify(b));
    assert.equal(
      b.line,
      `Обновление не нужно: установлен harness ${NEWER} — новее опубликованного в npm ${OLDER}: эта версия ещё не опубликована (канал alpha).`,
    );
  } finally {
    await registry.close().catch(() => {});
  }
});
