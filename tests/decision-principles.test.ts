/**
 * Принцип «Кто принимает решения» (docs/principles.md) закреплён договором:
 * таблица правил документа совпадает с `decisionRules`, технические решения
 * — у ведущего, остальные — у человека, и explain называет актёра и
 * действие ровно по этой таблице. Перевод технического восстановления к
 * человеку без правки принципа роняет этот тест.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decisionRules, type DecisionRuleKey } from '../src/projections/decisions.ts';
import { explainStop, type StopInput } from '../src/projections/stop.ts';

const doc = readFileSync(fileURLToPath(new URL('../docs/principles.md', import.meta.url)), 'utf8');
const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
const agents = readFileSync(fileURLToPath(new URL('../AGENTS.md', import.meta.url)), 'utf8');

/** Строки таблицы правил между маркерами документа. */
function docRules() {
  const start = doc.indexOf('<!-- decision-rules:start -->');
  const end = doc.indexOf('<!-- decision-rules:end -->');
  assert.ok(start >= 0 && end > start, 'маркеры таблицы правил в docs/principles.md');
  const cells = doc
    .slice(start, end)
    .split('\n')
    .filter((l) => l.trim().startsWith('|') && !/^\|\s*-/.test(l.trim()))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim().replace(/`/g, '')),
    );
  const [, ...rows] = cells;
  return Object.fromEntries(
    rows.map(([key, code, actor, action, kind]) => [key!, { code, actor, action, kind }]),
  );
}

test('principle: таблица правил документа — та же, что decisionRules', () => {
  assert.deepEqual(docRules(), decisionRules);
  assert.match(doc, /## Кто принимает решения/);
  assert.match(readme, /docs\/principles\.md/, 'README ссылается на принцип');
  assert.match(agents, /docs\/principles\.md/, 'AGENTS.md: правило правки принципа');
});

test('principle: техническое восстановление — у ведущего, остальное — у человека', () => {
  for (const [key, rule] of Object.entries(decisionRules))
    assert.equal(rule.actor, rule.kind === 'technical' ? 'lead' : 'user', key);
  // Закреплённый перечень технических действий: сменить актёра одного из них
  // можно, только сменив и вид (и документ, и этот перечень).
  const technical = Object.entries(decisionRules)
    .filter(([, r]) => r.kind === 'technical')
    .map(([k, r]) => `${k}:${r.action}`)
    .sort();
  assert.deepEqual(technical, [
    'diagnosis-required:diagnose',
    'diagnosis-split:review-plan',
    'exhausted-diagnose:diagnose',
    'exhausted-lead-reset:reset-attempts',
    'input-technical:answer-input',
  ]);
});

type Work = Extract<StopInput, { kind: 'work' }>;
const workInput = (work: Partial<Work['work']>, extra: Partial<Work> = {}): StopInput => ({
  kind: 'work',
  work: { id: 'w', status: 'failed', attempt: 3, failureKind: 'gate', ...work },
  maxAttempts: 3,
  repair: { sameFailureRepairs: 0, groupRepairsUsed: 0, groupRepairBudget: 6, outlook: 'stop' },
  control: { paused: false },
  ...extra,
});

/** Вход explain, на котором действует каждое правило. */
const inputs: Record<DecisionRuleKey, StopInput> = {
  'diagnosis-required': workInput({
    attempt: 2,
    leadRecovery: {
      hold: { kind: 'diagnosis-required', failures: ['r1', 'r2'] },
      exhausted: { actor: 'lead', step: 'diagnose' },
      leadResets: 2,
    },
  }),
  'exhausted-diagnose': workInput({
    leadRecovery: { exhausted: { actor: 'lead', step: 'diagnose' }, leadResets: 2 },
  }),
  'exhausted-lead-reset': workInput({
    leadRecovery: {
      exhausted: { actor: 'lead', step: 'reset', diagnosis: 'D2', index: 1, cap: 2 },
      leadResets: 2,
    },
  }),
  'diagnosis-split': workInput({
    attempt: 2,
    leadRecovery: {
      hold: { kind: 'replan', diagnosis: 'D1' },
      exhausted: { actor: 'lead', step: 'replan', diagnosis: 'D1' },
      leadResets: 2,
    },
  }),
  'input-technical': workInput({
    attempt: 1,
    failureKind: 'needs-input',
    input: { requestId: 'IR-1', state: 'awaiting-answer', leadMay: 'technical' },
  }),
  'diagnosis-contradiction': workInput({
    attempt: 2,
    leadRecovery: {
      hold: { kind: 'contradiction', diagnosis: 'D1' },
      exhausted: { actor: 'user', why: 'cause', diagnosis: 'D1' },
      leadResets: 2,
    },
  }),
  'input-user': workInput({
    attempt: 1,
    failureKind: 'needs-input',
    input: { requestId: 'IR-1', state: 'awaiting-answer' },
  }),
  'exhausted-user': workInput({
    leadRecovery: { exhausted: { actor: 'user', why: 'cap' }, leadResets: 2 },
  }),
  'budget-exhausted': { kind: 'error', error: { code: 'BUDGET_EXHAUSTED', message: 'бюджет' } },
};

test('principle: explain называет актёра и действие каждого правила по таблице', () => {
  for (const [key, rule] of Object.entries(decisionRules) as [
    DecisionRuleKey,
    (typeof decisionRules)[DecisionRuleKey],
  ][]) {
    const d = explainStop(inputs[key]);
    assert.deepEqual(
      { code: d.code, actor: d.actor, action: d.action },
      { code: rule.code, actor: rule.actor, action: rule.action },
      key,
    );
  }
  // Код отказа CLI без контекста работы: разбор — ведущему, исчерпание — человеку.
  const error = (code: 'DIAGNOSIS_REQUIRED' | 'ATTEMPTS_EXHAUSTED') =>
    explainStop({ kind: 'error', error: { code, message: code } });
  assert.deepEqual(
    [error('DIAGNOSIS_REQUIRED').actor, error('DIAGNOSIS_REQUIRED').action],
    ['lead', 'diagnose'],
  );
  assert.deepEqual(
    [error('ATTEMPTS_EXHAUSTED').actor, error('ATTEMPTS_EXHAUSTED').action],
    ['user', 'reset-attempts'],
  );
  // Без правила `lead` (нет leadRecovery) исчерпание — человек, как прежде.
  const old = explainStop(workInput({}));
  assert.deepEqual(
    [old.code, old.actor, old.action],
    ['ATTEMPTS_EXHAUSTED', 'user', 'reset-attempts'],
  );
});
