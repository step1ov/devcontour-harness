/**
 * Представление оператора, ревизия 2 (alpha.57): лента «кто что делал»
 * (`activity[]`) и удалённая ветка принятой работы (`works[].target.remote`).
 * Лента проверяется на синтетическом входе (окно, порядок, предел, языки,
 * маскирование) и на настоящем движке (вопрос исполнителя, ответ ведущего,
 * неудачная попытка — из записей хранилища, а не из пересказа). Удалённая
 * ветка на настоящем git — в accepted-target.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import {
  OPERATOR_VIEW_LIMITS,
  operatorViewSchema,
  workDetailViewSchema,
  type InputQuestion,
} from '../src/contracts/index.ts';
import { collectOperatorViewInput, type ViewSource } from '../src/control/operator-view.ts';
import type { WorkflowQueue } from '../src/control/workflow.ts';
import { operatorView, workDetailView } from '../src/projections/index.ts';
import type { OperatorActivityInput } from '../src/projections/operator-view.ts';
import type { Engine } from '../src/engine/engine.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';
import { NOW, at, baseInput, work } from './operator-view-input.ts';

const events: OperatorActivityInput[] = [
  { kind: 'attempt.started', at: at(50), workId: 'w', attempt: 1, runtime: 'claude' },
  {
    kind: 'gate',
    at: at(45),
    workId: 'w',
    attempt: 1,
    gate: 'test',
    phase: 'candidate',
    passed: false,
  },
  {
    kind: 'attempt.ended',
    at: at(44),
    workId: 'w',
    attempt: 1,
    outcome: 'failed',
    reason: { ru: 'дефект — не прошли проверки: test', en: 'defect — gates failed: test' },
  },
  {
    kind: 'attempt.ended',
    at: at(43),
    workId: 'w',
    attempt: 2,
    outcome: 'failed',
    reason: { ru: 'окружение — порт 3000 занят', en: 'environment — port 3000 is busy' },
    uncounted: true,
  },
  {
    kind: 'gate',
    at: at(30),
    workId: 'w',
    attempt: 3,
    gate: 'test',
    phase: 'integration',
    passed: true,
    recheck: 'flaky',
  },
  {
    kind: 'gate',
    at: at(29),
    workId: 'w',
    attempt: 3,
    gate: 'lint',
    phase: 'integration',
    passed: true,
    reused: true,
  },
  {
    kind: 'review',
    at: at(28),
    scope: 'attempt',
    subject: 'w',
    workId: 'w',
    attempt: 3,
    phase: 'candidate',
    approved: true,
    blocking: 0,
    reviewer: 'codex',
  },
  {
    kind: 'review',
    at: at(27),
    scope: 'plan',
    subject: 'g1',
    round: 2,
    approved: false,
    blocking: 2,
    reviewer: 'codex',
  },
  {
    kind: 'review.escalated',
    at: at(27),
    scope: 'plan',
    subject: 'g1',
    findings: 1,
    round: 4,
  },
  { kind: 'question.asked', at: at(20), workId: 'w', requestId: 'IR-1', severity: 8 },
  {
    kind: 'question.answered',
    at: at(19),
    workId: 'w',
    requestId: 'IR-1',
    by: 'lead',
    basis: 'technical',
  },
  {
    kind: 'work.accepted',
    at: at(10),
    workId: 'w',
    attempt: 3,
    sha: sha('c'),
    ref: 'refs/heads/main',
  },
  // Вне окна (больше суток назад) — в ленту не попадает.
  { kind: 'attempt.started', at: at(25 * 60), workId: 'old', attempt: 1, runtime: 'codex' },
];

test('view r2: лента — события окна новыми сверху, кто и что простыми словами', () => {
  const view = operatorView(baseInput({ works: [work('w')], activity: events }));
  operatorViewSchema.parse(view);
  assert.equal(view.viewRevision, 2);
  const a = view.activity!;
  assert.equal(a.length, events.length - 1, 'событие вне окна опущено');
  assert.ok(!a.some((x) => x.workId === 'old'));
  for (let k = 1; k < a.length; k++)
    assert.ok(Date.parse(a[k - 1]!.at) >= Date.parse(a[k]!.at), 'новые сверху');
  const by = (action: string) => a.find((x) => x.action === action)!;
  assert.deepEqual(by('work.accepted'), {
    at: at(10),
    actor: 'controller',
    action: 'work.accepted',
    workId: 'w',
    plain: `работа w принята (попытка 3): ${sha('c').slice(0, 12)} в refs/heads/main, локально`,
  });
  assert.equal(by('question.answered').actor, 'lead');
  assert.equal(
    by('question.answered').plain,
    'ведущий ответил на вопрос IR-1 по работе w (технический вопрос)',
  );
  assert.equal(by('question.asked').actor, 'writer');
  assert.equal(by('question.asked').subject, 'IR-1');
  assert.equal(by('review.changes-requested').actor, 'reviewer');
  assert.equal(
    by('review.changes-requested').plain,
    'reviewer codex вернул план g1: блокирующих замечаний 2, раунд 2',
  );
  assert.match(by('review.approved').plain, /читал diff, ничего не запускал$/);
  assert.equal(by('review.escalated').subject, 'g1');
  assert.equal(
    by('gate.failed').plain,
    'контроллер запустил проверку test: не прошла (работа w, попытка 1, кандидат)',
  );
  assert.match(by('gate.recheck').plain, /^перепроверка test прошла: первый провал был случайным/);
  assert.match(by('gate.reused').plain, /не запускалась/);
  const failed = a.filter((x) => x.action === 'attempt.failed').map((x) => x.plain);
  assert.deepEqual(failed, [
    'попытка 2 работы w не удалась: окружение — порт 3000 занят; попытка не расходуется',
    'попытка 1 работы w не удалась: дефект — не прошли проверки: test',
  ]);
  assert.deepEqual([...new Set(a.map((x) => x.actor))].sort(), [
    'controller',
    'lead',
    'reviewer',
    'writer',
  ]);

  const en = operatorView(baseInput({ works: [work('w')], activity: events }), { lang: 'en' });
  const enBy = (action: string) => en.activity!.find((x) => x.action === action)!;
  assert.equal(
    enBy('question.answered').plain,
    'the lead answered question IR-1 on w (technical question)',
  );
  assert.equal(
    enBy('attempt.started').plain,
    'the controller started attempt 1 of w; claude writes',
  );
  assert.ok(!JSON.stringify(en.activity).match(/[а-яё]/i), 'английская лента без русских слов');
});

test('view r2: лента — предел 50 и счёт опущенного; одинаковое время — детерминированный порядок; нет ленты — нет поля', () => {
  const many: OperatorActivityInput[] = Array.from({ length: 60 }, (_, k) => ({
    kind: 'attempt.started',
    at: at(k % 7),
    workId: `w${k}`,
    attempt: 1,
    runtime: 'claude',
  }));
  const view = operatorView(baseInput({ activity: many }));
  operatorViewSchema.parse(view);
  assert.equal(view.activity!.length, OPERATOR_VIEW_LIMITS.activity);
  assert.equal(view.truncated?.activity, 10);
  assert.ok(view.health.warnings.some((w) => w.code === 'VIEW_TRUNCATED'));
  // Самые старые (6 минут назад) опущены первыми.
  assert.ok(view.activity!.every((x) => Date.parse(x.at) >= NOW - 6 * 60_000));
  const again = operatorView(baseInput({ activity: [...many].reverse() }));
  assert.deepEqual(again.activity, view.activity, 'порядок входа не меняет ленту');
  assert.equal(again.source.token, view.source.token);

  const none = operatorView(baseInput());
  assert.equal(none.activity, undefined, 'производитель без ленты — поля нет, а не пустая лента');
  const empty = operatorView(baseInput({ activity: [] }));
  assert.deepEqual(empty.activity, []);

  // Окно 7 дней видит событие суточной давности.
  const week = operatorView(baseInput({ activity: events }), { windowMs: 7 * 86_400_000 });
  assert.ok(week.activity!.some((x) => x.workId === 'old'));
});

test('view r2: лента маскирует свободный текст (refs ревью кода) и укладывается в предел строки', () => {
  const view = operatorView(
    baseInput({
      activity: [
        {
          kind: 'review',
          at: at(5),
          scope: 'code',
          subject: 'd'.repeat(64),
          label: `app/dev ${homedir()}/x..feature/token=ghp_${'A'.repeat(36)}`,
          round: 1,
          approved: true,
          blocking: 0,
          reviewer: 'codex',
        },
        {
          kind: 'gate',
          at: at(4),
          workId: 'w'.repeat(190),
          attempt: 1,
          gate: 'g'.repeat(190),
          phase: 'candidate',
          passed: true,
        },
      ],
      mask: { home: homedir() },
    }),
  );
  operatorViewSchema.parse(view);
  const s = JSON.stringify(view.activity);
  assert.ok(!s.includes(homedir()), s);
  assert.ok(!s.includes('A'.repeat(36)), s);
  assert.ok(view.activity!.every((x) => x.plain.length <= 200));
});

test('view r2: удалённая ветка принятой работы — состояние, имя, время и строка на языке представления', () => {
  const target = {
    repositoryId: 'app',
    ref: 'refs/heads/main',
    acceptedSha: sha('a'),
    head: sha('a'),
    commitsSinceAccepted: 0,
    filesSinceAccepted: 0,
  };
  const input = baseInput({
    works: [
      work('pushed', {
        status: 'done',
        target: {
          ...target,
          remote: {
            state: 'pushed',
            trackingRef: 'origin/main',
            checkedAt: at(60),
            line: 'уже в удалённой ветке origin/main',
            lineEn: 'already on the remote branch origin/main',
          },
        },
      }),
      work('local', {
        status: 'done',
        target: {
          ...target,
          remote: {
            state: 'not-pushed',
            trackingRef: 'origin/main',
            line: 'принято локально; в удалённой ветке origin/main ещё нет',
            lineEn: 'accepted locally; not yet on the remote branch origin/main',
          },
        },
      }),
      work('none', {
        status: 'done',
        target: {
          ...target,
          remote: {
            state: 'unknown',
            reason: 'нет удалённой ветки',
            reasonEn: 'no remote branch',
            line: 'неизвестно (нет удалённой ветки)',
            lineEn: 'unknown (no remote branch)',
          },
        },
      }),
    ],
  });
  const view = operatorView(input);
  operatorViewSchema.parse(view);
  const remote = (id: string, v = view) => v.works.find((w) => w.id === id)!.target!.remote;
  assert.deepEqual(remote('pushed'), {
    state: 'pushed',
    trackingRef: 'origin/main',
    checkedAt: at(60),
    line: 'уже в удалённой ветке origin/main',
  });
  assert.equal(remote('local').state, 'not-pushed');
  assert.equal(remote('local').line, 'принято локально; в удалённой ветке origin/main ещё нет');
  assert.deepEqual(remote('none'), {
    state: 'unknown',
    reason: 'нет удалённой ветки',
    line: 'неизвестно (нет удалённой ветки)',
  });
  const en = operatorView(input, { lang: 'en' });
  assert.equal(remote('none', en).reason, 'no remote branch');
  assert.equal(
    remote('local', en).line,
    'accepted locally; not yet on the remote branch origin/main',
  );
  const detail = workDetailView(input, 'local');
  workDetailViewSchema.parse(detail);
  assert.equal(detail.work.target!.remote.state, 'not-pushed');
});

const noJobs = { list: () => [], continues: () => false } as unknown as WorkflowQueue;
const sourceOf = (engine: Engine, dir: string): ViewSource => ({
  engine,
  policy: engine.policy,
  workflows: noJobs,
  stateDir: dir,
  baseDir: dir,
});

test('view r2: лента из записей движка — ревью плана, попытка, вопрос исполнителя, ответ ведущего', () => {
  const env = engineOf(
    policyOf((p) => {
      p.inputPolicy = { threshold: 7, leadAnswers: { technical: true } };
    }),
  );
  ready(env.engine, graphOf({ w: [] }));
  const a = env.engine.claim('c1')!;
  const question: InputQuestion = {
    question: 'Какую библиотеку дат взять?',
    options: [
      { id: 'native', label: 'Intl', consequence: null, forUser: 'ничего не меняется' },
      { id: 'lib', label: 'date-fns', consequence: 'зависимость', forUser: null },
    ],
    recommended: 'native',
    severity: 8,
    rationale: 'Выбор внутри реализации',
    affects: [],
    impact: 'technical',
  };
  env.engine.fail(a.id, a.token, 'вопрос', {
    kind: 'needs-input',
    input: {
      question: { question, effectiveSeverity: 8, floors: [], mode: 'request' },
      assumptions: [],
      followUps: [],
      criticalHits: [],
      callId: 'call-1',
    },
  });
  const [request] = env.engine.inputRequests({ workId: 'w' });
  env.engine.answerInput(
    request!.id,
    { text: 'Intl', optionId: 'native', actor: { kind: 'lead' }, reason: 'без зависимости' },
    1,
  );
  const collect = () =>
    collectOperatorViewInput(
      sourceOf(env.engine, env.dir),
      { warnings: [], baseDir: env.dir },
      { now: env.clock.now },
    );
  const view = operatorView(collect());
  operatorViewSchema.parse(view);
  const actions = view.activity!.map((x) => `${x.actor} ${x.action}`);
  assert.deepEqual(
    [...actions].sort(),
    [
      'controller attempt.failed',
      'controller attempt.started',
      'lead question.answered',
      // Одобрение плана графа при подготовке (`ready`): раунд ревью плана из записи ревью.
      'reviewer review.approved',
      'writer question.asked',
    ],
    actions.join('\n'),
  );
  const failed = view.activity!.find((x) => x.action === 'attempt.failed')!;
  assert.equal(failed.workId, 'w');
  assert.match(
    failed.plain,
    /^попытка 1 работы w не удалась: вопрос исполнителя — исполнитель задал вопрос/,
  );
  const answered = view.activity!.find((x) => x.action === 'question.answered')!;
  assert.equal(answered.subject, request!.id);
  assert.match(answered.plain, /\(технический вопрос\)$/);
  // Причина ведущего — в основании ответа, не в ленте: лента без свободного текста ответа.
  assert.ok(!JSON.stringify(view.activity).includes('без зависимости'));
  env.store.close();
});
