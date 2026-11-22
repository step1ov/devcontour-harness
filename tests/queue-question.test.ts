/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тест правит сырой JSON примера до разбора схемой.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainDataSchema, statusDataSchema, workGraphSchema } from '../src/contracts/index.ts';
import { statusOf, statusText } from '../src/control/status.ts';
import { diagnoseState, explainText } from '../src/explain/diagnose.ts';
import { operatorView } from '../src/projections/operator-view.ts';
import { review, trustNone } from './engine-fixture.ts';
import { baseInput } from './operator-view-input.ts';
import { approve, runAll, setup } from './runner-fixture.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { bin } from './runner-fixture.ts';

const ask = {
  files: { 'src/greet.js': "exports.greet = () => 'draft';\n" },
  result: {
    completed: false,
    summary: 'Нужен ответ',
    discoveries: [],
    inputRequest: {
      question: 'Which greeting text?',
      options: [
        { id: 'hello', label: 'Hello, <name>!', consequence: null },
        { id: 'hi', label: 'Hi <name>', consequence: 'shorter' },
      ],
      recommended: 'hello',
      severity: 9,
      rationale: 'User-visible text',
      affects: [],
    },
    assumptions: [],
  },
};

test('alpha.67 P5-4: вопрос держит только свою работу — никто не запущен, готовые есть: «запустите harness run» ходом ведущего', async () => {
  const ctx = setup({
    scenario: { writer: [ask], reviewer: approve() },
    policy: (p: any) => (p.inputPolicy = { threshold: 7, criticalPaths: [] }),
    graph: (g: any) => (g.orders[0].id = 'ask-a'),
  });
  await runAll(ctx);
  // Запуск закончился: роль controller отпущена.
  ctx.runner.release();
  // Вторая, независимая работа согласована, но запуска после вопроса не было.
  const order = structuredClone(ctx.graph.orders[0]!) as any;
  const second = workGraphSchema.parse({
    ...ctx.graph,
    id: 'second',
    source: { ...ctx.graph.source, ref: 'second.json' },
    orders: [{ ...order, id: 'b-ready', source: { ...order.source, ref: 'b-ready' } }],
  });
  const { graph } = ctx.engine.register(second, trustNone);
  ctx.engine.recordReview({
    ...review(graph, 1),
    authorRuntime: ctx.policy.roles.developer!.writer.runtime,
    reviewerRuntime: ctx.policy.review.plan.reviewer.runtime,
    reviewerBinding: ctx.engine.reviewerBinding(
      'plan',
      ctx.policy.roles.developer!.writer.runtime,
    )!,
  });
  ctx.engine.approve(graph.id, 'agent');

  const status = statusDataSchema.parse(statusOf({ engine: ctx.engine, policy: ctx.policy }));
  assert.equal(status.works.find((w) => w.id === 'ask-a')?.input?.state, 'awaiting-answer');
  assert.equal(status.runner?.state, 'not-running');
  assert.equal(status.runner?.restartBy, 'lead');
  assert.equal(status.runner?.ready, 1);
  assert.deepEqual(status.runner?.heldByQuestion, ['ask-a']);
  assert.equal(
    status.runner?.line,
    'Очередь стоит — никто не запущен: запустите harness run: готово 1 задача, вопрос блокирует только ask-a (ведущий).',
  );
  assert.match(statusText(status), /запустите harness run: готово 1 задача/);
  ctx.store.close();

  const explained = explainDataSchema.parse(
    await diagnoseState({
      stateDir: ctx.state,
      policy: ctx.policy,
      baseDir: ctx.repo.dir,
      adapters: {
        claude: cliAdapter('claude', { executable: bin('fake-claude'), toolProfiles: {} }),
        codex: cliAdapter('codex', { executable: bin('fake-codex'), toolProfiles: {} }),
      },
    }),
  );
  assert.deepEqual(
    { ...explained.queue, line: undefined, lineEn: undefined },
    {
      actor: 'lead',
      action: 'start-run',
      ready: 1,
      heldByQuestion: ['ask-a'],
      line: undefined,
      lineEn: undefined,
    },
  );
  assert.match(
    explainText(explained),
    /^→ lead: Очередь стоит — никто не запущен: запустите harness run/,
  );
});

test('alpha.67 P5-4: вопрос владельцу в источнике задач — строка очереди панели называет запуск готовых', () => {
  const view = operatorView(
    baseInput({
      queue: {
        paused: false,
        runner: 'not-running',
        restartBy: 'lead',
        ready: 3,
        line: 'Очередь стоит — никто не запущен: работу сдвинет только новый запуск (ведущий: harness run).',
      },
      sources: [
        {
          connector: 'relay',
          provider: 'relay-v2-cli',
          tasks: [],
          questions: [
            {
              id: 'q1',
              key: 'DOC-2',
              title: 'Телефон',
              options: [],
              targets: ['WEB-1'],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(
    view.progress.queue.line,
    'Очередь стоит — никто не запущен: запустите harness run: готово 3 задачи, вопрос владельцу блокирует только WEB-1 (ведущий).',
  );
  assert.equal(view.progress.queue.restartBy, 'lead');
  // Без готовых работ строка прежняя.
  const idle = operatorView(
    baseInput({ queue: { paused: false, runner: 'not-running', line: 'прежняя строка' } }),
  );
  assert.equal(idle.progress.queue.line, 'прежняя строка');
});
