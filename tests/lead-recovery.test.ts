/**
 * Восстановление ведущим после повторных отказов (`policy.recovery`,
 * docs/principles.md «Кто принимает решения»): после `diagnoseAfter`
 * засчитанных отказов следующей попытки нет без разбора ведущего; при
 * исчерпанных попытках ведущий сам даёт новый предел по свежему
 * техническому разбору в пределе `leadResets`; иначе — человек.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError, recoveryPolicyOf, type ExecutionPolicy } from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { workTrack } from '../src/projections/track.ts';
import { decisionSettings, decisionSummary } from '../src/projections/decisions.ts';
import { engineOf, graphOf, planReview, policyOf, ready, trustNone } from './engine-fixture.ts';

type Recovery = { mode: 'lead' | 'user'; diagnoseAfter?: number; leadResets?: number };

function setup(recovery?: Recovery, patch: (p: Record<string, unknown>) => void = () => {}) {
  const policy = policyOf((p) => {
    p.maxAttempts = 3;
    if (recovery) p.recovery = recovery;
    patch(p);
  });
  const ctx = engineOf(policy);
  ready(ctx.engine, graphOf({ a: [] }));
  return { ...ctx, policy };
}

/** Выдать попытку работы `a` и записать отказ класса `kind`. */
function failOnce(
  e: Engine,
  kind: 'gate' | 'review' | 'environment' = 'gate',
  interrupted = false,
) {
  const a = e.claim('c1');
  assert.ok(a, 'попытка выдана');
  e.fail(a.id, a.token, 'проверка не прошла: ' + a.attempt, {
    kind,
    ...(interrupted ? { interrupted: true } : {}),
  });
  if (kind === 'environment') e.resume();
  return a;
}

const work = (e: Engine) => e.read((v) => v.work('a')!);

function explain(ctx: { engine: Engine; policy: ExecutionPolicy }) {
  const d = stopInputsOf(
    {
      engine: ctx.engine,
      policy: ctx.policy,
      workflows: { list: () => [], continues: () => false },
    },
    { maxAttempts: ctx.policy.maxAttempts, repairBudget: ctx.policy.repairBudget, workId: 'a' },
  )
    .filter((i) => i.kind === 'work')
    .map(explainStop)[0]!;
  return { code: d.code, actor: d.actor, action: d.action, message: d.message };
}

const refused = (fn: () => unknown, code: string, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HarnessError, String(e));
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });

/** Повтор упавшей работы движком (как repair) и выдача следующей попытки. */
const retryAuto = (e: Engine) => e.retry('a', undefined, 'recovery');

test('recovery: после двух засчитанных отказов третьей попытки нет без разбора; explain — ведущий, diagnose', () => {
  const ctx = setup({ mode: 'lead' });
  const e = ctx.engine;
  failOnce(e);
  retryAuto(e);
  failOnce(e);
  refused(() => retryAuto(e), 'DIAGNOSIS_REQUIRED', /harness diagnose/);
  refused(() => e.retry('a', undefined, 'operator'), 'DIAGNOSIS_REQUIRED');
  assert.ok(e.read((v) => e.blockers(work(e), v)).some((b) => b.code === 'DIAGNOSIS_REQUIRED'));
  assert.deepEqual((({ code, actor, action }) => ({ code, actor, action }))(explain(ctx)), {
    code: 'DIAGNOSIS_REQUIRED',
    actor: 'lead',
    action: 'diagnose',
  });
  const d = e.diagnose('a', {
    cause: 'approach',
    hypothesis: 'Считать сумму по таблице, а не жадно',
    evidence: ['лог gate'],
  });
  assert.equal(d.diagnosis.id, 'D1');
  assert.equal(d.diagnosis.failures.length, 2);
  assert.equal(d.next, 'attempt');
  retryAuto(e);
  const third = e.claim('c1');
  assert.equal(third?.attempt, 3, 'после разбора выдана третья попытка');
  const events = ctx.store.events(0, 1000).filter((x) => x.type === 'work.diagnosed');
  assert.equal(events.length, 1);
  assert.deepEqual((events[0]!.payload as { cause: string }).cause, 'approach');
});

test('recovery: повтор той же гипотезы (регистр, пробелы, точка) — отказ; разбор без засчитанных отказов — отказ', () => {
  const ctx = setup({ mode: 'lead' });
  const e = ctx.engine;
  refused(() => e.diagnose('a', { cause: 'other' }), 'NOT_READY', /без разбора нет/);
  failOnce(e);
  retryAuto(e);
  failOnce(e);
  refused(() => e.diagnose('a', { cause: 'coverage' }), 'INVALID_INPUT', /--hypothesis/);
  e.diagnose('a', { cause: 'coverage', hypothesis: 'Добавить случаи с пустым списком' });
  retryAuto(e);
  failOnce(e);
  refused(
    () =>
      e.diagnose('a', { cause: 'approach', hypothesis: '  добавить СЛУЧАИ с пустым   списком. ' }),
    'INVALID_INPUT',
    /повторяет разбор D1/,
  );
});

test('recovery: сброс ведущего в пределе leadResets; сверх предела, повтор разбора и не техническая причина — человек', () => {
  const ctx = setup({ mode: 'lead', leadResets: 2 });
  const e = ctx.engine;
  failOnce(e);
  retryAuto(e);
  failOnce(e);
  e.diagnose('a', { cause: 'approach', hypothesis: 'Первая гипотеза о подходе' });
  retryAuto(e);
  failOnce(e);
  // Исчерпано: свежего разбора третьего отказа нет — ход ведущего, разбор.
  assert.deepEqual((({ actor, action }) => ({ actor, action }))(explain(ctx)), {
    actor: 'lead',
    action: 'diagnose',
  });
  refused(() => e.retry('a', { reason: '' }, 'lead'), 'DIAGNOSIS_REQUIRED');
  const d2 = e.diagnose('a', { cause: 'approach', hypothesis: 'Вторая гипотеза: другой алгоритм' });
  assert.equal(d2.next, 'lead-reset');
  const x = explain(ctx);
  assert.deepEqual(
    { actor: x.actor, action: x.action },
    { actor: 'lead', action: 'reset-attempts' },
  );
  const reset = e.retry('a', { reason: '', diagnosis: 'D2' }, 'lead');
  assert.equal(reset.work.attempt, 0);
  assert.deepEqual(reset.reset, {
    performed: true,
    spent: 3,
    by: 'lead',
    diagnosis: 'D2',
    index: 1,
    cap: 2,
    granted: 3,
  });
  assert.match(
    explain(ctx).message,
    /ведущий дал ещё 3 попытки \(сброс 1 из 2\): причина — неверный подход — новая гипотеза; гипотеза — Вторая гипотеза/,
  );
  const retried = ctx.store
    .events(0, 1000)
    .filter((ev) => ev.type === 'work.retried')
    .at(-1)!;
  assert.deepEqual(retried.payload, {
    by: 'lead',
    reset: true,
    spent: 3,
    reasonLength: 0,
    diagnosis: 'D2',
    index: 1,
    cap: 2,
    granted: 3,
  });
  // Тот же разбор второй раз предел не даёт: после нового отказа он не свежий.
  failOnce(e);
  refused(() => e.retry('a', { reason: '', diagnosis: 'D2' }, 'lead'), 'DIAGNOSIS_REQUIRED');
  // Второй цикл: второй сброс ведущего (2 из 2).
  retryAuto(e);
  failOnce(e);
  e.diagnose('a', { cause: 'coverage', hypothesis: 'Третья гипотеза: случаи с нулём' });
  retryAuto(e);
  failOnce(e);
  e.diagnose('a', { cause: 'approach', hypothesis: 'Четвёртая гипотеза: переписать разбор' });
  const second = e.retry('a', { reason: '' }, 'lead').reset;
  assert.equal(second && 'index' in second ? second.index : undefined, 2);
  // Третий цикл: сбросы ведущего потрачены — решение человека.
  failOnce(e);
  retryAuto(e);
  failOnce(e);
  e.diagnose('a', { cause: 'approach', hypothesis: 'Пятая гипотеза: кэш' });
  retryAuto(e);
  failOnce(e);
  e.diagnose('a', { cause: 'approach', hypothesis: 'Шестая гипотеза: порядок' });
  const user = explain(ctx);
  assert.deepEqual(
    { actor: user.actor, action: user.action },
    { actor: 'user', action: 'reset-attempts' },
  );
  assert.match(user.message, /сбросы ведущего потрачены \(2\)/);
  refused(() => e.retry('a', { reason: '' }, 'lead'), 'ATTEMPTS_EXHAUSTED', /потрачены/);
  // Человек сбрасывает, как прежде; сброс записан его решением.
  assert.equal(e.retry('a', { reason: 'решение владельца' }, 'operator').work.attempt, 0);
  assert.deepEqual(
    work(e).leadRecovery?.resets.map((r) => [r.by, r.index ?? null]),
    [
      ['lead', 1],
      ['lead', 2],
      ['operator', null],
    ],
  );
});

test('recovery: не техническая причина при исчерпании (environment) — сброс решает человек', () => {
  const ctx = setup({ mode: 'lead', diagnoseAfter: 3 });
  const e = ctx.engine;
  for (let i = 0; i < 3; i++) {
    failOnce(e);
    if (i < 2) retryAuto(e);
  }
  e.diagnose('a', { cause: 'environment' });
  assert.deepEqual((({ actor, action }) => ({ actor, action }))(explain(ctx)), {
    actor: 'user',
    action: 'reset-attempts',
  });
  refused(() => e.retry('a', { reason: '' }, 'lead'), 'ATTEMPTS_EXHAUSTED', /не техническая/);
});

test('recovery: противоречивое обещание — решение человека; сброс оператора снимает удержание', () => {
  const ctx = setup({ mode: 'lead' });
  const e = ctx.engine;
  failOnce(e);
  retryAuto(e);
  failOnce(e);
  const d = e.diagnose('a', {
    cause: 'contradiction',
    hypothesis: 'Критерий 2 требует пустой ответ, критерий 3 — непустой',
  });
  assert.equal(d.next, 'user-decision');
  const x = explain(ctx);
  assert.deepEqual(
    { actor: x.actor, action: x.action },
    { actor: 'user', action: 'user-decision' },
  );
  assert.match(x.message, /противоречивое обещание/);
  refused(() => retryAuto(e), 'NOT_READY', /противоречивое/);
  refused(() => e.retry('a', { reason: '' }, 'lead'), 'NOT_READY');
  e.retry('a', { reason: 'владелец уточнил: пустой ответ' }, 'operator');
  assert.equal(work(e).leadRecovery?.diagnoses[0]?.resolved?.by, 'operator');
  assert.ok(e.claim('c1'), 'решение человека сняло удержание');
});

test('recovery: split — работа ждёт перепланирования; согласование новой постановки снимает удержание без новых попыток', () => {
  const ctx = setup({ mode: 'lead' });
  const e = ctx.engine;
  failOnce(e);
  retryAuto(e);
  failOnce(e);
  assert.equal(e.diagnose('a', { cause: 'split' }).next, 'replan');
  refused(() => retryAuto(e), 'NOT_READY', /задача велика/);
  const x = explain(ctx);
  assert.deepEqual({ actor: x.actor, action: x.action }, { actor: 'lead', action: 'review-plan' });
  // Новая редакция: постановка сужена.
  const g = graphOf({ a: [] }, '2');
  (g.orders[0] as { title: string }).title += ' — только первая часть';
  const { graph } = e.register(g, trustNone);
  e.recordReview(planReview(e, graph, e.reviews('plan', graph.id).length + 1));
  e.approve(graph.id, 'agent');
  assert.equal(work(e).attempt, 2, 'перепланирование попыток не добавляет');
  const next = e.claim('c1');
  assert.equal(next?.attempt, 3);
});

test('recovery: mode user — прежнее поведение: третья попытка без разбора, исчерпание — человек', () => {
  const ctx = setup({ mode: 'user' });
  const e = ctx.engine;
  failOnce(e);
  retryAuto(e);
  failOnce(e);
  retryAuto(e);
  assert.equal(e.claim('c1')?.attempt, 3);
  const w = e.read((v) => v.attempts('a')).at(-1)!;
  e.fail(w.id, w.token, 'снова', { kind: 'gate' });
  const x = explain(ctx);
  assert.deepEqual(
    { code: x.code, actor: x.actor, action: x.action },
    {
      code: 'ATTEMPTS_EXHAUSTED',
      actor: 'user',
      action: 'reset-attempts',
    },
  );
  assert.match(x.message, /сброс — решение человека/);
  e.diagnose('a', { cause: 'approach', hypothesis: 'Гипотеза при правиле user' });
  refused(() => e.retry('a', { reason: '' }, 'lead'), 'ATTEMPTS_EXHAUSTED', /user/);
  assert.equal(work(e).leadRecovery?.resets.length ?? 0, 0);
});

test('recovery: без поля — lead, если ведущий решает технические вопросы, иначе user; явное поле главнее', () => {
  const technical = { threshold: 7, criticalPaths: [], leadAnswers: { technical: true } };
  assert.deepEqual(recoveryPolicyOf({}), {
    mode: 'user',
    enabled: false,
    diagnoseAfter: 2,
    leadResets: 2,
    source: 'default',
  });
  assert.equal(recoveryPolicyOf({ inputPolicy: technical }).mode, 'lead');
  assert.equal(recoveryPolicyOf({ inputPolicy: technical }).source, 'derived');
  assert.equal(
    recoveryPolicyOf({
      inputPolicy: technical,
      recovery: { mode: 'user', diagnoseAfter: 2, leadResets: 2 },
    }).mode,
    'user',
  );
  // Поведение: выведенный lead держит третью попытку, без правила — нет.
  const derived = setup(undefined, (p) => (p.inputPolicy = technical));
  failOnce(derived.engine);
  retryAuto(derived.engine);
  failOnce(derived.engine);
  refused(() => retryAuto(derived.engine), 'DIAGNOSIS_REQUIRED');
  const plain = setup();
  failOnce(plain.engine);
  retryAuto(plain.engine);
  failOnce(plain.engine);
  retryAuto(plain.engine);
  assert.equal(plain.engine.claim('c1')?.attempt, 3);
  assert.equal(
    plain.engine.read((v) => v.work('a')!.leadRecovery),
    undefined,
    'состояние прежнее',
  );
});

test('recovery: незасчитанные отказы (окружение, остановка controller) разбора не требуют', () => {
  const ctx = setup({ mode: 'lead', diagnoseAfter: 2 });
  const e = ctx.engine;
  failOnce(e, 'gate');
  retryAuto(e);
  failOnce(e, 'environment');
  retryAuto(e);
  failOnce(e, 'gate', true);
  assert.equal(work(e).status, 'ready', 'остановка controller вернула работу в очередь');
  failOnce(e, 'environment');
  retryAuto(e);
  assert.equal(work(e).attempt, 1, 'засчитан один отказ');
  assert.equal(
    e.read((v) => e.leadHoldOf(work(e), v)),
    undefined,
  );
  assert.ok(e.claim('c1'), 'вторая засчитанная попытка выдаётся без разбора');
  refused(() => e.diagnose('a', { cause: 'other' }), 'NOT_READY', /Идёт попытка/);
});

test('recovery: diagnoseAfter 1, 2, 3 при maxAttempts 3 — где разбор; leadResets 0 — сбрасывает только человек', () => {
  // 1: разбор после каждого отказа.
  const one = setup({ mode: 'lead', diagnoseAfter: 1 });
  failOnce(one.engine);
  refused(() => retryAuto(one.engine), 'DIAGNOSIS_REQUIRED');
  one.engine.diagnose('a', { cause: 'approach', hypothesis: 'Гипотеза после первого отказа' });
  retryAuto(one.engine);
  failOnce(one.engine);
  refused(() => retryAuto(one.engine), 'DIAGNOSIS_REQUIRED');
  // 2: первая повторная — без разбора, после второй — разбор.
  const two = setup({ mode: 'lead', diagnoseAfter: 2 });
  failOnce(two.engine);
  retryAuto(two.engine);
  failOnce(two.engine);
  refused(() => retryAuto(two.engine), 'DIAGNOSIS_REQUIRED');
  // 3 (= maxAttempts): шлюза до исчерпания нет, разбор — при исчерпании.
  const three = setup({ mode: 'lead', diagnoseAfter: 3 });
  for (let i = 0; i < 3; i++) {
    failOnce(three.engine);
    if (i < 2) retryAuto(three.engine);
  }
  const x = explain(three);
  assert.deepEqual(
    { code: x.code, actor: x.actor, action: x.action },
    {
      code: 'ATTEMPTS_EXHAUSTED',
      actor: 'lead',
      action: 'diagnose',
    },
  );
  // leadResets 0: исчерпание с техническим разбором — человек.
  const zero = setup({ mode: 'lead', diagnoseAfter: 3, leadResets: 0 });
  for (let i = 0; i < 3; i++) {
    failOnce(zero.engine);
    if (i < 2) retryAuto(zero.engine);
  }
  zero.engine.diagnose('a', { cause: 'approach', hypothesis: 'Гипотеза при нуле сбросов' });
  assert.equal(explain(zero).actor, 'user');
  refused(() => zero.engine.retry('a', { reason: '' }, 'lead'), 'ATTEMPTS_EXHAUSTED');
});

const kinds = (steps: { kind: string; state: string; attempt?: number }[]) =>
  steps.map((s) => `${s.kind}${s.attempt ? s.attempt : ''}:${s.state}`);

test('track: путь работы — попытки по шагам, разбор по diagnoseAfter, запасные сбросы и «принято»', () => {
  for (const [diagnoseAfter, expected] of [
    [
      1,
      [
        'code1:passed',
        'checks1:failed',
        'review1:skipped',
        'integration1:skipped',
        'diagnosis:waiting',
        'code2:planned',
        'checks2:planned',
        'review2:planned',
        'integration2:planned',
        'diagnosis:planned',
        'code3:planned',
        'checks3:planned',
        'review3:planned',
        'integration3:planned',
        'diagnosis:planned',
        'reset:planned',
        'diagnosis:planned',
        'reset:planned',
        'accepted:planned',
      ],
    ],
    [
      2,
      [
        'code1:passed',
        'checks1:failed',
        'review1:skipped',
        'integration1:skipped',
        'diagnosis:planned',
        'code2:planned',
        'checks2:planned',
        'review2:planned',
        'integration2:planned',
        'diagnosis:planned',
        'code3:planned',
        'checks3:planned',
        'review3:planned',
        'integration3:planned',
        'diagnosis:planned',
        'reset:planned',
        'diagnosis:planned',
        'reset:planned',
        'accepted:planned',
      ],
    ],
    [
      3,
      [
        'code1:passed',
        'checks1:failed',
        'review1:skipped',
        'integration1:skipped',
        'diagnosis:planned',
        'code2:planned',
        'checks2:planned',
        'review2:planned',
        'integration2:planned',
        'diagnosis:planned',
        'code3:planned',
        'checks3:planned',
        'review3:planned',
        'integration3:planned',
        'diagnosis:planned',
        'reset:planned',
        'diagnosis:planned',
        'reset:planned',
        'accepted:planned',
      ],
    ],
  ] as const) {
    const ctx = setup({ mode: 'lead', diagnoseAfter });
    failOnce(ctx.engine);
    const w = work(ctx.engine);
    const attempts = ctx.engine.read((v) => v.attempts('a'));
    const t = workTrack(w, attempts, {
      maxAttempts: 3,
      recovery: recoveryPolicyOf(ctx.policy),
      lang: 'ru',
    });
    assert.deepEqual(kinds(t.steps), expected, `diagnoseAfter ${diagnoseAfter}`);
    assert.equal(t.steps[1]!.reason, 'проверки не прошли');
    // Ревизия 8: до `diagnoseAfter` отказов — разбор по желанию (повтор
    // делает harness сам), с ним и на исчерпании — обязательный.
    const diagnoses = t.steps.filter((s) => s.kind === 'diagnosis');
    assert.ok(diagnoses.every((s) => typeof s.required === 'boolean'));
    const optional = diagnoses.filter((s) => s.required === false);
    assert.equal(optional.length, Math.max(0, Math.min(diagnoseAfter, 3) - 1));
    assert.ok(optional.every((s) => s.label === 'повтор: harness сам, ведущий может разобрать'));
    assert.ok(
      diagnoses
        .filter((s) => s.required && s.state === 'planned')
        .every((s) => s.label === 'обязательный разбор ведущего'),
    );
    assert.equal(diagnoses.at(-1)!.required, true, 'разбор перед сбросом обязателен');
  }
  // mode user: ни разборов, ни сбросов ведущего; разбор и сброс ведущего — решениями в истории.
  const user = setup({ mode: 'user' });
  failOnce(user.engine);
  const plain = workTrack(
    work(user.engine),
    user.engine.read((v) => v.attempts('a')),
    {
      maxAttempts: 3,
      recovery: recoveryPolicyOf(user.policy),
      lang: 'en',
    },
  );
  assert.ok(!plain.steps.some((s) => s.kind === 'diagnosis' || s.kind === 'reset'));
  assert.equal(plain.steps.at(-1)?.label, 'accepted');
  const lead = setup({ mode: 'lead', leadResets: 1 });
  failOnce(lead.engine);
  retryAuto(lead.engine);
  failOnce(lead.engine);
  lead.engine.diagnose('a', { cause: 'approach', hypothesis: 'Гипотеза для пути работы' });
  retryAuto(lead.engine);
  failOnce(lead.engine);
  lead.engine.diagnose('a', { cause: 'coverage', hypothesis: 'Вторая гипотеза для пути' });
  lead.engine.retry('a', { reason: '' }, 'lead');
  const t = workTrack(
    work(lead.engine),
    lead.engine.read((v) => v.attempts('a')),
    {
      maxAttempts: 3,
      recovery: recoveryPolicyOf(lead.policy),
      lang: 'ru',
    },
  );
  const decisions = t.steps
    .filter((s) => s.state === 'decision')
    .map((s) => `${s.kind}:${s.reason}`);
  assert.deepEqual(decisions, [
    'diagnosis:D1: неверный подход',
    'diagnosis:D2: слабое покрытие',
    'reset:+3 (сброс 1 из 1, D2)',
  ]);
  // D1 разобрал два отказа (держало правило), D2 — один, но по нему дан сброс.
  assert.deepEqual(
    t.steps.filter((s) => s.kind === 'diagnosis' && s.state === 'decision').map((s) => s.required),
    [true, true],
  );
  assert.equal(
    t.steps.filter((s) => s.kind === 'reset' && s.state === 'planned').length,
    0,
    'сбросов не осталось',
  );
});

test('settings: тексты настроек на двух языках; итог меняется со значениями', () => {
  const s = decisionSettings({
    maxAttempts: 3,
    recovery: { mode: 'lead', diagnoseAfter: 2, leadResets: 2 },
  });
  assert.deepEqual(
    s.items.map((i) => i.key),
    [
      'maxAttempts',
      'recovery.mode',
      'recovery.diagnoseAfter',
      'recovery.leadResets',
      'inputPolicy.leadAnswers.technical',
    ],
  );
  for (const i of s.items) {
    assert.ok(i.explain.ru.length > 20 && /[а-я]/.test(i.explain.ru), i.key);
    assert.ok(i.explain.en.length > 20 && /^[\x20-\x7e—]+$/.test(i.explain.en), i.key);
  }
  assert.equal(
    s.summary.ru,
    'после 2 отказов — разбор ведущего; ведущий может дать ещё попытки 2 раза; дальше — вы',
  );
  const r = (mode: 'lead' | 'user', diagnoseAfter: number, leadResets: number) =>
    recoveryPolicyOf({ recovery: { mode, diagnoseAfter, leadResets } });
  assert.match(
    decisionSummary(r('lead', 1, 1), 3).ru,
    /^после 1 отказа — разбор ведущего; ведущий может дать ещё попытки 1 раз; дальше — вы$/,
  );
  assert.match(
    decisionSummary(r('lead', 3, 0), 3).ru,
    /^разбор ведущего — когда исчерпаны 3 попытки; ещё попытки даёте только вы; дальше — вы$/,
  );
  assert.match(decisionSummary(r('user', 2, 2), 3).ru, /решаете вы/);
  assert.match(
    decisionSummary(r('lead', 2, 2), 3).en,
    /^after 2 failures the lead diagnoses; the lead may grant more attempts 2 times; then you$/,
  );
  const sources = decisionSettings({
    maxAttempts: 3,
    inputPolicy: { leadAnswers: { technical: true } },
  }).items.map((i) => [i.key, i.value, i.source]);
  assert.deepEqual(sources, [
    ['maxAttempts', 3, 'policy'],
    ['recovery.mode', 'lead', 'derived'],
    ['recovery.diagnoseAfter', 2, 'derived'],
    ['recovery.leadResets', 2, 'derived'],
    ['inputPolicy.leadAnswers.technical', true, 'policy'],
  ]);
});

test('cli: diagnose проверяет причину, init — флаги восстановления, до чтения состояния', () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const harness = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    return JSON.parse(r.stdout) as { ok: boolean; error?: { code: string; message: string } };
  };
  const dir = mkdtempSync(join(tmpdir(), 'harness-lead-cli-'));
  const cause = harness('diagnose', '--state', dir, '--work', 'a', '--cause', 'luck');
  assert.equal(cause.error?.code, 'INVALID_INPUT');
  assert.match(cause.error.message, /coverage \| approach \| split/);
  const lone = harness('init', '--repository', dir, '--diagnose-after', '1');
  assert.equal(lone.error?.code, 'INVALID_INPUT');
  assert.match(lone.error.message, /вместе с --recovery/);
  const mode = harness('init', '--repository', dir, '--recovery', 'maybe');
  assert.match(mode.error!.message, /lead или user/);
  const range = harness('init', '--repository', dir, '--recovery', 'lead', '--lead-resets', '9');
  assert.match(range.error!.message, /--lead-resets: целое от 0 до 5/);
  const flag = harness('retry', '--state', dir, '--work', 'a', '--hypothesis', 'x');
  assert.match(flag.error!.message, /--hypothesis поддерживают: diagnose/);
});

test('doctor: действующее правило решений словами; recovery lead без технических ответов ведущего — предупреждение; шлюз не до исчерпания — заметка', async () => {
  const { doctor } = await import('../src/control/doctor.ts');
  const odd = await doctor(
    policyOf((p) => {
      p.maxAttempts = 3;
      p.recovery = { mode: 'lead', diagnoseAfter: 3, leadResets: 1 };
    }),
    {},
  );
  assert.equal(
    odd.decisions?.summary.ru,
    'разбор ведущего — когда исчерпаны 3 попытки; ведущий может дать ещё попытки 1 раз; дальше — вы',
  );
  assert.ok(odd.warnings?.some((w) => w.includes('recovery.mode: lead')));
  assert.ok(odd.notes?.some((n) => n.includes('recovery.diagnoseAfter 3 ≥ maxAttempts 3')));
  const usual = await doctor(
    policyOf(
      (p) =>
        (p.inputPolicy = { threshold: 7, criticalPaths: [], leadAnswers: { technical: true } }),
    ),
    {},
  );
  assert.equal(usual.decisions?.items.find((i) => i.key === 'recovery.mode')?.source, 'derived');
  assert.ok(!usual.warnings?.some((w) => w.includes('recovery.mode')));
});

test('A68-1a: дополнение свежего разбора — без второго разбора и перерегистрации; исполнитель получает его; предела оно не даёт', async () => {
  const { leadDiagnosisNote } = await import('../src/engine/runner.ts');
  const ctx = setup({ mode: 'lead' });
  const e = ctx.engine;
  failOnce(e);
  retryAuto(e);
  failOnce(e);
  // Дополнять нечего, пока разбора нет.
  refused(() => e.amendDiagnosis('a', { text: 'вторая причина отказа' }), 'NOT_READY');
  e.diagnose('a', { cause: 'environment', hypothesis: 'конфигурация gate не та' });
  // Второй разбор того же отказа — отказ, как раньше.
  refused(
    () => e.diagnose('a', { cause: 'approach', hypothesis: 'другая гипотеза теста' }),
    'NOT_READY',
  );
  const amended = e.amendDiagnosis('a', {
    text: 'Ошибка очистки теста маскирует исходный отказ: token=abcdefabcdefabcdefabcdef',
    evidence: ['лог gate'],
  });
  assert.equal(amended.diagnosis.id, 'D1');
  assert.equal(amended.diagnosis.addenda?.length, 1);
  assert.doesNotMatch(
    amended.diagnosis.addenda[0]!.text,
    /abcdefabcdefabcdef/,
    'секрет замаскирован',
  );
  const d = work(e).leadRecovery!;
  assert.equal(d.diagnoses.length, 1, 'нового разбора нет');
  assert.equal(d.seq, 1);
  const note = leadDiagnosisNote(d.diagnoses[0]!);
  assert.match(note, /Lead addendum 1 to D1/);
  assert.match(note, /маскирует исходный отказ/);
  const events = ctx.store.events(0, 1000).filter((x) => x.type === 'work.diagnosis-amended');
  assert.deepEqual((events[0]!.payload as { addendum: number }).addendum, 1);
  for (let i = 2; i <= 5; i++) e.amendDiagnosis('a', { text: `ещё заметка ведущего ${i}` });
  refused(
    () => e.amendDiagnosis('a', { text: 'шестая заметка ведущего' }),
    'INVALID_INPUT',
    /5 дополнений/,
  );
  // После дополнения работа идёт дальше обычным повтором.
  retryAuto(e);
  assert.equal(e.claim('c1')?.attempt, 3);
});
