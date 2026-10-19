import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirementProof, unprovenReason, type ProofRecord } from '../src/verification/proof.ts';
import { junitSummary } from '../src/verification/gates.ts';
import { redactor } from '../src/environment/redaction.ts';
import { sha } from './engine-fixture.ts';

/**
 * Доказательство названного testcase — решающей записью gate: последней
 * собственной записью вида test фазы интеграции на принятом SHA под версией
 * проверок попытки. Запись ревью, запись другой версии и более ранний прогон
 * того же gate testcase не подтверждают.
 */
const link = { id: 'REQ-1', gate: 'unit', testId: 'required-test' };
const record = (patch: Partial<ProofRecord> = {}): ProofRecord => ({
  kind: 'test',
  gate: 'unit',
  phase: 'integration',
  sha: sha('b'),
  passed: true,
  checks: 'a'.repeat(64),
  tests: [{ id: 'required-test', status: 'passed' }],
  ...patch,
});
const level = (evidence: ProofRecord[]) =>
  requirementProof(link, evidence, sha('b'), 'a'.repeat(64)).level;

test('Решающая test-запись нужной версии подтверждает testcase', () => {
  assert.equal(level([record()]), 'testcase');
});

test('Запись ревью под именем gate testcase не подтверждает', () => {
  assert.equal(level([record({ tests: undefined }), record({ kind: 'review' })]), 'none');
});

test('Запись другой версии проверок testcase не подтверждает', () => {
  assert.equal(level([record({ checks: 'f'.repeat(64) })]), 'none');
  assert.equal(level([record({ checks: 'f'.repeat(64) }), record({ tests: undefined })]), 'none');
});

test('Более ранний прогон того же gate не подтверждает: решает последний', () => {
  assert.equal(level([record(), record({ tests: undefined })]), 'none');
  assert.equal(level([record(), record({ passed: false })]), 'none');
});

test('Зелёная проверка без связанного теста — прежний, более слабый уровень gate, названный прямо', () => {
  const proof = requirementProof({ id: 'REQ-1', gate: 'unit' }, [record()], sha('b'));
  assert.equal(proof.level, 'gate');
  assert.match(proof.reason, /не связан с конкретным тестом/);
});

test('Ни посторонний зелёный тест, ни пропуск, ни повтор, ни чужой SHA, ни кандидат, ни обрезанный или пустой манифест не подтверждают', () => {
  const cases: [string, ProofRecord[], string | undefined, RegExp][] = [
    [
      'посторонний тест',
      [record({ tests: [{ id: 'other', status: 'passed' }] })],
      sha('b'),
      /не выполнялся/,
    ],
    [
      'пропущенный',
      [record({ tests: [{ id: link.testId, status: 'skipped' }] })],
      sha('b'),
      /skipped/,
    ],
    ['упавший', [record({ tests: [{ id: link.testId, status: 'failed' }] })], sha('b'), /failed/],
    [
      'повтор id',
      [
        record({
          tests: [
            { id: link.testId, status: 'passed' },
            { id: link.testId, status: 'passed' },
          ],
        }),
      ],
      sha('b'),
      /встречается/,
    ],
    ['обрезанный манифест', [record({ testsTruncated: true })], sha('b'), /обрезан/],
    ['другой SHA', [record({ sha: sha('c') })], sha('b'), /не выполнялась/],
    ['фаза кандидата', [record({ phase: 'candidate' })], sha('b'), /не выполнялась/],
    ['проверка не прошла', [record({ passed: false })], sha('b'), /не прошла/],
    ['без манифеста', [record({ tests: undefined })], sha('b'), /не сообщила/],
    ['результат не принят', [record()], undefined, /не принят/],
    ['запись потребителя', [record({ consumer: 'app' })], sha('b'), /не выполнялась/],
  ];
  for (const [name, given, accepted, reason] of cases) {
    const proof = requirementProof(link, given, accepted);
    assert.equal(proof.level, 'none', name);
    assert.match(proof.reason, reason, name);
  }
});

test('Приёмка спрашивает только требования, назвавшие свой тест; причина называет требование', () => {
  const requirement = {
    id: 'REQ-1',
    source: 'docs/spec.md',
    digest: 'f'.repeat(64),
    text: 'Скидка применяется к сумме корзины',
    gate: 'unit',
    scenario: 'Корзина со скидкой',
  };
  assert.equal(
    unprovenReason([{ ...requirement, testId: link.testId }], [record()], sha('b')),
    undefined,
  );
  assert.equal(unprovenReason([requirement], [record()], sha('b')), undefined, 'прежний уровень');
  assert.match(
    unprovenReason([{ ...requirement, testId: 'missing' }], [record()], sha('b')) ?? '',
    /REQ-1 — Тест missing не выполнялся/,
  );
});

test('Имя, изменённое redaction или хешем, не подтверждает; обычное имя рядом сопоставляется', () => {
  const redact = redactor([
    'SYNTHETIC_PRIVATE_442211',
    'SYNTHETIC_MULTILINE_PRIVATE\nSECOND_LINE_1234',
  ]);
  const long = (tail: string) => 'p'.repeat(1001) + tail;
  const summary = junitSummary(
    '<testsuite>' +
      '<testcase name="case-SYNTHETIC_PRIVATE_442211"/>' +
      `<testcase name="${long('a')}"/><testcase name="${long('b')}"/>` +
      '<testcase classname="auth" name="multi"><failure><![CDATA[SYNTHETIC_MULTILINE_PRIVATE\nSECOND_LINE_1234]]></failure></testcase>' +
      '<testcase name="plain"/>' +
      '</testsuite>',
    redact,
  );
  const byId = new Map(summary.cases.map((c) => [c.id, c]));
  assert.equal(byId.get('case-[REDACTED]')?.opaque, true);
  assert.equal(byId.get('plain')?.opaque, undefined, 'обычное имя остаётся сопоставимым');
  // Многострочный секрет не остаётся ни целиком, ни частями.
  const text = JSON.stringify(summary);
  for (const piece of [
    'SYNTHETIC_MULTILINE_PRIVATE',
    'SECOND_LINE_1234',
    'SYNTHETIC_PRIVATE_442211',
  ])
    assert.equal(text.includes(piece), false, piece);
  const hashed = summary.cases.filter((c) => c.id.startsWith('sha256:'));
  assert.equal(hashed.length, 2);
  assert.notEqual(hashed[0]!.id, hashed[1]!.id, 'разные длинные имена не сливаются');
  assert.ok(hashed.every((c) => c.opaque && c.id.length <= 1000));
  const proof = requirementProof(
    { id: 'REQ-1', gate: 'unit', testId: 'case-[REDACTED]' },
    [record({ tests: summary.cases })],
    sha('b'),
  );
  assert.equal(proof.level, 'none');
  assert.match(proof.reason, /redaction/);
  assert.equal(
    requirementProof(
      { id: 'REQ-2', gate: 'unit', testId: 'plain' },
      [record({ tests: summary.cases })],
      sha('b'),
    ).level,
    'testcase',
  );
});
