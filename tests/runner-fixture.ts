/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Фикстура правит сырой JSON примера до разбора схемой.
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executionPolicySchema,
  workGraphSchema,
  type ExecutionPolicy,
  type RuntimeName,
  type WorkGraph,
} from '../src/contracts/index.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { Engine } from '../src/engine/engine.ts';
import { Runner, type RunnerOptions } from '../src/engine/runner.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { review, trustNone } from './engine-fixture.ts';
import { example } from './fixtures.ts';
import { repo } from './git-fixture.ts';

export const bin = (name: 'fake-codex' | 'fake-claude') =>
  fileURLToPath(new URL(`./fixtures/bin/${name}`, import.meta.url));

/**
 * Тест-раннер проекта: проверяет src/greet.js и пишет JUnit. На integration
 * падает, если в репозитории есть файл FAIL_ON_INTEGRATION (кандидат зелёный,
 * интеграция красная).
 */
const testRunner = `
const fs = require('fs');
let ok = false, message = '';
try {
  const { greet } = require(process.cwd() + '/src/greet.js');
  ok = greet('Ada') === 'Hello, Ada!';
  message = 'got ' + greet('Ada');
} catch (e) { message = String(e.message); }
if (process.env.DEVCONTOUR_PHASE === 'integration' && fs.existsSync('FAIL_ON_INTEGRATION')) { ok = false; message = 'integration only'; }
const esc = (s) => s.replace(/[<&"]/g, '');
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,
  '<testsuite><testcase classname="greet" name="greets">' + (ok ? '' : '<failure message="' + esc(message) + '"/>') + '</testcase></testsuite>');
`;

export const greet = "exports.greet = (name) => 'Hello, ' + name + '!';\n";

export interface Scenario {
  writer?: unknown;
  reviewer?: unknown;
}

export const approve = (summary = 'Критерии выполнены') => ({
  result: {
    approved: true,
    summary,
    findings: [],
    discoveries: [],
    execution: { commands: [], noCommandsReason: 'Проверка по diff и evidence' },
    previous: [],
  },
});
export const implement = (files: Record<string, string> = { 'src/greet.js': greet }) => ({
  files,
  result: { completed: true, summary: 'Добавлена greet', discoveries: [] },
});

export function setup(options: {
  writer?: RuntimeName;
  reviewer?: RuntimeName;
  vendor?: 'different-vendor' | 'same-vendor-allowed';
  scenario: Scenario;
  policy?: (p: Record<string, unknown>) => void;
  files?: Record<string, string>;
  graph?: (g: Record<string, unknown>) => void;
  now?: () => number;
  /** Дополнительные параметры Runner (хуки хоста, контекст). */
  runner?: Partial<RunnerOptions>;
}) {
  const r = repo({ 'README.md': 'app\n', 'test/run.js': testRunner, ...options.files });
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'harness-state-')));
  const scenarioPath = join(state, '..', 'scenario-' + state.split('-').at(-1) + '.json');
  writeFileSync(scenarioPath, JSON.stringify(options.scenario));
  const raw = structuredClone(example('policy')) as Record<string, any>;
  raw.repositories[0].path = r.dir;
  raw.repositories[0].gates[0].command = [process.execPath, 'test/run.js'];
  raw.roles.developer.writer.runtime = options.writer ?? 'claude';
  for (const k of ['code', 'plan', 'contract'])
    raw.review[k] = {
      reviewer: { runtime: options.reviewer ?? 'codex' },
      ...(options.vendor ? { vendor: options.vendor } : {}),
    };
  raw.isolation = { mode: 'none', domains: [] };
  raw.environment = { values: { FIXTURE_SCENARIO: scenarioPath } };
  raw.leaseMs = 30000;
  raw.runTimeoutMs = 60000;
  options.policy?.(raw);
  const policy: ExecutionPolicy = executionPolicySchema.parse(raw);
  r.git('update-ref', policy.repositories[0]!.targetRef, 'HEAD');
  const store = new SqliteExecutionStore(join(state, 'state.sqlite'), 'test');
  const engine = new Engine({
    host: standaloneHost(store, policy),
    policy,
    ...(options.now ? { now: options.now } : {}),
  });
  const runner = new Runner({
    engine,
    stateDir: state,
    baseDir: r.dir,
    adapters: {
      claude: cliAdapter('claude', {
        executable: bin('fake-claude'),
        toolProfiles: policy.toolProfiles,
      }),
      codex: cliAdapter('codex', {
        executable: bin('fake-codex'),
        toolProfiles: policy.toolProfiles,
      }),
    },
    owner: 'runner-1',
    resourceDatabase: join(state, 'resources.sqlite'),
    ...options.runner,
  });
  const graphRaw = structuredClone(example('graph')) as Record<string, any>;
  graphRaw.orders[0].writeScope = ['src'];
  options.graph?.(graphRaw);
  const graph: WorkGraph = workGraphSchema.parse(graphRaw);
  return { repo: r, state, scenarioPath, policy, store, engine, runner, graph };
}

/** Регистрация, ревью плана, согласование, запуск очереди и работа до простоя. */
export async function runAll(ctx: ReturnType<typeof setup>) {
  await ctx.runner.init();
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  if (!ctx.engine.reviews('plan', graph.id).some((r) => r.digest === graph.digest && r.approved))
    ctx.engine.recordReview({
      ...review(graph, ctx.engine.reviews('plan', graph.id).length + 1),
      authorRuntime: ctx.policy.roles.developer!.writer.runtime,
      reviewerRuntime: ctx.policy.review.plan.reviewer.runtime,
      reviewerBinding: ctx.engine.reviewerBinding(
        'plan',
        ctx.policy.roles.developer!.writer.runtime,
      )!,
    });
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  await ctx.runner.drain();
  return graph;
}

export const target = (ctx: ReturnType<typeof setup>) =>
  ctx.repo.git('rev-parse', ctx.policy.repositories[0]!.targetRef);
