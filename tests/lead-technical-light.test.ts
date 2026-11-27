/**
 * alpha.72, P9-1: в облегчённом режиме технические вопросы исполнителя по
 * умолчанию решает ведущий с причиной — и с самооценкой 10, если вопрос о
 * внутреннем договоре или программном интерфейсе. Вопросы о продукте, приёмке
 * и критических путях остаются у человека; строгий режим не меняется.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HarnessError,
  cliDataSchemas,
  inputPolicyOf,
  leadAnswerBasis,
  leadAnswersRule,
  leadAnswersSourceOf,
  type InputFloor,
  type InputOutcome,
  type InputQuestion,
} from '../src/contracts/index.ts';
import { evaluateInput, inputPolicyText } from '../src/engine/input-policy.ts';
import { decisionSettings } from '../src/projections/decisions.ts';
import { statusOf } from '../src/control/status.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { engineOf, graphOf, policyOf, ready } from './engine-fixture.ts';

/** Вопрос пилота 9: как получить секреты до первого env-up (технический, 10, contract). */
const secretsQuestion = (patch: Partial<InputQuestion> = {}): InputQuestion => ({
  question: 'Как обеспечить секреты до первого harness env-up?',
  options: [
    {
      id: 'controller_secrets',
      label: 'Контроллер генерирует секреты до env-up',
      consequence: 'Lead обеспечивает генерацию и передачу секретов',
      forUser: 'Для пользователей приложения ничего не меняется.',
    },
    {
      id: 'support_initializer',
      label: 'Разрешить предварительный генератор в test/support',
      consequence: 'Writer добавляет генератор секретов в test/support',
      forUser: 'Для пользователей приложения ничего не меняется.',
    },
  ],
  recommended: 'controller_secrets',
  severity: 10,
  rationale: 'Источник секретов — общий контракт для compose, API и worker.',
  affects: ['contract'],
  impact: 'technical',
  ...patch,
});

/** Оценка controller: та же, что даёт попытке `evaluateInput`. */
function rated(q: InputQuestion, changed: string[] = [], criticalPaths: string[] = []) {
  const d = evaluateInput(
    { completed: false, inputRequest: q, assumptions: [] },
    { threshold: 7, criticalPaths },
    changed,
  ).decision;
  if (d.kind !== 'stop') assert.fail('ожидалась остановка');
  return d.question;
}

const basis = (
  q: InputQuestion,
  policy: Parameters<typeof inputPolicyOf>[0],
  changed: string[] = [],
  criticalPaths: string[] = [],
) =>
  leadAnswerBasis(
    { kind: 'question', blocking: true, ...rated(q, changed, criticalPaths) },
    inputPolicyOf(policy),
  );

const light = (inputPolicy?: Record<string, unknown>) =>
  policyOf((p) => {
    p.harnessMode = 'light';
    if (inputPolicy) p.inputPolicy = inputPolicy;
  });
const strict = (inputPolicy?: Record<string, unknown>) =>
  policyOf((p) => {
    p.harnessMode = 'strict';
    if (inputPolicy) p.inputPolicy = inputPolicy;
  });

test('alpha.72: облегчённый режим — умолчание ответов ведущего; явное правило и строгий режим главнее', () => {
  assert.deepEqual(inputPolicyOf(light()).leadAnswers, {
    technical: true,
    technicalAreas: ['internal', 'migration'],
  });
  assert.equal(leadAnswersSourceOf(light()), 'light-default');
  // Явное `technical: true` без областей получает области облегчённого режима.
  assert.deepEqual(
    inputPolicyOf(light({ leadAnswers: { technical: true, maxSeverity: 9 } })).leadAnswers,
    { technical: true, maxSeverity: 9, technicalAreas: ['internal', 'migration'] },
  );
  assert.deepEqual(
    inputPolicyOf(light({ leadAnswers: { technical: true, technicalAreas: [] } })).leadAnswers,
    { technical: true, technicalAreas: [] },
  );
  assert.deepEqual(inputPolicyOf(light({ leadAnswers: { technical: false } })).leadAnswers, {
    technical: false,
  });
  assert.equal(leadAnswersSourceOf(light({ leadAnswers: { technical: false } })), 'policy');
  // Строгий режим — без умолчания и без областей.
  assert.equal(inputPolicyOf(strict()).leadAnswers, undefined);
  assert.equal(leadAnswersSourceOf(strict()), 'default');
  assert.deepEqual(inputPolicyOf(strict({ leadAnswers: { technical: true } })).leadAnswers, {
    technical: true,
  });
  // Правило словами называет области.
  assert.match(leadAnswersRule(inputPolicyOf(light())).ru, /внутреннем устройстве кода/);
  assert.match(leadAnswersRule(inputPolicyOf(strict())).ru, /отвечает человек/);
  // Настройки решений: значение действующее, источник — умолчание.
  const item = (p: ReturnType<typeof light>) =>
    decisionSettings(p).items.find((i) => i.key === 'inputPolicy.leadAnswers.technical')!;
  assert.deepEqual([item(light()).value, item(light()).source], [true, 'default']);
  assert.deepEqual([item(strict()).value, item(strict()).source], [false, 'default']);
  const off = item(light({ leadAnswers: { technical: false } }));
  assert.deepEqual([off.value, off.source], [false, 'policy']);
});

test('alpha.72: вопросы пилота 9 — договор и API у владельца, внутренняя развилка у ведущего', () => {
  // Секреты до env-up в пилоте: severity 10, contract → минимум declared, владелец (ревью H1).
  assert.deepEqual(rated(secretsQuestion()).floors, ['declared']);
  assert.equal(basis(secretsQuestion(), light()), null);
  // Сериализация File[] в SDK: contract и api — тоже владелец.
  assert.equal(basis(secretsQuestion({ affects: ['contract', 'api'] }), light()), null);
  // Та же развилка, названная внутренней, — ведущему.
  const internal = secretsQuestion({ affects: ['internal'] });
  assert.deepEqual(rated(internal).floors, ['declared']);
  assert.equal(basis(internal, light()), 'technical');
  // `internal` сама минимума не ставит: severity 8 — без минимумов.
  assert.deepEqual(rated(secretsQuestion({ severity: 8, affects: ['internal'] })).floors, []);
  // internal вместе с критической областью — владелец.
  assert.equal(basis(secretsQuestion({ affects: ['internal', 'contract'] }), light()), null);
  // Самооценка 10 без области — владелец (ревью M3).
  assert.equal(basis(secretsQuestion({ affects: [] }), light()), null);
  // Владелец назвал договор и API явно — ведущему.
  const listed = light({
    leadAnswers: { technical: true, technicalAreas: ['internal', 'contract', 'api'] },
  });
  assert.equal(basis(secretsQuestion(), listed), 'technical');
  assert.equal(basis(secretsQuestion({ affects: ['contract', 'api'] }), listed), 'technical');
  // Строгий режим — прежнее правило, даже с явным согласием.
  assert.equal(basis(internal, strict()), null);
  assert.equal(basis(internal, strict({ leadAnswers: { technical: true } })), null);
  assert.equal(
    basis(
      secretsQuestion({ severity: 8, affects: [] }),
      strict({ leadAnswers: { technical: true } }),
    ),
    'technical',
  );
  // Явный отказ и прежнее правило без областей в облегчённом режиме.
  assert.equal(basis(internal, light({ leadAnswers: { technical: false } })), null);
  assert.equal(
    basis(internal, light({ leadAnswers: { technical: true, technicalAreas: [] } })),
    null,
  );
  // Миграция (alpha.74, P10-5) — у ведущего по умолчанию; явный список без неё — владелец.
  const migration = secretsQuestion({ affects: ['migration'] });
  assert.equal(basis(migration, light()), 'technical');
  assert.equal(
    basis(migration, light({ leadAnswers: { technical: true, technicalAreas: ['internal'] } })),
    null,
  );
  // Запрос writer объясняет область internal рядом с критическими.
  const text = inputPolicyText({ threshold: 7, criticalPaths: [] });
  assert.match(text, /name it `internal` in `affects`/);
  assert.match(text, /changes no approved contract, public API, data model or security/);
});

test('alpha.72: продукт, приёмка, видимое пользователю и критический путь — человеку и в облегчённом режиме', () => {
  for (const area of ['product', 'acceptance'] as const)
    assert.equal(basis(secretsQuestion({ affects: ['contract', area] }), light()), null, area);
  assert.equal(basis(secretsQuestion({ impact: 'user-visible' }), light()), null);
  const noImpact = secretsQuestion();
  delete noImpact.impact;
  assert.equal(basis(noImpact, light()), null);
  // Попытка изменила критический путь политики: минимум critical-path.
  const hit = rated(secretsQuestion({ affects: [] }), ['db/schema.sql'], ['db']);
  assert.deepEqual(hit.floors.sort(), ['critical-path', 'declared']);
  assert.equal(
    basis(secretsQuestion({ affects: ['internal'] }), light(), ['db/schema.sql'], ['db']),
    null,
  );
  // Серьёзность выше явного maxSeverity — человеку.
  assert.equal(
    basis(
      secretsQuestion({ affects: ['internal'] }),
      light({ leadAnswers: { technical: true, maxSeverity: 9 } }),
    ),
    null,
  );
});

const outcome = (q: InputQuestion): InputOutcome => {
  const r = rated(q);
  return {
    question: { ...r, mode: 'request' },
    assumptions: [],
    followUps: [],
    criticalHits: [],
    callId: 'call-1',
  };
};

function stopped(q: InputQuestion, policy: ReturnType<typeof light>) {
  const env = engineOf(policy);
  ready(env.engine, graphOf({ w: [] }));
  const attempt = env.engine.claim('c1')!;
  env.engine.fail(attempt.id, attempt.token, 'вопрос', { kind: 'needs-input', input: outcome(q) });
  const [request] = env.engine.inputRequests({ workId: 'w' });
  return { ...env, request: request! };
}

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof HarnessError) return e;
    throw e;
  }
  assert.fail('ожидался отказ');
};

test('alpha.72: input-answer --actor lead — принят в облегчённом режиме с причиной; status и explain называют ведущего', () => {
  const env = stopped(secretsQuestion({ affects: ['internal'] }), light());
  const source = {
    engine: env.engine,
    policy: env.engine.policy,
    workflows: { list: () => [], continues: () => false },
  };
  const status = cliDataSchemas.status.parse(statusOf(source));
  assert.equal(status.works[0]!.input?.leadMay, 'technical');
  assert.deepEqual(status.works[0]!.stage?.needs, { actor: 'lead', action: 'answer-input' });
  const stop = stopInputsOf(source, { maxAttempts: 3, repairBudget: 2 })
    .filter((i) => i.kind === 'work')
    .map(explainStop)[0]!;
  assert.deepEqual([stop.actor, stop.action], ['lead', 'answer-input']);
  // Без причины — INVALID_INPUT; с причиной — ответ ведущего по правилу technical.
  assert.equal(
    refusal(() => env.engine.answerInput(env.request.id, { text: 'x', actor: { kind: 'lead' } }, 1))
      .code,
    'INVALID_INPUT',
  );
  const r = env.engine.answerInput(
    env.request.id,
    {
      text: 'Секреты генерирует harness (attemptEnv.secrets)',
      optionId: 'controller_secrets',
      actor: { kind: 'lead' },
      reason: 'тестовые секреты не меняют продукт',
    },
    1,
  );
  assert.equal(r.request.answers[0]!.basis, 'technical');
  env.store.close();

  // Строгий режим — прежний отказ с объяснением.
  const old = stopped(secretsQuestion({ affects: ['internal'] }), strict());
  const e = refusal(() =>
    old.engine.answerInput(old.request.id, { text: 'x', actor: { kind: 'lead' }, reason: 'r' }, 1),
  );
  assert.equal(e.code, 'OPERATOR_ANSWER_REQUIRED');
  old.store.close();
  // Облегчённый режим, вопрос о продукте — отказ называет области ведущего.
  const product = stopped(secretsQuestion({ affects: ['product'] }), light());
  const p = refusal(() =>
    product.engine.answerInput(
      product.request.id,
      { text: 'x', actor: { kind: 'lead' }, reason: 'r' },
      1,
    ),
  );
  assert.equal(p.code, 'OPERATOR_ANSWER_REQUIRED');
  assert.match(p.message, /кроме internal/);
  // Вопрос пилота о договоре — тоже владельцу.
  const contract = stopped(secretsQuestion(), light());
  assert.equal(
    refusal(() =>
      contract.engine.answerInput(
        contract.request.id,
        { text: 'x', actor: { kind: 'lead' }, reason: 'r' },
        1,
      ),
    ).code,
    'OPERATOR_ANSWER_REQUIRED',
  );
  contract.store.close();
  product.store.close();
});

test('alpha.72: floors без affects (вызов прежней версии) — технический путь с минимумом закрыт', () => {
  const policy = inputPolicyOf(light());
  const floors: InputFloor[] = ['declared'];
  assert.equal(
    leadAnswerBasis(
      {
        kind: 'question',
        blocking: true,
        effectiveSeverity: 10,
        floors,
        question: { impact: 'technical' },
      },
      policy,
    ),
    null,
  );
});

test('alpha.74, P10-5: технический вопрос о миграции с самооценкой 10 — ведущему в облегчённом и тонком режимах', () => {
  const thin = (inputPolicy?: Record<string, unknown>) =>
    policyOf((p) => {
      p.harnessMode = 'thin';
      if (inputPolicy) p.inputPolicy = inputPolicy;
    });
  // Вопрос пилота 10: impact technical, severity 10, affects migration — минимум declared.
  const migration = secretsQuestion({
    question: 'Как перенести старые записи в новую таблицу?',
    rationale: 'Миграция внутренняя: формат для пользователя не меняется.',
    affects: ['migration'],
  });
  assert.deepEqual(rated(migration).floors, ['declared']);
  for (const p of [light(), thin(), thin({ leadAnswers: { technical: true } })])
    assert.equal(basis(migration, p), 'technical');
  assert.equal(basis(secretsQuestion({ affects: ['internal', 'migration'] }), thin()), 'technical');
  // Договор, API, продукт, приёмка, видимое пользователю, критический путь — владельцу.
  for (const affects of [
    ['migration', 'contract'],
    ['migration', 'api'],
    ['migration', 'product'],
    ['acceptance'],
  ] as const)
    assert.equal(basis(secretsQuestion({ affects: [...affects] }), thin()), null, affects.join());
  assert.equal(
    basis(secretsQuestion({ affects: ['migration'], impact: 'user-visible' }), thin()),
    null,
  );
  assert.equal(basis(migration, thin(), ['db/schema.sql'], ['db']), null);
  // Строгий режим и явный отказ не меняются.
  assert.equal(basis(migration, strict({ leadAnswers: { technical: true } })), null);
  assert.equal(basis(migration, thin({ leadAnswers: { technical: false } })), null);
  // Движок принимает ответ ведущего с причиной.
  const env = stopped(migration, thin());
  const r = env.engine.answerInput(
    env.request.id,
    {
      text: 'Перенести записи одним шагом миграции',
      optionId: 'controller_secrets',
      actor: { kind: 'lead' },
      reason: 'миграция внутренняя, пользователь видит те же данные',
    },
    1,
  );
  assert.equal(r.request.answers[0]!.basis, 'technical');
  env.store.close();
  assert.match(leadAnswersRule(inputPolicyOf(thin())).ru, /миграции данных/);
});
