/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call --
 * Фикстура правит сырой JSON политики.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FAILURE_PATHS_REVIEW_TEXT,
  FAILURE_PATHS_WRITER_TEXT,
  WRITER_SELF_CHECK_TEXT,
} from '../src/engine/prompt.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';
import { nodeGate } from './git-fixture.ts';

test('writer: подсказка называет команды и cwd gates области и требует самопроверки; значения окружения в неё не попадают', async () => {
  const secret = 'value-of-gate-only-env-7f3a';
  // Объявленный секрет, вписанный значением в команду gate (ревью C LOW-5).
  const inline = 'inline-gate-secret-9c41d2e7b3';
  process.env.HARNESS_TEST_INLINE_SECRET = inline;
  const ctx = setup({
    files: { 'packages/b/package.json': '{"name":"b"}\n' },
    scenario: {
      writer: { ...implement(), recordPrompt: true },
      reviewer: { ...approve(), recordPrompt: true },
    },
    graph: (g: any) => (g.orders[0].gates = ['unit', 'pkg-check', 'inline-check']),
    policy: (p: any) => {
      p.harnessMode = 'light';
      p.environment.values.GATE_ONLY_TOKEN = secret;
      p.environment.secrets = { API_TOKEN: 'HARNESS_TEST_INLINE_SECRET' };
      p.repositories[0].gates.push({
        id: 'inline-check',
        kind: 'check',
        command: ['env', `API_TOKEN=${inline}`, ...nodeGate('process.exit(0)')],
      });
      p.repositories[0].gates.push({
        id: 'pkg-check',
        kind: 'check',
        cwd: 'packages/b',
        command: nodeGate('process.exit(0)'),
      });
    },
  });
  await runAll(ctx);
  const prompt = readFileSync(`${ctx.scenarioPath}.writer.0.prompt`, 'utf8');
  const head = prompt.slice(0, prompt.indexOf('\n---ARGS---'));
  assert.ok(head.includes(WRITER_SELF_CHECK_TEXT), 'самопроверка');
  assert.ok(head.includes('"id":"pkg-check"'));
  assert.ok(head.includes('"cwd":"packages/b"'), 'cwd gate');
  assert.ok(head.includes(JSON.stringify(nodeGate('process.exit(0)'))), 'точная команда');
  assert.ok(!head.includes(secret), 'значение окружения не в подсказке');
  assert.ok(!head.includes('GATE_ONLY_TOKEN'), 'имя переменной окружения gate не в подсказке');
  assert.ok(head.includes('"id":"inline-check"'));
  assert.ok(!head.includes(inline), 'значение секрета в команде gate замаскировано');
  // Окружение блокирует gate — completed=true, если работа сделана (не unfinished).
  assert.match(WRITER_SELF_CHECK_TEXT, /still return completed=true when the work itself is done/);
  delete process.env.HARNESS_TEST_INLINE_SECRET;
  // A3: чеклист сбойных путей — исполнителю; A2: reviewer попытки.
  assert.ok(head.includes(FAILURE_PATHS_WRITER_TEXT), 'чеклист исполнителю');
  assert.ok(!head.includes(FAILURE_PATHS_REVIEW_TEXT));
  const reviewer = readFileSync(`${ctx.scenarioPath}.reviewer.0.prompt`, 'utf8');
  assert.ok(reviewer.includes(FAILURE_PATHS_REVIEW_TEXT), 'чеклист reviewer попытки');
  assert.ok(!reviewer.includes(FAILURE_PATHS_WRITER_TEXT));
  ctx.store.close();
});

/** Тексты чеклиста — договор (alpha.71 A2/A3), записаны независимо от реализации. */
const PATHS =
  'the response is lost or times out (the client retries or gives up); the same request is retried or submitted twice; the client is offline or the network drops mid-request; a dependency (database, queue, storage, external API) is down or slow; state is expired or abandoned (an upload, session, reservation or link left half-way); concurrent requests touch the same data';

test('A2/A3: тексты чеклиста сбойных путей', () => {
  assert.equal(
    FAILURE_PATHS_REVIEW_TEXT,
    'Failure paths: for each user scenario in the order (and in the brief), check what happens when ' +
      PATHS +
      '. A scenario that loses or corrupts data, deletes what it should keep, gets stuck in an error that a retry cannot clear, or takes down another page or screen on such a path is a blocking finding, even when no acceptance criterion names that path.',
  );
  assert.equal(
    FAILURE_PATHS_WRITER_TEXT,
    'Before you hand back, check the failure paths of your scenarios and handle them: ' +
      PATHS +
      '. The reviewer rejects a scenario that breaks on one of these paths even when no acceptance criterion names it.',
  );
});
