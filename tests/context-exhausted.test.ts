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
import { repairPolicy, repairRepeats } from '../src/contracts/repair-policy.ts';
import { explainStop } from '../src/projections/stop.ts';
import { classifyFailure } from '../src/engine/classify.ts';
import { repairDecision } from '../src/engine/repair.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';

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
  assert.equal(response.diagnostics.contextExhausted, 'prompt-too-long');
  assert.match(response.diagnostics.reason ?? '', /^код 1: Prompt is too long/);
  assert.equal(runtime.terminalReason, 'prompt_too_long');
  assert.equal(runtime.compactions, undefined);
});

test('Ход остановлен у предела окна без сжатия (blocking_limit, код 1): тот же признак', async () => {
  const { response, runtime } = await invoke(capture('blocking-limit'), 1);
  assert.equal(response.status, 'failed');
  assert.equal(response.diagnostics.contextExhausted, 'blocking-limit');
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

/** Записанный поток, изменённый для ветки, которую живой прогон не дал. */
function derived(
  name: string,
  change: (events: Record<string, unknown>[]) => Record<string, unknown>[],
) {
  const events = readFileSync(capture(name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const path = join(mkdtempSync(join(tmpdir(), 'harness-ctx-stream-')), name + '.jsonl');
  writeFileSync(
    path,
    change(events)
      .map((e) => JSON.stringify(e) + '\n')
      .join(''),
  );
  return path;
}

test('Код 0 с is_error и prompt_too_long: тот же признак, отказ, а не ответ', async () => {
  const { response } = await invoke(capture('prompt-too-long'), 0);
  assert.equal(response.status, 'failed');
  assert.equal(response.diagnostics.contextExhausted, 'prompt-too-long');
  assert.match(response.diagnostics.reason ?? '', /^Prompt is too long/);
});

test('Поток без событий работы (только init и result): нехватка окна — отказ, а не недоступный runtime', async () => {
  const stream = derived('prompt-too-long', (events) =>
    events.filter((e) => e.type !== 'assistant'),
  );
  const { response } = await invoke(stream, 1);
  assert.equal(response.status, 'failed');
  assert.equal(response.diagnostics.contextExhausted, 'prompt-too-long');
  // Тот же поток без признака — недоступный runtime, как прежде.
  const plain = derived('prompt-too-long', (events) =>
    events
      .filter((e) => e.type !== 'assistant')
      .map((e) => (e.type === 'result' ? { ...e, terminal_reason: 'api_error' } : e)),
  );
  assert.equal((await invoke(plain, 1)).response.status, 'unavailable');
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
  assert.equal(repairRepeats('context-exhausted', 'blocking-limit'), 1);
  assert.equal(
    repairRepeats('context-exhausted', 'prompt-too-long'),
    0,
    'подсказка только вырастет',
  );
  assert.equal(repairRepeats('context-exhausted'), 1);
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
  assert.equal(attempts()[0]!.error, 'claude: не хватило окна контекста модели');
  assert.equal(attempts()[0]!.contextLimit, 'blocking-limit');
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

test('prompt_too_long: повтора нет — отказ сразу останавливает цикл с кодом CONTEXT_EXHAUSTED', async () => {
  const ctx = setup({
    scenario: { writer: [{ stream: capture('prompt-too-long'), exit: 1 }, implement()] },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 5),
  });
  await runAll(ctx);
  const [attempt] = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempt!.failureKind, 'context-exhausted');
  assert.equal(attempt!.contextLimit, 'prompt-too-long');
  const work = ctx.engine.read((v) => v.work('add-greeting'))!;
  const decision = ctx.engine.read((v) =>
    repairDecision(v, [work], { budgetLeft: 10, maxAttempts: 5 }),
  );
  assert.equal(decision?.action, 'stop');
  const diagnosis = explainStop({
    kind: 'work',
    work: {
      id: work.id,
      status: work.status,
      attempt: work.attempt,
      failureKind: 'context-exhausted',
      contextLimit: 'prompt-too-long',
    },
    maxAttempts: 5,
    repair: { sameFailureRepairs: 0, groupRepairsUsed: 0, groupRepairBudget: 3 },
    control: { paused: false },
  });
  assert.equal(diagnosis.code, 'CONTEXT_EXHAUSTED');
  assert.equal(diagnosis.retryPlanned, false);
  assert.equal(diagnosis.action, 'diagnose-failure');
  assert.match(diagnosis.message, /превышено уже первым запросом/);
});

test('blocking_limit, затем prompt_too_long: один отпечаток, предел последнего — остановка', async () => {
  const ctx = setup({
    scenario: {
      writer: [
        { stream: capture('blocking-limit'), exit: 1 },
        { stream: capture('prompt-too-long'), exit: 1 },
        implement(),
      ],
    },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 5),
  });
  const work = () => ctx.engine.read((v) => v.work('add-greeting'))!;
  const decide = () =>
    ctx.engine.read((v) => repairDecision(v, [work()], { budgetLeft: 10, maxAttempts: 5 }));
  await runAll(ctx);
  assert.equal(decide()?.action, 'retry');
  ctx.engine.retry('add-greeting');
  ctx.engine.resume();
  await ctx.runner.drain();
  const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.deepEqual(
    attempts.map((a) => a.contextLimit),
    ['blocking-limit', 'prompt-too-long'],
  );
  assert.equal(attempts[0]!.failureFingerprint, attempts[1]!.failureFingerprint);
  assert.equal(decide()?.action, 'stop');
});

test('Reviewer с нехваткой окна: класс context-exhausted, а не review; повтор берёт кандидата, reviewer без подсказки writer', async () => {
  const ctx = setup({
    writer: 'codex',
    reviewer: 'claude',
    scenario: {
      writer: implement(),
      reviewer: [
        { stream: capture('blocking-limit'), exit: 1 },
        { ...approve(), recordPrompt: true },
      ],
    },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 5),
  });
  await runAll(ctx);
  const [first] = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(first!.failureKind, 'context-exhausted', first!.error);
  assert.equal(first!.contextLimit, 'blocking-limit');
  ctx.engine.retry('add-greeting');
  ctx.engine.resume();
  await ctx.runner.drain();
  const second = ctx.engine.read((v) => v.attempts('add-greeting'))[1]!;
  assert.equal(second.reusedFrom?.runId, first!.id, 'кандидат переиспользован');
  const prompt = readFileSync(`${ctx.scenarioPath}.reviewer.1.prompt`, 'utf8');
  assert.doesNotMatch(prompt, /Keep your context small/);
});
