import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirementProof, type ProofRecord } from '../src/verification/proof.ts';
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
