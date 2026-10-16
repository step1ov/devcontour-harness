import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AttemptState,
  CallRecord,
  CheckSuite,
  ExecutionTransaction,
  JointVerificationState,
  RunEventDraft,
  RunResult,
  WorkState,
  WorkflowJob,
} from 'devcontour-harness';

/**
 * Проверки опубликованных типов на этапе компиляции (`npm run typecheck`):
 * импорт через публичный entry point, недопустимые записи не компилируются
 * (`@ts-expect-error` сам становится ошибкой, если тип ослабнет до
 * `Record<string, unknown>`), корректное чтение полей компилируется.
 */
type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type NotLoose<T> = string extends keyof T ? false : true;

export type _strict = [
  Assert<NotLoose<JointVerificationState>>,
  Assert<NotLoose<AttemptState>>,
  Assert<NotLoose<WorkState>>,
  Assert<NotLoose<CallRecord>>,
  Assert<NotLoose<CheckSuite>>,
  Assert<NotLoose<WorkflowJob>>,
  Assert<NotLoose<RunResult>>,
  Assert<IsAny<JointVerificationState> extends true ? false : true>,
];

export function _compileChecks(tx: ExecutionTransaction, v: JointVerificationState) {
  // Корректное чтение: владение, а после сужения по статусу — manifest.
  const token: string = v.token;
  const lease: number = v.leaseUntil;
  if (v.status === 'passed') {
    const digest: string = v.manifestDigest;
    const repos: string[] = Object.keys(v.manifest);
    void digest;
    void repos;
  }
  void token;
  void lease;
  // @ts-expect-error — пустое состояние не является совместной проверкой
  tx.putVerification({});
  // @ts-expect-error — неверные типы полей
  tx.putVerification({ ...v, status: 'garbage', token: 7, leaseUntil: 'forever' });
  // @ts-expect-error — у passed manifest обязателен
  const passed: JointVerificationState = { ...v, status: 'passed', manifest: undefined };
  void passed;
  // @ts-expect-error — токен не входит ни в одну нагрузку события
  const draft: RunEventDraft = { type: 'attempt.expired', payload: { leaseUntil: 1, token: 'x' } };
  void draft;
}

test('Проверки типов выполняются компилятором (см. npm run typecheck)', () => {
  assert.equal(typeof _compileChecks, 'function');
});
