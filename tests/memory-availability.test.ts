import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, contextDigest, type ErrorCode } from '../src/contracts/index.ts';
import { composeContext, memoryContextSource } from '../src/integrations/memory/index.ts';
import type { MemoryMode } from '../src/integrations/memory/index.ts';
import { FakeMemoryProvider } from '../src/integrations/memory/testing.ts';
import { approve, implement } from './runner-fixture.ts';
import { evidence, msetup, reviewAndApprove } from './memory-fixture.ts';

const refused = (code: ErrorCode, pattern?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  if (pattern) assert.match(e.message, pattern);
  return true;
};
const at = { repositoryId: 'app' };
const options = (mode: MemoryMode) => ({
  id: 'memory',
  mode,
  bank: 'project-app',
  project: 'app',
  query: 'q',
  limits: { maxBytes: 4096, maxItems: 10 },
});

test('M02: один недоступный provider — required блокирует до ревью/run, optional оставляет явное ограничение и согласуется, disabled не вызывается', async () => {
  // Позитивный контроль: тот же provider доступен — required даёт источник.
  const provider = new FakeMemoryProvider('fake-hindsight', [{ id: 'm1', text: 'note' }]);
  const control = await memoryContextSource(provider, options('required')).snapshot(['memory'], at);
  assert.equal(control.sources[0]?.id, 'memory');
  provider.calls.recall = 0;
  provider.unavailable('ECONNREFUSED 127.0.0.1:8888');
  const outcome: Record<string, unknown> = {};

  // required: отказ подготовки с причиной; пустой «успешный» ответ не выдумывается.
  {
    const ctx = msetup({
      scenario: { writer: implement(), reviewer: approve() },
      context: ['norms', 'memory'],
    });
    const memory = memoryContextSource(provider, options('required'));
    await assert.rejects(
      composeContext([{ source: ctx.files, ids: ['norms'] }, memory.part()], at),
      refused('NOT_READY', /Обязательная память memory \(fake-hindsight.*ECONNREFUSED/),
    );
    assert.equal(provider.calls.recall, 1);
    // Обход без памяти тоже не проходит: ни ревью плана, ни run.
    const filesOnly = await ctx.files.snapshot(['norms']);
    const h = ctx.open();
    await assert.rejects(
      h.run({ graph: ctx.graph, author: 'claude', context: filesOnly }),
      (e: unknown) => {
        refused('INVALID_INPUT')(e);
        assert.ok(
          (e as HarnessError).issues.some((i) => i.path.join('.') === 'graph.orders.0.context.1'),
          JSON.stringify((e as HarnessError).issues),
        );
        return true;
      },
    );
    await assert.rejects(
      h.review({ kind: 'plan', graph: ctx.graph, context: filesOnly, author: 'claude' }),
      refused('NOT_READY', /нет нужного контекста: memory/),
    );
    assert.equal(ctx.requests.length, 0, 'runtime не вызывался');
    assert.equal(
      h.engine.read((v) => v.attempts().length),
      0,
    );
    assert.equal(
      h.engine.read((v) => v.graph(ctx.graph.id)?.approval),
      undefined,
    );
    outcome.required = {
      status: 'NOT_READY before review/approval/run',
      providerCalls: provider.calls.recall,
      runtimeCalls: ctx.requests.length,
      attempts: 0,
    };
    h.close();
  }

  // optional: снимок без памяти с явным ограничением; согласуется и исполняется.
  {
    const before = provider.calls.recall;
    const ctx = msetup({
      scenario: { writer: implement(), reviewer: approve() },
      context: ['norms'],
    });
    const memory = memoryContextSource(provider, options('optional'));
    const snapshot = await composeContext(
      [{ source: ctx.files, ids: ['norms'] }, memory.part()],
      at,
    );
    assert.equal(provider.calls.recall - before, 1);
    assert.deepEqual(
      snapshot.sources.map((s) => s.id),
      ['norms'],
    );
    assert.equal(snapshot.missing.length, 1);
    assert.equal(snapshot.missing[0]!.id, 'memory');
    assert.match(
      snapshot.missing[0]!.reason,
      /optional memory fake-hindsight unavailable.*ECONNREFUSED/,
    );
    const h = ctx.open();
    const approval = await reviewAndApprove(h, ctx.graph, snapshot);
    assert.ok(approval.changed);
    await h.run({ graph: ctx.graph, author: 'claude', context: snapshot });
    assert.equal(h.result('add-greeting').result.outcome, 'accepted');
    assert.equal(provider.calls.recall - before, 1, 'исполнение не обращается к провайдеру');
    outcome.optional = {
      status: 'approved and accepted without memory',
      missing: snapshot.missing,
      providerCalls: provider.calls.recall - before,
      snapshotDigest: contextDigest(snapshot),
    };
    h.close();
  }

  // disabled: provider не вызывается (и вовсе не нужен — без ключей и SDK).
  {
    const before = provider.calls.recall;
    const ctx = msetup({
      scenario: { writer: implement(), reviewer: approve() },
      context: ['norms'],
    });
    const filesOnly = await ctx.files.snapshot(['norms']);
    const withProvider = await composeContext(
      [
        { source: ctx.files, ids: ['norms'] },
        memoryContextSource(provider, options('disabled')).part(),
      ],
      at,
    );
    const noProvider = await composeContext(
      [
        { source: ctx.files, ids: ['norms'] },
        memoryContextSource(undefined, options('disabled')).part(),
      ],
      at,
    );
    assert.equal(provider.calls.recall - before, 0);
    assert.equal(contextDigest(withProvider), contextDigest(filesOnly));
    assert.equal(contextDigest(noProvider), contextDigest(filesOnly));
    assert.throws(
      () => memoryContextSource(undefined, options('optional')),
      refused('INVALID_INPUT', /провайдер не задан/),
    );
    outcome.disabled = {
      status: 'same snapshot as without memory',
      providerCalls: provider.calls.recall - before,
      snapshotDigest: contextDigest(noProvider),
    };
  }
  evidence('M02', 'outcome.json', outcome);
});

test('M02/boundary: ядро и contracts не импортируют память; модуль памяти не тянет SDK, MCP и сеть', () => {
  const root = new URL('..', import.meta.url).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
    );
  for (const file of walk('src').filter((f) => !f.startsWith('src/integrations/')))
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /integrations\/memory/, file);
  for (const file of walk('src/integrations/memory')) {
    const imports = [...readFileSync(join(root, file), 'utf8').matchAll(/from '([^']+)'/g)].map(
      (m) => m[1]!,
    );
    for (const spec of imports)
      assert.ok(
        spec === 'zod' || spec.startsWith('./') || spec === '../../contracts/index.ts',
        `${file}: ${spec}`,
      );
  }
});
