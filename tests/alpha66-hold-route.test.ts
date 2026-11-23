import './temp-scope.ts';
/**
 * Маршрут удержания gate отказом `ps` (0.1.0-alpha.66, ревью раунда 2): то,
 * что представление велит ведущему, работает. Повтор ведущего снимает
 * удержание всегда — и после исчерпанного предела незасчитанных отказов,
 * когда сам повтор отклонён; строки удержания и explain называют
 * следующего по тому же правилу, что и отказ. Удержание переживает новую
 * редакцию графа и снимается сменой среды. Здесь же: актёр команд журнала
 * ведущего, продолжение оставленной доработки по записи прежней сборки и
 * путь работы (ожидание ведущего на удержанном gate, актёр шагов решений).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, HarnessError, type WorkGraph } from '../src/contracts/index.ts';
import { MAX_NEUTRAL_FAILURES } from '../src/contracts/repair-policy.ts';
import type { Engine } from '../src/engine/engine.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { environmentGateHolds } from '../src/projections/gate-hold.ts';
import { workTrack } from '../src/projections/track.ts';
import { recoveryPolicyOf } from '../src/projections/decisions.ts';
import {
  leadBegin,
  leadCommandActor,
  leadCommandEntry,
  recordLeadCommand,
} from '../src/control/lead.ts';
import { processListSeen } from '../src/verification/process-list.ts';
import {
  engineOf,
  graphOf,
  planReview,
  policyOf,
  ready,
  sha,
  trustNone,
} from './engine-fixture.ts';

function failOnPs(e: Engine) {
  const a = e.claim('c1');
  assert.ok(a, 'попытка выдана');
  e.phase(a.id, a.token, 'verifying', { candidateSha: sha('c') });
  e.evidence(a.id, a.token, {
    kind: 'test',
    phase: 'candidate',
    sha: sha('c'),
    gate: 'unit',
    passed: false,
    command: ['npm', 'test'],
    exitCode: 1,
    log: '',
    digest: digestOf('ps'),
    summary: 'GATE_SANDBOX_PROCESS_LIST: gate запускает ps (список процессов)',
  });
  e.fail(a.id, a.token, 'candidate/unit: GATE_SANDBOX_PROCESS_LIST', {
    kind: 'environment',
    cause: 'sandbox-process-list',
  });
  return a;
}

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

function setup(patch: (p: Record<string, unknown>) => void = () => {}) {
  const policy = policyOf((p) => {
    p.concurrency = 1;
    patch(p);
  });
  const env = engineOf(policy);
  ready(env.engine, graphOf({ a: [], b: [] }));
  return { ...env, policy };
}

const explainOf = (env: ReturnType<typeof setup>, workId: string) => {
  const d = stopInputsOf(
    {
      engine: env.engine,
      policy: env.policy,
      workflows: { list: () => [], continues: () => false },
    },
    { maxAttempts: env.policy.maxAttempts, repairBudget: env.policy.repairBudget, workId },
  )
    .filter((i) => i.kind === 'work')
    .map(explainStop)[0]!;
  return { code: d.code, actor: d.actor, action: d.action, message: d.message };
};

const holds = (e: Engine) => e.read((v) => e.environmentGateHolds(v));

test('маршрут: удержание → ведущий исправил тест → retry --by lead снимает удержание → успех', () => {
  const env = setup();
  const e = env.engine;
  const a = failOnPs(e);
  const other = a.workId === 'a' ? 'b' : 'a';
  // Что велит представление: ход ведущего и команда.
  const before = explainOf(env, a.workId);
  assert.equal(before.actor, 'lead');
  const line = e
    .read((v) => e.blockers(v.work(other)!, v))
    .find((b) => b.code === 'ENVIRONMENT_GATE_HELD')!.message;
  assert.match(line, new RegExp(`harness retry --work ${a.workId} --by lead`));
  // Ведущий исправил тест и подал именно эту команду.
  const r = e.retry(a.workId, undefined, 'lead');
  assert.equal(r.gateHoldLifted, 'unit');
  assert.equal(r.work.environmentHold, undefined);
  assert.equal(holds(e).length, 0);
  // Обе работы снова выдаются и принимаются.
  env.clock.now += 1000;
  e.lead('c1');
  const next = e.claim('c1');
  assert.ok(next, 'выдача идёт');
  accept(e, next.id, next.token, sha('d'), sha('e'));
  assert.equal(
    e.read((v) => v.work(next.workId)!.status),
    'done',
  );
});

test('маршрут: предел незасчитанных отказов исчерпан — retry --by lead всё равно снимает удержание, дальше — человек', () => {
  const env = setup((p) => {
    p.recovery = { mode: 'lead', diagnoseAfter: 2, leadResets: 2 };
  });
  const e = env.engine;
  let a = failOnPs(e);
  // Исправления ведущего, которые снова падают на ps: одиночные прогоны,
  // но предел незасчитанных отказов они тратят.
  for (let i = 1; i < MAX_NEUTRAL_FAILURES; i++) {
    e.retry(a.workId, undefined, 'lead');
    env.clock.now += 1000;
    e.lead('c1');
    a = failOnPs(e);
  }
  const w = e.read((v) => v.work(a.workId)!);
  assert.equal(w.neutralFailures, MAX_NEUTRAL_FAILURES);
  assert.ok(w.environmentHold);
  // Explain удержавшей работы: человек, тот же ход, что у отказа ниже.
  const x = explainOf(env, a.workId);
  assert.deepEqual(
    { code: x.code, actor: x.actor, action: x.action },
    { code: 'ATTEMPTS_EXHAUSTED', actor: 'user', action: 'reset-attempts' },
  );
  const userCommand = `harness retry --work ${a.workId} --reset --reason "…"`;
  assert.ok(x.message.includes(userCommand), x.message);
  assert.match(x.message, /исчерпан предел незасчитанных отказов \(3 из 3\)/);
  // Строка удержания у другой работы: снять удержание — ведущий, повтор — человек.
  const other = a.workId === 'a' ? 'b' : 'a';
  const line = e
    .read((v) => e.blockers(v.work(other)!, v))
    .find((b) => b.code === 'ENVIRONMENT_GATE_HELD')!.message;
  assert.ok(line.includes(`снять удержание (harness retry --work ${a.workId} --by lead)`), line);
  assert.ok(line.includes(`решение человека (${userCommand})`), line);
  // Повтор ведущего: отказ, но удержание снято и записано.
  assert.throws(
    () => e.retry(a.workId, undefined, 'lead'),
    (err: unknown) => {
      assert.ok(err instanceof HarnessError);
      assert.equal(err.code, 'ATTEMPTS_EXHAUSTED');
      assert.ok(err.message.includes(userCommand), err.message);
      assert.match(err.message, /сброс — решение человека/);
      assert.match(err.message, /Удержание gate unit снято/);
      return true;
    },
  );
  assert.equal(holds(e).length, 0, 'удержание снято, хотя повтор отклонён');
  const after = e.read((v) => v.work(a.workId)!);
  assert.equal(after.environmentHold, undefined);
  assert.equal(after.status, 'failed');
  const events = env.store.events(0, 100000).filter((ev) => ev.type === 'work.gate-hold-lifted');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.payload, { gate: 'unit', by: 'lead', refused: 'ATTEMPTS_EXHAUSTED' });
  // Другая работа с этим gate снова выдаётся.
  env.clock.now += 1000;
  e.lead('c1');
  assert.equal(e.claim('c1')?.workId, other);
  // Следующий — человек: его сброс снова даёт попытки.
  const reset = e.retry(a.workId, { reason: 'тест исправлен' }, 'operator');
  assert.equal(reset.work.status, 'ready');
  assert.equal(reset.work.neutralFailures, undefined);
});

test('новая редакция графа сохраняет удержание gate; принятая или отменённая работа — нет', () => {
  const env = setup();
  const e = env.engine;
  const a = failOnPs(e);
  const graph: WorkGraph = graphOf({ a: [], b: [], c: [] }, '2');
  const { graph: state } = e.register(graph, trustNone);
  const w = e.read((v) => v.work(a.workId)!);
  assert.equal(w.status, 'draft');
  assert.equal(w.environmentHold?.gate, 'unit', 'удержание перенесено');
  assert.equal(holds(e).length, 1);
  e.recordReview(planReview(e, state, e.reviews('plan', state.id).length + 1));
  e.approve(state.id, 'agent');
  env.clock.now += 1000;
  e.lead('c1');
  assert.equal(e.claim('c1'), undefined, 'после новой редакции gate по-прежнему удержан');
  // Убранная из плана работа отменяется — её удержание больше не держит.
  e.register(graphOf({ b: [], c: [] }, '3'), trustNone);
  assert.equal(holds(e).length, 0);
});

test('ключ удержания: режим изоляции и проба списка процессов — смена среды снимает удержание', () => {
  const env = setup();
  const e = env.engine;
  const a = failOnPs(e);
  const hold = e.read((v) => v.work(a.workId)!.environmentHold!);
  assert.equal(hold.isolation, 'os');
  const work = { id: a.workId, status: 'failed' as const, environmentHold: hold };
  const same = () => hold.digest;
  assert.equal(environmentGateHolds([work], same, { isolation: 'os' }).length, 1);
  assert.equal(
    environmentGateHolds([work], same, { isolation: 'none' }).length,
    0,
    'isolation: none',
  );
  assert.equal(
    environmentGateHolds([work], same, { isolation: 'os', processList: 'available' }).length,
    0,
    'ps в песочнице стал доступен',
  );
  assert.equal(
    environmentGateHolds([work], same, { isolation: 'os', processList: 'unavailable' }).length,
    1,
  );
  // Запись прежней сборки без поля — режим os.
  const { isolation: _i, ...old } = hold;
  void _i;
  assert.equal(
    environmentGateHolds([{ ...work, environmentHold: old }], same, { isolation: 'os' }).length,
    1,
  );
  // Движок: проба этого процесса ответила available — выдача идёт.
  assert.equal(holds(e).length, 1);
  processListSeen.status = 'available';
  try {
    assert.equal(holds(e).length, 0);
    env.clock.now += 1000;
    e.lead('c1');
    assert.ok(e.claim('c1'), 'удержания нет — работа выдана');
  } finally {
    delete processListSeen.status;
  }
  // Политика без песочницы ОС у того же хранилища: удержания нет.
  const none = engineOf(
    policyOf((p) => {
      p.concurrency = 1;
      p.isolation = { mode: 'none', domains: [] };
    }),
    env.dir,
  );
  assert.equal(none.engine.read((v) => none.engine.environmentGateHolds(v)).length, 0);
});

test('журнал ведущего: retry без --by lead — команда оператора и при активной сессии', () => {
  assert.equal(leadCommandActor('retry', {}), 'operator');
  assert.equal(leadCommandActor('retry', { by: 'operator' }), 'operator');
  assert.equal(leadCommandActor('retry', { by: 'lead' }), 'lead');
  assert.equal(leadCommandActor('pause', {}), undefined, 'прочие — по сессии');
  assert.equal(leadCommandEntry('retry', { work: 'a' }, {}), undefined);
  const env = engineOf();
  leadBegin(env.engine, { ttlMs: 10 * 60_000 });
  const entry = {
    kind: 'command' as const,
    action: 'lead.retry',
    plain: 'повтор',
    plainEn: 'retry',
  };
  assert.equal(recordLeadCommand(env.engine, entry, leadCommandActor('retry', {})), false);
  assert.equal(
    recordLeadCommand(env.engine, entry, leadCommandActor('retry', { by: 'lead' })),
    true,
  );
});

test('оставленная доработка без abandoned.attempt (прежняя сборка): счёт выводится из попыток, иначе — строгая сторона', () => {
  const policy = policyOf((p) => {
    p.maxAttempts = 3;
    p.recovery = { mode: 'lead', diagnoseAfter: 5, leadResets: 0 };
  });
  const env = engineOf(policy);
  const e = env.engine;
  ready(e, graphOf({ w: [] }));
  e.lead('c1');
  const r0 = e.claim('c1')!;
  accept(e, r0.id, r0.token, sha('a'), sha('b'));
  const revised = (revision: string) => {
    const g = graphOf({ w: [] }, revision, 'g');
    g.orders = g.orders.map((o) => ({ ...o, goal: o.goal + ' Доработка X.' }));
    return g;
  };
  const current0 = () => e.read((v) => v.work('w')!);
  const replan = (g: WorkGraph) => {
    const { graph: state } = e.register(g, trustNone);
    e.recordReview(planReview(e, state, e.reviews('plan', state.id).length + 1));
    e.approve(state.id, 'agent');
  };
  replan(revised('2'));
  const epoch = current0().rework?.roundEpochAt;
  assert.ok(epoch, 'доработка со своим пределом открыла эпоху раундов');
  for (let i = 0; i < 2; i++) {
    env.clock.now += 1000;
    e.lead('c1');
    const a = e.claim('c1')!;
    e.fail(a.id, a.token, 'gate fail ' + i, { kind: 'gate' });
    if (i === 0) e.retry('w', undefined, 'recovery');
  }
  e.cancel('w', 'abandon', 'operator');
  const strip = (fn: (w: ReturnType<typeof current>) => ReturnType<typeof current>) =>
    env.store.transact('task.retry', (tx) => tx.putWork(fn(tx.work('w')!)));
  const current = () => e.read((v) => v.work('w')!);
  // Запись прежней сборки: в abandoned нет attempt.
  strip((w) => {
    const { attempt: _a, ...abandoned } = w.rework!.abandoned!;
    void _a;
    return { ...w, rework: { ...w.rework!, abandoned } };
  });
  // После отказа — счёт принятой редакции (одна попытка): прежнее продолжение
  // по нему давало бы доработке почти свежий предел.
  assert.equal(current().attempt, 1);
  replan(revised('3'));
  assert.equal(current().rework?.resumed, true);
  assert.equal(
    current().rework?.roundEpochAt,
    epoch,
    'продолжение сохраняет эпоху раундов (alpha.68)',
  );
  assert.equal(current().attempt, 2, 'выведено: два засчитанных отказа после принятой попытки');
  // Принятой попытки не найти — строгая сторона: предел исчерпан.
  e.cancel('w', 'abandon', 'operator');
  strip((w) => {
    const { attempt: _a, ...abandoned } = w.rework!.abandoned!;
    void _a;
    const { runId: _r, ...acceptedRun } = w.rework!.accepted;
    void _r;
    return { ...w, rework: { ...w.rework!, abandoned, accepted: acceptedRun } };
  });
  replan(revised('4'));
  assert.equal(current().attempt, policy.maxAttempts);
});

test('путь работы: удержанный gate — ожидание ведущего до плановых попыток; шаги решений называют актёра', () => {
  const env = setup((p) => {
    p.recovery = { mode: 'lead', diagnoseAfter: 2, leadResets: 1 };
  });
  const e = env.engine;
  const a = failOnPs(e);
  const other = a.workId === 'a' ? 'b' : 'a';
  const view = (workId: string, gateHold?: string) =>
    e.read((v) =>
      workTrack(v.work(workId)!, v.attempts(workId), {
        maxAttempts: env.policy.maxAttempts,
        recovery: recoveryPolicyOf(env.policy),
        lang: 'ru',
        ...(gateHold ? { gateHold } : {}),
      }),
    );
  const held = view(
    other,
    e.read((v) => e.gateHoldsOf(v.work(other)!, e.environmentGateHolds(v))[0]?.gate),
  );
  const waiting = held.steps.findIndex((s) => s.state === 'waiting');
  assert.ok(waiting >= 0, JSON.stringify(held.steps));
  assert.deepEqual(
    {
      kind: held.steps[waiting]!.kind,
      label: held.steps[waiting]!.label,
      actor: held.steps[waiting]!.actor,
    },
    { kind: 'checks', label: 'ждёт ведущего: проверка unit удержана', actor: 'lead' },
  );
  const firstPlanned = held.steps.findIndex((s) => s.state === 'planned');
  assert.ok(waiting < firstPlanned, 'ожидание — до плановых попыток');
  // Плановые разборы и сбросы — ведущего.
  for (const s of held.steps.filter((s) => s.kind === 'diagnosis' || s.kind === 'reset'))
    assert.equal(s.actor, 'lead', JSON.stringify(s));
  // Сброс человеком — решение человека, сброс ведущего — ведущего.
  e.retry(a.workId, { reason: 'ручной сброс' }, 'operator');
  const reset = view(a.workId).steps.find((s) => s.kind === 'reset' && s.state === 'decision');
  assert.deepEqual(
    { label: reset?.label, actor: reset?.actor },
    {
      label: 'сброс попыток человеком',
      actor: 'user',
    },
  );
});
