import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessError, type FailureKind } from '../src/contracts/index.ts';
import { BlockedError, classifyFailure } from '../src/engine/classify.ts';
import { TaskFailure, repairPolicy } from '../src/engine/failure.ts';

/** Сообщение, которое runner строит из отказа runtime (см. runner: «runtime завершился отказом»). */
const runtime = (reason: string) => `claude: runtime завершился отказом: код 1: ${reason}`;
const L3 = runtime(
  'API Error: EPROTO: The TLS handshake failed. Does the server speak TLS on this port?',
);
const kindOf = (message: string) => classifyFailure(new Error(message), message);

test('NET01: точная строка L3 — environment и без ошибки, и с обычным Error', () => {
  assert.equal(classifyFailure(undefined, L3), 'environment');
  assert.equal(classifyFailure(new Error(L3), L3), 'environment');
});

test('NET02: семь транспортных кодов в любом регистре и TLS handshake без errno', () => {
  for (const code of [
    'EPROTO',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ])
    for (const spelled of [code, code.toLowerCase()]) {
      const message = runtime(`request to https://api.example failed, reason: ${spelled}`);
      assert.equal(kindOf(message), 'environment', message);
      assert.equal(
        classifyFailure(undefined, runtime(`connect ${spelled} 1.2.3.4:443`)),
        'environment',
      );
    }
  assert.equal(kindOf(runtime('TLS handshake failed')), 'environment');
  assert.equal(kindOf(runtime('tls HANDSHAKE FAILED while connecting')), 'environment');
  // Код внутри идентификатора — не код транспорта.
  for (const reason of [
    'XEPROTOX',
    'MY_ENOTFOUND_CODE',
    'ECONNREFUSEDX',
    'getaddrinfo_EAI_AGAIN_v2',
  ])
    assert.equal(kindOf(runtime(reason)), 'unknown', reason);
});

test('NET03: транспортный timeout — environment раньше общего текстового timeout', () => {
  assert.equal(kindOf(runtime('connect ETIMEDOUT: timeout')), 'environment');
  assert.equal(kindOf(runtime('TLS handshake timeout')), 'environment');
});

test('NET04: явный класс и известные коды HarnessError сильнее сетевого текста', () => {
  for (const kind of ['gate', 'review', 'timeout', 'cancelled'] as FailureKind[])
    assert.equal(classifyFailure(new TaskFailure(kind, L3), L3), kind, kind);
  // Gate с тестом про TLS остаётся отказом приложения.
  const gate = 'candidate/tests: TLS handshake failed in test "rejects plain http" (EPROTO)';
  assert.equal(classifyFailure(new TaskFailure('gate', gate), gate), 'gate');
  for (const [code, kind] of [
    ['GATE_FAILED', 'gate'],
    ['REVIEW_REJECTED', 'review'],
    ['REVIEW_PROTOCOL_INVALID', 'review-protocol'],
    ['SCOPE_VIOLATION', 'scope-violation'],
    ['BUDGET_EXHAUSTED', 'budget'],
  ] as const)
    assert.equal(classifyFailure(new HarnessError(code, L3), L3), kind, code);
});

test('NET05: auth/квота/частота рядом с EPROTO/TLS — provider-auth со своей политикой', () => {
  for (const reason of [
    'API Error: 401 Unauthorized after EPROTO retry',
    'Not logged in · Please run /login (TLS handshake failed earlier)',
    'insufficient_quota; previous attempt ECONNREFUSED',
    'Rate limit reached; ETIMEDOUT on retry',
    '429 Too Many Requests: TLS handshake timeout',
  ])
    assert.equal(kindOf(runtime(reason)), 'provider-auth', reason);
  assert.deepEqual(
    [
      repairPolicy['provider-auth'].action,
      repairPolicy['provider-auth'].repeats,
      repairPolicy['provider-auth'].blocksQueue,
    ],
    ['stop', 0, true],
  );
  assert.deepEqual(
    [
      repairPolicy.environment.action,
      repairPolicy.environment.repeats,
      repairPolicy.environment.blocksQueue,
    ],
    ['retry', 1, true],
  );
});

test('NET06: настоящий deadline, прежний timeout и голые слова не становятся environment', () => {
  assert.equal(
    kindOf('claude: runtime завершился с кодом 143 (исчерпан лимит времени прогона: 900 с)'),
    'timeout',
  );
  assert.equal(kindOf('Исчерпан лимит времени попытки (900 с)'), 'timeout');
  assert.equal(kindOf(runtime('request timeout')), 'timeout');
  for (const reason of [
    'TLS',
    'DNS lookup',
    'network',
    'protocol mismatch',
    'TLS certificate verification failed',
    'TypeError: cannot read properties of undefined',
    'tests failed: 3 of 10',
  ])
    assert.equal(kindOf(runtime(reason)), 'unknown', reason);
  assert.equal(kindOf('claude: runtime завершился отказом: код 1'), 'unknown');
});

test('NET07: прежние признаки environment, BlockedError и отмена — без регрессий', () => {
  for (const reason of [
    'ECONNRESET',
    'write EPIPE',
    'socket hang up',
    'fetch failed',
    'connection reset by peer',
  ])
    assert.equal(kindOf(runtime(reason)), 'environment', reason);
  assert.equal(
    classifyFailure(new BlockedError('codex: runtime не запускается'), 'x'),
    'environment',
  );
  assert.equal(classifyFailure(new TaskFailure('cancelled', 'прогон прерван'), 'x'), 'cancelled');
});
