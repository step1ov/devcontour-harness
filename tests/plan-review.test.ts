/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тесты правят сырой JSON политики и графа до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_VERSION,
  HarnessError,
  sha256,
  sourceDigest,
  type ContextSnapshot,
  type ErrorCode,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type RuntimeName,
  type RuntimeRequest,
} from '../src/contracts/index.ts';
import { Harness } from '../src/control/harness.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { callRecords } from '../src/engine/usage.ts';
import { graphOf, policyOf } from './engine-fixture.ts';

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};

/**
 * Управляемый reviewer: каждый вызов записывается и сообщает стоимость `usd`.
 * Это проверка механики harness, не качества модели.
 */
function reviewers(usd = 2) {
  const requests: RuntimeRequest[] = [];
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: (request) => {
      requests.push(request);
      return Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'controlled',
        output: { approved: true, summary: 'ok', findings: [], previous: [] },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: usd,
          complete: true,
          source: 'claude-result',
        },
        diagnostics: { exitCode: 0 },
      });
    },
  });
  return { requests, adapters: { codex: adapter('codex'), claude: adapter('claude') } };
}
const open = (
  policy: ExecutionPolicy,
  adapters: Partial<Record<RuntimeName, RuntimeAdapter>>,
  stateDir = mkdtempSync(join(tmpdir(), 'harness-plan-review-')),
) => ({ h: Harness.open({ policy, stateDir, baseDir: process.cwd(), adapters }), stateDir });

const snapshot = (text: string, id = 'norms'): ContextSnapshot => {
  const entry = {
    id,
    kind: 'files',
    version: '1',
    required: true,
    files: [
      {
        path: 'norms.md',
        digest: sha256(text),
        bytes: Buffer.byteLength(text),
        content: { encoding: 'utf8' as const, data: text },
      },
    ],
    references: [],
  };
  return {
    apiVersion: API_VERSION,
    sources: [{ ...entry, digest: sourceDigest(entry) }],
    missing: [],
  };
};
const needsNorms = () => {
  const graph = graphOf({ a: [] });
  graph.orders[0]!.context = ['norms'];
  return graph;
};

test('S2-R1-04/S2.4: reviewer плана получает закреплённый контекст; без снимка и с испорченным снимком — отказ до вызова; другой снимок — новый раунд (оба вендора)', async () => {
  for (const [author, reviewer] of [
    ['claude', 'codex'],
    ['codex', 'claude'],
  ] as const) {
    const { requests, adapters } = reviewers(0);
    const policy = policyOf((p: any) => {
      for (const k of ['plan', 'contract', 'code'])
        p.review[k] = { reviewer: { runtime: reviewer } };
    });
    const { h } = open(policy, adapters);
    const graph = needsNorms();
    await assert.rejects(h.review({ kind: 'plan', graph, author }), refused('NOT_READY'));
    const broken = snapshot('PINNED-CONTEXT-S2-7b6');
    broken.sources[0]!.files[0]!.digest = sha256('другое');
    await assert.rejects(
      h.review({ kind: 'plan', graph, context: broken, author }),
      refused('INVALID_INPUT'),
    );
    const other = snapshot('x', 'other');
    await assert.rejects(
      h.review({ kind: 'plan', graph, context: other, author }),
      refused('NOT_READY'),
    );
    assert.equal(requests.length, 0, 'отказы — до вызова reviewer');

    const first = await h.review({
      kind: 'plan',
      graph,
      context: snapshot('PINNED-CONTEXT-S2-7b6'),
      author,
    });
    assert.equal(first.reviewerRuntime, reviewer);
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.match(
      request.prompt,
      /PINNED-CONTEXT-S2-7b6/,
      'текст закреплённого контекста в запросе',
    );
    assert.match(request.prompt, new RegExp(first.contextDigest!), 'идентичность снимка в запросе');
    assert.deepEqual(request.session, { kind: 'fresh' });
    assert.deepEqual(request.sandbox.writable, []);
    // Тот же граф и снимок — прежний раунд без вызова.
    await h.review({ kind: 'plan', graph, context: snapshot('PINNED-CONTEXT-S2-7b6'), author });
    assert.equal(requests.length, 1);
    // Тот же граф, другой снимок — новый раунд, прежнее одобрение не возвращается.
    const second = await h.review({
      kind: 'plan',
      graph,
      context: snapshot('ИЗМЕНЁННЫЕ НОРМЫ'),
      author,
    });
    assert.equal(second.round, 2);
    assert.equal(requests.length, 2);
    assert.notEqual(second.contextDigest, first.contextDigest);
    assert.match(requests[1]!.prompt, /ИЗМЕНЁННЫЕ НОРМЫ/);
    h.close();
  }
});

test('S2-R1-04: run с другим снимком контекста при неизменном графе проводит новый раунд ревью плана', async () => {
  const { requests, adapters } = reviewers(0);
  const { h } = open(policyOf(), adapters);
  const graph = needsNorms();
  // Только регистрация и согласование: очередь не ведётся без репозитория,
  // поэтому runner останавливается до выдачи — проверяется ревью плана.
  await h.run({ graph, context: snapshot('нормы v1'), author: 'claude' }).catch(() => undefined);
  const before = requests.filter((r) => r.task === 'review-plan').length;
  assert.equal(before, 1);
  await h.run({ graph, context: snapshot('нормы v2'), author: 'claude' }).catch(() => undefined);
  const plans = requests.filter((r) => r.task === 'review-plan');
  assert.equal(plans.length, 2, 'другой контекст — новый раунд');
  assert.match(plans[1]!.prompt, /нормы v2/);
  h.close();
});

test('S2-R1-02/T25: ревью ещё не зарегистрированного плана закрепляет расход за графом и поручениями; повтор после исчерпания — отказ до вызова, и после перезапуска', async () => {
  const { requests, adapters } = reviewers(2);
  const policy = policyOf((p: any) => (p.budgets = { group: { usd: 1 }, work: { usd: 1 } }));
  const { h, stateDir } = open(policy, adapters);
  const graph = graphOf({ a: [] });
  await h.review({ kind: 'plan', graph, author: 'claude' });
  const record = h.engine.read((v) => callRecords(v))[0]!;
  assert.equal(record.groupId, 'g');
  assert.deepEqual(record.workIds, ['a']);
  assert.equal(
    h.engine.read((v) => v.graphs().length),
    0,
    'граф не регистрировался',
  );
  const changed = structuredClone(graph);
  changed.orders[0]!.title = 'Изменённый план';
  await assert.rejects(
    h.review({ kind: 'plan', graph: changed, author: 'claude' }),
    refused('BUDGET_EXHAUSTED'),
  );
  // Изменённый состав (другое поручение) — группа уже исчерпана.
  await assert.rejects(
    h.review({ kind: 'plan', graph: graphOf({ b: [] }), author: 'claude' }),
    refused('BUDGET_EXHAUSTED'),
  );
  assert.equal(requests.length, 1, 'запрещённые вызовы до reviewer');
  h.close();
  const again = open(policy, adapters, stateDir).h;
  await assert.rejects(
    again.review({ kind: 'plan', graph: changed, author: 'claude' }),
    refused('BUDGET_EXHAUSTED'),
  );
  assert.equal(requests.length, 1);
  again.close();
});

test('S2-R1-01/T27: процесс, чью политику сменили на более строгий бюджет, не начинает новых вызовов reviewer', async () => {
  const { requests, adapters } = reviewers(2);
  const loose = policyOf((p: any) => (p.budgets = { total: { usd: 10 } }));
  const { h } = open(loose, adapters);
  h.engine.lead('old');
  h.engine.release('old');
  await h.review({ kind: 'plan', graph: graphOf({ a: [] }), author: 'claude' });
  const strict = policyOf((p: any) => (p.budgets = { total: { usd: 1 } }));
  const next = new Engine({ host: standaloneHost(h.store, strict), policy: strict });
  assert.equal(next.lead('new'), true, 'новая политика применена новым controller');
  assert.ok(h.engine.policyState().stale);
  const before = requests.length;
  const calls = h.engine.read((v) => callRecords(v).length);
  await assert.rejects(
    h.review({ kind: 'plan', graph: graphOf({ b: [] }, '1', 'g-new'), author: 'claude' }),
    refused('APPROVAL_STALE'),
  );
  assert.equal(requests.length, before, 'reviewer не вызывался');
  assert.equal(
    h.engine.read((v) => callRecords(v).length),
    calls,
    'запись вызова не создана',
  );
  assert.equal(h.engine.reviews('plan', 'g-new').length, 0, 'одобрения нет');
  await assert.rejects(
    h.review({
      kind: 'contract',
      contract: { apiVersion: API_VERSION, id: 'api', title: 'API', content: 'Контракт.' },
      author: 'claude',
    }),
    refused('APPROVAL_STALE'),
    'ревью контракта — тот же барьер',
  );
  assert.equal(requests.length, before);
  next.release('new');
  h.close();
});
