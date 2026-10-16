/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return --
 * Фикстура правит сырой JSON примера до разбора схемой.
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executionPolicySchema,
  workGraphSchema,
  type ExecutionPolicy,
  type WorkGraph,
} from '../src/contracts/index.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { Engine } from '../src/engine/engine.ts';
import { Runner } from '../src/engine/runner.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { example } from './fixtures.ts';
import { repo } from './git-fixture.ts';
import { bin, type Scenario } from './runner-fixture.ts';

/** Собственная проверка компонента: значение — число. */
const unit = `const fs = require('fs');
const ok = /^\\d+$/.test(fs.readFileSync('value.json', 'utf8').trim());
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="value"' + (ok ? '/>' : '><failure message="nan"/></testcase>') + '</testsuite>');
process.exit(ok ? 0 : 1);
`;

/**
 * Проверка потребителя: значение библиотеки равно 2 — напрямую или через
 * artifact промежуточного компонента; если в дереве есть `.expect-prepared`,
 * подготовка потребителя обязана была выполниться.
 */
const verify = `const fs = require('fs');
const paths = JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON);
let via = '';
try {
  via = (paths.mid ? fs.readFileSync(paths.mid + '/built.json', 'utf8') : fs.readFileSync(paths.library + '/value.json', 'utf8')).trim();
} catch (e) { via = 'missing'; }
const prepared = !fs.existsSync('.expect-prepared') || fs.existsSync('.prepared');
const ok = via === '2' && prepared;
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="consumer"' + (ok ? '/>' : '><failure message="via ' + via + ' prepared ' + prepared + '"/></testcase>') + '</testsuite>');
process.exit(ok ? 0 : 1);
`;

const build = `const fs = require('fs');
const p = JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON);
fs.writeFileSync('built.json', fs.readFileSync(p.library + '/value.json', 'utf8'));
`;

export const node = (code: string) => [process.execPath, '-e', code];

/**
 * Три настоящих репозитория: `library`, `product` (зависит от library или,
 * в цепочке, от `mid`), `unrelated`; в цепочке `mid` собирает artifact из
 * значения библиотеки. Поручение меняет библиотеку и называет product
 * потребителем.
 */
export function components(
  options: {
    chain?: boolean;
    scenario?: Scenario;
    policy?: (p: Record<string, any>) => void;
    graph?: (g: Record<string, any>) => void;
  } = {},
) {
  const ids = options.chain ? ['library', 'mid', 'product'] : ['library', 'product', 'unrelated'];
  const repos = Object.fromEntries(
    ids.map((id) => [
      id,
      repo({
        '.gitignore': 'reports/\nbuilt.json\n.prepared\n',
        'value.json': '1\n',
        'unit.js': unit,
        'verify.js': verify,
      }),
    ]),
  );
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'harness-components-')));
  const scenarioPath = join(state, '..', 'scenario-' + state.split('-').at(-1) + '.json');
  writeFileSync(
    scenarioPath,
    JSON.stringify(
      options.scenario ?? {
        writer: {
          files: { 'value.json': '2\n' },
          result: { completed: true, summary: 'value 2', discoveries: [] },
        },
        reviewer: {
          result: {
            approved: true,
            summary: 'ok',
            findings: [],
            discoveries: [],
            execution: { commands: [], noCommandsReason: 'diff' },
            previous: [],
          },
        },
      },
    ),
  );
  const raw = structuredClone(example('policy')) as Record<string, any>;
  const template = raw.repositories[0];
  const gate = (id: string, script: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: 'test',
    command: [process.execPath, script],
    report: { type: 'junit', path: `reports/${id}.xml` },
    ...extra,
  });
  raw.repositories = ids.map((id) => ({
    ...template,
    id,
    path: repos[id]!.dir,
    protectedPaths: ['unit.js', 'verify.js'],
    dependsOn:
      id === 'mid' ? ['library'] : id === 'product' ? [options.chain ? 'mid' : 'library'] : [],
    gates: [
      id === 'library' || id === 'unrelated' ? gate('unit', 'unit.js') : gate('test', 'verify.js'),
    ],
    ...(id === 'mid'
      ? {
          dependencyBuild: [{ id: 'build', command: node(build) }],
          dependencyArtifacts: ['built.json'],
        }
      : {}),
  }));
  raw.roles.developer.writer.runtime = 'claude';
  for (const k of ['code', 'plan', 'contract']) raw.review[k] = { reviewer: { runtime: 'codex' } };
  raw.isolation = { mode: 'none', domains: [] };
  raw.environment = { values: { FIXTURE_SCENARIO: scenarioPath } };
  raw.leaseMs = 60000;
  raw.runTimeoutMs = 120000;
  options.policy?.(raw);
  const policy: ExecutionPolicy = executionPolicySchema.parse(raw);
  for (const r of policy.repositories) repos[r.id]!.git('update-ref', r.targetRef, 'HEAD');
  const store = new SqliteExecutionStore(join(state, 'state.sqlite'), 'test');
  const engine = new Engine({ host: standaloneHost(store, policy), policy });
  const runner = new Runner({
    engine,
    stateDir: state,
    baseDir: state,
    adapters: {
      claude: cliAdapter('claude', { executable: bin('fake-claude') }),
      codex: cliAdapter('codex', { executable: bin('fake-codex') }),
    },
    owner: 'runner-1',
    resourceDatabase: join(state, 'resources.sqlite'),
  });
  const graphRaw = structuredClone(example('graph')) as Record<string, any>;
  graphRaw.orders[0].repositoryId = 'library';
  graphRaw.orders[0].writeScope = ['value.json'];
  delete graphRaw.orders[0].gates;
  graphRaw.orders[0].consumers = [{ repositoryId: 'product', gates: ['test'] }];
  options.graph?.(graphRaw);
  const graph: WorkGraph = workGraphSchema.parse(graphRaw);
  const ref = (id: string) =>
    repos[id]!.git('rev-parse', policy.repositories.find((r) => r.id === id)!.targetRef);
  /** Рабочих деревьев у репозитория, включая основной checkout. */
  const worktrees = (id: string) =>
    repos[id]!.git('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree ')).length;
  return { repos, state, scenarioPath, policy, store, engine, runner, graph, ref, worktrees };
}
