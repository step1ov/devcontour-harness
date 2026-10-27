import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_OWNER, type RuntimeRequest } from '../src/contracts/index.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { LINE_LIMIT, parseUsage, usageStream } from '../src/agents/usage.ts';
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

/**
 * Executable claude с долгим потоком: событий больше предела runtime.log и
 * хвоста stdout, итоговое событие `result` со стоимостью — последним.
 */
function verboseClaude(bytes: number) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-usage-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!${process.execPath}
if (process.argv.includes('--version')) console.log('claude fixture-only');
else {
  process.stdin.resume();
  process.stdin.on('end', async () => {
    const write = (event) => new Promise((done) => process.stdout.write(JSON.stringify(event) + '\\n', done));
    await write({ type: 'system', subtype: 'init', model: 'fixture-model' });
    const text = 'x'.repeat(100_000);
    for (let sent = 0; sent < ${bytes}; sent += text.length)
      await write({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    await write({
      type: 'result',
      is_error: false,
      structured_output: { ok: true },
      total_cost_usd: 17.25,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    });
  });
}
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin };
}

test('Стоимость долгого вызова: итоговое событие result за пределом runtime.log и хвоста stdout всё равно учтено полностью', async () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const run = engine.claim('c1')!;
  const { dir, bin } = verboseClaude(12_000_000);
  const artifactDir = join(dir, 'artifacts');
  const response = await measuredInvoke(
    engine,
    cliAdapter('claude', { executable: bin }),
    {
      callId: 'call-long',
      task: 'implement',
      binding: { runtime: 'claude' },
      cwd: dir,
      prompt: 'task',
      session: { kind: 'fresh' },
      sandbox: { mode: 'none', writable: [dir], denied: [], network: { domains: [] } },
      timeoutMs: 60_000,
      env: { PATH: process.env.PATH ?? '' },
      artifactDir,
    },
    new AbortController().signal,
    { repositoryId: 'app', runId: run.id, stage: 'implementation' },
  );
  assert.equal(response.status, 'ok');
  const log = readFileSync(join(artifactDir, 'runtime.log'), 'utf8');
  assert.ok(!log.includes('total_cost_usd'), 'итоговой строки в ограниченном журнале нет');
  const [record] = engine.read((v) => callRecords(v));
  assert.equal(record!.usage.reportedUsd, 17.25);
  assert.equal(record!.usage.inputTokens, 80);
  assert.equal(record!.usage.complete, true);
  assert.equal(record!.model, 'fixture-model');
  assert.equal(usageTotals([record!]).costUsd, 17.25);
  const diagnostics = JSON.parse(readFileSync(join(artifactDir, 'runtime.json'), 'utf8')) as {
    usage: { reportedUsd: number };
  };
  assert.equal(diagnostics.usage.reportedUsd, 17.25);
});

test('Телеметрия потока: строки, разорванные между фрагментами, собираются; испорченная строка делает учёт неполным', () => {
  const result = JSON.stringify({
    type: 'result',
    total_cost_usd: 0.5,
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    },
  });
  const whole = usageStream('claude');
  for (const piece of [
    '{"type":"sys',
    'tem","model":"m"}\n' + result.slice(0, 20),
    result.slice(20),
  ])
    whole.push(piece);
  assert.deepEqual(
    [whole.usage(true).reportedUsd, whole.usage(true).complete, whole.model()],
    [0.5, true, 'm'],
  );
  const broken = usageStream('claude');
  broken.push('{"type":"assistant"\n' + result + '\n');
  assert.equal(broken.usage(true).reportedUsd, 0.5);
  assert.equal(broken.usage(true).complete, false);
  const turn = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2 },
  });
  const codex = usageStream('codex');
  codex.push(turn + '\n' + turn + '\n');
  assert.equal(codex.usage(true).inputTokens, 10);
});

test('Телеметрия потока: учитывается последнее result и первая модель; слишком длинная строка — неполный учёт', () => {
  const result = (usd: number) =>
    JSON.stringify({
      type: 'result',
      total_cost_usd: usd,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      },
    });
  const two = usageStream('claude');
  two.push(
    [
      JSON.stringify({ type: 'system', model: 'first' }),
      result(1),
      JSON.stringify({ type: 'system', model: 'second' }),
      result(2),
      '',
    ].join('\n'),
  );
  assert.equal(two.usage(true).reportedUsd, 2);
  assert.equal(two.model(), 'first');
  const long = usageStream('claude');
  long.push('{"type":"assistant","text":"' + 'x'.repeat(LINE_LIMIT));
  long.push('"}\n' + result(3) + '\n');
  assert.equal(long.usage(true).reportedUsd, 3);
  assert.equal(long.usage(true).complete, false, 'строка длиннее предела не разобрана');
  assert.ok(LINE_LIMIT <= 8_000_000);
});

test('Телеметрия потока: глубоко вложенный usage не роняет обработчик вывода', () => {
  const depth = 200_000;
  const deep = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
  const stream = usageStream('claude');
  assert.doesNotThrow(() =>
    stream.push('{"type":"result","total_cost_usd":1.5,"usage":' + deep + '}\n'),
  );
  assert.equal(stream.usage(true).reportedUsd, 1.5);
  const codex = usageStream('codex');
  assert.doesNotThrow(() => codex.push('{"type":"turn.completed","usage":' + deep + '}\n'));
});

test('Прерванный вызов, завершившийся кодом 0, — неполная телеметрия, а стоимость сохранена', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-usage-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!${process.execPath}
if (process.argv.includes('--version')) console.log('claude fixture-only');
else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ type: 'system', model: 'm' }) + '\\n');
    setInterval(() => {}, 1000);
  });
  process.on('SIGTERM', () => {
    process.stdout.write(JSON.stringify({ type: 'result', structured_output: {}, total_cost_usd: 0.4, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) + '\\n', () => process.exit(0));
  });
}
`,
  );
  chmodSync(bin, 0o755);
  const controller = new AbortController();
  const artifactDir = join(dir, 'artifacts');
  const pending = cliAdapter('claude', { executable: bin }).invoke(
    {
      callId: 'call-abort',
      task: 'implement',
      binding: { runtime: 'claude' },
      cwd: dir,
      prompt: 'task',
      session: { kind: 'fresh' },
      sandbox: { mode: 'none', writable: [dir], denied: [], network: { domains: [] } },
      timeoutMs: 60_000,
      env: { PATH: process.env.PATH ?? '' },
      artifactDir,
    },
    controller.signal,
  );
  // Прерывание — после того, как runtime начал отвечать.
  for (let i = 0; i < 200; i++) {
    await new Promise((done) => setTimeout(done, 50));
    try {
      if (readFileSync(join(artifactDir, 'runtime.log'), 'utf8').includes('"system"')) break;
    } catch {
      /* журнал ещё не создан */
    }
  }
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 'cancelled');
  assert.equal(response.usage.reportedUsd, 0.4);
  assert.equal(response.usage.complete, false);
});
