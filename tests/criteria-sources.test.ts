/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument --
 * Тест строит сырые draft и адаптеры как есть.
 */
/**
 * 0.1.0-alpha.70: ведущий не добавляет требований без источника. Каждый
 * критерий, который пишет ведущий, называет источник (`criteriaSources`);
 * ревью плана получает правило и список критериев без источника; источник
 * несуществующего критерия — отказ plan-check.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeAdapter, RuntimeName, RuntimeRequest } from '../src/contracts/index.ts';
import { workGraphSchema } from '../src/contracts/index.ts';
import { Harness } from '../src/control/harness.ts';
import { draftToGraph } from '../src/planning/graph.ts';
import { unsourcedCriteria, unsourcedCriteriaNote } from '../src/planning/sources.ts';
import { standaloneInstructions } from '../src/planning/standalone.ts';
import { graphOf, policyOf } from './engine-fixture.ts';

test('критерии без источника: по номерам; правило в запросе ревью плана и в указаниях ведущему', () => {
  const order = {
    acceptance: ['из постановки', 'добавил ведущий', 'ответ владельца'],
    criteriaSources: [
      { criterion: 0, kind: 'brief' as const, ref: '§2' },
      { criterion: 2, kind: 'owner-answer' as const, ref: 'Q-1' },
    ],
  };
  assert.deepEqual(unsourcedCriteria(order), [{ criterion: 1, text: 'добавил ведущий' }]);
  const graph = graphOf({ a: [], b: [] });
  graph.orders[0] = { ...graph.orders[0]!, ...order };
  const note = unsourcedCriteriaNote(graph);
  assert.match(note, /unsourced-criterion/);
  assert.match(note, /"order":"a".*добавил ведущий/);
  assert.doesNotMatch(note, /"order":"b"/, 'поручение без поля — критерии постановки как есть');
  assert.match(standaloneInstructions({ requirements: [] }).join('\n'), /criteriaSources/);
});

test('источник несуществующего критерия — отказ draftToGraph; верный — в поручении графа', () => {
  const task = {
    key: 'a',
    title: 'Задача',
    description: 'Описание задачи достаточно длинное',
    role: 'developer',
    repositoryId: 'app',
    scope: 'component' as const,
    dependsOn: [],
    acceptance: ['критерий'],
    contracts: [],
  };
  const facts = {
    repositories: [],
    roles: [],
    gates: [],
    contracts: [],
    contextPacks: [],
    resources: [],
  } as any;
  const source = { connector: 'files', ref: 'g', revision: '1' };
  const bad = draftToGraph(
    {
      title: 'План',
      description: '',
      tasks: [{ ...task, criteriaSources: [{ criterion: 3, kind: 'brief', ref: '§1' }] }],
    } as any,
    { graphId: 'g', source, facts },
  );
  assert.equal(bad.graph, undefined);
  assert.deepEqual(bad.issues[0]?.path, ['tasks', 0, 'criteriaSources', 0, 'criterion']);
  const good = draftToGraph(
    {
      title: 'План',
      description: '',
      tasks: [
        {
          ...task,
          labels: ['auth'],
          criteriaSources: [{ criterion: 0, kind: 'review-finding', ref: 'F-1' }],
        },
      ],
    } as any,
    { graphId: 'g', source, facts },
  );
  assert.deepEqual(good.issues, []);
  assert.deepEqual(good.graph?.orders[0]?.criteriaSources, [
    { criterion: 0, kind: 'review-finding', ref: 'F-1' },
  ]);
  assert.deepEqual(good.graph?.orders[0]?.labels, ['auth']);
  assert.ok(workGraphSchema.safeParse(good.graph).success);
});

test('ревью плана получает критерии без источника', async () => {
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
          reportedUsd: 0,
          complete: true,
          source: 'claude-result',
        },
        diagnostics: { exitCode: 0 },
      });
    },
  });
  const h = Harness.open({
    policy: policyOf(),
    stateDir: mkdtempSync(join(tmpdir(), 'harness-sources-')),
    baseDir: process.cwd(),
    adapters: { codex: adapter('codex'), claude: adapter('claude') },
  });
  const graph = graphOf({ a: [] });
  graph.orders[0] = {
    ...graph.orders[0]!,
    acceptance: ['из постановки', 'новое требование ведущего'],
    criteriaSources: [{ criterion: 0, kind: 'brief', ref: '§1' }],
  };
  await h.review({ kind: 'plan', graph, author: 'claude' });
  assert.match(requests[0]!.prompt, /Criteria without a cited source.*новое требование ведущего/);
  h.close();
});
