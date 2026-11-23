import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  operatorViewSchema,
  setupProgressSchema,
  SETUP_BUDGET_MS,
} from '../src/contracts/index.ts';
import { setupProgress } from '../src/control/setup-progress.ts';
import { operatorView, viewToken } from '../src/projections/operator-view.ts';
import { baseInput, NOW, work } from './operator-view-input.ts';

const uuid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-setup-progress-')));
  const harness = join(root, '.harness');
  const state = join(root, 'state');
  mkdirSync(harness, { recursive: true });
  return { root, harness, state };
}
const touch = (path: string, at: number, body = '{}') => {
  writeFileSync(path, body);
  utimesSync(path, new Date(at), new Date(at));
};
const record = (state: string, id: string, at: number, data: Record<string, unknown>) => {
  const dir = join(state, 'gates-at', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ at: new Date(at).toISOString(), data }));
};

test('alpha.67 setup: без записей — шаги ждут, doctor не записывается, бюджет 30 мин', () => {
  const p = project();
  const progress = setupProgressSchema.parse(setupProgress({ harnessDir: p.harness, now: NOW }));
  assert.equal(progress.budgetMs, SETUP_BUDGET_MS);
  assert.equal(progress.overBudget, false);
  assert.deepEqual(
    progress.steps.map((s) => [s.id, s.state]),
    [
      ['profile', 'pending'],
      ['init', 'pending'],
      ['doctor', 'unknown'],
      ['smoke', 'pending'],
      ['probe', 'pending'],
      ['gates', 'pending'],
      ['connector', 'skipped'],
    ],
  );
  assert.match(progress.line, /^Настройка: готово 0 из 5 шагов$/);
});

test('alpha.67 setup: шаги по записям smoke, пробы и gates; время — от первой записи; превышение бюджета называется', () => {
  const p = project();
  const start = NOW - 50 * 60_000;
  touch(join(p.harness, 'profile.json'), start);
  touch(join(p.harness, 'project.json'), start + 60_000, JSON.stringify({ profile: { ref: 'x' } }));
  touch(join(p.harness, 'policy.json'), start + 60_000);
  touch(join(p.harness, 'connector.json'), start + 2 * 60_000);
  record(p.state, 'LS-' + uuid(1), start + 10 * 60_000, { passed: true, durationMs: 90_000 });
  record(p.state, 'LS-' + uuid(2), start + 20 * 60_000, {
    passed: true,
    durationMs: 120_000,
    writerProbe: { ok: false },
  });
  // Проход пробы под loopback — не отдельная запись smoke.
  record(p.state, `LS-${uuid(2)}-loopback-1`, start + 21 * 60_000, { passed: false });
  record(p.state, 'GA-' + uuid(3), start + 30 * 60_000, { passed: true, durationMs: 130_800 });
  const progress = setupProgressSchema.parse(
    setupProgress({ harnessDir: p.harness, stateDir: p.state, now: NOW }),
  );
  const byId = Object.fromEntries(progress.steps.map((s) => [s.id, s]));
  assert.equal(byId.profile!.state, 'done');
  assert.equal(byId.init!.state, 'done');
  assert.equal(byId.smoke!.state, 'done');
  assert.equal(byId.smoke!.elapsedMs, 120_000);
  assert.equal(byId.probe!.state, 'failed');
  assert.equal(byId.gates!.state, 'done');
  assert.equal(byId.gates!.elapsedMs, 130_800);
  assert.match(byId.gates!.line, /gates на HEAD: готово, 2 мин/);
  assert.equal(byId.connector!.state, 'pending');
  assert.ok(progress.elapsedMs! >= 50 * 60_000 - 1000, String(progress.elapsedMs));
  assert.equal(progress.overBudget, true);
  assert.match(progress.line, /готово 4 из 6 шагов · идёт 50 мин \(бюджет 30 мин — превышен\)/);
  assert.match(progress.line, /не прошло: проба исполнителя/);
  assert.match(progress.line, /работами infra в плане/);
  assert.match(
    progress.lineEn,
    /Setup: 4 of 6 steps done · running 50 min \(budget 30 min — exceeded\)/,
  );
});

test('alpha.67 setup: ход настройки в обзоре без работ (ревизия 7); с работами — нет; токен не зависит от часов', () => {
  const p = project();
  touch(join(p.harness, 'policy.json'), NOW - 10 * 60_000);
  const at = (now: number) => setupProgress({ harnessDir: p.harness, now });
  const view = operatorViewSchema.parse(operatorView(baseInput({ setup: at(NOW) })));
  assert.equal(view.viewRevision, 8);
  assert.equal(view.stage?.name, 'setup');
  assert.equal(view.stage?.progress?.steps.length, 7);
  assert.deepEqual(view.stage?.lines, ['Идёт настройка harness', 'Задач пока нет']);
  const later = operatorView(baseInput({ now: NOW + 60_000, setup: at(NOW + 60_000) }));
  assert.notEqual(later.stage?.progress?.elapsedMs, view.stage?.progress?.elapsedMs);
  assert.equal(viewToken(later), view.source.token);
  const busy = operatorView(baseInput({ setup: at(NOW), works: [work('w')] }));
  assert.deepEqual(busy.stage, { name: 'work', lines: [] });
});

test('alpha.67 setup: испорченная длительность (отрицательная, бесконечная, огромная, дробная) — без длительности, ответ проходит схему', () => {
  for (const [bad, expected] of [
    [-1, undefined],
    [1e308, undefined],
    [Number.MAX_SAFE_INTEGER * 4, undefined],
    ['90000', undefined],
    [1500.6, 1501],
  ] as const) {
    const p = project();
    const dir = join(p.state, 'gates-at', 'LS-' + uuid(1));
    mkdirSync(dir, { recursive: true });
    // JSON не несёт Infinity: 1e308 * 10 записывается как null — берём 1e308.
    writeFileSync(
      join(dir, 'result.json'),
      `{"at":"${new Date(NOW - 60_000).toISOString()}","data":{"passed":true,"durationMs":${JSON.stringify(bad)}}}`,
    );
    const progress = setupProgressSchema.parse(
      setupProgress({ harnessDir: p.harness, stateDir: p.state, now: NOW }),
    );
    const smoke = progress.steps.find((s) => s.id === 'smoke')!;
    assert.equal(smoke.state, 'done');
    assert.equal(smoke.elapsedMs, expected, String(bad));
    assert.ok(progress.elapsedMs === undefined || progress.elapsedMs >= 0);
  }
});

test('alpha.67 setup: из многих записей берутся последние по времени, а не по порядку каталога', () => {
  const p = project();
  const old = NOW - 40 * 60_000;
  for (let n = 2; n <= 502; n++) {
    const id = 'LS-' + uuid(n);
    record(p.state, id, old, { passed: true });
    utimesSync(join(p.state, 'gates-at', id), new Date(old), new Date(old));
  }
  // Самая новая запись — с наименьшим именем: порядок каталога её отрезал бы.
  const newest = 'LS-' + uuid(1);
  record(p.state, newest, NOW - 60_000, { passed: false });
  utimesSync(join(p.state, 'gates-at', newest), new Date(NOW - 60_000), new Date(NOW - 60_000));
  const progress = setupProgressSchema.parse(
    setupProgress({ harnessDir: p.harness, stateDir: p.state, now: NOW }),
  );
  assert.equal(progress.steps.find((s) => s.id === 'smoke')!.state, 'failed');
});
