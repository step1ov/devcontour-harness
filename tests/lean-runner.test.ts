import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfile } from '../src/profiles/resolve.ts';
import { profileExecution } from '../src/init/policy.ts';
import { approve, greet, implement, runAll, setup } from './runner-fixture.ts';

/**
 * Два независимых готовых поручения; политика — параметры исполнения
 * профиля (`profileExecution`). Возвращает наибольшее число одновременно
 * активных попыток, замеченное во время работы очереди.
 */
async function peakActive(layers: string[]) {
  const execution = profileExecution(resolveProfile('npm-ci', { layers }));
  const ctx = setup({
    scenario: {
      // Любой исполнитель пишет внутри src: порядок выдачи не важен.
      writer: [
        implement({ 'src/greet.js': greet, 'src/a.js': 'exports.a = 1;\n' }),
        implement({ 'src/greet.js': greet, 'src/b.js': 'exports.b = 2;\n' }),
      ],
      reviewer: approve(),
    },
    policy: (p) => {
      Object.assign(p, execution);
      // Граница предела gate слоя (240 с) не больше времени попытки.
      p.runTimeoutMs = 600_000;
    },
    graph: (g) => {
      const orders = g.orders as Record<string, unknown>[];
      orders.push({
        ...orders[0],
        id: 'add-second',
        source: { connector: 'files', ref: 'add-second', revision: '1' },
        title: 'Second independent order',
      });
    },
  });
  let peak = 0;
  const sample = () => {
    const active = ctx.engine.read((v) => v.attempts().filter((a) => a.status === 'active'));
    peak = Math.max(peak, active.length);
  };
  const timer = setInterval(sample, 2);
  try {
    await runAll(ctx);
  } finally {
    clearInterval(timer);
  }
  const works = ctx.engine.read((v) => ['add-greeting', 'add-second'].map((id) => v.work(id)!));
  return { peak, works, policy: ctx.policy };
}

test('lean: с двумя готовыми поручениями runner держит не больше одной попытки', async () => {
  const lean = await peakActive(['lean']);
  assert.equal(lean.policy.concurrency, 1);
  assert.equal(lean.policy.gateTimeoutFloorMs, 240_000);
  assert.equal(lean.peak, 1, 'одновременно активных попыток');
  for (const w of lean.works) assert.equal(w.status, 'done', w.failure);
  // Контроль замера: без слоя (concurrency 2) обе попытки идут одновременно.
  const plain = await peakActive([]);
  assert.equal(plain.policy.concurrency, 2);
  assert.equal(plain.peak, 2, 'без lean замер видит параллельные попытки');
});
