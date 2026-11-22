import './temp-scope.ts';
/**
 * 0.1.0-alpha.66, сведение трёх ветвей (представление, доставка,
 * восстановление ведущим):
 * - следующий шаг (`nextAction`) и корни цепочки (`chainRoots`) по
 *   исчерпанию идут правилом «Кто принимает решения»: ход ведущего (разбор,
 *   сброс), пока бюджет его сбросов не потрачен; человек — после него, при
 *   не технической причине и при правиле `user`;
 * - путь работы (`track`) знает отказ от доработки и доработку, отменённую
 *   alpha.65: последний шаг — принятая редакция, без планового хвоста, как
 *   и статус работы и прогноз в том же представлении;
 * - `harness diagnose` и `retry --reset --by lead` через CLI над настоящим
 *   каталогом состояния: ответы, журнал ведущего, путь работы и handoff.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cliDataSchemas,
  digestOf,
  handoffPackSchema,
  operatorViewSchema,
  type WorkGraph,
} from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { collectOperatorViewInput } from '../src/control/operator-view.ts';
import {
  chainRoots,
  leadRecoveryStep,
  nextAction,
  operatorView,
  type ChainWork,
  type LeadRecoveryStep,
} from '../src/projections/index.ts';
import { recoveryPolicyOf } from '../src/projections/decisions.ts';
import {
  engineOf,
  graphOf,
  planReview,
  policyOf,
  ready,
  sha,
  trustNone,
} from './engine-fixture.ts';

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
    stdout: r.stdout,
    json: JSON.parse(r.stdout) as { ok: boolean; data?: never; error?: { code: string } },
  };
};

/* ------------------------------------------------------------------ */
/* Следующий шаг и корни цепочки                                       */
/* ------------------------------------------------------------------ */

const lead = (step: 'diagnose' | 'reset' | 'replan'): LeadRecoveryStep => ({
  exhausted: { actor: 'lead', step },
});
const user: LeadRecoveryStep = { exhausted: { actor: 'user' } };

test('next: исчерпание по правилу lead — разбор или сброс ведущего; человек — после бюджета сбросов и при правиле user', () => {
  const next = (leadRecovery?: LeadRecoveryStep, attempt = 3) =>
    (({ actor, action, step }) => [actor, action, step])(
      nextAction({
        status: 'failed',
        attempt,
        maxAttempts: 3,
        failureKind: 'gate',
        ...(leadRecovery ? { leadRecovery } : {}),
      }),
    );
  assert.deepEqual(next(lead('diagnose')), ['lead', 'diagnose', 'attempts-exhausted']);
  assert.deepEqual(next(lead('reset')), ['lead', 'reset-attempts', 'attempts-exhausted']);
  assert.deepEqual(next(lead('replan')), ['lead', 'review-plan', 'attempts-exhausted']);
  // Бюджет сбросов ведущего потрачен, причина не техническая — человек.
  assert.deepEqual(next(user), ['user', 'reset-attempts', 'attempts-exhausted']);
  // Правило user (поля нет) — прежний шаг.
  assert.deepEqual(next(undefined), ['user', 'reset-attempts', 'attempts-exhausted']);
  // До исчерпания: удержание разбором — ведущему, иначе повтор движка.
  assert.deepEqual(next({ hold: 'diagnosis-required', ...user }, 2), ['lead', 'diagnose', 'held']);
  assert.deepEqual(next({ hold: 'contradiction', ...user }, 2), ['user', 'user-decision', 'held']);
  assert.deepEqual(next(user, 1), ['controller', 'retry', 'retry-within-budget']);
});

test('chain: корень с исчерпанными попытками — ход ведущего по правилу lead, человек — по бюджету и правилу user', () => {
  const works = (root: Partial<ChainWork>): ChainWork[] => [
    { id: 'a', status: 'failed', dependsOn: [], attempt: 3, failureKind: 'gate', ...root },
    { id: 'b', status: 'ready', dependsOn: ['a'], attempt: 0 },
  ];
  const of = (root: Partial<ChainWork>) =>
    chainRoots(works(root), 3).map((r) => [r.code, r.actor, r.action]);
  assert.deepEqual(of({ leadRecovery: lead('diagnose') }), [
    ['failed-exhausted', 'lead', 'diagnose'],
  ]);
  assert.deepEqual(of({ leadRecovery: lead('reset') }), [
    ['failed-exhausted', 'lead', 'reset-attempts'],
  ]);
  assert.deepEqual(of({ leadRecovery: user }), [['failed-exhausted', 'user', 'reset-attempts']]);
  assert.deepEqual(of({}), [['failed-exhausted', 'user', 'reset-attempts']]);
  // Удержание разбором до исчерпания: не повтор движка, а разбор ведущего.
  assert.deepEqual(of({ attempt: 2, leadRecovery: { hold: 'diagnosis-required', ...user } }), [
    ['failed', 'lead', 'diagnose'],
  ]);
  assert.deepEqual(of({ attempt: 1 }), [['failed', 'controller', 'retry']]);
  // Готовая работа на потолке попыток (сброс ещё не дан) — тот же ход.
  assert.deepEqual(of({ status: 'ready', leadRecovery: lead('reset') }), [
    ['attempts-exhausted', 'lead', 'reset-attempts'],
  ]);
});

/* ------------------------------------------------------------------ */
/* Путь работы и доработка                                             */
/* ------------------------------------------------------------------ */

/** Провести попытку через обе фазы с PASS gate и ревью и принять её. */
function accept(e: Engine, id: string, token: string, candidate: string, integration: string) {
  e.phase(id, token, 'verifying', { candidateSha: candidate });
  for (const [phase, at] of [
    ['candidate', candidate],
    ['integration', integration],
  ] as const) {
    if (phase === 'integration') e.phase(id, token, 'integrating', { integrationSha: integration });
    for (const kind of ['test', 'review'] as const)
      e.evidence(id, token, {
        kind,
        phase,
        sha: at,
        gate: kind === 'test' ? 'unit' : 'independent-review',
        passed: true,
        command: ['x'],
        exitCode: 0,
        log: '',
        digest: digestOf(kind + phase),
        summary: 'ok',
        ...(kind === 'review' ? { findings: [] } : {}),
      });
  }
  e.finish(id, token, integration);
}

function replan(e: Engine, graph: WorkGraph) {
  const { graph: state } = e.register(graph, trustNone);
  e.recordReview(planReview(e, state, e.reviews('plan', state.id).length + 1));
  e.approve(state.id, 'agent');
}

function revised(revision: string) {
  const g = graphOf({ w: [] }, revision);
  g.orders = g.orders.map((o) => ({ ...o, goal: `${o.goal} Доработка ${revision}.` }));
  return g;
}

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

/** Принятая работа `w` с открытой доработкой и одной упавшей попыткой доработки. */
function reworked() {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  env.clock.now += 30_000;
  env.engine.lead('c1');
  const first = env.engine.claim('c1')!;
  env.clock.now += 20_000;
  accept(env.engine, first.id, first.token, sha('a'), sha('b'));
  replan(env.engine, revised('2'));
  env.clock.now += 30_000;
  env.engine.lead('c1');
  const second = env.engine.claim('c1')!;
  assert.equal(second.workId, 'w');
  env.engine.fail(second.id, second.token, 'проверка не прошла', { kind: 'gate' });
  return env;
}

test('track: отказ от доработки — последний шаг «принятая редакция», без планового хвоста; статус и прогноз согласны', () => {
  const env = reworked();
  // Открытая доработка: путь идёт дальше плановыми попытками доработки.
  const open = viewOf(env).works[0]!;
  assert.equal(open.status, 'failed');
  assert.ok(open.track!.steps.some((s) => s.state === 'planned' && s.rework === 1));
  env.engine.cancel('w', 'доработка не нужна', 'operator');
  const view = viewOf(env);
  const w = view.works[0]!;
  assert.equal(w.status, 'done');
  const steps = w.track!.steps;
  assert.deepEqual(
    (({ kind, state, label, rework }) => ({ kind, state, label, rework }))(steps.at(-1)!),
    {
      kind: 'accepted',
      state: 'passed',
      label: 'доработка оставлена — принятая редакция',
      rework: 1,
    },
  );
  assert.ok(!steps.some((s) => s.state === 'planned' || s.state === 'waiting'), 'хвоста нет');
  assert.equal(steps.find((s) => s.kind === 'accepted')!.label, 'принято');
  assert.equal(view.forecast!.progress.done, 1);
  assert.equal(view.forecast!.progress.rework, undefined);
  assert.equal(view.forecast!.progress.release?.state, 'code-accepted');
  assert.ok(view.forecast!.progress.lead, 'доля ведущего есть');
  assert.equal(
    viewOf(env, 'en').works[0]!.track!.steps.at(-1)!.label,
    'rework abandoned — the accepted revision',
  );
});

test('track: доработка, отменённая alpha.65 вместе с работой, — путь принятой работы, как и restoredFrom', () => {
  const env = reworked();
  env.store.transact('task.cancelled', (tx) => {
    const w = tx.work('w')!;
    const rework = { ...w.rework! };
    delete rework.acceptedOrder;
    tx.putWork({ ...w, status: 'cancelled', failureKind: 'cancelled', rework });
  });
  const w = viewOf(env).works[0]!;
  assert.deepEqual([w.status, w.restoredFrom], ['done', 'cancelled-rework']);
  const steps = w.track!.steps;
  assert.equal(steps.at(-1)!.label, 'доработка оставлена — принятая редакция');
  assert.ok(
    // Пропущенные шаги упавшей попытки доработки — история; планового хвоста
    // и «принято (пропущено)» отменённой работы нет.
    !steps.some(
      (s) =>
        s.state === 'planned' ||
        s.state === 'waiting' ||
        (s.state === 'skipped' && s.attempt === undefined) ||
        (s.kind === 'accepted' && s.state !== 'passed'),
    ),
    JSON.stringify(steps),
  );
});

/* ------------------------------------------------------------------ */
/* diagnose и сброс ведущего через CLI                                 */
/* ------------------------------------------------------------------ */

test('cli: diagnose и retry --reset --by lead над каталогом состояния — ответы, журнал ведущего, путь и handoff', () => {
  const policy = policyOf((p) => {
    p.maxAttempts = 2;
    p.recovery = { mode: 'lead', diagnoseAfter: 2, leadResets: 1 };
  });
  const env = engineOf(policy);
  ready(env.engine, graphOf({ a: [], b: ['a'] }));
  for (let k = 0; k < 2; k++) {
    if (k) env.engine.retry('a', undefined, 'recovery');
    const run = env.engine.claim('c1')!;
    assert.equal(run.workId, 'a');
    env.engine.fail(run.id, run.token, `проверка не прошла ${k}`, { kind: 'gate' });
  }
  // Исчерпано, разбора нет: ход ведущего — разбор (а не сброс человеком).
  const before = env.engine.read((v) =>
    leadRecoveryStep(v.work('a')!, v.attempts('a'), recoveryPolicyOf(policy), 2),
  );
  assert.deepEqual(before, { exhausted: { actor: 'lead', step: 'diagnose' } });
  writeFileSync(join(env.dir, 'binding.json'), JSON.stringify({ policy, baseDir: env.dir }));
  env.store.close();

  const pack = () => {
    const r = harness('handoff', '--state', env.dir);
    assert.equal(r.status, 0, r.stderr);
    return handoffPackSchema.parse(r.json.data).works.find((w) => w.id === 'a')!.next;
  };
  assert.deepEqual((({ actor, action, step }) => [actor, action, step])(pack()), [
    'lead',
    'diagnose',
    'attempts-exhausted',
  ]);

  const diagnose = harness(
    'diagnose',
    '--state',
    env.dir,
    '--work',
    'a',
    '--cause',
    'approach',
    '--hypothesis',
    'Разбор строки идёт не с того конца: читать справа налево',
  );
  assert.equal(diagnose.status, 0, diagnose.stderr + diagnose.stdout);
  const d = cliDataSchemas.diagnose.parse(diagnose.json.data);
  assert.deepEqual(
    [d.workId, d.diagnosis.cause, d.next, d.mode],
    ['a', 'approach', 'lead-reset', 'lead'],
  );
  assert.deepEqual((({ actor, action }) => [actor, action])(pack()), ['lead', 'reset-attempts']);

  const reset = harness(
    'retry',
    '--state',
    env.dir,
    '--work',
    'a',
    '--reset',
    '--by',
    'lead',
    '--diagnosis',
    d.diagnosis.id,
  );
  assert.equal(reset.status, 0, reset.stderr + reset.stdout);
  const r = cliDataSchemas.retry.parse(reset.json.data);
  assert.equal(r.attempt, 0);
  assert.deepEqual(
    r.reset &&
      (({ performed, by, diagnosis, index, cap }) => ({ performed, by, diagnosis, index, cap }))(
        r.reset,
      ),
    { performed: true, by: 'lead', diagnosis: d.diagnosis.id, index: 1, cap: 1 },
  );
  // Тот же разбор второй раз предел не даёт: отказ или сброс не выполнен.
  const again = harness(
    'retry',
    '--state',
    env.dir,
    '--work',
    'a',
    '--reset',
    '--by',
    'lead',
    '--diagnosis',
    d.diagnosis.id,
  );
  assert.ok(
    again.status !== 0 || cliDataSchemas.retry.parse(again.json.data).reset?.performed === false,
    again.stdout,
  );

  const out = harness('view', '--state', env.dir);
  assert.equal(out.status, 0, out.stderr);
  const view = operatorViewSchema.parse(
    (out.json.data as unknown as { view?: unknown }).view ?? out.json.data,
  );
  // Журнал ведущего: разбор и сброс ведущего — его записи с работой.
  const notes = view
    .lead!.notes.filter((n) => n.workId === 'a')
    .map((n) => [n.action, n.plain] as const);
  assert.ok(
    notes.some(
      ([action, plain]) =>
        action === 'lead.diagnose' &&
        plain.includes(`${d.diagnosis.id}, причина approach`) &&
        plain.includes('ведущий может дать новый предел попыток'),
    ),
    JSON.stringify(notes),
  );
  assert.ok(
    notes.some(
      ([action, plain]) =>
        action === 'lead.retry' &&
        plain.includes(`по разбору ${d.diagnosis.id} (сброс 1 из 1)`) &&
        plain.includes('ещё 2 попытки'),
    ),
    JSON.stringify(notes),
  );
  // Путь работы: разбор и сброс ведущего между попытками, дальше — плановые попытки.
  const track = view.works.find((w) => w.id === 'a')!.track!.steps;
  const kinds = track.filter((s) => s.state === 'decision').map((s) => s.kind);
  assert.deepEqual(kinds, ['diagnosis', 'reset']);
  assert.ok(track.some((s) => s.state === 'planned' && s.kind === 'code'));
});

/* ------------------------------------------------------------------ */
/* Порядок опускания по размеру                                        */
/* ------------------------------------------------------------------ */

test('size: путь работы опускается первым — раньше разделов связки, полей работ и ленты', async () => {
  const { baseInput, work } = await import('./operator-view-input.ts');
  const { OPERATOR_VIEW_LIMITS } = await import('../src/contracts/index.ts');
  const step = (k: number) => ({
    kind: 'code' as const,
    attempt: k,
    state: 'failed' as const,
    label: 'код',
    reason: 'проверки не прошли — подробная причина отказа простыми словами',
  });
  const steps = Array.from({ length: 120 }, (_, k) => step(k + 1));
  const input = baseInput({
    works: Array.from({ length: 30 }, (_, k) =>
      work(`w${k}`, { track: { ru: { steps, truncated: 0 }, en: { steps, truncated: 0 } } }),
    ),
    activity: Array.from({ length: 20 }, (_, k) => ({
      kind: 'lead' as const,
      at: new Date(Date.parse('2026-11-19T11:00:00.000Z') + k * 1000).toISOString(),
      action: 'lead.note',
      plain: `запись ведущего ${k}`,
    })),
  });
  const whole = operatorView(input, { maxBytes: 64 * 1024 * 1024 });
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  assert.ok(whole.works.every((w) => w.track?.steps.length === 120));
  assert.ok(size(whole) > OPERATOR_VIEW_LIMITS.bytes, String(size(whole)));
  const view = operatorViewSchema.parse(operatorView(input));
  assert.ok(
    view.works.every((w) => w.track === undefined),
    'пути работ опущены',
  );
  assert.equal(view.works.length, 30, 'работы остаются');
  assert.equal(view.truncated?.workFields, 30);
  assert.equal(view.truncated?.activity, undefined, 'лента остаётся: пути хватило');
  assert.equal(view.activity?.length, whole.activity?.length);
  const codes = view.health.warnings.map((w) => w.code);
  assert.ok(codes.includes('VIEW_SIZE_REDUCED'), codes.join());
});
