import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_OWNER, type RuntimeRequest } from '../src/contracts/index.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { parseUsage } from '../src/agents/usage.ts';
import { measuredInvoke } from '../src/engine/measured.ts';
import { callRecords, priceUsage, usageTotals } from '../src/engine/usage.ts';
import { engineOf, graphOf, ready } from './engine-fixture.ts';

test('Документированная телеметрия Codex JSONL переживает посторонние события; оборванный поток — неполный', () => {
  const output = readFileSync(new URL('./fixtures/codex-events.jsonl', import.meta.url), 'utf8');
  const usage = parseUsage('codex', output, true);
  assert.equal(usage.inputTokens, 24763);
  assert.equal(usage.cacheReadTokens, 24448);
  assert.equal(usage.outputTokens, 122);
  assert.equal(usage.reportedUsd, null);
  assert.equal(parseUsage('codex', output + '{truncated', true).complete, false);
  assert.equal(parseUsage('codex', output + '{truncated', true).inputTokens, 24763);
});

test('Телеметрия нормализует кэш-токены; неверные, отсутствующие и частичные данные — никогда не ноль', () => {
  const claude = parseUsage(
    'claude',
    JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
      total_cost_usd: 0.12,
    }),
    true,
  );
  assert.equal(claude.inputTokens, 80);
  assert.equal(claude.reportedUsd, 0.12);
  const line = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 25 },
  });
  const codex = parseUsage('codex', line + '\n' + line, true);
  assert.equal(codex.inputTokens, 200);
  assert.equal(codex.outputTokens, 50);
  assert.equal(codex.cacheReadTokens, 140);
  const price = {
    runtime: 'codex' as const,
    model: 'fixture',
    effectiveAt: '2026-01-01T00:00:00Z',
    input: 10,
    output: 20,
    cacheRead: 1,
    cacheWrite: 5,
  };
  assert.equal(priceUsage(codex, price).costUsd, 0.00174);
  assert.equal(priceUsage(claude, price).costSource, 'provider-reported');
  assert.equal(parseUsage('codex', 'invalid', true).inputTokens, null);
  // Слова модели о стоимости в структурированном ответе — не телеметрия.
  assert.equal(
    parseUsage('claude', '{"structured_output":{"total_cost_usd":0}}', true).reportedUsd,
    null,
  );
  assert.equal(parseUsage('codex', line, false).complete, false);
  assert.equal(priceUsage({ ...codex, cacheReadTokens: null }, price).costUsd, null);
  assert.equal(
    parseUsage(
      'codex',
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: -1 } }),
      true,
    ).inputTokens,
    null,
  );
  assert.equal(usageTotals([]).costUsd, null);
});

/** Executable codex: версия и телеметрия, затем отказ процесса. */
function failingCodex() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-usage-'));
  const bin = join(dir, 'codex');
  writeFileSync(
    bin,
    `#!${process.execPath}
if (process.argv.includes('--version')) console.log('codex fixture-only');
else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'x' } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 } }));
    console.error('provider secret-token failed');
    process.exitCode = 1;
  });
}
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin };
}

test('Отказ процесса runtime: телеметрия сохранена, версия — вызванного исполняемого файла; ошибочный вызов остаётся в учёте без текста запроса и вывода', async () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const run = engine.claim('c1')!;
  const { dir, bin } = failingCodex();
  const request: RuntimeRequest = {
    callId: 'call-cli',
    task: 'implement',
    binding: { runtime: 'codex', model: 'fixture-model' },
    cwd: dir,
    prompt: 'private task text',
    session: { kind: 'fresh' },
    sandbox: { mode: 'none', writable: [dir], denied: [], network: { domains: [] } },
    timeoutMs: 20_000,
    env: { PATH: process.env.PATH ?? '' },
    artifactDir: join(dir, 'artifacts'),
    secrets: ['secret-token'],
  };
  const response = await measuredInvoke(
    engine,
    cliAdapter('codex', { executable: bin }),
    request,
    new AbortController().signal,
    { repositoryId: 'app', runId: run.id, stage: 'implementation' },
  );
  assert.equal(response.status, 'failed');
  const records = engine.read((v) => callRecords(v));
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.runtimeVersion, 'codex fixture-only');
  assert.equal(record.usage.inputTokens, 100);
  assert.equal(record.usage.complete, false);
  assert.equal(record.outcome, 'error');
  assert.equal(record.workId, 'a');
  assert.equal(usageTotals([record]).costUsd, null);
  assert.equal(usageTotals([record]).unknownCalls, 1);
  assert.ok(!JSON.stringify(record).includes('private task text'), 'текста запроса нет');
  assert.ok(!JSON.stringify(record).includes('secret'), 'вывода и секретов нет');
  // Запись — у репозитория попытки, а не у workspace.
  assert.equal(
    engine.read((v) => v.locals('usage', WORKSPACE_OWNER).length),
    0,
  );
  assert.equal(
    engine.read((v) => v.locals('usage', 'app').length),
    1,
  );
});
