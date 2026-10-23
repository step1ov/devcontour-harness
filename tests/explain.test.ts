/**
 * H1-03 (OP-DIAG-05): `explainStop` по таблицам h1-spec §1.2 и матрице
 * contract-map; входы из сохранённого состояния (`stopInputsOf`); K4 —
 * `retryPlanned` описывает решение `repairDecision`, ничего не планируя.
 * Модели не вызываются: состояния строятся операциями движка.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_OWNER,
  errorCodes,
  failureKinds,
  type ErrorCode,
  type FailureKind,
} from '../src/contracts/index.ts';
import { stopDiagnosisSchema } from '../src/contracts/diagnosis.ts';
import { Harness } from '../src/control/harness.ts';
import { repairDecision } from '../src/engine/repair.ts';
import { explainText } from '../src/explain/diagnose.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import {
  explainStop,
  stopCodeOf,
  type StopDiagnosis,
  type StopInput,
} from '../src/projections/stop.ts';
import { ready } from './engine-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, implement } from './runner-fixture.ts';

type WorkInput = Extract<StopInput, { kind: 'work' }>;
type Patch = {
  work?: Partial<WorkInput['work']>;
  repair?: Partial<WorkInput['repair']>;
  control?: WorkInput['control'];
} & Partial<Omit<WorkInput, 'kind' | 'work' | 'repair' | 'control'>>;

/** Вход поручения: по умолчанию ready, первая попытка, бюджеты свободны, очередь идёт. */
const work = (patch: Patch = {}): WorkInput => ({
  kind: 'work',
  maxAttempts: patch.maxAttempts ?? 3,
  work: { id: 'w1', status: 'ready', attempt: 1, ...patch.work },
  repair: { sameFailureRepairs: 0, groupRepairsUsed: 0, groupRepairBudget: 6, ...patch.repair },
  control: patch.control ?? { paused: false },
  ...(patch.phase ? { phase: patch.phase } : {}),
  ...(patch.runId ? { runId: patch.runId } : {}),
  ...(patch.evidence ? { evidence: patch.evidence } : {}),
});
const failed = (kind: FailureKind | undefined, patch: Patch = {}) =>
  work({
    ...patch,
    work: { status: 'failed', ...(kind ? { failureKind: kind } : {}), ...patch.work },
  });

/** Пять полей решения: code, cause, phase, actor, action. */
const shape = (d: StopDiagnosis) => [d.code, d.cause, d.phase, d.actor, d.action];
const check = (input: StopInput) => {
  const d = explainStop(input);
  stopDiagnosisSchema.parse(d);
  return d;
};

test('H1-03: матрица OP-DIAG-05 — каждая строка даёт code, cause, phase, actor, action и retryPlanned', () => {
  const rows: [string, StopInput, unknown[], boolean][] = [
    [
      'runtime отсутствует (doctor available=false)',
      { kind: 'runtime', runtime: { runtime: 'codex', available: false } },
      ['RUNTIME_UNAVAILABLE', 'runtime-missing', 'preflight', 'user', 'fix-environment'],
      false,
    ],
    [
      'не авторизован / квота (writer)',
      failed('provider-auth', { phase: 'implementation' }),
      ['RUNTIME_UNAVAILABLE', 'provider-auth', 'implementation', 'user', 'fix-access'],
      false,
    ],
    [
      'не авторизован / квота (reviewer)',
      failed('provider-auth', { phase: 'review' }),
      ['RUNTIME_UNAVAILABLE', 'provider-auth', 'review', 'user', 'fix-access'],
      false,
    ],
    [
      'TLS/DNS, повтор разрешён (writer)',
      failed('environment', { phase: 'implementation' }),
      ['RUNTIME_UNAVAILABLE', 'environment', 'implementation', 'controller', 'retry'],
      true,
    ],
    [
      'TLS/DNS, повтор разрешён (reviewer, NET13)',
      failed('environment', { phase: 'review' }),
      ['RUNTIME_UNAVAILABLE', 'environment', 'review', 'controller', 'retry'],
      true,
    ],
    [
      'TLS/DNS, повтор исчерпан',
      failed('environment', { phase: 'implementation', repair: { sameFailureRepairs: 1 } }),
      ['RUNTIME_UNAVAILABLE', 'environment', 'implementation', 'user', 'fix-environment'],
      false,
    ],
    [
      'TLS/DNS у reviewer, повтор исчерпан',
      failed('environment', { phase: 'review', repair: { groupRepairsUsed: 6 } }),
      ['RUNTIME_UNAVAILABLE', 'environment', 'review', 'user', 'fix-environment'],
      false,
    ],
    [
      'отчёт reviewer непригоден',
      failed('review-protocol', { phase: 'review' }),
      ['REVIEW_PROTOCOL_INVALID', 'review-protocol', 'review', 'user', 'user-decision'],
      false,
    ],
    [
      'отчёт writer непригоден (неразобранный вывод)',
      failed('unknown', { phase: 'implementation' }),
      ['INTERNAL', 'unknown', 'implementation', 'user', 'user-decision'],
      false,
    ],
    [
      'gate упал, повтор разрешён',
      failed('gate', { phase: 'gates' }),
      ['GATE_FAILED', 'gate', 'gates', 'controller', 'retry'],
      true,
    ],
    [
      'gate упал, повтор исчерпан',
      failed('gate', { phase: 'gates', repair: { sameFailureRepairs: 2 } }),
      ['GATE_FAILED', 'gate', 'gates', 'lead', 'diagnose-failure'],
      false,
    ],
    [
      'бюджет расходов',
      failed('budget', { phase: 'implementation' }),
      ['BUDGET_EXHAUSTED', 'budget', 'claim', 'user', 'raise-budget'],
      false,
    ],
    [
      'попытки исчерпаны (последний failureKind)',
      failed('gate', { work: { attempt: 3 }, phase: 'gates' }),
      ['ATTEMPTS_EXHAUSTED', 'gate', 'claim', 'user', 'reset-attempts'],
      false,
    ],
    [
      'controller занят',
      { kind: 'error', error: { code: 'CONTROLLER_BUSY', message: 'роль у другого процесса' } },
      ['CONTROLLER_BUSY', 'controller-busy', 'claim', 'lead', 'wait'],
      false,
    ],
    [
      'пауза оператора',
      work({ control: { paused: true, pauseReason: 'operator' } }),
      ['PAUSED', 'operator-pause', 'claim', 'user', 'resume-queue'],
      false,
    ],
  ];
  for (const [label, input, expected, retry] of rows) {
    const d = check(input);
    assert.deepEqual(shape(d), expected, label);
    assert.equal(d.retryPlanned, retry, label);
  }
});

test('H1-03: таблица §1.2 для kind=work — ветки в указанном порядке', () => {
  const rows: [string, WorkInput, unknown[]][] = [
    [
      '1 done',
      work({ work: { status: 'done' } }),
      ['NOT_READY', 'not-ready', 'delivery', null, 'none'],
    ],
    [
      '2 failed, attempt ≥ max, без класса',
      failed(undefined, { work: { attempt: 3 } }),
      ['ATTEMPTS_EXHAUSTED', 'unknown', 'claim', 'user', 'reset-attempts'],
    ],
    [
      '2 раньше 3: повтор разрешён бы, но попытки исчерпаны',
      failed('environment', { work: { attempt: 2 }, maxAttempts: 2 }),
      ['ATTEMPTS_EXHAUSTED', 'environment', 'claim', 'user', 'reset-attempts'],
    ],
    [
      '3 retryPlanned — timeout',
      failed('timeout'),
      ['RUNTIME_UNAVAILABLE', 'timeout', 'implementation', 'controller', 'retry'],
    ],
    [
      '3 retryPlanned — merge',
      failed('merge'),
      ['GIT_FAILED', 'merge', 'integration', 'controller', 'retry'],
    ],
    [
      '4 provider-auth (класс stop)',
      failed('provider-auth'),
      ['RUNTIME_UNAVAILABLE', 'provider-auth', 'implementation', 'user', 'fix-access'],
    ],
    [
      '5 timeout без повтора',
      failed('timeout', { repair: { groupRepairBudget: 0 } }),
      ['RUNTIME_UNAVAILABLE', 'timeout', 'implementation', 'user', 'fix-environment'],
    ],
    [
      '6 review-protocol',
      failed('review-protocol'),
      ['REVIEW_PROTOCOL_INVALID', 'review-protocol', 'review', 'user', 'user-decision'],
    ],
    [
      '6 failed без класса — unknown',
      failed(undefined),
      ['INTERNAL', 'unknown', 'implementation', 'user', 'user-decision'],
    ],
    [
      '7 budget — фаза claim и при input.phase',
      failed('budget', { phase: 'review' }),
      ['BUDGET_EXHAUSTED', 'budget', 'claim', 'user', 'raise-budget'],
    ],
    [
      '8 review без повтора',
      failed('review', { repair: { sameFailureRepairs: 2 } }),
      ['REVIEW_REJECTED', 'review', 'review', 'lead', 'diagnose-failure'],
    ],
    [
      '8 scope-violation без повтора',
      failed('scope-violation', { repair: { sameFailureRepairs: 1 } }),
      ['SCOPE_VIOLATION', 'scope-violation', 'integration', 'lead', 'diagnose-failure'],
    ],
    [
      '8 empty-result без повтора',
      failed('empty-result', { repair: { groupRepairBudget: 0 } }),
      ['GATE_FAILED', 'empty-result', 'implementation', 'lead', 'diagnose-failure'],
    ],
    [
      '8 stale-base (класс stop)',
      failed('stale-base'),
      ['GIT_FAILED', 'stale-base', 'integration', 'lead', 'diagnose-failure'],
    ],
    [
      '8 merge без повтора',
      failed('merge', { repair: { sameFailureRepairs: 1 } }),
      ['GIT_FAILED', 'merge', 'integration', 'lead', 'diagnose-failure'],
    ],
    [
      '9 cancelled',
      work({ work: { status: 'cancelled', failureKind: 'cancelled' } }),
      ['CANCELLED', 'cancelled', 'claim', 'lead', 'replan-dependents'],
    ],
    [
      '10 draft',
      work({ work: { status: 'draft', attempt: 0 } }),
      ['APPROVAL_REQUIRED', 'approval-required', 'claim', 'lead', 'review-plan'],
    ],
    [
      '11 hold',
      work({ work: { hold: { operation: 'base-update', reason: 'перенос базы' } } }),
      ['NOT_READY', 'not-ready', 'claim', 'controller', 'wait'],
    ],
    [
      '12 budgetBlock',
      work({ work: { budgetBlock: { reason: 'Бюджет work w1 исчерпан' } } }),
      ['BUDGET_EXHAUSTED', 'budget', 'claim', 'user', 'raise-budget'],
    ],
    [
      '13 пауза shutdown',
      work({ control: { paused: true, pauseReason: 'shutdown' } }),
      ['PAUSED', 'operator-pause', 'claim', 'user', 'resume-queue'],
    ],
    [
      '14 пауза runtime: provider-auth',
      work({ control: { paused: true, pauseReason: 'runtime', pauseFailures: ['provider-auth'] } }),
      ['RUNTIME_UNAVAILABLE', 'provider-auth', 'claim', 'user', 'fix-access'],
    ],
    [
      '14 пауза runtime без классов — environment',
      work({ control: { paused: true, pauseReason: 'runtime' } }),
      ['RUNTIME_UNAVAILABLE', 'environment', 'claim', 'user', 'fix-environment'],
    ],
    [
      '15 пауза reconfigure',
      work({ control: { paused: true, pauseReason: 'reconfigure' } }),
      ['PAUSED', 'not-ready', 'claim', 'controller', 'wait'],
    ],
    [
      '15 пауза base-check',
      work({ control: { paused: true, pauseReason: 'base-check' } }),
      ['PAUSED', 'not-ready', 'claim', 'controller', 'wait'],
    ],
    [
      '16 running',
      work({ work: { status: 'running' } }),
      ['NOT_READY', 'not-ready', 'implementation', 'controller', 'wait'],
    ],
    [
      '16 verifying',
      work({ work: { status: 'verifying' } }),
      ['NOT_READY', 'not-ready', 'gates', 'controller', 'wait'],
    ],
    [
      '16 reviewing',
      work({ work: { status: 'reviewing' } }),
      ['NOT_READY', 'not-ready', 'review', 'controller', 'wait'],
    ],
    [
      '16 integrating',
      work({ work: { status: 'integrating' } }),
      ['NOT_READY', 'not-ready', 'integration', 'controller', 'wait'],
    ],
    [
      '17 ready и attempt ≥ max',
      work({ work: { attempt: 3, failureKind: 'review' } }),
      ['ATTEMPTS_EXHAUSTED', 'review', 'claim', 'user', 'reset-attempts'],
    ],
    ['18 иначе', work(), ['NOT_READY', 'not-ready', 'claim', 'controller', 'wait']],
  ];
  for (const [label, input, expected] of rows) {
    const d = check(input);
    assert.deepEqual(shape(d), expected, label);
    assert.equal(d.retryPlanned, d.action === 'retry', label);
    assert.equal(d.workId, 'w1');
  }
  // Порядок: failed раньше паузы; draft раньше hold; hold раньше budgetBlock и паузы.
  const paused = { paused: true, pauseReason: 'operator' } as const;
  assert.equal(explainStop(failed('gate', { control: paused })).code, 'GATE_FAILED');
  assert.equal(
    explainStop(
      work({ work: { status: 'draft', hold: { operation: 'x', reason: 'y' } }, control: paused }),
    ).code,
    'APPROVAL_REQUIRED',
  );
  const held = explainStop(
    work({
      work: {
        hold: { operation: 'base-update', reason: 'перенос базы' },
        budgetBlock: { reason: 'b' },
      },
      control: paused,
    }),
  );
  assert.equal(held.code, 'NOT_READY');
  assert.match(held.message, /перенос базы/, 'в message — hold.reason');
  assert.equal(
    explainStop(work({ work: { budgetBlock: { reason: 'b' } }, control: paused })).code,
    'BUDGET_EXHAUSTED',
  );
  // Пауза runtime: в message — продолжение после исправления.
  assert.match(
    explainStop(work({ control: { paused: true, pauseReason: 'runtime' } })).message,
    /harness resume/,
  );
  // phase берётся из входа, где строка таблицы её не фиксирует.
  assert.equal(explainStop(failed('gate', { phase: 'integration' })).phase, 'integration');
});

test('H1-03: kind=error и kind=runtime — таблица §1.2; прочие коды по классу', () => {
  const named: [ErrorCode, unknown[]][] = [
    ['CONTROLLER_BUSY', ['controller-busy', 'claim', 'lead', 'wait']],
    ['PAUSED', ['operator-pause', 'claim', 'user', 'resume-queue']],
    ['APPROVAL_REQUIRED', ['approval-required', 'claim', 'lead', 'review-plan']],
    ['APPROVAL_STALE', ['approval-required', 'claim', 'lead', 'review-plan']],
    ['GATE_FAILED', ['gate', 'gates', 'lead', 'diagnose-failure']],
    ['REVIEW_REJECTED', ['review', 'review', 'lead', 'diagnose-failure']],
    ['REVIEW_PROTOCOL_INVALID', ['review-protocol', 'review', 'user', 'user-decision']],
    ['SCOPE_VIOLATION', ['scope-violation', 'integration', 'lead', 'diagnose-failure']],
    ['BUDGET_EXHAUSTED', ['budget', 'claim', 'user', 'raise-budget']],
    ['BUDGET_UNKNOWN', ['budget', 'claim', 'user', 'raise-budget']],
    ['ATTEMPTS_EXHAUSTED', ['unknown', 'claim', 'user', 'reset-attempts']],
    ['RUNTIME_UNAVAILABLE', ['environment', 'preflight', 'user', 'fix-environment']],
  ];
  const byClass = {
    input: ['not-ready', 'preflight', 'lead', 'diagnose-failure'],
    refused: ['not-ready', 'claim', 'lead', 'diagnose-failure'],
    infrastructure: ['environment', 'preflight', 'user', 'fix-environment'],
  };
  for (const code of Object.keys(errorCodes) as ErrorCode[]) {
    const d = check({ kind: 'error', error: { code, message: 'текст ' + code } });
    const expected = named.find(([c]) => c === code)?.[1] ?? byClass[errorCodes[code]];
    assert.deepEqual([d.code, ...shape(d).slice(1)], [code, ...expected], code);
    assert.equal(d.retryPlanned, false);
    assert.match(d.message, new RegExp('текст ' + code));
    assert.deepEqual(d.evidence, []);
    assert.equal(d.workId, undefined);
  }
  const missing = check({
    kind: 'runtime',
    runtime: { runtime: 'claude', available: false, reason: 'нет в PATH' },
  });
  assert.deepEqual(missing.evidence, [{ kind: 'doctor', id: 'claude' }]);
  assert.match(missing.message, /claude/);
  assert.match(missing.message, /нет в PATH/);
  const present = check({ kind: 'runtime', runtime: { runtime: 'claude', available: true } });
  assert.deepEqual(shape(present), ['NOT_READY', 'not-ready', 'preflight', null, 'none']);
  assert.deepEqual(present.evidence, []);
});

test('H1-03: K2 и пределы — message ≤ 2000, evidence — 20 последних, failure и runId в диагнозе', () => {
  const long = failed('gate', {
    work: { failure: 'x'.repeat(5000) },
    runId: 'run-9',
    evidence: Array.from({ length: 25 }, (_, i) => ({ kind: 'evidence' as const, id: `e${i}` })),
  });
  const d = check(long);
  assert.equal(d.message.length, 2000);
  assert.ok(d.message.endsWith('…'));
  assert.equal(d.evidence.length, 20);
  assert.deepEqual(
    d.evidence.map((e) => e.id),
    Array.from({ length: 20 }, (_, i) => `e${i + 5}`),
  );
  assert.equal(d.runId, 'run-9');
  const short = check(failed('gate', { work: { failure: 'unit упал' } }));
  assert.match(short.message, /Настроенная проверка не прошла\..*unit упал/);
  // Длинное сообщение ошибки — тот же предел.
  const err = check({
    kind: 'error',
    error: { code: 'CONTROLLER_BUSY', message: 'y'.repeat(3000) },
  });
  assert.equal(err.message.length, 2000);
  // Вход не меняется.
  const input = failed('environment', { evidence: [{ kind: 'attempt', id: 'a1' }] });
  const before = structuredClone(input);
  explainStop(input);
  assert.deepEqual(input, before);
});

test('H1-03: класс — только сохранённый failureKind; текст сети при unknown не переклассифицируется', () => {
  const L3 =
    'claude: runtime завершился отказом: код 1: API Error: EPROTO: The TLS handshake failed. Does the server speak TLS on this port?';
  for (const kind of ['unknown', undefined] as const) {
    const d = check(failed(kind, { work: { failure: L3 }, phase: 'implementation' }));
    assert.deepEqual(shape(d), ['INTERNAL', 'unknown', 'implementation', 'user', 'user-decision']);
    assert.equal(d.retryPlanned, false);
  }
  // Тот же текст при сохранённом environment — environment: решает класс, а не текст.
  assert.equal(check(failed('environment', { work: { failure: L3 } })).cause, 'environment');
  // Код совпадает с stopReason результата (stopCodeOf) для каждого класса без повтора.
  for (const kind of failureKinds) {
    const d = check(failed(kind, { repair: { groupRepairBudget: 0 } }));
    assert.equal(d.code, stopCodeOf(kind), kind);
  }
});

test('H1-03: статическая проверка — stop.ts и explain/* не импортируют classify и не разбирают текст', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const importsOf = (file: string) =>
    [...readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)].map(
      (m) => m[1]!,
    );
  for (const rel of ['projections/stop.ts', 'explain/state.ts', 'explain/diagnose.ts']) {
    const text = readFileSync(join(root, rel), 'utf8');
    assert.doesNotMatch(text, /classifyFailure\s*\(/, `${rel}: нет вызова classifyFailure`);
    assert.doesNotMatch(text, /EPROTO|ENOTFOUND|TLS handshake|\.match\(|RegExp\(/, rel);
    for (const spec of importsOf(join(root, rel)))
      assert.doesNotMatch(spec, /classif/, `${rel} импортирует ${spec}`);
  }
  // Граф импортов stop.ts (runtime): только projections/*, contracts/errors, contracts/repair-policy.
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)) {
      if (m[2]) continue;
      const spec = m[3]!;
      assert.ok(spec.startsWith('.'), `${file}: внешний импорт ${spec}`);
      walk(resolve(dirname(file), spec));
    }
  };
  walk(join(root, 'projections/stop.ts'));
  for (const file of seen) {
    const rel = file.slice(root.length);
    assert.ok(
      rel.startsWith('projections/') ||
        rel === 'contracts/errors.ts' ||
        rel === 'contracts/repair-policy.ts',
      `stop.ts достигает ${rel}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Состояние движка: stopInputsOf и K4                                 */
/* ------------------------------------------------------------------ */

const GREETING = 'add-greeting';
const message = (kind: FailureKind) => `${kind}: отказ сценария fixture`;

/**
 * Состояние с упавшим поручением, построенное операциями движка (без вызовов
 * моделей): `times` одинаковых отказов класса `kind`, задание графа (`job`) с
 * `repairs` потраченными восстановлениями, при `dropFingerprint` — запись без
 * отпечатка (прежние версии).
 */
function failedState(o: {
  kind: FailureKind;
  times?: number;
  job?: boolean;
  repairs?: number;
  dropFingerprint?: boolean;
  differ?: boolean;
}) {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  const graph = ready(h.engine, ctx.graph, 'c1');
  if (o.job) {
    const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
    if (o.repairs)
      h.store.transact('workflow.updated', (tx) =>
        tx.putLocal('workflow-jobs', WORKSPACE_OWNER, job.key, { ...job, repairs: o.repairs }),
      );
  }
  for (let i = 0; i < (o.times ?? 1); i++) {
    if (i > 0) {
      h.engine.retry(GREETING);
      h.engine.resume();
    }
    const a = h.engine.claim('c1')!;
    assert.ok(a, 'попытка выдана');
    h.engine.fail(a.id, a.token, message(o.kind) + (o.differ ? ` #${i}` : ''), { kind: o.kind });
  }
  if (o.dropFingerprint)
    h.store.transact('task.retry', (tx) => {
      const { failureFingerprint: _f, ...w } = tx.work(GREETING)!;
      void _f;
      tx.putWork(w);
    });
  h.engine.release('c1');
  return { ctx, h, graphId: graph.id };
}

test('H1-03: K4 — retryPlanned === (repairDecision(...)?.action === "retry") на всех fixture', () => {
  const fixtures: Parameters<typeof failedState>[0][] = [];
  for (const kind of [
    'environment',
    'gate',
    'provider-auth',
    'unknown',
    'review',
    'budget',
  ] as const)
    for (const job of [true, false]) fixtures.push({ kind, job });
  fixtures.push(
    { kind: 'environment', job: true, times: 2 },
    { kind: 'gate', job: true, times: 2 },
    { kind: 'gate', job: true, times: 2, differ: true },
    { kind: 'timeout', job: true, times: 2 },
    { kind: 'environment', job: true, repairs: 1 },
    { kind: 'gate', job: true, repairs: 6 },
    { kind: 'environment', job: true, dropFingerprint: true },
    { kind: 'gate', job: true, dropFingerprint: true },
  );
  const budgets: [number, number][] = [
    [3, 6],
    [3, 1],
    [3, 0],
    [2, 6],
    [1, 6],
  ];
  let retries = 0;
  let total = 0;
  for (const f of fixtures) {
    const { h, graphId } = failedState(f);
    try {
      for (const [maxAttempts, repairBudget] of budgets) {
        const inputs = stopInputsOf(h, { maxAttempts, repairBudget });
        const input = inputs.find((i): i is WorkInput => i.kind === 'work')!;
        const d = explainStop(input);
        const job = h.workflows.list().find((j) => j.kind === 'graph' && j.id === graphId);
        // Без задания графа движок сам не чинит: repairDecision не вызывается.
        const decided = job
          ? h.engine.read((v) =>
              repairDecision(v, v.works(graphId), {
                budgetLeft: repairBudget - (job.repairs ?? 0),
                maxAttempts,
              }),
            )
          : undefined;
        const label = JSON.stringify({ ...f, maxAttempts, repairBudget });
        assert.equal(d.retryPlanned, decided?.action === 'retry', label);
        assert.equal(d.action === 'retry', d.retryPlanned, label);
        total++;
        if (d.retryPlanned) retries++;
      }
    } finally {
      h.close();
    }
  }
  assert.ok(retries > 0 && retries < total, `обе ветки покрыты: ${retries}/${total}`);
});

test('H1-03: stopInputsOf — phase, runId и evidence из последней завершённой попытки; repair по K4; controller; done пропущен', () => {
  const { h } = failedState({ kind: 'environment', job: true, times: 2 });
  try {
    const attempts = h.engine.read((v) => v.attempts(GREETING));
    const inputs = stopInputsOf(h, { maxAttempts: 3, repairBudget: 6 });
    assert.equal(inputs.length, 1, 'controller освобождён: только поручение');
    const input = inputs[0] as WorkInput;
    assert.equal(input.runId, attempts.at(-1)!.id);
    assert.equal(input.phase, 'implementation', 'attempt.phase running → implementation');
    assert.deepEqual(input.evidence, [{ kind: 'attempt', id: attempts.at(-1)!.id }]);
    assert.deepEqual(input.repair, {
      sameFailureRepairs: 1,
      groupRepairsUsed: 0,
      groupRepairBudget: 6,
      // Тот же отпечаток уже чинился: решение группы — остановка.
      groupStopped: true,
    });
    assert.equal(input.work.failureKind, 'environment');
    assert.deepEqual(input.control, {
      paused: true,
      pauseReason: 'runtime',
      pauseFailures: ['environment'],
    });
    const d = explainStop(input);
    assert.deepEqual(shape(d), [
      'RUNTIME_UNAVAILABLE',
      'environment',
      'implementation',
      'user',
      'fix-environment',
    ]);
    assert.equal(d.retryPlanned, false, 'одинаковый отказ второй раз: повтор исчерпан');

    // Действующая роль controller — отдельный вход CONTROLLER_BUSY первым.
    assert.equal(h.engine.lead('other-controller'), true);
    const busy = stopInputsOf(h, { maxAttempts: 3, repairBudget: 6 });
    assert.equal(busy[0]!.kind, 'error');
    assert.deepEqual(shape(explainStop(busy[0]!)), [
      'CONTROLLER_BUSY',
      'controller-busy',
      'claim',
      'lead',
      'wait',
    ]);
    h.engine.release('other-controller');

    // --work: только это поручение; неизвестный id — NOT_FOUND.
    assert.equal(stopInputsOf(h, { maxAttempts: 3, repairBudget: 6, workId: GREETING }).length, 1);
    assert.throws(
      () => stopInputsOf(h, { maxAttempts: 3, repairBudget: 6, workId: 'nope' }),
      (e: unknown) => (e as { code?: string }).code === 'NOT_FOUND',
    );
    // Без отпечатка повторять нечего: sameFailureRepairs = repeats класса.
    h.store.transact('task.retry', (tx) => {
      const { failureFingerprint: _f, ...w } = tx.work(GREETING)!;
      void _f;
      tx.putWork(w);
    });
    const noPrint = stopInputsOf(h, { maxAttempts: 3, repairBudget: 6 })[0] as WorkInput;
    assert.equal(noPrint.repair.sameFailureRepairs, 1);
    // Принятое поручение диагнозов не даёт.
    h.store.transact('task.retry', (tx) => tx.putWork({ ...tx.work(GREETING)!, status: 'done' }));
    assert.deepEqual(stopInputsOf(h, { maxAttempts: 3, repairBudget: 6 }), []);
  } finally {
    h.close();
  }
});

test('H1-03: исторический unknown (L3) остаётся unknown — диагноз INTERNAL, state и события не меняются', () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  let h = ctx.open();
  const graph = ready(h.engine, ctx.graph, 'alpha7');
  h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
  const a = h.engine.claim('alpha7')!;
  const L3 =
    'claude: runtime завершился отказом: код 1: API Error: EPROTO: The TLS handshake failed. Does the server speak TLS on this port?';
  // Запись alpha.7: прежний классификатор сохранил сетевой текст как unknown.
  h.engine.fail(a.id, a.token, L3, { kind: 'unknown' });
  h.engine.release('alpha7');
  h.close();
  const sha = () => createHash('sha256').update(readFileSync(ctx.statePath)).digest('hex');
  const before = sha();
  // Чтение — как у `harness explain`: база открыта только для чтения.
  h = Harness.open({
    stateDir: ctx.state,
    policy: ctx.policy,
    baseDir: ctx.repo.dir,
    readOnly: true,
    readOnlyState: true,
  });
  const events = h.store.events(0, 10000).length;
  const [input] = stopInputsOf(h, { maxAttempts: 3, repairBudget: 6 });
  const d = explainStop(input!);
  assert.deepEqual(shape(d), ['INTERNAL', 'unknown', 'implementation', 'user', 'user-decision']);
  assert.equal(d.retryPlanned, false);
  assert.match(d.message, /EPROTO/, 'текст отказа показан как есть');
  assert.equal(
    h.engine.read((v) => v.work(GREETING)!.failureKind),
    'unknown',
  );
  assert.equal(h.store.events(0, 10000).length, events, 'чтение не пишет событий');
  h.close();
  assert.equal(sha(), before, 'база состояния не изменена');
});

test('H1-03: explainText — строка на диагноз, сообщение и evidence с отступом', () => {
  const d = explainStop(
    failed('gate', {
      phase: 'gates',
      repair: { groupRepairBudget: 0 },
      work: { failure: 'unit упал' },
      evidence: [
        { kind: 'attempt', id: 'run-1' },
        { kind: 'evidence', id: 'ev-1', sha: 'a'.repeat(40) },
      ],
    }),
  );
  const e = explainStop({ kind: 'error', error: { code: 'CONTROLLER_BUSY', message: 'занято' } });
  const text = explainText({ diagnoses: [e, d] });
  const lines = text.trimEnd().split('\n');
  assert.equal(lines[0], '— CONTROLLER_BUSY [controller-busy/claim] → lead: wait');
  assert.equal(lines[1], '  ' + e.message);
  assert.equal(lines[2], 'w1 GATE_FAILED [gate/gates] → lead: diagnose-failure');
  assert.equal(lines[3], '  ' + d.message);
  assert.equal(lines[4], `  evidence: attempt:run-1, evidence:ev-1@${'a'.repeat(40)}`);
  assert.equal(lines.length, 5);
  assert.ok(text.endsWith('\n'));
  assert.equal(
    explainText({ diagnoses: [explainStop(work({ work: { status: 'done' } }))] }).split('\n')[0],
    'w1 NOT_READY [not-ready/delivery] → —: none',
  );
});

test('H1-03: работа под восстановлением свойства не получает retryPlanned — как repairDecision', () => {
  const input = {
    kind: 'work',
    work: { id: 'w', status: 'failed', attempt: 1, failureKind: 'environment', recovery: true },
    maxAttempts: 3,
    repair: { sameFailureRepairs: 0, groupRepairsUsed: 0, groupRepairBudget: 6 },
    control: { paused: false },
  } as const;
  assert.equal(explainStop(input).retryPlanned, false);
  assert.equal(
    explainStop({ ...input, work: { ...input.work, recovery: false } }).retryPlanned,
    true,
  );
});

test('H1-03: остановленное задание графа не назначит повтор — explain не обещает retry, run подтверждает', async () => {
  const { ctx, h, graphId } = failedState({ kind: 'gate', job: true });
  try {
    const job = h.workflows.list().find((j) => j.kind === 'graph' && j.id === graphId)!;
    // Так задание оставляет advance после решения «остановка» или исчерпания стадии.
    h.store.transact('workflow.updated', (tx) =>
      tx.putLocal('workflow-jobs', WORKSPACE_OWNER, job.key, { ...job, status: 'failed' }),
    );
    const explain = () =>
      stopInputsOf(h, { maxAttempts: 3, repairBudget: 6 })
        .filter((i): i is WorkInput => i.kind === 'work')
        .map(explainStop);
    const [before] = explain();
    assert.equal(before!.retryPlanned, false);
    assert.notEqual(before!.action, 'retry');
    assert.deepEqual([before!.actor, before!.action], ['lead', 'diagnose-failure']);
    const writerCalls = ctx.calls('claude', 'writer');
    await h.run({ graph: ctx.graph, author: 'claude' });
    assert.equal(ctx.calls('claude', 'writer'), writerCalls, 'движок действительно не повторил');
    assert.deepEqual(explain(), [before]);
  } finally {
    h.close();
  }
});

test('H1-03: решение группы «остановка» (отмена или класс stop у соседа) снимает retryPlanned', () => {
  const input = {
    kind: 'work',
    work: { id: 'b', status: 'failed', attempt: 1, failureKind: 'gate' },
    maxAttempts: 3,
    repair: { sameFailureRepairs: 0, groupRepairsUsed: 0, groupRepairBudget: 6 },
    control: { paused: false },
  } as const;
  assert.equal(explainStop(input).retryPlanned, true);
  const stopped = explainStop({ ...input, repair: { ...input.repair, groupStopped: true } });
  assert.equal(stopped.retryPlanned, false);
  assert.deepEqual([stopped.actor, stopped.action], ['lead', 'diagnose-failure']);
});

test('H1-03 (H1-F002): задание прежней редакции графа ещё queued — retry не обещается; диагностика задание не трогает', () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  try {
    const first = ready(h.engine, ctx.graph, 'old-controller');
    const oldJob = h.workflows.start({ kind: 'graph', id: first.id, authorRuntime: 'claude' });
    h.engine.release('old-controller');
    const revised = structuredClone(ctx.graph);
    revised.source.revision = '2';
    revised.orders[0]!.source.revision = '2';
    revised.orders[0]!.title += ' revised';
    ready(h.engine, revised, 'new-controller');
    const a = h.engine.claim('new-controller')!;
    h.engine.fail(a.id, a.token, 'environment fixture', { kind: 'environment' });
    h.engine.release('new-controller');
    const before = h.workflows.list();
    assert.equal(before[0]!.status, 'queued');
    const [d] = stopInputsOf(h, { maxAttempts: 3, repairBudget: 6 })
      .filter((i): i is WorkInput => i.kind === 'work')
      .map(explainStop);
    assert.equal(d!.retryPlanned, false);
    assert.deepEqual([d!.actor, d!.action], ['user', 'fix-environment']);
    assert.deepEqual(h.workflows.list(), before, 'read-only: задание не помечено stale');
    // Движок действительно не продолжит старое задание.
    assert.equal(h.workflows.claim(oldJob.key), undefined);
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F002): попытки стадии задания исчерпаны — retry не обещается', () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  try {
    const graph = ready(h.engine, ctx.graph, 'controller');
    const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
    const a = h.engine.claim('controller')!;
    h.engine.fail(a.id, a.token, 'environment fixture', { kind: 'environment' });
    h.engine.release('controller');
    for (let i = 0; i < job.maxAttempts; i++)
      h.workflows.fail(h.workflows.claim(job.key)!, `interruption ${i + 1}`, true);
    assert.equal(h.workflows.get(job.key).status, 'queued');
    const [d] = stopInputsOf(h, { maxAttempts: 3, repairBudget: 6 })
      .filter((i): i is WorkInput => i.kind === 'work')
      .map(explainStop);
    assert.equal(d!.retryPlanned, false);
    assert.notEqual(d!.action, 'retry');
    assert.equal(h.workflows.claim(job.key), undefined);
    assert.equal(h.workflows.get(job.key).error, 'Исчерпаны попытки стадии');
  } finally {
    h.close();
  }
});

test('H1-03 (H1-F006): последняя стадия уже выполняется действующим владельцем — retry обещается, как его выполняет run', async () => {
  const ctx = hsetup({ scenario: { writer: implement(), reviewer: approve() } });
  const h = ctx.open();
  try {
    const graph = ready(h.engine, ctx.graph, 'controller');
    const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
    h.workflows.finish(h.workflows.claim(job.key)!);
    const a = h.engine.claim('controller')!;
    h.engine.fail(a.id, a.token, 'environment fixture', { kind: 'environment' });
    h.engine.release('controller');
    for (let i = 0; i < job.maxAttempts - 1; i++)
      h.workflows.fail(h.workflows.claim(job.key)!, `interruption ${i + 1}`, true);
    let seen: { held: boolean; expired: boolean; retryPlanned: boolean } | undefined;
    const claim = h.workflows.claim.bind(h.workflows);
    // Наблюдение на публичной границе claim настоящего run; результат не меняется.
    h.workflows.claim = (...args) => {
      const claimed = claim(...args);
      if (claimed?.stage === 1 && claimed.attempts === claimed.maxAttempts && !seen) {
        const [d] = stopInputsOf(h, { maxAttempts: 3, repairBudget: 6 })
          .filter((i): i is WorkInput => i.kind === 'work')
          .map(explainStop);
        seen = {
          held: h.engine.read((v) => h.workflows.continues(claimed, v)),
          // Та же последняя стадия с истёкшей арендой уже не продолжится.
          expired: h.engine.read((v) => h.workflows.continues({ ...claimed, leaseUntil: 0 }, v)),
          retryPlanned: d!.retryPlanned,
        };
      }
      return claimed;
    };
    const result = await h.run({ graph: ctx.graph, author: 'claude' });
    assert.deepEqual(seen, { held: true, expired: false, retryPlanned: true });
    assert.equal(h.workflows.get(job.key).repairs, 1, 'run действительно назначил repair');
    assert.equal(result.works[0]!.status, 'done');
  } finally {
    h.close();
  }
});
