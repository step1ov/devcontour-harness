/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тесты правят сырой JSON политики до разбора схемой.
 */
/**
 * 0.1.0-alpha.69 (пилот 6: P6-21, P6-29, P6-30): раунды ревью плана тратит
 * только настоящее изменение плана — другой набор поручений или их значимое
 * содержание против прежнего одобренного раунда. Доработка принятой работы,
 * указания ведущего (ревизия источника, заметка в контексте), контекст и
 * политика предел не тратят. В облегчённом режиме счёта раундов нет:
 * предел — время и стоимость выпуска, исчерпание решает владелец.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_VERSION,
  HarnessError,
  digestOf,
  freeRoundsSinceApproved,
  planContentDigest,
  planOrderDigest,
  planOrderDigests,
  planStatementDigests,
  sha256,
  sourceDigest,
  workGraphDigest,
  type ContextSnapshot,
  type ErrorCode,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type RuntimeName,
  type WorkGraph,
  LIGHT_REVIEW_LOOP_ROUNDS,
} from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { Harness } from '../src/control/harness.ts';
import { lightBudgetWarning } from '../src/control/doctor.ts';
import { planRoundEpoch, reviewRoundCap, technicalReview } from '../src/control/review.ts';
import { reviewSummaries } from '../src/control/review-summary.ts';
import { budgetLimitsOf } from '../src/engine/engine.ts';
import { engineOf, graphOf, policyOf, sha, trustNone } from './engine-fixture.ts';

const refused = (code: ErrorCode, message?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  if (message) assert.match(e.message, message);
  return true;
};

/** Reviewer одобряет каждый раунд; `usd` — сообщённая стоимость вызова. */
function reviewers(usd = 0) {
  let calls = 0;
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: () => {
      calls += 1;
      return Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'controlled',
        output: { approved: true, summary: 'ok', findings: [], previous: [] },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: usd,
          complete: true,
          source: 'claude-result',
        },
        diagnostics: { exitCode: 0 },
      });
    },
  });
  return { calls: () => calls, adapters: { codex: adapter('codex'), claude: adapter('claude') } };
}

const source = (id: string, text: string, kind = 'files') => {
  const entry = {
    id,
    kind,
    version: '1',
    required: false,
    files: [
      {
        path: `${id}.md`,
        digest: sha256(text),
        bytes: Buffer.byteLength(text),
        content: { encoding: 'utf8' as const, data: text },
      },
    ],
    references: [],
  };
  return { ...entry, digest: sourceDigest(entry) };
};
const snap = (...sources: ReturnType<typeof source>[]): ContextSnapshot => ({
  apiVersion: API_VERSION,
  sources,
  missing: [],
});

/** Новая редакция графа: ревизия набора и каждой постановки — `revision`. */
function revision(graph: WorkGraph, rev: string, patch: (g: WorkGraph) => void = () => {}) {
  const next = structuredClone(graph);
  next.source.revision = rev;
  for (const o of next.orders) o.source.revision = rev;
  patch(next);
  return next;
}

/** Раунд ревью плана так, как его ведёт `Harness.review`, над движком теста. */
function roundOf(
  engine: Engine,
  adapters: ReturnType<typeof reviewers>['adapters'],
  dir: string,
  graph: WorkGraph,
  context?: ContextSnapshot,
) {
  const cap = reviewRoundCap(engine.policy);
  const since = engine.read((v) => planRoundEpoch(v, graph.id));
  const n = engine.reviews('plan', graph.id).length + 1;
  return technicalReview(engine, engine.policy, adapters, {
    kind: 'plan',
    subject: graph.id,
    digest: workGraphDigest(graph),
    author: 'claude',
    instructions: ['review'],
    ...(context ? { context } : {}),
    cwd: dir,
    artifactDir: join(dir, 'reviews', String(n)),
    denied: [],
    meta: { subjectId: graph.id, subjectKind: 'group' },
    ...(cap === null ? {} : { maxRounds: cap }),
    planDigest: planContentDigest(graph),
    planOrders: planOrderDigests(graph),
    planStatements: planStatementDigests(graph),
    ...(since ? { roundEpoch: since } : {}),
  });
}

/** Принять выданную попытку: обе фазы с PASS gate и ревью. */
function accept(e: Engine, id: string, token: string) {
  const candidate = sha('a');
  const integration = sha('b');
  e.phase(id, token, 'verifying', { candidateSha: candidate });
  for (const [phase, at] of [
    ['candidate', candidate],
    ['integration', integration],
  ] as const) {
    if (phase === 'integration') e.phase(id, token, 'integrating', { integrationSha: integration });
    for (const [gate, kind, command] of [
      ['unit', 'test', ['npm', 'test']],
      ['independent-review', 'review', ['codex']],
    ] as const)
      e.evidence(id, token, {
        kind,
        phase,
        sha: at,
        gate,
        passed: true,
        command: [...command],
        exitCode: 0,
        log: '',
        digest: digestOf(gate + phase),
        summary: 'ok',
        ...(kind === 'review' ? { findings: [] } : {}),
      });
  }
  e.finish(id, token, integration);
}

/** Строгий движок (предел раундов 2) с принятой работой `w` графа `g` (w, x ← w). */
async function acceptedGraph() {
  const env = engineOf(policyOf((p: any) => (p.maxAttempts = 1)));
  const { engine, clock, dir } = env;
  clock.now = Date.now();
  const { calls, adapters } = reviewers();
  const graph = graphOf({ w: [], x: ['w'] });
  const first = await roundOf(engine, adapters, dir, graph);
  assert.equal(first.counted, true, 'первый раунд предмета засчитан');
  engine.register(graph, trustNone);
  engine.approve(graph.id, 'agent');
  engine.lead('c1');
  engine.resume();
  const run = engine.claim('c1')!;
  assert.equal(run.workId, 'w');
  accept(engine, run.id, run.token);
  assert.equal(
    engine.read((v) => v.work('w')!.status),
    'done',
  );
  return { ...env, calls, adapters, graph };
}

test('A69-1a: доработка принятой работы не тратит раунд и не тратит эпоху графа', async () => {
  const { engine, clock, dir, adapters, graph } = await acceptedGraph();
  // Доработка с той же постановкой (цель и критерии прежние) — бесплатна.
  const rework = revision(graph, '2', (g) => {
    g.orders[0]!.writeScope = ['src', 'lib'];
  });
  const r2 = await roundOf(engine, adapters, dir, rework);
  assert.equal(r2.counted, false, 'доработка принятой работы — без траты предела');
  assert.equal(r2.changes?.plan, false);
  assert.deepEqual(r2.changes?.orders, { changed: [], rework: ['w'] });
  // Регистрация переоткрывает `w`; вторая правка открытой доработки — тоже бесплатна.
  clock.now = Date.now();
  engine.register(rework, trustNone);
  assert.equal(
    engine.read((v) => v.work('w')!.rework?.fresh),
    true,
  );
  const again = revision(rework, '3', (g) => {
    g.orders[0]!.title = 'Доработка w: уточнённое название';
  });
  const r3 = await roundOf(engine, adapters, dir, again);
  assert.equal(r3.counted, false, 'правка открытой доработки — тоже доработка');
  // Эпоха доработки не израсходована: первый раунд после неё не засчитан.
  assert.equal(
    engine.read((v) => planRoundEpoch(v, graph.id)),
    undefined,
  );
  // Предел 2: засчитан только первый раунд, осталось 1.
  const [row] = engine.read((v) => reviewSummaries(v, engine.policy));
  assert.deepEqual(row!.rounds, { used: 1, max: 2, remaining: 1, free: 2 });
  // Настоящее изменение непринятой `x` — засчитано (2 из 2), следующее — отказ.
  const real = revision(again, '4', (g) => {
    g.orders[1]!.writeScope = ['src/x'];
  });
  const r4 = await roundOf(engine, adapters, dir, real);
  assert.equal(r4.counted, true);
  // Против прежнего одобренного раунда (r3) `w` уже та же — в списке только `x`.
  assert.deepEqual(r4.changes?.orders, { changed: ['x'], rework: [] });
  const more = revision(real, '5', (g) => {
    g.orders[1]!.dependsOn = [];
  });
  await assert.rejects(
    roundOf(engine, adapters, dir, more),
    refused('ATTEMPTS_EXHAUSTED', /2 из 2; новый раунд нужен: изменился план/),
  );
  // Доработка при исчерпанном пределе всё ещё проводится.
  const r5 = await roundOf(
    engine,
    adapters,
    dir,
    revision(real, '6', (g) => {
      g.orders[0]!.title = 'Доработка w ещё раз';
    }),
  );
  assert.equal(r5.counted, false);
});

test('A69-1b: указания ведущего и новая ревизия источника не тратят раунд', async () => {
  const env = engineOf(policyOf((p: any) => (p.maxAttempts = 1)));
  const { engine, dir } = env;
  const { adapters } = reviewers();
  const graph = graphOf({ a: [], b: ['a'] });
  const r1 = await roundOf(engine, adapters, dir, graph, snap(source('brief', 'B')));
  assert.equal(r1.counted, true);
  // Ведущий перерегистрирует снимок с указанием исполнителю: ревизии набора и
  // постановок новые, указание — в контексте; поручения те же.
  const r2 = await roundOf(
    engine,
    adapters,
    dir,
    revision(graph, '2'),
    snap(source('brief', 'B'), source('lead-note', 'Вторая причина: очистка теста', 'lead-note')),
  );
  assert.equal(r2.counted, false, 'указание ведущего — не изменение плана');
  assert.equal(r2.changes?.plan, false);
  assert.equal(r2.changes?.orders, undefined, 'поручения не менялись');
  assert.deepEqual(r2.changes?.context.added, ['lead-note']);
  // Дополнение к указанию (addendum) — снова новая ревизия, снова бесплатно.
  const r3 = await roundOf(
    engine,
    adapters,
    dir,
    revision(graph, '3'),
    snap(source('brief', 'B'), source('lead-note', 'Вторая причина + заметка', 'lead-note')),
  );
  assert.equal(r3.counted, false);
  // Требование с новым digest документа-источника, но тем же текстом, — контекст.
  const req = (digest: string) => ({
    id: 'REQ-a',
    source: 'docs/a.md',
    digest,
    text: 'Требование к работе a',
    gate: 'unit',
    scenario: 'Сценарий требования',
  });
  const withReq = revision(graph, '4', (g) => {
    g.orders[0]!.requirements = [req(sha256('v1'))];
  });
  assert.equal(
    planOrderDigest(withReq.orders[0]!),
    planOrderDigest(
      revision(withReq, '5', (g) => (g.orders[0]!.requirements = [req(sha256('v2'))])).orders[0]!,
    ),
    'digest документа требования в состав плана не входит',
  );
  assert.notEqual(planOrderDigest(withReq.orders[0]!), planOrderDigest(graph.orders[0]!));
  // Политика изменилась (не план) — тоже без траты.
  const policy = policyOf((p: any) => {
    p.maxAttempts = 1;
    p.runTimeoutMs = 1_234_000;
  });
  const r4 = await technicalReview(engine, policy, adapters, {
    kind: 'plan',
    subject: graph.id,
    digest: workGraphDigest(graph),
    author: 'claude',
    instructions: ['review'],
    context: snap(source('brief', 'B')),
    cwd: dir,
    artifactDir: join(dir, 'reviews', 'policy'),
    denied: [],
    meta: { subjectId: graph.id, subjectKind: 'group' },
    maxRounds: 2,
    planDigest: planContentDigest(graph),
    planOrders: planOrderDigests(graph),
  });
  assert.equal(r4.changes?.policy, true);
  assert.equal(r4.counted, false, 'изменение политики — не изменение плана');
});

test('A69-1c: тот же план после отклонённого раунда не оплачивается второй раз; круг ограничен', () => {
  const rounds = [
    { round: 1, approved: true, counted: true },
    { round: 2, approved: false, counted: true },
    { round: 3, approved: false, counted: false },
    { round: 4, approved: false, counted: false },
  ];
  assert.equal(freeRoundsSinceApproved(rounds), 2);
  assert.equal(
    freeRoundsSinceApproved([...rounds, { round: 5, approved: true, counted: false }]),
    0,
  );
  assert.equal(freeRoundsSinceApproved([{ round: 1, approved: false, counted: false }]), 1);
});

test('A69-1c: бесплатных раундов без одобрения подряд — не больше предела, дальше засчитаны', async () => {
  const env = engineOf(policyOf((p: any) => (p.maxAttempts = 1)));
  const { engine, dir } = env;
  let approve = true;
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: () =>
      Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'controlled',
        output: { approved: approve, summary: 'x', findings: [], previous: [] },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 0,
          complete: true,
          source: 'claude-result',
        },
        diagnostics: { exitCode: 0 },
      }),
  });
  const adapters = { codex: adapter('codex'), claude: adapter('claude') };
  const graph = graphOf({ a: [] });
  assert.equal((await roundOf(engine, adapters, dir, graph)).counted, true);
  approve = false;
  // Тот же план, только контекст: 2 бесплатных отклонённых раунда (предел 2).
  for (const i of [1, 2]) {
    const r = await roundOf(engine, adapters, dir, graph, snap(source('doc', 'v' + i)));
    assert.equal(r.counted, false, `раунд ${i + 1} бесплатен`);
  }
  // Третий подряд без одобрения — засчитан (2 из 2).
  const third = await roundOf(engine, adapters, dir, graph, snap(source('doc', 'v3')));
  assert.equal(third.counted, true, 'круг без одобрения тратит предел');
  await assert.rejects(
    roundOf(engine, adapters, dir, graph, snap(source('doc', 'v4'))),
    refused('ATTEMPTS_EXHAUSTED'),
  );
});

test('A69-1d: настоящее изменение плана в строгом режиме засчитано — каждое поле постановки', () => {
  const graph = graphOf({ a: [], b: ['a'] });
  const base = planOrderDigests(graph);
  const changes: [string, (g: WorkGraph) => void][] = [
    ['текст', (g) => (g.orders[0]!.goal = 'Другая цель работы a, совсем другая.')],
    ['критерии', (g) => (g.orders[0]!.acceptance = ['Другой критерий'])],
    ['зависимости', (g) => (g.orders[1]!.dependsOn = [])],
    ['область записи', (g) => (g.orders[0]!.writeScope = ['lib'])],
    ['вид', (g) => (g.orders[0]!.kind = 'infra')],
    ['репозиторий', (g) => (g.orders[0]!.repositoryId = 'other')],
    ['обязательный контекст', (g) => (g.orders[0]!.context = ['brief'])],
    ['новое поручение', (g) => g.orders.push({ ...g.orders[0]!, id: 'c' })],
    ['убранное поручение', (g) => g.orders.pop()],
  ];
  for (const [what, patch] of changes) {
    const next = structuredClone(graph);
    patch(next);
    assert.notDeepEqual(planOrderDigests(next), base, what);
  }
  // Ревизия источника и коннектор постановки — не план.
  assert.deepEqual(planOrderDigests(revision(graph, '9')), base);
});

function lightHarness(patch: (p: any) => void = () => {}, usd = 0) {
  const { calls, adapters } = reviewers(usd);
  const policy: ExecutionPolicy = policyOf((p: any) => {
    p.harnessMode = 'light';
    p.maxAttempts = 1;
    patch(p);
  });
  const h = Harness.open({
    policy,
    stateDir: mkdtempSync(join(tmpdir(), 'harness-plan-rounds-a69-')),
    baseDir: process.cwd(),
    adapters,
  });
  return { h, calls };
}

test('A69-2: облегчённый режим не отказывает по раундам и показывает «без предела»', async () => {
  const { h, calls } = lightHarness();
  assert.equal(reviewRoundCap(h.policy), null);
  assert.equal(budgetLimitsOf(h.policy).reviewRounds, null);
  let graph = graphOf({ a: [] });
  // Предел строгого режима был бы 2: пять изменений плана подряд — все проводятся.
  for (const i of [1, 2, 3, 4, 5]) {
    graph = revision(graph, String(i), (g) => (g.orders[0]!.title = `План, версия ${i}`));
    const r = await h.review({ kind: 'plan', graph, author: 'claude' });
    assert.equal(r.round, i);
    assert.equal(r.counted, true, 'изменение плана отмечено, но предела нет');
  }
  assert.equal(calls(), 5);
  const [row] = h.engine.read((v) => reviewSummaries(v, h.policy));
  assert.equal(row!.rounds.max, null);
  assert.equal(row!.rounds.remaining, null);
  assert.match(
    row!.line,
    /раундов 5, без предела \(облегчённый режим; бюджет — время\/стоимость выпуска\)/,
  );
  // Doctor называет отсутствие бюджета выпуска одной строкой.
  assert.match(lightBudgetWarning(h.policy) ?? '', /^light-no-budget: .*budgets\.group/);
  h.close();
});

test('A69-2: облегчённый режим — исчерпанный бюджет выпуска останавливает ревью (BUDGET_EXHAUSTED)', async () => {
  const { h } = lightHarness((p) => (p.budgets = { group: { usd: 1.5 } }), 1);
  assert.equal(lightBudgetWarning(h.policy), undefined, 'бюджет задан — строки doctor нет');
  let graph = graphOf({ a: [] });
  const next = (i: number) =>
    (graph = revision(graph, String(i), (g) => (g.orders[0]!.title = `План, версия ${i}`)));
  await h.review({ kind: 'plan', graph: next(1), author: 'claude' });
  await h.review({ kind: 'plan', graph: next(2), author: 'claude' });
  await assert.rejects(
    h.review({ kind: 'plan', graph: next(3), author: 'claude' }),
    refused('BUDGET_EXHAUSTED'),
  );
  h.close();
});

test('A69-2: строгий режим без бюджета — строки doctor нет; предел раундов прежний', () => {
  const strict = policyOf();
  assert.equal(lightBudgetWarning(strict), undefined);
  assert.equal(reviewRoundCap(strict), strict.maxAttempts * 2);
  assert.equal(budgetLimitsOf(strict).reviewRounds, strict.maxAttempts * 2);
});

test('A69-2: облегчённый режим — круг без одобрения: 6 раундов неизменённого плана — ход ведущего, 12 неодобренных — владелец', async () => {
  const env = engineOf(policyOf((p: any) => (p.harnessMode = 'light')));
  const { engine, dir } = env;
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: () =>
      Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'controlled',
        output: { approved: false, summary: 'x', findings: [], previous: [] },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 0,
          complete: true,
          source: 'claude-result',
        },
        diagnostics: { exitCode: 0 },
      }),
  });
  const adapters = { codex: adapter('codex'), claude: adapter('claude') };
  let graph = graphOf({ a: [] });
  await roundOf(engine, adapters, dir, graph);
  // Тот же план — бесплатные раунды до LIGHT_REVIEW_LOOP_ROUNDS, потом ход ведущего.
  for (let i = 1; i <= LIGHT_REVIEW_LOOP_ROUNDS; i++)
    await roundOf(engine, adapters, dir, graph, snap(source('doc', 'v' + i)));
  await assert.rejects(
    roundOf(engine, adapters, dir, graph, snap(source('doc', 'again'))),
    refused('NOT_READY', /Круг ревью.*ход ведущего/),
  );
  // Ход ведущего — изменить план: серия обнуляется, и следующий раунд того
  // же (изменённого) плана снова идёт (решение владельца 2026-11-24).
  graph = revision(graph, 'r1', (g) => (g.orders[0]!.title = 'План после находок'));
  await roundOf(engine, adapters, dir, graph);
  await roundOf(engine, adapters, dir, graph, snap(source('doc', 'after-change')));
  // Раунды идут, пока неодобренных подряд не вдвое больше (12 — владелец).
  let n = 0;
  for (;;) {
    graph = revision(graph, String(++n), (g) => (g.orders[0]!.title = `План ${n}`));
    try {
      await roundOf(engine, adapters, dir, graph);
    } catch (e) {
      refused('ATTEMPTS_EXHAUSTED', /решение владельца/)(e);
      break;
    }
    assert.ok(n < 20, 'круг ограничен');
  }
});

test('A69-1a: новые цель или критерии принятой работы — настоящее изменение плана', async () => {
  const { engine, dir, adapters, graph } = await acceptedGraph();
  const goal = await roundOf(
    engine,
    adapters,
    dir,
    revision(graph, '2', (g) => {
      g.orders[0]!.goal = 'Исправить ошибку, найденную после приёмки работы w.';
    }),
  );
  assert.equal(goal.counted, true, 'новая цель принятой работы — раунд засчитан');
  assert.deepEqual(goal.changes?.orders?.changed, ['w']);
});
