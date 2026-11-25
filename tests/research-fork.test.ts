/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тесты портят сырой JSON политики до разбора схемой.
 */
/**
 * 0.1.0-alpha.70: общее исследование задачи и ответвление сессии. Writer
 * возвращает `research`; оно сохраняется у работы и попадает в запрос
 * следующей попытки (стабильный раздел после постановки). Адаптер с
 * `sessionFork` получает `session.kind: fork` от сессии исследования;
 * reviewer — всегда новая сессия и исследования не видит.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { RuntimeAdapter, RuntimeRequest } from '../src/contracts/index.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { approve, bin, greet, runAll, setup } from './runner-fixture.ts';
import { finding, verdict } from './review-fixture.ts';

const WORK = 'add-greeting';
const research = {
  summary: 'greet живёт в src/greet.js, тесты — test/run.js через JUnit',
  files: [{ path: 'src/greet.js', why: 'реализация greet' }],
  approach: 'Строка шаблоном',
  constraints: null,
};

test('исследование сохраняется у работы, следующая попытка начинает с него; сессия ответвляется, reviewer — новая', async () => {
  const sessions: { task: string; session: RuntimeRequest['session'] }[] = [];
  const wrap = (runtime: 'claude' | 'codex'): RuntimeAdapter => {
    const base = cliAdapter(runtime, { executable: bin(`fake-${runtime}`) });
    return {
      runtime,
      capabilities: async () => ({ ...(await base.capabilities()), sessionFork: true }),
      invoke: async (r, signal) => {
        sessions.push({ task: r.task, session: r.session });
        const res = await base.invoke({ ...r, session: { kind: 'fresh' } }, signal);
        return { ...res, sessionId: 'sess-research-1' };
      },
    };
  };
  const ctx = setup({
    scenario: {
      writer: [
        {
          files: { 'src/greet.js': greet },
          result: { completed: true, summary: 'Добавлена greet', discoveries: [], research },
        },
        {
          files: { 'src/greet.js': greet },
          result: { completed: true, summary: 'Исправлено', discoveries: [] },
          recordPrompt: true,
        },
      ],
      reviewer: [
        {
          ...verdict(false, { findings: [finding('Нет проверки пустого имени')] }),
          recordPrompt: true,
        },
        {
          ...verdict(true, {
            previous: [{ id: '$open:0', status: 'closed', basis: 'Проверка есть' }],
          }),
        },
        approve(),
      ],
      refuter: [{ result: { summary: 'ok', verdicts: [], missed: [] } }],
    } as any,
    policy: (p: any) => (p.maxAttempts = 3),
    runner: { adapters: { claude: wrap('claude'), codex: wrap('codex') } },
  });
  await runAll(ctx);
  ctx.engine.retry(WORK);
  await ctx.runner.drain();
  const work = ctx.engine.read((v) => v.work(WORK)!);
  assert.equal(work.research?.attempt, 1);
  assert.match(work.research?.text ?? '', /greet живёт в src\/greet\.js/);
  assert.match(work.research?.text ?? '', /- src\/greet\.js: реализация greet/);
  assert.deepEqual(work.research?.session, { runtime: 'claude', id: 'sess-research-1' });
  const second = readFileSync(`${ctx.scenarioPath}.writer.1.prompt`, 'utf8');
  assert.match(second, /Saved research[\s\S]*## this work \(attempt 1\)[\s\S]*greet живёт/);
  // Исследование — сразу после постановки, до области записи и истории.
  assert.ok(second.indexOf('Saved research') < second.indexOf('Write scope'));
  const reviewer = readFileSync(`${ctx.scenarioPath}.reviewer.0.prompt`, 'utf8');
  assert.doesNotMatch(reviewer, /Saved research/);
  const writers = sessions.filter((s) => s.task === 'implement');
  assert.deepEqual(writers[0]!.session, { kind: 'fresh' });
  assert.deepEqual(writers[1]!.session, { kind: 'fork', id: 'sess-research-1' });
  const reviews = sessions.filter((s) => s.task !== 'implement');
  assert.ok(reviews.length >= 2);
  assert.ok(
    reviews.every((s) => s.session.kind === 'fresh'),
    'reviewer — всегда новая сессия',
  );
});
