/**
 * Влияние вопроса исполнителя (0.1.0-alpha.55): технический вопрос или
 * меняющий результат для пользователя. Технический вопрос ведущий решает сам
 * только с явного согласия политики (`inputPolicy.leadAnswers.technical`) и с
 * причиной; вопрос для пользователя и вопрос с минимумом — только человеку.
 * Ответ ведущего на технический вопрос виден как «решено ведущим (технический
 * вопрос)» в status, explain, пакете передачи и отчёте; doctor называет
 * действующее правило словами.
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HarnessError,
  cliDataSchemas,
  executionPolicySchema,
  implementationResultSchema,
  answerDigest,
  inputAnswerSchema,
  inputPolicySchema,
  inputRequestSchema,
  leadAnswerBasis,
  leadAnswersRule,
  type InputFloor,
  type InputOutcome,
  type InputQuestion,
} from '../src/contracts/index.ts';
import { implementationOutputSchema } from '../src/agents/schemas.ts';
import {
  evaluateInput,
  inputPolicyText,
  normalizeImplementation,
} from '../src/engine/input-policy.ts';
import { inputContextSource } from '../src/engine/input-requests.ts';
import { statusOf, statusText } from '../src/control/status.ts';
import { doctor } from '../src/control/doctor.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { handoffPack } from '../src/handoff/pack.ts';
import { handoffMarkdown } from '../src/handoff/markdown.ts';
import { collectReportInput } from '../src/control/report.ts';
import { reportMarkdown, valueReport } from '../src/report/index.ts';
import { engineOf, graphOf, policyOf, ready } from './engine-fixture.ts';

const question = (impact?: 'technical' | 'user-visible' | null): InputQuestion => ({
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
  ...(impact === undefined ? {} : { impact }),
});

const outcome = (q: InputQuestion, floors: InputFloor[] = []): InputOutcome => ({
  question: {
    question: q,
    effectiveSeverity: floors.length ? 10 : q.severity,
    floors,
    mode: 'request',
  },
  assumptions: [],
  followUps: [],
  criticalHits: [],
  callId: 'call-1',
});

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    return e.code;
  }
};

const noJobs = { list: () => [], continues: () => false };

/** Граф w; попытка остановилась блокирующим вопросом `q` при политике `inputPolicy`. */
function stopped(
  q: InputQuestion,
  inputPolicy: Record<string, unknown> | undefined,
  floors: InputFloor[] = [],
) {
  const env = engineOf(
    policyOf((p) => {
      if (inputPolicy) p.inputPolicy = inputPolicy;
    }),
  );
  ready(env.engine, graphOf({ w: [] }));
  const attempt = env.engine.claim('c1')!;
  env.engine.fail(attempt.id, attempt.token, 'вопрос', {
    kind: 'needs-input',
    input: outcome(q, floors),
  });
  const [request] = env.engine.inputRequests({ workId: 'w' });
  return { ...env, attempt, request: request! };
}

const TECHNICAL = { threshold: 7, leadAnswers: { technical: true } };

/** Вопрос, поднятый ответом writer вне схемы через нормализацию и оценку. */
const normalizedBasis = (inputRequest: Record<string, unknown>) => {
  const out = normalizeImplementation({ completed: false, summary: 's', inputRequest })!;
  const decision = evaluateInput(out.output, { threshold: 7, criticalPaths: [] }, []).decision as {
    question: { question: InputQuestion; effectiveSeverity: number; floors: InputFloor[] };
  };
  return leadAnswerBasis(
    { kind: 'question', blocking: true, ...decision.question },
    { leadAnswers: { technical: true } },
  );
};

test('alpha.55: запрос writer объясняет классификацию; wire-схема объявляет impact и forUser с null', () => {
  const text = inputPolicyText({ threshold: 7, criticalPaths: [] });
  assert.match(text, /`impact`: "technical" only when no option changes what the users/);
  assert.match(text, /When unsure, use "user-visible"/);
  assert.match(text, /`forUser`: one short sentence in plain words/);
  const q = (implementationOutputSchema.properties.inputRequest as { required: string[] }).required;
  assert.ok(q.includes('impact'));
  const option = (
    implementationOutputSchema.properties.inputRequest as unknown as {
      properties: { options: { items: { required: string[] } } };
    }
  ).properties.options.items.required;
  assert.ok(option.includes('forUser'));
  // Ответ writer с null проходит договор; канонический вопрос null не хранит.
  const parsed = implementationResultSchema.parse({
    completed: false,
    summary: 's',
    inputRequest: question(null),
  });
  const evaluated = evaluateInput(parsed, { threshold: 7, criticalPaths: [] }, []);
  assert.equal(evaluated.decision.kind, 'stop');
  const stored = (evaluated.decision as { question: { question: InputQuestion } }).question
    .question;
  assert.equal('impact' in stored, false);
  assert.equal('forUser' in stored.options[1]!, false);
  assert.equal(stored.options[0]!.forUser, 'Для пользователя ничего не меняется');
  // Технический — сохраняется.
  const technical = evaluateInput(
    implementationResultSchema.parse({
      completed: false,
      summary: 's',
      inputRequest: question('technical'),
    }),
    { threshold: 7, criticalPaths: [] },
    [],
  );
  assert.equal(
    (technical.decision as { question: { question: InputQuestion } }).question.question.impact,
    'technical',
  );
});

test('alpha.55: ответ вне схемы — impact вне перечня снят (вопрос человеку), forUser усечён', () => {
  const out = normalizeImplementation({
    completed: false,
    summary: 's',
    inputRequest: {
      ...question(),
      impact: 'internal',
      options: [{ id: 'a b', label: 'A', consequence: null, forUser: 'x'.repeat(400) }],
    },
  })!;
  assert.ok(out);
  assert.equal(out.output.inputRequest?.impact, undefined);
  assert.equal(out.output.inputRequest?.options[0]?.forUser?.length, 300);
  assert.ok(out.issues.some((i) => /влияние вопроса вне перечня/.test(i)));
  const ok = normalizeImplementation({
    completed: false,
    summary: 's',
    inputRequest: { ...question('technical'), severity: 'x' },
  })!;
  assert.equal(ok.output.inputRequest?.impact, 'technical');
  // Область строкой или объектом не теряет минимум: технический вопрос о
  // критической области ведущему не достаётся.
  assert.equal(normalizedBasis({ ...question('technical'), affects: 'product' }), null);
  assert.equal(normalizedBasis({ ...question('technical'), affects: { product: true } }), null);
  assert.equal(normalizedBasis({ ...question('technical'), affects: ['Public API'] }), null);
  assert.equal(normalizedBasis({ ...question('technical'), affects: [] }), 'technical');
});

test('alpha.55: политика — leadAnswers нужен maxSeverity или technical: true; правило словами', () => {
  assert.equal(inputPolicySchema.safeParse({ leadAnswers: {} }).success, false);
  assert.equal(inputPolicySchema.safeParse({ leadAnswers: { technical: false } }).success, false);
  assert.equal(inputPolicySchema.safeParse({ leadAnswers: { technical: true } }).success, true);
  assert.equal(
    inputPolicySchema.safeParse({ leadAnswers: { technical: true, maxSeverity: 4 } }).success,
    true,
  );
  assert.match(leadAnswersRule({}).ru, /отвечает человек/);
  const technical = leadAnswersRule({ leadAnswers: { technical: true } });
  assert.match(technical.ru, /^Технические вопросы .* ведущий решает сам и записывает причину/);
  assert.match(technical.ru, /меняют результат для пользователя.*— человеку/);
  assert.match(technical.en, /the lead decides technical questions/i);
  const both = leadAnswersRule({ leadAnswers: { technical: true, maxSeverity: 4 } });
  assert.match(both.ru, /серьёзность не выше 4 из 10\. Вопросы, которые меняют результат/);
  // Правило: технический без минимумов; пользовательский и критический — человек.
  const r = (impact: InputQuestion['impact'], floors: InputFloor[], effectiveSeverity = 8) => ({
    kind: 'question' as const,
    blocking: true,
    effectiveSeverity,
    floors,
    question: { impact },
  });
  const pol = { leadAnswers: { technical: true as const } };
  assert.equal(leadAnswerBasis(r('technical', []), pol), 'technical');
  assert.equal(leadAnswerBasis(r('technical', ['declared'], 10), pol), null);
  assert.equal(leadAnswerBasis(r('technical', ['critical-path'], 10), pol), null);
  assert.equal(leadAnswerBasis(r('user-visible', []), pol), null);
  assert.equal(leadAnswerBasis(r(undefined, []), pol), null);
  assert.equal(leadAnswerBasis(r(undefined, []), {}), null);
  // Сочетание: с technical вопрос для пользователя — человеку при любом пороге;
  // порог дополнительно ограничивает технические.
  const combined = { leadAnswers: { technical: true as const, maxSeverity: 8 } };
  assert.equal(leadAnswerBasis(r(undefined, []), combined), null);
  assert.equal(leadAnswerBasis(r('user-visible', [], 3), combined), null);
  assert.equal(leadAnswerBasis(r('technical', []), combined), 'technical');
  assert.equal(leadAnswerBasis(r('technical', [], 9), combined), null);
  const top = { leadAnswers: { technical: true as const, maxSeverity: 10 } };
  assert.equal(leadAnswerBasis(r('user-visible', [], 10), top), null);
  assert.equal(leadAnswerBasis(r('technical', ['declared'], 10), top), null);
  // Без technical — правило alpha.54 по порогу.
  assert.equal(leadAnswerBasis(r(undefined, []), { leadAnswers: { maxSeverity: 8 } }), 'severity');
  // Опубликованная JSON Schema политики держит то же правило (не теряет refine).
  const policySchema = JSON.parse(
    readFileSync(new URL('../schemas/execution-policy.schema.json', import.meta.url), 'utf8'),
  ) as unknown;
  const found: unknown[] = [];
  JSON.stringify(policySchema, (k, v: unknown) => {
    if (k === 'leadAnswers') found.push(v);
    return v;
  });
  const variants = (
    found[0] as { anyOf: { required: string[]; properties: { technical: unknown } }[] }
  ).anyOf;
  assert.deepEqual(
    variants.map((v) => v.required),
    [['maxSeverity'], ['technical']],
  );
  assert.deepEqual(variants[1]!.properties.technical, { type: 'boolean', const: true });
  // Неблокирующий — всегда.
  assert.equal(
    leadAnswerBasis({ ...r(undefined, []), kind: 'follow-up', blocking: false }, {}),
    'non-blocking',
  );
});

test('alpha.55: ведущий решает технический вопрос только с причиной; запись basis и reason', () => {
  const env = stopped(question('technical'), TECHNICAL);
  const id = env.request.id;
  assert.equal(env.request.question.impact, 'technical');
  // Без причины — INVALID_INPUT без записи.
  assert.equal(
    code(() => env.engine.answerInput(id, { text: 'Intl', actor: { kind: 'lead' } }, 1)),
    'INVALID_INPUT',
  );
  assert.equal(
    code(() =>
      env.engine.answerInput(id, { text: 'Intl', actor: { kind: 'lead' }, reason: '  ' }, 1),
    ),
    'INVALID_INPUT',
  );
  assert.equal(env.engine.inputRequest(id).version, 1);
  const r = env.engine.answerInput(
    id,
    { text: 'Intl', optionId: 'native', actor: { kind: 'lead' }, reason: 'без новой зависимости' },
    1,
  );
  const answer = r.request.answers[0]!;
  assert.equal(answer.basis, 'technical');
  assert.equal(answer.reason, 'без новой зависимости');
  inputRequestSchema.parse(r.request);
  // Причина не входит в digest ответа: тот же ответ оператора — тот же digest.
  const other = stopped(question('technical'), undefined);
  const op = other.engine.answerInput(
    other.request.id,
    { text: 'Intl', optionId: 'native', actor: { kind: 'operator' } },
    1,
  );
  assert.equal(op.request.answers[0]!.basis, undefined);
  assert.equal(op.request.answers[0]!.reason, undefined);
  // Digest ответа — от содержания (запрос, версия, текст, вариант, вид), без
  // правила и причины: тот же, что у ответа прежней версии.
  assert.equal(
    answer.digest,
    answerDigest(id, { revision: 1, text: 'Intl', optionId: 'native', kind: 'clarification' }),
  );
  // Повтор с той же причиной — тот же ответ; другая причина — новая версия.
  const same = env.engine.answerInput(
    id,
    { text: 'Intl', optionId: 'native', actor: { kind: 'lead' }, reason: 'без новой зависимости' },
    2,
  );
  assert.equal(same.changed, false);
  const corrected = env.engine.answerInput(
    id,
    { text: 'Intl', optionId: 'native', actor: { kind: 'lead' }, reason: 'меньше пакета' },
    2,
  );
  assert.equal(corrected.changed, true);
  assert.equal(corrected.answer.reason, 'меньше пакета');
  assert.equal(corrected.answer.revision, 2);
  // Запись с правилом без ведущего или техническая без причины — вне договора.
  assert.equal(
    inputAnswerSchema.safeParse({ ...answer, actor: { kind: 'operator' } }).success,
    false,
  );
  const { reason: _r, ...noReason } = answer;
  void _r;
  assert.equal(inputAnswerSchema.safeParse(noReason).success, false);
  // Контекст writer называет решение ведущего и причину.
  const source = inputContextSource(r.request, answer);
  const md = source.files.find((f) => f.path.endsWith('.md'))!;
  assert.match(
    (md.content as { data: string }).data,
    /Decided by the lead \(technical question\): без новой зависимости/,
  );
  assert.match(
    (md.content as { data: string }).data,
    /\(for the user: Для пользователя ничего не меняется\)/,
  );
  env.store.close();
  other.store.close();
});

test('alpha.55: вопрос для пользователя и технический с минимумом — OPERATOR_ANSWER_REQUIRED при technical', () => {
  const visible = stopped(question('user-visible'), TECHNICAL);
  let error: HarnessError | undefined;
  try {
    visible.engine.answerInput(
      visible.request.id,
      { text: 'x', actor: { kind: 'lead' }, reason: 'r' },
      1,
    );
  } catch (e) {
    error = e as HarnessError;
  }
  assert.equal(error?.code, 'OPERATOR_ANSWER_REQUIRED');
  assert.match(error.message, /меняет результат для пользователя/);
  const absent = stopped(question(), TECHNICAL);
  assert.equal(
    code(() =>
      absent.engine.answerInput(
        absent.request.id,
        { text: 'x', actor: { kind: 'lead' }, reason: 'r' },
        1,
      ),
    ),
    'OPERATOR_ANSWER_REQUIRED',
  );
  const critical = stopped(question('technical'), TECHNICAL, ['critical-path']);
  try {
    critical.engine.answerInput(
      critical.request.id,
      { text: 'x', actor: { kind: 'lead' }, reason: 'r' },
      1,
    );
    assert.fail('ожидался отказ');
  } catch (e) {
    assert.equal((e as HarnessError).code, 'OPERATOR_ANSWER_REQUIRED');
    assert.match((e as HarnessError).message, /критической области или пути/);
  }
  // Без согласия политики технический вопрос — тоже человеку.
  const off = stopped(question('technical'), undefined);
  assert.equal(
    code(() =>
      off.engine.answerInput(
        off.request.id,
        { text: 'x', actor: { kind: 'lead' }, reason: 'r' },
        1,
      ),
    ),
    'OPERATOR_ANSWER_REQUIRED',
  );
  // Человек отвечает на любой из них как прежде.
  assert.equal(
    visible.engine.answerInput(visible.request.id, { text: 'x', actor: { kind: 'operator' } }, 1)
      .changed,
    true,
  );
  for (const e of [visible, absent, critical, off]) e.store.close();
});

test('alpha.55: «решено ведущим (технический вопрос)» — в status, explain, пакете передачи и отчёте', () => {
  const env = stopped(question('technical'), TECHNICAL);
  const { engine } = env;
  const policy = engine.policy;
  const source = { engine, policy, workflows: noJobs };
  const diagnose = () =>
    stopInputsOf(source, { maxAttempts: policy.maxAttempts, repairBudget: policy.repairBudget })
      .filter((i) => i.kind === 'work')
      .map(explainStop)[0]!;
  // До ответа: ведущему можно, и это видно.
  const before = cliDataSchemas.status.parse(statusOf(source));
  assert.equal(before.works[0]!.input?.impact, 'technical');
  assert.equal(before.works[0]!.input?.leadMay, 'technical');
  assert.deepEqual(before.works[0]!.stage?.needs, { actor: 'lead', action: 'answer-input' });
  assert.match(statusText(before), /технический вопрос — решает ведущий/);
  const waiting = diagnose();
  assert.deepEqual([waiting.actor, waiting.action], ['lead', 'answer-input']);
  assert.match(waiting.message, /--actor lead --reason/);

  engine.answerInput(
    env.request.id,
    { text: 'Intl', optionId: 'native', actor: { kind: 'lead' }, reason: 'без зависимости' },
    1,
  );
  const after = cliDataSchemas.status.parse(statusOf(source));
  assert.equal(after.works[0]!.input?.answerBasis, 'technical');
  assert.equal(after.works[0]!.input?.leadMay, undefined);
  assert.match(
    statusText(after),
    /серьёзность 8, технический\]: решено ведущим \(технический вопрос\)/,
  );
  assert.match(
    diagnose().message,
    /\(решено ведущим \(технический вопрос\): без зависимости\) записан, но не применён/,
  );

  const pack = handoffPack(source);
  cliDataSchemas.handoff.parse(pack);
  assert.equal(pack.inputs?.[0]?.impact, 'technical');
  assert.equal(pack.inputs?.[0]?.answer?.basis, 'technical');
  assert.equal(pack.inputs?.[0]?.answer?.reason, 'без зависимости');
  assert.match(handoffMarkdown(pack), /решено ведущим \(технический вопрос\): без зависимости/);
  assert.match(handoffMarkdown(pack), /серьёзность 8, технический\]/);

  const report = valueReport(collectReportInput(env.store), {
    stateDir: env.dir,
    harnessVersion: 'test',
    asOf: '2026-01-02T00:00:00.000Z',
  });
  assert.deepEqual(report.inputs?.answeredBy, { operator: 0, lead: 1, host: 0, leadTechnical: 1 });
  assert.match(
    reportMarkdown(report),
    /by the lead agent 1 — of them decided by the lead as technical questions 1/,
  );
  env.store.close();
});

test('alpha.55: без правила technical вопрос для пользователя адресован человеку, как в alpha.54', () => {
  const env = stopped(question(), undefined);
  const source = { engine: env.engine, policy: env.engine.policy, workflows: noJobs };
  const status = cliDataSchemas.status.parse(statusOf(source));
  assert.equal(status.works[0]!.input?.impact, undefined);
  assert.equal(status.works[0]!.input?.leadMay, undefined);
  assert.match(statusText(status), /ждёт ответа человека/);
  const d = stopInputsOf(source, { maxAttempts: 3, repairBudget: 2 })
    .filter((i) => i.kind === 'work')
    .map(explainStop)[0]!;
  assert.equal(d.actor, 'user');
  env.store.close();
});

test('alpha.55: doctor --policy называет правило ответов словами', async () => {
  const off = await doctor(policyOf(), {});
  assert.equal(off.questions?.leadTechnical, false);
  assert.match(off.questions.line, /отвечает человек/);
  const on = await doctor(
    executionPolicySchema.parse({
      ...policyOf(),
      inputPolicy: { threshold: 7, criticalPaths: [], leadAnswers: { technical: true } },
    }),
    {},
  );
  assert.equal(on.questions?.leadTechnical, true);
  assert.match(on.questions.line, /Технические вопросы/);
  cliDataSchemas.doctor.parse(on);
  assert.equal((await doctor(undefined, {})).questions, undefined);
});
