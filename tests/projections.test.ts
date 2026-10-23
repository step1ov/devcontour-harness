import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureKinds, pauseReasons, workStatuses } from '../src/contracts/execution.ts';
import * as root from '../src/index.ts';
import {
  activeStatuses,
  chainRoots,
  clipDeep,
  clipText,
  nextAction,
  queueStop,
  stopCauses,
  workProgress,
  type ChainWork,
  type NextInput,
  type NextView,
  type ProgressInput,
  type WorkStatus,
} from '../src/projections/index.ts';

const work = (
  id: string,
  status: WorkStatus,
  dependsOn: string[] = [],
  extra: Partial<ChainWork> = {},
): ChainWork => ({ id, status, dependsOn, attempt: 0, ...extra });

test('H1-05: корень пакета и ./projections экспортируют одну реализацию', () => {
  assert.equal(root.chainRoots, chainRoots);
  assert.equal(root.workProgress, workProgress);
  assert.equal(root.nextAction, nextAction);
  assert.equal(root.queueStop, queueStop);
  assert.equal(root.clipDeep, clipDeep);
});

test('H1-05: литералы перечней проекций совпадают с договором', () => {
  assert.deepEqual(activeStatuses, ['running', 'verifying', 'reviewing', 'integrating']);
  for (const s of activeStatuses) assert.ok((workStatuses as readonly string[]).includes(s), s);
  assert.deepEqual(stopCauses.slice(0, failureKinds.length), [...failureKinds]);
  assert.deepEqual(stopCauses.slice(failureKinds.length), [
    'runtime-missing',
    'controller-busy',
    'operator-pause',
    'approval-required',
    'not-ready',
  ]);
});

test('AC09: OP-DIAG-01 корень с исчерпанным бюджетом держит цепочку из трёх', () => {
  const roots = chainRoots(
    [
      work('root', 'failed', [], { attempt: 3 }),
      work('a', 'ready', ['root']),
      work('b', 'ready', ['a']),
      work('c', 'ready', ['b']),
      work('done', 'done'),
      work('free', 'ready', ['done']),
    ],
    3,
  );
  assert.deepEqual(roots, [
    {
      workId: 'root',
      code: 'failed-exhausted',
      waiting: 3,
      actor: 'user',
      action: 'reset-attempts',
    },
  ]);
});

test('AC09: OP-DIAG-01 черновик, удержание и отмена; идущая работа не корень', () => {
  const roots = chainRoots(
    [
      work('d', 'draft'),
      work('h', 'ready', [], { hold: { operation: 'op', reason: 'Меняется контракт X' } }),
      work('x', 'cancelled'),
      work('r', 'running'),
      work('w1', 'ready', ['d']),
      work('w2', 'ready', ['h']),
      work('w3', 'ready', ['x']),
      work('w4', 'ready', ['r']),
    ],
    3,
  );
  assert.deepEqual(roots, [
    { workId: 'd', code: 'draft', waiting: 1, actor: 'lead', action: 'review-plan' },
    {
      workId: 'h',
      code: 'held',
      waiting: 1,
      actor: 'controller',
      action: 'wait',
      detail: 'Меняется контракт X',
    },
    { workId: 'x', code: 'cancelled', waiting: 1, actor: 'lead', action: 'replan-dependents' },
  ]);
});

test('AC09: OP-DIAG-01 ромб — зависимая работа считается у корня один раз', () => {
  // top ← l, r ← bottom: bottom доходит до top двумя путями.
  const roots = chainRoots([
    work('top', 'failed', [], { attempt: 1, failureKind: 'gate' }),
    work('l', 'ready', ['top']),
    work('r', 'ready', ['top']),
    work('bottom', 'ready', ['l', 'r']),
  ]);
  assert.deepEqual(roots, [
    {
      workId: 'top',
      code: 'failed',
      waiting: 3,
      actor: 'controller',
      action: 'retry',
      failureKind: 'gate',
    },
  ]);
});

test('AC09: OP-DIAG-01 бюджет, исчерпанные попытки, активный прогон и неизвестная зависимость', () => {
  const roots = chainRoots(
    [
      work('b', 'ready', [], { budgetBlock: { reason: 'предел стоимости' }, attempt: 1 }),
      work('bx', 'ready', [], { budgetBlock: { reason: 'предел стоимости' }, attempt: 3 }),
      work('e', 'ready', [], { attempt: 3 }),
      work('ok', 'ready', [], { attempt: 2 }),
      work('run', 'failed', [], { activeRunId: 'run-1', attempt: 3 }),
      work('w1', 'ready', ['b']),
      work('w2', 'ready', ['bx']),
      work('w3', 'ready', ['e']),
      work('w4', 'ready', ['ok']),
      work('w5', 'ready', ['run']),
      work('w6', 'ready', ['missing']),
    ],
    3,
  );
  assert.deepEqual(roots, [
    {
      workId: 'b',
      code: 'budget-blocked',
      waiting: 1,
      actor: 'user',
      action: 'raise-budget',
      detail: 'предел стоимости',
    },
    {
      workId: 'bx',
      code: 'attempts-exhausted',
      waiting: 1,
      actor: 'user',
      action: 'reset-attempts',
    },
    {
      workId: 'e',
      code: 'attempts-exhausted',
      waiting: 1,
      actor: 'user',
      action: 'reset-attempts',
    },
  ]);
  // failureKind копируется только для failed-кодов.
  const held = chainRoots([
    work('h', 'ready', [], { hold: { operation: 'op', reason: 'r' }, failureKind: 'gate' }),
    work('w', 'ready', ['h']),
  ]);
  assert.equal(held[0]?.failureKind, undefined);
  assert.deepEqual(chainRoots([]), []);
});

const progress = (over: Partial<ProgressInput> & { work: ProgressInput['work'] }) =>
  workProgress({
    statusOf: () => 'done',
    maxAttempts: 3,
    paused: false,
    activeRuns: 0,
    concurrency: 1,
    ...over,
  });

test('AC10: OP-DIAG-02 причины ready-работы в фиксированном порядке', () => {
  const statuses: Record<string, WorkStatus> = { a: 'done', b: 'running' };
  const view = progress({
    work: { status: 'ready', attempt: 3, dependsOn: ['a', 'b', 'gone'] },
    statusOf: (id) => statuses[id],
    paused: true,
    activeRuns: 2,
    concurrency: 2,
  });
  assert.deepEqual(view, {
    dependencies: ['b', 'gone'],
    reasons: ['dependencies-incomplete', 'attempts-exhausted', 'queue-paused', 'workers-busy'],
    eligible: false,
  });
  // Пример context.test.ts: зависимость не готова, очередь на паузе.
  assert.deepEqual(
    progress({
      work: { status: 'ready', attempt: 0, dependsOn: ['a'] },
      statusOf: () => 'ready',
      paused: true,
    }).reasons,
    ['dependencies-incomplete', 'queue-paused'],
  );
});

test('AC10: OP-DIAG-02 draft, failed и eligibility', () => {
  assert.deepEqual(progress({ work: { status: 'draft', attempt: 0, dependsOn: [] } }), {
    dependencies: [],
    reasons: ['plan-review-required'],
    eligible: false,
  });
  assert.deepEqual(progress({ work: { status: 'failed', attempt: 3, dependsOn: [] } }).reasons, [
    'attempts-exhausted',
  ]);
  assert.deepEqual(progress({ work: { status: 'failed', attempt: 2, dependsOn: [] } }).reasons, [
    'failure-requires-diagnosis',
  ]);
  // Для прочих статусов общих причин нет, но выдачи тоже нет.
  assert.deepEqual(progress({ work: { status: 'running', attempt: 1, dependsOn: [] } }), {
    dependencies: [],
    reasons: [],
    eligible: false,
  });
  assert.deepEqual(
    progress({ work: { status: 'ready', attempt: 2, dependsOn: [] }, activeRuns: 0 }),
    { dependencies: [], reasons: [], eligible: true },
  );
  assert.equal(
    progress({
      work: { status: 'ready', attempt: 0, dependsOn: [] },
      hostReasons: ['inactive_revision'],
    }).eligible,
    false,
  );
  assert.equal(
    progress({ work: { status: 'ready', attempt: 0, dependsOn: [] }, hostReasons: [] }).eligible,
    true,
  );
});

test('AC11: OP-DIAG-04 runtime-пауза называет свежую ошибку, operator — нет', () => {
  assert.deepEqual(queueStop({ paused: false, errors: [{ seq: 1, message: 'x' }] }), {
    paused: false,
  });
  const errors = [
    { seq: 2, message: 'TaskFailure: База прогонов отстала' },
    { seq: 1, message: 'Error: старая причина' },
  ];
  assert.deepEqual(queueStop({ paused: true, pauseReason: 'runtime', errors }), {
    paused: true,
    reason: 'runtime',
    detail: 'База прогонов отстала',
  });
  // Порядок входа не важен: решает наибольший seq.
  assert.deepEqual(queueStop({ paused: true, errors: [...errors].reverse() }), {
    paused: true,
    reason: 'runtime',
    detail: 'База прогонов отстала',
  });
  assert.deepEqual(queueStop({ paused: true, errors: [] }), { paused: true, reason: 'runtime' });
  assert.deepEqual(queueStop({ paused: true, pauseReason: 'operator', errors }), {
    paused: true,
    reason: 'operator',
  });
  assert.deepEqual(queueStop({ paused: true, pauseReason: 'base-check', errors }), {
    paused: true,
    reason: 'base-check',
  });
});

test('AC11: M-3 свежая ошибка без сообщения — без detail, без отката к старой', () => {
  for (const latest of [{ seq: 5 }, { seq: 5, message: '' }])
    assert.deepEqual(
      queueStop({
        paused: true,
        pauseReason: 'runtime',
        errors: [{ seq: 4, message: 'Error: прежняя' }, latest],
      }),
      { paused: true, reason: 'runtime' },
    );
});

const next = (over: Partial<NextInput>): NextView =>
  nextAction({ status: 'ready', attempt: 0, maxAttempts: 3, ...over });
const recovery = (
  status: NonNullable<NextInput['recovery']>['status'],
  extra: Partial<NonNullable<NextInput['recovery']>> = {},
): NextInput['recovery'] => ({ status, property: 'P1', ...extra });

test('H1-05: OP-DIAG-03 таблица веток nextAction', () => {
  const decision = {
    action: 'new-approach' as const,
    reason: 'r',
    evidence: [],
    proposal: 'p',
    source: { kind: 'lead' as const },
    decidedAt: '2026-10-23T00:00:00.000Z',
  };
  const cases: [Partial<NextInput>, NextView][] = [
    [
      { status: 'done', recovery: recovery('awaiting-user') },
      { actor: null, action: 'none', step: 'accepted' },
    ],
    [
      { status: 'cancelled', hold: { operation: 'op' } },
      { actor: null, action: 'none', step: 'cancelled' },
    ],
    [
      { recovery: recovery('awaiting-lead') },
      {
        actor: 'lead',
        action: 'recovery-decision',
        step: 'recovery-awaiting-lead',
        property: 'P1',
      },
    ],
    [
      { recovery: recovery('analyzing') },
      { actor: 'lead', action: 'wait', step: 'recovery-analyzing', property: 'P1' },
    ],
    [
      { recovery: recovery('applying') },
      { actor: 'controller', action: 'wait', step: 'recovery-applying' },
    ],
    [
      { recovery: recovery('retry') },
      { actor: 'controller', action: 'wait', step: 'recovery-retry-allowed' },
    ],
    [
      { recovery: recovery('retrying') },
      { actor: 'controller', action: 'wait', step: 'recovery-retrying' },
    ],
    [
      { recovery: recovery('awaiting-user', { reason: 'нужна цель' }) },
      {
        actor: 'user',
        action: 'user-decision',
        step: 'recovery-awaiting-user',
        detail: 'нужна цель',
      },
    ],
    [
      { recovery: recovery('awaiting-user') },
      { actor: 'user', action: 'user-decision', step: 'recovery-awaiting-user' },
    ],
    [
      { recovery: recovery('stopped', { reason: 'стоп', decision }) },
      { actor: 'lead', action: 'user-decision', step: 'recovery-stopped', detail: 'стоп' },
    ],
    [
      { recovery: recovery('stopped', { decision: { ...decision, proposal: undefined } }) },
      { actor: 'user', action: 'user-decision', step: 'recovery-stopped' },
    ],
    // Закрытый эпизод идёт дальше по веткам.
    [
      { recovery: recovery('closed'), status: 'failed', attempt: 3 },
      { actor: 'user', action: 'reset-attempts', step: 'attempts-exhausted' },
    ],
    [
      { recovery: recovery('closed'), waitingAdoption: true, hold: { operation: 'op' } },
      { actor: 'controller', action: 'wait', step: 'corpus-adoption' },
    ],
    [
      { hold: { operation: 'contract-change' }, status: 'draft' },
      { actor: 'controller', action: 'wait', step: 'held', detail: 'contract-change' },
    ],
    [{ status: 'draft' }, { actor: 'lead', action: 'review-plan', step: 'plan-review' }],
    ...activeStatuses.map((status): [Partial<NextInput>, NextView] => [
      { status },
      { actor: 'controller', action: 'wait', step: 'attempt-running' },
    ]),
    [
      { status: 'failed', attempt: 2 },
      { actor: 'controller', action: 'retry', step: 'retry-within-budget' },
    ],
    [
      { status: 'failed', attempt: 4 },
      { actor: 'user', action: 'reset-attempts', step: 'attempts-exhausted' },
    ],
    [{ status: 'ready' }, { actor: 'controller', action: 'wait', step: 'awaiting-claim' }],
  ];
  for (const [input, expected] of cases)
    assert.deepEqual(next(input), expected, JSON.stringify(input));
});

test('AC19: OP-AGENT-01 clipDeep усекает строки и убирает token на любой глубине', () => {
  assert.deepEqual(clipDeep({ a: 'x'.repeat(2001), nested: [{ token: 's', b: 1 }] }), {
    a: 'x'.repeat(2000) + '…',
    nested: [{ b: 1 }],
  });
  assert.equal(clipText('y'.repeat(301)), 'y'.repeat(300) + '…');
  assert.equal(clipText('y'.repeat(300)), 'y'.repeat(300));
  assert.equal(clipText(''), '');
  assert.equal(clipText(undefined), undefined);
});

test('AC11: OP-DIAG-04 только runtime-пауза называет сбой', () => {
  const errors = [{ seq: 1, message: 'Error: сбой' }];
  for (const reason of pauseReasons)
    assert.deepEqual(
      queueStop({ paused: true, pauseReason: reason, errors }),
      reason === 'runtime' ? { paused: true, reason, detail: 'сбой' } : { paused: true, reason },
      reason,
    );
});
