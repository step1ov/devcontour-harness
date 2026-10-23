/**
 * A01/A02: файловый сценарий прежнего потребителя через публичный API
 * установленного архива, runtime — fixture executables (подставные CLI, не
 * живые модели). Запускается `node src/scenario.mts` (type stripping Node 24,
 * без tsx и devDependencies harness).
 *
 *   SCENARIO_WORK=<временный каталог> SCENARIO_BIN=<каталог fake-claude/fake-codex>
 *   [SCENARIO_GATE=npm|node] [SCENARIO_FLOWS=cli,api,host]
 *
 * Потоки:
 * - `cli`  — пример `examples/files-only` командами `harness validate/run/result/deliver`;
 * - `api`  — тот же пример через `Harness.run` с прежними WorkSource/ContextSource/ResultSink;
 * - `host` — `examples/single-task` через `Engine` + `Runner` с прежними ExecutionHost/ExecutionStore.
 * Итог — JSON в stdout и `<SCENARIO_WORK>/scenario.json`; любое расхождение — exit 1.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  Engine,
  HARNESS_VERSION,
  Harness,
  Runner,
  cliAdapter,
  executionPolicySchema,
  runResult,
  technicalReview,
  workGraphDigest,
  workGraphSchema,
  type RunResult,
} from 'devcontour-harness';
import { API_VERSION } from 'devcontour-harness/contracts';
import {
  LegacyDirContextSource,
  LegacyFileSink,
  LegacyFileWorkSource,
  LegacyStore,
  legacyHost,
} from './ports.mts';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error('не задано ' + name);
  return value;
};
const work = env('SCENARIO_WORK');
const fixtures = env('SCENARIO_BIN');
const gate = process.env.SCENARIO_GATE ?? 'npm';
const flows = (process.env.SCENARIO_FLOWS ?? 'cli,api,host').split(',');
const require = createRequire(import.meta.url);
const installed = dirname(require.resolve('devcontour-harness/package.json'));
const examples = join(installed, 'examples');
const bin = join(dirname(dirname(installed)), 'node_modules', '.bin', 'harness');
const claude = join(fixtures, 'fake-claude');
const codex = join(fixtures, 'fake-codex');
for (const f of [claude, codex]) chmodSync(f, 0o755);

const report: Record<string, unknown> = { harness: HARNESS_VERSION, apiVersion: API_VERSION, gate };
const check = (ok: unknown, message: string): void => {
  if (!ok) {
    report.failure = message;
    writeFileSync(join(work, 'scenario.json'), JSON.stringify(report, null, 2));
    console.error('scenario: ' + message);
    process.exit(1);
  }
};
process.on('uncaughtException', (error) => {
  check(
    false,
    'исключение: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)),
  );
});
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'consumer',
  GIT_AUTHOR_EMAIL: 'consumer@example.invalid',
  GIT_COMMITTER_NAME: 'consumer',
  GIT_COMMITTER_EMAIL: 'consumer@example.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
/** SHA принятого результата: поле есть только у варианта `accepted`. */
const shaOf = (r: RunResult | undefined) => (r?.outcome === 'accepted' ? r.shas.result : undefined);
const approve = {
  approved: true,
  summary: 'ok',
  findings: [],
  discoveries: [],
  execution: { commands: [], noCommandsReason: 'diff' },
  previous: [],
};

/** Тест примера files-only: проверяет createNote и пишет JUnit, путь задаёт harness. */
const notesTest = `const fs = require('fs');
const path = require('path');
let ok = false;
let message = '';
try {
  const { createNote } = require(process.cwd() + '/src/notes.js');
  const tags = createNote({ tags: [' a', 'a', 'b'] }).tags;
  ok = JSON.stringify(tags) === '["a","b"]';
  message = 'tags = ' + JSON.stringify(tags);
} catch (error) {
  message = String(error.message);
}
const report = process.env.DEVCONTOUR_REPORT_PATH || '.reports/junit.xml';
fs.mkdirSync(path.dirname(report), { recursive: true });
const failure = ok ? '' : '<failure message="' + message.replace(/[<&"]/g, '') + '"/>';
fs.writeFileSync(report, '<testsuite><testcase classname="notes" name="tags">' + failure + '</testcase></testsuite>');
console.log(ok ? 'notes: ok' : 'notes: ' + message);
`;
const notesImpl =
  'exports.createNote = (n) => ({ ...n, tags: [...new Set((n.tags || []).map((t) => t.trim()))] });\n';

/**
 * Проект примера в собственном Git. Пример ставится как есть; добавляются
 * только целевой код (test и package.json — их в примере нет) и настройки
 * fixture-запуска политики: сценарий fixture, без OS sandbox, одна попытка.
 */
function project(name: string, example: string, files: Record<string, string>) {
  const app = join(work, name);
  cpSync(join(examples, example), app, { recursive: true });
  const scenario = join(work, name + '.scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      writer: { files, result: { completed: true, summary: 'change', discoveries: [] } },
      reviewer: { result: approve },
    }),
  );
  const policyPath = join(app, 'policy.json');
  const raw = JSON.parse(readFileSync(policyPath, 'utf8')) as Record<string, unknown> & {
    repositories: { gates: { command: string[] }[] }[];
  };
  raw.isolation = { mode: 'none', domains: [] };
  raw.environment = { values: { FIXTURE_SCENARIO: scenario } };
  raw.maxAttempts = 1;
  // Fixture codex не сообщает стоимость вызова: пределы примера остаются, а
  // неизвестная стоимость fixture не останавливает очередь.
  const budgets = raw.budgets as { onUnknown?: string } | undefined;
  if (budgets) budgets.onUnknown = 'continue';
  if (example === 'files-only') {
    mkdirSync(join(app, 'test'), { recursive: true });
    writeFileSync(join(app, 'test', 'run.js'), notesTest);
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: name, private: true, scripts: { test: 'node test/run.js' } }),
    );
    if (gate === 'node') raw.repositories[0]!.gates[0]!.command = ['node', 'test/run.js'];
  }
  writeFileSync(policyPath, JSON.stringify(raw, null, 2));
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'add', '-A');
  git(app, 'commit', '-qm', 'init');
  return { app, policyPath, state: join(work, name + '-state') };
}

const cliEnv = { ...process.env, HARNESS_CLAUDE_BIN: claude, HARNESS_CODEX_BIN: codex };
const harness = (...args: string[]) => {
  const r = spawnSync(bin, args, { cwd: work, encoding: 'utf8', env: cliEnv });
  let json: { ok?: boolean; data?: any; error?: { code?: string; message?: string } } = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(r.stdout) as typeof json;
  } catch {
    /* вывод не JSON — проверка ниже покажет stderr */
  }
  return { status: r.status, json, stderr: r.stderr };
};

if (flows.includes('cli')) {
  const p = project('notes-cli', 'files-only', { 'src/notes.js': notesImpl });
  const graph = join(p.app, 'graph.json');
  const sink = join(work, 'notes-cli-results');
  const validated = harness('validate', '--graph', graph, '--policy', p.policyPath);
  check(validated.status === 0 && validated.json.ok, 'cli validate: ' + validated.stderr);
  const ran = harness(
    'run',
    '--graph',
    graph,
    '--policy',
    p.policyPath,
    '--state',
    p.state,
    '--sink',
    'file:' + sink,
  );
  check(ran.status === 0, `cli run: exit ${ran.status} ${JSON.stringify(ran.json)} ${ran.stderr}`);
  const result = harness('result', '--state', p.state, '--work', 'add-tags');
  const r = result.json.data?.result as RunResult | undefined;
  const accepted = git(p.app, 'rev-parse', 'refs/heads/harness/accepted');
  check(r?.outcome === 'accepted', 'cli result: ' + JSON.stringify(result.json));
  check(shaOf(r) === accepted, 'cli: result SHA ≠ target ref');
  check(r?.inputs.contextDigest, 'cli: контекст не закреплён');
  const delivered = join(sink, 'add-tags.json');
  check(existsSync(delivered), 'cli: нет файла получателя');
  const before = readFileSync(delivered, 'utf8');
  const again = harness(
    'deliver',
    '--state',
    p.state,
    '--work',
    'add-tags',
    '--sink',
    'file:' + sink,
  );
  check(again.status === 0, 'cli deliver: ' + JSON.stringify(again.json));
  check(readFileSync(delivered, 'utf8') === before, 'cli deliver: повтор переписал запись');
  const status = harness('status', '--state', p.state);
  check(status.status === 0, 'cli status');
  report.cli = {
    outcome: r?.outcome,
    resultSha: shaOf(r),
    contextDigest: r?.inputs.contextDigest,
    delivery: result.json.data?.delivery ?? null,
    redelivered: 'unchanged',
  };
}

if (flows.includes('api')) {
  const p = project('notes-api', 'files-only', { 'src/notes.js': notesImpl });
  const graphPath = join(p.app, 'graph.json');
  const policy = executionPolicySchema.parse(JSON.parse(readFileSync(p.policyPath, 'utf8')));
  const source = new LegacyFileWorkSource();
  const { graph } = await source.fetch(graphPath);
  const context = await new LegacyDirContextSource(join(p.app, 'context')).snapshot(['norms'], {
    repositoryId: 'app',
  });
  const sink = new LegacyFileSink(join(work, 'notes-api-results'), async (result) => {
    if (!(await source.revision(graphPath))) return undefined;
    const current = (await source.fetch(graphPath)).graph;
    return current.orders.find((o) => o.id === result.workOrderId)?.source.revision ?? 'removed';
  });
  const h = Harness.open({
    stateDir: p.state,
    policy,
    baseDir: p.app,
    adapters: {
      claude: cliAdapter('claude', { executable: claude }),
      codex: cliAdapter('codex', { executable: codex }),
    },
  });
  try {
    const ran = await h.run({ graph, context, author: 'external', sink, source });
    check(
      ran.works.every((w) => w.status === 'done'),
      'api run: ' + JSON.stringify(ran.works),
    );
    const envelope = h.result('add-tags');
    const accepted = git(p.app, 'rev-parse', 'refs/heads/harness/accepted');
    check(envelope.result.outcome === 'accepted', 'api: не принят');
    check(shaOf(envelope.result) === accepted, 'api: result SHA ≠ target ref');
    check(sink.writes === 1, 'api: получатель записал ' + sink.writes + ' раз');
    await h.deliver('add-tags', sink);
    check(sink.writes === 1, 'api: повтор доставки создал вторую запись');
    report.api = {
      outcome: envelope.result.outcome,
      resultSha: shaOf(envelope.result),
      sinkWrites: sink.writes,
      delivery: (envelope as { delivery?: unknown }).delivery ?? null,
    };
  } finally {
    h.close();
  }
}

if (flows.includes('host')) {
  const p = project('greeting-host', 'single-task', {
    'src/greet.js': "exports.greet = (n) => 'Hello, ' + n + '!';\n",
  });
  mkdirSync(p.state, { recursive: true });
  const policy = executionPolicySchema.parse(JSON.parse(readFileSync(p.policyPath, 'utf8')));
  const graph = workGraphSchema.parse(JSON.parse(readFileSync(join(p.app, 'graph.json'), 'utf8')));
  const store = new LegacyStore(join(p.state, 'state.sqlite'), 'consumer-alpha5');
  const engine = new Engine({ host: legacyHost(store, policy), policy });
  const runner = new Runner({
    engine,
    stateDir: p.state,
    baseDir: p.app,
    adapters: {
      claude: cliAdapter('claude', { executable: claude }),
      codex: cliAdapter('codex', { executable: codex }),
    },
  });
  try {
    engine.register(graph, { trusted: () => false, reachable: () => true });
    // Согласование как у хоста с собственным ведением: раунд технического ревью
    // плана через публичный technicalReview, затем согласование агентом.
    const adapters = {
      claude: cliAdapter('claude', { executable: claude }),
      codex: cliAdapter('codex', { executable: codex }),
    };
    const review = await technicalReview(engine, policy, adapters, {
      kind: 'plan',
      subject: graph.id,
      digest: workGraphDigest(graph),
      author: 'external',
      instructions: ['Review the plan.', JSON.stringify(graph)],
      cwd: p.app,
      artifactDir: join(p.state, 'reviews', 'plan-1'),
      denied: [p.state],
      meta: { subjectId: graph.id, subjectKind: 'group' },
    });
    check(review.approved, 'host: ревью плана не одобрило граф');
    engine.approve(graph.id, 'agent');
    await runner.init();
    if (engine.read((v) => v.control().paused)) engine.resume();
    await runner.drain();
    runner.release();
    const w = engine.read((v) => v.work('add-greeting'));
    const accepted = git(p.app, 'rev-parse', 'refs/heads/harness/accepted');
    check(w?.status === 'done', 'host: поручение ' + JSON.stringify(w?.status));
    check(w?.resultSha === accepted, 'host: result SHA ≠ target ref');
    const attempt = engine.read((v) =>
      v.attempts('add-greeting').find((a) => a.status !== 'active'),
    );
    check(attempt, 'host: нет завершённой попытки');
    const result = runResult(attempt!, HARNESS_VERSION);
    check(result.outcome === 'accepted', 'host: runResult ' + result.outcome);
    const sink = new LegacyFileSink(join(work, 'greeting-host-results'), () =>
      Promise.resolve(undefined),
    );
    const outcome = await sink.deliver({ key: 'k:' + result.runId, result });
    check(outcome.status === 'delivered', 'host: доставка ' + JSON.stringify(outcome));
    check(store.transactions > 0, 'host: движок не писал через хранилище хоста');
    report.host = {
      outcome: result.outcome,
      resultSha: shaOf(result),
      engineVersion: attempt!.engineVersion ?? null,
      consumerVersion: attempt!.consumerVersion ?? null,
      transactions: store.transactions,
      events: store.events(0, 1000).length,
    };
  } finally {
    store.close();
  }
}

writeFileSync(join(work, 'scenario.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
