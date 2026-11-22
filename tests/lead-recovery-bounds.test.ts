/**
 * Пределы восстановления ведущим не обходятся (0.1.0-alpha.66, ревью):
 * отказ от доработки и та же постановка снова не дают свежих попыток и
 * сбросов, сброс человеком (в том числе без записи прежней сборки) решает
 * отказы до него, разбор покрывает больше 20 отказов, согласованное
 * разделение (`split`) оставляет новый предел ведущему, разбор хранится без
 * секретов.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, HarnessError, type WorkGraph } from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { pendingFailures } from '../src/projections/lead-recovery.ts';
import {
  engineOf,
  graphOf,
  planReview,
  policyOf,
  ready,
  sha,
  trustNone,
} from './engine-fixture.ts';

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
  return state;
}

/** Редакция графа с доработкой принятой работы `w`: та же постановка, если `text` тот же. */
function revised(revision: string, text = ' Доработка X.') {
  const g = graphOf({ w: [] }, revision, 'g');
  g.orders = g.orders.map((o) => ({ ...o, goal: o.goal + text }));
  return g;
}

const refused = (fn: () => unknown, code: string, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HarnessError, String(e));
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });

/** Выдавать и проваливать попытки `w`, пока они выдаются; повтор — `by`. */
function drain(
  env: ReturnType<typeof engineOf>,
  by: 'recovery' | 'operator' = 'recovery',
  workId = 'w',
) {
  let n = 0;
  for (;;) {
    env.clock.now += 1000;
    env.engine.lead('c1');
    const a = env.engine.claim('c1');
    if (!a) return n;
    env.engine.fail(a.id, a.token, 'gate fail ' + n, { kind: 'gate' });
    n++;
    try {
      env.engine.retry(workId, undefined, by);
    } catch {
      return n;
    }
  }
}

function accepted(patch: (p: Record<string, unknown>) => void) {
  const env = engineOf(policyOf(patch));
  ready(env.engine, graphOf({ w: [] }));
  env.engine.lead('c1');
  const r0 = env.engine.claim('c1')!;
  accept(env.engine, r0.id, r0.token, sha('a'), sha('b'));
  return env;
}

test('bounds: отказ от доработки и та же постановка снова — попытки не свежие (было: свежий предел на каждом круге)', () => {
  const env = accepted((p) => {
    p.maxAttempts = 2;
    p.recovery = { mode: 'lead', diagnoseAfter: 5, leadResets: 0 };
  });
  const e = env.engine;
  const fails: number[] = [];
  for (let cycle = 0; cycle < 5; cycle++) {
    replan(e, revised(String(cycle + 2)));
    fails.push(drain(env));
    const w = e.read((v) => v.work('w')!);
    assert.equal(w.attempt, 2, `круг ${cycle}: счётчик попыток доработки перенесён`);
    if (cycle > 0) {
      assert.equal(w.rework?.resumed, true, 'доработка продолжает оставленную');
      assert.equal(w.rework?.fresh, false);
      assert.equal(w.rework?.budgets, 1, 'своего предела у продолжения нет');
    }
    e.cancel('w', 'abandon', 'operator');
    const after = e.read((v) => v.work('w')!);
    assert.equal(after.status, 'done');
    assert.equal(after.rework?.abandoned?.attempt, 2);
  }
  assert.deepEqual(fails, [2, 0, 0, 0, 0], 'попытки тратятся один раз на предел');
  // Другая постановка после отказа — новая доработка со своим пределом.
  replan(e, revised('9', ' Доработка Y.'));
  const w = e.read((v) => v.work('w')!);
  assert.deepEqual(
    {
      attempt: w.attempt,
      fresh: w.rework?.fresh,
      budgets: w.rework?.budgets,
      resumed: w.rework?.resumed,
    },
    { attempt: 0, fresh: true, budgets: 2, resumed: undefined },
  );
});

test('bounds: отказ от доработки сохраняет разборы и сбросы ведущего — предел сбросов не обходится', () => {
  const env = accepted((p) => {
    p.maxAttempts = 2;
    p.repairBudget = 50;
    p.recovery = { mode: 'lead', diagnoseAfter: 5, leadResets: 1 };
  });
  const e = env.engine;
  let h = 0;
  let resets = 0;
  const ids: string[] = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    replan(e, revised(String(cycle + 2)));
    drain(env, 'operator');
    for (;;) {
      try {
        ids.push(
          e.diagnose('w', { cause: 'approach', hypothesis: 'гипотеза номер ' + h++ }).diagnosis.id,
        );
        e.retry('w', { reason: '' }, 'lead');
        resets++;
        drain(env, 'operator');
      } catch {
        break;
      }
    }
    e.cancel('w', 'abandon', 'operator');
    const after = e.read((v) => v.work('w')!);
    assert.ok(after.leadRecovery, `круг ${cycle}: история ведущего сохранена после отказа`);
  }
  assert.equal(resets, 1, 'один сброс ведущего на предел, сколько ни оставлять доработку');
  assert.equal(new Set(ids).size, ids.length, 'номера разборов не повторяются');
  // Новая редакция той же постановки продолжает ту же историю: прежние
  // гипотезы (для отказа от повтора) и счёт сбросов этого предела.
  replan(e, revised('20'));
  const w = e.read((v) => v.work('w')!);
  assert.equal(w.leadRecovery?.diagnoses[0]?.hypothesis, 'гипотеза номер 0');
  assert.equal(w.leadRecovery?.resets.filter((r) => r.by === 'lead').length, 1);
  refused(() => e.retry('w', { reason: '' }, 'lead'), 'ATTEMPTS_EXHAUSTED');
});

function single(patch: (p: Record<string, unknown>) => void) {
  const env = engineOf(policyOf(patch));
  ready(env.engine, graphOf({ a: [] }));
  return env;
}
const failA = (e: Engine) => {
  const a = e.claim('c1');
  assert.ok(a, 'попытка выдана');
  e.fail(a.id, a.token, 'проверка не прошла', { kind: 'gate' });
  return a;
};
function explainA(env: ReturnType<typeof engineOf>, policy: ReturnType<typeof policyOf>) {
  const d = stopInputsOf(
    { engine: env.engine, policy, workflows: { list: () => [], continues: () => false } },
    { maxAttempts: policy.maxAttempts, repairBudget: policy.repairBudget, workId: 'a' },
  )
    .filter((i) => i.kind === 'work')
    .map(explainStop)[0]!;
  return { code: d.code, actor: d.actor, action: d.action };
}

test('bounds: сброс человеком при правиле user записан; отказы до сброса без записи (прежняя сборка) разбора не требуют', () => {
  const user = single((p) => {
    p.maxAttempts = 3;
    p.recovery = { mode: 'user' };
  });
  failA(user.engine);
  user.engine.retry('a', undefined, 'recovery');
  failA(user.engine);
  user.engine.retry('a', { reason: 'человек решил' }, 'operator');
  const w = user.engine.read((v) => v.work('a')!);
  assert.deepEqual(
    w.leadRecovery?.resets.map((r) => ({ by: r.by, failures: r.failures.length })),
    [{ by: 'operator', failures: 2 }],
  );

  // Правило lead, сброс человеком, запись о нём стёрта — так выглядит
  // работа прежней сборки после перехода на lead.
  const policy = policyOf((p) => {
    p.maxAttempts = 3;
    p.recovery = { mode: 'lead', diagnoseAfter: 2 };
  });
  const lead = engineOf(policy);
  ready(lead.engine, graphOf({ a: [] }));
  failA(lead.engine);
  lead.engine.retry('a', undefined, 'recovery');
  failA(lead.engine);
  lead.engine.retry('a', { reason: 'человек решил' }, 'operator');
  lead.store.transact('task.retry', (tx) => {
    tx.putWork({ ...tx.work('a')!, leadRecovery: undefined });
  });
  assert.deepEqual(
    pendingFailures(
      lead.engine.read((v) => v.work('a')!),
      lead.engine.read((v) => v.attempts('a')),
    ),
    [],
  );
  const next = lead.engine.claim('c1');
  assert.equal(next?.attempt, 1, 'после сброса попытка выдаётся без разбора');
  lead.engine.fail(next.id, next.token, 'снова', { kind: 'gate' });
  lead.engine.retry('a', undefined, 'recovery');
  assert.equal(
    lead.engine.claim('c1')?.attempt,
    2,
    'один отказ после сброса — не повод для разбора',
  );
});

test('bounds: разбор покрывает больше 20 отказов — повторного разбора они не требуют', () => {
  const attempts = Array.from({ length: 25 }, (_, i) => ({
    id: 'r' + i,
    workId: 'a',
    status: 'failed' as const,
    failureKind: 'gate' as const,
  }));
  const work = {
    id: 'a',
    status: 'failed' as const,
    attempt: 25,
    leadRecovery: {
      seq: 1,
      resets: [],
      diagnoses: [
        {
          id: 'D1',
          cause: 'approach' as const,
          hypothesis: 'другая гипотеза',
          evidence: [],
          failures: attempts.slice(-20).map((a) => a.id),
          by: 'lead' as const,
          at: '2026-01-01T00:00:00.000Z',
          epoch: 0,
        },
      ],
    },
  };
  assert.deepEqual(pendingFailures(work, attempts), []);
  assert.deepEqual(pendingFailures(work, [...attempts, { ...attempts[0]!, id: 'r25' }]), ['r25']);
});

test('bounds: split на исчерпании и согласованное разделение — новый предел даёт ведущий в пределе leadResets', () => {
  const policy = policyOf((p) => {
    p.maxAttempts = 2;
    p.recovery = { mode: 'lead', diagnoseAfter: 5, leadResets: 1 };
  });
  const env = engineOf(policy);
  const e = env.engine;
  ready(e, graphOf({ a: [] }));
  failA(e);
  e.retry('a', undefined, 'recovery');
  failA(e);
  const d = e.diagnose('a', { cause: 'split' });
  assert.equal(d.next, 'replan');
  assert.deepEqual(explainA(env, policy), {
    code: 'NOT_READY',
    actor: 'lead',
    action: 'review-plan',
  });
  // Перепланирование тем же id: постановка сужена и согласована.
  const g = graphOf({ a: [] }, '2');
  (g.orders[0] as { title: string }).title += ' — только первая часть';
  replan(e, g);
  assert.equal(e.read((v) => v.work('a')!).attempt, 2, 'попыток перепланирование не добавляет');
  assert.deepEqual(explainA(env, policy), {
    code: 'ATTEMPTS_EXHAUSTED',
    actor: 'lead',
    action: 'reset-attempts',
  });
  const r = e.retry('a', { reason: '', diagnosis: d.diagnosis.id }, 'lead');
  assert.equal(r.reset?.performed, true);
  assert.equal(e.claim('c1')?.attempt, 1);
  // Сверх предела сбросов — человек.
  const a = e.read((v) => v.attempts('a')).at(-1)!;
  e.fail(a.id, a.token, 'снова', { kind: 'gate' });
  e.retry('a', undefined, 'recovery');
  failA(e);
  const d2 = e.diagnose('a', { cause: 'split' });
  const g3 = graphOf({ a: [] }, '3');
  (g3.orders[0] as { title: string }).title += ' — только четверть';
  replan(e, g3);
  refused(
    () => e.retry('a', { reason: '', diagnosis: d2.diagnosis.id }, 'lead'),
    'ATTEMPTS_EXHAUSTED',
    /потрачены/,
  );
  assert.deepEqual(explainA(env, policy), {
    code: 'ATTEMPTS_EXHAUSTED',
    actor: 'user',
    action: 'reset-attempts',
  });
});

test('bounds: гипотеза и доказательства разбора хранятся без секретов', () => {
  const env = single((p) => {
    p.maxAttempts = 3;
    p.recovery = { mode: 'lead', diagnoseAfter: 1 };
  });
  failA(env.engine);
  const key = 'sk-ant-api03-' + 'A'.repeat(40);
  const d = env.engine.diagnose('a', {
    cause: 'approach',
    hypothesis: `исполнитель печатал ключ ${key} в лог; перестать`,
    evidence: [`curl -H "Authorization: Bearer ${'b'.repeat(30)}" https://x`],
  });
  const stored = env.engine.read((v) => v.work('a')!.leadRecovery!.diagnoses.at(-1)!);
  for (const text of [d.diagnosis.hypothesis!, stored.hypothesis!, ...stored.evidence]) {
    assert.ok(!text.includes(key), text);
    assert.ok(!text.includes('b'.repeat(30)), text);
  }
  assert.match(stored.hypothesis!, /перестать/);
});
