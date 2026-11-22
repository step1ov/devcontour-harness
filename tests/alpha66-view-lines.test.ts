/**
 * Представление ревизии 6 (0.1.0-alpha.66, сборка панели): шаги идущей
 * попытки, которых она ещё не достигла, — `planned`, а не `skipped`;
 * строки не несут часового времени (UTC в тексте рядом с местным временем
 * панели) — время в данных (`lead.since`).
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operatorViewSchema, recoveryPolicyOf } from '../src/contracts/index.ts';
import { collectOperatorViewInput } from '../src/control/operator-view.ts';
import { operatorView } from '../src/projections/index.ts';
import { workTrack } from '../src/projections/track.ts';
import { leadBegin, leadNote } from '../src/control/lead.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';

test('track: идущая попытка — недостигнутые шаги planned; у закончившейся — skipped', () => {
  const policy = policyOf((p) => {
    p.maxAttempts = 2;
  });
  const env = engineOf(policy);
  ready(env.engine, graphOf({ a: [] }));
  const a = env.engine.claim('c1')!;
  env.engine.phase(a.id, a.token, 'verifying', { candidateSha: sha('c') });
  const track = () =>
    workTrack(
      env.engine.read((v) => v.work('a')!),
      env.engine.read((v) => v.attempts('a')),
      { maxAttempts: 2, recovery: recoveryPolicyOf(policy), lang: 'ru' },
    ).steps.filter((s) => s.attempt === 1);
  const running = track().map((s) => `${s.kind}:${s.state}`);
  assert.deepEqual(running, [
    'code:passed',
    'checks:current',
    'review:planned',
    'integration:planned',
  ]);
  env.engine.fail(a.id, a.token, 'проверки не прошли', { kind: 'gate' });
  const finished = track().map((s) => `${s.kind}:${s.state}`);
  assert.deepEqual(finished, [
    'code:passed',
    'checks:failed',
    'review:skipped',
    'integration:skipped',
  ]);
});

test('lead.line: без часового времени в тексте — время в lead.since', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  leadBegin(env.engine, { ttlMs: 30 * 60_000 });
  env.clock.now += 60_000;
  leadNote(env.engine, { text: 'Проверяю сайт' });
  for (const lang of ['ru', 'en'] as const) {
    const { engine, dir } = env;
    const source = {
      engine,
      policy: engine.policy,
      workflows: { list: () => [], continues: () => false } as never,
      stateDir: dir,
      baseDir: dir,
    };
    const view = operatorViewSchema.parse(
      operatorView(
        collectOperatorViewInput(
          source,
          { raw: engine.policy, warnings: [], baseDir: dir },
          { now: engine.clock(), lang },
        ),
        { lang },
      ),
    );
    assert.equal(
      view.lead?.line,
      lang === 'ru' ? 'ведущий работает: Проверяю сайт' : 'the lead is working: Проверяю сайт',
    );
    assert.ok(view.lead?.since, 'время — в данных');
    // Ни одна строка представления не несёт часового времени UTC.
    assert.doesNotMatch(JSON.stringify(view), /\d\d:\d\d UTC/);
  }
});
