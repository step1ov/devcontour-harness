/**
 * Доработка после приёмки (пилот 3, P3-1): изменённая постановка уже
 * принятого поручения — новая редакция со своим пределом попыток, а не
 * повтор проваленного договора. Изменённая постановка непринятого поручения
 * сохраняет счётчик: перепланированием предел не обойти. Своих пределов у
 * доработок не больше `MAX_REWORK_BUDGETS`, дальше счётчик переносится.
 * Прежняя приёмка записана у поручения: status, view и прогноз говорят
 * «принято ранее на <sha>; доработка …», а не «принято 0».
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliDataSchemas, digestOf, type WorkGraph } from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { MAX_REWORK_BUDGETS } from '../src/engine/failure.ts';
import { statusOf } from '../src/control/status.ts';
import { releaseDone } from '../src/control/lead.ts';
import { collectOperatorViewInput } from '../src/control/operator-view.ts';
import { attemptLine, operatorView } from '../src/projections/index.ts';
import { currentRevisionAttempts } from '../src/report/compute.ts';
import { operatorViewSchema } from '../src/contracts/index.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import {
  engineOf,
  graphOf,
  planReview,
  policyOf,
  ready,
  sha,
  trustNone,
} from './engine-fixture.ts';

/** Провести попытку через обе фазы с PASS gate и ревью и принять её. */
function accept(e: Engine, id: string, token: string, candidate: string, integration: string) {
  e.phase(id, token, 'verifying', { candidateSha: candidate });
  for (const [phase, at] of [
    ['candidate', candidate],
    ['integration', integration],
  ] as const) {
    if (phase === 'integration') e.phase(id, token, 'integrating', { integrationSha: integration });
    e.evidence(id, token, {
      kind: 'test',
      phase,
      sha: at,
      gate: 'unit',
      passed: true,
      command: ['npm', 'test'],
      exitCode: 0,
      log: '',
      digest: digestOf(phase),
      summary: 'ok',
    });
    e.evidence(id, token, {
      kind: 'review',
      phase,
      sha: at,
      gate: 'independent-review',
      passed: true,
      command: ['codex'],
      exitCode: 0,
      log: '',
      digest: digestOf('r' + phase),
      summary: 'ok',
      findings: [],
    });
  }
  e.finish(id, token, integration);
}

/** Редакция графа `revision` с изменённой целью поручения `w`. */
function revised(
  revision: string,
  goal: string,
  deps: Record<string, string[]> = { w: [], x: ['w'] },
): WorkGraph {
  const g = graphOf(deps, revision);
  g.orders[0] = { ...g.orders[0]!, goal };
  return g;
}

/** Новая редакция: регистрация, раунд ревью плана и согласование. */
function replan(e: Engine, graph: WorkGraph) {
  const { graph: state } = e.register(graph, trustNone);
  e.recordReview(planReview(e, state, e.reviews('plan', state.id).length + 1));
  e.approve(state.id, 'agent');
  return state;
}

const fail = (e: Engine) => {
  const run = e.claim('c1')!;
  assert.equal(run.workId, 'w');
  e.fail(run.id, run.token, 'unit failed', { kind: 'gate' });
  return run;
};

/**
 * Пилот: #1 и #2 — засчитанные отказы, #3 принята; ведущий нашёл ошибку
 * своей проверкой и перепланировал поручение с изменённой постановкой.
 */
function pilot(deps: Record<string, string[]> = { w: [], x: ['w'] }) {
  // Приёмка выпуска (alpha.69) здесь не предмет: совет вместо требования.
  const env = engineOf(policyOf((p) => (p.release = { review: 'advisory' })));
  const { engine } = env;
  assert.equal(engine.policy.maxAttempts, 3);
  ready(engine, graphOf(deps));
  // `x` зависит от `w`: выдаётся только `w`.
  fail(engine);
  engine.retry('w');
  fail(engine);
  engine.retry('w');
  const third = engine.claim('c1')!;
  assert.equal(third.workId, 'w');
  accept(engine, third.id, third.token, sha('a'), sha('b'));
  const accepted = engine.read((v) => v.work('w')!);
  assert.equal(accepted.status, 'done');
  assert.equal(accepted.attempt, 3);
  replan(engine, revised('2', 'Исправить ошибку JS, найденную после приёмки.', deps));
  return { ...env, third };
}

test('P3-1: изменённая постановка принятого поручения — доработка со своим пределом попыток', () => {
  const { engine, store, third } = pilot();
  const w = engine.read((v) => v.work('w')!);
  assert.equal(w.status, 'ready');
  assert.equal(w.attempt, 0, 'доработка начинает свой предел попыток');
  assert.deepEqual(
    engine.read((v) => engine.blockers(w, v)).filter((b) => b.code === 'ATTEMPTS_EXHAUSTED'),
    [],
    'не ATTEMPTS_EXHAUSTED: решения человека не нужно',
  );
  assert.deepEqual(w.rework, {
    revision: 1,
    budgets: 1,
    fresh: true,
    accepted: { runId: third.id, resultSha: sha('b'), at: w.rework!.accepted.at },
    reopenedAt: w.rework!.reopenedAt,
    roundEpochAt: w.rework!.reopenedAt,
    spent: 3,
    // 0.1.0-alpha.66: постановка принятой редакции — для отказа от доработки.
    acceptedOrder: graphOf({ w: [], x: ['w'] }).orders[0],
  });
  const reopened = store.events(0, 1000).filter((e) => e.type === 'work.reopened');
  assert.deepEqual(
    reopened.map((e) => [e.workId, e.payload]),
    [['w', { revision: 1, budget: 'fresh', acceptedSha: sha('b'), spent: 3 }]],
  );
  // explain: ничего от человека.
  const policy = engine.policy;
  const stops = stopInputsOf(
    { engine, policy, workflows: { list: () => [], continues: () => false } },
    { maxAttempts: policy.maxAttempts, repairBudget: policy.repairBudget },
  )
    .filter((i) => i.kind === 'work' && i.work.id === 'w')
    .map(explainStop);
  assert.ok(
    stops.every((s) => s.actor !== 'user'),
    JSON.stringify(stops.map((s) => [s.code, s.actor, s.action])),
  );
  // Первая попытка доработки — №1, и её приёмка снова закрывает поручение.
  const run = engine.claim('c1')!;
  assert.equal(run.workId, 'w');
  assert.equal(run.attempt, 1);
  accept(engine, run.id, run.token, sha('c'), sha('d'));
  const done = engine.read((v) => v.work('w')!);
  assert.equal(done.status, 'done');
  assert.equal(done.attempt, 1);
  assert.equal(done.resultSha, sha('d'));
  assert.equal(done.rework?.revision, 1, 'история приёмки остаётся у поручения');
});

test('P3-1: изменённая постановка непринятого поручения сохраняет счётчик', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ w: [], x: ['w'] }));
  fail(engine);
  engine.retry('w');
  fail(engine);
  replan(engine, revised('2', 'Другая цель до приёмки.'));
  let w = engine.read((v) => v.work('w')!);
  assert.equal(w.status, 'ready');
  assert.equal(w.attempt, 2, 'перепланирование до приёмки не возвращает попытки');
  assert.equal(w.rework, undefined);
  const third = engine.claim('c1')!;
  assert.equal(third.attempt, 3, 'последняя попытка предела');
  engine.fail(third.id, third.token, 'unit failed', { kind: 'gate' });
  replan(engine, revised('3', 'Ещё одна цель до приёмки.'));
  w = engine.read((v) => v.work('w')!);
  assert.equal(w.attempt, 3);
  assert.deepEqual(
    engine
      .read((v) => engine.blockers(w, v))
      .filter((b) => b.code === 'ATTEMPTS_EXHAUSTED')
      .map((b) => b.code),
    ['ATTEMPTS_EXHAUSTED'],
    'исчерпание переживает новую редакцию',
  );
  assert.equal(engine.claim('c1'), undefined, 'w не выдаётся');
});

test('P3-1: незасчитанные отказы непринятого поручения тоже переживают перепланирование', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ w: [], x: ['w'] }));
  const run = engine.claim('c1')!;
  engine.fail(run.id, run.token, 'sandbox died', { kind: 'environment' });
  engine.resume();
  const before = engine.read((v) => v.work('w')!.neutralFailures);
  assert.equal(before, 1);
  replan(engine, revised('2', 'Другая цель до приёмки.'));
  assert.equal(
    engine.read((v) => v.work('w')!.neutralFailures),
    1,
  );
});

test('P3-1: свой предел — не больше MAX_REWORK_BUDGETS доработок; дальше счётчик переносится', () => {
  const { engine, store } = pilot();
  let n = 1;
  /**
   * Закончить текущую редакцию: `fails` засчитанных отказов, по желанию отказ
   * окружения (незасчитанный), затем приёмка; и открыть следующую доработку.
   */
  const cycle = (fails: number, neutral = false) => {
    for (let k = 0; k < fails; k++) {
      fail(engine);
      engine.retry('w');
    }
    if (neutral) {
      const env = engine.claim('c1')!;
      engine.fail(env.id, env.token, 'sandbox died', { kind: 'environment' });
      engine.resume();
      engine.retry('w');
    }
    const run = engine.claim('c1')!;
    assert.equal(run.workId, 'w');
    accept(engine, run.id, run.token, sha('e'), sha(String(n % 10)));
    n++;
    replan(engine, revised(String(n + 1), `Доработка ${n}.`));
    return engine.read((v) => v.work('w')!);
  };
  const reopened = () =>
    store.events(0, 5000).flatMap((e) => (e.type === 'work.reopened' ? [e.payload] : []));
  // Доработки 2 … MAX — со своим пределом; отказ окружения принятой редакции
  // свежая доработка не наследует.
  let w = engine.read((v) => v.work('w')!);
  for (let k = 1; k < MAX_REWORK_BUDGETS; k++) {
    w = cycle(2, true);
    assert.equal(w.rework?.fresh, true);
    assert.equal(w.attempt, 0);
    assert.equal(w.neutralFailures, undefined, 'свежая доработка — незасчитанные с нуля');
  }
  assert.equal(w.rework?.budgets, MAX_REWORK_BUDGETS);
  // Редакция MAX принята с первой попытки и с отказом окружения: доработка
  // MAX + 1 переносит её счётчик (1, а не предел) и её незасчитанные отказы.
  w = cycle(0, true);
  assert.equal(w.rework?.revision, MAX_REWORK_BUDGETS + 1);
  assert.equal(w.rework?.budgets, MAX_REWORK_BUDGETS);
  assert.equal(w.rework?.fresh, false);
  assert.equal(w.attempt, 1, 'перенесён счётчик принятой редакции, а не исчерпание');
  assert.equal(w.neutralFailures, 1, 'перенесены и незасчитанные отказы');
  assert.equal(
    engine.read((v) => engine.blockers(w, v)).find((b) => b.code === 'ATTEMPTS_EXHAUSTED'),
    undefined,
  );
  assert.deepEqual(reopened().at(-1), {
    revision: MAX_REWORK_BUDGETS + 1,
    budget: 'carried',
    acceptedSha: sha(String((n - 1) % 10)),
    spent: 1,
  });
  // Перенесённая доработка: один отказ, приёмка третьей — следующая
  // доработка получает 3 из 3 и ждёт решения человека.
  w = cycle(1);
  assert.equal(w.attempt, 3, 'сверх предела доработок попытки переносятся');
  const exhausted = engine
    .read((v) => engine.blockers(w, v))
    .find((b) => b.code === 'ATTEMPTS_EXHAUSTED');
  assert.match(exhausted?.message ?? '', /доработ/);
  assert.equal(reopened().at(-1)?.budget, 'carried');
});

test('P3-1: новая редакция открытой доработки — не новая доработка: счётчик и предел прежние', () => {
  const { engine, store } = pilot();
  fail(engine);
  engine.retry('w');
  const before = engine.read((v) => v.work('w')!);
  assert.equal(before.attempt, 1);
  replan(engine, revised('3', 'Доработка, уточнённая до приёмки.'));
  const w = engine.read((v) => v.work('w')!);
  assert.equal(w.status, 'ready');
  assert.equal(w.attempt, 1, 'непринятая доработка сохраняет счётчик');
  assert.deepEqual(w.rework, before.rework, 'та же доработка, тот же предел');
  assert.equal(
    store.events(0, 5000).filter((e) => e.type === 'work.reopened').length,
    1,
    'work.reopened — только при открытии доработки',
  );
});

test('P3-1: currentRevisionAttempts — без runId принятой попытки граница по времени открытия', () => {
  const at = (m: number) => `2026-01-01T00:0${m}:00.000Z`;
  const attempts = [1, 2, 3, 4].map((m) => ({ id: 'r' + m, startedAt: at(m) }));
  const rework = {
    revision: 1,
    budgets: 1,
    fresh: true,
    accepted: { resultSha: sha('a') },
    reopenedAt: at(3),
    spent: 2,
  };
  assert.deepEqual(
    currentRevisionAttempts({ rework }, attempts).map((a) => a.id),
    ['r3', 'r4'],
  );
  // runId есть, но записи нет (не найдена) — тоже по времени.
  assert.deepEqual(
    currentRevisionAttempts(
      { rework: { ...rework, accepted: { runId: 'gone', resultSha: sha('a') } } },
      attempts,
    ).map((a) => a.id),
    ['r3', 'r4'],
  );
  // С runId — после принявшей попытки.
  assert.deepEqual(
    currentRevisionAttempts(
      { rework: { ...rework, accepted: { runId: 'r1', resultSha: sha('a') } } },
      attempts,
    ).map((a) => a.id),
    ['r2', 'r3', 'r4'],
  );
  assert.equal(currentRevisionAttempts({}, attempts), attempts);
});

test('P3-1: status называет прежнюю приёмку и попытки доработки, а не «принято 0»', () => {
  const { engine } = pilot();
  const status = () =>
    cliDataSchemas.status
      .parse(statusOf({ engine, policy: engine.policy }))
      .works.find((x) => x.id === 'w')!;
  let sw = status();
  assert.equal(sw.attempt, 0);
  assert.deepEqual(sw.attemptSummary!.rework, {
    revision: 1,
    fresh: true,
    acceptedSha: sha('b'),
    acceptedAt: sw.attemptSummary!.rework!.acceptedAt,
    earlierRuns: 3,
  });
  assert.equal(
    sw.attemptSummary!.total,
    0,
    'попытки прежней редакции не входят в сводку доработки',
  );
  assert.equal(
    sw.attemptSummary!.line,
    `принято ранее на ${sha('b').slice(0, 7)}; доработка 1: попыток 0; отказов 0; по времени 0; прервано остановкой 0; принято 0; осталось попыток 3 из 3`,
  );
  assert.doesNotMatch(sw.stage!.line, /исчерпан|сброс/);
  assert.equal(
    sw.verification,
    undefined,
    'проверки прежней редакции не выдаются за проверки доработки',
  );
  const run = engine.claim('c1')!;
  sw = status();
  assert.match(
    sw.attemptSummary!.line,
    /^принято ранее на b{7}; доработка 1: попыток 1 \(идёт 1\)/,
  );
  engine.fail(run.id, run.token, 'unit failed', { kind: 'gate' });
  sw = status();
  assert.match(sw.attemptSummary!.line, /осталось попыток 2 из 3$/);
});

test('P3-1: view и прогноз — работа принята ранее, доработка отдельно; прогноз не падает', () => {
  const { engine, dir } = pilot();
  const source = {
    engine,
    policy: engine.policy,
    workflows: { list: () => [], continues: () => false } as never,
    stateDir: dir,
    baseDir: dir,
  };
  const view = (now: number, lang: 'ru' | 'en' = 'ru') =>
    operatorViewSchema.parse(
      operatorView(
        collectOperatorViewInput(
          source,
          { raw: engine.policy, warnings: [], baseDir: dir },
          { now, lang },
        ),
        { lang },
      ),
    );
  const before = view(engine.clock());
  const en = view(engine.clock(), 'en');
  assert.match(
    en.works.find((x) => x.id === 'w')!.attempts.line ?? '',
    /^accepted earlier at b{7}; rework 1: /,
  );
  assert.match(
    en.forecast!.progress.works!.find((x) => x.workId === 'w')!.line,
    /^w: accepted earlier; rework — not started/,
  );
  assert.match(en.forecast!.progress.line, /reworks after acceptance: 1/);
  const w = before.works.find((x) => x.id === 'w')!;
  assert.deepEqual(w.attempts.rework, {
    revision: 1,
    fresh: true,
    acceptedSha: sha('b'),
    acceptedAt: w.attempts.rework!.acceptedAt,
  });
  assert.match(w.attempts.line ?? '', /^принято ранее на b{7}; доработка 1: /);
  const f = before.forecast!;
  // Объём 2: w принята ранее (100 %), x — 0: прогноз не ниже 50 %.
  assert.equal(f.progress.percent, 50);
  assert.equal(f.progress.done, 1);
  assert.equal(f.progress.rework, 1);
  assert.match(f.progress.line, /доработок после приёмки: 1/);
  const row = f.progress.works!.find((x) => x.workId === 'w')!;
  assert.equal(row.rework, true);
  assert.match(row.line, /^w: принято ранее; доработка — ещё не начата/);
  // Идёт первая попытка доработки: строка называет её номер в своём пределе.
  engine.claim('c1');
  const running = view(engine.clock()).forecast!;
  assert.equal(running.progress.percent, 50, 'идущая доработка прогноз не роняет');
  assert.match(
    running.progress.works!.find((x) => x.workId === 'w')!.line,
    /^w: принято ранее; доработка ~\d+ %, попытка 1 из 3/,
  );
  assert.equal(running.time.finishedAt, undefined);
});

test('P3-1: строка попыток доработки — прежняя приёмка в начале, хвост остатка цел', () => {
  const facts = {
    total: 1,
    active: 0,
    failed: 1,
    failures: [{ key: 'defect', count: 1 }],
    timeouts: 0,
    interrupted: 0,
    accepted: 0,
    attempts: { used: 1, max: 3 },
  };
  assert.equal(
    attemptLine({ ...facts, rework: { revision: 2, acceptedSha: sha('c'), fresh: true } }, 'ru'),
    'принято ранее на ccccccc; доработка 2: попыток 1; отказов 1 (defect 1); по времени 0; прервано остановкой 0; принято 0; осталось попыток 2 из 3',
  );
  assert.equal(
    attemptLine(
      {
        ...facts,
        attempts: { used: 3, max: 3 },
        rework: { revision: 4, acceptedSha: sha('c'), fresh: false },
      },
      'en',
    ),
    'accepted earlier at ccccccc; rework 4 (attempts carried over): runs 1, counted attempts 3; failures 1 (defect 1); time limit 0; interrupted by shutdown 0; accepted 0; attempts left 0 of 3',
  );
  // Узкий предел: хвост остатка сохраняется.
  const narrow = attemptLine(
    { ...facts, rework: { revision: 2, acceptedSha: sha('c'), fresh: true } },
    'ru',
    60,
  );
  assert.ok(narrow.length <= 60);
  assert.match(narrow, /осталось попыток 2 из 3$/);
});

test('P3-1: status второй доработки — попытки после принявшей доработку 1', () => {
  const { engine } = pilot();
  const run = engine.claim('c1')!;
  accept(engine, run.id, run.token, sha('c'), sha('d'));
  replan(engine, revised('3', 'Вторая доработка.'));
  const status = () =>
    cliDataSchemas.status
      .parse(statusOf({ engine, policy: engine.policy }))
      .works.find((x) => x.id === 'w')!;
  let sw = status();
  assert.deepEqual(sw.attemptSummary!.rework, {
    revision: 2,
    fresh: true,
    acceptedSha: sha('d'),
    acceptedAt: sw.attemptSummary!.rework!.acceptedAt,
    earlierRuns: 4,
  });
  assert.equal(sw.attemptSummary!.total, 0);
  assert.match(sw.attemptSummary!.line, /^принято ранее на d{7}; доработка 2: попыток 0;/);
  engine.claim('c1');
  sw = status();
  assert.equal(sw.attemptSummary!.total, 1);
  assert.equal(sw.attemptSummary!.rework.earlierRuns, 4);
  assert.match(
    sw.attemptSummary!.line,
    /^принято ранее на d{7}; доработка 2: попыток 1 \(идёт 1\)/,
  );
});

/** Представление над состоянием `engineOf`. */
function viewOf(env: ReturnType<typeof engineOf>, lang: 'ru' | 'en' = 'ru') {
  const { engine, dir } = env;
  const source = {
    engine,
    policy: engine.policy,
    workflows: { list: () => [], continues: () => false } as never,
    stateDir: dir,
    baseDir: dir,
  };
  return operatorViewSchema.parse(
    operatorView(
      collectOperatorViewInput(
        source,
        { raw: engine.policy, warnings: [], baseDir: dir },
        { now: engine.clock(), lang },
      ),
      { lang },
    ),
  );
}

test('P3-1: прогноз выпуска из одной доработанной работы — 99 %, не закончен, остаток не «ничего»', () => {
  const env = pilot({ w: [] });
  // Попытки прежней редакции закончились — есть образцы времени.
  env.clock.now += 60_000;
  env.engine.lead('c1');
  const f = viewOf(env).forecast!;
  assert.equal(f.progress.total, 1);
  assert.equal(f.progress.left, 0);
  assert.equal(f.progress.rework, 1);
  // Код весь принят ранее (90 % выпуска), шаги ведущего — план согласован,
  // итогового отчёта нет (ревизия 6: 10 % выпуска).
  assert.equal(f.progress.percent, 95, 'всё принято ранее, но доработка открыта');
  assert.equal(f.time.finishedAt, undefined);
  assert.notEqual(f.time.estimate, 'nothing');
  assert.doesNotMatch(f.time.line, /осталось: ничего/);
  // Лента: доработка открыта новой редакцией.
  const activity = viewOf(env).activity ?? [];
  const item = activity.find((a) => a.action === 'work.reopened');
  assert.ok(item, JSON.stringify(activity.map((a) => a.action)));
  assert.equal(item.workId, 'w');
  assert.match(item.plain, /доработка 1, свой предел попыток/);
  assert.match(
    viewOf(env, 'en').activity!.find((a) => a.action === 'work.reopened')!.plain,
    /rework 1, its own attempt budget/,
  );
  // Доработка принята: код принят — ниже 100 %, пока ведущий не написал
  // итоговый отчёт (ревизия 6: шаг отчёта — половина доли ведущего); после
  // `release done` — 100 %.
  const run = env.engine.claim('c1')!;
  accept(env.engine, run.id, run.token, sha('c'), sha('d'));
  const accepted = viewOf(env).forecast!;
  assert.equal(accepted.progress.percent, 95);
  assert.equal(accepted.progress.release?.state, 'code-accepted');
  env.clock.now += 1000;
  releaseDone(env.engine, { summary: 'Доработка принята, выпуск готов.' });
  const done = viewOf(env).forecast!;
  assert.equal(done.progress.percent, 100);
  assert.equal(done.progress.release?.state, 'done');
  assert.equal(done.progress.rework, undefined);
  assert.equal(done.time.estimate, 'nothing');
  assert.ok(done.time.finishedAt);
});

test('P3-1: попыток на принятую задачу — по редакции, которая принята', () => {
  const env = pilot();
  // Доработка принята с первой попытки: у w 4 записи, у редакции — 1.
  const run = env.engine.claim('c1')!;
  accept(env.engine, run.id, run.token, sha('c'), sha('d'));
  env.clock.now += 60_000;
  const f = viewOf(env).forecast!;
  const range = f.time.remaining ?? f.time.rough;
  assert.ok(range, JSON.stringify(f.time));
  assert.equal(range.attemptsPerTask, 1, 'попытки прежней редакции не входят');
});
