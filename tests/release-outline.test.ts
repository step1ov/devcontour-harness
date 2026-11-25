/**
 * 0.1.0-alpha.68: план выпуска ведущего и прогноз по всему выпуску.
 * - `harness lead outline --file F`: этапы × компоненты с размером и тем,
 *   кто их делает; повторная запись — новая редакция с причиной и строкой
 *   журнала ведущего;
 * - без плана — подсказка `RELEASE_OUTLINE_MISSING` в status и панели, run не
 *   блокируется; только инфраструктура — 30 % выпуска (оценка);
 * - незарегистрированные части плана — объём выпуска и время по размеру;
 * - рост плана («план вырос: +W, было X % → стало Y %»), «если ведущий не
 *   добавит задач», «код принят · осталось немного: ведущий завершает»;
 * - этап идущей попытки к приёмке для карточки работы.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INFRA_DEFAULT_SHARE,
  OUTLINE_DEFAULT_TASK_MS,
  WORKSPACE_OWNER,
  cliCommands,
  cliDataSchemas,
  operatorViewSchema,
} from '../src/contracts/index.ts';
import { collectOperatorViewInput } from '../src/control/operator-view.ts';
import { statusOf } from '../src/control/status.ts';
import { leadOutline } from '../src/control/outline.ts';
import { leadBegin } from '../src/control/lead.ts';
import { operatorView, viewToken } from '../src/projections/operator-view.ts';
import type { OperatorOutlineInput } from '../src/projections/operator-view.ts';
import { NOW, at, attempt, baseInput, work } from './operator-view-input.ts';
import { engineOf, graphOf, policyOf, ready } from './engine-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (...args: string[]) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', cli, ...args],
    { encoding: 'utf8' },
  );
  return {
    status: r.status,
    stderr: r.stderr,
    json: JSON.parse(r.stdout) as { ok: boolean; data?: never; error?: { code: string } },
  };
};

const outlineFile = {
  stages: [
    {
      id: 'infra',
      title: 'Инфраструктура',
      kind: 'infra',
      components: [{ id: 'api-infra', title: 'API: сборка и gates', size: 'S', actor: 'writers' }],
    },
    {
      id: 'product',
      title: 'Продукт',
      kind: 'product',
      components: [
        { id: 'site', title: 'Сайт', size: 'M', actor: 'writers' },
        { id: 'admin', title: 'Админка', tasks: 3, actor: 'writers' },
      ],
    },
    {
      id: 'deploy',
      title: 'Выкладка',
      kind: 'deploy',
      components: [{ id: 'staging', title: 'Стенд и миграции', size: 'S', actor: 'owner' }],
    },
  ],
} as const;

const done = (id: string, over: Parameters<typeof work>[1] = {}) =>
  work(id, {
    status: 'done',
    stage: { ...work(id).stage, name: 'done', next: [] },
    attemptSummary: { ...work(id).attemptSummary, attempts: { used: 1, max: 3, left: 2 } },
    ...over,
  });

const outline = (over: Partial<OperatorOutlineInput> = {}): OperatorOutlineInput => ({
  revision: 1,
  recordedAt: at(300),
  firstRecordedAt: at(300),
  units: 7,
  stages: outlineFile.stages,
  changes: [],
  ...over,
});

const view = (input: ReturnType<typeof baseInput>) => operatorViewSchema.parse(operatorView(input));

test('alpha.68: lead outline — запись, та же редакция, рост с причиной, журнал, синоним и отказ', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  const first = leadOutline(env.engine, outlineFile);
  assert.equal(first.changed, true);
  assert.equal(first.outline.revision, 1);
  // S — 1, M — 2, tasks 3, S — 1.
  assert.equal(first.outline.units, 7);
  assert.match(first.line, /^План выпуска записан: 3 этапа, 4 компонента, ~7 задач\./);
  env.clock.now += 60_000;
  const same = leadOutline(env.engine, outlineFile);
  assert.equal(same.changed, false);
  assert.equal(same.outline.revision, 1);
  const grown = structuredClone(outlineFile) as unknown as {
    stages: { components: { id: string; title: string; size?: string; actor: string }[] }[];
  };
  grown.stages[1]!.components.push({ id: 'photos', title: 'Фото', size: 'L', actor: 'writers' });
  env.clock.now += 60_000;
  const next = leadOutline(env.engine, grown);
  assert.equal(next.changed, true);
  assert.equal(next.outline.revision, 2);
  assert.equal(next.outline.firstRecordedAt, first.outline.recordedAt);
  assert.deepEqual(next.change && { ...next.change, at: undefined }, {
    at: undefined,
    revision: 2,
    before: 7,
    after: 10,
    added: ['Фото'],
    removed: [],
    reason: 'план вырос: +Фото (было ~7 задач → стало ~10 задач)',
  });
  const log = env.engine.read((v) => v.local('lead', WORKSPACE_OWNER, 'log'))!;
  const journal = log.entries.filter((e) => e.action === 'lead.outline').map((e) => e.plain);
  assert.deepEqual(journal, [
    'ведущий записал план выпуска: 3 этапа, ~7 задач',
    'ведущий обновил план выпуска: план вырос: +Фото (было ~7 задач → стало ~10 задач)',
  ]);
  // Явная причина главнее разницы.
  grown.stages[1]!.components.pop();
  const shrunk = leadOutline(env.engine, grown, { reason: 'фото — в следующий выпуск' });
  assert.equal(shrunk.change?.reason, 'фото — в следующий выпуск');
  assert.deepEqual(shrunk.change?.removed, ['Фото']);
  // Не по договору — INVALID_INPUT с путём.
  assert.throws(
    () =>
      leadOutline(env.engine, {
        stages: [
          {
            id: 's',
            title: 'x',
            kind: 'infra',
            components: [{ id: 'c', title: 'y', actor: 'writers' }],
          },
        ],
      }),
    (e: { code?: string }) => e.code === 'INVALID_INPUT',
  );
  assert.throws(
    () =>
      leadOutline(env.engine, {
        stages: [
          {
            id: 's',
            title: 'x',
            kind: 'infra',
            components: [{ id: 's', title: 'y', size: 'S', actor: 'writers' }],
          },
        ],
      }),
    /План выпуска не по договору/,
  );
});

test('alpha.68 CLI: lead outline --file и синоним; status — RELEASE_OUTLINE_MISSING до плана, run не блокируется', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  const source = {
    engine: env.engine,
    policy: env.engine.policy,
    workflows: { list: () => [], continues: () => false } as never,
    stateDir: env.dir,
    baseDir: env.dir,
  };
  const missing = statusOf(source).outline;
  assert.equal(missing?.state, 'missing');
  assert.equal(missing?.code, 'RELEASE_OUTLINE_MISSING');
  assert.match(missing.line, /run не блокируется/);
  assert.equal(
    cliDataSchemas.status.parse(statusOf(source)).outline?.code,
    'RELEASE_OUTLINE_MISSING',
  );
  // Договор CLI называет команду и её флаги.
  assert.deepEqual(
    cliCommands['lead-outline'].args.map((a) => a.name),
    ['--state', '--file', '--reason', '--policy'],
  );
  assert.equal(cliCommands['lead-outline'].writes, true);
  const file = join(env.dir, 'outline.json');
  writeFileSync(file, JSON.stringify(outlineFile));
  writeFileSync(
    join(env.dir, 'binding.json'),
    JSON.stringify({ policy: env.engine.policy, baseDir: env.dir }),
  );
  env.store.close();
  const r = harness('lead', 'outline', '--state', env.dir, '--file', file);
  assert.equal(r.status, 0, r.stderr);
  const data = cliDataSchemas['lead-outline'].parse(r.json.data);
  assert.equal(data.outline.units, 7);
  const again = harness('lead-outline', '--state', env.dir, '--file', file, '--reason', 'то же');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(cliDataSchemas['lead-outline'].parse(again.json.data).changed, false);
  // --file только у lead-outline.
  const foreign = harness('status', '--state', env.dir, '--file', file);
  assert.equal(foreign.json.error?.code, 'INVALID_INPUT');
  const st = harness('status', '--state', env.dir);
  assert.equal(st.status, 0, st.stderr);
  const status = cliDataSchemas.status.parse(st.json.data);
  assert.equal(status.outline?.state, 'recorded');
  assert.equal(status.outline?.revision, 1);
  assert.equal(status.outline?.units, 7);
});

test('alpha.69 CLI: lead outline до первого run — с --policy каталог привязан и план записан; без него — отказ с подсказкой', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-outline-'));
  const state = join(dir, 'state');
  const policyFile = join(dir, 'policy.json');
  writeFileSync(policyFile, JSON.stringify(policyOf()));
  const file = join(dir, 'outline.json');
  writeFileSync(file, JSON.stringify(outlineFile));
  // Каталога состояния ещё нет: без политики — понятный отказ, а не молчаливое создание.
  const refused = harness('lead', 'outline', '--state', state, '--file', file);
  assert.equal(refused.json.error?.code, 'NOT_FOUND');
  assert.match(JSON.stringify(refused.json.error), /--policy/);
  assert.equal(existsSync(state), false, 'отказ ничего не создал');
  const r = harness('lead', 'outline', '--state', state, '--policy', policyFile, '--file', file);
  assert.equal(r.status, 0, r.stderr);
  const data = cliDataSchemas['lead-outline'].parse(r.json.data);
  assert.equal(data.changed, true);
  assert.equal(data.outline.revision, 1);
  assert.ok(existsSync(join(state, 'binding.json')), 'каталог привязан к политике');
  // Дальше — как у привязанного каталога: без --policy, та же редакция.
  const again = harness('lead', 'outline', '--state', state, '--file', file);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(cliDataSchemas['lead-outline'].parse(again.json.data).changed, false);
  // Первый граф застаёт записанный план: status называет его записанным.
  const st = harness('status', '--state', state);
  assert.equal(st.status, 0, st.stderr);
  const status = cliDataSchemas.status.parse(st.json.data);
  assert.equal(status.outline?.state, 'recorded');
  assert.equal(status.outline?.units, 7);
});

test('alpha.68: незарегистрированные части плана — объём выпуска, состояние этапов и время по размеру', () => {
  // Инфраструктура принята, сайт (M = 2) — одна работа идёт; админка и стенд не зарегистрированы.
  const running = work('site-1', {
    status: 'running',
    stage: {
      ...work('site-1').stage,
      name: 'gates',
      since: at(5),
      next: ['review', 'integration'],
    },
  });
  const input = baseInput({
    works: [done('api', { kind: 'infra', seenAt: at(290) }), { ...running, seenAt: at(200) }],
    attempts: [
      attempt('api', 1),
      attempt('site-1', 1, { status: 'active', finishedAt: undefined }),
    ],
    outline: outline(),
  });
  const f = view(input).forecast!;
  // Код: (1 + 0,4) из 2 + 5 незарегистрированных задач; ведущий — 0 из 3 шагов.
  assert.equal(f.progress.percent, Math.round(100 * ((0.9 * 1.4) / 7)));
  assert.match(f.progress.line, /по плану выпуска ещё не зарегистрировано: ~5$/);
  const o = f.outline!;
  assert.equal(o.state, 'recorded');
  assert.deepEqual(
    { units: o.units, registered: o.registered, unregistered: o.unregistered },
    { units: 7, registered: 2, unregistered: 5 },
  );
  assert.deepEqual(
    o.stages!.map((s) => [s.id, s.state, s.registered, s.units]),
    [
      ['infra', 'registered', 1, 1],
      ['product', 'partial', 1, 5],
      ['deploy', 'unregistered', 0, 1],
    ],
  );
  assert.deepEqual(o.stages![1]!.components[0]!.works, ['site-1']);
  assert.equal(o.stages![0]!.percent, 100);
  // Время незарегистрированного: 4 задачи у исполнителей, 1 шаг владельца.
  const t = f.time.outline!;
  assert.equal(t.units, 4);
  assert.equal(t.ownerUnits, 1);
  assert.equal(t.basis, 'attempts');
  assert.match(
    t.line,
    /^по плану выпуска ещё ~4 задачи: ~.* \(оценка по размеру\), шагов владельца ~1 — в оценку не входят$/,
  );
  assert.match(f.time.line, /\+ по плану выпуска ещё ~4 задачи/);
  // Без закончившихся попыток — типичная длительность задачи.
  const fresh = view({ ...input, attempts: [] }).forecast!.time.outline!;
  assert.equal(fresh.basis, 'default');
  assert.equal(fresh.hiMs, 4 * OUTLINE_DEFAULT_TASK_MS.hi);
  // Выпуск не «код принят», пока план не зарегистрирован целиком.
  const accepted = view({
    ...input,
    works: [done('api', { kind: 'infra' }), done('site-1')],
    attempts: [attempt('api', 1), attempt('site-1', 1)],
  }).forecast!;
  assert.equal(accepted.progress.release?.state, 'in-work');
  assert.equal(accepted.time.finishedAt, undefined);
  assert.match(accepted.time.line, /по зарегистрированным работам — ничего \+ по плану выпуска/);
  assert.equal(accepted.progress.lead?.steps.find((s) => s.step === 'plan')?.done, false);
});

test('alpha.68: без плана — подсказка; одна инфраструктура — 30 % выпуска (оценка), продукт не спланирован', () => {
  const input = baseInput({
    works: [done('api', { kind: 'infra' }), work('db', { kind: 'infra' })],
    attempts: [attempt('api', 1)],
  });
  const f = view(input).forecast!;
  assert.deepEqual(
    { state: f.outline?.state, code: f.outline?.code },
    { state: 'missing', code: 'RELEASE_OUTLINE_MISSING' },
  );
  assert.match(f.outline!.line, /^плана выпуска нет — прогноз по одному графу/);
  assert.equal(f.progress.infraShare?.share, INFRA_DEFAULT_SHARE);
  // Код инфраструктуры: 1 из 2 × 0,3 × 0,9.
  assert.equal(f.progress.percent, Math.round(100 * 0.9 * 0.3 * 0.5));
  assert.match(
    f.progress.line,
    /; инфраструктура — 30 % выпуска \(оценка\), продукт ещё не спланирован$/,
  );
  assert.match(f.time.line, / · продукт ещё не спланирован — в оценку не входит/);
  // Продуктовая работа — доли нет.
  const mixed = view({ ...input, works: [...input.works, work('site')] }).forecast!;
  assert.equal(mixed.progress.infraShare, undefined);
  // English.
  const en = operatorView(input, { lang: 'en' }).forecast!;
  assert.match(en.outline!.line, /^no release outline/);
  assert.match(en.progress.line, /infrastructure is 30 % of the release \(estimate\)/);
});

test('alpha.68: рост плана — работа сверх плана и запись плана с большим объёмом', () => {
  // Без плана: второй граф позже первого — «план вырос: +W».
  const base = baseInput({
    works: [
      done('w1', { seenAt: at(200) }),
      done('w2', { seenAt: at(200) }),
      work('w3', { seenAt: at(30) }),
    ],
    attempts: [attempt('w1', 1), attempt('w2', 1)],
  });
  const g = view(base).forecast!.progress;
  assert.deepEqual(g.growth && { ...g.growth }, {
    at: at(30),
    added: ['w3'],
    before: g.growth!.before,
    after: g.percent,
    by: 'works',
    line: `план вырос: +w3 (было ${g.growth!.before} % → стало ${g.percent} %)`,
  });
  assert.ok(g.growth!.before > g.percent);
  // Работа, которая заполняет план, — не рост.
  const planned = view({
    ...base,
    outline: outline({
      units: 3,
      stages: [
        {
          id: 'p',
          title: 'Продукт',
          kind: 'product',
          components: [{ id: 'c', title: 'Всё', tasks: 3, actor: 'writers' }],
        },
      ],
    }),
  }).forecast!.progress;
  assert.equal(planned.growth, undefined);
  // Запись плана выросла — рост по плану с причиной.
  const grown = view({
    ...base,
    works: base.works.map((w) => ({ ...w, seenAt: at(200) })),
    outline: outline({
      revision: 2,
      units: 5,
      stages: [
        {
          id: 'p',
          title: 'Продукт',
          kind: 'product',
          components: [
            { id: 'c', title: 'Всё', tasks: 3, actor: 'writers' },
            { id: 'photos', title: 'Фото', tasks: 2, actor: 'writers' },
          ],
        },
      ],
      changes: [
        {
          at: at(10),
          revision: 2,
          before: 3,
          after: 5,
          added: ['Фото'],
          removed: [],
          reason: 'план вырос: +Фото',
        },
      ],
    }),
  }).forecast!.progress;
  assert.equal(grown.growth?.by, 'outline');
  assert.deepEqual(grown.growth?.added, ['Фото']);
  assert.equal(grown.growth?.reason, 'план вырос: +Фото');
  assert.ok(grown.growth.before > grown.percent, JSON.stringify(grown.growth));
  assert.match(grown.growth.line, /^план вырос: \+Фото \(было \d+ % → стало \d+ %\)$/);
});

test('alpha.68: последний отрезок — «если ведущий не добавит задач», «ведущий завершает», токен не идёт за часами', () => {
  const lead = {
    session: { since: at(100), until: new Date(NOW + 20 * 60_000).toISOString() },
    entries: [],
  };
  const inWork = baseInput({
    works: [
      done('w1'),
      work('w2', {
        status: 'running',
        stage: { ...work('w2').stage, name: 'review', since: at(2) },
      }),
    ],
    attempts: [attempt('w1', 1), attempt('w2', 1, { status: 'active', finishedAt: undefined })],
    lead,
  });
  const f = view(inWork).forecast!;
  assert.equal(f.progress.conditional, true);
  assert.match(f.progress.line, / — если ведущий не добавит задач$/);
  // Без сессии ведущего — без оговорки.
  assert.equal(
    view({ ...inWork, lead: { entries: [] } }).forecast!.progress.conditional,
    undefined,
  );
  // Код принят, ведущий завершает 5 мин, его обычная доля — 10 мин (разрыв «приёмка → следующая попытка»).
  const finishing = baseInput({
    works: [done('w1'), done('w2')],
    attempts: [
      attempt('w1', 1, { startedAt: at(60), finishedAt: at(40) }),
      attempt('w2', 1, { startedAt: at(30), finishedAt: at(5) }),
    ],
    lead,
  });
  const a = view(finishing).forecast!;
  assert.equal(a.progress.release?.state, 'code-accepted');
  assert.ok(a.progress.percent <= 99);
  assert.match(a.progress.line, /^готово ~\d+ % — если ведущий не добавит задач · код принят/);
  assert.deepEqual(a.time.finishing, { since: at(5), elapsedMs: 5 * 60_000 });
  assert.match(
    a.time.line,
    /код принят · осталось немного: ведущий завершает \(идёт 5 мин, обычно ~/,
  );
  assert.doesNotMatch(a.time.line, /осталось: ничего/);
  // Через час: доля ведущего превышена — оценки нет, только сколько идёт.
  const late = view({ ...finishing, now: NOW + 60 * 60_000 }).forecast!;
  assert.equal(late.time.finishing?.exceeded, true);
  assert.match(late.time.line, /ведущий завершает \(идёт 1 ч 5 мин\)/);
  assert.doesNotMatch(late.time.line, /обычно|работа ведущего/);
  // Токен — по началу отрезка, а не по прошедшему времени.
  const t1 = viewToken(operatorView({ ...finishing, now: NOW + 60_000 }));
  const t2 = viewToken(operatorView({ ...finishing, now: NOW + 120_000 }));
  assert.equal(t1, t2);
});

test('alpha.68: этап идущей попытки к приёмке — доли этапа и типичная длительность', () => {
  const input = baseInput({
    works: [
      work('w1', {
        status: 'running',
        stage: { ...work('w1').stage, name: 'review', since: at(3), next: ['integration'] },
      }),
      work('w2'),
    ],
    attempts: [attempt('w1', 1, { status: 'active', finishedAt: undefined })],
    stageTypical: { review: { p50Ms: 6 * 60_000, p90Ms: 9 * 60_000, samples: 2 } },
  });
  const works = view(input).forecast!.progress.works!;
  assert.deepEqual(works.find((w) => w.workId === 'w1')?.stageProgress, {
    stage: 'review',
    from: 0.6,
    to: 0.8,
    since: at(3),
    typicalMs: 6 * 60_000,
    samples: 2,
  });
  assert.equal(works.find((w) => w.workId === 'w2')?.stageProgress, undefined);
});

test('alpha.68: представление собирает план и первое появление работ из состояния', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  const seen = env.engine.read((v) => v.local('work-seen', WORKSPACE_OWNER, 'w'));
  assert.ok(seen?.at);
  leadBegin(env.engine, { ttlMs: 30 * 60_000 });
  leadOutline(env.engine, outlineFile);
  const source = {
    engine: env.engine,
    policy: env.engine.policy,
    workflows: { list: () => [], continues: () => false } as never,
    stateDir: env.dir,
    baseDir: env.dir,
  };
  const input = collectOperatorViewInput(
    source,
    { raw: env.engine.policy, warnings: [], baseDir: env.dir },
    { now: env.engine.clock() },
  );
  assert.equal(input.outline?.units, 7);
  assert.equal(input.works[0]!.seenAt, seen.at);
  const doc = operatorViewSchema.parse(operatorView(input));
  assert.equal(doc.forecast?.outline?.state, 'recorded');
  assert.ok(doc.activity?.some((x) => x.action === 'lead.outline'));
});
