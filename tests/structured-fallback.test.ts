/**
 * F59: строка `result` Claude Code (десятки КБ) обрывалась на выходе
 * процесса, и готовая попытка проваливалась как «структурированный ответ не
 * прочитан». Ответ, принятый инструментом `StructuredOutput`, есть в том же
 * потоке раньше — адаптер берёт его, когда итогового `structured_output` нет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import type { RuntimeRequest } from '../src/contracts/index.ts';

const answer = { completed: true, summary: 'Готово: каналы F2 и F3', discoveries: [] };
const line = (value: unknown) => JSON.stringify(value) + '\n';
const call = (id: string, input: unknown, parent: string | null = null) =>
  line({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'StructuredOutput', input }],
    },
  });
const reply = (id: string, isError = false) =>
  line({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          ...(isError ? { is_error: true } : {}),
          content: isError
            ? 'Output does not match schema'
            : 'Structured output provided successfully',
        },
      ],
    },
  });
// Строка `result`, оборванная посреди текста: без конца и без перевода строки.
const truncated = line({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'x'.repeat(50_000),
  structured_output: answer,
}).slice(0, 39_780);
const init = line({ type: 'system', subtype: 'init', model: 'claude-fixture' });

async function invoke(stream: string) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-f59-'));
  try {
    const file = join(dir, 'stream.jsonl');
    writeFileSync(file, stream);
    const bin = join(dir, 'claude');
    writeFileSync(
      bin,
      `#!${process.execPath}
const { readFileSync } = require('node:fs');
if (process.argv.includes('--version')) { console.log('claude fixture-only'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(readFileSync(${JSON.stringify(file)}, 'utf8'), () => process.exit(0));
});
`,
    );
    chmodSync(bin, 0o755);
    const request: RuntimeRequest = {
      callId: 'call-f59',
      task: 'implement',
      binding: { runtime: 'claude' },
      cwd: dir,
      prompt: 'task',
      session: { kind: 'fresh' },
      sandbox: { mode: 'none', writable: [dir], denied: [], network: { domains: [] } },
      timeoutMs: 60_000,
      env: { PATH: process.env.PATH ?? '' },
      artifactDir: join(dir, 'artifacts'),
    };
    return await cliAdapter('claude', { executable: bin }).invoke(
      request,
      new AbortController().signal,
    );
  } finally {
    // Только свой временный каталог из mkdtemp.
    if (dir.startsWith(join(tmpdir(), 'harness-f59-')))
      rmSync(dir, { recursive: true, force: true });
  }
}

test('F59: оборванная строка result — ответ из принятого вызова StructuredOutput', async () => {
  const response = await invoke(init + call('toolu_1', answer) + reply('toolu_1') + truncated);
  assert.equal(response.status, 'ok', JSON.stringify(response.diagnostics));
  assert.deepEqual(response.output, answer);
});

test('F59: последний принятый вызов, а не отклонённый инструментом и не вызов субагента', async () => {
  const first = { ...answer, summary: 'первый' };
  const response = await invoke(
    init +
      call('toolu_1', first) +
      reply('toolu_1') +
      call('toolu_2', { wrong: true }) +
      reply('toolu_2', true) +
      call('toolu_3', { nested: true }, 'toolu_task') +
      reply('toolu_3') +
      truncated,
  );
  assert.equal(response.status, 'ok', JSON.stringify(response.diagnostics));
  assert.deepEqual(response.output, first);
});

test('F59: без принятого вызова оборванный поток — по-прежнему непрочитанный ответ', async () => {
  for (const stream of [
    init + truncated,
    init + call('toolu_1', answer) + reply('toolu_1', true) + truncated,
  ]) {
    const response = await invoke(stream);
    assert.equal(response.status, 'failed');
    assert.match(response.diagnostics.reason ?? '', /структурированный ответ не прочитан/);
  }
});

test('F59: целая строка result по-прежнему источник ответа', async () => {
  const final = { ...answer, summary: 'итог' };
  const response = await invoke(
    init +
      call('toolu_1', answer) +
      reply('toolu_1') +
      line({ type: 'result', subtype: 'success', is_error: false, structured_output: final }),
  );
  assert.equal(response.status, 'ok');
  assert.deepEqual(response.output, final);
});
