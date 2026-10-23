/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument --
 * Тест читает JSON-ответы CLI как есть; их форму проверяет сам CLI схемой команды.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FileContextSource } from '../src/connectors/files.ts';
import { approve, bin, greet, implement } from './runner-fixture.ts';

/**
 * Маршрут standalone (H1-01, H1-02, H1-04) через настоящий CLI: копия
 * fixture npm-приложения в своём Git → init → overlay fixture runtime →
 * граф только из `facts` init и шаблона пакета → validate → run → result.
 *
 * Runtime — подставные executables (`tests/fixtures/bin/fake-*`), их ответы —
 * сценарий (scripted fixture), не модель: проверяется механика, не качество.
 */
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/standalone/npm-app', import.meta.url));
const integrations = fileURLToPath(new URL('../src/integrations/', import.meta.url));

const gitEnv = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function project() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-standalone-')));
  const app = join(scratch, 'npm-app');
  cpSync(fixture, app, { recursive: true });
  // Точная версия того же менеджера, что выбирает профиль (K10).
  const npm = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  pkg.packageManager = 'npm@' + npm;
  writeFileSync(join(app, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: app,
      encoding: 'utf8',
      env: { ...process.env, ...gitEnv },
    }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');

  // Трассировка загрузки модулей каждого node-процесса (CLI и fake runtimes).
  const traceLog = join(scratch, 'modules.log');
  const trace = join(scratch, 'trace.mjs');
  writeFileSync(
    trace,
    `import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
const log = ${JSON.stringify(traceLog)};
appendFileSync(log, 'process ' + process.pid + '\\n');
registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); if (r.url.startsWith('file:')) appendFileSync(log, new URL(r.url).pathname + '\\n'); return r; } });
`,
  );
  const stateHome = join(scratch, 'state-home');
  const env = {
    ...process.env,
    ...gitEnv,
    NODE_OPTIONS: '--import ' + pathToFileURL(trace).href,
    HARNESS_STATE_HOME: stateHome,
    HARNESS_CLAUDE_BIN: bin('fake-claude'),
    HARNESS_CODEX_BIN: bin('fake-codex'),
    // Ловушки: если бы маршрут обращался к Relay/Hindsight, он увидел бы эти значения.
    RELAY_URL: 'http://127.0.0.1:9/relay-trap',
    RELAY_TOKEN: 'relay-trap-token',
    RELAY_API_KEY: 'relay-trap-key',
    HINDSIGHT_URL: 'http://127.0.0.1:9/hindsight-trap',
    HINDSIGHT_API_KEY: 'hindsight-trap-key',
    HINDSIGHT_BANK: 'hindsight-trap-bank',
  };
  const harness = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd: scratch,
      encoding: 'utf8',
      env,
    });
    let json: any;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = undefined;
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  return { scratch, app, git, harness, traceLog, stateHome };
}

/** Снимок файлов вне `.harness/`: путь → содержимое (tracked и untracked). */
function outside(app: string) {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: app,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f && !f.startsWith('.harness/'));
  return Object.fromEntries(files.sort().map((f) => [f, readFileSync(join(app, f), 'utf8')]));
}

test('H1-01/H1-02/H1-04: npm-приложение → init → граф из facts → run → accepted, без integrations', () => {
  const p = project();
  const before = outside(p.app);
  const headBefore = p.git('rev-parse', 'HEAD');

  const plan = p.harness('init', '--repository', p.app, '--plan');
  assert.equal(plan.status, 0, plan.stderr + plan.stdout);
  assert.equal(plan.json.data.status, 'new');
  assert.equal(plan.json.data.toolchain.ready, true, plan.json.data.toolchain.problems.join('\n'));
  assert.equal(existsSync(join(p.app, '.harness')), false, '--plan ничего не пишет');

  const init = p.harness('init', '--repository', p.app);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  const data = init.json.data;
  assert.equal(data.mode, 'apply');
  assert.deepEqual(
    data.created.map((f: string) => f.slice(p.app.length + 1)),
    ['.harness/.gitignore', '.harness/README.md', '.harness/policy.json', '.harness/project.json'],
  );
  const state: string = data.manifest.paths.state;
  assert.ok(state.startsWith(join(p.stateHome, 'projects') + '/'), state);
  assert.equal(existsSync(state), false, 'init не создаёт state');
  assert.equal(data.profile.id, 'npm-ci');
  assert.equal(data.manifest.runtimes.writer, 'claude');
  assert.equal(data.manifest.runtimes.reviewer, 'codex');

  // Overlay fixture runtime — как smoke-package: isolation none и сценарий ответов.
  const scenario = join(p.scratch, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ writer: implement(), reviewer: approve() }));
  const policyPath = join(p.app, '.harness', 'policy.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  assert.equal(policy.isolation, undefined, 'init оставляет isolation по умолчанию (os)');
  policy.isolation = { mode: 'none', domains: [] };
  policy.environment = { values: { FIXTURE_SCENARIO: scenario } };
  writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n');

  // Граф: только facts init и шаблон пакета; содержание поручения — решение агента.
  const facts = data.facts;
  const template = JSON.parse(readFileSync(facts.graphTemplate, 'utf8'));
  assert.equal(
    facts.graphTemplate,
    fileURLToPath(new URL('../templates/graph.json', import.meta.url)),
  );
  const graph = {
    ...template,
    id: 'greeting',
    source: { connector: 'files', ref: 'greeting.json', revision: '1' },
    orders: [
      {
        ...template.orders[0],
        id: 'add-greeting',
        source: { connector: 'files', ref: 'add-greeting', revision: '1' },
        title: 'Implement greet',
        goal: 'src/greet.js exports greet(name) returning "Hello, <name>!"',
        acceptance: ['greet("Ada") returns "Hello, Ada!"', 'The unit-tests gate passes with JUnit'],
        role: facts.roles[0].id,
        repositoryId: facts.repositoryId,
        writeScope: ['src'],
        gates: facts.gates.map((g: { id: string }) => g.id),
      },
    ],
  };
  mkdirSync(facts.workDir, { recursive: true });
  const graphPath = join(facts.workDir, 'greeting.json');
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n');

  const valid = p.harness('validate', '--graph', graphPath, '--policy', policyPath);
  assert.equal(valid.status, 0, valid.stderr + valid.stdout);

  const run = p.harness(
    'run',
    '--graph',
    graphPath,
    '--policy',
    policyPath,
    '--state',
    state,
    '--author',
    'claude',
  );
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const result = p.harness('result', '--state', state, '--work', 'add-greeting');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const accepted = p.git('rev-parse', 'refs/heads/harness/accepted');
  assert.equal(result.json.data.result.outcome, 'accepted');
  assert.equal(result.json.data.result.shas.result, accepted);
  assert.equal(p.git('show', `${accepted}:src/greet.js`), greet.trimEnd());

  // Повтор init: ничего не пишет, тот же projectId и state.
  const again = p.harness('init', '--repository', p.app);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.deepEqual(again.json.data.created, []);
  assert.equal(again.json.data.status, 'complete');
  assert.equal(again.json.data.projectId, data.projectId);
  assert.equal(again.json.data.manifest.paths.state, state);
  // Новая сессия: только --repository и --plan — решения из manifest.
  const session = p.harness('init', '--repository', p.app, '--plan');
  assert.equal(session.status, 0, session.stderr);
  assert.deepEqual(session.json.data.manifest, data.manifest);
  const status = p.harness('status', '--state', session.json.data.manifest.paths.state);
  assert.equal(status.status, 0, status.stderr);

  // Вне .harness/ checkout не изменён: файлы, HEAD, git status.
  assert.deepEqual(outside(p.app), before);
  assert.equal(p.git('rev-parse', 'HEAD'), headBefore);
  assert.deepEqual(
    p
      .git('status', '--porcelain', '--untracked-files=all')
      .split('\n')
      .filter((l) => !l.startsWith('?? .harness/')),
    [],
  );

  // H1-04: ни один процесс маршрута не загрузил src/integrations/*.
  const log = readFileSync(p.traceLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(log.filter((l) => l.startsWith('process ')).length >= 6, 'трассировка загружалась');
  assert.ok(
    log.some((l) => l.endsWith('/src/init/project.ts')),
    'трассировка видит модули CLI',
  );
  assert.deepEqual(
    log.filter((l) => l.startsWith(integrations)),
    [],
  );
});

test('H1-04: заметка в .harness/work/context/notes закрепляется контекстом; symlink отклоняется', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-notes-')));
  const notes = join(dir, '.harness', 'work', 'context', 'notes');
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, 'decision.md'), '# Decision\n\nKeep greet pure.\n');
  const context = new FileContextSource(join(dir, '.harness', 'work', 'context'));
  const snapshot = await context.snapshot(['notes']);
  const [source] = snapshot.sources;
  assert.equal(source?.id, 'notes');
  assert.equal(source?.files[0]?.path, 'decision.md');
  assert.match(source?.files[0]?.digest ?? '', /^[0-9a-f]{64}$/);
  symlinkSync('/etc/hosts', join(notes, 'leak.md'));
  await assert.rejects(async () => context.snapshot(['notes']), /symlink/);
});
