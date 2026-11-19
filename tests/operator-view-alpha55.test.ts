/**
 * Представление оператора на настоящем состоянии движка с полями alpha.55:
 * причина повтора (`attemptSummary.lastFailure`), блокировки простыми словами
 * (`blockers[].plain/actor`), что проверено и как (`verification`), влияние
 * вопроса (`impact`, `forUser`) и правило ответа ведущего на технический
 * вопрос. Загрузчик берёт их из `status` и записей вопросов, а не из
 * синтетического входа: путь «поле отсутствует» здесь не проверяется.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  digestOf,
  operatorViewSchema,
  workDetailViewSchema,
  type InputQuestion,
} from '../src/contracts/index.ts';
import { collectOperatorViewInput, type ViewSource } from '../src/control/operator-view.ts';
import type { WorkflowQueue } from '../src/control/workflow.ts';
import { operatorView, workDetailView } from '../src/projections/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';

const noJobs = { list: () => [], continues: () => false } as unknown as WorkflowQueue;
const sourceOf = (engine: Engine, dir: string): ViewSource => ({
  engine,
  policy: engine.policy,
  workflows: noJobs,
  stateDir: dir,
  baseDir: dir,
});
const collect = (engine: Engine, dir: string, now: number) =>
  collectOperatorViewInput(sourceOf(engine, dir), { warnings: [], baseDir: dir }, { now });

const evidence = (
  e: Engine,
  a: { id: string; token: string },
  phase: 'candidate' | 'integration',
  at: string,
  gate: string,
  kind: 'test' | 'review' = 'test',
) =>
  e.evidence(a.id, a.token, {
    kind,
    phase,
    sha: at,
    gate,
    passed: true,
    command: ['npm', 'run', gate],
    exitCode: 0,
    log: '',
    digest: digestOf(phase + gate),
    summary: 'ok',
    ...(kind === 'review' ? { findings: [] } : {}),
  });

test('view alpha.55: lastFailure, blockers plain/actor и verification приходят из настоящего status', () => {
  const env = engineOf();
  const { engine } = env;
  ready(engine, graphOf({ w: [], x: ['w'] }));
  const first = engine.claim('c1')!;
  engine.fail(first.id, first.token, 'Порт 3000 занят до начала фазы, токен sk-secret', {
    kind: 'environment',
    blocked: true,
  });
  env.clock.now += 1000;
  engine.resume();
  engine.retry('w', { reason: 'порт освобождён' });
  const second = engine.claim('c1')!;
  assert.ok(second);

  const running = operatorView(collect(engine, env.dir, env.clock.now));
  operatorViewSchema.parse(running);
  const w = running.works.find((r) => r.id === 'w')!;
  const x = running.works.find((r) => r.id === 'x')!;
  assert.equal(w.attempts.lastFailure?.plain, 'окружение — порт 3000 занят');
  assert.equal(w.attempts.lastFailure?.bucket, 'environment');
  assert.ok(!JSON.stringify(running).includes('sk-secret'));
  const dep = x.blockers.find((b) => b.code === 'NOT_READY');
  assert.ok(dep?.plain, 'простой текст блокировки из status');
  assert.match(dep.plain, /w/);
  assert.ok(dep.actor, 'кто снимает блокировку');
  const en = operatorView(collect(engine, env.dir, env.clock.now), { lang: 'en' });
  assert.equal(
    en.works.find((r) => r.id === 'w')!.attempts.lastFailure?.plain,
    'environment — port 3000 is busy',
  );

  engine.phase(second.id, second.token, 'verifying', { baseSha: sha('c'), candidateSha: sha('a') });
  evidence(engine, second, 'candidate', sha('a'), 'unit');
  evidence(engine, second, 'candidate', sha('a'), 'independent-review', 'review');
  engine.phase(second.id, second.token, 'integrating', { integrationSha: sha('b') });
  evidence(engine, second, 'integration', sha('b'), 'unit');
  evidence(engine, second, 'integration', sha('b'), 'independent-review', 'review');
  engine.finish(second.id, second.token, sha('b'));

  const detail = workDetailView(collect(engine, env.dir, env.clock.now), 'w');
  workDetailViewSchema.parse(detail);
  const rows = (detail.verification ?? []).map((r) => [r.gate, r.kind, r.phase, r.result]);
  assert.deepEqual(
    rows.filter((r) => r[0] === 'unit'),
    [
      ['unit', 'gate', 'candidate', 'passed'],
      ['unit', 'gate', 'integration', 'passed'],
    ],
  );
  assert.ok(
    rows.some((r) => r[1] === 'review'),
    'строка ревью попытки из status.works[].verification',
  );
  env.store.close();
});

const question = (impact?: 'technical'): InputQuestion => ({
  question: 'Какую библиотеку дат взять?',
  options: [
    {
      id: 'native',
      label: 'Intl без зависимостей',
      consequence: null,
      forUser: 'Для пользователя ничего не меняется',
    },
    { id: 'lib', label: 'date-fns', consequence: 'ещё одна зависимость', forUser: null },
  ],
  recommended: 'native',
  severity: 8,
  rationale: 'Выбор внутри реализации',
  affects: [],
  ...(impact ? { impact } : {}),
});

function stopped(q: InputQuestion, technical: boolean) {
  const env = engineOf(
    policyOf((p) => {
      if (technical) p.inputPolicy = { threshold: 7, leadAnswers: { technical: true } };
    }),
  );
  ready(env.engine, graphOf({ w: [] }));
  const a = env.engine.claim('c1')!;
  env.engine.fail(a.id, a.token, 'вопрос', {
    kind: 'needs-input',
    input: {
      question: { question: q, effectiveSeverity: q.severity, floors: [], mode: 'request' },
      assumptions: [],
      followUps: [],
      criticalHits: [],
      callId: 'call-1',
    },
  });
  return env;
}

test('view alpha.55: технический вопрос при leadAnswers.technical — ведущему, forUser — простой текст', () => {
  const env = stopped(question('technical'), true);
  const view = operatorView(collect(env.engine, env.dir, env.clock.now));
  operatorViewSchema.parse(view);
  assert.deepEqual(
    view.questions.map((q) => [q.workId, q.impact, q.answerableBy, q.plain]),
    [['w', 'technical', 'operator-or-lead', 'Для пользователя ничего не меняется']],
  );
  env.store.close();

  // Без правила technical — тот же технический вопрос только человеку.
  const strict = stopped(question('technical'), false);
  const human = operatorView(collect(strict.engine, strict.dir, strict.clock.now));
  assert.deepEqual(
    human.questions.map((q) => [q.impact, q.answerableBy]),
    [['technical', 'operator']],
  );
  strict.store.close();

  // Вопрос без impact — для пользователя, человеку даже при правиле technical.
  const visible = stopped(question(), true);
  const user = operatorView(collect(visible.engine, visible.dir, visible.clock.now));
  assert.deepEqual(
    user.questions.map((q) => [q.impact, q.answerableBy]),
    [['user-visible', 'operator']],
  );
  visible.store.close();
});
