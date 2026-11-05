/**
 * Нехватка окна контекста модели внутри попытки — свой класс отказа
 * `context-exhausted`. Фикстуры — обрезанные записи живого Claude Code
 * 2.1.316 (`--print --output-format stream-json --verbose`, как вызывает
 * адаптер): запрос больше окна (`terminal_reason: prompt_too_long`), ход,
 * остановленный CLI у предела окна при выключенном сжатии
 * (`blocking_limit`), успешное автоматическое сжатие (`compact_boundary`,
 * не отказ) и отказ провайдера по балансу (не нехватка окна).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { usageStream } from '../src/agents/usage.ts';
import type { EventType, RunEvent, RuntimeRequest } from '../src/contracts/index.ts';
import { repairPolicy } from '../src/contracts/repair-policy.ts';
import { classifyFailure } from '../src/engine/classify.ts';
import { repairDecision } from '../src/engine/repair.ts';
import { implement, runAll, setup } from './runner-fixture.ts';

const capture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/context-exhaustion/${name}.jsonl`, import.meta.url));

/** Executable claude, который отдаёт записанный поток и выходит с его кодом. */
function replaying(stream: string, exit: number) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ctx-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!${process.execPath}
const { readFileSync } = require('node:fs');
if (process.argv.includes('--version')) { console.log('claude fixture-only'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(readFileSync(${JSON.stringify(stream)}, 'utf8'), () => process.exit(${exit}));
});
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin };
}

async function invoke(stream: string, exit: number) {
  const { dir, bin } = replaying(stream, exit);
  const artifactDir = join(dir, 'artifacts');
  const request: RuntimeRequest = {
    callId: 'call-ctx',
    task: 'implement',
    binding: { runtime: 'claude' },
    cwd: dir,
    prompt: 'task',
    session: { kind: 'fresh' },
    sandbox: { mode: 'none', writable: [dir], denied: [], network: { domains: [] } },
    timeoutMs: 60_000,
    env: { PATH: process.env.PATH ?? '' },
    artifactDir,
  };
  const response = await cliAdapter('claude', { executable: bin }).invoke(
    request,
    new AbortController().signal,
  );
  const runtime = JSON.parse(readFileSync(join(artifactDir, 'runtime.json'), 'utf8')) as {
    terminalReason?: string;
    compactions?: number;
  };
  return { response, runtime };
}

test('Запрос больше окна (prompt_too_long, код 1): отказ с признаком нехватки окна, а не недоступный runtime', async () => {
  const { response, runtime } = await invoke(capture('prompt-too-long'), 1);
  assert.equal(response.status, 'failed');
  assert.equal(response.diagnostics.contextExhausted, true);
  assert.match(response.diagnostics.reason ?? '', /^код 1: Prompt is too long/);
  assert.equal(runtime.terminalReason, 'prompt_too_long');
  assert.equal(runtime.compactions, undefined);
});

test('Ход остановлен у предела окна без сжатия (blocking_limit, код 1): тот же признак', async () => {
  const { response, runtime } = await invoke(capture('blocking-limit'), 1);
  assert.equal(response.status, 'failed');
  assert.equal(response.diagnostics.contextExhausted, true);
  assert.equal(response.diagnostics.reason, 'код 1: Prompt is too long');
  assert.equal(runtime.terminalReason, 'blocking_limit');
});

test('Успешное автоматическое сжатие — не отказ: ответ принят, сжатие записано в runtime.json', async () => {
  const { response, runtime } = await invoke(capture('auto-compact'), 0);
  assert.equal(response.status, 'ok');
  assert.deepEqual(response.output, { summary: 'alpha760' });
  assert.equal(response.diagnostics.contextExhausted, undefined);
  assert.equal(runtime.compactions, 1);
  assert.equal(runtime.terminalReason, 'completed');
});

test('Отказ по балансу провайдера — не нехватка окна: класс остаётся provider-auth', async () => {
  const { response } = await invoke(capture('billing-error'), 1);
  assert.equal(response.status, 'failed');
  assert.equal(response.diagnostics.contextExhausted, undefined);
  assert.equal(classifyFailure(undefined, response.diagnostics.reason ?? ''), 'provider-auth');
});

test('Телеметрия потока: terminal_reason последнего result и число compact_boundary', () => {
  const stream = usageStream('claude');
  for (const line of readFileSync(capture('auto-compact'), 'utf8').split('\n'))
    stream.push(line + '\n');
  assert.equal(stream.compactions(), 1);
  assert.equal(stream.terminalReason(), 'completed');
  const codex = usageStream('codex');
  codex.push(readFileSync(capture('blocking-limit'), 'utf8'));
  assert.equal(codex.terminalReason(), undefined, 'признак — только у claude');
});

test('Класс по признаку адаптера, а не по тексту: числа токенов с «401» не делают отказ провайдерским', () => {
  // Текст причины prompt_too_long несёт числа токенов; «401» в них совпал бы
  // с признаком отказа провайдера, поэтому класс ставится по признаку адаптера.
  const reason = 'Prompt is too long · the request is ~1401764 tokens (limit 1000000)';
  assert.equal(classifyFailure(undefined, reason), 'provider-auth', 'текстовый разбор ошибся бы');
  assert.equal(repairPolicy['context-exhausted'].action, 'retry');
  assert.equal(repairPolicy['context-exhausted'].repeats, 1);
  assert.equal(repairPolicy['context-exhausted'].blocksQueue, undefined, 'очередь не стоит');
});

const ofType = <T extends EventType>(events: RunEvent[], type: T) =>
  events.flatMap((e) => (e.type === type ? [e as Extract<RunEvent, { type: T }>] : []));

test('Попытка с нехваткой окна: класс context-exhausted, засчитана, один повтор с подсказкой, затем остановка', async () => {
  const exhausted = { stream: capture('blocking-limit'), exit: 1 };
  const ctx = setup({
    scenario: { writer: [exhausted, { ...exhausted, recordPrompt: true }, implement()] },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 5),
  });
  const attempts = () => ctx.engine.read((v) => v.attempts('add-greeting'));
  const work = () => ctx.engine.read((v) => v.work('add-greeting'))!;
  const decide = () =>
    ctx.engine.read((v) => repairDecision(v, [work()], { budgetLeft: 10, maxAttempts: 5 }));
  await runAll(ctx);
  assert.deepEqual(
    attempts().map((a) => [a.status, a.failureKind]),
    [['failed', 'context-exhausted']],
  );
  assert.match(
    attempts()[0]!.error ?? '',
    /не хватило окна контекста модели: код 1: Prompt is too long/,
  );
  assert.equal(work().failureKind, 'context-exhausted');
  assert.equal(work().attempt, 1, 'попытка засчитана');
  assert.equal(ctx.engine.read((v) => v.control()).paused, false, 'выдача не остановлена');
  const first = decide();
  assert.equal(first?.action, 'retry');
  assert.equal(first?.action === 'retry' && first.blocksQueue, false);

  ctx.engine.retry('add-greeting');
  ctx.engine.resume();
  await ctx.runner.drain();
  const prompt = readFileSync(`${ctx.scenarioPath}.writer.1.prompt`, 'utf8');
  assert.match(prompt, /The previous attempt ran out of the model context window\./);
  assert.equal(work().attempt, 2, 'обе попытки засчитаны');
  const second = decide();
  assert.equal(second?.action, 'stop', 'второй такой же отказ останавливает цикл');
  assert.match(second?.reason ?? '', /разделить или сократить контекст/);
  const diagnosed = ofType(ctx.store.events(), 'attempt.diagnosed').map((e) => e.payload);
  assert.deepEqual(diagnosed, [
    { failureKind: 'context-exhausted', cause: 'none', counted: true },
    { failureKind: 'context-exhausted', cause: 'none', counted: true },
  ]);
});
