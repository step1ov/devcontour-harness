/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call --
 * Фикстура правит сырой JSON политики.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WRITER_SELF_CHECK_TEXT } from '../src/engine/prompt.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';
import { nodeGate } from './git-fixture.ts';

test('writer: подсказка называет команды и cwd gates области и требует самопроверки; значения окружения в неё не попадают', async () => {
  const secret = 'value-of-gate-only-env-7f3a';
  const ctx = setup({
    files: { 'packages/b/package.json': '{"name":"b"}\n' },
    scenario: { writer: { ...implement(), recordPrompt: true }, reviewer: approve() },
    graph: (g: any) => (g.orders[0].gates = ['unit', 'pkg-check']),
    policy: (p: any) => {
      p.harnessMode = 'light';
      p.environment.values.GATE_ONLY_TOKEN = secret;
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
  ctx.store.close();
});
