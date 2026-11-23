/**
 * Представление оператора, ревизия 2 (alpha.57): лента «кто что делал»
 * (`activity[]`) и удалённая ветка принятой работы (`works[].target.remote`).
 * Лента проверяется на синтетическом входе (окно, порядок, предел, языки,
 * маскирование) и на настоящем движке (вопрос исполнителя, ответ ведущего,
 * неудачная попытка — из записей хранилища, а не из пересказа). Удалённая
 * ветка на настоящем git — в accepted-target.test.ts.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import {
  OPERATOR_VIEW_LIMITS,
  operatorViewSchema,
  workDetailViewSchema,
  type AttemptState,
  type InputQuestion,
} from '../src/contracts/index.ts';
import {
  activityInputOf,
  collectOperatorViewInput,
  type ViewSource,
} from '../src/control/operator-view.ts';
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
    inspection: 'diff-only',
  },
  {
    kind: 'review',
    at: at(26),
    scope: 'attempt',
    subject: 'w',
    workId: 'w',
    attempt: 3,
    phase: 'integration',
    approved: true,
    blocking: 0,
    reviewer: 'claude',
    inspection: 'commands',
    commands: 3,
  },
  {
    kind: 'review',
    at: at(25),
    scope: 'code',
    subject: 'c'.repeat(64),
    label: 'app/dev main..feature',
    round: 1,
    approved: true,
    blocking: 0,
    reviewer: 'codex',
  },
  {
    kind: 'gate',
    at: at(24),
    workId: 'w',
    attempt: 3,
    gate: 'e2e',
    phase: 'candidate',
    passed: false,
    notLaunched: true,
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
  assert.equal(view.viewRevision, 7);
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
  // Что делал reviewer — только по записи controller; без записи фраза молчит.
  const approved = a.filter((x) => x.action === 'review.approved').map((x) => x.plain);
  assert.deepEqual(approved, [
    'reviewer codex одобрил код app/dev main..feature, раунд 1',
    'reviewer claude одобрил изменения работы w (попытка 3, интеграция); запускал команды: 3',
    'reviewer codex одобрил изменения работы w (попытка 3, кандидат); читал diff, ничего не запускал',
  ]);
  assert.equal(
    by('gate.not-launched').plain,
    'проверка e2e не запустилась — отказ среды, проверки не было (работа w, попытка 3, кандидат)',
  );
  assert.equal(
    a.filter((x) => x.action === 'gate.failed').length,
    1,
    'незапуск — не провал проверки',
  );
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
  // Опущены самые старые: все 8 событий 6 минут назад и 2 из 8 событий 5
  // минут назад — при равном времени остаются первые по фразе.
  const ids = (min: number) => many.filter((e) => e.at === at(min)).map((e) => e.workId!);
  const kept = new Set(view.activity!.map((x) => x.workId));
  for (const id of ids(6)) assert.ok(!kept.has(id), id);
  for (const m of [0, 1, 2, 3, 4]) for (const id of ids(m)) assert.ok(kept.has(id), id);
  const phrase = (id: string) => `контроллер запустил попытку 1 работы ${id}; пишет claude`;
  const five = ids(5).sort((x, y) => (phrase(x) < phrase(y) ? -1 : 1));
  assert.deepEqual(
    five.filter((id) => kept.has(id)),
    five.slice(0, 6),
  );
  const again = operatorView(baseInput({ activity: [...many].reverse() }));
  assert.deepEqual(again.activity, view.activity, 'порядок входа не меняет ленту');
  assert.equal(again.source.token, view.source.token);

  const none = operatorView(baseInput());
  assert.equal(none.activity, undefined, 'производитель без ленты — поля нет, а не пустая лента');
  const empty = operatorView(baseInput({ activity: [] }));
  assert.deepEqual(empty.activity, []);

  // Границы окна: ровно начало окна и `now` — внутри; раньше начала и позже `now` — нет.
  const from = NOW - 86_400_000;
  const edge = (t: number, id: string): OperatorActivityInput => ({
    kind: 'attempt.started',
    at: new Date(t).toISOString(),
    workId: id,
    attempt: 1,
    runtime: 'claude',
  });
  const bounded = operatorView(
    baseInput({
      activity: [
        edge(from, 'start'),
        edge(from - 1, 'before'),
        edge(NOW, 'now'),
        edge(NOW + 1, 'future'),
      ],
    }),
  );
  assert.deepEqual(
    bounded.activity!.map((x) => x.workId),
    ['now', 'start'],
  );

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
            line: 'принято локально; ещё нет в удалённой ветке origin/main',
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
  assert.equal(remote('local').line, 'принято локально; ещё нет в удалённой ветке origin/main');
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
  // Без суффикса «не расходуется»: возврат попытки за вопрос решает движок
  // по своему пределу, и лента его не утверждает.
  assert.equal(
    failed.plain,
    'попытка 1 работы w не удалась: вопрос исполнителя — исполнитель задал вопрос',
  );
  const answered = view.activity!.find((x) => x.action === 'question.answered')!;
  assert.equal(answered.subject, request!.id);
  assert.match(answered.plain, /\(технический вопрос\)$/);
  // Причина ведущего — в основании ответа, не в ленте: лента без свободного текста ответа.
  assert.ok(!JSON.stringify(view.activity).includes('без зависимости'));
  env.store.close();
});

test('view r2: лента — фразы, совпавшие после обрезки, не зависят от порядка входа и на пределе', () => {
  const long = 'x'.repeat(190);
  const same: OperatorActivityInput[] = Array.from({ length: 51 }, (_, k) => ({
    kind: 'attempt.started',
    at: at(1),
    workId: `${long}${String(k).padStart(2, '0')}`,
    attempt: 1,
    runtime: 'claude',
  }));
  const one = operatorView(baseInput({ activity: same }));
  const two = operatorView(baseInput({ activity: [...same].reverse() }));
  assert.equal(new Set(one.activity!.map((x) => x.plain)).size, 1, 'фразы совпали после обрезки');
  assert.deepEqual(two.activity, one.activity);
  assert.equal(two.source.token, one.source.token);
  // На пределе опущено одно и то же событие: последнее по сырым полям.
  assert.deepEqual(
    one.activity!.map((x) => x.workId),
    same.slice(0, 50).map((e) => e.workId),
  );
});

test('view r2: ответ оператора и хоста — свой исполнитель и фраза', () => {
  const view = operatorView(
    baseInput({
      activity: [
        { kind: 'question.answered', at: at(3), workId: 'w', requestId: 'IR-2', by: 'operator' },
        { kind: 'question.answered', at: at(2), workId: 'w', requestId: 'IR-3', by: 'host' },
      ],
    }),
    { lang: 'en' },
  );
  assert.deepEqual(
    view.activity!.map((x) => [x.actor, x.plain]),
    [
      ['host', 'the host answered question IR-3 on w'],
      ['operator', 'the operator answered question IR-2 on w'],
    ],
  );
});

test('view r2: события из записей попытки — незапуск gate, что делал reviewer, перепроверка и перенос', () => {
  const base = {
    id: 'run-1',
    workId: 'w',
    repositoryId: 'app',
    attempt: 2,
    runtime: 'claude',
    reviewer: 'codex',
    status: 'failed',
    failureKind: 'gate',
    startedAt: at(30),
    finishedAt: at(20),
    candidateSha: sha('a'),
  };
  const ev = (over: Record<string, unknown>) => ({
    id: `e-${String(over.gate)}-${String(over.createdAt)}`,
    runId: 'run-1',
    kind: 'test',
    phase: 'candidate',
    sha: sha('a'),
    passed: true,
    createdAt: at(25),
    command: [],
    exitCode: 0,
    log: '',
    digest: 'd'.repeat(64),
    summary: 'код выхода 0',
    ...over,
  });
  const attemptState = {
    ...base,
    evidence: [
      ev({ gate: 'unit', passed: false, exitCode: 1, summary: 'код выхода 1' }),
      ev({
        gate: 'e2e',
        passed: false,
        summary: 'песочница ОС не запустила команду: отказ запуска',
      }),
      ev({ gate: 'unit', createdAt: at(24), recheck: { of: 'e-unit', outcome: 'flaky' } }),
      ev({
        gate: 'independent-review',
        kind: 'review',
        createdAt: at(23),
        inspection: {
          mode: 'commands',
          source: 'controller-probes',
          commands: [],
          reason: null,
          total: 2,
        },
      }),
      ev({
        gate: 'independent-review',
        kind: 'review',
        phase: 'integration',
        createdAt: at(22),
        inspection: { mode: 'diff-only', source: 'unavailable', commands: [], reason: null },
      }),
    ],
  } as unknown as AttemptState;
  const events = activityInputOf([attemptState], [], [], []);
  const view = operatorView(baseInput({ activity: events }));
  const plain = (action: string) =>
    view.activity!.filter((x) => x.action === action).map((x) => x.plain);
  assert.deepEqual(plain('gate.not-launched'), [
    'проверка e2e не запустилась — отказ среды, проверки не было (работа w, попытка 2, кандидат)',
  ]);
  assert.deepEqual(plain('gate.failed'), [
    'контроллер запустил проверку unit: не прошла (работа w, попытка 2, кандидат)',
  ]);
  assert.equal(plain('gate.recheck').length, 1);
  // Запись без источника наблюдения (`source: unavailable`) — неизвестно, а не «ничего не запускал».
  assert.deepEqual(plain('review.approved'), [
    'reviewer codex одобрил изменения работы w (попытка 2, интеграция)',
    'reviewer codex одобрил изменения работы w (попытка 2, кандидат); запускал команды: 2',
  ]);
  assert.match(
    plain('attempt.failed')[0]!,
    /^попытка 2 работы w не удалась: дефект — не прошли проверки/,
  );
});

test('view r2: записи — перенос с кандидата, невалидное ревью, исходы попыток, ветка из попытки, эпизоды эскалации', () => {
  const attemptOf = (over: Record<string, unknown>) =>
    ({
      workId: 'w',
      repositoryId: 'app',
      runtime: 'claude',
      reviewer: 'codex',
      startedAt: at(40),
      finishedAt: at(35),
      evidence: [],
      ...over,
    }) as unknown as AttemptState;
  const ev = (over: Record<string, unknown>) => ({
    id: `e-${String(over.id ?? over.createdAt)}`,
    runId: 'r1',
    kind: 'test',
    phase: 'integration',
    sha: sha('b'),
    gate: 'unit',
    passed: true,
    createdAt: at(36),
    command: [],
    exitCode: 0,
    log: '',
    digest: 'd'.repeat(64),
    summary: 'код выхода 0',
    ...over,
  });
  const attempts = [
    attemptOf({ id: 'r1', attempt: 1, status: 'cancelled' }),
    attemptOf({ id: 'r2', attempt: 2, status: 'expired', startedAt: at(34), finishedAt: at(33) }),
    attemptOf({
      id: 'r3',
      attempt: 3,
      status: 'failed',
      interrupted: 'shutdown',
      startedAt: at(32),
      finishedAt: at(31),
    }),
    attemptOf({
      id: 'r4',
      attempt: 4,
      status: 'succeeded',
      startedAt: at(30),
      finishedAt: at(20),
      integrationSha: sha('b'),
      // Ветка при выдаче; политика с тех пор могла смениться.
      pinned: { targetRef: 'refs/heads/before' },
      evidence: [
        ev({
          id: 'reuse',
          runId: 'r4',
          reusedEvidence: { evidenceId: 'x', phase: 'candidate', sha: sha('a'), tree: sha('c') },
        }),
        ev({
          id: 'bad-review',
          runId: 'r4',
          kind: 'review',
          gate: 'independent-review',
          passed: false,
          reviewRound: { protocol: 'invalid' },
        }),
      ],
    }),
  ];
  const plan = (round: number, disposition?: Record<string, unknown>) =>
    ({
      kind: 'plan',
      subject: 'g1',
      round,
      at: at(60 - round),
      approved: false,
      reviewerRuntime: 'codex',
      findings: [
        {
          id: 'F1',
          severity: 'blocking',
          status: 'open',
          rounds: round,
          ...(disposition ? { disposition } : {}),
        },
      ],
    }) as never;
  // F1 ждёт решения с раунда 3; «продолжать» после раунда 3 записывает
  // прежний счёт (3, как движок); снова ждёт с раунда 6 — вторая эскалация.
  // У другого предмета (g2) своя находка F1 — свои эпизоды.
  const cont = { decision: 'continue', by: 'operator', round: 4, rounds: 3 };
  const other = (round: number) => ({ ...(plan(round) as object), subject: 'g2' }) as never;
  const rows = [
    plan(1),
    other(1),
    plan(2),
    other(2),
    plan(3),
    other(3),
    plan(4, cont),
    other(4),
    plan(5, cont),
    plan(6, cont),
    plan(7, cont),
  ];
  const events = activityInputOf(attempts, rows, [], []);
  const view = operatorView(baseInput({ activity: events }));
  operatorViewSchema.parse(view);
  const plain = (action: string) =>
    view.activity!.filter((x) => x.action === action).map((x) => x.plain);
  assert.deepEqual(plain('attempt.cancelled'), [
    'попытка 1 работы w отменена: оператор — попытку отменили',
  ]);
  assert.deepEqual(plain('attempt.expired'), [
    'попытка 2 работы w потеряла владельца: окружение — процесс попытки пропал (владение истекло); попытка не расходуется',
  ]);
  assert.deepEqual(plain('attempt.interrupted'), [
    'попытка 3 работы w прервана остановкой; попытка не расходуется',
  ]);
  assert.deepEqual(plain('work.accepted'), [
    `работа w принята (попытка 4): ${sha('b').slice(0, 12)} в refs/heads/before, локально`,
  ]);
  assert.equal(plain('gate.reused').length, 1);
  assert.equal(plain('gate.passed').length, 0, 'перенесённая запись — не запуск');
  assert.equal(
    view.activity!.filter((x) => x.actor === 'reviewer' && x.workId === 'w').length,
    0,
    'ответ reviewer не по протоколу — не раунд и не вердикт',
  );
  const esc = (subject: string) =>
    view.activity!.filter((x) => x.action === 'review.escalated' && x.subject === subject);
  assert.deepEqual(
    esc('g1').map((x) => x.at),
    [at(60 - 6), at(60 - 3)],
    'две эскалации g1: раунды 3 и 6',
  );
  assert.deepEqual(
    esc('g2').map((x) => x.at),
    [at(60 - 3)],
    'g2 ждёт с раунда 3 без перерыва — одна эскалация',
  );
});

test('view r2: токен меняется вместе с лентой', () => {
  const one = operatorView(baseInput({ activity: events }));
  const two = operatorView(baseInput({ activity: events.slice(1) }));
  assert.notEqual(two.source.token, one.source.token);
});
